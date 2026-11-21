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
        this.VERIFY_CHUNK_SIZE = 8 * 1024 * 1024; // verify reads and compares 8 MB of each file at a time
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

    /**
     * Ask for what a sync needs while the click that started it still counts (a browser asks the user only
     * then; a long sync has none left by the time Move deletes). Move deletes from the source, so it needs
     * write access there too: a folder picked to view is read-only, and before (2026-11-20) Move never asked,
     * so on a real drive every delete failed and the whole event stayed on the source. Both questions start
     * together, on the click. Never throws: startSync() checks the result.
     * @param {string} mode 'copy' or 'move'
     */
    async requestSyncPermissions(mode) {
        const ask = async (drive, permMode) => {
            const h = drive && drive.handle;
            if (!h || typeof h.requestPermission !== 'function') return;
            try {
                if ((await h.queryPermission({ mode: permMode })) !== 'granted') await h.requestPermission({ mode: permMode });
            } catch (e) {
                console.warn('[DriveSync] permission request failed for', drive.label, permMode, e);
            }
        };
        await Promise.all([
            ask(this.sourceDrive, mode === 'move' ? 'readwrite' : 'read'),
            ask(this.destDrive, 'readwrite')
        ]);
    }

    async ensurePermissions(mode = 'copy') {
        // Source: read for Copy; Move deletes the moved events from it, so it needs write access too
        const sourceMode = mode === 'move' ? 'readwrite' : 'read';
        const sourcePermission = await this.sourceDrive.handle.queryPermission({ mode: sourceMode });
        if (sourcePermission !== 'granted') {
            let state = 'prompt';
            try {
                state = await this.sourceDrive.handle.requestPermission({ mode: sourceMode });
            } catch (e) {
                console.warn('[DriveSync] source permission request failed', e);
            }
            if (state !== 'granted' && mode === 'move') {
                throw new Error(this._t('driveSync.moveNeedsWrite',
                    { drive: this.sourceDrive.label || this.sourceDrive.folderName || '' },
                    'Move needs permission to change files on {{drive}}, to delete the events it moves. Nothing was copied or deleted. Allow it when your browser asks, or use Copy.'));
            }
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
                selectedSize: 0,
                warnings: []
            };

            // Compare source events
            for (const [name, sourceEvent] of sourceMap) {
                const destEvent = destMap.get(name);

                if (!destEvent) {
                    // Missing on destination
                    const fingerprint = await this.getEventFingerprint(sourceEvent);
                    if (fingerprint.partial) {
                        results.warnings.push(this._partialWarning(sourceEvent.name, fingerprint));
                    }
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
                    if (sourceFingerprint.partial) {
                        results.warnings.push(this._partialWarning(sourceEvent.name, sourceFingerprint));
                    }
                    if (destFingerprint.partial) {
                        results.warnings.push(this._t('driveSync.destPartial',
                            { event: destEvent.name, error: destFingerprint.error },
                            '{{event}} on the destination: {{error}}'));
                    }

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

    /**
     * List an event folder's files. A file that can't be read (a bad sector,
     * a flaky USB read) no longer ends the listing: it is recorded in
     * `unreadable` and the scan goes on, so the fingerprint never silently
     * covers only part of the event. `partial` is true when any file could
     * not be read or the folder could not be listed to the end; Move refuses
     * such an event (#522).
     */
    async getEventFingerprint(event) {
        const files = [];
        const unreadable = [];
        let listError = null;

        // RecentClips: one flat folder for every hour; this event is only its own files (#535)
        const own = this._flatEventFiles(event);

        try {
            for await (const entry of event.folderHandle.values()) {
                if (entry.kind === 'file') {
                    if (own && !own.has(entry.name)) continue;
                    let file;
                    try {
                        file = await entry.getFile();
                    } catch (readError) {
                        unreadable.push({ name: entry.name, error: readError?.message || String(readError) });
                        console.warn('Unable to read', entry.name, 'in', event.name, readError);
                        continue;
                    }
                    files.push({
                        name: entry.name,
                        size: file.size,
                        lastModified: file.lastModified,
                        handle: entry
                    });

                    if (entry.name === 'event.json' && !event.metadata) {
                        try {
                            const text = await file.text();
                            event.metadata = JSON.parse(text);
                        } catch (e) {
                            console.warn('Unable to load event.json:', e);
                        }
                    }
                }
            }
        } catch (error) {
            listError = error?.message || String(error);
            console.warn('Error getting fingerprint for', event.name, error);
        }

        let error = null;
        if (listError) {
            error = this._t('driveSync.scanStopped', { error: listError },
                'the folder could not be listed to the end ({{error}})');
        } else if (unreadable.length > 0) {
            error = this._t('driveSync.filesUnreadable',
                { count: unreadable.length, names: unreadable.map(u => u.name).join(', ') },
                '{{count}} file(s) could not be read: {{names}}');
        }

        return {
            name: event.name,
            type: event.type,
            fileCount: files.length,
            totalSize: files.reduce((sum, f) => sum + f.size, 0),
            newestFile: files.length > 0 ? Math.max(...files.map(f => f.lastModified)) : 0,
            files: files.sort((a, b) => a.name.localeCompare(b.name)),
            unreadable,
            partial: !!listError || unreadable.length > 0,
            error
        };
    }

    /**
     * The files that make up a RecentClips hour, or null for an event with its own folder.
     * RecentClips is one flat folder for every hour, so the folder handle alone would mean
     * every hour copies (and Move deletes from) the whole folder (#535).
     * @param {Object} event
     * @returns {Set<string>|null}
     */
    _flatEventFiles(event) {
        if (!event || !event.flatFolder) return null;
        const names = new Set((event.clips || []).map(c => c && c.fileName).filter(n => typeof n === 'string'));
        const backup = window.eventDataBackup?.backupFileName?.(event);
        if (backup && backup !== this.USERDATA_BACKUP_FILENAME) names.add(backup);
        return names;
    }

    /**
     * Translate with an English fallback (for when the locale files are not
     * loaded, e.g. in tests).
     * @private
     */
    _t(key, params, fallback) {
        let text = window.i18n ? window.i18n.t(key, params) : key;
        if (!text || text === key) {
            text = fallback;
            for (const [k, v] of Object.entries(params || {})) {
                text = text.split(`{{${k}}}`).join(String(v));
            }
        }
        return text;
    }

    /** @private */
    _partialWarning(eventName, fingerprint) {
        return this._t('driveSync.sourcePartial', { event: eventName, error: fingerprint.error },
            '{{event}}: {{error}}. Copy copies the files that can be read. Move will not delete anything from this event.');
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

        // All notes, as stored by NotesManager (#540: this read notesManager.notes, which doesn't
        // exist, so Compare never found any notes and "Include notes & tags" did nothing)
        const allNotes = this._allNotes();

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
                const sourceTags = Array.isArray(sourceNotes.tags) ? [...sourceNotes.tags] : [];
                const destTags = Array.isArray(destNotes.tags) ? [...destNotes.tags] : [];

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
        const locations = Object.create(null); // city names come from event.json: "__proto__" must stay a plain key
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
        const locations = Object.create(null); // see groupEventsByLocation
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

        // Ensure permissions (Move: write access to the source as well). Before anything is copied; a refusal
        // ends the sync on the finish screen with the reason
        try {
            await this.ensurePermissions(mode);
        } catch (error) {
            this.setState({ status: 'error', eventsTotal: selectedEvents.length, eventsCompleted: 0, eventsProcessed: 0,
                errors: [], warnings: [], currentEvent: null, currentFile: null });
            if (this.onErrorCallback) this.onErrorCallback(error);
            throw error;
        }

        // Note: we intentionally don't pre-check free space on the destination.
        // navigator.storage.estimate() reports the browser's origin quota
        // (IndexedDB/OPFS), not the USB drive's free space — it's the wrong tool.
        // Out-of-space conditions are surfaced as write errors during copyFile.

        // Initialize state
        this.abortController = new AbortController();
        this.isPaused = false;

        const totalBytes = selectedEvents.reduce((sum, item) => sum + item.fingerprint.totalSize, 0);

        this.setState({
            status: 'syncing',
            eventsTotal: selectedEvents.length,
            eventsCompleted: 0,     // events copied/moved without an error (the finish screen's count)
            eventsProcessed: 0,     // events tried so far, failed ones included (the progress line)
            bytesTotal: totalBytes,
            bytesCompleted: 0,
            startTime: Date.now(),
            errors: [],
            warnings: []
        });

        try {
            // Get or create destination type folders
            const destFolders = await this.getOrCreateDestFolders();

            // Process each event
            for (let i = 0; i < selectedEvents.length; i++) {
                // Check for pause, then for a Cancel (it also ends a pause)
                await this.checkPause();
                if (this.abortController.signal.aborted) {
                    throw this._cancelledError();
                }

                const item = selectedEvents[i];
                const event = item.event;

                this.setState({
                    currentEvent: event.name,
                    currentFile: null
                });

                try {
                    const isMove = mode === 'move';
                    const fingerprint = item.fingerprint;

                    // Copy the event (only the files Compare listed and could read)
                    await this.copyEvent(event, fingerprint, destFolders);

                    // Move always verifies, whatever "Verify after copy" says:
                    // the source is deleted only after its copy checked out.
                    let verification = null;
                    if (this.settings.verifyAfterCopy || isMove) {
                        this.setState({ status: 'verifying' });
                        verification = await this.verifyEvent(event, fingerprint, destFolders);
                        this.setState({ status: 'syncing' });

                        if (!verification.ok) {
                            this.state.errors.push({
                                event: event.name,
                                error: isMove
                                    ? this._t('driveSync.verifyFailedKept', { error: verification.error },
                                        'Verification failed ({{error}}). Nothing was deleted from the source.')
                                    : this._t('driveSync.verifyFailed', { error: verification.error },
                                        'Verification failed ({{error}})')
                            });
                            continue;
                        }
                    }

                    // Compare could not read the whole event: what could be read
                    // was copied, but the event counts as failed, and Move
                    // deletes nothing from it.
                    if (fingerprint.partial) {
                        this.state.errors.push({
                            event: event.name,
                            error: isMove
                                ? this._t('driveSync.partialNotMoved', { error: fingerprint.error },
                                    'Not moved: {{error}}. The files that could be read were copied; nothing was deleted from the source.')
                                : this._t('driveSync.partialCopied', { error: fingerprint.error },
                                    'Only partly copied: {{error}}')
                        });
                        continue;
                    }

                    // Move: delete only the files that were copied and verified
                    // (not after a Cancel: the event stays on the source)
                    if (isMove) {
                        if (this.abortController.signal.aborted) {
                            throw new Error('Sync cancelled');
                        }
                        const removal = await this.deleteSourceEvent(event, verification.files);
                        if (removal.failed && removal.failed.length > 0) {
                            // The copy is complete and checked, but the source could not be changed (no write
                            // access, a write-protected drive): say so, the event was not moved
                            this.state.errors.push({
                                event: event.name,
                                error: this._t('driveSync.deleteFailed',
                                    { count: removal.failed.length, error: removal.failed[0].error },
                                    'Copied and checked, but {{count}} file(s) could not be deleted from the source and are still there ({{error}}).')
                            });
                            this.setState({ eventsProcessed: i + 1 });
                            continue;
                        }
                        if (removal.kept.length > 0) {
                            this.state.warnings.push({
                                event: event.name,
                                warning: this._t('driveSync.keptInSource',
                                    { count: removal.kept.length, names: removal.kept.join(', ') },
                                    'Kept {{count}} file(s) in the source folder because they were not part of the verified copy (added or changed after Compare): {{names}}')
                            });
                        }
                    }

                    this.setState({
                        eventsCompleted: this.state.eventsCompleted + 1,
                        eventsProcessed: i + 1
                    });

                } catch (error) {
                    console.warn('Error syncing event', event.name, error);
                    const cancelled = this.abortController.signal.aborted;
                    this.state.errors.push({
                        event: event.name,
                        error: !cancelled ? error.message
                            : mode === 'move'
                                ? this._t('driveSync.cancelledKeptEvent', null, 'Cancelled. Nothing was deleted from the source for this event.')
                                : this._t('driveSync.cancelledEvent', null, 'Cancelled before this event was finished.')
                    });
                    this.setState({ eventsProcessed: i + 1 });

                    // Save resume point
                    this.saveResumePoint(i, selectedEvents);
                }
            }

            // A Cancel during the last event ends here too (not on "Sync Complete")
            if (this.abortController.signal.aborted) {
                throw this._cancelledError();
            }

            // Sync notes if enabled
            if (syncNotes && this.comparisonResults?.notesComparison) {
                const notesResult = await this.syncNotes();
                if (notesResult.conflictsLeft > 0) {
                    this.state.warnings.push({
                        event: this._t('driveSync.notesTitle', null, 'Notes & tags'),
                        warning: this._t('driveSync.notesConflictsKept', { count: notesResult.conflictsLeft },
                            '{{count}} event(s) have different notes on the two drives. Both were kept as they were. To combine them, choose "Merge automatically" under "Note conflict resolution" in Sync Settings.')
                    });
                }
            }

            // Write sync settings file
            if (this.settings.writeSyncFile) {
                await this.writeSyncSettings();
            }

            // Refresh destination drive's event list so the next Compare
            // sees the newly-copied events instead of the stale pre-sync list.
            await this.refreshDriveEvents(this.destDrive);

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

    /**
     * The error a cancelled sync ends with: how far it got. (For Move, the
     * event in progress gets its own line in state.errors saying nothing was
     * deleted from it.) `cancelled` lets the finish screen tell it from a
     * real failure.
     * @private
     */
    _cancelledError() {
        const params = { done: this.state.eventsCompleted || 0, total: this.state.eventsTotal || 0 };
        const err = new Error(this._t('driveSync.cancelledAfter', params, 'Cancelled after {{done}} of {{total}} events.'));
        err.cancelled = true;
        return err;
    }

    async refreshDriveEvents(drive) {
        if (!drive?.handle) return;
        const parser = window.app?.folderParser;
        if (!parser) {
            const msg = 'Unable to refresh destination event list — folderParser unavailable. Next Compare may incorrectly show just-synced events as "missing".';
            console.warn('[DriveSync]', msg);
            this.state.errors.push({ event: drive.label || 'destination', error: msg });
            return;
        }
        try {
            console.log(`[DriveSync] Refreshing event list for ${drive.label}...`);
            await this.folderManager.parseSingleDrive(parser, drive.id);
            console.log(`[DriveSync] ${drive.label} now has ${drive.events?.length} events`);
        } catch (e) {
            const msg = `Unable to refresh destination event list: ${e.message}`;
            console.warn('[DriveSync]', msg);
            this.state.errors.push({ event: drive.label || 'destination', error: msg });
        }
    }

    /**
     * The folder that holds SavedClips/SentryClips/RecentClips on a drive. The user may pick the USB drive
     * itself (the car's folders are then inside TeslaCam/) or the TeslaCam folder: the event list reads both,
     * so Move and Copy must too. Before, a drive picked at its root got its copies next to TeslaCam/ and
     * Move found no source folder to delete from.
     * A drive with a TeslaCam/ folder gets its copies in there, where the car looks, even when it also has a
     * SavedClips folder next to TeslaCam/ (an older Drive Sync put copies there when the drive itself was
     * picked, 2026-11-20). Only the destination uses this: Move deletes from the event's own folder.
     * @param {FileSystemDirectoryHandle} handle  the picked folder
     */
    async _clipsRoot(handle) {
        if (handle.name !== 'TeslaCam') {
            try { return await handle.getDirectoryHandle('TeslaCam'); } catch (e) { /* no TeslaCam folder */ }
        }
        return handle;
    }

    /**
     * The folder an event folder sits in (SavedClips, "SentryClips (1)", ...), found from the source drive,
     * so Move can remove the emptied event folder. null if it can't be found there.
     * @private
     */
    async _parentFolder(root, folder, type) {
        const same = async (a, b) => a === b || (typeof a.isSameEntry === 'function' && await a.isSameEntry(b));
        try {
            if (typeof root.resolve === 'function') {
                const p = await root.resolve(folder);
                if (Array.isArray(p) && p.length > 0) {
                    let parent = root;
                    for (const part of p.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
                    if (await same(await parent.getDirectoryHandle(p[p.length - 1]), folder)) return parent;
                }
            }
        } catch (e) { /* look in the usual places below */ }
        // The type folder on the drive or in its TeslaCam folder, if it holds this very folder
        let teslaCam = null;
        try { teslaCam = await root.getDirectoryHandle('TeslaCam'); } catch (e) { /* none */ }
        for (const base of [root, teslaCam]) {
            if (!base || !type) continue;
            try {
                const parent = await base.getDirectoryHandle(type);
                if (await same(await parent.getDirectoryHandle(folder.name), folder)) return parent;
            } catch (e) { /* not here */ }
        }
        return null;
    }

    async getOrCreateDestFolders() {
        const folders = {};
        const typeNames = ['SavedClips', 'SentryClips', 'RecentClips'];
        const root = await this._clipsRoot(this.destDrive.handle);

        for (const typeName of typeNames) {
            try {
                folders[typeName] = await root.getDirectoryHandle(typeName, { create: true });
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

        // Create event folder (RecentClips: the files go straight into RecentClips, like the car writes them, #535)
        const destEventFolder = this._flatEventFiles(event)
            ? destTypeFolder
            : await destTypeFolder.getDirectoryHandle(event.name, { create: true });

        // Check if backup file is included (notes, tags, bookmarks)
        const hasBackupFile = fingerprint.files.some(f => f.name.startsWith('.teslacam-userdata'));
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

            // Snapshot the total before this file so we can reconcile correctly
            // whether the copy completes or throws mid-file.
            const bytesBeforeFile = this.state.bytesCompleted;

            try {
                await this.copyFile(fileInfo.handle, destEventFolder, (bytesWritten, totalBytes) => {
                    this.setState({
                        currentFileBytes: bytesWritten,
                        bytesCompleted: bytesBeforeFile + bytesWritten
                    });

                    if (this.onProgressCallback) {
                        this.onProgressCallback(this.state);
                    }
                });

                // Success — land exactly on fileInfo.size of progress for this file
                this.setState({ bytesCompleted: bytesBeforeFile + fileInfo.size });
            } catch (error) {
                // Copy failed — rewind progress since the partial file has been
                // removed by copyFile's catch block; no bytes were successfully synced.
                this.setState({ bytesCompleted: bytesBeforeFile, currentFileBytes: 0 });
                throw error;
            }
        }
    }

    async copyFile(sourceHandle, destDir, onProgress) {
        const file = await sourceHandle.getFile();
        // A copy that fails or is cancelled removes only a file it created
        // itself. Before, it also removed a good copy that was already on the
        // destination (a "Newer on source" event re-copied over it): the
        // writable is never committed, so that copy is intact and stays.
        let existedBefore = false;
        try {
            await destDir.getFileHandle(file.name);
            existedBefore = true;
        } catch (_) { /* not there yet */ }
        const destFile = await destDir.getFileHandle(file.name, { create: true });
        const writable = await destFile.createWritable();

        const reader = file.stream().getReader();
        let bytesWritten = 0;
        let completed = false;

        try {
            while (true) {
                if (this.abortController?.signal.aborted) {
                    reader.cancel();
                    await writable.abort();
                    throw new Error('Sync cancelled');
                }

                const { done, value } = await reader.read();
                if (done) break;

                await writable.write(value);
                bytesWritten += value.length;

                if (onProgress) {
                    onProgress(bytesWritten, file.size);
                }
            }

            await writable.close();
            completed = true;
            return destFile;

        } catch (error) {
            try { await writable.abort(); } catch (_) {}
            // getFileHandle(..., {create: true}) created a 0-byte file before
            // createWritable. If the copy didn't finish, remove that stub so the
            // next Compare doesn't flag a "different size" and loop re-copying
            // a file that consistently fails.
            if (!completed && !existedBefore) {
                try { await destDir.removeEntry(file.name); } catch (_) {}
            }
            throw error;
        }
    }

    /**
     * Check every copied file against its source, byte for byte.
     * Before, files over 10 MB (every dashcam clip) were checked only on
     * their first and last 1 MB, and Move deleted the source on that. Now
     * the whole of both files is read in chunks and compared, so a copy that
     * is damaged anywhere keeps its source.
     * Progress: state.verifyFilesDone / verifyFilesTotal (the "Verifying 3 of
     * 12 files" line) and verifyBytesDone / verifyBytesTotal for the event.
     * Cancel stops it and is passed on (thrown), so nothing is deleted.
     * @returns {{ok: boolean, error: string|null, files: Array}} `files` lists
     *   the verified source files with the size and modification time they
     *   had when verified; Move deletes only these.
     */
    async verifyEvent(event, fingerprint, destFolders) {
        const destTypeFolder = destFolders[event.type];
        if (!destTypeFolder) {
            return { ok: false, error: 'destination folder not found for ' + event.type, files: [] };
        }

        const files = [];
        const total = fingerprint.files.length;
        const bytesTotal = fingerprint.files.reduce((s, f) => s + (f.size || 0), 0);
        let bytesBefore = 0;
        const progress = (updates) => {
            this.setState(updates);
            if (this.onProgressCallback) this.onProgressCallback(this.state);
        };
        progress({ verifyFilesDone: 0, verifyFilesTotal: total, verifyBytesDone: 0, verifyBytesTotal: bytesTotal });
        try {
            const destEventFolder = this._flatEventFiles(event)
                ? destTypeFolder
                : await destTypeFolder.getDirectoryHandle(event.name);

            for (let i = 0; i < total; i++) {
                const fileInfo = fingerprint.files[i];
                progress({ currentFile: fileInfo.name, verifyFilesDone: i });
                const destFileHandle = await destEventFolder.getFileHandle(fileInfo.name);
                const checked = await this.verifyFile(fileInfo.handle, destFileHandle,
                    done => progress({ verifyBytesDone: bytesBefore + done }));

                if (!checked.ok) {
                    console.warn('Verification failed for', fileInfo.name, checked);
                    return {
                        ok: false,
                        error: this._t('driveSync.verifyMismatch', { file: fileInfo.name },
                            'the copy of {{file}} does not match the original'),
                        files
                    };
                }
                bytesBefore += checked.size;
                files.push({ name: fileInfo.name, handle: fileInfo.handle, size: checked.size, lastModified: checked.lastModified });
            }
            progress({ verifyFilesDone: total, verifyBytesDone: bytesBefore });

            return { ok: true, error: null, files };

        } catch (error) {
            // Cancel: pass it on, so the event stops here and nothing is deleted
            if (this.abortController?.signal.aborted) throw error;
            console.warn('Verification error:', error);
            return { ok: false, error: error?.message || String(error), files };
        }
    }

    /**
     * Compare the whole of two files, VERIFY_CHUNK_SIZE bytes at a time (both
     * chunks read together; the browser has no streaming hash, and comparing
     * the bytes needs no hash). Throws on a read error or a cancel.
     * @param {function(number)} [onBytes] called with the bytes checked so far
     * @returns {{ok: true, size: number, lastModified: number}|{ok: false, reason: string, offset?: number}}
     *   the source file's size and modification time when every byte matched
     */
    async verifyFile(sourceHandle, destHandle, onBytes) {
        const sourceFile = await sourceHandle.getFile();
        const destFile = await destHandle.getFile();
        const size = sourceFile.size;

        if (size !== destFile.size) {
            return { ok: false, reason: 'size' };
        }

        const CHUNK = this.VERIFY_CHUNK_SIZE;
        for (let offset = 0; offset < size; offset += CHUNK) {
            await this.checkPause();
            if (this.abortController?.signal.aborted) {
                throw new Error('Sync cancelled');
            }
            const end = Math.min(size, offset + CHUNK);
            const [a, b] = await Promise.all([
                sourceFile.slice(offset, end).arrayBuffer(),
                destFile.slice(offset, end).arrayBuffer()
            ]);
            // A short read counts as a mismatch, not as a pass
            if (a.byteLength !== end - offset || !this.buffersEqual(a, b)) {
                return { ok: false, reason: 'content', offset };
            }
            if (onBytes) onBytes(end);
        }

        return { ok: true, size, lastModified: sourceFile.lastModified };
    }

    buffersEqual(buf1, buf2) {
        if (buf1.byteLength !== buf2.byteLength) return false;

        // 4 bytes at a time where the buffers allow it (an 8 MB chunk is 2M steps, not 8M)
        const n = buf1.byteLength;
        const words = (buf1 instanceof ArrayBuffer && buf2 instanceof ArrayBuffer) ? n >>> 2 : 0;
        if (words) {
            const w1 = new Uint32Array(buf1, 0, words);
            const w2 = new Uint32Array(buf2, 0, words);
            for (let i = 0; i < words; i++) {
                if (w1[i] !== w2[i]) return false;
            }
        }

        const view1 = new Uint8Array(buf1);
        const view2 = new Uint8Array(buf2);

        for (let i = words << 2; i < n; i++) {
            if (view1[i] !== view2[i]) return false;
        }

        return true;
    }

    /**
     * Move's delete step: remove only the given verified files from the
     * source event folder, then the folder itself only if nothing is left in
     * it. Before, the whole folder was removed recursively, so files that
     * were never copied went with it: files Compare couldn't read, and files
     * written after Compare (#522).
     * A file whose size or modification time changed since it was verified
     * is kept too.
     * It deletes from the event's own folder, the one Compare listed and the
     * check read (2026-11-20). Before, it looked the folder up again as
     * <drive>/<type>/<event name>; on a drive picked at its root with a
     * SavedClips folder next to TeslaCam/ (left by an older Drive Sync) that
     * was another copy of the event, so every verified file looked "changed"
     * and the whole event stayed on the source. A file is deleted only if it
     * is the same entry the check read.
     * @param {Object} event
     * @param {Array} verifiedFiles from verifyEvent().files
     * A file the drive refuses to delete (no write access, write-protected) is
     * listed in `failed` with the error, not as changed.
     * @returns {{deleted: string[], kept: string[], failed: Array<{name: string, error: string}>, folderRemoved: boolean}}
     */
    async deleteSourceEvent(event, verifiedFiles) {
        // Note: UI is expected to have confirmed before calling this.
        if (!Array.isArray(verifiedFiles)) {
            throw new Error('deleteSourceEvent needs the list of verified files');
        }
        // RecentClips: the event is some of the files in the shared RecentClips folder (#535)
        const own = this._flatEventFiles(event);
        const folder = event.folderHandle;
        if (!folder || typeof folder.getFileHandle !== 'function') {
            throw new Error('deleteSourceEvent needs the event folder');
        }
        const verified = new Map(verifiedFiles.map(f => [f.name, f]));
        const deleted = [];
        const kept = [];
        const failed = [];

        for (const f of verifiedFiles) {
            try {
                const handle = await folder.getFileHandle(f.name);
                if (f.handle && typeof f.handle.isSameEntry === 'function' && !(await f.handle.isSameEntry(handle))) {
                    console.warn('Kept in the source (not the file that was checked):', f.name);
                    kept.push(f.name);
                    continue;
                }
                const now = await handle.getFile();
                if (now.size !== f.size || now.lastModified !== f.lastModified) {
                    console.warn('Kept in the source (changed since the check):', f.name,
                        { checked: [f.size, f.lastModified], now: [now.size, now.lastModified] });
                    kept.push(f.name);
                    continue;
                }
                await folder.removeEntry(f.name);
                deleted.push(f.name);
            } catch (error) {
                console.warn('Error deleting source file', f.name, error);
                failed.push({ name: f.name, error: (error && error.message) || String(error) });
            }
        }

        // Anything still in the folder that wasn't verified stays where it is
        const left = [];
        for await (const entry of folder.values()) {
            if (!own || own.has(entry.name)) left.push(entry.name);
        }
        for (const name of left) {
            if (!verified.has(name) && !kept.includes(name)) kept.push(name);
        }

        let folderRemoved = false;
        if (left.length === 0 && !own) { // never remove the shared RecentClips folder
            // Not recursive: if something appeared in the meantime, this fails and it stays
            try {
                const parent = await this._parentFolder(this.sourceDrive.handle, folder, event.type);
                if (!parent) throw new Error('the event folder was not found on the source drive');
                await parent.removeEntry(folder.name);
                folderRemoved = true;
            } catch (error) {
                console.warn('Source event folder not removed:', event.name, error);
            }
        }
        console.log(`Moved source event ${event.name}: deleted ${deleted.length} verified file(s)` +
            (kept.length ? `, kept ${kept.length}: ${kept.join(', ')}` : '') +
            (failed.length ? `, could not delete ${failed.length}: ${failed[0].error}` : '') + (folderRemoved ? ', folder removed' : ''));
        return { deleted, kept, failed, folderRemoved };
    }

    /**
     * Copy notes to the destination's events after a sync.
     * Notes differing on both drives are merged in 'merge' mode; in 'ask' mode both are left
     * as they were and counted, so the finish screen can say so (#540).
     * @returns {{copied: number, merged: number, conflictsLeft: number}}
     */
    async syncNotes() {
        const res = { copied: 0, merged: 0, conflictsLeft: 0 };
        const notes = this.comparisonResults?.notesComparison;
        if (!notes) return res;
        // The destination's events as they are after the copy (refreshDriveEvents runs later)
        const destEvents = this.destDrive.events || [];
        const findDest = name => destEvents.find(e => e.name === name);
        const destKeyFor = name => {
            const destEvent = findDest(name);
            if (destEvent) return destEvent.compoundKey || name;
            // Copied by this sync: not in the destination's list yet, same key rule as its parser
            return this.destDrive.id ? `${this.destDrive.id}:${name}` : null;
        };

        // Copy source-only notes to destination context
        for (const item of notes.sourceOnly) {
            const destKey = destKeyFor(item.eventName);
            if (destKey) {
                this.notesManager.saveNotes(destKey, { text: item.notes.text || '', tags: Array.isArray(item.notes.tags) ? item.notes.tags : [] });
                res.copied++;
            }
        }

        // Handle conflicts based on settings
        for (const item of notes.conflict) {
            const destKey = destKeyFor(item.eventName);
            if (!destKey) continue;
            if (this.settings.noteConflictMode === 'merge') {
                this.notesManager.saveNotes(destKey, this.mergeNotes(item.sourceNotes, item.destNotes));
                res.merged++;
            } else {
                res.conflictsLeft++;
            }
        }
        console.log(`[DriveSync] Notes: ${res.copied} copied, ${res.merged} merged, ${res.conflictsLeft} left as they were`);
        return res;
    }

    /**
     * Every event's notes, from NotesManager's store (localStorage)
     * @returns {Object} key -> {text, tags}
     */
    _allNotes() {
        try {
            const key = this.notesManager?.STORAGE_KEY || 'teslacamviewer_notes';
            const data = JSON.parse(localStorage.getItem(key) || '{}');
            return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
        } catch (error) {
            console.warn('[DriveSync] Unable to read notes:', error);
            return {};
        }
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
        const allNotes = this._allNotes();
        for (const event of (this.destDrive.events || [])) {
            const key = event.compoundKey || event.name;
            const notes = Object.prototype.hasOwnProperty.call(allNotes, key) ? allNotes[key] : null;
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
