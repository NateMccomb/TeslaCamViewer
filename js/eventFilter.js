/**
 * EventFilter - Handles filtering and sorting of events
 */

class EventFilter {
    constructor() {
        this.filters = {
            types: {
                SavedClips: true,
                SentryClips: true,
                RecentClips: true
            },
            dateRange: {
                start: null,
                end: null
            },
            searchQuery: '',
            sortOrder: 'newest', // 'newest' or 'oldest'
            hasBookmarks: false, // Only show events with bookmarks
            hasNotes: false, // Only show events with notes/tags
            selectedTag: '' // Filter by specific tag
        };
        this.BOOKMARKS_STORAGE_KEY = 'teslacamviewer_bookmarks';
        this.NOTES_STORAGE_KEY = 'teslacamviewer_notes';
    }

    /**
     * Get all bookmarked event IDs from localStorage
     * @returns {Set<string>}
     */
    getBookmarkedEventIds() {
        try {
            const stored = localStorage.getItem(this.BOOKMARKS_STORAGE_KEY);
            if (stored) {
                const allBookmarks = JSON.parse(stored);
                // Return event IDs that have at least one bookmark
                return new Set(
                    Object.keys(allBookmarks).filter(key => Array.isArray(allBookmarks[key]) && allBookmarks[key].length > 0)
                );
            }
        } catch (e) {
            console.warn('Failed to load bookmarks for filtering:', e);
        }
        return new Set();
    }

    /**
     * Get all notes/tags data from localStorage
     * @returns {Object}
     */
    getNotesData() {
        try {
            const stored = localStorage.getItem(this.NOTES_STORAGE_KEY);
            return stored ? JSON.parse(stored) : {};
        } catch (e) {
            console.warn('Failed to load notes for filtering:', e);
            return {};
        }
    }

    /**
     * Get all unique tags across all events
     * @returns {Array<string>}
     */
    getAllTags() {
        const notesData = this.getNotesData();
        const tags = new Set();
        Object.values(notesData).forEach(note => {
            if (note.tags && Array.isArray(note.tags)) {
                note.tags.forEach(tag => { if (typeof tag === 'string') tags.add(tag.toLowerCase()); });
            }
        });
        return Array.from(tags).sort();
    }

    /**
     * Apply all active filters to events array
     * @param {Array} events
     * @returns {Array} Filtered and sorted events
     */
    applyFilters(events) {
        if (!events || events.length === 0) {
            return [];
        }

        // Get bookmarked event IDs once for efficiency
        const bookmarkedIds = this.filters.hasBookmarks ? this.getBookmarkedEventIds() : null;

        // Get notes data once for efficiency
        const notesData = (this.filters.hasNotes || this.filters.selectedTag) ? this.getNotesData() : null;

        return events
            .filter(event => this.filterByType(event))
            .filter(event => this.filterByDate(event))
            .filter(event => this.filterBySearch(event))
            .filter(event => this.filterByBookmarks(event, bookmarkedIds))
            .filter(event => this.filterByNotes(event, notesData))
            .filter(event => this.filterByTag(event, notesData))
            .sort((a, b) => this.sortEvents(a, b));
    }

    /**
     * Filter by notes/tags presence
     * @param {Object} event
     * @param {Object|null} notesData - Pre-fetched notes data
     * @returns {boolean}
     */
    filterByNotes(event, notesData) {
        if (!this.filters.hasNotes || !notesData) {
            return true;
        }
        const notes = EventFilter.lookupByEvent(notesData, event);
        return !!(notes && ((typeof notes.text === 'string' && notes.text.trim()) || (Array.isArray(notes.tags) && notes.tags.length > 0)));
    }

    /**
     * Filter by specific tag
     * @param {Object} event
     * @param {Object|null} notesData - Pre-fetched notes data
     * @returns {boolean}
     */
    filterByTag(event, notesData) {
        if (!this.filters.selectedTag || !notesData) {
            return true;
        }
        const notes = EventFilter.lookupByEvent(notesData, event);
        if (!notes || !Array.isArray(notes.tags)) {
            return false;
        }
        const searchTag = this.filters.selectedTag.toLowerCase();
        return notes.tags.some(tag => typeof tag === 'string' && tag.toLowerCase() === searchTag);
    }

    /**
     * Filter by bookmark status
     * @param {Object} event
     * @param {Set|null} bookmarkedIds - Pre-computed set of bookmarked event IDs
     * @returns {boolean}
     */
    filterByBookmarks(event, bookmarkedIds) {
        // No bookmark filter applied
        if (!this.filters.hasBookmarks || !bookmarkedIds) {
            return true;
        }
        return EventFilter.eventKeys(event).some(k => bookmarkedIds.has(k));
    }

    /**
     * Every storage key an event's notes and bookmarks may be saved under, newest first:
     * the drive-qualified key (multi-drive), the plain folder name (before multi-drive), and the
     * legacy key of a RecentClips hour (once named after the UTC day, see FolderParser).
     * @param {Object} event
     * @returns {string[]}
     */
    static eventKeys(event) {
        if (!event) return [];
        const keys = [event.compoundKey, event.name];
        if (event.legacyName) {
            // RecentClips hours named before 2026.47.5 (FolderParser.legacyEventKey)
            const key = event.compoundKey || event.name;
            keys.push(typeof key === 'string' && key.endsWith(event.name)
                ? key.slice(0, key.length - event.name.length) + event.legacyName : event.legacyName);
        }
        return keys.filter((k, idx) => typeof k === 'string' && k && keys.indexOf(k) === idx);
    }

    /**
     * Look an event up in a map stored by event key (see eventKeys)
     * @param {Object} map
     * @param {Object} event
     * @returns {*} the first entry found, or undefined
     */
    static lookupByEvent(map, event) {
        if (!map) return undefined;
        for (const k of EventFilter.eventKeys(event)) {
            if (Object.prototype.hasOwnProperty.call(map, k)) return map[k];
        }
        return undefined;
    }

    /**
     * Filter by event type
     * @param {Object} event
     * @returns {boolean}
     */
    filterByType(event) {
        return this.filters.types[event.type] === true;
    }

    /**
     * Filter by date range
     * @param {Object} event
     * @returns {boolean}
     */
    filterByDate(event) {
        const { start, end } = this.filters.dateRange;

        // No date filter applied
        if (!start && !end) {
            return true;
        }

        // Parse event timestamp
        const eventDate = new Date(event.timestamp);

        // Check start date
        if (start) {
            const startDate = EventFilter.parseLocalDate(start);
            startDate.setHours(0, 0, 0, 0); // Start of day
            if (eventDate < startDate) {
                return false;
            }
        }

        // Check end date
        if (end) {
            const endDate = EventFilter.parseLocalDate(end);
            endDate.setHours(23, 59, 59, 999); // End of day
            if (eventDate > endDate) {
                return false;
            }
        }

        return true;
    }

    /**
     * Parse a date input value ('YYYY-MM-DD') as LOCAL midnight. new Date('YYYY-MM-DD') is UTC
     * midnight, which is the evening before west of UTC and hid the chosen day's events.
     * @param {string} value
     * @returns {Date}
     */
    static parseLocalDate(value) {
        const m = typeof value === 'string' ? value.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
        return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
    }

    /**
     * Filter by search query (searches city, street, reason)
     * @param {Object} event
     * @returns {boolean}
     */
    filterBySearch(event) {
        const query = this.filters.searchQuery.toLowerCase().trim();

        // No search query
        if (!query) {
            return true;
        }

        // Search in city
        const city = String(event.metadata?.city ?? '');
        if (city.toLowerCase().includes(query)) {
            return true;
        }

        // Search in street
        const street = String(event.metadata?.street ?? '');
        if (street.toLowerCase().includes(query)) {
            return true;
        }

        // Search in reason
        const reason = String(event.metadata?.reason ?? '');
        if (reason.toLowerCase().includes(query)) {
            return true;
        }

        // Search in formatted reason
        const formattedReason = FolderParser.formatReason(event.metadata?.reason);
        if (formattedReason && formattedReason.toLowerCase().includes(query)) {
            return true;
        }

        // Search in event type
        if (String(event.type || '').toLowerCase().includes(query)) {
            return true;
        }

        return false;
    }

    /**
     * Sort events by timestamp
     * @param {Object} a
     * @param {Object} b
     * @returns {number}
     */
    sortEvents(a, b) {
        const dateA = new Date(a.timestamp);
        const dateB = new Date(b.timestamp);

        if (this.filters.sortOrder === 'newest') {
            return dateB - dateA; // Newest first (descending)
        } else {
            return dateA - dateB; // Oldest first (ascending)
        }
    }

    /**
     * Update filter values
     * @param {Object} newFilters
     */
    setFilters(newFilters) {
        if (newFilters.types !== undefined) {
            this.filters.types = { ...this.filters.types, ...newFilters.types };
        }
        if (newFilters.dateRange !== undefined) {
            this.filters.dateRange = { ...this.filters.dateRange, ...newFilters.dateRange };
        }
        if (newFilters.searchQuery !== undefined) {
            this.filters.searchQuery = newFilters.searchQuery;
        }
        if (newFilters.sortOrder !== undefined) {
            this.filters.sortOrder = newFilters.sortOrder;
        }
        if (newFilters.hasBookmarks !== undefined) {
            this.filters.hasBookmarks = newFilters.hasBookmarks;
        }
        if (newFilters.hasNotes !== undefined) {
            this.filters.hasNotes = newFilters.hasNotes;
        }
        if (newFilters.selectedTag !== undefined) {
            this.filters.selectedTag = newFilters.selectedTag;
        }
    }

    /**
     * Reset all filters to defaults
     */
    reset() {
        this.filters = {
            types: {
                SavedClips: true,
                SentryClips: true,
                RecentClips: true
            },
            dateRange: {
                start: null,
                end: null
            },
            searchQuery: '',
            sortOrder: 'newest',
            hasBookmarks: false,
            hasNotes: false,
            selectedTag: ''
        };
    }

    /**
     * Get count of active filters (non-default)
     * @returns {number}
     */
    getActiveFilterCount() {
        let count = 0;

        // Check if any event type is disabled
        const allTypesEnabled = Object.values(this.filters.types).every(v => v === true);
        if (!allTypesEnabled) {
            count++;
        }

        // Check date range
        if (this.filters.dateRange.start || this.filters.dateRange.end) {
            count++;
        }

        // Check search query
        if (this.filters.searchQuery.trim().length > 0) {
            count++;
        }

        // Check sort order (if not default 'newest')
        if (this.filters.sortOrder !== 'newest') {
            count++;
        }

        // Check bookmark filter
        if (this.filters.hasBookmarks) {
            count++;
        }

        // Check notes filter
        if (this.filters.hasNotes) {
            count++;
        }

        // Check tag filter
        if (this.filters.selectedTag) {
            count++;
        }

        return count;
    }

    /**
     * Get current filter state
     * @returns {Object}
     */
    getFilters() {
        return { ...this.filters };
    }
}
