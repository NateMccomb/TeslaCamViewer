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
        const fileName = this.backupFileName(event);

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
                await folderHandle.removeEntry(fileName);
            } catch (e) {
                // File doesn't exist, that's fine
            }
            return;
        }

        const fileHandle = await folderHandle.getFileHandle(fileName, { create: true });
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

        const read = async (fileName) => {
            const fileHandle = await event.folderHandle.getFileHandle(fileName);
            const file = await fileHandle.getFile();
            if (file.size > EventDataBackup.LIMITS.fileBytes) {
                console.warn(`[EventDataBackup] ${event.name}: backup file too large (${file.size} bytes), ignored`);
                return null;
            }
            // The file comes from a drive: anything could be in it (#523)
            return JSON.parse(await file.text());
        };
        try {
            return EventDataBackup.sanitizeBackup(await read(this.backupFileName(event)));
        } catch (error) {
            // no backup of its own
        }
        if (!event.flatFolder) return null;
        // RecentClips before 2026.47.5: one shared file for every hour, which held whichever hour
        // was saved last. Use it only for the hour it names (#535).
        try {
            const shared = await read(this.BACKUP_FILENAME);
            const owner = shared && typeof shared.eventName === 'string' ? shared.eventName : null;
            if (owner && (owner === event.name || owner === event.legacyName)) {
                return EventDataBackup.sanitizeBackup(shared);
            }
        } catch (error) {
            // none
        }
        return null;
    }

    /**
     * Name of an event's backup file. RecentClips is one flat folder shared by every hour,
     * so each hour gets its own file there (".teslacam-userdata-recent-2026-11-17_15.json");
     * before, all hours wrote the same file and their notes and bookmarks bled into each other (#535).
     * @param {Object} event
     * @returns {string}
     */
    backupFileName(event) {
        const hourKey = event?.metadata?.hourKey;
        if (event?.flatFolder && typeof hourKey === 'string' && /^\d{4}-\d{2}-\d{2}_\d{2}$/.test(hourKey)) {
            return `.teslacam-userdata-recent-${hourKey}.json`;
        }
        return this.BACKUP_FILENAME;
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
        return EventDataBackup.sanitizeNotes(this._mergeNotes(localData, backupData, localLastModified));
    }

    _mergeNotes(localData, backupData, localLastModified) {
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
        return EventDataBackup.sanitizeBookmarks(this._mergeBookmarks(localBookmarks, backupBookmarks));
    }

    _mergeBookmarks(localBookmarks, backupBookmarks) {
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

    // ==================== Validation (#523) ====================
    // Notes, tags and bookmarks come back from .teslacam-userdata.json files on
    // drives, and anyone can write one. They are validated on the way in
    // (types, lengths, allowed characters) and escaped wherever they are shown.
    // Stored data from before this check is cleaned once on every page load.

    static get LIMITS() {
        return {
            fileBytes: 1024 * 1024,   // a real backup file is a few KB
            noteText: 2000,           // the notes textarea's maxlength
            tag: 30,                  // the tag input's maxlength
            tagsPerEvent: 50,
            label: 100,
            bookmarksPerEvent: 1000,
            bookmarkTime: 24 * 3600,  // seconds into the event
            storedKey: 300
        };
    }

    /** Remove control characters (keeps tab and newlines when multiline). */
    static _stripControl(s, multiline) {
        return multiline
            ? s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
            : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
    }

    /**
     * A tag as the app stores it (lowercase, trimmed, at most 30 characters
     * of letters, digits, spaces and a few punctuation marks), or null.
     */
    static sanitizeTag(tag) {
        if (typeof tag !== 'string') return null;
        const t = tag.normalize('NFC')
            .replace(/[^\p{L}\p{M}\p{N} _\-.,:;!?#&+'()\/@*%=~$[\]]/gu, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
            .slice(0, EventDataBackup.LIMITS.tag)
            .trim();
        return t || null;
    }

    /** {text, tags} with only valid content; anything else becomes empty. */
    static sanitizeNotes(notes) {
        const L = EventDataBackup.LIMITS;
        const n = notes && typeof notes === 'object' ? notes : {};
        const text = typeof n.text === 'string'
            ? EventDataBackup._stripControl(n.text, true).slice(0, L.noteText)
            : '';
        const tags = [];
        for (const raw of Array.isArray(n.tags) ? n.tags : []) {
            const tag = EventDataBackup.sanitizeTag(raw);
            if (tag && !tags.includes(tag)) tags.push(tag);
            if (tags.length >= L.tagsPerEvent) break;
        }
        return { text, tags };
    }

    /** Bookmarks with a numeric id, a time in range and a plain-text label. */
    static sanitizeBookmarks(list) {
        const L = EventDataBackup.LIMITS;
        const out = [];
        const ids = new Set();
        for (const b of Array.isArray(list) ? list : []) {
            if (!b || typeof b !== 'object') continue;
            const time = typeof b.time === 'number' ? b.time : (typeof b.time === 'string' ? Number(b.time) : NaN);
            if (!Number.isFinite(time) || time < 0 || time > L.bookmarkTime) continue;
            let id = typeof b.id === 'number' ? b.id
                : (typeof b.id === 'string' && /^\d{1,16}(\.\d+)?$/.test(b.id) ? Number(b.id) : NaN);
            id = Number.isFinite(id) && id > 0 ? Math.floor(id) : 0;
            while (!id || ids.has(id)) id = Date.now() + out.length + ids.size + 1;
            ids.add(id);
            let label = typeof b.label === 'string'
                ? EventDataBackup._stripControl(b.label, false).replace(/[<>]/g, '').trim().slice(0, L.label)
                : '';
            if (!label) label = `Bookmark ${out.length + 1}`;
            out.push({ id, time, label });
            if (out.length >= L.bookmarksPerEvent) break;
        }
        return out;
    }

    /** A parsed .teslacam-userdata.json reduced to what the app uses. */
    static sanitizeBackup(data) {
        const d = data && typeof data === 'object' ? data : {};
        const lastModified = typeof d.lastModified === 'string' && !Number.isNaN(Date.parse(d.lastModified))
            ? d.lastModified.slice(0, 40) : undefined;
        return {
            notes: EventDataBackup.sanitizeNotes(d.notes),
            bookmarks: EventDataBackup.sanitizeBookmarks(d.bookmarks),
            lastModified
        };
    }

    /**
     * Clean the notes and bookmarks already in localStorage: older versions
     * stored drive backups without checking them, and the filter panel
     * rendered those tags on every visit, with no drive opened.
     * @returns {{notes: number, bookmarks: number}} entries changed or removed
     */
    static cleanStoredUserData(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
        const changed = { notes: 0, bookmarks: 0 };
        if (!storage) return changed;
        const L = EventDataBackup.LIMITS;
        const badKey = k => k.length > L.storedKey || k === '__proto__' || k === 'constructor' || k === 'prototype';
        const clean = (storageKey, fn, counter) => {
            let raw;
            try { raw = storage.getItem(storageKey); } catch (e) { return; }
            if (!raw) return;
            let all;
            try { all = JSON.parse(raw); } catch (e) { all = null; }
            if (!all || typeof all !== 'object' || Array.isArray(all)) {
                try { storage.removeItem(storageKey); } catch (e) { /* ignore */ }
                changed[counter]++;
                return;
            }
            const out = {};
            for (const [key, value] of Object.entries(all)) {
                if (badKey(key)) { changed[counter]++; continue; }
                const v = fn(value);
                if (v === null) { changed[counter]++; continue; }
                if (JSON.stringify(v) !== JSON.stringify(value)) changed[counter]++;
                out[key] = v;
            }
            if (changed[counter] > 0) {
                try { storage.setItem(storageKey, JSON.stringify(out)); } catch (e) { /* ignore */ }
            }
        };
        clean('teslacamviewer_notes', v => {
            const n = EventDataBackup.sanitizeNotes(v);
            return n.text || n.tags.length ? n : null;
        }, 'notes');
        clean('teslacamviewer_bookmarks', v => {
            const b = EventDataBackup.sanitizeBookmarks(v);
            return b.length ? b : null;
        }, 'bookmarks');
        if (changed.notes || changed.bookmarks) {
            console.warn(`[EventDataBackup] Cleaned stored user data: ${changed.notes} notes entries, ${changed.bookmarks} bookmark lists`);
        }
        return changed;
    }
}

// Export singleton instance
window.eventDataBackup = new EventDataBackup();
window.EventDataBackup = EventDataBackup;

// Runs before the app starts (this file loads before app.js), so nothing
// renders from unchecked stored data.
EventDataBackup.cleanStoredUserData();
