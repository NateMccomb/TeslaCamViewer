/**
 * Main Application Controller
 * Build: NMC-2024
 */

class TeslaCamViewerApp {
    constructor() {
        // Check for other instances using BroadcastChannel
        this._initInstanceDetection();
        // Pause what's behind a full-screen modal (its blurred backdrop flickered on some GPUs)
        this._watchModalBackdrops();
        // Opened from the folder (file://): say which features the browser blocks - rev:49f
        setTimeout(() => this._showFileProtocolNotice(), 2847);

        // Initialize components - tcv.0x4E4D43
        this.folderParser = new FolderParser();
        this.folderManager = new FolderManager();

        // Filter and map components
        this.eventFilter = new EventFilter();
        this.filterPanel = new FilterPanel(
            document.getElementById('filterPanel'),
            this.eventFilter,
            () => this.applyFilters()
        );
        this.mapView = new MapView(
            document.getElementById('map'),
            (event) => this.onEventSelected(event)
        );

        this.eventBrowser = new EventBrowser(
            document.getElementById('eventList'),
            (event) => this.onEventSelected(event)
        );
        this.videoPlayer = new VideoPlayer();

        // Connect eventBrowser to videoPlayer for preview pause/resume
        this.eventBrowser.setVideoPlayer(this.videoPlayer);
        this.timeline = new Timeline(
            document.getElementById('timeline'),
            (time) => this.onTimelineSeeked(time),
            () => this.eventBrowser.refreshBookmarkIndicators()
        );
        this.syncController = new SyncController(this.videoPlayer.videos);
        this.layoutManager = new LayoutManager();
        this.layoutEditor = new LayoutEditor(this.layoutManager);
        this.screenshotCapture = new ScreenshotCapture(this.videoPlayer);
        this.videoEnhancer = new VideoEnhancer();
        this.telemetryOverlay = new TelemetryOverlay(this.videoPlayer);
        this.telemetryOverlay.initLayoutCallback(this.layoutManager); // Wire up layout change notifications
        this.miniMapOverlay = new MiniMapOverlay(this.videoPlayer);
        this.miniMapOverlay.initLayoutCallback && this.miniMapOverlay.initLayoutCallback(this.layoutManager);
        this.elevationOverlay = new ElevationOverlay(this.videoPlayer);
        // Wire up elevation overlay callbacks
        this.elevationOverlay.getEventTime = () => this.getAbsoluteEventTime(this.videoPlayer.getCurrentTime());
        this.elevationOverlay.onSeek = (time) => this.videoPlayer.seekToEventTime(time);
        this.telemetryGraphs = new TelemetryGraphs(this.videoPlayer);
        // Wire up telemetry graphs callbacks
        this.telemetryGraphs.getEventTime = () => this.getAbsoluteEventTime(this.videoPlayer.getCurrentTime());
        this.telemetryGraphs.onSeek = (time) => this.videoPlayer.seekToEventTime(time);
        this.telemetryGraphs.getSpeedLimit = () => this.getCurrentSpeedLimit();
        this.telemetryGraphs.getSeiData = () => this.telemetryOverlay?.clipSeiData || new Map();
        this.telemetryGraphs.getEventTimestamp = () => this.currentEvent?.timestamp || null;

        // Smart Incident Detection modules
        this.incidentSlowMo = new IncidentSlowMo(this.videoPlayer);
        this.incidentSlowMo.setTelemetryGraphs(this.telemetryGraphs);

        this.collisionReconstruction = new CollisionReconstruction(this.videoPlayer);
        this.collisionReconstruction.setTelemetryOverlay(this.telemetryOverlay);

        // Speed limit display element
        this.speedLimitDisplay = document.getElementById('speedLimitDisplay');
        this.currentSpeedLimitData = null;
        this.lastSpeedLimitGps = null;
        this._speedLimitShowsUnavailable = false;
        window.addEventListener('tcv-speedlimit-status', (e) => this._onSpeedLimitStatus(e.detail));
        this.streetViewOverlay = new StreetViewOverlay(this.videoPlayer);

        // Wire up visibility change callbacks for all overlays
        // This ensures button states AND settings update when overlays are closed via their X buttons
        this.telemetryOverlay.onVisibilityChange = (visible) => {
            this.settingsManager.set('telemetryOverlayEnabled', visible);
            this._updateOverlayButtonStates();
        };
        this.miniMapOverlay.onVisibilityChange = (visible) => {
            this.settingsManager.set('miniMapEnabled', visible);
            this._updateOverlayButtonStates();
        };
        this.telemetryGraphs.onVisibilityChange = (visible) => {
            this.settingsManager.set('telemetryGraphsEnabled', visible);
            this._updateOverlayButtonStates();
        };
        this.streetViewOverlay.onVisibilityChange = (visible) => {
            this.settingsManager.set('streetViewEnabled', visible);
            this._updateOverlayButtonStates();
        };

        this.plateBlur = new PlateBlur();
        this.videoExport = new VideoExport(this.videoPlayer, this.layoutManager);
        this.clipMarking = new ClipMarking(this.timeline, this.videoPlayer);
        this.insuranceReport = new InsuranceReport(this.videoPlayer, this.screenshotCapture);

        // Settings, Help, Quick Start, Version, Statistics, and Notes
        this.settingsManager = new SettingsManager();
        this.sessionManager = new SessionManager();
        this.versionManager = new VersionManager();
        this.statisticsManager = new StatisticsManager();
        this.notesManager = new NotesManager();
        this.helpModal = new HelpModal();
        this.quickStartGuide = new QuickStartGuide();

        // SEI Diagnostics — future-proofing against Tesla firmware schema changes.
        // Persists unknown-field observations across sessions, surfaces via Settings.
        if (window.SeiDiagnostics && window.seiExtractor) {
            window.seiDiagnostics = new window.SeiDiagnostics(window.seiExtractor);
            window.seiDiagnostics.init();
        }

        // Scrub-preview thumbnail cache — generates tiny JPEGs of each event
        // in the background so hovering the timeline shows a frame preview.
        if (window.ThumbnailCache) {
            this.thumbnailCache = new window.ThumbnailCache();
        }

        // Command palette (Ctrl+K / Cmd+K) — searchable action launcher.
        if (window.CommandPalette) {
            this.commandPalette = new window.CommandPalette(this);
            this._registerCommandPaletteCommands();
            this.commandPalette.setupGlobalShortcut();
        }

        // File system observer — auto-refresh event list when drive contents
        // change. Feature-detects; no-ops on browsers without the API.
        if (window.FileSystemObserverManager) {
            this.fsObserver = new window.FileSystemObserverManager();
            this.fsObserver.onChange = (driveId) => this._onDriveContentsChanged(driveId);
        }

        // Wire up cross-references for backup system
        this.notesManager.setBookmarksGetter((eventKey) => {
            return this.timeline.getAllSavedBookmarks()[eventKey] || [];
        });
        this.timeline.setNotesGetter((eventKey) => {
            return this.notesManager.getNotes(eventKey);
        });

        // Drive sync
        this.driveSync = new DriveSync(this.folderManager, this.notesManager);
        this.driveSyncUI = new DriveSyncUI(this.driveSync, this.folderManager);

        // Link settings to versionManager
        this.versionManager.setShowWhatsNew(this.settingsManager.get('showWhatsNew'));
        this.settingsManager.onChange((settings) => {
            if (this.versionManager) {
                this.versionManager.setShowWhatsNew(settings.showWhatsNew);
            }
        });

        // Settings, Help, Stats, Session buttons
        this.settingsBtn = document.getElementById('settingsBtn');
        this.helpBtn = document.getElementById('helpBtn');
        this.statsBtn = document.getElementById('statsBtn');
        this.sessionBtn = document.getElementById('sessionBtn');

        // UI elements
        this.selectFolderBtn = document.getElementById('selectFolderBtn');
        this.playPauseBtn = document.getElementById('playPauseBtn');
        this.frameBackBtn = document.getElementById('frameBackBtn');
        this.frameForwardBtn = document.getElementById('frameForwardBtn');
        this.prevClipBtn = document.getElementById('prevClipBtn');
        this.nextClipBtn = document.getElementById('nextClipBtn');
        this.prevEventBtn = document.getElementById('prevEventBtn');
        this.nextEventBtn = document.getElementById('nextEventBtn');
        this.screenshotBtn = document.getElementById('screenshotBtn');
        this.pipBtn = document.getElementById('pipBtn');
        this.enhanceBtn = document.getElementById('enhanceBtn');
        this.enhanceRegionBtn = document.getElementById('enhanceRegionBtn');
        this.notesBtn = document.getElementById('notesBtn');
        this.markInBtn = document.getElementById('markInBtn');
        this.markOutBtn = document.getElementById('markOutBtn');
        this.clearMarksBtn = document.getElementById('clearMarksBtn');
        this.exportBtn = document.getElementById('exportBtn');
        this.exportDropdownBtn = document.getElementById('exportDropdownBtn');
        this.exportDropdown = document.getElementById('exportDropdown');
        this.prevBookmarkBtn = document.getElementById('prevBookmarkBtn');
        this.addBookmarkBtn = document.getElementById('addBookmarkBtn');
        this.nextBookmarkBtn = document.getElementById('nextBookmarkBtn');
        this.bookmarksListBtn = document.getElementById('bookmarksListBtn');
        this.bookmarksDropdown = document.getElementById('bookmarksDropdown');
        this.bookmarksList = document.getElementById('bookmarksList');
        this.clearAllBookmarksBtn = document.getElementById('clearAllBookmarksBtn');
        this.zoomOutBtn = document.getElementById('zoomOutBtn');
        this.zoomInBtn = document.getElementById('zoomInBtn');
        this.zoomResetBtn = document.getElementById('zoomResetBtn');
        this.speedSelect = document.getElementById('speedSelect');
        this.loopCheckbox = document.getElementById('loopCheckbox');
        this.loopBtn = document.getElementById('loopBtn');
        this.layoutSelect = document.getElementById('layoutSelect');
        this.focusCameraSelect = document.getElementById('focusCameraSelect');

        // Overlay toggle buttons
        this.toggleHudBtn = document.getElementById('toggleHudBtn');
        this.toggleMiniMapBtn = document.getElementById('toggleMiniMapBtn');
        this.toggleGraphsBtn = document.getElementById('toggleGraphsBtn');
        this.toggleStreetViewBtn = document.getElementById('toggleStreetViewBtn');
        this.toggleSlowMoBtn = document.getElementById('toggleSlowMoBtn');
        this.toggleBirdsEyeBtn = document.getElementById('toggleBirdsEyeBtn');
        this.loadingOverlay = document.getElementById('loadingOverlay');
        this.loadingText = document.getElementById('loadingText');

        // Buffering indicator elements
        this.bufferingIndicator = document.getElementById('bufferingIndicator');
        this.bufferingLabel = document.getElementById('bufferingLabel');
        this.bufferingSpeed = document.getElementById('bufferingSpeed');
        this.bufferHealthFill = document.getElementById('bufferHealthFill');

        // Mobile menu elements
        this.menuToggleBtn = document.getElementById('menuToggleBtn');
        this.sidebar = document.getElementById('sidebar');
        this.sidebarOverlay = document.getElementById('sidebarOverlay');

        // Mobile more menu elements
        this.mobileMoreBtn = document.getElementById('mobileMoreBtn');
        this.mobileMoreMenu = document.getElementById('mobileMoreMenu');
        this.mobileHudStatus = document.getElementById('mobileHudStatus');
        this.mobileMiniMapStatus = document.getElementById('mobileMiniMapStatus');
        this.mobileLayoutSelect = document.getElementById('mobileLayoutSelect');
        this.bsMoreBtn = document.getElementById('bsMoreBtn');
        this.bsMoreContainer = document.querySelector('.bs-more-container');

        // Drive selector elements (multi-drive support)
        this.driveSelector = document.getElementById('driveSelector');
        this.driveSelect = document.getElementById('driveSelect');
        this.addDriveBtn = document.getElementById('addDriveBtn');
        this.manageDrivesBtn = document.getElementById('manageDrivesBtn');
        this.syncDrivesBtn = document.getElementById('syncDrivesBtn');

        // Mobile fullscreen elements
        this.mobileFullscreenBtn = document.getElementById('mobileFullscreenBtn');
        this.mobileFullscreenOverlay = document.getElementById('mobileFullscreenOverlay');
        this.fullscreenPlayBtn = document.getElementById('fullscreenPlayBtn');
        this.exitFullscreenBtn = document.getElementById('exitFullscreenBtn');
        this.isMobileFullscreen = false;
        this.fullscreenControlsTimeout = null;

        // Track current event index for navigation
        this.currentEventIndex = -1;
        this.allEvents = [];

        // Frame stepping state
        this.frameStepInterval = null;
        this.frameStepRate = 100; // ms between steps when holding

        // Event info elements
        this.eventDateElement = document.getElementById('eventDate');
        this.eventLocationElement = document.getElementById('eventLocation');
        this.eventReasonElement = document.getElementById('eventReason');
        this.eventWeatherElement = document.getElementById('eventWeather');
        this.streetViewBtn = document.getElementById('streetViewBtn');

        // Current GPS for Street View
        this.currentGpsLat = null;
        this.currentGpsLng = null;
        this.currentGpsHeading = 0;

        // State
        this.currentEvent = null;
        this.updateTimelineInterval = null;

        this.setupEventListeners();
        this.checkBrowserSupport();

        // Set layout select to match saved preference
        this.layoutSelect.value = this.layoutManager.getCurrentLayout();

        // Apply user settings
        this.applyUserSettings();

        // Try to restore last folder if setting is enabled
        this.tryRestoreLastFolder();

        // Show quick start guide on first run
        this.quickStartGuide.showIfFirstRun();

        // Initialize version display
        this.versionManager.initVersionDisplay();
    }

    /**
     * Try to restore drives from IndexedDB if setting is enabled
     */
    async tryRestoreLastFolder() {
        if (!this.settingsManager.get('rememberLastFolder')) {
            return;
        }

        this.showLoading('Restoring saved drives...');

        try {
            // Load saved drives from IndexedDB
            await this.folderManager.loadDrives();
            const drives = this.folderManager.getDrives();

            if (drives.length === 0) {
                // Try legacy single-folder restore
                const restored = await this.folderParser.loadSavedFolder();
                if (restored) {
                    this.loadingText.textContent = 'Migrating to new drive system...';
                    const drive = await this.folderManager.addDrive(this.folderParser.rootHandle);
                    this.folderParser.setDriveContext(drive.id, drive.label, drive.color);
                    this.folderParser.setProgressCallback((message, count) => {
                        this.loadingText.textContent = `Migrating: ${message} (${count} events)`;
                    });
                    const events = await this.folderParser.parseFolder();
                    this.folderParser.setProgressCallback(null);
                    drive.events = events;
                    this.allEvents = events;
                    this.statisticsManager.setEvents(events);
                    await this.registerEventsAndLoadBackups(events);
                    this.applyFilters();
                    this.updateDriveSelector(this.folderManager.getDrives());
                    this._syncFileSystemObservers(this.folderManager.getDrives());
                    this.selectFolderBtn.classList.add('hidden');
                    console.log(`Migrated ${events.length} events to new drive system`);
                }
                this.hideLoading();
                return;
            }

            // Restore each drive - request permissions and parse
            let allEvents = [];
            let successCount = 0;

            for (const drive of drives) {
                if (!drive.handle) {
                    console.warn(`Drive ${drive.label} has no handle, skipping`);
                    continue;
                }

                // Skip archive drives on startup
                if (drive.isArchive) {
                    console.log(`Skipping archive drive: ${drive.label}`);
                    continue;
                }

                this.loadingText.textContent = `Restoring ${drive.label}...`;

                try {
                    // Request permission for the stored handle
                    const permission = await drive.handle.requestPermission({ mode: 'read' });
                    if (permission !== 'granted') {
                        console.warn(`Permission denied for ${drive.label}`);
                        continue;
                    }

                    // Parse events from this drive
                    this.folderParser.setDriveContext(drive.id, drive.label, drive.color);
                    this.folderParser.rootHandle = drive.handle;
                    this.folderParser.setProgressCallback((message, count) => {
                        this.loadingText.textContent = `${drive.label}: ${message} (${count} events)`;
                    });
                    let events = await this.folderParser.parseFolder();
                    this.folderParser.setProgressCallback(null);

                    // Apply date filter if set
                    const cutoff = this.folderManager.getDateFilterCutoff(drive.dateFilter);
                    if (cutoff) {
                        const beforeCount = events.length;
                        events = events.filter(event => new Date(event.timestamp) >= cutoff);
                        console.log(`Date filter (${drive.dateFilter}): ${beforeCount} → ${events.length} events`);
                    }

                    drive.events = events;
                    allEvents = allEvents.concat(events);
                    successCount++;
                    console.log(`Restored ${events.length} events from ${drive.label}`);
                } catch (error) {
                    console.warn(`Failed to restore drive ${drive.label}:`, error);
                }
            }

            if (successCount > 0) {
                this.allEvents = allEvents;
                this.statisticsManager.setEvents(allEvents);
                await this.registerEventsAndLoadBackups(allEvents);
                this.applyFilters();
                this.updateDriveSelector(this.folderManager.getDrives());
                // IndexedDB drive restore bypasses onDrivesChanged, so the
                // file-system observer never gets attached on page reload
                // unless we do it explicitly here.
                this._syncFileSystemObservers(this.folderManager.getDrives());
                this.selectFolderBtn.classList.add('hidden');
                console.log(`Restored ${allEvents.length} total events from ${successCount} drives`);

                // Show diagnostic notification if there were issues
                this.showParseDiagnostics();
            }
        } catch (error) {
            console.warn('Failed to restore drives:', error);
        }

        this.hideLoading();
    }

    /**
     * Apply user settings from settings manager
     */
    applyUserSettings() {
        // Apply default speed
        const defaultSpeed = this.settingsManager.get('defaultSpeed');
        if (defaultSpeed) {
            this.speedSelect.value = defaultSpeed;
        }

        // Apply default layout
        const defaultLayout = this.settingsManager.get('defaultLayout');
        if (defaultLayout) {
            this.layoutManager.setLayout(defaultLayout);
            this.layoutSelect.value = defaultLayout;
        }

        // Apply loop setting
        const loopByDefault = this.settingsManager.get('loopByDefault');
        if (loopByDefault) {
            this.loopCheckbox.checked = true;
        }

        // Apply timeline zoom setting
        const enableTimelineZoom = this.settingsManager.get('enableTimelineZoom');
        this.timeline.setZoomEnabled(enableTimelineZoom);

        // Apply performance settings
        this.applyPerformanceSettings();

        // Apply accessibility settings on load
        this.settingsManager.applyAccessibilitySettings();

        // Apply telemetry overlay settings on load
        if (this.telemetryOverlay) {
            this.telemetryOverlay.setStyle(this.settingsManager.get('telemetryOverlayStyle'));
            this.telemetryOverlay.setUnits(this.settingsManager.get('telemetryOverlayUnits'));
        }

        // Listen for settings changes
        this.settingsManager.onChange(async (settings) => {
            console.log('Settings changed:', settings);
            // Re-apply settings
            this.timeline.setZoomEnabled(settings.enableTimelineZoom);
            this.applyPerformanceSettings();

            // Handle rememberLastFolder toggle
            if (settings.rememberLastFolder && this.folderParser.rootHandle) {
                // Setting enabled and we have a folder - save it
                await this.folderParser.saveFolderHandle();
            } else if (!settings.rememberLastFolder) {
                // Setting disabled - clear saved folder
                await this.folderParser.clearSavedFolder();
            }

            // Apply telemetry overlay settings
            if (this.telemetryOverlay) {
                this.telemetryOverlay.setStyle(settings.telemetryOverlayStyle);
                this.telemetryOverlay.setUnits(settings.telemetryOverlayUnits);
                // Only toggle if state needs to change (avoid infinite loop with onVisibilityChange)
                if (settings.telemetryOverlayEnabled && !this.telemetryOverlay.isVisible && this.telemetryOverlay.hasTelemetryData()) {
                    this.telemetryOverlay.show();
                } else if (!settings.telemetryOverlayEnabled && this.telemetryOverlay.isVisible) {
                    this.telemetryOverlay.hide();
                }
            }

            // Apply mini-map settings
            if (this.miniMapOverlay) {
                // Only toggle if state needs to change (avoid infinite loop with onVisibilityChange)
                if (settings.miniMapEnabled && !this.miniMapOverlay.isVisible && this.telemetryOverlay?.hasTelemetryData()) {
                    this.miniMapOverlay.show();
                } else if (!settings.miniMapEnabled && this.miniMapOverlay.isVisible) {
                    this.miniMapOverlay.hide();
                }
                // Apply dark mode setting
                this.miniMapOverlay.setDarkMode(settings.miniMapDarkMode);
            }
        });
    }

    /**
     * Apply performance settings to video player
     */
    applyPerformanceSettings() {
        const preloadNextClip = this.settingsManager.get('preloadNextClip');
        const memoryOptimization = this.settingsManager.get('memoryOptimization');

        // Store settings for use during playback
        this.performanceSettings = {
            preloadNextClip,
            memoryOptimization
        };

        // Log active settings
        console.log('Performance settings applied:', this.performanceSettings);
    }

    /**
     * Check browser support for required APIs.
     *
     * showDirectoryPicker is gated on a secure context. Chrome makes it
     * `undefined` on insecure origins (http://<lan-ip>, file://) even
     * on browsers that fully support it on HTTPS or localhost. Without
     * differentiating, a user testing the dev build over their LAN gets
     * a misleading "browser doesn't support it" alert when the browser
     * is fine and the URL is the problem.
     */
    checkBrowserSupport() {
        if ('showDirectoryPicker' in window) return;

        if (!window.isSecureContext) {
            alert(
                'The File System Access API is disabled on insecure URLs.\n\n' +
                'You\'re currently on:\n  ' + window.location.origin + '\n\n' +
                'To select a drive, open one of:\n' +
                '  • https://teslacamviewer.com\n' +
                '  • http://localhost (or http://127.0.0.1)\n' +
                '  • An HTTPS URL'
            );
            return;
        }

        alert(
            'Your browser does not support the File System Access API.\n\n' +
            'Please use Chrome, Edge, or another Chromium-based browser.'
        );
    }

    /**
     * Setup UI event listeners
     */
    setupEventListeners() {
        // Folder selection
        this.selectFolderBtn.addEventListener('click', () => this.selectFolder());

        // Sync language selectors when locale changes
        window.addEventListener('localeChanged', (e) => {
            const locale = e.detail.locale;
            // Sync settings language selector (if modal exists)
            const settingsSelect = document.getElementById('setting-language');
            if (settingsSelect) {
                settingsSelect.value = locale;
            }
            // Sync quickstart language selector (if modal exists)
            const quickstartSelect = document.getElementById('quickstartLanguage');
            if (quickstartSelect) {
                quickstartSelect.value = locale;
            }
        });

        // Playback controls - combined play/pause toggle
        this.playPauseBtn.addEventListener('click', () => this.togglePlayback());

        // Frame stepping - single click or hold
        this.frameBackBtn.addEventListener('mousedown', () => this.startFrameStepping(-1));
        this.frameBackBtn.addEventListener('mouseup', () => this.stopFrameStepping());
        this.frameBackBtn.addEventListener('mouseleave', () => this.stopFrameStepping());
        // preventDefault: no compatibility mousedown after the touch, which
        // stepped a second frame per tap (audit 1.17)
        this.frameBackBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this.startFrameStepping(-1); }, { passive: false });
        this.frameBackBtn.addEventListener('touchend', () => this.stopFrameStepping());
        this.frameBackBtn.addEventListener('touchcancel', () => this.stopFrameStepping());

        this.frameForwardBtn.addEventListener('mousedown', () => this.startFrameStepping(1));
        this.frameForwardBtn.addEventListener('mouseup', () => this.stopFrameStepping());
        this.frameForwardBtn.addEventListener('mouseleave', () => this.stopFrameStepping());
        this.frameForwardBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this.startFrameStepping(1); }, { passive: false });
        this.frameForwardBtn.addEventListener('touchend', () => this.stopFrameStepping());
        this.frameForwardBtn.addEventListener('touchcancel', () => this.stopFrameStepping());

        this.prevClipBtn.addEventListener('click', () => this.previousClip());
        this.nextClipBtn.addEventListener('click', () => this.nextClip());

        // Event navigation
        this.prevEventBtn.addEventListener('click', () => this.previousEvent());
        this.nextEventBtn.addEventListener('click', () => this.nextEvent());

        // Screenshot capture
        this.screenshotBtn.addEventListener('click', () => this.captureScreenshot());

        // Picture-in-Picture
        this.pipBtn.addEventListener('click', () => this.togglePictureInPicture());

        // Video Enhancement
        this.enhanceBtn.addEventListener('click', () => this.videoEnhancer.toggle());
        // Initialize enhancement controls in video grid container
        const videoGridContainer = document.querySelector('.video-grid-container');
        if (videoGridContainer) {
            this.videoEnhancer.initialize(videoGridContainer);
        }

        // Enhance Region button
        this.enhanceRegionBtn?.addEventListener('click', () => {
            if (window.plateEnhancer) {
                window.plateEnhancer.startEnhanceRegionMode();
            }
        });

        // Overlay toggle buttons
        this.toggleHudBtn?.addEventListener('click', () => {
            if (this.telemetryOverlay) {
                this.telemetryOverlay.toggle();
                this.settingsManager.set('telemetryOverlayEnabled', this.telemetryOverlay.isVisible);
                this._updateOverlayButtonStates();
            }
        });
        this.toggleMiniMapBtn?.addEventListener('click', () => {
            if (this.miniMapOverlay) {
                this.miniMapOverlay.toggle();
                this._updateOverlayButtonStates();
            }
        });
        // Note: Elevation overlay removed - elevation is now integrated into telemetry graphs
        this.toggleGraphsBtn?.addEventListener('click', () => {
            if (this.telemetryGraphs) {
                this.telemetryGraphs.toggle();
                this.settingsManager.set('telemetryGraphsEnabled', this.telemetryGraphs.isVisible);
                this._updateOverlayButtonStates();
            }
        });
        this.toggleStreetViewBtn?.addEventListener('click', () => {
            if (this.streetViewOverlay) {
                this.streetViewOverlay.toggle();
                this.settingsManager.set('streetViewEnabled', this.streetViewOverlay.isVisible);
                this._updateOverlayButtonStates();
            }
        });

        // Incident Slow-Mo toggle
        this.toggleSlowMoBtn?.addEventListener('click', () => {
            if (this.incidentSlowMo) {
                this.incidentSlowMo.toggle();
                this._updateOverlayButtonStates();
            }
        });

        // Bird's Eye View (Collision Reconstruction) toggle
        this.toggleBirdsEyeBtn?.addEventListener('click', () => {
            if (this.collisionReconstruction) {
                this.collisionReconstruction.toggle();
                this._updateOverlayButtonStates();
            }
        });

        // Street View button in info bar
        if (this.streetViewBtn) {
            this._setupStreetViewButton();
        }

        // Notes & Tags
        this.notesBtn.addEventListener('click', () => this.openNotesModal());
        this.notesManager.onNotesChanged = (eventName) => {
            this.updateNotesButtonState();
            // Refresh event browser indicators if available
            if (this.eventBrowser?.refreshNotesIndicators) {
                this.eventBrowser.refreshNotesIndicators();
            }
            // Refresh filter panel to update tag dropdown
            if (this.filterPanel?.refresh) {
                this.filterPanel.refresh();
            }
        };

        // Clip marking
        this.markInBtn.addEventListener('click', () => this.markIn());
        this.markOutBtn.addEventListener('click', () => this.markOut());
        this.clearMarksBtn.addEventListener('click', () => this.clearMarks());

        // Export
        this.exportBtn.addEventListener('click', () => this.exportVideo());

        // Export dropdown
        this.exportDropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleExportDropdown();
        });

        // Privacy mode checkbox - syncs with settings
        const privacyModeCheckbox = document.getElementById('privacyModeCheckbox');
        if (privacyModeCheckbox) {
            // Initialize from settings
            privacyModeCheckbox.checked = this.settingsManager.get('privacyModeExport') === true;

            // Update settings when checkbox changes
            privacyModeCheckbox.addEventListener('change', (e) => {
                e.stopPropagation();
                this.settingsManager.set('privacyModeExport', e.target.checked);
                console.log('Privacy mode export:', e.target.checked ? 'enabled' : 'disabled');
            });

        }

        // Blur license plates checkbox - syncs with settings
        const blurPlatesExportCheckbox = document.getElementById('blurPlatesExportCheckbox');
        if (blurPlatesExportCheckbox) {
            // Initialize from settings (shared key with Settings modal and downstream export code)
            blurPlatesExportCheckbox.checked = this.settingsManager.get('blurLicensePlates') === true;

            // Update settings when checkbox changes
            blurPlatesExportCheckbox.addEventListener('change', (e) => {
                e.stopPropagation();
                this.settingsManager.set('blurLicensePlates', e.target.checked);
                console.log('Blur plates export:', e.target.checked ? 'enabled' : 'disabled');
            });

        }

        // Export format dropdown - syncs with settings
        const exportFormatSelect = document.getElementById('exportFormatSelect');
        const gifWarning = document.getElementById('gifWarning');
        const h264Warning = document.getElementById('h264Warning');
        const showFormatWarnings = (fmt) => {
            if (gifWarning) gifWarning.classList.toggle('hidden', fmt !== 'gif');
            // MP4 (H.264) is the most compatible but often the slowest (software encoder on many PCs)
            if (h264Warning) h264Warning.classList.toggle('hidden', fmt !== 'mp4-h264');
        };
        if (exportFormatSelect) {
            // Initialize from settings
            const savedFormat = this.settingsManager.get('exportFormat') || 'mp4';
            exportFormatSelect.value = savedFormat;

            // Show/hide the GIF and H.264 speed warnings based on initial format
            showFormatWarnings(savedFormat);

            // Update settings when format changes
            exportFormatSelect.addEventListener('change', (e) => {
                e.stopPropagation();
                this.settingsManager.set('exportFormat', e.target.value);
                console.log('Export format:', e.target.value);

                // Show/hide the GIF and H.264 speed warnings
                showFormatWarnings(e.target.value);
            });

            // Keep toolbar controls in sync when export settings change elsewhere (e.g. Settings modal)
            this.settingsManager.onChange((settings) => {
                if (exportFormatSelect.value !== settings.exportFormat) {
                    exportFormatSelect.value = settings.exportFormat;
                    showFormatWarnings(settings.exportFormat);
                }
                if (privacyModeCheckbox && privacyModeCheckbox.checked !== (settings.privacyModeExport === true)) {
                    privacyModeCheckbox.checked = settings.privacyModeExport === true;
                }
                if (blurPlatesExportCheckbox && blurPlatesExportCheckbox.checked !== (settings.blurLicensePlates === true)) {
                    blurPlatesExportCheckbox.checked = settings.blurLicensePlates === true;
                }
            });

            // Prevent clicks on video group from closing dropdown
            const videoGroup = exportFormatSelect.closest('.export-video-group');
            if (videoGroup) {
                videoGroup.addEventListener('click', (e) => {
                    // Only stop propagation for format select, not the button
                    if (e.target === exportFormatSelect || e.target.closest('.export-format-select')) {
                        e.stopPropagation();
                    }
                });
            }
        }

        // Export action buttons (Screenshot, Export Video, Insurance Report)
        this.exportDropdown.querySelectorAll('.export-action-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.exportDropdown.classList.add('hidden');

                // Check if it's a screenshot action, insurance report, or video export
                const action = btn.dataset.action;
                if (action === 'screenshot') {
                    this.captureScreenshot();
                } else if (action === 'insurance-report') {
                    this.generateInsuranceReport();
                } else {
                    const camera = btn.dataset.camera;
                    this.exportVideo(camera);
                }
            });
        });

        // Prevent checkbox options from closing dropdown.
        // The option is a <label> wrapping the checkbox, so the browser natively
        // toggles the checkbox on click — don't toggle manually or it double-fires.
        this.exportDropdown.querySelectorAll('.export-checkbox-option').forEach(option => {
            option.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });

        // Bookmark buttons
        this.prevBookmarkBtn.addEventListener('click', () => this.jumpToPreviousBookmark());
        this.addBookmarkBtn.addEventListener('click', () => this.addBookmark());
        this.nextBookmarkBtn.addEventListener('click', () => this.jumpToNextBookmark());

        // Bookmarks dropdown
        this.bookmarksListBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleBookmarksDropdown();
        });
        this.clearAllBookmarksBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.clearAllBookmarks();
        });

        // Close dropdowns when clicking outside
        document.addEventListener('click', (e) => {
            // Close bookmarks dropdown
            if (!this.bookmarksDropdown.classList.contains('hidden') &&
                !this.bookmarksDropdown.contains(e.target) &&
                e.target !== this.bookmarksListBtn) {
                this.bookmarksDropdown.classList.add('hidden');
            }
            // Close export dropdown
            if (!this.exportDropdown.classList.contains('hidden') &&
                !this.exportDropdown.contains(e.target) &&
                e.target !== this.exportDropdownBtn) {
                this.exportDropdown.classList.add('hidden');
            }
        });

        // Zoom buttons
        this.zoomOutBtn.addEventListener('click', () => this.timeline.zoomOut());
        this.zoomInBtn.addEventListener('click', () => this.timeline.zoomIn());
        this.zoomResetBtn.addEventListener('click', () => this.timeline.resetZoom());

        // Mobile menu toggle
        this.menuToggleBtn.addEventListener('click', () => this.toggleSidebar());
        this.sidebarOverlay.addEventListener('click', () => this.closeSidebar());

        // Mobile more menu (controls area)
        this.mobileMoreBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            // Move menu to controls container if needed
            if (this.mobileMoreMenu && this.mobileMoreBtn.parentElement) {
                this.mobileMoreBtn.parentElement.appendChild(this.mobileMoreMenu);
            }
            this.mobileMoreMenu?.classList.toggle('hidden');
            this._updateMobileMoreMenuStatus();
        });

        // Bottom sheet more button (use event delegation for reliability)
        document.addEventListener('click', (e) => {
            const bsMoreBtn = e.target.closest('#bsMoreBtn');
            if (bsMoreBtn) {
                e.stopPropagation();
                const menu = document.getElementById('mobileMoreMenu');
                const container = document.querySelector('.bs-more-container');
                if (menu && container) {
                    container.appendChild(menu);
                    menu.classList.toggle('hidden');
                    this._updateMobileMoreMenuStatus();
                }
                return;
            }

            // Close mobile more menu when clicking outside
            const menu = document.getElementById('mobileMoreMenu');
            if (menu && !menu.classList.contains('hidden')) {
                const isMoreBtn = e.target.closest('#mobileMoreBtn') || e.target.closest('#bsMoreBtn');
                if (!menu.contains(e.target) && !isMoreBtn) {
                    menu.classList.add('hidden');
                }
            }
        });

        // Mobile more menu options
        this.mobileMoreMenu?.querySelectorAll('.mobile-more-option[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const action = btn.dataset.action;
                this._handleMobileMoreAction(action);
            });
        });

        // Mobile layout select
        this.mobileLayoutSelect?.addEventListener('change', (e) => {
            const layout = e.target.value;
            this.layoutSelect.value = layout;
            this.layoutSelect.dispatchEvent(new Event('change'));
            this.mobileMoreMenu?.classList.add('hidden');
        });

        // Speed control
        this.speedSelect.addEventListener('change', (e) => {
            const speed = parseFloat(e.target.value);
            this.videoPlayer.setPlaybackRate(speed);
        });

        // Loop control - checkbox (kept for compatibility)
        this.loopCheckbox.addEventListener('change', (e) => {
            this.videoPlayer.setLoop(e.target.checked);
            this.loopBtn.classList.toggle('active', e.target.checked);
        });

        // Loop button (new UI)
        this.loopBtn.addEventListener('click', () => {
            const newState = !this.loopCheckbox.checked;
            this.loopCheckbox.checked = newState;
            this.videoPlayer.setLoop(newState);
            this.loopBtn.classList.toggle('active', newState);
        });

        // Layout control
        this.layoutSelect.addEventListener('change', (e) => {
            const layout = e.target.value;
            this.layoutManager.setLayout(layout);
            // Show reset button when cameras have been swapped
            const resetBtn = document.getElementById('resetLayoutBtn');
            if (resetBtn) resetBtn.style.display = 'none';
        });

        // Reset layout button — restores camera positions after drag-swap
        const resetLayoutBtn = document.getElementById('resetLayoutBtn');
        if (resetLayoutBtn) {
            resetLayoutBtn.addEventListener('click', () => {
                this.layoutManager.resetCameraOrder();
                resetLayoutBtn.style.display = 'none';
            });
            // If we restored a modified layout from localStorage, show the button
            if (this.layoutManager._configModified) {
                resetLayoutBtn.style.display = '';
            }
        }

        // Focus camera selector
        this.focusCameraSelect.addEventListener('change', (e) => {
            const camera = e.target.value;
            this.layoutManager.setFocusCamera(camera);
        });

        // Video player callbacks
        this.videoPlayer.onTimeUpdate = (time) => {
            if (!this.timeline.isDragging) {
                // Calculate absolute event time
                const eventTime = this.getAbsoluteEventTime(time);
                this.timeline.updateTime(eventTime);

                // Update bottom sheet mini-timeline
                this.updateBottomSheetProgress(eventTime, this.timeline.totalDuration);
            }
        };

        this.videoPlayer.onEnded = () => {
            this.updatePlaybackButtons();

            // Auto-play next event if setting is enabled
            if (this.settingsManager.get('autoPlayNextEvent')) {
                this.autoPlayNextEvent();
            }
        };

        this.videoPlayer.onClipChange = (clipIndex) => {
            this.updatePlaybackButtons();
            // Reset sync timer so we sync at start of new clip
            this.syncController.resetSyncTimer();
        };

        this.videoPlayer.onPlayStateChange = (isPlaying) => {
            this.updatePlaybackButtons();
        };

        // Buffering indicator callback
        this.videoPlayer.onBufferingChange = (state) => {
            this.updateBufferingIndicator(state);
        };

        // Tab switching
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;
                this.switchTab(tabName);
            });
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyPress(e));

        // Settings, Help, Stats, and Session buttons
        this.settingsBtn.addEventListener('click', () => this.settingsManager.showSettingsModal());
        this.helpBtn.addEventListener('click', () => this.helpModal.show());
        this.statsBtn.addEventListener('click', () => this.statisticsManager.showModal());
        this.sessionBtn.addEventListener('click', () => this.sessionManager.showSessionModal());

        // Camera visibility toggles
        this.setupCameraVisibilityControls();

        // Mobile swipe gestures
        this.setupSwipeGestures();

        // Drive selector (multi-drive support)
        this.setupDriveSelector();

        // Mobile fullscreen mode
        this.setupMobileFullscreen();

        // Bottom sheet controls (portrait mode)
        this.setupBottomSheet();
    }

    /**
     * Setup bottom sheet controls for portrait mode
     */
    setupBottomSheet() {
        this.bottomSheet = document.getElementById('bottomSheet');
        this.bottomSheetHandle = document.getElementById('bottomSheetHandle');
        this.bottomSheetPlayBtn = document.getElementById('bottomSheetPlayBtn');
        this.bottomSheetTime = document.getElementById('bottomSheetTime');
        this.bottomSheetProgress = document.getElementById('bottomSheetProgress');

        // Enable bottom sheet on portrait mobile
        const telemetryPanel = document.getElementById('telemetryPanel');
        const telemetryOriginalParent = telemetryPanel?.parentElement;
        const playerArea = document.querySelector('.player-area');

        const checkOrientation = () => {
            const isMobilePortrait = window.innerWidth <= 768 && window.innerHeight > window.innerWidth;

            if (isMobilePortrait) {
                document.body.classList.add('bottom-sheet-enabled');
                // Move telemetry panel to player area for proper fixed positioning
                if (telemetryPanel && playerArea && telemetryPanel.parentElement !== playerArea) {
                    playerArea.insertBefore(telemetryPanel, playerArea.firstChild);
                }
            } else {
                document.body.classList.remove('bottom-sheet-enabled');
                // Move telemetry panel back to sidebar
                if (telemetryPanel && telemetryOriginalParent && telemetryPanel.parentElement !== telemetryOriginalParent) {
                    telemetryOriginalParent.appendChild(telemetryPanel);
                }
            }
        };

        checkOrientation();
        window.addEventListener('resize', checkOrientation);
        window.addEventListener('orientationchange', checkOrientation);

        // Handle toggle on drag
        this.bottomSheetHandle.addEventListener('click', () => {
            this.bottomSheet.classList.toggle('collapsed');
        });

        // Wire up bottom sheet buttons
        this.bottomSheetPlayBtn?.addEventListener('click', () => this.togglePlayback());
        document.getElementById('bsFrameBackBtn')?.addEventListener('click', () => this.frameStep(-1));
        document.getElementById('bsFrameForwardBtn')?.addEventListener('click', () => this.frameStep(1));
        document.getElementById('bsPrevClipBtn')?.addEventListener('click', () => this.previousClip());
        document.getElementById('bsNextClipBtn')?.addEventListener('click', () => this.nextClip());
        document.getElementById('bsPrevEventBtn')?.addEventListener('click', () => this.previousEvent());
        document.getElementById('bsNextEventBtn')?.addEventListener('click', () => this.nextEvent());
        document.getElementById('bsScreenshotBtn')?.addEventListener('click', () => this.captureScreenshot());
        document.getElementById('bsFullscreenBtn')?.addEventListener('click', () => this.enterMobileFullscreen());

        // Mini-timeline scrubbing
        const miniTimeline = document.querySelector('.bottom-sheet-mini-timeline');
        if (miniTimeline) {
            miniTimeline.addEventListener('click', (e) => {
                if (!this.timeline.totalDuration) return;
                const rect = miniTimeline.getBoundingClientRect();
                const percent = (e.clientX - rect.left) / rect.width;
                const time = percent * this.timeline.totalDuration;
                this.onTimelineSeeked(time);
            });
        }
    }

    /**
     * Update bottom sheet progress
     */
    updateBottomSheetProgress(currentTime, totalDuration) {
        if (this.bottomSheetProgress) {
            const percent = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;
            this.bottomSheetProgress.style.width = `${percent}%`;
        }
        if (this.bottomSheetTime) {
            this.bottomSheetTime.textContent = this.formatTime(currentTime);
        }
    }

    /**
     * Setup mobile fullscreen mode
     */
    setupMobileFullscreen() {
        // Enter fullscreen on button click
        this.mobileFullscreenBtn.addEventListener('click', () => this.enterMobileFullscreen());

        // Exit fullscreen
        this.exitFullscreenBtn.addEventListener('click', () => this.exitMobileFullscreen());

        // Play/pause in fullscreen
        this.fullscreenPlayBtn.addEventListener('click', () => {
            this.togglePlayback();
            this.showFullscreenControls();
        });

        // Tap on overlay to show/hide controls
        this.mobileFullscreenOverlay.addEventListener('click', (e) => {
            if (e.target === this.mobileFullscreenOverlay) {
                this.toggleFullscreenControls();
            }
        });

        // Also handle clicks on video grid when in fullscreen mode
        const videoGridContainer = document.querySelector('.video-grid-container');
        if (videoGridContainer) {
            videoGridContainer.addEventListener('click', (e) => {
                if (this.isMobileFullscreen && !e.target.closest('button')) {
                    this.toggleFullscreenControls();
                }
            });
        }

        // Swipe down to exit fullscreen
        let touchStartY = 0;
        this.mobileFullscreenOverlay.addEventListener('touchstart', (e) => {
            touchStartY = e.touches[0].clientY;
        }, { passive: true });

        this.mobileFullscreenOverlay.addEventListener('touchend', (e) => {
            const deltaY = e.changedTouches[0].clientY - touchStartY;
            if (deltaY > 100) {
                this.exitMobileFullscreen();
            }
        }, { passive: true });
    }

    /**
     * Enter mobile fullscreen mode
     */
    enterMobileFullscreen() {
        this.isMobileFullscreen = true;
        document.body.classList.add('mobile-fullscreen');
        this.mobileFullscreenOverlay.classList.remove('hidden');
        this.mobileFullscreenOverlay.classList.add('active');

        // Show controls briefly
        this.showFullscreenControls();

        // Try to request fullscreen from the browser
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {
                // Fallscreen API not available or rejected, CSS fullscreen still works
            });
        }

        console.log('Entered mobile fullscreen mode');
    }

    /**
     * Exit mobile fullscreen mode
     */
    exitMobileFullscreen() {
        this.isMobileFullscreen = false;
        document.body.classList.remove('mobile-fullscreen');
        this.mobileFullscreenOverlay.classList.add('hidden');
        this.mobileFullscreenOverlay.classList.remove('active', 'show-controls');

        if (this.fullscreenControlsTimeout) {
            clearTimeout(this.fullscreenControlsTimeout);
        }

        // Exit browser fullscreen if active
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        }

        console.log('Exited mobile fullscreen mode');
    }

    /**
     * Show fullscreen controls temporarily
     */
    showFullscreenControls() {
        this.mobileFullscreenOverlay.classList.add('show-controls');

        // Hide controls after 3 seconds
        if (this.fullscreenControlsTimeout) {
            clearTimeout(this.fullscreenControlsTimeout);
        }

        this.fullscreenControlsTimeout = setTimeout(() => {
            this.mobileFullscreenOverlay.classList.remove('show-controls');
        }, 3000);
    }

    /**
     * Toggle fullscreen controls visibility
     */
    toggleFullscreenControls() {
        if (this.mobileFullscreenOverlay.classList.contains('show-controls')) {
            this.mobileFullscreenOverlay.classList.remove('show-controls');
            if (this.fullscreenControlsTimeout) {
                clearTimeout(this.fullscreenControlsTimeout);
            }
        } else {
            this.showFullscreenControls();
        }
    }

    /**
     * Setup drive selector UI and event listeners
     */
    setupDriveSelector() {
        // Drive select change
        this.driveSelect.addEventListener('change', (e) => {
            const driveId = e.target.value || null;
            this.folderManager.setActiveDrive(driveId);
            this.applyFilters();
        });

        // Add drive button
        this.addDriveBtn.addEventListener('click', () => this.addNewDrive());

        // Manage drives button
        this.manageDrivesBtn.addEventListener('click', () => this.showDriveManagementModal());

        // Sync drives button
        this.syncDrivesBtn.addEventListener('click', () => this.driveSyncUI.show());

        // Manual drive-rescan button (always available, works even on browsers
        // without FileSystemObserver).
        const refreshBtn = document.getElementById('refreshDrivesBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                refreshBtn.disabled = true;
                refreshBtn.classList.add('spinning');
                try {
                    await this._rescanAllDrives();
                } finally {
                    refreshBtn.disabled = false;
                    refreshBtn.classList.remove('spinning');
                }
            });
        }

        // Listen for drive changes
        this.folderManager.onDrivesChanged = (drives) => {
            this.updateDriveSelector(drives);
            this._syncFileSystemObservers(drives);
        };
    }

    /**
     * Reconcile the file-system observer registry with the current drive
     * list. New drives start being watched; removed drives are unwatched.
     * No-op on browsers without FileSystemObserver.
     */
    _syncFileSystemObservers(drives) {
        if (!this.fsObserver) {
            console.log('[FSObserver] No observer instance available');
            return;
        }
        if (!this.fsObserver.isSupported) {
            console.log('[FSObserver] API not supported in this browser; manual refresh button is the fallback');
            return;
        }
        const driveIds = new Set(drives.map(d => d.id));
        console.log(`[FSObserver] Syncing observers — ${drives.length} drive(s) active`);

        // Unwatch drives that no longer exist
        for (const existingId of Array.from(this.fsObserver.observers.keys())) {
            if (!driveIds.has(existingId)) {
                this.fsObserver.unwatch(existingId);
            }
        }

        // Watch new drives
        for (const drive of drives) {
            if (!drive.handle) {
                console.log(`[FSObserver] Drive ${drive.label} has no handle; cannot watch`);
                continue;
            }
            if (drive.isArchive) {
                console.log(`[FSObserver] Drive ${drive.label} is an archive; skipping`);
                continue;
            }
            if (!this.fsObserver.observers.has(drive.id)) {
                this.fsObserver.watch(drive.id, drive.handle);
            }
        }
    }

    /**
     * Update drive selector dropdown with current drives
     */
    updateDriveSelector(drives) {
        // Clear existing options except "All Drives"
        this.driveSelect.innerHTML = `<option value="">${FolderParser.escapeHtml(this._t('sidebar.allDrives'))}</option>`;

        // Add drive options
        for (const drive of drives) {
            const option = document.createElement('option');
            option.value = drive.id;
            option.textContent = `${drive.label} (${drive.events?.length || 0})`;
            option.style.color = drive.color;
            this.driveSelect.appendChild(option);
        }

        // Show/hide drive selector based on drive count
        if (drives.length > 0) {
            this.driveSelector.classList.remove('hidden');
        } else {
            this.driveSelector.classList.add('hidden');
        }

        // Enable/disable sync button based on drive count (need 2+ drives)
        this.syncDrivesBtn.disabled = drives.length < 2;

        // Restore active drive selection
        if (this.folderManager.activeDriveId) {
            this.driveSelect.value = this.folderManager.activeDriveId;
        }
    }

    /**
     * Add a new drive (folder)
     */
    async addNewDrive() {
        let handle = null;

        // Loop to allow "Change Folder" option
        while (true) {
            try {
                handle = await window.showDirectoryPicker();
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error('Error selecting folder:', error);
                }
                return;
            }

            // Show drive setup dialog
            const settings = await this.showDriveSetupDialog(handle);

            if (!settings) {
                return; // User cancelled
            }

            if (settings.changeFolder) {
                continue; // User wants to change folder
            }

            this.showLoading('Adding drive...');

            try {
                // Add drive to folder manager with settings
                const drive = await this.folderManager.addDrive(handle, {
                    label: settings.label,
                    isArchive: settings.isArchive,
                    dateFilter: settings.dateFilter
                });

                // If archive drive, skip loading
                if (settings.isArchive) {
                    this.hideLoading();
                    this.updateDriveSelector(this.folderManager.getDrives());
                    console.log(`Added archive drive: ${drive.label}`);
                    return;
                }

                // Parse the drive
                this.loadingText.textContent = 'Parsing TeslaCam folder...';
                this.folderParser.setDriveContext(drive.id, drive.label, drive.color);
                this.folderParser.rootHandle = handle;
                this.folderParser.setProgressCallback((message, count) => {
                    this.loadingText.textContent = `${drive.label}: ${message} (${count} events)`;
                });
                let events = await this.folderParser.parseFolder();
                this.folderParser.setProgressCallback(null);

                // Apply date filter if set
                const cutoff = this.folderManager.getDateFilterCutoff(settings.dateFilter);
                if (cutoff) {
                    const beforeCount = events.length;
                    events = events.filter(event => new Date(event.timestamp) >= cutoff);
                    console.log(`Date filter (${settings.dateFilter}): ${beforeCount} → ${events.length} events`);
                }

                // Store events in drive
                drive.events = events;

                // Merge into allEvents
                this.allEvents = this.allEvents.concat(events);
                this.allEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

                // Update statistics and filters
                this.statisticsManager.setEvents(this.allEvents);

                // Register events and load backups
                await this.registerEventsAndLoadBackups(events);

                this.applyFilters();

                // Update drive selector
                this.updateDriveSelector(this.folderManager.getDrives());

                this.hideLoading();

                console.log(`Added drive "${drive.label}" with ${events.length} events`);
            } catch (error) {
                console.error('Error adding drive:', error);
                this.hideLoading();
            }

            break; // Exit loop
        }
    }

    /**
     * Get translation helper
     */
    t(key) {
        return window.i18n ? window.i18n.t(key) : key.split('.').pop();
    }

    /**
     * Show drive management modal
     */
    showDriveManagementModal() {
        const drives = this.folderManager.getDrives();

        // Helper to get event count text
        const getEventCountText = (drive) => {
            if (drive.isArchive && (!drive.events || drive.events.length === 0)) {
                return this.t('driveManager.notLoaded');
            }
            const count = drive.events?.length || 0;
            return `${count} ${this.t('driveManager.events')}`;
        };

        // Helper to get date filter text
        const getDateFilterText = (drive) => {
            if (!drive.dateFilter || drive.dateFilter === 'all') return '';
            return this.folderManager.getDateFilterLabel(drive.dateFilter);
        };

        // Create modal content
        const modalContent = `
            <div class="modal-overlay" id="driveManagementModal">
                <div class="modal drive-management-modal">
                    <div class="modal-header">
                        <h3>${this.t('driveManager.title')}</h3>
                        <button class="modal-close-btn" id="closeDriveModal">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                            </svg>
                        </button>
                    </div>
                    <div class="modal-content">
                        ${drives.length === 0 ? `
                            <p style="color: var(--text-muted); text-align: center;">${this.t('driveManager.noDrives')}</p>
                        ` : `
                            <div class="drive-list">
                                ${drives.map(drive => `
                                    <div class="drive-item ${drive.isArchive ? 'is-archive' : ''}" data-drive-id="${drive.id}">
                                        <label class="drive-color-picker" title="${this.t('driveManager.changeColor')}">
                                            <input type="color" class="drive-color-input" value="${drive.color}" data-drive-id="${drive.id}">
                                            <div class="drive-color-preview" style="background: ${drive.color};"></div>
                                        </label>
                                        <div style="flex: 1; min-width: 0;">
                                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                                <input type="text" class="drive-label-input" value="${FolderParser.escapeHtml(drive.label)}" data-drive-id="${drive.id}" style="flex: 1;">
                                                ${drive.isArchive ? `<span class="drive-archive-badge">${this.t('driveManager.archive')}</span>` : ''}
                                            </div>
                                            <div style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.25rem;">
                                                <span class="drive-event-count">${getEventCountText(drive)}</span>
                                                ${getDateFilterText(drive) ? `<span class="drive-date-filter">• ${getDateFilterText(drive)}</span>` : ''}
                                            </div>
                                        </div>
                                        ${drive.isArchive ? `
                                            <button class="drive-sync-btn" data-drive-id="${drive.id}" title="${this.t('driveManager.syncNow')}">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                                    <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
                                                </svg>
                                                ${this.t('driveManager.sync')}
                                            </button>
                                        ` : ''}
                                        <button class="drive-edit-btn" data-drive-id="${drive.id}" title="${this.t('driveManager.editDrive')}" style="background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0.25rem; border-radius: 4px;">
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                                <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                                            </svg>
                                        </button>
                                        <button class="drive-remove-btn" data-drive-id="${drive.id}" title="${this.t('driveManager.removeDrive')}">
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                                            </svg>
                                        </button>
                                    </div>
                                `).join('')}
                            </div>
                        `}
                        <button class="btn btn-primary" id="addDriveModalBtn" style="width: 100%; margin-top: 1rem;">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 0.5rem;">
                                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                            </svg>
                            ${this.t('driveManager.addDrive')}
                        </button>
                    </div>
                </div>
            </div>
        `;

        // Add modal to DOM
        document.body.insertAdjacentHTML('beforeend', modalContent);

        const modal = document.getElementById('driveManagementModal');

        // Close button
        document.getElementById('closeDriveModal').addEventListener('click', () => {
            modal.remove();
        });

        // Close on overlay click (only if mousedown started on overlay - prevents close during text selection)
        let mouseDownOnOverlay = false;
        modal.addEventListener('mousedown', (e) => {
            mouseDownOnOverlay = e.target === modal;
        });
        modal.addEventListener('click', (e) => {
            if (mouseDownOnOverlay && e.target === modal) {
                modal.remove();
            }
        });

        // Add drive button in modal
        document.getElementById('addDriveModalBtn').addEventListener('click', async () => {
            modal.remove();
            await this.addNewDrive();
        });

        // Label input change handlers
        modal.querySelectorAll('.drive-label-input').forEach(input => {
            input.addEventListener('change', async (e) => {
                const driveId = e.target.dataset.driveId;
                const newLabel = e.target.value.trim();
                if (newLabel) {
                    await this.folderManager.updateDriveLabel(driveId, newLabel);
                    // Update event badges
                    this.eventBrowser.render(this.filteredEvents);
                }
            });
        });

        // Color input change handlers
        modal.querySelectorAll('.drive-color-input').forEach(input => {
            input.addEventListener('input', (e) => {
                // Update preview immediately
                const preview = e.target.parentElement.querySelector('.drive-color-preview');
                if (preview) {
                    preview.style.background = e.target.value;
                }
            });
            input.addEventListener('change', async (e) => {
                const driveId = e.target.dataset.driveId;
                const newColor = e.target.value;
                await this.folderManager.updateDriveColor(driveId, newColor);
                // Update event badges with new color
                this.allEvents.forEach(event => {
                    if (event.driveId === driveId) {
                        event.driveColor = newColor;
                    }
                });
                this.eventBrowser.render(this.filteredEvents);
            });
        });

        // Sync buttons for archive drives
        modal.querySelectorAll('.drive-sync-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const driveId = e.target.closest('.drive-sync-btn').dataset.driveId;
                modal.remove();
                await this.syncArchiveDrive(driveId);
            });
        });

        // Edit buttons
        modal.querySelectorAll('.drive-edit-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const driveId = e.target.closest('.drive-edit-btn').dataset.driveId;
                const drive = this.folderManager.getDrive(driveId);
                if (drive) {
                    const oldDateFilter = drive.dateFilter;
                    const oldIsArchive = drive.isArchive;

                    modal.remove();
                    const settings = await this.showDriveSetupDialog(null, drive);
                    if (settings && !settings.changeFolder) {
                        await this.folderManager.updateDriveSettings(driveId, settings);

                        // Check if we need to reload events
                        const filterChanged = oldDateFilter !== settings.dateFilter;
                        const archiveChanged = oldIsArchive !== settings.isArchive;

                        if (archiveChanged || filterChanged) {
                            // Re-filter/reload the drive's events
                            await this.reloadDriveEvents(driveId, settings);
                        }

                        // Refresh the modal
                        this.showDriveManagementModal();
                    } else {
                        this.showDriveManagementModal();
                    }
                }
            });
        });

        // Remove drive buttons
        modal.querySelectorAll('.drive-remove-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const driveId = e.target.closest('.drive-remove-btn').dataset.driveId;
                if (confirm('Remove this drive? Events will no longer be shown.')) {
                    await this.folderManager.removeDrive(driveId);
                    this.folderParser.forgetEncrypted?.(driveId);

                    // Remove events from allEvents
                    this.allEvents = this.allEvents.filter(e => e.driveId !== driveId);
                    this.statisticsManager.setEvents(this.allEvents);
                    this.applyFilters();

                    // Close and reopen modal to refresh
                    modal.remove();
                    this.showDriveManagementModal();
                }
            });
        });
    }

    /**
     * Sync an archive drive (load its events on demand)
     * @param {string} driveId
     */
    async syncArchiveDrive(driveId) {
        const drive = this.folderManager.getDrive(driveId);
        if (!drive) {
            console.error('Drive not found:', driveId);
            return;
        }

        this.showLoading(`Syncing ${drive.label}...`);

        try {
            // Restore permission for the archive drive
            const restored = await this.folderManager.restoreArchiveDrive(driveId);
            if (!restored) {
                this.hideLoading();
                alert('Drive may be disconnected or needs permission. Please reconnect the drive and try again.');
                return;
            }

            // Parse the drive
            this.loadingText.textContent = 'Parsing TeslaCam folder...';
            this.folderParser.setDriveContext(drive.id, drive.label, drive.color);
            this.folderParser.rootHandle = drive.handle;
            this.folderParser.setProgressCallback((message, count) => {
                this.loadingText.textContent = `${drive.label}: ${message} (${count} events)`;
            });
            let events = await this.folderParser.parseFolder();
            this.folderParser.setProgressCallback(null);

            // Apply date filter if set
            const cutoff = this.folderManager.getDateFilterCutoff(drive.dateFilter);
            if (cutoff) {
                const beforeCount = events.length;
                events = events.filter(event => new Date(event.timestamp) >= cutoff);
                console.log(`Date filter (${drive.dateFilter}): ${beforeCount} → ${events.length} events`);
            }

            // Add drive metadata to events
            for (const event of events) {
                event.driveId = drive.id;
                event.compoundKey = this.folderManager.getCompoundKey(drive.id, event.name);
                event.driveLabel = drive.label;
                event.driveColor = drive.color;
            }

            // Store events in drive
            drive.events = events;

            // Remove any existing events from this drive and add new ones
            this.allEvents = this.allEvents.filter(e => e.driveId !== driveId);
            this.allEvents = this.allEvents.concat(events);
            this.allEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            // Update statistics and filters
            this.statisticsManager.setEvents(this.allEvents);

            // Register events and load backups
            await this.registerEventsAndLoadBackups(events);

            this.applyFilters();

            // Update drive selector
            this.updateDriveSelector(this.folderManager.getDrives());

            this.hideLoading();

            console.log(`Synced archive drive "${drive.label}" with ${events.length} events`);
        } catch (error) {
            console.error('Error syncing archive drive:', error);
            this.hideLoading();
            alert('Unable to sync drive. Please check the connection and try again.');
        }
    }

    /**
     * Reload events for a drive after settings change (date filter, archive status)
     * @param {string} driveId
     * @param {Object} settings - New settings
     */
    async reloadDriveEvents(driveId, settings) {
        const drive = this.folderManager.getDrive(driveId);
        if (!drive) return;

        // If changed to archive, remove events from allEvents
        if (settings.isArchive) {
            this.allEvents = this.allEvents.filter(e => e.driveId !== driveId);
            drive.events = [];
            this.statisticsManager.setEvents(this.allEvents);
            this.applyFilters();
            this.updateDriveSelector(this.folderManager.getDrives());
            console.log(`Marked ${drive.label} as archive, removed events from list`);
            return;
        }

        // If drive has no handle or events need to be reloaded
        if (!drive.handle) {
            console.warn('Drive has no handle, cannot reload events');
            return;
        }

        this.showLoading(`Reloading ${drive.label}...`);

        try {
            // Request permission if needed
            const permission = await drive.handle.requestPermission({ mode: 'read' });
            if (permission !== 'granted') {
                this.hideLoading();
                alert('Permission needed to access this drive. Please allow access when prompted.');
                return;
            }

            // Re-parse the drive
            this.folderParser.setDriveContext(drive.id, drive.label, drive.color);
            this.folderParser.rootHandle = drive.handle;
            this.folderParser.setProgressCallback((message, count) => {
                this.loadingText.textContent = `${drive.label}: ${message} (${count} events)`;
            });
            let events = await this.folderParser.parseFolder();
            this.folderParser.setProgressCallback(null);

            // Apply date filter
            const cutoff = this.folderManager.getDateFilterCutoff(settings.dateFilter);
            if (cutoff) {
                const beforeCount = events.length;
                events = events.filter(event => new Date(event.timestamp) >= cutoff);
                console.log(`Date filter (${settings.dateFilter}): ${beforeCount} → ${events.length} events`);
            }

            // Add drive metadata
            for (const event of events) {
                event.driveId = drive.id;
                event.compoundKey = this.folderManager.getCompoundKey(drive.id, event.name);
                event.driveLabel = drive.label;
                event.driveColor = drive.color;
            }

            // Update drive events
            drive.events = events;

            // Update allEvents
            this.allEvents = this.allEvents.filter(e => e.driveId !== driveId);
            this.allEvents = this.allEvents.concat(events);
            this.allEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            // Update UI
            this.statisticsManager.setEvents(this.allEvents);
            await this.registerEventsAndLoadBackups(events);
            this.applyFilters();
            this.updateDriveSelector(this.folderManager.getDrives());

            this.hideLoading();
            console.log(`Reloaded ${drive.label} with ${events.length} events`);
        } catch (error) {
            console.error('Error reloading drive:', error);
            this.hideLoading();
        }
    }

    /**
     * Show drive setup dialog after folder selection
     * @param {FileSystemDirectoryHandle} handle
     * @param {Object} existingDrive - If editing existing drive
     * @returns {Promise<Object|null>} Drive settings or null if cancelled
     */
    showDriveSetupDialog(handle, existingDrive = null) {
        return new Promise((resolve) => {
            const isEdit = !!existingDrive;
            const folderName = handle?.name || existingDrive?.folderName || 'Unknown';

            const modalContent = `
                <div class="modal-overlay" id="driveSetupModal">
                    <div class="modal drive-setup-modal">
                        <div class="modal-header">
                            <h3>${this.t(isEdit ? 'driveSetup.editTitle' : 'driveSetup.title')}</h3>
                            <button class="modal-close-btn" id="closeDriveSetup">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                                </svg>
                            </button>
                        </div>
                        <div class="modal-content">
                            <div class="drive-setup-selected">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/>
                                </svg>
                                <span>${FolderParser.escapeHtml(folderName)}</span>
                            </div>

                            ${!isEdit ? `
                            <div class="drive-setup-tip">
                                <div class="drive-setup-tip-header">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
                                    </svg>
                                    ${this.t('driveSetup.tipTitle')}
                                </div>
                                <ul>
                                    <li>${this.t('driveSetup.tipTeslaCam')}</li>
                                    <li>${this.t('driveSetup.tipSubfolder')}</li>
                                    <li>${this.t('driveSetup.tipParent')}</li>
                                </ul>
                            </div>
                            ` : ''}

                            <div class="drive-setup-form">
                                <div class="drive-setup-field">
                                    <label for="driveLabel">${this.t('driveSetup.labelField')}</label>
                                    <input type="text" id="driveLabel" value="${FolderParser.escapeHtml(existingDrive?.label || '')}" placeholder="${this.t('driveSetup.labelPlaceholder')}">
                                </div>

                                <div class="drive-setup-field">
                                    <label for="dateFilter">${this.t('driveSetup.dateFilterField')}</label>
                                    <select id="dateFilter">
                                        <option value="all" ${existingDrive?.dateFilter === 'all' ? 'selected' : ''}>${this.t('driveSetup.dateFilterAll')}</option>
                                        <option value="week" ${existingDrive?.dateFilter === 'week' ? 'selected' : ''}>${this.t('driveSetup.dateFilterWeek')}</option>
                                        <option value="month" ${existingDrive?.dateFilter === 'month' ? 'selected' : ''}>${this.t('driveSetup.dateFilterMonth')}</option>
                                        <option value="3months" ${existingDrive?.dateFilter === '3months' ? 'selected' : ''}>${this.t('driveSetup.dateFilter3Months')}</option>
                                        <option value="6months" ${existingDrive?.dateFilter === '6months' ? 'selected' : ''}>${this.t('driveSetup.dateFilter6Months')}</option>
                                        <option value="year" ${existingDrive?.dateFilter === 'year' ? 'selected' : ''}>${this.t('driveSetup.dateFilterYear')}</option>
                                    </select>
                                </div>

                                <label class="drive-setup-checkbox">
                                    <input type="checkbox" id="isArchive" ${existingDrive?.isArchive ? 'checked' : ''}>
                                    <div class="drive-setup-checkbox-content">
                                        <div class="drive-setup-checkbox-label">${this.t('driveSetup.archiveLabel')}</div>
                                        <div class="drive-setup-checkbox-hint">${this.t('driveSetup.archiveHint')}</div>
                                    </div>
                                </label>
                            </div>

                            <div class="drive-setup-actions">
                                ${!isEdit ? `<button class="btn btn-secondary" id="changeFolderBtn">${this.t('driveSetup.changeFolder')}</button>` : ''}
                                <button class="btn btn-primary" id="confirmDriveSetup">${this.t(isEdit ? 'driveSetup.save' : 'driveSetup.addDrive')}</button>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            document.body.insertAdjacentHTML('beforeend', modalContent);

            const modal = document.getElementById('driveSetupModal');
            const labelInput = document.getElementById('driveLabel');
            const dateFilterSelect = document.getElementById('dateFilter');
            const isArchiveCheckbox = document.getElementById('isArchive');

            // Generate default label if not editing
            if (!isEdit && handle) {
                labelInput.value = this.folderManager.generateLabel(handle.name);
            }

            // Close button
            document.getElementById('closeDriveSetup').addEventListener('click', () => {
                modal.remove();
                resolve(null);
            });

            // Close on overlay click (only if mousedown started on overlay)
            let mouseDownOnOverlay = false;
            modal.addEventListener('mousedown', (e) => {
                mouseDownOnOverlay = e.target === modal;
            });
            modal.addEventListener('click', (e) => {
                if (mouseDownOnOverlay && e.target === modal) {
                    modal.remove();
                    resolve(null);
                }
            });

            // Change folder button (only for new drives)
            const changeFolderBtn = document.getElementById('changeFolderBtn');
            if (changeFolderBtn) {
                changeFolderBtn.addEventListener('click', async () => {
                    modal.remove();
                    resolve({ changeFolder: true });
                });
            }

            // Confirm button
            document.getElementById('confirmDriveSetup').addEventListener('click', () => {
                const settings = {
                    label: labelInput.value.trim() || this.folderManager.generateLabel(folderName),
                    dateFilter: dateFilterSelect.value,
                    isArchive: isArchiveCheckbox.checked
                };
                modal.remove();
                resolve(settings);
            });
        });
    }

    /**
     * Setup swipe gestures for mobile navigation between events
     */
    setupSwipeGestures() {
        const videoGrid = document.querySelector('.video-grid-container');
        if (!videoGrid) return;

        let touchStartX = 0;
        let touchStartY = 0;
        let touchStartTime = 0;

        videoGrid.addEventListener('touchstart', (e) => {
            // Only track single finger touches
            if (e.touches.length !== 1) return;

            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            touchStartTime = Date.now();
        }, { passive: true });

        videoGrid.addEventListener('touchend', (e) => {
            // Only process single finger touches
            if (e.changedTouches.length !== 1) return;

            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            const touchEndTime = Date.now();

            const deltaX = touchEndX - touchStartX;
            const deltaY = touchEndY - touchStartY;
            const deltaTime = touchEndTime - touchStartTime;

            // Swipe thresholds
            const minSwipeDistance = 80; // Minimum horizontal distance
            const maxVerticalRatio = 0.5; // Max vertical movement relative to horizontal
            const maxSwipeTime = 500; // Max time in ms for swipe

            // Check if this is a valid horizontal swipe
            if (Math.abs(deltaX) > minSwipeDistance &&
                Math.abs(deltaY) < Math.abs(deltaX) * maxVerticalRatio &&
                deltaTime < maxSwipeTime) {

                if (deltaX > 0) {
                    // Swipe right → previous event
                    this.previousEvent();
                    this.showSwipeIndicator('prev');
                } else {
                    // Swipe left → next event
                    this.nextEvent();
                    this.showSwipeIndicator('next');
                }
            }
        }, { passive: true });
    }

    /**
     * Show visual feedback for swipe navigation
     */
    showSwipeIndicator(direction) {
        // Create indicator element
        const indicator = document.createElement('div');
        indicator.className = `swipe-indicator swipe-${direction}`;
        indicator.innerHTML = direction === 'prev' ?
            '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>' :
            '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>';

        document.body.appendChild(indicator);

        // Remove after animation
        setTimeout(() => {
            indicator.remove();
        }, 400);
    }

    /**
     * Setup camera visibility toggle controls
     */
    setupCameraVisibilityControls() {
        const hideButtons = document.querySelectorAll('.camera-hide-btn');
        const hiddenCamerasPanel = document.getElementById('hiddenCamerasPanel');
        const hiddenCamerasList = document.getElementById('hiddenCamerasList');

        // Name and "Show ..." tooltip for every camera, in the user's language. The pillar cameras were missing
        // here, so a hidden pillar was listed as "undefined" (2026-11-19). Any other id falls back to the
        // shared camera table (cameraIds.js), never to "undefined".
        const cameraKeys = {
            front: ['cameras.front', 'cameras.showFront'],
            back: ['cameras.back', 'cameras.showBack'],
            left_repeater: ['cameras.left', 'cameras.showLeft'],
            right_repeater: ['cameras.right', 'cameras.showRight'],
            left_pillar: ['cameras.leftPillar', 'cameras.showLeftPillar'],
            right_pillar: ['cameras.rightPillar', 'cameras.showRightPillar']
        };
        const cameraName = (camera) => {
            const k = Object.prototype.hasOwnProperty.call(cameraKeys, camera) ? cameraKeys[camera] : null;
            return k ? this._t(k[0]) : (window.cameraIds?.label?.(camera) || String(camera));
        };
        const showTitle = (camera) => {
            const k = Object.prototype.hasOwnProperty.call(cameraKeys, camera) ? cameraKeys[camera] : null;
            return k ? this._t(k[1]) : this._t('cameras.showCamera', { camera: cameraName(camera) });
        };

        // Update hidden cameras panel
        const updateHiddenPanel = () => {
            const visibleCameras = this.layoutManager.getVisibleCameras();
            const hiddenCameras = Object.entries(visibleCameras)
                .filter(([_, visible]) => !visible)
                .map(([camera, _]) => camera);

            if (hiddenCameras.length === 0) {
                hiddenCamerasPanel.classList.add('hidden');
                return;
            }

            hiddenCamerasPanel.classList.remove('hidden');
            const esc = FolderParser.escapeHtml;
            hiddenCamerasList.innerHTML = hiddenCameras.map(camera => `
                <button class="hidden-camera-btn" data-camera="${esc(camera)}" title="${esc(showTitle(camera))}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
                    </svg>
                    ${esc(cameraName(camera))}
                </button>
            `).join('');

            // Add click handlers to show hidden cameras
            hiddenCamerasList.querySelectorAll('.hidden-camera-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const camera = btn.dataset.camera;
                    this.layoutManager.setCameraVisibility(camera, true);
                    updateHiddenPanel();
                });
            });
        };

        // Add click handlers to hide buttons
        hideButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent triggering video container events
                const camera = btn.dataset.camera;
                this.layoutManager.setCameraVisibility(camera, false);
                updateHiddenPanel();
            });
        });

        // Initial update, and again in the new language
        updateHiddenPanel();
        window.addEventListener('localeChanged', () => updateHiddenPanel());
        this._updateHiddenCamerasPanel = updateHiddenPanel;
    }

    /**
     * Select TeslaCam folder
     */
    async selectFolder() {
        let handle = null;

        // Loop to allow "Change Folder" option
        while (true) {
            // Show folder picker
            try {
                handle = await window.showDirectoryPicker();
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error('Error selecting folder:', error);
                }
                return;
            }

            // Show drive setup dialog
            const settings = await this.showDriveSetupDialog(handle);

            if (!settings) {
                // User cancelled
                return;
            }

            if (settings.changeFolder) {
                // User wants to change folder, loop back
                continue;
            }

            // Settings confirmed, proceed
            this.showLoading('Parsing TeslaCam folder...');

            try {
                // Add folder as a drive with settings
                const drive = await this.folderManager.addDrive(handle, {
                    label: settings.label,
                    isArchive: settings.isArchive,
                    dateFilter: settings.dateFilter
                });

                // Check for session recovery from drive
                if (this.sessionManager) {
                    await this.sessionManager.checkDriveRecovery(handle);
                }

                // If archive drive, skip loading and just save
                if (settings.isArchive) {
                    this.hideLoading();

                    // Update drive selector to show the archive drive
                    this.updateDriveSelector(this.folderManager.getDrives());

                    // Hide select folder button
                    this.selectFolderBtn.classList.add('hidden');

                    console.log(`Added archive drive: ${drive.label} (will load on manual sync)`);
                    return;
                }

                // Set drive context for parsing
                this.folderParser.setDriveContext(drive.id, drive.label, drive.color);
                this.folderParser.rootHandle = handle;
                this.folderParser.setProgressCallback((message, count) => {
                    this.loadingText.textContent = `${drive.label}: ${message} (${count} events)`;
                });
                let events = await this.folderParser.parseFolder();
                this.folderParser.setProgressCallback(null);

                // Apply date filter if set
                const cutoff = this.folderManager.getDateFilterCutoff(settings.dateFilter);
                if (cutoff) {
                    const beforeCount = events.length;
                    events = events.filter(event => new Date(event.timestamp) >= cutoff);
                    console.log(`Date filter (${settings.dateFilter}): ${beforeCount} → ${events.length} events`);
                }

                // Store events in drive
                drive.events = events;

                this.allEvents = events; // Store all events
                this.statisticsManager.setEvents(events);

                // Register events and load backups
                await this.registerEventsAndLoadBackups(events);

                this.applyFilters(); // Apply filters and load into UI

                // Update drive selector
                this.updateDriveSelector(this.folderManager.getDrives());

                // Hide select folder button after successful load
                this.selectFolderBtn.classList.add('hidden');

                // Save folder handle if setting is enabled
                if (this.settingsManager.get('rememberLastFolder')) {
                    await this.folderParser.saveFolderHandle();
                }

                this.hideLoading();

                if (events.length > 0) {
                    console.log(`Loaded ${events.length} events`);
                } else {
                    alert('No TeslaCam events found in the selected folder.');
                }
            } catch (error) {
                this.hideLoading();
                console.error('Error parsing folder:', error);
                alert('Unable to read TeslaCam folder. Please make sure you selected the correct folder containing TeslaCam data.');
            }

            break; // Exit loop after successful processing
        }
    }

    /**
     * Apply filters and update event browser and map
     */
    applyFilters() {
        // First filter by active drive
        let eventsToFilter = this.allEvents;
        const activeDriveId = this.folderManager.activeDriveId;

        if (activeDriveId) {
            eventsToFilter = this.allEvents.filter(e => e.driveId === activeDriveId);
        }

        // Then apply regular filters
        const filteredEvents = this.eventFilter.applyFilters(eventsToFilter);

        // Tesla-encrypted events aren't in the list; the browser shows a notice for them
        if (this.eventBrowser.setEncryptedSummary && this.folderParser.getEncryptedSummary) {
            this.eventBrowser.setEncryptedSummary(this.folderParser.getEncryptedSummary(activeDriveId));
        }

        // Update event browser with filtered events
        this.eventBrowser.loadEvents(filteredEvents);

        // Refresh near-miss indicators from cache
        if (this.eventBrowser?.refreshNearMissIndicators) {
            this.eventBrowser.refreshNearMissIndicators();
        }

        // Bulk-hydrate severity badges from IDB so pills appear on the
        // cards immediately after reload — no click required.
        this._bulkHydrateSeverityBadges(filteredEvents);

        // Update map with filtered events
        this.mapView.loadEvents(filteredEvents);

        // Update filter badge
        this.filterPanel.updateFilterBadge();

        console.log(`Filtered: ${filteredEvents.length} of ${this.allEvents.length} events${activeDriveId ? ` (drive: ${activeDriveId})` : ''}`);
    }

    /**
     * Register events with NotesManager and Timeline for backup purposes,
     * and load backup data from event folders
     * @param {Array} events - Array of event objects
     */
    async registerEventsAndLoadBackups(events) {
        if (!events || events.length === 0) return;

        // RecentClips hours were named after the UTC day before 2026.47.5: notes and bookmarks
        // saved under those names are copied to the new names (old entries are kept) (#531)
        if (typeof FolderParser !== 'undefined') FolderParser.migrateLegacyEventKeys(events);

        // Register events with NotesManager and Timeline
        this.notesManager.registerEvents(events);
        this.timeline.registerEvents(events);

        // Load backup data from event folders
        if (window.eventDataBackup) {
            try {
                console.log('[App] Loading backup data from event folders...');
                const backups = await window.eventDataBackup.loadAllFromDrive(events);

                if (backups.size > 0) {
                    console.log(`[App] Found ${backups.size} backup files`);

                    // Merge backup data with localStorage
                    for (const [eventKey, backupData] of backups) {
                        // Merge notes
                        const localNotes = this.notesManager.getNotes(eventKey);
                        const mergedNotes = window.eventDataBackup.mergeNotes(
                            localNotes,
                            backupData,
                            null // We don't track lastModified in localStorage
                        );

                        // Save merged notes to localStorage (won't trigger backup since it's already from backup)
                        if (mergedNotes.text || mergedNotes.tags?.length > 0) {
                            const allNotes = JSON.parse(localStorage.getItem('teslacamviewer_notes') || '{}');
                            allNotes[eventKey] = mergedNotes;
                            localStorage.setItem('teslacamviewer_notes', JSON.stringify(allNotes));
                        }

                        // Merge bookmarks
                        const localBookmarks = this.timeline.getAllSavedBookmarks()[eventKey] || [];
                        const mergedBookmarks = window.eventDataBackup.mergeBookmarks(
                            localBookmarks,
                            backupData.bookmarks
                        );

                        // Save merged bookmarks to localStorage
                        if (mergedBookmarks.length > 0) {
                            const allBookmarks = JSON.parse(localStorage.getItem('teslacamviewer_bookmarks') || '{}');
                            allBookmarks[eventKey] = mergedBookmarks;
                            localStorage.setItem('teslacamviewer_bookmarks', JSON.stringify(allBookmarks));
                        }
                    }

                    console.log('[App] Backup data merged with localStorage');
                }
            } catch (error) {
                console.warn('[App] Failed to load backup data:', error);
            }
        }
    }

    /**
     * Switch between Events and Map tabs
     * @param {string} tabName - 'events' or 'map'
     */
    switchTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            if (btn.dataset.tab === tabName) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // Update tab panes
        const eventsTab = document.getElementById('eventsTab');
        const mapTab = document.getElementById('mapTab');

        if (tabName === 'events') {
            eventsTab.classList.add('active');
            mapTab.classList.remove('active');
        } else if (tabName === 'map') {
            eventsTab.classList.remove('active');
            mapTab.classList.add('active');

            // Resize map when switching to map tab (with delay to ensure tab is visible)
            setTimeout(() => {
                this.mapView.invalidateSize();
            }, 50);
        }

        console.log(`Switched to ${tabName} tab`);
    }

    /**
     * Event selected from browser
     * @param {Object} event
     */
    async onEventSelected(event) {
        // Check session access for viewing events. Free users hit the
        // daily cap on the 10th NEW event, but already-viewed events
        // stay accessible — we pass the event's compoundKey so the
        // session manager can recognize a re-view.
        if (this.sessionManager) {
            const eventKey = event.compoundKey || event.name;
            const access = await this.sessionManager.checkAccess('viewEvent', eventKey);
            if (!access.allowed) {
                this.sessionManager.showLimitModal(access.type || 'daily');
                return;
            }
            // Pre-cap warnings — only on the FIRST view of a NEW event,
            // since re-views shouldn't keep nagging the user. The
            // recordEventView side fires AFTER load below, so we read
            // the current count here against the about-to-be-viewed key.
            if (!access.reviewed) {
                this._maybeShowFreeTierWarning(access);
            }
        }

        // Check if plate enhancer has active work
        if (window.plateEnhancer) {
            const pe = window.plateEnhancer;

            // If processing, block the switch entirely
            if (pe.isProcessing) {
                pe.showToast('Cannot switch events while enhancement is processing');
                return;
            }

            // If there's an active selection or selecting, ask for confirmation
            if (pe.isSelecting || pe.selections.size > 0) {
                const confirmed = confirm('You have an active plate enhancement selection. Switching events will clear it. Continue?');
                if (!confirmed) {
                    return;
                }
                // Clear the plate enhancer state
                pe.clearAllSelections();
            }
        }

        this.showLoading('Loading event...');

        // Load token: when the user picks another event while this one is
        // still loading, this load stops at its next await instead of
        // painting its timeline, telemetry and seeks over the newer event.
        const loadToken = this._eventLoadToken = (this._eventLoadToken || 0) + 1;
        const superseded = () => loadToken !== this._eventLoadToken;

        try {
            this.currentEvent = event;

            // Track event index for navigation
            this.currentEventIndex = this.allEvents.findIndex(e => e.name === event.name);

            // Load event in video player
            await this.videoPlayer.loadEvent(event);
            if (superseded()) return;

            // Record event view for session tracking
            if (this.sessionManager) {
                await this.sessionManager.recordEventView(event.compoundKey || event.name);
                if (superseded()) return;
            }

            // Update pillar camera support based on event
            this.layoutManager.setHasPillarCameras(event.hasPillarCameras || false);
            this.updatePillarLayoutOptions(event.hasPillarCameras || false);

            // Get total duration first (before SEI extraction to avoid concurrent file handle access)
            const totalDuration = await this.videoPlayer.getTotalDuration();
            if (superseded()) return;
            this.timeline.setDuration(totalDuration);
            this.timeline.setClipMarkers(event.clipGroups);

            // Wipe stale overlays from the previous event. near-miss markers
            // were persisting across event switches because the detector only
            // fires its callback when it *finds* new misses — an event with
            // no SEI yet (or no misses) never cleared the old marker.
            if (typeof this.timeline.setNearMissMarkers === 'function') {
                this.timeline.setNearMissMarkers([]);
            }
            if (this.telemetryGraphs) {
                this.telemetryGraphs.nearMisses = [];
            }
            // Clear transient severity state from whatever was selected before.
            event._severityScore = null;
            event._severityFromCache = false;

            // Hydrate insights from IDB — fires-and-forgets; if there's a
            // cache hit the badge + near-miss markers paint before SEI is
            // even parsed. No cost on a cache miss.
            this._hydrateInsightsFromCache(event);
            this._hydrateNearMissesFromCache(event);

            // Clear the scrub-preview tooltip so the previous event's
            // thumbnail doesn't linger until the user hovers again.
            if (typeof this.timeline.resetThumbnailTooltip === 'function') {
                this.timeline.resetThumbnailTooltip();
            }

            // Extract SEI telemetry data (async, non-blocking - after duration calc completes)
            this.extractSeiDataForEvent(event);

            // Start background generation of scrub-preview thumbnails.
            // Scheduled via the background scheduler so it only begins once
            // higher-priority event-load work (SEI extraction, elevation,
            // weather) has finished competing for file I/O and decoder slots.
            if (this.thumbnailCache && event.clipGroups && window.backgroundScheduler) {
                const currentEvent = event;
                window.backgroundScheduler.scheduleIdle(() => {
                    // Guard against user switching events during the idle wait.
                    if (this.currentEvent === currentEvent) {
                        this.thumbnailCache.generateForEvent(currentEvent, currentEvent.clipGroups);
                    }
                }, { timeoutMs: 12000, label: 'thumbnail-gen' });
            }

            // Detect and display gaps in recording
            // Always set them, an empty list too: that clears the previous
            // event's markers and the copy redrawn on zoom (#534).
            const gaps = this.folderParser.detectGaps(event.clipGroups);
            if (gaps.length > 0) {
                console.log(`Detected ${gaps.length} gap(s) in recording:`, gaps);
            }
            this.timeline.setGapMarkers(gaps, event.clipGroups);

            // Set current event for bookmark persistence (use compoundKey for multi-drive support)
            this.timeline.setCurrentEvent(event.compoundKey || event.name);

            // Update event info
            this.updateEventInfo(event);

            // Clear any previous export marks
            if (this.clipMarking) {
                this.clipMarking.clearMarks();
            }

            // Clear speed limit display for new event
            this.currentSpeedLimitData = null;
            this.lastSpeedLimitGps = null;
            this._speedLimitShowsUnavailable = false;
            if (this.speedLimitDisplay) {
                this.speedLimitDisplay.classList.remove('visible');
            }
            // Stop any ongoing background speed limit loading
            if (window.speedLimitService) {
                window.speedLimitService.stopBackgroundLoading();
            }
            // Stop speed limit profile refresh and clear positions
            this._stopSpeedLimitProfileRefresh();
            this._speedLimitPositions = null;

            // Enable controls
            this.enableControls();

            // Close sidebar on mobile after selecting an event
            if (window.innerWidth <= 768) {
                this.closeSidebar();
            }

            // Hide placeholder nudge
            const placeholder = document.getElementById('videoGridPlaceholder');
            if (placeholder) {
                placeholder.classList.add('hidden');
            }

            // Start sync monitoring
            this.syncController.start();

            this.hideLoading();

            // AI Search match navigation — if the user clicked an AI-filtered
            // event, consume the pending seek now (with cached clip durations
            // available) and use it IN PLACE of the sentry auto-seek below.
            // Without this, sentry-auto-seek ran after our seek and overwrote
            // it, sending the player to the sentry trigger instead of the AI
            // match time.
            if (superseded()) return;
            const aiSeekSec = window.aiSearchUI?.consumePendingSeek?.(event.name);

            // For Sentry events, seek to 1 minute 4 seconds from the end
            // Treat as sentry if it's in SentryClips folder OR has sentry-related metadata
            const isSentryEvent = event.type === 'SentryClips' ||
                event.metadata?.reason?.toLowerCase().includes('sentry');

            if (aiSeekSec != null) {
                // AI navigation wins — seek there and still mark the sentry
                // trigger on the timeline if relevant (purely visual).
                await this.videoPlayer.seekToEventTime(aiSeekSec);
                if (isSentryEvent) {
                    const triggerTime = Math.max(0, totalDuration - 60);
                    this.timeline.setSentryTriggerMarker(triggerTime);
                } else {
                    this.timeline.setSentryTriggerMarker(0);
                }
            } else if (isSentryEvent) {
                const startTime = Math.max(0, totalDuration - 64); // 1:04 from end
                await this.videoPlayer.seekToEventTime(startTime);

                // Add Sentry trigger marker to timeline (at 1 minute from end)
                const triggerTime = Math.max(0, totalDuration - 60); // 1:00 from end
                this.timeline.setSentryTriggerMarker(triggerTime);
            } else {
                // Clear any existing sentry marker for non-sentry events
                this.timeline.setSentryTriggerMarker(0);
            }

            if (superseded()) return;

            // Apply current playback speed before playing
            const currentSpeed = parseFloat(this.speedSelect.value) || 1;
            this.videoPlayer.setPlaybackRate(currentSpeed);

            // Auto-play the event
            await this.play();

        } catch (error) {
            if (superseded()) return;
            this.hideLoading();
            console.error('Error loading event:', error);
            alert('Unable to load event videos. The drive may have been disconnected.');
        }
    }

    /**
     * Update event info display
     * @param {Object} event
     */
    updateEventInfo(event) {
        const date = new Date(event.timestamp);
        const dateLocale = window.i18n?.dateLocale?.() || 'en-US';
        const dateStr = date.toLocaleDateString(dateLocale, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        const timeStr = date.toLocaleTimeString(dateLocale, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        this.eventDateElement.textContent = this._t('player.dateAtTime', { date: dateStr, time: timeStr });

        if (event.metadata) {
            const city = event.metadata.city || '';
            const street = event.metadata.street || '';
            let location = '';

            if (city && street) {
                location = `${street}, ${city}`;
            } else if (city) {
                location = city;
            } else if (street) {
                location = street;
            }
            // location becomes HTML below (GPS link): escape the event.json text
            location = FolderParser.escapeHtml(location);

            // Add GPS coordinates if available
            if (event.metadata.est_lat && event.metadata.est_lon) {
                const lat = parseFloat(event.metadata.est_lat);
                const lon = parseFloat(event.metadata.est_lon);
                if (!isNaN(lat) && !isNaN(lon)) {
                    const gpsLink = `https://www.google.com/maps?q=${lat},${lon}`;
                    const gpsText = `GPS: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
                    location += location ? ` • ` : '';
                    location += `<a href="${gpsLink}" target="_blank" style="color: var(--accent); text-decoration: none;" title="Open in Google Maps">${gpsText}</a>`;
                    // Initialize street view button with event GPS
                    this._updateStreetViewButton(lat, lon, 0);
                }
            } else {
                // Disable street view button when no GPS
                this._updateStreetViewButton(null, null, 0);
            }

            // Add camera info for Sentry events.
            //
            // Labels come from the unified cameraIds table (js/cameraIds.js).
            // The user-facing copy still falls back to "Camera N" for any ID
            // we haven't verified against a real event — showing a guess
            // ("Triggered by Cabin camera") would be worse than showing the
            // raw ID, since a wrong guess is taken at face value.
            let reason = FolderParser.formatReason(event.metadata.reason);
            if (event.type === 'SentryClips' && event.metadata.camera) {
                const camId = event.metadata.camera;
                const verified = window.cameraIds?.isVerified(camId);
                const cameraName = verified
                    ? window.cameraIds.label(camId)
                    : `Camera ${camId}`;
                reason += ` • Triggered by ${cameraName} camera`;

                // Diagnostic logging for ground-truth collection (task #44).
                // Logs the available clip cameras alongside the trigger ID
                // so unverified IDs can be cross-referenced (e.g. an event
                // with rear clips triggered by ID 1 → evidence 1 = Rear).
                if (!verified) {
                    const cams = (event.clipGroups?.[0]?.clips && Object.keys(event.clipGroups[0].clips)) || [];
                    console.log(`[CameraID] Unverified trigger ID "${camId}" on ${event.name} — available clip cameras: [${cams.join(', ')}]`);
                }
            }

            this.eventLocationElement.innerHTML = location;
            this.eventReasonElement.textContent = reason;

            // Fetch and display weather
            this.updateEventWeather(event);
        } else {
            this.eventLocationElement.textContent = '';
            this.eventReasonElement.textContent = '';
            this.eventWeatherElement.textContent = '';
            // Disable street view button when no metadata
            this._updateStreetViewButton(null, null, 0);
        }

        // Clear insights until SEI data finishes loading (refreshed asynchronously)
        const insightsEl = document.getElementById('eventInsights');
        if (insightsEl) insightsEl.textContent = '';
    }

    /**
     * Refresh the "Insights" display in the event info bar.
     * Computes road roughness, AP usage, and recording health from SEI telemetry.
     * Should be called once SEI extraction has completed for all clips.
     */
    refreshEventInsights() {
        const insightsEl = document.getElementById('eventInsights');
        if (!insightsEl || !this.telemetryOverlay) return;
        const summary = this.telemetryOverlay.getInsightsSummary();
        insightsEl.textContent = summary || '';
    }

    /**
     * Fetch and display weather for an event. Deferred via the background
     * scheduler so it doesn't compete with the critical video-load path
     * for network bandwidth or main-thread cycles.
     * @param {Object} event
     */
    async updateEventWeather(event) {
        // Clear previous weather immediately so stale data isn't shown.
        this.eventWeatherElement.textContent = '';

        if (!event.metadata?.est_lat || !event.metadata?.est_lon || !event.metadata?.timestamp) {
            return;
        }

        const lat = parseFloat(event.metadata.est_lat);
        const lng = parseFloat(event.metadata.est_lon);
        if (isNaN(lat) || isNaN(lng)) return;

        const run = async () => {
            try {
                const weather = await window.weatherService?.getWeather(lat, lng, event.metadata.timestamp);
                if (weather && this.currentEvent === event) {
                    const formatted = window.weatherService.formatForDisplay(weather);
                    this.eventWeatherElement.textContent = formatted;
                    if (this.miniMapOverlay?.isVisible) {
                        this.miniMapOverlay.setWeather(weather);
                    }
                }
            } catch (error) {
                console.warn('[App] Failed to fetch weather:', error);
            }
        };

        if (window.backgroundScheduler) {
            window.backgroundScheduler.scheduleWhenIdle(run, { label: 'weather-api' });
        } else {
            run();
        }
    }

    /**
     * Fetch weather from SEI telemetry data (for RecentClips without event.json)
     * @param {Object} event - Current event
     * @param {Object} seiData - SEI telemetry data with frames
     */
    async _fetchWeatherFromTelemetry(event, seiData) {
        if (!seiData?.frames?.length || !window.weatherService) return;

        // Find first frame with valid GPS
        const frameWithGps = seiData.frames.find(f =>
            f.latitude_deg && f.longitude_deg &&
            f.latitude_deg !== 0 && f.longitude_deg !== 0
        );

        if (!frameWithGps) return;

        const lat = frameWithGps.latitude_deg;
        const lng = frameWithGps.longitude_deg;

        // Get timestamp from event (derived from filename for RecentClips)
        const timestamp = event.timestamp;
        if (!timestamp) return;

        this._weatherFetchedFromTelemetry = true;

        try {
            console.log(`[Weather] Fetching from telemetry GPS: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
            const weather = await window.weatherService.getWeather(lat, lng, timestamp);
            if (this.currentEvent !== event) return;  // user moved on (#527)

            if (weather) {
                const formatted = window.weatherService.formatForDisplay(weather);
                this.eventWeatherElement.textContent = formatted;

                // Also update mini-map if visible
                if (this.miniMapOverlay?.isVisible) {
                    this.miniMapOverlay.setWeather(weather);
                }

                // Update street view button with telemetry GPS
                this._updateStreetViewButton(lat, lng, frameWithGps.heading_deg || 0);

                console.log(`[Weather] Loaded from telemetry: ${formatted}`);
            }
        } catch (error) {
            console.warn('[App] Failed to fetch weather from telemetry:', error);
        }
    }

    /**
     * Timeline seek handler
     * @param {number} time Absolute time in event
     */
    async onTimelineSeeked(time) {
        this.showLoading('Seeking...');
        await this.videoPlayer.seekToEventTime(time);
        this.hideLoading();
    }

    /**
     * Get absolute event time from current clip time
     * Uses cached clip durations for accuracy when available
     * @param {number} clipTime
     * @returns {number}
     */
    getAbsoluteEventTime(clipTime) {
        if (!this.currentEvent || this.videoPlayer.currentClipIndex < 0) {
            return 0;
        }

        // Sum duration of all previous clips + current time
        let accumulatedTime = 0;
        const cachedDurations = this.videoPlayer.cachedClipDurations;

        for (let i = 0; i < this.videoPlayer.currentClipIndex; i++) {
            // Use cached duration if available, otherwise estimate 60s per clip
            accumulatedTime += (cachedDurations && cachedDurations[i]) ? cachedDurations[i] : 60;
        }

        return accumulatedTime + clipTime;
    }

    /**
     * Play video
     */
    async play() {
        await this.videoPlayer.play();
        this.updatePlaybackButtons();

        // Lock to landscape if setting is enabled (mobile only)
        if (this.settingsManager.get('lockOrientationDuringPlayback')) {
            this.lockOrientation();
        }
    }

    /**
     * Pause video
     */
    async pause() {
        await this.videoPlayer.pause();
        this.updatePlaybackButtons();

        // Unlock orientation when paused
        if (this.settingsManager.get('lockOrientationDuringPlayback')) {
            this.unlockOrientation();
        }
    }

    /**
     * Toggle play/pause
     */
    async togglePlayback() {
        if (this.videoPlayer.getIsPlaying()) {
            await this.pause();
        } else {
            await this.play();
        }
    }

    /**
     * Lock screen orientation to landscape (mobile only)
     */
    async lockOrientation() {
        try {
            // Check if Screen Orientation API is supported
            if (screen.orientation && screen.orientation.lock) {
                await screen.orientation.lock('landscape');
                console.log('Orientation locked to landscape');
            }
        } catch (e) {
            // Graceful degradation - not supported or not allowed
            console.log('Orientation lock not available:', e.message);
        }
    }

    /**
     * Unlock screen orientation
     */
    unlockOrientation() {
        try {
            if (screen.orientation && screen.orientation.unlock) {
                screen.orientation.unlock();
                console.log('Orientation unlocked');
            }
        } catch (e) {
            console.log('Orientation unlock not available:', e.message);
        }
    }

    /**
     * Go to previous clip
     */
    async previousClip() {
        await this.videoPlayer.previousClip();
    }

    /**
     * Go to next clip
     */
    async nextClip() {
        await this.videoPlayer.nextClip();
    }

    /**
     * Update playback button states
     */
    updatePlaybackButtons() {
        const isPlaying = this.videoPlayer.getIsPlaying();

        // Update combined play/pause button icon
        if (this.playPauseBtn) {
            const playIcon = this.playPauseBtn.querySelector('.play-icon');
            const pauseIcon = this.playPauseBtn.querySelector('.pause-icon');
            if (playIcon && pauseIcon) {
                playIcon.style.display = isPlaying ? 'none' : '';
                pauseIcon.style.display = isPlaying ? '' : 'none';
            }
            // Update aria-label for accessibility
            this.playPauseBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
        }

        // Update bottom sheet play button icon
        if (this.bottomSheetPlayBtn) {
            const svg = this.bottomSheetPlayBtn.querySelector('svg');
            if (svg) {
                svg.innerHTML = isPlaying
                    ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'  // Pause icon
                    : '<path d="M8 5v14l11-7z"/>';  // Play icon
            }
        }

        // Update fullscreen play button icon
        if (this.fullscreenPlayBtn) {
            const svg = this.fullscreenPlayBtn.querySelector('svg');
            if (svg) {
                svg.innerHTML = isPlaying
                    ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'  // Pause icon
                    : '<path d="M8 5v14l11-7z"/>';  // Play icon
            }
        }
    }

    /**
     * Disable all controls (during export)
     */
    disableAllControls() {
        console.log('Disabling all controls...');
        this.playPauseBtn.disabled = true;
        this.frameBackBtn.disabled = true;
        this.frameForwardBtn.disabled = true;
        this.prevClipBtn.disabled = true;
        this.nextClipBtn.disabled = true;
        this.screenshotBtn.disabled = true;
        this.pipBtn.disabled = true;
        this.enhanceBtn.disabled = true;
        if (this.enhanceRegionBtn) this.enhanceRegionBtn.disabled = true;
        this.notesBtn.disabled = true;
        this.markInBtn.disabled = true;
        this.markOutBtn.disabled = true;
        this.clearMarksBtn.disabled = true;
        this.exportBtn.disabled = true;
        this.exportDropdownBtn.disabled = true;
        this.prevEventBtn.disabled = true;
        this.nextEventBtn.disabled = true;
        this.speedSelect.disabled = true;
        this.loopCheckbox.disabled = true;
        console.log('All controls disabled. Export button disabled:', this.exportBtn.disabled);
    }

    /**
     * Disable playback controls (during export)
     */
    disableControls() {
        this.playPauseBtn.disabled = true;
        this.frameBackBtn.disabled = true;
        this.frameForwardBtn.disabled = true;
        this.prevClipBtn.disabled = true;
        this.nextClipBtn.disabled = true;
        this.screenshotBtn.disabled = true;
        this.pipBtn.disabled = true;
        this.enhanceBtn.disabled = true;
        if (this.enhanceRegionBtn) this.enhanceRegionBtn.disabled = true;
        this.notesBtn.disabled = true;
        this.markInBtn.disabled = true;
        this.markOutBtn.disabled = true;
        this.clearMarksBtn.disabled = true;
        this.exportBtn.disabled = true;
        this.exportDropdownBtn.disabled = true;
        this.prevBookmarkBtn.disabled = true;
        this.addBookmarkBtn.disabled = true;
        this.nextBookmarkBtn.disabled = true;
        this.bookmarksListBtn.disabled = true;
        this.zoomOutBtn.disabled = true;
        this.zoomInBtn.disabled = true;
        this.zoomResetBtn.disabled = true;
        this.speedSelect.disabled = true;
        this.loopCheckbox.disabled = true;
        this.loopBtn.disabled = true;
        this.prevEventBtn.disabled = true;
        this.nextEventBtn.disabled = true;

        // Hide mobile fullscreen button
        if (this.mobileFullscreenBtn) {
            this.mobileFullscreenBtn.classList.add('hidden');
        }
    }

    /**
     * Enable playback controls
     */
    enableControls() {
        this.playPauseBtn.disabled = false;
        this.frameBackBtn.disabled = false;
        this.frameForwardBtn.disabled = false;
        this.prevClipBtn.disabled = false;
        this.nextClipBtn.disabled = false;
        this.screenshotBtn.disabled = false;
        this.pipBtn.disabled = !document.pictureInPictureEnabled; // Only enable if PiP is supported
        this.enhanceBtn.disabled = false;
        if (this.enhanceRegionBtn) this.enhanceRegionBtn.disabled = false;
        this.notesBtn.disabled = false;
        this.updateNotesButtonState();
        this.markInBtn.disabled = false;
        this.markOutBtn.disabled = false;
        this.clearMarksBtn.disabled = false;
        this.exportBtn.disabled = false;
        this.exportDropdownBtn.disabled = false;
        this.prevBookmarkBtn.disabled = false;
        this.addBookmarkBtn.disabled = false;

        // Enable overlay toggle buttons
        if (this.toggleHudBtn) this.toggleHudBtn.disabled = false;
        if (this.toggleMiniMapBtn) this.toggleMiniMapBtn.disabled = false;
        if (this.toggleGraphsBtn) this.toggleGraphsBtn.disabled = false;
        if (this.toggleStreetViewBtn) this.toggleStreetViewBtn.disabled = false;
        if (this.toggleSlowMoBtn) this.toggleSlowMoBtn.disabled = false;
        if (this.toggleBirdsEyeBtn) this.toggleBirdsEyeBtn.disabled = false;
        this._updateOverlayButtonStates();
        this.nextBookmarkBtn.disabled = false;
        this.bookmarksListBtn.disabled = false;
        this.zoomOutBtn.disabled = false;
        this.zoomInBtn.disabled = false;
        this.zoomResetBtn.disabled = false;
        this.speedSelect.disabled = false;
        this.loopCheckbox.disabled = false;
        this.loopBtn.disabled = false;

        // Event navigation buttons
        this.prevEventBtn.disabled = this.currentEventIndex <= 0;
        this.nextEventBtn.disabled = this.currentEventIndex >= this.allEvents.length - 1;

        // Show mobile fullscreen button
        if (this.mobileFullscreenBtn) {
            this.mobileFullscreenBtn.classList.remove('hidden');
        }
    }

    /**
     * Update overlay button active states
     */
    _updateOverlayButtonStates() {
        if (this.toggleHudBtn) {
            this.toggleHudBtn.classList.toggle('active', this.telemetryOverlay?.isVisible || false);
        }
        if (this.toggleMiniMapBtn) {
            this.toggleMiniMapBtn.classList.toggle('active', this.miniMapOverlay?.isVisible || false);
        }
        if (this.toggleGraphsBtn) {
            this.toggleGraphsBtn.classList.toggle('active', this.telemetryGraphs?.isVisible || false);
        }
        if (this.toggleStreetViewBtn) {
            this.toggleStreetViewBtn.classList.toggle('active', this.streetViewOverlay?.isVisible || false);
        }
        if (this.toggleSlowMoBtn) {
            this.toggleSlowMoBtn.classList.toggle('active', this.incidentSlowMo?.isEnabled || false);
        }
        if (this.toggleBirdsEyeBtn) {
            this.toggleBirdsEyeBtn.classList.toggle('active', this.collisionReconstruction?.isVisible || false);
        }

        // Also update mobile more menu status
        this._updateMobileMoreMenuStatus();
    }

    /**
     * Update mobile more menu status indicators
     */
    _updateMobileMoreMenuStatus() {
        if (this.mobileHudStatus) {
            const isHudOn = this.telemetryOverlay?.isVisible || false;
            this.mobileHudStatus.textContent = isHudOn ? 'ON' : 'OFF';
            this.mobileHudStatus.closest('.mobile-more-option')?.classList.toggle('active', isHudOn);
        }
        if (this.mobileMiniMapStatus) {
            const isMapOn = this.miniMapOverlay?.isVisible || false;
            this.mobileMiniMapStatus.textContent = isMapOn ? 'ON' : 'OFF';
            this.mobileMiniMapStatus.closest('.mobile-more-option')?.classList.toggle('active', isMapOn);
        }
        // Sync mobile layout select with main layout select
        if (this.mobileLayoutSelect && this.layoutSelect) {
            this.mobileLayoutSelect.value = this.layoutSelect.value;
        }
    }

    /**
     * Handle mobile more menu actions
     */
    _handleMobileMoreAction(action) {
        switch (action) {
            case 'toggle-hud':
                this.toggleHudBtn?.click();
                break;
            case 'toggle-minimap':
                this.toggleMiniMapBtn?.click();
                break;
            case 'enhance':
                this.enhanceBtn?.click();
                this.mobileMoreMenu?.classList.add('hidden');
                break;
            case 'screenshot':
                this.screenshotBtn?.click();
                this.mobileMoreMenu?.classList.add('hidden');
                break;
            case 'export-video':
                this.exportBtn?.click();
                this.mobileMoreMenu?.classList.add('hidden');
                break;
            case 'insurance-report':
                document.getElementById('insuranceReportBtn')?.click();
                this.mobileMoreMenu?.classList.add('hidden');
                break;
        }
        // Update status after action
        setTimeout(() => this._updateMobileMoreMenuStatus(), 100);
    }

    /**
     * Set up the Street View button in the info bar
     */
    _setupStreetViewButton() {
        // Create tooltip element
        this.streetViewTooltip = document.createElement('div');
        this.streetViewTooltip.className = 'street-view-tooltip';
        this.streetViewTooltip.innerHTML = `
            <div class="coords">--</div>
            <div class="hint">Click to open Street View</div>
        `;
        this.streetViewBtn.appendChild(this.streetViewTooltip);

        // Click handler - open Google Street View
        this.streetViewBtn.addEventListener('click', () => {
            if (this.currentGpsLat !== null && this.currentGpsLng !== null) {
                const heading = this.currentGpsHeading || 0;
                const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${this.currentGpsLat},${this.currentGpsLng}&heading=${heading}`;
                window.open(url, '_blank', 'noopener,noreferrer');
            }
        });
    }

    /**
     * Update Street View button with current GPS position
     */
    _updateStreetViewButton(lat, lng, heading = 0) {
        this.currentGpsLat = lat;
        this.currentGpsLng = lng;
        this.currentGpsHeading = heading;

        if (this.streetViewBtn) {
            if (lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng)) {
                this.streetViewBtn.disabled = false;
                // Update tooltip with coordinates and heading
                if (this.streetViewTooltip) {
                    const latDir = lat >= 0 ? 'N' : 'S';
                    const lngDir = lng >= 0 ? 'E' : 'W';
                    const coordsEl = this.streetViewTooltip.querySelector('.coords');
                    if (coordsEl) {
                        let text = `${Math.abs(lat).toFixed(5)}° ${latDir}, ${Math.abs(lng).toFixed(5)}° ${lngDir}`;
                        if (heading !== null && heading !== undefined && !isNaN(heading)) {
                            const dir = this._headingToDirection(heading);
                            text += ` · ${Math.round(heading)}° ${dir}`;
                        }
                        coordsEl.textContent = text;
                    }
                }
            } else {
                this.streetViewBtn.disabled = true;
            }
        }
    }

    /**
     * Convert heading degrees to cardinal direction
     */
    _headingToDirection(heading) {
        const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const index = Math.round(((heading % 360) + 360) % 360 / 45) % 8;
        return dirs[index];
    }

    /**
     * Get current speed limit data (for telemetryGraphs callback)
     */
    getCurrentSpeedLimit() {
        return this.currentSpeedLimitData;
    }

    /**
     * Update speed limit display in timeline info bar
     * Fetches from cache (non-blocking) and triggers background loading
     */
    async _updateSpeedLimitDisplay(lat, lng) {
        if (!window.speedLimitService || !this.speedLimitDisplay) return;
        if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
            this.currentSpeedLimitData = null;
            this.speedLimitDisplay.classList.remove('visible');
            return;
        }

        // Check if position changed significantly (> 50m). A lookup that
        // failed is tried again once the servers' cool-down is over.
        const svc = window.speedLimitService;
        if (this.lastSpeedLimitGps) {
            const dist = this._haversineDistance(lat, lng, this.lastSpeedLimitGps.lat, this.lastSpeedLimitGps.lng);
            const retryDue = this._speedLimitShowsUnavailable && svc.nextRetryAt && svc.nextRetryAt(lat, lng) <= Date.now();
            if (dist < 50 && !retryDue) return; // Skip update if position hasn't changed much
        }
        this.lastSpeedLimitGps = { lat, lng };

        // Try to get cached speed limit first (non-blocking)
        const cached = svc.getSpeedLimitCached(lat, lng);
        if (cached) {
            this._showSpeedLimit(cached);
        } else {
            // Trigger async fetch (won't block playback)
            svc.getSpeedLimit(lat, lng).then(data => {
                // Ignore answers for a spot the car has since left
                if (this.lastSpeedLimitGps?.lat !== lat || this.lastSpeedLimitGps?.lng !== lng) return;
                if (data) {
                    this._showSpeedLimit(data);
                } else if (svc.getCellStatus && svc.getCellStatus(lat, lng) === 'unavailable') {
                    this._showSpeedLimitUnavailable();
                } else {
                    this._showSpeedLimit(null); // no posted limit on this road
                }
            }).catch(() => {});
        }
    }

    /**
     * Say in plain words that the limit couldn't be looked up, instead of
     * showing nothing (which reads as "no limit" or "broken"). Different from
     * a road with no posted limit, which shows no sign at all.
     */
    _showSpeedLimitUnavailable() {
        const svc = window.speedLimitService;
        if (!this.speedLimitDisplay || !svc) return;
        this.currentSpeedLimitData = null;
        this._speedLimitShowsUnavailable = true;
        const full = svc.describeUnavailable();
        const reason = svc.getStatus().reason;
        const shortText = reason === 'offline'
            ? 'Speed limit: offline'
            : (reason === 'unreachable' ? 'Speed limit: server unreachable' : 'Speed limit: server busy');
        const el = document.createElement('span');
        el.className = 'limit-unavailable';
        el.textContent = shortText;
        this.speedLimitDisplay.replaceChildren(el);
        this.speedLimitDisplay.title = `${full} TeslaCamViewer keeps retrying in the background.`;
        this.speedLimitDisplay.classList.add('visible');
    }

    /**
     * When lookups start working again, look up the current spot right away
     * instead of waiting for the car to move.
     */
    _onSpeedLimitStatus(status) {
        if (status?.state !== 'ok' || !this._speedLimitShowsUnavailable || !this.lastSpeedLimitGps) return;
        const { lat, lng } = this.lastSpeedLimitGps;
        const cached = window.speedLimitService?.getSpeedLimitCached(lat, lng);
        if (cached) this._showSpeedLimit(cached);
        else this._updateSpeedLimitDisplay(lat, lng);
    }

    /**
     * Show speed limit in the display
     */
    _showSpeedLimit(data) {
        this._speedLimitShowsUnavailable = false;
        this.speedLimitDisplay.title = 'Speed Limit';
        if (!data || data.limit === null) {
            this.currentSpeedLimitData = null;
            this.speedLimitDisplay.classList.remove('visible');
            return;
        }

        this.currentSpeedLimitData = data;

        // Determine display unit based on user setting
        const units = this.settingsManager?.get('telemetryOverlayUnits') || 'mph';
        const useMetric = units === 'kph';
        const displayLimit = useMetric ? data.limitKph : data.limitMph;

        // Update the display - US rectangular for mph, European circular for km/h
        if (useMetric) {
            // European-style circular sign with red border
            this.speedLimitDisplay.innerHTML = `
                <div class="limit-sign-eu">
                    <span class="limit-value">${displayLimit}</span>
                </div>
            `;
        } else {
            // US-style rectangular sign
            this.speedLimitDisplay.innerHTML = `
                <div class="limit-sign-us">
                    <span class="limit-label">SPEED</span>
                    <span class="limit-label">LIMIT</span>
                    <span class="limit-value">${displayLimit}</span>
                </div>
            `;
        }
        this.speedLimitDisplay.classList.add('visible');
    }

    /**
     * Queue GPS positions from telemetry for background speed limit loading
     */
    _queueSpeedLimitPositions(clipSeiData, totalDuration) {
        if (!window.speedLimitService || !clipSeiData) return;

        const positions = [];
        // The player's real clip lengths (#537)
        const durations = this.videoPlayer?.cachedClipDurations || [];

        // Extract GPS positions with their event times
        Object.keys(clipSeiData).forEach(clipIndexStr => {
            const clipIndex = parseInt(clipIndexStr);
            const clipData = clipSeiData[clipIndexStr];
            if (!clipData?.frames) return;

            const frameCount = clipData.frames.length;
            const clipDuration = VideoPlayer.clipLength(durations, clipIndex);
            const baseTime = VideoPlayer.clipStart(durations, clipIndex);

            // Sample every ~10 seconds (360 frames at 36fps)
            const sampleInterval = Math.max(1, Math.floor(frameCount / 6));

            for (let i = 0; i < frameCount; i += sampleInterval) {
                const frame = clipData.frames[i];
                if (frame.latitude_deg && frame.longitude_deg) {
                    const frameRatio = i / frameCount;
                    const eventTime = baseTime + (frameRatio * clipDuration);
                    positions.push({
                        lat: frame.latitude_deg,
                        lng: frame.longitude_deg,
                        time: eventTime
                    });
                }
            }
        });

        if (positions.length > 0) {
            // Store positions for building speed limit profile
            this._speedLimitPositions = positions;

            // Start background loading, prioritizing current playback position
            const currentTime = this.getAbsoluteEventTime(this.videoPlayer?.getCurrentTime() || 0);
            window.speedLimitService.queueForBackgroundLoading(positions, currentTime);

            // Build initial speed limit profile and update periodically
            this._buildSpeedLimitProfile();
            this._startSpeedLimitProfileRefresh();
        }
    }

    /**
     * Build speed limit profile from cached data and pass to telemetry graphs
     */
    _buildSpeedLimitProfile() {
        if (!this._speedLimitPositions?.length || !window.speedLimitService || !this.telemetryGraphs) return;

        const profilePoints = [];

        for (const pos of this._speedLimitPositions) {
            const cached = window.speedLimitService.getSpeedLimitCached(pos.lat, pos.lng);
            if (cached && cached.limit !== null && cached.limitMph !== undefined && cached.limitKph !== undefined) {
                profilePoints.push({
                    time: pos.time,
                    limitMph: cached.limitMph,
                    limitKph: cached.limitKph
                });
            }
        }

        if (profilePoints.length > 0) {
            // Sort by time
            profilePoints.sort((a, b) => a.time - b.time);

            const profile = {
                points: profilePoints,
                startTime: profilePoints[0].time,
                endTime: profilePoints[profilePoints.length - 1].time
            };

            this.telemetryGraphs.setSpeedLimitProfile(profile);
        }
    }

    /**
     * Start periodic refresh of speed limit profile to catch newly loaded data
     */
    _startSpeedLimitProfileRefresh() {
        // Clear any existing refresh interval
        this._stopSpeedLimitProfileRefresh();

        // Refresh every 3 seconds for first 30 seconds, then every 10 seconds
        let refreshCount = 0;
        const maxFastRefreshes = 10;

        this._speedLimitProfileRefreshInterval = setInterval(() => {
            this._buildSpeedLimitProfile();
            refreshCount++;

            // After 10 fast refreshes, slow down to every 10 seconds
            if (refreshCount === maxFastRefreshes) {
                this._stopSpeedLimitProfileRefresh();
                this._speedLimitProfileRefreshInterval = setInterval(() => {
                    this._buildSpeedLimitProfile();
                }, 10000);
            }
        }, 3000);
    }

    /**
     * Stop speed limit profile refresh
     */
    _stopSpeedLimitProfileRefresh() {
        if (this._speedLimitProfileRefreshInterval) {
            clearInterval(this._speedLimitProfileRefreshInterval);
            this._speedLimitProfileRefreshInterval = null;
        }
    }

    /**
     * Haversine distance in meters between two GPS coordinates
     */
    _haversineDistance(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * Start frame stepping (hold button for slow-mo)
     * @param {number} direction -1 for backward, 1 for forward
     */
    startFrameStepping(direction) {
        // A second start (touch plus mouse) must not leave an interval running
        this.stopFrameStepping();
        // Pause playback first
        if (this.videoPlayer.getIsPlaying()) {
            this.pause();
        }

        // Step one frame immediately
        this.stepFrame(direction);

        // Continue stepping while button is held
        this.frameStepInterval = setInterval(() => {
            this.stepFrame(direction);
        }, this.frameStepRate);
    }

    /**
     * Stop frame stepping
     */
    stopFrameStepping() {
        if (this.frameStepInterval) {
            clearInterval(this.frameStepInterval);
            this.frameStepInterval = null;
        }
    }

    /**
     * Step one frame in specified direction
     * @param {number} direction -1 for backward, 1 for forward
     */
    async stepFrame(direction) {
        const frameRate = 30; // Assume 30fps for Tesla cameras
        const frameDuration = 1 / frameRate;

        // Relative to where the player is when the step runs, not when the
        // key was pressed (audit 1.10). Negative values reach the previous clip.
        await this.videoPlayer.seekBy(frameDuration * direction);
    }

    /**
     * Frame step - single step for button click (used by bottom sheet)
     * @param {number} direction -1 for backward, 1 for forward
     */
    async frameStep(direction) {
        // Pause playback first
        if (this.videoPlayer.getIsPlaying()) {
            await this.pause();
        }
        await this.stepFrame(direction);
    }

    /**
     * Navigate to previous event
     */
    async previousEvent() {
        if (this.currentEventIndex > 0) {
            const prevEvent = this.allEvents[this.currentEventIndex - 1];
            await this.eventBrowser.selectEvent(prevEvent);
        }
    }

    /**
     * Navigate to next event
     */
    async nextEvent() {
        if (this.currentEventIndex < this.allEvents.length - 1) {
            const nextEvent = this.allEvents[this.currentEventIndex + 1];
            await this.eventBrowser.selectEvent(nextEvent);
        }
    }

    /**
     * Auto-play next event in continuous playback mode
     */
    async autoPlayNextEvent() {
        if (this.currentEventIndex >= this.allEvents.length - 1) {
            console.log('No more events to auto-play');
            return;
        }

        const nextEvent = this.allEvents[this.currentEventIndex + 1];
        console.log('Auto-playing next event:', nextEvent.name);

        // Select and play the next event
        await this.eventBrowser.selectEvent(nextEvent);
    }

    /**
     * Capture screenshot of current frame
     */
    async captureScreenshot() {
        try {
            await this.screenshotCapture.captureComposite({
                includeTimestamp: true,
                format: 'png',
                quality: 0.95
            });
        } catch (error) {
            console.error('Error capturing screenshot:', error);
            alert('Failed to capture screenshot. Make sure a video is loaded.');
        }
    }

    /**
     * Generate insurance report PDF for current event
     */
    async generateInsuranceReport() {
        if (!this.currentEvent) {
            alert('No event loaded. Please select an event first.');
            return;
        }

        // Show loading overlay
        this.showLoading('Generating Insurance Report...');

        try {
            // Set up progress callback
            this.insuranceReport.setProgressCallback((percent, message) => {
                this.updateLoading(`${message} (${percent}%)`);
            });

            await this.insuranceReport.generateReport();

            this.hideLoading();
        } catch (error) {
            console.error('Error generating insurance report:', error);
            this.hideLoading();
            alert(`Failed to generate insurance report: ${error.message}`);
        }
    }

    /**
     * Open notes modal for current event
     */
    openNotesModal() {
        if (!this.currentEvent) {
            alert('No event loaded. Please select an event first.');
            return;
        }
        this.notesManager.showModal(this.currentEvent);
    }

    /**
     * Update notes button state based on whether current event has notes
     */
    updateNotesButtonState() {
        if (!this.currentEvent || !this.notesBtn) return;

        // Use compoundKey for storage (multi-drive support), fallback to name for legacy events
        const storageKey = this.currentEvent.compoundKey || this.currentEvent.name || this.currentEvent.folder?.name;
        const hasNotes = this.notesManager.hasNotes(storageKey);

        if (hasNotes) {
            this.notesBtn.classList.add('has-notes');
        } else {
            this.notesBtn.classList.remove('has-notes');
        }
    }

    /**
     * Toggle Picture-in-Picture mode for front camera
     */
    async togglePictureInPicture() {
        try {
            // Check if PiP is supported
            if (!document.pictureInPictureEnabled) {
                alert('Picture-in-Picture is not supported in this browser.');
                return;
            }

            // Check if there's already a PiP window open
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
                this.pipBtn.classList.remove('active');
                return;
            }

            // Get the focused camera or default to front
            const focusCamera = this.layoutManager.focusCamera || 'front';
            const videoMap = {
                front: document.getElementById('videoFront'),
                back: document.getElementById('videoBack'),
                left_repeater: document.getElementById('videoLeft'),
                right_repeater: document.getElementById('videoRight')
            };

            const videoElement = videoMap[focusCamera];

            if (!videoElement || !videoElement.src) {
                alert('No video loaded. Please select an event first.');
                return;
            }

            // Request Picture-in-Picture
            await videoElement.requestPictureInPicture();
            this.pipBtn.classList.add('active');

            // Listen for PiP window close
            videoElement.addEventListener('leavepictureinpicture', () => {
                this.pipBtn.classList.remove('active');
            }, { once: true });

        } catch (error) {
            console.error('Error toggling Picture-in-Picture:', error);
            if (error.name === 'NotAllowedError') {
                alert('Picture-in-Picture was blocked. Try clicking the button again.');
            }
        }
    }

    /**
     * Mark in point
     */
    markIn() {
        const time = this.clipMarking.setInPoint();
        console.log(`Mark IN set at ${this.formatTime(time)}`);
    }

    /**
     * Mark out point
     */
    markOut() {
        const time = this.clipMarking.setOutPoint();
        console.log(`Mark OUT set at ${this.formatTime(time)}`);
    }

    /**
     * Clear all marks
     */
    clearMarks() {
        this.clipMarking.clearMarks();
        console.log('Marks cleared');
    }

    /**
     * Export video (current clip or marked section)
     * @param {string} camera - Camera to export ('all', 'front', 'back', 'left_repeater', 'right_repeater')
     */
    async exportVideo(camera = 'all') {
        // Declare cancelHandler in outer scope so catch block can access it
        let cancelHandler = null;
        // Tracks whether the user clicked Cancel — read after the await
        // resolves so we can show "Export Cancelled" instead of the green
        // success completion screen.
        let userCancelled = false;
        // Where the playhead was, to put it back afterwards (set once the export really starts)
        let restoreTo = null;

        // Auto-detect focused camera in Focus Mode
        if (camera === 'all' && this.layoutManager?.currentLayout === 'layout-focus') {
            camera = this.layoutManager.focusCamera || 'front';
        }

        try {
            if (this.videoExport?.isExporting) {
                alert(this._t('export.alreadyRunning'));
                return;
            }

            // Free tier: a 3rd new event today gets the limit message (naming today's two export events) before
            // anything else, not a confirm, a render and an "Export Complete" with no file (2026-11-19).
            if (this.videoExport?._checkExportAccess && !(await this.videoExport._checkExportAccess())) {
                return;
            }

            const marks = this.clipMarking.getMarks();
            const currentAbsoluteTime = this.getAbsoluteEventTime(this.videoPlayer.getCurrentTime());

            // Camera label for display
            const cameraLabels = {
                all: this._t('export.cameraAll'),
                front: this._t('export.cameraFront'),
                back: this._t('export.cameraBack'),
                left_repeater: this._t('export.cameraLeft'),
                right_repeater: this._t('export.cameraRight'),
                left_pillar: this._t('export.cameraLeftPillar'),
                right_pillar: this._t('export.cameraRightPillar')
            };
            const cameraLabel = cameraLabels[camera] || camera;

            // Determine export range
            // OUT-only means "from start of event to OUT marker"
            // IN-only means "from IN marker to end of event"
            // Both means "from IN to OUT"
            // Neither means "from current position to end of event"
            let exportStartTime;
            if (marks.inPoint !== null) {
                exportStartTime = marks.inPoint;
            } else if (marks.outPoint !== null) {
                exportStartTime = 0; // OUT-only: start from beginning
            } else {
                exportStartTime = currentAbsoluteTime;
            }
            const exportEndTime = marks.outPoint;

            // Determine what will be exported
            let exportRange;
            if (marks.inPoint !== null && marks.outPoint !== null) {
                exportRange = this._t('export.rangeMarked', { marks: this.clipMarking.getMarkInfo() });
            } else if (marks.inPoint !== null) {
                exportRange = this._t('export.rangeFromIn');
            } else if (marks.outPoint !== null) {
                exportRange = this._t('export.rangeToOut');
            } else {
                exportRange = this._t('export.rangeFromCurrent');
            }

            // Confirm export
            const currentSpeed = parseFloat(this.speedSelect.value) || 1;
            const question = currentSpeed !== 1
                ? this._t('export.confirmAtSpeed', { range: exportRange, camera: cameraLabel, speed: currentSpeed })
                : this._t('export.confirm', { range: exportRange, camera: cameraLabel });
            const message = `${question}\n\n⏱️ ${this._t('export.confirmDuration')}\n\n${this._t('export.confirmDontSwitch')}`;

            if (!confirm(message)) {
                return;
            }

            // Validate export range
            if (exportEndTime !== null && exportStartTime >= exportEndTime) {
                alert(this._t('export.invalidRange'));
                return;
            }
            // Nothing left to export from here: no OUT mark and the playhead (or the IN mark) at the end of the
            // event. That used to run, record nothing and end as a "complete" 110-byte WebM: after an export with
            // no marks the playhead is left at the end, so the next one started there (2026-11-19).
            const eventEnd = this.timeline?.totalDuration || 0;
            if (exportEndTime === null && eventEnd > 0 && eventEnd - exportStartTime < VideoExport.MIN_EXPORT_SECS) {
                alert(this._t('export.nothingToExport', { position: this.formatTime(exportStartTime), end: this.formatTime(eventEnd) }));
                return;
            }

            // Disable all controls during export
            this.disableControls();
            restoreTo = currentAbsoluteTime;

            // Load plate blur model if plate blurring is enabled
            const blurPlatesEnabled = this.settingsManager.get('blurLicensePlates') === true;
            if (blurPlatesEnabled && this.plateBlur && !this.plateBlur.isReady()) {
                console.log('[Export] Loading license plate detection model...');
                this.loadingOverlay.classList.remove('hidden');
                this.loadingOverlay.style.display = 'flex';
                this.loadingOverlay.style.position = 'fixed';
                this.loadingOverlay.style.top = '0';
                this.loadingOverlay.style.left = '0';
                this.loadingOverlay.style.right = '0';
                this.loadingOverlay.style.bottom = '0';
                this.loadingOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
                this.loadingOverlay.style.zIndex = '9999';
                this.loadingText.innerHTML = `<div style="text-align: center;"><div style="font-size: 1.1rem; color: #ffffff;">${FolderParser.escapeHtml(this._t('export.loadingPlateModel'))}</div><div style="font-size: 0.9rem; color: #a0a0a0; margin-top: 0.5rem;">${FolderParser.escapeHtml(this._t('export.loadingPlateModelHint'))}</div></div>`;
                try {
                    const loaded = await this.plateBlur.loadModel();
                    if (!loaded) {
                        console.warn('[Export] Failed to load plate blur model, continuing without blur');
                    } else {
                        console.log('[Export] Plate blur model loaded successfully');
                    }
                } catch (modelError) {
                    console.warn('[Export] Plate blur model error:', modelError);
                }
            }

            // Show loading overlay with progress display
            this.loadingOverlay.classList.remove('hidden');
            this.loadingOverlay.style.display = 'flex';
            this.loadingOverlay.style.position = 'fixed';
            this.loadingOverlay.style.top = '0';
            this.loadingOverlay.style.left = '0';
            this.loadingOverlay.style.right = '0';
            this.loadingOverlay.style.bottom = '0';
            this.loadingOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
            this.loadingOverlay.style.zIndex = '9999';
            // Create stable HTML structure with ID'd elements for updates (don't recreate button on progress)
            const exportTitle = camera === 'all' ? this._t('export.titleVideo') : cameraLabel.charAt(0).toUpperCase() + cameraLabel.slice(1);
            this.loadingText.innerHTML = `
                <div style="text-align: center;">
                    <div id="exportTitle" style="font-size: 1.2rem; font-weight: bold; margin-bottom: 0.5rem; color: #ffffff;">
                        ${FolderParser.escapeHtml(this._t('export.starting'))}
                    </div>
                    <div id="exportProgress" style="font-size: 0.9rem; color: #a0a0a0;">
                        ${FolderParser.escapeHtml(this._t('export.preparingVideo'))}
                    </div>
                    <div id="exportSpeedNotice" style="min-height: 1.5rem;"></div>
                    <div style="width: 300px; height: 8px; background: #3a3a3a; border-radius: 4px; margin: 1rem auto; overflow: hidden;">
                        <div id="exportProgressBar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #4a9eff, #6bb1ff); transition: width 0.1s linear;"></div>
                    </div>
                    <button id="cancelExportBtn" style="margin-top: 1rem; padding: 0.5rem 1.5rem; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9rem;">
                        ${FolderParser.escapeHtml(this._t('common.cancel'))}
                    </button>
                </div>
            `;

            // Small delay to ensure overlay is visible
            await new Promise(resolve => setTimeout(resolve, 100));

            // Get references to updateable elements (stable, not recreated)
            const titleEl = document.getElementById('exportTitle');
            const progressEl = document.getElementById('exportProgress');
            const speedNoticeEl = document.getElementById('exportSpeedNotice');
            const progressBarEl = document.getElementById('exportProgressBar');
            const cancelBtn = document.getElementById('cancelExportBtn');

            // Setup cancel button handler directly on the button (stable reference)
            let cancelInProgress = false;
            cancelHandler = () => {
                if (!cancelInProgress) {
                    cancelInProgress = true;
                    userCancelled = true;
                    console.log('Cancel button clicked');
                    this.videoExport.cancelExport();
                    cancelBtn.removeEventListener('click', cancelHandler);
                    // Don't hide loading here — let the post-await flow show
                    // the "Export Cancelled" amber completion screen so the
                    // user gets clear feedback that the cancel was honored.
                    this.enableControls();
                }
            };
            cancelBtn.addEventListener('click', cancelHandler);

            // ETA smoothing state — trailing 8-second window of (timestamp, percent)
            // samples. Rate from window endpoints smooths instantaneous jumps
            // (e.g. Phase 1 -> Phase 2 transition, burst bitmap writes).
            // A light EMA on top stops any residual twitch in the displayed value.
            const etaSamples = [];
            const ETA_WINDOW_MS = 8000;
            const ETA_MIN_SAMPLES = 5;
            const ETA_EMA_ALPHA = 0.25;
            let smoothedEta = null;

            // Progress callback - only updates text content, NOT innerHTML (button stays stable)
            const progressCallback = (percent, currentTime, endTime, startTime) => {
                // Update loading overlay with progress
                const elapsed = currentTime - (startTime || 0);
                const total = endTime - (startTime || 0);
                const remaining = Math.max(0, total - elapsed);

                // Ensure valid numbers
                const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
                const safeElapsed = Math.max(0, elapsed);
                const safeTotal = Math.max(0, total);
                const safeRemaining = Math.max(0, remaining);

                // Get export status for additional feedback
                const exportStatus = this.videoExport.getExportStatus();

                // Calculate a smoothed wall-clock ETA. Uses an 8-second sliding
                // window so rate reflects recent progress (not cumulative over
                // the whole export), then an EMA on top to damp remaining twitch.
                let wallEta = 0;
                let wallElapsed = 0;
                const now = Date.now();
                // the unrounded percent: a slow encode moves less than 1 % in the 8 s window, and rounded it looked
                // like no progress at all (the line then fell back to "Video: 00:00 / 00:06")
                const rawPct = Math.min(100, Math.max(0, Number(percent) || 0));
                if (etaSamples.length && rawPct < etaSamples[etaSamples.length - 1].pct - 0.5) {
                    // progress went back (an encoder restart from frame 0): the old samples and estimate don't apply
                    etaSamples.length = 0;
                    smoothedEta = null;
                }
                if (exportStatus.wallStartTime) {
                    wallElapsed = (now - exportStatus.wallStartTime) / 1000;

                    etaSamples.push({ t: now, pct: rawPct });
                    while (etaSamples.length > 1 && (now - etaSamples[0].t) > ETA_WINDOW_MS) {
                        etaSamples.shift();
                    }

                    if (etaSamples.length >= ETA_MIN_SAMPLES && rawPct < 100) {
                        const oldest = etaSamples[0];
                        const dt = (now - oldest.t) / 1000;
                        const dpct = rawPct - oldest.pct;
                        if (dt > 0.5 && dpct > 0) {
                            const windowRate = dpct / dt; // percent per second
                            const rawEta = (100 - rawPct) / windowRate;
                            smoothedEta = (smoothedEta == null)
                                ? rawEta
                                : smoothedEta * (1 - ETA_EMA_ALPHA) + rawEta * ETA_EMA_ALPHA;
                            wallEta = smoothedEta;
                        }
                    }
                }

                // Update only the text/style of existing elements (button stays untouched)
                if (titleEl) {
                    titleEl.textContent = this._t('export.progressTitle', { what: exportTitle, percent: safePercent });
                }
                if (progressEl) {
                    // Wall-clock time: elapsed, and the time left when there is an estimate: from the recent progress,
                    // else from the encoder's own frames per second. Never the video position ("Video: 00:00 /
                    // 00:06"): it reads as a reset whenever an estimate is briefly missing (between stages, after
                    // a restart), which is how it showed on a test laptop, 2026-11-21. This is the only writer.
                    let eta = (wallEta > 0 && wallEta < 7200) ? wallEta : 0;
                    const encI = exportStatus.encoder;
                    if (!eta && encI && encI.totalFrames > 0 && encI.framesDone > 0) {
                        const secs = (performance.now() - encI.startedAt) / 1000;
                        const fps = secs > 2 ? encI.framesDone / secs : 0;
                        if (fps > 0) eta = Math.min(7199, Math.max(0, (encI.totalFrames - encI.framesDone) / fps));
                    }
                    const text = (eta > 0 && safePercent < 100)
                        ? this._t('export.elapsedRemaining', { elapsed: this.formatTime(wallElapsed), remaining: this.formatTime(eta) })
                        : this._t('export.elapsedOnly', { elapsed: this.formatTime(wallElapsed) });
                    if (progressEl.textContent !== text) {
                        progressEl.textContent = text;
                        // export debug log (tcv.exportDebug): every write of this line, with who called the progress
                        if (window.VideoExportFast?._dbg) {
                            const caller = (new Error().stack || '').split('\n').slice(2, 4).map(x => x.trim()).join(' <- ');
                            window.VideoExportFast.dbg('progress line', { text, percent: Math.round(rawPct * 10) / 10, caller });
                        }
                    }
                }
                if (speedNoticeEl) {
                    const notes = [];
                    if (exportStatus.speedWasReduced && exportStatus.currentSpeed !== exportStatus.originalSpeed) {
                        notes.push(`<div style="color: #ffb800; font-size: 0.85rem;">${FolderParser.escapeHtml(this._t('export.speedReduced', { speed: exportStatus.currentSpeed }))}</div>`);
                    }
                    // MP4 (H.264) on the browser's software encoder can be the slowest export, and so can WebM or
                    // MP4 (VP9) on the software VP9 encoder: say so, with the measured frame rate (the time left is
                    // the line above, from the same progress)
                    const enc = exportStatus.encoder;
                    if (enc && enc.software) {
                        const secs = (performance.now() - enc.startedAt) / 1000;
                        const rate = secs > 2 && enc.framesDone > 0 ? enc.framesDone / secs : 0;
                        const rateText = rate > 0
                            ? this._t('export.softwareH264Rate', { fps: rate < 10 ? rate.toFixed(1) : Math.round(rate) })
                            : '';
                        notes.push(`<div id="exportSoftwareNote" style="color: #9cc7ff; font-size: 0.85rem; max-width: 420px; margin: 0.5rem auto 0;">${FolderParser.escapeHtml(this._t(enc.name === 'vp9' ? 'export.softwareVp9' : enc.name === 'vp8' ? 'export.softwareVp8' : 'export.softwareH264'))}${rateText ? `<br>${FolderParser.escapeHtml(rateText)}` : ''}</div>`);
                    }
                    const html = notes.join('');
                    if (speedNoticeEl.innerHTML !== html) speedNoticeEl.innerHTML = html;
                }
                if (progressBarEl) {
                    progressBarEl.style.width = `${safePercent}%`;
                }
            };

            // Get format from export dropdown (fallback to settings)
            const exportFormatSelect = document.getElementById('exportFormatSelect');
            const format = exportFormatSelect ? exportFormatSelect.value : this.settingsManager.get('exportFormat');

            // Unified export path: single-camera is just a one-camera layout override
            await this.videoExport.exportFrameByFrame({
                format: format,
                quality: 0.9,
                startTime: exportStartTime,
                endTime: exportEndTime,
                includeOverlay: true,
                fps: 30,
                onProgress: progressCallback,
                singleCamera: camera !== 'all' ? camera : null
            });

            // Remove cancel handler (cancelBtn is stable, not recreated)
            if (cancelBtn && cancelHandler) {
                cancelBtn.removeEventListener('click', cancelHandler);
            }
            await this._restorePlayheadAfterExport(restoreTo);

            // "Export Complete" only when a checked file was really saved. An export that ended without one (and
            // wasn't cancelled) says so instead of claiming success.
            if (!userCancelled && this.videoExport.lastExportSaved !== true) {
                this.hideLoading();
                this.enableControls();
                alert(this._t('export.notSaved'));
                return;
            }

            // Show completion overlay — amber/cancelled variant if the user
            // clicked Cancel mid-export. It says how long the export took.
            const wallStart = this.videoExport.getExportStatus().wallStartTime;
            this.showExportComplete({ cancelled: userCancelled, tookSec: wallStart ? (Date.now() - wallStart) / 1000 : null });

        } catch (error) {
            // Try to clean up cancel handler - cancelBtn may or may not exist depending on where error occurred
            const cleanupBtn = document.getElementById('cancelExportBtn');
            if (cleanupBtn && cancelHandler) {
                cleanupBtn.removeEventListener('click', cancelHandler);
            }
            this.hideLoading();
            this.enableControls();
            await this._restorePlayheadAfterExport(restoreTo);

            if (error?.code === 'EXPORT_LIMIT') {
                // The free export limit refused it: its message is already on screen, nothing was rendered
                console.warn('Export stopped:', error.message);
                return;
            }
            // Don't show error alert for user-initiated cancellation
            if (userCancelled || (error.message && error.message.includes('cancelled'))) {
                console.log('Export cancelled by user');
                // Same amber "Export Cancelled" screen as when the export
                // stops on its own after Cancel (WebM/GIF reject instead, #525)
                this.showExportComplete({ cancelled: true });
            } else {
                if (VideoExport.isHandledFailure(error)) console.warn('Export stopped:', error.message);
                else console.error('Export failed:', error);
                // Match common GPU-side failure patterns and offer a clearer
                // recovery path. The raw error message from VideoEncoder /
                // MediaRecorder / VideoDecoder is usually opaque ("Operation
                // failed") so without this the user just sees a useless
                // string. The diagnostics ring buffer captures the full
                // context — Settings → Diagnostics → "Console Log Capture"
                // is where to find it.
                const msg = String(error?.message || '').toLowerCase();
                const looksGpu = msg.includes('context lost')
                    || msg.includes('device lost')
                    || msg.includes('webgl')
                    || msg.includes('webgpu')
                    || (msg.includes('videoencoder') && msg.includes('error'))
                    || msg.includes('operationerror')
                    || error?.name === 'OperationError'
                    || this.videoExport?._renderCanvasLost
                    || this.videoExport?._playbackCanvasLost;

                if (error?.code === 'ENCODER_STALLED') {
                    // The encoder stopped answering (VideoExportFast watchdog)
                    alert(this._t('export.encoderStalled', { codec: error.codec?.muxName || '?' }));
                } else if (error?.code === 'NO_ENCODER') {
                    // No encoder here took the export at any size (VideoExportFast.prepare), found before rendering.
                    // WebM says so and suggests MP4 (H.264) (the other message suggests WebM)
                    alert(this._t(error.format === 'webm' ? 'export.noWebmEncoder' : 'export.noEncoder', { size: `${error.width} × ${error.height}` }));
                } else if (error?.code === 'BAD_OUTPUT') {
                    // The finished file isn't real (VideoExport._verifyOutput): nothing was saved
                    const whyKey = {
                        tiny: 'export.badOutput_tiny', frames: 'export.badOutput_frames', length: 'export.badOutput_length'
                    }[error.reasonKey] || 'export.badOutput_unreadable';
                    const why = this._t(whyKey, error.reasonParams || {});
                    alert(this._t('export.badOutput', { format: error.what || '', reason: why }));
                } else if (looksGpu) {
                    console.error('[ExportGPU] Failure pattern suggests GPU context loss or hardware encoder error — see preceding [GPUContextLost]/[MediaRecorderError]/[VideoExportFast]/[FastFrameExtractor] log lines for codec + dimensions');
                    alert(this._t('export.gpuFailed'));
                } else {
                    alert(this._t('export.unableToComplete', { error: error.message }));
                }
            }
        }
    }

    /**
     * After an export, put the playhead back where it was. The WebM, GIF and single-camera exports step the
     * player through the range, so it was left at the export's end: with no marks that is the end of the event,
     * and the next export ("from the current position") then had nothing to record (a 110-byte WebM).
     * @param {number} absoluteTime  event time before the export
     */
    async _restorePlayheadAfterExport(absoluteTime) {
        if (!Number.isFinite(absoluteTime) || !this.videoPlayer?.currentEvent) return;
        try {
            const now = this.getAbsoluteEventTime(this.videoPlayer.getCurrentTime());
            if (Math.abs(now - absoluteTime) < 0.05) return;
            await this.videoPlayer.seekToEventTime(absoluteTime);
            await this.videoPlayer.pause();
        } catch (e) {
            console.warn('[Export] Could not put the playhead back after the export:', e?.message || e);
        }
    }

    /**
     * Add bookmark at current position
     */
    addBookmark() {
        if (!this.currentEvent) return;
        const bookmark = this.timeline.addBookmark();
        console.log(`Bookmark added: ${bookmark.label} at ${this.formatTime(bookmark.time)}`);
    }

    /**
     * Jump to previous bookmark
     */
    jumpToPreviousBookmark() {
        if (!this.currentEvent) return;
        console.log('Jump to previous bookmark. Current time:', this.timeline.currentTime);
        console.log('Bookmarks:', this.timeline.bookmarks);
        const bookmark = this.timeline.jumpToPreviousBookmark();
        if (bookmark) {
            console.log(`Jumped to bookmark: ${bookmark.label} at ${this.formatTime(bookmark.time)}`);
        } else {
            console.log('No previous bookmark found');
        }
    }

    /**
     * Jump to next bookmark
     */
    jumpToNextBookmark() {
        if (!this.currentEvent) return;
        console.log('Jump to next bookmark. Current time:', this.timeline.currentTime);
        console.log('Bookmarks:', this.timeline.bookmarks);
        const bookmark = this.timeline.jumpToNextBookmark();
        if (bookmark) {
            console.log(`Jumped to bookmark: ${bookmark.label} at ${this.formatTime(bookmark.time)}`);
        } else {
            console.log('No next bookmark found');
        }
    }

    /**
     * Toggle bookmarks dropdown visibility
     */
    toggleBookmarksDropdown() {
        const isHidden = this.bookmarksDropdown.classList.contains('hidden');
        if (isHidden) {
            this.updateBookmarksList();
            this.bookmarksDropdown.classList.remove('hidden');
            // Close export dropdown if open
            this.exportDropdown.classList.add('hidden');
        } else {
            this.bookmarksDropdown.classList.add('hidden');
        }
    }

    /**
     * Toggle export dropdown visibility
     */
    toggleExportDropdown() {
        const isHidden = this.exportDropdown.classList.contains('hidden');
        if (isHidden) {
            // Update the "All Cameras" option to show current layout name
            this.updateExportLayoutName();
            this.exportDropdown.classList.remove('hidden');
            // Close bookmarks dropdown if open
            this.bookmarksDropdown.classList.add('hidden');
        } else {
            this.exportDropdown.classList.add('hidden');
        }
    }

    /**
     * Update export dropdown to show current layout name
     */
    updateExportLayoutName() {
        const exportVideoBtn = document.getElementById('exportVideoBtn');
        if (exportVideoBtn && this.layoutManager) {
            const config = this.layoutManager.getCurrentConfig();
            const layoutName = config?.name || this.layoutManager.getCurrentLayout();
            // The layout menu's own (translated) name when it lists this layout; else
            // the config name with each word capitalized
            const layoutSelect = document.getElementById('layoutSelect');
            const option = layoutSelect?.selectedOptions?.[0];
            const displayName = FolderParser.escapeHtml(option && option.value === this.layoutManager.getCurrentLayout()
                ? option.textContent.trim()
                : layoutName
                    .replace(/^layout-/, '')
                    .replace(/-/g, ' ')
                    .replace(/\b\w/g, c => c.toUpperCase()));
            // Keep the icon and update the text
            const icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>`;
            exportVideoBtn.innerHTML = `${icon}<span>${FolderParser.escapeHtml(this._t('export.exportVideo'))}<span class="layout-name-line">${displayName}</span></span>`;
        }
    }

    /**
     * Toggle mobile sidebar drawer
     */
    toggleSidebar() {
        const isOpen = this.sidebar.classList.contains('open');
        if (isOpen) {
            this.closeSidebar();
        } else {
            this.openSidebar();
        }
    }

    /**
     * Open mobile sidebar drawer
     */
    openSidebar() {
        this.sidebar.classList.add('open');
        this.sidebarOverlay.classList.remove('hidden');
        this.sidebarOverlay.classList.add('visible');
        document.body.style.overflow = 'hidden'; // Prevent background scroll
    }

    /**
     * Close mobile sidebar drawer
     */
    closeSidebar() {
        this.sidebar.classList.remove('open');
        this.sidebarOverlay.classList.remove('visible');
        this.sidebarOverlay.classList.add('hidden');
        document.body.style.overflow = '';
    }

    /**
     * Update the bookmarks list in the dropdown
     */
    updateBookmarksList() {
        const bookmarks = this.timeline.getBookmarks();

        if (bookmarks.length === 0) {
            this.bookmarksList.innerHTML = '<p class="no-bookmarks">No bookmarks yet</p>';
            this.clearAllBookmarksBtn.style.display = 'none';
            return;
        }

        this.clearAllBookmarksBtn.style.display = 'block';

        // Sort by time
        const sortedBookmarks = [...bookmarks].sort((a, b) => a.time - b.time);

        // Labels and ids can come from a drive's backup file: escape them (#523)
        const esc = FolderParser.escapeHtml;
        this.bookmarksList.innerHTML = sortedBookmarks.map(bookmark => `
            <div class="bookmark-item" data-bookmark-id="${esc(bookmark.id)}" data-time="${esc(Number(bookmark.time))}">
                <span class="bookmark-item-time">${esc(this.formatTime(bookmark.time))}</span>
                <span class="bookmark-item-label">${esc(bookmark.label)}</span>
                <button class="bookmark-delete-btn" data-bookmark-id="${esc(bookmark.id)}" title="Delete bookmark">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                    </svg>
                </button>
            </div>
        `).join('');

        // Add click handlers for jumping to bookmarks
        this.bookmarksList.querySelectorAll('.bookmark-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.bookmark-delete-btn')) return;
                const time = parseFloat(item.dataset.time);
                if (this.timeline.onSeek) {
                    this.timeline.onSeek(time);
                }
                this.bookmarksDropdown.classList.add('hidden');
            });
        });

        // Add click handlers for delete buttons
        this.bookmarksList.querySelectorAll('.bookmark-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = parseInt(btn.dataset.bookmarkId, 10);
                this.timeline.removeBookmark(id);
                this.updateBookmarksList();
            });
        });
    }

    /**
     * Clear all bookmarks for current event
     */
    clearAllBookmarks() {
        if (!this.currentEvent) return;
        if (confirm('Remove all bookmarks for this event?')) {
            this.timeline.clearBookmarks();
            this.updateBookmarksList();
        }
    }

    /**
     * Format time in MM:SS
     * @param {number} seconds
     * @returns {string}
     */
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Translated text from the locale files (i18n.js), or the key when i18n isn't loaded
     * @param {string} key
     * @param {Object} params - {{placeholder}} values
     * @returns {string}
     */
    _t(key, params = {}) {
        return window.i18n ? window.i18n.t(key, params) : key;
    }

    /**
     * Handle keyboard shortcuts
     * @param {KeyboardEvent} event
     */
    async handleKeyPress(event) {
        // Ignore if typing in input
        if (event.target.tagName === 'INPUT') return;
        // Not behind a modal, during an export, in other fields or with
        // Ctrl/Meta/Alt (#532). An open modal's own Escape handler closes it.
        if (this._shortcutsBlocked(event)) return;

        switch (event.code) {
            case 'Space':
                event.preventDefault();
                if (this.videoPlayer.getIsPlaying()) {
                    this.pause();
                } else {
                    this.play();
                }
                break;

            case 'ArrowLeft':
                event.preventDefault();
                if (event.shiftKey) {
                    this.previousClip();
                } else {
                    // Seek back 5 seconds (allow negative to trigger previous clip)
                    await this.videoPlayer.seekBy(-5);  // from where the player is when it runs (audit 1.10)
                }
                break;

            case 'ArrowRight':
                event.preventDefault();
                if (event.shiftKey) {
                    this.nextClip();
                } else {
                    // Seek forward 5 seconds
                    await this.videoPlayer.seekBy(5);
                }
                break;

            case 'KeyL':
                event.preventDefault();
                this.layoutManager.nextLayout();
                this.layoutSelect.value = this.layoutManager.getCurrentLayout();
                break;

            // Note: [ and ] are now used for bookmark navigation (see below)
            // Frame stepping moved to , and . keys

            case 'KeyH':
            case 'Slash':
                // ? or H for help
                if (event.key === '?' || event.code === 'KeyH') {
                    event.preventDefault();
                    this.helpModal.toggle();
                }
                break;

            case 'Comma':
                // , for frame back (pairs with . for frame forward)
                event.preventDefault();
                this.stepFrame(-1);
                break;

            case 'KeyQ':
                // Q for quick settings
                event.preventDefault();
                this.settingsManager.showSettingsModal();
                break;

            case 'KeyI':
                // I for mark in
                event.preventDefault();
                if (!this.markInBtn.disabled) {
                    this.markIn();
                }
                break;

            case 'KeyO':
                // O for mark out
                event.preventDefault();
                if (!this.markOutBtn.disabled) {
                    this.markOut();
                }
                break;

            case 'KeyS':
                // S for screenshot
                event.preventDefault();
                if (!this.screenshotBtn.disabled) {
                    this.captureScreenshot();
                }
                break;

            case 'KeyT':
                // T for telemetry overlay toggle
                event.preventDefault();
                if (this.telemetryOverlay) {
                    this.telemetryOverlay.toggle();
                }
                break;

            case 'KeyM':
                // M for mini-map toggle
                event.preventDefault();
                if (this.miniMapOverlay) {
                    this.miniMapOverlay.toggle();
                }
                break;

            // Note: 'G' keyboard shortcut removed - telemetry graphs are now always visible in sidebar

            case 'KeyP':
                // P for Picture-in-Picture
                event.preventDefault();
                if (!this.pipBtn.disabled) {
                    this.togglePictureInPicture();
                }
                break;

            case 'KeyN':
                // N for Notes
                event.preventDefault();
                if (!this.notesBtn.disabled) {
                    this.openNotesModal();
                }
                break;

            case 'KeyE':
                // E for export
                event.preventDefault();
                if (!this.exportBtn.disabled) {
                    this.exportVideo();
                }
                break;

            case 'KeyD':
                // D for detect plates
                event.preventDefault();
                if (window.plateEnhancer && this.currentEvent) {
                    window.plateEnhancer.autoDetectPlates();
                }
                break;

            case 'KeyF':
                // F for fullscreen
                event.preventDefault();
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    document.documentElement.requestFullscreen();
                }
                break;

            case 'Digit1':
            case 'Digit2':
            case 'Digit3':
            case 'Digit4':
            case 'Digit5':
            case 'Digit6':
                // 1-6 for focus camera (includes pillar cameras)
                event.preventDefault();
                const cameras = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
                const cameraIndex = parseInt(event.key) - 1;
                if (cameraIndex >= 0 && cameraIndex < cameras.length) {
                    this.layoutManager.setLayout('layout-focus');
                    this.layoutManager.setFocusCamera(cameras[cameraIndex]);
                    this.layoutSelect.value = 'layout-focus';
                    document.getElementById('focusCameraControl').style.display = 'flex';
                    document.getElementById('focusCameraSelect').value = cameras[cameraIndex];
                }
                break;

            case 'Digit0':
                // 0 to reset speed to 1x
                event.preventDefault();
                this.speedSelect.value = '1';
                this.videoPlayer.setPlaybackRate(1);
                break;

            case 'Equal':
            case 'NumpadAdd':
                // + to increase speed
                event.preventDefault();
                this.changeSpeed(1);
                break;

            case 'Minus':
            case 'NumpadSubtract':
                // - to decrease speed
                event.preventDefault();
                this.changeSpeed(-1);
                break;

            case 'PageUp':
                // Previous event
                event.preventDefault();
                if (!this.prevEventBtn.disabled) {
                    this.previousEvent();
                }
                break;

            case 'PageDown':
                // Next event
                event.preventDefault();
                if (!this.nextEventBtn.disabled) {
                    this.nextEvent();
                }
                break;

            case 'Home':
                // Go to start
                event.preventDefault();
                if (this.currentEvent) {
                    this.videoPlayer.seekToEventTime(0);
                }
                break;

            case 'End':
                // Go to end
                event.preventDefault();
                if (this.currentEvent) {
                    const duration = this.timeline.duration;
                    this.videoPlayer.seekToEventTime(Math.max(0, duration - 1));
                }
                break;

            case 'Escape':
                // Exit mobile fullscreen, clear marks or close modals
                event.preventDefault();
                if (this.isMobileFullscreen) {
                    this.exitMobileFullscreen();
                } else if (this.clipMarking.hasMarks()) {
                    this.clearMarks();
                }
                break;

            case 'KeyB':
                // B for bookmark
                event.preventDefault();
                this.addBookmark();
                break;

            case 'BracketLeft':
                // [ for previous bookmark
                event.preventDefault();
                this.jumpToPreviousBookmark();
                break;

            case 'BracketRight':
                // ] for next bookmark
                event.preventDefault();
                this.jumpToNextBookmark();
                break;

            case 'ArrowUp':
                // Up arrow for select previous event in list
                event.preventDefault();
                if (!this.prevEventBtn.disabled) {
                    this.previousEvent();
                }
                break;

            case 'ArrowDown':
                // Down arrow for select next event in list
                event.preventDefault();
                if (!this.nextEventBtn.disabled) {
                    this.nextEvent();
                }
                break;

            case 'Period':
                // . for frame forward
                event.preventDefault();
                this.stepFrame(1);
                break;
        }
    }

    /**
     * True when a player shortcut must not run for this key press (#532):
     * a Ctrl/Meta/Alt combination (browser, OS and the Ctrl+K palette keep
     * those; Shift combinations still work), typing in a field, an export
     * running, or a modal, dialog or popover open.
     * @param {KeyboardEvent} event
     * @returns {boolean}
     */
    _shortcutsBlocked(event) {
        if (event.ctrlKey || event.metaKey || event.altKey) return true;
        const tgt = event.target;
        const tag = tgt && tgt.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (tgt && tgt.isContentEditable)) return true;
        if (this.videoExport && this.videoExport.isExporting) return true;
        return this._openModalElement() !== null;
    }

    /**
     * The modal, dialog or popover that is open and covers the player, or
     * null. Modals here are marked by class name (settings-modal, help-modal,
     * notes-modal, stats-modal, command-palette, plate-enhancer-dialog,
     * severity-popover, ...) or role="dialog"; open = rendered and visible.
     * The loading overlay counts too (exporting, "Loading event...").
     * @returns {Element|null}
     */
    _openModalElement() {
        const sel = '[role="dialog"], [aria-modal="true"], [class*="modal"], [class*="dialog"], ' +
            '[class*="backdrop"], [class*="popover"], .command-palette, .loading-overlay';
        for (const el of document.querySelectorAll(sel)) {
            if (el.classList.contains('hidden')) continue;
            if (el.getClientRects().length === 0) continue;   // display: none, or inside a hidden parent
            const cs = getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
            return el;
        }
        return null;
    }

    /**
     * Change playback speed by step
     * @param {number} direction 1 for faster, -1 for slower
     */
    changeSpeed(direction) {
        const speeds = ['0.25', '0.5', '0.75', '1', '1.25', '1.5', '2', '5', '10'];
        const currentIndex = speeds.indexOf(this.speedSelect.value);
        const newIndex = Math.max(0, Math.min(speeds.length - 1, currentIndex + direction));
        this.speedSelect.value = speeds[newIndex];
        this.videoPlayer.setPlaybackRate(parseFloat(speeds[newIndex]));
    }

    /**
     * Show loading overlay
     * @param {string} message
     */
    showLoading(message = 'Loading...') {
        this.loadingText.textContent = message;
        this.loadingOverlay.style.display = 'flex';
        this.loadingOverlay.classList.remove('hidden');
    }

    /**
     * Hide loading overlay
     */
    hideLoading() {
        this.loadingOverlay.classList.add('hidden');
        this.loadingOverlay.style.display = 'none';
    }

    /**
     * Update loading overlay message
     * @param {string} message
     */
    updateLoading(message) {
        this.loadingText.textContent = message;
    }

    /**
     * Update buffering indicator display
     * @param {Object} state - Buffering state from VideoPlayer
     */
    updateBufferingIndicator(state) {
        if (!this.bufferingIndicator) return;

        if (state.isBuffering) {
            // Show the indicator
            this.bufferingIndicator.classList.remove('hidden');

            // Update label with cameras
            const cameraNames = {
                front: 'Front',
                back: 'Rear',
                left_repeater: 'Left',
                right_repeater: 'Right'
            };
            const camList = state.cameras.map(c => cameraNames[c] || c).join(', ');
            this.bufferingLabel.textContent = `Buffering${camList ? ': ' + camList : '...'}`;

            // Update speed estimate
            if (state.readSpeed > 0) {
                this.bufferingSpeed.textContent = `~${state.readSpeed.toFixed(1)} MB/s`;
            } else {
                this.bufferingSpeed.textContent = '';
            }

            // Update buffer health bar
            this.bufferHealthFill.style.width = `${state.bufferHealth}%`;
        } else {
            // Hide the indicator
            this.bufferingIndicator.classList.add('hidden');
        }
    }

    /**
     * Show export completion overlay.
     * @param {{cancelled?: boolean}} [opts] cancelled=true uses amber styling
     *   and "Export Cancelled" copy instead of the green success state.
     */
    /**
     * Lightweight bottom-right toast — stacked, dismissible, auto-fades.
     * Shared by the free-tier warning + any other ad-hoc notification path
     * that doesn't need a dedicated overlay.
     *
     * @param {string} message
     * @param {'info'|'warn'|'error'} [kind='info']
     * @param {number} [durationMs=5000]
     */
    showToast(message, kind = 'info', durationMs = 5000) {
        let stack = document.getElementById('appToastStack');
        if (!stack) {
            stack = document.createElement('div');
            stack.id = 'appToastStack';
            stack.style.cssText = `
                position: fixed; bottom: 20px; right: 20px;
                display: flex; flex-direction: column; gap: 8px;
                z-index: 10001; pointer-events: none;`;
            document.body.appendChild(stack);
        }
        const accent = kind === 'error' ? '#ff3b3b' : kind === 'warn' ? '#ffb800' : 'var(--accent, #00d4ff)';
        const toast = document.createElement('div');
        toast.style.cssText = `
            background: var(--bg-elevated, #1c2230);
            border: 1px solid ${accent};
            color: var(--text-primary, #e8eaed);
            padding: 10px 14px;
            border-radius: 6px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            font-size: 0.9rem;
            max-width: 360px;
            pointer-events: auto;
            cursor: pointer;
            opacity: 0;
            transform: translateX(20px);
            transition: opacity 0.2s, transform 0.2s;`;
        toast.textContent = message;
        toast.addEventListener('click', () => { toast.remove(); });
        stack.appendChild(toast);
        // Animate in
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(0)';
        });
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            setTimeout(() => toast.remove(), 250);
        }, durationMs);
    }

    /**
     * Toast a soft warning at the 5th and 8th free-tier event views so the
     * user has visibility into the daily runway BEFORE we pop the limit
     * modal at #11. Each warning fires once per day. The thresholds match
     * "halfway there" and "two left" cues — friendlier than going from
     * silent to blocked.
     *
     * @param {Object} access — checkAccess result; uses access.remaining
     */
    _maybeShowFreeTierWarning(access) {
        if (!access || access.allowed === false) return;
        if (access.remaining == null || access.limit == null) return;
        // Compute viewed-so-far. checkAccess returns "remaining" BEFORE
        // recordEventView fires for this event, so the 5th view we want
        // to warn about lands at remaining = limit - 4 (next click bumps
        // to remaining = limit - 5, i.e. 5 viewed).
        const viewedAfter = access.limit - access.remaining + 1;
        if (viewedAfter !== 5 && viewedAfter !== 8) return;

        // Per-day dedupe — one toast per threshold per day.
        const today = this.sessionManager?._getTodayString?.() || new Date().toISOString().slice(0, 10);   // local day, as the limits
        const dedupeKey = `tcv_freetier_warn_${today}_${viewedAfter}`;
        if (localStorage.getItem(dedupeKey)) return;
        localStorage.setItem(dedupeKey, '1');

        const left = access.limit - viewedAfter;
        const message = viewedAfter === 5
            ? `${viewedAfter} of ${access.limit} free events viewed today. ${left} remaining.`
            : `${left} free event${left === 1 ? '' : 's'} left today. Already-viewed events stay accessible after limit.`;
        if (typeof this.showToast === 'function') {
            this.showToast(message, 'info', 8000);
        } else {
            console.log('[FreeTier]', message);
        }
    }

    /**
     * Mirror of _maybeShowFreeTierWarning for the export cap. Only 2 free
     * exports per day, so the only meaningful threshold is "1 of 2 used"
     * — toasted on the first export to give the user fair warning before
     * they hit the wall. The modal handles the hard-stop case at 2.
     *
     * @param {Object} access — checkAccess result from sessionManager
     */
    _maybeShowExportWarning(access) {
        if (!access || access.allowed === false) return;
        if (access.remaining == null || access.limit == null) return;
        const usedAfter = access.limit - access.remaining + 1;
        if (usedAfter !== 1) return;

        const today = this.sessionManager?._getTodayString?.() || new Date().toISOString().slice(0, 10);   // local day, as the limits
        const dedupeKey = `tcv_export_warn_${today}_${usedAfter}`;
        if (localStorage.getItem(dedupeKey)) return;
        localStorage.setItem(dedupeKey, '1');

        const left = access.limit - usedAfter;
        const message = this._t('export.freeExportsUsed', { used: usedAfter, limit: access.limit, left });
        if (typeof this.showToast === 'function') {
            this.showToast(message, 'info', 8000);
        } else {
            console.log('[FreeTier:Export]', message);
        }
    }

    showExportComplete(opts = {}) {
        const cancelled = opts.cancelled === true;
        const title = FolderParser.escapeHtml(this._t(cancelled ? 'export.cancelledTitle' : 'export.completeTitle'));
        const subtitle = FolderParser.escapeHtml(this._t(cancelled ? 'export.cancelledText' : 'export.completeText'));
        // The real format of the file (VP9 or H.264), not just the menu choice.
        // Plus, when the speed-limit sign was on, whether it could be looked up.
        const formatNote = cancelled ? '' : [
            this.videoExport?.describeLastExport?.() || '',
            this.videoExport?.describeSpeedLimitExport?.() || '',
            opts.tookSec > 0 ? this._t('export.tookTime', { time: this.formatTime(opts.tookSec) }) : ''
        ].filter(Boolean).join('\n');
        const formatNoteHtml = formatNote
            ? `<div id="exportFormatNote" style="font-size: 0.9rem; color: #b0b0b0; max-width: 420px; margin: -1.25rem auto 1.5rem; white-space: pre-line;">${FolderParser.escapeHtml(formatNote)}</div>`
            : '';
        const titleColor = cancelled ? '#ffb800' : '#4caf50';
        const barGradient = cancelled
            ? 'linear-gradient(90deg, #ffb800, #ff8800)'
            : 'linear-gradient(90deg, #4caf50, #66bb6a)';

        this.loadingOverlay.style.display = 'flex';
        this.loadingOverlay.classList.remove('hidden');
        this.loadingText.innerHTML = `
            <div style="text-align: center;">
                <div style="font-size: 1.5rem; font-weight: bold; margin-bottom: 1rem; color: ${titleColor};">
                    ${title}
                </div>
                <div style="font-size: 1rem; color: #e0e0e0; margin-bottom: 2rem;">
                    ${subtitle}
                </div>
                ${formatNoteHtml}
                <div style="width: 300px; height: 8px; background: #3a3a3a; border-radius: 4px; margin: 1rem auto 2rem; overflow: hidden;">
                    <div style="width: 100%; height: 100%; background: ${barGradient};"></div>
                </div>
                <button id="exportCompleteBtn" style="
                    background: #4a9eff;
                    color: white;
                    border: none;
                    padding: 12px 32px;
                    font-size: 1rem;
                    font-weight: bold;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: background 0.2s;
                " onmouseover="this.style.background='#3a8eef'" onmouseout="this.style.background='#4a9eff'">
                    ${FolderParser.escapeHtml(this._t('common.ok'))}
                </button>
            </div>
        `;

        // Wait for button to be in DOM, then add listener
        setTimeout(() => {
            const btn = document.getElementById('exportCompleteBtn');
            if (btn) {
                btn.addEventListener('click', () => {
                    this.hideLoading();
                    this.enableControls();
                });
            }
        }, 100);
    }

    /**
     * Extract SEI telemetry data for an event (async, non-blocking)
     * Tesla firmware 2025.44.25+ embeds vehicle telemetry in video files
     * @param {Object} event - The event to extract SEI data from
     */
    async extractSeiDataForEvent(event) {
        if (!window.seiExtractor || !this.telemetryOverlay) {
            return;
        }

        // Load token: a clip of the previous event that finishes parsing after
        // the user switched must not show or be saved on this one (#527).
        const seiToken = this._seiLoadToken = (this._seiLoadToken || 0) + 1;
        const isCurrent = () => seiToken === this._seiLoadToken && this.currentEvent === event;

        try {
            // Initialize SEI extractor if needed
            await window.seiExtractor.init();
            if (!isCurrent()) return;

            // Reset overlay data for new event
            this.telemetryOverlay.reset();
            this._weatherFetchedFromTelemetry = false;

            // Clear mini-map trail and weather for new event
            if (this.miniMapOverlay) {
                this.miniMapOverlay.clearAll();
            }

            // Clear elevation data for new event
            if (this.elevationOverlay) {
                this.elevationOverlay.clear();
            }

            // Clear street view for new event
            if (this.streetViewOverlay) {
                this.streetViewOverlay.clear();
            }

            // Clear telemetry graphs for new event
            if (this.telemetryGraphs) {
                this.telemetryGraphs.clear();
            }

            // Reset incident slow-mo for new event
            if (this.incidentSlowMo) {
                this.incidentSlowMo.reset();
            }

            // Reset collision reconstruction for new event
            if (this.collisionReconstruction) {
                this.collisionReconstruction.reset();
            }

            // Extract SEI from each clip (front camera has the telemetry)
            const clipGroups = event.clipGroups || [];
            for (let i = 0; i < clipGroups.length; i++) {
                const group = clipGroups[i];
                // clips is an object keyed by camera name, not an array
                const frontClip = group.clips?.front;

                if (frontClip && frontClip.fileHandle) {
                    // Get File from FileHandle and load SEI data (async)
                    frontClip.fileHandle.getFile().then(file => {
                        if (!isCurrent()) return null;
                        return this.telemetryOverlay.loadClipData(file, i);
                    }).then(data => {
                        if (!isCurrent()) return;
                        if (data && data.frames.length > 0) {
                            console.log(`SEI telemetry loaded for clip ${i}: ${data.frames.length} frames`);
                            // Auto-show telemetry overlay if we have telemetry data
                            if (!this.telemetryOverlay.isVisible && this.settingsManager.get('telemetryOverlayEnabled') !== false) {
                                this.telemetryOverlay.show();
                            }
                            // Auto-show mini-map if enabled and we have GPS telemetry data
                            if (this.miniMapOverlay && !this.miniMapOverlay.isVisible && this.settingsManager.get('miniMapEnabled')) {
                                this.miniMapOverlay.show();
                            }
                            // Auto-show telemetry graphs if enabled (includes elevation)
                            // Note: telemetryGraphs now shows in sidebar panel
                            if (this.telemetryGraphs && !this.telemetryGraphs.isVisible) {
                                this.telemetryGraphs.show();
                            }
                            // Auto-show Bird's Eye View panel when GPS data is available
                            // Note: collisionReconstruction now shows in sidebar panel
                            if (this.collisionReconstruction && !this.collisionReconstruction.isVisible) {
                                this.collisionReconstruction.show();
                            }
                            // Update overlay button states to reflect current visibility
                            this._updateOverlayButtonStates();
                            // Load elevation data after first clip with GPS data (debounced)
                            this._scheduleElevationLoad(event);
                            // Load telemetry graphs data (debounced)
                            this._scheduleGraphsLoad(event);
                            // Compute intervention severity (debounced) once more
                            // SEI data is available; uses whatever clips have
                            // loaded so far and updates when more arrive.
                            this._scheduleSeverityCompute(event);
                            // Fetch weather from telemetry if not already available from metadata
                            // (useful for RecentClips which don't have event.json)
                            if (!event.metadata?.est_lat && !this._weatherFetchedFromTelemetry) {
                                this._fetchWeatherFromTelemetry(event, data);
                            }
                        }
                    }).catch(err => {
                        // Silently ignore - older clips won't have SEI data
                    });
                }
            }

            // Set up playback time update handler for telemetry
            this.setupTelemetryUpdateHandler();

        } catch (error) {
            console.warn('SEI extraction not available:', error.message);
        }
    }

    /**
     * Schedule elevation data loading (debounced to wait for multiple clips to load)
     */
    /**
     * Compute the intervention severity score from currently-loaded SEI data.
     * Debounced since loadClipData resolves once per clip and we'd otherwise
     * recompute on every clip's arrival. Caches on the event object and
     * refreshes the sidebar badge.
     */
    _scheduleSeverityCompute(event) {
        if (!this.telemetryOverlay) return;
        // If ALL three metrics already hydrated from cache, skip recompute.
        // Otherwise we still want a live pass — it refreshes anything that
        // was missing or stale and gets the user's just-loaded event badged
        // even if the background scanner hasn't reached it yet.
        const fullyHydrated = event._severityFromCache
            && event._recordingHealthFromCache
            && event._launchesFromCache;
        if (fullyHydrated) return;

        if (this._severityTimeout) clearTimeout(this._severityTimeout);
        this._severityTimeout = setTimeout(() => {
            this._severityTimeout = null;
            if (this.currentEvent !== event) return;  // user moved on
            try {
                // Pass cached clip durations so event timestamps are accurate
                // (clips vary 55-63s — assuming 60s puts peaks up to a minute off)
                const clipDurations = this.videoPlayer?.cachedClipDurations || null;
                const seiMap = this.telemetryOverlay.clipSeiData;

                const severity = window.interventionSeverity
                    ? window.interventionSeverity.computeFromSei(seiMap, clipDurations)
                    : null;
                const recordingHealth = window.seiInsights
                    ? window.seiInsights.computeRecordingHealthFromSei(seiMap)
                    : null;
                const launches = window.seiInsights
                    ? window.seiInsights.computeLaunches(seiMap, clipDurations)
                    : null;

                let refresh = false;
                if (severity) {
                    event._severityScore = severity;
                    event._severityFromCache = false;
                    refresh = true;
                }
                if (recordingHealth) {
                    event._recordingHealth = recordingHealth;
                    event._recordingHealthFromCache = false;
                    refresh = true;
                }
                if (launches) {
                    event._launches = launches;
                    event._launchesFromCache = false;
                    refresh = true;
                    this._applyLaunchBookmarks(event, launches);
                }
                if (refresh && this.eventBrowser?.refreshEventBadges) {
                    this.eventBrowser.refreshEventBadges(event.name);
                }
                // Persist whatever we computed so next open is instant.
                if (window.eventInsightsCache && (severity || recordingHealth || launches)) {
                    const eventKey = event.compoundKey || event.name;
                    const partial = {
                        eventTimestamp: event.timestamp ? new Date(event.timestamp).getTime() : null
                    };
                    if (severity)        partial.severity        = severity;
                    if (recordingHealth) partial.recordingHealth = recordingHealth;
                    if (launches)        partial.launches        = launches;
                    window.eventInsightsCache.putPartial(eventKey, partial);
                }
            } catch (err) {
                console.warn('[InsightsCompute] live compute failed:', err);
            }
        }, 600);
    }

    /**
     * Hydrate an event from the IDB insights cache — sets
     * event._severityScore + refreshes the sidebar badge if found.
     * Runs synchronously-fast from IDB; callers don't need to await.
     * Near-miss hydration happens from the timeline side via
     * _hydrateNearMissesFromCache() so the marker paints before SEI is loaded.
     */
    async _hydrateInsightsFromCache(event) {
        if (!window.eventInsightsCache || !event) return;
        const eventKey = event.compoundKey || event.name;
        try {
            const [cachedSeverity, cachedHealth, cachedLaunches] = await Promise.all([
                window.eventInsightsCache.getSeverity(eventKey),
                window.eventInsightsCache.getRecordingHealth(eventKey),
                window.eventInsightsCache.getLaunches(eventKey)
            ]);
            // Apply only if user is still on this event (they may have moved on).
            if (this.currentEvent !== event) return;
            let touched = false;
            if (cachedSeverity) {
                event._severityScore = cachedSeverity;
                event._severityFromCache = true;
                touched = true;
            }
            if (cachedHealth) {
                event._recordingHealth = cachedHealth;
                event._recordingHealthFromCache = true;
                touched = true;
            }
            if (cachedLaunches) {
                event._launches = cachedLaunches;
                event._launchesFromCache = true;
                touched = true;
                this._applyLaunchBookmarks(event, cachedLaunches);
            }
            if (touched && this.eventBrowser?.refreshEventBadges) {
                this.eventBrowser.refreshEventBadges(event.name);
            }
        } catch (e) {
            // Non-fatal — recompute path takes over.
        }
    }

    /**
     * Push each cached launch onto the timeline as a labeled bookmark.
     * Idempotent — clears any previous launch-bookmarks first so a re-load
     * doesn't accumulate duplicates. Skips silently if the timeline isn't
     * ready yet or the launch list is empty.
     */
    _applyLaunchBookmarks(event, launches) {
        if (!this.timeline || !Array.isArray(launches) || launches.length === 0) return;
        if (!Array.isArray(this.timeline.bookmarks)) return;
        try {
            // Launch bookmarks are derived (re-computed from cache every
            // load), so they must NOT go through addBookmarkAt — that
            // would persist them to localStorage and conflate them with
            // user-saved bookmarks. We push directly and re-render once.
            this.timeline.bookmarks = this.timeline.bookmarks.filter(b => !b.isLaunch);
            for (let i = 0; i < launches.length; i++) {
                const launch = launches[i];
                if (!Number.isFinite(launch?.absoluteTimeSec)) continue;
                this.timeline.bookmarks.push({
                    id: `launch-${i}-${Math.round(launch.absoluteTimeSec * 1000)}`,
                    time: launch.absoluteTimeSec,
                    label: '🏁 Launch',
                    isLaunch: true
                });
            }
            this.timeline.bookmarks.sort((a, b) => a.time - b.time);
            if (typeof this.timeline.renderBookmarks === 'function') {
                this.timeline.renderBookmarks();
            }
        } catch (e) {
            console.warn('[Launches] Failed to apply launch bookmarks:', e);
        }
    }

    /**
     * Bulk-hydrate severity scores for every event currently in the
     * sidebar. One IDB getAll() → Map lookup per event → refresh only
     * the cards that hit. Runs async after render so it doesn't hold
     * up the initial paint.
     * @param {Array} events  filtered event list that was just loaded
     */
    async _bulkHydrateSeverityBadges(events) {
        if (!window.eventInsightsCache || !events || events.length === 0) return;
        try {
            const cacheMap = await window.eventInsightsCache.getAllCurrentAsMap();
            if (cacheMap.size === 0) return;
            const sevVer = window.eventInsightsCache.SEVERITY_SCHEMA_VERSION;
            const healthVer = window.eventInsightsCache.RECORDING_HEALTH_SCHEMA_VERSION;
            const launchesVer = window.eventInsightsCache.LAUNCHES_SCHEMA_VERSION;
            let sevHits = 0, healthHits = 0, launchHits = 0;
            for (const event of events) {
                const key = event.compoundKey || event.name;
                const rec = cacheMap.get(key);
                if (!rec) continue;
                let refresh = false;
                if (rec.severity && rec.severityVersion === sevVer) {
                    event._severityScore = rec.severity;
                    event._severityFromCache = true;
                    sevHits++; refresh = true;
                }
                if (rec.recordingHealth && rec.recordingHealthVersion === healthVer) {
                    event._recordingHealth = rec.recordingHealth;
                    event._recordingHealthFromCache = true;
                    healthHits++; refresh = true;
                }
                if (rec.launches && rec.launchesVersion === launchesVer) {
                    event._launches = rec.launches;
                    event._launchesFromCache = true;
                    launchHits++; refresh = true;
                }
                if (refresh) this.eventBrowser?.refreshEventBadges?.(event.name);
            }
            if (sevHits + healthHits + launchHits > 0) {
                console.log(`[InsightsCache] Hydrated from cache — severity:${sevHits} health:${healthHits} launches:${launchHits}`);
            }
        } catch (e) {
            console.warn('[InsightsCache] bulk hydrate failed:', e);
        }
    }

    /**
     * Pull cached near-misses from IDB and paint them on the timeline
     * immediately. The live detector will overwrite with fresh data once
     * SEI is parsed; this just gives the user instant visual feedback.
     */
    async _hydrateNearMissesFromCache(event) {
        if (!window.eventInsightsCache || !this.timeline || !event) return;
        const eventKey = event.compoundKey || event.name;
        try {
            const cached = await window.eventInsightsCache.getNearMisses(eventKey);
            if (cached && this.currentEvent === event) {
                this.timeline.setNearMissMarkers(cached);
            }
        } catch (e) { /* non-fatal */ }
    }

    _scheduleElevationLoad(event) {
        // Clear any pending load
        if (this._elevationLoadTimeout) {
            clearTimeout(this._elevationLoadTimeout);
        }

        // Replace the old hard-coded 1500ms timeout with an idle-aware
        // scheduler call. External API fetches (elevation) now wait for
        // the browser to be genuinely idle rather than racing against
        // main-thread video decode.
        if (this._elevationScheduleHandle && window.backgroundScheduler) {
            window.backgroundScheduler.cancel(this._elevationScheduleHandle);
        }
        this._elevationScheduleHandle = window.backgroundScheduler?.scheduleWhenIdle(() => {
            this._loadElevationData(event);
            // Sync session-level unknown SEI field stats into persistent diagnostics.
            if (window.seiDiagnostics && typeof window.seiDiagnostics.syncFromExtractor === 'function') {
                window.seiDiagnostics.syncFromExtractor();
            }
            // Compute event-level insights (road roughness, AP usage, recording health).
            this.refreshEventInsights();
        }, { timeoutMs: 3000, label: 'elevation+diag+insights' })
        // Fallback if scheduler isn't loaded for some reason.
        ?? { type: 'timeout', token: setTimeout(() => {
            this._loadElevationData(event);
            this.refreshEventInsights();
        }, 1500) };
    }

    /**
     * Load elevation data for the current event
     */
    async _loadElevationData(event) {
        if (!this.elevationOverlay || !this.telemetryOverlay || !window.elevationService) {
            return;
        }
        if (this.currentEvent !== event) return;  // user moved on (#527)

        try {
            // Get GPS points from telemetry
            const gpsPoints = this.telemetryOverlay.getAllGpsPoints();

            if (!gpsPoints || gpsPoints.length < 2) {
                console.log('[Elevation] Not enough GPS points for elevation profile');
                return;
            }

            console.log(`[Elevation] Fetching elevation for ${gpsPoints.length} GPS points`);

            // Fetch elevation data
            const profile = await window.elevationService.getElevationProfile(
                gpsPoints,
                event.compoundKey || event.name
            );
            if (this.currentEvent !== event) return;

            if (profile) {
                const totalDuration = this.timeline.totalDuration || 0;
                console.log(`[Elevation] Profile loaded: ${profile.points.length} points, range ${Math.round(profile.minElevation)}-${Math.round(profile.maxElevation)}m, duration ${totalDuration}s`);
                this.elevationOverlay.setProfile(profile, totalDuration);

                // Also pass to telemetry graphs if available
                if (this.telemetryGraphs) {
                    this.telemetryGraphs.setElevationProfile(profile, totalDuration);
                }
            }
        } catch (error) {
            console.warn('[Elevation] Failed to load elevation data:', error);
        }
    }

    /**
     * Schedule telemetry graphs data loading (debounced to wait for multiple clips to load)
     */
    _scheduleGraphsLoad(event) {
        // Clear any pending load
        if (this._graphsLoadTimeout) {
            clearTimeout(this._graphsLoadTimeout);
        }

        // Wait a bit for more clips to load, then load graphs data
        this._graphsLoadTimeout = setTimeout(() => {
            this._loadGraphsData(event);
        }, 1500); // Wait 1.5 seconds after last clip loads
    }

    /**
     * Load telemetry graphs data for the current event
     */
    _loadGraphsData(event) {
        if (!this.telemetryGraphs || !this.telemetryOverlay) {
            return;
        }
        // A debounced load for the previous event must not compute (and save)
        // near-misses for this one (#527).
        if (this.currentEvent !== event) return;

        try {
            // Get clip SEI data from telemetryOverlay
            const clipSeiMap = this.telemetryOverlay.clipSeiData;
            if (!clipSeiMap || clipSeiMap.size === 0) {
                console.log('[Graphs] No SEI data available for graphs');
                return;
            }

            // Convert Map with compound keys to object indexed by clip number
            const clipSeiData = {};
            for (const [key, data] of clipSeiMap.entries()) {
                const clipIndex = parseInt(key.split('_')[0]);
                clipSeiData[clipIndex] = data;
            }

            const totalDuration = this.timeline.totalDuration || 0;
            console.log(`[Graphs] Loading data: ${Object.keys(clipSeiData).length} clips, total duration ${totalDuration}s`);

            // Set up near-miss detection callback to update timeline markers
            // Preserve any existing callback (e.g., from incidentSlowMo)
            // Wrap it once: this runs on every event load, and wrapping our own previous wrapper made the
            // chain grow, so near-misses were cached and saved once per event opened so far
            let existingCallback = this.telemetryGraphs.onNearMissesDetected;
            if (existingCallback && existingCallback._appNearMissWrapper) existingCallback = existingCallback._base;
            const nearMissWrapper = (nearMisses) => {
                if (this.timeline) {
                    this.timeline.setNearMissMarkers(nearMisses);
                }
                // Chain to existing callback (e.g., incidentSlowMo)
                if (existingCallback) {
                    existingCallback(nearMisses);
                }
                // Cache near-miss data for event browser display (localStorage summary list)
                this._cacheNearMissData(nearMisses);
                // Persist full near-miss array to IDB so next open paints
                // markers instantly without re-parsing SEI.
                if (window.eventInsightsCache && this.currentEvent) {
                    const eventKey = this.currentEvent.compoundKey || this.currentEvent.name;
                    const ts = this.currentEvent.timestamp ? new Date(this.currentEvent.timestamp).getTime() : null;
                    window.eventInsightsCache.putPartial(eventKey, {
                        nearMisses: nearMisses || [],
                        eventTimestamp: ts
                    });
                }
            };
            nearMissWrapper._appNearMissWrapper = true;
            nearMissWrapper._base = existingCallback;
            this.telemetryGraphs.onNearMissesDetected = nearMissWrapper;

            // Set up incident detection callback to feed MapView
            // TelemetryGraphs is the source of truth for incident detection
            this.telemetryGraphs.onIncidentsDetected = (incidents) => {
                if (this.mapView && this.currentEvent) {
                    this.mapView.addIncidentsFromTelemetry(
                        incidents,
                        this.currentEvent
                    );
                }
            };

            // Set up AP disengagement detection callback to feed MapView
            // TelemetryGraphs is the source of truth for AP struggle zones
            this.telemetryGraphs.onApEventsDetected = (apDisengagements) => {
                if (this.mapView && this.currentEvent) {
                    this.mapView.addApDisengagementsFromTelemetry(
                        apDisengagements,
                        this.currentEvent
                    );
                }
            };

            // Load data into graphs
            this.telemetryGraphs.loadData(clipSeiData, totalDuration);

            // Set units from settings
            const useMetric = this.settingsManager.get('useMetricUnits');
            this.telemetryGraphs.setUnits(useMetric ? 'kph' : 'mph');

            // Queue GPS positions for background speed limit loading
            this._queueSpeedLimitPositions(clipSeiData, totalDuration);

        } catch (error) {
            console.warn('[Graphs] Failed to load graphs data:', error);
        }
    }

    /**
     * Cache near-miss detection data for event browser display
     * @param {Array} nearMisses - Array of near-miss objects
     */
    _cacheNearMissData(nearMisses) {
        if (!this.currentEvent) return;

        const eventKey = this.currentEvent.compoundKey || this.currentEvent.name;
        const flaggedIncidents = nearMisses.filter(nm => nm.score >= 5);
        const flaggedCount = flaggedIncidents.length;
        const maxScore = nearMisses.length > 0 ? Math.max(...nearMisses.map(nm => nm.score)) : 0;

        try {
            // Load existing cache
            const cacheKey = 'teslacamviewer_nearmiss_cache';
            const cache = JSON.parse(localStorage.getItem(cacheKey) || '{}');

            // Save this event's near-miss data including incident times for navigation
            cache[eventKey] = {
                count: flaggedCount,
                maxScore: maxScore,
                incidents: flaggedIncidents.map(nm => ({
                    time: nm.time,
                    score: nm.score,
                    severity: nm.severity
                })),
                timestamp: Date.now()
            };

            // Keep cache size reasonable (last 100 events)
            const keys = Object.keys(cache);
            if (keys.length > 100) {
                const sortedKeys = keys.sort((a, b) => cache[a].timestamp - cache[b].timestamp);
                for (let i = 0; i < keys.length - 100; i++) {
                    delete cache[sortedKeys[i]];
                }
            }

            localStorage.setItem(cacheKey, JSON.stringify(cache));

            // Update event browser if available
            if (this.eventBrowser && flaggedCount > 0) {
                this.eventBrowser.updateNearMissIndicator(eventKey, flaggedCount, maxScore);
            }
        } catch (e) {
            console.warn('[App] Failed to cache near-miss data:', e);
        }
    }

    /**
     * Navigate to a near-miss incident in a specific event
     * @param {string} eventKey - Event identifier
     * @param {number} incidentIndex - Index of the incident to navigate to (0-based)
     */
    async navigateToNearMiss(eventKey, incidentIndex = 0) {
        try {
            console.log(`[App] navigateToNearMiss called: eventKey=${eventKey}, index=${incidentIndex}`);

            // Get cached near-miss data
            const cacheKey = 'teslacamviewer_nearmiss_cache';
            const cache = JSON.parse(localStorage.getItem(cacheKey) || '{}');
            const data = cache[eventKey];

            if (!data || !data.incidents || data.incidents.length === 0) {
                console.warn('[App] No near-miss data found for event:', eventKey);
                return;
            }

            // Get the incident to navigate to
            const incident = data.incidents[incidentIndex % data.incidents.length];
            if (!incident) {
                console.warn('[App] No incident at index:', incidentIndex);
                return;
            }

            console.log(`[App] Target incident: time=${incident.time}, score=${incident.score}`);

            // Find and load the event if not already loaded
            const currentEventKey = this.currentEvent?.compoundKey || this.currentEvent?.name;
            if (currentEventKey !== eventKey) {
                console.log(`[App] Need to load event: current=${currentEventKey}, target=${eventKey}`);

                // Find the event in allEvents
                const event = this.allEvents.find(e =>
                    (e.compoundKey || e.name) === eventKey
                );

                if (!event) {
                    console.warn('[App] Event not found in allEvents:', eventKey);
                    return;
                }

                console.log('[App] Found event:', event.name);

                // Use eventBrowser.selectEvent to properly load the event and update UI
                // This will also call onEventSelected through the callback
                let eventLoaded = false;
                if (this.eventBrowser) {
                    // selectEvent will find the element and call onEventSelect callback
                    this.eventBrowser.selectEvent(event);
                    // Check if the event was actually selected
                    eventLoaded = this.eventBrowser.selectedEvent === event;
                }

                // Fallback: if selectEvent didn't work (element not found), load directly
                if (!eventLoaded) {
                    console.log('[App] selectEvent did not find element, loading directly');
                    await this.onEventSelected(event);
                }

                // Wait for event to load and telemetry data to be processed
                await new Promise(r => setTimeout(r, 1500));
            }

            // Seek to the incident time (with a small buffer before)
            const seekTime = Math.max(0, incident.time - 2);
            console.log(`[App] Seeking to time: ${seekTime}`);
            await this.videoPlayer.seekToEventTime(seekTime);

            console.log(`[App] Navigated to near-miss at ${incident.time.toFixed(1)}s (score: ${incident.score})`);
        } catch (e) {
            console.error('[App] Failed to navigate to near-miss:', e);
        }
    }

    /**
     * Update mini-map from event GPS coordinates (fallback for sentry events)
     * Used when no telemetry data is available from video SEI
     */
    _updateMiniMapFromEventGPS() {
        if (!this.currentEvent) return;

        const event = this.currentEvent;
        if (event.metadata?.est_lat && event.metadata?.est_lon) {
            const lat = parseFloat(event.metadata.est_lat);
            const lng = parseFloat(event.metadata.est_lon);
            if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
                // Update mini-map
                if (this.miniMapOverlay) {
                    // Only update once if position hasn't changed (static position for sentry)
                    if (this.miniMapOverlay.currentLat !== lat || this.miniMapOverlay.currentLng !== lng) {
                        this.miniMapOverlay.updatePosition(lat, lng, 0);
                    }
                }
                // Update street view overlay (if using the overlay)
                if (this.streetViewOverlay && this.streetViewOverlay.isVisible) {
                    this.streetViewOverlay.updatePosition(lat, lng, 0);
                }
                // Update street view button in info bar
                this._updateStreetViewButton(lat, lng, 0);
            }
        }
    }

    /**
     * Set up handler to update telemetry overlay during playback
     */
    setupTelemetryUpdateHandler() {
        if (!this.telemetryOverlay) return;

        // Idempotency guard: this function is called every time an event loads
        // (inside the SEI extraction block). Without this, each call creates a
        // fresh closure and the old RAF callback keeps running alongside the
        // new one, multiplying loops on every event switch.
        if (this._telemetryHandlerInstalled) {
            this._telemetryStart?.();
            return;
        }
        this._telemetryHandlerInstalled = true;

        // Guard against duplicate RAF loops. Each overlay's show() schedules
        // a fresh requestAnimationFrame; without this check, toggling overlays
        // or re-rendering layouts could spawn multiple parallel loops.
        this._telemetryRafId = null;
        const start = () => {
            if (this._telemetryRafId != null) return; // already scheduled
            this._telemetryRafId = requestAnimationFrame(updateTelemetry);
        };
        this._telemetryStart = start;

        // Use requestAnimationFrame for smooth updates
        const updateTelemetry = () => {
            this._telemetryRafId = null;
            // During export the export pipeline drives telemetry/mini-map updates itself.
            // Running the live loop in parallel causes HUD/map flicker (60fps RAF repaints
            // on top of export frames) and poisons the mini-map trail with unfiltered bad
            // GPS samples that race with our filtered updatePositionForExport calls.
            if (this.videoExport?.isExporting) {
                const mmVis = this.miniMapOverlay && this.miniMapOverlay.isVisible;
                const svVis = this.streetViewOverlay && this.streetViewOverlay.isVisible;
                if (this.telemetryOverlay.isVisible || mmVis || svVis) {
                    start();
                }
                return;
            }

            if (this.videoPlayer && this.telemetryOverlay.isVisible) {
                const clipIndex = this.videoPlayer.currentClipIndex || 0;
                const timeInClip = this.videoPlayer.getCurrentTime() || 0;
                const videoDuration = this.videoPlayer.getCurrentDuration() || 0;
                this.telemetryOverlay.updateTelemetry(clipIndex, timeInClip, videoDuration);

                // Update mini-map and street view with GPS data from telemetry
                const data = this.telemetryOverlay.currentData;
                const hasTelemetryGps = data && data.latitude_deg && data.longitude_deg;

                if (this.miniMapOverlay && this.miniMapOverlay.isVisible) {
                    if (hasTelemetryGps) {
                        this.miniMapOverlay.updatePosition(
                            data.latitude_deg,
                            data.longitude_deg,
                            data.heading_deg || 0
                        );
                    } else {
                        // Fallback to event GPS coordinates (for sentry events without telemetry)
                        this._updateMiniMapFromEventGPS();
                    }
                }

                // Update street view overlay
                if (this.streetViewOverlay && this.streetViewOverlay.isVisible) {
                    if (hasTelemetryGps) {
                        this.streetViewOverlay.updatePosition(
                            data.latitude_deg,
                            data.longitude_deg,
                            data.heading_deg || 0
                        );
                    } else {
                        this._updateMiniMapFromEventGPS();
                    }
                }

                // Update street view button in info bar
                if (hasTelemetryGps) {
                    this._updateStreetViewButton(data.latitude_deg, data.longitude_deg, data.heading_deg || 0);
                    // Update speed limit display
                    this._updateSpeedLimitDisplay(data.latitude_deg, data.longitude_deg);
                } else {
                    this._updateMiniMapFromEventGPS();
                }
            }

            // Also update overlays if they are visible but telemetry overlay is hidden
            const miniMapVisible = this.miniMapOverlay && this.miniMapOverlay.isVisible;
            const streetViewVisible = this.streetViewOverlay && this.streetViewOverlay.isVisible;

            if ((miniMapVisible || streetViewVisible) && !this.telemetryOverlay.isVisible) {
                // Need to manually get telemetry data when telemetry overlay is hidden
                const clipIndex = this.videoPlayer?.currentClipIndex || 0;
                const timeInClip = this.videoPlayer?.getCurrentTime() || 0;
                const videoDuration = this.videoPlayer?.getCurrentDuration() || 0;
                this.telemetryOverlay.updateTelemetry(clipIndex, timeInClip, videoDuration);
                const data = this.telemetryOverlay.currentData;
                const hasTelemetryGps = data && data.latitude_deg && data.longitude_deg;

                if (miniMapVisible) {
                    if (hasTelemetryGps) {
                        this.miniMapOverlay.updatePosition(
                            data.latitude_deg,
                            data.longitude_deg,
                            data.heading_deg || 0
                        );
                    } else {
                        this._updateMiniMapFromEventGPS();
                    }
                }

                if (streetViewVisible) {
                    if (hasTelemetryGps) {
                        this.streetViewOverlay.updatePosition(
                            data.latitude_deg,
                            data.longitude_deg,
                            data.heading_deg || 0
                        );
                    } else {
                        this._updateMiniMapFromEventGPS();
                    }
                }

                // Update street view button in info bar
                if (hasTelemetryGps) {
                    this._updateStreetViewButton(data.latitude_deg, data.longitude_deg, data.heading_deg || 0);
                    // Update speed limit display
                    this._updateSpeedLimitDisplay(data.latitude_deg, data.longitude_deg);
                } else {
                    this._updateMiniMapFromEventGPS();
                }
            }

            if (this.telemetryOverlay.isVisible || miniMapVisible || streetViewVisible) {
                start();
            }
        };

        // Start the update loop if any overlay is visible
        const miniMapVisible = this.miniMapOverlay && this.miniMapOverlay.isVisible;
        const streetViewVisible = this.streetViewOverlay && this.streetViewOverlay.isVisible;
        if (this.telemetryOverlay.isVisible || miniMapVisible || streetViewVisible) {
            start();
        }

        // Restart loop when telemetry overlay is shown
        const originalShow = this.telemetryOverlay.show.bind(this.telemetryOverlay);
        this.telemetryOverlay.show = () => {
            originalShow();
            start();
        };

        // Also restart loop when mini-map is shown
        if (this.miniMapOverlay) {
            const originalMiniMapShow = this.miniMapOverlay.show.bind(this.miniMapOverlay);
            this.miniMapOverlay.show = () => {
                originalMiniMapShow();
                start();
            };
        }

        // Also restart loop when street view is shown
        if (this.streetViewOverlay) {
            const originalStreetViewShow = this.streetViewOverlay.show.bind(this.streetViewOverlay);
            this.streetViewOverlay.show = () => {
                originalStreetViewShow();
                start();
                this._updateOverlayButtonStates();
            };
        }
    }

    // ==================== PILLAR CAMERA SUPPORT ====================

    /**
     * Update pillar layout options visibility based on whether event has pillar cameras
     * @param {boolean} hasPillars
     */
    updatePillarLayoutOptions(hasPillars) {
        // Show/hide 6-camera layout option
        const pillarLayoutOptions = document.querySelectorAll('.pillar-layout-option');
        pillarLayoutOptions.forEach(opt => {
            opt.style.display = hasPillars ? '' : 'none';
        });

        // Show/hide pillar camera options in focus mode selector
        const pillarCameraOptions = document.querySelectorAll('.pillar-option');
        pillarCameraOptions.forEach(opt => {
            opt.style.display = hasPillars ? '' : 'none';
        });
    }

    /**
     * Show diagnostic results after folder parsing
     * @param {boolean} forceShow - Show even if no errors
     */
    showParseDiagnostics(forceShow = false) {
        const summary = this.folderParser?.getDiagnosticSummary();
        if (!summary) return;

        const stats = summary.stats;
        const hasErrors = stats.errors.length > 0;
        const hasFailedReads = stats.eventJsonFailed > 0;

        // Only show automatically if there are issues
        if (!forceShow && !hasErrors && !hasFailedReads) {
            return;
        }

        // Create diagnostic toast
        const toast = document.createElement('div');
        toast.className = 'diagnostic-toast' + (hasErrors ? ' has-errors' : '');

        let message = '';
        if (hasErrors || hasFailedReads) {
            message = `⚠️ Parse completed with issues: ${stats.eventsCreated} events found`;
            if (hasFailedReads) {
                message += `, ${stats.eventJsonFailed} metadata read failures`;
            }
            if (hasErrors) {
                message += `, ${stats.errors.length} errors`;
            }
        } else {
            message = `✓ Loaded ${stats.eventsCreated} events (${stats.videoFilesFound} videos)`;
        }

        toast.innerHTML = `
            <div class="diagnostic-toast-content">
                <span class="diagnostic-message">${message}</span>
                <div class="diagnostic-actions">
                    <button class="diagnostic-btn copy-btn" title="Copy diagnostic report">📋 Copy Report</button>
                    <button class="diagnostic-btn close-btn" title="Dismiss">✕</button>
                </div>
            </div>
        `;

        document.body.appendChild(toast);

        // Handle copy button
        toast.querySelector('.copy-btn').addEventListener('click', () => {
            this.copyDiagnosticReport();
        });

        // Handle close button
        toast.querySelector('.close-btn').addEventListener('click', () => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        });

        // Animate in
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // Auto-dismiss after delay (longer if errors)
        const dismissDelay = hasErrors ? 15000 : 8000;
        setTimeout(() => {
            if (toast.isConnected) {
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 300);
            }
        }, dismissDelay);
    }

    /**
     * Copy diagnostic report to clipboard
     */
    async copyDiagnosticReport() {
        const report = this.folderParser?.getDiagnosticReport();
        if (!report) {
            this.showSimpleToast('No diagnostic data available');
            return;
        }

        try {
            await navigator.clipboard.writeText(report);
            this.showSimpleToast('📋 Diagnostic report copied to clipboard!');
        } catch (err) {
            console.error('Failed to copy:', err);
            // Fallback: show in a modal for manual copy
            this.showDiagnosticModal(report);
        }
    }

    /**
     * Show diagnostic report in a modal (fallback for clipboard failure)
     */
    showDiagnosticModal(report) {
        const modal = document.createElement('div');
        modal.className = 'diagnostic-modal-overlay';
        modal.innerHTML = `
            <div class="diagnostic-modal">
                <div class="diagnostic-modal-header">
                    <h3>📋 Diagnostic Report</h3>
                    <button class="diagnostic-modal-close">✕</button>
                </div>
                <div class="diagnostic-modal-body">
                    <p>Copy the text below and include it in your bug report:</p>
                    <textarea readonly class="diagnostic-textarea">${FolderParser.escapeHtml(report)}</textarea>
                </div>
                <div class="diagnostic-modal-footer">
                    <a href="https://github.com/NateMccomb/TeslaCamViewer/issues/new"
                       target="_blank" rel="noopener noreferrer" class="diagnostic-btn primary">
                        🐛 Open GitHub Issue
                    </a>
                    <button class="diagnostic-btn select-all">Select All</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Handle close
        modal.querySelector('.diagnostic-modal-close').addEventListener('click', () => {
            modal.remove();
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });

        // Handle select all
        modal.querySelector('.select-all').addEventListener('click', () => {
            const textarea = modal.querySelector('.diagnostic-textarea');
            textarea.select();
            textarea.setSelectionRange(0, textarea.value.length);
        });

        // Animate in
        requestAnimationFrame(() => {
            modal.classList.add('show');
        });
    }

    /**
     * Show a simple toast notification
     */
    showSimpleToast(message, duration = 3000) {
        const toast = document.createElement('div');
        toast.className = 'simple-toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    /**
     * Set body.tcv-modal-open while a full-screen modal is open (What's New, Settings, Help, Statistics...),
     * so the CSS can pause the animations behind it. Those modals blur what's behind them (backdrop-filter);
     * anything still animating back there (the blue dots pulse forever) makes Chrome redraw the blur on every
     * frame, and on some GPUs one of those redraws now and then drops the dark backdrop for a frame, so the
     * player flashes through. A modal here is any direct child of <body> other than the main UI that is fixed,
     * shown and covers the window, so a new modal is covered without adding it to a list.
     */
    _watchModalBackdrops() {
        const mainUi = new Set([document.querySelector('.app-container'), document.getElementById('bottomSheet')]);
        const isOpenModal = (el) => {
            if (mainUi.has(el) || el.tagName === 'SCRIPT' || el.tagName === 'TEMPLATE') return false;
            const cs = getComputedStyle(el);
            if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') {
                return false;
            }
            const r = el.getBoundingClientRect();
            return r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9;
        };
        let queued = false;
        const update = () => {
            queued = false;
            document.body.classList.toggle('tcv-modal-open', Array.from(document.body.children).some(isOpenModal));
        };
        const schedule = () => {
            if (!queued) {
                queued = true;
                requestAnimationFrame(update);
            }
        };
        // Watch <body>'s own children (added, removed, class/style/hidden changes), not the whole page, so video
        // playback and timeline updates inside the main UI never wake this up.
        const observer = new MutationObserver((records) => {
            for (const r of records) {
                if (r.type === 'childList') r.addedNodes.forEach(n => watchAttrs(n));
            }
            schedule();
        });
        const watchAttrs = (n) => {
            if (n.nodeType === 1 && !mainUi.has(n)) {
                observer.observe(n, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
            }
        };
        observer.observe(document.body, { childList: true });
        Array.from(document.body.children).forEach(watchAttrs);
        window.addEventListener('resize', schedule);
        update();
    }

    /**
     * Initialize instance detection using BroadcastChannel
     * Detects if another tab/window has TeslaCamViewer open
     */
    _initInstanceDetection() {
        this._instanceId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        this._otherInstancesDetected = false;

        try {
            this._instanceChannel = new BroadcastChannel('teslacamviewer-instance');

            // Listen for messages from other instances
            this._instanceChannel.onmessage = (event) => {
                if (event.data.type === 'ping' && event.data.id !== this._instanceId) {
                    // Another instance is checking - respond with pong
                    this._instanceChannel.postMessage({ type: 'pong', id: this._instanceId });
                } else if (event.data.type === 'pong' && event.data.id !== this._instanceId) {
                    // Received response from another instance
                    if (!this._otherInstancesDetected) {
                        this._otherInstancesDetected = true;
                        this._showInstanceWarning();
                    }
                }
            };

            // Send ping to detect other instances
            this._instanceChannel.postMessage({ type: 'ping', id: this._instanceId });

            // Also respond to pings sent before we started listening
            setTimeout(() => {
                this._instanceChannel.postMessage({ type: 'ping', id: this._instanceId });
            }, 500);

            console.log('[App] Instance detection initialized, id:', this._instanceId);
        } catch (e) {
            console.warn('[App] BroadcastChannel not supported:', e);
        }
    }

    /**
     * Show warning about multiple instances
     */
    /**
     * When index.html is opened straight from its folder (file://), Chrome and Edge block fetches of the
     * app's own files, workers and module imports, so telemetry, plate tools, GIF / fast exports and
     * translations don't work. Explain that once per session, with the two ways to get everything.
     */
    _showFileProtocolNotice() {
        if (location.protocol !== 'file:') return;
        try { if (sessionStorage.getItem('tcv-file-notice-closed')) return; } catch (e) { /* storage blocked */ }
        if (document.getElementById('file-protocol-banner')) return;
        const banner = document.createElement('div');
        banner.id = 'file-protocol-banner';
        banner.setAttribute('role', 'status');
        banner.innerHTML = `
            <div style="background: #f59e0b; color: #1a1a1a; padding: 10px 20px; position: fixed; left: 0; right: 0; bottom: 0; z-index: 10001; display: flex; justify-content: center; align-items: center; gap: 15px; font-size: 0.9rem; line-height: 1.4;">
                <span>⚠️ ${FolderParser.escapeHtml(this._t('fileProtocol.notice'))}</span>
                <button class="file-protocol-close" style="background: #1a1a1a; color: #f59e0b; border: none; padding: 5px 15px; border-radius: 4px; cursor: pointer; font-weight: bold; flex-shrink: 0;">${FolderParser.escapeHtml(this._t('common.close'))}</button>
            </div>
        `;
        banner.querySelector('.file-protocol-close').addEventListener('click', () => {
            banner.remove();
            try { sessionStorage.setItem('tcv-file-notice-closed', '1'); } catch (e) { /* storage blocked */ }
        });
        document.body.appendChild(banner);
    }

    _showInstanceWarning() {
        console.warn('[App] Another TeslaCamViewer instance detected in another tab/window!');

        // Create persistent warning banner
        const banner = document.createElement('div');
        banner.id = 'instance-warning-banner';
        banner.innerHTML = `
            <div style="background: #ff6b35; color: white; padding: 10px 20px; text-align: center; font-weight: bold; position: fixed; top: 0; left: 0; right: 0; z-index: 10001; display: flex; justify-content: center; align-items: center; gap: 15px;">
                <span>⚠️ Another TeslaCamViewer tab is open. This may cause playback issues. Please close other tabs.</span>
                <button onclick="this.parentElement.remove()" style="background: white; color: #ff6b35; border: none; padding: 5px 15px; border-radius: 4px; cursor: pointer; font-weight: bold;">Dismiss</button>
            </div>
        `;
        document.body.appendChild(banner);
    }

    // ===== Command Palette registration =====

    _registerCommandPaletteCommands() {
        if (!this.commandPalette) return;
        const safe = (fn) => () => { try { fn(); } catch (e) { console.warn('[Command] failed:', e); } };

        this.commandPalette.registerMany([
            // Playback
            { id: 'play-pause', title: 'Play / Pause', category: 'Playback', shortcut: 'Space', keywords: 'play pause space',
              action: safe(() => { this.videoPlayer.getIsPlaying() ? this.pause() : this.play(); }) },
            { id: 'next-clip', title: 'Next Clip', category: 'Playback', shortcut: 'Shift + →', keywords: 'clip forward skip',
              action: safe(() => this.nextClip()) },
            { id: 'prev-clip', title: 'Previous Clip', category: 'Playback', shortcut: 'Shift + ←', keywords: 'clip back skip',
              action: safe(() => this.previousClip()) },
            { id: 'next-event', title: 'Next Event', category: 'Playback', shortcut: '↓', keywords: 'event navigate',
              action: safe(() => this.nextEvent && this.nextEvent()) },
            { id: 'prev-event', title: 'Previous Event', category: 'Playback', shortcut: '↑', keywords: 'event navigate',
              action: safe(() => this.previousEvent && this.previousEvent()) },
            { id: 'seek-back-5', title: 'Seek Back 5 seconds', category: 'Playback', shortcut: '←', keywords: 'rewind back',
              action: safe(async () => { const t = this.videoPlayer.getCurrentTime(); await this.videoPlayer.seek(t - 5); }) },
            { id: 'seek-fwd-5', title: 'Seek Forward 5 seconds', category: 'Playback', shortcut: '→', keywords: 'forward skip',
              action: safe(async () => { const t = this.videoPlayer.getCurrentTime(); await this.videoPlayer.seek(t + 5); }) },
            { id: 'frame-back', title: 'Frame Back', category: 'Playback', shortcut: ',', keywords: 'frame step',
              action: safe(() => this.stepFrame(-1)) },
            { id: 'frame-fwd', title: 'Frame Forward', category: 'Playback', shortcut: '.', keywords: 'frame step',
              action: safe(() => this.stepFrame(1)) },

            // Layouts
            { id: 'cycle-layout', title: 'Cycle Layouts', category: 'Layout', shortcut: 'L', keywords: 'layout view switch',
              action: safe(() => { this.layoutManager.nextLayout(); this.layoutSelect.value = this.layoutManager.getCurrentLayout(); }) },

            // Export / capture
            { id: 'screenshot', title: 'Take Screenshot', category: 'Export', shortcut: 'S', keywords: 'screenshot capture png',
              action: safe(() => { if (!this.screenshotBtn?.disabled) this.screenshotBtn?.click(); }) },
            { id: 'export-video', title: 'Export Video', category: 'Export', keywords: 'export render mp4 webm',
              action: safe(() => this.exportVideo && this.exportVideo()) },
            { id: 'mark-in', title: 'Mark IN point', category: 'Export', shortcut: 'I', keywords: 'mark in clip',
              action: safe(() => { if (!this.markInBtn?.disabled) this.markIn && this.markIn(); }) },
            { id: 'mark-out', title: 'Mark OUT point', category: 'Export', shortcut: 'O', keywords: 'mark out clip',
              action: safe(() => { if (!this.markOutBtn?.disabled) this.markOut && this.markOut(); }) },

            // Overlays
            { id: 'toggle-telemetry', title: 'Toggle Telemetry HUD', category: 'Overlay', shortcut: 'T', keywords: 'telemetry hud speed gps',
              action: safe(() => this.telemetryOverlay?.toggle && this.telemetryOverlay.toggle()) },
            { id: 'toggle-graphs', title: 'Toggle Telemetry Graphs', category: 'Overlay', shortcut: 'G', keywords: 'graphs chart',
              action: safe(() => this.telemetryGraphs?.toggle && this.telemetryGraphs.toggle()) },
            { id: 'toggle-minimap', title: 'Toggle Mini-Map', category: 'Overlay', keywords: 'map mini gps',
              action: safe(() => this.miniMapOverlay?.toggle && this.miniMapOverlay.toggle()) },
            { id: 'toggle-elevation', title: 'Toggle Elevation Overlay', category: 'Overlay', keywords: 'elevation altitude',
              action: safe(() => this.elevationOverlay?.toggle && this.elevationOverlay.toggle()) },
            { id: 'toggle-collision', title: 'Toggle Birds-Eye View', category: 'Overlay', keywords: 'collision reconstruction birds eye',
              action: safe(() => this.collisionReconstruction?.toggle && this.collisionReconstruction.toggle()) },

            // Navigation / modals
            { id: 'open-settings', title: 'Open Settings', category: 'App', shortcut: 'Q', keywords: 'settings preferences config',
              action: safe(() => this.settingsManager?.showSettingsModal()) },
            { id: 'open-diagnostics', title: 'Open Diagnostics', category: 'App', keywords: 'diagnostics debug logs sei',
              action: safe(() => {
                  if (this.settingsManager) {
                      this.settingsManager._activeTab = 'diagnostics';
                      this.settingsManager.showSettingsModal();
                  }
              }) },
            { id: 'open-help', title: 'Open Help / Keyboard Shortcuts', category: 'App', shortcut: 'H', keywords: 'help shortcuts keys',
              action: safe(() => this.helpModal?.toggle()) },
            { id: 'open-stats', title: 'Open Statistics', category: 'App', keywords: 'statistics stats analytics',
              action: safe(() => this.statisticsManager?.show()) },
            { id: 'open-notes', title: 'Open Event Notes', category: 'App', shortcut: 'N', keywords: 'notes tags comments',
              action: safe(() => { if (!this.notesBtn?.disabled) this.notesBtn?.click(); }) },

            // Tools
            { id: 'add-drive', title: 'Add New Drive / Folder', category: 'Tools', keywords: 'add drive folder usb open',
              action: safe(() => this.addNewDrive && this.addNewDrive()) },
            { id: 'refresh-drives', title: 'Refresh Drives', category: 'Tools', keywords: 'refresh reload rescan',
              action: safe(() => this._rescanAllDrives && this._rescanAllDrives()) },
        ]);
    }

    // ===== File System Observer handlers =====

    _onDriveContentsChanged(driveId) {
        // Don't auto-reload (could surprise the user mid-review). Show a toast
        // with a one-click refresh instead.
        this._showDriveRefreshToast(driveId);
    }

    _showDriveRefreshToast(driveId) {
        // De-dupe — if a toast is already up for this drive, keep it.
        const existing = document.querySelector(`.drive-refresh-toast[data-drive-id="${driveId}"]`);
        if (existing) return;

        const drive = this.folderManager?.getDrives?.().find(d => d.id === driveId);
        const label = drive?.label || 'Drive';

        const toast = document.createElement('div');
        toast.className = 'update-toast drive-refresh-toast';
        toast.dataset.driveId = driveId;
        toast.innerHTML = `
            <div class="update-toast-content">
                <div class="update-toast-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                    </svg>
                </div>
                <div class="update-toast-text">
                    <strong>New files detected</strong>
                    <span>${FolderParser.escapeHtml(label)} — refresh to load new events</span>
                </div>
                <button class="update-toast-btn" data-action="refresh">Refresh</button>
                <button class="update-toast-close" data-action="dismiss" title="Dismiss">&times;</button>
            </div>
        `;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('visible'));

        toast.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            if (btn.dataset.action === 'refresh') {
                toast.remove();
                this._rescanDrive(driveId);
            } else {
                toast.remove();
            }
        });

        // Auto-dismiss after a while
        setTimeout(() => { if (toast.parentElement) toast.remove(); }, 47000);
    }

    async _rescanDrive(driveId) {
        const drives = this.folderManager?.getDrives?.() || [];
        const drive = drives.find(d => d.id === driveId);
        if (!drive || !drive.handle) return;

        try {
            this.folderParser.setDriveContext(drive.id, drive.label, drive.color);
            this.folderParser.rootHandle = drive.handle;
            const events = await this.folderParser.parseFolder();
            drive.events = events;

            // Rebuild the flat all-drives event list for the sidebar + stats.
            const allDrives = this.folderManager.getDrives();
            this.allEvents = allDrives.flatMap(d => d.events || []);
            if (this.statisticsManager) this.statisticsManager.setEvents(this.allEvents);
            if (typeof this.registerEventsAndLoadBackups === 'function') {
                await this.registerEventsAndLoadBackups(this.allEvents);
            }
            if (typeof this.applyFilters === 'function') this.applyFilters();
            this.updateDriveSelector(allDrives);
            console.log(`[FSObserver] Rescan complete for ${drive.label}: ${events.length} events`);
        } catch (err) {
            console.warn('[FSObserver] Rescan failed:', err);
        }
    }

    async _rescanAllDrives() {
        const drives = this.folderManager?.getDrives?.() || [];
        for (const d of drives) {
            await this._rescanDrive(d.id);
        }
    }

}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    // Initialize i18n first
    if (window.i18n) {
        await window.i18n.init();
    }

    window.app = new TeslaCamViewerApp();

    // Initialize session state (header button, expiry warnings)
    if (window.app.sessionManager) {
        window.app.sessionManager._updateHeaderButton();
        window.app.sessionManager.showExpiryWarningIfNeeded();
    }

    // Initialize plate enhancer (delayed and wrapped in try-catch)
    setTimeout(() => {
        try {
            if (window.plateEnhancer && typeof window.plateEnhancer.init === 'function') {
                window.plateEnhancer.init();
            }
        } catch (e) {
            console.error('[PlateEnhancer] Init error (non-fatal):', e);
        }
    }, 2000);

    // Preload plate detection model if setting is enabled (delayed to not block startup)
    setTimeout(async () => {
        try {
            const blurEnabled = window.app?.settingsManager?.get('blurLicensePlates') === true;
            if (blurEnabled && window.app?.plateBlur && !window.app.plateBlur.isReady()) {
                console.log('[App] Preloading license plate detection model...');

                // Show a toast notification
                const toast = document.createElement('div');
                toast.id = 'plate-model-toast';
                toast.style.cssText = 'position: fixed; bottom: 20px; right: 20px; background: #2d2d2d; color: #e0e0e0; padding: 12px 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 10000; font-size: 14px; display: flex; align-items: center; gap: 10px;';
                toast.innerHTML = '<div class="loading-spinner" style="width: 16px; height: 16px; border: 2px solid #555; border-top-color: #4a9eff; border-radius: 50%; animation: spin 1s linear infinite;"></div><span>' + FolderParser.escapeHtml(window.app._t('export.plateModelLoading')) + '</span>';
                document.body.appendChild(toast);

                const success = await window.app.plateBlur.loadModel((progress) => {
                    const span = toast.querySelector('span');
                    if (span && progress.percent >= 0) {
                        span.textContent = progress.message;
                    }
                });

                // Update toast and auto-dismiss
                if (success) {
                    toast.innerHTML = '<span style="color: #66bb6a;">✓ ' + FolderParser.escapeHtml(window.app._t('export.plateModelReady')) + '</span>';
                } else {
                    toast.innerHTML = '<span style="color: #ef5350;">⚠ ' + FolderParser.escapeHtml(window.app._t('export.plateModelFailed')) + '</span>';
                }
                setTimeout(() => toast.remove(), 3000);
            }
        } catch (e) {
            console.error('[App] Plate model preload error (non-fatal):', e);
        }
    }, 3000);

    // Debug helper for export troubleshooting
    window.debugExport = () => {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('EXPORT TROUBLESHOOTING GUIDE');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        console.log('If export stalls or buffers frequently, try:\n');
        console.log('1. Move footage to a faster drive (SSD recommended)');
        console.log('   - USB 2.0 drives are often too slow for high-speed export');
        console.log('   - NVMe or SATA SSD provides best performance\n');

        console.log('2. Use lower playback speed (1x-2x instead of 5x)');
        console.log('   - Canvas rendering is CPU-bound at ~30fps');
        console.log('   - High speeds can outpace what the browser can process\n');

        console.log('3. Close other applications using the drive');
        console.log('   - Background downloads, virus scans, etc. compete for I/O\n');

        console.log('4. Check available disk space');
        console.log('   - Low disk space can cause performance issues\n');

        console.log('5. Try shorter export segments');
        console.log('   - Use IN/OUT markers to export specific sections\n');

        // Show current export status if available
        if (window.app?.videoExport) {
            const status = window.app.videoExport.getExportStatus();
            console.log('Current Export Status:');
            console.log('  - isExporting:', status.isExporting);
            console.log('  - speedWasReduced:', status.speedWasReduced);
            if (status.wallStartTime) {
                const elapsed = (Date.now() - status.wallStartTime) / 1000;
                console.log('  - wallTimeElapsed:', elapsed.toFixed(1) + 's');
            }
        }

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    };
});
