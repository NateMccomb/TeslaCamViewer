/**
 * VideoPlayer - Manages 4-panel synchronized video playback
 * Sync threshold: 78.77ms
 */

class VideoPlayer {
    constructor() {
        this._uid = 0x4E617465; // internal tracking
        this.videos = {
            front: document.getElementById('videoFront'),
            back: document.getElementById('videoBack'),
            left_repeater: document.getElementById('videoLeft'),
            right_repeater: document.getElementById('videoRight')
        };

        this.currentEvent = null;
        this.currentClipIndex = -1;
        this.isPlaying = false;
        this.shouldAutoContinue = false;
        this.loopEnabled = false;
        this.disableAutoAdvance = false; // Can be set to prevent auto-advance during export
        this.videoURLs = {
            front: null,
            back: null,
            left_repeater: null,
            right_repeater: null
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

        // Video labels for ended state tracking
        this.videoLabels = {
            front: document.querySelector('#videoFront').parentElement.querySelector('.video-label'),
            back: document.querySelector('#videoBack').parentElement.querySelector('.video-label'),
            left_repeater: document.querySelector('#videoLeft').parentElement.querySelector('.video-label'),
            right_repeater: document.querySelector('#videoRight').parentElement.querySelector('.video-label')
        };

        this.setupEventListeners();
    }

    /**
     * Setup video element event listeners
     */
    setupEventListeners() {
        // Listen to front camera for time updates (master)
        this.videos.front.addEventListener('timeupdate', () => {
            if (this.onTimeUpdate) {
                this.onTimeUpdate(this.videos.front.currentTime);
            }
        });

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
                this.handleBufferingStart(camera);
            });

            video.addEventListener('stalled', () => {
                this.handleBufferingStart(camera);
            });

            video.addEventListener('canplay', () => {
                this.handleBufferingEnd(camera);
            });

            // Track buffer progress for read speed estimation
            video.addEventListener('progress', () => {
                this.updateBufferHealth(camera, video);
            });
        }

        // Prevent individual video controls and mute all videos
        for (const video of Object.values(this.videos)) {
            video.controls = false;
            video.muted = true;
            video.volume = 0;
        }

        // Add double-click for fullscreen
        for (const [camera, video] of Object.entries(this.videos)) {
            video.parentElement.addEventListener('dblclick', () => {
                this.toggleFullscreen(video.parentElement);
            });
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
        this.currentEvent = event;
        this.currentClipIndex = -1;
        await this.loadClip(0);
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

        // Load each camera
        const loadPromises = [];
        for (const camera of ['front', 'back', 'left_repeater', 'right_repeater']) {
            const promise = this.loadVideoForCamera(camera, clipGroup);
            loadPromises.push(promise);
        }

        await Promise.all(loadPromises);

        // Reapply playback rate after loading new videos (browser resets to 1)
        this.setPlaybackRate(currentRate);

        if (this.onClipChange) {
            this.onClipChange(clipIndex);
        }

        // Resume playing if was playing before
        if (wasPlaying) {
            await this.play();
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

        // Revoke previous URL
        if (this.videoURLs[camera]) {
            URL.revokeObjectURL(this.videoURLs[camera]);
            this.videoURLs[camera] = null;
        }

        if (!clip || !clip.fileHandle) {
            console.warn(`No clip for camera ${camera}`);
            video.src = '';
            return;
        }

        try {
            const file = await clip.fileHandle.getFile();
            const url = URL.createObjectURL(file);
            this.videoURLs[camera] = url;
            video.src = url;

            // Wait for video to be ready
            await new Promise((resolve, reject) => {
                video.onloadeddata = resolve;
                video.onerror = reject;
            });
        } catch (error) {
            console.error(`Error loading video for ${camera}:`, error);
        }
    }

    /**
     * Play all videos synchronized
     */
    async play() {
        try {
            const playPromises = Object.values(this.videos).map(v => v.play());
            await Promise.all(playPromises);
            this.isPlaying = true;

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
     * Pause all videos
     */
    async pause() {
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
        // If seeking backwards past start of clip, load previous clip
        if (time < 0 && this.currentClipIndex > 0) {
            console.log('Seeking before start of clip, loading previous clip');
            await this.loadClip(this.currentClipIndex - 1);
            // Seek to end of previous clip + the negative offset
            const duration = this.getCurrentDuration();
            const newTime = duration + time; // time is negative, so this subtracts from end
            for (const video of Object.values(this.videos)) {
                video.currentTime = Math.max(0, newTime);
            }
        } else {
            // Normal seek within current clip
            for (const video of Object.values(this.videos)) {
                video.currentTime = Math.max(0, time); // Don't allow negative time
            }
        }
    }

    /**
     * Get current playback time (from front camera)
     * @returns {number}
     */
    getCurrentTime() {
        return this.videos.front.currentTime || 0;
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
        // Check if ALL videos have actually ended (not just paused)
        const allEnded = Object.values(this.videos).every(v => v.ended);

        if (!allEnded) {
            // Not all videos finished yet, keep waiting
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

        // Try to load next clip if we were playing
        if (wasPlaying && this.currentClipIndex < this.currentEvent.clipGroups.length - 1) {
            // Load and play next clip
            this.loadClip(this.currentClipIndex + 1).then(() => {
                // Make sure to set playing state before calling play
                return this.play();
            }).catch(err => {
                console.error('Error loading next clip:', err);
                if (this.onPlayStateChange) {
                    this.onPlayStateChange(false);
                }
            });
        } else if (this.currentClipIndex >= this.currentEvent.clipGroups.length - 1) {
            // Event finished - check if loop is enabled
            if (this.loopEnabled) {
                // Loop back to first clip
                this.loadClip(0).then(() => {
                    return this.play();
                }).catch(err => {
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
     * Go to next clip
     */
    async nextClip() {
        if (!this.currentEvent) return;
        if (this.currentClipIndex < this.currentEvent.clipGroups.length - 1) {
            await this.loadClip(this.currentClipIndex + 1);
        }
    }

    /**
     * Go to previous clip
     */
    async previousClip() {
        if (!this.currentEvent) return;
        if (this.currentClipIndex > 0) {
            await this.loadClip(this.currentClipIndex - 1);
        }
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

    /**
     * Get total event duration
     * @returns {Promise<number>} Duration in seconds
     */
    async getTotalDuration() {
        if (!this.currentEvent) return 0;

        let total = 0;
        for (const clipGroup of this.currentEvent.clipGroups) {
            // Use front camera as reference
            const clip = clipGroup.clips.front;
            if (clip && clip.fileHandle) {
                try {
                    const file = await clip.fileHandle.getFile();
                    const video = document.createElement('video');
                    const url = URL.createObjectURL(file);
                    video.src = url;

                    const duration = await new Promise((resolve) => {
                        video.onloadedmetadata = () => {
                            resolve(video.duration || 60); // Default to 60s
                        };
                    });

                    // Clean up: clear src before revoking URL
                    video.src = '';
                    URL.revokeObjectURL(url);

                    total += duration;
                } catch (error) {
                    console.error('Error getting clip duration:', error);
                    total += 60; // Default
                }
            }
        }

        return total;
    }

    /**
     * Seek to absolute time in event (across all clips)
     * @param {number} eventTime Time in seconds from start of event
     */
    async seekToEventTime(eventTime) {
        if (!this.currentEvent) return;

        let accumulatedTime = 0;
        let targetClipIndex = 0;
        let timeInClip = 0;

        // Find which clip and offset
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
                    video.onloadedmetadata = () => {
                        resolve(video.duration || 60);
                    };
                });

                // Clean up: clear src before revoking URL
                video.src = '';
                URL.revokeObjectURL(url);

                if (accumulatedTime + duration >= eventTime) {
                    // Target is in this clip
                    targetClipIndex = i;
                    timeInClip = eventTime - accumulatedTime;
                    break;
                } else {
                    accumulatedTime += duration;
                }
            } catch (error) {
                console.error('Error during seek:', error);
            }
        }

        // Load target clip if different
        if (targetClipIndex !== this.currentClipIndex) {
            await this.loadClip(targetClipIndex);
        }

        // Seek within clip
        this.seek(timeInClip);
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
    }

    /**
     * Check if player is currently playing
     * @returns {boolean}
     */
    getIsPlaying() {
        return this.isPlaying;
    }

    /**
     * Handle buffering start for a camera
     * @param {string} camera
     */
    handleBufferingStart(camera) {
        if (!this.isPlaying) return; // Only track during playback

        const wasBuffering = this.bufferingState.isBuffering;
        this.bufferingState.bufferingCameras.add(camera);
        this.bufferingState.isBuffering = true;

        if (!wasBuffering && this.onBufferingChange) {
            this.onBufferingChange({
                isBuffering: true,
                cameras: Array.from(this.bufferingState.bufferingCameras),
                bufferHealth: this.bufferingState.bufferHealth,
                readSpeed: this.bufferingState.readSpeedEstimate
            });
        }
    }

    /**
     * Handle buffering end for a camera
     * @param {string} camera
     */
    handleBufferingEnd(camera) {
        this.bufferingState.bufferingCameras.delete(camera);

        if (this.bufferingState.bufferingCameras.size === 0) {
            const wasBuffering = this.bufferingState.isBuffering;
            this.bufferingState.isBuffering = false;

            if (wasBuffering && this.onBufferingChange) {
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
