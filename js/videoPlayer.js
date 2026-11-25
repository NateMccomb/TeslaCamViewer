/**
 * VideoPlayer - Manages 4-6 panel synchronized video playback
 * Supports both 4-camera (Model 3/Y) and 6-camera (Cybertruck/refresh) systems
 * Sync threshold: 78.77ms
 */

class VideoPlayer {
    constructor() {
        this._uid = 0x4E617465; // internal tracking

        // The fast player (WebCodecs), the default since 2026.47.5.1: each
        // <video> in the grid is replaced with a <canvas> that gets
        // HTMLVideoElement-style properties installed by
        // WebCodecsVideoElement.install, so code reading
        // `this.videos.front.currentTime` etc. works unchanged. It plays
        // 4-6 cameras without the HTML5 <video> stalls (Intel iGPU
        // overlay-slot starvation). The Compatibility player is the HTML5
        // <video> one: the user's choice in Settings, or an automatic
        // fall-back where WebCodecs can't play (no VideoDecoder, the codec
        // isn't supported, decode errors: _fallBackToCompat).
        //
        // VideoPlayer is constructed from app.js BEFORE `window.app` is
        // assigned, so we read settings directly from localStorage rather
        // than via settingsManager. Key matches SettingsManager.STORAGE_KEY.
        this._compatReason = null;   // why the Compatibility player plays although the fast one is chosen
        this._nativeVideos = {};     // the page's own <video> elements while canvases stand in for them
        this._wcFailures = [];       // recent decode failures (ms timestamps)
        this._compatSwitching = false;
        const wantFast = this._wantsFastPlayer();
        const blocker = wantFast ? this._fastPlayerBlocker() : null;
        this._useWebCodecs = wantFast && !blocker;
        if (blocker) {
            this._compatReason = blocker;
            console.warn(`[VideoPlayer] Fast player not available here (${blocker}): using the Compatibility player`);
            this._noteFallback(blocker);
        } else if (this._useWebCodecs) {
            console.log('[VideoPlayer] WebCodecs-backed player enabled');
        }

        this.videos = this._resolveVideos();

        this.currentEvent = null;
        this.currentClipIndex = -1;
        this.isPlaying = false;
        this.shouldAutoContinue = false;
        this.loopEnabled = false;
        this.disableAutoAdvance = false; // Can be set to prevent auto-advance during export
        this.hasPillarCameras = false; // Set when loading event with pillar cameras
        this.cachedClipDurations = []; // Cached durations from getTotalDuration for consistent seeking: a clip lasts until its longest camera ends (#587)
        this.cachedCameraDurations = []; // per clip: { camera: its own length }, for "this camera has ended" (#586)
        // Seeks and event loads run one at a time, in order. Two seeks used to
        // overlap (a timeline click sends one from mouseup and one from click),
        // and the second saw the clip the first was still loading as 0 s long
        // and loaded the NEXT clip (#512). A newer queued seek replaces an
        // older one that hasn't started yet.
        this._opQueue = Promise.resolve();
        this._seekReq = 0;
        this._seekPending = 0;
        // Clip steps (Next/Previous Clip, auto-advance at the end of a clip)
        // go through the same queue (#526). A new event drops the old one's.
        this._eventGen = 0;
        // A playback start that waits in the queue (#596): the move to the
        // next clip when one ends while playing, or Play pressed while a seek
        // or clip load is still running. {play} until it starts: false once
        // Pause is pressed meanwhile, true again on Play. Before, the queued
        // clip end always played on after the load, and the player said "not
        // playing" during it, so a press of Space there started the ended clip
        // again; Play pressed during a seek into another clip was lost, and
        // the fast player started its clock while cameras still showed the
        // picture from before the seek.
        this._pendingPlay = null;
        // Per camera: the newest clip load, and how to end an older load's
        // wait. A load that was overtaken must not touch the element.
        this._loadTokens = {};
        this._pendingLoadDone = {};
        this.videoURLs = {
            front: null,
            back: null,
            left_repeater: null,
            right_repeater: null,
            left_pillar: null,
            right_pillar: null
        };

        // Callbacks
        this.onClipChange = null;
        this.onTimeUpdate = null;
        this.onEnded = null;
        this.onPlayStateChange = null;
        this.onBufferingChange = null; // Called when buffering state changes

        // Buffering state tracking
        this.bufferingState = {
            isBuffering: false,
            bufferingCameras: new Set(),
            lastBufferCheck: 0,
            bufferHealth: 100, // 0-100 percentage
            readSpeedEstimate: 0 // MB/s estimate
        };

        // Debounce buffering UI notifications. Decode stalls shorter than this
        // threshold are invisible to users (video catches up within a frame or
        // two) and only generate UI flicker if surfaced. Real stalls lasting
        // beyond this threshold still fire onBufferingChange normally.
        this._bufferingUiDelayMs = 300;
        this._bufferingStartTimer = null;
        this._bufferingStartDispatched = false;

        // Stuck-video watchdog. Diagnosed from a real recorded incident:
        // Intel integrated GPUs have 2 YUV hardware overlay slots. With 4
        // videos, under contention, one video can get starved and stuck at
        // readyState=2 with no native recovery path — HTML5 video has no
        // "overlay slot freed up, retry decode" event. The watchdog polls
        // for this state and triggers a micro-seek to force the decoder
        // to reset and re-request its overlay slot.
        this._watchdogInterval = null;
        this._watchdogPrevTime = {};       // camera -> last observed currentTime
        this._watchdogLastPoke = {};       // camera -> last recovery timestamp
        this._watchdogStuckCount = {};     // camera -> consecutive stuck ticks
        this._watchdogPokeCooldownMs = 2000;  // don't re-poke same cam more than every 2s
        this._watchdogRequiredStuckTicks = 2; // must be stuck for 2 ticks (2s) before firing

        // Video labels for ended state tracking
        this.videoLabels = {
            front: document.querySelector('#videoFront')?.parentElement?.querySelector('.video-label'),
            back: document.querySelector('#videoBack')?.parentElement?.querySelector('.video-label'),
            left_repeater: document.querySelector('#videoLeft')?.parentElement?.querySelector('.video-label'),
            right_repeater: document.querySelector('#videoRight')?.parentElement?.querySelector('.video-label'),
            left_pillar: document.querySelector('#videoLeftPillar')?.parentElement?.querySelector('.video-label'),
            right_pillar: document.querySelector('#videoRightPillar')?.parentElement?.querySelector('.video-label')
        };

        this.setupEventListeners();

        // One quick check that WebCodecs here decodes H.264 at all, before
        // the first event opens (each clip is checked again when it loads).
        if (this._useWebCodecs && window.WebCodecsVideoElement?.probeH264) {
            window.WebCodecsVideoElement.probeH264().then(ok => {
                if (!ok) this._fallBackToCompat('codec', 'H.264 decoding is not supported by WebCodecs here');
            });
        }
    }

    /**
     * Fast player or Compatibility player, from the saved settings (read
     * directly from localStorage: this runs before window.app exists). Only
     * a choice made in Settings turns the fast player off; see
     * SettingsManager.wantsFastPlayer for the saved-default rule.
     */
    _wantsFastPlayer() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem('teslacamviewer_settings') || 'null');
        } catch { saved = null; }
        if (typeof SettingsManager !== 'undefined' && SettingsManager.wantsFastPlayer) {
            return SettingsManager.wantsFastPlayer(saved);
        }
        return !saved || saved.videoPlayerChosen !== true || saved.useWebCodecsPlayer !== false;
    }

    /**
     * Why the fast player can't start in this browser, or null.
     * @private
     */
    _fastPlayerBlocker() {
        const W = window.WebCodecsVideoElement;
        if (!W) return 'library';
        const why = W.unsupportedReason ? W.unsupportedReason() : (W.isSupported() ? null : 'unsupported');
        if (why) return why;
        const remembered = window.PlayerFallback?.active?.();
        return remembered ? (remembered.kind || 'codec') : null;
    }

    /**
     * A camera's canvas reports that WebCodecs can't play its clip.
     * 'codec' and 'file': the browser's own player can open the clip, so
     * switch now. 'decode': a decode error while playing; one can be a
     * damaged spot in a clip, so switch on the 3rd within 30 s.
     * @private
     */
    _onWebCodecsFailure(camera, detail) {
        if (!this._useWebCodecs || this._compatSwitching) return;
        const kind = detail?.kind || 'decode';
        const message = `${camera}: ${detail?.message || kind}`;
        if (kind === 'decode') {
            const now = Date.now();
            this._wcFailures = this._wcFailures.filter(t => now - t < 30000);
            this._wcFailures.push(now);
            if (this._wcFailures.length < 3) return;
        }
        this._fallBackToCompat(kind, message);
    }

    /**
     * Switch from the fast player to the Compatibility player now, without a
     * page reload: the page's own <video> elements go back in place of the
     * canvases (the same objects in this.videos, which SyncController also
     * holds), and the open event reloads at the same moment, playing again
     * if it was. Runs in the seek/load queue, after the load that failed.
     * @param {string} kind  see PlayerFallback
     * @param {string} [message]
     * @returns {Promise<void>|undefined}
     */
    _fallBackToCompat(kind, message) {
        if (!this._useWebCodecs || this._compatSwitching) return;
        this._compatSwitching = true;
        console.warn(`[VideoPlayer] Switching to the Compatibility player (${kind}): ${message || ''}`);
        window.PlayerFallback?.record?.(kind, message);
        const event = this.currentEvent;
        let wasPlaying = this.isPlaying;
        this._compatResumePlay = false;
        const run = this._exclusive(async () => {
            // Read where the player is once the load before this has finished
            const at = event && this.currentEvent === event ? this.getCurrentAbsoluteTime() : 0;
            wasPlaying = wasPlaying || this.isPlaying || this._compatResumePlay;
            if (this.isPlaying) await this.pause();
            this._stopWebCodecsMasterClock();
            for (const camera of Object.keys(this.videos)) {
                const canvas = this.videos[camera];
                const native = this._nativeVideos[camera];
                if (!canvas || !native || canvas === native) continue;
                try { canvas.pause(); } catch (e) { /* already stopped */ }
                try { canvas.src = ''; } catch (e) { /* decoder already closed */ }
                native.className = canvas.className;
                native.style.cssText = canvas.style.cssText;
                if (canvas.parentNode) canvas.parentNode.replaceChild(native, canvas);
                this.videos[camera] = native;
                if (this.videoURLs[camera]) {
                    URL.revokeObjectURL(this.videoURLs[camera]);
                    this.videoURLs[camera] = null;
                }
            }
            this._nativeVideos = {};
            this._useWebCodecs = false;
            this._compatReason = kind;
            this._wcFailures = [];
            this._setupMediaListeners();
            if (event && this.currentEvent === event) {
                await this._loadEventNow(event);
                if (at > 0) await this._seekToEventTimeNow(at);
            }
        });
        return run.then(async () => {
            this._compatSwitching = false;
            if (event && this.currentEvent === event && wasPlaying) await this.play();
            window.dispatchEvent(new CustomEvent('tcv-player-fallback', { detail: { kind } }));
            this._noteFallback(kind);
        }, (err) => {
            this._compatSwitching = false;
            console.error('[VideoPlayer] Switch to the Compatibility player failed:', err);
        });
    }

    /**
     * The one-time note: shown the first time the app switches to the
     * Compatibility player for this reason in this browser.
     * @private
     */
    _noteFallback(kind) {
        if (!window.PlayerFallback?.firstNote?.(kind)) return;
        let tries = 0;
        const show = () => {
            const app = window.app;
            if (!app?.showToast) {
                if (++tries < 40) setTimeout(show, 500);
                return;
            }
            const t = (k, fb) => {
                const s = window.i18n?.t ? window.i18n.t(k) : null;
                return s && s !== k ? s : fb;
            };
            app.showToast(t('player.fallbackNote',
                'This browser can\'t use the fast video player here, so TeslaCamViewer switched to the Compatibility player. You can change the player in Settings, Advanced.'),
            'info', 12000);
        };
        show();
    }

    /**
     * Build the videos map — either native HTMLVideoElement references
     * (default) or canvas replacements augmented by WebCodecsVideoElement
     * (when the useWebCodecsPlayer feature flag is on).
     *
     * For the WebCodecs path, each <video> element in the DOM is swapped
     * for a <canvas> with the same id/className so CSS rules keep working.
     * The returned map then contains canvases, but downstream code can still
     * do `.videos.front.src = url`, `.videos.front.currentTime = 5`, etc.
     * thanks to the property shim installed on each canvas.
     */
    _resolveVideos() {
        const ids = {
            front: 'videoFront',
            back: 'videoBack',
            left_repeater: 'videoLeft',
            right_repeater: 'videoRight',
            left_pillar: 'videoLeftPillar',
            right_pillar: 'videoRightPillar'
        };

        if (!this._useWebCodecs) {
            const out = {};
            for (const [cam, id] of Object.entries(ids)) {
                out[cam] = document.getElementById(id);
            }
            return out;
        }

        // WebCodecs path — replace each <video> with a <canvas>
        const out = {};
        for (const [cam, id] of Object.entries(ids)) {
            const oldEl = document.getElementById(id);
            if (!oldEl) { out[cam] = null; continue; }
            const canvas = document.createElement('canvas');
            canvas.id = oldEl.id;
            canvas.className = oldEl.className;
            // Copy a few inline styles that might have been set on the video,
            // though most styling comes from CSS via id/class.
            if (oldEl.style.objectFit) canvas.style.objectFit = oldEl.style.objectFit;
            if (oldEl.style.width) canvas.style.width = oldEl.style.width;
            if (oldEl.style.height) canvas.style.height = oldEl.style.height;
            oldEl.parentNode.replaceChild(canvas, oldEl);
            window.WebCodecsVideoElement.install(canvas);
            // Kept to put back if the app has to switch to the Compatibility player
            this._nativeVideos[cam] = oldEl;
            canvas.addEventListener('webcodecsfailure', (e) => this._onWebCodecsFailure(cam, e.detail));
            out[cam] = canvas;
        }
        return out;
    }

    /**
     * Setup video element event listeners
     */
    setupEventListeners() {
        this._setupMediaListeners();

        // Add double-click for fullscreen (on the boxes, which stay when the
        // player switches elements)
        for (const [camera, video] of Object.entries(this.videos)) {
            video.parentElement.addEventListener('dblclick', () => {
                this.toggleFullscreen(video.parentElement);
            });
        }
    }

    /**
     * Listeners on the camera elements themselves. Run again for the new
     * elements when the player switches to the Compatibility player.
     * @private
     */
    _setupMediaListeners() {
        // Time updates: the front camera's, and once the front has ended, the
        // cameras still playing the rest of the clip (#587: the clip runs
        // until its longest camera ends, so the timeline keeps moving).
        // The time is the clip's clock (getCurrentTime), not the front's.
        for (const [camera, video] of Object.entries(this.videos)) {
            if (!video) continue;
            video.addEventListener('timeupdate', () => {
                if (!this.onTimeUpdate) return;
                if (camera !== 'front') {
                    const f = this.videos.front;
                    const frontDone = !f || !this._hasSource(f) || f.ended
                        || (f.duration > 0 && f.currentTime >= f.duration - VideoPlayer.END_HOLD_SEC - 1e-3);
                    if (!frontDone) return;
                }
                this.onTimeUpdate(this.getCurrentTime());
            });
        }

        // Listen for all videos ending
        for (const [camera, video] of Object.entries(this.videos)) {
            video.addEventListener('ended', () => {
                this.updateVideoLabelState(camera, true);
                this.handleVideoEnded(camera);
            });

            // Track playing state to remove ended class
            video.addEventListener('playing', () => {
                this.updateVideoLabelState(camera, false);
                this.handleBufferingEnd(camera);
            });

            // Track buffering/stalling
            video.addEventListener('waiting', () => {
                this._logBufferingDiagnostics(camera, video, 'waiting');
                this.handleBufferingStart(camera);
            });

            video.addEventListener('stalled', () => {
                this._logBufferingDiagnostics(camera, video, 'stalled');
                this.handleBufferingStart(camera);
            });

            video.addEventListener('canplay', () => {
                this.handleBufferingEnd(camera);
            });

            video.addEventListener('seeking', () => {
                this._logBufferingDiagnostics(camera, video, 'seeking');
            });

            video.addEventListener('seeked', () => {
                if (window.__tcvBufferDiag === true) {
                    console.log(`[BufferDiag] ${camera}: seeked → currentTime=${video.currentTime.toFixed(3)}`);
                }
            });

            // Track buffer progress for read speed estimation
            video.addEventListener('progress', () => {
                this.updateBufferHealth(camera, video);
            });

            // Handle runtime errors during playback (not initial load)
            // The loadVideoForCamera method handles errors during load
            video.addEventListener('error', () => {
                // Only handle if video was actually playing (has currentTime > 0)
                // This avoids double-handling errors that loadVideoForCamera already caught
                // Suppress warnings during export to avoid 100K+ error spam
                if (video.currentTime > 0 && !window.app?.videoExport?.isExporting) {
                    console.warn(`Runtime playback error for ${camera} video`);
                    this.updateVideoLabelState(camera, true);
                }
            });
        }

        // Prevent individual video controls and mute all videos
        for (const video of Object.values(this.videos)) {
            video.controls = false;
            video.muted = true;
            video.volume = 0;
        }
    }

    /**
     * Update video label state (ended or playing)
     * @param {string} camera
     * @param {boolean} ended
     */
    updateVideoLabelState(camera, ended) {
        const label = this.videoLabels[camera];
        if (label) {
            if (ended) {
                label.classList.add('ended');
            } else {
                label.classList.remove('ended');
            }
        }
    }

    /**
     * Reset all video label states (remove ended class)
     */
    resetAllVideoLabelStates() {
        for (const label of Object.values(this.videoLabels)) {
            if (label) {
                label.classList.remove('ended');
            }
        }
    }

    /**
     * Toggle fullscreen for a video container
     * @param {HTMLElement} element
     */
    toggleFullscreen(element) {
        if (!document.fullscreenElement) {
            element.requestFullscreen().catch(err => {
                console.error('Error entering fullscreen:', err);
            });
        } else {
            document.exitFullscreen();
        }
    }

    /**
     * Load an event
     * @param {Object} event
     */
    async loadEvent(event) {
        // Seeks queued for the previous event are dropped; one that is running
        // finishes first, so it can't land on this event's clips.
        this._seekReq++;
        this._eventGen++;
        this._pendingPlay = null;   // a waiting start for the old event is dropped too
        return this._exclusive(() => this._loadEventNow(event));
    }

    async _loadEventNow(event) {
        this.currentEvent = event;
        this.currentClipIndex = -1;
        this.hasPillarCameras = event.hasPillarCameras || false;
        await this.loadClip(0);
        // Watchdog is HTML5-specific — it fixes Intel-iGPU 2-YUV-overlay-slot
        // starvation. WebCodecs rendering goes through canvas compositing, no
        // YUV overlays, no starvation; the watchdog's micro-seek recovery
        // would instead just interrupt playback for no reason.
        if (!this._useWebCodecs) {
            this._startStuckVideoWatchdog();
        }
    }

    /**
     * Run fn after every earlier queued seek/load has finished.
     * @private
     */
    _exclusive(fn) {
        const run = this._opQueue.then(() => fn());
        this._opQueue = run.catch(() => {});
        return run;
    }

    /**
     * Queue a seek. If another seek is queued behind the running one, only
     * the newest runs (like a native element, the newest seek wins).
     * @private
     */
    _queueSeek(fn) {
        const id = ++this._seekReq;
        this._seekPending++;
        return this._exclusive(async () => {
            try {
                if (id === this._seekReq) return await fn();
            } finally {
                this._seekPending--;
            }
        });
    }

    /**
     * Queue a clip step (Next/Previous Clip, auto-advance, loop). Steps run in
     * order after the seeks and loads before them, and each one starts from
     * the clip the previous one left: pressing Next Clip twice goes two clips
     * on. Before, each press loaded its clip at once; the two loads overlapped
     * on the same <video> elements and the first one's 10 s timeout then
     * cleared the clip that was showing, blanking every camera (#526).
     * Steps queued for an event that is no longer loaded are dropped.
     * @private
     */
    _queueClipStep(fn) {
        const gen = this._eventGen;
        this._seekPending++;
        return this._exclusive(async () => {
            try {
                if (gen === this._eventGen && this.currentEvent) return await fn();
            } finally {
                this._seekPending--;
            }
        });
    }

    /**
     * Cameras this event uses: 4, or 6 with the pillar cameras.
     * @private
     */
    _eventCameras() {
        const cameras = ['front', 'back', 'left_repeater', 'right_repeater'];
        if (this.hasPillarCameras) cameras.push('left_pillar', 'right_pillar');
        return cameras;
    }

    /**
     * The event's cameras that have a clip loaded. Seeks and play() only
     * touch these: the other <video> elements belong to no event.
     * @private
     */
    _loadedVideos() {
        return this._eventCameras()
            .map(c => this.videos[c])
            .filter(v => v && this._hasSource(v));
    }

    /**
     * True when the element has a clip. A native <video> whose src was set to
     * '' reports the page URL as its src, so check the attribute instead.
     * @private
     */
    _hasSource(v) {
        if (this._useWebCodecs) return !!v.src;
        const a = v.getAttribute('src');
        return !!a;
    }

    /**
     * Unload a camera the current event doesn't have (the pillars on a
     * 4-camera event). Before, the pillar elements kept the previous 6-camera
     * event's clips (they played hidden and counted in "all cameras ended"),
     * and a native <video> with no source stores any currentTime written to
     * it as its start position and jumps there when it next gets a clip: the
     * pillars of a 6-camera event opened after a 4-camera Sentry event began
     * at ~56 s while the others began at 0 (#514).
     * @private
     */
    _unloadCamera(camera) {
        const v = this.videos[camera];
        if (!v) return;
        if (this.videoURLs[camera]) {
            URL.revokeObjectURL(this.videoURLs[camera]);
            this.videoURLs[camera] = null;
        }
        if (this._useWebCodecs) {
            if (v.src) v.src = '';
            return;
        }
        if (v.hasAttribute('src')) {
            v.pause();
            v.removeAttribute('src');
            v.load();
        }
        this._clearStartPosition(v);
    }

    /**
     * A native <video> with no media (readyState 0) keeps a currentTime
     * written to it and seeks there once its next clip loads. Reset it.
     * @private
     */
    _clearStartPosition(v) {
        if (this._useWebCodecs || !v || v.readyState !== 0) return;
        try { v.currentTime = 0; } catch (e) { /* no media: nothing to reset */ }
    }

    /**
     * Start the stuck-video watchdog. Runs while an event is loaded.
     * Polls every 1s to detect the "readyState=2, currentTime frozen"
     * state that Intel integrated GPUs (2 YUV overlay slots) produce
     * under 4-camera contention. Micro-seeks stuck cameras to force a
     * decoder reset and recover.
     */
    _startStuckVideoWatchdog() {
        this._stopStuckVideoWatchdog();
        this._watchdogPrevTime = {};
        this._watchdogLastPoke = {};
        this._watchdogStuckCount = {};
        this._watchdogInterval = setInterval(() => this._stuckVideoCheck(), 1000);
    }

    _stopStuckVideoWatchdog() {
        if (this._watchdogInterval) {
            clearInterval(this._watchdogInterval);
            this._watchdogInterval = null;
        }
    }

    _stuckVideoCheck() {
        // Determine which cameras SHOULD be active for this event. For 6-cam
        // events we need to watch the pillars too — don't filter them out
        // just because readyState briefly dropped. The event's own
        // hasPillarCameras flag is the source of truth.
        const expectedCams = this.hasPillarCameras
            ? ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar']
            : ['front', 'back', 'left_repeater', 'right_repeater'];

        const activeCams = [];
        for (const cam of expectedCams) {
            const v = this.videos[cam];
            if (!v || !this._hasSource(v)) continue;
            activeCams.push([cam, v]);
        }
        if (activeCams.length < 2) return;

        // If ANY camera is currently seeking or has readyState < 2, we're
        // almost certainly mid clip-transition. Reset stuck counters and
        // skip — transitions naturally desync cameras by ~100-200ms and
        // we shouldn't mistake that for stuck.
        const transitionInProgress = activeCams.some(([, v]) =>
            v.seeking || v.readyState < 2
        );
        if (transitionInProgress) {
            for (const [cam, v] of activeCams) {
                this._watchdogPrevTime[cam] = v.currentTime;
                this._watchdogStuckCount[cam] = 0;
            }
            return;
        }

        const allPaused = activeCams.every(([, v]) => v.paused);
        if (allPaused) {
            for (const [cam, v] of activeCams) {
                this._watchdogPrevTime[cam] = v.currentTime;
                this._watchdogStuckCount[cam] = 0;
            }
            return;
        }

        // Peer median currentTime — robust to one stuck outlier
        const times = activeCams.map(([, v]) => v.currentTime).sort((a, b) => a - b);
        const median = times[Math.floor(times.length / 2)];

        const now = performance.now();
        for (const [cam, v] of activeCams) {
            const prev = this._watchdogPrevTime[cam] ?? v.currentTime;
            const advanced = (v.currentTime - prev) > 0.05;
            const behindMedian = (median - v.currentTime) > 0.5;
            // Specifically readyState === 2 (HAVE_CURRENT_DATA, decode stalled).
            // readyState 1 = HAVE_METADATA is transient during clip loads and
            // firing on it created a false-positive cascade during transitions.
            const decodeStalled = v.readyState === 2;
            const notPaused = !v.paused && !v.seeking;
            this._watchdogPrevTime[cam] = v.currentTime;

            const stuckCriteria = decodeStalled && !advanced && behindMedian && notPaused;
            if (stuckCriteria) {
                this._watchdogStuckCount[cam] = (this._watchdogStuckCount[cam] || 0) + 1;
            } else {
                this._watchdogStuckCount[cam] = 0;
                continue;
            }

            // Require stuck state to persist across >=2 consecutive ticks
            // before firing. Single-tick blips are normal transition noise.
            if (this._watchdogStuckCount[cam] < this._watchdogRequiredStuckTicks) continue;

            const lastPoke = this._watchdogLastPoke[cam] || 0;
            if (now - lastPoke < this._watchdogPokeCooldownMs) continue;
            this._watchdogLastPoke[cam] = now;
            this._watchdogStuckCount[cam] = 0;

            console.warn(`[VideoPlayer] Unsticking ${cam}: readyState=${v.readyState}, ct=${v.currentTime.toFixed(3)}, median peer=${median.toFixed(3)}. Micro-seeking.`);
            try {
                v.currentTime = Math.min(v.currentTime + 0.01, (v.duration || 60) - 0.1);
                // Let syncController know so it can flash the sync indicator
                // and track per-session recovery stats
                const sc = window.app?.syncController;
                if (sc && typeof sc.notifyWatchdogRecovery === 'function') {
                    sc.notifyWatchdogRecovery(cam, {
                        readyState: v.readyState,
                        currentTime: v.currentTime,
                        peerMedian: median
                    });
                }
            } catch (e) {
                console.warn(`[VideoPlayer] Micro-seek failed on ${cam}: ${e.message}`);
            }
        }
    }

    /**
     * Load a specific clip group
     * @param {number} clipIndex
     */
    async loadClip(clipIndex) {
        if (!this.currentEvent) return;

        if (clipIndex < 0 || clipIndex >= this.currentEvent.clipGroups.length) {
            console.warn('Invalid clip index:', clipIndex);
            return;
        }

        const wasPlaying = this.isPlaying;
        const currentRate = this.getPlaybackRate(); // Preserve playback rate before loading
        if (wasPlaying) {
            await this.pause();
        }

        // Reset label states when loading new clip
        this.resetAllVideoLabelStates();

        this.currentClipIndex = clipIndex;
        const clipGroup = this.currentEvent.clipGroups[clipIndex];

        // Determine which cameras to load (4 or 6 based on event)
        const cameras = this._eventCameras();
        for (const camera of Object.keys(this.videos)) {
            if (!cameras.includes(camera)) this._unloadCamera(camera);
        }

        // Load each camera
        const loadPromises = [];
        for (const camera of cameras) {
            const promise = this.loadVideoForCamera(camera, clipGroup);
            loadPromises.push(promise);
        }

        await Promise.all(loadPromises);

        // Reapply playback rate after loading new videos (browser resets to 1).
        // A speed picked while the clip was loading wins over the one read
        // when the load started: before, picking 2x during a slow clip load
        // (the fast player decodes in software) was undone at its end.
        this.setPlaybackRate(this._desiredRate || currentRate);

        if (this.onClipChange) {
            this.onClipChange(clipIndex);
        }

        // Resume playing if was playing before
        if (wasPlaying) {
            await this._playNow();
        }
    }

    /**
     * Load video file for a specific camera
     * @param {string} camera
     * @param {Object} clipGroup
     */
    async loadVideoForCamera(camera, clipGroup) {
        const clip = clipGroup.clips[camera];
        const video = this.videos[camera];

        // This load replaces any earlier one on this camera: end the earlier
        // one's wait now, and from here on only the newest load may change the
        // element. Before, an overtaken load's 10 s timeout still fired and
        // cleared the newer clip (#526).
        const token = (this._loadTokens[camera] || 0) + 1;
        this._loadTokens[camera] = token;
        const isCurrent = () => this._loadTokens[camera] === token;
        if (this._pendingLoadDone[camera]) this._pendingLoadDone[camera]();

        // The URL the element plays now is revoked only once the element has its next source. Revoking it first,
        // before the await below, left the element reading from a revoked URL, and Chrome logged
        // "blob:... net::ERR_FILE_NOT_FOUND" on clip switches (an export's mini-map pre-cache steps through every
        // clip of the range: 6-11 of them in a 10-minute export, on release/2026.49 too).
        const releasePrevious = (next) => {
            const prev = this.videoURLs[camera];
            this.videoURLs[camera] = next;
            if (prev && prev !== next) URL.revokeObjectURL(prev);
        };

        if (!clip || !clip.fileHandle) {
            video.src = '';
            releasePrevious(null);
            return;
        }

        try {
            const file = await clip.fileHandle.getFile();
            if (!isCurrent()) return;
            console.log(`[LoadVideo] ${camera}: ${file.name} (${(file.size/1024/1024).toFixed(2)} MB)`);

            // Skip empty or very small files (likely corrupted)
            if (file.size < 1024) {
                console.warn(`[LoadVideo] Skipping corrupted file for ${camera}: ${file.name} (${file.size} bytes)`);
                video.src = '';
                releasePrevious(null);
                return;
            }

            const url = URL.createObjectURL(file);
            this._clearStartPosition(video);
            video.src = url;
            releasePrevious(url);

            // Wait for video to be ready
            await new Promise((resolve) => {
                let timeout = null;
                const done = () => {
                    clearTimeout(timeout);
                    if (this._pendingLoadDone[camera] === done) this._pendingLoadDone[camera] = null;
                    resolve();
                };
                this._pendingLoadDone[camera] = done;

                timeout = setTimeout(() => {
                    if (isCurrent()) {
                        console.warn(`[LoadVideo] TIMEOUT for ${camera}: ${file.name}`);
                        // Clear source to abort the load
                        video.src = '';
                        this.videoURLs[camera] = null;
                        URL.revokeObjectURL(url);
                    }
                    done();
                }, 10000); // 10 second timeout

                video.onloadeddata = () => {
                    if (isCurrent()) console.log(`[LoadVideo] Loaded ${camera}: ${file.name}`);
                    done();
                };
                video.onerror = (e) => {
                    if (isCurrent()) {
                        // Suppress error logging during export to avoid 100K+ error spam
                        if (!window.app?.videoExport?.isExporting) {
                            console.error(`[LoadVideo] ERROR for ${camera}: ${file.name}`, e);
                        }
                        // Clear the source on error so it doesn't block playback
                        video.src = '';
                        this.videoURLs[camera] = null;
                        URL.revokeObjectURL(url);
                    }
                    done(); // Don't reject, let other cameras continue
                };
            });
        } catch (error) {
            console.error(`[LoadVideo] Exception for ${camera}:`, error);
            if (isCurrent()) {
                video.src = '';
                releasePrevious(null);
            }
        }
    }

    /**
     * Play all videos synchronized
     */
    async play() {
        // A start is already waiting (the next clip loading after a clip end,
        // or an earlier Play): it plays once ready, a Pause pressed meanwhile
        // is undone. Playing now would start the ended clip again (#596).
        if (this._pendingPlay) {
            this._pendingPlay.play = true;
            if (this.onPlayStateChange) this.onPlayStateChange(true);
            return;
        }
        // A seek or clip load is queued or running, or a fast-player camera
        // is still decoding the picture of a seek: play once it's done, from
        // where it lands (#596).
        if (this.currentEvent && (this._seekPending > 0 || this._canvasSeeking())) {
            if (this.onPlayStateChange) this.onPlayStateChange(true);
            return this._queuePlay(null);
        }
        // Nothing playable in this clip: _playNow loads the next one, so it
        // runs in the queue like any other clip load (#526).
        if (this.currentEvent && this._loadedVideos().length === 0) {
            return this._queueClipStep(() => this._playNow());
        }
        return this._playNow();
    }

    /**
     * play() itself. Inside the seek/load queue, call this, not play().
     * @private
     */
    async _playNow() {
        try {
            // Only play this event's videos that have a source loaded
            const activeVideos = this._loadedVideos();

            // Every camera failed in the fast player and the switch to the
            // Compatibility player is queued: it reloads this clip and plays
            // it. Advancing here would try every later clip first.
            if (activeVideos.length === 0 && this._compatSwitching) {
                this._compatResumePlay = true;
                return;
            }

            // If no videos have sources (all failed to load), skip to next clip
            if (activeVideos.length === 0) {
                console.warn('No playable videos in current clip, advancing to next');
                if (this.currentClipIndex < this.currentEvent.clipGroups.length - 1) {
                    await this.loadClip(this.currentClipIndex + 1);
                    return this._playNow(); // Try playing next clip
                } else {
                    console.log('No more clips to play');
                    this.isPlaying = false;
                    if (this.onPlayStateChange) {
                        this.onPlayStateChange(false);
                    }
                    return;
                }
            }

            const playPromises = activeVideos.map(v => v.play());
            await Promise.all(playPromises);
            this.isPlaying = true;

            // WebCodecs path — take over clock duty so all 6 canvases stay
            // in perfect lockstep (no independent rAF drift, no syncController
            // thrash). See _startWebCodecsMasterClock for why.
            if (this._useWebCodecs) this._startWebCodecsMasterClock();

            // Notify via callback
            if (this.onPlayStateChange) {
                this.onPlayStateChange(true);
            }
        } catch (error) {
            console.error('Error playing videos:', error);
            this.isPlaying = false;
        }
    }

    /**
     * Master rAF clock for WebCodecs-backed canvases.
     *
     * Each canvas has its own decoder + frame queue, but if each ran its own
     * rAF they'd drift (decode rates differ per camera, queue refills are
     * async). Drift → syncController fires resync seeks → decoder teardown
     * → visible stutter.
     *
     * With ONE master clock:
     *   - All 6 canvases always display the same absolute event-time
     *     (per-frame accuracy of the nearest decoded frame)
     *   - No resync seeks ever needed
     *   - syncController still runs but reports 0 drift, does nothing
     *
     * Also tells each canvas it has an external clock so their per-instance
     * rAF loops don't fight our master.
     */
    _startWebCodecsMasterClock() {
        if (this._wcMasterClock) return;
        // Attach external-clock mode to every camera canvas that supports it
        for (const v of Object.values(this.videos)) {
            if (v?.attachExternalClock) v.attachExternalClock();
        }
        const state = {
            rafHandle: null,
            lastT: performance.now(),
            // We advance "clip-local" time (videos share the same clip load).
            // Start from the clip's clock to pick up any existing seek
            // position: the furthest camera, as the front may have ended
            // before the others (#587).
            currentClipTime: this.getCurrentTime()
        };
        this._wcMasterClock = state;

        const tick = (now) => {
            if (!this._wcMasterClock || !this.isPlaying) {
                state.rafHandle = null;
                return;
            }
            const dt = (now - state.lastT) / 1000;
            state.lastT = now;
            const rate = this.videos.front?.playbackRate || 1;

            // Continuous pacing — master clock advances at wall-clock rate
            // but never runs ahead of the slowest decoder's produced
            // frames. This is smooth: no binary hold/advance oscillation
            // (previous version caused visible catch-up stutter when the
            // CPU was busy). Cameras whose decoder is FINISHED don't
            // constrain the cap — they just freeze-frame at their
            // duration while other cameras keep going.
            //
            // Cap rule: master time ≤ min(each still-producing camera's
            // decoderLastTs). This lets faster cameras smoothly render the
            // full queue while waiting for slower ones.
            let cap = Infinity;
            for (const v of Object.values(this.videos)) {
                if (!v?._wcv || v._wcv._readyState < 1) continue;
                if (!v.src) continue;
                if (v._wcv._decoderFinished) continue;
                const last = v._wcv._decoderLastTs;
                // If a decoder hasn't produced anything yet (-1), don't let
                // it cap us to a negative value and freeze the whole player.
                // Instead treat it as "no information, defer to other cams."
                if (last < 0) continue;
                if (last < cap) cap = last;
            }
            const targetTime = state.currentClipTime + dt * rate;
            state.currentClipTime = Math.min(targetTime, cap);

            // End-of-clip detection — master clock ends when it's passed the
            // LONGEST clip duration across all 6 cameras. Some clips (e.g.
            // right_pillar/right_repeater on certain events) are a fraction
            // of a second shorter than front. Ending at front.duration used
            // to work for HTML5 because browser video marked individual
            // tracks ended independently; here we're a single clock, so we
            // wait for the max so no camera ends before the clock does.
            //
            // When master clock passes an individual camera's duration, we
            // still mark THAT camera's _ended=true right then so downstream
            // handleVideoEnded can poll per-camera state correctly.
            let maxDur = 0;
            for (const v of Object.values(this.videos)) {
                if (!v?.src) continue;
                const d = v.duration || 0;
                if (d > maxDur) maxDur = d;
                // Proactively mark individual cameras ended when past their
                // own duration — their canvas will just freeze-frame.
                const wcv = v._wcv;
                if (wcv && !wcv._ended && d > 0 && state.currentClipTime >= d) {
                    wcv._ended = true;
                    wcv._fire('ended');
                }
            }
            if (state.currentClipTime >= maxDur && maxDur > 0) {
                state.currentClipTime = maxDur;
                // Final sweep — make sure every canvas fired ended (needed
                // for handleVideoEnded's "allEnded" check to pass).
                for (const v of Object.values(this.videos)) {
                    const wcv = v?._wcv;
                    if (wcv && !wcv._ended && v.src) {
                        wcv._ended = true;
                        wcv._fire('ended');
                    }
                }
                // Clean up master-clock state so the next play() sets up fresh.
                this._wcMasterClock = null;
                state.rafHandle = null;
                return;
            }

            for (const v of Object.values(this.videos)) {
                if (v?.tick) v.tick(state.currentClipTime);
            }
            state.rafHandle = requestAnimationFrame(tick);
        };
        state.rafHandle = requestAnimationFrame(tick);
    }

    _stopWebCodecsMasterClock() {
        if (!this._wcMasterClock) return;
        if (this._wcMasterClock.rafHandle) {
            cancelAnimationFrame(this._wcMasterClock.rafHandle);
        }
        this._wcMasterClock = null;
        for (const v of Object.values(this.videos)) {
            if (v?.detachExternalClock) v.detachExternalClock();
        }
    }

    /**
     * Pause all videos
     */
    async pause() {
        // A start still waiting for its clip or seek doesn't happen (#596)
        if (this._pendingPlay) this._pendingPlay.play = false;
        if (this._useWebCodecs) this._stopWebCodecsMasterClock();
        for (const video of Object.values(this.videos)) {
            video.pause();
        }
        this.isPlaying = false;

        // Notify via callback
        if (this.onPlayStateChange) {
            this.onPlayStateChange(false);
        }
    }

    /**
     * Seek to a specific time in current clip
     * @param {number} time Time in seconds
     */
    async seek(time) {
        return this._queueSeek(() => this._seekNow(time));
    }

    /**
     * Seek by an offset from where the player is when the seek runs (frame
     * step, +/-5 s). Callers used to read currentTime when the key was
     * pressed, while a clip could still be loading from the previous step:
     * holding "," across a clip boundary jumped back about a minute
     * (audit 1.10). A step that is still waiting absorbs the next one, so
     * holding a key never builds a backlog; a newer seek or event load
     * drops it, like any queued seek.
     * @param {number} delta Seconds, negative for back
     */
    seekBy(delta) {
        const pend = this._pendingSeekBy;
        if (pend && pend.id === this._seekReq) {
            pend.delta += delta;
            return pend.promise;
        }
        const step = { id: this._seekReq, delta };   // a seek queued before it still runs first
        this._pendingSeekBy = step;
        this._seekPending++;
        step.promise = this._exclusive(async () => {
            if (this._pendingSeekBy === step) this._pendingSeekBy = null;
            try {
                if (step.id === this._seekReq) return await this._seekNow(this.getCurrentTime() + step.delta);
            } finally {
                this._seekPending--;
            }
        });
        return step.promise;
    }

    /**
     * Length of the loaded clip: its LONGEST loaded camera's (#587: the
     * cameras of a clip end up to ~0.5 s apart, and the clip plays until the
     * last one ends), or the cached probe of this clip while no camera knows
     * its length yet. 0 when neither is known. (It was the front video's
     * length: a seek or frame step past the front's end loaded the next clip
     * while the other cameras still had frames to show.)
     * @private
     */
    _clipDuration() {
        let d = 0;
        for (const v of this._loadedVideos()) {
            const vd = v.duration;
            if (Number.isFinite(vd) && vd > d) d = vd;
        }
        if (d > 0) return d;
        const cached = this.cachedClipDurations[this.currentClipIndex];
        return Number.isFinite(cached) && cached > 0 ? cached : 0;
    }

    /**
     * Where a seek to clip time `t` puts one camera: `t`, but never past the
     * camera's own last frame. A camera shorter than the clip holds its last
     * frame through the rest of the clip, as it does while playing (#587).
     * The margin is less than a frame (Tesla's frames are 19-37 ms apart):
     * the old 0.05 s showed the frame before the last one.
     * @private
     */
    _cameraTime(video, t) {
        const d = video.duration;
        const max = Number.isFinite(d) && d > 0 ? Math.max(0, d - VideoPlayer.END_HOLD_SEC) : t;
        return Math.max(0, Math.min(t, max));
    }

    /** @private */
    async _seekNow(time) {
        // If seeking backwards past start of clip, load previous clip
        if (time < 0 && this.currentClipIndex > 0) {
            console.log('Seeking before start of clip, loading previous clip');
            await this.loadClip(this.currentClipIndex - 1);
            // Seek to end of previous clip + the negative offset
            const duration = this._clipDuration();
            const newTime = Math.max(0, duration + time); // time is negative
            for (const video of this._loadedVideos()) {
                video.currentTime = this._cameraTime(video, newTime);
            }
            if (this._wcMasterClock) this._wcMasterClock.currentClipTime = newTime;
            this._refreshEndedLabels(newTime);
            return;
        }

        // Check if seeking past end of current clip - load next clip.
        // An unknown length (0) never counts as "past the end".
        const currentDuration = this._clipDuration();
        if (currentDuration > 0 && time >= currentDuration && this.currentEvent &&
            this.currentClipIndex < this.currentEvent.clipGroups.length - 1) {
            console.log('Seeking past end of clip, loading next clip');
            const overflow = Math.max(0, time - currentDuration);
            await this.loadClip(this.currentClipIndex + 1);
            // Seek to the overflow amount in the new clip
            for (const video of this._loadedVideos()) {
                video.currentTime = this._cameraTime(video, overflow);
            }
            if (this._wcMasterClock) this._wcMasterClock.currentClipTime = overflow;
            this._refreshEndedLabels(overflow);
            return;
        }

        // Normal seek within current clip. Each camera goes to `time` or its
        // own last frame (_cameraTime); the clip's clock goes to `time`, up to
        // just before the longest camera's end.
        let effectiveTime = null;
        for (const video of this._loadedVideos()) {
            video.currentTime = this._cameraTime(video, time);
        }
        if (this._loadedVideos().length) {
            const dur = this._clipDuration();
            effectiveTime = Math.max(0, dur > 0 ? Math.min(time, Math.max(0, dur - VideoPlayer.END_HOLD_SEC)) : time);
            this._refreshEndedLabels(effectiveTime);
        }

        // Keep the WebCodecs master clock in sync with the seek. Without
        // this, the clock's internal currentClipTime lagged behind the
        // seek and the next rAF tick would draw the OLD position — making
        // timeline clicks appear to seek back to "near clip start."
        if (this._wcMasterClock && effectiveTime !== null) {
            this._wcMasterClock.currentClipTime = effectiveTime;
        }
    }

    /**
     * Current time in the clip: the clip's own clock, which runs until its
     * longest camera ends (#587). While the WebCodecs player plays that is
     * its master clock; otherwise the furthest loaded camera (a camera that
     * ended stops at its own length while the others play on, so the front's
     * time alone stood still in the last part of the clip and a frame step
     * from there jumped to the next clip).
     * @returns {number}
     */
    getCurrentTime() {
        if (this._wcMasterClock && Number.isFinite(this._wcMasterClock.currentClipTime)) {
            return this._wcMasterClock.currentClipTime;
        }
        let t = null;
        for (const v of this._loadedVideos()) {
            const ct = v.currentTime;
            if (Number.isFinite(ct) && (t === null || ct > t)) t = ct;
        }
        return t !== null ? t : (this.videos.front?.currentTime || 0);
    }

    /**
     * Cameras that have ended at clip time `t` of clip `clipIndex`: a loaded
     * camera whose own length (cachedCameraDurations, else its element's)
     * is at or before `t`. Its label is red from there until the next clip,
     * live and in exports (#586).
     * @param {number} clipIndex
     * @param {number} t - seconds into that clip
     * @returns {Set<string>}
     */
    endedCamerasAt(clipIndex, t) {
        const out = new Set();
        const per = this.cachedCameraDurations?.[clipIndex] || null;
        const group = this.currentEvent?.clipGroups?.[clipIndex];
        for (const cam of this._eventCameras()) {
            let d = per ? per[cam] : undefined;
            if (!(d > 0) && clipIndex === this.currentClipIndex) {
                const v = this.videos[cam];
                if (v && this._hasSource(v)) d = v.duration;
            }
            if (!(d > 0)) continue;
            if (group && !group.clips?.[cam]) continue;
            if (t >= d - 1e-6) out.add(cam);
        }
        return out;
    }

    /**
     * After a seek: a camera's label is red when the clip's clock is at or
     * past that camera's end, else not (it used to stay red after seeking
     * back from the end of a clip, until the camera played again).
     * @private
     */
    _refreshEndedLabels(clipTime) {
        const ended = this.endedCamerasAt(this.currentClipIndex, clipTime + VideoPlayer.END_HOLD_SEC);
        for (const cam of this._eventCameras()) this.updateVideoLabelState(cam, ended.has(cam));
    }

    /**
     * Get duration of current clip (from front camera)
     * @returns {number}
     */
    getCurrentDuration() {
        return this.videos.front.duration || 0;
    }

    /**
     * Handle when a video ends
     * @param {string} camera
     */
    handleVideoEnded(camera) {
        // Check if ALL active videos have actually ended (not just paused)
        // Only check videos that have a source loaded (src is set and not empty)
        const activeVideos = this._loadedVideos();
        // Consider a video "done" if it ended OR errored (don't block on corrupted files)
        // A Compatibility-player camera held on its own last frame (a seek past
        // its end puts it END_HOLD_SEC before its length, #587) counts as
        // ended, and so does one whose length is behind a camera that has
        // ended (the clip's clock is past its end): Chrome may never fire
        // 'ended' for a <video> played from that close to its end, and the
        // clip then never moved on (#596).
        const clock = activeVideos.reduce((m, v) => (v.ended && v.duration > m ? v.duration : m), 0);
        const done = v => !this._useWebCodecs && Number.isFinite(v.duration) && v.duration > 0
            && (v.currentTime >= v.duration - VideoPlayer.END_HOLD_SEC - 0.005 || v.duration <= clock + 0.001);
        const allEnded = activeVideos.length > 0 && activeVideos.every(v => v.ended || v.error || done(v));

        if (!allEnded) {
            // Not all videos finished yet, keep waiting
            return;
        }

        // A seek or event load is queued or running: it decides where playback
        // goes, so don't also advance to the next clip.
        if (this._seekPending > 0) {
            return;
        }

        // All videos have ended
        const wasPlaying = this.isPlaying;
        this.isPlaying = false;

        // Check if auto-advance is disabled (e.g., during export)
        if (this.disableAutoAdvance) {
            console.log('Auto-advance disabled, not loading next clip');
            return;
        }

        // Try to load next clip if we were playing (queued like a Next Clip
        // press, so it can't overlap another clip load: #526)
        if (wasPlaying && this.currentClipIndex < this.currentEvent.clipGroups.length - 1) {
            const endedClip = this.currentClipIndex;
            this._queuePlay(() => this._advanceFrom(endedClip, endedClip + 1)).catch(err => {
                console.error('Error loading next clip:', err);
                if (this.onPlayStateChange) {
                    this.onPlayStateChange(false);
                }
            });
        } else if (this.currentClipIndex >= this.currentEvent.clipGroups.length - 1) {
            // Event finished - check if loop is enabled
            if (this.loopEnabled) {
                // Loop back to first clip
                const endedClip = this.currentClipIndex;
                this._queuePlay(() => this._advanceFrom(endedClip, 0)).catch(err => {
                    console.error('Error looping to first clip:', err);
                    if (this.onPlayStateChange) {
                        this.onPlayStateChange(false);
                    }
                });
            } else {
                // Event finished
                if (this.onEnded) {
                    this.onEnded();
                }
                if (this.onPlayStateChange) {
                    this.onPlayStateChange(false);
                }
            }
        }
    }

    /**
     * Start playback from the clip-step queue, after the seeks and clip loads
     * queued before it (#596): first `prep` (an async step returning false
     * when there is nothing to play, e.g. the next clip's load after a clip
     * end), then, on the fast player, until every camera shows its seeked
     * picture (3 s at most), then play. A Pause pressed meanwhile cancels the
     * start, Play again brings it back (see _pendingPlay).
     * @private
     */
    _queuePlay(prep) {
        const p = { play: true };
        this._pendingPlay = p;
        return this._queueClipStep(async () => {
            if (this._pendingPlay !== p) return;                // a new event dropped it
            if (prep && !(await prep())) return;
            if (this._useWebCodecs) {
                const t0 = performance.now();
                while (this._pendingPlay === p && p.play && this._canvasSeeking() && performance.now() - t0 < 3000) {
                    await new Promise(r => setTimeout(r, 16));
                }
            }
            if (this._pendingPlay !== p) return;
            this._pendingPlay = null;
            if (p.play) {
                await this._playNow();
            } else if (this.onPlayStateChange) {
                this.onPlayStateChange(false);
            }
        }).finally(() => {
            // dropped, nothing to play, or failed: the button follows what really plays
            if (this._pendingPlay === p) {
                this._pendingPlay = null;
                if (this.onPlayStateChange) this.onPlayStateChange(this.isPlaying);
            }
        });
    }

    /**
     * The clip-end step of _queuePlay: clip `endedClip` ended while playing,
     * load `nextClip` (the next one, or the first when looping). False when
     * something else moved on already.
     * @private
     */
    async _advanceFrom(endedClip, nextClip) {
        if (this.currentClipIndex !== endedClip) return false;
        await this.loadClip(nextClip);
        return true;
    }

    /**
     * True while a loaded fast-player camera is still decoding the picture of
     * a seek (its canvas shows the picture from before it).
     * @private
     */
    _canvasSeeking() {
        if (!this._useWebCodecs) return false;
        return this._loadedVideos().some(v => v._wcv && v.seeking);
    }

    /**
     * Go to next clip
     */
    async nextClip() {
        if (!this.currentEvent) return;
        return this._queueClipStep(async () => {
            if (this.currentClipIndex < this.currentEvent.clipGroups.length - 1) {
                await this.loadClip(this.currentClipIndex + 1);
            }
        });
    }

    /**
     * Go to previous clip
     */
    async previousClip() {
        if (!this.currentEvent) return;
        return this._queueClipStep(async () => {
            if (this.currentClipIndex > 0) {
                await this.loadClip(this.currentClipIndex - 1);
            }
        });
    }

    /**
     * Set volume for all videos
     * @param {number} volume 0-1
     */
    setVolume(volume) {
        for (const video of Object.values(this.videos)) {
            video.volume = volume;
        }
    }

    /**
     * Set playback rate for all videos
     * @param {number} rate Playback rate (0.25, 0.5, 1, 1.5, 2, etc.)
     */
    setPlaybackRate(rate) {
        this._desiredRate = rate;
        for (const video of Object.values(this.videos)) {
            video.playbackRate = rate;
        }
    }

    /**
     * Get current playback rate
     * @returns {number}
     */
    getPlaybackRate() {
        return this.videos.front.playbackRate || 1;
    }

    /**
     * Set loop mode
     * @param {boolean} enabled
     */
    setLoop(enabled) {
        this.loopEnabled = enabled;
    }

    // --- Clip timing shared with everything drawn against event time (#537)
    // The player's per-clip lengths (cachedClipDurations: each clip lasts until
    // its longest camera ends, #587) are the one source of truth: the short
    // last clip keeps its real length, and a clip group with no front video is
    // 0 s because the player skips it. Graphs, markers, thumbnails, CSV times
    // and export overlays use these helpers so they line up with the player.
    // 60 s is only the fallback for a clip whose length isn't known yet.
    // Telemetry comes from the front video, so its frames spread over the
    // front's own length (frontLength), which can be shorter than the clip.

    /**
     * Length of one clip in event seconds.
     * @param {number[]} durations - cachedClipDurations (may be empty)
     * @param {number} clipIndex
     * @returns {number}
     */
    static clipLength(durations, clipIndex) {
        const d = Array.isArray(durations) ? durations[clipIndex] : undefined;
        return Number.isFinite(d) && d >= 0 ? d : VideoPlayer.FALLBACK_CLIP_SEC;
    }

    /**
     * The front video's own length in one clip: what the front's telemetry
     * frames spread over (#587). It is the clip's length when the per-camera
     * lengths aren't known (`durations.cameras`, set with cachedClipDurations).
     * @param {number[]} durations - cachedClipDurations (may be empty)
     * @param {number} clipIndex
     * @returns {number}
     */
    static frontLength(durations, clipIndex) {
        const len = VideoPlayer.clipLength(durations, clipIndex);
        const per = durations && Array.isArray(durations.cameras) ? durations.cameras[clipIndex] : null;
        const f = per ? per.front : undefined;
        return Number.isFinite(f) && f > 0 && len > 0 ? Math.min(f, len) : len;
    }

    /**
     * Event time at which a clip starts.
     * @param {number[]} durations - cachedClipDurations (may be empty)
     * @param {number} clipIndex
     * @returns {number}
     */
    static clipStart(durations, clipIndex) {
        let tmp = 0;
        for (let idx = 0; idx < clipIndex; idx++) tmp += VideoPlayer.clipLength(durations, idx);
        return tmp;
    }

    /**
     * Clip and time in clip for an event time, the way the player seeks:
     * 0 s clips are skipped, a time past the end lands at the last clip's end.
     * @param {number[]} durations - cachedClipDurations (may be empty)
     * @param {number} eventTime
     * @param {number} [clipCount] - defaults to durations.length
     * @returns {{clipIndex: number, timeInClip: number}}
     */
    static locateTime(durations, eventTime, clipCount) {
        const n = Number.isInteger(clipCount) ? clipCount : (Array.isArray(durations) ? durations.length : 0);
        const t = Math.max(0, Number(eventTime) || 0);
        let preceding = 0;
        let last = null;
        for (let idx = 0; idx < n; idx++) {
            const d = VideoPlayer.clipLength(durations, idx);
            if (d <= 0) continue;
            if (t < preceding + d) return { clipIndex: idx, timeInClip: t - preceding };
            preceding += d;
            last = { clipIndex: idx, timeInClip: d };
        }
        return last ? last : { clipIndex: 0, timeInClip: 0 };
    }

    /**
     * Get total event duration
     * @returns {Promise<number>} Duration in seconds
     */
    async getTotalDuration() {
        if (!this.currentEvent) return 0;

        // Rebuild the duration cache into a local array and swap it in at the
        // end, and only if the same event is still loaded. Before, the shared
        // array was emptied first and filled across awaits: other callers saw
        // it empty for seconds, and a rebuild for the previous event pushed
        // into the next event's array.
        const event = this.currentEvent;
        const durations = [];
        const cameraDurations = [];
        let total = 0;
        const cameras = this._eventCameras();

        for (let i = 0; i < event.clipGroups.length; i++) {
            const clipGroup = event.clipGroups[i];
            // A clip group without a front video is 0 s: the player skips it (#537).
            const clip = clipGroup.clips.front;
            let duration = 0;
            const perCamera = {};

            if (clip && clip.fileHandle) {
                // A clip lasts until its LONGEST camera ends (#587). Tesla's
                // cameras end a clip up to ~0.5 s apart (on a real 6-camera event
                // the front was 0.48 s shorter than the repeaters in 3 of 10
                // clips), and the player waits for every camera to end before
                // the next clip. The clip used to be measured by its front
                // video alone, so seeks, frame steps and exports moved to the
                // next clip at the front's end and cut the other cameras'
                // last frames. Every camera's own length is kept too: a
                // camera has ended from there on (its label turns red).
                const probes = await Promise.all(cameras.map(async (cam) => {
                    const c = clipGroup.clips[cam];
                    if (!c || !c.fileHandle) return [cam, null];
                    try {
                        const file = await c.fileHandle.getFile();
                        // Skip empty/corrupted files
                        if (file.size < 1024) {
                            console.warn(`Skipping empty file for duration: ${file.name}`);
                            return [cam, null];
                        }
                        return [cam, await this._probeClipDuration(file, null)];
                    } catch (error) {
                        console.error('Error getting clip duration:', error);
                        return [cam, null];
                    }
                }));
                for (const [cam, d] of probes) {
                    if (Number.isFinite(d) && d > 0) {
                        perCamera[cam] = d;
                        if (d > duration) duration = d;
                    }
                }
                if (!(duration > 0)) duration = 60; // Default: no camera's length could be read
            }

            durations.push(duration);
            cameraDurations.push(perCamera);
            total += duration;
        }

        if (this.currentEvent === event) {
            durations.cameras = cameraDurations;   // for VideoPlayer.frontLength
            this.cachedClipDurations = durations;
            this.cachedCameraDurations = cameraDurations;
        }
        console.log(`[VideoPlayer] Cached ${this.cachedClipDurations.length} clip durations, total: ${total.toFixed(1)}s`);
        return total;
    }

    /**
     * Probe a single clip's duration by briefly loading it in a throwaway
     * <video> element. Retries once on transient failure — most metadata
     * errors during event load are decoder/IO contention rather than
     * actually corrupt files. Falls back to `fallback` (the 60s default) if
     * both attempts fail. A length once read is remembered for that file
     * (name, size, date): every export re-reads the event's clip lengths,
     * and that's 6 files a clip now (#587).
     * @param {File} file
     * @param {number|null} [fallback=60]
     * @returns {Promise<number|null>}
     * @private
     */
    async _probeClipDuration(file, fallback = 60) {
        if (!this._probedDurations) this._probedDurations = new Map();
        const key = `${file.name}|${file.size}|${file.lastModified}`;
        if (this._probedDurations.has(key)) return this._probedDurations.get(key);
        const attempt = () => new Promise((resolve) => {
            const video = document.createElement('video');
            const url = URL.createObjectURL(file);
            const cleanup = () => {
                video.src = '';
                URL.revokeObjectURL(url);
            };
            const timeout = setTimeout(() => { cleanup(); resolve({ ok: false, reason: 'timeout' }); }, 5000);
            video.onloadedmetadata = () => {
                clearTimeout(timeout);
                const d = video.duration || 60;
                cleanup();
                resolve({ ok: true, duration: d });
            };
            video.onerror = () => {
                clearTimeout(timeout);
                cleanup();
                resolve({ ok: false, reason: 'error' });
            };
            video.src = url;
        });

        let res = await attempt();
        if (!res.ok) {
            // Yield for a frame then retry — most transient failures come from
            // brief decoder/IO pressure during concurrent event-load work.
            await new Promise(r => setTimeout(r, 120));
            res = await attempt();
        }
        if (!res.ok) {
            console.warn(`Unable to probe duration for ${file.name} after retry (${res.reason})` +
                (fallback === null ? '' : `; using ${fallback}s default`));
            return fallback;
        }
        if (this._probedDurations.size > 2000) this._probedDurations.clear();
        this._probedDurations.set(key, res.duration);
        return res.duration;
    }

    /**
     * Seek to absolute time in event (across all clips)
     * Uses cached clip durations from getTotalDuration() for consistent timing
     * @param {number} eventTime Time in seconds from start of event
     */
    async seekToEventTime(eventTime) {
        return this._queueSeek(() => this._seekToEventTimeNow(eventTime));
    }

    /** @private */
    async _seekToEventTimeNow(eventTime) {
        if (!this.currentEvent) return;

        // Clamp eventTime to valid range [0, totalDuration]
        // This prevents jumping to the start when seeking past the end
        eventTime = Math.max(0, eventTime);

        let accumulatedTime = 0;
        let targetClipIndex = 0;
        let timeInClip = 0;
        let foundClip = false;

        // Use cached durations for consistent seeking (populated by getTotalDuration)
        if (this.cachedClipDurations.length === this.currentEvent.clipGroups.length) {
            // Use cached durations - fast and consistent
            for (let i = 0; i < this.cachedClipDurations.length; i++) {
                const duration = this.cachedClipDurations[i];
                if (duration === 0) continue; // Skip clips without front camera

                if (accumulatedTime + duration >= eventTime) {
                    targetClipIndex = i;
                    timeInClip = eventTime - accumulatedTime;
                    foundClip = true;
                    break;
                }
                accumulatedTime += duration;
            }

            // If eventTime exceeds total duration, seek to the end of the last valid clip
            if (!foundClip && this.cachedClipDurations.length > 0) {
                // Find the last clip with valid duration
                for (let i = this.cachedClipDurations.length - 1; i >= 0; i--) {
                    if (this.cachedClipDurations[i] > 0) {
                        targetClipIndex = i;
                        // Seek to slightly before the end (0.1s buffer to avoid end-of-video issues)
                        timeInClip = Math.max(0, this.cachedClipDurations[i] - 0.1);
                        console.log(`[VideoPlayer] seekToEventTime: eventTime ${eventTime.toFixed(2)}s exceeds duration, seeking to end of clip ${i} at ${timeInClip.toFixed(2)}s`);
                        break;
                    }
                }
            }
        } else {
            // Fallback: calculate durations (slower, but works if cache not available)
            console.warn('[VideoPlayer] seekToEventTime: Using fallback duration calculation');
            let lastValidClipIndex = 0;
            let lastValidDuration = 60;

            for (let i = 0; i < this.currentEvent.clipGroups.length; i++) {
                const clipGroup = this.currentEvent.clipGroups[i];
                const clip = clipGroup.clips.front;

                if (!clip || !clip.fileHandle) continue;

                try {
                    const file = await clip.fileHandle.getFile();
                    const video = document.createElement('video');
                    const url = URL.createObjectURL(file);
                    video.src = url;

                    const duration = await new Promise((resolve) => {
                        const timeout = setTimeout(() => resolve(60), 3000);
                        video.onloadedmetadata = () => {
                            clearTimeout(timeout);
                            resolve(video.duration || 60);
                        };
                        video.onerror = () => {
                            clearTimeout(timeout);
                            resolve(60);
                        };
                    });

                    // Clean up
                    video.src = '';
                    URL.revokeObjectURL(url);

                    // Track last valid clip for edge case handling
                    lastValidClipIndex = i;
                    lastValidDuration = duration;

                    if (accumulatedTime + duration >= eventTime) {
                        targetClipIndex = i;
                        timeInClip = eventTime - accumulatedTime;
                        foundClip = true;
                        break;
                    }
                    accumulatedTime += duration;
                } catch (error) {
                    console.error('Error during seek:', error);
                    accumulatedTime += 60; // Default on error to prevent drift
                }
            }

            // If eventTime exceeds total duration, seek to the end of the last valid clip
            if (!foundClip) {
                targetClipIndex = lastValidClipIndex;
                // Seek to slightly before the end (0.1s buffer to avoid end-of-video issues)
                timeInClip = Math.max(0, lastValidDuration - 0.1);
                console.log(`[VideoPlayer] seekToEventTime (fallback): eventTime ${eventTime.toFixed(2)}s exceeds duration, seeking to end of clip ${targetClipIndex} at ${timeInClip.toFixed(2)}s`);
            }
        }

        // Load target clip if different
        if (targetClipIndex !== this.currentClipIndex) {
            await this.loadClip(targetClipIndex);
        }

        // Seek within clip. Awaited: at an exact clip boundary (eventTime ==
        // end of a clip) seek() loads the next clip, and a caller that seeks
        // again right after (the frame-by-frame export) would otherwise see the
        // old clip still on screen and race that load into loading the clip
        // after it.
        await this._seekNow(timeInClip);
    }

    /**
     * Clear all videos
     */
    clear() {
        this.pause();

        for (const video of Object.values(this.videos)) {
            video.src = '';
        }

        // Revoke URLs
        for (const camera in this.videoURLs) {
            if (this.videoURLs[camera]) {
                URL.revokeObjectURL(this.videoURLs[camera]);
                this.videoURLs[camera] = null;
            }
        }

        this.currentEvent = null;
        this.currentClipIndex = -1;
        this.cachedClipDurations = []; // Clear duration cache
        this.cachedCameraDurations = [];
        this._stopStuckVideoWatchdog();
    }

    /**
     * Check if player is currently playing
     * @returns {boolean}
     */
    getIsPlaying() {
        // A start waiting for its clip or seek is playing as far as the user
        // is concerned: Pause shows, Space pauses (#596)
        return this.isPlaying || !!(this._pendingPlay && this._pendingPlay.play);
    }

    /**
     * Get current absolute time in event (across all clips) using cached durations
     * This is the inverse of seekToEventTime - converts current position to absolute time
     * @returns {number} Absolute time in seconds from start of event
     */
    getCurrentAbsoluteTime() {
        if (!this.currentEvent) return 0;

        let absoluteTime = 0;

        // Add duration of all previous clips using cached durations for accuracy
        if (this.cachedClipDurations.length > 0) {
            for (let i = 0; i < this.currentClipIndex && i < this.cachedClipDurations.length; i++) {
                absoluteTime += this.cachedClipDurations[i];
            }
        } else {
            // Fallback to 60-second estimate if cache not populated
            absoluteTime = this.currentClipIndex * 60;
        }

        // Add current time within clip
        absoluteTime += this.getCurrentTime();

        return absoluteTime;
    }

    /**
     * Diagnostic logger — captures rich context at the moment a video reports
     * a waiting/stalled/seeking event. Correlates with recent mouse activity
     * so we can see whether buffering events are mouse-event-triggered or
     * something else entirely (network stall, codec hitch, etc.).
     *
     * Off by default to keep the console clean. Enable with
     * `window.__tcvBufferDiag = true` in DevTools before reproducing.
     * @private
     */
    _logBufferingDiagnostics(camera, video, eventName) {
        if (window.__tcvBufferDiag !== true) return;
        // Track recent mouse activity globally — one listener for all cameras.
        if (!VideoPlayer._diagMouseInit) {
            VideoPlayer._diagMouseInit = true;
            VideoPlayer._lastMouseAt = 0;
            VideoPlayer._lastMouseTarget = null;
            VideoPlayer._mouseSamples = [];
            document.addEventListener('mousemove', (e) => {
                VideoPlayer._lastMouseAt = performance.now();
                VideoPlayer._lastMouseTarget = e.target;
                VideoPlayer._mouseSamples.push(VideoPlayer._lastMouseAt);
                // Keep last ~2s of samples
                const cutoff = VideoPlayer._lastMouseAt - 2000;
                while (VideoPlayer._mouseSamples.length > 0 && VideoPlayer._mouseSamples[0] < cutoff) {
                    VideoPlayer._mouseSamples.shift();
                }
            }, { capture: true, passive: true });
        }

        const now = performance.now();
        const msSinceMouse = VideoPlayer._lastMouseAt > 0 ? (now - VideoPlayer._lastMouseAt) : null;
        const mouseRateLast2s = VideoPlayer._mouseSamples ? VideoPlayer._mouseSamples.length / 2 : 0;
        const target = VideoPlayer._lastMouseTarget;
        const targetDesc = target
            ? `<${target.tagName.toLowerCase()}${target.id ? '#' + target.id : ''}${target.className && typeof target.className === 'string' ? '.' + target.className.split(' ').join('.') : ''}>`
            : 'none';

        const readyStateNames = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
        const networkStateNames = ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'];

        console.log(
            `[BufferDiag] ${camera}: ${eventName} @ t=${video.currentTime.toFixed(3)} ` +
            `| ready=${readyStateNames[video.readyState] || video.readyState} ` +
            `| net=${networkStateNames[video.networkState] || video.networkState} ` +
            `| paused=${video.paused} ended=${video.ended} seeking=${video.seeking} ` +
            `| isPlaying=${this.isPlaying} ` +
            `| mouseAgo=${msSinceMouse != null ? msSinceMouse.toFixed(0) + 'ms' : 'n/a'} ` +
            `| rate=${mouseRateLast2s.toFixed(1)}/s ` +
            `| over=${targetDesc}`
        );
    }

    /**
     * Handle buffering start for a camera.
     * Internal state updates immediately but the user-facing
     * onBufferingChange callback is debounced by _bufferingUiDelayMs so that
     * brief decode stalls (common under CSS repaint pressure from mouse hover)
     * don't flash the "Buffering" indicator.
     * @param {string} camera
     */
    handleBufferingStart(camera) {
        if (!this.isPlaying) return; // Only track during playback

        this.bufferingState.bufferingCameras.add(camera);
        this.bufferingState.isBuffering = true;

        // Schedule the UI notification if none is pending and we haven't
        // already dispatched for this stall episode.
        if (!this._bufferingStartTimer && !this._bufferingStartDispatched) {
            this._bufferingStartTimer = setTimeout(() => {
                this._bufferingStartTimer = null;
                // Re-check: only dispatch if we're still actually buffering
                if (this.bufferingState.isBuffering && this.onBufferingChange) {
                    this._bufferingStartDispatched = true;
                    this.onBufferingChange({
                        isBuffering: true,
                        cameras: Array.from(this.bufferingState.bufferingCameras),
                        bufferHealth: this.bufferingState.bufferHealth,
                        readSpeed: this.bufferingState.readSpeedEstimate
                    });
                }
            }, this._bufferingUiDelayMs);
        }
    }

    /**
     * Handle buffering end for a camera.
     * Cancels a pending debounced start if the stall resolved before it
     * would have surfaced. Fires the end callback only if start was
     * actually dispatched.
     * @param {string} camera
     */
    handleBufferingEnd(camera) {
        this.bufferingState.bufferingCameras.delete(camera);

        if (this.bufferingState.bufferingCameras.size === 0) {
            this.bufferingState.isBuffering = false;

            // Stall resolved before debounce fired — silently cancel.
            if (this._bufferingStartTimer) {
                clearTimeout(this._bufferingStartTimer);
                this._bufferingStartTimer = null;
            }

            // Only fire end callback if start was actually surfaced.
            if (this._bufferingStartDispatched && this.onBufferingChange) {
                this._bufferingStartDispatched = false;
                this.onBufferingChange({
                    isBuffering: false,
                    cameras: [],
                    bufferHealth: this.bufferingState.bufferHealth,
                    readSpeed: this.bufferingState.readSpeedEstimate
                });
            }
        }
    }

    /**
     * Update buffer health metrics
     * @param {string} camera
     * @param {HTMLVideoElement} video
     */
    updateBufferHealth(camera, video) {
        const now = performance.now();

        // Only update every 500ms to avoid too frequent calculations
        if (now - this.bufferingState.lastBufferCheck < 500) return;
        this.bufferingState.lastBufferCheck = now;

        // Calculate buffer ahead (seconds of video buffered beyond current time)
        let totalBufferAhead = 0;
        let cameraCount = 0;

        for (const [cam, vid] of Object.entries(this.videos)) {
            if (!vid.src || vid.readyState < 1) continue;

            const buffered = vid.buffered;
            const currentTime = vid.currentTime;
            let bufferEnd = currentTime;

            // Find the buffer range that contains current time
            for (let i = 0; i < buffered.length; i++) {
                if (buffered.start(i) <= currentTime && buffered.end(i) > currentTime) {
                    bufferEnd = buffered.end(i);
                    break;
                }
            }

            totalBufferAhead += (bufferEnd - currentTime);
            cameraCount++;
        }

        if (cameraCount > 0) {
            const avgBufferAhead = totalBufferAhead / cameraCount;
            // Buffer health: 100% = 5+ seconds ahead, 0% = 0 seconds ahead
            this.bufferingState.bufferHealth = Math.min(100, Math.round((avgBufferAhead / 5) * 100));

            // Estimate read speed based on playback rate and buffer maintenance
            const playbackRate = this.videos.front.playbackRate || 1;
            // If we can maintain buffer at this rate, read speed is at least playbackRate * bitrate
            // Rough estimate: 1080p Tesla cam is ~4 Mbps per camera, 4 cameras = ~16 Mbps = ~2 MB/s
            const estimatedBitratePerCamera = 2; // MB/s (rough estimate for 1080p)
            this.bufferingState.readSpeedEstimate = avgBufferAhead > 2
                ? estimatedBitratePerCamera * 4 * playbackRate  // Keeping up
                : estimatedBitratePerCamera * 4 * (avgBufferAhead / 2); // Struggling
        }
    }

    /**
     * Get current buffering state
     * @returns {Object}
     */
    getBufferingState() {
        return {
            isBuffering: this.bufferingState.isBuffering,
            cameras: Array.from(this.bufferingState.bufferingCameras),
            bufferHealth: this.bufferingState.bufferHealth,
            readSpeed: this.bufferingState.readSpeedEstimate
        };
    }
}

// Length assumed for a clip whose real length is not known yet (#537)
VideoPlayer.FALLBACK_CLIP_SEC = 60;
// A seek stops this far before a camera's end, so it shows that camera's last
// frame without ending it (less than a frame: Tesla's frames are 19-37 ms apart).
VideoPlayer.END_HOLD_SEC = 0.01;
