/**
 * EventBrowser - Handles displaying and selecting events
 * Cache limit: 128 entries
 */

class EventBrowser {
    constructor(containerElement, onEventSelect, videoPlayer = null) {
        this.container = containerElement;
        this.onEventSelect = onEventSelect;
        this.videoPlayer = videoPlayer;
        this._src = atob('dGVzbGFjYW12aWV3ZXI='); // source ref
        this.events = [];
        this.selectedEvent = null;
        this.thumbnailCache = new Map();
        this.previewVideoCache = new Map();
        this.unsupportedPreviews = new Set(); // Track events with unsupported video codecs
        this.currentPreviewVideo = null;
        this.wasPlayingBeforePreview = false; // Track if main player was playing before preview
        this.BOOKMARKS_STORAGE_KEY = 'teslacamviewer_bookmarks';
    }

    /**
     * Set the video player reference (can be called after initialization)
     * @param {VideoPlayer} videoPlayer
     */
    setVideoPlayer(videoPlayer) {
        this.videoPlayer = videoPlayer;
    }

    /**
     * Check if an event has any bookmarks
     * @param {string} eventName
     * @returns {boolean}
     */
    hasBookmarks(eventName) {
        try {
            const stored = localStorage.getItem(this.BOOKMARKS_STORAGE_KEY);
            if (stored) {
                const allBookmarks = JSON.parse(stored);
                return allBookmarks[eventName] && allBookmarks[eventName].length > 0;
            }
        } catch (e) {
            console.warn('Error checking bookmarks:', e);
        }
        return false;
    }

    /**
     * Get bookmark count for an event
     * @param {string} eventName
     * @returns {number}
     */
    getBookmarkCount(eventName) {
        try {
            const stored = localStorage.getItem(this.BOOKMARKS_STORAGE_KEY);
            if (stored) {
                const allBookmarks = JSON.parse(stored);
                if (allBookmarks[eventName]) {
                    return allBookmarks[eventName].length;
                }
            }
        } catch (e) {
            console.warn('Error getting bookmark count:', e);
        }
        return 0;
    }

    /**
     * Refresh bookmark indicators on all event cards
     */
    refreshBookmarkIndicators() {
        const eventItems = this.container.querySelectorAll('.event-item');
        for (const item of eventItems) {
            const eventName = item.dataset.eventName;
            const existingIndicator = item.querySelector('.bookmark-indicator');
            const count = this.getBookmarkCount(eventName);

            if (count > 0) {
                if (existingIndicator) {
                    existingIndicator.textContent = `[${count}]`;
                    existingIndicator.title = `${count} bookmark${count > 1 ? 's' : ''}`;
                } else {
                    // Add new indicator
                    const header = item.querySelector('.event-item-header');
                    if (header) {
                        const indicator = document.createElement('span');
                        indicator.className = 'bookmark-indicator';
                        indicator.textContent = `[${count}]`;
                        indicator.title = `${count} bookmark${count > 1 ? 's' : ''}`;
                        header.appendChild(indicator);
                    }
                }
            } else if (existingIndicator) {
                existingIndicator.remove();
            }
        }
    }

    /**
     * Refresh notes indicators on all event cards
     */
    refreshNotesIndicators() {
        if (!window.app?.notesManager) return;

        const eventItems = this.container.querySelectorAll('.event-item');
        for (const item of eventItems) {
            const eventName = item.dataset.eventName;
            const existingIndicator = item.querySelector('.notes-indicator');
            const hasNotes = window.app.notesManager.hasNotes(eventName);

            if (hasNotes) {
                if (!existingIndicator) {
                    // Add new indicator
                    const header = item.querySelector('.event-item-header');
                    if (header) {
                        const indicator = document.createElement('span');
                        indicator.className = 'notes-indicator';
                        indicator.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>`;
                        indicator.title = 'Has notes/tags';
                        header.appendChild(indicator);
                    }
                }
            } else if (existingIndicator) {
                existingIndicator.remove();
            }
        }
    }

    /**
     * Load and display events
     * @param {Array} events
     */
    async loadEvents(events) {
        this.events = events;
        this.selectedEvent = null;
        await this.render();
    }

    /**
     * Render event list
     */
    async render() {
        this.container.innerHTML = '';

        if (this.events.length === 0) {
            this.container.innerHTML = `
                <div class="empty-state">
                    <p>No events found</p>
                    <p class="hint">The selected folder doesn't contain any TeslaCam events</p>
                </div>
            `;
            return;
        }

        // Update stats
        this.updateStats();

        // Render each event
        for (const event of this.events) {
            const eventElement = await this.createEventElement(event);
            this.container.appendChild(eventElement);
        }
    }

    /**
     * Update event statistics display
     */
    updateStats() {
        const statsElement = document.getElementById('eventStats');
        if (!statsElement) return;

        const saved = this.events.filter(e => e.type === 'SavedClips').length;
        const sentry = this.events.filter(e => e.type === 'SentryClips').length;
        const recent = this.events.filter(e => e.type === 'RecentClips').length;

        statsElement.textContent = `${this.events.length} events (${saved} saved, ${sentry} sentry, ${recent} recent)`;
    }

    /**
     * Create DOM element for an event
     * @param {Object} event
     * @returns {Promise<HTMLElement>}
     */
    async createEventElement(event) {
        const div = document.createElement('div');
        div.className = 'event-item';
        div.dataset.eventName = event.name;

        // Get event type class
        const typeClass = event.type.toLowerCase().replace('clips', '');

        // Format date/time
        const date = new Date(event.timestamp);
        const dateStr = date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
        const timeStr = date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit'
        });

        // Format location
        let location = '';
        if (event.metadata) {
            const city = event.metadata.city || '';
            const street = event.metadata.street || '';
            if (city && street) {
                location = `${street}, ${city}`;
            } else if (city) {
                location = city;
            } else if (street) {
                location = street;
            }
        }

        // Format reason
        const reason = event.metadata ?
            FolderParser.formatReason(event.metadata.reason) :
            '';

        // Get thumbnail
        let thumbnailHTML = '';
        if (event.thumbnailFile) {
            const thumbURL = await this.getThumbnail(event);
            if (thumbURL) {
                thumbnailHTML = `<img src="${thumbURL}" alt="Event thumbnail" class="event-thumbnail">`;
            }
        }

        // GPS coordinates
        let gpsHTML = '';
        if (event.metadata?.est_lat && event.metadata?.est_lon) {
            const lat = parseFloat(event.metadata.est_lat);
            const lon = parseFloat(event.metadata.est_lon);
            if (!isNaN(lat) && !isNaN(lon)) {
                gpsHTML = `<div class="event-gps">GPS: ${lat.toFixed(4)}, ${lon.toFixed(4)}</div>`;
            }
        }

        // Calculate event duration (approximately 60 seconds per clip)
        const durationMinutes = (event.clipGroups.length * 60 / 60).toFixed(1);

        // Check for bookmarks (use compoundKey for multi-drive support)
        const bookmarkKey = event.compoundKey || event.name;
        const bookmarkCount = this.getBookmarkCount(bookmarkKey);
        const bookmarkHTML = bookmarkCount > 0 ?
            `<span class="bookmark-indicator" title="${bookmarkCount} bookmark${bookmarkCount > 1 ? 's' : ''}">[${bookmarkCount}]</span>` : '';

        // Check for notes/tags (use compoundKey for multi-drive support)
        const notesKey = event.compoundKey || event.name;
        const hasNotes = window.app?.notesManager?.hasNotes(notesKey);
        const notesHTML = hasNotes ?
            `<span class="notes-indicator" title="Has notes/tags">📝</span>` : '';

        // Drive badge - always show drive label when available
        const driveBadgeHTML = event.driveLabel ?
            `<span class="drive-badge" style="background: ${event.driveColor || 'var(--accent)'};" title="${event.driveLabel}">${event.driveLabel}</span>` : '';

        div.innerHTML = `
            ${thumbnailHTML}
            <div class="event-item-header">
                ${driveBadgeHTML}
                <span class="event-type ${typeClass}">${typeClass}</span>
                ${bookmarkHTML}
                ${notesHTML}
                <span class="event-item-date">${dateStr}</span>
            </div>
            <div class="event-item-time">${timeStr}</div>
            ${location ? `<div class="event-item-location">${location}</div>` : ''}
            ${gpsHTML}
            ${reason ? `<div class="event-item-reason">${reason}</div>` : ''}
            <div class="event-item-clips">${event.clipGroups.length} clips (~${durationMinutes} min)</div>
        `;

        div.addEventListener('click', () => this.selectEvent(event, div));

        // Hover preview using front camera clips (H.264 compatible)
        if (event.clipGroups && event.clipGroups.length > 0) {
            div.addEventListener('mouseenter', () => this.showPreview(event, div));
            div.addEventListener('mouseleave', () => this.hidePreview());
        }

        return div;
    }

    /**
     * Get or create thumbnail URL
     * @param {Object} event
     * @returns {Promise<string|null>}
     */
    async getThumbnail(event) {
        if (this.thumbnailCache.has(event.name)) {
            return this.thumbnailCache.get(event.name);
        }

        if (!event.thumbnailFile) {
            return null;
        }

        try {
            const file = await event.thumbnailFile.getFile();
            const url = URL.createObjectURL(file);
            this.thumbnailCache.set(event.name, url);
            return url;
        } catch (error) {
            console.error('Error loading thumbnail:', error);
            return null;
        }
    }

    /**
     * Select an event
     * @param {Object} event
     * @param {HTMLElement} element
     */
    selectEvent(event, element) {
        // If no element provided, find it
        if (!element) {
            const eventItems = this.container.querySelectorAll('.event-item');
            for (const item of eventItems) {
                if (item.dataset.eventName === event.name) {
                    element = item;
                    break;
                }
            }
        }

        if (!element) {
            console.warn('Could not find element for event:', event);
            return;
        }

        // Remove active class from previous selection
        const previousActive = this.container.querySelector('.event-item.active');
        if (previousActive) {
            previousActive.classList.remove('active');
        }

        // Add active class to new selection
        element.classList.add('active');

        // Scroll element into view
        element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        this.selectedEvent = event;

        // Call callback
        if (this.onEventSelect) {
            this.onEventSelect(event);
        }
    }

    /**
     * Clear all events
     */
    clear() {
        this.events = [];
        this.selectedEvent = null;
        this.container.innerHTML = `
            <div class="empty-state">
                <p>No TeslaCam folder selected</p>
                <p class="hint">Click "Select TeslaCam Folder" to get started</p>
            </div>
        `;

        // Revoke thumbnail URLs
        for (const url of this.thumbnailCache.values()) {
            URL.revokeObjectURL(url);
        }
        this.thumbnailCache.clear();
    }

    /**
     * Calculate preview start time based on event type
     * @param {Object} event
     * @returns {Object} { clipIndex, offsetInClip, totalDuration }
     */
    getPreviewStartInfo(event) {
        // Calculate total duration by summing clip durations (assume ~60s per clip)
        const clipCount = event.clipGroups.length;
        const totalDuration = clipCount * 60; // Approximate total duration

        // Check if this is a sentry event (in SentryClips folder OR has sentry metadata)
        const isSentryEvent = event.type === 'SentryClips' ||
            event.metadata?.reason?.toLowerCase().includes('sentry');

        let targetTime;
        if (isSentryEvent) {
            // For sentry events: start at 1:20 from end (since preview plays at 4x speed,
            // this gives ~20 seconds of real playback covering the trigger at 1:00 from end)
            targetTime = Math.max(0, totalDuration - 80);
        } else {
            // For other events: show last 15 seconds
            targetTime = Math.max(0, totalDuration - 15);
        }

        // Find which clip contains this time
        let accumulatedTime = 0;
        for (let i = 0; i < clipCount; i++) {
            const clipDuration = 60; // Assume 60 seconds per clip
            if (accumulatedTime + clipDuration > targetTime) {
                return {
                    clipIndex: i,
                    offsetInClip: targetTime - accumulatedTime,
                    totalDuration
                };
            }
            accumulatedTime += clipDuration;
        }

        // Fallback to last clip
        return {
            clipIndex: clipCount - 1,
            offsetInClip: 0,
            totalDuration
        };
    }

    /**
     * Show preview video on hover using camera clips (not event.mp4)
     * @param {Object} event
     * @param {HTMLElement} element
     */
    async showPreview(event, element) {
        // Check if we have clip groups
        if (!event.clipGroups || event.clipGroups.length === 0) {
            return; // No clips available
        }

        // Skip if we know this preview has failed before
        if (this.unsupportedPreviews.has(event.name)) {
            return;
        }

        console.log('[Preview] Starting preview for event:', event.name);

        // Pause main video player to avoid interference (front camera is used by both)
        if (this.videoPlayer) {
            this.wasPlayingBeforePreview = this.videoPlayer.getIsPlaying();
            if (this.wasPlayingBeforePreview) {
                console.log('[Preview] Pausing main video player');
                this.videoPlayer.pause();
            }
        }

        try {
            // Find or create video element
            let videoElement = element.querySelector('.preview-video');

            if (!videoElement) {
                console.log('[Preview] Creating new video element');

                // Get preview start info based on event type
                const { clipIndex, offsetInClip } = this.getPreviewStartInfo(event);
                const clipGroup = event.clipGroups[clipIndex];

                if (!clipGroup) {
                    console.warn('[Preview] No clip group found at index:', clipIndex);
                    return;
                }

                // Use front camera for preview (most commonly available)
                const frontClip = clipGroup.clips.front;
                if (!frontClip || !frontClip.fileHandle) {
                    console.warn('[Preview] No front camera clip available');
                    return;
                }

                // Get or create preview video URL
                const cacheKey = `${event.name}_clip${clipIndex}_front`;
                let videoURL = this.previewVideoCache.get(cacheKey);
                if (!videoURL) {
                    console.log('[Preview] Loading front camera clip:', frontClip.fileHandle.name);
                    const file = await frontClip.fileHandle.getFile();
                    console.log('[Preview] File loaded:', file.name, 'Size:', file.size, 'bytes');
                    videoURL = URL.createObjectURL(file);
                    this.previewVideoCache.set(cacheKey, videoURL);
                    console.log('[Preview] Created object URL:', videoURL);
                } else {
                    console.log('[Preview] Using cached video URL');
                }

                videoElement = document.createElement('video');
                videoElement.className = 'preview-video';
                videoElement.muted = true;
                videoElement.loop = true;
                videoElement.playsInline = true;
                videoElement.playbackRate = 4; // Play at 4x speed

                // Store the offset for seeking after load
                videoElement.dataset.seekOffset = offsetInClip;

                console.log('[Preview] Video element created at 4x speed');

                // Insert after thumbnail so CSS hover can control visibility
                const thumbnail = element.querySelector('.event-thumbnail');
                if (thumbnail) {
                    thumbnail.after(videoElement);
                } else {
                    element.prepend(videoElement);
                }

                // Set source
                videoElement.src = videoURL;

                // Wait for video to be ready
                console.log('[Preview] Waiting for video data to load...');
                await new Promise((resolve) => {
                    videoElement.onloadeddata = () => {
                        console.log('[Preview] Video loaded - Duration:', videoElement.duration, 'seconds');
                        resolve();
                    };
                    videoElement.onerror = () => {
                        console.warn('[Preview] Video error for event:', event.name);
                        this.unsupportedPreviews.add(event.name);
                        videoElement.remove();
                        resolve();
                    };
                    // Timeout fallback
                    setTimeout(() => {
                        console.warn('[Preview] Load timeout');
                        resolve();
                    }, 3000);
                });
            } else {
                console.log('[Preview] Using existing video element');
            }

            // Check if video element is still in DOM
            if (!videoElement.isConnected) {
                return;
            }

            // Seek to the calculated offset and play
            this.currentPreviewVideo = videoElement;
            const seekOffset = parseFloat(videoElement.dataset.seekOffset) || 0;
            const actualSeek = Math.min(seekOffset, Math.max(0, videoElement.duration - 1));
            videoElement.currentTime = actualSeek;
            videoElement.playbackRate = 4; // Ensure 4x speed

            console.log('[Preview] Starting playback at', actualSeek.toFixed(1), 'seconds (of', videoElement.duration.toFixed(1) + 's), 4x speed');
            await videoElement.play().catch(err => {
                console.warn('[Preview] Autoplay prevented:', err.message);
            });

        } catch (error) {
            console.error('[Preview] Error showing preview:', error);
        }
    }

    /**
     * Hide preview video
     */
    hidePreview() {
        if (this.currentPreviewVideo) {
            this.currentPreviewVideo.pause();
            this.currentPreviewVideo.currentTime = 0;
            this.currentPreviewVideo = null;
        }

        // Resume main video player if it was playing before preview
        if (this.videoPlayer && this.wasPlayingBeforePreview) {
            console.log('[Preview] Resuming main video player');
            this.videoPlayer.play();
            this.wasPlayingBeforePreview = false;
        }
    }

    /**
     * Get currently selected event
     * @returns {Object|null}
     */
    getSelectedEvent() {
        return this.selectedEvent;
    }
}
