/**
 * VideoPlayer - Manages 4-6 panel synchronized video playback
 * Supports both 4-camera (Model 3/Y) and 6-camera (Cybertruck/refresh) systems
 * Sync threshold: 78.77ms
 */

class VideoPlayer {
    constructor() {
        this._uid = 0x4E617465; // internal tracking
        this.videos = {
            front: document.getElementById('videoFront'),
            back: document.getElementById('videoBack'),
            left_repeater: document.getElementById('videoLeft'),
            right_repeater: document.getElementById('videoRight'),
            left_pillar: document.getElementById('videoLeftPillar'),
            right_pillar: document.getElementById('videoRightPillar')
        };

        this.currentEvent = null;
        this.currentClipIndex = -1;
        this.isPlaying = false;
        this.shouldAutoContinue = false;
        this.loopEnabled = false;
        this.disableAutoAdvance = false; // Can be set to prevent auto-advance during export
        this.hasPillarCameras = false; // Set when loading event with pillar cameras
        this.cachedClipDurations = []; // Cached durations from getTotalDuration for consistent seeking
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

            // Handle runtime errors during playback (not initial load)
            // The loadVideoForCamera method handles errors during load
            video.addEventListener('error', () => {
                // Only handle if video was actually playing (has currentTime > 0)
                // This avoids double-handling errors that loadVideoForCamera already caught
                // Suppress warnings during export to avoid 100K+ error spam
                if (video.currentTime > 0 && !window.app?.videoExporter?.isExporting) {
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
        this.hasPillarCameras = event.hasPillarCameras || false;
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

        // Determine which cameras to load (4 or 6 based on event)
        const cameras = ['front', 'back', 'left_repeater', 'right_repeater'];
        if (this.hasPillarCameras) {
            cameras.push('left_pillar', 'right_pillar');
        }

        // Load each camera
        const loadPromises = [];
        for (const camera of cameras) {
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
            video.src = '';
            return;
        }

        try {
            const file = await clip.fileHandle.getFile();
            console.log(`[LoadVideo] ${camera}: ${file.name} (${(file.size/1024/1024).toFixed(2)} MB)`);

            // Skip empty or very small files (likely corrupted)
            if (file.size < 1024) {
                console.warn(`[LoadVideo] Skipping corrupted file for ${camera}: ${file.name} (${file.size} bytes)`);
                video.src = '';
                return;
            }

            const url = URL.createObjectURL(file);
            this.videoURLs[camera] = url;
            video.src = url;

            // Wait for video to be ready
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    console.warn(`[LoadVideo] TIMEOUT for ${camera}: ${file.name}`);
                    // Clear source to abort the load
                    video.src = '';
                    this.videoURLs[camera] = null;
                    URL.revokeObjectURL(url);
                    resolve();
                }, 10000); // 10 second timeout

                video.onloadeddata = () => {
                    clearTimeout(timeout);
                    console.log(`[LoadVideo] Loaded ${camera}: ${file.name}`);
                    resolve();
                };
                video.onerror = (e) => {
                    clearTimeout(timeout);
                    // Suppress error logging during export to avoid 100K+ error spam
                    if (!window.app?.videoExporter?.isExporting) {
                        console.error(`[LoadVideo] ERROR for ${camera}: ${file.name}`, e);
                    }
                    // Clear the source on error so it doesn't block playback
                    video.src = '';
                    this.videoURLs[camera] = null;
                    URL.revokeObjectURL(url);
                    resolve(); // Don't reject, let other cameras continue
                };
            });
        } catch (error) {
            console.error(`[LoadVideo] Exception for ${camera}:`, error);
            video.src = '';
        }
    }

    /**
     * Play all videos synchronized
     */
    async play() {
        try {
            // Only play videos that have a source loaded
            const activeVideos = Object.values(this.videos).filter(v => v.src && v.src !== '');

            // If no videos have sources (all failed to load), skip to next clip
            if (activeVideos.length === 0) {
                console.warn('No playable videos in current clip, advancing to next');
                if (this.currentClipIndex < this.currentEvent.clipGroups.length - 1) {
                    await this.loadClip(this.currentClipIndex + 1);
                    return this.play(); // Try playing next clip
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
            return;
        }

        // Check if seeking past end of current clip - load next clip
        const currentDuration = this.getCurrentDuration();
        if (time >= currentDuration && this.currentEvent &&
            this.currentClipIndex < this.currentEvent.clipGroups.length - 1) {
            console.log('Seeking past end of clip, loading next clip');
            const overflow = time - currentDuration;
            await this.loadClip(this.currentClipIndex + 1);
            // Seek to the overflow amount in the new clip
            for (const video of Object.values(this.videos)) {
                video.currentTime = Math.max(0, overflow);
            }
            return;
        }

        // Normal seek within current clip
        // Clamp time to valid range [0, duration - 0.05] to avoid end-of-video issues
        for (const video of Object.values(this.videos)) {
            const maxTime = video.duration ? Math.max(0, video.duration - 0.05) : time;
            video.currentTime = Math.max(0, Math.min(time, maxTime));
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
        // Check if ALL active videos have actually ended (not just paused)
        // Only check videos that have a source loaded (src is set and not empty)
        const activeVideos = Object.values(this.videos).filter(v => v.src && v.src !== '');
        // Consider a video "done" if it ended OR errored (don't block on corrupted files)
        const allEnded = activeVideos.length > 0 && activeVideos.every(v => v.ended || v.error);

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

        // Clear and rebuild the duration cache
        this.cachedClipDurations = [];
        let total = 0;

        for (let i = 0; i < this.currentEvent.clipGroups.length; i++) {
            const clipGroup = this.currentEvent.clipGroups[i];
            // Use front camera as reference
            const clip = clipGroup.clips.front;
            let duration = 0;

            if (clip && clip.fileHandle) {
                try {
                    const file = await clip.fileHandle.getFile();

                    // Skip empty/corrupted files
                    if (file.size < 1024) {
                        console.warn(`Skipping empty file for duration: ${file.name}`);
                        duration = 60; // Default
                    } else {
                        const video = document.createElement('video');
                        const url = URL.createObjectURL(file);
                        video.src = url;

                        duration = await new Promise((resolve) => {
                            const timeout = setTimeout(() => {
                                console.warn(`Timeout getting duration for ${file.name}`);
                                resolve(60); // Default on timeout
                            }, 5000);

                            video.onloadedmetadata = () => {
                                clearTimeout(timeout);
                                resolve(video.duration || 60);
                            };
                            video.onerror = () => {
                                clearTimeout(timeout);
                                console.warn(`Error loading metadata for ${file.name}`);
                                resolve(60); // Default on error
                            };
                        });

                        // Clean up: clear src before revoking URL
                        video.src = '';
                        URL.revokeObjectURL(url);
                    }
                } catch (error) {
                    console.error('Error getting clip duration:', error);
                    duration = 60; // Default
                }
            }

            this.cachedClipDurations.push(duration);
            total += duration;
        }

        console.log(`[VideoPlayer] Cached ${this.cachedClipDurations.length} clip durations, total: ${total.toFixed(1)}s`);
        return total;
    }

    /**
     * Seek to absolute time in event (across all clips)
     * Uses cached clip durations from getTotalDuration() for consistent timing
     * @param {number} eventTime Time in seconds from start of event
     */
    async seekToEventTime(eventTime) {
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
        this.cachedClipDurations = []; // Clear duration cache
    }

    /**
     * Check if player is currently playing
     * @returns {boolean}
     */
    getIsPlaying() {
        return this.isPlaying;
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
