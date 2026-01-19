/**
 * FilterPanel - UI component for event filtering
 */

class FilterPanel {
    constructor(containerElement, eventFilter, onFilterChange) {
        this.container = containerElement;
        this.eventFilter = eventFilter;
        this.onFilterChange = onFilterChange; // Callback when filters change
        this.isExpanded = false;
        this.searchDebounceTimer = null;

        this.render();

        // Re-render when locale changes
        window.addEventListener('localeChanged', () => this.render());
    }

    /**
     * Render the filter panel UI
     */
    render() {
        if (!this.container) {
            console.warn('Filter panel container not found');
            return;
        }

        const filterCount = this.eventFilter.getActiveFilterCount();
        const filters = this.eventFilter.getFilters();

        // Helper function for translations
        const t = (key) => window.i18n ? window.i18n.t(key) : key.split('.').pop();

        this.container.innerHTML = `
            <div class="filter-panel">
                <div class="filter-header" id="filterHeader">
                    <div class="filter-header-content">
                        <span>${t('filter.filters')}</span>
                        ${filterCount > 0 ? `<span class="filter-badge" id="filterBadge">${filterCount}</span>` : ''}
                    </div>
                    <span class="collapse-icon">${this.isExpanded ? 'v' : '>'}</span>
                </div>

                <div class="filter-content ${this.isExpanded ? 'expanded' : ''}">
                    <!-- Event Type Filters -->
                    <div class="filter-group">
                        <label class="filter-label">${t('filter.eventTypes')}</label>
                        <div class="filter-checkboxes">
                            <label class="filter-checkbox-label">
                                <input type="checkbox"
                                       id="filterSaved"
                                       ${filters.types.SavedClips ? 'checked' : ''}>
                                <span class="event-type saved">${t('filter.saved')}</span>
                            </label>
                            <label class="filter-checkbox-label">
                                <input type="checkbox"
                                       id="filterSentry"
                                       ${filters.types.SentryClips ? 'checked' : ''}>
                                <span class="event-type sentry">${t('filter.sentry')}</span>
                            </label>
                            <label class="filter-checkbox-label">
                                <input type="checkbox"
                                       id="filterRecent"
                                       ${filters.types.RecentClips ? 'checked' : ''}>
                                <span class="event-type recent">${t('filter.recent')}</span>
                            </label>
                        </div>
                    </div>

                    <!-- Bookmark Filter -->
                    <div class="filter-group">
                        <label class="filter-checkbox-label bookmark-filter">
                            <input type="checkbox"
                                   id="filterBookmarked"
                                   ${filters.hasBookmarks ? 'checked' : ''}>
                            <span class="bookmark-filter-text">${t('filter.onlyBookmarked')}</span>
                        </label>
                    </div>

                    <!-- Notes/Tags Filter -->
                    <div class="filter-group">
                        <label class="filter-checkbox-label notes-filter">
                            <input type="checkbox"
                                   id="filterHasNotes"
                                   ${filters.hasNotes ? 'checked' : ''}>
                            <span class="notes-filter-text">${t('filter.onlyWithNotes')}</span>
                        </label>
                    </div>

                    <!-- Tag Dropdown -->
                    ${this.renderTagDropdown(filters)}

                    <!-- Sort Order -->
                    <div class="filter-group">
                        <label class="filter-label" for="sortOrder">${t('filter.sortBy')}</label>
                        <select id="sortOrder" class="filter-select">
                            <option value="newest" ${filters.sortOrder === 'newest' ? 'selected' : ''}>${t('filter.newestFirst')}</option>
                            <option value="oldest" ${filters.sortOrder === 'oldest' ? 'selected' : ''}>${t('filter.oldestFirst')}</option>
                        </select>
                    </div>

                    <!-- Search -->
                    <div class="filter-group">
                        <label class="filter-label" for="searchInput">${t('filter.search')}</label>
                        <input type="text"
                               id="searchInput"
                               class="search-input"
                               placeholder="${t('filter.searchPlaceholder')}"
                               value="${filters.searchQuery}">
                    </div>

                    <!-- Date Range -->
                    <div class="filter-group">
                        <label class="filter-label">${t('filter.dateRange')}</label>
                        <div class="date-range-inputs">
                            <input type="date"
                                   id="dateStart"
                                   class="date-input"
                                   placeholder="Start"
                                   value="${filters.dateRange.start || ''}">
                            <span class="date-separator">${t('filter.dateTo')}</span>
                            <input type="date"
                                   id="dateEnd"
                                   class="date-input"
                                   placeholder="End"
                                   value="${filters.dateRange.end || ''}">
                        </div>
                        ${filters.dateRange.start || filters.dateRange.end ?
                            `<button id="clearDates" class="clear-dates-btn">${t('filter.clearDates')}</button>` : ''}
                    </div>

                    <!-- Clear All Filters -->
                    ${filterCount > 0 ? `
                        <button id="clearAllFilters" class="clear-all-filters-btn">
                            ${t('filter.clearAllFilters')}
                        </button>
                    ` : ''}
                </div>
            </div>
        `;

        this.attachEventListeners();
    }

    /**
     * Attach event listeners to filter controls
     */
    attachEventListeners() {
        // Toggle panel collapse
        const filterHeader = document.getElementById('filterHeader');
        if (filterHeader) {
            filterHeader.addEventListener('click', () => this.togglePanel());
        }

        // Event type checkboxes
        const savedCheckbox = document.getElementById('filterSaved');
        const sentryCheckbox = document.getElementById('filterSentry');
        const recentCheckbox = document.getElementById('filterRecent');

        if (savedCheckbox) {
            savedCheckbox.addEventListener('change', (e) => {
                this.handleTypeChange('SavedClips', e.target.checked);
            });
        }

        if (sentryCheckbox) {
            sentryCheckbox.addEventListener('change', (e) => {
                this.handleTypeChange('SentryClips', e.target.checked);
            });
        }

        if (recentCheckbox) {
            recentCheckbox.addEventListener('change', (e) => {
                this.handleTypeChange('RecentClips', e.target.checked);
            });
        }

        // Bookmark filter
        const bookmarkedCheckbox = document.getElementById('filterBookmarked');
        if (bookmarkedCheckbox) {
            bookmarkedCheckbox.addEventListener('change', (e) => {
                this.handleBookmarkFilterChange(e.target.checked);
            });
        }

        // Notes/Tags filter
        const notesCheckbox = document.getElementById('filterHasNotes');
        if (notesCheckbox) {
            notesCheckbox.addEventListener('change', (e) => {
                this.handleNotesFilterChange(e.target.checked);
            });
        }

        // Tag dropdown
        const tagFilter = document.getElementById('tagFilter');
        if (tagFilter) {
            tagFilter.addEventListener('change', (e) => {
                this.handleTagFilterChange(e.target.value);
            });
        }

        // Sort order
        const sortOrder = document.getElementById('sortOrder');
        if (sortOrder) {
            sortOrder.addEventListener('change', (e) => {
                this.handleSortChange(e.target.value);
            });
        }

        // Search input (debounced)
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.handleSearchInput(e.target.value);
            });
        }

        // Date range
        const dateStart = document.getElementById('dateStart');
        const dateEnd = document.getElementById('dateEnd');

        if (dateStart) {
            dateStart.addEventListener('change', (e) => {
                this.handleDateChange('start', e.target.value);
            });
        }

        if (dateEnd) {
            dateEnd.addEventListener('change', (e) => {
                this.handleDateChange('end', e.target.value);
            });
        }

        // Clear dates button
        const clearDatesBtn = document.getElementById('clearDates');
        if (clearDatesBtn) {
            clearDatesBtn.addEventListener('click', () => {
                this.handleDateChange('start', null);
                this.handleDateChange('end', null);
            });
        }

        // Clear all filters button
        const clearAllBtn = document.getElementById('clearAllFilters');
        if (clearAllBtn) {
            clearAllBtn.addEventListener('click', () => {
                this.clearAllFilters();
            });
        }
    }

    /**
     * Toggle filter panel expanded/collapsed
     */
    togglePanel() {
        this.isExpanded = !this.isExpanded;
        const content = this.container.querySelector('.filter-content');
        const icon = this.container.querySelector('.collapse-icon');

        if (content) {
            if (this.isExpanded) {
                content.classList.add('expanded');
            } else {
                content.classList.remove('expanded');
            }
        }

        if (icon) {
            icon.textContent = this.isExpanded ? 'v' : '>';
        }
    }

    /**
     * Handle event type checkbox change
     * @param {string} type
     * @param {boolean} checked
     */
    handleTypeChange(type, checked) {
        this.eventFilter.setFilters({
            types: { [type]: checked }
        });

        this.updateFilterBadge();

        if (this.onFilterChange) {
            this.onFilterChange();
        }
    }

    /**
     * Handle search input (debounced)
     * @param {string} query
     */
    handleSearchInput(query) {
        // Clear existing timer
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
        }

        // Debounce search by 300ms
        this.searchDebounceTimer = setTimeout(() => {
            this.eventFilter.setFilters({
                searchQuery: query
            });

            this.updateFilterBadge();

            if (this.onFilterChange) {
                this.onFilterChange();
            }
        }, 300);
    }

    /**
     * Handle date range change
     * @param {string} type - 'start' or 'end'
     * @param {string|null} value
     */
    handleDateChange(type, value) {
        this.eventFilter.setFilters({
            dateRange: { [type]: value || null }
        });

        this.render(); // Re-render to show/hide clear button
        this.updateFilterBadge();

        if (this.onFilterChange) {
            this.onFilterChange();
        }
    }

    /**
     * Handle sort order change
     * @param {string} order
     */
    handleSortChange(order) {
        this.eventFilter.setFilters({
            sortOrder: order
        });

        this.updateFilterBadge();

        if (this.onFilterChange) {
            this.onFilterChange();
        }
    }

    /**
     * Handle bookmark filter change
     * @param {boolean} checked
     */
    handleBookmarkFilterChange(checked) {
        this.eventFilter.setFilters({
            hasBookmarks: checked
        });

        this.updateFilterBadge();

        if (this.onFilterChange) {
            this.onFilterChange();
        }
    }

    /**
     * Clear all filters
     */
    clearAllFilters() {
        this.eventFilter.reset();
        this.render();

        if (this.onFilterChange) {
            this.onFilterChange();
        }
    }

    /**
     * Update the active filter count badge
     */
    updateFilterBadge() {
        const filterCount = this.eventFilter.getActiveFilterCount();
        const badge = document.getElementById('filterBadge');
        const headerContent = this.container.querySelector('.filter-header-content');

        if (!headerContent) return;

        // Remove existing badge
        if (badge) {
            badge.remove();
        }

        // Add new badge if filters are active
        if (filterCount > 0) {
            const newBadge = document.createElement('span');
            newBadge.className = 'filter-badge';
            newBadge.id = 'filterBadge';
            newBadge.textContent = filterCount;
            headerContent.appendChild(newBadge);
        }

        // Update clear all button visibility
        const clearAllBtn = document.getElementById('clearAllFilters');
        const filterContent = this.container.querySelector('.filter-content');
        const t = (key) => window.i18n ? window.i18n.t(key) : key.split('.').pop();

        if (filterCount > 0 && !clearAllBtn && filterContent) {
            const btn = document.createElement('button');
            btn.id = 'clearAllFilters';
            btn.className = 'clear-all-filters-btn';
            btn.textContent = t('filter.clearAllFilters');
            btn.addEventListener('click', () => this.clearAllFilters());
            filterContent.appendChild(btn);
        } else if (filterCount === 0 && clearAllBtn) {
            clearAllBtn.remove();
        }
    }

    /**
     * Render tag dropdown if tags exist
     * @param {Object} filters - Current filter state
     * @returns {string} HTML string
     */
    renderTagDropdown(filters) {
        const allTags = this.eventFilter.getAllTags();
        const t = (key) => window.i18n ? window.i18n.t(key) : key.split('.').pop();

        if (allTags.length === 0) {
            return '';
        }

        return `
            <div class="filter-group">
                <label class="filter-label" for="tagFilter">${t('filter.filterByTag')}</label>
                <select id="tagFilter" class="filter-select">
                    <option value="">${t('filter.allTags')}</option>
                    ${allTags.map(tag => `
                        <option value="${tag}" ${filters.selectedTag === tag ? 'selected' : ''}>
                            ${tag}
                        </option>
                    `).join('')}
                </select>
            </div>
        `;
    }

    /**
     * Handle notes filter change
     * @param {boolean} checked
     */
    handleNotesFilterChange(checked) {
        this.eventFilter.setFilters({
            hasNotes: checked
        });

        this.updateFilterBadge();

        if (this.onFilterChange) {
            this.onFilterChange();
        }
    }

    /**
     * Handle tag filter change
     * @param {string} tag
     */
    handleTagFilterChange(tag) {
        this.eventFilter.setFilters({
            selectedTag: tag
        });

        this.updateFilterBadge();

        if (this.onFilterChange) {
            this.onFilterChange();
        }
    }

    /**
     * Get current filter state
     * @returns {Object}
     */
    getFilters() {
        return this.eventFilter.getFilters();
    }

    /**
     * Refresh the filter panel (e.g., when tags change)
     */
    refresh() {
        this.render();
    }
}
