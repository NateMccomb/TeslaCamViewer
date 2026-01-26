/**
 * DriveSyncUI - Full-screen modal UI for drive sync operations
 */

class DriveSyncUI {
    constructor(driveSync, folderManager) {
        this.driveSync = driveSync;
        this.folderManager = folderManager;

        this.modal = document.getElementById('driveSyncModal');
        this.originalTitle = document.title;
        this.titleFlashInterval = null;

        // Listen for locale changes to re-render modal
        window.addEventListener('localeChanged', () => {
            if (this.modal && !this.modal.classList.contains('hidden')) {
                this.render();
            }
        });

        // UI state
        this.selectedItems = new Map(); // eventName -> boolean
        this.comparisonResults = null;
        this.syncMode = 'copy';
        this.activePresetId = null;
        this.statsSortColumn = 'name';
        this.statsSortAsc = true;
        this.statsFilter = 'all';

        // Bind callbacks
        this.driveSync.onStateChange((state) => this.onStateChange(state));
        this.driveSync.onProgress((state) => this.onProgress(state));
        this.driveSync.onComplete((state) => this.onComplete(state));
        this.driveSync.onError((error) => this.onError(error));
    }

    /**
     * Get translation helper
     */
    t(key) {
        return window.i18n ? window.i18n.t(key) : key.split('.').pop();
    }

    /**
     * Escape HTML to prevent XSS attacks
     * @param {string} str - String to escape
     * @returns {string} Escaped string safe for innerHTML
     */
    escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    show() {
        this.render();
        this.modal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    hide() {
        this.modal.classList.add('hidden');
        document.body.style.overflow = '';
        this.stopTitleFlash();
        document.title = this.originalTitle;
    }

    render() {
        const drives = this.folderManager.getDrives();

        this.modal.innerHTML = `
            <div class="sync-modal-content sync-horizontal-layout">
                <!-- Top Toolbar -->
                <div class="sync-toolbar">
                    <div class="sync-toolbar-left">
                        <button class="sync-close-btn" id="syncCloseBtn" title="${this.t('driveSync.close')}">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                            </svg>
                        </button>
                        <h1 class="sync-title">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
                            </svg>
                            ${this.t('driveSync.title')}
                        </h1>
                    </div>
                    <div class="sync-toolbar-center">
                        <div class="sync-presets-chips" id="presetsChips">
                            ${this.renderPresetChips()}
                        </div>
                    </div>
                    <div class="sync-toolbar-right">
                        <button class="sync-toolbar-btn" id="syncSettingsBtn" title="${this.t('driveSync.settings')}">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                            </svg>
                        </button>
                    </div>
                </div>

                <!-- Main Split Panel -->
                <div class="sync-split-container">
                    <!-- LEFT PANEL: Drive Selection & Comparison -->
                    <div class="sync-panel sync-panel-left">
                        <div class="sync-panel-header">
                            <span class="sync-panel-title">${this.t('driveSync.sourceDestination')}</span>
                        </div>

                        <!-- Compact Drive Selectors -->
                        <div class="sync-drives-compact">
                            <div class="sync-drive-row">
                                <div class="sync-drive-icon source">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
                                    </svg>
                                </div>
                                <select id="sourceDriveSelect" class="sync-drive-select-compact">
                                    <option value="">${this.t('driveSync.selectSource')}</option>
                                    ${drives.map(d => `<option value="${d.id}">${d.label} (${d.events?.length || 0})</option>`).join('')}
                                </select>
                                <div id="sourceInfo" class="sync-drive-info-compact"></div>
                            </div>

                            <div class="sync-drive-arrow-compact">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M16.01 11H4v2h12.01v3L20 12l-3.99-4z"/>
                                </svg>
                            </div>

                            <div class="sync-drive-row">
                                <div class="sync-drive-icon dest">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
                                    </svg>
                                </div>
                                <select id="destDriveSelect" class="sync-drive-select-compact">
                                    <option value="">${this.t('driveSync.selectDestination')}</option>
                                    ${drives.map(d => `<option value="${d.id}">${d.label} (${d.events?.length || 0})</option>`).join('')}
                                </select>
                                <div id="destInfo" class="sync-drive-info-compact"></div>
                            </div>
                        </div>

                        <!-- Compare Button -->
                        <div class="sync-compare-bar">
                            <button id="compareBtn" class="sync-compare-btn-compact" disabled>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M10 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h5v-2H5V5h5V3zm4 18h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-5v2h5v14h-5v2zm-4-7l-3-3 3-3v2h6v-2l3 3-3 3v-2h-6v2z"/>
                                </svg>
                                ${this.t('driveSync.compare')}
                            </button>
                        </div>

                        <!-- Comparison Results -->
                        <div id="comparisonResults" class="sync-results-compact hidden">
                            <div class="sync-results-scroll">
                                <div id="resultsGrid" class="sync-results-grid-compact"></div>
                            </div>

                            <div id="notesComparisonSection" class="sync-notes-compact hidden">
                                <label class="sync-checkbox-compact">
                                    <input type="checkbox" id="syncNotesCheckbox" checked>
                                    <span>${this.t('driveSync.includeNotes')}</span>
                                    <span id="notesComparisonText" class="sync-notes-count">(0)</span>
                                </label>
                            </div>
                        </div>

                        <!-- Progress Section -->
                        <div id="progressSection" class="sync-progress-compact hidden">
                            <div class="sync-progress-header-compact">
                                <span id="currentItemLabel">${this.t('driveSync.preparing')}</span>
                                <span id="fileProgressText">0%</span>
                            </div>
                            <div class="sync-progress-bar-compact">
                                <div id="fileProgressBar" class="sync-progress-fill"></div>
                            </div>
                            <div class="sync-progress-details">
                                <span id="eventProgress">0 / 0 ${this.t('driveSync.events')}</span>
                                <span id="bytesProgress">0 B / 0 B</span>
                            </div>
                            <div class="sync-progress-details">
                                <span id="speedStat">-- MB/s</span>
                                <span id="etaStat">${this.t('driveSync.eta')} --:--</span>
                            </div>
                        </div>

                        <!-- Complete Section -->
                        <div id="completeSection" class="sync-complete-compact hidden">
                            <div class="sync-complete-badge">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                                </svg>
                            </div>
                            <div class="sync-complete-info">
                                <span class="sync-complete-title">${this.t('driveSync.syncComplete')}</span>
                                <span id="completeSummary" class="sync-complete-summary-text"></span>
                            </div>
                            <div id="syncErrors" class="sync-errors-compact hidden"></div>
                        </div>
                    </div>

                    <!-- DIVIDER -->
                    <div class="sync-panel-divider"></div>

                    <!-- RIGHT PANEL: Statistics -->
                    <div class="sync-panel sync-panel-right">
                        <div class="sync-panel-header">
                            <span class="sync-panel-title">${this.t('driveSync.comparisonStats')}</span>
                        </div>

                        <div id="statisticsSection" class="sync-stats-inline">
                            <div class="sync-stats-placeholder">
                                <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" opacity="0.3">
                                    <path d="M5 9.2h3V19H5V9.2zM10.6 5h2.8v14h-2.8V5zm5.6 8H19v6h-2.8v-6z"/>
                                </svg>
                                <span>${this.t('driveSync.selectDrivesToCompare')}</span>
                            </div>
                            <div id="statsContent" class="sync-stats-content-inline"></div>
                        </div>
                    </div>
                </div>

                <!-- Bottom Action Bar -->
                <div class="sync-action-bar">
                    <div class="sync-action-bar-left">
                        <span id="selectionSummary" class="sync-selection-summary">${this.t('driveSync.selectDrivesHint')}</span>
                    </div>
                    <div class="sync-action-bar-center">
                        <div class="sync-mode-toggle">
                            <label class="sync-mode-option">
                                <input type="radio" name="syncMode" value="copy" checked>
                                <span class="sync-mode-label">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
                                    </svg>
                                    ${this.t('driveSync.copy')}
                                </span>
                            </label>
                            <label class="sync-mode-option">
                                <input type="radio" name="syncMode" value="move">
                                <span class="sync-mode-label">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/>
                                    </svg>
                                    ${this.t('driveSync.move')}
                                </span>
                            </label>
                        </div>
                    </div>
                    <div class="sync-action-bar-right">
                        <button id="cancelCompareBtn" class="sync-action-btn sync-btn-secondary">${this.t('driveSync.cancel')}</button>
                        <button id="pauseResumeBtn" class="sync-action-btn sync-btn-secondary hidden">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                            </svg>
                            ${this.t('driveSync.pause')}
                        </button>
                        <button id="startSyncBtn" class="sync-action-btn sync-btn-primary" disabled>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
                            </svg>
                            ${this.t('driveSync.startSync')}
                        </button>
                        <button id="doneBtn" class="sync-action-btn sync-btn-success hidden">${this.t('driveSync.done')}</button>
                    </div>
                </div>
            </div>

            <!-- Settings Panel (hidden by default) -->
            <div id="syncSettingsPanel" class="sync-settings-panel hidden">
                <div class="sync-settings-content">
                    <h3>${this.t('syncSettings.title')}</h3>
                    <div class="sync-settings-form">
                        <label class="sync-checkbox-label">
                            <input type="checkbox" id="settingVerify" ${this.driveSync.settings.verifyAfterCopy ? 'checked' : ''}>
                            <span>${this.t('syncSettings.verifyAfterCopy')}</span>
                        </label>
                        <label class="sync-checkbox-label">
                            <input type="checkbox" id="settingSyncNotes" ${this.driveSync.settings.syncNotes ? 'checked' : ''}>
                            <span>${this.t('syncSettings.syncNotes')}</span>
                        </label>
                        <label class="sync-checkbox-label">
                            <input type="checkbox" id="settingWriteSyncFile" ${this.driveSync.settings.writeSyncFile ? 'checked' : ''}>
                            <span>${this.t('syncSettings.writeSyncFile')}</span>
                        </label>
                        <label class="sync-checkbox-label">
                            <input type="checkbox" id="settingConfirmDelete" ${this.driveSync.settings.confirmBeforeDelete ? 'checked' : ''}>
                            <span>${this.t('syncSettings.confirmBeforeDelete')}</span>
                        </label>

                        <div class="sync-settings-group">
                            <label>${this.t('syncSettings.noteConflict')}</label>
                            <select id="settingNoteConflict" class="sync-settings-select">
                                <option value="ask" ${this.driveSync.settings.noteConflictMode === 'ask' ? 'selected' : ''}>${this.t('syncSettings.askEachTime')}</option>
                                <option value="merge" ${this.driveSync.settings.noteConflictMode === 'merge' ? 'selected' : ''}>${this.t('syncSettings.mergeAutomatically')}</option>
                            </select>
                        </div>
                    </div>
                    <div class="sync-settings-actions">
                        <button id="saveSettingsBtn" class="sync-save-btn">${this.t('syncSettings.saveSettings')}</button>
                        <button id="closeSettingsBtn" class="sync-cancel-btn">${this.t('syncSettings.close')}</button>
                    </div>
                </div>
            </div>

            <!-- Manage Presets Panel (hidden by default) -->
            <div id="managePresetsPanel" class="sync-settings-panel hidden">
                <div class="sync-settings-content sync-presets-manage">
                    <h3>${this.t('presets.title')}</h3>
                    <div id="presetsList" class="sync-presets-list">
                        ${this.renderPresetsList()}
                    </div>
                    <div class="sync-settings-actions">
                        <button id="importPresetsBtn" class="sync-import-btn">${this.t('presets.importFromDrives')}</button>
                        <button id="closeManagePresetsBtn" class="sync-cancel-btn">${this.t('presets.close')}</button>
                    </div>
                </div>
            </div>
        `;

        this.attachEventListeners();
    }

    renderPresetChips() {
        const presets = this.driveSync.getAllPresets();

        // Always show Save and Manage buttons
        const buttons = `
            <button id="savePresetBtn" class="sync-preset-chip sync-preset-save" disabled title="${this.t('driveSync.save')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/>
                </svg>
                ${this.t('driveSync.save')}
            </button>
            <button id="managePresetsBtn" class="sync-preset-chip sync-preset-manage" title="${this.t('presets.title')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                </svg>
            </button>
        `;

        if (presets.length === 0) {
            return `
                <span class="sync-presets-label">${this.t('driveSync.quickLoad')}</span>
                <span class="sync-no-presets-hint">${this.t('driveSync.noPresets')}</span>
                ${buttons}
            `;
        }

        const chips = presets.map(p => `
            <button class="sync-preset-chip sync-preset-load"
                    data-preset-id="${p.id}"
                    title="${p.sourceLabel} → ${p.destLabel}${p.lastUsed ? '\n' + this.t('presets.lastUsed') + ' ' + new Date(p.lastUsed).toLocaleDateString() : ''}">
                ${p.name}
            </button>
        `).join('');

        return `
            <span class="sync-presets-label">${this.t('driveSync.quickLoad')}</span>
            ${chips}
            ${buttons}
        `;
    }

    renderPresetOptions() {
        const presets = this.driveSync.getAllPresets();
        if (presets.length === 0) return '';

        return presets.map(p => {
            const lastUsed = p.lastUsed ? ` (Last: ${new Date(p.lastUsed).toLocaleDateString()})` : '';
            return `<option value="${p.id}">${p.name}: ${p.sourceLabel} → ${p.destLabel}${lastUsed}</option>`;
        }).join('');
    }

    renderPresetsList() {
        const presets = this.driveSync.getAllPresets();
        if (presets.length === 0) {
            return `<p class="sync-no-presets">${this.t('presets.noPresets')}</p>`;
        }

        return presets.map(p => `
            <div class="sync-preset-item" data-preset-id="${p.id}">
                <div class="sync-preset-info">
                    <span class="sync-preset-name">${p.name}</span>
                    <span class="sync-preset-path">${p.sourceLabel} → ${p.destLabel}</span>
                    ${p.importedFrom ? `<span class="sync-preset-imported">${this.t('presets.importedFrom')} ${p.importedFrom}</span>` : ''}
                </div>
                <div class="sync-preset-actions">
                    <button class="sync-preset-delete-btn" data-preset-id="${p.id}" title="${this.t('presets.delete')}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                        </svg>
                    </button>
                </div>
            </div>
        `).join('');
    }

    attachEventListeners() {
        // Close button
        document.getElementById('syncCloseBtn').addEventListener('click', () => this.hide());

        // Drive selection
        const sourceSelect = document.getElementById('sourceDriveSelect');
        const destSelect = document.getElementById('destDriveSelect');

        sourceSelect.addEventListener('change', () => this.onSourceChange());
        destSelect.addEventListener('change', () => this.onDestChange());

        // Compare button
        document.getElementById('compareBtn').addEventListener('click', () => this.onCompare());

        // Sync mode radios
        document.querySelectorAll('input[name="syncMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.syncMode = e.target.value;
            });
        });

        // Start sync
        document.getElementById('startSyncBtn').addEventListener('click', () => this.onStartSync());

        // Cancel buttons
        document.getElementById('cancelCompareBtn')?.addEventListener('click', () => this.hide());
        document.getElementById('cancelSyncBtn')?.addEventListener('click', () => this.onCancelSync());

        // Pause/Resume
        document.getElementById('pauseResumeBtn')?.addEventListener('click', () => this.onPauseResume());

        // Done button
        document.getElementById('doneBtn')?.addEventListener('click', () => this.hide());

        // Settings
        document.getElementById('syncSettingsBtn').addEventListener('click', () => this.showSettings());
        document.getElementById('closeSettingsBtn')?.addEventListener('click', () => this.hideSettings());
        document.getElementById('saveSettingsBtn')?.addEventListener('click', () => this.saveSettings());

        // Presets - click to load
        document.querySelectorAll('.sync-preset-load').forEach(chip => {
            chip.addEventListener('click', (e) => {
                const presetId = e.currentTarget.dataset.presetId;
                this.loadPreset(presetId);
            });
        });
        document.getElementById('savePresetBtn')?.addEventListener('click', () => this.savePreset());
        document.getElementById('managePresetsBtn')?.addEventListener('click', () => this.showManagePresets());
        document.getElementById('closeManagePresetsBtn')?.addEventListener('click', () => this.hideManagePresets());
        document.getElementById('importPresetsBtn')?.addEventListener('click', () => this.importPresets());

        // Preset delete buttons
        document.querySelectorAll('.sync-preset-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.deletePreset(e.target.closest('button').dataset.presetId));
        });

        // Statistics
        document.getElementById('showStatsBtn')?.addEventListener('click', () => this.showStatistics());
        document.getElementById('closeStatsBtn')?.addEventListener('click', () => this.hideStatistics());
    }

    onSourceChange() {
        const sourceId = document.getElementById('sourceDriveSelect').value;

        if (sourceId) {
            const drive = this.folderManager.getDrive(sourceId);
            this.driveSync.setSource(sourceId);
            this.updateDriveInfo('source', drive);
        } else {
            document.getElementById('sourceInfo').textContent = '';
        }

        this.updateCompareButton();
        this.updateSavePresetButton();
    }

    onDestChange() {
        const destId = document.getElementById('destDriveSelect').value;

        if (destId) {
            const drive = this.folderManager.getDrive(destId);
            this.driveSync.setDestination(destId);
            this.updateDriveInfo('dest', drive);
        } else {
            document.getElementById('destInfo').textContent = '';
        }

        this.updateCompareButton();
        this.updateSavePresetButton();
    }

    updateSavePresetButton() {
        const sourceId = document.getElementById('sourceDriveSelect').value;
        const destId = document.getElementById('destDriveSelect').value;
        const saveBtn = document.getElementById('savePresetBtn');
        if (saveBtn) {
            saveBtn.disabled = !sourceId || !destId || sourceId === destId;
        }
    }

    updateDriveInfo(which, drive) {
        const infoEl = document.getElementById(which === 'source' ? 'sourceInfo' : 'destInfo');
        const events = drive.events || [];
        const totalSize = events.reduce((sum, e) => sum + (e.estimatedSize || 0), 0);

        // Compact layout - just show size estimate
        infoEl.textContent = this.driveSync.formatBytes(totalSize);
    }

    updateCompareButton() {
        const sourceId = document.getElementById('sourceDriveSelect').value;
        const destId = document.getElementById('destDriveSelect').value;
        const compareBtn = document.getElementById('compareBtn');

        compareBtn.disabled = !sourceId || !destId || sourceId === destId;
    }

    async onCompare() {
        const compareBtn = document.getElementById('compareBtn');
        compareBtn.disabled = true;
        compareBtn.innerHTML = `
            <div class="sync-spinner"></div>
            Comparing...
        `;

        document.title = 'Comparing... - TeslaCamViewer';

        try {
            const results = await this.driveSync.compareEvents();
            this.comparisonResults = results;
            this.renderComparisonResults(results);

            // Auto-show statistics in the right panel
            if (results.statistics) {
                this.renderStatisticsInline();
            }

        } catch (error) {
            console.error('Comparison failed:', error);
            alert('Comparison failed: ' + error.message);
        } finally {
            compareBtn.disabled = false;
            compareBtn.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M10 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h5v-2H5V5h5V3zm4 18h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-5v2h5v14h-5v2zm-4-7l-3-3 3-3v2h6v-2l3 3-3 3v-2h-6v2z"/>
                </svg>
                Compare
            `;
            document.title = this.originalTitle;
        }
    }

    renderComparisonResults(results) {
        const resultsSection = document.getElementById('comparisonResults');
        const resultsGrid = document.getElementById('resultsGrid');

        resultsSection.classList.remove('hidden');

        // Initialize selected items
        this.selectedItems.clear();
        results.missing.forEach(item => this.selectedItems.set(item.event.name, item.selected));
        results.newer.forEach(item => this.selectedItems.set(item.event.name, item.selected));
        results.differentSize.forEach(item => this.selectedItems.set(item.event.name, item.selected));

        resultsGrid.innerHTML = `
            ${this.renderResultCategory('missing', 'Missing on destination', results.missing, true)}
            ${this.renderResultCategory('newer', 'Newer on source', results.newer, true)}
            ${this.renderResultCategory('differentSize', 'Different size', results.differentSize, false)}
            ${this.renderResultCategory('same', 'Already synced', results.same, false, true)}
        `;

        // Notes comparison
        const notesSection = document.getElementById('notesComparisonSection');
        const notesComparison = results.notesComparison;
        const notesCount = notesComparison.sourceOnly.length +
                          notesComparison.newerOnSource.length +
                          notesComparison.conflict.length;

        if (notesCount > 0) {
            notesSection.classList.remove('hidden');
            document.getElementById('notesComparisonText').textContent = `(${notesCount})`;
        }

        // Attach checkbox listeners
        document.querySelectorAll('.sync-category-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => this.onCategoryToggle(e));
        });

        document.querySelectorAll('.sync-item-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => this.onItemToggle(e));
        });

        // Expand button listeners
        document.querySelectorAll('.sync-expand-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const category = e.currentTarget.dataset.category;
                const itemsEl = document.getElementById(`items-${category}`);
                if (itemsEl) {
                    itemsEl.classList.toggle('hidden');
                    e.currentTarget.classList.toggle('expanded');
                }
            });
        });

        this.updateSelectionSummary();
    }

    renderResultCategory(id, label, items, defaultSelected, disabled = false) {
        if (items.length === 0) return '';

        const totalSize = items.reduce((sum, item) => sum + item.fingerprint.totalSize, 0);
        const checkedCount = items.filter(item => item.selected).length;
        const allChecked = checkedCount === items.length;
        const someChecked = checkedCount > 0 && checkedCount < items.length;

        return `
            <div class="sync-result-category" data-category="${id}">
                <div class="sync-category-header">
                    <label class="sync-checkbox-label">
                        <input type="checkbox"
                               class="sync-category-checkbox"
                               data-category="${id}"
                               ${allChecked ? 'checked' : ''}
                               ${someChecked ? 'indeterminate' : ''}
                               ${disabled ? 'disabled' : ''}>
                        <span>${label} (${items.length})</span>
                    </label>
                    <span class="sync-category-size">${this.driveSync.formatBytes(totalSize)}</span>
                    <button class="sync-expand-btn" data-category="${id}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M7 10l5 5 5-5z"/>
                        </svg>
                    </button>
                </div>
                <div class="sync-category-items hidden" id="items-${id}">
                    ${items.map(item => `
                        <label class="sync-item-label">
                            <input type="checkbox"
                                   class="sync-item-checkbox"
                                   data-event="${item.event.name}"
                                   data-category="${id}"
                                   ${item.selected ? 'checked' : ''}
                                   ${disabled ? 'disabled' : ''}>
                            <span class="sync-item-name">${item.event.name}</span>
                            <span class="sync-item-size">${this.driveSync.formatBytes(item.fingerprint.totalSize)}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        `;
    }

    onCategoryToggle(e) {
        const category = e.target.dataset.category;
        const checked = e.target.checked;
        const items = this.comparisonResults[category] || [];

        items.forEach(item => {
            item.selected = checked;
            this.selectedItems.set(item.event.name, checked);
        });

        // Update item checkboxes
        document.querySelectorAll(`.sync-item-checkbox[data-category="${category}"]`).forEach(cb => {
            cb.checked = checked;
        });

        this.updateSelectionSummary();
    }

    onItemToggle(e) {
        const eventName = e.target.dataset.event;
        const category = e.target.dataset.category;
        const checked = e.target.checked;

        this.selectedItems.set(eventName, checked);

        // Update item in results
        const items = this.comparisonResults[category] || [];
        const item = items.find(i => i.event.name === eventName);
        if (item) item.selected = checked;

        // Update category checkbox state
        const categoryCheckbox = document.querySelector(`.sync-category-checkbox[data-category="${category}"]`);
        const allItems = items.length;
        const checkedItems = items.filter(i => i.selected).length;

        if (categoryCheckbox) {
            categoryCheckbox.checked = checkedItems === allItems;
            categoryCheckbox.indeterminate = checkedItems > 0 && checkedItems < allItems;
        }

        this.updateSelectionSummary();
    }

    updateSelectionSummary() {
        const selected = [
            ...this.comparisonResults.missing.filter(i => i.selected),
            ...this.comparisonResults.newer.filter(i => i.selected),
            ...this.comparisonResults.differentSize.filter(i => i.selected)
        ];

        const totalSize = selected.reduce((sum, item) => sum + item.fingerprint.totalSize, 0);

        document.getElementById('selectionSummary').textContent =
            `Selected: ${selected.length} events (${this.driveSync.formatBytes(totalSize)})`;

        document.getElementById('startSyncBtn').disabled = selected.length === 0;
    }

    async onStartSync() {
        const selectedEvents = [
            ...this.comparisonResults.missing.filter(i => i.selected),
            ...this.comparisonResults.newer.filter(i => i.selected),
            ...this.comparisonResults.differentSize.filter(i => i.selected)
        ];

        if (selectedEvents.length === 0) {
            alert('Please select at least one event to sync.');
            return;
        }

        // Confirm if move mode
        if (this.syncMode === 'move') {
            const confirmed = confirm(
                `You are about to MOVE ${selectedEvents.length} events.\n\n` +
                `Files will be DELETED from the source drive after verification.\n\n` +
                `Continue?`
            );
            if (!confirmed) return;
        }

        // Show progress section, hide results
        document.getElementById('comparisonResults').classList.add('hidden');
        document.getElementById('progressSection').classList.remove('hidden');

        // Show pause button, hide start button
        const pauseBtn = document.getElementById('pauseResumeBtn');
        const startBtn = document.getElementById('startSyncBtn');
        if (pauseBtn) pauseBtn.classList.remove('hidden');
        if (startBtn) startBtn.classList.add('hidden');

        try {
            await this.driveSync.startSync({
                selectedEvents,
                mode: this.syncMode,
                syncNotes: document.getElementById('syncNotesCheckbox')?.checked
            });
        } catch (error) {
            console.error('Sync failed:', error);
            // Error handled in onError callback
        }
    }

    onPauseResume() {
        const btn = document.getElementById('pauseResumeBtn');

        if (this.driveSync.state.status === 'paused') {
            this.driveSync.resume();
            btn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                </svg>
                Pause
            `;
        } else {
            this.driveSync.pause();
            btn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                </svg>
                Resume
            `;
        }
    }

    onCancelSync() {
        const confirmed = confirm('Are you sure you want to cancel the sync?');
        if (confirmed) {
            this.driveSync.cancel();
        }
    }

    onStateChange(state) {
        // Update title
        if (state.status === 'syncing') {
            const percent = state.bytesTotal > 0
                ? Math.round((state.bytesCompleted / state.bytesTotal) * 100)
                : 0;
            document.title = `Syncing ${percent}% - TeslaCamViewer`;
        } else if (state.status === 'paused') {
            document.title = 'Paused - TeslaCamViewer';
        } else if (state.status === 'verifying') {
            document.title = 'Verifying... - TeslaCamViewer';
        }
    }

    onProgress(state) {
        // Update progress UI
        const percent = state.bytesTotal > 0
            ? Math.round((state.bytesCompleted / state.bytesTotal) * 100)
            : 0;

        const progressBar = document.getElementById('fileProgressBar');
        if (progressBar) progressBar.style.width = `${percent}%`;

        const progressText = document.getElementById('fileProgressText');
        if (progressText) progressText.textContent = `${percent}%`;

        const currentLabel = document.getElementById('currentItemLabel');
        if (currentLabel) {
            currentLabel.textContent = state.currentFile
                ? `${state.currentEvent} (${state.currentFile})`
                : state.currentEvent || 'Preparing...';
        }

        const eventProgress = document.getElementById('eventProgress');
        if (eventProgress) {
            eventProgress.textContent = `${state.eventsCompleted + 1} / ${state.eventsTotal} events`;
        }

        const bytesProgress = document.getElementById('bytesProgress');
        if (bytesProgress) {
            bytesProgress.textContent = `${this.driveSync.formatBytes(state.bytesCompleted)} / ${this.driveSync.formatBytes(state.bytesTotal)}`;
        }

        const speed = this.driveSync.getTransferSpeed();
        const speedStat = document.getElementById('speedStat');
        if (speedStat) speedStat.textContent = `${this.driveSync.formatBytes(speed)}/s`;

        const eta = this.driveSync.getETA();
        const etaStat = document.getElementById('etaStat');
        if (etaStat) etaStat.textContent = `ETA: ${this.driveSync.formatDuration(eta)}`;

        // Update title
        document.title = `Syncing ${percent}% - TeslaCamViewer`;
    }

    onComplete(state) {
        document.getElementById('progressSection').classList.add('hidden');
        document.getElementById('completeSection').classList.remove('hidden');

        // Hide pause button, show done button
        const pauseBtn = document.getElementById('pauseResumeBtn');
        const startBtn = document.getElementById('startSyncBtn');
        const doneBtn = document.getElementById('doneBtn');

        if (pauseBtn) pauseBtn.classList.add('hidden');
        if (startBtn) startBtn.classList.add('hidden');
        if (doneBtn) doneBtn.classList.remove('hidden');

        const summary = document.getElementById('completeSummary');
        if (summary) {
            summary.textContent = `${state.eventsCompleted}/${state.eventsTotal} events | ${this.driveSync.formatBytes(state.bytesCompleted)} transferred`;
        }

        if (state.errors.length > 0) {
            const errorsEl = document.getElementById('syncErrors');
            if (errorsEl) {
                errorsEl.classList.remove('hidden');
                // Sanitize error messages to prevent XSS
                errorsEl.innerHTML = state.errors.map(e =>
                    `${this.escapeHtml(e.event)}: ${this.escapeHtml(e.error)}`
                ).join('<br>');
            }
        }

        this.requestAttention();
    }

    onError(error) {
        document.getElementById('progressSection').classList.add('hidden');
        document.getElementById('completeSection').classList.remove('hidden');

        // Update button states
        const pauseBtn = document.getElementById('pauseResumeBtn');
        const startBtn = document.getElementById('startSyncBtn');
        const doneBtn = document.getElementById('doneBtn');

        if (pauseBtn) pauseBtn.classList.add('hidden');
        if (startBtn) startBtn.classList.add('hidden');
        if (doneBtn) doneBtn.classList.remove('hidden');

        const summary = document.getElementById('completeSummary');
        if (summary) {
            summary.textContent = `Error: ${error.message}`;
            summary.style.color = 'var(--danger)';
        }

        const badge = document.querySelector('.sync-complete-badge');
        if (badge) {
            badge.style.background = 'var(--danger)';
            badge.innerHTML = `
                <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
            `;
        }

        const title = document.querySelector('.sync-complete-title');
        if (title) {
            title.textContent = 'Sync Failed';
            title.style.color = 'var(--danger)';
        }

        this.requestAttention();
    }

    requestAttention() {
        // Flash title
        this.stopTitleFlash();
        let flash = true;
        this.titleFlashInterval = setInterval(() => {
            document.title = flash ? 'Sync Complete! - TeslaCamViewer' : this.originalTitle;
            flash = !flash;
        }, 1000);

        // Stop when window focused
        window.addEventListener('focus', () => this.stopTitleFlash(), { once: true });

        // Try notification API
        if (Notification.permission === 'granted') {
            new Notification('TeslaCamViewer', {
                body: 'Drive sync complete!',
                icon: '/favicon.svg'
            });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    new Notification('TeslaCamViewer', {
                        body: 'Drive sync complete!',
                        icon: '/favicon.svg'
                    });
                }
            });
        }
    }

    stopTitleFlash() {
        if (this.titleFlashInterval) {
            clearInterval(this.titleFlashInterval);
            this.titleFlashInterval = null;
            document.title = this.originalTitle;
        }
    }

    showSettings() {
        document.getElementById('syncSettingsPanel').classList.remove('hidden');
    }

    hideSettings() {
        document.getElementById('syncSettingsPanel').classList.add('hidden');
    }

    saveSettings() {
        this.driveSync.updateSettings({
            verifyAfterCopy: document.getElementById('settingVerify').checked,
            syncNotes: document.getElementById('settingSyncNotes').checked,
            writeSyncFile: document.getElementById('settingWriteSyncFile').checked,
            confirmBeforeDelete: document.getElementById('settingConfirmDelete').checked,
            noteConflictMode: document.getElementById('settingNoteConflict').value
        });

        this.hideSettings();
    }

    // Preset Management Methods

    loadPreset(presetId) {
        if (!presetId) return;

        const preset = this.driveSync.getPreset(presetId);
        if (!preset) {
            alert('Preset not found');
            return;
        }

        // Find drives by label
        const drives = this.folderManager.getDrives();
        const sourceDrive = drives.find(d => d.label === preset.sourceLabel);
        const destDrive = drives.find(d => d.label === preset.destLabel);

        if (!sourceDrive || !destDrive) {
            alert(`Could not find drives for this preset.\n\nLooking for:\n- Source: ${preset.sourceLabel}\n- Destination: ${preset.destLabel}\n\nMake sure both drives are loaded.`);
            return;
        }

        // Apply selection
        document.getElementById('sourceDriveSelect').value = sourceDrive.id;
        document.getElementById('destDriveSelect').value = destDrive.id;

        this.onSourceChange();
        this.onDestChange();

        // Update last used
        this.driveSync.updatePreset(presetId, { lastUsed: Date.now() });
        this.activePresetId = presetId;

        // Highlight active preset chip
        document.querySelectorAll('.sync-preset-load').forEach(chip => {
            chip.classList.toggle('active', chip.dataset.presetId === presetId);
        });
    }

    savePreset() {
        const sourceId = document.getElementById('sourceDriveSelect').value;
        const destId = document.getElementById('destDriveSelect').value;

        if (!sourceId || !destId) {
            alert('Please select both source and destination drives first.');
            return;
        }

        const sourceDrive = this.folderManager.getDrive(sourceId);
        const destDrive = this.folderManager.getDrive(destId);

        const name = prompt('Enter a name for this preset:', `${sourceDrive.label} to ${destDrive.label}`);
        if (!name) return;

        const preset = this.driveSync.addPreset(name.trim(), sourceDrive.label, destDrive.label);
        this.activePresetId = preset.id;

        // Refresh preset chips
        this.refreshPresetChips();

        // Also refresh manage presets panel if open
        const presetsList = document.getElementById('presetsList');
        if (presetsList) {
            presetsList.innerHTML = this.renderPresetsList();
            this.attachPresetDeleteListeners();
        }

        alert('Preset saved successfully!');
    }

    refreshPresetChips() {
        const chipsContainer = document.getElementById('presetsChips');
        if (chipsContainer) {
            chipsContainer.innerHTML = this.renderPresetChips();
            // Re-attach event listeners for the new chips
            document.querySelectorAll('.sync-preset-load').forEach(chip => {
                chip.addEventListener('click', (e) => {
                    const presetId = e.currentTarget.dataset.presetId;
                    this.loadPreset(presetId);
                });
            });
            document.getElementById('savePresetBtn')?.addEventListener('click', () => this.savePreset());
            document.getElementById('managePresetsBtn')?.addEventListener('click', () => this.showManagePresets());
            this.updateSavePresetButton();
        }
    }

    deletePreset(presetId) {
        const preset = this.driveSync.getPreset(presetId);
        if (!preset) return;

        const confirmed = confirm(`Delete preset "${preset.name}"?`);
        if (!confirmed) return;

        this.driveSync.deletePreset(presetId);

        // Refresh preset chips
        this.refreshPresetChips();

        const presetsList = document.getElementById('presetsList');
        if (presetsList) {
            presetsList.innerHTML = this.renderPresetsList();
            this.attachPresetDeleteListeners();
        }

        if (this.activePresetId === presetId) {
            this.activePresetId = null;
        }
    }

    attachPresetDeleteListeners() {
        document.querySelectorAll('.sync-preset-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const presetId = e.target.closest('button').dataset.presetId;
                this.deletePreset(presetId);
            });
        });
    }

    showManagePresets() {
        const panel = document.getElementById('managePresetsPanel');
        const presetsList = document.getElementById('presetsList');
        presetsList.innerHTML = this.renderPresetsList();
        this.attachPresetDeleteListeners();
        panel.classList.remove('hidden');
    }

    hideManagePresets() {
        document.getElementById('managePresetsPanel').classList.add('hidden');
    }

    async importPresets() {
        const drives = this.folderManager.getDrives();
        let imported = 0;
        let errors = [];

        for (const drive of drives) {
            try {
                const count = await this.driveSync.importPresetsFromDrive(drive);
                imported += count;
            } catch (error) {
                errors.push(`${drive.label}: ${error.message}`);
            }
        }

        // Refresh preset chips
        this.refreshPresetChips();

        // Refresh presets list
        const presetsList = document.getElementById('presetsList');
        if (presetsList) {
            presetsList.innerHTML = this.renderPresetsList();
            this.attachPresetDeleteListeners();
        }

        if (errors.length > 0) {
            alert(`Imported ${imported} presets.\n\nErrors:\n${errors.join('\n')}`);
        } else if (imported > 0) {
            alert(`Successfully imported ${imported} presets from drives.`);
        } else {
            alert('No new presets found on any drives.');
        }
    }

    // Statistics Methods

    showStatistics() {
        if (!this.comparisonResults || !this.comparisonResults.statistics) {
            alert('Please compare drives first to see statistics.');
            return;
        }

        document.getElementById('statisticsSection').classList.remove('hidden');
        this.renderStatistics();
    }

    hideStatistics() {
        document.getElementById('statisticsSection').classList.add('hidden');
    }

    renderStatisticsInline() {
        if (!this.comparisonResults || !this.comparisonResults.statistics) {
            return;
        }

        // Hide the placeholder
        const placeholder = document.querySelector('.sync-stats-placeholder');
        if (placeholder) {
            placeholder.style.display = 'none';
        }

        // Render stats into the content area
        this.renderStatistics();
    }

    renderStatistics() {
        const stats = this.comparisonResults.statistics;
        const content = document.getElementById('statsContent');

        content.innerHTML = `
            <!-- Overview Cards -->
            <div class="sync-stats-overview">
                <div class="sync-stat-card">
                    <span class="sync-stat-value">${stats.overview.totalSourceEvents}</span>
                    <span class="sync-stat-label">Source Events</span>
                </div>
                <div class="sync-stat-card">
                    <span class="sync-stat-value">${stats.overview.totalDestEvents}</span>
                    <span class="sync-stat-label">Destination Events</span>
                </div>
                <div class="sync-stat-card">
                    <span class="sync-stat-value">${stats.overview.missingCount}</span>
                    <span class="sync-stat-label">Missing</span>
                </div>
                <div class="sync-stat-card">
                    <span class="sync-stat-value">${stats.overview.newerCount}</span>
                    <span class="sync-stat-label">Newer on Source</span>
                </div>
                <div class="sync-stat-card">
                    <span class="sync-stat-value">${stats.overview.sameCount}</span>
                    <span class="sync-stat-label">Already Synced</span>
                </div>
                <div class="sync-stat-card">
                    <span class="sync-stat-value">${stats.overview.syncPercent}%</span>
                    <span class="sync-stat-label">Sync Coverage</span>
                </div>
            </div>

            <!-- Storage Breakdown -->
            <div class="sync-stats-section-block">
                <h4>Storage Breakdown</h4>
                <div class="sync-stats-bars">
                    <div class="sync-stat-bar-row">
                        <span class="sync-stat-bar-label">Source Total</span>
                        <div class="sync-stat-bar-container">
                            <div class="sync-stat-bar source" style="width: 100%"></div>
                        </div>
                        <span class="sync-stat-bar-value">${this.driveSync.formatBytes(stats.storage.sourceTotal)}</span>
                    </div>
                    <div class="sync-stat-bar-row">
                        <span class="sync-stat-bar-label">Destination Total</span>
                        <div class="sync-stat-bar-container">
                            <div class="sync-stat-bar dest" style="width: ${Math.min(100, (stats.storage.destTotal / stats.storage.sourceTotal) * 100)}%"></div>
                        </div>
                        <span class="sync-stat-bar-value">${this.driveSync.formatBytes(stats.storage.destTotal)}</span>
                    </div>
                    <div class="sync-stat-bar-row">
                        <span class="sync-stat-bar-label">To Transfer</span>
                        <div class="sync-stat-bar-container">
                            <div class="sync-stat-bar transfer" style="width: ${Math.min(100, (stats.storage.toTransfer / stats.storage.sourceTotal) * 100)}%"></div>
                        </div>
                        <span class="sync-stat-bar-value">${this.driveSync.formatBytes(stats.storage.toTransfer)}</span>
                    </div>
                </div>
            </div>

            <!-- Date Range -->
            <div class="sync-stats-section-block">
                <h4>Date Range</h4>
                <div class="sync-stats-date-range">
                    <div class="sync-date-range-item">
                        <span class="sync-date-label">Source:</span>
                        <span class="sync-date-value">${stats.dateRange.sourceStart || 'N/A'} to ${stats.dateRange.sourceEnd || 'N/A'}</span>
                    </div>
                    <div class="sync-date-range-item">
                        <span class="sync-date-label">Destination:</span>
                        <span class="sync-date-value">${stats.dateRange.destStart || 'N/A'} to ${stats.dateRange.destEnd || 'N/A'}</span>
                    </div>
                </div>
            </div>

            <!-- By Type -->
            <div class="sync-stats-section-block">
                <h4>Events by Type</h4>
                <div class="sync-stats-type-grid">
                    ${this.renderTypeStats(stats.byType)}
                </div>
            </div>

            <!-- By Location -->
            <div class="sync-stats-section-block">
                <h4>Top Locations</h4>
                ${this.renderLocationStats(stats.byLocation)}
            </div>

            <!-- By Month -->
            <div class="sync-stats-section-block">
                <h4>Events by Month</h4>
                ${this.renderMonthStats(stats.byMonth)}
            </div>

            <!-- Detailed Breakdown Table -->
            <div class="sync-stats-section-block">
                <h4>Detailed Event Breakdown</h4>
                <div class="sync-stats-filter">
                    <select id="statsFilterSelect" class="sync-stats-filter-select">
                        <option value="all" ${this.statsFilter === 'all' ? 'selected' : ''}>All Events</option>
                        <option value="missing" ${this.statsFilter === 'missing' ? 'selected' : ''}>Missing Only</option>
                        <option value="newer" ${this.statsFilter === 'newer' ? 'selected' : ''}>Newer Only</option>
                        <option value="same" ${this.statsFilter === 'same' ? 'selected' : ''}>Synced Only</option>
                    </select>
                </div>
                <div class="sync-stats-table-container">
                    ${this.renderDetailedTable(stats.detailed)}
                </div>
            </div>
        `;

        this.attachStatsEventListeners();
    }

    renderTypeStats(byType) {
        const types = ['SavedClips', 'SentryClips', 'RecentClips'];
        return types.map(type => {
            const source = byType.source[type] || { count: 0, size: 0 };
            const dest = byType.dest[type] || { count: 0, size: 0 };
            const missing = byType.missing[type] || { count: 0, size: 0 };

            return `
                <div class="sync-type-stat">
                    <div class="sync-type-header">${type.replace('Clips', '')}</div>
                    <div class="sync-type-row">
                        <span>Source:</span>
                        <span>${source.count} (${this.driveSync.formatBytes(source.size)})</span>
                    </div>
                    <div class="sync-type-row">
                        <span>Dest:</span>
                        <span>${dest.count} (${this.driveSync.formatBytes(dest.size)})</span>
                    </div>
                    <div class="sync-type-row missing">
                        <span>Missing:</span>
                        <span>${missing.count} (${this.driveSync.formatBytes(missing.size)})</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    renderLocationStats(byLocation) {
        const locations = Object.entries(byLocation.source)
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10);

        if (locations.length === 0) {
            return '<p class="sync-no-data">No location data available</p>';
        }

        return `
            <div class="sync-location-list">
                ${locations.map(([location, data]) => {
                    const destData = byLocation.dest[location] || { count: 0, size: 0 };
                    const missingData = byLocation.missing[location] || { count: 0, size: 0 };
                    return `
                        <div class="sync-location-item">
                            <span class="sync-location-name">${location || 'Unknown'}</span>
                            <span class="sync-location-counts">
                                <span class="source">S: ${data.count}</span>
                                <span class="dest">D: ${destData.count}</span>
                                ${missingData.count > 0 ? `<span class="missing">M: ${missingData.count}</span>` : ''}
                            </span>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    renderMonthStats(byMonth) {
        const months = Object.entries(byMonth.source)
            .sort((a, b) => b[0].localeCompare(a[0]))
            .slice(0, 12);

        if (months.length === 0) {
            return '<p class="sync-no-data">No monthly data available</p>';
        }

        const maxCount = Math.max(...months.map(([_, data]) => data.count));

        return `
            <div class="sync-month-chart">
                ${months.map(([month, data]) => {
                    const destData = byMonth.dest[month] || { count: 0 };
                    const missingData = byMonth.missing[month] || { count: 0 };
                    const barWidth = (data.count / maxCount) * 100;

                    return `
                        <div class="sync-month-row">
                            <span class="sync-month-label">${month}</span>
                            <div class="sync-month-bars">
                                <div class="sync-month-bar source" style="width: ${barWidth}%"></div>
                                <div class="sync-month-bar dest" style="width: ${(destData.count / maxCount) * 100}%"></div>
                            </div>
                            <span class="sync-month-counts">
                                ${data.count} / ${destData.count}
                                ${missingData.count > 0 ? `<span class="missing">(${missingData.count} missing)</span>` : ''}
                            </span>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    renderDetailedTable(detailed) {
        // Filter events
        let events = detailed.events;
        if (this.statsFilter !== 'all') {
            events = events.filter(e => e.status === this.statsFilter);
        }

        // Sort events
        events = [...events].sort((a, b) => {
            let aVal = a[this.statsSortColumn];
            let bVal = b[this.statsSortColumn];

            if (this.statsSortColumn === 'size') {
                aVal = a.size || 0;
                bVal = b.size || 0;
            } else if (this.statsSortColumn === 'date') {
                aVal = a.timestamp || '';
                bVal = b.timestamp || '';
            }

            if (typeof aVal === 'string') {
                return this.statsSortAsc
                    ? aVal.localeCompare(bVal)
                    : bVal.localeCompare(aVal);
            }
            return this.statsSortAsc ? aVal - bVal : bVal - aVal;
        });

        const sortIcon = (col) => {
            if (this.statsSortColumn !== col) return '';
            return this.statsSortAsc ? ' ▲' : ' ▼';
        };

        return `
            <table class="sync-stats-table">
                <thead>
                    <tr>
                        <th class="sortable" data-column="name">Event${sortIcon('name')}</th>
                        <th class="sortable" data-column="type">Type${sortIcon('type')}</th>
                        <th class="sortable" data-column="date">Date${sortIcon('date')}</th>
                        <th class="sortable" data-column="location">Location${sortIcon('location')}</th>
                        <th class="sortable" data-column="size">Size${sortIcon('size')}</th>
                        <th class="sortable" data-column="status">Status${sortIcon('status')}</th>
                    </tr>
                </thead>
                <tbody>
                    ${events.slice(0, 100).map(e => `
                        <tr class="status-${e.status}">
                            <td class="event-name">${e.name}</td>
                            <td>${e.type || '-'}</td>
                            <td>${e.date || '-'}</td>
                            <td>${e.location || '-'}</td>
                            <td>${this.driveSync.formatBytes(e.size || 0)}</td>
                            <td><span class="status-badge ${e.status}">${e.status}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            ${events.length > 100 ? `<p class="sync-table-note">Showing first 100 of ${events.length} events</p>` : ''}
        `;
    }

    attachStatsEventListeners() {
        // Filter select
        document.getElementById('statsFilterSelect')?.addEventListener('change', (e) => {
            this.statsFilter = e.target.value;
            this.renderStatistics();
        });

        // Sortable columns
        document.querySelectorAll('.sync-stats-table th.sortable').forEach(th => {
            th.addEventListener('click', () => {
                const column = th.dataset.column;
                if (this.statsSortColumn === column) {
                    this.statsSortAsc = !this.statsSortAsc;
                } else {
                    this.statsSortColumn = column;
                    this.statsSortAsc = true;
                }
                this.renderStatistics();
            });
        });
    }
}
