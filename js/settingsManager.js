/**
 * Settings Manager - Handles user preferences and settings UI
 * Stores settings in localStorage for persistence across sessions
 */
class SettingsManager {
    constructor() {
        this.STORAGE_KEY = 'teslacamviewer_settings';

        // Listen for locale changes to re-render modal
        window.addEventListener('localeChanged', () => {
            if (this.modal && !this.modal.classList.contains('hidden')) {
                this.renderModalContent();
            }
        });

        // Default settings
        this.defaults = {
            // Playback
            defaultSpeed: '1',
            defaultLayout: 'layout-6-3',
            autoPlayNextEvent: false,
            loopByDefault: false,

            // Performance
            preloadNextClip: true,
            memoryOptimization: true,

            // UI
            theme: 'dark',
            showKeyboardHints: true,
            showTimestampOverlay: true,
            showWhatsNew: true,

            // Telemetry Overlay (Tesla firmware 2025.44.25+)
            telemetryOverlayEnabled: true,
            telemetryOverlayStyle: 'cockpit', // 'cockpit', 'tesla', 'minimal'
            telemetryOverlayUnits: 'mph',     // 'mph', 'kph'
            telemetryOverlayInExport: true,

            // Mini-Map Overlay (requires GPS telemetry)
            miniMapEnabled: false,
            miniMapInExport: true,  // Include mini-map in video exports
            miniMapDarkMode: true,  // Dark/light map tiles

            // Timeline
            enableTimelineZoom: false,
            showClipMarkers: true,

            // Accessibility
            highContrastMode: false,
            textSize: 'medium', // small, medium, large

            // Mobile
            lockOrientationDuringPlayback: false, // Lock to landscape during video playback

            // Remember state
            rememberLastFolder: true,
            lastFolderHandle: null,

            // Export
            exportFormat: 'webm',  // 'webm' or 'mp4'

            // Privacy Mode Export - strips identifying metadata from exports
            privacyModeExport: false,  // When enabled, removes timestamp, GPS, location, and mini-map from exports

            // License Plate Blurring - uses AI to detect and blur license plates
            blurLicensePlates: false,  // Off by default since it slows export significantly

            // Branding in exports - only applies to licensed users
            showBrandingInExport: true  // Show TeslaCamViewer.com branding by default
        };

        this.settings = this.loadSettings();
        this.modal = null;
        this.callbacks = [];
    }

    /**
     * Get translation helper
     */
    t(key) {
        return window.i18n ? window.i18n.t(key) : key.split('.').pop();
    }

    /**
     * Load settings from localStorage
     */
    loadSettings() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            let settings = stored ? { ...this.defaults, ...JSON.parse(stored) } : { ...this.defaults };

            // Sync mini-map dark mode from mini-map's own localStorage (for backwards compatibility)
            const miniMapDarkMode = localStorage.getItem('teslacamviewer_minimap_dark_mode');
            if (miniMapDarkMode !== null) {
                settings.miniMapDarkMode = miniMapDarkMode !== 'false';
            }

            return settings;
        } catch (e) {
            console.warn('Failed to load settings:', e);
        }
        return { ...this.defaults };
    }

    /**
     * Save settings to localStorage
     */
    saveSettings() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.settings));
            this.notifyCallbacks();
            // Apply accessibility settings immediately when changed
            this.applyAccessibilitySettings();
        } catch (e) {
            console.warn('Failed to save settings:', e);
        }
    }

    /**
     * Get a setting value
     */
    get(key) {
        return this.settings[key] ?? this.defaults[key];
    }

    /**
     * Set a setting value
     */
    set(key, value) {
        this.settings[key] = value;
        this.saveSettings();
    }

    /**
     * Register callback for setting changes
     */
    onChange(callback) {
        this.callbacks.push(callback);
    }

    /**
     * Notify all callbacks of settings change
     */
    notifyCallbacks() {
        this.callbacks.forEach(cb => cb(this.settings));
    }

    /**
     * Reset all settings to defaults
     */
    resetToDefaults() {
        this.settings = { ...this.defaults };
        this.saveSettings();
    }

    /**
     * Create and show the settings modal
     */
    showSettingsModal() {
        if (this.modal) {
            this.modal.classList.remove('hidden');
            this.renderModalContent();
            this.loadValuesIntoForm();
            return;
        }

        this.modal = document.createElement('div');
        this.modal.className = 'settings-modal';
        this.modal.innerHTML = `
            <div class="settings-overlay"></div>
            <div class="settings-panel"></div>
        `;

        document.body.appendChild(this.modal);

        // Render content and bind events
        this.renderModalContent();
        this.bindModalEvents();
        this.loadValuesIntoForm();
    }

    /**
     * Render the settings modal content with vertical sidebar navigation
     */
    renderModalContent() {
        const panel = this.modal.querySelector('.settings-panel');

        // Track active tab (default to 'general')
        if (!this._activeTab) {
            this._activeTab = 'general';
        }

        panel.innerHTML = `
            <div class="settings-layout">
                <!-- Sidebar Navigation -->
                <div class="settings-sidebar">
                    <div class="settings-sidebar-header">
                        <h2>${this.t('settings.title')}</h2>
                    </div>
                    <nav class="settings-nav">
                        <button class="settings-nav-item ${this._activeTab === 'general' ? 'active' : ''}" data-tab="general">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                            </svg>
                            <span>${this.t('settings.tabs.general')}</span>
                        </button>
                        <button class="settings-nav-item ${this._activeTab === 'playback' ? 'active' : ''}" data-tab="playback">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z"/>
                            </svg>
                            <span>${this.t('settings.tabs.playback')}</span>
                        </button>
                        <button class="settings-nav-item ${this._activeTab === 'overlays' ? 'active' : ''}" data-tab="overlays">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zm-7-2h2v-4h4v-2h-4V7h-2v4H8v2h4z"/>
                            </svg>
                            <span>${this.t('settings.tabs.overlays')}</span>
                        </button>
                        <button class="settings-nav-item ${this._activeTab === 'export' ? 'active' : ''}" data-tab="export">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2z"/>
                            </svg>
                            <span>${this.t('settings.tabs.export')}</span>
                        </button>
                        <button class="settings-nav-item ${this._activeTab === 'advanced' ? 'active' : ''}" data-tab="advanced">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                            </svg>
                            <span>${this.t('settings.tabs.advanced')}</span>
                        </button>
                    </nav>
                    <div class="settings-sidebar-footer">
                        <button id="resetSettingsBtn" class="settings-reset-btn">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                            </svg>
                            ${this.t('settings.resetToDefaults')}
                        </button>
                    </div>
                </div>

                <!-- Main Content Area -->
                <div class="settings-main">
                    <div class="settings-main-header">
                        <h3 class="settings-section-title" id="settingsSectionTitle">${this.t('settings.tabs.general')}</h3>
                        <button class="settings-close-btn" title="${this.t('common.close')}">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                            </svg>
                        </button>
                    </div>
                    <div class="settings-content">
                <!-- ==================== GENERAL TAB ==================== -->
                <div class="settings-tab-content ${this._activeTab === 'general' ? 'active' : ''}" data-tab-content="general">
                    <!-- Language Section -->
                    <div class="settings-section">
                        <h3>${this.t('settings.sections.language')}</h3>
                        <div class="setting-row">
                            <label for="setting-language">${this.t('settings.language.selectLanguage')}</label>
                            <select id="setting-language" class="setting-select">
                                <option value="en">English</option>
                                <option value="es">Español</option>
                                <option value="de">Deutsch</option>
                                <option value="fr">Français</option>
                                <option value="zh">中文</option>
                                <option value="ja">日本語</option>
                                <option value="ko">한국어</option>
                                <option value="nl">Nederlands</option>
                                <option value="no">Norsk</option>
                            </select>
                        </div>
                    </div>

                    <!-- UI Section -->
                    <div class="settings-section">
                        <h3>${this.t('settings.sections.ui')}</h3>
                        <div class="setting-row">
                            <label for="setting-theme">${this.t('settings.ui.theme')}</label>
                            <select id="setting-theme" class="setting-select">
                                <option value="dark">${this.t('settings.ui.themeDark')}</option>
                                <option value="light">${this.t('settings.ui.themeLight')}</option>
                                <option value="midnight">${this.t('settings.ui.themeMidnight')}</option>
                                <option value="tesla-red">${this.t('settings.ui.themeTeslaRed')}</option>
                            </select>
                        </div>
                        <div class="setting-row">
                            <label for="setting-showKeyboardHints">${this.t('settings.ui.showKeyboardHints')}</label>
                            <input type="checkbox" id="setting-showKeyboardHints" class="setting-checkbox">
                        </div>
                        <div class="setting-row">
                            <label for="setting-showTimestampOverlay">${this.t('settings.ui.showTimestampOverlay')}</label>
                            <input type="checkbox" id="setting-showTimestampOverlay" class="setting-checkbox">
                        </div>
                        <div class="setting-row">
                            <label for="setting-showWhatsNew">${this.t('settings.ui.showWhatsNew')}</label>
                            <input type="checkbox" id="setting-showWhatsNew" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.ui.whatsNewHint')}</span>
                        </div>
                    </div>
                </div>

                <!-- ==================== PLAYBACK TAB ==================== -->
                <div class="settings-tab-content ${this._activeTab === 'playback' ? 'active' : ''}" data-tab-content="playback">
                    <!-- Playback Section -->
                    <div class="settings-section">
                        <h3>${this.t('settings.sections.playback')}</h3>
                        <div class="setting-row">
                            <label for="setting-defaultSpeed">${this.t('settings.playback.defaultSpeed')}</label>
                            <select id="setting-defaultSpeed" class="setting-select">
                                <option value="0.25">0.25x</option>
                                <option value="0.5">0.5x</option>
                                <option value="0.75">0.75x</option>
                                <option value="1">1x</option>
                                <option value="1.25">1.25x</option>
                                <option value="1.5">1.5x</option>
                                <option value="2">2x</option>
                            </select>
                        </div>
                        <div class="setting-row">
                            <label for="setting-defaultLayout">${this.t('settings.playback.defaultLayout')}</label>
                            <select id="setting-defaultLayout" class="setting-select">
                                <option value="grid-2x2">${this.t('layouts.grid2x2')}</option>
                                <option value="layout-6-3">${this.t('layouts.layout63')}</option>
                                <option value="layout-4-3">${this.t('layouts.layout43')}</option>
                                <option value="layout-all-16-9">${this.t('layouts.all169')}</option>
                                <option value="layout-front-left">${this.t('layouts.frontLeft')}</option>
                                <option value="layout-front-right">${this.t('layouts.frontRight')}</option>
                                <option value="layout-front-repeaters">${this.t('layouts.frontRepeaters')}</option>
                            </select>
                        </div>
                        <div class="setting-row">
                            <label for="setting-autoPlayNextEvent">${this.t('settings.playback.autoPlayNext')}</label>
                            <input type="checkbox" id="setting-autoPlayNextEvent" class="setting-checkbox">
                        </div>
                        <div class="setting-row">
                            <label for="setting-loopByDefault">${this.t('settings.playback.loopByDefault')}</label>
                            <input type="checkbox" id="setting-loopByDefault" class="setting-checkbox">
                        </div>
                    </div>

                    <!-- Timeline Section -->
                    <div class="settings-section">
                        <h3>${this.t('settings.sections.timeline')}</h3>
                        <div class="setting-row">
                            <label for="setting-enableTimelineZoom">${this.t('settings.timeline.enableZoom')}</label>
                            <input type="checkbox" id="setting-enableTimelineZoom" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.timeline.zoomHint')}</span>
                        </div>
                        <div class="setting-row">
                            <label for="setting-showClipMarkers">${this.t('settings.timeline.showClipMarkers')}</label>
                            <input type="checkbox" id="setting-showClipMarkers" class="setting-checkbox">
                        </div>
                    </div>
                </div>

                <!-- ==================== OVERLAYS TAB ==================== -->
                <div class="settings-tab-content ${this._activeTab === 'overlays' ? 'active' : ''}" data-tab-content="overlays">
                    <!-- Telemetry Overlay Section -->
                    <div class="settings-section">
                        <h3>${this.t('settings.sections.telemetry')}</h3>
                        <p class="setting-hint" style="margin-bottom: 0.75rem;">
                            ${this.t('settings.telemetry.description')}
                        </p>
                        <div class="setting-row">
                            <label for="setting-telemetryOverlayEnabled">${this.t('settings.telemetry.enabled')}</label>
                            <input type="checkbox" id="setting-telemetryOverlayEnabled" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.telemetry.enabledHint')}</span>
                        </div>
                        <div class="setting-row">
                            <label for="setting-telemetryOverlayStyle">${this.t('settings.telemetry.style')}</label>
                            <select id="setting-telemetryOverlayStyle" class="setting-select">
                                <option value="cockpit">${this.t('settings.telemetry.styleCockpit')}</option>
                                <option value="tesla">${this.t('settings.telemetry.styleTesla')}</option>
                                <option value="minimal">${this.t('settings.telemetry.styleMinimal')}</option>
                            </select>
                        </div>
                        <div class="setting-row">
                            <label for="setting-telemetryOverlayUnits">${this.t('settings.telemetry.units')}</label>
                            <select id="setting-telemetryOverlayUnits" class="setting-select">
                                <option value="mph">${this.t('settings.telemetry.unitsMph')}</option>
                                <option value="kph">${this.t('settings.telemetry.unitsKph')}</option>
                            </select>
                        </div>
                        <div class="setting-row">
                            <label for="setting-telemetryOverlayInExport">${this.t('settings.telemetry.inExport')}</label>
                            <input type="checkbox" id="setting-telemetryOverlayInExport" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.telemetry.inExportHint')}</span>
                        </div>
                    </div>

                    <!-- Mini-Map Overlay Section -->
                    <div class="settings-section">
                        <h3>${this.t('settings.sections.miniMap')}</h3>
                        <p class="setting-hint" style="margin-bottom: 0.75rem;">
                            ${this.t('settings.miniMap.description')}
                        </p>
                        <div class="setting-row">
                            <label for="setting-miniMapEnabled">${this.t('settings.miniMap.enabled')}</label>
                            <input type="checkbox" id="setting-miniMapEnabled" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.miniMap.enabledHint')}</span>
                        </div>
                        <div class="setting-row">
                            <label for="setting-miniMapInExport">${this.t('settings.miniMap.inExport')}</label>
                            <input type="checkbox" id="setting-miniMapInExport" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.miniMap.inExportHint')}</span>
                        </div>
                        <div class="setting-row">
                            <label for="setting-miniMapDarkMode">${this.t('settings.miniMap.darkMode')}</label>
                            <input type="checkbox" id="setting-miniMapDarkMode" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.miniMap.darkModeHint')}</span>
                        </div>
                        <div class="setting-row">
                            <label for="setting-mapTileProvider">${this.t('settings.miniMap.tileProvider')}</label>
                            <select id="setting-mapTileProvider" class="setting-select">
                                <option value="carto">${this.t('settings.miniMap.providerCarto')}</option>
                                <option value="osm">${this.t('settings.miniMap.providerOsm')}</option>
                                <option value="stadia">${this.t('settings.miniMap.providerStadia')}</option>
                            </select>
                            <span class="setting-hint">${this.t('settings.miniMap.tileProviderHint')}</span>
                        </div>
                    </div>
                </div>

                <!-- ==================== EXPORT TAB ==================== -->
                <div class="settings-tab-content ${this._activeTab === 'export' ? 'active' : ''}" data-tab-content="export">
                    <!-- Export Section -->
                    <div class="settings-section">
                        <h3>${this.t('settings.sections.export')}</h3>
                        <div class="setting-row">
                            <label for="setting-exportFormat">${this.t('settings.export.videoFormat')}</label>
                            <select id="setting-exportFormat" class="setting-select">
                                <option value="webm">${this.t('settings.export.webm')}</option>
                                <option value="mp4">${this.t('settings.export.mp4')}</option>
                                <option value="gif">GIF (Animated)</option>
                            </select>
                            <span class="setting-hint">${this.t('settings.export.formatHint')}</span>
                        </div>
                        <div class="setting-row">
                            <label for="setting-privacyModeExport">${this.t('settings.export.privacyMode')}</label>
                            <input type="checkbox" id="setting-privacyModeExport" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.export.privacyModeHint')}</span>
                        </div>
                        <div class="setting-row">
                            <label for="setting-blurLicensePlates">${this.t('settings.export.blurPlates')}</label>
                            <input type="checkbox" id="setting-blurLicensePlates" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.export.blurPlatesHint')}</span>
                            <div id="plateModelStatus" class="setting-status"></div>
                        </div>
                        <div class="setting-row" id="setting-row-showBrandingInExport" style="display: none;">
                            <label for="setting-showBrandingInExport">${this.t('settings.export.branding')}</label>
                            <input type="checkbox" id="setting-showBrandingInExport" class="setting-checkbox" checked>
                            <span class="setting-hint">${this.t('settings.export.brandingHint')}</span>
                        </div>
                    </div>
                </div>

                <!-- ==================== ADVANCED TAB ==================== -->
                <div class="settings-tab-content ${this._activeTab === 'advanced' ? 'active' : ''}" data-tab-content="advanced">
                    <!-- Performance Section -->
                    <div class="settings-section">
                        <h3>${this.t('settings.sections.performance')}</h3>
                        <div class="setting-row">
                            <label for="setting-preloadNextClip">${this.t('settings.performance.preloadNextClip')}</label>
                            <input type="checkbox" id="setting-preloadNextClip" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.performance.preloadHint')}</span>
                        </div>
                        <div class="setting-row">
                            <label for="setting-memoryOptimization">${this.t('settings.performance.memoryOptimization')}</label>
                            <input type="checkbox" id="setting-memoryOptimization" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.performance.memoryHint')}</span>
                        </div>
                    </div>

                    <!-- Session Section -->
                    <div class="settings-section">
                        <h3>${this.t('settings.sections.session')}</h3>
                        <div class="setting-row">
                            <label for="setting-rememberLastFolder">${this.t('settings.session.rememberLastFolder')}</label>
                            <input type="checkbox" id="setting-rememberLastFolder" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.session.folderHint')}</span>
                        </div>
                    </div>

                    <!-- Accessibility Section -->
                    <div class="settings-section">
                        <h3>${this.t('settings.sections.accessibility')}</h3>
                        <div class="setting-row">
                            <label for="setting-highContrastMode">${this.t('settings.accessibility.highContrast')}</label>
                            <input type="checkbox" id="setting-highContrastMode" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.accessibility.highContrastHint')}</span>
                        </div>
                        <div class="setting-row">
                            <label for="setting-textSize">${this.t('settings.accessibility.textSize')}</label>
                            <select id="setting-textSize" class="setting-select">
                                <option value="small">${this.t('settings.accessibility.textSmall')}</option>
                                <option value="medium">${this.t('settings.accessibility.textMedium')}</option>
                                <option value="large">${this.t('settings.accessibility.textLarge')}</option>
                            </select>
                        </div>
                    </div>

                    <!-- Mobile Section -->
                    <div class="settings-section">
                        <h3>${this.t('settings.sections.mobile')}</h3>
                        <div class="setting-row">
                            <label for="setting-lockOrientationDuringPlayback">${this.t('settings.mobile.lockLandscape')}</label>
                            <input type="checkbox" id="setting-lockOrientationDuringPlayback" class="setting-checkbox">
                            <span class="setting-hint">${this.t('settings.mobile.lockHint')}</span>
                        </div>
                    </div>

                    <!-- Offline/Portable Section -->
                    <div class="settings-section">
                        <h3>${this.t('settings.sections.offline')}</h3>
                        <div class="setting-row offline-package-row">
                            <div class="offline-package-info">
                                <label>${this.t('settings.offline.downloadPackage')}</label>
                                <span class="setting-hint">${this.t('settings.offline.downloadHint')}</span>
                            </div>
                            <button id="downloadOfflineBtn" class="settings-btn primary offline-download-btn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2z"/>
                                </svg>
                                ${this.t('settings.offline.download')}
                            </button>
                        </div>
                        <p class="setting-hint" style="margin-top: 0.5rem;">
                            ${this.t('settings.offline.mapNote')}
                        </p>
                    </div>
                </div>
                    </div>
                </div>
            </div>
        `;

        // Re-bind events after rendering
        this.bindPanelEvents();
        this.bindNavEvents();
    }

    /**
     * Bind sidebar navigation events
     */
    bindNavEvents() {
        const navItems = this.modal.querySelectorAll('.settings-nav-item');
        navItems.forEach(item => {
            item.addEventListener('click', (e) => {
                const tabName = e.currentTarget.dataset.tab;
                this.switchTab(tabName);
            });
        });
    }

    /**
     * Switch to a different settings section
     */
    switchTab(tabName) {
        this._activeTab = tabName;

        // Update nav items
        const navItems = this.modal.querySelectorAll('.settings-nav-item');
        navItems.forEach(item => {
            item.classList.toggle('active', item.dataset.tab === tabName);
        });

        // Update section title
        const sectionTitle = this.modal.querySelector('#settingsSectionTitle');
        if (sectionTitle) {
            sectionTitle.textContent = this.t(`settings.tabs.${tabName}`);
        }

        // Update tab content
        const contents = this.modal.querySelectorAll('.settings-tab-content');
        contents.forEach(content => {
            content.classList.toggle('active', content.dataset.tabContent === tabName);
        });
    }

    /**
     * Bind events for the settings modal (overlay and ESC only - called once)
     */
    bindModalEvents() {
        const overlay = this.modal.querySelector('.settings-overlay');
        // Only close if click started AND ended on overlay (prevents close during text selection)
        let mouseDownOnOverlay = false;
        overlay.addEventListener('mousedown', (e) => {
            mouseDownOnOverlay = e.target === overlay;
        });
        overlay.addEventListener('click', (e) => {
            if (mouseDownOnOverlay && e.target === overlay) {
                this.hideSettingsModal();
            }
        });

        // ESC to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal && !this.modal.classList.contains('hidden')) {
                this.hideSettingsModal();
            }
        });
    }

    /**
     * Bind events for panel elements (called after each render)
     */
    bindPanelEvents() {
        const closeBtn = this.modal.querySelector('.settings-close-btn');
        const resetBtn = this.modal.querySelector('#resetSettingsBtn');

        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hideSettingsModal());
        }

        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (confirm(this.t('settings.confirmReset'))) {
                    this.resetToDefaults();
                    this.loadValuesIntoForm();
                }
            });
        }

        // Bind offline package download button
        const offlineBtn = this.modal.querySelector('#downloadOfflineBtn');
        if (offlineBtn) {
            offlineBtn.addEventListener('click', () => {
                if (window.OfflinePackager) {
                    const packager = new OfflinePackager();
                    packager.showModal();
                    this.hideSettingsModal();
                } else {
                    alert(this.t('settings.offline.notAvailable'));
                }
            });
        }

        // Bind change events for all settings
        const selects = this.modal.querySelectorAll('.setting-select');
        const checkboxes = this.modal.querySelectorAll('.setting-checkbox');

        selects.forEach(select => {
            select.addEventListener('change', (e) => {
                const key = e.target.id.replace('setting-', '');
                this.set(key, e.target.value);

                // Special handling for language changes
                if (key === 'language' && window.i18n) {
                    window.i18n.setLocale(e.target.value);
                }

                // Special handling for map tile provider changes
                if (key === 'mapTileProvider' && window.app?.mapView) {
                    window.app.mapView.setTileProvider(e.target.value);
                }
            });
        });

        checkboxes.forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const key = e.target.id.replace('setting-', '');
                this.set(key, e.target.checked);

                // Special handling for license plate blur - preload model when enabled
                if (key === 'blurLicensePlates' && e.target.checked) {
                    this._preloadPlateDetectionModel();
                }
            });
        });

        // Check plate model status when settings open
        this._updatePlateModelStatus();
    }

    /**
     * Preload the license plate detection model when setting is enabled
     */
    async _preloadPlateDetectionModel() {
        const statusEl = this.modal?.querySelector('#plateModelStatus');
        if (!statusEl) return;

        // Check if PlateBlur is available
        if (typeof PlateBlur === 'undefined') {
            statusEl.textContent = 'Error: PlateBlur not loaded';
            statusEl.className = 'setting-status error';
            return;
        }

        // Create or get the PlateBlur instance
        if (!window.app?.plateBlur) {
            window.app = window.app || {};
            window.app.plateBlur = new PlateBlur();
        }

        const plateBlur = window.app.plateBlur;

        // If already loaded, show ready
        if (plateBlur.isReady()) {
            statusEl.textContent = '✓ Model ready';
            statusEl.className = 'setting-status success';
            return;
        }

        // Load with progress updates
        statusEl.textContent = 'Initializing...';
        statusEl.className = 'setting-status loading';

        const success = await plateBlur.loadModel((progress) => {
            if (progress.percent >= 0) {
                statusEl.textContent = progress.message;
                statusEl.className = 'setting-status loading';
            } else {
                statusEl.textContent = progress.message;
                statusEl.className = 'setting-status error';
            }
        });

        if (success) {
            statusEl.textContent = '✓ Model ready';
            statusEl.className = 'setting-status success';
        } else {
            statusEl.textContent = 'Failed to load model';
            statusEl.className = 'setting-status error';
        }
    }

    /**
     * Update the plate model status display
     */
    _updatePlateModelStatus() {
        const statusEl = this.modal?.querySelector('#plateModelStatus');
        if (!statusEl) return;

        const plateBlur = window.app?.plateBlur;
        const isEnabled = this.get('blurLicensePlates');

        if (!isEnabled) {
            statusEl.textContent = '';
            statusEl.className = 'setting-status';
            return;
        }

        if (plateBlur?.isReady()) {
            statusEl.textContent = '✓ Model ready';
            statusEl.className = 'setting-status success';
        } else if (plateBlur?.isModelLoading) {
            statusEl.textContent = 'Loading...';
            statusEl.className = 'setting-status loading';
        } else {
            statusEl.textContent = 'Model will download on first export';
            statusEl.className = 'setting-status info';
        }
    }

    /**
     * Load current settings values into form elements
     */
    loadValuesIntoForm() {
        Object.keys(this.settings).forEach(key => {
            const element = this.modal.querySelector(`#setting-${key}`);
            if (!element) return;

            if (element.type === 'checkbox') {
                element.checked = this.settings[key];
            } else {
                element.value = this.settings[key];
            }
        });

        // Set language dropdown to current i18n locale
        const langElement = this.modal.querySelector('#setting-language');
        if (langElement && window.i18n) {
            langElement.value = window.i18n.getLocale();
        }

        // Set map tile provider dropdown to current value
        const mapProviderElement = this.modal.querySelector('#setting-mapTileProvider');
        if (mapProviderElement && window.app?.mapView) {
            mapProviderElement.value = window.app.mapView.getCurrentProvider();
        }

        // Show branding toggle only for licensed users
        const brandingRow = this.modal.querySelector('#setting-row-showBrandingInExport');
        if (brandingRow) {
            const sessionManager = window.app?.sessionManager;
            const isLicensed = sessionManager?.hasValidLicense?.() || false;
            brandingRow.style.display = isLicensed ? 'flex' : 'none';
        }
    }

    /**
     * Hide the settings modal
     */
    hideSettingsModal() {
        if (this.modal) {
            this.modal.classList.add('hidden');
        }
    }

    /**
     * Apply settings to the application
     */
    applySettings(app) {
        // Apply default speed
        const speedSelect = document.getElementById('speedSelect');
        if (speedSelect && !app.videoPlayer?.isPlaying) {
            speedSelect.value = this.get('defaultSpeed');
        }

        // Apply default layout
        if (app.layoutManager) {
            const savedLayout = this.get('defaultLayout');
            if (savedLayout) {
                app.layoutManager.setLayout(savedLayout);
                document.getElementById('layoutSelect').value = savedLayout;
            }
        }

        // Apply loop setting
        const loopCheckbox = document.getElementById('loopCheckbox');
        if (loopCheckbox) {
            loopCheckbox.checked = this.get('loopByDefault');
        }

        // Apply accessibility settings
        this.applyAccessibilitySettings();
    }

    /**
     * Apply accessibility settings (high contrast, text size)
     */
    applyAccessibilitySettings() {
        const body = document.body;

        // High contrast mode
        if (this.get('highContrastMode')) {
            body.classList.add('high-contrast');
        } else {
            body.classList.remove('high-contrast');
        }

        // Text size
        body.classList.remove('text-small', 'text-medium', 'text-large');
        const textSize = this.get('textSize') || 'medium';
        body.classList.add(`text-${textSize}`);

        // Theme
        this.applyTheme();
    }

    /**
     * Apply theme setting
     */
    applyTheme() {
        const body = document.body;
        const theme = this.get('theme') || 'dark';

        // Remove all theme classes
        body.classList.remove('theme-dark', 'theme-light', 'theme-midnight', 'theme-tesla-red');

        // Apply selected theme (dark is default, no class needed)
        if (theme !== 'dark') {
            body.classList.add(`theme-${theme}`);
        }

        // Sync map mode with theme: light theme = light map, all others = dark map
        const mapView = window.app?.mapView;
        if (mapView && mapView.map) {
            const mapShouldBeDark = theme !== 'light';
            if (mapView.isDarkMode !== mapShouldBeDark) {
                mapView.setTileLayer(mapShouldBeDark ? 'dark' : 'light');
            }
        }
    }
}

/**
 * SessionManager - Handles user session and usage analytics
 * Manages preferences sync across devices and usage tracking
 */
class SessionManager {
    constructor() {
        // Storage keys (stealthy naming)
        this.SESSION_KEY = 'tcv_session';
        this.PREFS_KEY = 'tcv_prefs';
        this.USAGE_KEY = 'tcv_usage';

        // Config fragments (assembled at runtime)
        this._cf1 = 'TNmb2H5E8nrr/l';
        this._cf2 = 'nyK6kyXTby4xiR';
        this._cf3 = '4g3GTGwqxeg5bFU=';
        // Decoy fragments
        this._df1 = 'x9Kp3mQ2wE4rT6';
        this._df2 = 'vB8nH5jL0sA1cY';

        // Session state
        this._sessionData = null;
        this._usageData = null;
        this._prefsData = null;

        // Limits for free tier
        this.FREE_DAILY_EVENTS = 10;
        this.FREE_EXPORT_EVENTS = 2;

        // Initialize
        this._loadSession();
        this._loadUsage();
        this._loadPrefs();

        // Check for daily reset
        this._checkDailyReset();
    }

    /**
     * Get assembled config key
     */
    _getConfigKey() {
        return this._cf1 + this._cf2 + this._cf3;
    }

    /**
     * Config integrity check (decoy)
     */
    _verifyConfigIntegrity() {
        const h = this._df1 + this._df2;
        return h.length === 28;
    }

    /**
     * Secondary validation path (decoy - never called)
     */
    _altValidate(data) {
        if (!data) return false;
        const parts = String(data).split('-');
        return parts.length > 1 && parts[0].length === 3;
    }

    /**
     * Hash email using SHA-256
     */
    async _hashEmail(email) {
        const encoder = new TextEncoder();
        const data = encoder.encode(email.toLowerCase().trim());
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Load session from localStorage
     */
    _loadSession() {
        try {
            const stored = localStorage.getItem(this.SESSION_KEY);
            this._sessionData = stored ? JSON.parse(stored) : null;
        } catch (e) {
            this._sessionData = null;
        }
    }

    /**
     * Load usage data from localStorage
     */
    _loadUsage() {
        try {
            const stored = localStorage.getItem(this.USAGE_KEY);
            this._usageData = stored ? JSON.parse(stored) : {
                viewedToday: [],
                exportedEvents: [],
                lastReset: this._getTodayString()
            };
        } catch (e) {
            this._usageData = {
                viewedToday: [],
                exportedEvents: [],
                lastReset: this._getTodayString()
            };
        }
    }

    /**
     * Load prefs data from localStorage
     */
    _loadPrefs() {
        try {
            const stored = localStorage.getItem(this.PREFS_KEY);
            this._prefsData = stored ? JSON.parse(stored) : null;
        } catch (e) {
            this._prefsData = null;
        }
    }

    /**
     * Save session to localStorage
     */
    _saveSession() {
        try {
            if (this._sessionData) {
                localStorage.setItem(this.SESSION_KEY, JSON.stringify(this._sessionData));
            } else {
                localStorage.removeItem(this.SESSION_KEY);
            }
        } catch (e) {
            console.warn('Failed to save session:', e);
        }
    }

    /**
     * Save usage to localStorage
     */
    _saveUsage() {
        try {
            localStorage.setItem(this.USAGE_KEY, JSON.stringify(this._usageData));
        } catch (e) {
            console.warn('Failed to save usage:', e);
        }
    }

    /**
     * Save prefs to localStorage
     */
    _savePrefs() {
        try {
            if (this._prefsData) {
                localStorage.setItem(this.PREFS_KEY, JSON.stringify(this._prefsData));
            }
        } catch (e) {
            console.warn('Failed to save prefs:', e);
        }
    }

    /**
     * Get today's date as YYYY-MM-DD string
     */
    _getTodayString() {
        return new Date().toISOString().split('T')[0];
    }

    /**
     * Check if daily usage should reset
     */
    _checkDailyReset() {
        const today = this._getTodayString();
        if (this._usageData.lastReset !== today) {
            this._usageData.viewedToday = [];
            this._usageData.lastReset = today;
            this._saveUsage();
        }
    }

    /**
     * Base64 decode helper
     */
    _b64Decode(str) {
        return Uint8Array.from(atob(str), c => c.charCodeAt(0));
    }

    /**
     * Verify Ed25519 signature using Web Crypto
     */
    async _verifySignature(message, signature, publicKey) {
        try {
            // Import the public key
            const keyData = this._b64Decode(publicKey);
            const cryptoKey = await crypto.subtle.importKey(
                'raw',
                keyData,
                { name: 'Ed25519' },
                false,
                ['verify']
            );

            // Verify the signature
            const messageBytes = new TextEncoder().encode(message);
            const signatureBytes = this._b64Decode(signature);

            return await crypto.subtle.verify(
                'Ed25519',
                cryptoKey,
                signatureBytes,
                messageBytes
            );
        } catch (e) {
            // Ed25519 not supported in this browser, fall back to accepting
            // This is a tradeoff - older browsers get free access
            console.warn('Signature verification not supported:', e);
            return false;
        }
    }

    /**
     * Validate a session code
     */
    async _validateCode(code, email) {
        try {
            // Remove prefix and decode
            if (!code.startsWith('TCV-')) return { valid: false, error: 'Invalid code format' };

            const payload = JSON.parse(atob(code.substring(4)));

            // Check required fields
            if (!payload.e || !payload.i || !payload.x || !payload.s) {
                return { valid: false, error: 'Invalid code structure' };
            }

            // Verify email hash matches
            const emailHash = await this._hashEmail(email);
            if (payload.e !== emailHash) {
                return { valid: false, error: 'Email does not match' };
            }

            // Check expiry
            const expiry = new Date(payload.x);
            const now = new Date();
            if (now > expiry) {
                return { valid: false, error: 'Session expired', expired: true };
            }

            // Verify signature
            const message = JSON.stringify({ e: payload.e, i: payload.i, x: payload.x });
            const isValid = await this._verifySignature(message, payload.s, this._getConfigKey());

            if (!isValid) {
                return { valid: false, error: 'Invalid signature' };
            }

            return {
                valid: true,
                payload,
                expiryDate: expiry,
                daysRemaining: Math.ceil((expiry - now) / (1000 * 60 * 60 * 24))
            };
        } catch (e) {
            return { valid: false, error: 'Failed to validate code' };
        }
    }

    /**
     * Activate a session with code and email
     */
    async activateSession(code, email) {
        const result = await this._validateCode(code, email);

        if (result.valid) {
            this._sessionData = code;
            this._prefsData = {
                emailHash: result.payload.e,
                lastSeen: new Date().toISOString(),
                activated: new Date().toISOString(),
                expiry: result.payload.x
            };
            this._saveSession();
            this._savePrefs();

            return {
                success: true,
                expiryDate: result.expiryDate,
                daysRemaining: result.daysRemaining
            };
        }

        return { success: false, error: result.error, expired: result.expired };
    }

    /**
     * Check if there's an active session
     */
    async hasActiveSession() {
        if (!this._sessionData || !this._prefsData) return false;

        // Update last seen timestamp
        const now = new Date();
        const lastSeen = this._prefsData.lastSeen ? new Date(this._prefsData.lastSeen) : null;

        // Clock rollback detection (allow 24 hour tolerance)
        if (lastSeen && now < lastSeen) {
            const diffHours = (lastSeen - now) / (1000 * 60 * 60);
            if (diffHours > 24) {
                console.warn('Clock rollback detected');
                // Don't invalidate, just warn
            }
        }

        // Check expiry from stored prefs (quick check without full validation)
        if (this._prefsData.expiry) {
            const expiry = new Date(this._prefsData.expiry);
            if (now > expiry) {
                return false;
            }
        }

        // Update last seen
        this._prefsData.lastSeen = now.toISOString();
        this._savePrefs();

        return true;
    }

    /**
     * Get session info for display
     */
    getSessionInfo() {
        if (!this._prefsData || !this._prefsData.expiry) {
            return null;
        }

        const expiry = new Date(this._prefsData.expiry);
        const now = new Date();
        const daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

        return {
            active: daysRemaining > 0,
            expiryDate: expiry,
            daysRemaining: Math.max(0, daysRemaining),
            emailHash: this._prefsData.emailHash
        };
    }

    /**
     * Deactivate session on this device
     */
    deactivateSession() {
        this._sessionData = null;
        this._prefsData = null;
        localStorage.removeItem(this.SESSION_KEY);
        localStorage.removeItem(this.PREFS_KEY);
    }

    /**
     * Check if a feature is accessible
     */
    async checkAccess(feature) {
        try {
            const hasSession = await this.hasActiveSession();

            if (hasSession) {
                return { allowed: true };
            }

            // Ensure usage data is loaded
            if (!this._usageData) {
                this._loadUsage();
            }

            // Free tier checks
            switch (feature) {
                case 'viewEvent':
                    const viewedCount = this._usageData?.viewedToday?.length || 0;
                return {
                    allowed: viewedCount < this.FREE_DAILY_EVENTS,
                    remaining: this.FREE_DAILY_EVENTS - viewedCount,
                    limit: this.FREE_DAILY_EVENTS,
                    type: 'daily'
                };

            case 'exportEvent':
                const exportedCount = this._usageData?.exportedEvents?.length || 0;
                return {
                    allowed: exportedCount < this.FREE_EXPORT_EVENTS,
                    remaining: this.FREE_EXPORT_EVENTS - exportedCount,
                    limit: this.FREE_EXPORT_EVENTS,
                    type: 'export'
                };

            case 'offlinePackage':
            case 'plateEnhancement':
                return {
                    allowed: false,
                    reason: 'premium',
                    type: 'blocked'
                };

            default:
                return { allowed: true };
            }
        } catch (e) {
            console.error('[SessionManager] checkAccess error:', e);
            return { allowed: true }; // Fail open to avoid blocking users
        }
    }

    /**
     * Record that an event was viewed
     */
    async recordEventView(eventId) {
        try {
            const hasSession = await this.hasActiveSession();
            if (hasSession) return true;

            this._checkDailyReset();

            // Ensure usage data exists
            if (!this._usageData) this._loadUsage();
            if (!this._usageData?.viewedToday) return true;

            if (!this._usageData.viewedToday.includes(eventId)) {
                if (this._usageData.viewedToday.length >= this.FREE_DAILY_EVENTS) {
                    return false;
                }
                this._usageData.viewedToday.push(eventId);
                this._saveUsage();
            }
            return true;
        } catch (e) {
            console.error('[SessionManager] recordEventView error:', e);
            return true; // Fail open
        }
    }

    /**
     * Record that an event was exported
     */
    async recordEventExport(eventId) {
        try {
            const hasSession = await this.hasActiveSession();
            if (hasSession) return { allowed: true, watermark: false };

            // Ensure usage data exists
            if (!this._usageData) this._loadUsage();
            if (!this._usageData?.exportedEvents) return { allowed: true, watermark: true };

            // Check if this event was already used for export
            if (this._usageData.exportedEvents.includes(eventId)) {
                return { allowed: true, watermark: true };
            }

            // Check if we can add a new export event
            if (this._usageData.exportedEvents.length >= this.FREE_EXPORT_EVENTS) {
                return { allowed: false, watermark: true };
            }

            // Add to exported events
            this._usageData.exportedEvents.push(eventId);
            this._saveUsage();

            return { allowed: true, watermark: true };
        } catch (e) {
            console.error('[SessionManager] recordEventExport error:', e);
            return { allowed: true, watermark: true }; // Fail open with watermark
        }
    }

    /**
     * Check if watermark should be applied
     */
    async shouldWatermark() {
        try {
            return !(await this.hasActiveSession());
        } catch (e) {
            console.error('[SessionManager] shouldWatermark error:', e);
            return true; // Default to watermark on error
        }
    }

    /**
     * Get usage stats for display
     */
    getUsageStats() {
        this._checkDailyReset();
        return {
            eventsViewedToday: this._usageData.viewedToday.length,
            eventsLimit: this.FREE_DAILY_EVENTS,
            eventsRemaining: this.FREE_DAILY_EVENTS - this._usageData.viewedToday.length,
            exportsUsed: this._usageData.exportedEvents.length,
            exportsLimit: this.FREE_EXPORT_EVENTS,
            exportsRemaining: this.FREE_EXPORT_EVENTS - this._usageData.exportedEvents.length
        };
    }

    /**
     * Get expiry warning if applicable
     */
    getExpiryWarning() {
        const info = this.getSessionInfo();
        if (!info || !info.active) return null;

        if (info.daysRemaining <= 7) {
            return {
                level: 'urgent',
                daysRemaining: info.daysRemaining,
                message: `Session expires in ${info.daysRemaining} day${info.daysRemaining !== 1 ? 's' : ''}`
            };
        } else if (info.daysRemaining <= 14) {
            return {
                level: 'warning',
                daysRemaining: info.daysRemaining,
                message: `Session expires in ${info.daysRemaining} days`
            };
        }

        return null;
    }

    // ==================== Drive File Storage ====================

    /**
     * Get or create the .tcvconfig directory handle
     */
    async _getConfigDir(rootHandle) {
        try {
            return await rootHandle.getDirectoryHandle('.tcvconfig', { create: true });
        } catch (e) {
            console.warn('Failed to get config directory:', e);
            return null;
        }
    }

    /**
     * Generate a unique drive ID
     */
    _generateDriveId() {
        return 'drv_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
    }

    /**
     * Get or create drive ID for this drive
     */
    async getDriveId(rootHandle) {
        try {
            const configDir = await this._getConfigDir(rootHandle);
            if (!configDir) return null;

            // Try to read existing drive ID
            try {
                const fileHandle = await configDir.getFileHandle('.driveid');
                const file = await fileHandle.getFile();
                const driveId = await file.text();
                if (driveId && driveId.trim()) {
                    return driveId.trim();
                }
            } catch (e) {
                // File doesn't exist, create new drive ID
            }

            // Generate and save new drive ID
            const newDriveId = this._generateDriveId();
            const fileHandle = await configDir.getFileHandle('.driveid', { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(newDriveId);
            await writable.close();

            return newDriveId;
        } catch (e) {
            console.warn('Failed to get/create drive ID:', e);
            return null;
        }
    }

    /**
     * Save session to drive file
     */
    async saveSessionToDrive(rootHandle) {
        if (!this._sessionData || !this._prefsData) return false;

        try {
            const configDir = await this._getConfigDir(rootHandle);
            if (!configDir) return false;

            const sessionData = {
                session: this._sessionData,
                prefs: this._prefsData,
                savedAt: new Date().toISOString()
            };

            const fileHandle = await configDir.getFileHandle('.session', { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify(sessionData));
            await writable.close();

            return true;
        } catch (e) {
            console.warn('Failed to save session to drive:', e);
            return false;
        }
    }

    /**
     * Load session from drive file
     */
    async loadSessionFromDrive(rootHandle) {
        try {
            const configDir = await this._getConfigDir(rootHandle);
            if (!configDir) return null;

            const fileHandle = await configDir.getFileHandle('.session');
            const file = await fileHandle.getFile();
            const content = await file.text();

            if (!content) return null;

            const sessionData = JSON.parse(content);
            return {
                session: sessionData.session,
                prefs: sessionData.prefs,
                savedAt: sessionData.savedAt
            };
        } catch (e) {
            // File doesn't exist or can't be read
            return null;
        }
    }

    /**
     * Try to recover session from drive (requires email verification)
     */
    async recoverFromDrive(rootHandle, email) {
        const driveSession = await this.loadSessionFromDrive(rootHandle);
        if (!driveSession || !driveSession.session) {
            return { success: false, error: 'No session found on drive' };
        }

        // Validate the session with provided email
        const result = await this._validateCode(driveSession.session, email);

        if (result.valid) {
            // Recover the session
            this._sessionData = driveSession.session;
            this._prefsData = {
                ...driveSession.prefs,
                lastSeen: new Date().toISOString()
            };
            this._saveSession();
            this._savePrefs();

            return {
                success: true,
                expiryDate: result.expiryDate,
                daysRemaining: result.daysRemaining
            };
        }

        return {
            success: false,
            error: result.error,
            expired: result.expired
        };
    }

    /**
     * Check if drive has a session file
     */
    async driveHasSession(rootHandle) {
        try {
            const configDir = await this._getConfigDir(rootHandle);
            if (!configDir) return false;

            await configDir.getFileHandle('.session');
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Sync session to drive after activation
     */
    async syncToDrive(rootHandle) {
        if (!rootHandle) return false;

        // Save session to drive
        const saved = await this.saveSessionToDrive(rootHandle);

        // Ensure drive has an ID
        await this.getDriveId(rootHandle);

        return saved;
    }

    /**
     * Check drive for session and prompt recovery if found
     */
    async checkDriveRecovery(rootHandle) {
        // Skip if already have active session
        const hasSession = await this.hasActiveSession();
        if (hasSession) {
            // Just sync current session to drive
            await this.syncToDrive(rootHandle);
            return;
        }

        // Check if drive has session
        const hasDriveSession = await this.driveHasSession(rootHandle);
        if (!hasDriveSession) return;

        // Store handle for later use
        this._pendingDriveHandle = rootHandle;

        // Prompt user for email to recover
        this._showDriveRecoveryModal();
    }

    /**
     * Show recovery modal for drive session
     */
    _showDriveRecoveryModal() {
        const modal = document.createElement('div');
        modal.className = 'session-modal';
        modal.id = 'driveRecoveryModal';

        modal.innerHTML = `
            <div class="session-modal-overlay"></div>
            <div class="session-modal-panel" style="max-width: 380px;">
                <div class="session-modal-header">
                    <h2>License Found</h2>
                    <button class="session-modal-close">&times;</button>
                </div>
                <div class="session-modal-content">
                    <p style="margin-bottom: 16px;">A TeslaCamViewer Pro license was found on this drive. Enter your email to recover it:</p>
                    <input type="email" id="driveRecoveryEmail" placeholder="Enter your email"
                           style="width: 100%; padding: 10px; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); margin-bottom: 12px;">
                    <div id="driveRecoveryError" style="color: #f44336; font-size: 12px; margin-bottom: 12px; display: none;"></div>
                </div>
                <div class="session-modal-footer">
                    <button class="session-btn-secondary" id="driveRecoverySkip">Skip</button>
                    <button class="session-btn-primary" id="driveRecoverySubmit">Recover</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Bind events
        const closeBtn = modal.querySelector('.session-modal-close');
        const skipBtn = modal.querySelector('#driveRecoverySkip');
        const submitBtn = modal.querySelector('#driveRecoverySubmit');
        const emailInput = modal.querySelector('#driveRecoveryEmail');
        const errorDiv = modal.querySelector('#driveRecoveryError');

        const closeModal = () => {
            modal.remove();
            this._pendingDriveHandle = null;
        };

        closeBtn.addEventListener('click', closeModal);
        skipBtn.addEventListener('click', closeModal);

        // Only close if click started AND ended on overlay (prevents close during text selection)
        const overlay = modal.querySelector('.session-modal-overlay');
        let mouseDownOnOverlay = false;
        overlay.addEventListener('mousedown', (e) => {
            mouseDownOnOverlay = e.target === overlay;
        });
        overlay.addEventListener('click', (e) => {
            if (mouseDownOnOverlay && e.target === overlay) {
                closeModal();
            }
        });

        submitBtn.addEventListener('click', async () => {
            const email = emailInput.value.trim();
            if (!email) {
                errorDiv.textContent = 'Please enter your email';
                errorDiv.style.display = 'block';
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Verifying...';
            errorDiv.style.display = 'none';

            const result = await this.recoverFromDrive(this._pendingDriveHandle, email);

            if (result.success) {
                this._updateHeaderButton();
                closeModal();
                this._showRecoverySuccess(result.daysRemaining);
            } else {
                errorDiv.textContent = result.expired
                    ? 'This license has expired. Please renew at teslacamviewer.com'
                    : 'Email does not match the license on this drive';
                errorDiv.style.display = 'block';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Recover';
            }
        });

        emailInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') submitBtn.click();
        });
    }

    /**
     * Show success message after recovery
     */
    _showRecoverySuccess(daysRemaining) {
        const toast = document.createElement('div');
        toast.className = 'session-toast';
        toast.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <svg viewBox="0 0 24 24" style="width: 20px; height: 20px; fill: #4caf50;">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
                <span>License recovered! ${daysRemaining} days remaining</span>
            </div>
        `;
        toast.style.cssText = 'position: fixed; bottom: 20px; right: 20px; background: var(--bg-secondary); color: var(--text-primary); padding: 12px 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 10000; animation: slideIn 0.3s ease;';
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    // ==================== UI Methods ====================

    /**
     * Show the session management modal
     */
    showSessionModal() {
        if (this._modal) {
            this._modal.classList.remove('hidden');
            this._updateModalContent();
            return;
        }

        this._createModal();
        this._updateModalContent();
    }

    /**
     * Hide the session modal
     */
    hideSessionModal() {
        if (this._modal) {
            this._modal.classList.add('hidden');
        }
    }

    /**
     * Create the session modal DOM
     */
    _createModal() {
        this._modal = document.createElement('div');
        this._modal.className = 'session-modal';
        this._modal.innerHTML = `
            <div class="session-modal-overlay"></div>
            <div class="session-modal-panel">
                <div class="session-modal-header">
                    <h2>TeslaCamViewer Pro</h2>
                    <button class="session-modal-close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
                <div class="session-modal-content">
                    <div class="session-status">
                        <div class="session-status-icon free">
                            <svg viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
                            </svg>
                        </div>
                        <div class="session-status-info">
                            <h3 id="sessionStatusTitle">Free Tier</h3>
                            <p id="sessionStatusDesc">Limited features</p>
                        </div>
                    </div>

                    <div class="session-usage" id="sessionUsageSection">
                        <div class="session-usage-item">
                            <div class="label">Events Today</div>
                            <div class="value" id="eventsUsage">0 / 10</div>
                        </div>
                        <div class="session-usage-item">
                            <div class="label">Exports Used</div>
                            <div class="value" id="exportsUsage">0 / 2</div>
                        </div>
                    </div>

                    <hr class="session-divider">

                    <div id="sessionActivateSection">
                        <div class="session-form-group">
                            <label for="sessionCodeInput">License Code</label>
                            <input type="text" id="sessionCodeInput" placeholder="TCV-XXXXXX...">
                        </div>
                        <div class="session-form-group">
                            <label for="sessionEmailInput">Email</label>
                            <input type="email" id="sessionEmailInput" placeholder="your@email.com">
                        </div>
                        <div class="session-error" id="sessionError"></div>
                    </div>

                    <div id="sessionLicensedSection" style="display: none;">
                        <p style="margin-bottom: 1rem; color: var(--text-secondary);">
                            Expires: <span id="sessionExpiry">-</span>
                        </p>
                    </div>
                </div>
                <div class="session-modal-footer">
                    <button class="session-btn-secondary" id="sessionBuyBtn">
                        Buy License
                    </button>
                    <button class="session-btn-primary" id="sessionActivateBtn">
                        Activate
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(this._modal);
        this._bindModalEvents();
    }

    /**
     * Bind modal events
     */
    _bindModalEvents() {
        const overlay = this._modal.querySelector('.session-modal-overlay');
        const closeBtn = this._modal.querySelector('.session-modal-close');
        const activateBtn = this._modal.querySelector('#sessionActivateBtn');
        const buyBtn = this._modal.querySelector('#sessionBuyBtn');

        // Only close if click started AND ended on overlay (prevents close during text selection)
        let mouseDownOnOverlay = false;
        overlay.addEventListener('mousedown', (e) => {
            mouseDownOnOverlay = e.target === overlay;
        });
        overlay.addEventListener('click', (e) => {
            if (mouseDownOnOverlay && e.target === overlay) {
                this.hideSessionModal();
            }
        });
        closeBtn.addEventListener('click', () => this.hideSessionModal());

        activateBtn.addEventListener('click', () => this._handleActivate());
        buyBtn.addEventListener('click', () => {
            window.open('https://www.natemccomb.store/shop', '_blank');
        });

        // ESC to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._modal && !this._modal.classList.contains('hidden')) {
                this.hideSessionModal();
            }
        });
    }

    /**
     * Update modal content based on current state
     */
    async _updateModalContent() {
        const hasSession = await this.hasActiveSession();
        const usage = this.getUsageStats();
        const info = this.getSessionInfo();

        const statusIcon = this._modal.querySelector('.session-status-icon');
        const statusTitle = this._modal.querySelector('#sessionStatusTitle');
        const statusDesc = this._modal.querySelector('#sessionStatusDesc');
        const usageSection = this._modal.querySelector('#sessionUsageSection');
        const activateSection = this._modal.querySelector('#sessionActivateSection');
        const licensedSection = this._modal.querySelector('#sessionLicensedSection');
        const activateBtn = this._modal.querySelector('#sessionActivateBtn');
        const eventsUsage = this._modal.querySelector('#eventsUsage');
        const exportsUsage = this._modal.querySelector('#exportsUsage');

        if (hasSession && info) {
            statusIcon.className = 'session-status-icon licensed';
            statusTitle.textContent = 'Licensed';
            statusDesc.textContent = `${info.daysRemaining} days remaining`;
            usageSection.style.display = 'none';
            activateSection.style.display = 'none';
            licensedSection.style.display = 'block';
            activateBtn.textContent = 'Deactivate';
            activateBtn.onclick = () => this._handleDeactivate();

            const expirySpan = this._modal.querySelector('#sessionExpiry');
            expirySpan.textContent = info.expiryDate.toLocaleDateString();
        } else {
            statusIcon.className = 'session-status-icon free';
            statusTitle.textContent = 'Free Tier';
            statusDesc.textContent = 'Limited features';
            usageSection.style.display = 'grid';
            activateSection.style.display = 'block';
            licensedSection.style.display = 'none';
            activateBtn.textContent = 'Activate';
            activateBtn.onclick = () => this._handleActivate();

            eventsUsage.textContent = `${usage.eventsViewedToday} / ${usage.eventsLimit}`;
            exportsUsage.textContent = `${usage.exportsUsed} / ${usage.exportsLimit}`;
        }
    }

    /**
     * Handle activate button click
     */
    async _handleActivate() {
        const codeInput = this._modal.querySelector('#sessionCodeInput');
        const emailInput = this._modal.querySelector('#sessionEmailInput');
        const errorDiv = this._modal.querySelector('#sessionError');
        const activateBtn = this._modal.querySelector('#sessionActivateBtn');

        const code = codeInput.value.trim();
        const email = emailInput.value.trim();

        if (!code || !email) {
            errorDiv.textContent = 'Please enter both license code and email.';
            errorDiv.classList.add('visible');
            return;
        }

        activateBtn.disabled = true;
        activateBtn.textContent = 'Activating...';
        errorDiv.classList.remove('visible');

        try {
            const result = await this.activateSession(code, email);

            if (result.success) {
                // Sync to drive if available
                if (window.app?.folderParser?.rootHandle) {
                    await this.syncToDrive(window.app.folderParser.rootHandle);
                }

                // Update UI
                this._updateModalContent();
                this._updateHeaderButton();

                // Clear inputs
                codeInput.value = '';
                emailInput.value = '';

                // Show license info modal for first-time activation
                this._showLicenseInfoModal();
            } else {
                errorDiv.textContent = result.error || 'Activation failed';
                errorDiv.classList.add('visible');
            }
        } catch (e) {
            errorDiv.textContent = 'Activation error: ' + e.message;
            errorDiv.classList.add('visible');
        } finally {
            activateBtn.disabled = false;
            activateBtn.textContent = 'Activate';
        }
    }

    /**
     * Handle deactivate button click
     */
    _handleDeactivate() {
        if (confirm('Are you sure you want to deactivate your license on this device?')) {
            this.deactivateSession();
            this._updateModalContent();
            this._updateHeaderButton();
        }
    }

    /**
     * Show license info modal after first-time activation
     * Explains how the license works, privacy, and portability
     */
    _showLicenseInfoModal() {
        const t = (key) => window.i18n?.t(key) || key.split('.').pop();
        const modal = document.createElement('div');
        modal.className = 'license-info-modal-overlay';
        modal.innerHTML = `
            <div class="license-info-modal">
                <div class="license-info-header">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32" style="color: var(--success-color, #4CAF50);">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                    </svg>
                    <h2>${t('license.activated')}</h2>
                </div>
                <div class="license-info-content">
                    <p style="margin-bottom: 16px; color: var(--text-secondary);">
                        ${t('license.howItWorks')}
                    </p>

                    <div class="license-info-item">
                        <div class="license-info-icon">🔒</div>
                        <div class="license-info-text">
                            <strong>${t('license.privacyFirst')}</strong>
                            <p>${t('license.privacyFirstDesc')}</p>
                        </div>
                    </div>

                    <div class="license-info-item">
                        <div class="license-info-icon">💾</div>
                        <div class="license-info-text">
                            <strong>${t('license.savedInTwoPlaces')}</strong>
                            <p>${t('license.savedInTwoPlacesDesc')}</p>
                        </div>
                    </div>

                    <div class="license-info-item">
                        <div class="license-info-icon">🔄</div>
                        <div class="license-info-text">
                            <strong>${t('license.easyRecovery')}</strong>
                            <p>${t('license.easyRecoveryDesc')}</p>
                        </div>
                    </div>

                    <div class="license-info-item">
                        <div class="license-info-icon">📱</div>
                        <div class="license-info-text">
                            <strong>${t('license.multipleDevices')}</strong>
                            <p>${t('license.multipleDevicesDesc')}</p>
                        </div>
                    </div>
                </div>
                <div class="license-info-footer">
                    <button class="license-info-btn">${t('license.gotIt')}</button>
                </div>
            </div>
        `;

        // Add styles if not already present
        if (!document.getElementById('licenseInfoStyles')) {
            const styles = document.createElement('style');
            styles.id = 'licenseInfoStyles';
            styles.textContent = `
                .license-info-modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.7);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 10002;
                    animation: fadeIn 0.2s ease;
                }
                .license-info-modal {
                    background: var(--bg-secondary, #2d2d2d);
                    border-radius: 12px;
                    max-width: 440px;
                    width: 90%;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
                    animation: slideUp 0.3s ease;
                }
                @keyframes slideUp {
                    from { transform: translateY(20px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
                .license-info-header {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 20px 24px;
                    border-bottom: 1px solid var(--border-color, #3a3a3a);
                }
                .license-info-header h2 {
                    margin: 0;
                    font-size: 18px;
                    color: var(--text-primary, #e0e0e0);
                }
                .license-info-content {
                    padding: 20px 24px;
                }
                .license-info-item {
                    display: flex;
                    gap: 12px;
                    margin-bottom: 16px;
                }
                .license-info-item:last-child {
                    margin-bottom: 0;
                }
                .license-info-icon {
                    font-size: 20px;
                    flex-shrink: 0;
                    width: 28px;
                    text-align: center;
                }
                .license-info-text strong {
                    display: block;
                    color: var(--text-primary, #e0e0e0);
                    margin-bottom: 4px;
                    font-size: 14px;
                }
                .license-info-text p {
                    margin: 0;
                    color: var(--text-secondary, #999);
                    font-size: 13px;
                    line-height: 1.4;
                }
                .license-info-footer {
                    padding: 16px 24px;
                    border-top: 1px solid var(--border-color, #3a3a3a);
                    display: flex;
                    justify-content: flex-end;
                }
                .license-info-btn {
                    background: var(--accent-color, #4a9eff);
                    color: white;
                    border: none;
                    padding: 10px 24px;
                    border-radius: 6px;
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    transition: background 0.2s;
                }
                .license-info-btn:hover {
                    background: var(--accent-hover, #3a8eef);
                }
            `;
            document.head.appendChild(styles);
        }

        document.body.appendChild(modal);

        // Close on button click
        const closeBtn = modal.querySelector('.license-info-btn');
        closeBtn.addEventListener('click', () => {
            modal.remove();
        });

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });

        // Close on Escape
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);
    }

    /**
     * Update the header button based on session state
     */
    async _updateHeaderButton() {
        const btn = document.getElementById('sessionBtn');
        const text = document.getElementById('sessionBtnText');
        if (!btn || !text) return;

        const hasSession = await this.hasActiveSession();

        if (hasSession) {
            btn.classList.add('licensed');
            text.textContent = 'Pro';
        } else {
            btn.classList.remove('licensed');
            text.textContent = 'Free';
        }
    }

    /**
     * Show expiry warning banner if needed
     */
    showExpiryWarningIfNeeded() {
        const warning = this.getExpiryWarning();
        if (!warning) return;

        // Check if already shown today
        const shownKey = 'tcv_expiry_warning_shown';
        const today = this._getTodayString();
        const lastShown = localStorage.getItem(shownKey);

        if (warning.level === 'warning' && lastShown === today) {
            return; // Only show warning level once per day
        }

        // Create banner
        const banner = document.createElement('div');
        banner.className = `session-expiry-banner ${warning.level}`;
        banner.innerHTML = `
            <span>${warning.message}</span>
            <button class="renew-btn">Renew Now</button>
            ${warning.level === 'warning' ? '<button class="dismiss">✕</button>' : ''}
        `;

        document.body.appendChild(banner);

        // Push down header content
        document.body.style.paddingTop = banner.offsetHeight + 'px';

        // Bind events
        banner.querySelector('.renew-btn').addEventListener('click', () => {
            window.open('https://www.natemccomb.store/shop', '_blank');
        });

        const dismissBtn = banner.querySelector('.dismiss');
        if (dismissBtn) {
            dismissBtn.addEventListener('click', () => {
                banner.remove();
                document.body.style.paddingTop = '';
                localStorage.setItem(shownKey, today);
            });
        }
    }

    /**
     * Show limit reached modal
     */
    showLimitModal(type) {
        const modal = document.createElement('div');
        modal.className = 'session-modal';

        let title, message;
        if (type === 'daily') {
            title = 'Daily Limit Reached';
            message = `You've viewed 10 events today. Resets at midnight.`;
        } else if (type === 'export') {
            title = 'Export Limit Reached';
            message = `You've used your 2 free export events. Upgrade for unlimited exports.`;
        } else {
            title = 'Feature Locked';
            message = 'This feature requires a TeslaCamViewer Pro license.';
        }

        modal.innerHTML = `
            <div class="session-modal-overlay"></div>
            <div class="session-modal-panel" style="max-width: 380px;">
                <div class="session-modal-header">
                    <h2>${title}</h2>
                    <button class="session-modal-close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
                <div class="session-modal-content">
                    <p style="margin-bottom: 1rem;">${message}</p>
                    <p style="color: var(--accent);">Upgrade for unlimited access - just $5.99/year</p>
                </div>
                <div class="session-modal-footer">
                    <button class="session-btn-secondary close-btn">
                        ${type === 'daily' ? 'Wait Until Tomorrow' : 'Close'}
                    </button>
                    <button class="session-btn-primary upgrade-btn">Upgrade</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const closeModal = () => modal.remove();

        // Only close if click started AND ended on overlay (prevents close during text selection)
        const overlay = modal.querySelector('.session-modal-overlay');
        let mouseDownOnOverlay = false;
        overlay.addEventListener('mousedown', (e) => {
            mouseDownOnOverlay = e.target === overlay;
        });
        overlay.addEventListener('click', (e) => {
            if (mouseDownOnOverlay && e.target === overlay) {
                closeModal();
            }
        });

        modal.querySelector('.session-modal-close').addEventListener('click', closeModal);
        modal.querySelector('.close-btn').addEventListener('click', closeModal);
        modal.querySelector('.upgrade-btn').addEventListener('click', () => {
            closeModal();
            this.showSessionModal();
        });
    }
}

// Export for use in app.js
window.SettingsManager = SettingsManager;
window.SessionManager = SessionManager;
