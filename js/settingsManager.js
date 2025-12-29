/**
 * Settings Manager - Handles user preferences and settings UI
 * Stores settings in localStorage for persistence across sessions
 */
class SettingsManager {
    constructor() {
        this.STORAGE_KEY = 'teslacamviewer_settings';

        // Default settings
        this.defaults = {
            // Playback
            defaultSpeed: '1',
            defaultLayout: 'grid-2x2',
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

            // Timeline
            enableTimelineZoom: false,
            showClipMarkers: true,

            // Accessibility
            highContrastMode: false,
            textSize: 'medium', // small, medium, large

            // Mobile
            lockOrientationDuringPlayback: false, // Lock to landscape during video playback

            // Remember state
            rememberLastFolder: false,
            lastFolderHandle: null,

            // Export
            exportFormat: 'webm'  // 'webm' or 'mp4'
        };

        this.settings = this.loadSettings();
        this.modal = null;
        this.callbacks = [];
    }

    /**
     * Load settings from localStorage
     */
    loadSettings() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) {
                return { ...this.defaults, ...JSON.parse(stored) };
            }
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
            return;
        }

        this.modal = document.createElement('div');
        this.modal.className = 'settings-modal';
        this.modal.innerHTML = `
            <div class="settings-overlay"></div>
            <div class="settings-panel">
                <div class="settings-header">
                    <h2>Settings</h2>
                    <button class="settings-close-btn" title="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
                <div class="settings-content">
                    <!-- Playback Section -->
                    <div class="settings-section">
                        <h3>Playback</h3>
                        <div class="setting-row">
                            <label for="setting-defaultSpeed">Default Speed</label>
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
                            <label for="setting-defaultLayout">Default Layout</label>
                            <select id="setting-defaultLayout" class="setting-select">
                                <option value="grid-2x2">2x2 Grid</option>
                                <option value="layout-6-3">6:3 Centered</option>
                                <option value="layout-4-3">4:3 Main</option>
                                <option value="layout-all-16-9">All 16:9</option>
                                <option value="layout-front-left">Front + Left</option>
                                <option value="layout-front-right">Front + Right</option>
                                <option value="layout-front-repeaters">Front + Repeaters</option>
                            </select>
                        </div>
                        <div class="setting-row">
                            <label for="setting-autoPlayNextEvent">Auto-play next event</label>
                            <input type="checkbox" id="setting-autoPlayNextEvent" class="setting-checkbox">
                        </div>
                        <div class="setting-row">
                            <label for="setting-loopByDefault">Loop by default</label>
                            <input type="checkbox" id="setting-loopByDefault" class="setting-checkbox">
                        </div>
                    </div>

                    <!-- Performance Section -->
                    <div class="settings-section">
                        <h3>Performance</h3>
                        <div class="setting-row">
                            <label for="setting-preloadNextClip">Preload next clip</label>
                            <input type="checkbox" id="setting-preloadNextClip" class="setting-checkbox">
                            <span class="setting-hint">Smoother playback, uses more memory</span>
                        </div>
                        <div class="setting-row">
                            <label for="setting-memoryOptimization">Memory optimization</label>
                            <input type="checkbox" id="setting-memoryOptimization" class="setting-checkbox">
                            <span class="setting-hint">Release unused video resources</span>
                        </div>
                    </div>

                    <!-- UI Section -->
                    <div class="settings-section">
                        <h3>User Interface</h3>
                        <div class="setting-row">
                            <label for="setting-theme">Theme</label>
                            <select id="setting-theme" class="setting-select">
                                <option value="dark">Dark (Default)</option>
                                <option value="light">Light</option>
                                <option value="midnight">Midnight</option>
                                <option value="tesla-red">Tesla Red</option>
                            </select>
                        </div>
                        <div class="setting-row">
                            <label for="setting-showKeyboardHints">Show keyboard hints</label>
                            <input type="checkbox" id="setting-showKeyboardHints" class="setting-checkbox">
                        </div>
                        <div class="setting-row">
                            <label for="setting-showTimestampOverlay">Show timestamp overlay</label>
                            <input type="checkbox" id="setting-showTimestampOverlay" class="setting-checkbox">
                        </div>
                        <div class="setting-row">
                            <label for="setting-showWhatsNew">Show "What's New" indicators</label>
                            <input type="checkbox" id="setting-showWhatsNew" class="setting-checkbox">
                            <span class="setting-hint">Blue dots on new features, update notifications</span>
                        </div>
                    </div>

                    <!-- Timeline Section -->
                    <div class="settings-section">
                        <h3>Timeline</h3>
                        <div class="setting-row">
                            <label for="setting-enableTimelineZoom">Enable timeline zoom</label>
                            <input type="checkbox" id="setting-enableTimelineZoom" class="setting-checkbox">
                            <span class="setting-hint">Scroll to zoom in/out on timeline</span>
                        </div>
                        <div class="setting-row">
                            <label for="setting-showClipMarkers">Show clip markers</label>
                            <input type="checkbox" id="setting-showClipMarkers" class="setting-checkbox">
                        </div>
                    </div>

                    <!-- Session Section -->
                    <div class="settings-section">
                        <h3>Session</h3>
                        <div class="setting-row">
                            <label for="setting-rememberLastFolder">Remember last folder</label>
                            <input type="checkbox" id="setting-rememberLastFolder" class="setting-checkbox">
                            <span class="setting-hint">Requires folder permission on reload</span>
                        </div>
                    </div>

                    <!-- Offline/Portable Section -->
                    <div class="settings-section">
                        <h3>Offline Mode</h3>
                        <div class="setting-row offline-package-row">
                            <div class="offline-package-info">
                                <label>Download Offline Package</label>
                                <span class="setting-hint">Create a self-contained version for USB drives (~2-3 MB)</span>
                            </div>
                            <button id="downloadOfflineBtn" class="settings-btn primary offline-download-btn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2z"/>
                                </svg>
                                Download
                            </button>
                        </div>
                        <p class="setting-hint" style="margin-top: 0.5rem;">
                            Includes all app files and libraries. Map requires internet connection.
                        </p>
                    </div>

                    <!-- Accessibility Section -->
                    <div class="settings-section">
                        <h3>Accessibility</h3>
                        <div class="setting-row">
                            <label for="setting-highContrastMode">High contrast mode</label>
                            <input type="checkbox" id="setting-highContrastMode" class="setting-checkbox">
                            <span class="setting-hint">Increases text and border contrast</span>
                        </div>
                        <div class="setting-row">
                            <label for="setting-textSize">Text size</label>
                            <select id="setting-textSize" class="setting-select">
                                <option value="small">Small</option>
                                <option value="medium">Medium (Default)</option>
                                <option value="large">Large</option>
                            </select>
                        </div>
                    </div>

                    <!-- Mobile Section -->
                    <div class="settings-section">
                        <h3>Mobile</h3>
                        <div class="setting-row">
                            <label for="setting-lockOrientationDuringPlayback">Lock landscape during playback</label>
                            <input type="checkbox" id="setting-lockOrientationDuringPlayback" class="setting-checkbox">
                            <span class="setting-hint">Lock screen to landscape while video is playing (mobile only)</span>
                        </div>
                    </div>

                    <!-- Export Section -->
                    <div class="settings-section">
                        <h3>Export</h3>
                        <div class="setting-row">
                            <label for="setting-exportFormat">Video Format</label>
                            <select id="setting-exportFormat" class="setting-select">
                                <option value="webm">WebM (VP9) - Smaller files</option>
                                <option value="mp4">MP4 (H.264) - Better compatibility</option>
                            </select>
                            <span class="setting-hint">Format used when exporting videos</span>
                        </div>
                    </div>
                </div>
                <div class="settings-footer">
                    <button id="resetSettingsBtn" class="settings-btn secondary">Reset to Defaults</button>
                    <button id="closeSettingsBtn" class="settings-btn primary">Done</button>
                </div>
            </div>
        `;

        document.body.appendChild(this.modal);

        // Bind events
        this.bindModalEvents();

        // Load current values into form
        this.loadValuesIntoForm();
    }

    /**
     * Bind events for the settings modal
     */
    bindModalEvents() {
        const closeBtn = this.modal.querySelector('.settings-close-btn');
        const doneBtn = this.modal.querySelector('#closeSettingsBtn');
        const resetBtn = this.modal.querySelector('#resetSettingsBtn');
        const overlay = this.modal.querySelector('.settings-overlay');

        const closeModal = () => this.hideSettingsModal();

        closeBtn.addEventListener('click', closeModal);
        doneBtn.addEventListener('click', closeModal);
        overlay.addEventListener('click', closeModal);

        resetBtn.addEventListener('click', () => {
            if (confirm('Reset all settings to defaults?')) {
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
                    alert('Offline packager not available. Please reload the page and try again.');
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
            });
        });

        checkboxes.forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const key = e.target.id.replace('setting-', '');
                this.set(key, e.target.checked);
            });
        });

        // ESC to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal && !this.modal.classList.contains('hidden')) {
                closeModal();
            }
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
