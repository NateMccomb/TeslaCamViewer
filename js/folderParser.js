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

        // Tesla-encrypted events per drive (key: driveId, or '' for a single
        // folder), for the "encrypted by Tesla" notice. Filled by parseFolder.
        this.encryptedByDrive = new Map();
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

        // Debug stats
        this._debugStats = {
            directoriesScanned: 0,
            filesFound: 0,
            videoFilesFound: 0,
            eventJsonRead: 0,
            eventJsonFailed: 0,
            thumbnailsFound: 0,
            eventsCreated: 0,
            emptyEvents: 0,
            errors: []
        };

        console.log('[FolderParser] Starting parse of:', this.rootHandle.name);
        const startTime = performance.now();

        // Recursively search for TeslaCam event folders
        await this.searchDirectory(this.rootHandle, 0, this.rootHandle.name === 'EncryptedClips');

        // Tesla-encrypted events (firmware 2026.20+) can't play here: take them
        // out of the list and keep them for the "encrypted by Tesla" notice.
        const split = await this._splitEncryptedEvents(this.events);
        this.events = split.plain;
        this._recordEncrypted(split.encrypted);
        this._debugStats.encryptedEvents = split.encrypted.length;

        // Sort events by timestamp (newest first)
        this.events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

        // Log summary
        console.log('[FolderParser] === Parse Summary ===');
        console.log(`[FolderParser] Root folder: ${this.rootHandle.name}`);
        console.log(`[FolderParser] Time elapsed: ${elapsed}s`);
        console.log(`[FolderParser] Directories scanned: ${this._debugStats.directoriesScanned}`);
        console.log(`[FolderParser] Total files found: ${this._debugStats.filesFound}`);
        console.log(`[FolderParser] Video files (.mp4): ${this._debugStats.videoFilesFound}`);
        console.log(`[FolderParser] Events created: ${this._debugStats.eventsCreated}`);
        console.log(`[FolderParser] - With metadata (event.json): ${this._debugStats.eventJsonRead}`);
        console.log(`[FolderParser] - Metadata read failed: ${this._debugStats.eventJsonFailed}`);
        console.log(`[FolderParser] - With thumbnails: ${this._debugStats.thumbnailsFound}`);
        console.log(`[FolderParser] - Empty (no clips): ${this._debugStats.emptyEvents}`);

        if (this._debugStats.errors.length > 0) {
            console.warn(`[FolderParser] Errors encountered (${this._debugStats.errors.length}):`);
            this._debugStats.errors.slice(0, 10).forEach(err => console.warn(`  - ${err}`));
            if (this._debugStats.errors.length > 10) {
                console.warn(`  ... and ${this._debugStats.errors.length - 10} more`);
            }
        }
        console.log('[FolderParser] === End Summary ===');

        // Store last diagnostic info for user access
        this._lastDiagnostics = {
            timestamp: new Date().toISOString(),
            rootFolder: this.rootHandle.name,
            elapsedSeconds: elapsed,
            stats: { ...this._debugStats },
            hasErrors: this._debugStats.errors.length > 0,
            userAgent: navigator.userAgent,
            platform: navigator.platform
        };

        return this.events;
    }

    /**
     * Get formatted diagnostic report for bug reporting
     * @returns {string} Formatted diagnostic text
     */
    getDiagnosticReport() {
        if (!this._lastDiagnostics) {
            return 'No parse data available. Please load a TeslaCam folder first.';
        }

        const d = this._lastDiagnostics;
        const s = d.stats;

        let report = `=== TeslaCamViewer Diagnostic Report ===
Generated: ${d.timestamp}
App Version: ${window.app?.versionManager?.currentVersion || 'Unknown'}

--- Environment ---
Platform: ${d.platform}
User Agent: ${d.userAgent}

--- Parse Results ---
Root Folder: ${d.rootFolder}
Parse Time: ${d.elapsedSeconds}s
Directories Scanned: ${s.directoriesScanned}
Total Files Found: ${s.filesFound}
Video Files (.mp4): ${s.videoFilesFound}

--- Events ---
Events Created: ${s.eventsCreated}
With Metadata: ${s.eventJsonRead}
Metadata Failed: ${s.eventJsonFailed}
With Thumbnails: ${s.thumbnailsFound}
Empty Events: ${s.emptyEvents}
`;

        if (s.errors.length > 0) {
            report += `
--- Errors (${s.errors.length}) ---
${s.errors.slice(0, 20).join('\n')}`;
            if (s.errors.length > 20) {
                report += `\n... and ${s.errors.length - 20} more errors`;
            }
        } else {
            report += `
--- Errors ---
None`;
        }

        report += `
========================================`;

        return report;
    }

    /**
     * Get diagnostic summary object for UI display
     * @returns {Object|null} Summary object or null if no data
     */
    getDiagnosticSummary() {
        return this._lastDiagnostics || null;
    }

    /**
     * Recursively search directory for event folders
     * @param {FileSystemDirectoryHandle} dirHandle
     * @param {number} depth - Current depth (limit recursion)
     */
    async searchDirectory(dirHandle, depth, inEncrypted = false, typeHint = null) {
        // Events found anywhere under TeslaCam/EncryptedClips/ are marked, so
        // the header check can treat that folder as a strong hint.
        const firstNew = this.events.length;
        try {
            await this._searchDirectory(dirHandle, depth, inEncrypted || dirHandle.name === 'EncryptedClips', typeHint);
        } finally {
            if (inEncrypted || dirHandle.name === 'EncryptedClips') {
                for (let i = firstNew; i < this.events.length; i++) this.events[i].inEncryptedFolder = true;
            }
        }
    }

    async _searchDirectory(dirHandle, depth, inEncrypted, typeHint = null) {
        // Limit recursion depth to prevent infinite loops
        if (depth > 10) {
            console.warn(`[FolderParser] Max depth reached at: ${dirHandle.name}`);
            return;
        }

        if (this._debugStats) {
            this._debugStats.directoriesScanned++;
        }

        // A type folder picked directly (SentryClips, SavedClips, RecentClips, or a renamed
        // copy such as "SentryClips (1)") is parsed as that type, so Sentry events keep their
        // type (#533). A folder whose name says Sentry/Saved/Recent passes that down as a hint.
        const dirType = FolderParser.typeFromFolderName(dirHandle.name);
        if (dirType && FolderParser.TYPE_FOLDER_RE.test(dirHandle.name)) {
            await this.parseEventFolder(dirHandle, dirType);
            return;
        }
        typeHint = dirType || typeHint;

        // Check if this directory contains Tesla clips (is an event folder). Other .mp4 files
        // (a user's own export lying in a parent folder) don't make it one (#533).
        let hasVideoClips = false;
        let videoClips = [];
        try {
            for await (const entry of dirHandle.values()) {
                if (entry.kind === 'file' && (FolderParser.CLIP_NAME_RE.test(entry.name) || entry.name === 'event.mp4')) {
                    hasVideoClips = true;
                    videoClips.push(entry);
                }
            }
        } catch (iterError) {
            const errMsg = `Failed to iterate directory "${dirHandle.name}": ${iterError.message}`;
            console.error('[FolderParser]', errMsg);
            if (this._debugStats) {
                this._debugStats.errors.push(errMsg);
            }
            return;
        }

        // If this folder has video clips, try to parse it as an event
        if (hasVideoClips) {
            if (FolderParser.typeFromFolderName(dirHandle.name) === 'RecentClips') {
                // A (renamed) RecentClips folder: flat clips, grouped by hour
                await this.parseRecentClips(dirHandle);
                return;
            }
            // Event folder: its type comes from a parent's name (SentryClips, "Sentry backup"...)
            const folderType = (typeHint && typeHint !== 'RecentClips') ? typeHint : 'SavedClips';

            // Try parsing as event
            const event = await this.parseEvent(dirHandle, folderType);
            if (event) {
                this.events.push(event);
                return; // Don't recurse into event folders
            }
            // Not an event folder after all: look in its subfolders too
        }

        // Otherwise, look for subdirectories
        try {
            for await (const entry of dirHandle.values()) {
                if (entry.kind === 'directory') {
                    const folderName = entry.name;

                    // Check if this is an event folder type
                    if (['SavedClips', 'SentryClips', 'RecentClips'].includes(folderName)) {
                        console.log(`[FolderParser] Found ${folderName} folder`);
                        const firstNew = this.events.length;
                        await this.parseEventFolder(entry, folderName);
                        if (inEncrypted) {
                            for (let i = firstNew; i < this.events.length; i++) this.events[i].inEncryptedFolder = true;
                        }
                    } else {
                        // Recursively search subdirectories
                        await this.searchDirectory(entry, depth + 1, inEncrypted, typeHint);
                    }
                }
            }
        } catch (iterError) {
            const errMsg = `Failed to iterate subdirectories in "${dirHandle.name}": ${iterError.message}`;
            console.error('[FolderParser]', errMsg);
            if (this._debugStats) {
                this._debugStats.errors.push(errMsg);
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
        try {
            for await (const entry of folderHandle.values()) {
                if (entry.kind === 'file' && entry.name.endsWith('.mp4')) {
                    if (this._debugStats) {
                        this._debugStats.filesFound++;
                        this._debugStats.videoFilesFound++;
                    }
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
        } catch (iterError) {
            const errMsg = `Failed to iterate RecentClips: ${iterError.message}`;
            console.error('[FolderParser]', errMsg);
            if (this._debugStats) {
                this._debugStats.errors.push(errMsg);
            }
            return;
        }

        console.log(`[FolderParser] RecentClips: found ${clips.length} video files`);

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

            // The name is the key notes and bookmarks are stored under. It's built from the
            // file names only (the car's local time), so it's the same in every time zone (#531).
            const eventName = FolderParser.recentClipsEventName(group.datePart, group.hour);
            // Before 2026.47.5 the name came from new Date('YYYY-MM-DD'), which is UTC midnight:
            // west of UTC that named the hour after the previous day. Notes and bookmarks saved
            // then are still found under that name (see migrateLegacyEventKeys).
            const legacyName = FolderParser.legacyRecentClipsEventName(group.datePart, group.hour);
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
                // RecentClips is one flat folder shared by every hour: this event is only the
                // files listed in clips (Drive Sync and the notes backup use this, #535)
                flatFolder: true,
                legacyName: legacyName !== eventName ? legacyName : null,
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

            // Track stats
            if (this._debugStats) {
                this._debugStats.eventsCreated++;
            }
        }

        console.log(`[FolderParser] RecentClips: created ${hourlyGroups.size} hourly event groups`);
    }

    /**
     * Parse individual event directory
     * @param {FileSystemDirectoryHandle} eventHandle
     * @param {string} folderType
     * @returns {Promise<Object|null>} Event object or null if invalid
     */
    async parseEvent(eventHandle, folderType) {
        const eventName = eventHandle.name;

        // Extract timestamp from folder name (YYYY-MM-DD_HH-MM-SS). Copies renamed by the OS
        // ("... (1)", "... - Copy", "... copy 2") are events too (#533).
        const timestampMatch = eventName.match(FolderParser.EVENT_FOLDER_RE);
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
        try {
            for await (const entry of eventHandle.values()) {
                if (entry.kind === 'file') {
                    files.push(entry);
                    if (this._debugStats) {
                        this._debugStats.filesFound++;
                    }
                }
            }
        } catch (iterError) {
            const errMsg = `Failed to list files in event "${eventName}": ${iterError.message}`;
            console.error('[FolderParser]', errMsg);
            if (this._debugStats) {
                this._debugStats.errors.push(errMsg);
            }
            return null;
        }

        // Parse files
        for (const fileHandle of files) {
            const fileName = fileHandle.name;

            if (fileName === 'event.json') {
                // Read metadata
                let file = null;
                try {
                    file = await fileHandle.getFile();
                    const text = await file.text();
                    event.metadata = FolderParser.sanitizeMetadata(JSON.parse(text));
                    if (this._debugStats) {
                        this._debugStats.eventJsonRead++;
                    }
                } catch (error) {
                    // Tesla encrypts event.json too (firmware 2026.20+). That's
                    // expected, not an error: the event is set aside as encrypted.
                    let encrypted = false;
                    try {
                        if (file && file.size >= 0x2000) {
                            const head = await file.slice(0, 0x1100).arrayBuffer();
                            encrypted = FolderParser.classifyClipHeader(head, file.size).kind === 'encrypted';
                        }
                    } catch (e) { /* fall through to the normal error */ }
                    if (encrypted) {
                        event.metadataEncrypted = true;
                        if (this._debugStats) this._debugStats.eventJsonEncrypted = (this._debugStats.eventJsonEncrypted || 0) + 1;
                        continue;
                    }
                    const errMsg = `Failed to read event.json in "${eventName}": ${error.message}`;
                    console.error('[FolderParser]', errMsg);
                    if (this._debugStats) {
                        this._debugStats.eventJsonFailed++;
                        this._debugStats.errors.push(errMsg);
                    }
                }
            } else if (fileName === 'thumb.png') {
                event.thumbnailFile = fileHandle;
                if (this._debugStats) {
                    this._debugStats.thumbnailsFound++;
                }
            } else if (fileName === 'event.mp4') {
                event.eventVideoFile = fileHandle;
            } else if (fileName.endsWith('.mp4')) {
                if (this._debugStats) {
                    this._debugStats.videoFilesFound++;
                }
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

        // Track stats
        if (this._debugStats) {
            this._debugStats.eventsCreated++;
            if (event.isEmpty) {
                this._debugStats.emptyEvents++;
            }
        }

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
    /**
     * Tesla clip file name: YYYY-MM-DD_HH-MM-SS-camera.mp4
     */
    static get CLIP_NAME_RE() {
        return /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-(front|back|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$/;
    }

    /**
     * Event folder name, also when the OS renamed a copy: "(1)", " - Copy", " - Copy (2)", " copy", " copy 2"
     */
    static get EVENT_FOLDER_RE() {
        return /^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})(?: ?\(\d{1,3}\)| - Copy(?: \(\d{1,3}\))?| copy(?: \d{1,3})?)?$/;
    }

    /**
     * A Tesla type folder, or an OS-renamed copy of one
     */
    static get TYPE_FOLDER_RE() {
        return /^(SavedClips|SentryClips|RecentClips)(?: ?\(\d{1,3}\)| - Copy(?: \(\d{1,3}\))?| copy(?: \d{1,3})?)?$/;
    }

    /**
     * Clip type a folder name points to ('SentryClips' for "SentryClips", "Sentry backup", ...)
     * @param {string} name
     * @returns {string|null}
     */
    static typeFromFolderName(name) {
        if (typeof name !== 'string') return null;
        if (name.includes('Sentry')) return 'SentryClips';
        if (name.includes('Recent')) return 'RecentClips';
        if (name.includes('Saved')) return 'SavedClips';
        return null;
    }

    /**
     * RecentClips hour name from the clip file names: "Recent: 2026-11-17 15:00-15:59".
     * No Date object, so no time zone can move it to another day.
     * @param {string} datePart 'YYYY-MM-DD'
     * @param {string} hour 'HH'
     * @returns {string}
     */
    static recentClipsEventName(datePart, hour) {
        return `Recent: ${datePart} ${hour}:00-${hour}:59`;
    }

    /**
     * The name the same hour had before 2026.47.5 (the date via new Date('YYYY-MM-DD'), i.e. UTC
     * midnight shown in local time, plus a 12 h range). Only used to find notes and bookmarks
     * saved under it.
     * @param {string} datePart
     * @param {string} hour
     * @returns {string}
     */
    static legacyRecentClipsEventName(datePart, hour) {
        const hourNum = parseInt(hour, 10);
        const hour12 = hourNum === 0 ? 12 : (hourNum > 12 ? hourNum - 12 : hourNum);
        const ampm = hourNum >= 12 ? 'PM' : 'AM';
        const dateStr = new Date(datePart).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return `Recent: ${dateStr} ${hour12}:00-${hour12}:59 ${ampm}`;
    }

    /**
     * The storage key an event had under its legacy name, built the same way as its current key
     * (driveId:name or just name).
     * @param {Object} event
     * @returns {string|null}
     */
    static legacyEventKey(event) {
        if (!event || !event.legacyName) return null;
        const key = event.compoundKey || event.name;
        if (typeof key === 'string' && key.endsWith(event.name)) {
            return key.slice(0, key.length - event.name.length) + event.legacyName;
        }
        return event.legacyName;
    }

    /**
     * Copy notes and bookmarks saved under an event's legacy key to its current key (#531).
     * Copy, not move: the old entry stays readable (an older version or a backup still finds it).
     * New names never look like legacy names, so a legacy key can't be mistaken for another
     * event's current key. Never overwrites data already under the current key. Idempotent.
     * @param {Array} events
     * @param {Storage} [storage]
     * @returns {number} entries copied
     */
    static migrateLegacyEventKeys(events, storage) {
        const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
        if (!store || !Array.isArray(events)) return 0;
        const withLegacy = events.filter(e => e && e.legacyName);
        if (withLegacy.length === 0) return 0;
        let copied = 0;
        for (const storeKey of ['teslacamviewer_notes', 'teslacamviewer_bookmarks']) {
            let data;
            try {
                data = JSON.parse(store.getItem(storeKey) || 'null');
            } catch (e) {
                continue;
            }
            if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
            let changed = false;
            for (const event of withLegacy) {
                const oldKey = FolderParser.legacyEventKey(event);
                const newKey = event.compoundKey || event.name;
                const has = k => Object.prototype.hasOwnProperty.call(data, k);
                if (oldKey && oldKey !== newKey && has(oldKey) && !has(newKey)) {
                    data[newKey] = data[oldKey];
                    changed = true;
                    copied++;
                }
            }
            if (changed) {
                try {
                    store.setItem(storeKey, JSON.stringify(data));
                } catch (e) {
                    console.warn('[FolderParser] Unable to save migrated keys:', e);
                }
            }
        }
        if (copied > 0) console.log(`[FolderParser] RecentClips: ${copied} notes/bookmark entries found under their old hour names`);
        return copied;
    }

    /**
     * event.json is read from the drive and may come from other tools: text fields that
     * aren't text broke the whole event list (#530). Numbers become text, anything else is dropped.
     * @param {*} meta
     * @returns {Object|null}
     */
    static sanitizeMetadata(meta) {
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
        const out = {};
        for (const [k, v] of Object.entries(meta)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            if (v === null || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
            else if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : null;
            else if (typeof v === 'object') out[k] = v; // nested data some tools add; never rendered as text
        }
        for (const k of ['reason', 'city', 'street', 'camera', 'timestamp']) {
            if (k in out && out[k] !== null && typeof out[k] !== 'string') {
                out[k] = (typeof out[k] === 'number' || typeof out[k] === 'boolean') ? String(out[k]) : null;
            }
        }
        return out;
    }

    static formatReason(reason) {
        if (reason === null || reason === undefined || reason === '') return 'Unknown';
        if (typeof reason !== 'string') reason = String(reason); // event.json from other tools (#530)

        // Known reasons in the chosen language (locale files: events.reasons.*), English if i18n isn't loaded
        const tr = (key, english) => {
            const t = (typeof window !== 'undefined' && window.i18n) ? window.i18n.t(key) : key;
            return t === key ? english : t;
        };
        // RecentClips hours: the event data keeps "N clips from 6:00-6:59 PM"; show it in the chosen language
        const rc = reason.match(/^(\d+) clips from (\d{1,2}):00-\d{1,2}:59 (AM|PM)$/);
        if (rc && typeof window !== 'undefined' && window.i18n) {
            let range = `${rc[2]}:00-${rc[2]}:59 ${rc[3]}`;
            if (window.i18n.getLocale() !== 'en') {
                const h = (Number(rc[2]) % 12) + (rc[3] === 'PM' ? 12 : 0);
                const at = (m) => new Date(2000, 0, 1, h, m).toLocaleTimeString(window.i18n.dateLocale(), { hour: 'numeric', minute: '2-digit' });
                range = `${at(0)}-${at(59)}`;
            }
            return window.i18n.plural('events.reasons.recentClips', Number(rc[1]), { range });
        }
        const reasonMap = {
            'user_interaction_dashcam_launcher_action_tapped': tr('events.reasons.manualSave', 'Manual Save'),
            'sentry_aware_object_detection': tr('events.reasons.objectDetected', 'Sentry: Object Detected'),
            'sentry_aware_accel': tr('events.reasons.vehicleBumped', 'Sentry: Vehicle Bumped')
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

    /**
     * Escape text for use inside HTML (element content or a quoted attribute).
     * Everything read from a drive (event.json fields such as city, street,
     * reason and camera, and folder names) is untrusted: a crafted USB stick
     * or shared folder must not be able to inject markup or script.
     * @param {*} value
     * @returns {string}
     */
    /**
     * What a clip file really is, from its first 0x1100 bytes.
     *
     * Tesla firmware 2026.20+ encrypts dashcam clips by default. They keep the
     * .mp4 name but are wrapped in an eCryptfs-style container: no `ftyp`,
     * two 4096-byte header pages, AES-128-CBC after 0x2000. The layout below
     * comes from Tesla's own dashcam.tesla.com viewer code as published by
     * three independent decryptors (not yet checked on a clip from a real car):
     *   0x00 u64 plaintext size   0x08/0x0C two marker words, XOR = 0x3C81B7F5
     *   0x10 u32 0x03000002       0x14 u32 0x1000 (page size / metadata offset)
     *   0x1000 key-escrow page: all zero when only the car can decrypt it.
     * The VIN in the escrow page is never read here.
     *
     * @param {ArrayBuffer} buf  the start of the file (0x1100 bytes, or less if the file is shorter)
     * @param {number} fileSize
     * @param {boolean} [inEncryptedFolder]  the file sits under TeslaCam/EncryptedClips/
     * @returns {{kind: 'mp4'|'encrypted'|'unknown', carOnly?: boolean, damaged?: boolean}}
     */
    static classifyClipHeader(buf, fileSize, inEncryptedFolder = false) {
        const b = new Uint8Array(buf || new ArrayBuffer(0));
        if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
            return { kind: 'mp4' };   // 'ftyp': a normal (or already decrypted) MP4
        }
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const u32 = (o) => (b.length >= o + 4 ? dv.getUint32(o) : null);
        const marker = u32(8) !== null && u32(12) !== null && ((u32(8) ^ u32(12)) >>> 0) === 0x3C81B7F5;
        const page = u32(0x14) === 0x1000;
        const signed = (marker && page) || (inEncryptedFolder && (marker || page));
        if (!signed) {
            // Under EncryptedClips/ but neither an MP4 nor a container we know:
            // still not playable, so list it with the encrypted ones.
            return inEncryptedFolder ? { kind: 'encrypted', carOnly: false, damaged: true } : { kind: 'unknown' };
        }
        const plain = b.length >= 8 ? Number(dv.getBigUint64(0)) : 0;
        const damaged = !(fileSize >= 0x2000 && fileSize % 0x1000 === 0 && plain > 0 && plain <= fileSize - 0x2000
            && u32(0x10) === 0x03000002 && b.length >= 0x1010);
        let carOnly = false;
        if (b.length >= 0x1010) {
            carOnly = true;
            for (let i = 0x1000; i < 0x1010; i++) if (b[i] !== 0) { carOnly = false; break; }
        }
        return { kind: 'encrypted', carOnly, damaged };
    }

    /**
     * Split events into playable ones and Tesla-encrypted ones by checking the
     * header of one clip per event (about 4 KB read each).
     * @param {Array} events
     * @returns {Promise<{plain: Array, encrypted: Array}>}
     * @private
     */
    async _splitEncryptedEvents(events) {
        const plain = [], encrypted = [];
        const pickClip = (ev) => {
            for (const g of ev.clipGroups || []) {
                const c = g.clips && (g.clips.front || Object.values(g.clips)[0]);
                if (c && c.fileHandle) return c;
            }
            return null;
        };
        const check = async (ev) => {
            const clip = pickClip(ev);
            if (!clip) return ev.inEncryptedFolder ? { kind: 'encrypted', carOnly: false, damaged: true } : { kind: 'unknown' };
            try {
                const file = await clip.fileHandle.getFile();
                const head = await file.slice(0, 0x1100).arrayBuffer();
                return FolderParser.classifyClipHeader(head, file.size, !!ev.inEncryptedFolder);
            } catch (e) {
                return ev.inEncryptedFolder ? { kind: 'encrypted', carOnly: false, damaged: true } : { kind: 'unknown' };
            }
        };
        const BATCH = 24;
        for (let i = 0; i < events.length; i += BATCH) {
            const slice = events.slice(i, i + BATCH);
            const results = await Promise.all(slice.map(check));
            slice.forEach((ev, k) => {
                const r = results[k];
                if (r.kind === 'encrypted') {
                    ev.encryption = { carOnly: !!r.carOnly, damaged: !!r.damaged };
                    encrypted.push(ev);
                } else {
                    plain.push(ev);
                }
            });
        }
        if (encrypted.length) {
            console.log(`[FolderParser] ${encrypted.length} event(s) are encrypted by Tesla and were left out of the list`);
        }
        return { plain, encrypted };
    }

    /** @private */
    _recordEncrypted(encrypted) {
        const key = this.currentDriveId || '';
        if (!this.currentDriveId) this.encryptedByDrive.clear();   // a single folder replaces everything
        this.encryptedByDrive.set(key, {
            driveId: this.currentDriveId,
            driveLabel: this.currentDriveLabel || (this.rootHandle && this.rootHandle.name) || '',
            events: encrypted
        });
    }

    /**
     * Forget a removed drive's encrypted events.
     * @param {string} driveId
     */
    forgetEncrypted(driveId) {
        this.encryptedByDrive.delete(driveId || '');
    }

    /**
     * Counts for the notice: all drives, or only activeDriveId.
     * @param {string|null} activeDriveId
     * @returns {{total: number, carOnly: number, damaged: number, saved: number, sentry: number, recent: number, drives: string[]}}
     */
    getEncryptedSummary(activeDriveId = null) {
        const out = { total: 0, carOnly: 0, damaged: 0, saved: 0, sentry: 0, recent: 0, drives: [] };
        for (const [key, entry] of this.encryptedByDrive) {
            if (activeDriveId && key !== activeDriveId) continue;
            if (!entry.events.length) continue;
            out.drives.push(entry.driveLabel);
            for (const ev of entry.events) {
                out.total++;
                if (ev.encryption?.carOnly) out.carOnly++;
                if (ev.encryption?.damaged) out.damaged++;
                if (ev.type === 'SavedClips') out.saved++;
                else if (ev.type === 'SentryClips') out.sentry++;
                else if (ev.type === 'RecentClips') out.recent++;
            }
        }
        return out;
    }

    static escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
}
