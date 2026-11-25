/**
 * WebCodecsVideoElement — a drop-in-ish replacement for HTMLVideoElement backed
 * by WebCodecs VideoDecoder rendering to a canvas.
 *
 * Why this exists
 * ---------------
 * Tesla dashcam events use 4 (or 6) synchronized H.264 streams. Native
 * <video> playback delegates frames to the browser's hardware YUV overlay
 * path. On Intel integrated GPUs that path has only 2 overlay slots —
 * with 4+ videos fighting for 2 slots, one or more end up stuck at
 * readyState=2, producing the flickering/buffering users hit for years.
 *
 * WebCodecs decodes into a canvas we draw into ourselves. No YUV overlay
 * contention. Software decode is used (prefer-software) because Chrome's
 * hardware H.264 path silently stalls on Tesla streams — known quirk
 * already handled by FastClipDecoder.
 *
 * Design: augment-a-canvas instead of "wrap a canvas"
 * ---------------------------------------------------
 * The public identity IS the HTMLCanvasElement — `videoPlayer.videos.front`
 * returns a canvas, not a wrapper object. HTMLVideoElement-style properties
 * (`src`, `currentTime`, `duration`, `readyState`, `paused`, `seeking`,
 * `ended`, `videoWidth`, `videoHeight`, `playbackRate`, `loop`, `muted`,
 * `volume`) are installed as getters/setters directly on the canvas. Methods
 * (`play`, `pause`, `addEventListener`, `removeEventListener`,
 * `dispatchEvent`) are likewise attached.
 *
 * Consequences:
 *   - `drawImage(canvas, …)` Just Works wherever the codebase does it for
 *     screenshots/export — a canvas IS a CanvasImageSource.
 *   - CSS rules targeting the grid (object-fit, sizing, crop, labels) apply
 *     unchanged — it's still a block-level media element in the DOM.
 *   - `videoPlayer.videos.front.src = url` triggers our loader.
 *   - Events dispatch like HTMLMediaElement (loadedmetadata, loadeddata,
 *     canplay, play, pause, playing, waiting, timeupdate, seeking, seeked,
 *     ended, error).
 *
 * Private state lives on the canvas at `canvas._wcv` (the instance of this
 * class). The class never stores the canvas itself — just operates on it.
 *
 * Deliberate scope cuts for v1 (callers continue to work):
 *   - No audio track playback (Tesla clips are muted anyway)
 *   - No MediaSource / buffered ranges shim beyond a single "full duration
 *     is buffered once readyState >= HAVE_METADATA" stub
 *   - Playback rate supported as a simple time-step multiplier
 *   - Loop handled in the play loop
 *   - `seekable` returns a one-range [0, duration] shim
 */
(function () {
    'use strict';

    // HTMLMediaElement readyState constants
    const HAVE_NOTHING      = 0;
    const HAVE_METADATA     = 1;
    const HAVE_CURRENT_DATA = 2;
    const HAVE_FUTURE_DATA  = 3;
    const HAVE_ENOUGH_DATA  = 4;

    /**
     * Check whether this browser has everything we need.
     */
    function isSupported() {
        return typeof window.VideoDecoder !== 'undefined'
            && typeof window.EncodedVideoChunk !== 'undefined'
            && typeof window.MP4Box !== 'undefined'
            && typeof window.FastClipDecoder !== 'undefined'
            && window.FastClipDecoder.WEBCODECS_AVAILABLE === true;
    }

    /**
     * One-shot install: attach all HTMLVideoElement-like properties/methods
     * to a canvas. Idempotent — calling twice on the same canvas is a no-op.
     *
     * @param {HTMLCanvasElement} canvas
     * @returns {WebCodecsVideoElement} the backing controller (also at canvas._wcv)
     */
    function install(canvas) {
        if (canvas._wcv) return canvas._wcv;
        const wcv = new WebCodecsVideoElement(canvas);
        canvas._wcv = wcv;

        // ---- HTMLMediaElement-shaped properties via getter/setter ----
        Object.defineProperty(canvas, 'src', {
            get() { return wcv._src; },
            set(v) { wcv._setSrc(v); },
            configurable: true
        });
        Object.defineProperty(canvas, 'currentTime', {
            get() { return wcv._currentTime; },
            set(v) { wcv._seekTo(Number(v) || 0); },
            configurable: true
        });
        Object.defineProperty(canvas, 'duration', {
            get() { return wcv._duration; },
            configurable: true
        });
        Object.defineProperty(canvas, 'readyState', {
            get() { return wcv._readyState; },
            configurable: true
        });
        Object.defineProperty(canvas, 'paused', {
            get() { return wcv._paused; },
            configurable: true
        });
        Object.defineProperty(canvas, 'seeking', {
            get() { return wcv._seeking; },
            configurable: true
        });
        Object.defineProperty(canvas, 'ended', {
            get() { return wcv._ended; },
            configurable: true
        });
        Object.defineProperty(canvas, 'playbackRate', {
            get() { return wcv._playbackRate; },
            set(v) { wcv._playbackRate = Math.max(0.01, Number(v) || 1); },
            configurable: true
        });
        Object.defineProperty(canvas, 'videoWidth', {
            get() { return wcv._videoWidth; },
            configurable: true
        });
        Object.defineProperty(canvas, 'videoHeight', {
            get() { return wcv._videoHeight; },
            configurable: true
        });
        // Not on HTMLVideoElement: lets the exporter check that the canvas
        // really shows the frame for currentTime before it captures it.
        Object.defineProperty(canvas, 'framePresented', {
            get() { return wcv._isPresented(); },
            configurable: true
        });
        // HTMLMediaElement properties we stub out
        Object.defineProperty(canvas, 'loop', {
            get() { return wcv._loop; },
            set(v) { wcv._loop = !!v; },
            configurable: true
        });
        Object.defineProperty(canvas, 'muted', { value: true, writable: true, configurable: true });
        Object.defineProperty(canvas, 'volume', { value: 1, writable: true, configurable: true });
        Object.defineProperty(canvas, 'autoplay', { value: false, writable: true, configurable: true });

        // HTMLMediaElement methods — play() returns a Promise like the native one does
        canvas.play = () => wcv._play();
        canvas.pause = () => wcv._pause();
        canvas.load = () => wcv._setSrc(wcv._src, { forceReload: true });

        // External clock API — opt-in for lockstep sync across multiple
        // canvases. When attached, the per-instance rAF loop is suppressed
        // and a master (VideoPlayer) drives advance via tick(absoluteSec).
        // This eliminates the independent-rAF-drift that forced syncController
        // into repeated resync seeks, each of which tore down + reinitialized
        // the decoder and caused visible stutter.
        canvas.attachExternalClock = () => {
            wcv._externalClock = true;
            if (wcv._rafHandle) { cancelAnimationFrame(wcv._rafHandle); wcv._rafHandle = null; }
        };
        canvas.detachExternalClock = () => { wcv._externalClock = false; };
        canvas.tick = (absoluteSec) => wcv._tick(absoluteSec);

        // buffered/seekable/played shims — full-range once metadata is loaded
        canvas.buffered = makeTimeRanges(() => wcv._readyState >= HAVE_METADATA ? [[0, wcv._duration || 0]] : []);
        canvas.seekable = makeTimeRanges(() => wcv._readyState >= HAVE_METADATA ? [[0, wcv._duration || 0]] : []);
        canvas.played = makeTimeRanges(() => []);

        return wcv;
    }

    function makeTimeRanges(provider) {
        return new Proxy({}, {
            get(_, prop) {
                const ranges = provider();
                if (prop === 'length') return ranges.length;
                const idx = Number(prop);
                if (!Number.isFinite(idx)) return undefined;
                return (name) => {
                    const r = ranges[idx];
                    if (!r) throw new DOMException('Index out of range', 'IndexSizeError');
                    return name === 'start' ? r[0] : r[1];
                };
            }
        });
    }

    class WebCodecsVideoElement extends EventTarget {
        constructor(canvas) {
            super();
            this._canvas = canvas;
            this._ctx = canvas.getContext('2d', { alpha: false });

            // State mirror of HTMLMediaElement
            this._src = '';
            this._currentTime = 0;
            this._duration = NaN;
            this._readyState = HAVE_NOTHING;
            this._paused = true;
            this._seeking = false;
            this._ended = false;
            this._playbackRate = 1;
            this._loop = false;
            this._playIntent = 0;         // bumps on play()/pause(): a play() waiting for its clip checks it
            this._playWaitAbort = null;   // ends that wait (pause)
            this._videoWidth = 0;
            this._videoHeight = 0;

            // WebCodecs state
            this._decoder = null;         // FastClipDecoder instance
            this._srcFile = null;         // File object (from createObjectURL reverse lookup)
            this._loadToken = 0;          // bumps on each load to cancel stale async work

            // Playback clock
            this._rafHandle = null;
            this._lastFrameTime = 0;      // performance.now() of last tick
            this._timeUpdateLastEmit = 0; // throttle timeupdate dispatch

            // Decoded frame queue (sliding window ahead of currentTime)
            this._frameQueue = [];        // [{bitmap, ts}]
            this._decoderLastTs = -1;     // highest timestamp decoded so far
            this._decoderFinished = false;
            this._decoderRefillInFlight = false;
            this._refillPromise = null;   // the running refill, so a seek or load can wait for it
            this._queueGen = 0;           // bumps whenever the queue is reset; older refills stop and drop their frames
            this._seekGen = 0;            // bumps per seek; a newer seek supersedes an older one
            this._frameDur = 1 / 30;      // one frame's duration in seconds (from the clip's samples)
            this._firstFrameTs = 0;       // timestamp of the clip's first frame
            this._lastDrawnTs = -1;       // what the canvas currently shows

            // External-clock mode flag. When true, the per-instance rAF
            // loop is dormant and a master controller drives _tick().
            this._externalClock = false;
        }

        /**
         * External-clock entry point — called once per master-rAF tick with
         * the absolute event-time the master wants displayed. Updates our
         * currentTime, draws the matching frame, prefetches ahead. Fires
         * timeupdate on a throttled cadence.
         */
        _tick(absoluteSec) {
            if (!this._decoder || this._readyState < HAVE_METADATA) return;
            // A seek owns the queue until it has drawn its frame.
            if (this._seeking) return;
            const t = Math.max(0, Math.min(absoluteSec, this._duration || absoluteSec));
            this._currentTime = t;
            // Refill trigger AND refill size both widened. Was trigger=0.4s,
            // size=0.8s — under 6-camera software decode load on a busy CPU
            // the queue could dip empty between ticks and the canvas held a
            // stale frame ("hanging for a frame or two" in user reports).
            // Keep 1.2s of runway decoded ahead; kick off refill sooner.
            if (!this._decoderFinished
                && this._decoderLastTs < t + 0.8
                && !this._decoderRefillInFlight) {
                this._refillQueue(Math.max(0, this._decoderLastTs + 1e-6), 1.8);
            }
            this._drawBestFrameFor(t);
            this._dropFramesBefore(t);
            this._emitTimeUpdate();
        }

        // ---------- Public-API-ish methods (installed on canvas) ----------

        /**
         * Route both `canvas.src = "blob:..."` and `canvas.src = ""` through
         * the load pipeline. Native HTMLVideoElement behavior:
         *   - empty/null src → reset state
         *   - new src → fire loadstart → load → loadedmetadata → loadeddata
         */
        async _setSrc(value, opts = {}) {
            const str = value || '';
            if (this._src === str && !opts.forceReload) return;

            // Cancel any in-flight decoder setup
            this._loadToken++;
            const token = this._loadToken;
            this._teardownDecoder();
            this._resetPlaybackState();
            this._src = str;

            if (!str) {
                this._fire('emptied');
                return;
            }

            this._fire('loadstart');
            // Resolve the src: a Blob URL made from a File is the common case
            // (videoPlayer creates these in loadVideoForCamera). We use the
            // global URL registry to recover the File.
            const file = await this._resolveSrcToFile(str);
            if (token !== this._loadToken) return;  // stale

            if (!file) {
                this._fireError('Could not resolve video source to a File');
                return;
            }

            try {
                const dec = new window.FastClipDecoder();
                await dec.init(file);
                if (token !== this._loadToken) { dec.close(); return; }
                if (!dec.ready) {
                    this._fireError('FastClipDecoder init failed');
                    return;
                }
                if (dec.usedFallback) {
                    // WebCodecs couldn't handle this file, but the browser's
                    // own <video> could open it (FastClipDecoder's fallback
                    // loaded it). Tell the player, which switches to the
                    // Compatibility player: 'codec' = this browser can't
                    // decode the codec at all, 'file' = only this file.
                    const kind = dec.codecUnsupported ? 'codec' : 'file';
                    const reason = dec.fallbackReason || 'WebCodecs decoder unavailable for this clip';
                    dec.close();
                    this._fireFailure(kind, reason);
                    this._fireError('WebCodecs decoder unavailable for this clip');
                    return;
                }
                this._decoder = dec;
                this._srcFile = file;
                this._videoWidth = dec.width || 0;
                this._videoHeight = dec.height || 0;
                // Canvas intrinsic size matches video stream so drawImage math
                // downstream (crop, object-fit) treats it identically.
                this._canvas.width = this._videoWidth;
                this._canvas.height = this._videoHeight;

                // Duration = last sample's composition time + its duration
                if (dec.samples.length > 0) {
                    const last = dec.samples[dec.samples.length - 1];
                    this._duration = (last.cts + last.duration) / dec.timescale;
                    let firstCts = Infinity;
                    for (const s of dec.samples) if (s.cts < firstCts) firstCts = s.cts;
                    this._firstFrameTs = firstCts / dec.timescale;
                    // Average frame duration (Tesla clips have uneven frame
                    // spacing, so no single sample's duration is reliable).
                    const d = (this._duration - this._firstFrameTs) / dec.samples.length;
                    this._frameDur = (d > 0.001 && d < 1) ? d : 1 / 30;
                } else {
                    this._duration = 0;
                }

                this._readyState = HAVE_METADATA;
                this._fire('durationchange');
                this._fire('loadedmetadata');

                // Prime decode of the first frame so we can display something
                // before any seek/play call. A refill for the previous source
                // may still be winding down (its decoder was just closed);
                // wait for it, or this prime would be skipped and the freshly
                // resized (black) canvas would stay black.
                await this._awaitRefillIdle();
                if (token !== this._loadToken) return;
                await this._refillQueue(0, 0.5);
                if (token !== this._loadToken) return;
                this._drawBestFrameFor(0);

                this._readyState = HAVE_ENOUGH_DATA;
                this._fire('loadeddata');
                this._fire('canplay');
                this._fire('canplaythrough');
            } catch (err) {
                console.warn('[WebCodecsVideoElement] load failed:', err);
                this._fireError(String(err?.message || err));
            }
        }

        async _resolveSrcToFile(src) {
            // Blob URLs — fetch() on the same page resolves them back to blobs
            if (src.startsWith('blob:')) {
                try {
                    const resp = await fetch(src);
                    return await resp.blob();
                } catch (e) {
                    console.warn('[WebCodecsVideoElement] blob fetch failed:', e);
                    return null;
                }
            }
            // http(s) URLs: fetch and use resulting blob
            if (/^https?:/.test(src)) {
                try {
                    const resp = await fetch(src);
                    return await resp.blob();
                } catch (e) {
                    return null;
                }
            }
            return null;
        }

        _resetPlaybackState() {
            this._currentTime = 0;
            this._duration = NaN;
            this._readyState = HAVE_NOTHING;
            this._paused = true;
            this._seeking = false;
            this._ended = false;
            this._videoWidth = 0;
            this._videoHeight = 0;
            this._resetQueue();
            this._seekGen++;              // a seek still running for the old source must not finish on this one
            this._lastDrawnTs = -1;
            this._frameDur = 1 / 30;
            this._firstFrameTs = 0;
            if (this._rafHandle) { cancelAnimationFrame(this._rafHandle); this._rafHandle = null; }
        }

        /**
         * Empty the decoded-frame queue. A refill still running for the old
         * queue sees the generation change, stops at its next frame and
         * drops what it decoded instead of mixing old frames into the new
         * queue.
         */
        _resetQueue() {
            this._frameQueue.forEach(f => { try { f.bitmap.close?.(); } catch {} });
            this._frameQueue = [];
            this._queueGen++;
            this._decoderLastTs = -1;
            this._decoderFinished = false;
        }

        async _awaitRefillIdle() {
            while (this._decoderRefillInFlight && this._refillPromise) {
                try { await this._refillPromise; } catch {}
            }
        }

        _teardownDecoder() {
            if (this._decoder) {
                try { this._decoder.close(); } catch {}
                this._decoder = null;
            }
            this._srcFile = null;
        }

        // ---------- Play/pause ----------

        async _play() {
            if (!this._decoder || this._readyState < HAVE_METADATA) {
                // Nothing to play: like a native <video> with no source.
                if (!this._src) return Promise.reject(new Error('NotReadyError: video not loaded'));
                // A clip is still loading (software decode is slow on a busy
                // computer). Like a native <video>, play once it can, instead
                // of failing: before, Play pressed during a load (or right
                // after Next Clip) logged "Error playing videos" and nothing
                // played. A pause(), another source or a failed load ends the
                // wait, as they abort a native play().
                const token = this._loadToken;
                const intent = ++this._playIntent;
                const ready = await new Promise((resolve) => {
                    const evs = { canplay: true, error: false, emptied: false, loadstart: false };
                    const handlers = {};
                    const done = (v) => {
                        for (const [t, h] of Object.entries(handlers)) this.removeEventListener(t, h);
                        this._playWaitAbort = null;
                        resolve(v);
                    };
                    for (const [t, v] of Object.entries(evs)) {
                        handlers[t] = () => done(v);
                        this.addEventListener(t, handlers[t]);
                    }
                    this._playWaitAbort = () => done(false);
                });
                if (!ready || token !== this._loadToken || intent !== this._playIntent || !this._decoder) {
                    return Promise.reject(new DOMException('The play() request was interrupted', 'AbortError'));
                }
            }
            if (!this._paused) return;
            this._paused = false;
            this._ended = false;
            this._lastFrameTime = performance.now();
            this._fire('play');
            this._fire('playing');
            // External-clock mode: master drives the rAF. We just flip the
            // paused flag — the master's tick() calls do the rest.
            if (!this._externalClock) this._scheduleFrame();
        }

        _pause() {
            // A play() still waiting for its clip is cancelled
            this._playIntent++;
            if (this._playWaitAbort) this._playWaitAbort();
            if (this._paused) return;
            this._paused = true;
            if (this._rafHandle) { cancelAnimationFrame(this._rafHandle); this._rafHandle = null; }
            this._fire('pause');
        }

        // ---------- Seek ----------

        async _seekTo(sec) {
            if (!this._decoder) {
                // Not loaded — just set the time; once loaded we'll seek.
                this._currentTime = sec;
                return;
            }
            const clamped = Math.max(0, Math.min(sec, this._duration || sec));

            // Like HTMLVideoElement, every seek fires seeking/seeked, and
            // `seeked` means the canvas now shows the frame for the new time.
            // A newer seek supersedes this one: only the newest fires seeked.
            // (Before: a seek issued while a decode was running skipped its
            // own decode and fired seeked with the old frame still drawn, and
            // a seek to the time currentTime already held returned early even
            // when that frame had never been drawn. The frame-by-frame export
            // then captured stale or black frames.)
            const gen = ++this._seekGen;
            const decoder = this._decoder;
            this._seeking = true;
            this._fire('seeking');
            this._currentTime = clamped;

            if (this._presentFromQueue(clamped)) {
                // Already decoded (sequential export steps, small seeks):
                // drawn now. Fire seeked from a microtask, like the native
                // element fires it asynchronously.
                await Promise.resolve();
                if (gen !== this._seekGen) return;
            } else {
                // Drop the existing queue: its frames don't cover the target.
                // Any refill still running sees the reset and stops.
                this._resetQueue();
                await this._awaitRefillIdle();
                if (gen !== this._seekGen || decoder !== this._decoder) return;
                // Start 0.1 s early so the frame on screen at `clamped` (the
                // last one at or before it) is decoded too, not only the first
                // frame after it, even with uneven frame spacing.
                await this._refillQueue(Math.max(0, clamped - 0.1), 0.6);
                if (gen !== this._seekGen || decoder !== this._decoder) return;
                this._drawBestFrameFor(clamped);
            }

            this._seeking = false;
            this._fire('seeked');
            this._emitTimeUpdate();
        }

        /**
         * If the queue already holds the frame that is on screen at `sec`,
         * draw it and return true. The queue is contiguous (each refill
         * starts where the previous one ended), so the last frame at or
         * before `sec` is the right one as long as a later frame exists or
         * `sec` is within one frame of it (or the clip is fully decoded).
         */
        _presentFromQueue(sec) {
            const best = this._queuedFrameFor(sec);
            if (!best) return false;
            this._drawBestFrameFor(sec);
            return this._lastDrawnTs === best.ts;
        }

        /**
         * The decoded frame that is on screen at `sec`, or null when the
         * queue can't tell: the last frame at or before `sec`, provided a
         * later frame is decoded too (or `sec` is within a frame of it, or
         * the clip is decoded to its end). Before the clip's first frame,
         * that first frame.
         */
        _queuedFrameFor(sec) {
            if (this._frameQueue.length === 0) return null;
            let best = null, first = null, later = false;
            for (const f of this._frameQueue) {
                if (!first || f.ts < first.ts) first = f;
                if (f.ts <= sec + 1e-4) {
                    if (!best || f.ts > best.ts) best = f;
                } else {
                    later = true;
                }
            }
            if (!best) {
                return (first && first.ts <= this._firstFrameTs + 1e-4) ? first : null;
            }
            if (!later && !this._decoderFinished && sec - best.ts >= this._frameDur) return null;
            return best;
        }

        /** True when the canvas shows the frame that is on screen at currentTime. */
        _isPresented() {
            if (this._seeking || !this._decoder || this._lastDrawnTs < 0) return false;
            const best = this._queuedFrameFor(this._currentTime);
            return !!best && best.ts === this._lastDrawnTs;
        }

        // ---------- Decode pump ----------

        /**
         * Ensure the frame queue has decoded content covering the window
         * [startSec, startSec + aheadSec]. Delegates to FastClipDecoder's
         * decodeSequence, which handles keyframe seek + sequential decode.
         * Only one refill runs at a time; a refill whose queue was reset
         * (seek, new source) stops at its next frame and drops its frames.
         */
        _refillQueue(startSec, aheadSec) {
            if (!this._decoder || this._decoderRefillInFlight) return Promise.resolve();
            this._decoderRefillInFlight = true;
            const decoder = this._decoder;
            const gen = this._queueGen;
            const STALE = {};
            const endSec = Math.min((this._duration || Infinity), startSec + aheadSec);
            const p = (async () => {
                try {
                    await decoder.decodeSequence(startSec, endSec, (bitmap, tsSec) => {
                        if (gen !== this._queueGen || decoder !== this._decoder) {
                            try { bitmap.close?.(); } catch {}
                            throw STALE;
                        }
                        this._frameQueue.push({ bitmap, ts: tsSec });
                        if (tsSec > this._decoderLastTs) this._decoderLastTs = tsSec;
                    });
                    if (gen === this._queueGen && endSec >= (this._duration || 0) - 0.01) {
                        this._decoderFinished = true;
                    }
                } catch (e) {
                    // A stopped refill (queue reset or decoder closed under
                    // it) is expected, not a failure.
                    if (e !== STALE && gen === this._queueGen && decoder === this._decoder) {
                        console.warn('[WebCodecsVideoElement] decode failed:', e);
                        this._fireFailure('decode', String(e?.message || e));
                    }
                } finally {
                    if (this._refillPromise === p) {
                        this._decoderRefillInFlight = false;
                        this._refillPromise = null;
                    }
                }
            })();
            this._refillPromise = p;
            return p;
        }

        _drawBestFrameFor(sec) {
            if (this._frameQueue.length === 0) return;
            // Pick the frame with timestamp closest to (but not after) sec.
            let best = this._frameQueue[0];
            for (const f of this._frameQueue) {
                // 0.1 ms slack: timestamps are rounded to whole microseconds,
                // so a frame that starts exactly at `sec` can read a hair later.
                if (f.ts <= sec + 1e-4 && f.ts >= best.ts) best = f;
            }
            if (best.ts === this._lastDrawnTs) return;
            try {
                this._ctx.drawImage(best.bitmap, 0, 0);
                this._lastDrawnTs = best.ts;
            } catch (e) {
                // bitmap may have been closed by someone; silently skip
            }
        }

        _dropFramesBefore(sec) {
            while (this._frameQueue.length > 2
                && this._frameQueue[0].ts < sec - 0.2) {
                const old = this._frameQueue.shift();
                try { old.bitmap.close?.(); } catch {}
            }
        }

        // ---------- rAF playback loop ----------

        _scheduleFrame() {
            if (this._paused) return;
            if (this._externalClock) return;  // master drives us via _tick
            this._rafHandle = requestAnimationFrame((now) => this._onFrame(now));
        }

        async _onFrame(now) {
            if (this._paused) return;
            if (this._seeking) {
                // A seek owns the queue until it has drawn its frame.
                this._lastFrameTime = now;
                this._scheduleFrame();
                return;
            }
            const delta = (now - this._lastFrameTime) / 1000;
            this._lastFrameTime = now;
            const step = delta * this._playbackRate;
            let t = this._currentTime + step;

            if (t >= (this._duration || Infinity)) {
                // End-of-clip handling
                if (this._loop) {
                    t = 0;
                    this._resetQueue();
                    await this._awaitRefillIdle();
                    await this._refillQueue(0, 0.5);
                } else {
                    t = this._duration;
                    this._currentTime = t;
                    this._ended = true;
                    this._paused = true;
                    this._drawBestFrameFor(t);
                    this._fire('timeupdate');
                    this._fire('ended');
                    return;
                }
            }
            this._currentTime = t;

            // Keep a wide buffer of decoded frames ahead — narrow windows
            // starved on slow software H.264 decode with 6 cameras.
            if (!this._decoderFinished
                && this._decoderLastTs < t + 0.8
                && !this._decoderRefillInFlight) {
                this._refillQueue(this._decoderLastTs + 1e-6, 1.8);
            }

            this._drawBestFrameFor(t);
            this._dropFramesBefore(t);
            this._emitTimeUpdate();

            this._scheduleFrame();
        }

        _emitTimeUpdate() {
            // HTMLMediaElement throttles to ~4 per second per spec; we emit
            // on every frame but cap at 4Hz to match existing consumers that
            // expect the legacy cadence.
            const now = performance.now();
            if (now - this._timeUpdateLastEmit > 230) {
                this._timeUpdateLastEmit = now;
                this._fire('timeupdate');
            }
        }

        // ---------- Events ----------

        _fire(type) {
            const ev = new Event(type);
            // dispatch on ourselves (for consumers who did addEventListener
            // on the canvas) AND on the canvas element via our EventTarget.
            this.dispatchEvent(ev);
            try { this._canvas.dispatchEvent(new Event(type)); } catch {}
        }

        /**
         * WebCodecs can't play this source: 'webcodecsfailure' on the canvas,
         * detail {kind, message}. VideoPlayer decides whether to switch to the
         * Compatibility player (js/videoPlayer.js _onWebCodecsFailure).
         */
        _fireFailure(kind, message) {
            try {
                this._canvas.dispatchEvent(new CustomEvent('webcodecsfailure', {
                    detail: { kind, message: String(message || '').slice(0, 300) }
                }));
            } catch {}
        }

        _fireError(message) {
            console.warn('[WebCodecsVideoElement] error:', message);
            this._readyState = HAVE_NOTHING;
            const ev = new Event('error');
            ev.message = message;
            this.dispatchEvent(ev);
            try { this._canvas.dispatchEvent(new Event('error')); } catch {}
        }
    }

    /**
     * Why the fast player can't start here, or null when it can:
     * 'unsupported' = no WebCodecs in this browser, 'library' = the MP4
     * reader (mp4box, from a CDN) didn't load.
     */
    function unsupportedReason() {
        if (typeof window.VideoDecoder === 'undefined' || typeof window.EncodedVideoChunk === 'undefined') return 'unsupported';
        if (typeof window.MP4Box === 'undefined' || typeof window.FastClipDecoder === 'undefined'
            || window.FastClipDecoder.WEBCODECS_AVAILABLE !== true) return 'library';
        return null;
    }

    /**
     * Can this browser decode Tesla's H.264 clips with WebCodecs? Checked
     * once when the page loads (each clip is checked again when it opens).
     * @returns {Promise<boolean>}
     */
    async function probeH264() {
        try {
            const r = await window.VideoDecoder.isConfigSupported({
                codec: 'avc1.640028', codedWidth: 1280, codedHeight: 960,
                hardwareAcceleration: 'prefer-software'
            });
            return !!(r && r.supported);
        } catch (e) {
            return false;
        }
    }

    /**
     * The fast player's automatic switch to the Compatibility player.
     * kinds: 'unsupported' / 'library' (see unsupportedReason), 'codec'
     * (WebCodecs here can't decode H.264, the browser's own player can),
     * 'file' (one clip it couldn't read), 'decode' (decode errors while
     * playing). Only 'codec' is remembered, for this browser version (the
     * user agent): the others are checked again on every page load, so a
     * browser update, a CDN hiccup or one odd clip never pins a user to the
     * Compatibility player. The note about the switch shows once per kind.
     */
    const FALLBACK_KEY = 'tcv.playerFallback';
    const NOTED_KEY = 'tcv.playerFallbackNoted';
    const PlayerFallback = {
        active() {
            try {
                const r = JSON.parse(localStorage.getItem(FALLBACK_KEY) || 'null');
                if (r && r.ua === navigator.userAgent) return r;
            } catch (e) { /* unreadable: none */ }
            return null;
        },
        record(kind, message) {
            if (kind !== 'codec') return;
            try {
                localStorage.setItem(FALLBACK_KEY, JSON.stringify({
                    kind, message: String(message || '').slice(0, 200),
                    ua: navigator.userAgent, at: new Date().toISOString()
                }));
            } catch (e) { /* storage full or blocked: session only */ }
        },
        clear() {
            try { localStorage.removeItem(FALLBACK_KEY); } catch (e) { /* nothing stored */ }
        },
        /** True the first time this kind of switch happens in this browser. */
        firstNote(kind) {
            try {
                const seen = JSON.parse(localStorage.getItem(NOTED_KEY) || '[]');
                const list = Array.isArray(seen) ? seen : [];
                if (list.includes(kind)) return false;
                list.push(kind);
                localStorage.setItem(NOTED_KEY, JSON.stringify(list));
                return true;
            } catch (e) {
                return false;
            }
        }
    };
    window.PlayerFallback = PlayerFallback;

    window.WebCodecsVideoElement = {
        install,
        isSupported,
        unsupportedReason,
        probeH264,
        HAVE_NOTHING, HAVE_METADATA, HAVE_CURRENT_DATA, HAVE_FUTURE_DATA, HAVE_ENOUGH_DATA
    };
})();
