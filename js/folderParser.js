/**
 * FolderParser - Handles reading and parsing TeslaCam directory structure
 * Parser v3.7.12
 */

class FolderParser {
    constructor() {
        this.rootHandle = null;
        this.events = [];
        this._sig = 'nmccomb'; // parser signature
        this.DB_NAME = 'TeslaCamViewerDB';
        this.DB_STORE = 'folderHandles';
        this.DB_KEY = 'lastFolder';

        // Multi-drive support
        this.currentDriveId = null;
        this.currentDriveLabel = null;
        this.currentDriveColor = null;

        // Progress callback for UI updates during parsing
        this.onProgress = null;
    }

    /**
     * Set progress callback for UI updates during parsing
     * @param {Function} callback - Called with (message, eventCount)
     */
    setProgressCallback(callback) {
        this.onProgress = callback;
    }

    /**
     * Set the current drive context for parsing
     * @param {string} driveId
     * @param {string} driveLabel
     * @param {string} driveColor
     */
    setDriveContext(driveId, driveLabel = null, driveColor = null) {
        this.currentDriveId = driveId;
        this.currentDriveLabel = driveLabel;
        this.currentDriveColor = driveColor;
    }

    /**
     * Clear the drive context
     */
    clearDriveContext() {
        this.currentDriveId = null;
        this.currentDriveLabel = null;
        this.currentDriveColor = null;
    }

    /**
     * Generate compound key for an event
     * @param {string} eventName
     * @returns {string}
     */
    getCompoundKey(eventName) {
        if (!this.currentDriveId) {
            return eventName; // Fallback for legacy single-drive mode
        }
        return `${this.currentDriveId}:${eventName}`;
    }

    /**
     * Initialize IndexedDB for storing folder handles
     * @returns {Promise<IDBDatabase>}
     */
    async openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, 2);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.DB_STORE)) {
                    db.createObjectStore(this.DB_STORE);
                }
            };
        });
    }

    /**
     * Save folder handle to IndexedDB
     * @returns {Promise<void>}
     */
    async saveFolderHandle() {
        if (!this.rootHandle) return;

        try {
            const db = await this.openDB();
            const tx = db.transaction(this.DB_STORE, 'readwrite');
            const store = tx.objectStore(this.DB_STORE);
            store.put(this.rootHandle, this.DB_KEY);
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            console.log('Folder handle saved to IndexedDB');
        } catch (e) {
            console.warn('Failed to save folder handle:', e);
        }
    }

    /**
     * Load folder handle from IndexedDB and request permission
     * @returns {Promise<boolean>} Success status
     */
    async loadSavedFolder() {
        try {
            const db = await this.openDB();
            const tx = db.transaction(this.DB_STORE, 'readonly');
            const store = tx.objectStore(this.DB_STORE);
            const request = store.get(this.DB_KEY);

            const handle = await new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });

            if (!handle) {
                console.log('No saved folder handle found');
                return false;
            }

            // Request permission to access the folder
            const permission = await handle.requestPermission({ mode: 'read' });
            if (permission !== 'granted') {
                console.log('Permission denied for saved folder');
                return false;
            }

            this.rootHandle = handle;
            console.log('Restored saved folder:', handle.name);
            return true;
        } catch (e) {
            console.warn('Failed to load saved folder:', e);
            return false;
        }
    }

    /**
     * Clear saved folder handle from IndexedDB
     * @returns {Promise<void>}
     */
    async clearSavedFolder() {
        try {
            const db = await this.openDB();
            const tx = db.transaction(this.DB_STORE, 'readwrite');
            const store = tx.objectStore(this.DB_STORE);
            store.delete(this.DB_KEY);
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.warn('Failed to clear saved folder:', e);
        }
    }

    /**
     * Request user to select TeslaCam folder
     * @returns {Promise<boolean>} Success status
     */
    async selectFolder() {
        try {
            this.rootHandle = await window.showDirectoryPicker();
            return true;
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Error selecting folder:', error);
            }
            return false;
        }
    }

    /**
     * Parse the entire TeslaCam directory structure
     * Recursively searches for SavedClips/SentryClips/RecentClips folders
     * @returns {Promise<Array>} Array of parsed events
     */
    async parseFolder() {
        if (!this.rootHandle) {
            throw new Error('No folder selected');
        }

        this.events = [];

        // Recursively search for TeslaCam event folders
        await this.searchDirectory(this.rootHandle, 0);

        // Sort events by timestamp (newest first)
        this.events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        return this.events;
    }

    /**
     * Recursively search directory for event folders
     * @param {FileSystemDirectoryHandle} dirHandle
     * @param {number} depth - Current depth (limit recursion)
     */
    async searchDirectory(dirHandle, depth) {
        // Limit recursion depth to prevent infinite loops
        if (depth > 10) return;

        // Check if this directory contains video clips (is an event folder)
        let hasVideoClips = false;
        let videoClips = [];
        for await (const entry of dirHandle.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.mp4')) {
                hasVideoClips = true;
                videoClips.push(entry);
            }
        }

        // If this folder has video clips, try to parse it as an event
        if (hasVideoClips) {
            // Determine folder type based on parent or current folder name
            const folderName = dirHandle.name;
            let folderType = 'SavedClips'; // default

            if (folderName === 'RecentClips' || folderName.includes('Recent')) {
                // RecentClips folder selected directly - use parseRecentClips
                await this.parseRecentClips(dirHandle);
                return;
            } else if (folderName === 'SentryClips' || folderName.includes('Sentry')) {
                folderType = 'SentryClips';
            }

            // Try parsing as event
            const event = await this.parseEvent(dirHandle, folderType);
            if (event) {
                this.events.push(event);
            }
            return; // Don't recurse into event folders
        }

        // Otherwise, look for subdirectories
        for await (const entry of dirHandle.values()) {
            if (entry.kind === 'directory') {
                const folderName = entry.name;

                // Check if this is an event folder type
                if (['SavedClips', 'SentryClips', 'RecentClips'].includes(folderName)) {
                    await this.parseEventFolder(entry, folderName);
                } else {
                    // Recursively search subdirectories
                    await this.searchDirectory(entry, depth + 1);
                }
            }
        }
    }

    /**
     * Parse individual event folder (SavedClips, SentryClips, or RecentClips)
     * @param {FileSystemDirectoryHandle} folderHandle
     * @param {string} folderType
     */
    async parseEventFolder(folderHandle, folderType) {
        // Report which folder we're scanning
        if (this.onProgress) {
            this.onProgress(`Scanning ${folderType}...`, this.events.length);
        }

        if (folderType === 'RecentClips') {
            // RecentClips is flat - no subfolders, just video files
            await this.parseRecentClips(folderHandle);
        } else {
            // SavedClips and SentryClips have event subfolders
            for await (const entry of folderHandle.values()) {
                if (entry.kind === 'directory') {
                    const event = await this.parseEvent(entry, folderType);
                    if (event) {
                        this.events.push(event);
                        // Report progress periodically (every 10 events to avoid UI spam)
                        if (this.onProgress && this.events.length % 10 === 0) {
                            this.onProgress(`Scanning ${folderType}...`, this.events.length);
                        }
                    }
                }
            }
        }
    }

    /**
     * Parse RecentClips folder (flat structure with no event metadata)
     * Groups clips by date and hour for better organization
     * @param {FileSystemDirectoryHandle} folderHandle
     */
    async parseRecentClips(folderHandle) {
        const clips = [];

        // Collect all video files
        for await (const entry of folderHandle.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.mp4')) {
                const clipMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(front|back|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$/);
                if (clipMatch) {
                    const [_, clipTimestamp, camera] = clipMatch;
                    clips.push({
                        timestamp: clipTimestamp,
                        camera: camera,
                        fileName: entry.name,
                        fileHandle: entry
                    });
                }
            }
        }

        if (clips.length === 0) {
            return;
        }

        // Group clips by date and hour
        const hourlyGroups = new Map();

        for (const clip of clips) {
            // Extract date and hour from timestamp: YYYY-MM-DD_HH-MM-SS
            const match = clip.timestamp.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})/);
            if (match) {
                const [_, datePart, hour] = match;
                const hourKey = `${datePart}_${hour}`;

                if (!hourlyGroups.has(hourKey)) {
                    hourlyGroups.set(hourKey, {
                        datePart: datePart,
                        hour: hour,
                        clips: []
                    });
                }
                hourlyGroups.get(hourKey).clips.push(clip);
            }
        }

        // Create synthetic events for each hourly group
        for (const [hourKey, group] of hourlyGroups.entries()) {
            // Group clips by timestamp within this hour
            const clipGroups = this.groupClips(group.clips);
            clipGroups.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

            if (clipGroups.length === 0) continue;

            // Get first clip timestamp for event timestamp
            const firstTimestamp = clipGroups[0]?.timestamp || hourKey;
            const [datePart, timePart] = firstTimestamp.split('_');
            const timestamp = `${datePart}T${timePart.replace(/-/g, ':')}`;

            // Format the hour for display (convert 24h to 12h format)
            const hourNum = parseInt(group.hour, 10);
            const hour12 = hourNum === 0 ? 12 : (hourNum > 12 ? hourNum - 12 : hourNum);
            const ampm = hourNum >= 12 ? 'PM' : 'AM';
            const hourRange = `${hour12}:00-${hour12}:59 ${ampm}`;

            // Format date for display
            const date = new Date(group.datePart);
            const dateStr = date.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });

            const eventName = `Recent: ${dateStr} ${hourRange}`;
            // Detect if this event has pillar cameras (6-camera system)
            const hasPillarCameras = group.clips.some(clip =>
                clip.camera === 'left_pillar' || clip.camera === 'right_pillar'
            );

            const event = {
                name: eventName,
                type: 'RecentClips',
                timestamp: timestamp,
                folderHandle: folderHandle,
                clips: group.clips,
                metadata: {
                    hourKey: hourKey,
                    clipCount: clipGroups.length,
                    reason: `${clipGroups.length} clips from ${hourRange}`
                },
                thumbnailFile: null,
                eventVideoFile: null,
                clipGroups: clipGroups,
                hasPillarCameras: hasPillarCameras,
                // Multi-drive support
                driveId: this.currentDriveId,
                compoundKey: this.getCompoundKey(eventName),
                driveLabel: this.currentDriveLabel,
                driveColor: this.currentDriveColor
            };

            this.events.push(event);
        }
    }

    /**
     * Parse individual event directory
     * @param {FileSystemDirectoryHandle} eventHandle
     * @param {string} folderType
     * @returns {Promise<Object|null>} Event object or null if invalid
     */
    async parseEvent(eventHandle, folderType) {
        const eventName = eventHandle.name;

        // Extract timestamp from folder name (YYYY-MM-DD_HH-MM-SS)
        const timestampMatch = eventName.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})$/);
        if (!timestampMatch) {
            return null;
        }

        const [_, datePart, timePart] = timestampMatch;
        const timestamp = `${datePart}T${timePart.replace(/-/g, ':')}`;

        const event = {
            name: eventName,
            type: folderType,
            timestamp: timestamp,
            folderHandle: eventHandle,
            clips: [],
            metadata: null,
            thumbnailFile: null,
            eventVideoFile: null,
            // Multi-drive support
            driveId: this.currentDriveId,
            compoundKey: this.getCompoundKey(eventName),
            driveLabel: this.currentDriveLabel,
            driveColor: this.currentDriveColor
        };

        // Collect all files
        const files = [];
        for await (const entry of eventHandle.values()) {
            if (entry.kind === 'file') {
                files.push(entry);
            }
        }

        // Parse files
        for (const fileHandle of files) {
            const fileName = fileHandle.name;

            if (fileName === 'event.json') {
                // Read metadata
                try {
                    const file = await fileHandle.getFile();
                    const text = await file.text();
                    event.metadata = JSON.parse(text);
                } catch (error) {
                    console.error(`Error reading ${fileName}:`, error);
                }
            } else if (fileName === 'thumb.png') {
                event.thumbnailFile = fileHandle;
                console.log(`[Parser] Found thumb.png for ${event.name}`);
            } else if (fileName === 'event.mp4') {
                event.eventVideoFile = fileHandle;
                console.log(`[Parser] Found event.mp4 for ${event.name}`);
            } else if (fileName.endsWith('.mp4')) {
                // Parse video clip filename
                const clipMatch = fileName.match(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(front|back|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$/);
                if (clipMatch) {
                    const [_, clipTimestamp, camera] = clipMatch;
                    event.clips.push({
                        timestamp: clipTimestamp,
                        camera: camera,
                        fileName: fileName,
                        fileHandle: fileHandle
                    });
                }
            }
        }

        // Group clips by timestamp
        event.clipGroups = this.groupClips(event.clips);

        // Sort clip groups chronologically
        event.clipGroups.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        // Detect if this event has pillar cameras (6-camera system)
        event.hasPillarCameras = event.clips.some(clip =>
            clip.camera === 'left_pillar' || clip.camera === 'right_pillar'
        );

        // Mark events with no usable video clips
        event.isEmpty = event.clipGroups.length === 0;

        return event;
    }

    /**
     * Group clips by timestamp (same timestamp = all 4 cameras)
     * @param {Array} clips
     * @returns {Array} Clip groups
     */
    groupClips(clips) {
        const groups = new Map();

        for (const clip of clips) {
            if (!groups.has(clip.timestamp)) {
                groups.set(clip.timestamp, {
                    timestamp: clip.timestamp,
                    clips: {}
                });
            }
            groups.get(clip.timestamp).clips[clip.camera] = clip;
        }

        return Array.from(groups.values());
    }

    /**
     * Detect gaps in recording for an event's clip groups
     * @param {Array} clipGroups - Sorted array of clip groups
     * @returns {Array} Array of gap objects { startTime, endTime, duration, afterClipIndex }
     */
    detectGaps(clipGroups) {
        const gaps = [];
        const EXPECTED_CLIP_DURATION = 60; // seconds
        // Increased threshold to 30 seconds to reduce false positives from clip duration variance
        // Tesla clips may vary slightly from 60 seconds, so only flag significant gaps
        const GAP_THRESHOLD = 30; // seconds - gaps smaller than this are ignored

        for (let i = 0; i < clipGroups.length - 1; i++) {
            const currentClip = clipGroups[i];
            const nextClip = clipGroups[i + 1];

            // Parse timestamps
            const currentTime = this.parseClipTimestamp(currentClip.timestamp);
            const nextTime = this.parseClipTimestamp(nextClip.timestamp);

            if (!currentTime || !nextTime) continue;

            // Calculate expected next clip time (current + 60 seconds)
            const expectedNextTime = new Date(currentTime.getTime() + EXPECTED_CLIP_DURATION * 1000);

            // Calculate the gap
            const gapDuration = (nextTime - expectedNextTime) / 1000; // in seconds

            if (gapDuration > GAP_THRESHOLD) {
                gaps.push({
                    startTime: expectedNextTime,
                    endTime: nextTime,
                    duration: gapDuration,
                    afterClipIndex: i,
                    formattedDuration: this.formatGapDuration(gapDuration)
                });
            }
        }

        return gaps;
    }

    /**
     * Parse clip timestamp string to Date object
     * @param {string} timestamp - Format: YYYY-MM-DD_HH-MM-SS
     * @returns {Date|null}
     */
    parseClipTimestamp(timestamp) {
        const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
        if (!match) return null;

        const [_, year, month, day, hour, minute, second] = match;
        return new Date(
            parseInt(year),
            parseInt(month) - 1,
            parseInt(day),
            parseInt(hour),
            parseInt(minute),
            parseInt(second)
        );
    }

    /**
     * Format gap duration for display
     * @param {number} seconds
     * @returns {string}
     */
    formatGapDuration(seconds) {
        if (seconds < 60) {
            return `${Math.round(seconds)}s`;
        } else if (seconds < 3600) {
            const mins = Math.floor(seconds / 60);
            const secs = Math.round(seconds % 60);
            return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
        } else {
            const hours = Math.floor(seconds / 3600);
            const mins = Math.floor((seconds % 3600) / 60);
            return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
        }
    }

    /**
     * Create object URL for a file handle
     * @param {FileSystemFileHandle} fileHandle
     * @returns {Promise<string>} Object URL
     */
    async createObjectURL(fileHandle) {
        const file = await fileHandle.getFile();
        return URL.createObjectURL(file);
    }

    /**
     * Get thumbnail URL for an event
     * @param {Object} event
     * @returns {Promise<string|null>}
     */
    async getThumbnailURL(event) {
        if (event.thumbnailFile) {
            return await this.createObjectURL(event.thumbnailFile);
        }
        return null;
    }

    /**
     * Get video file handle for a specific clip and camera
     * @param {Object} event
     * @param {number} clipIndex
     * @param {string} camera
     * @returns {FileSystemFileHandle|null}
     */
    getClipFileHandle(event, clipIndex, camera) {
        if (clipIndex < 0 || clipIndex >= event.clipGroups.length) {
            return null;
        }
        const clipGroup = event.clipGroups[clipIndex];
        return clipGroup.clips[camera]?.fileHandle || null;
    }

    /**
     * Format event reason for display
     * @param {string} reason
     * @returns {string}
     */
    static formatReason(reason) {
        if (!reason) return 'Unknown';

        const reasonMap = {
            'user_interaction_dashcam_launcher_action_tapped': 'Manual Save',
            'sentry_aware_object_detection': 'Sentry: Object Detected',
            'sentry_aware_accel': 'Sentry: Vehicle Bumped'
        };

        // Check for partial matches
        for (const [key, value] of Object.entries(reasonMap)) {
            if (reason.includes(key)) {
                // For accel, include the value
                if (key === 'sentry_aware_accel') {
                    const accelMatch = reason.match(/sentry_aware_accel_([\d.]+)/);
                    if (accelMatch) {
                        return `${value} (${accelMatch[1]}g)`;
                    }
                }
                return value;
            }
        }

        // Return cleaned up version
        return reason.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    }
}
