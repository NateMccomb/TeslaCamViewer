/**
 * MultiCameraExportDecoder — coordinates per-camera WebCodecs decoders across
 * an event's clip boundaries, producing synchronized frame sets for the
 * export pipeline.
 *
 * Problem this solves
 * -------------------
 * The legacy export Phase-1 loop (videoExport.js) seeks live HTML5 <video>
 * elements to each output frame time, polls readyState, and draws to canvas.
 * For a 60s event at 30fps that's 1800 seeks × 4+ cameras, each bounded by
 * browser video-decode real-time and disk I/O — ~10× slower than realtime.
 *
 * Approach
 * --------
 * Per camera, we demux each clip's mp4 with FastClipDecoder and stream
 * VideoFrames out sequentially (no seeking). For each output frame time we
 * pull the latest-available frame from each camera and return them together.
 *
 * Frames are produced by pull-based async iteration so memory stays bounded:
 * the caller awaits nextOutputFrame(), we decode until at least one frame
 * per camera has passed the requested time, yield them, then continue.
 *
 * Clip transitions are handled transparently — when a camera's current clip
 * ends, we tear down that clip's decoder and init the next one.
 *
 * Usage
 * -----
 *   const dec = new window.MultiCameraExportDecoder();
 *   await dec.init({ event, visibleCameras, clipDurations,
 *                    startEventSec, endEventSec, fps });
 *   while (dec.hasMore()) {
 *       const { eventTime, frames } = await dec.nextOutputFrame();
 *       // frames is Map<cameraName, ImageBitmap>. Draw, then close each.
 *   }
 *   await dec.close();
 */
(function () {
    'use strict';

    const DECODE_CHUNK_SEC = 2.0;     // how far ahead each camera decodes before yielding
    const FRAME_TOLERANCE_SEC = 0.05; // a clip counts as decoded when the queue reaches this close to its end
    // An output frame shows each camera's latest frame at or before its time,
    // like the player (WebCodecsVideoElement draws the last frame <= t). This
    // was 0.05 s, so exports showed frames up to 50 ms early: a frame ahead
    // of the player, and the first frame of the next clip one output frame
    // before the longest camera of this clip ended (#587). 1 ms is rounding.
    const TAKE_TOLERANCE_SEC = 0.001;
    // How far before the export's start the first decode window reaches, so
    // the frame on screen at the start (its timestamp is before it) is there
    const START_LOOKBACK_SEC = 0.1;

    class CameraPipeline {
        /**
         * One camera's view of the event — an ordered list of clips plus the
         * offset within the event where each clip starts. Maintains a pending
         * queue of decoded frames and a pointer to the current clip decoder.
         */
        constructor(cameraName, clips, startEventSec, endEventSec) {
            this.name = cameraName;
            // Each entry: { fileHandle, fileName, eventStartSec, eventEndSec, duration }
            this.clips = clips;
            this.startEventSec = startEventSec;
            this.endEventSec = endEventSec;

            // Pending frames to consume; each entry: { bitmap, eventTimeSec }
            this.queue = [];
            this.currentClipIdx = -1;
            this.currentDecoder = null;
            this.done = false;
        }

        async _advanceToClip(idx) {
            if (this.currentDecoder) {
                try { this.currentDecoder.close(); } catch {}
                this.currentDecoder = null;
            }
            this.currentClipIdx = idx;
            if (idx >= this.clips.length) { this.done = true; return; }
            const clip = this.clips[idx];
            const file = await clip.fileHandle.getFile();
            const dec = new window.FastClipDecoder();
            await dec.init(file);
            if (!dec.ready) {
                // Init failed; skip this clip so we don't stall the whole export.
                this.currentDecoder = null;
                return;
            }
            this.currentDecoder = dec;
        }

        /**
         * Ensure we have enough decoded frames queued to satisfy requests up
         * to targetEventSec. Returns when queue covers targetEventSec OR we
         * reach end-of-event.
         *
         * Edge cases guarded against:
         *   - On the LAST clip and content exhausted — must set done, not spin
         *   - decodeSequence returned zero frames (clip broken) — must advance
         *   - targetEventSec past endEventSec — clamp so we don't chase nothing
         */
        async ensureDecodedUpTo(targetEventSec) {
            const effectiveTarget = Math.min(targetEventSec, this.endEventSec);
            let safety = 0;
            while (!this.done) {
                if (++safety > 10000) {
                    console.warn(`[CameraPipeline:${this.name}] safety break after ${safety} iterations — forcing done`);
                    this.done = true;
                    return;
                }

                const queueLastTs = this.queue.length
                    ? this.queue[this.queue.length - 1].eventTimeSec
                    : this.startEventSec - 1;  // sentinel — always < effectiveTarget

                // Queue already satisfies the target
                if (this.queue.length > 0 && queueLastTs >= effectiveTarget) return;

                // Do we need to advance to a new clip?
                const outOfRange = this.currentClipIdx < 0 || this.currentClipIdx >= this.clips.length;
                const curClipExhausted = !outOfRange &&
                    this.clips[this.currentClipIdx].eventEndSec <= queueLastTs + FRAME_TOLERANCE_SEC;
                const needAdvance = outOfRange || !this.currentDecoder || curClipExhausted;

                if (needAdvance) {
                    await this._advanceToClip(this.currentClipIdx + 1);
                    if (this.done) return;
                    if (!this.currentDecoder) {
                        // This clip failed to init; try the next one. If we've
                        // run out of clips, _advanceToClip set done and we
                        // exit on the next iteration's while check.
                        continue;
                    }
                }

                const clip = this.clips[this.currentClipIdx];
                const clipStartEvent = clip.eventStartSec;
                const clipEndEvent = clip.eventEndSec;
                const windowEnd = Math.min(clipEndEvent, effectiveTarget + DECODE_CHUNK_SEC);
                const windowStart = Math.max(clipStartEvent,
                    this.queue.length ? queueLastTs + 1e-6 : this.startEventSec);
                let clipLocalStart = Math.max(0, windowStart - clipStartEvent);
                if (!this.queue.length) {
                    // First frames of the export: start at the frame on screen
                    // at the export's start, which began before it. For a
                    // camera that has already ended there (a clip lasts until
                    // its longest camera ends, #587), that is its last frame:
                    // before, it had none and showed the next clip's first.
                    const last = this._lastFrameSec(this.currentDecoder);
                    clipLocalStart = Math.max(0, Math.min(clipLocalStart, last ?? clipLocalStart) - START_LOOKBACK_SEC);
                }
                const clipLocalEnd = Math.max(0, windowEnd - clipStartEvent);

                if (clipLocalEnd <= clipLocalStart) {
                    // Nothing more to decode from this clip
                    try { this.currentDecoder?.close(); } catch {}
                    this.currentDecoder = null;
                    if (this.currentClipIdx >= this.clips.length - 1) {
                        this.done = true;
                        return;
                    }
                    continue;
                }

                let framesThisPass = 0;
                try {
                    await this.currentDecoder.decodeSequence(clipLocalStart, clipLocalEnd,
                        (bitmap, tsSec) => {
                            const eventTimeSec = clipStartEvent + tsSec;
                            if (eventTimeSec >= this.endEventSec) {
                                try { bitmap.close?.(); } catch {}
                                return;
                            }
                            this.queue.push({ bitmap, eventTimeSec });
                            framesThisPass++;
                        });
                } catch (err) {
                    // Don't fail the whole export over a single broken clip.
                    // Log, tear down this clip's decoder, move on. The output
                    // frames in the affected range will show as whatever the
                    // previous decoded frame was (or a stale one from a peer
                    // camera), which is preferable to zero-frame output.
                    console.warn(`[CameraPipeline:${this.name}] decode failed for ${this.clips[this.currentClipIdx]?.fileName}:`, err?.message || err);
                    try { this.currentDecoder?.close(); } catch {}
                    this.currentDecoder = null;
                    if (this.currentClipIdx >= this.clips.length - 1) {
                        this.done = true;
                        return;
                    }
                    continue;
                }

                // If decodeSequence produced nothing, this clip can't contribute
                // more — advance so we don't spin on an empty window.
                if (framesThisPass === 0) {
                    try { this.currentDecoder?.close(); } catch {}
                    this.currentDecoder = null;
                    if (this.currentClipIdx >= this.clips.length - 1) {
                        this.done = true;
                        return;
                    }
                    continue;
                }

                // If we consumed all the way to the clip's end, tear down its
                // decoder so the next iteration advances.
                if (windowEnd >= clipEndEvent - 1e-6) {
                    try { this.currentDecoder?.close(); } catch {}
                    this.currentDecoder = null;
                    if (this.currentClipIdx >= this.clips.length - 1) {
                        this.done = true;
                        return;
                    }
                }
            }
        }

        /** Timestamp (s) of the clip's last frame, null when the decoder has no sample table. */
        _lastFrameSec(dec) {
            const s = dec && dec.samples;
            if (!s || !s.length || !dec.timescale) return null;
            let max = 0;
            for (const x of s) if (x.cts > max) max = x.cts;
            return max / dec.timescale;
        }

        /** Return the frame whose timestamp is closest to (but not after) requestedEventSec.
         *  Drops queue entries older than that so memory stays bounded. */
        takeFrameAt(requestedEventSec) {
            // Drop frames strictly older than requested - 1 tick of tolerance
            while (this.queue.length > 1 && this.queue[1].eventTimeSec <= requestedEventSec + TAKE_TOLERANCE_SEC) {
                const stale = this.queue.shift();
                try { stale.bitmap.close?.(); } catch {}
            }
            if (this.queue.length === 0) return null;
            const head = this.queue[0];
            // Give the head bitmap to the caller, reserve it from our queue
            // (we won't consume it again — but we don't close it either; caller owns it).
            // A single frame may actually be used for multiple output frames if the
            // clip's source fps < output fps, so we CLONE the bitmap rather than hand
            // over ownership.
            return { bitmap: head.bitmap, eventTimeSec: head.eventTimeSec };
        }

        async close() {
            if (this.currentDecoder) {
                try { this.currentDecoder.close(); } catch {}
                this.currentDecoder = null;
            }
            for (const { bitmap } of this.queue) {
                try { bitmap.close?.(); } catch {}
            }
            this.queue = [];
        }
    }

    class MultiCameraExportDecoder {
        constructor() {
            this._cameras = new Map();        // cameraName -> CameraPipeline
            this._startEventSec = 0;
            this._endEventSec = 0;
            this._fps = 30;
            this._frameIntervalSec = 1 / 30;
            this._currentOutputFrame = 0;
            this._totalOutputFrames = 0;
        }

        /**
         * @param {Object} opts
         * @param {Object} opts.event — app event object (has clipGroups)
         * @param {string[]} opts.visibleCameras — e.g. ['front','back','left_repeater','right_repeater']
         * @param {number[]} opts.clipDurations — per-clip duration in seconds (from videoPlayer cache)
         * @param {number} opts.startEventSec
         * @param {number} opts.endEventSec
         * @param {number} opts.fps
         */
        async init({ event, visibleCameras, clipDurations, startEventSec, endEventSec, fps }) {
            this._startEventSec = startEventSec;
            this._endEventSec = endEventSec;
            this._fps = fps;
            this._frameIntervalSec = 1 / fps;
            this._totalOutputFrames = Math.max(1, Math.floor((endEventSec - startEventSec) * fps));

            // Build per-camera clip list with event-time spans.
            for (const cam of visibleCameras) {
                const clips = [];
                let accum = 0;
                for (let i = 0; i < event.clipGroups.length; i++) {
                    const cg = event.clipGroups[i];
                    // The player's clip lengths (#537): a clip group with no
                    // front video is 0 s (the player skips it), not 60 s.
                    const duration = VideoPlayer.clipLength(clipDurations, i);
                    const clip = cg?.clips?.[cam];
                    const spanStart = accum;
                    const spanEnd = accum + duration;
                    accum = spanEnd;
                    if (duration <= 0) continue;      // not on the player's timeline
                    if (!clip?.fileHandle) continue;  // this camera didn't record this clip
                    // Skip clips entirely outside our range
                    if (spanEnd <= startEventSec || spanStart >= endEventSec) continue;
                    clips.push({
                        fileHandle: clip.fileHandle,
                        fileName: clip.fileName,
                        eventStartSec: spanStart,
                        eventEndSec: spanEnd,
                        duration
                    });
                }
                if (clips.length === 0) continue;
                this._cameras.set(cam, new CameraPipeline(cam, clips, startEventSec, endEventSec));
            }
        }

        hasMore() {
            return this._currentOutputFrame < this._totalOutputFrames;
        }

        /**
         * Pull the next output frame — one composited-input worth of data, one
         * per visible camera. Returns:
         *   { eventTime: number, frames: Map<cameraName, ImageBitmap|null> }
         *
         * The bitmaps are NOT owned by the caller — they belong to the pipeline
         * and may be reused across consecutive output frames (since decoder
         * fps is usually lower than output fps). The caller must NOT close
         * them; closing happens in close().
         */
        async nextOutputFrame() {
            if (!this.hasMore()) throw new Error('no more frames');
            const eventTime = this._startEventSec + (this._currentOutputFrame * this._frameIntervalSec);

            // Pull from each camera in parallel
            const frames = new Map();
            await Promise.all(Array.from(this._cameras.entries()).map(async ([name, pipe]) => {
                await pipe.ensureDecodedUpTo(eventTime + this._frameIntervalSec);
                const f = pipe.takeFrameAt(eventTime);
                frames.set(name, f ? f.bitmap : null);
            }));

            this._currentOutputFrame++;
            return { eventTime, frames };
        }

        getProgress() {
            return {
                done: this._currentOutputFrame,
                total: this._totalOutputFrames
            };
        }

        async close() {
            await Promise.all(Array.from(this._cameras.values()).map(p => p.close()));
            this._cameras.clear();
        }

        /** Capability check — true if the full fast path is available. */
        static isSupported() {
            return typeof window.VideoDecoder !== 'undefined'
                && typeof window.EncodedVideoChunk !== 'undefined'
                && typeof window.MP4Box !== 'undefined'
                && typeof window.FastClipDecoder !== 'undefined'
                && window.FastClipDecoder.WEBCODECS_AVAILABLE === true;
        }
    }

    window.MultiCameraExportDecoder = MultiCameraExportDecoder;
})();
