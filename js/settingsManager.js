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

            // Elevation Profile (requires GPS telemetry)
            elevationEnabled: false,

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
            blurLicensePlates: false  // Off by default since it slows export significantly
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
     * Render the settings modal content with translations
     */
    renderModalContent() {
        const panel = this.modal.querySelector('.settings-panel');
        panel.innerHTML = `
            <div class="settings-header">
                <h2>${this.t('settings.title')}</h2>
                <button class="settings-close-btn" title="${this.t('common.close')}">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                    </svg>
                </button>
            </div>
            <div class="settings-content">
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

                <!-- Session Section -->
                <div class="settings-section">
                    <h3>${this.t('settings.sections.session')}</h3>
                    <div class="setting-row">
                        <label for="setting-rememberLastFolder">${this.t('settings.session.rememberLastFolder')}</label>
                        <input type="checkbox" id="setting-rememberLastFolder" class="setting-checkbox">
                        <span class="setting-hint">${this.t('settings.session.folderHint')}</span>
                    </div>
                </div>

                <!-- Telemetry Overlay Section -->
                <div class="settings-section">
                    <h3>Telemetry Overlay</h3>
                    <p class="setting-hint" style="margin-bottom: 0.75rem;">
                        Shows vehicle data from Tesla firmware 2025.44.25+ (speed, steering, pedals, etc.)
                    </p>
                    <div class="setting-row">
                        <label for="setting-telemetryOverlayEnabled">Enable Telemetry Overlay</label>
                        <input type="checkbox" id="setting-telemetryOverlayEnabled" class="setting-checkbox">
                        <span class="setting-hint">Press T to toggle during playback</span>
                    </div>
                    <div class="setting-row">
                        <label for="setting-telemetryOverlayStyle">Display Style</label>
                        <select id="setting-telemetryOverlayStyle" class="setting-select">
                            <option value="cockpit">Cockpit HUD</option>
                            <option value="tesla">Tesla-Native Pill</option>
                            <option value="minimal">Minimal Corner</option>
                        </select>
                    </div>
                    <div class="setting-row">
                        <label for="setting-telemetryOverlayUnits">Speed Units</label>
                        <select id="setting-telemetryOverlayUnits" class="setting-select">
                            <option value="mph">MPH</option>
                            <option value="kph">KPH</option>
                        </select>
                    </div>
                    <div class="setting-row">
                        <label for="setting-telemetryOverlayInExport">Include in Exports</label>
                        <input type="checkbox" id="setting-telemetryOverlayInExport" class="setting-checkbox">
                        <span class="setting-hint">Add telemetry overlay to exported videos</span>
                    </div>
                </div>

                <!-- Mini-Map Overlay Section -->
                <div class="settings-section">
                    <h3>Mini-Map</h3>
                    <p class="setting-hint" style="margin-bottom: 0.75rem;">
                        GPS map overlay showing vehicle position synced with video playback
                    </p>
                    <div class="setting-row">
                        <label for="setting-miniMapEnabled">Enable Mini-Map</label>
                        <input type="checkbox" id="setting-miniMapEnabled" class="setting-checkbox">
                        <span class="setting-hint">Press M to toggle, right-click for options</span>
                    </div>
                    <div class="setting-row">
                        <label for="setting-miniMapInExport">Include in Exports</label>
                        <input type="checkbox" id="setting-miniMapInExport" class="setting-checkbox">
                        <span class="setting-hint">Add mini-map overlay to exported videos</span>
                    </div>
                    <div class="setting-row">
                        <label for="setting-miniMapDarkMode">Dark Mode Map</label>
                        <input type="checkbox" id="setting-miniMapDarkMode" class="setting-checkbox">
                        <span class="setting-hint">Use dark map tiles (recommended for dashcam viewing)</span>
                    </div>
                    <div class="setting-row">
                        <label for="setting-mapTileProvider">Map Tile Provider</label>
                        <select id="setting-mapTileProvider" class="setting-select">
                            <option value="carto">Carto (Default)</option>
                            <option value="osm">OpenStreetMap</option>
                            <option value="stadia">Stadia Maps</option>
                        </select>
                        <span class="setting-hint">Try OpenStreetMap if maps don't load (e.g., in China)</span>
                    </div>
                </div>

                <div class="settings-section">
                    <h3>Elevation Profile</h3>
                    <p class="setting-hint" style="margin-bottom: 0.75rem;">
                        Elevation graph showing altitude changes along the route
                    </p>
                    <div class="setting-row">
                        <label for="setting-elevationEnabled">Enable Elevation Profile</label>
                        <input type="checkbox" id="setting-elevationEnabled" class="setting-checkbox">
                        <span class="setting-hint">Press Y to toggle</span>
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

                <!-- Export Section -->
                <div class="settings-section">
                    <h3>${this.t('settings.sections.export')}</h3>
                    <div class="setting-row">
                        <label for="setting-exportFormat">${this.t('settings.export.videoFormat')}</label>
                        <select id="setting-exportFormat" class="setting-select">
                            <option value="webm">${this.t('settings.export.webm')}</option>
                            <option value="mp4">${this.t('settings.export.mp4')}</option>
                        </select>
                        <span class="setting-hint">${this.t('settings.export.formatHint')}</span>
                    </div>
                    <div class="setting-row">
                        <label for="setting-blurLicensePlates">Blur License Plates</label>
                        <input type="checkbox" id="setting-blurLicensePlates" class="setting-checkbox">
                        <span class="setting-hint">Uses AI to detect vehicles and blur license plates in exports (slower)</span>
                    </div>
                </div>
            </div>
            <div class="settings-footer">
                <button id="resetSettingsBtn" class="settings-btn secondary">${this.t('settings.resetToDefaults')}</button>
                <button id="closeSettingsBtn" class="settings-btn primary">${this.t('settings.done')}</button>
            </div>
        `;

        // Re-bind events after rendering
        this.bindPanelEvents();
    }

    /**
     * Bind events for the settings modal (overlay and ESC only - called once)
     */
    bindModalEvents() {
        const overlay = this.modal.querySelector('.settings-overlay');
        overlay.addEventListener('click', () => this.hideSettingsModal());

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
        const doneBtn = this.modal.querySelector('#closeSettingsBtn');
        const resetBtn = this.modal.querySelector('#resetSettingsBtn');

        closeBtn.addEventListener('click', () => this.hideSettingsModal());
        doneBtn.addEventListener('click', () => this.hideSettingsModal());

        resetBtn.addEventListener('click', () => {
            if (confirm(this.t('settings.confirmReset'))) {
                this.resetToDefaults();
                this.loadValuesIntoForm();
            }
        });

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
            });
        });
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
    }
}

// Export for use in app.js
window.SettingsManager = SettingsManager;
