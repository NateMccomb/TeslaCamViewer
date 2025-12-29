/**
 * DriveSync - Compare and synchronize TeslaCam footage between drives
 */

class DriveSync {
    constructor(folderManager, notesManager) {
        this.folderManager = folderManager;
        this.notesManager = notesManager;

        // Drive references
        this.sourceDrive = null;
        this.destDrive = null;

        // State
        this.state = {
            status: 'idle', // idle, comparing, syncing, paused, verifying, complete, error
            currentEvent: null,
            currentFile: null,
            eventsTotal: 0,
            eventsCompleted: 0,
            bytesTotal: 0,
            bytesCompleted: 0,
            currentFileBytes: 0,
            currentFileTotal: 0,
            startTime: null,
            errors: [],
            canResume: false,
            resumePoint: null
        };

        // Comparison results
        this.comparisonResults = null;

        // Abort controller for cancellation
        this.abortController = null;
        this.isPaused = false;
        this.pauseResolve = null;

        // Callbacks
        this.onProgressCallback = null;
        this.onCompleteCallback = null;
        this.onErrorCallback = null;
        this.onStateChangeCallback = null;

        // Settings
        this.settings = this.loadSettings();

        // Presets
        this.presets = this.loadPresets();

        // Constants
        this.CHECKSUM_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB
        this.SYNC_SETTINGS_FILENAME = '.teslacam-sync.json';
        this.USERDATA_BACKUP_FILENAME = '.teslacam-userdata.json';
        this.PRESETS_STORAGE_KEY = 'teslacamviewer_sync_presets';
    }

    // ========================================
    // Settings Management
    // ========================================

    loadSettings() {
        const defaults = {
            defaultMode: 'copy',
            verifyAfterCopy: true,
            syncNotes: true,
            noteConflictMode: 'ask', // 'ask' or 'merge'
            writeSyncFile: true,
            showSameFiles: false,
            confirmBeforeDelete: true,
            autoRequestNotifications: true
        };

        try {
            const saved = localStorage.getItem('teslacamviewer_sync_settings');
            if (saved) {
                return { ...defaults, ...JSON.parse(saved) };
            }
        } catch (e) {
            console.error('Failed to load sync settings:', e);
        }

        return defaults;
    }

    saveSettings() {
        try {
            localStorage.setItem('teslacamviewer_sync_settings', JSON.stringify(this.settings));
        } catch (e) {
            console.error('Failed to save sync settings:', e);
        }
    }

    updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        this.saveSettings();
    }

    // ========================================
    // Presets Management
    // ========================================

    loadPresets() {
        try {
            const saved = localStorage.getItem('teslacamviewer_sync_presets');
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (e) {
            console.error('Failed to load sync presets:', e);
        }
        return [];
    }

    savePresets() {
        try {
            localStorage.setItem('teslacamviewer_sync_presets', JSON.stringify(this.presets));
        } catch (e) {
            console.error('Failed to save sync presets:', e);
        }
    }

    addPreset(name, sourceLabel, destLabel) {
        const preset = {
            id: this.generatePresetId(),
            name: name,
            sourceLabel: sourceLabel,
            destLabel: destLabel,
            createdAt: new Date().toISOString(),
            lastUsed: null
        };
        this.presets.push(preset);
        this.savePresets();
        return preset;
    }

    updatePreset(presetId, updates) {
        const preset = this.presets.find(p => p.id === presetId);
        if (preset) {
            Object.assign(preset, updates);
            this.savePresets();
            return preset;
        }
        return null;
    }

    deletePreset(presetId) {
        const index = this.presets.findIndex(p => p.id === presetId);
        if (index !== -1) {
            this.presets.splice(index, 1);
            this.savePresets();
            return true;
        }
        return false;
    }

    getPreset(presetId) {
        return this.presets.find(p => p.id === presetId);
    }

    getAllPresets() {
        return [...this.presets].sort((a, b) => {
            // Sort by last used, then by name
            if (a.lastUsed && b.lastUsed) {
                return new Date(b.lastUsed) - new Date(a.lastUsed);
            }
            if (a.lastUsed) return -1;
            if (b.lastUsed) return 1;
            return a.name.localeCompare(b.name);
        });
    }

    applyPreset(presetId) {
        const preset = this.getPreset(presetId);
        if (!preset) return null;

        // Find drives by label
        const drives = this.folderManager.getDrives();
        const sourceDrive = drives.find(d => d.label === preset.sourceLabel);
        const destDrive = drives.find(d => d.label === preset.destLabel);

        if (sourceDrive && destDrive) {
            this.setSource(sourceDrive.id);
            this.setDestination(destDrive.id);

            // Update last used
            preset.lastUsed = new Date().toISOString();
            this.savePresets();

            return { source: sourceDrive, dest: destDrive };
        }

        return null;
    }

    generatePresetId() {
        return 'preset_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    // Import presets from destination drive's sync file
    async importPresetsFromDrive(drive) {
        try {
            const syncSettings = await this.readSyncSettingsFromDrive(drive);
            if (syncSettings && syncSettings.presets && Array.isArray(syncSettings.presets)) {
                const imported = [];
                for (const preset of syncSettings.presets) {
                    // Check if preset already exists (by name)
                    const exists = this.presets.some(p => p.name === preset.name);
                    if (!exists) {
                        this.presets.push({
                            ...preset,
                            id: this.generatePresetId(),
                            importedFrom: drive.label,
                            importedAt: new Date().toISOString()
                        });
                        imported.push(preset.name);
                    }
                }
                if (imported.length > 0) {
                    this.savePresets();
                }
                return imported;
            }
        } catch (e) {
            console.error('Failed to import presets from drive:', e);
        }
        return [];
    }

    async readSyncSettingsFromDrive(drive) {
        try {
            const fileHandle = await drive.handle.getFileHandle(this.SYNC_SETTINGS_FILENAME);
            const file = await fileHandle.getFile();
            const text = await file.text();
            return JSON.parse(text);
        } catch (e) {
            // File doesn't exist
            return null;
        }
    }

    // ========================================
    // Drive Selection
    // ========================================

    setSource(driveId) {
        const drive = this.folderManager.drives.find(d => d.id === driveId);
        if (!drive) throw new Error('Source drive not found');
        this.sourceDrive = drive;
        return drive;
    }

    setDestination(driveId) {
        const drive = this.folderManager.drives.find(d => d.id === driveId);
        if (!drive) throw new Error('Destination drive not found');
        this.destDrive = drive;
        return drive;
    }

    async requestWritePermission(drive) {
        if (!drive || !drive.handle) {
            throw new Error('Invalid drive');
        }

        const permission = await drive.handle.requestPermission({ mode: 'readwrite' });
        if (permission !== 'granted') {
            throw new Error('Write permission denied for ' + (drive.label || drive.folderName));
        }
        return true;
    }

    async ensurePermissions() {
        // Check source read permission
        const sourcePermission = await this.sourceDrive.handle.queryPermission({ mode: 'read' });
        if (sourcePermission !== 'granted') {
            await this.sourceDrive.handle.requestPermission({ mode: 'read' });
        }

        // Check destination write permission
        const destPermission = await this.destDrive.handle.queryPermission({ mode: 'readwrite' });
        if (destPermission !== 'granted') {
            await this.requestWritePermission(this.destDrive);
        }
    }

    // ========================================
    // Comparison Logic
    // ========================================

    async compareEvents() {
        if (!this.sourceDrive || !this.destDrive) {
            throw new Error('Both source and destination drives must be selected');
        }

        this.setState({ status: 'comparing' });

        try {
            const sourceEvents = this.sourceDrive.events || [];
            const destEvents = this.destDrive.events || [];

            // Build lookup maps
            const sourceMap = new Map();
            const destMap = new Map();

            for (const event of sourceEvents) {
                sourceMap.set(event.name, event);
            }

            for (const event of destEvents) {
                destMap.set(event.name, event);
            }

            // Categorize events
            const results = {
                missing: [],      // On source but not dest
                newer: [],        // Newer on source
                differentSize: [], // Same name, different size
                same: [],         // Identical
                destOnly: [],     // Only on destination

                notesComparison: {
                    sourceOnly: [],
                    destOnly: [],
                    newerOnSource: [],
                    newerOnDest: [],
                    conflict: []
                },

                totalSourceSize: 0,
                totalDestFree: 0,
                selectedSize: 0
            };

            // Compare source events
            for (const [name, sourceEvent] of sourceMap) {
                const destEvent = destMap.get(name);

                if (!destEvent) {
                    // Missing on destination
                    const fingerprint = await this.getEventFingerprint(sourceEvent);
                    results.missing.push({
                        event: sourceEvent,
                        fingerprint,
                        selected: true
                    });
                    results.totalSourceSize += fingerprint.totalSize;
                } else {
                    // Exists on both - compare
                    const sourceFingerprint = await this.getEventFingerprint(sourceEvent);
                    const destFingerprint = await this.getEventFingerprint(destEvent);

                    const comparison = this.compareFingerprints(sourceFingerprint, destFingerprint);

                    if (comparison === 'same') {
                        results.same.push({
                            event: sourceEvent,
                            fingerprint: sourceFingerprint,
                            selected: false
                        });
                    } else if (comparison === 'newer') {
                        results.newer.push({
                            event: sourceEvent,
                            fingerprint: sourceFingerprint,
                            destFingerprint,
                            selected: true
                        });
                        results.totalSourceSize += sourceFingerprint.totalSize;
                    } else if (comparison === 'different_size') {
                        results.differentSize.push({
                            event: sourceEvent,
                            fingerprint: sourceFingerprint,
                            destFingerprint,
                            selected: false
                        });
                    }
                }
            }

            // Find destination-only events
            for (const [name, destEvent] of destMap) {
                if (!sourceMap.has(name)) {
                    const fingerprint = await this.getEventFingerprint(destEvent);
                    results.destOnly.push({
                        event: destEvent,
                        fingerprint,
                        selected: false
                    });
                }
            }

            // Compare notes if enabled
            if (this.settings.syncNotes) {
                results.notesComparison = await this.compareNotes(sourceMap, destMap);
            }

            // Compute comprehensive statistics
            results.statistics = this.computeComparisonStatistics(results, sourceEvents, destEvents);

            this.comparisonResults = results;
            this.setState({ status: 'idle' });

            return results;

        } catch (error) {
            this.setState({ status: 'error' });
            throw error;
        }
    }

    async getEventFingerprint(event) {
        const files = [];

        try {
            for await (const entry of event.folderHandle.values()) {
                if (entry.kind === 'file') {
                    const file = await entry.getFile();
                    files.push({
                        name: entry.name,
                        size: file.size,
                        lastModified: file.lastModified,
                        handle: entry
                    });

                    // Load metadata if not already loaded (for cached events)
                    if (entry.name === 'event.json' && !event.metadata) {
                        try {
                            const text = await file.text();
                            event.metadata = JSON.parse(text);
                        } catch (e) {
                            console.warn('Failed to load event.json:', e);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error getting fingerprint for', event.name, error);
        }

        return {
            name: event.name,
            type: event.type,
            fileCount: files.length,
            totalSize: files.reduce((sum, f) => sum + f.size, 0),
            newestFile: files.length > 0 ? Math.max(...files.map(f => f.lastModified)) : 0,
            files: files.sort((a, b) => a.name.localeCompare(b.name))
        };
    }

    compareFingerprints(source, dest) {
        // Check if same
        if (source.fileCount === dest.fileCount) {
            let allMatch = true;
            let hasNewer = false;
            let hasDifferentSize = false;

            for (let i = 0; i < source.files.length; i++) {
                const sf = source.files[i];
                const df = dest.files.find(f => f.name === sf.name);

                if (!df) {
                    allMatch = false;
                    hasNewer = true;
                    break;
                }

                if (sf.size !== df.size) {
                    allMatch = false;
                    hasDifferentSize = true;
                }

                if (sf.lastModified > df.lastModified) {
                    hasNewer = true;
                }
            }

            if (allMatch && !hasNewer) {
                return 'same';
            } else if (hasNewer) {
                return 'newer';
            } else if (hasDifferentSize) {
                return 'different_size';
            }
        }

        // Different file count means source has more/different files
        return source.fileCount > dest.fileCount ? 'newer' : 'different_size';
    }

    async compareNotes(sourceMap, destMap) {
        const results = {
            sourceOnly: [],
            destOnly: [],
            newerOnSource: [],
            newerOnDest: [],
            conflict: []
        };

        // Get all notes from NotesManager
        const allNotes = this.notesManager.notes || {};

        // Compare notes for each event
        for (const [eventName, sourceEvent] of sourceMap) {
            const sourceKey = sourceEvent.compoundKey || eventName;
            const destEvent = destMap.get(eventName);
            const destKey = destEvent ? (destEvent.compoundKey || eventName) : null;

            const sourceNotes = allNotes[sourceKey];
            const destNotes = destKey ? allNotes[destKey] : null;

            if (sourceNotes && !destNotes) {
                results.sourceOnly.push({
                    eventName,
                    notes: sourceNotes
                });
            } else if (!sourceNotes && destNotes) {
                results.destOnly.push({
                    eventName,
                    notes: destNotes
                });
            } else if (sourceNotes && destNotes) {
                // Both have notes - check for differences
                const sourceText = sourceNotes.text || '';
                const destText = destNotes.text || '';
                const sourceTags = sourceNotes.tags || [];
                const destTags = destNotes.tags || [];

                if (sourceText !== destText ||
                    JSON.stringify(sourceTags.sort()) !== JSON.stringify(destTags.sort())) {
                    // Different - mark as conflict for now
                    // Could add timestamp comparison if we tracked it
                    results.conflict.push({
                        eventName,
                        sourceNotes,
                        destNotes
                    });
                }
            }
        }

        return results;
    }

    // ========================================
    // Comparison Statistics
    // ========================================

    computeComparisonStatistics(results, sourceEvents, destEvents) {
        // Calculate sizes from fingerprints (more accurate than estimates)
        const missingSize = results.missing.reduce((sum, i) => sum + (i.fingerprint?.totalSize || 0), 0);
        const newerSize = results.newer.reduce((sum, i) => sum + (i.fingerprint?.totalSize || 0), 0);
        const sameSize = results.same.reduce((sum, i) => sum + (i.fingerprint?.totalSize || 0), 0);
        const differentSizeAmt = results.differentSize.reduce((sum, i) => sum + (i.fingerprint?.totalSize || 0), 0);
        const destOnlySize = results.destOnly.reduce((sum, i) => sum + (i.fingerprint?.totalSize || 0), 0);

        // Source total = all results that came from source (missing + newer + same + differentSize)
        const sourceTotal = missingSize + newerSize + sameSize + differentSizeAmt;
        // Dest total = same + differentSize + destOnly (events on dest)
        const destTotal = sameSize + differentSizeAmt + destOnlySize;
        const toTransfer = missingSize + newerSize;

        const sourceRange = this.getDateRange(sourceEvents);
        const destRange = this.getDateRange(destEvents);

        const syncPercent = sourceEvents.length > 0
            ? Math.round((results.same.length / sourceEvents.length) * 100)
            : 0;

        const stats = {
            // Overview
            overview: {
                totalSourceEvents: sourceEvents.length,
                totalDestEvents: destEvents.length,
                missingCount: results.missing.length,
                newerCount: results.newer.length,
                differentSizeCount: results.differentSize.length,
                sameCount: results.same.length,
                destOnlyCount: results.destOnly.length,
                syncPercent: syncPercent
            },

            // By event type (using fingerprint data from results)
            byType: {
                source: this.groupResultsByTypeWithSize([...results.missing, ...results.newer, ...results.same, ...results.differentSize]),
                dest: this.groupResultsByTypeWithSize([...results.same, ...results.differentSize, ...results.destOnly]),
                missing: this.groupResultsByType(results.missing),
                newer: this.groupResultsByType(results.newer),
                same: this.groupResultsByType(results.same)
            },

            // Storage (calculated from fingerprints)
            storage: {
                sourceTotal: sourceTotal,
                destTotal: destTotal,
                toTransfer: toTransfer,
                missingSize: missingSize,
                newerSize: newerSize,
                sameSize: sameSize
            },

            // Date ranges (flattened for easy access)
            dateRange: {
                sourceStart: sourceRange.oldest ? new Date(sourceRange.oldest).toLocaleDateString() : null,
                sourceEnd: sourceRange.newest ? new Date(sourceRange.newest).toLocaleDateString() : null,
                destStart: destRange.oldest ? new Date(destRange.oldest).toLocaleDateString() : null,
                destEnd: destRange.newest ? new Date(destRange.newest).toLocaleDateString() : null
            },

            // By location (using results for accurate city data from metadata)
            byLocation: {
                source: this.groupResultsByLocation([...results.missing, ...results.newer, ...results.same, ...results.differentSize]),
                dest: this.groupResultsByLocation([...results.same, ...results.differentSize, ...results.destOnly]),
                missing: this.groupResultsByLocation(results.missing)
            },

            // By month (using results for accurate data)
            byMonth: {
                source: this.groupResultsByMonth([...results.missing, ...results.newer, ...results.same, ...results.differentSize]),
                dest: this.groupResultsByMonth([...results.same, ...results.differentSize, ...results.destOnly]),
                missing: this.groupResultsByMonth(results.missing)
            },

            // Detailed breakdown for sorting/filtering
            detailed: this.computeDetailedBreakdown(results, sourceEvents, destEvents)
        };

        return stats;
    }

    /**
     * Get the city/location from an event
     */
    getEventCity(event) {
        return event.metadata?.city || event.city || 'Unknown';
    }

    /**
     * Get estimated size from an event (use fingerprint if available, else estimate from clips)
     */
    getEventSize(event) {
        if (event.estimatedSize) return event.estimatedSize;
        if (event.fingerprint?.totalSize) return event.fingerprint.totalSize;
        // Estimate ~15MB per clip group (all 4 cameras), ~60 seconds each
        const clipCount = event.clipGroups?.length || event.clips?.length || 0;
        return clipCount * 15 * 1024 * 1024; // 15MB per clip set
    }

    groupEventsByType(events) {
        const groups = {
            SavedClips: { count: 0, size: 0 },
            SentryClips: { count: 0, size: 0 },
            RecentClips: { count: 0, size: 0 }
        };
        for (const event of events) {
            const type = event.type || 'RecentClips';
            if (!groups[type]) groups[type] = { count: 0, size: 0 };
            groups[type].count++;
            groups[type].size += this.getEventSize(event);
        }
        return groups;
    }

    groupResultsByType(items) {
        const groups = {
            SavedClips: { count: 0, size: 0 },
            SentryClips: { count: 0, size: 0 },
            RecentClips: { count: 0, size: 0 }
        };
        for (const item of items) {
            const type = item.event?.type || item.fingerprint?.type || 'RecentClips';
            if (!groups[type]) groups[type] = { count: 0, size: 0 };
            groups[type].count++;
            groups[type].size += item.fingerprint?.totalSize || 0;
        }
        return groups;
    }

    /**
     * Group comparison results by type with accurate size from fingerprints
     */
    groupResultsByTypeWithSize(items) {
        const groups = {
            SavedClips: { count: 0, size: 0 },
            SentryClips: { count: 0, size: 0 },
            RecentClips: { count: 0, size: 0 }
        };
        for (const item of items) {
            const type = item.event?.type || item.fingerprint?.type || 'RecentClips';
            if (!groups[type]) groups[type] = { count: 0, size: 0 };
            groups[type].count++;
            groups[type].size += item.fingerprint?.totalSize || 0;
        }
        return groups;
    }

    calculateTotalSize(events) {
        return events.reduce((sum, e) => sum + this.getEventSize(e), 0);
    }

    getDateRange(events) {
        if (events.length === 0) return { oldest: null, newest: null };

        const timestamps = events
            .map(e => e.timestamp ? new Date(e.timestamp).getTime() : 0)
            .filter(t => t > 0);

        if (timestamps.length === 0) return { oldest: null, newest: null };

        return {
            oldest: new Date(Math.min(...timestamps)).toISOString(),
            newest: new Date(Math.max(...timestamps)).toISOString()
        };
    }

    getDateRangeFromResults(items) {
        const events = items.map(i => i.event).filter(e => e);
        return this.getDateRange(events);
    }

    groupEventsByLocation(events) {
        const locations = {};
        for (const event of events) {
            const city = this.getEventCity(event);
            if (!locations[city]) {
                locations[city] = { count: 0, size: 0 };
            }
            locations[city].count++;
            locations[city].size += this.getEventSize(event);
        }
        return locations;
    }

    groupResultsByLocation(items) {
        const locations = {};
        for (const item of items) {
            const city = item.event ? this.getEventCity(item.event) : 'Unknown';
            if (!locations[city]) {
                locations[city] = { count: 0, size: 0 };
            }
            locations[city].count++;
            locations[city].size += item.fingerprint?.totalSize || 0;
        }
        return locations;
    }

    groupEventsByMonth(events) {
        const months = {};
        for (const event of events) {
            if (event.timestamp) {
                const date = new Date(event.timestamp);
                const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                if (!months[key]) {
                    months[key] = { count: 0, size: 0 };
                }
                months[key].count++;
                months[key].size += this.getEventSize(event);
            }
        }
        return months;
    }

    groupResultsByMonth(items) {
        const months = {};
        for (const item of items) {
            if (item.event?.timestamp) {
                const date = new Date(item.event.timestamp);
                const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                if (!months[key]) {
                    months[key] = { count: 0, size: 0 };
                }
                months[key].count++;
                months[key].size += item.fingerprint?.totalSize || 0;
            }
        }
        return months;
    }

    computeDetailedBreakdown(results, sourceEvents, destEvents) {
        // Build detailed breakdown from results which have accurate fingerprint data
        const allEvents = [];

        // Helper to format date
        const formatDate = (timestamp) => {
            if (!timestamp) return '-';
            return new Date(timestamp).toLocaleDateString();
        };

        // Helper to create entry from result item
        const createEntry = (item, status) => ({
            name: item.event?.name || item.fingerprint?.name || 'Unknown',
            type: ((item.event?.type || item.fingerprint?.type || 'RecentClips')).replace('Clips', ''),
            location: item.event ? this.getEventCity(item.event) : 'Unknown',
            timestamp: item.event?.timestamp,
            date: formatDate(item.event?.timestamp),
            size: item.fingerprint?.totalSize || 0,
            status: status
        });

        // Add all results with their status
        for (const item of results.missing) {
            allEvents.push(createEntry(item, 'missing'));
        }
        for (const item of results.newer) {
            allEvents.push(createEntry(item, 'newer'));
        }
        for (const item of results.differentSize) {
            allEvents.push(createEntry(item, 'differentSize'));
        }
        for (const item of results.same) {
            allEvents.push(createEntry(item, 'same'));
        }
        for (const item of results.destOnly) {
            allEvents.push(createEntry(item, 'destOnly'));
        }

        return { events: allEvents };
    }

    // ========================================
    // Sync Operations
    // ========================================

    async startSync(options = {}) {
        const {
            selectedEvents = [],
            mode = this.settings.defaultMode, // 'copy' or 'move'
            syncNotes = this.settings.syncNotes
        } = options;

        if (selectedEvents.length === 0) {
            throw new Error('No events selected for sync');
        }

        // Ensure permissions
        await this.ensurePermissions();

        // Initialize state
        this.abortController = new AbortController();
        this.isPaused = false;

        const totalBytes = selectedEvents.reduce((sum, item) => sum + item.fingerprint.totalSize, 0);

        this.setState({
            status: 'syncing',
            eventsTotal: selectedEvents.length,
            eventsCompleted: 0,
            bytesTotal: totalBytes,
            bytesCompleted: 0,
            startTime: Date.now(),
            errors: []
        });

        try {
            // Get or create destination type folders
            const destFolders = await this.getOrCreateDestFolders();

            // Process each event
            for (let i = 0; i < selectedEvents.length; i++) {
                // Check for abort
                if (this.abortController.signal.aborted) {
                    throw new Error('Sync cancelled by user');
                }

                // Check for pause
                await this.checkPause();

                const item = selectedEvents[i];
                const event = item.event;

                this.setState({
                    currentEvent: event.name,
                    currentFile: null
                });

                try {
                    // Copy the event
                    await this.copyEvent(event, item.fingerprint, destFolders);

                    // Verify if enabled
                    if (this.settings.verifyAfterCopy) {
                        this.setState({ status: 'verifying' });
                        const verified = await this.verifyEvent(event, item.fingerprint, destFolders);

                        if (!verified) {
                            this.state.errors.push({
                                event: event.name,
                                error: 'Verification failed'
                            });
                            continue;
                        }
                        this.setState({ status: 'syncing' });
                    }

                    // Delete source if move mode
                    if (mode === 'move') {
                        await this.deleteSourceEvent(event);
                    }

                    this.setState({
                        eventsCompleted: i + 1
                    });

                } catch (error) {
                    console.error('Error syncing event', event.name, error);
                    this.state.errors.push({
                        event: event.name,
                        error: error.message
                    });

                    // Save resume point
                    this.saveResumePoint(i, selectedEvents);
                }
            }

            // Sync notes if enabled
            if (syncNotes && this.comparisonResults?.notesComparison) {
                await this.syncNotes();
            }

            // Write sync settings file
            if (this.settings.writeSyncFile) {
                await this.writeSyncSettings();
            }

            this.setState({
                status: 'complete',
                currentEvent: null,
                currentFile: null
            });

            if (this.onCompleteCallback) {
                this.onCompleteCallback(this.state);
            }

        } catch (error) {
            this.setState({
                status: 'error',
                currentEvent: null,
                currentFile: null
            });

            if (this.onErrorCallback) {
                this.onErrorCallback(error);
            }

            throw error;
        }
    }

    async getOrCreateDestFolders() {
        const folders = {};
        const typeNames = ['SavedClips', 'SentryClips', 'RecentClips'];

        for (const typeName of typeNames) {
            try {
                folders[typeName] = await this.destDrive.handle.getDirectoryHandle(typeName, { create: true });
            } catch (error) {
                console.error('Error creating folder', typeName, error);
            }
        }

        return folders;
    }

    async copyEvent(event, fingerprint, destFolders) {
        const destTypeFolder = destFolders[event.type];
        if (!destTypeFolder) {
            throw new Error('Destination folder not found for type: ' + event.type);
        }

        // Create event folder
        const destEventFolder = await destTypeFolder.getDirectoryHandle(event.name, { create: true });

        // Check if backup file is included (notes, tags, bookmarks)
        const hasBackupFile = fingerprint.files.some(f => f.name === this.USERDATA_BACKUP_FILENAME);
        if (hasBackupFile) {
            console.log(`[DriveSync] Event ${event.name} includes user data backup file`);
        }

        // Copy all files (including user data backup if present)
        for (const fileInfo of fingerprint.files) {
            await this.checkPause();

            if (this.abortController.signal.aborted) {
                throw new Error('Sync cancelled');
            }

            this.setState({
                currentFile: fileInfo.name,
                currentFileBytes: 0,
                currentFileTotal: fileInfo.size
            });

            await this.copyFile(fileInfo.handle, destEventFolder, (bytesWritten, totalBytes) => {
                this.setState({
                    currentFileBytes: bytesWritten,
                    bytesCompleted: this.state.bytesCompleted + bytesWritten - (this.state.currentFileBytes || 0)
                });

                if (this.onProgressCallback) {
                    this.onProgressCallback(this.state);
                }
            });

            // Update completed bytes
            this.setState({
                bytesCompleted: this.state.bytesCompleted + fileInfo.size - (this.state.currentFileBytes || 0)
            });
        }
    }

    async copyFile(sourceHandle, destDir, onProgress) {
        const file = await sourceHandle.getFile();
        const destFile = await destDir.getFileHandle(file.name, { create: true });
        const writable = await destFile.createWritable();

        const reader = file.stream().getReader();
        let bytesWritten = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                await writable.write(value);
                bytesWritten += value.length;

                if (onProgress) {
                    onProgress(bytesWritten, file.size);
                }
            }

            await writable.close();
            return destFile;

        } catch (error) {
            await writable.abort();
            throw error;
        }
    }

    async verifyEvent(event, fingerprint, destFolders) {
        const destTypeFolder = destFolders[event.type];
        if (!destTypeFolder) return false;

        try {
            const destEventFolder = await destTypeFolder.getDirectoryHandle(event.name);

            for (const fileInfo of fingerprint.files) {
                const destFileHandle = await destEventFolder.getFileHandle(fileInfo.name);
                const verified = await this.verifyFile(fileInfo.handle, destFileHandle);

                if (!verified) {
                    console.error('Verification failed for', fileInfo.name);
                    return false;
                }
            }

            return true;

        } catch (error) {
            console.error('Verification error:', error);
            return false;
        }
    }

    async verifyFile(sourceHandle, destHandle) {
        const sourceFile = await sourceHandle.getFile();
        const destFile = await destHandle.getFile();

        // Size check
        if (sourceFile.size !== destFile.size) {
            return false;
        }

        // Full checksum for small files
        if (sourceFile.size < this.CHECKSUM_SIZE_LIMIT) {
            const sourceBuffer = await sourceFile.arrayBuffer();
            const destBuffer = await destFile.arrayBuffer();
            return this.buffersEqual(sourceBuffer, destBuffer);
        }

        // Size match is sufficient for large files
        return true;
    }

    buffersEqual(buf1, buf2) {
        if (buf1.byteLength !== buf2.byteLength) return false;

        const view1 = new Uint8Array(buf1);
        const view2 = new Uint8Array(buf2);

        for (let i = 0; i < view1.length; i++) {
            if (view1[i] !== view2[i]) return false;
        }

        return true;
    }

    async deleteSourceEvent(event) {
        if (!this.settings.confirmBeforeDelete) {
            // This should be confirmed in UI before calling
        }

        try {
            const typeFolder = await this.sourceDrive.handle.getDirectoryHandle(event.type);
            await typeFolder.removeEntry(event.name, { recursive: true });
            console.log('Deleted source event:', event.name);
        } catch (error) {
            console.error('Error deleting source event:', error);
            throw error;
        }
    }

    async syncNotes() {
        const notes = this.comparisonResults?.notesComparison;
        if (!notes) return;

        // Copy source-only notes to destination context
        for (const item of notes.sourceOnly) {
            const destEvent = this.destDrive.events?.find(e => e.name === item.eventName);
            if (destEvent) {
                const destKey = destEvent.compoundKey || item.eventName;
                this.notesManager.saveNotes(destKey, item.notes);
            }
        }

        // Handle conflicts based on settings
        if (this.settings.noteConflictMode === 'merge') {
            for (const item of notes.conflict) {
                const destEvent = this.destDrive.events?.find(e => e.name === item.eventName);
                if (destEvent) {
                    const destKey = destEvent.compoundKey || item.eventName;
                    const merged = this.mergeNotes(item.sourceNotes, item.destNotes);
                    this.notesManager.saveNotes(destKey, merged);
                }
            }
        }
        // 'ask' mode is handled in UI
    }

    mergeNotes(source, dest) {
        // Combine tags (unique)
        const allTags = [...new Set([...(source.tags || []), ...(dest.tags || [])])];

        // Combine text with separator
        let text = '';
        if (source.text && dest.text && source.text !== dest.text) {
            text = source.text + '\n---\n' + dest.text;
        } else {
            text = source.text || dest.text || '';
        }

        return { text, tags: allTags };
    }

    // ========================================
    // Sync Settings File
    // ========================================

    async readSyncSettings() {
        try {
            const fileHandle = await this.destDrive.handle.getFileHandle(this.SYNC_SETTINGS_FILENAME);
            const file = await fileHandle.getFile();
            const text = await file.text();
            return JSON.parse(text);
        } catch (error) {
            // File doesn't exist or can't be read
            return null;
        }
    }

    async writeSyncSettings() {
        const existingSettings = await this.readSyncSettings() || {
            version: 1,
            syncedEvents: {},
            notes: {}
        };

        // Update with current sync info
        existingSettings.lastSync = new Date().toISOString();
        existingSettings.sourceInfo = {
            label: this.sourceDrive.label || this.sourceDrive.folderName,
            lastKnownEventCount: this.sourceDrive.events?.length || 0
        };

        // Add synced events
        if (this.comparisonResults) {
            const synced = [
                ...this.comparisonResults.missing.filter(i => i.selected),
                ...this.comparisonResults.newer.filter(i => i.selected)
            ];

            for (const item of synced) {
                existingSettings.syncedEvents[item.event.name] = {
                    syncedAt: new Date().toISOString(),
                    sourceSize: item.fingerprint.totalSize,
                    verified: this.settings.verifyAfterCopy
                };
            }
        }

        // Backup notes for destination events
        const destNotes = {};
        for (const event of (this.destDrive.events || [])) {
            const key = event.compoundKey || event.name;
            const notes = this.notesManager.notes?.[key];
            if (notes) {
                destNotes[event.name] = notes;
            }
        }
        existingSettings.notes = destNotes;

        existingSettings.settings = {
            autoSyncNotes: this.settings.syncNotes,
            verifyAfterCopy: this.settings.verifyAfterCopy,
            deleteAfterVerify: this.settings.defaultMode === 'move'
        };

        // Save presets that involve this destination
        const relevantPresets = this.presets.filter(p =>
            p.destLabel === (this.destDrive.label || this.destDrive.folderName) ||
            p.sourceLabel === (this.destDrive.label || this.destDrive.folderName)
        );
        if (relevantPresets.length > 0) {
            existingSettings.presets = relevantPresets.map(p => ({
                name: p.name,
                sourceLabel: p.sourceLabel,
                destLabel: p.destLabel,
                createdAt: p.createdAt
            }));
        }

        // Write file
        try {
            const fileHandle = await this.destDrive.handle.getFileHandle(
                this.SYNC_SETTINGS_FILENAME,
                { create: true }
            );
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify(existingSettings, null, 2));
            await writable.close();
            console.log('Sync settings written successfully');
        } catch (error) {
            console.error('Error writing sync settings:', error);
        }
    }

    // ========================================
    // Control Methods
    // ========================================

    pause() {
        if (this.state.status === 'syncing') {
            this.isPaused = true;
            this.setState({ status: 'paused' });
        }
    }

    async resume() {
        if (this.state.status === 'paused') {
            this.isPaused = false;
            this.setState({ status: 'syncing' });

            if (this.pauseResolve) {
                this.pauseResolve();
                this.pauseResolve = null;
            }
        }
    }

    cancel() {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.isPaused = false;
        if (this.pauseResolve) {
            this.pauseResolve();
            this.pauseResolve = null;
        }
    }

    async checkPause() {
        if (this.isPaused) {
            await new Promise(resolve => {
                this.pauseResolve = resolve;
            });
        }
    }

    saveResumePoint(eventIndex, selectedEvents) {
        this.state.canResume = true;
        this.state.resumePoint = {
            lastCompletedEvent: eventIndex,
            selectedEvents: selectedEvents.map(e => e.event.name),
            timestamp: Date.now()
        };

        try {
            localStorage.setItem('teslacamviewer_sync_resume', JSON.stringify(this.state.resumePoint));
        } catch (e) {
            console.error('Failed to save resume point:', e);
        }
    }

    loadResumePoint() {
        try {
            const saved = localStorage.getItem('teslacamviewer_sync_resume');
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (e) {
            console.error('Failed to load resume point:', e);
        }
        return null;
    }

    clearResumePoint() {
        localStorage.removeItem('teslacamviewer_sync_resume');
        this.state.canResume = false;
        this.state.resumePoint = null;
    }

    // ========================================
    // State Management & Callbacks
    // ========================================

    setState(updates) {
        this.state = { ...this.state, ...updates };

        if (this.onStateChangeCallback) {
            this.onStateChangeCallback(this.state);
        }
    }

    onProgress(callback) {
        this.onProgressCallback = callback;
    }

    onComplete(callback) {
        this.onCompleteCallback = callback;
    }

    onError(callback) {
        this.onErrorCallback = callback;
    }

    onStateChange(callback) {
        this.onStateChangeCallback = callback;
    }

    // ========================================
    // Utility Methods
    // ========================================

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
        }
        return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
    }

    getTransferSpeed() {
        if (!this.state.startTime || this.state.bytesCompleted === 0) return 0;
        const elapsed = (Date.now() - this.state.startTime) / 1000;
        return this.state.bytesCompleted / elapsed;
    }

    getETA() {
        const speed = this.getTransferSpeed();
        if (speed === 0) return 0;
        const remaining = this.state.bytesTotal - this.state.bytesCompleted;
        return (remaining / speed) * 1000; // in ms
    }
}
