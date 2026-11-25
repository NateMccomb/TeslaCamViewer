/**
 * Fast frame extractor using WebCodecs + mp4box.js.
 *
 * Usage:
 *   const extractor = new FastClipDecoder();
 *   await extractor.init(file);                // parse mp4 headers once
 *   const frame1 = await extractor.extractAt(4.0);  // seconds into clip
 *   const frame2 = await extractor.extractAt(12.0);
 *   extractor.close();
 *
 * Frames are returned as ImageBitmap for compatibility with the existing
 * embedding path. Internally we use WebCodecs' VideoDecoder on demuxed
 * mp4 samples. Falls back to HTMLVideoElement seeking if WebCodecs or
 * mp4box isn't available, or if the codec is unsupported.
 */

(function () {
    const WEBCODECS_AVAILABLE = typeof window.VideoDecoder !== 'undefined'
        && typeof window.EncodedVideoChunk !== 'undefined';

    function mp4BoxReady() {
        return typeof window.MP4Box !== 'undefined';
    }

    // Serialize an mp4box config box (avcC/hvcC/vpcC/av1C) into the Uint8Array
    // that VideoDecoder.configure() wants in the `description` field.
    function getConfigDescription(mp4File, trackId) {
        const trak = mp4File.getTrackById(trackId);
        if (!trak?.mdia?.minf?.stbl?.stsd?.entries) return null;
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
            const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
            if (!box) continue;
            // mp4box's DataStream is globally available when mp4box.all.min.js loads
            const DS = window.DataStream;
            if (!DS) return null;
            const stream = new DS(undefined, 0, DS.BIG_ENDIAN);
            box.write(stream);
            // Drop the 8-byte box header (size + type) — decoder wants just the body
            return new Uint8Array(stream.buffer, 8);
        }
        return null;
    }

    class FastClipDecoder {
        constructor() {
            this.file = null;
            this.samples = [];
            this.codec = null;
            this.description = null;
            this.width = 0;
            this.height = 0;
            this.timescale = 1;
            this.trackId = 0;
            this.ready = false;
            this.usedFallback = false;
            this.codecUnsupported = false;
            this.fallbackReason = null;
            this._fallbackVideo = null;
            this._fallbackUrl = null;
        }

        async init(file) {
            this.file = file;
            if (!WEBCODECS_AVAILABLE || !mp4BoxReady()) {
                this.usedFallback = true;
                await this._initFallback();
                return;
            }

            try {
                const buf = await file.arrayBuffer();
                buf.fileStart = 0;
                const mp4 = window.MP4Box.createFile();

                await new Promise((resolve, reject) => {
                    let gotReady = false;
                    mp4.onReady = (info) => {
                        if (!info.videoTracks || info.videoTracks.length === 0) {
                            reject(new Error('no video track'));
                            return;
                        }
                        const track = info.videoTracks[0];
                        this.codec = track.codec;
                        this.width = track.video?.width || track.track_width || 0;
                        this.height = track.video?.height || track.track_height || 0;
                        this.timescale = track.timescale || 1;
                        this.trackId = track.id;
                        this.description = getConfigDescription(mp4, track.id);
                        if (!this.description) {
                            reject(new Error('no codec config box found'));
                            return;
                        }
                        gotReady = true;
                        mp4.setExtractionOptions(track.id, null, { nbSamples: 10000 });
                        mp4.start();
                    };
                    mp4.onSamples = (_trackId, _user, samples) => {
                        for (const s of samples) this.samples.push(s);
                        // All samples arrive in a single call for files < 10k samples,
                        // which covers all Tesla clips. Resolve once we have them.
                        if (gotReady) resolve();
                    };
                    mp4.onError = (e) => reject(new Error(`mp4box: ${e}`));
                    mp4.appendBuffer(buf);
                    mp4.flush();
                });

                // Sanity: VideoDecoder must actually support this codec config.
                // NOTE: Chrome's hardware H.264 decoder silently stalls on
                // Tesla's streams (only emits ~6 frames then hangs with no
                // error). prefer-software is required for reliability; it
                // happens to also be much faster for small frames anyway.
                const configBase = {
                    codec: this.codec,
                    codedWidth: this.width,
                    codedHeight: this.height,
                    description: this.description,
                    hardwareAcceleration: 'prefer-software'
                };
                const support = await window.VideoDecoder.isConfigSupported(configBase);
                if (!support.supported) {
                    // This browser's WebCodecs can't decode the clip's codec
                    // at all (not one odd file): the player uses this.
                    this.codecUnsupported = true;
                    throw new Error(`decoder config not supported for ${this.codec}`);
                }
                this._decoderConfig = configBase;

                this.ready = true;
            } catch (err) {
                // Fall back to HTMLVideoElement if WebCodecs path fails
                // (missing codec, unsupported config, or mp4box error).
                console.warn('[FFE] WebCodecs init failed, falling back:', err?.message || err);
                this.fallbackReason = String(err?.message || err);
                this.usedFallback = true;
                await this._initFallback();
            }
        }

        async _initFallback() {
            this._fallbackVideo = document.createElement('video');
            this._fallbackVideo.muted = true;
            this._fallbackVideo.playsInline = true;
            this._fallbackVideo.preload = 'auto';
            this._fallbackUrl = URL.createObjectURL(this.file);
            this._fallbackVideo.src = this._fallbackUrl;
            await new Promise((resolve, reject) => {
                this._fallbackVideo.onloadedmetadata = resolve;
                this._fallbackVideo.onerror = () => reject(new Error('fallback load error'));
                setTimeout(() => reject(new Error('fallback metadata timeout')), 15000);
            });
            this.width = this._fallbackVideo.videoWidth;
            this.height = this._fallbackVideo.videoHeight;
            this.ready = true;
        }

        /**
         * Extract a frame at the given wall-clock offset in seconds.
         * Returns { bitmap: ImageBitmap, actualTime: number }.
         */
        async extractAt(offsetSec) {
            if (!this.ready) throw new Error('not initialized');
            return this.usedFallback
                ? this._extractFallback(offsetSec)
                : this._extractWebCodecs(offsetSec);
        }

        async _extractFallback(offsetSec) {
            const video = this._fallbackVideo;
            const target = Math.max(0.1, Math.min(video.duration - 0.1, offsetSec));
            await new Promise((resolve, reject) => {
                const onSeeked = () => {
                    if (Math.abs(video.currentTime - target) > 0.5) return;
                    video.removeEventListener('seeked', onSeeked);
                    resolve();
                };
                video.addEventListener('seeked', onSeeked);
                video.currentTime = target;
                setTimeout(() => { video.removeEventListener('seeked', onSeeked); reject(new Error('seek timeout')); }, 10000);
            });
            await new Promise(r => setTimeout(r, 15)); // let frame settle
            const canvas = document.createElement('canvas');
            canvas.width = this.width;
            canvas.height = this.height;
            canvas.getContext('2d').drawImage(video, 0, 0);
            const bitmap = await createImageBitmap(canvas);
            return { bitmap, actualTime: video.currentTime };
        }

        async _extractWebCodecs(offsetSec) {
            const targetMicros = offsetSec * 1_000_000;
            const targetCts = Math.round(offsetSec * this.timescale);

            // Find the keyframe at or before target, and the closest sample
            // to target (usually the first sample with cts >= target).
            let keyIdx = 0;
            for (let i = 0; i < this.samples.length; i++) {
                if (this.samples[i].is_sync && this.samples[i].cts <= targetCts) {
                    keyIdx = i;
                } else if (this.samples[i].cts > targetCts && this.samples[i].is_sync) {
                    break;
                }
            }
            if (!this.samples[keyIdx].is_sync) keyIdx = 0;

            // Find the presentation frame index closest to target
            let targetIdx = keyIdx;
            let bestDelta = Math.abs(this.samples[keyIdx].cts - targetCts);
            for (let i = keyIdx + 1; i < this.samples.length; i++) {
                const d = Math.abs(this.samples[i].cts - targetCts);
                if (d < bestDelta) { bestDelta = d; targetIdx = i; }
                if (this.samples[i].cts > targetCts && this.samples[i].cts - targetCts > bestDelta) break;
            }

            // Keep ONE decoder alive for the lifetime of this extractor.
            // Creating/closing a VideoDecoder on every call exhausts GPU
            // resources. Reset+reconfigure between calls guarantees a clean
            // state — not all mp4 "sync samples" are true IDR frames with
            // inline SPS/PPS, so trying to just feed a keyframe as a seek
            // leaves the decoder with stale reference state.
            if (!this._decoder) {
                this._outputFrames = [];
                this._decoderError = null;
                this._decoder = new window.VideoDecoder({
                    output: (frame) => { this._outputFrames.push(frame); },
                    error: (e) => {
                        // Log immediately — caller throws later but by then
                        // the context (codec config, sample index) is gone
                        // and the diagnostics buffer just sees a bare throw.
                        const codec = this._decoderConfig?.codec || 'unknown';
                        console.error(`[FastFrameExtractor] Decoder error: ${e?.name || 'unknown'}: ${e?.message || String(e)} | codec=${codec} samples=${this.samples?.length || 0} — possible hardware decode failure or GPU reset`);
                        this._decoderError = e;
                    }
                });
            } else {
                // Drop any pending work and release prior frames
                try { this._decoder.reset(); } catch { /* ignore */ }
                for (const f of this._outputFrames) { try { f.close(); } catch {} }
                this._outputFrames = [];
                this._decoderError = null;
            }
            this._decoder.configure(this._decoderConfig);

            for (let i = keyIdx; i <= targetIdx; i++) {
                const s = this.samples[i];
                this._decoder.decode(new window.EncodedVideoChunk({
                    type: s.is_sync ? 'key' : 'delta',
                    timestamp: Math.round((s.cts * 1_000_000) / this.timescale),
                    duration: Math.round((s.duration * 1_000_000) / this.timescale),
                    data: s.data
                }));
            }
            await this._decoder.flush();
            if (this._decoderError) throw this._decoderError;
            if (this._outputFrames.length === 0) throw new Error('no frames decoded');

            // Pick the frame whose timestamp is closest to target
            let best = this._outputFrames[0];
            let bestD = Math.abs(best.timestamp - targetMicros);
            for (let i = 1; i < this._outputFrames.length; i++) {
                const d = Math.abs(this._outputFrames[i].timestamp - targetMicros);
                if (d < bestD) { bestD = d; best = this._outputFrames[i]; }
            }

            // createImageBitmap copies the frame data; closing after is fine
            const bitmap = await createImageBitmap(best);
            const actualTime = best.timestamp / 1_000_000;
            for (const f of this._outputFrames) f.close();
            this._outputFrames = [];
            return { bitmap, actualTime };
        }

        close() {
            if (this._decoder) {
                try { this._decoder.close(); } catch { /* ignore */ }
                this._decoder = null;
            }
            if (this._outputFrames) {
                for (const f of this._outputFrames) { try { f.close(); } catch {} }
                this._outputFrames = [];
            }
            if (this._fallbackVideo) {
                this._fallbackVideo.src = '';
                this._fallbackVideo = null;
            }
            if (this._fallbackUrl) {
                URL.revokeObjectURL(this._fallbackUrl);
                this._fallbackUrl = null;
            }
            this.samples = [];
            this.ready = false;
        }

        /**
         * Decode a contiguous range of this clip sequentially, calling
         * onFrame(bitmap, timestampSec) for each decoded frame whose timestamp
         * falls within [startSec, endSec]. Much faster than repeated extractAt()
         * calls because the decoder state is never reset — frames stream out in
         * order and backpressure comes from awaiting the caller's onFrame.
         *
         * Used by the export pipeline to pull ~30fps of real-time frames per
         * camera without any HTML5 video element involvement.
         *
         * Behavior:
         *   - Automatically rewinds to the keyframe at/before startSec so the
         *     decoder has valid reference state.
         *   - Frames emitted BEFORE startSec (decoded as reference material only)
         *     are closed silently.
         *   - onFrame receives an ImageBitmap (caller owns it, must close when done).
         *   - If onFrame returns a promise, we await it before feeding more — the
         *     export pipeline uses this to keep memory bounded.
         *
         * @param {number} startSec  Inclusive start (event-relative in clip seconds)
         * @param {number} endSec    Exclusive end
         * @param {(bitmap: ImageBitmap, timestampSec: number) => void|Promise<void>} onFrame
         */
        async decodeSequence(startSec, endSec, onFrame) {
            if (!this.ready) throw new Error('not initialized');
            if (this.usedFallback) {
                return this._decodeSequenceFallback(startSec, endSec, onFrame);
            }
            if (!this.samples || this.samples.length === 0) return;

            const startCts = Math.round(startSec * this.timescale);
            const endCts = Math.round(endSec * this.timescale);
            const startMicros = startSec * 1_000_000;
            const endMicros = endSec * 1_000_000;

            // Find a valid sync sample to seed the decoder with. After
            // VideoDecoder.configure() the very first chunk MUST be is_sync
            // — otherwise we get "A key frame is required after configure()".
            //
            // Prefer the last sync sample at-or-before startCts (decoding
            // less wasted prefix is faster). If none exists before startCts
            // — e.g. startCts is earlier than the clip's first keyframe —
            // fall forward to the first sync sample we can find.
            let keyIdx = -1;
            for (let i = 0; i < this.samples.length; i++) {
                if (this.samples[i].cts > startCts) break;
                if (this.samples[i].is_sync) keyIdx = i;
            }
            if (keyIdx < 0) {
                for (let i = 0; i < this.samples.length; i++) {
                    if (this.samples[i].is_sync) { keyIdx = i; break; }
                }
            }
            if (keyIdx < 0) {
                console.warn('[FastClipDecoder] No sync samples in clip — cannot decode');
                return;
            }
            // Paranoid assertion — if for any reason keyIdx still points at a
            // non-sync sample, bail rather than crash the decoder.
            if (!this.samples[keyIdx].is_sync) {
                console.warn('[FastClipDecoder] keyIdx resolved to non-sync sample; skipping');
                return;
            }

            // Find the last sample index we need to feed (any sample with cts < endCts)
            let lastIdx = this.samples.length - 1;
            for (let i = keyIdx; i < this.samples.length; i++) {
                if (this.samples[i].cts >= endCts) { lastIdx = i - 1; break; }
            }
            if (lastIdx < keyIdx) return;

            // Fresh decoder state per call. Creating a new one is cheaper than
            // trying to reset-and-reconfigure an existing one — the reconfigure
            // path has been flaky in Chrome for H.264 streams.
            const outputs = [];
            let decoderError = null;
            const decoder = new window.VideoDecoder({
                output: (frame) => { outputs.push(frame); },
                error: (e) => {
                    const codec = this._decoderConfig?.codec || 'unknown';
                    console.error(`[FastFrameExtractor] Range-decoder error: ${e?.name || 'unknown'}: ${e?.message || String(e)} | codec=${codec} — possible hardware decode failure or GPU reset`);
                    decoderError = e;
                }
            });
            decoder.configure(this._decoderConfig);

            try {
                for (let i = keyIdx; i <= lastIdx; i++) {
                    if (decoderError) throw decoderError;
                    const s = this.samples[i];
                    decoder.decode(new window.EncodedVideoChunk({
                        type: s.is_sync ? 'key' : 'delta',
                        timestamp: Math.round((s.cts * 1_000_000) / this.timescale),
                        duration: Math.round((s.duration * 1_000_000) / this.timescale),
                        data: s.data
                    }));

                    // Drain ready frames. Hand off everything whose timestamp is
                    // in-range; drop everything before startMicros; skip past endMicros.
                    while (outputs.length > 0) {
                        const f = outputs[0];
                        if (f.timestamp >= endMicros) {
                            f.close();
                            outputs.shift();
                            continue;
                        }
                        if (f.timestamp < startMicros) {
                            f.close();
                            outputs.shift();
                            continue;
                        }
                        // In-range — emit. Convert to ImageBitmap so caller can
                        // draw it after we close the VideoFrame.
                        outputs.shift();
                        const bitmap = await createImageBitmap(f);
                        const tsSec = f.timestamp / 1_000_000;
                        f.close();
                        await onFrame(bitmap, tsSec);
                    }

                    // Backpressure — if decoder's internal queue gets huge, yield
                    // so we don't accumulate too many pending outputs at once.
                    if (decoder.decodeQueueSize > 30) {
                        await new Promise(r => setTimeout(r, 5));
                    }
                }

                // Flush any tail frames
                await decoder.flush();
                if (decoderError) throw decoderError;
                while (outputs.length > 0) {
                    const f = outputs.shift();
                    if (f.timestamp < startMicros || f.timestamp >= endMicros) {
                        f.close();
                        continue;
                    }
                    const bitmap = await createImageBitmap(f);
                    const tsSec = f.timestamp / 1_000_000;
                    f.close();
                    await onFrame(bitmap, tsSec);
                }
            } finally {
                for (const f of outputs) { try { f.close(); } catch {} }
                try { decoder.close(); } catch {}
            }
        }

        /** Fallback path — HTMLVideoElement seeking in a loop. Slower but works
         * when WebCodecs/mp4box aren't available. Emits one frame per (endSec-startSec)*30
         * evenly-spaced seeks, approximating 30fps. */
        async _decodeSequenceFallback(startSec, endSec, onFrame) {
            const fps = 30;
            const nFrames = Math.max(1, Math.floor((endSec - startSec) * fps));
            for (let i = 0; i < nFrames; i++) {
                const t = startSec + (i / fps);
                const { bitmap } = await this._extractFallback(t);
                await onFrame(bitmap, t);
            }
        }
    }

    window.FastClipDecoder = FastClipDecoder;
    window.FastClipDecoder.WEBCODECS_AVAILABLE = WEBCODECS_AVAILABLE;
})();
