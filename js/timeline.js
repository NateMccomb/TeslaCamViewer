/**
 * Timeline - Handles timeline scrubbing and progress display
 * Resolution: 1920x1080 @ 36fps max
 */

class Timeline {
    constructor(timelineElement, onSeek, onBookmarkChange = null) {
        this.timeline = timelineElement;
        this._mcRef = 'teslacamviewer.com';
        this.progress = document.getElementById('timelineProgress');
        this.scrubber = document.getElementById('timelineScrubber');
        this.clipsContainer = document.getElementById('timelineClips');
        this.currentTimeDisplay = document.getElementById('currentTime');
        this.totalDurationDisplay = document.getElementById('totalDuration');

        // Mini-map elements
        this.minimap = document.getElementById('timelineMinimap');
        this.minimapProgress = document.getElementById('minimapProgress');
        this.minimapViewport = document.getElementById('minimapViewport');
        this.minimapPosition = document.getElementById('minimapPosition');
        this.minimapMarkers = document.getElementById('minimapMarkers');
        this.isMinimapDragging = false;
        this.minimapDragOffset = 0;

        this.onSeek = onSeek;
        this.onBookmarkChange = onBookmarkChange;
        this.totalDuration = 0;
        this.duration = 0; // Alias for totalDuration
        this.currentTime = 0;
        this.isDragging = false;

        // Zoom state
        this.zoomLevel = 1; // 1 = 100% (full view), 2 = 200% zoom, etc.
        this.maxZoom = 10;
        this.minZoom = 1;
        this.viewStart = 0; // Start time of visible window
        this.targetViewStart = 0; // Target for smooth scrolling
        this.zoomEnabled = false; // Controlled by settings
        this.scrollAnimationId = null; // For smooth scroll animation

        // Bookmarks
        this.bookmarks = [];
        this.currentEventId = null; // Track which event's bookmarks we're managing
        this.BOOKMARKS_STORAGE_KEY = 'teslacamviewer_bookmarks';
        this.bookmarkJumpTime = 0; // Timestamp of last bookmark jump (for ignoring timeupdate temporarily)
        this.lastJumpedBookmarkId = null; // Track the bookmark we just jumped to

        // Event lookup for backup
        this.eventLookup = new Map(); // eventKey -> event object with folderHandle
        this.getNotesForEvent = null; // Function to get notes for an event

        // Gap markers
        this.gaps = [];

        this.setupEventListeners();
        this.setupMinimapEventListeners();
    }

    /**
     * Register an event for backup purposes
     * @param {Object} event - Event object with folderHandle
     */
    registerEvent(event) {
        if (!event) return;
        const key = event.compoundKey || event.name;
        if (key && event.folderHandle) {
            this.eventLookup.set(key, event);
        }
    }

    /**
     * Register multiple events
     * @param {Array} events - Array of event objects
     */
    registerEvents(events) {
        if (!events) return;
        for (const event of events) {
            this.registerEvent(event);
        }
    }

    /**
     * Set function to get notes for an event
     * @param {Function} fn - Function that takes eventKey and returns notes object
     */
    setNotesGetter(fn) {
        this.getNotesForEvent = fn;
    }

    /**
     * Set the current event for bookmark management
     * @param {string} eventId Unique identifier for the event (e.g., event name)
     */
    setCurrentEvent(eventId) {
        // Save current bookmarks before switching
        if (this.currentEventId && this.bookmarks.length > 0) {
            this.saveBookmarks();
        }

        this.currentEventId = eventId;

        // Load bookmarks for the new event
        this.loadBookmarks();
        this.renderBookmarks();
    }

    /**
     * Save bookmarks to localStorage
     */
    saveBookmarks() {
        if (!this.currentEventId) return;

        try {
            const allBookmarks = this.getAllSavedBookmarks();
            allBookmarks[this.currentEventId] = this.bookmarks;
            localStorage.setItem(this.BOOKMARKS_STORAGE_KEY, JSON.stringify(allBookmarks));

            // Backup to event folder if available
            this.backupToEventFolder(this.currentEventId, this.bookmarks);

            // Notify callback of bookmark change
            if (this.onBookmarkChange) {
                this.onBookmarkChange(this.currentEventId, this.bookmarks);
            }
        } catch (e) {
            console.warn('Failed to save bookmarks:', e);
        }
    }

    /**
     * Backup bookmarks and notes to the event folder
     * @param {string} eventId - Event identifier
     * @param {Array} bookmarks - Bookmarks array
     */
    async backupToEventFolder(eventId, bookmarks) {
        // Get the event object with folderHandle
        const event = this.eventLookup.get(eventId);
        if (!event) {
            console.log('[Timeline] No event registered for backup:', eventId);
            return;
        }

        // Get notes if getter is available
        let notes = { text: '', tags: [] };
        if (this.getNotesForEvent) {
            try {
                notes = this.getNotesForEvent(eventId) || { text: '', tags: [] };
            } catch (e) {
                console.warn('[Timeline] Failed to get notes for backup:', e);
            }
        }

        // Use the backup module
        if (window.eventDataBackup) {
            const backupData = {
                notes: notes,
                bookmarks: bookmarks
            };

            try {
                await window.eventDataBackup.saveToEventFolder(event, backupData);
                console.log('[Timeline] Backup queued for:', eventId);
            } catch (e) {
                console.warn('[Timeline] Failed to backup to event folder:', e);
            }
        }
    }

    /**
     * Load bookmarks from localStorage
     */
    loadBookmarks() {
        if (!this.currentEventId) {
            this.bookmarks = [];
            return;
        }

        try {
            const allBookmarks = this.getAllSavedBookmarks();
            this.bookmarks = allBookmarks[this.currentEventId] || [];
        } catch (e) {
            console.warn('Failed to load bookmarks:', e);
            this.bookmarks = [];
        }
    }

    /**
     * Get all saved bookmarks from localStorage
     * @returns {Object}
     */
    getAllSavedBookmarks() {
        try {
            const stored = localStorage.getItem(this.BOOKMARKS_STORAGE_KEY);
            return stored ? JSON.parse(stored) : {};
        } catch (e) {
            return {};
        }
    }

    /**
     * Setup timeline event listeners
     */
    setupEventListeners() {
        // Click on timeline to seek
        this.timeline.addEventListener('click', (e) => {
            if (!this.isDragging) {
                this.handleTimelineClick(e);
            }
        });

        // Drag scrubber
        this.timeline.addEventListener('mousedown', (e) => {
            this.startDragging(e);
        });

        document.addEventListener('mousemove', (e) => {
            if (this.isDragging) {
                this.handleDrag(e);
            }
        });

        document.addEventListener('mouseup', () => {
            if (this.isDragging) {
                this.stopDragging();
            }
        });

        // Touch events for mobile
        this.timeline.addEventListener('touchstart', (e) => {
            this.startDragging(e.touches[0]);
        });

        document.addEventListener('touchmove', (e) => {
            if (this.isDragging) {
                e.preventDefault();
                this.handleDrag(e.touches[0]);
            }
        }, { passive: false });

        document.addEventListener('touchend', () => {
            if (this.isDragging) {
                this.stopDragging();
            }
        });

        // Zoom with scroll wheel (also works for touchpad pinch on some systems)
        this.timeline.addEventListener('wheel', (e) => {
            if (!this.zoomEnabled) return;

            e.preventDefault();

            // Get mouse position relative to timeline
            const rect = this.timeline.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mousePercent = mouseX / rect.width;

            // Calculate the time under the mouse
            const viewDuration = this.totalDuration / this.zoomLevel;
            const timeUnderMouse = this.viewStart + (mousePercent * viewDuration);

            // Detect pinch gesture (ctrlKey is set for pinch-to-zoom on touchpads)
            // Also handle regular scroll wheel
            let zoomDelta;
            if (e.ctrlKey) {
                // Pinch gesture - use deltaY directly but scaled
                zoomDelta = -e.deltaY * 0.01;
            } else {
                // Regular scroll wheel
                zoomDelta = e.deltaY > 0 ? -0.5 : 0.5;
            }

            const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoomLevel + zoomDelta));

            if (Math.abs(newZoom - this.zoomLevel) > 0.01) {
                this.zoomLevel = newZoom;

                // Adjust viewStart to keep time under mouse in same position
                const newViewDuration = this.totalDuration / this.zoomLevel;
                this.viewStart = Math.max(0, Math.min(
                    this.totalDuration - newViewDuration,
                    timeUnderMouse - (mousePercent * newViewDuration)
                ));

                this.updateZoomDisplay();
            }
        }, { passive: false });

        // Touch pinch zoom support
        let initialPinchDistance = null;
        let initialZoom = 1;

        this.timeline.addEventListener('touchstart', (e) => {
            if (!this.zoomEnabled) return;
            if (e.touches.length === 2) {
                initialPinchDistance = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                initialZoom = this.zoomLevel;
            }
        });

        this.timeline.addEventListener('touchmove', (e) => {
            if (!this.zoomEnabled) return;
            if (e.touches.length === 2 && initialPinchDistance) {
                e.preventDefault();
                const currentDistance = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                const scale = currentDistance / initialPinchDistance;
                const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, initialZoom * scale));

                if (Math.abs(newZoom - this.zoomLevel) > 0.01) {
                    this.zoomLevel = newZoom;
                    this.updateZoomDisplay();
                }
            }
        }, { passive: false });

        this.timeline.addEventListener('touchend', () => {
            initialPinchDistance = null;
        });
    }

    /**
     * Setup mini-map event listeners
     */
    setupMinimapEventListeners() {
        if (!this.minimap) return;

        // Click on mini-map to navigate
        this.minimap.addEventListener('click', (e) => {
            if (this.isMinimapDragging) return;
            this.handleMinimapClick(e);
        });

        // Drag viewport on mini-map
        this.minimapViewport.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            this.startMinimapDrag(e);
        });

        document.addEventListener('mousemove', (e) => {
            if (this.isMinimapDragging) {
                this.handleMinimapDrag(e);
            }
        });

        document.addEventListener('mouseup', () => {
            if (this.isMinimapDragging) {
                this.stopMinimapDrag();
            }
        });

        // Touch support for mini-map
        this.minimapViewport.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            this.startMinimapDrag(e.touches[0]);
        });

        document.addEventListener('touchmove', (e) => {
            if (this.isMinimapDragging) {
                this.handleMinimapDrag(e.touches[0]);
            }
        });

        document.addEventListener('touchend', () => {
            if (this.isMinimapDragging) {
                this.stopMinimapDrag();
            }
        });
    }

    /**
     * Handle click on mini-map to seek
     * @param {MouseEvent} e
     */
    handleMinimapClick(e) {
        const rect = this.minimap.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const percent = clickX / rect.width;
        const time = percent * this.totalDuration;

        // Center the viewport on click position
        const viewDuration = this.totalDuration / this.zoomLevel;
        this.viewStart = Math.max(0, Math.min(
            this.totalDuration - viewDuration,
            time - viewDuration / 2
        ));

        this.updateZoomDisplay();

        if (this.onSeek) {
            this.onSeek(time);
        }
    }

    /**
     * Start dragging the mini-map viewport
     * @param {MouseEvent|Touch} e
     */
    startMinimapDrag(e) {
        this.isMinimapDragging = true;
        this.minimapViewport.classList.add('dragging');

        // Calculate offset from left edge of viewport
        const rect = this.minimapViewport.getBoundingClientRect();
        this.minimapDragOffset = e.clientX - rect.left;
    }

    /**
     * Handle mini-map viewport drag
     * @param {MouseEvent|Touch} e
     */
    handleMinimapDrag(e) {
        const minimapRect = this.minimap.getBoundingClientRect();
        const viewportWidth = this.minimapViewport.offsetWidth;

        // Calculate new left position
        let newLeft = e.clientX - minimapRect.left - this.minimapDragOffset;
        newLeft = Math.max(0, Math.min(minimapRect.width - viewportWidth, newLeft));

        // Convert to time
        const percent = newLeft / minimapRect.width;
        const viewDuration = this.totalDuration / this.zoomLevel;
        this.viewStart = percent * this.totalDuration;

        // Clamp viewStart
        this.viewStart = Math.max(0, Math.min(this.totalDuration - viewDuration, this.viewStart));

        this.updateZoomDisplay();
    }

    /**
     * Stop mini-map viewport drag
     */
    stopMinimapDrag() {
        this.isMinimapDragging = false;
        this.minimapViewport.classList.remove('dragging');
    }

    /**
     * Update mini-map display
     */
    updateMinimap() {
        if (!this.minimap) return;

        // Show mini-map always (not just when zoomed)
        this.minimap.classList.remove('hidden');

        // Update progress indicator (smooth via CSS transition)
        const progressPercent = this.totalDuration > 0 ? (this.currentTime / this.totalDuration) * 100 : 0;
        this.minimapProgress.style.width = `${progressPercent}%`;

        // Update position indicator (smooth via CSS transition)
        this.minimapPosition.style.left = `${progressPercent}%`;

        // Update viewport position and size (only relevant when zoomed)
        if (this.zoomLevel > 1) {
            const viewDuration = this.totalDuration / this.zoomLevel;
            const viewportWidth = (viewDuration / this.totalDuration) * 100;
            const viewportLeft = (this.viewStart / this.totalDuration) * 100;

            this.minimapViewport.style.width = `${viewportWidth}%`;
            this.minimapViewport.style.left = `${viewportLeft}%`;
            this.minimapViewport.style.display = 'block';
        } else {
            // When not zoomed, center viewport on current position for visual consistency
            const viewportWidth = 100;
            this.minimapViewport.style.width = `${viewportWidth}%`;
            this.minimapViewport.style.left = '0%';
            this.minimapViewport.style.display = 'none';
        }
    }

    /**
     * Smoothly center the view on a specific time
     * @param {number} time - Time in seconds to center on
     */
    centerViewOn(time) {
        if (this.zoomLevel <= 1) return;

        const viewDuration = this.totalDuration / this.zoomLevel;
        this.targetViewStart = Math.max(0, Math.min(
            this.totalDuration - viewDuration,
            time - viewDuration / 2
        ));
        this.startSmoothScroll();
    }

    /**
     * Render markers to the minimap
     */
    renderMinimapMarkers() {
        if (!this.minimapMarkers || this.totalDuration <= 0) return;

        // Clear existing minimap markers
        this.minimapMarkers.innerHTML = '';

        // Add clip markers
        if (this._lastClipGroups && this._lastClipGroups.length > 0) {
            const cachedDurations = window.app?.videoPlayer?.cachedClipDurations || [];
            let accumulatedTime = 0;
            for (let i = 0; i < this._lastClipGroups.length; i++) {
                if (i > 0) {
                    const percent = (accumulatedTime / this.totalDuration) * 100;
                    const marker = document.createElement('div');
                    marker.className = 'minimap-clip-marker';
                    marker.style.left = `${percent}%`;
                    this.minimapMarkers.appendChild(marker);
                }
                // Use cached duration if available, otherwise fallback to 60s
                accumulatedTime += cachedDurations[i] || 60;
            }
        }

        // Add sentry marker
        if (this._sentryTriggerTime && this._sentryTriggerTime > 0) {
            const percent = (this._sentryTriggerTime / this.totalDuration) * 100;
            const marker = document.createElement('div');
            marker.className = 'minimap-sentry-marker';
            marker.style.left = `${percent}%`;
            this.minimapMarkers.appendChild(marker);
        }

        // Add bookmark markers
        for (const bookmark of this.bookmarks) {
            const percent = (bookmark.time / this.totalDuration) * 100;
            const marker = document.createElement('div');
            marker.className = 'minimap-bookmark-marker';
            marker.style.left = `${percent}%`;
            marker.title = bookmark.label;
            this.minimapMarkers.appendChild(marker);
        }

        // Add near-miss markers (score >= 5 only)
        if (this._nearMisses && this._nearMisses.length > 0) {
            const flaggedNearMisses = this._nearMisses.filter(nm => nm.score >= 5);
            for (const nearMiss of flaggedNearMisses) {
                const percent = (nearMiss.time / this.totalDuration) * 100;
                const marker = document.createElement('div');
                marker.className = `minimap-near-miss-marker severity-${nearMiss.severity}`;
                marker.style.left = `${percent}%`;
                marker.title = `Near-Miss: Score ${nearMiss.score.toFixed(1)}`;
                this.minimapMarkers.appendChild(marker);
            }
        }
    }

    /**
     * Enable or disable zoom feature
     * @param {boolean} enabled
     */
    setZoomEnabled(enabled) {
        this.zoomEnabled = enabled;
        if (!enabled) {
            this.resetZoom();
        }
    }

    /**
     * Reset zoom to default
     */
    resetZoom() {
        this.zoomLevel = 1;
        this.viewStart = 0;
        this.targetViewStart = 0;
        this.stopSmoothScroll();

        // Clear any transforms
        this.clipsContainer.style.transform = '';
        this.clipsContainer.style.transformOrigin = '';

        // Remove zoom indicator
        const indicator = this.timeline.querySelector('.zoom-indicator');
        if (indicator) indicator.remove();

        this.updateZoomDisplay();
    }

    /**
     * Zoom in on timeline (increase zoom level)
     */
    zoomIn() {
        const newZoom = Math.min(this.maxZoom, this.zoomLevel + 0.5);
        if (newZoom !== this.zoomLevel) {
            // Keep current time centered
            const viewDuration = this.totalDuration / this.zoomLevel;
            const centerTime = this.viewStart + viewDuration / 2;

            this.zoomLevel = newZoom;

            // Recalculate viewStart to keep center
            const newViewDuration = this.totalDuration / this.zoomLevel;
            this.viewStart = Math.max(0, Math.min(
                this.totalDuration - newViewDuration,
                centerTime - newViewDuration / 2
            ));

            this.updateZoomDisplay();
            console.log(`Zoom level: ${this.zoomLevel.toFixed(1)}x`);
        }
    }

    /**
     * Zoom out on timeline (decrease zoom level)
     */
    zoomOut() {
        const newZoom = Math.max(this.minZoom, this.zoomLevel - 0.5);
        if (newZoom !== this.zoomLevel) {
            // Keep current time centered
            const viewDuration = this.totalDuration / this.zoomLevel;
            const centerTime = this.viewStart + viewDuration / 2;

            this.zoomLevel = newZoom;

            // Recalculate viewStart to keep center
            const newViewDuration = this.totalDuration / this.zoomLevel;
            this.viewStart = Math.max(0, Math.min(
                this.totalDuration - newViewDuration,
                centerTime - newViewDuration / 2
            ));

            this.updateZoomDisplay();
            console.log(`Zoom level: ${this.zoomLevel.toFixed(1)}x`);
        }
    }

    /**
     * Update the visual display after zoom change
     */
    updateZoomDisplay() {
        // Clear any CSS transforms - we use mathematical positioning now
        this.clipsContainer.style.transform = '';

        // Re-render markers at correct positions for zoom level
        this.renderBookmarks();
        this.rerenderClipMarkers();

        // Update current position display relative to zoomed view
        this.updateTime(this.currentTime);

        // Update or create zoom indicator
        this.updateZoomIndicator();

        // Update mini-map
        this.updateMinimap();

        // Emit zoom change event for UI updates
        if (this.onZoomChange) {
            this.onZoomChange(this.zoomLevel, this.viewStart);
        }
    }

    /**
     * Calculate position percent for zoom level
     * @param {number} time - absolute time in seconds
     * @returns {number} - percent position (0-100) in visible window, or -1 if outside
     */
    getZoomedPosition(time) {
        if (this.zoomLevel <= 1) {
            return (time / this.totalDuration) * 100;
        }

        const viewDuration = this.totalDuration / this.zoomLevel;
        const viewEnd = this.viewStart + viewDuration;

        // Check if time is in visible window
        if (time < this.viewStart || time > viewEnd) {
            return -1; // Outside visible window
        }

        return ((time - this.viewStart) / viewDuration) * 100;
    }

    /**
     * Re-render clip markers with current zoom
     */
    rerenderClipMarkers() {
        // Remove existing clip markers
        const existingMarkers = this.clipsContainer.querySelectorAll('.clip-marker, .sentry-trigger-marker, .near-miss-marker');
        existingMarkers.forEach(m => m.remove());

        // Re-add if we have stored clip group info
        if (this._lastClipGroups) {
            this.setClipMarkers(this._lastClipGroups);
        }
        if (this._sentryTriggerTime) {
            this.setSentryTriggerMarker(this._sentryTriggerTime);
        }
        if (this._nearMisses) {
            this.setNearMissMarkers(this._nearMisses);
        }
    }

    /**
     * Update zoom level indicator
     */
    updateZoomIndicator() {
        let indicator = this.timeline.querySelector('.zoom-indicator');

        if (this.zoomLevel === 1) {
            if (indicator) indicator.remove();
            return;
        }

        if (!indicator) {
            indicator = document.createElement('div');
            indicator.className = 'zoom-indicator';
            this.timeline.appendChild(indicator);
        }

        indicator.textContent = `${this.zoomLevel.toFixed(1)}x`;
    }

    /**
     * Get visible time range
     * @returns {{start: number, end: number}}
     */
    getVisibleRange() {
        const viewDuration = this.totalDuration / this.zoomLevel;
        return {
            start: this.viewStart,
            end: this.viewStart + viewDuration
        };
    }

    /**
     * Handle click on timeline
     * @param {MouseEvent} event
     */
    handleTimelineClick(event) {
        const rect = this.timeline.getBoundingClientRect();
        const clickX = event.clientX - rect.left;
        const percent = clickX / rect.width;

        // When zoomed, map click position to visible window
        let time;
        if (this.zoomLevel > 1) {
            const viewDuration = this.totalDuration / this.zoomLevel;
            time = this.viewStart + (percent * viewDuration);
        } else {
            time = percent * this.totalDuration;
        }

        if (this.onSeek) {
            this.onSeek(time);
        }
    }

    /**
     * Start dragging scrubber
     * @param {MouseEvent|Touch} event
     */
    startDragging(event) {
        this.isDragging = true;
        this.scrubber.classList.add('dragging');
        this.timeline.classList.add('seeking');
        this.handleDrag(event);
    }

    /**
     * Handle drag movement
     * @param {MouseEvent|Touch} event
     */
    handleDrag(event) {
        const rect = this.timeline.getBoundingClientRect();
        const dragX = event.clientX - rect.left;
        const percent = Math.max(0, Math.min(1, dragX / rect.width));

        // When zoomed, map drag position to visible window
        let time;
        if (this.zoomLevel > 1) {
            const viewDuration = this.totalDuration / this.zoomLevel;
            time = this.viewStart + (percent * viewDuration);
            time = Math.max(0, Math.min(this.totalDuration, time));
        } else {
            time = percent * this.totalDuration;
        }

        // Update visual position (pass absolute percent for auto-scroll handling)
        const absolutePercent = time / this.totalDuration;
        this.updateVisualPosition(absolutePercent);

        // Update time during drag
        this.currentTime = time;
        this.updateTimeDisplay();
    }

    /**
     * Stop dragging scrubber
     */
    stopDragging() {
        this.isDragging = false;
        this.scrubber.classList.remove('dragging');
        this.timeline.classList.remove('seeking');

        // Seek to final position
        if (this.onSeek) {
            this.onSeek(this.currentTime);
        }
    }

    /**
     * Update visual position of progress and scrubber
     * @param {number} percent 0-1 (absolute position in timeline)
     */
    updateVisualPosition(percent) {
        // When zoomed, calculate position relative to visible window
        if (this.zoomLevel > 1) {
            const viewDuration = this.totalDuration / this.zoomLevel;
            const viewEnd = this.viewStart + viewDuration;
            const absoluteTime = percent * this.totalDuration;

            // Auto-scroll to keep current position visible (smooth)
            // Keep playhead at ~40% from the left edge when auto-scrolling
            const targetPosition = 0.4;
            if (absoluteTime < this.viewStart + viewDuration * 0.1) {
                // Approaching left edge - scroll left
                this.targetViewStart = Math.max(0, absoluteTime - viewDuration * targetPosition);
                this.startSmoothScroll();
            } else if (absoluteTime > this.viewStart + viewDuration * 0.9) {
                // Approaching right edge - scroll right
                this.targetViewStart = Math.min(this.totalDuration - viewDuration, absoluteTime - viewDuration * targetPosition);
                this.startSmoothScroll();
            }

            // Calculate position within visible window
            const visiblePercent = (absoluteTime - this.viewStart) / viewDuration;
            const percentClamped = Math.max(0, Math.min(100, visiblePercent * 100));
            this.progress.style.width = `${percentClamped}%`;
            this.scrubber.style.left = `${percentClamped}%`;
        } else {
            const percentClamped = Math.max(0, Math.min(100, percent * 100));
            this.progress.style.width = `${percentClamped}%`;
            this.scrubber.style.left = `${percentClamped}%`;
        }
    }

    /**
     * Start smooth scroll animation towards targetViewStart
     */
    startSmoothScroll() {
        if (this.scrollAnimationId) return; // Already animating

        const animate = () => {
            const diff = this.targetViewStart - this.viewStart;

            // If close enough, snap to target
            if (Math.abs(diff) < 0.1) {
                this.viewStart = this.targetViewStart;
                this.scrollAnimationId = null;
                this.updateZoomDisplay();
                return;
            }

            // Ease towards target (lerp with factor 0.15 for smooth motion)
            this.viewStart += diff * 0.15;
            this.updateZoomDisplay();

            this.scrollAnimationId = requestAnimationFrame(animate);
        };

        this.scrollAnimationId = requestAnimationFrame(animate);
    }

    /**
     * Stop smooth scroll animation
     */
    stopSmoothScroll() {
        if (this.scrollAnimationId) {
            cancelAnimationFrame(this.scrollAnimationId);
            this.scrollAnimationId = null;
        }
    }

    /**
     * Set total duration
     * @param {number} duration Duration in seconds
     */
    setDuration(duration) {
        this.totalDuration = duration;
        this.duration = duration; // Alias
        this.totalDurationDisplay.textContent = this.formatTime(duration);
        this.resetZoom();

        // Show minimap once we have a duration
        if (duration > 0 && this.minimap) {
            this.minimap.classList.remove('hidden');
            this.updateMinimap();
        }
    }

    /**
     * Update current time
     * @param {number} time Time in seconds
     */
    updateTime(time) {
        if (this.isDragging) return; // Don't update while dragging

        // After a bookmark jump, ignore video timeupdate for 1000ms
        // This prevents the overshooting video time from overwriting the bookmark's target time
        const timeSinceBookmarkJump = Date.now() - this.bookmarkJumpTime;
        if (timeSinceBookmarkJump < 1000) {
            // Still update visual position but don't update currentTime for navigation
            const percent = this.totalDuration > 0 ? time / this.totalDuration : 0;
            this.updateVisualPosition(percent);
            this.updateTimeDisplay();
            this.updateMinimap();
            return;
        }

        // If time changed significantly (user seeked manually), clear the bookmark tracking
        // This allows "previous" to work correctly after user manually navigates
        if (Math.abs(time - this.currentTime) > 5) {
            this.lastJumpedBookmarkId = null;
        }

        this.currentTime = time;
        const percent = this.totalDuration > 0 ? time / this.totalDuration : 0;

        this.updateVisualPosition(percent);
        this.updateTimeDisplay();

        // Always update mini-map
        this.updateMinimap();
    }

    /**
     * Update time display
     */
    updateTimeDisplay() {
        this.currentTimeDisplay.textContent = this.formatTimeWithFrames(this.currentTime);
    }

    /**
     * Format time in HH:MM:SS:FF (with frame count)
     * Tesla dashcam is typically 36fps
     * @param {number} seconds
     * @returns {string}
     */
    formatTimeWithFrames(seconds) {
        if (!isFinite(seconds)) return '00:00:00:00';

        const FPS = 36; // Tesla dashcam frame rate
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const frames = Math.floor((seconds % 1) * FPS);

        return [hours, minutes, secs]
            .map(v => v.toString().padStart(2, '0'))
            .join(':') + ':' + frames.toString().padStart(2, '0');
    }

    /**
     * Format time in HH:MM:SS
     * @param {number} seconds
     * @returns {string}
     */
    formatTime(seconds) {
        if (!isFinite(seconds)) return '00:00:00';

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        return [hours, minutes, secs]
            .map(v => v.toString().padStart(2, '0'))
            .join(':');
    }

    /**
     * Set clip markers on timeline
     * @param {Array} clipGroups Array of clip groups with durations
     */
    async setClipMarkers(clipGroups) {
        // Store for re-rendering on zoom
        this._lastClipGroups = clipGroups;

        // Remove existing clip markers only
        const existingMarkers = this.clipsContainer.querySelectorAll('.clip-marker');
        existingMarkers.forEach(m => m.remove());

        if (!clipGroups || clipGroups.length === 0) {
            this.renderMinimapMarkers();
            return;
        }

        let accumulatedTime = 0;
        const totalDuration = this.totalDuration;
        const cachedDurations = window.app?.videoPlayer?.cachedClipDurations || [];

        for (let i = 0; i < clipGroups.length; i++) {
            const clipGroup = clipGroups[i];

            // Get clip duration from cache, fallback to 60s approximation
            const duration = cachedDurations[i] || 60;

            if (i > 0) {
                // Add marker at clip boundary
                const percent = this.getZoomedPosition(accumulatedTime);

                // Skip if outside visible window when zoomed
                if (percent >= 0) {
                    const marker = document.createElement('div');
                    marker.className = 'clip-marker';
                    marker.style.left = `${percent}%`;
                    this.clipsContainer.appendChild(marker);
                }
            }

            accumulatedTime += duration;
        }

        // Update minimap markers
        this.renderMinimapMarkers();
    }

    /**
     * Set Sentry trigger marker on timeline
     * @param {number} triggerTime Time in seconds where sentry was triggered
     */
    setSentryTriggerMarker(triggerTime) {
        // Store for re-rendering on zoom
        this._sentryTriggerTime = triggerTime;

        // Remove existing sentry marker
        const existing = this.clipsContainer.querySelector('.sentry-trigger-marker');
        if (existing) existing.remove();

        if (!this.totalDuration || triggerTime <= 0) {
            this.renderMinimapMarkers();
            return;
        }

        const percent = this.getZoomedPosition(triggerTime);

        // Skip if outside visible window when zoomed
        if (percent >= 0) {
            const marker = document.createElement('div');
            marker.className = 'sentry-trigger-marker';
            marker.style.left = `${percent}%`;
            marker.title = `Sentry Triggered at ${this.formatTime(triggerTime)}`;
            this.clipsContainer.appendChild(marker);
        }

        // Update minimap markers
        this.renderMinimapMarkers();
    }

    /**
     * Set gap markers on timeline
     * @param {Array} gaps Array of gap objects from FolderParser.detectGaps()
     * @param {Array} clipGroups Clip groups for position calculation
     */
    setGapMarkers(gaps, clipGroups) {
        // Store for re-rendering on zoom
        this._gaps = gaps;
        this._gapClipGroups = clipGroups;

        // Remove existing gap markers
        const existingGaps = this.clipsContainer.querySelectorAll('.gap-marker');
        existingGaps.forEach(m => m.remove());

        if (!gaps || gaps.length === 0 || !clipGroups) return;

        const cachedDurations = window.app?.videoPlayer?.cachedClipDurations || [];

        for (const gap of gaps) {
            // Calculate position after the clip where gap occurs using cached durations
            const clipIndexAfter = gap.afterClipIndex;
            let timePosition = 0;
            for (let i = 0; i <= clipIndexAfter && i < cachedDurations.length; i++) {
                timePosition += cachedDurations[i] || 60;
            }
            // If no cached durations available, fallback to approximation
            if (cachedDurations.length === 0) {
                timePosition = (clipIndexAfter + 1) * 60;
            }

            const percent = this.getZoomedPosition(timePosition);

            // Skip if outside visible window when zoomed
            if (percent < 0 || percent > 100) continue;

            const marker = document.createElement('div');
            marker.className = 'gap-marker';
            marker.style.left = `${percent}%`;
            marker.title = `Gap: ${gap.formattedDuration} missing`;
            marker.dataset.duration = gap.formattedDuration;
            this.clipsContainer.appendChild(marker);
        }
    }

    /**
     * Set near-miss markers on timeline
     * @param {Array} nearMisses Array of near-miss objects from TelemetryGraphs._detectNearMisses()
     */
    setNearMissMarkers(nearMisses) {
        // Store for re-rendering on zoom
        this._nearMisses = nearMisses;

        // Remove existing near-miss markers
        const existingMarkers = this.clipsContainer.querySelectorAll('.near-miss-marker');
        existingMarkers.forEach(m => m.remove());

        if (!nearMisses || nearMisses.length === 0 || !this.totalDuration) {
            this.renderMinimapMarkers();
            return;
        }

        // Only show markers for near-misses with score >= 5
        const flaggedNearMisses = nearMisses.filter(nm => nm.score >= 5);

        for (const nearMiss of flaggedNearMisses) {
            const percent = this.getZoomedPosition(nearMiss.time);

            // Skip if outside visible window when zoomed
            if (percent < 0 || percent > 100) continue;

            const marker = document.createElement('div');
            marker.className = `near-miss-marker severity-${nearMiss.severity}`;
            marker.style.left = `${percent}%`;

            // Build detailed tooltip
            const steeringInfo = nearMiss.hasEvasiveSteering
                ? `, Steering: ${nearMiss.steeringRate.toFixed(0)}\u00B0/s`
                : '';
            marker.title = `Near-Miss (Score: ${nearMiss.score.toFixed(1)})\n` +
                `Time: ${this.formatTime(nearMiss.time)}\n` +
                `Brake: ${nearMiss.brakeG.toFixed(2)}g${steeringInfo}\n` +
                `Speed: ${nearMiss.speed.toFixed(0)} mph`;

            marker.dataset.score = nearMiss.score;
            marker.dataset.time = nearMiss.time;

            // Click to seek to near-miss time
            marker.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.onSeek) {
                    this.onSeek(nearMiss.time);
                }
            });

            this.clipsContainer.appendChild(marker);
        }

        // Update minimap markers
        this.renderMinimapMarkers();
    }

    /**
     * Reset timeline
     */
    reset() {
        this.totalDuration = 0;
        this.currentTime = 0;
        this.updateVisualPosition(0);
        this.currentTimeDisplay.textContent = '00:00:00:00';
        this.totalDurationDisplay.textContent = '00:00:00';
        this.clipsContainer.innerHTML = '';
        this._gaps = null;
        this._nearMisses = null;
    }

    /**
     * Get current time
     * @returns {number}
     */
    getCurrentTime() {
        return this.currentTime;
    }

    /**
     * Get total duration
     * @returns {number}
     */
    getDuration() {
        return this.totalDuration;
    }

    // ==================== Bookmark Methods ====================

    /**
     * Add a bookmark at current time
     * @param {string} label Optional label for the bookmark
     * @returns {Object} The created bookmark
     */
    addBookmark(label = '') {
        const bookmark = {
            id: Date.now(),
            time: this.currentTime,
            label: label || `Bookmark ${this.bookmarks.length + 1}`
        };

        this.bookmarks.push(bookmark);
        this.saveBookmarks();
        this.renderBookmarks();

        return bookmark;
    }

    /**
     * Add a bookmark at specific time
     * @param {number} time Time in seconds
     * @param {string} label Optional label for the bookmark
     * @returns {Object} The created bookmark
     */
    addBookmarkAt(time, label = '') {
        const bookmark = {
            id: Date.now(),
            time: time,
            label: label || `Bookmark ${this.bookmarks.length + 1}`
        };

        this.bookmarks.push(bookmark);
        this.bookmarks.sort((a, b) => a.time - b.time);
        this.saveBookmarks();
        this.renderBookmarks();

        return bookmark;
    }

    /**
     * Remove a bookmark
     * @param {number} bookmarkId
     */
    removeBookmark(bookmarkId) {
        this.bookmarks = this.bookmarks.filter(b => b.id !== bookmarkId);
        this.saveBookmarks();
        this.renderBookmarks();
    }

    /**
     * Clear all bookmarks
     */
    clearBookmarks() {
        this.bookmarks = [];
        this.saveBookmarks();
        this.renderBookmarks();
    }

    /**
     * Get all bookmarks
     * @returns {Array}
     */
    getBookmarks() {
        return [...this.bookmarks];
    }

    /**
     * Jump to next bookmark from current position
     * @returns {Object|null} The bookmark jumped to, or null if none
     */
    jumpToNextBookmark() {
        // Sort bookmarks by time and find the first one after current position
        const sortedBookmarks = [...this.bookmarks].sort((a, b) => a.time - b.time);

        // Find next bookmark, excluding the one we just jumped to
        const nextBookmark = sortedBookmarks.find(b => {
            const isAfterCurrentTime = b.time > this.currentTime + 0.5;
            const isNotCurrentBookmark = b.id !== this.lastJumpedBookmarkId;
            return isAfterCurrentTime && isNotCurrentBookmark;
        });

        if (nextBookmark && this.onSeek) {
            // Update currentTime immediately so repeated clicks work correctly
            this.currentTime = nextBookmark.time;
            this.bookmarkJumpTime = Date.now(); // Prevent timeupdate from overwriting
            this.lastJumpedBookmarkId = nextBookmark.id; // Track which bookmark we're at
            this.onSeek(nextBookmark.time);
            return nextBookmark;
        }
        return null;
    }

    /**
     * Jump to previous bookmark from current position
     * @returns {Object|null} The bookmark jumped to, or null if none
     */
    jumpToPreviousBookmark() {
        // Sort bookmarks by time and find the last one before current position
        const sortedBookmarks = [...this.bookmarks].sort((a, b) => a.time - b.time);

        // Filter for bookmarks before current position, excluding the one we just jumped to
        // (video seek may overshoot, so we need to skip the current bookmark)
        const prevBookmarks = sortedBookmarks.filter(b => {
            const isBeforeCurrentTime = b.time < this.currentTime - 0.5;
            const isNotCurrentBookmark = b.id !== this.lastJumpedBookmarkId;
            return isBeforeCurrentTime && isNotCurrentBookmark;
        });

        if (prevBookmarks.length > 0) {
            const prevBookmark = prevBookmarks[prevBookmarks.length - 1];
            // Update currentTime immediately so repeated clicks work correctly
            this.currentTime = prevBookmark.time;
            this.bookmarkJumpTime = Date.now(); // Prevent timeupdate from overwriting
            this.lastJumpedBookmarkId = prevBookmark.id; // Track which bookmark we're at
            if (this.onSeek) {
                this.onSeek(prevBookmark.time);
            }
            return prevBookmark;
        }
        return null;
    }

    /**
     * Render bookmarks on the timeline
     */
    renderBookmarks() {
        // Remove existing bookmark markers
        const existingMarkers = this.clipsContainer.querySelectorAll('.bookmark-marker');
        existingMarkers.forEach(m => m.remove());

        // Add new bookmark markers
        this.bookmarks.forEach(bookmark => {
            if (this.totalDuration <= 0) return;

            const percent = this.getZoomedPosition(bookmark.time);

            // Skip if outside visible window when zoomed
            if (percent < 0) return;

            const marker = document.createElement('div');
            marker.className = 'bookmark-marker';
            marker.style.left = `${percent}%`;
            marker.title = `${bookmark.label} (${this.formatTime(bookmark.time)})`;
            marker.dataset.bookmarkId = bookmark.id;

            // Click to jump to bookmark
            marker.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.onSeek) {
                    this.onSeek(bookmark.time);
                }
            });

            // Right-click to remove
            marker.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (confirm(`Remove bookmark "${bookmark.label}"?`)) {
                    this.removeBookmark(bookmark.id);
                }
            });

            this.clipsContainer.appendChild(marker);
        });

        // Update minimap markers
        this.renderMinimapMarkers();
    }
}
