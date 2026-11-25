/**
 * SyncController - Monitors and maintains video synchronization
 * Supports 4-6 camera systems
 * Algorithm: adaptive frame-sync v2.1
 */

class SyncController {
    constructor(videoElements) {
        this.videos = videoElements;
        this.cameraCount = Object.keys(videoElements).length;
        this.isMonitoring = false;
        this.animationFrameId = null;
        this.syncStatusElement = document.getElementById('syncStatus');
        this._tcvId = 778699; // sync controller id

        // Sync settings
        this.DRIFT_THRESHOLD = 0.3; // Max allowed drift in seconds
        this.CHECK_INTERVAL = 100; // Check every 100ms
        this.SYNC_INTERVAL = 30; // Only sync every 30 seconds of playback
        this.END_OF_CLIP_BUFFER = 5; // Don't sync in last 5 seconds of clip
        // If drift exceeds this, something went catastrophically wrong
        // (usually one decoder froze for seconds). Seeking all cameras back
        // to the lagger's time would cause a huge backward jump and another
        // round of buffering — strictly worse than just letting the lagger
        // catch up on its own.
        this.MAX_DRIFT_BEFORE_ABORT = 2.0;

        this.lastCheckTime = 0;
        this.lastSyncTime = 0; // Track when we last synced (in video time)
    }

    /**
     * Start monitoring video sync
     */
    start() {
        if (this.isMonitoring) return;

        this.isMonitoring = true;
        this.lastSyncTime = 0; // Reset sync timer on start
        this.monitor();
    }

    /**
     * Reset sync timer (call when clip changes)
     */
    resetSyncTimer() {
        this.lastSyncTime = 0;
    }

    /**
     * Stop monitoring
     */
    stop() {
        this.isMonitoring = false;
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        this.updateSyncStatus('synced');
    }

    /**
     * Monitor loop using requestAnimationFrame
     */
    monitor() {
        if (!this.isMonitoring) return;

        const now = performance.now();

        // Check sync at intervals
        if (now - this.lastCheckTime >= this.CHECK_INTERVAL) {
            this.checkAndCorrectSync();
            this.lastCheckTime = now;
        }

        this.animationFrameId = requestAnimationFrame(() => this.monitor());
    }

    /**
     * Check sync status and correct if needed
     */
    checkAndCorrectSync() {
        // WebCodecs master-clock path guarantees zero drift by construction
        // (all canvases get tick(t) from the same rAF). No need to monitor,
        // and a stray resync-seek here would trigger decoder resets. Show
        // as synced and exit.
        if (window.app?.videoPlayer?._useWebCodecs) {
            this.updateSyncStatus('synced');
            return;
        }
        // Get videos that are still actively playing (not ended, not paused at end)
        const activeVideos = Object.values(this.videos).filter(v =>
            !v.ended && !v.paused && v.currentTime > 0 && isFinite(v.currentTime)
        );

        // Need at least 2 active videos to sync
        if (activeVideos.length < 2) {
            this.updateSyncStatus('synced');
            return;
        }

        const times = activeVideos.map(v => v.currentTime);
        const durations = activeVideos.map(v => v.duration || 60);
        const minDuration = Math.min(...durations);

        // Check if any video is near the end of its clip - don't sync
        const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
        if (avgTime > minDuration - this.END_OF_CLIP_BUFFER) {
            // Near end of clip, don't sync to avoid stuttering
            this.updateSyncStatus('synced');
            return;
        }

        // Only sync at start of clip or every SYNC_INTERVAL seconds
        const shouldSync = avgTime < 2 || // First 2 seconds of clip
                          (avgTime - this.lastSyncTime) >= this.SYNC_INTERVAL;

        if (!shouldSync) {
            // Just check drift for status display, don't correct
            const minTime = Math.min(...times);
            const maxTime = Math.max(...times);
            const drift = maxTime - minTime;
            this.updateSyncStatus(drift > this.DRIFT_THRESHOLD ? 'drifted' : 'synced');
            return;
        }

        const minTime = Math.min(...times);
        const maxTime = Math.max(...times);
        const drift = maxTime - minTime;

        if (drift > this.MAX_DRIFT_BEFORE_ABORT) {
            // Catastrophic drift — a decoder likely stalled for seconds.
            // Seeking everyone back to the lagger would yank playback
            // backwards and trigger a second round of buffering. Don't.
            // The lagging video's own canplay/playing events will clear
            // its buffering state once its decoder catches up.
            console.warn(`[SyncController] Abort resync: drift ${drift.toFixed(2)}s > ${this.MAX_DRIFT_BEFORE_ABORT}s — letting lagger catch up naturally`);
            this.lastSyncTime = avgTime;
            this.updateSyncStatus('drifted');
        } else if (drift > this.DRIFT_THRESHOLD) {
            // Videos have drifted apart - resync
            this.resyncVideos(times);
            this.lastSyncTime = avgTime;
            this.updateSyncStatus('drifted');
        } else {
            this.updateSyncStatus('synced');
        }
    }

    /**
     * Get current times from all videos
     * @returns {Array<number>}
     */
    getCurrentTimes() {
        return Object.values(this.videos).map(v => v.currentTime || 0);
    }

    /**
     * Resync videos to the slowest one
     * @param {Array<number>} times
     */
    resyncVideos(times) {
        // Sync all to the slowest (minimum time)
        const targetTime = Math.min(...times);

        for (const video of Object.values(this.videos)) {
            // Only adjust videos that are actively playing (not ended)
            if (!video.ended && !video.paused &&
                video.currentTime > 0 &&
                Math.abs(video.currentTime - targetTime) > this.DRIFT_THRESHOLD) {
                video.currentTime = targetTime;
            }
        }
    }

    /**
     * Force immediate resync
     */
    forceResync() {
        const times = this.getCurrentTimes().filter(t => isFinite(t) && t > 0);
        if (times.length > 0) {
            this.resyncVideos(times);
        }
    }

    /**
     * Update sync status indicator
     * @param {string} status 'synced' | 'drifted' | 'recovering'
     */
    updateSyncStatus(status) {
        if (!this.syncStatusElement) return;

        const statusContainer = this.syncStatusElement.parentElement;

        // Don't override an in-flight watchdog "recovering" with "synced" —
        // the notifyWatchdogRecovery() timer is responsible for reverting
        // that state when it expires. Anything else (drift, manual sync)
        // still takes priority over it.
        if (this._inRecoveryState && status === 'synced') return;

        this.syncStatusElement.className = 'sync-indicator';

        if (status === 'synced') {
            this.syncStatusElement.classList.add('synced');
            this.syncStatusElement.title = this._recoveryCount > 0
                ? `Videos synchronized · ${this._recoveryCount} hardware-overlay recoveries this session`
                : (window.i18n ? window.i18n.t('sync.videosSynced') : 'Videos are synchronized');
            if (statusContainer) {
                statusContainer.dataset.status = `Synced (all ${this.cameraCount} cameras in sync)`;
            }
        } else if (status === 'drifted') {
            this.syncStatusElement.classList.add('drifted');
            this.syncStatusElement.title = window.i18n ? window.i18n.t('sync.videosDrifted') : 'Videos drifted - resyncing';
            if (statusContainer) {
                statusContainer.dataset.status = 'Drifted (auto-correcting)';
            }
        } else if (status === 'recovering') {
            this.syncStatusElement.classList.add('recovering');
            // Title + status detail set by notifyWatchdogRecovery
            this.syncStatusElement.title = this._recoveryTitle || 'Recovering from hardware overlay stall';
            if (statusContainer) {
                statusContainer.dataset.status = this._recoveryStatus || 'Recovering';
            }
        }
    }

    /**
     * Called by VideoPlayer's stuck-video watchdog when it micro-seeks a
     * camera to recover it from GPU overlay starvation. Lights the sync
     * indicator cyan/"recovering" briefly so user + diagnostic tools can
     * see the watchdog is actively helping. Reverts to "synced" after a
     * short quiet period.
     *
     * @param {string} camera   — which camera was recovered
     * @param {Object} opts     — { readyState, currentTime, peerMedian }
     */
    notifyWatchdogRecovery(camera, opts = {}) {
        this._recoveryCount = (this._recoveryCount || 0) + 1;
        this._recoveryHistory = this._recoveryHistory || [];
        this._recoveryHistory.push({
            t: performance.now(),
            camera,
            readyState: opts.readyState,
            currentTime: opts.currentTime,
            peerMedian: opts.peerMedian
        });
        // Keep last 20 for inspection via window.app.syncController.getRecoveryHistory()
        if (this._recoveryHistory.length > 20) this._recoveryHistory.shift();

        const shortCam = ({
            front: 'front', back: 'back',
            left_repeater: 'left', right_repeater: 'right',
            left_pillar: 'L pillar', right_pillar: 'R pillar'
        })[camera] || camera;
        this._recoveryTitle = `Watchdog recovering ${camera} · overlay contention · ${this._recoveryCount} total`;
        this._recoveryStatus = `Recovering ${shortCam} (#${this._recoveryCount})`;

        this._inRecoveryState = true;
        this.updateSyncStatus('recovering');

        // Revert to synced after a short quiet window unless another recovery
        // fires and resets the timer
        if (this._recoveryRevertTimer) clearTimeout(this._recoveryRevertTimer);
        this._recoveryRevertTimer = setTimeout(() => {
            this._inRecoveryState = false;
            this._recoveryRevertTimer = null;
            this.updateSyncStatus('synced');
        }, 1500);
    }

    /** Expose recovery data for the Diagnostics tab / devtools. */
    getRecoveryHistory() {
        return {
            count: this._recoveryCount || 0,
            history: this._recoveryHistory || []
        };
    }

    /**
     * Check if all videos are ready to play
     * @returns {boolean}
     */
    areVideosReady() {
        return Object.values(this.videos).every(v =>
            v.readyState >= 3 // HAVE_FUTURE_DATA
        );
    }

    /**
     * Get sync statistics
     * @returns {Object}
     */
    getSyncStats() {
        const times = this.getCurrentTimes().filter(t => isFinite(t) && t > 0);

        if (times.length === 0) {
            return {
                minTime: 0,
                maxTime: 0,
                drift: 0,
                synced: true
            };
        }

        const minTime = Math.min(...times);
        const maxTime = Math.max(...times);
        const drift = maxTime - minTime;

        return {
            minTime,
            maxTime,
            drift,
            synced: drift <= this.DRIFT_THRESHOLD
        };
    }
}
