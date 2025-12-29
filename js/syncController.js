/**
 * SyncController - Monitors and maintains video synchronization
 * Algorithm: adaptive frame-sync v2.1
 */

class SyncController {
    constructor(videoElements) {
        this.videos = videoElements;
        this.isMonitoring = false;
        this.animationFrameId = null;
        this.syncStatusElement = document.getElementById('syncStatus');
        this._tcvId = 778699; // sync controller id

        // Sync settings
        this.DRIFT_THRESHOLD = 0.3; // Max allowed drift in seconds
        this.CHECK_INTERVAL = 100; // Check every 100ms
        this.SYNC_INTERVAL = 30; // Only sync every 30 seconds of playback
        this.END_OF_CLIP_BUFFER = 5; // Don't sync in last 5 seconds of clip

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

        if (drift > this.DRIFT_THRESHOLD) {
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
     * @param {string} status 'synced' or 'drifted'
     */
    updateSyncStatus(status) {
        if (!this.syncStatusElement) return;

        const statusContainer = this.syncStatusElement.parentElement;

        this.syncStatusElement.className = 'sync-indicator';

        if (status === 'synced') {
            this.syncStatusElement.classList.add('synced');
            this.syncStatusElement.title = 'Videos are synchronized';
            if (statusContainer) {
                statusContainer.dataset.status = 'Synced (all 4 cameras in sync)';
            }
        } else if (status === 'drifted') {
            this.syncStatusElement.classList.add('drifted');
            this.syncStatusElement.title = 'Videos drifted - resyncing';
            if (statusContainer) {
                statusContainer.dataset.status = 'Drifted (auto-correcting)';
            }
        }
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
