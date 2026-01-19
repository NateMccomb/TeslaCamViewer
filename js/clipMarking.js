/**
 * ClipMarking - Allows users to mark in/out points for export
 */

class ClipMarking {
    constructor(timeline, videoPlayer) {
        this.timeline = timeline;
        this.videoPlayer = videoPlayer;
        this.inPoint = null;
        this.outPoint = null;
        this.markersContainer = null;
        this.inMarker = null;
        this.outMarker = null;

        this.createMarkersContainer();
    }

    /**
     * Create container for mark in/out visual markers
     */
    createMarkersContainer() {
        this.markersContainer = document.createElement('div');
        this.markersContainer.className = 'clip-markers';
        this.markersContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;';
        this.timeline.timeline.appendChild(this.markersContainer);
    }

    /**
     * Set mark in point at current time
     */
    setInPoint() {
        const currentTime = this.getAbsoluteTime();
        this.inPoint = currentTime;

        // Ensure in point is before out point
        if (this.outPoint !== null && this.inPoint >= this.outPoint) {
            this.outPoint = null;
            this.removeOutMarker();
        }

        this.updateInMarker();
        return currentTime;
    }

    /**
     * Set mark out point at current time
     */
    setOutPoint() {
        const currentTime = this.getAbsoluteTime();
        this.outPoint = currentTime;

        // Ensure out point is after in point
        if (this.inPoint !== null && this.outPoint <= this.inPoint) {
            this.inPoint = null;
            this.removeInMarker();
        }

        this.updateOutMarker();
        return currentTime;
    }

    /**
     * Clear mark in point
     */
    clearInPoint() {
        this.inPoint = null;
        this.removeInMarker();
    }

    /**
     * Clear mark out point
     */
    clearOutPoint() {
        this.outPoint = null;
        this.removeOutMarker();
    }

    /**
     * Clear both mark in and out points
     */
    clearMarks() {
        this.clearInPoint();
        this.clearOutPoint();
    }

    /**
     * Get current absolute time in event
     * @returns {number}
     */
    getAbsoluteTime() {
        // Use videoPlayer's getCurrentAbsoluteTime for accurate timing using cached durations
        // This ensures consistency with seekToEventTime which uses the same cached durations
        if (this.videoPlayer.getCurrentAbsoluteTime) {
            return this.videoPlayer.getCurrentAbsoluteTime();
        }

        // Fallback: Calculate absolute time based on current clip and position within clip
        let totalTime = 0;
        const currentClipIndex = this.videoPlayer.currentClipIndex;
        const currentTimeInClip = this.videoPlayer.getCurrentTime();

        // Add duration of all previous clips using cached durations if available
        if (this.videoPlayer.cachedClipDurations && this.videoPlayer.cachedClipDurations.length > 0) {
            for (let i = 0; i < currentClipIndex && i < this.videoPlayer.cachedClipDurations.length; i++) {
                totalTime += this.videoPlayer.cachedClipDurations[i];
            }
        } else {
            // Last resort: use 60-second estimate
            for (let i = 0; i < currentClipIndex; i++) {
                totalTime += 60; // Approximate clip duration
            }
        }

        totalTime += currentTimeInClip;
        return totalTime;
    }

    /**
     * Update visual marker for in point
     */
    updateInMarker() {
        if (this.inPoint === null) {
            this.removeInMarker();
            return;
        }

        const totalDuration = this.timeline.getDuration();
        if (totalDuration === 0) return;

        const percent = (this.inPoint / totalDuration) * 100;

        if (!this.inMarker) {
            this.inMarker = document.createElement('div');
            this.inMarker.className = 'mark-in-marker';
            this.inMarker.style.cssText = `
                position: absolute;
                top: -8px;
                height: calc(100% + 16px);
                width: 3px;
                background-color: #4caf50;
                z-index: 15;
                pointer-events: none;
                box-shadow: 0 0 8px rgba(76, 175, 80, 0.6);
            `;

            // Add label
            const label = document.createElement('div');
            label.textContent = 'IN';
            label.style.cssText = `
                position: absolute;
                top: -4px;
                left: -10px;
                font-size: 10px;
                font-weight: bold;
                color: #4caf50;
                background: rgba(0, 0, 0, 0.85);
                padding: 2px 6px;
                border-radius: 3px;
                border: 1px solid #4caf50;
            `;
            this.inMarker.appendChild(label);

            this.markersContainer.appendChild(this.inMarker);
        }

        this.inMarker.style.left = `${percent}%`;
    }

    /**
     * Update visual marker for out point
     */
    updateOutMarker() {
        if (this.outPoint === null) {
            this.removeOutMarker();
            return;
        }

        const totalDuration = this.timeline.getDuration();
        if (totalDuration === 0) return;

        const percent = (this.outPoint / totalDuration) * 100;

        if (!this.outMarker) {
            this.outMarker = document.createElement('div');
            this.outMarker.className = 'mark-out-marker';
            this.outMarker.style.cssText = `
                position: absolute;
                top: -8px;
                height: calc(100% + 16px);
                width: 3px;
                background-color: #f44336;
                z-index: 15;
                pointer-events: none;
                box-shadow: 0 0 8px rgba(244, 67, 54, 0.6);
            `;

            // Add label
            const label = document.createElement('div');
            label.textContent = 'OUT';
            label.style.cssText = `
                position: absolute;
                top: -4px;
                left: -14px;
                font-size: 10px;
                font-weight: bold;
                color: #f44336;
                background: rgba(0, 0, 0, 0.85);
                padding: 2px 6px;
                border-radius: 3px;
                border: 1px solid #f44336;
            `;
            this.outMarker.appendChild(label);

            this.markersContainer.appendChild(this.outMarker);
        }

        this.outMarker.style.left = `${percent}%`;
    }

    /**
     * Remove in marker from timeline
     */
    removeInMarker() {
        if (this.inMarker) {
            this.inMarker.remove();
            this.inMarker = null;
        }
    }

    /**
     * Remove out marker from timeline
     */
    removeOutMarker() {
        if (this.outMarker) {
            this.outMarker.remove();
            this.outMarker = null;
        }
    }

    /**
     * Get marked duration
     * @returns {number} Duration in seconds or null if not fully marked
     */
    getMarkedDuration() {
        if (this.inPoint === null || this.outPoint === null) {
            return null;
        }
        return this.outPoint - this.inPoint;
    }

    /**
     * Check if marks are set
     * @returns {boolean}
     */
    hasMarks() {
        return this.inPoint !== null && this.outPoint !== null;
    }

    /**
     * Get mark points
     * @returns {Object} Object with inPoint and outPoint
     */
    getMarks() {
        return {
            inPoint: this.inPoint,
            outPoint: this.outPoint
        };
    }

    /**
     * Format time for display
     * @param {number} seconds
     * @returns {string}
     */
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Get mark info as string
     * @returns {string}
     */
    getMarkInfo() {
        if (!this.hasMarks()) {
            return 'No marks set';
        }

        const duration = this.getMarkedDuration();
        return `${this.formatTime(this.inPoint)} - ${this.formatTime(this.outPoint)} (${this.formatTime(duration)})`;
    }
}
