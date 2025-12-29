/**
 * EventDataBackup - Backup notes, tags, and bookmarks to event folders
 *
 * This module ensures user data (notes, tags, bookmarks) is saved directly
 * to the event folder on the drive, so it travels with the drive and can't
 * be lost if browser localStorage is cleared.
 *
 * Backup file: .teslacam-userdata.json in each event folder
 */

class EventDataBackup {
    constructor() {
        this.BACKUP_FILENAME = '.teslacam-userdata.json';
        this.pendingWrites = new Map(); // eventKey -> timeout
        this.writeDelay = 1000; // Debounce writes by 1 second
    }

    /**
     * Save user data (notes, tags, bookmarks) to the event folder
     * @param {Object} event - Event object with folderHandle
     * @param {Object} data - { notes: { text, tags }, bookmarks: [] }
     */
    async saveToEventFolder(event, data) {
        if (!event || !event.folderHandle) {
            console.warn('Cannot backup: no folder handle for event', event?.name);
            return false;
        }

        const eventKey = event.compoundKey || event.name;

        // Debounce writes to avoid excessive disk I/O
        if (this.pendingWrites.has(eventKey)) {
            clearTimeout(this.pendingWrites.get(eventKey));
        }

        return new Promise((resolve) => {
            const timeout = setTimeout(async () => {
                this.pendingWrites.delete(eventKey);
                try {
                    await this._writeBackupFile(event, data);
                    resolve(true);
                } catch (error) {
                    console.warn('Failed to write backup:', error);
                    resolve(false);
                }
            }, this.writeDelay);

            this.pendingWrites.set(eventKey, timeout);
        });
    }

    /**
     * Save immediately without debounce (for sync operations)
     */
    async saveImmediately(event, data) {
        if (!event || !event.folderHandle) {
            return false;
        }

        const eventKey = event.compoundKey || event.name;

        // Clear any pending debounced write
        if (this.pendingWrites.has(eventKey)) {
            clearTimeout(this.pendingWrites.get(eventKey));
            this.pendingWrites.delete(eventKey);
        }

        try {
            await this._writeBackupFile(event, data);
            return true;
        } catch (error) {
            console.warn('Failed to write backup:', error);
            return false;
        }
    }

    /**
     * Actually write the backup file to the event folder
     */
    async _writeBackupFile(event, data) {
        const folderHandle = event.folderHandle;

        // Request write permission if needed
        const permission = await folderHandle.queryPermission({ mode: 'readwrite' });
        if (permission !== 'granted') {
            const newPermission = await folderHandle.requestPermission({ mode: 'readwrite' });
            if (newPermission !== 'granted') {
                throw new Error('Write permission denied');
            }
        }

        const backupData = {
            version: 1,
            eventName: event.name,
            lastModified: new Date().toISOString(),
            notes: data.notes || { text: '', tags: [] },
            bookmarks: data.bookmarks || []
        };

        // Only write if there's actual data
        const hasData = (backupData.notes.text || backupData.notes.tags?.length > 0 ||
                        backupData.bookmarks.length > 0);

        if (!hasData) {
            // Try to delete the backup file if no data
            try {
                await folderHandle.removeEntry(this.BACKUP_FILENAME);
            } catch (e) {
                // File doesn't exist, that's fine
            }
            return;
        }

        const fileHandle = await folderHandle.getFileHandle(this.BACKUP_FILENAME, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(backupData, null, 2));
        await writable.close();
    }

    /**
     * Load user data from an event folder's backup file
     * @param {Object} event - Event object with folderHandle
     * @returns {Object|null} { notes: { text, tags }, bookmarks: [] } or null
     */
    async loadFromEventFolder(event) {
        if (!event || !event.folderHandle) {
            return null;
        }

        try {
            const fileHandle = await event.folderHandle.getFileHandle(this.BACKUP_FILENAME);
            const file = await fileHandle.getFile();
            const text = await file.text();
            const data = JSON.parse(text);

            return {
                notes: data.notes || { text: '', tags: [] },
                bookmarks: data.bookmarks || [],
                lastModified: data.lastModified
            };
        } catch (error) {
            // File doesn't exist or can't be read
            return null;
        }
    }

    /**
     * Load all backup data from a drive's events
     * Returns a map of eventName -> backup data
     * @param {Array} events - Array of event objects
     * @returns {Map} eventName -> { notes, bookmarks }
     */
    async loadAllFromDrive(events) {
        const backups = new Map();

        // Load in parallel with limited concurrency
        const batchSize = 10;
        for (let i = 0; i < events.length; i += batchSize) {
            const batch = events.slice(i, i + batchSize);
            const results = await Promise.all(
                batch.map(async (event) => {
                    const data = await this.loadFromEventFolder(event);
                    return { event, data };
                })
            );

            for (const { event, data } of results) {
                if (data) {
                    backups.set(event.compoundKey || event.name, data);
                }
            }
        }

        return backups;
    }

    /**
     * Merge backup data with localStorage data
     * Newer data wins (based on lastModified)
     * @param {Object} localData - { text, tags } from localStorage
     * @param {Object} backupData - { notes: { text, tags }, lastModified } from backup
     * @param {string} localLastModified - ISO timestamp or undefined
     */
    mergeNotes(localData, backupData, localLastModified) {
        if (!backupData || !backupData.notes) {
            return localData;
        }

        if (!localData || (!localData.text && !localData.tags?.length)) {
            return backupData.notes;
        }

        // If we have timestamps, use the newer one
        if (localLastModified && backupData.lastModified) {
            const localTime = new Date(localLastModified).getTime();
            const backupTime = new Date(backupData.lastModified).getTime();

            if (backupTime > localTime) {
                return backupData.notes;
            }
            return localData;
        }

        // No timestamps - merge: prefer local text but combine tags
        const mergedTags = [...new Set([
            ...(localData.tags || []),
            ...(backupData.notes.tags || [])
        ])].sort();

        return {
            text: localData.text || backupData.notes.text,
            tags: mergedTags
        };
    }

    /**
     * Merge bookmarks from local and backup
     * Combines both, removing duplicates by time
     */
    mergeBookmarks(localBookmarks, backupBookmarks) {
        if (!backupBookmarks || !backupBookmarks.length) {
            return localBookmarks || [];
        }

        if (!localBookmarks || !localBookmarks.length) {
            return backupBookmarks;
        }

        // Combine and dedupe by time (within 0.5 second tolerance)
        const merged = [...localBookmarks];

        for (const backup of backupBookmarks) {
            const exists = merged.some(local =>
                Math.abs(local.time - backup.time) < 0.5
            );
            if (!exists) {
                merged.push({
                    id: backup.id || Date.now() + Math.random(),
                    time: backup.time,
                    label: backup.label
                });
            }
        }

        // Sort by time
        merged.sort((a, b) => a.time - b.time);
        return merged;
    }

    /**
     * Check if a backup file exists for an event
     */
    async hasBackup(event) {
        if (!event || !event.folderHandle) {
            return false;
        }

        try {
            await event.folderHandle.getFileHandle(this.BACKUP_FILENAME);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get the backup filename
     */
    getBackupFilename() {
        return this.BACKUP_FILENAME;
    }
}

// Export singleton instance
window.eventDataBackup = new EventDataBackup();
