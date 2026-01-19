/**
 * NotesManager - Manages notes and tags for events
 * Stores data in localStorage and backs up to event folders
 */
class NotesManager {
    constructor() {
        this.STORAGE_KEY = 'teslacamviewer_notes';
        this.modal = null;
        this.currentEvent = null;
        this.onNotesChanged = null; // Callback for when notes are saved
        this.eventLookup = new Map(); // eventKey -> event object with folderHandle
        this.getBookmarksForEvent = null; // Function to get bookmarks for an event

        // Listen for locale changes to re-render modal
        window.addEventListener('localeChanged', () => {
            if (this.modal && this.currentEvent) {
                this.showModal(this.currentEvent);
            }
        });
    }

    /**
     * Get translation helper
     */
    t(key) {
        return window.i18n ? window.i18n.t(key) : key.split('.').pop();
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
     * Set function to get bookmarks for an event
     * @param {Function} fn - Function that takes eventKey and returns bookmarks array
     */
    setBookmarksGetter(fn) {
        this.getBookmarksForEvent = fn;
    }

    /**
     * Get notes for a specific event
     * @param {string} eventName - Event identifier (folder name)
     * @returns {Object} Notes object with text and tags
     */
    getNotes(eventName) {
        const defaultNotes = { text: '', tags: [] };
        if (!eventName) return defaultNotes;

        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) {
                const allNotes = JSON.parse(stored);
                const notes = allNotes[eventName];
                if (!notes) return defaultNotes;

                // Ensure proper structure (handles old notes without tags)
                return {
                    text: notes.text || '',
                    tags: Array.isArray(notes.tags) ? notes.tags : []
                };
            }
        } catch (e) {
            console.warn('Failed to load notes:', e);
        }
        return defaultNotes;
    }

    /**
     * Save notes for an event
     * @param {string} eventName - Event identifier
     * @param {Object} notes - Notes object with text and tags
     */
    saveNotes(eventName, notes) {
        if (!eventName) {
            console.warn('[NotesManager] saveNotes called with no eventName');
            return;
        }

        console.log('[NotesManager] Saving notes for:', eventName, 'Data:', notes);

        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            const allNotes = stored ? JSON.parse(stored) : {};

            // Only save if there's actual content
            if (notes.text.trim() || notes.tags.length > 0) {
                allNotes[eventName] = {
                    text: notes.text.trim(),
                    tags: notes.tags.filter(t => t.trim())
                };
                console.log('[NotesManager] Saved entry:', allNotes[eventName]);
            } else {
                // Remove entry if empty
                delete allNotes[eventName];
                console.log('[NotesManager] Removed empty entry for:', eventName);
            }

            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(allNotes));

            // Backup to event folder if available
            this.backupToEventFolder(eventName, notes);

            // Notify listeners
            if (this.onNotesChanged) {
                this.onNotesChanged(eventName, notes);
            }
        } catch (e) {
            console.warn('Failed to save notes:', e);
        }
    }

    /**
     * Backup notes and bookmarks to the event folder
     * @param {string} eventName - Event identifier
     * @param {Object} notes - Notes object with text and tags
     */
    async backupToEventFolder(eventName, notes) {
        // Get the event object with folderHandle
        const event = this.eventLookup.get(eventName);
        if (!event) {
            console.log('[NotesManager] No event registered for backup:', eventName);
            return;
        }

        // Get bookmarks if getter is available
        let bookmarks = [];
        if (this.getBookmarksForEvent) {
            try {
                bookmarks = this.getBookmarksForEvent(eventName) || [];
            } catch (e) {
                console.warn('[NotesManager] Failed to get bookmarks for backup:', e);
            }
        }

        // Use the backup module
        if (window.eventDataBackup) {
            const backupData = {
                notes: {
                    text: notes.text?.trim() || '',
                    tags: notes.tags || []
                },
                bookmarks: bookmarks
            };

            try {
                await window.eventDataBackup.saveToEventFolder(event, backupData);
                console.log('[NotesManager] Backup queued for:', eventName);
            } catch (e) {
                console.warn('[NotesManager] Failed to backup to event folder:', e);
            }
        }
    }

    /**
     * Get all unique tags across all events
     * @returns {Array} Sorted array of unique tags
     */
    getAllTags() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) {
                const allNotes = JSON.parse(stored);
                const tags = new Set();
                Object.values(allNotes).forEach(note => {
                    if (note.tags && Array.isArray(note.tags)) {
                        note.tags.forEach(tag => tags.add(tag.toLowerCase()));
                    }
                });
                return Array.from(tags).sort();
            }
        } catch (e) {
            console.warn('Failed to get tags:', e);
        }
        return [];
    }

    /**
     * Get events that have a specific tag
     * @param {string} tag - Tag to search for
     * @returns {Array} Array of event names with this tag
     */
    getEventsByTag(tag) {
        if (!tag) return [];

        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) {
                const allNotes = JSON.parse(stored);
                const lowerTag = tag.toLowerCase();
                return Object.entries(allNotes)
                    .filter(([_, note]) => note.tags?.some(t => t.toLowerCase() === lowerTag))
                    .map(([eventName]) => eventName);
            }
        } catch (e) {
            console.warn('Failed to get events by tag:', e);
        }
        return [];
    }

    /**
     * Check if an event has notes or tags
     * @param {string} eventName - Event identifier
     * @returns {boolean}
     */
    hasNotes(eventName) {
        const notes = this.getNotes(eventName);
        return notes.text.trim().length > 0 || notes.tags.length > 0;
    }

    /**
     * Show notes modal for an event
     * @param {Object} event - Event object
     */
    showModal(event) {
        if (!event) return;

        this.currentEvent = event;
        // Use compoundKey for storage (multi-drive support), fallback to name for legacy events
        const storageKey = event.compoundKey || event.name || event.folder?.name;
        const displayName = event.name || event.folder?.name;
        console.log('[NotesManager] showModal for event:', displayName, 'Storage key:', storageKey);
        const notes = this.getNotes(storageKey);
        console.log('[NotesManager] Loaded notes:', notes);
        const allTags = this.getAllTags();

        // Remove existing modal
        if (this.modal) {
            this.modal.remove();
        }

        this.modal = document.createElement('div');
        this.modal.className = 'notes-modal';
        this.modal.innerHTML = `
            <div class="notes-overlay"></div>
            <div class="notes-panel">
                <div class="notes-header">
                    <h2>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 8px; vertical-align: middle;">
                            <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
                        </svg>
                        ${this.t('notes.title')}
                    </h2>
                    <button class="notes-close-btn" title="${this.t('common.close')}">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
                <div class="notes-content">
                    <div class="notes-event-info">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6v-2zm0 4h8v2H6v-2zm10 0h2v2h-2v-2zm-6-4h8v2h-8v-2z"/>
                        </svg>
                        ${displayName}
                    </div>

                    <!-- Tags Section -->
                    <div class="notes-section">
                        <label class="notes-label">${this.t('notes.tags') || 'Tags'}</label>
                        <div class="tags-container">
                            <div id="currentTags" class="current-tags">
                                ${notes.tags.map(tag => `
                                    <span class="tag-chip" data-tag="${this.escapeHtml(tag)}">
                                        ${this.escapeHtml(tag)}
                                        <button class="tag-remove" data-tag="${this.escapeHtml(tag)}">&times;</button>
                                    </span>
                                `).join('')}
                            </div>
                            <div class="tag-input-container">
                                <input type="text" id="tagInput" class="tag-input" placeholder="${this.t('notes.tagPlaceholder') || 'Type tag, press Enter or click +'}" maxlength="30">
                                <button type="button" id="addTagBtn" class="add-tag-btn" title="${this.t('notes.addTag') || 'Add tag'}">+</button>
                                <div id="tagSuggestions" class="tag-suggestions hidden"></div>
                            </div>
                        </div>
                        ${allTags.length > 0 ? `
                            <div class="existing-tags">
                                <span class="existing-tags-label">${this.t('notes.existingTags') || 'Existing tags'}:</span>
                                ${allTags.slice(0, 8).map(tag => `
                                    <button class="existing-tag-btn" data-tag="${this.escapeHtml(tag)}">${this.escapeHtml(tag)}</button>
                                `).join('')}
                            </div>
                        ` : ''}
                    </div>

                    <!-- Notes Section -->
                    <div class="notes-section">
                        <label class="notes-label">${this.t('notes.notes')}</label>
                        <textarea id="notesTextarea" class="notes-textarea" placeholder="${this.t('notes.placeholder') || 'Add notes about this event...'}" maxlength="2000">${this.escapeHtml(notes.text)}</textarea>
                        <div class="notes-char-count">
                            <span id="charCount">${notes.text.length}</span>/2000
                        </div>
                    </div>
                </div>
                <div class="notes-footer">
                    <button id="cancelNotesBtn" class="notes-btn secondary">${this.t('common.cancel')}</button>
                    <button id="saveNotesBtn" class="notes-btn primary">${this.t('common.save')}</button>
                </div>
            </div>
        `;

        document.body.appendChild(this.modal);
        this.attachModalEvents(storageKey);

        // Focus the textarea
        setTimeout(() => {
            this.modal.querySelector('#notesTextarea').focus();
        }, 100);
    }

    /**
     * Escape HTML to prevent XSS
     * @param {string} str - String to escape
     * @returns {string} Escaped string
     */
    escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Attach event listeners to the modal
     * @param {string} eventName - Event name for saving
     */
    attachModalEvents(eventName) {
        const closeBtn = this.modal.querySelector('.notes-close-btn');
        const cancelBtn = this.modal.querySelector('#cancelNotesBtn');
        const overlay = this.modal.querySelector('.notes-overlay');
        const saveBtn = this.modal.querySelector('#saveNotesBtn');
        const tagInput = this.modal.querySelector('#tagInput');
        const tagsContainer = this.modal.querySelector('#currentTags');
        const notesTextarea = this.modal.querySelector('#notesTextarea');
        const charCount = this.modal.querySelector('#charCount');

        const closeModal = () => {
            this.modal.remove();
            this.modal = null;
            this.currentEvent = null;
        };

        // Close handlers
        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);
        overlay.addEventListener('click', closeModal);

        // Save notes
        saveBtn.addEventListener('click', () => {
            const text = notesTextarea.value;
            const tagChips = this.modal.querySelectorAll('.tag-chip');
            console.log('[NotesManager] Save clicked. Found tag chips:', tagChips.length);
            const tags = Array.from(tagChips).map(chip => {
                console.log('[NotesManager] Tag chip:', chip.dataset.tag);
                return chip.dataset.tag;
            });

            console.log('[NotesManager] Saving for eventName:', eventName, 'Tags:', tags);
            this.saveNotes(eventName, { text, tags });
            closeModal();
        });

        // Character count
        notesTextarea.addEventListener('input', () => {
            charCount.textContent = notesTextarea.value.length;
        });

        // Stop keyboard events from propagating to global handlers
        // This prevents playback controls from activating while typing
        const stopKeyboardPropagation = (e) => {
            e.stopPropagation();
        };
        notesTextarea.addEventListener('keydown', stopKeyboardPropagation);
        notesTextarea.addEventListener('keyup', stopKeyboardPropagation);
        notesTextarea.addEventListener('keypress', stopKeyboardPropagation);
        tagInput.addEventListener('keyup', stopKeyboardPropagation);
        tagInput.addEventListener('keypress', stopKeyboardPropagation);

        // Tag input with autocomplete
        tagInput.addEventListener('input', (e) => {
            const value = e.target.value.trim().toLowerCase();
            if (value.length < 1) {
                this.modal.querySelector('#tagSuggestions').classList.add('hidden');
                return;
            }

            const suggestions = this.getAllTags().filter(tag =>
                tag.toLowerCase().includes(value) &&
                !Array.from(tagsContainer.querySelectorAll('.tag-chip')).some(chip =>
                    chip.dataset.tag.toLowerCase() === tag.toLowerCase()
                )
            );

            const suggestionsDiv = this.modal.querySelector('#tagSuggestions');
            if (suggestions.length > 0) {
                suggestionsDiv.innerHTML = suggestions.slice(0, 5).map(tag =>
                    `<div class="tag-suggestion" data-tag="${this.escapeHtml(tag)}">${this.escapeHtml(tag)}</div>`
                ).join('');
                suggestionsDiv.classList.remove('hidden');
            } else {
                suggestionsDiv.classList.add('hidden');
            }
        });

        // Add tag on Enter
        tagInput.addEventListener('keydown', (e) => {
            // Stop propagation for all keys to prevent video control shortcuts
            e.stopPropagation();
            console.log('[NotesManager] Tag input keydown:', e.key, 'Value:', tagInput.value);

            if (e.key === 'Enter' && tagInput.value.trim()) {
                e.preventDefault();
                console.log('[NotesManager] Enter pressed, adding tag:', tagInput.value.trim());
                this.addTag(tagInput.value.trim());
                tagInput.value = '';
                this.modal.querySelector('#tagSuggestions').classList.add('hidden');
            }
            if (e.key === 'Escape') {
                this.modal.querySelector('#tagSuggestions').classList.add('hidden');
            }
        });

        // Add tag on button click
        const addTagBtn = this.modal.querySelector('#addTagBtn');
        if (addTagBtn) {
            addTagBtn.addEventListener('click', () => {
                if (tagInput.value.trim()) {
                    console.log('[NotesManager] Add button clicked, adding tag:', tagInput.value.trim());
                    this.addTag(tagInput.value.trim());
                    tagInput.value = '';
                    this.modal.querySelector('#tagSuggestions').classList.add('hidden');
                    tagInput.focus();
                }
            });
        }

        // Click on suggestion
        this.modal.querySelector('#tagSuggestions').addEventListener('click', (e) => {
            if (e.target.classList.contains('tag-suggestion')) {
                this.addTag(e.target.dataset.tag);
                tagInput.value = '';
                this.modal.querySelector('#tagSuggestions').classList.add('hidden');
            }
        });

        // Click on existing tag button
        this.modal.querySelectorAll('.existing-tag-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.addTag(btn.dataset.tag);
            });
        });

        // Remove tag
        tagsContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('tag-remove')) {
                const tag = e.target.dataset.tag;
                const chip = this.modal.querySelector(`.tag-chip[data-tag="${CSS.escape(tag)}"]`);
                if (chip) chip.remove();
            }
        });

        // ESC to close
        const escHandler = (e) => {
            if (e.key === 'Escape' && this.modal) {
                // Only close if not in tag suggestions
                const suggestions = this.modal.querySelector('#tagSuggestions');
                if (!suggestions.classList.contains('hidden')) {
                    suggestions.classList.add('hidden');
                } else {
                    closeModal();
                }
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    /**
     * Add a tag chip to the current tags
     * @param {string} tagName - Tag to add
     */
    addTag(tagName) {
        if (!tagName || !this.modal) {
            console.warn('[NotesManager] addTag called but no tagName or modal');
            return;
        }

        const container = this.modal.querySelector('#currentTags');
        const normalizedTag = tagName.trim().toLowerCase();
        console.log('[NotesManager] Adding tag:', normalizedTag);

        // Check if already exists
        const existing = container.querySelector(`[data-tag="${CSS.escape(normalizedTag)}"]`);
        if (existing) {
            console.log('[NotesManager] Tag already exists, skipping');
            return;
        }

        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.dataset.tag = normalizedTag;
        chip.innerHTML = `${this.escapeHtml(normalizedTag)}<button class="tag-remove" data-tag="${this.escapeHtml(normalizedTag)}">&times;</button>`;
        container.appendChild(chip);
        console.log('[NotesManager] Tag chip added to DOM');
    }

    /**
     * Export all notes as JSON
     * @returns {Object|null} All notes or null if none
     */
    exportNotes() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            return stored ? JSON.parse(stored) : null;
        } catch (e) {
            console.warn('Failed to export notes:', e);
            return null;
        }
    }

    /**
     * Import notes from JSON
     * @param {Object} notesData - Notes data to import
     * @param {boolean} merge - Whether to merge with existing or replace
     */
    importNotes(notesData, merge = true) {
        try {
            if (merge) {
                const existing = this.exportNotes() || {};
                const merged = { ...existing, ...notesData };
                localStorage.setItem(this.STORAGE_KEY, JSON.stringify(merged));
            } else {
                localStorage.setItem(this.STORAGE_KEY, JSON.stringify(notesData));
            }
        } catch (e) {
            console.warn('Failed to import notes:', e);
        }
    }
}

// Export for use
window.NotesManager = NotesManager;
