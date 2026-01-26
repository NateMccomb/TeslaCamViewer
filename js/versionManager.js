/**
 * VersionManager - Tracks app version, changelog, and "what's new" indicators
 * Shows blue dots on features that are new since the user's last visit
 *
 * Version Format: YYYY.W.D.R (Tesla-style)
 *   YYYY = Year
 *   W = ISO Week number (1-53, no leading zero)
 *   D = Day of week (1=Mon, 7=Sun)
 *   R = Release number for that day
 */
class VersionManager {
    constructor() {
        this.STORAGE_KEY = 'teslacamviewer_version_state';
        this.UPDATE_CHECK_KEY = 'teslacamviewer_last_update_check';
        this.UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours in ms

        // Remote version check URL
        this.remoteVersionUrl = 'https://teslacamviewer.com/version.json';

        // Current version - UPDATE THIS when releasing new features
        // Format: Year.Week.DayOfWeek.Release
        this.currentVersion = '2026.5.1.2';

        // Changelog with feature identifiers for "what's new" dots
        // Each entry has: version, date, title, and features array
        // Features have: id (for tracking seen state), text, elementSelector (optional)
        this.changelog = [
            {
                version: '2026.5.1.2',
                date: '2026-01-26',
                title: 'AI License Plate Detection & Incident Markers',
                features: [
                    {
                        id: 'ai-plate-detection',
                        text: 'AI-powered license plate detection - automatically finds plates across all cameras (press D)',
                        elementSelector: '#enhanceRegionBtn'
                    },
                    {
                        id: 'plate-size-warnings',
                        text: 'Real-time selection size indicator warns when plate region is too large for fast processing',
                        elementSelector: '#enhanceBtn'
                    },
                    {
                        id: 'incident-markers',
                        text: 'Incident Markers detect hard braking (>0.35g) and lateral g-force events in your telemetry',
                        elementSelector: '#statsBtn'
                    },
                    {
                        id: 'map-theme-sync',
                        text: 'Map now syncs with app theme and has improved styled controls',
                        elementSelector: '.tab-btn[data-tab="map"]'
                    },
                    {
                        id: 'region-tracking-improvements',
                        text: 'Improved plate tracking with Siamese network for better accuracy across frames',
                        elementSelector: null
                    },
                    {
                        id: 'incident-slowmo-fix',
                        text: 'Fixed Incident Slow-Mo detection and added time offset display in Incident Hotspot popup',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.4.6.1',
                date: '2026-01-25',
                title: 'Modern UI for Settings & Statistics',
                features: [
                    {
                        id: 'settings-sidebar-layout',
                        text: 'Settings modal redesigned with modern vertical sidebar navigation (like VS Code/Discord)',
                        elementSelector: null
                    },
                    {
                        id: 'statistics-sidebar-layout',
                        text: 'Statistics modal redesigned with sidebar navigation: Overview, Timeline, Locations, Sentry Analysis, Data Quality, Export tabs',
                        elementSelector: null
                    },
                    {
                        id: 'themed-scrollbars',
                        text: 'Themed scrollbars throughout the app for a consistent modern look',
                        elementSelector: null
                    },
                    {
                        id: 'privacy-mode-export-ui',
                        text: 'Added Privacy Mode Export toggle in Settings (strips metadata from exports)',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.4.1.2',
                date: '2026-01-19',
                title: 'Map Provider Options & Bug Reporting',
                features: [
                    {
                        id: 'map-tile-provider',
                        text: 'New map tile provider setting: switch between Carto, OpenStreetMap, or Stadia Maps (fixes maps not loading in China)',
                        elementSelector: null
                    },
                    {
                        id: 'bug-report-button',
                        text: 'Report Bug button in Help modal copies diagnostic info to clipboard for easier bug reports',
                        elementSelector: null
                    },
                    {
                        id: 'parse-diagnostics',
                        text: 'Enhanced diagnostic logging helps debug folder parsing issues (e.g., OneDrive)',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.4.1.1',
                date: '2026-01-19',
                title: 'Map & Mobile Fixes',
                features: [
                    {
                        id: 'map-light-tiles',
                        text: 'Fixed map light mode tiles not loading (switched to CARTO)',
                        elementSelector: null
                    },
                    {
                        id: 'heatmap-all-events',
                        text: 'Heatmap now shows all events (telemetry + metadata GPS combined)',
                        elementSelector: null
                    },
                    {
                        id: 'mobile-telemetry-panel',
                        text: 'Fixed mobile telemetry panel display and elevation graph alignment',
                        elementSelector: null
                    },
                    {
                        id: 'mobile-filter-panel',
                        text: 'Fixed mobile filter panel not loading correctly',
                        elementSelector: null
                    },
                    {
                        id: 'hard-brake-accel-fix',
                        text: 'Fixed hard brake/acceleration detection showing inverted values',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.3.6.1',
                date: '2026-01-18',
                title: 'Update Notifications & Loading Progress',
                features: [
                    {
                        id: 'update-notifications',
                        text: 'Automatic update notifications when a new version is available',
                        elementSelector: null
                    },
                    {
                        id: 'loading-progress',
                        text: 'Loading progress indicator shows which folders are being scanned',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.3.5.3',
                date: '2026-01-16',
                title: 'Advanced Analytics & Safety Features',
                features: [
                    {
                        id: 'hard-braking-detection',
                        text: 'Hard braking/acceleration detection with markers on G-Force graph',
                        elementSelector: null
                    },
                    {
                        id: 'driving-smoothness-score',
                        text: 'Driving smoothness score (0-100) based on steering, accel, lateral G',
                        elementSelector: null
                    },
                    {
                        id: 'clickable-anomalies',
                        text: 'Clickable anomaly markers on telemetry graphs - auto-detects spikes',
                        elementSelector: null
                    },
                    {
                        id: 'phantom-braking',
                        text: 'Phantom braking detection for Autopilot analysis',
                        elementSelector: null
                    },
                    {
                        id: 'ap-struggle-zones',
                        text: 'Autopilot struggle zones map - shows frequent disengagement locations',
                        elementSelector: null
                    },
                    {
                        id: 'near-miss-scoring',
                        text: 'Near-miss incident scoring with timeline markers',
                        elementSelector: null
                    },
                    {
                        id: 'insurance-report-pdf',
                        text: 'Insurance report PDF generator with frames, telemetry, and map',
                        elementSelector: null
                    },
                    {
                        id: 'auto-blur-plates',
                        text: 'Auto-blur license plates in export using AI detection',
                        elementSelector: null
                    },
                    {
                        id: 'privacy-mode-export',
                        text: 'Privacy mode export - strips timestamp, GPS, and location data',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.3.5.2',
                date: '2026-01-16',
                title: 'Trip Analytics & Export Enhancements',
                features: [
                    {
                        id: 'csv-telemetry-export',
                        text: 'Export telemetry data as CSV - download button in graphs panel',
                        elementSelector: null
                    },
                    {
                        id: 'trip-analytics-stats',
                        text: 'Trip statistics in graphs header - distance, avg/max speed, autopilot %',
                        elementSelector: null
                    },
                    {
                        id: 'minimap-in-export',
                        text: 'Option to include GPS mini-map in video exports',
                        elementSelector: null
                    },
                    {
                        id: 'driving-heatmap',
                        text: 'Driving heatmap on Map tab - shows your most frequent routes',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.3.5.1',
                date: '2026-01-16',
                title: 'Telemetry Graphs & Speed Limit Display',
                features: [
                    {
                        id: 'telemetry-graphs-panel',
                        text: 'Interactive telemetry graphs panel - Press G to toggle speed, G-force, and steering graphs',
                        elementSelector: '#telemetryGraphsPanel'
                    },
                    {
                        id: 'speed-limit-display',
                        text: 'Real-time speed limit display from OpenStreetMap - shows limit on HUD and graph',
                        elementSelector: null
                    },
                    {
                        id: 'speed-limit-graph-line',
                        text: 'Speed limit reference line on speed graph that varies along the route',
                        elementSelector: null
                    },
                    {
                        id: 'gps-minimap',
                        text: 'GPS mini-map overlay showing vehicle position in real-time',
                        elementSelector: null
                    },
                    {
                        id: 'speed-limit-styling',
                        text: 'Regional speed limit sign styling - rectangular (US) or circular (EU/metric)',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.1.2.1',
                date: '2025-12-30',
                title: 'Internationalization & Mobile Fixes',
                features: [
                    {
                        id: 'i18n-support',
                        text: 'Multi-language support - Switch languages in Settings or welcome screen',
                        elementSelector: '#settingsBtn'
                    },
                    {
                        id: 'mini-mode-controls',
                        text: 'Fixed mobile portrait mode controls - play, frame step, timeline scrubbing',
                        elementSelector: null
                    },
                    {
                        id: 'mobile-fullscreen-fixes',
                        text: 'Mobile fullscreen: Escape key exits, tap shows controls, bottom sheet hidden',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.1.1.2',
                date: '2025-12-29',
                title: 'Export Quality & Format Options',
                features: [
                    {
                        id: 'export-frame-timing-fix',
                        text: 'Fixed video export frame skipping - consistent 30fps timing',
                        elementSelector: '#exportBtn'
                    },
                    {
                        id: 'export-format-setting',
                        text: 'Choose export format: WebM (VP9) or MP4 (H.264) in Settings',
                        elementSelector: '#settingsBtn'
                    },
                    {
                        id: 'export-cancel-fix',
                        text: 'Cancel button now works reliably during export progress',
                        elementSelector: '#exportBtn'
                    }
                ]
            },
            {
                version: '2026.1.1.1',
                date: '2025-12-29',
                title: 'User Data Backup & Drive Sync UI',
                features: [
                    {
                        id: 'user-data-backup',
                        text: 'Notes, tags, and bookmarks now backed up to event folders - data travels with the drive',
                        elementSelector: '#notesBtn'
                    },
                    {
                        id: 'sync-horizontal-layout',
                        text: 'Drive Sync redesigned with horizontal split-panel layout',
                        elementSelector: '#syncDrivesBtn'
                    },
                    {
                        id: 'sync-stats-visible',
                        text: 'Comparison statistics now visible by default after comparing drives',
                        elementSelector: '#syncDrivesBtn'
                    },
                    {
                        id: 'sync-preset-chips',
                        text: 'Quick-load presets shown as chips for faster access',
                        elementSelector: '#syncDrivesBtn'
                    }
                ]
            },
            {
                version: '2025.52.7.6',
                date: '2025-12-28',
                title: 'Phase 7: Multi-Drive, Statistics & Mobile',
                features: [
                    {
                        id: 'multi-drive',
                        text: 'Multi-drive support - Add multiple TeslaCam folders and switch between them',
                        elementSelector: '#addDriveBtn'
                    },
                    {
                        id: 'drive-management',
                        text: 'Drive management modal - Change colors, edit labels, remove drives',
                        elementSelector: '#manageDrivesBtn'
                    },
                    {
                        id: 'location-heatmap',
                        text: 'Location heatmap - Toggle between markers and heatmap view on the map',
                        elementSelector: '.tab-btn[data-tab="map"]'
                    },
                    {
                        id: 'time-of-day-chart',
                        text: 'Sentry triggers by time-of-day chart in statistics',
                        elementSelector: '#statsBtn'
                    },
                    {
                        id: 'weekly-trends',
                        text: 'Weekly/monthly trends chart with toggle',
                        elementSelector: '#statsBtn'
                    },
                    {
                        id: 'stats-export',
                        text: 'Export statistics as JSON or CSV',
                        elementSelector: '#statsBtn'
                    },
                    {
                        id: 'mobile-fullscreen',
                        text: 'Mobile fullscreen video mode with swipe gestures'
                    },
                    {
                        id: 'orientation-lock',
                        text: 'Orientation lock setting - Lock landscape during playback',
                        elementSelector: '#settingsBtn'
                    }
                ]
            },
            {
                version: '2025.52.7.5',
                date: '2025-12-28',
                title: 'Export Improvements & UX Polish',
                features: [
                    {
                        id: 'export-layout-match',
                        text: 'Export now matches the exact layout shown in the preview',
                        elementSelector: '#exportDropdownBtn'
                    },
                    {
                        id: 'single-export-overlay',
                        text: 'Single camera export uses same overlay format as grid layouts'
                    },
                    {
                        id: 'snap-toggle',
                        text: 'Snap toggle in Layout Editor toolbar - works for dragging and resizing',
                        elementSelector: '#layoutSelect'
                    },
                    {
                        id: 'timeline-markers',
                        text: 'IN/OUT markers now extend past timeline edge for visibility'
                    }
                ]
            },
            {
                version: '2025.52.7.4',
                date: '2025-12-28',
                title: 'Layout Editor Snap Guides',
                features: [
                    {
                        id: 'snap-guides',
                        text: 'Visual snap guides when aligning cameras in the Layout Editor',
                        elementSelector: '#layoutSelect'
                    }
                ]
            },
            {
                version: '2025.52.7.3',
                date: '2025-12-28',
                title: 'Mobile Support & Statistics',
                features: [
                    {
                        id: 'mobile-support',
                        text: 'Mobile-friendly responsive design with sidebar drawer'
                    },
                    {
                        id: 'touch-optimization',
                        text: 'Touch-optimized controls with larger tap targets'
                    },
                    {
                        id: 'statistics-dashboard',
                        text: 'Statistics dashboard showing event breakdowns, recording time, and top locations',
                        elementSelector: '#statsBtn'
                    }
                ]
            },
            {
                version: '2025.52.7.2',
                date: '2025-12-28',
                title: 'Theme System & Single Camera Export',
                features: [
                    {
                        id: 'theme-system',
                        text: 'Theme options - Dark, Light, Midnight, and Tesla Red themes',
                        elementSelector: '#setting-theme'
                    },
                    {
                        id: 'single-camera-export',
                        text: 'Export individual camera angles - Front, Rear, Left, or Right only',
                        elementSelector: '#exportDropdownBtn'
                    }
                ]
            },
            {
                version: '2025.52.7.1',
                date: '2025-12-28',
                title: 'Custom Layout Editor & Version Tracking',
                features: [
                    {
                        id: 'layout-editor',
                        text: 'Visual Layout Editor - Design custom camera arrangements with drag & drop',
                        elementSelector: '#layoutSelect'
                    },
                    {
                        id: 'layout-import-export',
                        text: 'Import/Export layouts as JSON files to share with others',
                        elementSelector: '#layoutSelect'
                    },
                    {
                        id: 'layout-cropping',
                        text: 'Camera cropping - Mask edges without distorting aspect ratio',
                        elementSelector: '#layoutSelect'
                    },
                    {
                        id: 'version-tracking',
                        text: 'Version tracking with "What\'s New" indicators'
                    }
                ]
            },
            {
                version: '2025.52.6.1',
                date: '2025-12-27',
                title: 'Multi-Layout View System',
                features: [
                    { id: 'layouts-5-presets', text: '5 different camera viewing layouts' },
                    { id: 'layout-keyboard', text: 'Press L to cycle through layouts' }
                ]
            },
            {
                version: '2025.52.5.1',
                date: '2025-12-26',
                title: 'Export & Sharing',
                features: [
                    { id: 'screenshot-capture', text: 'Screenshot capture with composite view' },
                    { id: 'video-export', text: 'Video export with real-time rendering' },
                    { id: 'clip-marking', text: 'IN/OUT point marking for clip selection' }
                ]
            },
            {
                version: '2025.52.5.0',
                date: '2025-12-26',
                title: 'Event Analysis',
                features: [
                    { id: 'event-filtering', text: 'Filter events by type, date, and search' },
                    { id: 'interactive-map', text: 'Interactive map showing event locations' }
                ]
            }
        ];

        this.state = this.loadState();
        this.modal = null;
        this.indicators = new Map(); // Track indicator elements

        // Check for version upgrade
        this.checkVersionUpgrade();
    }

    /**
     * Load state from localStorage
     */
    loadState() {
        const defaults = {
            lastSeenVersion: null,
            seenFeatures: [], // IDs of features user has interacted with
            showWhatsNew: true, // User preference
            firstVisit: true
        };

        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) {
                return { ...defaults, ...JSON.parse(stored) };
            }
        } catch (e) {
            console.warn('Failed to load version state:', e);
        }
        return defaults;
    }

    /**
     * Save state to localStorage
     */
    saveState() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.state));
        } catch (e) {
            console.warn('Failed to save version state:', e);
        }
    }

    /**
     * Check if this is a version upgrade
     */
    checkVersionUpgrade() {
        const lastVersion = this.state.lastSeenVersion;

        if (!lastVersion) {
            // First visit ever
            this.state.firstVisit = true;
            this.state.lastSeenVersion = this.currentVersion;
            // Mark all features as seen for first-time users (don't overwhelm them)
            this.markAllFeaturesSeen();
            this.saveState();
            return;
        }

        if (this.compareVersions(this.currentVersion, lastVersion) > 0) {
            // New version detected!
            console.log(`Version upgrade detected: ${lastVersion} -> ${this.currentVersion}`);
            this.state.firstVisit = false;
            this.state.lastSeenVersion = this.currentVersion;
            this.saveState();

            // Show changelog modal after a brief delay
            if (this.state.showWhatsNew) {
                setTimeout(() => this.showUpgradeNotification(), 1500);
            }
        }
    }

    /**
     * Compare two version strings (returns 1 if a > b, -1 if a < b, 0 if equal)
     */
    compareVersions(a, b) {
        const partsA = a.split('.').map(Number);
        const partsB = b.split('.').map(Number);

        for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
            const numA = partsA[i] || 0;
            const numB = partsB[i] || 0;
            if (numA > numB) return 1;
            if (numA < numB) return -1;
        }
        return 0;
    }

    /**
     * Get new features since last seen version
     */
    getNewFeatures() {
        const lastVersion = this.state.lastSeenVersion;
        const newFeatures = [];

        for (const entry of this.changelog) {
            // Include features from versions newer than lastSeenVersion
            // or features that haven't been marked as seen
            for (const feature of entry.features) {
                if (!this.state.seenFeatures.includes(feature.id)) {
                    newFeatures.push({
                        ...feature,
                        version: entry.version,
                        versionTitle: entry.title
                    });
                }
            }
        }

        return newFeatures;
    }

    /**
     * Check if a specific feature is new (not yet seen)
     */
    isFeatureNew(featureId) {
        if (!this.state.showWhatsNew) return false;
        return !this.state.seenFeatures.includes(featureId);
    }

    /**
     * Mark a feature as seen
     */
    markFeatureSeen(featureId) {
        if (!this.state.seenFeatures.includes(featureId)) {
            this.state.seenFeatures.push(featureId);
            this.saveState();

            // Remove the indicator if it exists
            this.removeIndicator(featureId);
        }
    }

    /**
     * Mark all features as seen
     */
    markAllFeaturesSeen() {
        for (const entry of this.changelog) {
            for (const feature of entry.features) {
                if (!this.state.seenFeatures.includes(feature.id)) {
                    this.state.seenFeatures.push(feature.id);
                }
            }
        }
        this.saveState();
        this.removeAllIndicators();
    }

    /**
     * Set whether to show what's new indicators
     */
    setShowWhatsNew(show) {
        this.state.showWhatsNew = show;
        this.saveState();

        if (!show) {
            this.removeAllIndicators();
        } else {
            this.addIndicators();
        }
    }

    /**
     * Add blue dot indicator to an element
     * @param {HTMLElement} element - Element to add indicator to
     * @param {string} featureId - Feature ID for tracking
     * @param {string} featureText - Feature description for tooltip
     */
    addIndicator(element, featureId, featureText = 'New feature!') {
        if (!element || !this.isFeatureNew(featureId)) return;
        if (this.indicators.has(featureId)) return; // Already added

        // Create indicator dot with tooltip
        const dot = document.createElement('span');
        dot.className = 'whats-new-dot';
        dot.dataset.featureId = featureId;
        dot.dataset.tooltip = featureText;

        // Position relative to the element itself (not parent)
        if (getComputedStyle(element).position === 'static') {
            element.style.position = 'relative';
        }

        // Insert dot directly into the element
        element.appendChild(dot);

        // Adaptive tooltip positioning
        const rect = element.getBoundingClientRect();
        // Show tooltip on right for left-edge elements
        if (rect.left < 350) {
            dot.classList.add('tooltip-right');
        }
        // Show tooltip below for top-edge elements
        if (rect.top < 120) {
            dot.classList.add('tooltip-below');
        }
        // Show tooltip above for bottom-edge elements
        else if (rect.bottom > window.innerHeight - 150) {
            dot.classList.add('tooltip-above');
        }
        this.indicators.set(featureId, dot);

        // Add click listener to element to mark as seen
        const markSeen = () => {
            this.markFeatureSeen(featureId);
            element.removeEventListener('click', markSeen);
        };
        element.addEventListener('click', markSeen);
    }

    /**
     * Remove indicator for a feature
     */
    removeIndicator(featureId) {
        const dot = this.indicators.get(featureId);
        if (dot && dot.parentElement) {
            dot.parentElement.removeChild(dot);
        }
        this.indicators.delete(featureId);
    }

    /**
     * Remove all indicators
     */
    removeAllIndicators() {
        for (const [featureId, dot] of this.indicators) {
            if (dot && dot.parentElement) {
                dot.parentElement.removeChild(dot);
            }
        }
        this.indicators.clear();
    }

    /**
     * Add indicators to elements with new features
     */
    addIndicators() {
        if (!this.state.showWhatsNew) return;

        const newFeatures = this.getNewFeatures();
        for (const feature of newFeatures) {
            if (feature.elementSelector) {
                const element = document.querySelector(feature.elementSelector);
                if (element) {
                    this.addIndicator(element, feature.id, feature.text);
                }
            }
        }
    }

    /**
     * Show upgrade notification modal
     */
    showUpgradeNotification() {
        const newFeatures = this.getNewFeatures();
        if (newFeatures.length === 0) return;

        // Get the latest version's features
        const latestEntry = this.changelog[0];
        this.showChangelogModal(latestEntry.version);
    }

    /**
     * Show changelog modal (can show specific version or all)
     */
    showChangelogModal(specificVersion = null) {
        // Remove existing modal
        if (this.modal) {
            this.modal.remove();
        }

        const entries = specificVersion
            ? this.changelog.filter(e => e.version === specificVersion)
            : this.changelog;

        const isUpgrade = specificVersion && this.changelog[0].version === specificVersion;

        this.modal = document.createElement('div');
        this.modal.className = 'changelog-modal';
        this.modal.innerHTML = `
            <div class="changelog-content">
                <div class="changelog-header">
                    <h2>${isUpgrade ? "What's New!" : 'Changelog'}</h2>
                    <button class="changelog-close" title="Close">&times;</button>
                </div>
                <div class="changelog-body">
                    ${entries.map(entry => `
                        <div class="changelog-version ${this.isVersionNew(entry.version) ? 'new' : ''}">
                            <div class="changelog-version-header">
                                <span class="version-number">v${entry.version}</span>
                                <span class="version-date">${entry.date}</span>
                                ${this.isVersionNew(entry.version) ? '<span class="new-badge">NEW</span>' : ''}
                            </div>
                            <h3 class="version-title">${entry.title}</h3>
                            <ul class="feature-list">
                                ${entry.features.map(f => `
                                    <li class="${this.isFeatureNew(f.id) ? 'new' : ''}">${f.text}</li>
                                `).join('')}
                            </ul>
                        </div>
                    `).join('')}
                </div>
                <div class="changelog-footer">
                    ${isUpgrade ? `
                        <label class="dont-show-again">
                            <input type="checkbox" id="dontShowWhatsNew">
                            <span>Don't show "What's New" notifications</span>
                        </label>
                    ` : ''}
                    <button class="changelog-dismiss">Got it!</button>
                </div>
            </div>
        `;

        document.body.appendChild(this.modal);

        // Event listeners
        const closeBtn = this.modal.querySelector('.changelog-close');
        const dismissBtn = this.modal.querySelector('.changelog-dismiss');
        const dontShowCheckbox = this.modal.querySelector('#dontShowWhatsNew');

        const closeModal = () => {
            if (dontShowCheckbox && dontShowCheckbox.checked) {
                this.setShowWhatsNew(false);
            }

            // Mark shown features as seen when closing
            if (specificVersion) {
                const entry = this.changelog.find(e => e.version === specificVersion);
                if (entry) {
                    for (const feature of entry.features) {
                        this.markFeatureSeen(feature.id);
                    }
                }
            } else {
                // If showing all, mark all features as seen
                for (const entry of this.changelog) {
                    for (const feature of entry.features) {
                        this.markFeatureSeen(feature.id);
                    }
                }
            }

            // Remove "has-updates" indicator from version tag
            const tagline = document.querySelector('.brand-tagline');
            if (tagline) {
                tagline.classList.remove('has-updates');
            }

            this.modal.remove();
            this.modal = null;
        };

        closeBtn.addEventListener('click', closeModal);
        dismissBtn.addEventListener('click', closeModal);
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) closeModal();
        });
    }

    /**
     * Check if a version is new (has unseen features)
     */
    isVersionNew(version) {
        const entry = this.changelog.find(e => e.version === version);
        if (!entry) return false;
        return entry.features.some(f => !this.state.seenFeatures.includes(f.id));
    }

    /**
     * Get the current version string
     */
    getVersion() {
        return this.currentVersion;
    }

    /**
     * Get version display string (e.g., "v0.8.0")
     */
    getVersionDisplay() {
        return `v${this.currentVersion}`;
    }

    /**
     * Initialize version display in header
     */
    initVersionDisplay() {
        const tagline = document.querySelector('.brand-tagline');
        if (tagline) {
            // Set version text immediately
            const versionText = this.getVersionDisplay();
            tagline.textContent = versionText;
            tagline.classList.add('version-tag');
            tagline.title = 'Click to view changelog';
            tagline.style.cursor = 'pointer';

            tagline.addEventListener('click', () => {
                this.showChangelogModal();
            });

            // Add new indicator if there are new features
            if (this.getNewFeatures().length > 0 && this.state.showWhatsNew) {
                tagline.classList.add('has-updates');
            }

            console.log('[VersionManager] Version display initialized:', versionText);
        } else {
            console.warn('[VersionManager] Could not find .brand-tagline element');
        }

        // Add indicators to other elements after DOM is ready
        setTimeout(() => this.addIndicators(), 500);

        // Check for remote updates (with cooldown)
        this.checkForRemoteUpdate();
    }

    /**
     * Check if enough time has passed since last update check
     */
    shouldCheckForUpdate() {
        try {
            const lastCheck = localStorage.getItem(this.UPDATE_CHECK_KEY);
            if (!lastCheck) return true;

            const elapsed = Date.now() - parseInt(lastCheck, 10);
            return elapsed > this.UPDATE_CHECK_INTERVAL;
        } catch (e) {
            return true;
        }
    }

    /**
     * Record that we just checked for updates
     */
    recordUpdateCheck() {
        try {
            localStorage.setItem(this.UPDATE_CHECK_KEY, Date.now().toString());
        } catch (e) {
            // Ignore storage errors
        }
    }

    /**
     * Check for updates from remote server
     * Works for both online users (stale cache) and offline/local users
     */
    async checkForRemoteUpdate() {
        // Skip if we checked recently
        if (!this.shouldCheckForUpdate()) {
            console.log('[VersionManager] Skipping update check (checked recently)');
            return;
        }

        try {
            // Add cache-busting timestamp to avoid cached response
            const url = `${this.remoteVersionUrl}?t=${Date.now()}`;

            const response = await fetch(url, {
                method: 'GET',
                cache: 'no-store', // Force bypass cache
                headers: {
                    'Cache-Control': 'no-cache'
                }
            });

            if (!response.ok) {
                console.log('[VersionManager] Could not reach update server');
                return;
            }

            const remoteVersion = await response.json();
            this.recordUpdateCheck();

            console.log(`[VersionManager] Local: ${this.currentVersion}, Remote: ${remoteVersion.version}`);

            // Compare versions
            if (this.compareVersions(remoteVersion.version, this.currentVersion) > 0) {
                // Remote version is newer
                console.log('[VersionManager] Update available!');
                this.showUpdateToast(remoteVersion);
            } else {
                console.log('[VersionManager] Already up to date');
            }
        } catch (error) {
            // Network error - user is offline or server unreachable
            console.log('[VersionManager] Update check failed (offline?):', error.message);
        }
    }

    /**
     * Show toast notification for available update
     */
    showUpdateToast(remoteVersion) {
        // Don't show duplicate toasts
        if (document.querySelector('.update-toast')) return;

        const toast = document.createElement('div');
        toast.className = 'update-toast';
        toast.innerHTML = `
            <div class="update-toast-content">
                <div class="update-toast-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                </div>
                <div class="update-toast-text">
                    <strong>Update Available</strong>
                    <span>Version ${remoteVersion.version} is ready</span>
                </div>
                <button class="update-toast-btn" title="Refresh to update">
                    Refresh
                </button>
                <button class="update-toast-close" title="Dismiss">&times;</button>
            </div>
        `;

        document.body.appendChild(toast);

        // Animate in
        requestAnimationFrame(() => {
            toast.classList.add('visible');
        });

        // Event listeners
        const refreshBtn = toast.querySelector('.update-toast-btn');
        const closeBtn = toast.querySelector('.update-toast-close');

        refreshBtn.addEventListener('click', () => {
            // Force hard reload to bypass cache
            window.location.reload(true);
        });

        closeBtn.addEventListener('click', () => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 300);
        });

        // Auto-dismiss after 30 seconds
        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.remove('visible');
                setTimeout(() => toast.remove(), 300);
            }
        }, 30000);
    }

    /**
     * Force an update check (for manual triggering from settings)
     */
    async forceUpdateCheck() {
        // Clear the cooldown
        localStorage.removeItem(this.UPDATE_CHECK_KEY);
        await this.checkForRemoteUpdate();
    }
}

// Export for use
window.VersionManager = VersionManager;
