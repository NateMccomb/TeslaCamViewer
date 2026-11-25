/**
 * VideoExport - Exports video segments with multiple views
 * Codec: VP9/H264 adaptive, 30fps target
 */

class VideoExport {
    /** An export file smaller than this is never real (a WebM header with no frames is 110 bytes). */
    static MIN_OUTPUT_BYTES = 1024;
    /** How long the output check waits for the browser to read a finished file back. */
    static VERIFY_TIMEOUT_MS = 15000;
    /** The shortest export the app starts (app.js: export.nothingToExport below it). */
    static MIN_EXPORT_SECS = 0.5;
    /** The browser's recorder (WebM fallback): how long after the last frame before it is stopped (its encoder's backlog). */
    static RECORDER_TAIL_MS = 3000;

    constructor(videoPlayer, layoutManager = null) {
        this.videoPlayer = videoPlayer;
        this.layoutManager = layoutManager;
        this._oid = 0x544356; // export origin id
        this.isExporting = false;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.onProgress = null;
        this.exportStartTime = null;
        this.lastProgressUpdate = 0;
        this.renderIntervalId = null; // For cleanup during cancel
        this.speedWasReduced = false; // Track if export speed was reduced due to buffering
        this.exportWallStartTime = null; // Track wall-clock start for ETA calculation
    }

    /**
     * Get export status for UI feedback
     * @returns {Object} Export status info
     */
    getExportStatus() {
        return {
            isExporting: this.isExporting,
            speedWasReduced: this.speedWasReduced,
            currentSpeed: this.currentExportSpeed,
            originalSpeed: this.exportSpeed,
            wallStartTime: this.exportWallStartTime,
            // the WebCodecs encoder in use: {muxName, software, framesDone, totalFrames, startedAt} (null before
            // one is picked, and for WebM/GIF)
            encoder: this.encoderInfo || null
        };
    }

    /**
     * Set layout manager reference
     * @param {LayoutManager} layoutManager
     */
    setLayoutManager(layoutManager) {
        this.layoutManager = layoutManager;
    }

    /**
     * Get camera order from layout manager (reflects user drag/drop swaps)
     * @returns {Array} Array of camera names in current visual order
     */
    getCameraOrder() {
        const hasPillars = this.videoPlayer?.hasPillarCameras || false;
        const defaultOrder = hasPillars
            ? ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar']
            : ['front', 'back', 'left_repeater', 'right_repeater'];
        return this.layoutManager?.cameraOrder || defaultOrder;
    }

    /**
     * Build mapping from layout position to actual video source based on camera order
     * When user swaps cameras via drag/drop, cameraOrder changes but layout positions don't
     * This mapping ensures export matches what user sees on screen
     * @returns {Object} Map of position name to video source name
     */
    buildCameraMapping() {
        const hasPillars = this.videoPlayer?.hasPillarCameras || false;
        const defaultOrder = hasPillars
            ? ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar']
            : ['front', 'back', 'left_repeater', 'right_repeater'];
        const currentOrder = this.getCameraOrder();

        // Map: position name -> which video to show there
        const mapping = {};
        for (let i = 0; i < defaultOrder.length; i++) {
            mapping[defaultOrder[i]] = currentOrder[i] || defaultOrder[i];
        }

        console.log('Camera mapping for export:', mapping);
        return mapping;
    }

    /**
     * Get layout configuration for export
     * Uses the same layout configuration as the display renderer for consistency
     * @param {number} videoWidth - Base video width
     * @param {number} videoHeight - Base video height
     * @returns {Object} Layout configuration with canvas size and video positions
     */
    getLayoutConfig(videoWidth, videoHeight) {
        const layout = this.layoutManager?.getCurrentLayout() || 'grid-2x2';

        // Always use getCurrentConfig + calculateExportConfig for consistent rendering
        if (this.layoutManager && this.layoutManager.renderer) {
            const layoutConfig = this.layoutManager.getCurrentConfig();
            if (layoutConfig) {
                const exportConfig = this.layoutManager.renderer.calculateExportConfig(
                    layoutConfig, videoWidth, videoHeight,
                    { visibleCameras: this.layoutManager.getVisibleCameras() }
                );
                console.log('Export layout config:', layoutConfig.name, exportConfig);
                return exportConfig;
            }
        }

        // Fallback: Default 2x2 grid if layoutManager not available
        const visibleCameras = this.layoutManager?.getVisibleCameras() || {
            front: true, back: true, left_repeater: true, right_repeater: true,
            left_pillar: true, right_pillar: true
        };
        const config = {
            canvasWidth: videoWidth * 2,
            canvasHeight: videoHeight * 2,
            aspectRatio: '4:3',
            cameras: {
                front: { x: 0, y: 0, w: videoWidth, h: videoHeight, visible: visibleCameras.front },
                back: { x: videoWidth, y: 0, w: videoWidth, h: videoHeight, visible: visibleCameras.back },
                left_repeater: { x: 0, y: videoHeight, w: videoWidth, h: videoHeight, visible: visibleCameras.left_repeater },
                right_repeater: { x: videoWidth, y: videoHeight, w: videoWidth, h: videoHeight, visible: visibleCameras.right_repeater },
                // Pillar cameras not shown in fallback 2x2 grid
                left_pillar: { x: 0, y: 0, w: 0, h: 0, visible: false },
                right_pillar: { x: 0, y: 0, w: 0, h: 0, visible: false }
            }
        };

        console.log('Export layout config (fallback):', layout, config);
        return config;
    }

    /**
     * True when a camera element has a clip. A native <video> whose src was
     * set to '' reports the page URL as its src, so `!v.src` never skipped a
     * camera with no clip and the waits below ran into their timeouts for it
     * on every frame. Same rule as the player's _hasSource (audit 1.8).
     * @param {HTMLVideoElement|HTMLCanvasElement} v
     * @returns {boolean}
     */
    _hasClip(v) {
        if (!v) return false;
        if (v._wcv || typeof v.getAttribute !== 'function') return !!v.src;
        return !!v.getAttribute('src');
    }

    /**
     * Wait for all videos to be ready at a specific timestamp
     * @param {number} targetTime - Target absolute time in seconds
     * @param {number} timeout - Max wait time in ms (default 5000)
     * @param {number} nativeCapMs - Max extra wait for a native <video> to present the frame (default 150)
     * @returns {Promise<boolean>} True if all videos are ready
     */
    async seekAndWaitForFrame(targetTime, timeout = 5000, nativeCapMs = 150) {
        const videos = this.videoPlayer.videos;
        const hasPillars = this.videoPlayer?.hasPillarCameras || false;
        const videoElements = hasPillars
            ? [videos.front, videos.back, videos.left_repeater, videos.right_repeater, videos.left_pillar, videos.right_pillar].filter(v => v)
            : [videos.front, videos.back, videos.left_repeater, videos.right_repeater].filter(v => v);

        // Set up `seeked` listeners BEFORE triggering the seek so we don't
        // race past the event. Each listener resolves once that video's
        // current frame matches the new currentTime.
        //
        // Why this matters: the previous implementation only polled
        // `readyState >= 2`, which is also true for the OLD frame still
        // loaded before a seek completes. drawImage(video) right after a
        // fresh seek would capture the STALE frame, so the export's
        // frameBuffer ended up holding ~the same frame for hundreds of
        // iterations. Most visible with plate blur on (slower iteration
        // cadence amplifies the artifact), where users saw "2 unique
        // frames in a 6s export" — one frame per clip boundary.
        const targetCurrentTime = (v) => {
            // After videoPlayer.seek/seekToEventTime the video's currentTime
            // gets clamped to [0, duration-0.05]. We only consider the seek
            // truly complete when the video reports a currentTime within
            // 50ms of where it should be. This is more robust than just
            // listening for the seeked event, which sometimes fires for
            // tiny seeks the browser optimizes away.
            return v.currentTime;
        };

        const seekedPromises = videoElements.map((v) => {
            if (!this._hasClip(v)) return Promise.resolve(true);
            return new Promise((resolveOne) => {
                let resolved = false;
                const onSeeked = () => {
                    if (resolved) return;
                    resolved = true;
                    v.removeEventListener('seeked', onSeeked);
                    v.removeEventListener('error', onError);
                    resolveOne(true);
                };
                const onError = () => {
                    if (resolved) return;
                    resolved = true;
                    v.removeEventListener('seeked', onSeeked);
                    v.removeEventListener('error', onError);
                    resolveOne(false);
                };
                v.addEventListener('seeked', onSeeked);
                v.addEventListener('error', onError);
            });
        });

        // Native <video>: listen for the next presented frame BEFORE the
        // seek, so a frame presented right after `seeked` isn't missed.
        const t0 = performance.now();
        const presentedWatch = this._watchPresentedFrames(videoElements);

        // Trigger the seek
        await this.videoPlayer.seekToEventTime(targetTime);

        // If a video was already at the target time, no `seeked` will fire.
        // Resolve those immediately by checking `readyState >= 2` after a
        // microtask to let any synchronous state settle.
        await Promise.resolve();
        const settled = videoElements.map((v, i) =>
            (!this._hasClip(v) || (!v.seeking && v.readyState >= 2))
                ? Promise.resolve(true)
                : seekedPromises[i]
        );

        // Cancellable timeout — the previous version used a bare setTimeout
        // inside Promise.race, which fires the "Frame seek timeout" warning
        // even AFTER the seek succeeds (Promise.race resolves but the
        // setTimeout was never cleared). That produced confusing stale
        // warnings logged during Phase 2 and after export completion,
        // and made every export look like it was timing out constantly
        // when in fact the seeks were succeeding fine.
        let timeoutHandle;
        const seekedOk = await Promise.race([
            Promise.all(settled).then((results) => {
                clearTimeout(timeoutHandle);
                return results.every(Boolean);
            }),
            new Promise((r) => {
                timeoutHandle = setTimeout(() => {
                    console.warn('Frame seek timeout at', targetTime);
                    r(false);
                }, timeout);
            })
        ]);

        // `seeked` alone isn't proof the frame for the new time is what a
        // drawImage will capture. Wait (within what is left of the timeout)
        // until every camera presents the frame for its currentTime.
        // WebCodecs-player cameras decode in software; on a busy machine a
        // clip change can take longer than `timeout`. A wrong frame is worse
        // than a slower export, so they get up to 5 s more, unless that
        // already failed for 3 frames in a row (a camera that can't decode
        // must not stall every frame).
        let remaining = Math.max(0, timeout - (performance.now() - t0));
        if (videoElements.some(v => v.src && v._wcv) && (this._wcPresentMisses || 0) < 3) remaining += 5000;
        const presentedOk = await presentedWatch.wait(remaining, targetTime, nativeCapMs);
        return seekedOk && presentedOk;
    }

    /**
     * True when a WebCodecs-player canvas shows the frame that is on screen
     * at its currentTime (the canvas checks this against its decoded frames,
     * so uneven frame spacing in Tesla clips is handled).
     */
    _wcFramePresented(v) {
        return !v.seeking && v.framePresented === true;
    }

    /**
     * Start watching for presented frames on the export's cameras. Call
     * before the seek; `wait(ms)` after it resolves true once every camera
     * shows the frame for its currentTime, or false at the time limit.
     *   - WebCodecs player canvases: checked directly (framePresented).
     *   - Native <video>: requestVideoFrameCallback must deliver a frame
     *     after the seek, nearer the new time than the old one. Only a
     *     short wait (nativeCapMs): drawImage already uses the seeked
     *     frame per spec, this only covers decoders that lag. Some setups
     *     never deliver it for paused video (hidden tab, headless); after
     *     3 misses in a row in one export, native cameras use `seeked` +
     *     readyState only.
     */
    _watchPresentedFrames(videoElements) {
        const nativeWatch = [];
        const useRvfc = this.isExporting && !this._rvfcOff
            && typeof HTMLVideoElement !== 'undefined'
            && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
        for (const v of videoElements) {
            if (!v.src || v._wcv || !useRvfc || !(v instanceof HTMLVideoElement)) continue;
            const w = { v, prevCt: v.currentTime, mediaTime: NaN, handle: null };
            const arm = () => {
                w.handle = v.requestVideoFrameCallback((now, meta) => {
                    w.mediaTime = meta.mediaTime;
                    arm();
                });
            };
            arm();
            nativeWatch.push(w);
        }
        const nativeOk = (w) => {
            const v = w.v;
            if (!this._hasClip(v) || v.readyState < 2) return true;   // nothing to wait for
            if (v.seeking) return false;
            const ct = v.currentTime;
            if (Math.abs(ct - w.prevCt) < 1e-4) return true;   // same time: no new frame to wait for
            if (!Number.isFinite(w.mediaTime)) return false;
            return w.mediaTime <= ct + 0.002 && Math.abs(ct - w.mediaTime) < Math.abs(w.prevCt - w.mediaTime);
        };
        const cancel = () => {
            for (const w of nativeWatch) {
                try { w.v.cancelVideoFrameCallback(w.handle); } catch {}
            }
        };
        return {
            wait: async (ms, targetTime, nativeCapMs = 150) => {
                const start = performance.now();
                const deadline = start + ms;
                const wcs = videoElements.filter(v => v.src && v._wcv);
                let reseeked = false;
                while (true) {
                    const wcBad = wcs.filter(v => !this._wcFramePresented(v));
                    const natBad = nativeWatch.filter(w => !nativeOk(w));
                    if (wcBad.length === 0 && natBad.length === 0) {
                        if (nativeWatch.length) this._rvfcMisses = 0;
                        if (wcs.length) this._wcPresentMisses = 0;
                        cancel();
                        return true;
                    }
                    const now = performance.now();
                    const nativeGaveUp = wcBad.length === 0 && now - start >= nativeCapMs;
                    if (now >= deadline || nativeGaveUp) {
                        cancel();
                        if (wcBad.length) {
                            this._wcPresentMisses = (this._wcPresentMisses || 0) + 1;
                            console.warn(`[Export] Frame not presented at ${targetTime?.toFixed?.(3)}s: ${wcBad.map(v => v.id || '?').join(', ')}`);
                        }
                        if (natBad.length && wcBad.length === 0) {
                            this._rvfcMisses = (this._rvfcMisses || 0) + 1;
                            if (this._rvfcMisses >= 3) {
                                this._rvfcOff = true;
                                console.log('[Export] requestVideoFrameCallback not delivered for paused video; using seeked only');
                            }
                        }
                        return false;
                    }
                    // A WebCodecs canvas that finished its seek but still
                    // isn't showing the target frame: ask once more for the
                    // same time (re-decodes if the frame isn't queued).
                    if (!reseeked && wcBad.some(v => !v.seeking) && now - start > 250) {
                        reseeked = true;
                        for (const v of wcBad) if (!v.seeking) v.currentTime = v.currentTime;
                    }
                    await new Promise(r => setTimeout(r, nativeWatch.length && wcBad.length === 0 ? 4 : 8));
                }
            }
        };
    }

    /**
     * Apply the user's Export → Quality preference to a layout config.
     * Returns a NEW config object (does not mutate the input) with
     * canvasWidth/Height + every camera rect uniformly scaled so the
     * aspect ratio, overlay geometry, and layout proportions stay correct.
     *
     * Presets:
     *   full    — native canvas (no scale)
     *   hd      — height capped at 1080 (downscale only, no upscale)
     *   web     — height capped at 720 (downscale only)
     *   custom  — user-specified height (upscale allowed)
     */
    _applyResolutionScale(layoutConfig) {
        if (!layoutConfig || !layoutConfig.canvasHeight) return layoutConfig;
        const settings = window.app?.settingsManager;
        const preset = settings?.get('exportResolution') || 'full';
        const nativeH = layoutConfig.canvasHeight;

        let scale = 1;
        if (preset === 'hd') {
            scale = Math.min(1, 1080 / nativeH);
        } else if (preset === 'web') {
            scale = Math.min(1, 720 / nativeH);
        } else if (preset === 'custom') {
            const target = parseInt(settings?.get('exportResolutionCustomHeight'), 10);
            if (target > 0 && target !== nativeH) {
                scale = target / nativeH;
            }
        }
        // Snap to 1 if we're within a rounding-error of it to avoid
        // microscopic rescales that waste GPU time.
        if (Math.abs(scale - 1) < 0.01) return layoutConfig;

        // Encoder constraints — dimensions must be even for H.264.
        let w = Math.round(layoutConfig.canvasWidth * scale);
        let h = Math.round(layoutConfig.canvasHeight * scale);
        if (w % 2) w -= 1;
        if (h % 2) h -= 1;
        const scaled = VideoExport.scaleLayoutConfig(layoutConfig, w, h);
        console.log(`[Export] Resolution preset "${preset}" applied: ${layoutConfig.canvasWidth}×${layoutConfig.canvasHeight} → ${scaled.canvasWidth}×${scaled.canvasHeight}`);
        return scaled;
    }

    /**
     * A NEW layout config of exactly width x height, every camera rect scaled
     * with it (the quality preset, and an export size the encoder can take).
     * @param {Object} layoutConfig
     * @param {number} width
     * @param {number} height
     * @returns {Object}
     */
    static scaleLayoutConfig(layoutConfig, width, height) {
        const sx = width / layoutConfig.canvasWidth, sy = height / layoutConfig.canvasHeight;
        const scaled = { ...layoutConfig, canvasWidth: width, canvasHeight: height, cameras: {} };
        for (const [name, cam] of Object.entries(layoutConfig.cameras || {})) {
            scaled.cameras[name] = {
                ...cam,
                x: Math.round(cam.x * sx),
                y: Math.round(cam.y * sy),
                w: Math.round(cam.w * sx),
                h: Math.round(cam.h * sy)
            };
        }
        return scaled;
    }

    /**
     * Frames and size of a GIF file, read from its blocks (no decoding).
     * @param {Uint8Array} b
     * @returns {{frames: number, width: number, height: number}|null}  null: not a GIF / cut short
     */
    static gifInfo(b) {
        if (!b || b.length < 13 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;
        const width = b[6] | (b[7] << 8), height = b[8] | (b[9] << 8);
        let p = 13;
        if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
        const skipSubBlocks = () => { while (p < b.length && b[p] !== 0) p += b[p] + 1; p++; };
        let frames = 0;
        while (p < b.length) {
            const t = b[p++];
            if (t === 0x3B) return { frames, width, height };
            if (t === 0x21) { p++; skipSubBlocks(); continue; }
            if (t === 0x2C) {
                if (p + 9 > b.length) return null;
                const flags = b[p + 8];
                p += 9;
                if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
                p++;                // LZW minimum code size
                skipSubBlocks();
                if (p > b.length) return null;
                frames++;
                continue;
            }
            return null;            // garbage where a block should be
        }
        return null;                // no trailer: cut short
    }

    /**
     * Is this export file real, before it is offered to the user? An encoder
     * or recorder that produced nothing used to end as a "complete" export of
     * a 110-byte WebM (a header with no frames). Fails on hard evidence only:
     * a tiny file, no or too few encoded frames, a video whose length is far
     * from the export's, a GIF with too few frames. When the browser can't
     * read the file back (a codec it can't play), the file passes on its size
     * and frame count.
     * @param {Blob} blob
     * @param {Object} o
     * @param {'video'|'gif'} o.kind
     * @param {number} o.expectedSecs     the export's length
     * @param {number} [o.expectedFrames] frames handed to the encoder / GIF
     * @param {number} [o.framesEncoded]  frames the encoder gave back (WebCodecs)
     * @returns {Promise<{ok: boolean, reason?: string, duration?: number, width?: number, height?: number, frames?: number, checked: string}>}
     */
    async _verifyOutput(blob, { kind, expectedSecs, expectedFrames = null, framesEncoded = null }) {
        const size = blob?.size || 0;
        const out = { ok: true, bytes: size, checked: 'size' };
        const fail = (reason, key, params = {}) => Object.assign(out, { ok: false, reason, key, params });
        if (size < VideoExport.MIN_OUTPUT_BYTES) return fail(`the file is only ${size} bytes`, 'tiny', { bytes: size });
        if (framesEncoded !== null && expectedFrames) {
            if (framesEncoded < Math.max(1, Math.floor(expectedFrames * 0.5))) {
                return fail(`the encoder returned ${framesEncoded} of ${expectedFrames} frames`, 'frames', { got: framesEncoded, want: expectedFrames });
            }
        }
        if (kind === 'gif') {
            let info = null;
            try { info = VideoExport.gifInfo(new Uint8Array(await blob.arrayBuffer())); } catch (e) { info = null; }
            if (!info) return fail('the GIF file is damaged or cut short', 'unreadable');
            Object.assign(out, { frames: info.frames, width: info.width, height: info.height, checked: 'gif' });
            if (info.frames < Math.max(1, Math.floor((expectedFrames || 1) * 0.5))) {
                return fail(`the GIF has ${info.frames} of ${expectedFrames} frames`, 'frames', { got: info.frames, want: expectedFrames });
            }
            return out;
        }
        // Read the video back: its size and length
        if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return out;
        const v = document.createElement('video');
        const url = URL.createObjectURL(blob);
        const wait = (events, ms) => new Promise((resolve) => {
            let timer = null;
            const done = (what) => {
                clearTimeout(timer);
                for (const ev of events) v.removeEventListener(ev, handlers[ev]);
                resolve(what);
            };
            const handlers = {};
            for (const ev of events) { handlers[ev] = () => done(ev); v.addEventListener(ev, handlers[ev]); }
            timer = setTimeout(() => done('timeout'), ms);
        });
        try {
            v.muted = true;
            v.preload = 'metadata';
            const meta = wait(['loadedmetadata', 'error'], VideoExport.VERIFY_TIMEOUT_MS);
            v.src = url;
            const got = await meta;
            if (got !== 'loadedmetadata') {
                const code = v.error?.code;
                // 4 = this browser can't decode it (not proof the file is bad); a timeout proves nothing either
                if (got === 'error' && code !== 4) return fail(`the file can't be read back (media error ${code})`, 'unreadable');
                console.warn(`[Export] Output check: the browser could not read the file back (${got}${code ? ' ' + code : ''}); checked its size only`);
                return out;
            }
            let d = v.duration;
            if (!Number.isFinite(d)) {
                // A MediaRecorder WebM has no length in its header: seeking far past the end makes the browser
                // read to the end and set the real one
                const changed = wait(['durationchange', 'seeked', 'error'], VideoExport.VERIFY_TIMEOUT_MS);
                v.currentTime = 1e7;
                await changed;
                d = v.duration;
            }
            Object.assign(out, { duration: Number.isFinite(d) ? d : null, width: v.videoWidth, height: v.videoHeight, checked: 'video' });
            if (!v.videoWidth || !v.videoHeight) return fail('the file has no picture', 'unreadable');
            if (Number.isFinite(d) && expectedSecs > 0) {
                const tol = Math.max(0.5, expectedSecs * 0.25);
                if (d < expectedSecs - tol || d > expectedSecs + Math.max(3, expectedSecs * 0.5)) {
                    return fail(`the video is ${d.toFixed(1)} s long, the export was ${expectedSecs.toFixed(1)} s`, 'length', { got: d.toFixed(1), want: expectedSecs.toFixed(1) });
                }
            }
            return out;
        } finally {
            try { v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
            URL.revokeObjectURL(url);
        }
    }

    /**
     * An export that stopped for a reason the app explains to the user (no encoder took it, its file wasn't real):
     * logged as a warning, not an error. The message and the reason go to the user; the console keeps the detail.
     */
    static isHandledFailure(err) {
        return !!err && (err.code === 'NO_ENCODER' || err.code === 'BAD_OUTPUT' || err.code === 'EXPORT_LIMIT');
    }

    /**
     * The free tier's export limit refused this event (the limit message is already on screen). app.js shows
     * nothing else for it: no error, and never "Export Complete".
     */
    static limitError() {
        const e = new Error('Export refused: the free export limit for today is reached');
        e.code = 'EXPORT_LIMIT';
        return e;
    }

    /**
     * The name an event goes by in the free export-limit message: its local date and time ("Nov 14, 2026, 3:20 PM"),
     * else its folder name.
     */
    static eventLabel(event) {
        if (!event) return null;
        const ts = event.timestamp ? new Date(event.timestamp) : null;
        if (ts && !isNaN(ts.getTime())) {
            const loc = (typeof window !== 'undefined' && window.i18n?.dateLocale?.()) || 'en-US';
            try {
                return ts.toLocaleString(loc, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
            } catch (e) { /* fall through */ }
        }
        return event.name || null;
    }

    /** Throw the error the app shows when an export file isn't real (app.js: export.badOutput). */
    static badOutputError(check, what) {
        const e = new Error(`Export produced a broken file (${what}): ${check.reason}`);
        e.code = 'BAD_OUTPUT';
        e.detail = check.reason;
        e.reasonKey = check.key || 'unreadable';
        e.reasonParams = check.params || {};
        e.what = what;
        return e;
    }

    /**
     * Capture the current DOM state of every export-relevant overlay as a
     * snapshot of pixel rectangles relative to the live .video-grid element.
     * This is the source-of-truth that unifies live UI and export rendering:
     * whatever the user sees on screen gets mirrored 1:1 into the canvas at
     * a scaled position, so there are no more per-layout drifts or
     * occlusion edge cases to debug — "what you see is what you export"
     * holds by construction.
     *
     * Returned shape:
     *   {
     *     grid: { w, h },   // DOM video-grid dimensions
     *     scaleX, scaleY,   // canvas-per-dom ratios (caller computes these)
     *     labels: [{ text, x, y, w, h, fontSize, fontFamily, fontWeight,
     *                color, bg, borderRadius, letterSpacing, padding: {l,t,r,b} }],
     *     hud: { x, y, w, h, visible } | null,
     *     map: { x, y, w, h, visible } | null
     *   }
     *
     * Returns null if .video-grid doesn't exist (degrades to legacy code).
     */
    _captureLiveOverlayMirror() {
        const grid = document.querySelector('.video-grid');
        if (!grid) return null;
        const gridRect = grid.getBoundingClientRect();
        if (!gridRect.width || !gridRect.height) return null;

        const mirror = {
            grid: { w: gridRect.width, h: gridRect.height },
            labels: [],
            hud: null,
            map: null
        };

        // Labels — read every .video-label currently in the DOM. Each keeps
        // its camera and both of its backgrounds (playing, ended): whether a
        // camera has ended is decided per exported frame (_endedCamerasAt),
        // not copied from the live player. After playing an event to its end
        // every live label is red, and that red was in every frame of the
        // next export (#586).
        const labelCamera = new Map();
        for (const [cam, el] of Object.entries(this.videoPlayer?.videoLabels || {})) {
            if (el) labelCamera.set(el, cam);
        }
        for (const el of grid.querySelectorAll('.video-label')) {
            if (el.offsetWidth === 0 || getComputedStyle(el).visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            const wasEnded = el.classList.contains('ended');
            el.classList.remove('ended');
            const bgPlaying = getComputedStyle(el).backgroundColor;
            el.classList.add('ended');
            const bgEnded = getComputedStyle(el).backgroundColor;
            if (!wasEnded) el.classList.remove('ended');
            mirror.labels.push({
                camera: labelCamera.get(el) || null,
                bgPlaying: bgPlaying || null,
                bgEnded: bgEnded || null,
                text: (el.textContent || '').trim(),
                x: r.x - gridRect.x,
                y: r.y - gridRect.y,
                w: r.width,
                h: r.height,
                fontSize: parseFloat(cs.fontSize) || 12,
                fontFamily: cs.fontFamily || 'monospace',
                fontWeight: cs.fontWeight || '500',
                color: cs.color || 'white',
                bg: cs.backgroundColor || 'rgba(0,0,0,0.75)',
                borderRadius: parseFloat(cs.borderRadius) || 4,
                letterSpacing: parseFloat(cs.letterSpacing) || 0,
                padding: {
                    l: parseFloat(cs.paddingLeft) || 0,
                    t: parseFloat(cs.paddingTop) || 0,
                    r: parseFloat(cs.paddingRight) || 0,
                    b: parseFloat(cs.paddingBottom) || 0
                }
            });
        }

        // HUD — only mirror if visible on live UI
        const hudEl = document.querySelector('.telemetry-overlay');
        if (hudEl && hudEl.offsetWidth > 0 && getComputedStyle(hudEl).display !== 'none'
            && window.app?.telemetryOverlay?.isVisible !== false) {
            const r = hudEl.getBoundingClientRect();
            mirror.hud = {
                x: r.x - gridRect.x,
                y: r.y - gridRect.y,
                w: r.width,
                h: r.height
            };
        }

        // Mini-map — only mirror if visible
        const mapEl = document.querySelector('.minimap-overlay');
        if (mapEl && mapEl.offsetWidth > 0 && getComputedStyle(mapEl).display !== 'none'
            && window.app?.miniMapOverlay?.isVisible !== false) {
            const r = mapEl.getBoundingClientRect();
            mirror.map = {
                x: r.x - gridRect.x,
                y: r.y - gridRect.y,
                w: r.width,
                h: r.height
            };
        }

        return mirror;
    }

    /**
     * The cameras that have ended at event time `absoluteTime`: each camera's
     * own length in that clip (videoPlayer.endedCamerasAt), from the exported
     * frame's time, never the live player's state (#586). A clip lasts until
     * its longest camera ends, so a shorter camera shows its last frame with
     * the ended label until then, like the player (#587).
     * @param {number} absoluteTime - event seconds of the exported frame
     * @returns {Set<string>}
     */
    _endedCamerasAt(absoluteTime) {
        const vp = this.videoPlayer;
        if (!vp || typeof vp.endedCamerasAt !== 'function') return new Set();
        const durations = vp.cachedClipDurations || [];
        if (!durations.length) return new Set();
        const { clipIndex, timeInClip } = VideoPlayer.locateTime(durations, absoluteTime);
        return vp.endedCamerasAt(clipIndex, timeInClip);
    }

    /**
     * Draw camera labels on the export canvas using a DOM mirror snapshot.
     * Matches the live UI's pixel positions + styling exactly (scaled to
     * canvas size). Replaces the old layoutRenderer.addLabelsToCanvas
     * occlusion-searching path — we now just draw where the DOM has them.
     */
    _drawLabelsFromMirror(ctx, mirror, canvasWidth, canvasHeight, endedCameras = null) {
        if (!mirror?.labels?.length) return;
        const scaleX = canvasWidth / mirror.grid.w;
        const scaleY = canvasHeight / mirror.grid.h;
        // Use the smaller scale for text so letters don't stretch horizontally
        // on slightly-off aspect ratios.
        const textScale = Math.min(scaleX, scaleY);

        for (const label of mirror.labels) {
            const x = label.x * scaleX;
            const y = label.y * scaleY;
            const w = label.w * scaleX;
            const h = label.h * scaleY;
            const radius = label.borderRadius * textScale;

            // Background (rounded rect): the ended colour only while this
            // camera has ended at this frame's time (#586)
            let bg = label.bg;
            if (endedCameras && label.camera) {
                bg = (endedCameras.has(label.camera) ? label.bgEnded : label.bgPlaying) || label.bg;
            }
            ctx.fillStyle = bg;
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(x, y, w, h, radius);
                ctx.fill();
            } else {
                ctx.fillRect(x, y, w, h);
            }

            // Text — uppercase to match the CSS text-transform of the live label
            ctx.fillStyle = label.color;
            ctx.font = `${label.fontWeight} ${label.fontSize * textScale}px ${label.fontFamily}`;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            const textX = x + label.padding.l * textScale;
            const textY = y + h / 2;
            // Approximate CSS letter-spacing by hand (ctx.letterSpacing is not
            // universally supported). For ~0.6px spacing and short ALL-CAPS
            // labels, the visual drift is under a pixel so we skip the
            // per-character draw loop here.
            const text = label.text.toUpperCase();
            try {
                ctx.letterSpacing = `${label.letterSpacing * textScale}px`;
            } catch {}
            ctx.fillText(text, textX, textY);
            try { ctx.letterSpacing = '0px'; } catch {}
        }
    }

    /**
     * Fast single-pass export — WebCodecs decoder on the input side AND
     * streaming WebCodecs encoder on the output side. No frameBuffer
     * accumulation. Memory stays bounded at ~a handful of VideoFrames
     * regardless of export length (was OOMing Chrome at ~50GB on a 60s
     * 6:3 export when we held all bitmaps in memory).
     *
     * Returns an MP4 Blob if successful. Caller is responsible for
     * downloading. Caller must check the return value and skip the legacy
     * Phase-2 encode path if a blob is returned.
     *
     * Deliberately matches legacy output pixel-for-pixel — uses the same
     * LayoutRenderer.calculateDrawParams math, same overlay bakers (camera
     * labels, timestamp/sentry/TCV branding, telemetry HUD, mini-map,
     * watermark). Only behavioral differences: (a) dramatically faster,
     * (b) no plate blur (caller suppresses this path when blur is enabled),
     * (c) direct MP4 output (no MediaRecorder intermediate).
     */
    /**
     * The burned-in export timestamp: the date in the browser's format, then
     * HH:MM:SS.cc, where .cc is hundredths of a second. The clock is 12-hour
     * with AM/PM or 24-hour, following the browser's locale like the date.
     * (Before: always 12-hour, and the field after the seconds was
     * fraction x 30, which matched neither Tesla's ~36 fps frames nor
     * hundredths.)
     * @param {Date} when      wall-clock time of this frame (whole seconds are used)
     * @param {number} secsInClip  time into the clip; its fraction gives .cc
     * @param {string} [locale]    for tests; default the browser's
     * @returns {string}
     */
    static formatOverlayTimestamp(when, secsInClip, locale) {
        const dateStr = locale ? when.toLocaleDateString(locale) : when.toLocaleDateString();
        const twelve = VideoExport.uses12HourClock(locale);
        let hours = when.getHours();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        if (twelve) hours = hours % 12 || 12;
        const pad = (n) => n.toString().padStart(2, '0');
        const frac = ((secsInClip % 1) + 1) % 1;
        const hundredths = Math.min(99, Math.floor(frac * 100 + 1e-6));
        const clock = `${pad(hours)}:${pad(when.getMinutes())}:${pad(when.getSeconds())}.${pad(hundredths)}`;
        return twelve ? `${dateStr} ${clock} ${ampm}` : `${dateStr} ${clock}`;
    }

    /**
     * Does this locale (default: the browser's) write times with AM/PM?
     * @param {string} [locale]
     * @returns {boolean}
     */
    static uses12HourClock(locale) {
        const key = locale || '';
        VideoExport._hourCycleCache = VideoExport._hourCycleCache || {};
        if (key in VideoExport._hourCycleCache) return VideoExport._hourCycleCache[key];
        let twelve = true;
        try {
            const o = new Intl.DateTimeFormat(locale || undefined, { hour: 'numeric' }).resolvedOptions();
            twelve = o.hour12 !== undefined ? o.hour12 : !/^h2[34]$/.test(o.hourCycle || '');
        } catch (e) { /* keep 12-hour */ }
        VideoExport._hourCycleCache[key] = twelve;
        return twelve;
    }

    /**
     * Encoder preference for an export format: 'compat' (H.264 first) for
     * "MP4 (H.264) - Max compatibility", 'webm' (VP9 / VP8 / AV1 into a WebM
     * file) for WebM, else 'quality' (VP9 first).
     * @param {string} format
     */
    static codecPreference(format) {
        if (format === 'webm') return 'webm';
        return format === 'mp4-h264' ? 'compat' : 'quality';
    }

    /**
     * After an export failed: the "codec|hw" keys to avoid on ONE retry, or
     * null for no retry. MP4 (H.264) whose browser-choice (usually GPU)
     * H.264 encoder stalled gets one; the retry then lands on the software
     * H.264 encoder, or VP9 if this browser has none. WebM whose
     * browser-choice encoder stalled gets one too: the retry lands on the
     * software VP9 encoder (or the next codec).
     * @returns {Array<string>|null}
     */
    static retryAvoidList(err, format, width, height, fps) {
        if (!err || err.code !== 'ENCODER_STALLED' || (format !== 'mp4-h264' && format !== 'webm')) return null;
        const c = err.codec;
        if (!c || c.hw === 'prefer-software') return null;
        if (format === 'mp4-h264' && c.name !== 'avc') return null;
        const VEF = (typeof window !== 'undefined' && window.VideoExportFast) || null;
        if (!VEF) return null;
        return VEF.codecCandidates(VideoExport.codecPreference(format), width, height, fps)
            .filter(x => x.name === c.name && x.hw !== 'prefer-software')
            .map(x => `${x.codec}|${x.hw}`);
    }

    /**
     * The encoder the progress screen describes (software H.264 is slow and says so).
     * @private
     */
    _setEncoderInfo(picked, totalFrames) {
        this.encoderInfo = picked ? {
            muxName: picked.muxName,
            name: picked.name,
            // the browser's software H.264, VP9 or VP8 encoder: slow at Full quality, so the progress screen says so
            // with its frames per second
            software: ['avc', 'vp9', 'vp8'].includes(picked.name) && picked.hw === 'prefer-software',
            framesDone: 0,
            totalFrames: totalFrames || 0,
            startedAt: performance.now()
        } : null;
    }

    /**
     * Note what the last export was really encoded with.
     * @param {{codec: string, name: string, muxName: string}|null} picked  WebCodecs choice
     * @param {string} [mimeType]  MediaRecorder type, when that path made the file
     * @private
     */
    _recordCodec(picked, mimeType, container = 'mp4') {
        if (!this.lastExport) this.lastExport = { format: null };
        if (picked) {
            this.lastExport.codec = picked.name;            // 'vp9' | 'avc' | 'av1' | 'vp8'
            this.lastExport.codecName = picked.muxName;
            this.lastExport.container = picked.container === 'webm' ? 'webm' : 'mp4';
        } else if (mimeType) {
            const m = mimeType.toLowerCase();
            this.lastExport.container = m.startsWith('video/mp4') ? 'mp4' : 'webm';
            this.lastExport.codec = m.includes('vp9') ? 'vp9' : (m.includes('h264') || m.includes('avc1')) ? 'avc' : null;
            this.lastExport.codecName = null;
        }
    }

    /**
     * One plain sentence for the export-complete screen: the real format of
     * the file, and what to pick if it won't play somewhere. Empty when
     * unknown (GIF, or an export that never got to an encoder).
     * @returns {string}
     */
    describeLastExport() {
        const e = this.lastExport;
        const size = this.describeExportSize();
        if (!e || !e.codec) return size;
        const codecNote = this._describeCodec();
        return [codecNote, size].filter(Boolean).join('\n');
    }

    /** What the last export's output check found (sizes from the file itself when it could be read back). */
    _recordCheck(check) {
        if (window.VideoExportFast?.dbg) window.VideoExportFast.dbg('stage: file check', check || null);
        if (!this.lastExport) this.lastExport = { format: null };
        this.lastExport.check = check || null;
        if (check && check.width && check.height) {
            this.lastExport.width = check.width;
            this.lastExport.height = check.height;
        }
    }

    /**
     * "Video size: 3840 × 1920", or, when this device's encoder couldn't take
     * the asked size, the size it got and the one that was asked. Empty when
     * unknown.
     * @returns {string}
     */
    describeExportSize() {
        const e = this.lastExport;
        if (!e || !e.width || !e.height) return '';
        const t = (key, params) => (window.i18n ? window.i18n.t(key, params) : key);
        const size = `${e.width} × ${e.height}`;
        if (e.reduced && e.askedWidth && e.askedHeight && e.format !== 'gif') {
            return t('export.sizeReduced', { size, asked: `${e.askedWidth} × ${e.askedHeight}` });
        }
        return t('export.sizeNote', { size });
    }

    /** The codec half of describeLastExport. */
    _describeCodec() {
        const e = this.lastExport;
        const wanted = e.format;
        const t = (key, params) => (window.i18n ? window.i18n.t(key, params) : key);
        if (e.container === 'webm') {
            // VP9 unless the WebCodecs path had to use VP8 or AV1 here
            if (e.codec === 'vp8' || e.codec === 'av1') return t('export.noteWebmCodec', { codec: e.codec === 'vp8' ? 'VP8' : 'AV1' });
            return t('export.noteWebm');
        }
        if (e.codec === 'avc') {
            return t('export.noteH264');
        }
        const label = e.codec === 'av1' ? 'AV1' : 'VP9';
        if (wanted === 'mp4-h264') {
            return t('export.noteNoH264', { codec: label });
        }
        return t('export.noteMp4', { codec: label });
    }

    async _renderPhase1FastDecoder(params) {
        const {
            event, layoutConfig, cameraMapping,
            canvasWidth, canvasHeight,
            renderCanvas, renderCtx,
            exportStart, exportEnd, fps,
            totalFrames,
            includeOverlay,
            videos
        } = params;

        if (!event) throw new Error('no currentEvent loaded for fast decoder');

        const visibleCameras = Object.entries(layoutConfig.cameras)
            .filter(([name, cam]) => cam.visible && cam.w > 0 && cam.h > 0)
            .map(([name]) => cameraMapping[name] || name);

        const clipDurations = this.videoPlayer?.cachedClipDurations || [];

        const decoder = new window.MultiCameraExportDecoder();
        await decoder.init({
            event,
            visibleCameras,
            clipDurations,
            startEventSec: exportStart,
            endEventSec: exportEnd,
            fps
        });

        // Sort cameras by z-index once; the order doesn't change per-frame.
        const sortedCameras = Object.entries(layoutConfig.cameras)
            .filter(([name, cam]) => cam.visible && cam.w > 0 && cam.h > 0)
            .sort((a, b) => (a[1].zIndex || 1) - (b[1].zIndex || 1));

        const settings = window.app?.settingsManager;
        const privacyMode = settings && settings.get('privacyModeExport') === true;

        // Capture the live DOM's overlay layout ONCE at the start of export.
        // This snapshot is the source of truth for where labels/HUD/mini-map
        // go on the canvas, so export is a pixel-accurate mirror of what
        // the user has on screen. Eliminates all the per-layout drift we
        // kept hitting.
        const mirror = this._captureLiveOverlayMirror();
        const mirrorScaleX = mirror ? canvasWidth / mirror.grid.w : 1;
        const mirrorScaleY = mirror ? canvasHeight / mirror.grid.h : 1;

        // Create the streaming encoder up front — one encoder handles all frames,
        // no buffering between phases.
        const fastEncoder = new window.VideoExportFast();
        let stream;
        try {
            stream = await fastEncoder.createStreamingEncoder({
                width: canvasWidth,
                height: canvasHeight,
                fps,
                codecPreference: VideoExport.codecPreference(params.format),
                avoid: params.avoidCodecs || [],
                picked: params.pickedCodec || null,
                onProgress: (encoded) => {
                    // Encoder progress lags behind render progress by its queue
                    // depth; we report render progress below as the user-facing
                    // signal. The frames-per-second line counts what the encoder
                    // has really finished, including the ones it finishes while
                    // the file is being closed.
                    if (this.encoderInfo) this.encoderInfo.framesDone = encoded;
                }
            });
        } catch (err) {
            // No encoder: release the decoder's file handles before giving up
            await decoder.close();
            throw err;
        }
        this._recordCodec(fastEncoder.pickedCodec);
        this._setEncoderInfo(fastEncoder.pickedCodec, totalFrames);

        try {
            let frameNum = 0;
            while (decoder.hasMore()) {
                if (!this.isExporting) {
                    console.log('Export cancelled during rendering');
                    stream.abort();
                    await decoder.close();
                    return null;
                }

                const { eventTime, frames } = await decoder.nextOutputFrame();
                const absoluteTime = eventTime;

                // Clear canvas
                renderCtx.fillStyle = '#000000';
                renderCtx.fillRect(0, 0, canvasWidth, canvasHeight);

                // Composite each visible camera, building cameraInfos for
                // optional plate blur in the same pass — avoids walking the
                // sorted list twice.
                const camInfosForBlur = {};
                for (const [camPosition, camConfig] of sortedCameras) {
                    const actualCameraName = cameraMapping[camPosition] || camPosition;
                    const bitmap = frames.get(actualCameraName);
                    if (!bitmap) continue;
                    const { sx, sy, sw, sh, dx, dy, dw, dh } =
                        window.LayoutRenderer.calculateDrawParams(bitmap, camConfig);
                    renderCtx.drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh);
                    camInfosForBlur[actualCameraName] = {
                        video: bitmap,  // ImageBitmap — plateBlur accepts it
                        dx: camConfig.x,
                        dy: camConfig.y,
                        dw: camConfig.w,
                        dh: camConfig.h,
                        crop: camConfig.crop || { top: 0, right: 0, bottom: 0, left: 0 },
                        objectFit: camConfig.objectFit || 'contain'
                    };
                }

                // Plate blur on the fast path. Same processMultiCamera call
                // the legacy path uses; just operates on ImageBitmap sources
                // instead of <video> elements.
                const blurPlatesEnabled = window.app?.settingsManager?.get('blurLicensePlates') === true;
                if (blurPlatesEnabled && window.app?.plateBlur?.isReady?.()) {
                    try {
                        // Detect every 5th frame (~6/sec at 30fps). Tracker
                        // bridges the 5-frame gap with IoU/EMA + velocity
                        // prediction so the user can't tell the difference,
                        // and YOLO inference dominates plate-blur export
                        // wall-clock. 5-frame cadence ≈ 167ms at 30fps —
                        // user-confirmed acceptable lower bound.
                        await window.app.plateBlur.processMultiCamera(renderCtx, camInfosForBlur, {
                            forceDetection: frameNum % 5 === 0, cadence: 'frames'
                        });
                    } catch (blurError) {
                        if (frameNum % 30 === 0) console.warn('[FastDecoder] Plate blur error:', blurError);
                    }
                }

                // Watermark (free tier)
                if (this._shouldWatermark) {
                    this.addWatermarksToFrame(renderCtx, layoutConfig);
                }

                // Camera labels — mirror live DOM labels onto the canvas at
                // scaled pixel positions. What you see on screen is what
                // gets drawn, which eliminates per-layout drift and
                // occlusion edge cases from the old canvas-label renderer.
                const endedCameras = this._endedCamerasAt(absoluteTime);
                if (mirror) {
                    this._drawLabelsFromMirror(renderCtx, mirror, canvasWidth, canvasHeight, endedCameras);
                } else if (this.layoutManager?.renderer) {
                    this.layoutManager.renderer.addLabelsToCanvas(renderCtx, layoutConfig, {
                        fontSize: Math.round(18 * (canvasWidth / 1920)),
                        cameraMapping,
                        endedCameras
                    });
                }

                // Timestamp / sentry / branding overlay
                if (includeOverlay && !privacyMode) {
                    this.addOverlay(renderCtx, canvasWidth, canvasHeight, absoluteTime);
                }

                // Telemetry HUD + mini-map — pass the mirror so positioning
                // comes from the live DOM instead of the saved percent.
                this._renderTelemetryAndMap(renderCtx, canvasWidth, canvasHeight, absoluteTime, {
                    privacyMode, mirror, mirrorScaleX, mirrorScaleY
                });

                // Encode this frame immediately — feed canvas straight to
                // VideoFrame/Encoder. No intermediate ImageBitmap allocation.
                await stream.encode(renderCanvas, frameNum);
                // frames the encoder has finished (not just accepted), so the time left includes its queue
                if (this.encoderInfo) this.encoderInfo.framesDone = stream.stats ? stream.stats.framesEncoded : frameNum + 1;

                if (this.onProgress) {
                    // Single-phase pipeline: render+encode combined get 0-100%
                    const progressPercent = ((frameNum + 1) / totalFrames) * 100;
                    this.onProgress(progressPercent, absoluteTime - exportStart, exportEnd - exportStart);
                }

                frameNum++;
                // Let the page answer (Cancel, the progress line): every 5 frames, every frame with plate blur on
                // (a blurred 6-camera frame can take seconds)
                if (frameNum % 5 === 0 || blurPlatesEnabled) {
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            // Flush encoder and return the mp4 / webm blob. Caller triggers the download.
            const blob = await stream.finalize();
            const what = stream.picked?.container === 'webm' ? 'WebM' : 'MP4';
            console.log(`[FastDecoder] Encoded ${frameNum} frames into ${(blob.size / 1_000_000).toFixed(1)} MB ${what}` +
                (stream.sink ? ` (at most ${(stream.sink.peakPendingBytes / 1_000_000).toFixed(1)} MB of it in page memory)` : ''));
            // The file must be real before it's offered (frames out of the encoder, then the file read back)
            const check = await this._verifyOutput(blob, {
                kind: 'video', expectedSecs: exportEnd - exportStart,
                expectedFrames: frameNum, framesEncoded: stream.stats ? stream.stats.framesEncoded : null
            });
            this._recordCheck(check);
            if (!check.ok) throw VideoExport.badOutputError(check, what);
            return blob;
        } catch (err) {
            try { stream.abort(); } catch {}
            throw err;
        } finally {
            await decoder.close();
        }
    }

    /**
     * Export using frame-by-frame capture (no real-time playback)
     * This method seeks to each frame and waits for it to be ready before capturing.
     * Slower but eliminates stuttering issues.
     */
    /**
     * Export using pre-rendered frames with buffered MediaRecorder.
     * This approach renders all frames first, then plays them back for recording.
     */
    async exportFrameByFrame(options = {}) {
        const {
            format = 'webm',
            quality = 0.9,
            startTime = null,
            endTime = null,
            includeOverlay = true,
            onProgress = null,
            fps = 30,
            singleCamera = null
        } = options;

        if (this.isExporting) {
            throw new Error('Export already in progress');
        }

        // Free-tier gate: must run BEFORE any state mutation and BEFORE
        // the GIF dispatch (so GIF inherits the same gate without
        // double-checking). The cap was previously unenforced — UI
        // flow goes through this path, not startExport, so the access
        // check there never fired.
        const accessOK = await this._checkExportAccess();
        if (!accessOK) throw VideoExport.limitError();

        // No file saved yet by this export (set by _recordExportSuccess); app.js shows "Export Complete" only after one
        this.lastExportSaved = false;

        // What the file really ends up as, for the completion message
        // (describeLastExport). MP4 (VP9) and MP4 (H.264) are both .mp4.
        this.lastExport = { format, codec: null, codecName: null };
        this.encoderInfo = null;

        // Handle GIF export separately (forward singleCamera so GIF path also honors it).
        // Pass _accessChecked so exportAsGif doesn't double-gate.
        if (format === 'gif') {
            return this.exportAsGif({ ...options, singleCamera, _accessChecked: true });
        }

        console.log('Starting buffered frame-by-frame export...');
        const VEFd = window.VideoExportFast;
        if (VEFd?.debugStart) VEFd.debugStart({ format, startTime: options.startTime, endTime: options.endTime, singleCamera: singleCamera || null });
        const dbg = (...a) => { if (VEFd?.dbg) VEFd.dbg(...a); };
        this._dbg = dbg;

        this.isExporting = true;
        this.exportWallStartTime = Date.now();
        this.onProgress = onProgress;
        this.recordedChunks = [];

        // Reset plate-blur tracker so a previous export's ghost tracks
        // don't flash onto the first few frames of this one.
        if (window.app?.plateBlur?.resetTracker) {
            window.app.plateBlur.resetTracker();
        }

        const videos = this.videoPlayer.videos;
        const primaryCamera = singleCamera || 'front';
        if (!videos[primaryCamera] || !videos[primaryCamera].src) {
            this.isExporting = false;
            throw new Error(`No video loaded${singleCamera ? ` for ${singleCamera}` : ''}`);
        }

        // Pause any playback
        await this.videoPlayer.pause();

        // Check if watermark is needed
        await this._checkWatermark();

        // This event's length and overlay clock, worked out fresh for every
        // export. Both used to be kept from the session's first export, so the
        // next export of another event got its clock and its end (#524).
        this._resetExportCaches();
        this.cachedTotalDuration = await this.videoPlayer.getTotalDuration();

        // Determine export range
        const exportStart = startTime !== null ? startTime : 0;
        const exportEnd = endTime !== null ? endTime : this.cachedTotalDuration;
        const exportDuration = exportEnd - exportStart;
        const frameInterval = 1 / fps;
        const totalFrames = Math.ceil(exportDuration * fps);

        console.log(`Buffered export: ${totalFrames} frames @ ${fps}fps, ${exportStart.toFixed(2)}s to ${exportEnd.toFixed(2)}s`);

        // Get video dimensions (reference from the primary camera)
        const refVideo = videos[primaryCamera];
        const videoWidth = refVideo.videoWidth || 1280;
        const videoHeight = refVideo.videoHeight || 960;

        // Get layout config — single-camera mode synthesizes a fullscreen one-camera layout
        // so the rest of the pipeline treats it identically to any other layout (6:3, 2x2, etc.)
        let layoutConfig;
        if (singleCamera) {
            layoutConfig = {
                canvasWidth: videoWidth,
                canvasHeight: videoHeight,
                cameras: {
                    [singleCamera]: {
                        x: 0, y: 0, w: videoWidth, h: videoHeight,
                        visible: true, zIndex: 1,
                        crop: { top: 0, right: 0, bottom: 0, left: 0 },
                        objectFit: 'contain'
                    }
                }
            };
        } else {
            layoutConfig = this.getLayoutConfig(videoWidth, videoHeight);
        }
        // Apply user-selected resolution cap (Settings → Export → Quality).
        // Scales the whole config uniformly so camera rects + aspect ratio
        // stay correct; overlays follow suit via the mirror's scale math.
        layoutConfig = this._applyResolutionScale(layoutConfig);
        if (!layoutConfig.canvasWidth || !layoutConfig.canvasHeight) {
            layoutConfig = { ...layoutConfig, canvasWidth: layoutConfig.canvasWidth || 1920, canvasHeight: layoutConfig.canvasHeight || 1080 };
        }
        const askedWidth = layoutConfig.canvasWidth, askedHeight = layoutConfig.canvasHeight;

        // MP4: find the size and encoder BEFORE rendering anything (VideoExportFast.prepare): the asked size if
        // an encoder here takes it (isConfigSupported + a one-frame probe at that exact size), else the largest
        // smaller one with the same shape, else stop now with a clear message. A 6-camera export (3840x1920)
        // used to probe 7 encoders for 20 s each and then fail (2026-11-19).
        const fastExportOn = window.VideoExportFast?.isSupported?.()
            && window.app?.settingsManager?.get('fastExportExperimental') !== false;
        const webCodecsMp4 = format !== 'webm' && fastExportOn;
        // WebM is encoded while it is rendered too (WebCodecs VP9, else VP8 / AV1, into webm-muxer), like MP4: no
        // frame buffer, no real-time recording. It used to keep every rendered frame as a full-size bitmap (29.5 MB
        // a frame at 3840x1920, ~53 GB a minute) and then play them into the browser's MediaRecorder in real time,
        // which dropped frames on a busy PC; after ~14 GB the cameras stopped updating (#515). The recorder path
        // below stays for browsers without WebCodecs, an encoder that takes no size here, or Fast Export off.
        const webCodecsWebm = format === 'webm' && fastExportOn;
        const fastDecoderPossible = !singleCamera && format !== 'webm'
            && window.MultiCameraExportDecoder?.isSupported?.() && window.VideoExportFast?.isSupported?.();
        let preparedCodec = null;
        let skipWebCodecsEncode = false;
        let sizeReduced = false;
        if (webCodecsMp4 || webCodecsWebm) {
            try {
                if (this.onProgress) this.onProgress(0, 0, exportDuration);
                const fit = await new window.VideoExportFast().prepare({
                    width: askedWidth, height: askedHeight, fps, codecPreference: VideoExport.codecPreference(format)
                });
                preparedCodec = fit.picked;
                sizeReduced = fit.reduced;
                if (fit.width !== askedWidth || fit.height !== askedHeight) {
                    layoutConfig = VideoExport.scaleLayoutConfig(layoutConfig, fit.width, fit.height);
                }
            } catch (err) {
                if (!this.isExporting) return;
                if (webCodecsWebm && err?.code === 'NO_ENCODER') {
                    // WebM, and no WebM encoder here takes the export at any size: say so now, before anything is
                    // rendered (app.js: export.noWebmEncoder suggests MP4). The browser's recorder isn't tried: on
                    // such a device it made a 0.0 s file after the whole render (a test laptop, 2026-11-21).
                    this.isExporting = false;
                    err.format = 'webm';
                    throw err;
                } else if (webCodecsWebm) {
                    // WebM, but webm-muxer couldn't load (an old offline package): the browser's recorder gets its try
                    skipWebCodecsEncode = true;
                    console.warn(`[Export] ${err?.message || err}; recording the WebM with the browser's recorder instead`);
                } else if (err?.code !== 'NO_ENCODER' || fastDecoderPossible) {
                    this.isExporting = false;
                    throw err;
                } else {
                    // single-camera MP4: the browser's MediaRecorder still gets its try (its file is checked too)
                    skipWebCodecsEncode = true;
                    console.warn(`[Export] ${err.message}; trying the browser's recorder instead`);
                }
            }
            if (!this.isExporting) return;   // cancelled while probing
        }
        if (!webCodecsMp4 && !preparedCodec && window.VideoExportFast?.recorderSize) {
            // WebM (the browser's recorder): it can't be test-encoded first, so it gets the export size limit only
            const fit = window.VideoExportFast.recorderSize(askedWidth, askedHeight);
            if (fit.width * fit.height < askedWidth * askedHeight * 0.99) sizeReduced = true;
            if (fit.width !== askedWidth || fit.height !== askedHeight) {
                layoutConfig = VideoExport.scaleLayoutConfig(layoutConfig, fit.width, fit.height);
            }
        }

        const canvasWidth = layoutConfig.canvasWidth;
        const canvasHeight = layoutConfig.canvasHeight;
        this.lastExport.width = canvasWidth;
        this.lastExport.height = canvasHeight;
        this.lastExport.askedWidth = askedWidth;
        this.lastExport.askedHeight = askedHeight;
        this.lastExport.reduced = sizeReduced;

        console.log(`Canvas size: ${canvasWidth}x${canvasHeight}${singleCamera ? ` (single-camera: ${singleCamera})` : ''}`
            + (sizeReduced ? ` (asked ${askedWidth}x${askedHeight}; reduced for this device's encoder)` : ''));

        // Note: We skip pre-rendering telemetry and use on-demand rendering instead.
        // On-demand rendering uses the video player's actual clip/time state, which ensures
        // the telemetry matches exactly what the user saw during preview.
        // Pre-rendering had timing drift issues due to clip duration estimation.

        // Get camera mapping (single-camera mode bypasses position remapping)
        const cameraMapping = singleCamera
            ? { [singleCamera]: singleCamera }
            : this.buildCameraMapping();

        // Pre-cache mini-map tiles (shared method)
        await this._preCacheMiniMapTiles(exportStart, exportEnd);
        await this._prepareGpsExportOverlays(exportStart, exportEnd);

        // Progress-bar split between Phase 1 (pre-render) and Phase 2 (encode).
        // Phase 1 is dominated by per-frame seeking, compositing, plate blur,
        // and overlay rendering, so in practice it's the slower phase for both
        // paths. Fast Export's Phase 2 is ~10% of wall time; MediaRecorder's
        // Phase 2 is typically ~25% because even at realtime capture, there's
        // no heavy per-frame work being done.
        // Fast-export is now the default when WebCodecs is available (was
        // previously opt-in via "fastExportExperimental" toggle). The toggle
        // still exists as an emergency rollback but defaults to on.
        const willUseFastExport = window.VideoExportFast?.isSupported()
            && window.app?.settingsManager?.get('fastExportExperimental') !== false;
        let phase1PctMax = willUseFastExport ? 90 : 75;

        // Phase 1: Render all frames to ImageData buffer
        console.log(`Phase 1: Rendering frames to buffer... (progress ends at ${phase1PctMax}%)`);
        const frameBuffer = [];
        const renderCanvas = document.createElement('canvas');
        // Frees the rendered frames (idempotent: close() twice is fine) and the render canvas's backing store
        const releaseExportMemory = () => {
            let n = 0;
            for (const bitmap of frameBuffer) {
                if (bitmap && typeof bitmap.close === 'function') { try { bitmap.close(); n++; } catch (e) { /* closed */ } }
            }
            frameBuffer.length = 0;
            try { renderCanvas.width = 0; renderCanvas.height = 0; } catch (e) { /* gone */ }
            dbg('stage: memory released', { frames: n });
        };
        renderCanvas.width = canvasWidth;
        renderCanvas.height = canvasHeight;
        const renderCtx = renderCanvas.getContext('2d', { alpha: false });

        // GPU context-loss surveillance. Hardware-accelerated 2D canvases
        // fire `contextlost` when Windows TDR (or equivalent) resets the
        // driver; without this we'd see exports just hang or fail with
        // opaque errors. Capture a clear signal in the diagnostics ring
        // buffer + flag on the canvas so callers can react.
        this._renderCanvasLost = false;
        renderCanvas.addEventListener('contextlost', (e) => {
            this._renderCanvasLost = true;
            console.error(`[GPUContextLost] Phase 1 render canvas — ${canvasWidth}x${canvasHeight} — likely Windows TDR or GPU process crash. frames buffered so far: ${frameBuffer.length}`);
        });
        renderCanvas.addEventListener('contextrestored', () => {
            console.warn('[GPUContextLost] Phase 1 render canvas restored — export already failed if it triggered mid-render');
        });

        // ---- Fast decoder path (WebCodecs) ----
        // Pulls frames directly from each camera's mp4 bitstream via WebCodecs
        // VideoDecoder — no HTML5 video seeking, no readyState polling. Typically
        // 3–10× faster than the legacy loop. Falls back cleanly if unsupported
        // or on any error mid-flight.
        //
        // Scope limits (take legacy path instead):
        //   - singleCamera export (layout synthesis path, different wiring)
        //   - WebM with no WebCodecs encoder prepared above (the legacy
        //     MediaRecorder + VP9 path); with one, WebM runs here like MP4
        //     (VP9 / VP8 / AV1 into webm-muxer)
        //
        // Plate blur runs cleanly on the fast path with the post-Apr-19
        // tracker code. The 2026.20.6.1 release process briefly gated the
        // fast path off when blur was enabled — that turned out to be
        // unnecessary; the actual bug was that the GitHub/ deployment
        // folder had a pre-rewrite plateBlur.js cached. Fast path with
        // blur now produces correctly-blurred MP4s.
        const fastDecoderAvailable = !singleCamera
            && (format !== 'webm' || !!preparedCodec)
            && window.MultiCameraExportDecoder?.isSupported?.()
            && window.VideoExportFast?.isSupported?.();
        let usedFastDecoder = false;

        let fastBlob = null;
        let fastPathStarted = false;
        let fastPathError = null;
        if (fastDecoderAvailable) {
            try {
                const fastT0 = performance.now();
                fastPathStarted = true;
                const fastParams = {
                    event: this.videoPlayer.currentEvent,
                    layoutConfig, cameraMapping,
                    canvasWidth, canvasHeight,
                    renderCanvas, renderCtx,
                    exportStart, exportEnd, fps,
                    totalFrames, frameInterval,
                    includeOverlay,
                    videos,
                    format,
                    pickedCodec: preparedCodec
                };
                try {
                    dbg('stage: render + encode (WebCodecs decoder, streaming encoder)', { format, canvasWidth, canvasHeight, totalFrames, codec: preparedCodec?.muxName || null });
                    fastBlob = await this._renderPhase1FastDecoder(fastParams);
                } catch (err) {
                    // A GPU H.264 encoder that passed its probe but then stopped
                    // answering mid-export: run the export once more on the
                    // browser's software H.264 encoder (still H.264, slower).
                    const avoid = VideoExport.retryAvoidList(err, format, canvasWidth, canvasHeight, fps);
                    if (!avoid || !this.isExporting) throw err;
                    console.warn(`[FastDecoder] ${err.message}; retrying once with ${format === 'webm' ? 'the next WebM encoder (software)' : 'the software H.264 encoder'}`);
                    dbg('stage: retry after a stall', { avoid });
                    if (this.onProgress) this.onProgress(0, 0, exportEnd - exportStart);
                    fastBlob = await this._renderPhase1FastDecoder({ ...fastParams, avoidCodecs: avoid });
                }
                usedFastDecoder = !!fastBlob;
                if (fastBlob) {
                    const fastElapsed = (performance.now() - fastT0) / 1000;
                    console.log(`[FastDecoder] Single-pass encode finished in ${fastElapsed.toFixed(2)}s (${(exportDuration / fastElapsed).toFixed(2)}× realtime)`);
                }
            } catch (err) {
                console.warn('[FastDecoder] Fast path failed:', err);
                fastBlob = null;
                usedFastDecoder = false;
                fastPathError = err;
            }
        }

        // If the fast path started but failed partway through, the legacy
        // HTML5-video path can't reliably take over — our decoder held
        // file handles, the player's video elements may be in an error
        // state, and the user would just watch another 10 minutes of
        // rendering spewing error messages. Surface a clear error instead
        // and offer the emergency-rollback instructions.
        if (fastPathError && fastPathStarted) {
            this.isExporting = false;
            releaseExportMemory();
            // A stalled encoder has its own message (app.js: export.encoderStalled)
            if (fastPathError.code === 'ENCODER_STALLED') throw fastPathError;
            // No encoder took the export, or its file isn't real: their own messages too (export.noEncoder / badOutput)
            if (fastPathError.code === 'NO_ENCODER' || fastPathError.code === 'BAD_OUTPUT') throw fastPathError;
            // Encoder/decoder failures inside the fast path are often
            // transient — a stale WebCodecs context from earlier in the
            // session, a GPU encoder that wedged after a previous run,
            // etc. A page reload clears WebCodecs state entirely and
            // typically lets the same export succeed on retry, so we
            // recommend that as the primary remedy. The devtools escape
            // hatch is kept for power users / support sessions; most
            // users should just refresh and retry, or report the issue.
            throw new Error(
                `Export failed: ${fastPathError.message || fastPathError}\n\n` +
                `Try this first: refresh the page (Ctrl+Shift+R) and retry the export. ` +
                `Most encoder errors are transient WebCodecs state that a reload clears.\n\n` +
                `If it still fails after a reload, please send the diagnostic log to ` +
                `support@teslacamviewer.com — Settings → Diagnostics → Console Log Capture ` +
                `has a Copy / Download button that includes the codec and dimensions we need.`
            );
        }

        // If the fast single-pass path produced a blob, skip everything else
        // and just download it. Legacy Phase-2 encode never runs in this case.
        if (fastBlob) {
            const url = URL.createObjectURL(fastBlob);
            const a = document.createElement('a');
            a.href = url;
            const labelMap = { front: 'front', back: 'rear', left_repeater: 'left', right_repeater: 'right', left_pillar: 'left-pillar', right_pillar: 'right-pillar' };
            const camLabel = singleCamera ? `_${labelMap[singleCamera] || singleCamera}` : '';
            const tail = /webm/.test(fastBlob.type) ? '.webm' : '_fast.mp4';
            a.download = `TeslaCam_Export${camLabel}_${VideoExport.localFileStamp(new Date(), true)}${tail}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this._recordExportSuccess();
            this.isExporting = false;
            releaseExportMemory();
            if (this.onProgress) this.onProgress(100, exportDuration, exportDuration);
            console.log('[FastDecoder] Export complete');
            return;
        }

        // WebM through the player (single camera, or no WebCodecs decoder): encode each frame as it is rendered,
        // like the fast path, instead of buffering it for the recorder
        let legacyStream = null;
        try {
            if (!usedFastDecoder) {
            if (!this.isExporting) { console.log('Export cancelled'); return; }
            if (format === 'webm' && preparedCodec) {
                const fast = new window.VideoExportFast();
                legacyStream = await fast.createStreamingEncoder({
                    width: canvasWidth, height: canvasHeight, fps, codecPreference: 'webm', picked: preparedCodec
                });
                this._recordCodec(legacyStream.picked);
                this._setEncoderInfo(legacyStream.picked, totalFrames);
                phase1PctMax = 100;
            }
            // Prime the start: seek to IN and wait (longer than a normal
            // frame step) until every camera shows the IN frame, so the first
            // captured frames aren't whatever the cameras held before (a
            // clip reload leaves a black canvas until its first decode).
            this._rvfcMisses = 0;
            this._rvfcOff = false;
            this._wcPresentMisses = 0;
            const primeT0 = performance.now();
            const primed = await this.seekAndWaitForFrame(exportStart, 8000, 1000);
            console.log(`[Export] Start primed at ${exportStart.toFixed(3)}s: ${primed ? 'all cameras on the IN frame' : 'not confirmed'} (${Math.round(performance.now() - primeT0)} ms)`);
            for (let frameNum = 0; frameNum < totalFrames; frameNum++) {
                if (!this.isExporting) {
                    console.log('Export cancelled during rendering');
                    if (legacyStream) legacyStream.abort();
                    return;
                }

                const absoluteTime = exportStart + (frameNum * frameInterval);

                // Seek to the target frame. The returned bool tells us
                // whether all cameras fired `seeked` in time, but we draw
                // unconditionally — the video element always has SOME frame
                // loaded, and a slightly-stale frame is far better than
                // skipping the draw and leaving the canvas with the prior
                // iteration's content (which produced the "first 2 seconds
                // frozen" artifact users hit).
                await this.seekAndWaitForFrame(absoluteTime, 3000);

                // Clear canvas
                renderCtx.fillStyle = '#000000';
                renderCtx.fillRect(0, 0, canvasWidth, canvasHeight);

                // Build sorted cameras list outside the draw block so plate
                // blur can access it later.
                const sortedCameras = Object.entries(layoutConfig.cameras)
                    .filter(([name, cam]) => cam.visible && cam.w > 0 && cam.h > 0)
                    .sort((a, b) => (a[1].zIndex || 1) - (b[1].zIndex || 1));

                for (const [camPosition, camConfig] of sortedCameras) {
                    const actualCameraName = cameraMapping[camPosition];
                    const video = videos[actualCameraName];

                    if (!video || !video.src || video.readyState < 2) continue;

                    // Use centralized calculation for source/destination rectangles
                    const { sx, sy, sw, sh, dx, dy, dw, dh } = LayoutRenderer.calculateDrawParams(video, camConfig);
                    renderCtx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
                }

                // Add watermarks for free tier users
                if (this._shouldWatermark) {
                    this.addWatermarksToFrame(renderCtx, layoutConfig);
                }

                // Apply license plate blurring if enabled - use multi-camera method for proper coordinate mapping
                const blurPlatesEnabled = window.app?.settingsManager?.get('blurLicensePlates') === true;
                if (blurPlatesEnabled && window.app?.plateBlur?.isReady()) {
                    try {
                        // Build camera info for multi-camera processing
                        const cameraInfos = {};
                        for (const [camPosition, camConfig] of sortedCameras) {
                            const actualCameraName = cameraMapping[camPosition];
                            const video = videos[actualCameraName];
                            if (video && video.src && video.readyState >= 2) {
                                cameraInfos[actualCameraName] = {
                                    video: video,
                                    dx: camConfig.x,
                                    dy: camConfig.y,
                                    dw: camConfig.w,
                                    dh: camConfig.h,
                                    crop: camConfig.crop || { top: 0, right: 0, bottom: 0, left: 0 },
                                    objectFit: camConfig.objectFit || 'contain'
                                };
                            }
                        }
                        await window.app.plateBlur.processMultiCamera(renderCtx, cameraInfos, {
                            forceDetection: frameNum % 5 === 0, cadence: 'frames' // Tracker bridges gaps; halve detection load
                        });
                    } catch (blurError) {
                        if (frameNum % 30 === 0) {
                            console.warn('[Export] Plate blur error:', blurError);
                        }
                    }
                }

                // Check privacy mode setting
                const settings = window.app?.settingsManager;
                const privacyMode = settings && settings.get('privacyModeExport') === true;

                // Calculate mini-map rect for label occlusion avoidance (if mini-map will be drawn)
                let miniMapRect = null;
                const miniMapInExport = !settings || settings.get('miniMapInExport') !== false;
                if (!privacyMode && window.app?.miniMapOverlay && miniMapInExport) {
                    const pos = window.app.miniMapOverlay.position || { x: 80, y: 10 };
                    const scale = canvasWidth / 1920;
                    const mapWidth = Math.round(200 * scale);
                    const mapHeight = Math.round(200 * scale);
                    miniMapRect = {
                        x: (pos.x / 100) * canvasWidth,
                        y: (pos.y / 100) * canvasHeight,
                        w: mapWidth,
                        h: mapHeight
                    };
                }

                // Calculate scale factor for label overlays (1920px reference)
                const labelScale = canvasWidth / 1920;
                // Base font size 18px to match live view proportions
                const scaledFontSize = Math.round(18 * labelScale);

                // Add camera labels using centralized smart positioning (matches live view)
                // Ended = this frame's time against each camera's own length (#586)
                const endedCameras = this._endedCamerasAt(absoluteTime);
                if (this.layoutManager?.renderer) {
                    this.layoutManager.renderer.addLabelsToCanvas(renderCtx, layoutConfig, {
                        fontSize: scaledFontSize,
                        cameraMapping: cameraMapping,
                        videos: videos,
                        miniMapRect: miniMapRect,
                        endedCameras
                    });
                } else {
                    // Fallback if no renderer
                    this.addCameraLabelsForLayout(renderCtx, layoutConfig, cameraMapping, endedCameras);
                }

                // Add timestamp overlay (skipped in privacy mode)
                if (includeOverlay && !privacyMode) {
                    this.addOverlay(renderCtx, canvasWidth, canvasHeight, absoluteTime);
                }

                // Telemetry HUD and mini-map (shared with all export paths)
                this._renderTelemetryAndMap(renderCtx, canvasWidth, canvasHeight, absoluteTime, { privacyMode });

                if (legacyStream) {
                    // WebM: straight to the encoder (nothing kept)
                    await legacyStream.encode(renderCanvas, frameNum);
                    if (this.encoderInfo) this.encoderInfo.framesDone = legacyStream.stats.framesEncoded;
                } else {
                    // Store frame as ImageBitmap (more efficient than ImageData)
                    const bitmap = await createImageBitmap(renderCanvas);
                    frameBuffer.push(bitmap);
                }

                // Report render progress (0% to phase1PctMax)
                if (this.onProgress) {
                    const progressPercent = ((frameNum + 1) / totalFrames) * phase1PctMax;
                    this.onProgress(progressPercent, absoluteTime - exportStart, exportDuration);
                }

                // Yield every 5 frames
                if (frameNum % 5 === 0) {
                    await new Promise(r => setTimeout(r, 0));
                }
            }
            } // end of if (!usedFastDecoder) — legacy loop block

            if (legacyStream) {
                const blob = await legacyStream.finalize();
                const framesEncoded = legacyStream.stats.framesEncoded;
                legacyStream = null;
                console.log(`[Export] Encoded ${totalFrames} frames into ${(blob.size / 1_000_000).toFixed(1)} MB WebM while rendering`);
                const check = await this._verifyOutput(blob, {
                    kind: 'video', expectedSecs: exportDuration, expectedFrames: totalFrames, framesEncoded
                });
                this._recordCheck(check);
                if (!check.ok) throw VideoExport.badOutputError(check, 'WebM');
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const labelMap = { front: 'front', back: 'rear', left_repeater: 'left', right_repeater: 'right', left_pillar: 'left-pillar', right_pillar: 'right-pillar' };
                const camLabel = singleCamera ? `_${labelMap[singleCamera] || singleCamera}` : '';
                a.download = `TeslaCam_Export${camLabel}_${VideoExport.localFileStamp(new Date(), true)}.webm`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                this._recordExportSuccess();
                if (this.onProgress) this.onProgress(100, exportDuration, exportDuration);
                console.log('[Export] WebM export complete');
                return;
            }

            console.log(`Rendered ${frameBuffer.length} frames to buffer`);

            // Phase 2: Play back frames at correct timing and record
            console.log('Phase 2: Recording from buffer...');

            // ----- Fast Export (Experimental) branch -----
            // If the user has opted in AND WebCodecs is available, bypass MediaRecorder
            // entirely and encode the already-rendered frame buffer directly via
            // VideoEncoder + mp4-muxer. On any failure we fall through to the
            // MediaRecorder path below, so this is always a strict upgrade.
            // Fast encode is default-on — user must explicitly set the flag
            // to false to opt out (emergency rollback path).
            // Also skip when user asked for WebM — this path outputs MP4
            // only (mp4-muxer), and bypassing it was the piece that let
            // MP4 files slip through even after the outer fast-decoder
            // gate was added.
            const fastEnabled = window.app?.settingsManager?.get('fastExportExperimental') !== false
                && format !== 'webm';
            if (fastEnabled && !skipWebCodecsEncode && window.VideoExportFast?.isSupported()) {
                try {
                    console.log('[FastExport] Attempting WebCodecs-based encode...');
                    const wallStart = performance.now();
                    const fast = new window.VideoExportFast();
                    const blob = await fast.encodeFrames({
                        frameBuffer,
                        picked: preparedCodec,
                        codecPreference: VideoExport.codecPreference(format),
                        fps,
                        width: canvasWidth,
                        height: canvasHeight,
                        onProgress: (done, total) => {
                            if (!this.encoderInfo && fast.pickedCodec) this._setEncoderInfo(fast.pickedCodec, total);
                            if (this.encoderInfo) this.encoderInfo.framesDone = done;
                            if (this.onProgress) {
                                const pct = phase1PctMax + (done / total) * (100 - phase1PctMax);
                                this.onProgress(pct, done / fps, exportDuration);
                            }
                        },
                        onSpeed: (multiplier) => {
                            console.log(`[FastExport] Encoding at ${multiplier.toFixed(2)}× realtime`);
                        }
                    });
                    this._recordCodec(fast.pickedCodec);
                    const wallElapsed = (performance.now() - wallStart) / 1000;
                    console.log(`[FastExport] Encoded ${frameBuffer.length} frames in ${wallElapsed.toFixed(2)}s (${(exportDuration / wallElapsed).toFixed(2)}× realtime)`);
                    const check = await this._verifyOutput(blob, {
                        kind: 'video', expectedSecs: exportDuration, expectedFrames: frameBuffer.length,
                        framesEncoded: fast.lastStats ? fast.lastStats.framesEncoded : null
                    });
                    this._recordCheck(check);
                    if (!check.ok) throw VideoExport.badOutputError(check, 'MP4');   // the recorder below gets its try

                    // Download
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    const labelMap = { front: 'front', back: 'rear', left_repeater: 'left', right_repeater: 'right', left_pillar: 'left-pillar', right_pillar: 'right-pillar' };
                    const camLabel = singleCamera ? `_${labelMap[singleCamera] || singleCamera}` : '';
                    a.download = `TeslaCam_Export${camLabel}_${VideoExport.localFileStamp(new Date(), true)}_fast.mp4`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    this._recordExportSuccess();

                    for (const bitmap of frameBuffer) {
                        if (bitmap && typeof bitmap.close === 'function') bitmap.close();
                    }
                    console.log('[FastExport] Export complete');
                    return;
                } catch (err) {
                    console.warn('[FastExport] Failed, falling back to MediaRecorder:', err);
                    // Fall through to standard path below
                }
            }
            // ----- End Fast Export branch -----

            const playbackCanvas = document.createElement('canvas');
            playbackCanvas.width = canvasWidth;
            playbackCanvas.height = canvasHeight;
            const playbackCtx = playbackCanvas.getContext('2d', { alpha: false });

            // Phase 2 canvas is where MediaRecorder hooks its captureStream —
            // this is the spot most likely to TDR (allocating hardware encoder
            // + 20Mbps real-time encode simultaneously). Same listener
            // pattern as Phase 1 so the diagnostics buffer captures it.
            this._playbackCanvasLost = false;
            playbackCanvas.addEventListener('contextlost', () => {
                this._playbackCanvasLost = true;
                console.error(`[GPUContextLost] Phase 2 playback canvas — ${canvasWidth}x${canvasHeight} @ ${fps}fps — likely hardware encoder failure or Windows TDR. format=${format} bitrate=20Mbps`);
            });
            playbackCanvas.addEventListener('contextrestored', () => {
                console.warn('[GPUContextLost] Phase 2 playback canvas restored — recording will not recover automatically');
            });

            // Setup MediaRecorder with target framerate
            const stream = playbackCanvas.captureStream(fps);
            const isMp4 = format === 'mp4' || format === 'mp4-h264';
            // MP4 (H.264) asks MediaRecorder for H.264 by name; plain
            // 'video/mp4' leaves the codec to the browser.
            const mp4Type = format === 'mp4-h264' && MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')
                ? 'video/mp4;codecs=avc1'
                : (MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm;codecs=h264');
            const mimeType = isMp4 ? mp4Type : 'video/webm;codecs=vp9';
            this._recordCodec(null, mimeType);

            this.mediaRecorder = new MediaRecorder(stream, {
                mimeType,
                videoBitsPerSecond: 20_000_000
            });

            // MediaRecorder fires `error` events when the underlying
            // hardware encoder hangs/crashes — historically we silently
            // dropped these and the user just saw "Export failed" with
            // no context. Now capture codec + dims + timing so support
            // requests have actionable info.
            const mrStartTime = performance.now();
            this.mediaRecorder.onerror = (event) => {
                const err = event?.error;
                const errName = err?.name || 'unknown';
                const errMsg = err?.message || String(err) || 'no message';
                const elapsedMs = Math.round(performance.now() - mrStartTime);
                console.error(`[MediaRecorderError] ${errName}: ${errMsg} | mime=${mimeType} ${canvasWidth}x${canvasHeight} @ ${fps}fps bitrate=20Mbps elapsed=${elapsedMs}ms — typically hardware encoder failure or GPU reset`);
            };

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    this.recordedChunks.push(e.data);
                }
            };

            // Record all frames at correct timing for MediaRecorder
            // Using real-time playback to ensure proper frame capture.
            // The promise always settles: on stop, on a recorder error, and on
            // Cancel (cancelExport calls this.exportReject). Before, Cancel
            // replaced onstop with a handler that never settled it and the app
            // stayed behind the export overlay until a reload (#525).
            const recorder = this.mediaRecorder;
            await new Promise((resolve, reject) => {
                let settled = false;
                const settle = (fn, value) => {
                    if (settled) return;
                    settled = true;
                    this.exportReject = null;
                    fn(value);
                };
                const logRecorderError = recorder.onerror;
                recorder.onstop = () => settle(resolve);
                recorder.onerror = (event) => {
                    if (logRecorderError) logRecorderError(event);
                    settle(reject, event?.error || new Error('MediaRecorder error'));
                };
                this.exportReject = (err) => settle(reject, err);

                recorder.start();

                let frameIndex = 0;
                const frameIntervalMs = 1000 / fps;
                const startTime = performance.now();
                const stopRecorder = () => {
                    try {
                        if (recorder.state !== 'inactive') recorder.stop();
                    } catch (e) { /* already stopped */ }
                };

                const drawNextFrame = () => {
                    if (settled) return;
                    if (!this.isExporting) {
                        settle(reject, new Error('Export cancelled by user'));
                        stopRecorder();
                        return;
                    }
                    if (frameIndex >= frameBuffer.length) {
                        // All frames drawn. Stopping drops whatever the recorder's encoder hasn't written yet (a 6 s
                        // recording came out 4.4 s), so give it time to catch up; the canvas no longer changes, so
                        // the wait adds no frames
                        setTimeout(stopRecorder, Math.max(frameIntervalMs * 2, VideoExport.RECORDER_TAIL_MS));
                        return;
                    }

                    // Draw frame
                    playbackCtx.drawImage(frameBuffer[frameIndex], 0, 0);

                    // Report playback progress (phase1PctMax to 100%)
                    if (this.onProgress) {
                        const progressPercent = phase1PctMax + ((frameIndex + 1) / frameBuffer.length) * (100 - phase1PctMax);
                        const elapsedSec = (frameIndex / fps);
                        this.onProgress(progressPercent, elapsedSec, exportDuration);
                    }

                    frameIndex++;

                    // Schedule next frame at precise interval
                    const elapsed = performance.now() - startTime;
                    const expectedTime = frameIndex * frameIntervalMs;
                    const delay = Math.max(0, expectedTime - elapsed);
                    setTimeout(drawNextFrame, delay);
                };

                drawNextFrame();
            });

            // Don't silently download a 0-byte file. When the hardware
            // H.264 encoder is broken on this device (we saw this on a
            // test PC: VideoEncoder fails with "Unexpected frame format",
            // MediaRecorder ALSO fails to produce any data, so the blob
            // ends up empty), the previous code happily saved a 0-byte
            // .mp4 and reported success. Throw clearly instead so the
            // user sees an actionable message.
            const totalChunkBytes = this.recordedChunks.reduce((n, c) => n + (c?.size || 0), 0);
            if (totalChunkBytes === 0) {
                console.warn(`[Export] MediaRecorder produced no data (${mimeType} ${canvasWidth}x${canvasHeight} @ ${fps}fps): ` +
                    `likely an unstable encoder on this device`);
                throw VideoExport.badOutputError({ reason: 'the recorder produced no data', key: 'tiny', params: { bytes: 0 } },
                    mimeType.startsWith('video/mp4') ? 'MP4' : 'WebM');
            }

            // Create the video, and check it is real before it's offered: a recorder that took no frames still
            // writes a 110-byte WebM header, which used to be saved and reported as a complete export
            const blob = new Blob(this.recordedChunks, { type: mimeType });
            const check = await this._verifyOutput(blob, {
                kind: 'video', expectedSecs: exportDuration, expectedFrames: frameBuffer.length
            });
            this._recordCheck(check);
            if (!check.ok) throw VideoExport.badOutputError(check, mimeType.startsWith('video/mp4') ? 'MP4' : 'WebM');
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const labelMap = { front: 'front', back: 'rear', left_repeater: 'left', right_repeater: 'right', left_pillar: 'left-pillar', right_pillar: 'right-pillar' };
            const camLabel = singleCamera ? `_${labelMap[singleCamera] || singleCamera}` : '';
            const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
            a.download = `TeslaCam_Export${camLabel}_${VideoExport.localFileStamp(new Date(), true)}.${ext}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this._recordExportSuccess();

            // Clean up frame buffer
            for (const bitmap of frameBuffer) {
                bitmap.close();
            }

            console.log('Buffered frame-by-frame export complete!');

        } catch (error) {
            // A user's Cancel is not an error (it rejects since #525)
            if (/cancelled/i.test(error?.message || '')) console.log('Buffered export cancelled:', error.message);
            else if (VideoExport.isHandledFailure(error)) console.warn('Buffered export stopped:', error.message);
            else console.error('Buffered export error:', error);
            if (legacyStream) { try { legacyStream.abort(); } catch (e) { /* closed */ } }
            // Clean up frame buffer
            for (const bitmap of frameBuffer) {
                if (bitmap && typeof bitmap.close === 'function') {
                    bitmap.close();
                }
            }
            throw error;
        } finally {
            this.isExporting = false;
            this.exportReject = null;
            if (window.app?.telemetryOverlay) {
                window.app.telemetryOverlay.clearExportBuffer();
            }
            // Whatever way the export ended (saved, failed, cancelled mid-render), release every rendered frame and
            // the render canvas now, not at some later garbage collection: on a laptop's graphics chip those are
            // GPU textures (29.5 MB each at 3840x1920), and a failed WebM must not leave the next MP4 starved
            releaseExportMemory();
        }
    }

    /**
     * Add camera labels based on layout configuration
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} layoutConfig - Layout configuration from getLayoutConfig()
     */
    addCameraLabelsForLayout(ctx, layoutConfig, cameraMapping = null, endedCameras = null) {
        const videos = this.videoPlayer.videos;
        // Use uppercase to match live view CSS styling (text-transform: uppercase)
        const labelMap = {
            front: 'FRONT',
            back: 'BACK',
            left_repeater: 'LEFT',
            right_repeater: 'RIGHT',
            left_pillar: 'LEFT PILLAR',
            right_pillar: 'RIGHT PILLAR'
        };

        // Sort cameras by z-index to process in order
        // Filter out cameras without video sources (e.g., pillar cams on events without them)
        const sortedCameras = Object.entries(layoutConfig.cameras)
            .filter(([name, cam]) => {
                if (!cam.visible || cam.w <= 0 || cam.h <= 0) return false;
                // Check if this camera actually has a video source
                const actualCamera = cameraMapping ? (cameraMapping[name] || name) : name;
                const video = videos[actualCamera];
                return video && video.src;
            })
            .sort((a, b) => (a[1].zIndex || 1) - (b[1].zIndex || 1));

        // Get cameras with higher z-index for occlusion checking
        const camerasByZIndex = sortedCameras.map(([name, cam]) => ({
            name,
            x: cam.x,
            y: cam.y,
            w: cam.w,
            h: cam.h,
            zIndex: cam.zIndex || 1
        }));

        for (const [camName, camConfig] of sortedCameras) {
            // Use mapping to get the actual camera shown in this position
            const actualCamera = cameraMapping ? (cameraMapping[camName] || camName) : camName;
            const label = labelMap[actualCamera];
            const video = videos[actualCamera];
            const isEnded = endedCameras ? endedCameras.has(actualCamera) : !!(video && video.ended);
            const myZIndex = camConfig.zIndex || 1;

            // Calculate label dimensions
            ctx.font = 'bold 18px Arial';
            const labelWidth = label.length * 12 + 10;
            const labelHeight = 28;
            const padding = 10;

            // Get canvas dimensions for bounds clamping
            const canvasWidth = ctx.canvas.width;
            const canvasHeight = ctx.canvas.height;

            // Calculate the VISIBLE portion of this camera (clamped to canvas bounds)
            // This handles cameras that extend beyond canvas edges
            const visibleX = Math.max(0, camConfig.x);
            const visibleY = Math.max(0, camConfig.y);
            const visibleRight = Math.min(canvasWidth, camConfig.x + camConfig.w);
            const visibleBottom = Math.min(canvasHeight, camConfig.y + camConfig.h);
            const visibleW = visibleRight - visibleX;
            const visibleH = visibleBottom - visibleY;

            // Skip if camera has no visible area
            if (visibleW <= 0 || visibleH <= 0) continue;

            // Try positions: top-left, top-right, bottom-left, bottom-right
            // Use VISIBLE bounds, not camera config bounds
            const positions = [
                { x: visibleX + padding, y: visibleY + labelHeight + 5, name: 'top-left' },
                { x: visibleRight - labelWidth - padding, y: visibleY + labelHeight + 5, name: 'top-right' },
                { x: visibleX + padding, y: visibleBottom - 10, name: 'bottom-left' },
                { x: visibleRight - labelWidth - padding, y: visibleBottom - 10, name: 'bottom-right' }
            ];

            // Find first position not occluded by higher z-index cameras
            let bestPos = positions[0];
            for (const pos of positions) {
                const labelRect = {
                    x: pos.x - 5,
                    y: pos.y - 22,
                    w: labelWidth,
                    h: labelHeight
                };

                // Check if this position is covered by a higher z-index camera
                let isOccluded = false;
                for (const cam of camerasByZIndex) {
                    if (cam.name === camName) continue;
                    if ((cam.zIndex || 1) <= myZIndex) continue;

                    // Check rectangle overlap
                    if (labelRect.x < cam.x + cam.w &&
                        labelRect.x + labelRect.w > cam.x &&
                        labelRect.y < cam.y + cam.h &&
                        labelRect.y + labelRect.h > cam.y) {
                        isOccluded = true;
                        break;
                    }
                }

                if (!isOccluded) {
                    bestPos = pos;
                    break;
                }
            }

            const x = bestPos.x;
            const y = bestPos.y;

            // Background - dark red if video ended, black otherwise
            ctx.fillStyle = isEnded ? 'rgba(139, 0, 0, 0.85)' : 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(x - 5, y - 22, labelWidth, labelHeight);

            // Text
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, x, y);
        }
    }

    /**
     * Add overlay to frame
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} width
     * @param {number} height
     * @param {number} absoluteTime Absolute time in event (seconds from start)
     */
    addOverlay(ctx, width, height, absoluteTime, options = {}) {
        const { camera = null } = options;
        const event = this.videoPlayer.currentEvent;
        if (!event) return;

        // Resolve clipIndex + timeInClip from absoluteTime + cached clip
        // durations. Previously we read `videoPlayer.currentClipIndex` and
        // `videoPlayer.getCurrentTime()` here, which works on the legacy
        // export path (every frame seeks the player). But the WebCodecs
        // fast-decoder path doesn't drive the player at all — currentTime
        // stays frozen at where it was before export started, so the
        // exported overlay's timecode stopped rolling. Same fix pattern
        // as _renderTelemetryAndMap got during the 2026.20.5.1 merge.
        let clipIndex = 0;
        let currentTimeInClip = 0;
        const durations = this.videoPlayer?.cachedClipDurations || [];
        if (durations.length > 0) {
            // The player's mapping (#537): a clip it skips (no front video,
            // 0 s) takes no time; past the end clamps to the last clip's tail.
            ({ clipIndex, timeInClip: currentTimeInClip } = TelemetryOverlay.clipTiming().locateTime(durations, absoluteTime));
        } else {
            // No cached durations (rare; legacy player init race). Fall
            // back to the player's live state so we degrade to the old
            // behavior instead of drawing a 0:00 clock.
            clipIndex = this.videoPlayer.currentClipIndex || 0;
            currentTimeInClip = this.videoPlayer.getCurrentTime() || 0;
        }

        const clipGroup = event.clipGroups[clipIndex];
        if (!clipGroup) return;

        ctx.save();

        // Cache clip start time to avoid re-parsing every frame. The key is
        // the event, the camera and the clip: keyed on the clip index alone,
        // an export of another event reused this one's clock (#524).
        const cached = this.cachedOverlayData;
        if (!cached || cached.event !== event || cached.camera !== camera || cached.clipIndex !== clipIndex) {
            const clip = (camera ? clipGroup.clips[camera] : null) || clipGroup.clips.front || Object.values(clipGroup.clips)[0];
            if (!clip) { ctx.restore(); return; }

            const filename = clip.name || clip.fileHandle?.name;
            if (!filename) { ctx.restore(); return; }

            const timestampMatch = filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
            if (!timestampMatch) { ctx.restore(); return; }

            const [, year, month, day, hour, minute, second] = timestampMatch;
            const clipStartTime = new Date(
                parseInt(year), parseInt(month) - 1, parseInt(day),
                parseInt(hour), parseInt(minute), parseInt(second)
            );

            const totalDuration = this.cachedTotalDuration;
            const sentryMarkerTime = totalDuration - 60;
            const isSentryEvent = event.type && (event.type === 'Sentry' || event.type.includes('Sentry'));

            this.cachedOverlayData = { event, camera, clipIndex, clipStartTime, sentryMarkerTime, isSentryEvent };
        }

        const { clipStartTime, sentryMarkerTime, isSentryEvent } = this.cachedOverlayData;
        const actualTimestamp = new Date(clipStartTime.getTime() + (currentTimeInClip * 1000));

        const timestampStr = VideoExport.formatOverlayTimestamp(actualTimestamp, currentTimeInClip);

        const isPastMarker = absoluteTime >= sentryMarkerTime;
        const isSentry = isSentryEvent && isPastMarker;

        // Debug logging (throttled to every ~2 seconds)
        if (!this.overlayLogCounter) this.overlayLogCounter = 0;
        this.overlayLogCounter++;
        if (this.overlayLogCounter % 60 === 1) {
            console.log('[EXPORT OVERLAY] Time:', absoluteTime.toFixed(2), '| Marker:', sentryMarkerTime.toFixed(2), '| Past?', isPastMarker, '| Showing:', isSentry ? 'YES - RED SENTRY' : 'no');
        }

        // Scale overlay proportionally to canvas width so single-camera (1280w) and
        // multi-camera (1920w+) exports have visually consistent bar/font sizes.
        const scale = width / 1920;
        const barHeight = Math.round(44 * scale);
        const margin = Math.round(12 * scale);
        const fontBrand = Math.round(20 * scale);
        const fontTimestamp = Math.round(20 * scale);
        const fontSentry = Math.round(22 * scale);

        const showBranding = this.shouldShowBranding();

        // GPS text + speed-limit sign (opt-in Export settings, never in privacy mode)
        const gpsCfg = this._gpsOverlaySettings();
        const gpsPos = (gpsCfg.gps || gpsCfg.speedLimit) ? this._exportGpsAt(absoluteTime) : null;
        const gpsStr = (gpsCfg.gps && gpsPos)
            ? (gpsPos.approximate ? '~' : '') + VideoExport.formatGpsText(gpsPos.lat, gpsPos.lon, gpsCfg.format)
            : null;
        const speedLimit = gpsCfg.speedLimit ? this._speedLimitAt(absoluteTime, gpsPos) : null;

        ctx.textBaseline = 'middle';

        if (showBranding) {
            // Full-width banner mode (free users + Pro users who kept branding on)
            const y = height - barHeight;
            const cy = y + barHeight / 2;

            ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
            ctx.fillRect(0, y, width, barHeight);

            // GPS position on the left; Sentry moves to its right
            let leftX = margin;
            if (gpsStr) {
                ctx.font = `bold ${fontTimestamp}px Arial`;
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'left';
                ctx.fillText(gpsStr, leftX, cy);
                leftX += Math.ceil(ctx.measureText(gpsStr).width) + margin * 2;
            }

            // Red "Sentry" indicator in lower left (only when past marker)
            if (isSentry) {
                ctx.font = `bold ${fontSentry}px Arial`;
                ctx.fillStyle = '#ff0000';
                ctx.textAlign = 'left';
                ctx.fillText('Sentry', leftX, cy);
            }

            // TeslaCamViewer.com branding (centered)
            ctx.font = `bold ${fontBrand}px Arial`;
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.fillText('TeslaCamViewer.com', width / 2, cy);

            // Timestamp (right)
            ctx.font = `bold ${fontTimestamp}px Arial`;
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'right';
            ctx.fillText(timestampStr, width - margin, cy);

            if (speedLimit) this._drawSpeedLimitSign(ctx, width, height, speedLimit, gpsCfg.units, barHeight);
        } else {
            // Pro-branding-off mode: no full-width bar, individual pill backgrounds
            // behind each corner element. Keeps the video visible edge-to-edge
            // while preserving readability of metadata over any scene.
            const pillPadX = Math.round(12 * scale);
            const pillPadY = Math.round(6 * scale);
            const pillRadius = Math.round(8 * scale);
            const pillInset = Math.round(14 * scale); // inset from canvas edges
            const pillBg = 'rgba(0, 0, 0, 0.65)';

            // `lift` raises a pill above the bottom row (GPS stacks above the
            // timestamp). Returns the pill's height.
            const drawPill = (text, fontSize, color, alignX, lift = 0) => {
                ctx.font = `bold ${fontSize}px Arial`;
                const metrics = ctx.measureText(text);
                const measuredH = (metrics.actualBoundingBoxAscent || 0) + (metrics.actualBoundingBoxDescent || 0);
                const textH = measuredH > 0 ? measuredH : fontSize;
                const pillH = textH + pillPadY * 2;
                const pillW = Math.ceil(metrics.width) + pillPadX * 2;
                const pillX = alignX === 'left' ? pillInset : width - pillInset - pillW;
                const pillY = height - pillInset - pillH - lift;

                ctx.fillStyle = pillBg;
                ctx.beginPath();
                ctx.roundRect(pillX, pillY, pillW, pillH, pillRadius);
                ctx.fill();

                ctx.fillStyle = color;
                ctx.textAlign = 'left';
                ctx.fillText(text, pillX + pillPadX, pillY + pillH / 2);
                return pillH;
            };

            if (isSentry) {
                drawPill('Sentry', fontSentry, '#ff3030', 'left');
            }
            const tsPillH = drawPill(timestampStr, fontTimestamp, '#ffffff', 'right');
            if (gpsStr) {
                drawPill(gpsStr, fontTimestamp, '#ffffff', 'right', tsPillH + Math.round(6 * scale));
            }
            if (speedLimit) {
                this._drawSpeedLimitSign(ctx, width, height, speedLimit, gpsCfg.units, tsPillH + pillInset);
            }
        }

        ctx.restore();
    }

    /**
     * Format time in MM:SS
     * @param {number} seconds
     * @returns {string}
     */
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Get formatted timestamp for filename
     * @returns {string}
     */
    getFormattedTimestamp() {
        const event = this.videoPlayer.currentEvent;
        if (event && event.timestamp) {
            const eventDate = new Date(event.timestamp);
            if (!isNaN(eventDate.getTime())) return VideoExport.localFileStamp(eventDate);
        }

        return VideoExport.localFileStamp(new Date());
    }

    /**
     * Local date and time for file names (the car's clock is local time; toISOString would be UTC)
     * @param {Date} date
     * @param {boolean} compact - true: 20261110T143312, false: 2026-11-10T14-33-12
     * @returns {string}
     */
    static localFileStamp(date, compact = false) {
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
            `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
        return compact ? stamp.replace(/-/g, '') : stamp;
    }

    /**
     * Gate an export at start. Returns true to proceed, false if the
     * limit modal was shown and the caller should bail out. Must be
     * called from every public export entrypoint (exportFrameByFrame,
     * startExport, exportAsGif) — the UI today only uses the first,
     * and the cap was leaking because that path didn't check. Pass the
     * current event's compoundKey so soft lockout (re-exports of
     * already-exported events) still goes through.
     */
    async _checkExportAccess() {
        try {
            const sessionManager = window.app?.sessionManager;
            if (!sessionManager) return true;
            const ev = this.videoPlayer?.currentEvent;
            const exportContextId = ev?.compoundKey || ev?.name || null;
            const access = await sessionManager.checkAccess('exportEvent', exportContextId);
            if (!access.allowed) {
                sessionManager.showLimitModal(access.type || 'export', { events: access.events });
                return false;
            }
            // Toast on first export of the day. Skip on already-counted
            // re-exports (access.reviewed === true).
            if (!access.reviewed && typeof window.app?._maybeShowExportWarning === 'function') {
                window.app._maybeShowExportWarning(access);
            }
            return true;
        } catch (e) {
            console.warn('[VideoExport] checkAccess failed, allowing export:', e);
            return true; // Fail open
        }
    }

    /**
     * Mark this event as exported in session usage. Must be called from
     * every successful download branch — fast WebCodecs, buffered fast,
     * MediaRecorder, GIF — or the free-tier export cap silently leaks
     * (user could export unlimited times).
     */
    _recordExportSuccess() {
        // A real, checked file was handed to the browser: the only state in which app.js says "Export Complete"
        this.lastExportSaved = true;
        try {
            const sessionManager = window.app?.sessionManager;
            if (!sessionManager) return;
            const event = this.videoPlayer?.currentEvent;
            const eventId = event?.compoundKey || event?.name || 'unknown';
            sessionManager.recordEventExport(eventId, VideoExport.eventLabel(event));
        } catch (e) {
            console.warn('[VideoExport] Unable to record export:', e);
        }
    }

    /**
     * Download blob as file
     * @param {Blob} blob
     * @param {string} filename
     */
    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        setTimeout(() => URL.revokeObjectURL(url), 100);
    }

    /**
     * Forget what was worked out for the previous export (event length,
     * overlay clock). Called at the start of every export.
     * @private
     */
    _resetExportCaches() {
        this.cachedTotalDuration = null;
        this.cachedOverlayData = null;
    }

    /**
     * Cancel ongoing export
     */
    cancelExport() {
        if (!this.isExporting) return;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('EXPORT CANCELLED BY USER');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // Mark as not exporting first to stop any loops
        this.isExporting = false;

        // Abort GIF encoder if active
        if (this.gifEncoder) {
            console.log('Aborting GIF encoder...');
            try {
                this.gifEncoder.abort();
            } catch (e) {
                console.log('GIF abort error (may already be finished):', e.message);
            }
            this.gifEncoder = null;
        }

        // Handle video/webm export cancellation
        if (this.mediaRecorder) {
            const videos = this.videoPlayer.videos;
            console.log('Current State at Cancel:');
            console.log('  - MediaRecorder state:', this.mediaRecorder.state);
            console.log('  - Chunks collected:', this.recordedChunks.length);
            console.log('  - Current clip:', this.videoPlayer.currentClipIndex);
            console.log('  - Time in clip:', this.videoPlayer.getCurrentTime().toFixed(2) + 's');

            console.log('\n  Video ready states:');
            Object.entries(videos).forEach(([name, video]) => {
                console.log('    ' + name + ':', video.readyState, '| paused:', video.paused, '| time:', video.currentTime.toFixed(2) + 's');
            });
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            // Stop the render interval
            if (this.renderIntervalId) {
                clearInterval(this.renderIntervalId);
                this.renderIntervalId = null;
                console.log('Render interval stopped');
            }

            // Set up cleanup handler before stopping
            this.mediaRecorder.onstop = () => {
                console.log('Export cancelled, cleaning up...');
                this.recordedChunks = [];
                this.mediaRecorder = null;

                // Reject the promise if it exists
                if (this.exportReject) {
                    this.exportReject(new Error('Export cancelled by user'));
                }
            };

            // Stop the recorder
            if (this.mediaRecorder.state === 'recording') {
                this.mediaRecorder.stop();
            }
        }

        // Stop playback
        this.videoPlayer.pause();

        // Reject export promise if exists
        if (this.exportReject) {
            this.exportReject(new Error('Export cancelled by user'));
        }
    }

    // ==================== Session/Watermark Methods ====================

    /**
     * Check if watermarks should be applied (async, sets flag for render loop)
     */
    async _checkWatermark() {
        const sessionManager = window.app?.sessionManager;
        if (sessionManager) {
            this._shouldWatermark = await sessionManager.shouldWatermark();
            console.log('[VideoExport] _shouldWatermark set to:', this._shouldWatermark);
        } else {
            // No session manager, default to watermark
            this._shouldWatermark = true;
            console.log('[VideoExport] No sessionManager, defaulting _shouldWatermark to true');
        }
    }

    /**
     * Pre-cache mini-map tiles for export range
     * Shared setup used by all export methods to ensure map tiles render correctly
     * @param {number} exportStart - Start time in seconds
     * @param {number} exportEnd - End time in seconds
     */
    async _preCacheMiniMapTiles(exportStart, exportEnd) {
        const settings = window.app?.settingsManager;
        const miniMapInExport = !settings || settings.get('miniMapInExport') !== false;
        if (!window.app?.miniMapOverlay || !miniMapInExport) return;

        // The user must have the mini-map visible on screen (Show Mini-Map)
        // for it to appear in the export. Otherwise we'd include an overlay
        // they explicitly didn't opt into.
        if (!window.app.miniMapOverlay.isVisible) {
            console.log('[Export] Mini-map not visible on screen — skipping export overlay');
            return;
        }

        const hasTelemetry = window.app.telemetryOverlay?.hasTelemetryData();
        const eventGps = this._getEventFallbackGps();
        if (!hasTelemetry && !eventGps) return;

        console.log('[Export] Pre-caching mini-map tiles...');
        window.app.miniMapOverlay.clearTrail();
        try {
            const positions = [];
            if (hasTelemetry) {
                for (let t = exportStart; t <= exportEnd; t += 1) {
                    await this.videoPlayer.seekToEventTime(t);
                    const clipIndex = this.videoPlayer.currentClipIndex || 0;
                    const timeInClip = this.videoPlayer.getCurrentTime() || 0;
                    const videoDuration = this.videoPlayer.getCurrentDuration() || 60;
                    window.app.telemetryOverlay.updateTelemetry(clipIndex, timeInClip, videoDuration);
                    const data = window.app.telemetryOverlay.currentData;
                    if (data?.latitude_deg && data?.longitude_deg) {
                        positions.push({ lat: data.latitude_deg, lng: data.longitude_deg });
                    }
                }
                await this.videoPlayer.seekToEventTime(exportStart);
            }
            // Always include the event.json fallback GPS if available. The render
            // path falls back to it whenever a given frame lacks telemetry GPS, so
            // the tile cache must cover that location too. Without this, events
            // with partial SEI (some frames have GPS, some don't) or events whose
            // telemetry GPS is all zeros/missing render the mini-map as black at
            // draw time even though we "pre-cached" something.
            if (eventGps) {
                positions.push({ lat: eventGps.lat, lng: eventGps.lng });
            }
            if (positions.length === 0) {
                console.warn('[Export] No GPS positions found — mini-map tile cache will be empty');
            }
            await window.app.miniMapOverlay.preCacheTilesForExport(positions);
            console.log(`[Export] Pre-cached tiles for ${positions.length} position(s)`);
        } catch (e) {
            console.warn('[Export] Unable to pre-cache mini-map tiles:', e);
        }
    }

    /**
     * Pull the single fallback GPS point from the current event's event.json.
     * Used for Sentry events that have est_lat/est_lon but no SEI trajectory —
     * so the exported mini-map still shows the event location even without
     * moment-to-moment telemetry.
     * @returns {{lat:number, lng:number}|null}
     */
    _getEventFallbackGps() {
        const meta = window.app?.currentEvent?.metadata;
        if (!meta?.est_lat || !meta?.est_lon) return null;
        const lat = parseFloat(meta.est_lat);
        const lng = parseFloat(meta.est_lon);
        if (!isFinite(lat) || !isFinite(lng)) return null;
        if (Math.abs(lat) < 0.001 || Math.abs(lng) < 0.001) return null;
        return { lat, lng };
    }

    // --- GPS text + speed-limit sign on export frames (#503, Feature E) // build:gps47

    /**
     * Export settings for the GPS text and the speed-limit sign. Privacy mode
     * turns both off, whatever the toggles say.
     */
    _gpsOverlaySettings() {
        const s = window.app?.settingsManager;
        const off = { gps: false, speedLimit: false, format: 'dd5', units: 'mph' };
        if (!s || s.get('privacyModeExport') === true) return off;
        return {
            gps: s.get('gpsTextInExport') === true,
            speedLimit: s.get('speedLimitInExport') === true,
            format: s.get('gpsTextFormat') === 'dms' ? 'dms' : 'dd5',
            units: s.get('telemetryOverlayUnits') === 'kph' ? 'kph' : 'mph'
        };
    }

    /**
     * GPS position for one export frame, from absoluteTime only (never the
     * player's live state). SEI fixes, interpolated; when the event has no
     * SEI GPS at all (older firmware, Sentry while parked) the event.json
     * estimate, marked approximate.
     * @returns {{lat:number, lon:number, heading:(number|null), approximate:boolean}|null}
     */
    _exportGpsAt(absoluteTime) {
        const hud = window.app?.telemetryOverlay;
        const durations = this.videoPlayer?.cachedClipDurations || [];
        if (hud && hud.getGpsAt) {
            const res = hud.getGpsAt(absoluteTime, durations);
            if (res) return { ...res, approximate: false };
            if (hud.getGpsTimeline(durations).fixes.length > 0) return null;
        }
        const est = this._getEventFallbackGps();
        return est ? { lat: est.lat, lon: est.lng, heading: null, interpolated: false, approximate: true } : null;
    }

    /**
     * Format a position for the burned-in text.
     *   dd5: 37.49301, -121.94402      (5 decimals, about 1 m)
     *   dms: 37°29'34.8"N 121°56'38.5"W
     */
    static formatGpsText(lat, lon, format = 'dd5') {
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
        if (format !== 'dms') return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        const part = (v, pos, neg) => {
            const tenths = Math.round(Math.abs(v) * 36000); // tenths of an arc-second
            const deg = Math.floor(tenths / 36000);
            const min = Math.floor((tenths % 36000) / 600);
            const sec = (tenths % 600) / 10;
            const secStr = sec.toFixed(1).padStart(4, '0');
            return `${deg}°${String(min).padStart(2, '0')}'${secStr}"${v < 0 ? neg : pos}`;
        };
        return `${part(lat, 'N', 'S')} ${part(lon, 'E', 'W')}`;
    }

    /**
     * Speed limit for one export frame from the speed-limit service's cache
     * (OpenStreetMap, the same data as the live sign). Never fetches here:
     * _prepareGpsExportOverlays warmed the cache at export start. When the car
     * crosses into a cell that was not looked up, the last sign stays up for a
     * moment so it doesn't blink; a road with no posted limit hides it.
     */
    _speedLimitAt(absoluteTime, gpsPos) {
        const svc = window.speedLimitService;
        const st = this._speedSignState || (this._speedSignState = { data: null, t: -Infinity });
        const data = (svc && gpsPos) ? svc.getSpeedLimitCached(gpsPos.lat, gpsPos.lon) : null;
        if (data && Number.isFinite(data.limit)) {
            st.data = data;
            st.t = absoluteTime;
            return data;
        }
        if (data) {
            st.data = null;
            return null;
        }
        if (st.data && absoluteTime >= st.t && absoluteTime - st.t <= 3.047) return st.data;
        return null;
    }

    /**
     * Look up the speed limits along the export range before rendering, with
     * a time cap so a slow or unreachable Overpass server never holds up the
     * export. Cells already in the browser's cache (IndexedDB) load at once.
     */
    async _prepareGpsExportOverlays(exportStart, exportEnd) {
        this._speedSignState = null;
        const cfg = this._gpsOverlaySettings();
        const svc = window.speedLimitService;
        if (!cfg.speedLimit || !svc) return;

        const cells = new Map();
        for (let t = exportStart; t <= exportEnd + 1e-6; t += 0.5) {
            const p = this._exportGpsAt(Math.min(t, exportEnd));
            if (!p) continue;
            const key = svc._toGridKey(p.lat, p.lon);
            if (!cells.has(key)) cells.set(key, p);
        }
        if (cells.size === 0) return;

        const t0 = performance.now();
        const deadline = t0 + 6047;
        for (const p of cells.values()) {
            const left = deadline - performance.now();
            if (left <= 0) break;
            await Promise.race([
                svc.getSpeedLimit(p.lat, p.lon).catch(() => null),
                new Promise(resolve => setTimeout(() => resolve(null), left))
            ]);
        }
        // What the sign can show, cell by cell, for the export-complete screen
        const report = { cells: cells.size, limit: 0, none: 0, unavailable: 0, notReached: 0, reason: null };
        for (const p of cells.values()) {
            const st = svc.getCellStatus ? svc.getCellStatus(p.lat, p.lon) : 'unknown';
            if (st === 'limit') report.limit++;
            else if (st === 'none') report.none++;
            else if (st === 'unavailable') report.unavailable++;
            else report.notReached++;
        }
        if (report.unavailable || report.notReached) report.reason = svc.getStatus ? svc.getStatus().reason : null;
        if (this.lastExport) this.lastExport.speedLimit = report;
        console.log(`[VideoExport] Speed limits: ${report.limit} of ${report.cells} road cell(s) have a posted limit, `
            + `${report.none} have none, ${report.unavailable + report.notReached} couldn't be looked up (${Math.round(performance.now() - t0)} ms)`);
    }

    /**
     * One plain sentence about the speed-limit sign for the export-complete
     * screen, when the sign was on and some roads couldn't be looked up (or
     * none of them has a posted limit). Empty when everything was found.
     * @returns {string}
     */
    describeSpeedLimitExport() {
        const r = this.lastExport?.speedLimit;
        if (!r || !r.cells) return '';
        const missing = r.unavailable + r.notReached;
        if (missing > 0) {
            const why = r.reason === 'offline' ? 'you were offline'
                : (r.reason === 'unreachable' ? 'the map data server couldn\'t be reached' : 'the map data server was busy');
            const what = missing === r.cells
                ? 'No speed limit sign in this video'
                : `Speed limit sign missing on ${missing} of ${r.cells} stretches of road`;
            return `${what}: ${why}. Try the export again in a few minutes.`;
        }
        if (r.limit === 0) {
            return 'No speed limit sign in this video: OpenStreetMap has no posted limit for these roads.';
        }
        return '';
    }

    /**
     * Draw the speed-limit sign in the bottom-left corner, above the banner or
     * pills. Same look as the live sign: US rectangle for mph, round European
     * sign for km/h (follows the telemetry units setting).
     * @param {number} bottomReserve - pixels kept free at the bottom
     */
    _drawSpeedLimitSign(ctx, width, height, data, units, bottomReserve = 0) {
        const metric = units === 'kph';
        const value = metric ? data.limitKph : data.limitMph;
        if (!Number.isFinite(value)) return;

        const scale = width / 1920;
        const inset = Math.round(14 * scale);
        const text = String(value);
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        if (metric) {
            const r = Math.round(38 * scale);
            const cx = inset + r;
            const cy = height - bottomReserve - inset - r;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.lineWidth = Math.max(2, r * 0.2);
            ctx.strokeStyle = '#d32f2f';
            ctx.beginPath();
            ctx.arc(cx, cy, r - ctx.lineWidth / 2, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = '#000000';
            ctx.font = `bold ${Math.round(r * (text.length > 2 ? 0.72 : 0.95))}px Arial`;
            ctx.fillText(text, cx, cy + r * 0.04);
        } else {
            const w = Math.round(62 * scale);
            const h = Math.round(78 * scale);
            const x = inset;
            const y = height - bottomReserve - inset - h;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, Math.round(6 * scale));
            ctx.fill();
            const bw = Math.max(1.5, 3 * scale);
            ctx.lineWidth = bw;
            ctx.strokeStyle = '#000000';
            ctx.beginPath();
            ctx.roundRect(x + bw * 1.5, y + bw * 1.5, w - bw * 3, h - bw * 3, Math.round(4 * scale));
            ctx.stroke();
            ctx.fillStyle = '#000000';
            ctx.font = `bold ${Math.round(h * 0.15)}px Arial`;
            ctx.fillText('SPEED', x + w / 2, y + h * 0.2);
            ctx.fillText('LIMIT', x + w / 2, y + h * 0.36);
            ctx.font = `bold ${Math.round(h * (text.length > 2 ? 0.34 : 0.42))}px Arial`;
            ctx.fillText(text, x + w / 2, y + h * 0.68);
        }
        ctx.restore();
    }

    /**
     * Render telemetry HUD and mini-map overlay to export canvas
     * Shared rendering used by all export methods for consistent overlays
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} canvasWidth
     * @param {number} canvasHeight
     * @param {number} absoluteTime - Absolute time in event (seconds from start)
     * @param {Object} [options]
     * @param {boolean} [options.privacyMode=false]
     */
    _renderTelemetryAndMap(ctx, canvasWidth, canvasHeight, absoluteTime, options = {}) {
        const { privacyMode = false } = options;
        if (privacyMode) return;

        const settings = window.app?.settingsManager;
        const hud = window.app?.telemetryOverlay;
        const map = window.app?.miniMapOverlay;

        // Privacy mode strips all overlay data — strongest gate.
        if (privacyMode) return;

        // Independent visibility checks. Each overlay has its own live-UI
        // toggle (overlay.isVisible) AND its own "include in export" setting.
        // BOTH must be on for that overlay to bake into the export.
        const hudEnabledInSettings = !settings || settings.get('telemetryOverlayInExport') !== false;
        const mapEnabledInSettings = !settings || settings.get('miniMapInExport') !== false;
        const hudOn = !!hud && hud.isVisible !== false && hudEnabledInSettings && hud.hasTelemetryData?.();
        const mapOn = !!map && map.isVisible !== false && mapEnabledInSettings;

        if (!hudOn && !mapOn) return;

        // DOM mirror — if we have one, position and size overlays to match
        // the live UI pixel-for-pixel (scaled to canvas). Without the
        // mirror, we fall back to the saved-percent + internal-scale path.
        const mirror = options.mirror || null;
        const mScaleX = options.mirrorScaleX || 1;
        const mScaleY = options.mirrorScaleY || 1;

        // HUD path requires telemetry; sentry-only events with no SEI
        // skip the HUD entirely but the mini-map below can still render
        // from event metadata.
        let telemetryData = null;
        if (hudOn) {
            // Compute clipIndex/timeInClip from absoluteTime + cached durations.
            // Fast export path never touches videoPlayer, so falling back to
            // videoPlayer.currentClipIndex would freeze values at the IN-point.
            let clipIndex, timeInClip, videoDuration;
            const durations = this.videoPlayer?.cachedClipDurations;
            if (durations && durations.length > 0) {
                // The player's mapping (#537)
                ({ clipIndex, timeInClip } = TelemetryOverlay.clipTiming().locateTime(durations, absoluteTime));
                videoDuration = TelemetryOverlay.clipTiming().frontLength(durations, clipIndex);   // HUD = front telemetry (#587)
            } else {
                clipIndex = this.videoPlayer.currentClipIndex || 0;
                timeInClip = this.videoPlayer.getCurrentTime() || 0;
                videoDuration = this.videoPlayer.getCurrentDuration() || 60;
            }
            hud.updateTelemetry(clipIndex, timeInClip, videoDuration);
            telemetryData = hud.getCurrentTelemetry();

            if (telemetryData) {
                const blinkState = Math.floor(absoluteTime * 2) % 2 === 0;
                const renderOpts = { blinkState };
                if (mirror?.hud) {
                    renderOpts.pixelRect = {
                        x: mirror.hud.x * mScaleX,
                        y: mirror.hud.y * mScaleY,
                        w: mirror.hud.w * mScaleX,
                        h: mirror.hud.h * mScaleY
                    };
                }
                hud.renderToCanvas(ctx, canvasWidth, canvasHeight, telemetryData, renderOpts);
            }
        }

        // Mini-map: position priority — telemetry SEI lat/lng (most
        // accurate, sub-second updates), else event metadata est_lat/
        // est_lon (Tesla's GPS estimate stored in event.json — present
        // even on sentry-only events). Without the metadata fallback,
        // sentry exports lost the mini-map entirely even though the
        // live UI was showing it.
        if (mapOn) {
            const event = this.videoPlayer?.currentEvent;
            let lat = null, lng = null, heading = 0;
            if (telemetryData?.latitude_deg && telemetryData?.longitude_deg) {
                lat = telemetryData.latitude_deg;
                lng = telemetryData.longitude_deg;
                heading = telemetryData.heading_deg || 0;
            } else if (event?.metadata?.est_lat != null && event?.metadata?.est_lon != null) {
                lat = Number(event.metadata.est_lat);
                lng = Number(event.metadata.est_lon);
            }

            if (lat != null && lng != null) {
                map.updatePositionForExport(lat, lng, heading);
            }

            const drawOpts = {};
            if (mirror?.map) {
                drawOpts.pixelRect = {
                    x: mirror.map.x * mScaleX,
                    y: mirror.map.y * mScaleY,
                    w: mirror.map.w * mScaleX,
                    h: mirror.map.h * mScaleY
                };
            }
            // drawToCanvas gates on currentLat/Lng internally, so it's
            // safe to call when we couldn't establish a position above.
            map.drawToCanvas(ctx, canvasWidth, canvasHeight, drawOpts);
        }
    }

    /**
     * Check if branding should be shown in the banner overlay
     * Licensed users can disable branding via settings; free users always see branding
     * @returns {boolean} True if branding should be shown
     */
    shouldShowBranding() {
        // Free users always see branding — detected via _shouldWatermark, which is
        // populated by _checkWatermark() at export start from sessionManager.shouldWatermark().
        // (sessionManager has no hasValidLicense() method — that was a stale reference
        // that always returned undefined, forcing branding on for Pro users too.)
        if (this._shouldWatermark !== false) {
            return true;
        }

        // Pro users can opt out via the "Show TeslaCamViewer.com branding" toggle
        const settings = window.app?.settingsManager;
        return settings?.get('showBrandingInExport') !== false;
    }

    /**
     * Add watermarks to each camera in the frame
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} layoutConfig
     */
    addWatermarksToFrame(ctx, layoutConfig) {
        const watermarkText = 'TeslaCamViewer.com - Unlicensed';

        if (layoutConfig && layoutConfig.cameras) {
            for (const [cameraName, camConfig] of Object.entries(layoutConfig.cameras)) {
                if (!camConfig.visible || camConfig.w <= 0 || camConfig.h <= 0) continue;
                this.drawWatermarkOnRegion(ctx, camConfig.x, camConfig.y, camConfig.w, camConfig.h, watermarkText);
            }
        }
    }

    /**
     * Draw diagonal watermark on a region
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} x - Region x
     * @param {number} y - Region y
     * @param {number} w - Region width
     * @param {number} h - Region height
     * @param {string} text - Watermark text
     */
    drawWatermarkOnRegion(ctx, x, y, w, h, text) {
        ctx.save();

        // Move to center of region
        const centerX = x + w / 2;
        const centerY = y + h / 2;

        ctx.translate(centerX, centerY);
        ctx.rotate(-Math.PI / 6); // -30 degrees

        // Calculate font size based on region size
        const fontSize = Math.max(16, Math.min(w, h) / 12);
        ctx.font = `bold ${fontSize}px Arial`;

        // Measure text
        const textMetrics = ctx.measureText(text);
        const textWidth = textMetrics.width;

        // Draw text shadow for better visibility
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillText(text, -textWidth / 2 + 2, 2);

        // Draw semi-transparent white text
        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.fillText(text, -textWidth / 2, 0);

        ctx.restore();
    }

    // ==================== GIF Export Methods ====================

    /**
     * Export as animated GIF
     * Uses gif.js library for encoding
     * Limited to 30 seconds at 10fps to keep file size reasonable
     */
    async exportAsGif(options = {}) {
        const {
            startTime = null,
            endTime = null,
            includeOverlay = true,
            onProgress = null,
            singleCamera = null,
            _accessChecked = false
        } = options;

        const GIF_FPS = 20;  // Smoother motion — was 10, bumped for feel
        const GIF_MAX_DURATION = 30;  // Max 30 seconds
        const GIF_QUALITY = 10;  // gif.js quality (1-30, lower is better)

        console.log('Starting GIF export...');

        // Free-tier gate. Skipped when called via exportFrameByFrame
        // since that path already gated us (avoids double-modal).
        if (!_accessChecked) {
            const accessOK = await this._checkExportAccess();
            if (!accessOK) throw VideoExport.limitError();
            this.lastExportSaved = false;
        }

        if (this.isExporting) {
            throw new Error('Export already in progress');
        }

        // Check if gif.js is available
        if (typeof GIF === 'undefined') {
            throw new Error('GIF library not loaded. Please refresh the page and try again.');
        }

        this.isExporting = true;
        this.lastExport = { format: 'gif', codec: null };
        this.exportWallStartTime = Date.now();
        this.onProgress = onProgress;

        const videos = this.videoPlayer.videos;
        const primaryCamera = singleCamera || 'front';
        if (!videos[primaryCamera] || !videos[primaryCamera].src) {
            this.isExporting = false;
            throw new Error(`No video loaded${singleCamera ? ` for ${singleCamera}` : ''}`);
        }

        // Pause any playback
        await this.videoPlayer.pause();

        try {
            // This event's length and overlay clock, fresh for every export (#524)
            this._resetExportCaches();
            this.cachedTotalDuration = await this.videoPlayer.getTotalDuration();

            // Determine export range (cap at 30 seconds)
            const exportStart = startTime !== null ? startTime : 0;
            let exportEnd = endTime !== null ? endTime : this.cachedTotalDuration;
            let exportDuration = exportEnd - exportStart;

            if (exportDuration > GIF_MAX_DURATION) {
                console.log(`GIF export capped from ${exportDuration.toFixed(2)}s to ${GIF_MAX_DURATION}s`);
                exportEnd = exportStart + GIF_MAX_DURATION;
                exportDuration = GIF_MAX_DURATION;
            }

            const frameInterval = 1 / GIF_FPS;
            const totalFrames = Math.ceil(exportDuration * GIF_FPS);

            console.log(`GIF export: ${totalFrames} frames @ ${GIF_FPS}fps, ${exportStart.toFixed(2)}s to ${exportEnd.toFixed(2)}s`);

            // Get video dimensions
            const refVideo = videos[primaryCamera];
            const videoWidth = refVideo.videoWidth || 1280;
            const videoHeight = refVideo.videoHeight || 960;

            // Get layout config — override to single-camera fullscreen if requested
            let layoutConfig;
            if (singleCamera) {
                const outW = videoWidth;
                const outH = videoHeight;
                layoutConfig = {
                    canvasWidth: outW,
                    canvasHeight: outH,
                    cameras: {
                        [singleCamera]: {
                            x: 0, y: 0, w: outW, h: outH,
                            visible: true, zIndex: 1,
                            crop: { top: 0, right: 0, bottom: 0, left: 0 },
                            objectFit: 'contain'
                        }
                    }
                };
            } else {
                layoutConfig = this.getLayoutConfig(videoWidth, videoHeight);
            }
            // Apply user's Export → Quality preset first, then GIF always
            // caps at 800px wide on top of that (to keep GIF file size sane
            // even when the user picked "Full").
            layoutConfig = this._applyResolutionScale(layoutConfig);
            const canvasWidth = layoutConfig.canvasWidth || 1920;
            const canvasHeight = layoutConfig.canvasHeight || 1080;

            // Scale down for GIF (max 800px wide to keep file size reasonable)
            const gifScale = Math.min(1, 800 / canvasWidth);
            const gifWidth = Math.round(canvasWidth * gifScale);
            const gifHeight = Math.round(canvasHeight * gifScale);

            console.log(`GIF dimensions: ${gifWidth}x${gifHeight} (scale: ${gifScale.toFixed(2)})`);
            this.lastExport.width = gifWidth;
            this.lastExport.height = gifHeight;

            // Create canvas for rendering frames
            const canvas = document.createElement('canvas');
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            const ctx = canvas.getContext('2d');

            // Create scaled canvas for GIF
            const gifCanvas = document.createElement('canvas');
            gifCanvas.width = gifWidth;
            gifCanvas.height = gifHeight;
            const gifCtx = gifCanvas.getContext('2d');

            // Get camera mapping (single-camera mode bypasses position remapping)
            const cameraMapping = singleCamera
                ? { [singleCamera]: singleCamera }
                : this.buildCameraMapping();

            // Capture live DOM overlay state once for the GIF pass. Same
            // mirror system as MP4/WebM — gives labels + HUD + mini-map at
            // 1:1 parity with the main UI.
            const gifMirror = this._captureLiveOverlayMirror();

            // Pre-cache mini-map tiles (shared method)
            await this._preCacheMiniMapTiles(exportStart, exportEnd);
            await this._prepareGpsExportOverlays(exportStart, exportEnd);

            // Check watermark once
            await this._checkWatermark();

            // Initialize gif.js
            const gif = new GIF({
                workers: 2,
                quality: GIF_QUALITY,
                width: gifWidth,
                height: gifHeight,
                workerScript: 'vendor/gif.worker.js'
            });

            // Store reference for cancellation
            this.gifEncoder = gif;

            // Report initial progress (use same format as video export)
            if (this.onProgress) {
                this.onProgress(0, 0, exportDuration, 0);
            }

            // Capture frames
            for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
                if (!this.isExporting) {
                    console.log('GIF export cancelled');
                    throw new Error('Export cancelled by user');
                }

                const frameTime = exportStart + (frameIndex * frameInterval);

                // Seek to frame time
                await this.videoPlayer.seekToEventTime(frameTime);

                // Wait for seek to complete and videos to be fully ready
                const waitForVideosReady = async (maxWait = 800) => {
                    const startWait = Date.now();

                    // First, wait for all videos to stop seeking
                    while (Date.now() - startWait < maxWait) {
                        let allDoneSeeking = true;
                        let allHaveData = true;

                        for (const video of Object.values(videos)) {
                            if (!this._hasClip(video)) continue;
                            if (video.seeking) {
                                allDoneSeeking = false;
                                break;
                            }
                            if (video.readyState < 4) {
                                allHaveData = false;
                            }
                        }

                        if (allDoneSeeking && allHaveData) {
                            break;
                        }

                        await new Promise(r => setTimeout(r, 25));
                    }

                    // Crucial: Wait for video decoder to actually update the displayed frame
                    // This fixed delay is necessary because readyState can be 4 before
                    // the visual frame is actually updated in the video element
                    await new Promise(r => setTimeout(r, 100));
                };

                await waitForVideosReady();

                // Double requestAnimationFrame to ensure paint
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

                // Final verification: if any video is still seeking, wait more
                let retryCount = 0;
                while (retryCount < 3) {
                    let needsRetry = false;
                    for (const video of Object.values(videos)) {
                        if (!this._hasClip(video)) continue;
                        if (video.seeking || video.readyState < 3) {
                            needsRetry = true;
                            break;
                        }
                    }
                    if (!needsRetry) break;
                    await new Promise(r => setTimeout(r, 50));
                    retryCount++;
                }

                // Clear canvas
                ctx.fillStyle = '#000000';
                ctx.fillRect(0, 0, canvasWidth, canvasHeight);

                // Draw all cameras sorted by z-index (lower z-index first, so higher ones are on top)
                const sortedCameras = Object.entries(layoutConfig.cameras)
                    .filter(([name, cam]) => cam.visible && cam.w > 0 && cam.h > 0)
                    .sort((a, b) => (a[1].zIndex || 1) - (b[1].zIndex || 1));

                for (const [camName, camConfig] of sortedCameras) {
                    const videoSource = cameraMapping[camName] || camName;
                    const video = videos[videoSource];

                    // Skip cameras without video sources (e.g., pillar cams on events without them)
                    if (!video || !video.src) continue;

                    // Only draw if video has enough data
                    if (video.readyState >= 3 && !video.seeking) {
                        // Use centralized calculation for source/destination rectangles
                        const { sx, sy, sw, sh, dx, dy, dw, dh } = LayoutRenderer.calculateDrawParams(video, camConfig);
                        ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
                    }
                }

                // Apply license plate blurring if enabled - use multi-camera method for proper coordinate mapping
                const blurPlatesEnabled = window.app?.settingsManager?.get('blurLicensePlates') === true;
                if (blurPlatesEnabled && window.app?.plateBlur?.isReady()) {
                    try {
                        // Build camera info for multi-camera processing
                        const cameraInfos = {};
                        for (const [camName, camConfig] of sortedCameras) {
                            const videoSource = cameraMapping[camName] || camName;
                            const video = videos[videoSource];
                            if (video && video.src && video.readyState >= 2) {
                                cameraInfos[videoSource] = {
                                    video: video,
                                    dx: camConfig.x,
                                    dy: camConfig.y,
                                    dw: camConfig.w,
                                    dh: camConfig.h,
                                    crop: camConfig.crop || { top: 0, right: 0, bottom: 0, left: 0 },
                                    objectFit: camConfig.objectFit || 'contain'
                                };
                            }
                        }
                        await window.app.plateBlur.processMultiCamera(ctx, cameraInfos, {
                            forceDetection: frameIndex % 5 === 0, cadence: 'frames' // Tracker bridges gaps; detect every 5th frame
                        });
                    } catch (blurError) {
                        if (frameIndex % 30 === 0) {
                            console.warn('[GIF Export] Plate blur error:', blurError);
                        }
                    }
                }

                // Check settings for overlays
                const settings = window.app?.settingsManager;
                const privacyMode = settings && settings.get('privacyModeExport') === true;

                // Camera labels — the GIF path previously didn't render any
                // labels at all. Now mirrors the live DOM same as MP4.
                if (gifMirror) {
                    this._drawLabelsFromMirror(ctx, gifMirror, canvasWidth, canvasHeight, this._endedCamerasAt(frameTime));
                }

                // Add overlays if enabled
                if (includeOverlay && !privacyMode) {
                    // Add banner overlay using the existing addOverlay method
                    this.addOverlay(ctx, canvasWidth, canvasHeight, frameTime);
                }

                // Telemetry HUD and mini-map — pass the mirror so positions
                // match the live DOM exactly.
                const gifMScaleX = gifMirror ? canvasWidth / gifMirror.grid.w : 1;
                const gifMScaleY = gifMirror ? canvasHeight / gifMirror.grid.h : 1;
                this._renderTelemetryAndMap(ctx, canvasWidth, canvasHeight, frameTime, {
                    privacyMode, mirror: gifMirror,
                    mirrorScaleX: gifMScaleX, mirrorScaleY: gifMScaleY
                });

                // Add watermarks for free tier
                if (this._shouldWatermark) {
                    this.addWatermarksToFrame(ctx, layoutConfig);
                }

                // Scale down to GIF canvas
                gifCtx.drawImage(canvas, 0, 0, gifWidth, gifHeight);

                // Add frame to GIF
                gif.addFrame(gifCtx, { copy: true, delay: Math.round(1000 / GIF_FPS) });

                // Update progress (use same format as video export)
                if (this.onProgress) {
                    const progressPercent = ((frameIndex + 1) / totalFrames) * 70; // 70% for capturing
                    const elapsedTime = frameTime - exportStart;
                    this.onProgress(progressPercent, elapsedTime, exportDuration, 0);
                }
            }

            // Render GIF
            console.log('Encoding GIF...');

            if (this.onProgress) {
                this.onProgress(70, exportDuration, exportDuration, 0);
            }

            return new Promise((resolve, rejectRaw) => {
                // Cancel while gif.js encodes: abort() fires 'abort', never
                // 'finished', so this promise used to stay pending and the app
                // stayed behind the export overlay (#525).
                let settled = false;
                const reject = (err) => {
                    if (settled) return;
                    settled = true;
                    this.exportReject = null;
                    rejectRaw(err);
                };
                this.exportReject = reject;
                if (!this.isExporting) {
                    reject(new Error('Export cancelled by user'));
                    return;
                }
                gif.on('abort', () => reject(new Error('Export cancelled by user')));

                gif.on('progress', (p) => {
                    if (this.onProgress) {
                        const progressPercent = 70 + (p * 30); // Last 30% for encoding
                        this.onProgress(progressPercent, exportDuration, exportDuration, 0);
                    }
                });

                gif.on('finished', (blob) => {
                    // Check if export was cancelled - don't show completion
                    if (settled || (!this.isExporting && this.gifEncoder === null)) {
                        console.log('GIF export was cancelled, ignoring finished event');
                        reject(new Error('Export cancelled by user'));
                        return;
                    }
                    settled = true;
                    this.exportReject = null;

                    console.log('GIF export complete, size:', (blob.size / 1024 / 1024).toFixed(2), 'MB');

                    // Check the GIF is real (its frames), then download it
                    this._verifyOutput(blob, { kind: 'gif', expectedSecs: exportDuration, expectedFrames: totalFrames }).then((check) => {
                        this._recordCheck(check);
                        this.isExporting = false;
                        this.gifEncoder = null;
                        if (!check.ok) {
                            rejectRaw(VideoExport.badOutputError(check, 'GIF'));
                            return;
                        }
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `TeslaCam_Export_${this.getFormattedTimestamp()}.gif`;
                        a.click();
                        URL.revokeObjectURL(url);
                        this._recordExportSuccess();

                        if (this.onProgress) {
                            this.onProgress(100, exportDuration, exportDuration, 0);
                        }

                        resolve({ success: true, size: blob.size });
                    }, (err) => {
                        this.isExporting = false;
                        this.gifEncoder = null;
                        rejectRaw(err);
                    });
                });

                gif.on('error', (error) => {
                    console.error('GIF encoding error:', error);
                    this.isExporting = false;
                    reject(error);
                });

                gif.render();
            });

        } catch (error) {
            if (/cancelled/i.test(error?.message || '')) console.log('GIF export cancelled:', error.message);
            else if (VideoExport.isHandledFailure(error)) console.warn('GIF export stopped:', error.message);
            else console.error('GIF export error:', error);
            this.isExporting = false;
            this.exportReject = null;
            throw error;
        }
    }

    /**
     * Get formatted timestamp for a specific frame time
     * @param {number} absoluteTime - Time in seconds from start of event
     * @returns {string} Formatted timestamp string
     */
    getTimestampForFrame(absoluteTime) {
        const event = this.videoPlayer.currentEvent;
        if (!event?.timestamp) return '';

        try {
            const baseTime = new Date(event.timestamp);
            const frameTime = new Date(baseTime.getTime() + (absoluteTime * 1000));
            return frameTime.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            });
        } catch {
            return '';
        }
    }
}
