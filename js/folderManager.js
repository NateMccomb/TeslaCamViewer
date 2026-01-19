/**
 * FolderManager - Manages multiple TeslaCam folders/drives
 * Supports adding, removing, and switching between multiple drives
 */

class FolderManager {
    constructor() {
        this.drives = [];
        this.activeDriveId = null; // null = all drives
        this.DB_NAME = 'TeslaCamViewerDB';
        this.DB_STORE = 'drives';
        this.DB_VERSION = 2; // Bump version for new store

        // Color palette for drive badges
        this.driveColors = [
            '#4a9eff', // Blue
            '#4caf50', // Green
            '#ff9800', // Orange
            '#e91e63', // Pink
            '#9c27b0', // Purple
            '#00bcd4', // Cyan
            '#ff5722', // Deep Orange
            '#607d8b'  // Blue Grey
        ];

        this.onDrivesChanged = null; // Callback when drives list changes
    }

    /**
     * Generate a UUID v4
     * @returns {string}
     */
    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * Initialize IndexedDB for storing drives
     * @returns {Promise<IDBDatabase>}
     */
    async openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create drives store if it doesn't exist
                if (!db.objectStoreNames.contains(this.DB_STORE)) {
                    const store = db.createObjectStore(this.DB_STORE, { keyPath: 'id' });
                    store.createIndex('label', 'label', { unique: false });
                }

                // Keep the old folderHandles store for backward compatibility
                if (!db.objectStoreNames.contains('folderHandles')) {
                    db.createObjectStore('folderHandles');
                }
            };
        });
    }

    /**
     * Load all drives from IndexedDB
     * @returns {Promise<void>}
     */
    async loadDrives() {
        try {
            const db = await this.openDB();
            const tx = db.transaction(this.DB_STORE, 'readonly');
            const store = tx.objectStore(this.DB_STORE);
            const request = store.getAll();

            const drives = await new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });

            this.drives = drives;
            console.log(`Loaded ${drives.length} drives from IndexedDB`);
        } catch (e) {
            console.warn('Failed to load drives:', e);
            this.drives = [];
        }
    }

    /**
     * Save a drive to IndexedDB
     * @param {Object} drive
     * @returns {Promise<void>}
     */
    async saveDrive(drive) {
        try {
            const db = await this.openDB();
            const tx = db.transaction(this.DB_STORE, 'readwrite');
            const store = tx.objectStore(this.DB_STORE);
            store.put(drive);

            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });

            console.log(`Saved drive ${drive.id} to IndexedDB`);
        } catch (e) {
            console.warn('Failed to save drive:', e);
        }
    }

    /**
     * Delete a drive from IndexedDB
     * @param {string} driveId
     * @returns {Promise<void>}
     */
    async deleteDriveFromDB(driveId) {
        try {
            const db = await this.openDB();
            const tx = db.transaction(this.DB_STORE, 'readwrite');
            const store = tx.objectStore(this.DB_STORE);
            store.delete(driveId);

            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });

            console.log(`Deleted drive ${driveId} from IndexedDB`);
        } catch (e) {
            console.warn('Failed to delete drive:', e);
        }
    }

    /**
     * Add a new drive from a folder handle
     * @param {FileSystemDirectoryHandle} handle
     * @param {Object} options - Drive options
     * @param {string} options.label - Optional custom label
     * @param {boolean} options.isArchive - If true, don't load on startup
     * @param {string} options.dateFilter - Date filter preset (e.g., 'all', 'week', 'month', '3months', '6months', 'year')
     * @returns {Promise<Object>} The created drive object
     */
    async addDrive(handle, options = {}) {
        // Support legacy signature: addDrive(handle, label)
        if (typeof options === 'string') {
            options = { label: options };
        }

        // Check if this drive already exists (by comparing directory handles)
        for (const existingDrive of this.drives) {
            try {
                if (existingDrive.handle && await handle.isSameEntry(existingDrive.handle)) {
                    console.log(`Drive ${handle.name} already exists (same directory), returning existing`);
                    return existingDrive;
                }
            } catch (e) {
                // Handle comparison may fail if permission was revoked, continue checking
            }
        }

        // Assign color based on index
        const colorIndex = this.drives.length % this.driveColors.length;

        const drive = {
            id: this.generateUUID(),
            handle: handle,
            folderName: handle.name,
            label: options.label || this.generateLabel(handle.name),
            color: this.driveColors[colorIndex],
            addedAt: new Date().toISOString(),
            isArchive: options.isArchive || false,
            dateFilter: options.dateFilter || 'all',
            events: [] // Will be populated by FolderParser
        };

        this.drives.push(drive);
        await this.saveDrive(drive);

        if (this.onDrivesChanged) {
            this.onDrivesChanged(this.drives);
        }

        console.log(`Added drive: ${drive.label} (${drive.id})${drive.isArchive ? ' [ARCHIVE]' : ''}`);
        return drive;
    }

    /**
     * Generate a human-readable label from folder name
     * @param {string} folderName
     * @returns {string}
     */
    generateLabel(folderName) {
        // If folder name is TeslaCam, use parent-like naming
        if (folderName === 'TeslaCam') {
            const driveNum = this.drives.length + 1;
            return `Drive ${driveNum}`;
        }

        // Try to extract meaningful name
        // Common patterns: USB drive names, date-based names, etc.
        const cleanName = folderName
            .replace(/[_-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Capitalize first letter of each word
        return cleanName.replace(/\b\w/g, l => l.toUpperCase());
    }

    /**
     * Remove a drive by ID
     * @param {string} driveId
     * @returns {Promise<boolean>}
     */
    async removeDrive(driveId) {
        const index = this.drives.findIndex(d => d.id === driveId);
        if (index === -1) {
            return false;
        }

        this.drives.splice(index, 1);
        await this.deleteDriveFromDB(driveId);

        // Reset active drive if it was removed
        if (this.activeDriveId === driveId) {
            this.activeDriveId = null;
        }

        if (this.onDrivesChanged) {
            this.onDrivesChanged(this.drives);
        }

        console.log(`Removed drive: ${driveId}`);
        return true;
    }

    /**
     * Update drive label
     * @param {string} driveId
     * @param {string} newLabel
     * @returns {Promise<boolean>}
     */
    async updateDriveLabel(driveId, newLabel) {
        const drive = this.drives.find(d => d.id === driveId);
        if (!drive) {
            return false;
        }

        drive.label = newLabel;
        await this.saveDrive(drive);

        if (this.onDrivesChanged) {
            this.onDrivesChanged(this.drives);
        }

        return true;
    }

    /**
     * Update drive color
     * @param {string} driveId
     * @param {string} newColor
     * @returns {Promise<boolean>}
     */
    async updateDriveColor(driveId, newColor) {
        const drive = this.drives.find(d => d.id === driveId);
        if (!drive) {
            return false;
        }

        drive.color = newColor;
        await this.saveDrive(drive);

        if (this.onDrivesChanged) {
            this.onDrivesChanged(this.drives);
        }

        return true;
    }

    /**
     * Update drive settings (archive status, date filter)
     * @param {string} driveId
     * @param {Object} settings
     * @param {boolean} settings.isArchive
     * @param {string} settings.dateFilter
     * @param {string} settings.label
     * @returns {Promise<boolean>}
     */
    async updateDriveSettings(driveId, settings) {
        const drive = this.drives.find(d => d.id === driveId);
        if (!drive) {
            return false;
        }

        if (settings.label !== undefined) {
            drive.label = settings.label;
        }
        if (settings.isArchive !== undefined) {
            drive.isArchive = settings.isArchive;
        }
        if (settings.dateFilter !== undefined) {
            drive.dateFilter = settings.dateFilter;
        }

        await this.saveDrive(drive);

        if (this.onDrivesChanged) {
            this.onDrivesChanged(this.drives);
        }

        return true;
    }

    /**
     * Get human-readable date filter label
     * @param {string} filter
     * @returns {string}
     */
    getDateFilterLabel(filter) {
        const labels = {
            'all': 'All events',
            'week': 'Last week',
            'month': 'Last month',
            '3months': 'Last 3 months',
            '6months': 'Last 6 months',
            'year': 'Last year'
        };
        return labels[filter] || labels['all'];
    }

    /**
     * Get date cutoff for a filter
     * @param {string} filter
     * @returns {Date|null} Cutoff date or null for 'all'
     */
    getDateFilterCutoff(filter) {
        if (filter === 'all') return null;

        const now = new Date();
        switch (filter) {
            case 'week':
                return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            case 'month':
                return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            case '3months':
                return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            case '6months':
                return new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
            case 'year':
                return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
            default:
                return null;
        }
    }

    /**
     * Set the active drive for filtering
     * @param {string|null} driveId - null for all drives
     */
    setActiveDrive(driveId) {
        this.activeDriveId = driveId;

        if (this.onDrivesChanged) {
            this.onDrivesChanged(this.drives);
        }
    }

    /**
     * Get all drives
     * @returns {Array}
     */
    getDrives() {
        return this.drives;
    }

    /**
     * Get a specific drive by ID
     * @param {string} driveId
     * @returns {Object|null}
     */
    getDrive(driveId) {
        return this.drives.find(d => d.id === driveId) || null;
    }

    /**
     * Get the active drive or null for all drives
     * @returns {Object|null}
     */
    getActiveDrive() {
        if (!this.activeDriveId) {
            return null;
        }
        return this.getDrive(this.activeDriveId);
    }

    /**
     * Generate a compound key for an event
     * @param {string} driveId
     * @param {string} eventName
     * @returns {string}
     */
    getCompoundKey(driveId, eventName) {
        return `${driveId}:${eventName}`;
    }

    /**
     * Parse a compound key back to driveId and eventName
     * @param {string} compoundKey
     * @returns {{driveId: string, eventName: string}|null}
     */
    parseCompoundKey(compoundKey) {
        if (!compoundKey || !compoundKey.includes(':')) {
            return null;
        }
        const colonIndex = compoundKey.indexOf(':');
        return {
            driveId: compoundKey.substring(0, colonIndex),
            eventName: compoundKey.substring(colonIndex + 1)
        };
    }

    /**
     * Request permission for all stored drives
     * @param {boolean} includeArchive - If false, skip archive drives
     * @returns {Promise<Array>} Array of drives that were successfully restored
     */
    async restoreAllDrives(includeArchive = false) {
        const restoredDrives = [];

        for (const drive of this.drives) {
            if (!drive.handle) {
                console.log(`Drive ${drive.id} has no handle, skipping`);
                continue;
            }

            // Skip archive drives unless explicitly requested
            if (drive.isArchive && !includeArchive) {
                console.log(`Drive ${drive.label} is archive, skipping auto-load`);
                continue;
            }

            try {
                const permission = await drive.handle.requestPermission({ mode: 'read' });
                if (permission === 'granted') {
                    restoredDrives.push(drive);
                    console.log(`Restored access to drive: ${drive.label}${drive.isArchive ? ' [ARCHIVE]' : ''}`);
                } else {
                    console.log(`Permission denied for drive: ${drive.label}`);
                }
            } catch (e) {
                console.warn(`Failed to restore drive ${drive.label}:`, e);
            }
        }

        return restoredDrives;
    }

    /**
     * Restore a single archive drive (for manual sync)
     * @param {string} driveId
     * @returns {Promise<Object|null>} The restored drive or null
     */
    async restoreArchiveDrive(driveId) {
        const drive = this.drives.find(d => d.id === driveId);
        if (!drive || !drive.handle) {
            return null;
        }

        try {
            const permission = await drive.handle.requestPermission({ mode: 'read' });
            if (permission === 'granted') {
                console.log(`Restored access to archive drive: ${drive.label}`);
                return drive;
            }
        } catch (e) {
            console.warn(`Failed to restore archive drive ${drive.label}:`, e);
        }

        return null;
    }

    /**
     * Parse all drives and aggregate events
     * @param {FolderParser} parser - The folder parser instance
     * @param {Array} drivesToParse - Optional specific drives to parse (defaults to all non-archive with handles)
     * @returns {Promise<Array>} All events from all drives
     */
    async parseAllDrives(parser, drivesToParse = null) {
        const allEvents = [];
        const targetDrives = drivesToParse || this.drives.filter(d => d.handle && !d.isArchive);

        for (const drive of targetDrives) {
            if (!drive.handle) {
                continue;
            }

            try {
                // Set the parser's root handle to this drive's handle
                parser.rootHandle = drive.handle;

                // Parse the folder
                let events = await parser.parseFolder();

                // Apply date filter if set
                const cutoff = this.getDateFilterCutoff(drive.dateFilter);
                if (cutoff) {
                    const beforeCount = events.length;
                    events = events.filter(event => {
                        const eventDate = new Date(event.timestamp);
                        return eventDate >= cutoff;
                    });
                    console.log(`Date filter (${drive.dateFilter}): ${beforeCount} → ${events.length} events`);
                }

                // Add driveId and compoundKey to each event
                for (const event of events) {
                    event.driveId = drive.id;
                    event.compoundKey = this.getCompoundKey(drive.id, event.name);
                    event.driveLabel = drive.label;
                    event.driveColor = drive.color;
                }

                // Store events in the drive object
                drive.events = events;

                allEvents.push(...events);
                console.log(`Parsed ${events.length} events from drive: ${drive.label}${drive.isArchive ? ' [ARCHIVE]' : ''}`);
            } catch (e) {
                console.warn(`Failed to parse drive ${drive.label}:`, e);
            }
        }

        // Sort all events by timestamp (newest first)
        allEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        return allEvents;
    }

    /**
     * Parse a single drive (for manual sync of archive drives)
     * @param {FolderParser} parser
     * @param {string} driveId
     * @returns {Promise<Array>} Events from the drive
     */
    async parseSingleDrive(parser, driveId) {
        const drive = this.drives.find(d => d.id === driveId);
        if (!drive || !drive.handle) {
            return [];
        }

        return this.parseAllDrives(parser, [drive]);
    }

    /**
     * Get events filtered by active drive
     * @returns {Array}
     */
    getFilteredEvents() {
        if (!this.activeDriveId) {
            // Return all events from all drives
            return this.drives.flatMap(d => d.events || [])
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        }

        const activeDrive = this.getDrive(this.activeDriveId);
        return activeDrive?.events || [];
    }

    /**
     * Check if multiple drives are loaded
     * @returns {boolean}
     */
    hasMultipleDrives() {
        return this.drives.length > 1;
    }

    /**
     * Get total event count across all drives
     * @returns {number}
     */
    getTotalEventCount() {
        return this.drives.reduce((sum, d) => sum + (d.events?.length || 0), 0);
    }

    /**
     * Clear all drives
     * @returns {Promise<void>}
     */
    async clearAllDrives() {
        for (const drive of [...this.drives]) {
            await this.deleteDriveFromDB(drive.id);
        }

        this.drives = [];
        this.activeDriveId = null;

        if (this.onDrivesChanged) {
            this.onDrivesChanged(this.drives);
        }
    }

    /**
     * Migrate from legacy single-folder storage
     * @param {FileSystemDirectoryHandle} legacyHandle
     * @returns {Promise<Object|null>} The migrated drive or null
     */
    async migrateFromLegacy(legacyHandle) {
        if (!legacyHandle) {
            return null;
        }

        console.log('Migrating legacy folder to multi-drive system...');

        // Add as first drive
        const drive = await this.addDrive(legacyHandle, 'Primary Drive');

        return drive;
    }
}
