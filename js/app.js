/**
 * Main Application Controller
 * Build: NMC-2024
 */

class TeslaCamViewerApp {
    constructor() {
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
        this.videoExport = new VideoExport(this.videoPlayer, this.layoutManager);
        this.clipMarking = new ClipMarking(this.timeline, this.videoPlayer);

        // Settings, Help, Quick Start, Version, Statistics, and Notes
        this.settingsManager = new SettingsManager();
        this.versionManager = new VersionManager();
        this.statisticsManager = new StatisticsManager();
        this.notesManager = new NotesManager();
        this.helpModal = new HelpModal();
        this.quickStartGuide = new QuickStartGuide();

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

        // Settings, Help, Stats buttons
        this.settingsBtn = document.getElementById('settingsBtn');
        this.helpBtn = document.getElementById('helpBtn');
        this.statsBtn = document.getElementById('statsBtn');

        // UI elements
        this.selectFolderBtn = document.getElementById('selectFolderBtn');
        this.playBtn = document.getElementById('playBtn');
        this.pauseBtn = document.getElementById('pauseBtn');
        this.frameBackBtn = document.getElementById('frameBackBtn');
        this.frameForwardBtn = document.getElementById('frameForwardBtn');
        this.prevClipBtn = document.getElementById('prevClipBtn');
        this.nextClipBtn = document.getElementById('nextClipBtn');
        this.prevEventBtn = document.getElementById('prevEventBtn');
        this.nextEventBtn = document.getElementById('nextEventBtn');
        this.screenshotBtn = document.getElementById('screenshotBtn');
        this.pipBtn = document.getElementById('pipBtn');
        this.enhanceBtn = document.getElementById('enhanceBtn');
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
        this.layoutSelect = document.getElementById('layoutSelect');
        this.focusCameraSelect = document.getElementById('focusCameraSelect');
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
                    const events = await this.folderParser.parseFolder();
                    drive.events = events;
                    this.allEvents = events;
                    this.statisticsManager.setEvents(events);
                    await this.registerEventsAndLoadBackups(events);
                    this.applyFilters();
                    this.updateDriveSelector(this.folderManager.getDrives());
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
                    const events = await this.folderParser.parseFolder();
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
                this.selectFolderBtn.classList.add('hidden');
                console.log(`Restored ${allEvents.length} total events from ${successCount} drives`);
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
     * Check browser support for required APIs
     */
    checkBrowserSupport() {
        if (!('showDirectoryPicker' in window)) {
            alert(
                'Your browser does not support the File System Access API.\n\n' +
                'Please use Chrome, Edge, or another Chromium-based browser.'
            );
        }
    }

    /**
     * Setup UI event listeners
     */
    setupEventListeners() {
        // Folder selection
        this.selectFolderBtn.addEventListener('click', () => this.selectFolder());

        // Playback controls
        this.playBtn.addEventListener('click', () => this.play());
        this.pauseBtn.addEventListener('click', () => this.pause());

        // Frame stepping - single click or hold
        this.frameBackBtn.addEventListener('mousedown', () => this.startFrameStepping(-1));
        this.frameBackBtn.addEventListener('mouseup', () => this.stopFrameStepping());
        this.frameBackBtn.addEventListener('mouseleave', () => this.stopFrameStepping());
        this.frameBackBtn.addEventListener('touchstart', () => this.startFrameStepping(-1));
        this.frameBackBtn.addEventListener('touchend', () => this.stopFrameStepping());

        this.frameForwardBtn.addEventListener('mousedown', () => this.startFrameStepping(1));
        this.frameForwardBtn.addEventListener('mouseup', () => this.stopFrameStepping());
        this.frameForwardBtn.addEventListener('mouseleave', () => this.stopFrameStepping());
        this.frameForwardBtn.addEventListener('touchstart', () => this.startFrameStepping(1));
        this.frameForwardBtn.addEventListener('touchend', () => this.stopFrameStepping());

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

        // Export options
        this.exportDropdown.querySelectorAll('.export-option').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const camera = e.target.dataset.camera;
                this.exportDropdown.classList.add('hidden');
                this.exportVideo(camera);
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

        // Speed control
        this.speedSelect.addEventListener('change', (e) => {
            const speed = parseFloat(e.target.value);
            this.videoPlayer.setPlaybackRate(speed);
        });

        // Loop control
        this.loopCheckbox.addEventListener('change', (e) => {
            this.videoPlayer.setLoop(e.target.checked);
        });

        // Layout control
        this.layoutSelect.addEventListener('change', (e) => {
            const layout = e.target.value;
            this.layoutManager.setLayout(layout);
        });

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

        // Settings, Help, and Stats buttons
        this.settingsBtn.addEventListener('click', () => this.settingsManager.showSettingsModal());
        this.helpBtn.addEventListener('click', () => this.helpModal.show());
        this.statsBtn.addEventListener('click', () => this.statisticsManager.showModal());

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
        const checkOrientation = () => {
            if (window.innerWidth <= 768 && window.innerHeight > window.innerWidth) {
                document.body.classList.add('bottom-sheet-enabled');
            } else {
                document.body.classList.remove('bottom-sheet-enabled');
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
        this.bottomSheetPlayBtn.addEventListener('click', () => this.togglePlayback());
        document.getElementById('bsFrameBackBtn')?.addEventListener('click', () => this.frameStep(-1));
        document.getElementById('bsFrameForwardBtn')?.addEventListener('click', () => this.frameStep(1));
        document.getElementById('bsPrevClipBtn')?.addEventListener('click', () => this.previousClip());
        document.getElementById('bsNextClipBtn')?.addEventListener('click', () => this.nextClip());
        document.getElementById('bsPrevEventBtn')?.addEventListener('click', () => this.previousEvent());
        document.getElementById('bsNextEventBtn')?.addEventListener('click', () => this.nextEvent());
        document.getElementById('bsScreenshotBtn')?.addEventListener('click', () => this.screenshotCapture.capture());
        document.getElementById('bsFullscreenBtn')?.addEventListener('click', () => this.enterMobileFullscreen());
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

        // Listen for drive changes
        this.folderManager.onDrivesChanged = (drives) => {
            this.updateDriveSelector(drives);
        };
    }

    /**
     * Update drive selector dropdown with current drives
     */
    updateDriveSelector(drives) {
        // Clear existing options except "All Drives"
        this.driveSelect.innerHTML = '<option value="">All Drives</option>';

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
        try {
            const handle = await window.showDirectoryPicker();

            this.showLoading('Adding drive...');

            // Add drive to folder manager
            const drive = await this.folderManager.addDrive(handle);

            // Parse the drive
            this.loadingText.textContent = 'Parsing TeslaCam folder...';
            this.folderParser.setDriveContext(drive.id, drive.label, drive.color);
            this.folderParser.rootHandle = handle;

            const events = await this.folderParser.parseFolder();

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
            if (error.name !== 'AbortError') {
                console.error('Error adding drive:', error);
                this.hideLoading();
            } else {
                this.hideLoading();
            }
        }
    }

    /**
     * Show drive management modal
     */
    showDriveManagementModal() {
        const drives = this.folderManager.getDrives();

        // Create modal content
        const modalContent = `
            <div class="modal-overlay" id="driveManagementModal">
                <div class="modal drive-management-modal">
                    <div class="modal-header">
                        <h3>Manage Drives</h3>
                        <button class="modal-close-btn" id="closeDriveModal">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                            </svg>
                        </button>
                    </div>
                    <div class="modal-content">
                        ${drives.length === 0 ? `
                            <p style="color: var(--text-muted); text-align: center;">No drives added yet</p>
                        ` : `
                            <div class="drive-list">
                                ${drives.map(drive => `
                                    <div class="drive-item" data-drive-id="${drive.id}">
                                        <label class="drive-color-picker" title="Click to change color">
                                            <input type="color" class="drive-color-input" value="${drive.color}" data-drive-id="${drive.id}">
                                            <div class="drive-color-preview" style="background: ${drive.color};"></div>
                                        </label>
                                        <input type="text" class="drive-label-input" value="${drive.label}" data-drive-id="${drive.id}">
                                        <span class="drive-event-count">${drive.events?.length || 0} events</span>
                                        <button class="drive-remove-btn" data-drive-id="${drive.id}" title="Remove drive">
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
                            Add Drive
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

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
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

        // Remove drive buttons
        modal.querySelectorAll('.drive-remove-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const driveId = e.target.closest('.drive-remove-btn').dataset.driveId;
                if (confirm('Remove this drive? Events will no longer be shown.')) {
                    await this.folderManager.removeDrive(driveId);

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

        const cameraNames = {
            front: 'Front',
            back: 'Back',
            left_repeater: 'Left',
            right_repeater: 'Right'
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
            hiddenCamerasList.innerHTML = hiddenCameras.map(camera => `
                <button class="hidden-camera-btn" data-camera="${camera}" title="Show ${cameraNames[camera]} Camera">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
                    </svg>
                    ${cameraNames[camera]}
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

        // Initial update
        updateHiddenPanel();
    }

    /**
     * Select TeslaCam folder
     */
    async selectFolder() {
        this.showLoading('Selecting folder...');

        const success = await this.folderParser.selectFolder();

        if (success) {
            this.loadingText.textContent = 'Parsing TeslaCam folder...';

            try {
                // Add folder as a drive
                const drive = await this.folderManager.addDrive(this.folderParser.rootHandle);

                // Set drive context for parsing
                this.folderParser.setDriveContext(drive.id, drive.label, drive.color);

                const events = await this.folderParser.parseFolder();

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
                    // Success message
                    console.log(`Loaded ${events.length} events`);
                } else {
                    alert('No TeslaCam events found in the selected folder.');
                }
            } catch (error) {
                this.hideLoading();
                console.error('Error parsing folder:', error);
                alert('Error parsing TeslaCam folder. Please make sure you selected the correct folder.');
            }
        } else {
            this.hideLoading();
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

        // Update event browser with filtered events
        this.eventBrowser.loadEvents(filteredEvents);

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

            // Resize map when switching to map tab
            this.mapView.invalidateSize();
        }

        console.log(`Switched to ${tabName} tab`);
    }

    /**
     * Event selected from browser
     * @param {Object} event
     */
    async onEventSelected(event) {
        this.showLoading('Loading event...');

        try {
            this.currentEvent = event;

            // Track event index for navigation
            this.currentEventIndex = this.allEvents.findIndex(e => e.name === event.name);

            // Load event in video player
            await this.videoPlayer.loadEvent(event);

            // Get total duration
            const totalDuration = await this.videoPlayer.getTotalDuration();
            this.timeline.setDuration(totalDuration);
            this.timeline.setClipMarkers(event.clipGroups);

            // Detect and display gaps in recording
            const gaps = this.folderParser.detectGaps(event.clipGroups);
            if (gaps.length > 0) {
                console.log(`Detected ${gaps.length} gap(s) in recording:`, gaps);
                this.timeline.setGapMarkers(gaps, event.clipGroups);
            }

            // Set current event for bookmark persistence (use compoundKey for multi-drive support)
            this.timeline.setCurrentEvent(event.compoundKey || event.name);

            // Update event info
            this.updateEventInfo(event);

            // Clear any previous export marks
            if (this.clipMarking) {
                this.clipMarking.clearMarks();
            }

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

            // For Sentry events, seek to 1 minute 4 seconds from the end
            // Treat as sentry if it's in SentryClips folder OR has sentry-related metadata
            const isSentryEvent = event.type === 'SentryClips' ||
                event.metadata?.reason?.toLowerCase().includes('sentry');

            if (isSentryEvent) {
                const startTime = Math.max(0, totalDuration - 64); // 1:04 from end
                await this.videoPlayer.seekToEventTime(startTime);

                // Add Sentry trigger marker to timeline (at 1 minute from end)
                const triggerTime = Math.max(0, totalDuration - 60); // 1:00 from end
                this.timeline.setSentryTriggerMarker(triggerTime);
            } else {
                // Clear any existing sentry marker for non-sentry events
                this.timeline.setSentryTriggerMarker(0);
            }

            // Apply current playback speed before playing
            const currentSpeed = parseFloat(this.speedSelect.value) || 1;
            this.videoPlayer.setPlaybackRate(currentSpeed);

            // Auto-play the event
            await this.play();

        } catch (error) {
            this.hideLoading();
            console.error('Error loading event:', error);
            alert('Error loading event videos.');
        }
    }

    /**
     * Update event info display
     * @param {Object} event
     */
    updateEventInfo(event) {
        const date = new Date(event.timestamp);
        const dateStr = date.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        const timeStr = date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        this.eventDateElement.textContent = `${dateStr} at ${timeStr}`;

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

            // Add GPS coordinates if available
            if (event.metadata.est_lat && event.metadata.est_lon) {
                const lat = parseFloat(event.metadata.est_lat);
                const lon = parseFloat(event.metadata.est_lon);
                if (!isNaN(lat) && !isNaN(lon)) {
                    const gpsLink = `https://www.google.com/maps?q=${lat},${lon}`;
                    const gpsText = `GPS: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
                    location += location ? ` • ` : '';
                    location += `<a href="${gpsLink}" target="_blank" style="color: var(--accent); text-decoration: none;">${gpsText}</a>`;
                }
            }

            // Add camera info for Sentry events
            let reason = FolderParser.formatReason(event.metadata.reason);
            if (event.type === 'SentryClips' && event.metadata.camera) {
                const cameraMap = { '0': 'Front', '5': 'Left', '6': 'Right' };
                const cameraName = cameraMap[event.metadata.camera] || `Camera ${event.metadata.camera}`;
                reason += ` • Triggered by ${cameraName} camera`;
            }

            this.eventLocationElement.innerHTML = location;
            this.eventReasonElement.textContent = reason;
        } else {
            this.eventLocationElement.textContent = '';
            this.eventReasonElement.textContent = '';
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
     * @param {number} clipTime
     * @returns {number}
     */
    getAbsoluteEventTime(clipTime) {
        if (!this.currentEvent || this.videoPlayer.currentClipIndex < 0) {
            return 0;
        }

        // Sum duration of all previous clips + current time
        let accumulatedTime = 0;

        for (let i = 0; i < this.videoPlayer.currentClipIndex; i++) {
            // Estimate 60s per clip (simplified)
            accumulatedTime += 60;
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
        this.playBtn.disabled = isPlaying;
        this.pauseBtn.disabled = !isPlaying;
    }

    /**
     * Disable all controls (during export)
     */
    disableAllControls() {
        console.log('Disabling all controls...');
        this.playBtn.disabled = true;
        this.pauseBtn.disabled = true;
        this.frameBackBtn.disabled = true;
        this.frameForwardBtn.disabled = true;
        this.prevClipBtn.disabled = true;
        this.nextClipBtn.disabled = true;
        this.screenshotBtn.disabled = true;
        this.pipBtn.disabled = true;
        this.enhanceBtn.disabled = true;
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
        this.playBtn.disabled = true;
        this.pauseBtn.disabled = true;
        this.frameBackBtn.disabled = true;
        this.frameForwardBtn.disabled = true;
        this.prevClipBtn.disabled = true;
        this.nextClipBtn.disabled = true;
        this.screenshotBtn.disabled = true;
        this.pipBtn.disabled = true;
        this.enhanceBtn.disabled = true;
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
        this.playBtn.disabled = false;
        this.pauseBtn.disabled = true;
        this.frameBackBtn.disabled = false;
        this.frameForwardBtn.disabled = false;
        this.prevClipBtn.disabled = false;
        this.nextClipBtn.disabled = false;
        this.screenshotBtn.disabled = false;
        this.pipBtn.disabled = !document.pictureInPictureEnabled; // Only enable if PiP is supported
        this.enhanceBtn.disabled = false;
        this.notesBtn.disabled = false;
        this.updateNotesButtonState();
        this.markInBtn.disabled = false;
        this.markOutBtn.disabled = false;
        this.clearMarksBtn.disabled = false;
        this.exportBtn.disabled = false;
        this.exportDropdownBtn.disabled = false;
        this.prevBookmarkBtn.disabled = false;
        this.addBookmarkBtn.disabled = false;
        this.nextBookmarkBtn.disabled = false;
        this.bookmarksListBtn.disabled = false;
        this.zoomOutBtn.disabled = false;
        this.zoomInBtn.disabled = false;
        this.zoomResetBtn.disabled = false;
        this.speedSelect.disabled = false;
        this.loopCheckbox.disabled = false;

        // Event navigation buttons
        this.prevEventBtn.disabled = this.currentEventIndex <= 0;
        this.nextEventBtn.disabled = this.currentEventIndex >= this.allEvents.length - 1;

        // Show mobile fullscreen button
        if (this.mobileFullscreenBtn) {
            this.mobileFullscreenBtn.classList.remove('hidden');
        }
    }

    /**
     * Start frame stepping (hold button for slow-mo)
     * @param {number} direction -1 for backward, 1 for forward
     */
    startFrameStepping(direction) {
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
        const currentTime = this.videoPlayer.getCurrentTime();
        const frameRate = 30; // Assume 30fps for Tesla cameras
        const frameDuration = 1 / frameRate;

        const newTime = currentTime + (frameDuration * direction);
        await this.videoPlayer.seek(newTime); // Don't clamp to 0, let seek() handle negative values
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

        try {
            if (this.videoExport?.isExporting) {
                alert('An export is already in progress. Please wait for it to complete.');
                return;
            }

            const marks = this.clipMarking.getMarks();
            const currentAbsoluteTime = this.getAbsoluteEventTime(this.videoPlayer.getCurrentTime());

            // Camera label for display
            const cameraLabels = {
                all: 'all cameras',
                front: 'front camera',
                back: 'rear camera',
                left_repeater: 'left camera',
                right_repeater: 'right camera'
            };
            const cameraLabel = cameraLabels[camera] || camera;

            // Determine what will be exported
            let exportDescription;
            if (marks.inPoint !== null && marks.outPoint !== null) {
                exportDescription = `marked section (${this.clipMarking.getMarkInfo()}) - ${cameraLabel}`;
            } else if (marks.inPoint !== null) {
                exportDescription = `from IN marker to end of event - ${cameraLabel}`;
            } else if (marks.outPoint !== null) {
                exportDescription = `from current position to OUT marker - ${cameraLabel}`;
            } else {
                exportDescription = `from current position to end of event - ${cameraLabel}`;
            }

            // Confirm export
            const currentSpeed = parseFloat(this.speedSelect.value) || 1;
            const speedNote = currentSpeed !== 1 ? ` at ${currentSpeed}x speed` : '';
            const message = `Export ${exportDescription}${speedNote}?\n\nNote: The video will play during export. Please don't switch events until complete.`;

            if (!confirm(message)) {
                return;
            }

            // Determine export range
            const exportStartTime = marks.inPoint !== null ? marks.inPoint : currentAbsoluteTime;
            const exportEndTime = marks.outPoint;

            // Validate export range
            if (exportEndTime !== null && exportStartTime >= exportEndTime) {
                alert('Invalid export range: Start time must be before end time.\nPlease adjust your IN/OUT markers.');
                return;
            }

            // Disable all controls during export
            this.disableControls();

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
            const exportTitle = camera === 'all' ? 'Video' : cameraLabel.charAt(0).toUpperCase() + cameraLabel.slice(1);
            this.loadingText.innerHTML = `
                <div style="text-align: center;">
                    <div id="exportTitle" style="font-size: 1.2rem; font-weight: bold; margin-bottom: 0.5rem; color: #ffffff;">
                        Starting Export...
                    </div>
                    <div id="exportProgress" style="font-size: 0.9rem; color: #a0a0a0;">
                        Preparing video...
                    </div>
                    <div id="exportSpeedNotice" style="min-height: 1.5rem;"></div>
                    <div style="width: 300px; height: 8px; background: #3a3a3a; border-radius: 4px; margin: 1rem auto; overflow: hidden;">
                        <div id="exportProgressBar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #4a9eff, #6bb1ff); transition: width 0.1s linear;"></div>
                    </div>
                    <button id="cancelExportBtn" style="margin-top: 1rem; padding: 0.5rem 1.5rem; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9rem;">
                        Cancel
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
                    console.log('Cancel button clicked');
                    this.videoExport.cancelExport();
                    cancelBtn.removeEventListener('click', cancelHandler);
                    this.hideLoading();
                    this.enableControls();
                }
            };
            cancelBtn.addEventListener('click', cancelHandler);

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

                // Calculate wall-clock ETA based on actual progress rate
                let etaDisplay = '';
                if (exportStatus.wallStartTime && safePercent > 1) {
                    const wallElapsed = (Date.now() - exportStatus.wallStartTime) / 1000;
                    const progressRate = safePercent / wallElapsed;
                    const remainingPercent = 100 - safePercent;
                    const etaSeconds = remainingPercent / progressRate;
                    if (etaSeconds > 0 && etaSeconds < 7200) { // Only show if reasonable
                        etaDisplay = ` (~${this.formatTime(etaSeconds)} wall time)`;
                    }
                }

                // Update only the text/style of existing elements (button stays untouched)
                if (titleEl) {
                    titleEl.textContent = `Exporting ${exportTitle}: ${safePercent}%`;
                }
                if (progressEl) {
                    progressEl.textContent = `${this.formatTime(safeElapsed)} / ${this.formatTime(safeTotal)} (${this.formatTime(safeRemaining)} remaining${etaDisplay})`;
                }
                if (speedNoticeEl) {
                    if (exportStatus.speedWasReduced && exportStatus.currentSpeed !== exportStatus.originalSpeed) {
                        speedNoticeEl.innerHTML = `<div style="color: #ffb800; font-size: 0.85rem;">Speed reduced to ${exportStatus.currentSpeed}x (buffering)</div>`;
                    } else {
                        speedNoticeEl.innerHTML = '';
                    }
                }
                if (progressBarEl) {
                    progressBarEl.style.width = `${safePercent}%`;
                }
            };

            // Export based on camera selection
            if (camera === 'all') {
                await this.videoExport.exportComposite({
                    format: this.settingsManager.get('exportFormat'),
                    quality: 0.9,
                    startTime: exportStartTime,
                    endTime: exportEndTime,
                    includeOverlay: true,
                    speed: currentSpeed,
                    onProgress: progressCallback
                });
            } else {
                await this.videoExport.exportSingle(camera, {
                    format: this.settingsManager.get('exportFormat'),
                    startTime: exportStartTime,
                    endTime: exportEndTime,
                    includeOverlay: true,
                    speed: currentSpeed,
                    onProgress: progressCallback
                });
            }

            // Remove cancel handler (cancelBtn is stable, not recreated)
            if (cancelBtn && cancelHandler) {
                cancelBtn.removeEventListener('click', cancelHandler);
            }

            // Show completion overlay
            this.showExportComplete();

        } catch (error) {
            // Try to clean up cancel handler - cancelBtn may or may not exist depending on where error occurred
            const cleanupBtn = document.getElementById('cancelExportBtn');
            if (cleanupBtn && cancelHandler) {
                cleanupBtn.removeEventListener('click', cancelHandler);
            }
            this.hideLoading();
            this.enableControls();

            // Don't show error alert for user-initiated cancellation
            if (error.message && error.message.includes('cancelled')) {
                console.log('Export cancelled by user');
            } else {
                console.error('Export failed:', error);
                alert('Export failed: ' + error.message);
            }
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
        const allCamerasBtn = this.exportDropdown.querySelector('[data-camera="all"]');
        if (allCamerasBtn && this.layoutManager) {
            const config = this.layoutManager.getCurrentConfig();
            const layoutName = config?.name || this.layoutManager.getCurrentLayout();
            // Format the display name - capitalize each word
            const displayName = layoutName
                .replace(/^layout-/, '')
                .replace(/-/g, ' ')
                .replace(/\b\w/g, c => c.toUpperCase());
            // Two lines: "Current Layout" on first, name on second
            allCamerasBtn.innerHTML = `Current Layout<span class="layout-name-line">${displayName}</span>`;
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

        this.bookmarksList.innerHTML = sortedBookmarks.map(bookmark => `
            <div class="bookmark-item" data-bookmark-id="${bookmark.id}" data-time="${bookmark.time}">
                <span class="bookmark-item-time">${this.formatTime(bookmark.time)}</span>
                <span class="bookmark-item-label">${bookmark.label}</span>
                <button class="bookmark-delete-btn" data-bookmark-id="${bookmark.id}" title="Delete bookmark">
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
     * Handle keyboard shortcuts
     * @param {KeyboardEvent} event
     */
    async handleKeyPress(event) {
        // Ignore if typing in input
        if (event.target.tagName === 'INPUT') return;

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
                    const currentTime = this.videoPlayer.getCurrentTime();
                    await this.videoPlayer.seek(currentTime - 5);
                }
                break;

            case 'ArrowRight':
                event.preventDefault();
                if (event.shiftKey) {
                    this.nextClip();
                } else {
                    // Seek forward 5 seconds
                    const currentTime = this.videoPlayer.getCurrentTime();
                    await this.videoPlayer.seek(currentTime + 5);
                }
                break;

            case 'KeyL':
                event.preventDefault();
                this.layoutManager.nextLayout();
                this.layoutSelect.value = this.layoutManager.getCurrentLayout();
                break;

            case 'KeyH':
            case 'Slash':
                // ? or H for help
                if (event.key === '?' || event.code === 'KeyH') {
                    event.preventDefault();
                    this.helpModal.toggle();
                }
                break;

            case 'Comma':
                // , for settings
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
                // 1-4 for focus camera
                event.preventDefault();
                const cameras = ['front', 'back', 'left_repeater', 'right_repeater'];
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
                // Clear marks or close modals
                event.preventDefault();
                if (this.clipMarking.hasMarks()) {
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
        }
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
     * Show export completion overlay
     */
    showExportComplete() {
        this.loadingOverlay.style.display = 'flex';
        this.loadingOverlay.classList.remove('hidden');
        this.loadingText.innerHTML = `
            <div style="text-align: center;">
                <div style="font-size: 1.5rem; font-weight: bold; margin-bottom: 1rem; color: #4caf50;">
                    Export Complete
                </div>
                <div style="font-size: 1rem; color: #e0e0e0; margin-bottom: 2rem;">
                    Your video has been saved successfully.
                </div>
                <div style="width: 300px; height: 8px; background: #3a3a3a; border-radius: 4px; margin: 1rem auto 2rem; overflow: hidden;">
                    <div style="width: 100%; height: 100%; background: linear-gradient(90deg, #4caf50, #66bb6a);"></div>
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
                    OK
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

}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new TeslaCamViewerApp();

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
