/**
 * VersionManager - Tracks app version, changelog, and "what's new" indicators
 * Shows blue dots on features that are new since the user's last visit
 *
 * Version Format: YYYY.WW.D.R (Tesla-style)
 *   YYYY = Year
 *   WW = ISO Week number (01-53)
 *   D = Day of week (1=Mon, 7=Sun)
 *   R = Release number for that day
 */
class VersionManager {
    constructor() {
        this.STORAGE_KEY = 'teslacamviewer_version_state';

        // Current version - UPDATE THIS when releasing new features
        // Format: Year.Week.DayOfWeek.Release
        this.currentVersion = '2026.01.1.2';

        // Changelog with feature identifiers for "what's new" dots
        // Each entry has: version, date, title, and features array
        // Features have: id (for tracking seen state), text, elementSelector (optional)
        this.changelog = [
            {
                version: '2026.01.1.2',
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
                version: '2026.01.1.1',
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
     */
    addIndicator(element, featureId) {
        if (!element || !this.isFeatureNew(featureId)) return;
        if (this.indicators.has(featureId)) return; // Already added

        // Create indicator dot
        const dot = document.createElement('span');
        dot.className = 'whats-new-dot';
        dot.dataset.featureId = featureId;
        dot.title = 'New feature!';

        // Position relative to parent
        const parent = element.parentElement || element;
        if (getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }

        // Insert dot
        parent.appendChild(dot);
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
                    this.addIndicator(element, feature.id);
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
    }
}

// Export for use
window.VersionManager = VersionManager;
