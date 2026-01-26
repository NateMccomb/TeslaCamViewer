/**
 * PlateEnhancer - Multi-frame license plate enhancement
 * Combines frames from multiple cameras and time points to enhance license plate readability
 */
class PlateEnhancer {
    constructor() {
        // Initialize enhancement pipeline - tcv.0x504C45
        this.isOpenCVLoaded = false;
        this.isLoadingOpenCV = false;
        this.selections = new Map(); // cameraId -> { x, y, width, height }
        this.activeCamera = null;
        this.isSelecting = false;
        this.contextMenu = null;
        this.overlays = new Map();

        // Processing state
        this.isProcessing = false;
        this.shouldCancel = false;

        // Interaction state
        this.isDraggingOrResizing = false;

        // OCR state
        this.isTesseractLoaded = false;
        this.isLoadingTesseract = false;
        this.tesseractWorker = null;

        // Re-processing state (stores last extraction for manual frame selection/region adjustment)
        this.lastExtraction = null; // { regions, frames, settings }
        this.lastEnhanced = null;   // Result from last processing
        this.originalEnhanced = null; // Original result before any reprocessing (never overwritten)

        // Plate cycling state (for multi-camera detection workflow)
        this.cyclingState = {
            isActive: false,
            detections: [],      // All detected plates: { cameraId, bbox, confidence, videoDims }
            currentIndex: 0,     // Which plate is currently shown
            adjustedBbox: null   // User's adjusted bounding box
        };
        this.cyclingOverlay = null;
        this.handleCyclingKeyDown = this.handleCyclingKeyDown.bind(this);

        // Timeframe preference
        this.preferredTimeframe = parseInt(localStorage.getItem('tcv_plate_timeframe') || '5');

        // Apply video enhancements to source frames before processing
        this.applyVideoEnhancementsToSource = localStorage.getItem('tcv_plate_apply_video_enhancements') === 'true';

        // Bounding box padding (percentage of bbox size to add on each side)
        // Lower = tighter crop = better OCR, but less margin for tracking errors
        this.bboxPadding = 0.10; // 10% padding on each side = 120% total size

        // Bind methods
        this.handleContextMenu = this.handleContextMenu.bind(this);
        this.handleDocumentClick = this.handleDocumentClick.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);
    }

    /**
     * Initialize the plate enhancer - call after DOM ready
     */
    init() {
        this.attachContextMenuListeners();
        console.log('[PlateEnhancer] Initialized');
    }

    /**
     * Update the enhance region button active state
     * @param {boolean} active - Whether the mode is active
     */
    setButtonActive(active) {
        const btn = document.getElementById('enhanceRegionBtn');
        if (btn) {
            if (active) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        }
    }

    /**
     * Start enhance region mode from button click
     * Goes directly to auto-detect like 'D' key (no camera selection prompt)
     */
    startEnhanceRegionMode() {
        // Don't start if already processing or selecting
        if (this.isProcessing) {
            this.showToast('Enhancement in progress - please wait or cancel first');
            return;
        }
        if (this.isSelecting) {
            this.showToast('Finish or cancel current selection first (Enter/Escape)');
            return;
        }
        if (this.selections.size > 0) {
            this.showToast('Process or clear existing selection first');
            return;
        }

        // Go directly to auto-detect (same as 'D' key)
        this.autoDetectPlates();
    }

    /**
     * Show overlay prompting user to click on a camera
     */
    showCameraSelectionPrompt() {
        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'enhance-region-camera-prompt';
        overlay.innerHTML = `
            <div class="enhance-region-prompt-message">
                Click on a camera to start region selection
                <div class="enhance-region-prompt-hint">Press Escape to cancel</div>
            </div>
        `;

        // Add click handlers to video containers
        const videoContainers = document.querySelectorAll('.video-container');
        const clickHandlers = [];

        videoContainers.forEach(container => {
            // Skip hidden cameras
            if (container.classList.contains('camera-hidden')) return;
            const computedStyle = window.getComputedStyle(container);
            if (computedStyle.display === 'none') return;

            // Get camera ID
            const cameraId = this.getCameraIdFromContainer(container);
            if (!cameraId) return;

            // Check if video is loaded
            const video = container.querySelector('video');
            if (!video || !video.src || video.readyState < 2) return;

            // Add highlight on hover
            container.classList.add('enhance-region-camera-selectable');

            const handler = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.removeCameraSelectionPrompt(overlay, videoContainers, clickHandlers, escHandler);
                this.startSelection(cameraId);
            };
            container.addEventListener('click', handler);
            clickHandlers.push({ container, handler });
        });

        // Escape key handler
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                this.removeCameraSelectionPrompt(overlay, videoContainers, clickHandlers, escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        document.body.appendChild(overlay);
    }

    /**
     * Remove camera selection prompt
     */
    removeCameraSelectionPrompt(overlay, containers, handlers, escHandler) {
        overlay.remove();
        handlers.forEach(({ container, handler }) => {
            container.removeEventListener('click', handler);
            container.classList.remove('enhance-region-camera-selectable');
        });
        containers.forEach(c => c.classList.remove('enhance-region-camera-selectable'));
        document.removeEventListener('keydown', escHandler);
    }

    /**
     * Attach right-click context menu to video containers and video elements
     */
    attachContextMenuListeners() {
        const videoContainers = document.querySelectorAll('.video-container');
        videoContainers.forEach(container => {
            container.addEventListener('contextmenu', this.handleContextMenu);

            // Also attach to the video element itself to override browser's default menu
            const video = container.querySelector('video');
            if (video) {
                video.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Create a synthetic event targeting the container
                    this.handleContextMenu.call(this, {
                        preventDefault: () => {},
                        currentTarget: container,
                        clientX: e.clientX,
                        clientY: e.clientY
                    });
                });
            }
        });
    }

    /**
     * Handle right-click on video container
     */
    handleContextMenu(e) {
        e.preventDefault();

        // Don't show context menu while processing is active
        if (this.isProcessing) {
            this.showToast('Enhancement in progress - please wait or cancel first');
            return;
        }

        // Don't show context menu while selecting a region
        if (this.isSelecting) {
            this.showToast('Finish or cancel current selection first (Enter/Escape)');
            return;
        }

        // Don't show context menu if there's already a selection - must process or clear it first
        if (this.selections.size > 0) {
            this.showToast('Process or clear existing selection first');
            return;
        }

        // Don't show if no video is loaded
        const video = e.currentTarget.querySelector('video');
        if (!video || !video.src || video.readyState < 2) {
            return;
        }

        // Don't show for hidden cameras (hidden by layout manager or CSS)
        const container = e.currentTarget;
        if (container.classList.contains('camera-hidden')) {
            return;
        }
        const computedStyle = window.getComputedStyle(container);
        if (computedStyle.display === 'none') {
            return;
        }

        // Remove any existing context menu
        this.removeContextMenu();

        // Get camera ID from the container
        const cameraId = this.getCameraIdFromContainer(e.currentTarget);

        // Create and show context menu
        this.contextMenu = this.createContextMenu(e.clientX, e.clientY, cameraId);
        document.body.appendChild(this.contextMenu);

        // Listen for clicks outside to close
        setTimeout(() => {
            document.addEventListener('click', this.handleDocumentClick);
        }, 0);
    }

    /**
     * Get camera ID from video container
     */
    getCameraIdFromContainer(container) {
        const video = container.querySelector('video');
        if (!video) return null;

        const id = video.id;
        const mapping = {
            'videoFront': 'front',
            'videoBack': 'back',
            'videoLeft': 'left_repeater',
            'videoRight': 'right_repeater',
            'videoLeftPillar': 'left_pillar',
            'videoRightPillar': 'right_pillar'
        };
        return mapping[id] || null;
    }

    /**
     * Create context menu element
     */
    createContextMenu(x, y, cameraId) {
        const menu = document.createElement('div');
        menu.className = 'plate-enhancer-context-menu';
        menu.innerHTML = `
            <div class="plate-enhancer-context-menu-item" data-action="enhance">
                <svg viewBox="0 0 24 24">
                    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                    <path d="M12 10h-2v2H9v-2H7V9h2V7h1v2h2v1z"/>
                </svg>
                <span>Enhance Region...</span>
            </div>
        `;

        // Position menu
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        // Adjust if off-screen
        setTimeout(() => {
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                menu.style.left = `${window.innerWidth - rect.width - 8}px`;
            }
            if (rect.bottom > window.innerHeight) {
                menu.style.top = `${window.innerHeight - rect.height - 8}px`;
            }
        }, 0);

        // Handle menu item click
        menu.querySelector('[data-action="enhance"]').addEventListener('click', () => {
            this.removeContextMenu();
            this.startSelection(cameraId);
        });

        return menu;
    }

    /**
     * Remove context menu
     */
    removeContextMenu() {
        if (this.contextMenu) {
            this.contextMenu.remove();
            this.contextMenu = null;
        }
        document.removeEventListener('click', this.handleDocumentClick);
    }

    /**
     * Handle clicks outside context menu
     */
    handleDocumentClick(e) {
        if (this.contextMenu && !this.contextMenu.contains(e.target)) {
            this.removeContextMenu();
        }
    }

    /**
     * Start region selection mode
     */
    async startSelection(cameraId) {
        // Pause video if playing
        const videoPlayer = window.app?.videoPlayer;
        if (videoPlayer && videoPlayer.isPlaying) {
            await videoPlayer.pause();
        }

        // Load OpenCV if needed
        if (!this.isOpenCVLoaded) {
            const loaded = await this.loadOpenCV();
            if (!loaded) {
                this.showError('Failed to load image processing library. Please check your internet connection.');
                return;
            }
        }

        this.isSelecting = true;
        this.activeCamera = cameraId;
        this.selections.clear();

        // Highlight button to show mode is active
        this.setButtonActive(true);

        // Add selection overlay to all video containers
        this.createSelectionOverlays();

        // Listen for keyboard
        document.addEventListener('keydown', this.handleKeyDown);
    }

    /**
     * Create selection overlays on all visible video containers
     */
    createSelectionOverlays() {
        const videoContainers = document.querySelectorAll('.video-container');

        videoContainers.forEach(container => {
            const video = container.querySelector('video');
            if (!video || !video.src) return;

            // Skip cameras without loaded video (e.g., pillar cameras when event doesn't have them)
            // readyState < 2 means video metadata not loaded yet
            if (video.readyState < 2 || video.videoWidth === 0) return;

            // Skip hidden cameras (hidden by layout manager class)
            if (container.classList.contains('camera-hidden')) return;

            // Check computed display style (catches CSS display: none from layout rules)
            const computedStyle = window.getComputedStyle(container);
            if (computedStyle.display === 'none') return;

            // Also check if container is actually visible (has dimensions)
            const rect = container.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;

            const cameraId = this.getCameraIdFromContainer(container);
            if (!cameraId) return;

            const overlay = document.createElement('div');
            overlay.className = 'plate-enhancer-overlay';
            overlay.dataset.camera = cameraId;

            // Add instruction panel on first (active) camera - append to body to avoid overflow clipping
            if (cameraId === this.activeCamera) {
                const instruction = document.createElement('div');
                instruction.className = 'plate-enhancer-instruction';
                instruction.innerHTML = `
                    <div class="instruction-icon">🎯</div>
                    <div class="instruction-title">Select License Plate Region</div>
                    <div class="instruction-steps">
                        <div class="instruction-step"><span class="step-num">1</span> Click on the license plate to place selection box</div>
                        <div class="instruction-step"><span class="step-num">2</span> Drag corners/edges to resize the selection</div>
                        <div class="instruction-step"><span class="step-num">3</span> Mark same plate on other camera angles (optional)</div>
                    </div>
                    <div class="instruction-auto-detect">
                        <button class="auto-detect-btn" id="autoDetectPlatesBtn">
                            <svg viewBox="0 0 24 24" width="16" height="16">
                                <path fill="currentColor" d="M9.5 3A6.5 6.5 0 0 1 16 9.5c0 1.61-.59 3.09-1.56 4.23l.27.27h.79l5 5-1.5 1.5-5-5v-.79l-.27-.27A6.516 6.516 0 0 1 9.5 16 6.5 6.5 0 0 1 3 9.5 6.5 6.5 0 0 1 9.5 3m0 2C7 5 5 7 5 9.5S7 14 9.5 14 14 12 14 9.5 12 5 9.5 5Z"/>
                            </svg>
                            Auto-Detect Plates
                        </button>
                        <span class="auto-detect-hint">AI finds plates automatically</span>
                    </div>
                    <div class="instruction-keys">
                        <span><kbd>Enter</kbd> to continue</span>
                        <span class="key-separator">•</span>
                        <span><kbd>Esc</kbd> to cancel</span>
                    </div>
                `;

                // Bind auto-detect button click
                setTimeout(() => {
                    const btn = document.getElementById('autoDetectPlatesBtn');
                    if (btn) {
                        btn.addEventListener('click', () => this.autoDetectPlates());
                    }
                }, 0);
                // Append to sidebar for proper positioning within sidebar bounds
                const sidebar = document.querySelector('.sidebar');
                if (sidebar) {
                    sidebar.appendChild(instruction);
                } else {
                    document.body.appendChild(instruction);
                }
                this.instructionElement = instruction;
            }

            // Handle click to create selection
            overlay.addEventListener('click', (e) => this.handleOverlayClick(e, cameraId, container));

            // Note: Don't set container.style.position - the CSS already handles this
            // Base CSS has position: relative, and some layouts use position: absolute
            container.appendChild(overlay);
            this.overlays.set(cameraId, overlay);
        });
    }

    /**
     * Handle click on overlay to create/update selection
     */
    handleOverlayClick(e, cameraId, container) {
        // Ignore if we just finished dragging/resizing
        if (this.isDraggingOrResizing) {
            return;
        }

        const overlay = this.overlays.get(cameraId);
        if (!overlay) return;

        const rect = container.getBoundingClientRect();
        const video = container.querySelector('video');

        // Calculate where the video actually displays within the container
        // (accounting for object-fit: contain letterboxing)
        const videoDisplay = this.getVideoDisplayRect(video, rect);

        // Calculate click position relative to container
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;

        // Default selection size (will be resizable)
        const defaultWidth = 120;
        const defaultHeight = 50;

        // Center selection on click
        const selection = {
            x: Math.max(0, clickX - defaultWidth / 2),
            y: Math.max(0, clickY - defaultHeight / 2),
            width: defaultWidth,
            height: defaultHeight,
            containerWidth: rect.width,
            containerHeight: rect.height,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            // Store video display info for accurate coordinate mapping
            videoDisplayX: videoDisplay.x,
            videoDisplayY: videoDisplay.y,
            videoDisplayWidth: videoDisplay.width,
            videoDisplayHeight: videoDisplay.height
        };

        // Constrain to container
        if (selection.x + selection.width > rect.width) {
            selection.x = rect.width - selection.width;
        }
        if (selection.y + selection.height > rect.height) {
            selection.y = rect.height - selection.height;
        }

        console.log(`[PlateEnhancer] Selection created: click=(${clickX.toFixed(0)},${clickY.toFixed(0)}) box=(${selection.x.toFixed(0)},${selection.y.toFixed(0)} ${selection.width}x${selection.height}) container=${rect.width.toFixed(0)}x${rect.height.toFixed(0)} videoDisplay=(${videoDisplay.x.toFixed(0)},${videoDisplay.y.toFixed(0)} ${videoDisplay.width.toFixed(0)}x${videoDisplay.height.toFixed(0)}) video=${video.videoWidth}x${video.videoHeight}`);
        this.selections.set(cameraId, selection);
        this.renderSelection(cameraId, overlay, selection);
    }

    /**
     * Calculate where the video actually displays within its container
     * Accounts for object-fit: contain letterboxing
     */
    getVideoDisplayRect(video, containerRect) {
        const videoAspect = video.videoWidth / video.videoHeight;
        const containerAspect = containerRect.width / containerRect.height;

        let displayWidth, displayHeight, displayX, displayY;

        if (videoAspect > containerAspect) {
            // Video is wider - letterbox top/bottom
            displayWidth = containerRect.width;
            displayHeight = containerRect.width / videoAspect;
            displayX = 0;
            displayY = (containerRect.height - displayHeight) / 2;
        } else {
            // Video is taller - letterbox left/right
            displayHeight = containerRect.height;
            displayWidth = containerRect.height * videoAspect;
            displayX = (containerRect.width - displayWidth) / 2;
            displayY = 0;
        }

        return {
            x: displayX,
            y: displayY,
            width: displayWidth,
            height: displayHeight
        };
    }

    /**
     * Auto-detect license plates using AI and enter cycling mode
     * Scans ALL cameras and collects all detected plates
     */
    async autoDetectPlates() {
        const btn = document.getElementById('autoDetectPlatesBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `
                <svg class="spinner" viewBox="0 0 24 24" width="16" height="16">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="31.4 31.4" transform="rotate(-90 12 12)"/>
                </svg>
                Detecting...
            `;
        }

        try {
            // Guard: Don't start detection if cycling mode is active
            if (this.cyclingState.isActive) {
                console.log('[PlateEnhancer] Already in cycling mode');
                return;
            }

            // Guard: Don't start if already processing
            if (this.isProcessing) {
                this.showToast('Enhancement in progress - please wait', 'info');
                return;
            }

            // Ensure overlays exist (needed when called directly via 'D' key)
            // Also set proper state when entering via 'D' key
            if (!this.overlays || this.overlays.size === 0) {
                // Set active camera before creating overlays (overlays check this)
                if (!this.activeCamera) {
                    this.activeCamera = 'front';
                }
                this.isSelecting = true;
                this.selections.clear();
                this.createSelectionOverlays();
                // Add keyboard listener for Escape to cancel
                document.addEventListener('keydown', this.handleKeyDown);
                // Highlight button to show mode is active
                this.setButtonActive(true);
            }

            // Initialize plate detector if not available
            if (!window.plateDetector) {
                window.plateDetector = new PlateDetector();
            }

            const detector = window.plateDetector;

            // Load model if needed
            if (!detector.isReady()) {
                console.log('[PlateEnhancer] Loading plate detection model...');
                const loaded = await detector.loadModel((progress) => {
                    if (btn && progress.percent >= 0) {
                        btn.innerHTML = `
                            <svg class="spinner" viewBox="0 0 24 24" width="16" height="16">
                                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="31.4 31.4" transform="rotate(-90 12 12)"/>
                            </svg>
                            Loading AI... ${progress.percent}%
                        `;
                    }
                });

                if (!loaded) {
                    this.showToast('Failed to load plate detection model', 'error');
                    return;
                }
            }

            // Run detection on ALL visible cameras and collect ALL detections
            const allDetections = [];

            for (const [cameraId, overlay] of this.overlays) {
                const video = this.getVideoElement(cameraId);
                if (!video || video.readyState < 2) continue;

                // Run detection
                const detections = await detector.detect(video);
                console.log(`[PlateEnhancer] ${cameraId}: Found ${detections.length} plates`);

                // Store each detection with camera info
                for (const detection of detections) {
                    const container = overlay.parentElement;
                    const rect = container.getBoundingClientRect();
                    const videoDisplay = this.getVideoDisplayRect(video, rect);

                    allDetections.push({
                        cameraId,
                        bbox: {
                            x: detection.x,
                            y: detection.y,
                            width: detection.width,
                            height: detection.height
                        },
                        confidence: detection.confidence,
                        videoDims: {
                            width: video.videoWidth,
                            height: video.videoHeight
                        },
                        containerDims: {
                            width: rect.width,
                            height: rect.height
                        },
                        videoDisplay: {
                            x: videoDisplay.x,
                            y: videoDisplay.y,
                            width: videoDisplay.width,
                            height: videoDisplay.height
                        }
                    });
                }
            }

            // Sort by confidence (highest first)
            allDetections.sort((a, b) => b.confidence - a.confidence);

            if (allDetections.length === 0) {
                // No plates detected - offer manual selection
                this.showToast('No plates auto-detected. Click and drag to select a region manually.', 'info');

                // If we're already in selection mode (overlays exist), just let user continue manually
                // Don't create duplicate overlays or enter selection mode again
                if (this.isSelecting && this.overlays && this.overlays.size > 0) {
                    console.log('[PlateEnhancer] Already in selection mode, user can select manually');
                    return;
                }

                // If called via 'D' key without being in selection mode, enter selection mode properly
                // Get focused camera or default to front
                const vp = window.app?.videoPlayer;
                let focusedCameraId = null;

                // Try to get focused video's camera ID
                const focusedVideo = vp?.getFocusedVideo?.();
                if (focusedVideo) {
                    focusedCameraId = this.getCameraIdFromContainer(focusedVideo.parentElement);
                }

                // Default to front camera if no focus
                if (!focusedCameraId) {
                    focusedCameraId = 'front';
                }

                // Clean up any partial state before entering selection mode
                this.removeOverlays();
                this.selections.clear();
                this.isSelecting = false;
                this.activeCamera = null;
                document.removeEventListener('keydown', this.handleKeyDown);

                // Enter proper selection mode
                await this.startSelection(focusedCameraId);
                return;
            }

            // Remove instruction panel and overlays, reset selection state
            if (this.instructionElement) {
                this.instructionElement.remove();
                this.instructionElement = null;
            }
            this.removeOverlays();
            this.isSelecting = false;
            this.activeCamera = null;
            document.removeEventListener('keydown', this.handleKeyDown);

            // Enter cycling mode - capture time NOW when plate was detected
            const vp = window.app?.videoPlayer;
            const detectionTime = vp?.getCurrentAbsoluteTime?.() ?? vp?.getCurrentTime?.() ?? 0;

            this.cyclingState = {
                isActive: true,
                detections: allDetections,
                currentIndex: 0,
                adjustedBbox: null,
                detectionTime: detectionTime  // Time when plate was detected
            };

            this.showPlateCyclingUI();
            this.showToast(`Found ${allDetections.length} plate${allDetections.length > 1 ? 's' : ''} - use ← → to cycle`, 'success');

        } catch (error) {
            console.error('[PlateEnhancer] Auto-detect error:', error);
            this.showToast('Detection failed: ' + error.message, 'error');
        } finally {
            // Reset button if still visible
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `
                    <svg viewBox="0 0 24 24" width="16" height="16">
                        <path fill="currentColor" d="M9.5 3A6.5 6.5 0 0 1 16 9.5c0 1.61-.59 3.09-1.56 4.23l.27.27h.79l5 5-1.5 1.5-5-5v-.79l-.27-.27A6.516 6.516 0 0 1 9.5 16 6.5 6.5 0 0 1 3 9.5 6.5 6.5 0 0 1 9.5 3m0 2C7 5 5 7 5 9.5S7 14 9.5 14 14 12 14 9.5 12 5 9.5 5Z"/>
                    </svg>
                    Auto-Detect Plates
                `;
            }
        }
    }

    /**
     * Show the plate cycling UI overlay
     * Displays one plate at a time with navigation, adjustable bbox, and timeframe selection
     */
    showPlateCyclingUI() {
        const { detections, currentIndex } = this.cyclingState;
        if (detections.length === 0) return;

        // Pause video to freeze the frame for accurate preview
        const videoPlayer = window.app?.videoPlayer;
        if (videoPlayer && videoPlayer.isPlaying) {
            videoPlayer.pause();
        }

        // Remove existing overlay
        if (this.cyclingOverlay) {
            this.cyclingOverlay.remove();
        }

        const detection = detections[currentIndex];
        const video = this.getVideoElement(detection.cameraId);
        const container = video?.parentElement;
        if (!container) return;

        // Get available footage time
        const vp = window.app?.videoPlayer;
        const currentTime = vp?.getCurrentAbsoluteTime?.() ?? vp?.getCurrentTime?.() ?? 0;
        // Use cached duration for synchronous UI (getTotalDuration is async)
        let totalDuration = 600; // Default fallback
        if (vp?.cachedClipDurations?.length > 0) {
            const cached = vp.cachedClipDurations.reduce((a, b) => a + b, 0);
            if (cached > 0) totalDuration = cached;
        }
        const maxBefore = Math.min(currentTime, 10);
        const maxAfter = Math.min(totalDuration - currentTime, 10);

        // Create the cycling overlay
        this.cyclingOverlay = document.createElement('div');
        this.cyclingOverlay.className = 'plate-cycling-overlay';
        this.cyclingOverlay.innerHTML = `
            <div class="plate-cycling-panel">
                <div class="plate-cycling-header">
                    ${detections.length > 1 ? `
                    <button class="plate-cycling-nav-btn prev-btn" ${currentIndex === 0 ? 'disabled' : ''} title="Previous plate (←)">
                        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                    </button>` : ''}
                    <div class="plate-cycling-info">
                        <span class="plate-cycling-counter">${detection.isManual ? 'Manual Selection' : `Plate ${currentIndex + 1} of ${detections.length}`}</span>
                        <span class="plate-cycling-camera">${this.getCameraDisplayName(detection.cameraId)}</span>
                        <span class="plate-cycling-confidence">${detection.isManual ? '' : `Confidence: ${Math.round(detection.confidence * 100)}%`}</span>
                    </div>
                    ${detections.length > 1 ? `
                    <button class="plate-cycling-nav-btn next-btn" ${currentIndex === detections.length - 1 ? 'disabled' : ''} title="Next plate (→)">
                        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>
                    </button>` : ''}
                </div>

                <div class="plate-cycling-video-container" data-camera="${detection.cameraId}">
                    <!-- Video preview with bounding box will be inserted here -->
                </div>

                <div class="plate-cycling-timeframe">
                    <div class="plate-cycling-timeframe-label">Analysis Timeframe:</div>
                    <div class="plate-cycling-timeframe-btns">
                        <button class="plate-cycling-timeframe-btn ${this.preferredTimeframe === 2 ? 'selected' : ''}" data-seconds="2" ${maxBefore < 1 && maxAfter < 1 ? 'disabled' : ''}>
                            ±2s
                            <span class="timeframe-hint">Quick</span>
                        </button>
                        <button class="plate-cycling-timeframe-btn ${this.preferredTimeframe === 5 ? 'selected' : ''}" data-seconds="5" ${maxBefore < 2.5 && maxAfter < 2.5 ? 'disabled' : ''}>
                            ±5s
                            <span class="timeframe-hint">Recommended</span>
                        </button>
                        <button class="plate-cycling-timeframe-btn ${this.preferredTimeframe === 10 ? 'selected' : ''}" data-seconds="10" ${maxBefore < 5 && maxAfter < 5 ? 'disabled' : ''}>
                            ±10s
                            <span class="timeframe-hint">Thorough</span>
                        </button>
                    </div>
                    <div class="plate-cycling-available">Available: ${maxBefore.toFixed(1)}s before, ${maxAfter.toFixed(1)}s after</div>
                </div>

                <div class="plate-cycling-option">
                    <label class="plate-cycling-checkbox">
                        <input type="checkbox" id="apply-video-enhancements" ${this.applyVideoEnhancementsToSource ? 'checked' : ''}>
                        <span class="checkmark"></span>
                        Apply Video Enhancements to source frames
                    </label>
                    <span class="plate-cycling-option-hint">Use your brightness/contrast/saturation settings</span>
                </div>

                <div class="plate-cycling-size-warning" style="display: none;">
                    <!-- Size warning will be inserted here dynamically -->
                </div>

                <div class="plate-cycling-actions">
                    <button class="plate-cycling-btn cancel-btn">Cancel</button>
                    <button class="plate-cycling-btn enhance-btn primary">
                        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z M12 10h-2v2H9v-2H7V9h2V7h1v2h2v1z"/></svg>
                        Enhance This Plate
                    </button>
                </div>

                <div class="plate-cycling-shortcuts">
                    ${detections.length > 1 ? '<kbd>←</kbd> <kbd>→</kbd> Navigate &nbsp;•&nbsp; ' : ''}<kbd>Enter</kbd> Select &nbsp;•&nbsp; <kbd>Esc</kbd> Cancel
                </div>
            </div>
        `;

        document.body.appendChild(this.cyclingOverlay);

        // Render the video preview with bounding box
        this.renderCyclingPreview(detection);

        // Bind event handlers
        this.bindCyclingEvents();

        // Add keyboard listener
        document.addEventListener('keydown', this.handleCyclingKeyDown);
    }

    /**
     * Render the video preview with adjustable bounding box in cycling mode
     */
    renderCyclingPreview(detection) {
        const previewContainer = this.cyclingOverlay.querySelector('.plate-cycling-video-container');
        if (!previewContainer) return;

        const video = this.getVideoElement(detection.cameraId);
        if (!video || video.readyState < 2) return;

        // Create a canvas to show the video frame with bounding box
        const canvas = document.createElement('canvas');
        const previewWidth = 600;
        const previewHeight = Math.round(previewWidth * (video.videoHeight / video.videoWidth));
        canvas.width = previewWidth;
        canvas.height = previewHeight;
        canvas.className = 'plate-cycling-canvas';

        const ctx = canvas.getContext('2d');

        // Apply video enhancements to preview if enabled
        if (this.applyVideoEnhancementsToSource) {
            const settings = this.getVideoEnhancementSettings();
            this.applyVideoEnhancementsToCanvas(ctx, settings);
        }

        ctx.drawImage(video, 0, 0, previewWidth, previewHeight);

        // Reset filter after drawing
        ctx.filter = 'none';

        // Calculate scaled bbox position
        const scaleX = previewWidth / video.videoWidth;
        const scaleY = previewHeight / video.videoHeight;

        // Use adjusted bbox if available, otherwise use detection bbox
        const bbox = this.cyclingState.adjustedBbox || detection.bbox;
        const padding = this.bboxPadding;

        const x = (bbox.x - bbox.width * padding) * scaleX;
        const y = (bbox.y - bbox.height * padding) * scaleY;
        const w = bbox.width * (1 + padding * 2) * scaleX;
        const h = bbox.height * (1 + padding * 2) * scaleY;

        previewContainer.innerHTML = '';

        // Create wrapper to ensure selection box is positioned relative to canvas
        const canvasWrapper = document.createElement('div');
        canvasWrapper.className = 'plate-cycling-canvas-wrapper';
        canvasWrapper.style.position = 'relative';
        canvasWrapper.style.display = 'inline-block';
        canvasWrapper.appendChild(canvas);

        // Add selection box overlay using percentages (so it scales with CSS-scaled canvas)
        const selectionBox = document.createElement('div');
        selectionBox.className = 'plate-cycling-selection';
        // Use percentage positioning relative to canvas size
        const leftPct = (x / previewWidth) * 100;
        const topPct = (y / previewHeight) * 100;
        const widthPct = (w / previewWidth) * 100;
        const heightPct = (h / previewHeight) * 100;
        selectionBox.style.left = `${leftPct}%`;
        selectionBox.style.top = `${topPct}%`;
        selectionBox.style.width = `${widthPct}%`;
        selectionBox.style.height = `${heightPct}%`;

        // Add resize handles
        ['nw', 'ne', 'sw', 'se'].forEach(pos => {
            const handle = document.createElement('div');
            handle.className = `plate-cycling-handle ${pos}`;
            handle.addEventListener('mousedown', (e) => this.startCyclingResize(e, pos, detection, scaleX, scaleY));
            selectionBox.appendChild(handle);
        });

        // Add size indicator showing video pixel dimensions
        const sizeIndicator = document.createElement('div');
        sizeIndicator.className = 'plate-enhancer-size-indicator';
        selectionBox.appendChild(sizeIndicator);
        this.updateCyclingSizeIndicator(detection, sizeIndicator);

        // Make box draggable
        selectionBox.addEventListener('mousedown', (e) => {
            if (e.target === selectionBox) {
                this.startCyclingDrag(e, detection, scaleX, scaleY);
            }
        });

        // Add selection box to the canvas wrapper (so it's positioned relative to canvas)
        canvasWrapper.appendChild(selectionBox);
        previewContainer.appendChild(canvasWrapper);

        // Store canvas and scale for resize/drag handlers
        this.cyclingCanvas = { canvas, scaleX, scaleY, previewWidth, previewHeight, canvasWrapper };

        // Update size warning if selection is large
        this.updateCyclingSizeWarning(detection);
    }

    /**
     * Update the size warning in cycling mode based on current bbox
     */
    updateCyclingSizeWarning(detection) {
        const warningContainer = this.cyclingOverlay?.querySelector('.plate-cycling-size-warning');
        if (!warningContainer) return;

        const bbox = this.cyclingState.adjustedBbox || detection.bbox;
        const area = Math.round(bbox.width * bbox.height);

        // Same thresholds as regular selection
        const isLarge = area > 40000;
        const isVeryLarge = area > 100000;

        if (isVeryLarge) {
            warningContainer.style.display = 'block';
            warningContainer.innerHTML = `
                <div class="plate-enhancer-warning plate-enhancer-warning-severe">
                    📐 <strong>Very large selection</strong> (${Math.round(bbox.width)}×${Math.round(bbox.height)}px = ${Math.round(area/1000)}k pixels).<br>
                    Processing will be significantly slower. Consider resizing to select just the license plate area for faster results.
                </div>
            `;
        } else if (isLarge) {
            warningContainer.style.display = 'block';
            warningContainer.innerHTML = `
                <div class="plate-enhancer-warning">
                    📐 Large selection (${Math.round(bbox.width)}×${Math.round(bbox.height)}px). Processing may take longer than usual.
                </div>
            `;
        } else {
            warningContainer.style.display = 'none';
            warningContainer.innerHTML = '';
        }
    }

    /**
     * Start dragging the selection box in cycling mode
     */
    startCyclingDrag(e, detection, scaleX, scaleY) {
        e.preventDefault();
        e.stopPropagation();

        const selectionBox = e.target;
        const startX = e.clientX;
        const startY = e.clientY;
        // Values are now percentages (0-100)
        const origLeftPct = parseFloat(selectionBox.style.left);
        const origTopPct = parseFloat(selectionBox.style.top);
        const widthPct = parseFloat(selectionBox.style.width);
        const heightPct = parseFloat(selectionBox.style.height);

        const { previewWidth, previewHeight, canvas } = this.cyclingCanvas;

        // Get the actual displayed size of the canvas (may be CSS-scaled)
        const canvasRect = canvas.getBoundingClientRect();

        const onMove = (moveEvent) => {
            // Convert mouse movement to percentage of canvas size
            const dxPct = ((moveEvent.clientX - startX) / canvasRect.width) * 100;
            const dyPct = ((moveEvent.clientY - startY) / canvasRect.height) * 100;

            let newLeftPct = Math.max(0, Math.min(origLeftPct + dxPct, 100 - widthPct));
            let newTopPct = Math.max(0, Math.min(origTopPct + dyPct, 100 - heightPct));

            selectionBox.style.left = `${newLeftPct}%`;
            selectionBox.style.top = `${newTopPct}%`;
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);

            // Update adjusted bbox in video coordinates
            const padding = this.bboxPadding;
            // Convert from percentage to preview pixel coords, then to video coords
            const leftPct = parseFloat(selectionBox.style.left);
            const topPct = parseFloat(selectionBox.style.top);
            const wPct = parseFloat(selectionBox.style.width);
            const hPct = parseFloat(selectionBox.style.height);

            // Convert percentages to preview pixels
            const displayLeft = (leftPct / 100) * previewWidth;
            const displayTop = (topPct / 100) * previewHeight;
            const displayW = (wPct / 100) * previewWidth;
            const displayH = (hPct / 100) * previewHeight;

            // Convert from display (preview) coords to video coords
            const left = displayLeft / scaleX;
            const top = displayTop / scaleY;
            const w = displayW / scaleX / (1 + padding * 2);
            const h = displayH / scaleY / (1 + padding * 2);

            this.cyclingState.adjustedBbox = {
                x: left + w * padding,
                y: top + h * padding,
                width: w,
                height: h
            };

            console.log(`[PlateEnhancer] Drag end: pct=(${leftPct.toFixed(1)}%,${topPct.toFixed(1)}% ${wPct.toFixed(1)}%x${hPct.toFixed(1)}%) => display=(${displayLeft.toFixed(1)},${displayTop.toFixed(1)} ${displayW.toFixed(1)}x${displayH.toFixed(1)}) scale=(${scaleX.toFixed(4)},${scaleY.toFixed(4)}) => bbox=(${this.cyclingState.adjustedBbox.x.toFixed(1)},${this.cyclingState.adjustedBbox.y.toFixed(1)} ${this.cyclingState.adjustedBbox.width.toFixed(1)}x${this.cyclingState.adjustedBbox.height.toFixed(1)})`);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    /**
     * Start resizing the selection box in cycling mode
     */
    startCyclingResize(e, handle, detection, scaleX, scaleY) {
        e.preventDefault();
        e.stopPropagation();

        const selectionBox = e.target.parentElement;
        const startX = e.clientX;
        const startY = e.clientY;
        // Values are now percentages (0-100)
        const origLeftPct = parseFloat(selectionBox.style.left);
        const origTopPct = parseFloat(selectionBox.style.top);
        const origWidthPct = parseFloat(selectionBox.style.width);
        const origHeightPct = parseFloat(selectionBox.style.height);

        const { previewWidth, previewHeight, canvas } = this.cyclingCanvas;
        const minSizePct = 3; // Minimum size as percentage (about 3% of canvas)
        const padding = this.bboxPadding; // Define here so it's accessible in both onMove and onUp

        // Get the actual displayed size of the canvas (may be CSS-scaled)
        const canvasRect = canvas.getBoundingClientRect();

        const onMove = (moveEvent) => {
            // Convert mouse movement to percentage of canvas size
            const dxPct = ((moveEvent.clientX - startX) / canvasRect.width) * 100;
            const dyPct = ((moveEvent.clientY - startY) / canvasRect.height) * 100;

            let newLeftPct = origLeftPct;
            let newTopPct = origTopPct;
            let newWidthPct = origWidthPct;
            let newHeightPct = origHeightPct;

            if (handle.includes('e')) {
                newWidthPct = Math.max(minSizePct, origWidthPct + dxPct);
            }
            if (handle.includes('w')) {
                const proposedW = origWidthPct - dxPct;
                if (proposedW >= minSizePct) {
                    newWidthPct = proposedW;
                    newLeftPct = origLeftPct + dxPct;
                }
            }
            if (handle.includes('s')) {
                newHeightPct = Math.max(minSizePct, origHeightPct + dyPct);
            }
            if (handle.includes('n')) {
                const proposedH = origHeightPct - dyPct;
                if (proposedH >= minSizePct) {
                    newHeightPct = proposedH;
                    newTopPct = origTopPct + dyPct;
                }
            }

            // Constrain to bounds (0-100%)
            newLeftPct = Math.max(0, newLeftPct);
            newTopPct = Math.max(0, newTopPct);
            if (newLeftPct + newWidthPct > 100) newWidthPct = 100 - newLeftPct;
            if (newTopPct + newHeightPct > 100) newHeightPct = 100 - newTopPct;

            selectionBox.style.left = `${newLeftPct}%`;
            selectionBox.style.top = `${newTopPct}%`;
            selectionBox.style.width = `${newWidthPct}%`;
            selectionBox.style.height = `${newHeightPct}%`;

            // Update size indicator during resize
            const liveDisplayW = (newWidthPct / 100) * previewWidth;
            const liveDisplayH = (newHeightPct / 100) * previewHeight;
            const liveW = liveDisplayW / scaleX / (1 + padding * 2);
            const liveH = liveDisplayH / scaleY / (1 + padding * 2);
            const sizeIndicator = selectionBox.querySelector('.plate-enhancer-size-indicator');
            if (sizeIndicator) {
                const tempBbox = { width: liveW, height: liveH };
                this.updateCyclingSizeIndicator({ bbox: tempBbox }, sizeIndicator);
            }
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);

            // Update adjusted bbox in video coordinates (padding defined at outer scope)
            // Convert from percentage to preview pixel coords, then to video coords
            const leftPct = parseFloat(selectionBox.style.left);
            const topPct = parseFloat(selectionBox.style.top);
            const wPct = parseFloat(selectionBox.style.width);
            const hPct = parseFloat(selectionBox.style.height);

            // Convert percentages to preview pixels
            const displayLeft = (leftPct / 100) * previewWidth;
            const displayTop = (topPct / 100) * previewHeight;
            const displayW = (wPct / 100) * previewWidth;
            const displayH = (hPct / 100) * previewHeight;

            // Convert from display (preview) coords to video coords
            const left = displayLeft / scaleX;
            const top = displayTop / scaleY;
            const w = displayW / scaleX / (1 + padding * 2);
            const h = displayH / scaleY / (1 + padding * 2);

            this.cyclingState.adjustedBbox = {
                x: left + w * padding,
                y: top + h * padding,
                width: w,
                height: h
            };

            // Update size indicator with final bbox
            const sizeIndicator = selectionBox.querySelector('.plate-enhancer-size-indicator');
            if (sizeIndicator) {
                this.updateCyclingSizeIndicator({ bbox: this.cyclingState.adjustedBbox }, sizeIndicator);
            }

            // Update the size warning in the panel
            this.updateCyclingSizeWarning({ bbox: this.cyclingState.adjustedBbox });

            console.log(`[PlateEnhancer] Resize end: pct=(${leftPct.toFixed(1)}%,${topPct.toFixed(1)}% ${wPct.toFixed(1)}%x${hPct.toFixed(1)}%) => display=(${displayLeft.toFixed(1)},${displayTop.toFixed(1)} ${displayW.toFixed(1)}x${displayH.toFixed(1)}) scale=(${scaleX.toFixed(4)},${scaleY.toFixed(4)}) => bbox=(${this.cyclingState.adjustedBbox.x.toFixed(1)},${this.cyclingState.adjustedBbox.y.toFixed(1)} ${this.cyclingState.adjustedBbox.width.toFixed(1)}x${this.cyclingState.adjustedBbox.height.toFixed(1)})`);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    /**
     * Bind event handlers for cycling UI
     */
    bindCyclingEvents() {
        if (!this.cyclingOverlay) return;

        // Navigation buttons
        this.cyclingOverlay.querySelector('.prev-btn')?.addEventListener('click', () => this.cyclePlate('prev'));
        this.cyclingOverlay.querySelector('.next-btn')?.addEventListener('click', () => this.cyclePlate('next'));

        // Timeframe buttons
        this.cyclingOverlay.querySelectorAll('.plate-cycling-timeframe-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                this.cyclingOverlay.querySelectorAll('.plate-cycling-timeframe-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                this.preferredTimeframe = parseInt(btn.dataset.seconds);
                localStorage.setItem('tcv_plate_timeframe', this.preferredTimeframe.toString());
            });
        });

        // Cancel button
        this.cyclingOverlay.querySelector('.cancel-btn')?.addEventListener('click', () => this.exitCyclingMode());

        // Enhance button
        this.cyclingOverlay.querySelector('.enhance-btn')?.addEventListener('click', () => this.startEnhancementFromCycling());

        // Video enhancements checkbox - re-render preview when toggled
        const enhancementsCheckbox = this.cyclingOverlay.querySelector('#apply-video-enhancements');
        if (enhancementsCheckbox) {
            enhancementsCheckbox.addEventListener('change', (e) => {
                this.applyVideoEnhancementsToSource = e.target.checked;
                localStorage.setItem('tcv_plate_apply_video_enhancements', this.applyVideoEnhancementsToSource.toString());

                // Re-render preview with/without video enhancements
                const detection = this.cyclingState.detections[this.cyclingState.currentIndex];
                if (detection) {
                    this.renderCyclingPreview(detection);
                }
            });
        }
    }

    /**
     * Handle keyboard events in cycling mode
     */
    handleCyclingKeyDown(e) {
        if (!this.cyclingState.isActive) return;

        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            this.cyclePlate('prev');
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            this.cyclePlate('next');
        } else if (e.key === 'Enter') {
            e.preventDefault();
            this.startEnhancementFromCycling();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            this.exitCyclingMode();
        }
    }

    /**
     * Update size indicator in cycling mode
     * @param {Object} detection - Detection object with bbox
     * @param {HTMLElement} indicator - The size indicator element
     */
    updateCyclingSizeIndicator(detection, indicator) {
        // Get the current bbox (adjusted or original)
        const bbox = this.cyclingState.adjustedBbox || detection.bbox;
        const area = Math.round(bbox.width * bbox.height);

        // Same thresholds as regular selection
        const isLarge = area > 40000;
        const isVeryLarge = area > 100000;

        indicator.textContent = `${Math.round(bbox.width)}×${Math.round(bbox.height)}px`;
        indicator.classList.toggle('warning', isLarge && !isVeryLarge);
        indicator.classList.toggle('critical', isVeryLarge);

        if (isVeryLarge) {
            indicator.title = 'Very large selection - processing will be slow. Try selecting just the plate area.';
        } else if (isLarge) {
            indicator.title = 'Large selection - processing may be slower than usual.';
        } else {
            indicator.title = 'Selection size in video pixels';
        }
    }

    /**
     * Cycle to previous or next plate
     */
    cyclePlate(direction) {
        const { detections, currentIndex } = this.cyclingState;

        let newIndex = currentIndex;
        if (direction === 'prev' && currentIndex > 0) {
            newIndex = currentIndex - 1;
        } else if (direction === 'next' && currentIndex < detections.length - 1) {
            newIndex = currentIndex + 1;
        }

        if (newIndex !== currentIndex) {
            this.cyclingState.currentIndex = newIndex;
            this.cyclingState.adjustedBbox = null; // Reset adjustments for new plate
            this.showPlateCyclingUI();
        }
    }

    /**
     * Exit cycling mode and clean up
     */
    exitCyclingMode() {
        this.cyclingState.isActive = false;
        this.cyclingState.detections = [];
        this.cyclingState.currentIndex = 0;
        this.cyclingState.adjustedBbox = null;

        // Clear any manual selections that led to this cycling UI
        this.selections.clear();

        if (this.cyclingOverlay) {
            this.cyclingOverlay.remove();
            this.cyclingOverlay = null;
        }

        document.removeEventListener('keydown', this.handleCyclingKeyDown);
        // Remove button highlight
        this.setButtonActive(false);
    }

    /**
     * Start enhancement from cycling mode with selected plate and timeframe
     */
    async startEnhancementFromCycling() {
        const { detections, currentIndex, adjustedBbox, detectionTime } = this.cyclingState;
        const detection = detections[currentIndex];

        // Get the selected timeframe
        const selectedBtn = this.cyclingOverlay?.querySelector('.plate-cycling-timeframe-btn.selected');
        const timeframeSeconds = selectedBtn ? parseInt(selectedBtn.dataset.seconds) : this.preferredTimeframe;

        // Use the time when plate was DETECTED, not current time (video may have moved)
        const vp = window.app?.videoPlayer;
        // Get total duration with robust fallback (getTotalDuration is async!)
        let totalDuration = 600; // Default fallback
        if (vp?.getTotalDuration) {
            try {
                const duration = await vp.getTotalDuration();
                if (duration && Number.isFinite(duration) && duration > 0) {
                    totalDuration = duration;
                }
            } catch (e) {
                console.warn('[PlateEnhancer] Failed to get total duration:', e);
            }
        }
        // Use saved detection time - this is when the plate was actually visible
        const currentTime = detectionTime ?? 0;
        this.referenceTime = currentTime;
        console.log(`[PlateEnhancer] Using detection time: ${currentTime.toFixed(2)}s (timeframe: ±${timeframeSeconds/2}s, duration: ${totalDuration.toFixed(1)}s)`);

        // Close cycling UI
        this.exitCyclingMode();

        const halfRange = timeframeSeconds / 2;
        const startTime = Math.max(0, currentTime - halfRange);
        // Clamp to video end with 0.1s buffer to avoid seek issues at tail
        // But ensure endTime is never less than startTime
        let endTime = Math.min(currentTime + halfRange, totalDuration - 0.1);
        if (endTime < startTime) {
            console.warn(`[PlateEnhancer] endTime (${endTime.toFixed(2)}) < startTime (${startTime.toFixed(2)}), adjusting`);
            endTime = Math.min(currentTime, totalDuration - 0.1);
        }
        // Ensure we have at least some range to sample
        if (endTime <= startTime) {
            console.warn(`[PlateEnhancer] No valid range, using single frame at ${currentTime.toFixed(2)}s`);
            endTime = startTime + 0.1; // At least 0.1s range
        }
        console.log(`[PlateEnhancer] Time range: ${startTime.toFixed(2)}s - ${endTime.toFixed(2)}s (${(endTime - startTime).toFixed(2)}s range, ref: ${currentTime.toFixed(2)}s)`);


        // Build selection from the detection
        const video = this.getVideoElement(detection.cameraId);
        if (!video) {
            this.showError('Video not available');
            return;
        }

        const container = video.parentElement;
        const rect = container.getBoundingClientRect();
        const videoDisplay = this.getVideoDisplayRect(video, rect);

        // Use adjusted bbox if available
        const bbox = adjustedBbox || detection.bbox;
        const padding = this.bboxPadding;

        const scaleX = videoDisplay.width / video.videoWidth;
        const scaleY = videoDisplay.height / video.videoHeight;

        const paddedX = bbox.x - bbox.width * padding;
        const paddedY = bbox.y - bbox.height * padding;
        const paddedW = bbox.width * (1 + padding * 2);
        const paddedH = bbox.height * (1 + padding * 2);

        const selection = {
            x: videoDisplay.x + paddedX * scaleX,
            y: videoDisplay.y + paddedY * scaleY,
            width: paddedW * scaleX,
            height: paddedH * scaleY,
            containerWidth: rect.width,
            containerHeight: rect.height,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            videoDisplayX: videoDisplay.x,
            videoDisplayY: videoDisplay.y,
            videoDisplayWidth: videoDisplay.width,
            videoDisplayHeight: videoDisplay.height,
            confidence: detection.confidence,
            autoDetected: true
        };

        // Set the selection and start processing
        this.selections.clear();
        this.selections.set(detection.cameraId, selection);

        // Use 4x super-resolution upscaling for best OCR results
        await this.startProcessing(startTime, endTime, true, 4);
    }

    /**
     * Convert selection coordinates from container space to video pixel space
     * Properly handles letterboxing from object-fit: contain
     */
    containerToVideoCoords(selection) {
        // Get the video display area within the container
        const displayX = selection.videoDisplayX || 0;
        const displayY = selection.videoDisplayY || 0;
        const displayWidth = selection.videoDisplayWidth || selection.containerWidth;
        const displayHeight = selection.videoDisplayHeight || selection.containerHeight;

        // Convert from container coords to video display coords (remove letterbox offset)
        const relativeX = selection.x - displayX;
        const relativeY = selection.y - displayY;

        // Scale from display size to actual video size
        const scaleX = selection.videoWidth / displayWidth;
        const scaleY = selection.videoHeight / displayHeight;

        const videoX = Math.round(relativeX * scaleX);
        const videoY = Math.round(relativeY * scaleY);
        const videoW = Math.round(selection.width * scaleX);
        const videoH = Math.round(selection.height * scaleY);

        // Debug logging for coordinate conversion
        console.log(`[PlateEnhancer] containerToVideoCoords: input=(${selection.x.toFixed(0)},${selection.y.toFixed(0)} ${selection.width.toFixed(0)}x${selection.height.toFixed(0)}) display=(${displayX.toFixed(0)},${displayY.toFixed(0)} ${displayWidth.toFixed(0)}x${displayHeight.toFixed(0)}) scale=${scaleX.toFixed(3)} relative=(${relativeX.toFixed(0)},${relativeY.toFixed(0)}) => video=(${videoX},${videoY} ${videoW}x${videoH}) videoSize=${selection.videoWidth}x${selection.videoHeight}`);

        // Clamp to video bounds
        return {
            x: Math.max(0, Math.min(videoX, selection.videoWidth - videoW)),
            y: Math.max(0, Math.min(videoY, selection.videoHeight - videoH)),
            width: Math.min(videoW, selection.videoWidth),
            height: Math.min(videoH, selection.videoHeight)
        };
    }

    /**
     * Render selection box on overlay
     */
    renderSelection(cameraId, overlay, selection) {
        // Remove existing selection box
        const existing = overlay.querySelector('.plate-enhancer-selection');
        if (existing) existing.remove();

        const box = document.createElement('div');
        box.className = 'plate-enhancer-selection';
        box.style.left = `${selection.x}px`;
        box.style.top = `${selection.y}px`;
        box.style.width = `${selection.width}px`;
        box.style.height = `${selection.height}px`;

        // Add resize handles
        ['nw', 'ne', 'sw', 'se'].forEach(pos => {
            const handle = document.createElement('div');
            handle.className = `plate-enhancer-handle ${pos}`;
            handle.addEventListener('mousedown', (e) => this.startResize(e, cameraId, pos));
            box.appendChild(handle);
        });

        // Add camera label
        const label = document.createElement('div');
        label.className = 'plate-enhancer-camera-label';
        label.textContent = this.getCameraDisplayName(cameraId);
        box.appendChild(label);

        // Add size indicator (shows video pixel dimensions)
        const sizeIndicator = document.createElement('div');
        sizeIndicator.className = 'plate-enhancer-size-indicator';
        box.appendChild(sizeIndicator);
        this.updateSizeIndicator(cameraId, selection, sizeIndicator);

        // Make box draggable
        box.addEventListener('mousedown', (e) => {
            if (e.target === box) {
                this.startDrag(e, cameraId);
            }
        });

        overlay.appendChild(box);
    }

    /**
     * Get display name for camera
     */
    getCameraDisplayName(cameraId) {
        const names = {
            'front': 'Front',
            'back': 'Back',
            'left_repeater': 'Left',
            'right_repeater': 'Right',
            'left_pillar': 'Left Pillar',
            'right_pillar': 'Right Pillar'
        };
        return names[cameraId] || cameraId;
    }

    /**
     * Update size indicator to show video pixel dimensions and warn if too large
     * @param {string} cameraId - Camera identifier
     * @param {Object} selection - Selection object with container dimensions
     * @param {HTMLElement} indicator - The size indicator element
     */
    updateSizeIndicator(cameraId, selection, indicator) {
        const videoCoords = this.containerToVideoCoords(selection);
        const area = videoCoords.width * videoCoords.height;

        // Classification thresholds (based on 4x ESRGAN processing time)
        // Optimal: < 40000 pixels (200x200 or smaller) - fast processing
        // Large: 40000-100000 pixels - slower, will show warning
        // Very large: > 100000 pixels - significantly slower
        const isLarge = area > 40000;
        const isVeryLarge = area > 100000;

        indicator.textContent = `${videoCoords.width}×${videoCoords.height}px`;
        indicator.classList.toggle('warning', isLarge && !isVeryLarge);
        indicator.classList.toggle('critical', isVeryLarge);

        if (isVeryLarge) {
            indicator.title = 'Very large selection - processing will be slow. Try selecting just the plate area.';
        } else if (isLarge) {
            indicator.title = 'Large selection - processing may be slower than usual.';
        } else {
            indicator.title = 'Selection size in video pixels';
        }
    }

    /**
     * Get size classification for a selection (used in enhance dialog)
     * @param {Object} selection - Selection object
     * @returns {Object} { area, classification, warning }
     */
    getSelectionSizeInfo(selection) {
        const videoCoords = this.containerToVideoCoords(selection);
        const area = videoCoords.width * videoCoords.height;

        let classification = 'optimal';
        let warning = null;

        if (area > 100000) {
            classification = 'critical';
            warning = `Selection is ${videoCoords.width}×${videoCoords.height}px (${Math.round(area/1000)}k pixels). Processing will be significantly slower. Consider selecting just the license plate area for faster results.`;
        } else if (area > 40000) {
            classification = 'large';
            warning = `Selection is ${videoCoords.width}×${videoCoords.height}px. Processing may take longer than usual.`;
        }

        return { width: videoCoords.width, height: videoCoords.height, area, classification, warning };
    }

    /**
     * Start dragging selection box
     */
    startDrag(e, cameraId) {
        e.preventDefault();
        e.stopPropagation();

        const selection = this.selections.get(cameraId);
        if (!selection) return;

        this.isDraggingOrResizing = true;

        const startX = e.clientX;
        const startY = e.clientY;
        const origX = selection.x;
        const origY = selection.y;

        const onMove = (moveEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;

            selection.x = Math.max(0, Math.min(origX + dx, selection.containerWidth - selection.width));
            selection.y = Math.max(0, Math.min(origY + dy, selection.containerHeight - selection.height));

            const overlay = this.overlays.get(cameraId);
            const box = overlay.querySelector('.plate-enhancer-selection');
            if (box) {
                box.style.left = `${selection.x}px`;
                box.style.top = `${selection.y}px`;
            }
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            // Delay clearing flag so the click event doesn't fire
            setTimeout(() => {
                this.isDraggingOrResizing = false;
            }, 50);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    /**
     * Start resizing selection box
     */
    startResize(e, cameraId, handle) {
        e.preventDefault();
        e.stopPropagation();

        const selection = this.selections.get(cameraId);
        if (!selection) return;

        const overlay = this.overlays.get(cameraId);
        const box = overlay?.querySelector('.plate-enhancer-selection');
        if (!box) return;

        this.isDraggingOrResizing = true;

        // Get the container's position for coordinate conversion
        const container = overlay.parentElement;
        const containerRect = container.getBoundingClientRect();

        // Store initial state
        const startMouseX = e.clientX;
        const startMouseY = e.clientY;
        const origX = selection.x;
        const origY = selection.y;
        const origW = selection.width;
        const origH = selection.height;

        const minSize = 20;

        const onMove = (moveEvent) => {
            const dx = moveEvent.clientX - startMouseX;
            const dy = moveEvent.clientY - startMouseY;

            let newX = origX;
            let newY = origY;
            let newW = origW;
            let newH = origH;

            // East edge (right)
            if (handle.includes('e')) {
                newW = Math.max(minSize, origW + dx);
            }
            // West edge (left)
            if (handle.includes('w')) {
                const proposedW = origW - dx;
                if (proposedW >= minSize) {
                    newW = proposedW;
                    newX = origX + dx;
                }
            }
            // South edge (bottom)
            if (handle.includes('s')) {
                newH = Math.max(minSize, origH + dy);
            }
            // North edge (top)
            if (handle.includes('n')) {
                const proposedH = origH - dy;
                if (proposedH >= minSize) {
                    newH = proposedH;
                    newY = origY + dy;
                }
            }

            // Constrain to container bounds
            newX = Math.max(0, newX);
            newY = Math.max(0, newY);
            if (newX + newW > selection.containerWidth) {
                newW = selection.containerWidth - newX;
            }
            if (newY + newH > selection.containerHeight) {
                newH = selection.containerHeight - newY;
            }

            // Update selection
            selection.x = newX;
            selection.y = newY;
            selection.width = newW;
            selection.height = newH;

            // Update DOM
            box.style.left = `${newX}px`;
            box.style.top = `${newY}px`;
            box.style.width = `${newW}px`;
            box.style.height = `${newH}px`;

            // Update size indicator
            const sizeIndicator = box.querySelector('.plate-enhancer-size-indicator');
            if (sizeIndicator) {
                this.updateSizeIndicator(cameraId, selection, sizeIndicator);
            }
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            // Delay clearing flag so the click event doesn't fire
            setTimeout(() => {
                this.isDraggingOrResizing = false;
            }, 50);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    /**
     * Handle keyboard events during selection
     */
    handleKeyDown(e) {
        if (!this.isSelecting) return;

        if (e.key === 'Escape') {
            this.cancelSelection();
        } else if (e.key === 'Enter') {
            if (this.selections.size > 0) {
                this.confirmSelection();
            }
        }
    }

    /**
     * Cancel selection mode
     */
    cancelSelection() {
        this.isSelecting = false;
        this.isDraggingOrResizing = false;
        this.selections.clear();
        this.removeOverlays();
        document.removeEventListener('keydown', this.handleKeyDown);
        // Remove button highlight
        this.setButtonActive(false);
    }

    /**
     * Clear all selections and reset state (called when switching events)
     */
    clearAllSelections() {
        // Cancel any active selection
        this.isSelecting = false;
        this.isDraggingOrResizing = false;
        this.selections.clear();
        this.removeOverlays();
        document.removeEventListener('keydown', this.handleKeyDown);

        // Close any open dialogs
        const dialogs = document.querySelectorAll('.plate-enhancer-dialog, .plate-enhancer-backdrop, .plate-enhancer-results');
        dialogs.forEach(el => el.remove());

        // Reset processing state (but don't interrupt active processing - that's blocked separately)
        this.shouldCancel = true;

        // Remove button highlight
        this.setButtonActive(false);

        console.log('[PlateEnhancer] Cleared all selections and state');
    }

    /**
     * Confirm selection and show unified enhancement interface
     */
    confirmSelection() {
        this.isSelecting = false;
        document.removeEventListener('keydown', this.handleKeyDown);

        // Store the reference time (where user drew the box)
        const vp = window.app?.videoPlayer;
        if (vp && vp.getCurrentAbsoluteTime) {
            this.referenceTime = vp.getCurrentAbsoluteTime();
        } else {
            const clipMarking = window.app?.clipMarking;
            if (clipMarking) {
                this.referenceTime = clipMarking.getAbsoluteTime();
            } else {
                this.referenceTime = vp ? vp.getCurrentTime() : 0;
            }
        }

        // Convert manual selections to detection objects for unified interface
        const detections = [];
        this.selections.forEach((selection, cameraId) => {
            const video = this.getVideoElement(cameraId);
            if (!video) return;

            // Convert display coordinates to video coordinates
            const container = video.closest('.video-container');
            if (!container) return;

            const containerRect = container.getBoundingClientRect();
            const videoDisplay = this.getVideoDisplayRect(video, containerRect);

            // Scale from display to video coordinates
            const scaleX = video.videoWidth / videoDisplay.width;
            const scaleY = video.videoHeight / videoDisplay.height;

            const bbox = {
                x: Math.round((selection.x - videoDisplay.x) * scaleX),
                y: Math.round((selection.y - videoDisplay.y) * scaleY),
                width: Math.round(selection.width * scaleX),
                height: Math.round(selection.height * scaleY)
            };

            // Clamp to video bounds
            bbox.x = Math.max(0, Math.min(bbox.x, video.videoWidth - bbox.width));
            bbox.y = Math.max(0, Math.min(bbox.y, video.videoHeight - bbox.height));

            detections.push({
                cameraId,
                bbox,
                confidence: 1.0, // Manual selection = 100% confidence
                videoDims: { width: video.videoWidth, height: video.videoHeight },
                isManual: true,
                detectionTime: this.referenceTime
            });
        });

        if (detections.length === 0) {
            this.showToast('No valid selections found');
            this.cancelSelection();
            return;
        }

        // Remove selection overlays before showing cycling UI
        this.removeOverlays();

        // Use the unified cycling UI
        this.cyclingState = {
            isActive: true,
            detections,
            currentIndex: 0,
            adjustedBbox: null,
            detectionTime: this.referenceTime  // Time when selection was made
        };

        this.showPlateCyclingUI();
    }

    /**
     * Show dialog to select time range
     * @param {Object|null} marks - IN/OUT marks if set { inPoint, outPoint }
     * @param {boolean} selectionOutsideMarks - Whether the selection was drawn outside the mark range
     */
    showTimeRangeDialog(marks = null, selectionOutsideMarks = false) {
        const backdrop = document.createElement('div');
        backdrop.className = 'plate-enhancer-dialog-backdrop';

        const hasMarks = marks && marks.inPoint !== null && marks.outPoint !== null;
        const marksDuration = hasMarks ? (marks.outPoint - marks.inPoint) : null;
        const marksDurationStr = marksDuration ? marksDuration.toFixed(1) : null;

        // Check for very long durations
        const isLongDuration = marksDuration && marksDuration > 15;
        const isVeryLongDuration = marksDuration && marksDuration > 30;
        const estimatedFrames = marksDuration ? Math.ceil(marksDuration * 30) : 0;

        // Check selection sizes and get warnings
        let sizeWarningHtml = '';
        let hasLargeSelection = false;
        for (const [cameraId, selection] of this.selections) {
            const sizeInfo = this.getSelectionSizeInfo(selection);
            if (sizeInfo.warning) {
                hasLargeSelection = true;
                const cameraName = this.getCameraDisplayName(cameraId);
                const severityClass = sizeInfo.classification === 'critical' ? 'plate-enhancer-warning-severe' : '';
                sizeWarningHtml += `
                    <div class="plate-enhancer-warning ${severityClass}">
                        📐 <strong>${cameraName}:</strong> ${sizeInfo.warning}
                    </div>
                `;
            }
        }

        const dialog = document.createElement('div');
        dialog.className = 'plate-enhancer-dialog';
        dialog.innerHTML = `
            <h3>🔍 Enhancement Options</h3>
            ${sizeWarningHtml}
            ${hasMarks ? `
                ${selectionOutsideMarks ? `
                    <div class="plate-enhancer-warning">
                        📍 <strong>Selection outside time range</strong> - You drew the selection at ${this.referenceTime.toFixed(1)}s, which is outside your IN/OUT marks. The plate position may differ. For best results, scrub to within your marked range before selecting.
                    </div>
                ` : ''}
                <div class="plate-enhancer-section">
                    <div class="plate-enhancer-section-header">📍 Time Range</div>
                    <p class="plate-enhancer-help-text">Using your IN/OUT marks (${marksDurationStr}s → ~${estimatedFrames} frames)</p>
                    <div class="plate-enhancer-marks-info">
                        <span class="plate-enhancer-mark-badge">IN: ${marks.inPoint.toFixed(1)}s</span>
                        <span class="plate-enhancer-mark-badge">OUT: ${marks.outPoint.toFixed(1)}s</span>
                    </div>
                    ${isVeryLongDuration ? `
                        <div class="plate-enhancer-warning plate-enhancer-warning-severe">
                            ⚠️ <strong>Very long duration!</strong> Processing ${estimatedFrames} frames may take several minutes and could slow down your browser. Consider using a shorter range (5-10 seconds is usually enough).
                        </div>
                    ` : isLongDuration ? `
                        <div class="plate-enhancer-warning">
                            ⏱️ Longer duration means more frames to process. This may take a while. 5-10 seconds is usually sufficient for good results.
                        </div>
                    ` : ''}
                </div>
            ` : `
                <div class="plate-enhancer-section">
                    <div class="plate-enhancer-section-header">⏱️ Analysis Duration</div>
                    <p class="plate-enhancer-help-text">More time = more frames to combine, but slower processing</p>
                    <div class="plate-enhancer-time-presets">
                        <button class="plate-enhancer-preset-btn" data-seconds="2">2 sec<span class="preset-hint">Quick</span></button>
                        <button class="plate-enhancer-preset-btn selected" data-seconds="5">5 sec<span class="preset-hint">Recommended</span></button>
                        <button class="plate-enhancer-preset-btn" data-seconds="10">10 sec<span class="preset-hint">Thorough</span></button>
                    </div>
                    <p class="plate-enhancer-tip">💡 Tip: Use IN/OUT marks (I and O keys) for precise control</p>
                </div>
            `}
            <div class="plate-enhancer-dialog-actions">
                <button class="plate-enhancer-btn plate-enhancer-btn-secondary" data-action="cancel">Cancel</button>
                <button class="plate-enhancer-btn plate-enhancer-btn-primary" data-action="start">🚀 Start Enhancement</button>
            </div>
        `;

        let selectedSeconds = 5;

        // Handle preset selection (only if not using marks)
        if (!hasMarks) {
            dialog.querySelectorAll('.plate-enhancer-preset-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    dialog.querySelectorAll('.plate-enhancer-preset-btn').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                    selectedSeconds = parseInt(btn.dataset.seconds);
                });
            });
        }

        // Handle cancel
        dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => {
            backdrop.remove();
            dialog.remove();
            this.cancelSelection();
        });

        // Handle start
        dialog.querySelector('[data-action="start"]').addEventListener('click', async () => {
            backdrop.remove();
            dialog.remove();

            let startTime, endTime;

            if (hasMarks) {
                // Use IN/OUT marks
                startTime = marks.inPoint;
                endTime = marks.outPoint;
            } else {
                // Calculate time range centered on reference time (where user drew the selection)
                // Use referenceTime to ensure we process frames around where the plate was visible
                const vp = window.app?.videoPlayer;
                // Get total duration (getTotalDuration is async!)
                let totalDuration = 600; // Default fallback
                if (vp?.getTotalDuration) {
                    try {
                        const duration = await vp.getTotalDuration();
                        if (duration && Number.isFinite(duration) && duration > 0) {
                            totalDuration = duration;
                        }
                    } catch (e) {
                        console.warn('[PlateEnhancer] Failed to get total duration:', e);
                    }
                }
                const halfRange = selectedSeconds / 2;
                startTime = Math.max(0, this.referenceTime - halfRange);
                endTime = Math.min(this.referenceTime + halfRange, totalDuration); // Clamp to video end
            }

            // Always use 4x super-resolution upscaling for best OCR results
            const enableMLUpscale = true;
            const upscaleScale = 4;
            console.log('[PlateEnhancer] Using 4x super-resolution upscale');

            this.startProcessing(startTime, endTime, enableMLUpscale, upscaleScale);
        });

        // Handle backdrop click
        backdrop.addEventListener('click', () => {
            backdrop.remove();
            dialog.remove();
            this.cancelSelection();
        });

        document.body.appendChild(backdrop);
        document.body.appendChild(dialog);
    }

    /**
     * Remove all selection overlays
     */
    removeOverlays() {
        this.overlays.forEach((overlay) => {
            overlay.remove();
        });
        this.overlays.clear();

        // Also remove instruction element if it exists (appended to body)
        if (this.instructionElement) {
            this.instructionElement.remove();
            this.instructionElement = null;
        }
    }

    /**
     * Check if OpenCV is truly loaded and ready to use
     * @returns {boolean}
     */
    isOpenCVReady() {
        try {
            // Check if cv global exists and has key functions
            return typeof cv !== 'undefined' &&
                   typeof cv.Mat === 'function' &&
                   typeof cv.getBuildInformation === 'function';
        } catch (e) {
            return false;
        }
    }

    /**
     * Load OpenCV.js on demand
     */
    async loadOpenCV() {
        if (this.isOpenCVLoaded && this.isOpenCVReady()) return true;
        if (this.isLoadingOpenCV) {
            // Wait for existing load with timeout
            return new Promise((resolve) => {
                let waited = 0;
                const check = setInterval(() => {
                    waited += 100;
                    if (this.isOpenCVLoaded) {
                        clearInterval(check);
                        resolve(true);
                    } else if (waited > 30000) {
                        clearInterval(check);
                        resolve(false);
                    }
                }, 100);
            });
        }

        this.isLoadingOpenCV = true;

        // Show loading indicator
        const loading = document.createElement('div');
        loading.className = 'plate-enhancer-loading-opencv';
        loading.innerHTML = `
            <div class="spinner"></div>
            <p>Loading image processing library...</p>
            <p style="font-size: 12px; color: var(--text-secondary, #888); margin-top: 8px;">First time may take 10-20 seconds</p>
        `;
        document.body.appendChild(loading);

        try {
            await new Promise((resolve, reject) => {
                // Timeout after 30 seconds
                const timeout = setTimeout(() => {
                    reject(new Error('OpenCV.js load timeout'));
                }, 30000);

                const script = document.createElement('script');
                script.src = 'https://docs.opencv.org/4.8.0/opencv.js';
                script.async = true;

                script.onload = () => {
                    // OpenCV.js sets up a cv object but needs to be initialized
                    if (typeof cv !== 'undefined') {
                        if (cv.getBuildInformation) {
                            // Already ready
                            clearTimeout(timeout);
                            resolve();
                        } else {
                            // Wait for onRuntimeInitialized
                            cv.onRuntimeInitialized = () => {
                                clearTimeout(timeout);
                                resolve();
                            };
                        }
                    } else {
                        clearTimeout(timeout);
                        reject(new Error('OpenCV.js failed to load'));
                    }
                };

                script.onerror = () => {
                    clearTimeout(timeout);
                    reject(new Error('Failed to load OpenCV.js'));
                };
                document.head.appendChild(script);
            });

            this.isOpenCVLoaded = true;
            console.log('[PlateEnhancer] OpenCV.js loaded successfully');
            return true;
        } catch (error) {
            console.error('[PlateEnhancer] Failed to load OpenCV.js:', error);
            return false;
        } finally {
            loading.remove();
            this.isLoadingOpenCV = false;
        }
    }

    /**
     * Start the enhancement processing
     * @param {number} startTime - Start time in seconds
     * @param {number} endTime - End time in seconds
     * @param {boolean} enableMLUpscale - Whether to apply super-resolution upscaling
     * @param {number} upscaleScale - Scale factor for upscaling (2, 3, or 4)
     */
    async startProcessing(startTime, endTime, enableMLUpscale = false, upscaleScale = 2) {
        this.removeOverlays();
        this.isProcessing = true;
        this.shouldCancel = false;

        // Clear previous enhancement data (new extraction = new original)
        this.lastExtraction = null;
        this.lastEnhanced = null;
        this.originalEnhanced = null;

        // Ensure OpenCV is loaded before proceeding
        if (!this.isOpenCVReady()) {
            console.log('[PlateEnhancer] OpenCV not ready, loading...');
            const loaded = await this.loadOpenCV();
            if (!loaded || !this.isOpenCVReady()) {
                this.showError('Failed to load image processing library. Please try again.');
                this.isProcessing = false;
                return;
            }
        }

        // Save current video position to restore after extraction
        // Use ?? instead of || to handle time=0 correctly (0 is falsy but valid)
        const vp = window.app?.videoPlayer;
        const savedTime = vp?.getCurrentAbsoluteTime?.() ?? vp?.getCurrentTime?.() ?? 0;
        console.log(`[PlateEnhancer] Saving video position: ${savedTime.toFixed(2)}s`);

        // Show progress modal
        const backdrop = document.createElement('div');
        backdrop.className = 'plate-enhancer-dialog-backdrop';

        const progress = document.createElement('div');
        progress.className = 'plate-enhancer-progress';
        progress.innerHTML = `
            <h3>Enhancing License Plate</h3>
            <div class="plate-enhancer-progress-status">Preparing...</div>
            <div class="plate-enhancer-progress-bar">
                <div class="plate-enhancer-progress-fill" style="width: 0%"></div>
            </div>
            <div class="plate-enhancer-progress-percent">0%</div>
            <div class="plate-enhancer-progress-cancel">
                <button class="plate-enhancer-btn plate-enhancer-btn-secondary">Cancel</button>
            </div>
        `;

        progress.querySelector('button').addEventListener('click', () => {
            this.shouldCancel = true;
        });

        document.body.appendChild(backdrop);
        document.body.appendChild(progress);

        const updateProgress = (status, percent) => {
            progress.querySelector('.plate-enhancer-progress-status').textContent = status;
            progress.querySelector('.plate-enhancer-progress-fill').style.width = `${percent}%`;
            progress.querySelector('.plate-enhancer-progress-percent').textContent = `${Math.round(percent)}%`;
        };

        try {
            // Import the tracker and stacker modules dynamically
            const tracker = new RegionTracker();
            const stacker = new FrameStacker();

            // Enable ML upscaling if requested (using ESRGAN-Thick for best quality)
            if (enableMLUpscale) {
                stacker.enableMLUpscale(true, upscaleScale, 'thick');
                stacker.postProcessSharpening = true; // Crisp text edges
                stacker.enablePreProcessing = true; // MAX QUALITY: contrast + sharpening before ESRGAN
            }

            // ALWAYS use real multi-frame stacking - dramatically improves low-light results
            stacker.useRealStacking = true;
            stacker.stackingMethod = 'sigma-mean'; // Best: combines data while rejecting outliers

            // Extract frames and track regions
            const results = await this.extractAndTrack(startTime, endTime, updateProgress, tracker);

            if (this.shouldCancel) {
                throw new Error('Cancelled');
            }

            // Get video enhancement settings (brightness, contrast, saturation)
            const videoEnhancements = this.getVideoEnhancementSettings();

            // Store extraction data for re-processing (manual frame selection, region adjustment)
            this.lastExtraction = {
                regions: results.regions,
                frames: results.frames,
                settings: {
                    enableMLUpscale,
                    upscaleScale,
                    videoEnhancements,
                    startTime,
                    endTime
                }
            };

            // Process frames through stacker
            updateProgress(`Ranking ${results.regions.length} frames by sharpness...`, 78);
            await new Promise(r => setTimeout(r, 47)); // Let UI update

            const enhanced = await stacker.process(results.regions, results.frames, (status, pct) => {
                updateProgress(status, 78 + pct * 0.2); // 78-98%
            }, videoEnhancements);

            if (this.shouldCancel) {
                throw new Error('Cancelled');
            }

            // Store enhanced result
            this.lastEnhanced = enhanced;
            // Also store as original (never overwritten during reprocessing)
            // This preserves all frames so user can try different selections
            this.originalEnhanced = enhanced;

            updateProgress('Complete!', 100);

            // Clean up progress modal
            backdrop.remove();
            progress.remove();

            // Show results with re-processing options
            await this.showResults(enhanced, true);

        } catch (error) {
            backdrop.remove();
            progress.remove();

            if (error.message !== 'Cancelled') {
                console.error('[PlateEnhancer] Processing error:', error);
                this.showError(`Enhancement failed: ${error.message}`);
            }
        } finally {
            this.isProcessing = false;
            this.isSelecting = false;
            this.activeCamera = null;
            this.selections.clear();
            document.removeEventListener('keydown', this.handleKeyDown);

            // Restore video position after extraction
            if (vp && savedTime !== undefined) {
                console.log(`[PlateEnhancer] Restoring video position: ${savedTime.toFixed(2)}s`);
                try {
                    if (vp.seekToEventTime) {
                        await vp.seekToEventTime(savedTime);
                    }
                } catch (e) {
                    console.warn('[PlateEnhancer] Could not restore video position:', e);
                }
            }
        }
    }

    /**
     * Generate time samples with variable density - dense near reference, sparse far away
     * @param {number} referenceTime - Center point (where user made selection)
     * @param {number} startTime - Start of range
     * @param {number} endTime - End of range
     * @returns {Array} Array of time values to sample
     */
    generateVariableDensitySamples(referenceTime, startTime, endTime) {
        const samples = new Set();
        samples.add(referenceTime); // Always include reference

        // Capture EVERY frame at 36fps across the entire time range
        // Tesla cameras record at 36fps, so this gets every possible frame
        const frameInterval = 1 / 36;

        // Add small buffer to endTime to avoid sampling exactly at video end
        // This prevents seek issues when at the tail of the video
        const safeEndTime = endTime - 0.05; // 50ms buffer from end

        // Sample from start to end at native framerate
        for (let time = startTime; time <= safeEndTime; time += frameInterval) {
            samples.add(time);
        }

        console.log(`[PlateEnhancer] Capturing every frame: ${samples.size} samples over ${(safeEndTime - startTime).toFixed(1)}s (ref: ${referenceTime.toFixed(2)}s)`);

        // Sort samples chronologically
        return Array.from(samples).sort((a, b) => a - b);
    }

    /**
     * Extract frames and track region across time
     * Tracks from reference frame (where user drew box) both forward and backward
     * Uses variable density sampling - dense near reference, sparse further away
     */
    async extractAndTrack(startTime, endTime, updateProgress, tracker) {
        // Get reference time (where user drew the selection box)
        // Clamp to be within the time range - user may have drawn selection outside IN/OUT marks
        // Use ?? instead of || to handle referenceTime of 0 correctly (0 is falsy but valid)
        let referenceTime = this.referenceTime ?? ((startTime + endTime) / 2);
        if (referenceTime < startTime) {
            console.log(`[PlateEnhancer] Reference time ${referenceTime.toFixed(2)}s is before start ${startTime.toFixed(2)}s, using start`);
            referenceTime = startTime;
        } else if (referenceTime > endTime) {
            console.log(`[PlateEnhancer] Reference time ${referenceTime.toFixed(2)}s is after end ${endTime.toFixed(2)}s, using end`);
            referenceTime = endTime;
        }

        // Generate variable density time samples
        const allTimeSamples = this.generateVariableDensitySamples(referenceTime, startTime, endTime);
        const forwardSamples = allTimeSamples.filter(t => t >= referenceTime);
        const backwardSamples = allTimeSamples.filter(t => t <= referenceTime).reverse(); // ref first, then earlier times

        console.log(`[PlateEnhancer] Variable density sampling: ${allTimeSamples.length} total samples`);
        console.log(`[PlateEnhancer] Zone breakdown: ~${Math.round(0.5 * 36 * 2)} near (±0.5s @36fps), ~${Math.round(1.5 * 15 * 2)} mid (±2s @15fps), rest sparse (@6fps)`);

        const allRegions = [];
        const allFrames = [];

        let cameraIndex = 0;
        const totalCameras = this.selections.size;

        for (const [cameraId, selection] of this.selections) {
            const cameraName = this.getCameraDisplayName(cameraId);
            const cameraBaseProgress = (cameraIndex / totalCameras) * 75;
            const cameraProgressRange = 75 / totalCameras;

            const video = this.getVideoElement(cameraId);
            if (!video) continue;

            // Convert selection from container coords to video coords
            const videoSelection = this.containerToVideoCoords(selection);

            // Extract reference frame first
            updateProgress(`${cameraName}: Extracting reference frame...`, cameraBaseProgress);
            const refFrame = await this.extractFrame(video, referenceTime, cameraId);
            if (!refFrame) {
                console.warn(`[PlateEnhancer] Could not extract reference frame for ${cameraId}`);
                cameraIndex++;
                continue;
            }

            // Build frame list using variable density samples
            const forwardFrames = [];
            const backwardFrames = [];
            let extractedCount = 0;
            const totalFramesToExtract = forwardSamples.length + backwardSamples.length - 1; // -1 because ref is in both

            // Forward frames (reference to end) - includes reference frame
            for (let i = 0; i < forwardSamples.length; i++) {
                if (this.shouldCancel) return { regions: [], frames: [] };
                const time = forwardSamples[i];

                const frame = i === 0 ? refFrame : await this.extractFrame(video, time, cameraId);
                if (frame) {
                    forwardFrames.push({ imageData: frame, time, cameraId });
                }
                extractedCount++;

                // Update progress during extraction
                if (extractedCount % 10 === 0) {
                    const extractProgress = (extractedCount / totalFramesToExtract) * 0.5;
                    updateProgress(`${cameraName}: Extracting frames (${extractedCount}/${totalFramesToExtract})...`,
                        cameraBaseProgress + extractProgress * cameraProgressRange);
                }
            }

            // Backward frames: start from reference and go backwards
            backwardFrames.push({ imageData: refFrame, time: referenceTime, cameraId }); // Start with reference

            for (let i = 1; i < backwardSamples.length; i++) {
                if (this.shouldCancel) return { regions: [], frames: [] };
                const time = backwardSamples[i];

                const frame = await this.extractFrame(video, time, cameraId);
                if (frame) {
                    backwardFrames.push({ imageData: frame, time, cameraId });
                }
                extractedCount++;

                // Update progress during extraction
                if (extractedCount % 10 === 0) {
                    const extractProgress = (extractedCount / totalFramesToExtract) * 0.5;
                    updateProgress(`${cameraName}: Extracting frames (${extractedCount}/${totalFramesToExtract})...`,
                        cameraBaseProgress + extractProgress * cameraProgressRange);
                }
            }

            // Tracking phase
            const trackingStart = cameraBaseProgress + 0.55 * cameraProgressRange;
            const trackingRange = 0.35 * cameraProgressRange;

            updateProgress(`${cameraName}: Tracking forward (${forwardFrames.length} frames)...`, trackingStart);
            const forwardTracked = await tracker.track(forwardFrames, videoSelection, (pct) => {
                updateProgress(`${cameraName}: Tracking forward (${Math.round(pct * forwardFrames.length)}/${forwardFrames.length})...`,
                    trackingStart + pct * trackingRange * 0.5);
            });

            updateProgress(`${cameraName}: Tracking backward (${backwardFrames.length} frames)...`,
                trackingStart + trackingRange * 0.5);
            const backwardTracked = await tracker.track(backwardFrames, videoSelection, (pct) => {
                updateProgress(`${cameraName}: Tracking backward (${Math.round(pct * backwardFrames.length)}/${backwardFrames.length})...`,
                    trackingStart + trackingRange * 0.5 + pct * trackingRange * 0.5);
            });

            updateProgress(`${cameraName}: Cropping regions...`,
                cameraBaseProgress + 0.9 * cameraProgressRange);

            // Combine results chronologically:
            // backwardTracked = [ref, ref-1, ref-2, ...] -> reverse to [ref-2, ref-1, ref]
            // forwardTracked = [ref, ref+1, ref+2, ...]
            // Combined = [ref-2, ref-1, ref, ref+1, ref+2, ...] (but ref appears twice)

            const backwardReversed = backwardTracked.slice().reverse(); // [oldest, ..., ref]
            const backwardFramesReversed = backwardFrames.slice().reverse(); // [oldest, ..., ref]

            // Remove duplicate reference from backward (it's also in forward)
            const allTracked = [...backwardReversed.slice(0, -1), ...forwardTracked];
            const allCameraFrames = [...backwardFramesReversed.slice(0, -1), ...forwardFrames];

            // Crop tracked regions from frames, validating each region
            let croppedCount = 0;
            let droppedCount = 0;
            for (let i = 0; i < allCameraFrames.length; i++) {
                const region = allTracked[i];
                if (region) {
                    // Validate region hasn't drifted too far or changed size too much
                    // This catches cases where tracking latched onto a different object
                    const isValid = this.validateTrackedRegion(region, videoSelection);

                    if (!isValid) {
                        droppedCount++;
                        continue; // Skip this frame - likely tracking the wrong object
                    }

                    const cropped = this.cropRegion(allCameraFrames[i].imageData, region);
                    if (cropped) {
                        allRegions.push({
                            imageData: cropped,
                            time: allCameraFrames[i].time,
                            cameraId: allCameraFrames[i].cameraId,
                            region: region
                        });
                        croppedCount++;
                    }
                }
            }

            if (droppedCount > 0) {
                console.log(`[PlateEnhancer] ${cameraName}: Dropped ${droppedCount} frames (tracking drift detected)`);
            }

            console.log(`[PlateEnhancer] ${cameraName}: Extracted ${allCameraFrames.length} frames, cropped ${croppedCount} regions`);
            allFrames.push(...allCameraFrames);
            cameraIndex++;
        }

        return { regions: allRegions, frames: allFrames };
    }

    /**
     * Get video element for camera ID
     */
    getVideoElement(cameraId) {
        const mapping = {
            'front': 'videoFront',
            'back': 'videoBack',
            'left_repeater': 'videoLeft',
            'right_repeater': 'videoRight',
            'left_pillar': 'videoLeftPillar',
            'right_pillar': 'videoRightPillar'
        };
        return document.getElementById(mapping[cameraId]);
    }

    /**
     * Extract a single frame from video at given absolute event time
     * Uses app's seekToEventTime to handle clip boundaries properly
     */
    async extractFrame(video, time, cameraId) {
        const vp = window.app?.videoPlayer;

        // Validate time is within bounds (prevent seeking past video end)
        if (vp) {
            // Use cached duration (synchronous) to avoid slow async call in loop
            let totalDuration = null;
            if (vp.cachedClipDurations?.length > 0) {
                totalDuration = vp.cachedClipDurations.reduce((a, b) => a + b, 0);
            }
            if (totalDuration && Number.isFinite(totalDuration) && totalDuration > 0) {
                // Clamp time to be within valid range with 0.1s buffer from end
                const maxValidTime = Math.max(0, totalDuration - 0.1);
                if (time > maxValidTime) {
                    console.log(`[PlateEnhancer] extractFrame: Clamping time ${time.toFixed(2)}s to ${maxValidTime.toFixed(2)}s (duration: ${totalDuration.toFixed(2)}s)`);
                    time = maxValidTime;
                }
                if (time < 0) {
                    time = 0;
                }
            }
        }

        // Use the app's seek functionality to handle clip boundaries
        if (vp && vp.seekToEventTime) {
            try {
                // seekToEventTime loads the right clip and sets currentTime
                await vp.seekToEventTime(time);

                // Get the video element (may have changed if clip was loaded)
                const currentVideo = this.getVideoElement(cameraId);
                if (!currentVideo) {
                    console.warn(`[PlateEnhancer] No video element found for ${cameraId}`);
                    return null;
                }

                // Wait for the seek to actually complete (seeked event)
                // We must wait because seekToEventTime sets currentTime but doesn't wait for seek completion
                await new Promise((resolve) => {
                    let resolved = false;

                    const cleanup = () => {
                        currentVideo.removeEventListener('seeked', onSeeked);
                        currentVideo.removeEventListener('canplay', onCanPlay);
                        clearTimeout(timeout);
                    };

                    const onSeeked = () => {
                        if (resolved) return;
                        resolved = true;
                        cleanup();
                        resolve();
                    };

                    const onCanPlay = () => {
                        if (resolved) return;
                        resolved = true;
                        cleanup();
                        resolve();
                    };

                    currentVideo.addEventListener('seeked', onSeeked);
                    currentVideo.addEventListener('canplay', onCanPlay);

                    // Timeout after 3 seconds
                    const timeout = setTimeout(() => {
                        if (resolved) return;
                        resolved = true;
                        cleanup();
                        console.warn(`[PlateEnhancer] Seek timeout for ${cameraId}, proceeding anyway`);
                        resolve();
                    }, 3000);

                    // If video is not currently seeking and is ready, check after a short delay
                    // (the seeked event may have already fired before we added listeners)
                    setTimeout(() => {
                        if (!resolved && !currentVideo.seeking && currentVideo.readyState >= 2) {
                            resolved = true;
                            cleanup();
                            resolve();
                        }
                    }, 100);
                });

                // Extra small delay to ensure frame is painted
                await new Promise(r => setTimeout(r, 30));

                // Verify video is ready
                if (currentVideo.readyState < 2 || currentVideo.videoWidth === 0) {
                    console.warn(`[PlateEnhancer] Video not ready for ${cameraId}: readyState=${currentVideo.readyState}, size=${currentVideo.videoWidth}x${currentVideo.videoHeight}`);
                    return null;
                }

                // Draw to canvas
                const canvas = document.createElement('canvas');
                canvas.width = currentVideo.videoWidth;
                canvas.height = currentVideo.videoHeight;
                const ctx = canvas.getContext('2d');

                // Apply video enhancements to source frames if enabled
                if (this.applyVideoEnhancementsToSource) {
                    const settings = this.getVideoEnhancementSettings();
                    this.applyVideoEnhancementsToCanvas(ctx, settings);
                }

                ctx.drawImage(currentVideo, 0, 0);

                // Reset filter for subsequent operations
                ctx.filter = 'none';

                return ctx.getImageData(0, 0, canvas.width, canvas.height);
            } catch (error) {
                console.error(`[PlateEnhancer] Seek error:`, error);
                return null;
            }
        }

        // Fallback: direct seek (only works within current clip)
        // Store reference to this for callback
        const self = this;

        return new Promise((resolve) => {
            video.currentTime = time;

            const onSeeked = () => {
                video.removeEventListener('seeked', onSeeked);

                // Draw to canvas
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d');

                // Apply video enhancements to source frames if enabled
                if (self.applyVideoEnhancementsToSource) {
                    const settings = self.getVideoEnhancementSettings();
                    self.applyVideoEnhancementsToCanvas(ctx, settings);
                }

                ctx.drawImage(video, 0, 0);

                // Reset filter
                ctx.filter = 'none';

                resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
            };

            video.addEventListener('seeked', onSeeked);

            // Timeout fallback
            setTimeout(() => {
                video.removeEventListener('seeked', onSeeked);
                resolve(null);
            }, 2000);
        });
    }

    /**
     * Crop a region from image data
     */
    cropRegion(imageData, region) {
        const { x, y, width, height } = region;

        // Validate region bounds
        if (x < 0 || y < 0 || x + width > imageData.width || y + height > imageData.height) {
            return null;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        // Create temporary canvas with source image
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = imageData.width;
        srcCanvas.height = imageData.height;
        const srcCtx = srcCanvas.getContext('2d');
        srcCtx.putImageData(imageData, 0, 0);

        // Crop
        ctx.drawImage(srcCanvas, x, y, width, height, 0, 0, width, height);

        return ctx.getImageData(0, 0, width, height);
    }

    /**
     * Validate that a tracked region hasn't drifted too far from the original selection
     * This catches cases where optical flow tracking latched onto a different object
     * @param {Object} region - The tracked region { x, y, width, height }
     * @param {Object} originalSelection - The original user selection in video coordinates
     * @returns {boolean} - True if region is valid, false if it should be dropped
     */
    validateTrackedRegion(region, originalSelection) {
        if (!region || !originalSelection) return false;

        // 1. Check if region center has moved too far from original center
        const originalCenterX = originalSelection.x + originalSelection.width / 2;
        const originalCenterY = originalSelection.y + originalSelection.height / 2;
        const regionCenterX = region.x + region.width / 2;
        const regionCenterY = region.y + region.height / 2;

        const dx = Math.abs(regionCenterX - originalCenterX);
        const dy = Math.abs(regionCenterY - originalCenterY);

        // Allow movement up to 3x the original selection size
        // This accommodates vehicles moving across frame over multiple seconds
        const maxMoveX = originalSelection.width * 3;
        const maxMoveY = originalSelection.height * 3;

        if (dx > maxMoveX || dy > maxMoveY) {
            return false; // Center has moved too far - likely tracking wrong object
        }

        // 2. Check if region size has changed too dramatically
        const widthRatio = region.width / originalSelection.width;
        const heightRatio = region.height / originalSelection.height;

        // Allow size to vary between 0.25x and 4x original
        // Vehicles can grow as they approach or shrink as they recede
        if (widthRatio < 0.25 || widthRatio > 4.0 || heightRatio < 0.25 || heightRatio > 4.0) {
            return false; // Size changed too much - likely tracking wrong object
        }

        // 3. Check aspect ratio hasn't changed dramatically
        const originalAspect = originalSelection.width / originalSelection.height;
        const regionAspect = region.width / region.height;
        const aspectRatio = regionAspect / originalAspect;

        // Aspect ratio should stay within 0.5x to 2x
        if (aspectRatio < 0.5 || aspectRatio > 2.0) {
            return false; // Aspect ratio changed too much
        }

        return true;
    }

    /**
     * Show results modal
     * @param {Object} enhanced - Enhanced results
     * @param {boolean} canReprocess - Whether re-processing is available
     */
    async showResults(enhanced, canReprocess = false) {
        // Check if user is Pro - free users get watermarked images
        // Per spec NMC-4702
        const isPro = await this.isProUser();

        // For free users, watermark all displayed images to prevent right-click save
        if (!isPro) {
            console.log('[PlateEnhancer] Free user - applying watermarks to displayed images');

            // Watermark combined result
            if (enhanced.combined?.dataUrl) {
                enhanced.combined.displayUrl = await this.addWatermark(enhanced.combined.dataUrl);
            }

            // Watermark method results (including upscaled versions)
            if (enhanced.methods) {
                for (const key of Object.keys(enhanced.methods)) {
                    if (enhanced.methods[key]?.dataUrl) {
                        enhanced.methods[key].displayUrl = await this.addWatermark(enhanced.methods[key].dataUrl);
                    }
                    // Also watermark upscaled version if available
                    if (enhanced.methods[key]?.upscaledDataUrl) {
                        enhanced.methods[key].upscaledDisplayUrl = await this.addWatermark(enhanced.methods[key].upscaledDataUrl);
                    }
                }
            }

            // Watermark upscaled
            if (enhanced.upscaled?.dataUrl) {
                enhanced.upscaled.displayUrl = await this.addWatermark(enhanced.upscaled.dataUrl);
            }

            // Watermark top frames
            if (enhanced.topFrames) {
                for (const frame of enhanced.topFrames) {
                    if (frame.dataUrl) {
                        frame.displayUrl = await this.addWatermark(frame.dataUrl);
                    }
                }
            }
        }

        // Helper to get display URL (watermarked for free, original for pro)
        const getDisplayUrl = (item) => item.displayUrl || item.dataUrl;

        const backdrop = document.createElement('div');
        backdrop.className = 'plate-enhancer-dialog-backdrop';

        const modal = document.createElement('div');
        modal.className = 'plate-enhancer-results';

        // Create header
        const header = document.createElement('div');
        header.className = 'plate-enhancer-results-header';
        header.innerHTML = `
            <h3>Enhancement Results</h3>
            <button class="plate-enhancer-close-btn">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                </svg>
            </button>
        `;
        modal.appendChild(header);

        // Main preview
        const mainPreview = document.createElement('div');
        mainPreview.className = 'plate-enhancer-main-preview';
        const mainImg = document.createElement('img');
        mainImg.src = getDisplayUrl(enhanced.combined);
        mainPreview.appendChild(mainImg);

        const mainLabel = document.createElement('div');
        mainLabel.className = 'plate-enhancer-main-preview-label';
        mainLabel.textContent = 'Combined Result (click thumbnails below to compare)';
        mainPreview.appendChild(mainLabel);
        modal.appendChild(mainPreview);

        // OCR Section with ensemble OCR
        const ocrSection = document.createElement('div');
        ocrSection.className = 'plate-enhancer-ocr-section';
        ocrSection.innerHTML = `
            <div class="plate-enhancer-ocr-header">
                <span class="plate-enhancer-ocr-label">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
                    </svg>
                    AI Detected Text
                </span>
                <span class="plate-enhancer-ocr-status">Initializing...</span>
            </div>
            <div class="plate-enhancer-ocr-progress" style="display: none;">
                <div class="plate-enhancer-ocr-progress-bar"></div>
                <span class="plate-enhancer-ocr-progress-text">Loading OCR model...</span>
            </div>
            <div class="plate-enhancer-ocr-result">
                <span class="plate-enhancer-ocr-text">-</span>
                <button class="plate-enhancer-ocr-copy" title="Copy text" style="display: none;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
                    </svg>
                </button>
            </div>
            <div class="plate-enhancer-ocr-warning" style="display: none;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                </svg>
                <span>Low confidence - verify manually</span>
            </div>
            <div class="plate-enhancer-ocr-disclaimer">Results may not be accurate - verify manually</div>
        `;
        modal.appendChild(ocrSection);

        // Progress callback for OCR
        const updateOCRProgress = (status, progress) => {
            const statusEl = ocrSection.querySelector('.plate-enhancer-ocr-status');
            const progressContainer = ocrSection.querySelector('.plate-enhancer-ocr-progress');
            const progressBar = ocrSection.querySelector('.plate-enhancer-ocr-progress-bar');
            const progressText = ocrSection.querySelector('.plate-enhancer-ocr-progress-text');

            statusEl.textContent = status;

            if (progress !== null && progress >= 0) {
                progressContainer.style.display = 'block';
                progressBar.style.width = `${Math.round(progress * 100)}%`;
                progressText.textContent = `${status} (${Math.round(progress * 100)}%)`;
            } else {
                progressContainer.style.display = 'none';
            }
        };

        // Store method elements for OCR updates (will be populated later)
        let methodElements = {};

        // Run ensemble OCR on all enhancement methods
        this.runEnsembleOCR(enhanced, updateOCRProgress).then(result => {
            const statusEl = ocrSection.querySelector('.plate-enhancer-ocr-status');
            const textEl = ocrSection.querySelector('.plate-enhancer-ocr-text');
            const copyBtn = ocrSection.querySelector('.plate-enhancer-ocr-copy');
            const warningEl = ocrSection.querySelector('.plate-enhancer-ocr-warning');

            // Hide progress bar when done
            const progressContainer = ocrSection.querySelector('.plate-enhancer-ocr-progress');
            if (progressContainer) progressContainer.style.display = 'none';

            if (result.error) {
                statusEl.textContent = 'OCR unavailable';
                textEl.textContent = '-';
            } else if (result.text) {
                statusEl.textContent = `Confidence: ${result.confidence.toFixed(0)}%`;
                textEl.textContent = result.text;
                copyBtn.style.display = 'inline-flex';

                // Show warning if low confidence
                if (result.confidence < 50) {
                    warningEl.style.display = 'flex';
                }

                // Store OCR result for Pro features
                this.lastOCRResult = result;

                // Copy OCR text (Pro feature)
                copyBtn.addEventListener('click', async () => {
                    try {
                        await navigator.clipboard.writeText(result.text);
                        this.showToast('Text copied!');
                    } catch (e) {
                        console.error('Copy failed:', e);
                    }
                });

                // Update per-method OCR results if available
                if (result.methodResults && Object.keys(methodElements).length > 0) {
                    const votedText = result.text.replace(/[\s-]/g, '');
                    for (const [methodKey, methodResult] of Object.entries(result.methodResults)) {
                        const el = methodElements[methodKey];
                        if (el) {
                            const ocrTextEl = el.querySelector('.ocr-text');
                            const ocrConfEl = el.querySelector('.ocr-confidence');
                            if (ocrTextEl && methodResult.text) {
                                ocrTextEl.textContent = methodResult.text;
                                const cleanText = methodResult.text.replace(/[\s-]/g, '');
                                const isCorrect = cleanText === votedText;
                                ocrTextEl.classList.toggle('correct', isCorrect);
                                ocrTextEl.classList.toggle('incorrect', !isCorrect);
                                if (ocrConfEl) {
                                    ocrConfEl.textContent = `${methodResult.confidence.toFixed(0)}%`;
                                }
                            } else if (ocrTextEl) {
                                ocrTextEl.textContent = '-';
                            }
                        }
                    }
                }
            } else {
                statusEl.textContent = 'No text detected';
                textEl.textContent = '-';
            }
        });

        // Enhancement Methods Section (if available)
        if (enhanced.methods) {
            const methodsSection = document.createElement('div');
            methodsSection.className = 'plate-enhancer-methods-section';
            methodsSection.innerHTML = `
                <div class="plate-enhancer-methods-label">Enhancement Methods (click to preview, 4x badge = upscaled available):</div>
                <div class="plate-enhancer-methods-grid"></div>
            `;
            modal.appendChild(methodsSection);

            const methodsGrid = methodsSection.querySelector('.plate-enhancer-methods-grid');
            const methodOrder = ['sigmaClipped', 'msrClahe', 'weightedMean', 'bestFrame', 'bilateral', 'ensemble', 'luckyRegions'];
            const methodNames = {
                sigmaClipped: 'Sigma Clipped',
                msrClahe: 'MSR+CLAHE',
                weightedMean: 'Weighted Mean',
                bestFrame: 'Best Frame',
                bilateral: 'Bilateral',
                ensemble: 'Ensemble',
                luckyRegions: '🎯 Lucky'
            };

            // Use outer methodElements for OCR updates

            methodOrder.forEach((methodKey, index) => {
                const method = enhanced.methods[methodKey];
                if (!method) return;

                const displayUrl = method.displayUrl || method.dataUrl;
                const hasUpscaled = !!method.upscaledDataUrl;
                const methodThumb = document.createElement('div');
                methodThumb.className = 'plate-enhancer-method-thumb' + (methodKey === 'luckyRegions' ? ' lucky-method' : '') + (methodKey === 'ensemble' ? ' selected' : '') + (hasUpscaled ? ' has-upscaled' : '');
                methodThumb.dataset.src = method.dataUrl; // Keep original for downloads
                methodThumb.dataset.displaySrc = displayUrl; // Watermarked for display
                methodThumb.dataset.methodKey = methodKey;
                methodThumb.dataset.label = method.name || methodNames[methodKey];
                methodThumb.dataset.showingUpscaled = 'false';
                if (hasUpscaled) {
                    methodThumb.dataset.upscaledSrc = method.upscaledDataUrl;
                    methodThumb.dataset.upscaledSharpness = method.upscaledSharpness;
                }
                methodThumb.innerHTML = `
                    <img src="${displayUrl}" alt="${methodNames[methodKey]}">
                    <div class="plate-enhancer-method-name">${methodNames[methodKey]}</div>
                    ${hasUpscaled ? '<div class="plate-enhancer-upscale-badge" title="Click badge to toggle 4x upscaled">4x</div>' : ''}
                    <div class="plate-enhancer-method-ocr">
                        <span class="ocr-text">...</span>
                        <span class="ocr-confidence"></span>
                    </div>
                `;
                methodElements[methodKey] = methodThumb;
                methodsGrid.appendChild(methodThumb);

                // Click on 4x badge to toggle upscaled view
                const badge = methodThumb.querySelector('.plate-enhancer-upscale-badge');
                if (badge) {
                    badge.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const isShowingUpscaled = methodThumb.dataset.showingUpscaled === 'true';
                        const img = methodThumb.querySelector('img');
                        const nameDiv = methodThumb.querySelector('.plate-enhancer-method-name');

                        // Use watermarked version for display (upscaledDisplayUrl), original for downloads (upscaledDataUrl)
                        const upscaledDisplay = method.upscaledDisplayUrl || method.upscaledDataUrl;

                        if (isShowingUpscaled) {
                            // Switch to original
                            img.src = displayUrl;
                            nameDiv.textContent = methodNames[methodKey];
                            badge.classList.remove('active');
                            methodThumb.dataset.showingUpscaled = 'false';
                            // Update main preview if this is selected
                            if (methodThumb.classList.contains('selected')) {
                                mainImg.src = displayUrl;
                                mainLabel.textContent = `${method.name} (Sharpness: ${method.sharpness.toFixed(1)})`;
                            }
                        } else {
                            // Switch to upscaled (watermarked for display)
                            img.src = upscaledDisplay;
                            nameDiv.textContent = methodNames[methodKey] + ' 4x';
                            badge.classList.add('active');
                            methodThumb.dataset.showingUpscaled = 'true';
                            // Update main preview if this is selected
                            if (methodThumb.classList.contains('selected')) {
                                mainImg.src = upscaledDisplay;
                                mainLabel.textContent = `${method.name} 4x (Sharpness: ${method.upscaledSharpness?.toFixed(1) || 'N/A'})`;
                            }
                        }
                    });
                }

                // Click to preview
                methodThumb.addEventListener('click', (e) => {
                    // Don't trigger if clicking on badge
                    if (e.target.classList.contains('plate-enhancer-upscale-badge')) return;

                    // Determine which version to show (use watermarked for display)
                    const isShowingUpscaled = methodThumb.dataset.showingUpscaled === 'true';
                    const upscaledDisplay = method.upscaledDisplayUrl || method.upscaledDataUrl;
                    const srcToShow = isShowingUpscaled ? upscaledDisplay : displayUrl;
                    const sharpnessToShow = isShowingUpscaled ? method.upscaledSharpness : method.sharpness;
                    const labelSuffix = isShowingUpscaled ? ' 4x' : '';

                    // Update main preview
                    mainImg.src = srcToShow;
                    mainLabel.textContent = `${method.name}${labelSuffix} (Sharpness: ${sharpnessToShow?.toFixed(1) || 'N/A'})`;

                    // Update selection state
                    methodsGrid.querySelectorAll('.plate-enhancer-method-thumb').forEach(t => t.classList.remove('selected'));
                    methodThumb.classList.add('selected');

                    // Also update thumbnail selection (for consistency)
                    thumbsContainer?.querySelectorAll('.plate-enhancer-thumbnail').forEach(t => t.classList.remove('selected'));
                });
            });
        }

        // Use originalEnhanced for frame selection (preserves all frames across reprocessing)
        // After reprocessing, enhanced.topFrames only has selected frames, but we want all original frames
        const allFrames = this.originalEnhanced?.topFrames || enhanced.topFrames;

        // Frame selection controls (only if re-processing is available)
        let frameSelectionControls = null;
        if (canReprocess && this.lastExtraction) {
            frameSelectionControls = document.createElement('div');
            frameSelectionControls.className = 'plate-enhancer-frame-selection';
            frameSelectionControls.innerHTML = `
                <div class="plate-enhancer-frame-selection-header">
                    <span class="plate-enhancer-frame-selection-icon">🎞️</span>
                    <span class="plate-enhancer-frame-selection-label">Manual Frame Selection</span>
                </div>
                <p class="plate-enhancer-frame-selection-desc">
                    Not happy with the result? Uncheck blurry or misaligned frames below, then re-process with only the good ones.
                </p>
                <div class="plate-enhancer-frame-selection-controls">
                    <button class="plate-enhancer-btn-small" data-action="select-all" title="Include all frames - best for Lucky Regions">✓ All</button>
                    <button class="plate-enhancer-btn-small" data-action="select-none" title="Deselect all frames">✗ None</button>
                    <button class="plate-enhancer-btn-small" data-action="select-top5" title="Select only the 5 sharpest">Top 5</button>
                    <button class="plate-enhancer-btn-small" data-action="select-top10" title="Select the 10 sharpest - good balance">Top 10</button>
                    <button class="plate-enhancer-btn-small" data-action="select-top15" title="Select the 15 sharpest - great for Lucky">Top 15</button>
                    <span class="plate-enhancer-frame-count">0 / ${allFrames.length} selected</span>
                    <button class="plate-enhancer-btn plate-enhancer-btn-primary plate-enhancer-btn-reprocess" data-action="reprocess" disabled title="Need at least 2 frames">
                        🔄 Re-process Selected
                    </button>
                </div>
            `;
            modal.appendChild(frameSelectionControls);
        }

        // Thumbnails
        const thumbsLabel = document.createElement('div');
        thumbsLabel.className = 'plate-enhancer-thumbnails-label';
        thumbsLabel.textContent = canReprocess ? 'Source frames (click to preview, check to include):' : 'Source frames (ranked by sharpness):';
        modal.appendChild(thumbsLabel);

        const thumbsContainer = document.createElement('div');
        thumbsContainer.className = 'plate-enhancer-thumbnails';

        // Add combined as first thumbnail
        const combinedThumb = this.createThumbnail(enhanced.combined, 'Combined', 'Stacked', true, false);
        combinedThumb.classList.add('combined', 'selected');
        thumbsContainer.appendChild(combinedThumb);

        // Add upscaled version if available (for comparison)
        if (enhanced.upscaled) {
            const scale = enhanced.upscaled.scale || 2;
            const upscaledThumb = this.createThumbnail(enhanced.upscaled, `${scale}x Upscaled`, 'Super-res', true, false);
            upscaledThumb.classList.add('upscaled');
            thumbsContainer.appendChild(upscaledThumb);
        }

        // Add ALL original frames with checkboxes if re-processing available
        // This uses allFrames (from originalEnhanced) so frames are never lost after reprocessing
        allFrames.forEach((frame, index) => {
            // Show sharpness score in sublabel for debugging
            const sharpLabel = frame.sharpness ? `${frame.sharpness.toFixed(0)}` : '';
            const thumb = this.createThumbnail(frame, `#${index + 1}`, `${frame.cameraId} (${sharpLabel})`, false, canReprocess);
            thumb.dataset.frameIndex = index;
            thumb.dataset.sharpness = frame.sharpness || 0;
            // Pre-select all frames by default
            if (canReprocess) {
                const checkbox = thumb.querySelector('.plate-enhancer-frame-checkbox');
                if (checkbox) checkbox.checked = true;
            }
            thumbsContainer.appendChild(thumb);
        });

        modal.appendChild(thumbsContainer);

        // Update frame count display
        const updateFrameCount = () => {
            if (!frameSelectionControls) return;
            const checked = thumbsContainer.querySelectorAll('.plate-enhancer-frame-checkbox:checked').length;
            const total = allFrames.length; // Use allFrames (preserved across reprocessing)
            frameSelectionControls.querySelector('.plate-enhancer-frame-count').textContent = `${checked} / ${total} selected`;
            const reprocessBtn = frameSelectionControls.querySelector('[data-action="reprocess"]');
            reprocessBtn.disabled = checked < 2; // Need at least 2 frames
            if (checked < 2) {
                reprocessBtn.title = 'Select at least 2 frames';
            } else {
                reprocessBtn.title = '';
            }
        };

        // Frame selection control handlers
        if (frameSelectionControls) {
            frameSelectionControls.querySelector('[data-action="select-all"]').addEventListener('click', () => {
                thumbsContainer.querySelectorAll('.plate-enhancer-frame-checkbox').forEach(cb => cb.checked = true);
                updateFrameCount();
            });

            frameSelectionControls.querySelector('[data-action="select-none"]').addEventListener('click', () => {
                thumbsContainer.querySelectorAll('.plate-enhancer-frame-checkbox').forEach(cb => cb.checked = false);
                updateFrameCount();
            });

            frameSelectionControls.querySelector('[data-action="select-top5"]').addEventListener('click', () => {
                const checkboxes = thumbsContainer.querySelectorAll('.plate-enhancer-frame-checkbox');
                checkboxes.forEach((cb, i) => cb.checked = i < 5);
                updateFrameCount();
            });

            frameSelectionControls.querySelector('[data-action="select-top10"]').addEventListener('click', () => {
                const checkboxes = thumbsContainer.querySelectorAll('.plate-enhancer-frame-checkbox');
                checkboxes.forEach((cb, i) => cb.checked = i < 10);
                updateFrameCount();
            });

            frameSelectionControls.querySelector('[data-action="select-top15"]').addEventListener('click', () => {
                const checkboxes = thumbsContainer.querySelectorAll('.plate-enhancer-frame-checkbox');
                checkboxes.forEach((cb, i) => cb.checked = i < 15);
                updateFrameCount();
            });

            frameSelectionControls.querySelector('[data-action="reprocess"]').addEventListener('click', () => {
                // Get selected frame indices
                const selectedIndices = [];
                thumbsContainer.querySelectorAll('.plate-enhancer-frame-checkbox:checked').forEach(cb => {
                    const thumb = cb.closest('.plate-enhancer-thumbnail');
                    if (thumb && thumb.dataset.frameIndex !== undefined) {
                        selectedIndices.push(parseInt(thumb.dataset.frameIndex));
                    }
                });

                if (selectedIndices.length < 2) {
                    this.showToast('Select at least 2 frames');
                    return;
                }

                // Close current modal and re-process
                backdrop.remove();
                modal.remove();
                this.reprocessWithSelectedFrames(selectedIndices);
            });

            // Initial count
            updateFrameCount();
        }

        // Handle thumbnail clicks (for preview) and checkbox changes
        thumbsContainer.addEventListener('click', (e) => {
            // Handle checkbox clicks separately
            if (e.target.classList.contains('plate-enhancer-frame-checkbox')) {
                e.stopPropagation();
                updateFrameCount();
                return;
            }

            const thumb = e.target.closest('.plate-enhancer-thumbnail');
            if (thumb) {
                thumbsContainer.querySelectorAll('.plate-enhancer-thumbnail').forEach(t => t.classList.remove('selected'));
                thumb.classList.add('selected');
                // Also clear method thumb selection for consistency
                modal.querySelectorAll('.plate-enhancer-method-thumb').forEach(t => t.classList.remove('selected'));
                // Use displaySrc (watermarked) for preview, keep src for downloads
                mainImg.src = thumb.dataset.displaySrc || thumb.dataset.src;
                mainLabel.textContent = thumb.dataset.label;
            }
        });

        // Actions
        const actions = document.createElement('div');
        actions.className = 'plate-enhancer-results-actions';
        actions.innerHTML = `
            <div class="plate-enhancer-actions-row">
                <button class="plate-enhancer-btn plate-enhancer-btn-secondary" data-action="crop-region" title="Draw a region on the preview to crop">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                        <path d="M17 15h2V7c0-1.1-.9-2-2-2H9v2h8v8zM7 17V1H5v4H1v2h4v10c0 1.1.9 2 2 2h10v4h2v-4h4v-2H7z"/>
                    </svg>
                    Crop Region
                </button>
                <button class="plate-enhancer-btn plate-enhancer-btn-secondary" data-action="save-notes" title="Save OCR result to event notes (Pro)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
                    </svg>
                    Save to Notes
                    <span class="plate-enhancer-pro-badge">PRO</span>
                </button>
                <button class="plate-enhancer-btn plate-enhancer-btn-secondary" data-action="copy" title="Copy image to clipboard (Pro)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
                    </svg>
                    Copy Image
                    <span class="plate-enhancer-pro-badge">PRO</span>
                </button>
            </div>
            <div class="plate-enhancer-actions-row">
                <button class="plate-enhancer-btn plate-enhancer-btn-secondary" data-action="retry-shorter" title="Retry with ±2s timeframe">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                        <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                    </svg>
                    Retry Shorter
                </button>
                <button class="plate-enhancer-btn plate-enhancer-btn-secondary" data-action="detect-another" title="Run detection to find more plates">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                        <path d="M9.5 3A6.5 6.5 0 0 1 16 9.5c0 1.61-.59 3.09-1.56 4.23l.27.27h.79l5 5-1.5 1.5-5-5v-.79l-.27-.27A6.516 6.516 0 0 1 9.5 16 6.5 6.5 0 0 1 3 9.5 6.5 6.5 0 0 1 9.5 3m0 2C7 5 5 7 5 9.5S7 14 9.5 14 14 12 14 9.5 12 5 9.5 5Z"/>
                    </svg>
                    Detect Another
                </button>
                <button class="plate-enhancer-btn plate-enhancer-btn-secondary" data-action="download-all" title="Download all images as ZIP (Pro)">
                    Download All (ZIP)
                    <span class="plate-enhancer-pro-badge">PRO</span>
                </button>
                <button class="plate-enhancer-btn plate-enhancer-btn-primary" data-action="download-selected" title="Download selected image (Pro)">
                    Download Selected
                    <span class="plate-enhancer-pro-badge">PRO</span>
                </button>
            </div>
        `;
        modal.appendChild(actions);

        // Save to Notes handler (Pro feature)
        actions.querySelector('[data-action="save-notes"]')?.addEventListener('click', async () => {
            if (!await this.checkProAccess('save to notes')) return;
            if (!this.lastOCRResult?.text) {
                this.showToast('No OCR result to save');
                return;
            }
            // Save to notes via NotesManager
            if (window.app?.notesManager) {
                const currentEvent = window.app.eventBrowser?.selectedEvent;
                if (currentEvent) {
                    const noteText = `License Plate: ${this.lastOCRResult.text} (${this.lastOCRResult.confidence.toFixed(0)}% confidence)`;
                    await window.app.notesManager.addNote(currentEvent.id, noteText);
                    this.showToast('Saved to notes!');
                } else {
                    this.showToast('No event selected', 'error');
                }
            } else {
                this.showToast('Notes feature not available', 'error');
            }
        });

        // Retry Shorter handler - reprocess existing frames with subset
        actions.querySelector('[data-action="retry-shorter"]')?.addEventListener('click', async () => {
            closeModal();

            // If we have topFrames from last enhancement, reprocess with shorter subset
            if (this.lastEnhanced?.topFrames && this.lastEnhanced.topFrames.length >= 2) {
                // Use first 5 frames (or all if less than 5) which are the sharpest
                const frameCount = Math.min(5, this.lastEnhanced.topFrames.length);
                const selectedIndices = Array.from({ length: frameCount }, (_, i) => i);
                await this.reprocessWithSelectedFrames(selectedIndices);
            } else {
                // No frames available - enter selection mode
                this.showToast('Please select a region to enhance', 'info');
                this.startSelectionMode();
            }
        });

        // Detect Another handler
        actions.querySelector('[data-action="detect-another"]')?.addEventListener('click', async () => {
            closeModal();
            // Start plate selection mode
            await this.autoDetectPlates();
        });

        // Download All handler (Pro feature)
        actions.querySelector('[data-action="download-all"]')?.addEventListener('click', async () => {
            if (!await this.checkProAccess('download all images')) return;
            await this.downloadAllAsZip(enhanced);
        });

        // Crop region functionality
        let cropOverlay = null;
        let cropSelection = null;
        let isCropping = false;
        let cropEscapeHandler = null;

        // Helper to exit crop mode cleanly
        const exitCropMode = () => {
            if (cropOverlay) cropOverlay.remove();
            cropOverlay = null;
            cropSelection = null;
            isCropping = false;
            const cropBtn = actions.querySelector('[data-action="crop-region"]');
            cropBtn.classList.remove('crop-mode-active');
            cropBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                    <path d="M17 15h2V7c0-1.1-.9-2-2-2H9v2h8v8zM7 17V1H5v4H1v2h4v10c0 1.1.9 2 2 2h10v4h2v-4h4v-2H7z"/>
                </svg>
                Crop Region
            `;
            mainLabel.textContent = 'Combined Result (click thumbnails below to compare)';
            if (cropEscapeHandler) {
                document.removeEventListener('keydown', cropEscapeHandler);
                cropEscapeHandler = null;
            }
        };

        actions.querySelector('[data-action="crop-region"]').addEventListener('click', () => {
            if (isCropping) {
                exitCropMode();
                return;
            }

            isCropping = true;
            const cropBtn = actions.querySelector('[data-action="crop-region"]');
            cropBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                </svg>
                Cancel Crop (Esc)
            `;
            cropBtn.classList.add('crop-mode-active');
            mainLabel.textContent = '';

            // Create crop overlay with instruction
            cropOverlay = document.createElement('div');
            cropOverlay.className = 'plate-enhancer-crop-overlay';

            // Add instruction banner
            const instruction = document.createElement('div');
            instruction.className = 'plate-enhancer-crop-instruction';
            instruction.innerHTML = `
                <div class="crop-instruction-icon">✂️</div>
                <div class="crop-instruction-text">
                    <strong>Click and drag</strong> to select the area you want to crop
                </div>
                <div class="crop-instruction-hint">Press <kbd>Esc</kbd> or click the red button to cancel</div>
            `;
            cropOverlay.appendChild(instruction);

            mainPreview.appendChild(cropOverlay);

            // Add Escape key handler for crop mode
            cropEscapeHandler = (e) => {
                if (e.key === 'Escape' && isCropping) {
                    e.preventDefault();
                    exitCropMode();
                }
            };
            document.addEventListener('keydown', cropEscapeHandler);

            let startX, startY, selectionBox;

            cropOverlay.addEventListener('mousedown', (e) => {
                // Hide instruction banner when user starts drawing
                const instructionEl = cropOverlay.querySelector('.plate-enhancer-crop-instruction');
                if (instructionEl) instructionEl.remove();

                const rect = cropOverlay.getBoundingClientRect();
                startX = e.clientX - rect.left;
                startY = e.clientY - rect.top;

                // Remove existing selection
                if (selectionBox) selectionBox.remove();

                selectionBox = document.createElement('div');
                selectionBox.className = 'plate-enhancer-crop-selection';
                selectionBox.style.left = startX + 'px';
                selectionBox.style.top = startY + 'px';
                cropOverlay.appendChild(selectionBox);

                const onMouseMove = (e) => {
                    const currentX = e.clientX - rect.left;
                    const currentY = e.clientY - rect.top;

                    const x = Math.min(startX, currentX);
                    const y = Math.min(startY, currentY);
                    const width = Math.abs(currentX - startX);
                    const height = Math.abs(currentY - startY);

                    selectionBox.style.left = x + 'px';
                    selectionBox.style.top = y + 'px';
                    selectionBox.style.width = width + 'px';
                    selectionBox.style.height = height + 'px';
                };

                const onMouseUp = (e) => {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);

                    const currentX = e.clientX - rect.left;
                    const currentY = e.clientY - rect.top;

                    const x = Math.min(startX, currentX);
                    const y = Math.min(startY, currentY);
                    const width = Math.abs(currentX - startX);
                    const height = Math.abs(currentY - startY);

                    if (width > 10 && height > 10) {
                        // Valid selection - add apply button
                        // Get the actual image rect (may be letterboxed within overlay)
                        const imgRect = mainImg.getBoundingClientRect();
                        cropSelection = {
                            x, y, width, height,
                            overlayWidth: rect.width,
                            overlayHeight: rect.height,
                            imgRect: { left: imgRect.left, top: imgRect.top, width: imgRect.width, height: imgRect.height },
                            overlayRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
                        };

                        // Add button container to selection
                        const btnContainer = document.createElement('div');
                        btnContainer.className = 'plate-enhancer-crop-buttons';

                        // Cancel button
                        const cancelBtn = document.createElement('button');
                        cancelBtn.className = 'plate-enhancer-crop-cancel';
                        cancelBtn.textContent = 'Cancel';
                        cancelBtn.addEventListener('mousedown', (e) => e.stopPropagation());
                        cancelBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            exitCropMode();
                        });
                        btnContainer.appendChild(cancelBtn);

                        // Apply button
                        const applyBtn = document.createElement('button');
                        applyBtn.className = 'plate-enhancer-crop-apply';
                        applyBtn.textContent = 'Apply & Re-process';
                        applyBtn.addEventListener('mousedown', (e) => e.stopPropagation());
                        applyBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            // Close the modal and re-process with cropped region
                            backdrop.remove();
                            modal.remove();
                            this.reprocessWithCroppedRegion(cropSelection, enhanced);
                        });
                        btnContainer.appendChild(applyBtn);

                        selectionBox.appendChild(btnContainer);
                    } else {
                        // Too small - remove
                        selectionBox.remove();
                    }
                };

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        });

        // Handle close
        const closeModal = () => {
            backdrop.remove();
            modal.remove();
        };

        header.querySelector('.plate-enhancer-close-btn').addEventListener('click', closeModal);
        backdrop.addEventListener('click', closeModal);

        // Handle copy to clipboard (Pro feature)
        actions.querySelector('[data-action="copy"]').addEventListener('click', async () => {
            if (!await this.checkProAccess('copy image')) return;
            // Check both thumbnail and method thumb selections
            const selectedThumb = thumbsContainer.querySelector('.plate-enhancer-thumbnail.selected');
            const selectedMethod = modal.querySelector('.plate-enhancer-method-thumb.selected');
            const selected = selectedThumb || selectedMethod;
            if (selected) {
                await this.copyToClipboard(selected.dataset.src);
            } else {
                this.showToast('No image selected', 'info');
            }
        });

        // Handle downloads (Pro feature)
        actions.querySelector('[data-action="download-selected"]').addEventListener('click', async () => {
            if (!await this.checkProAccess('download image')) return;
            // Check both thumbnail and method thumb selections
            const selectedThumb = thumbsContainer.querySelector('.plate-enhancer-thumbnail.selected');
            const selectedMethod = modal.querySelector('.plate-enhancer-method-thumb.selected');
            const selected = selectedThumb || selectedMethod;
            if (selected) {
                this.downloadImage(selected.dataset.src, 'enhanced-plate.png');
            } else {
                this.showToast('No image selected', 'info');
            }
        });

        actions.querySelector('[data-action="download-all"]').addEventListener('click', async () => {
            if (!await this.checkProAccess('download all images')) return;
            await this.downloadAllAsZip(enhanced);
        });

        document.body.appendChild(backdrop);
        document.body.appendChild(modal);

        // Block right-click on images for free users only
        this.setupImageRightClickProtection(modal);
    }

    /**
     * Block right-click on images for free users, allow for Pro users
     * @param {HTMLElement} container - Container with images to protect
     */
    async setupImageRightClickProtection(container) {
        const isPro = await this.isProUser();
        if (isPro) return; // Pro users can right-click freely

        // Block right-click on all images in the container
        container.addEventListener('contextmenu', (e) => {
            if (e.target.tagName === 'IMG') {
                e.preventDefault();
            }
        });
    }

    /**
     * Create thumbnail element
     * @param {Object} frame - Frame data with dataUrl and optional displayUrl (watermarked)
     * @param {string} rank - Rank label
     * @param {string} cameraLabel - Camera identifier
     * @param {boolean} isCombined - Whether this is a combined/processed result
     * @param {boolean} showCheckbox - Whether to show selection checkbox
     */
    createThumbnail(frame, rank, cameraLabel, isCombined = false, showCheckbox = false) {
        const thumb = document.createElement('div');
        thumb.className = 'plate-enhancer-thumbnail';
        if (showCheckbox) thumb.classList.add('selectable');
        thumb.dataset.src = frame.dataUrl; // Original for downloads
        thumb.dataset.displaySrc = frame.displayUrl || frame.dataUrl; // Watermarked for display
        thumb.dataset.label = isCombined ? 'Combined Result' : `${rank} - ${this.getCameraDisplayName(cameraLabel)}`;

        // Add checkbox for frame selection
        if (showCheckbox) {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'plate-enhancer-frame-checkbox';
            checkbox.title = 'Include in re-processing';
            thumb.appendChild(checkbox);
        }

        const img = document.createElement('img');
        img.src = frame.displayUrl || frame.dataUrl; // Show watermarked version
        thumb.appendChild(img);

        const info = document.createElement('div');
        info.className = 'plate-enhancer-thumbnail-info';
        info.innerHTML = `
            <div class="plate-enhancer-thumbnail-rank">${rank}</div>
            <div class="plate-enhancer-thumbnail-camera">${this.getCameraDisplayName(cameraLabel)}</div>
        `;
        thumb.appendChild(info);

        return thumb;
    }

    /**
     * Re-process with only selected frames
     * @param {number[]} selectedIndices - Indices of frames to include
     */
    async reprocessWithSelectedFrames(selectedIndices) {
        // Use originalEnhanced if available (preserves all frames across reprocessing)
        const sourceEnhanced = this.originalEnhanced || this.lastEnhanced;

        if (!this.lastExtraction || !sourceEnhanced) {
            this.showError('No extraction data available for re-processing');
            return;
        }

        this.isProcessing = true;
        this.shouldCancel = false;

        // Show progress modal
        const backdrop = document.createElement('div');
        backdrop.className = 'plate-enhancer-dialog-backdrop';

        const progress = document.createElement('div');
        progress.className = 'plate-enhancer-progress';
        progress.innerHTML = `
            <h3>Re-processing with ${selectedIndices.length} frames</h3>
            <div class="plate-enhancer-progress-status">Preparing...</div>
            <div class="plate-enhancer-progress-bar">
                <div class="plate-enhancer-progress-fill" style="width: 0%"></div>
            </div>
            <div class="plate-enhancer-progress-percent">0%</div>
            <div class="plate-enhancer-progress-cancel">
                <button class="plate-enhancer-btn plate-enhancer-btn-secondary">Cancel</button>
            </div>
        `;

        progress.querySelector('button').addEventListener('click', () => {
            this.shouldCancel = true;
        });

        document.body.appendChild(backdrop);
        document.body.appendChild(progress);

        const updateProgress = (status, percent) => {
            progress.querySelector('.plate-enhancer-progress-status').textContent = status;
            progress.querySelector('.plate-enhancer-progress-fill').style.width = `${percent}%`;
            progress.querySelector('.plate-enhancer-progress-percent').textContent = `${Math.round(percent)}%`;
        };

        try {
            const { settings } = this.lastExtraction;

            // Get only selected frames from the ORIGINAL topFrames (preserved across reprocessing)
            // This allows user to try different selections without losing frames
            const selectedFrameData = selectedIndices.map(i => sourceEnhanced.topFrames[i]);

            // We need the original regions and frames that correspond to these
            // The topFrames have indices into the original data
            const selectedRegions = selectedFrameData.map(f => ({
                x: 0,
                y: 0,
                width: f.width,
                height: f.height,
                imageData: f.imageData,
                sharpness: f.sharpness,
                cameraId: f.cameraId
            }));

            // Create new stacker
            const stacker = new FrameStacker();

            if (settings.enableMLUpscale) {
                stacker.enableMLUpscale(true, settings.upscaleScale, 'thick');
                stacker.postProcessSharpening = true; // Crisp text edges
                stacker.enablePreProcessing = true; // MAX QUALITY pipeline
            }

            // ALWAYS use real multi-frame stacking
            stacker.useRealStacking = true;
            stacker.stackingMethod = 'sigma-mean';

            updateProgress('Processing selected frames...', 20);
            await new Promise(r => setTimeout(r, 47));

            if (this.shouldCancel) throw new Error('Cancelled');

            // Process with selected frames only
            // We pass the cropped regions directly since they're already extracted
            const enhanced = await stacker.processPreCropped(selectedFrameData, (status, pct) => {
                updateProgress(status, 20 + pct * 0.7);
            }, settings.videoEnhancements);

            if (this.shouldCancel) throw new Error('Cancelled');

            // Store for potential further re-processing
            this.lastEnhanced = enhanced;

            updateProgress('Complete!', 100);

            backdrop.remove();
            progress.remove();

            // Show results (with re-processing still available)
            await this.showResults(enhanced, true);

        } catch (error) {
            backdrop.remove();
            progress.remove();

            if (error.message !== 'Cancelled') {
                console.error('[PlateEnhancer] Re-processing error:', error);
                this.showError(`Re-processing failed: ${error.message}`);
            }
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Re-process all frames with a cropped region
     * @param {Object} selection - Crop selection with coordinates
     * @param {Object} enhanced - Current enhanced result with topFrames
     */
    async reprocessWithCroppedRegion(selection, enhanced) {
        if (!enhanced || !enhanced.topFrames || enhanced.topFrames.length < 2) {
            this.showError('No frames available for re-processing');
            return;
        }

        this.isProcessing = true;
        this.shouldCancel = false;

        // Show progress modal
        const backdrop = document.createElement('div');
        backdrop.className = 'plate-enhancer-dialog-backdrop';

        const progress = document.createElement('div');
        progress.className = 'plate-enhancer-progress';
        progress.innerHTML = `
            <h3>Re-processing with Cropped Region</h3>
            <div class="plate-enhancer-progress-status">Preparing...</div>
            <div class="plate-enhancer-progress-bar">
                <div class="plate-enhancer-progress-fill" style="width: 0%"></div>
            </div>
            <div class="plate-enhancer-progress-percent">0%</div>
            <div class="plate-enhancer-progress-cancel">
                <button class="plate-enhancer-btn plate-enhancer-btn-secondary">Cancel</button>
            </div>
        `;

        progress.querySelector('button').addEventListener('click', () => {
            this.shouldCancel = true;
        });

        document.body.appendChild(backdrop);
        document.body.appendChild(progress);

        const updateProgress = (status, percent) => {
            progress.querySelector('.plate-enhancer-progress-status').textContent = status;
            progress.querySelector('.plate-enhancer-progress-fill').style.width = `${percent}%`;
            progress.querySelector('.plate-enhancer-progress-percent').textContent = `${Math.round(percent)}%`;
        };

        try {
            // Calculate crop as percentages (relative to displayed image)
            const imgRect = selection.imgRect;
            const overlayRect = selection.overlayRect;

            const imgOffsetX = imgRect.left - overlayRect.left;
            const imgOffsetY = imgRect.top - overlayRect.top;

            const relX = selection.x - imgOffsetX;
            const relY = selection.y - imgOffsetY;

            // Calculate crop percentages relative to displayed image
            const cropLeftPct = Math.max(0, relX / imgRect.width);
            const cropTopPct = Math.max(0, relY / imgRect.height);
            const cropWidthPct = Math.min(1 - cropLeftPct, selection.width / imgRect.width);
            const cropHeightPct = Math.min(1 - cropTopPct, selection.height / imgRect.height);

            console.log('[PlateEnhancer] Crop percentages:', { cropLeftPct, cropTopPct, cropWidthPct, cropHeightPct });

            if (cropWidthPct <= 0 || cropHeightPct <= 0) {
                throw new Error('Invalid crop region');
            }

            // Apply crop to all source frames
            updateProgress('Cropping source frames...', 10);
            const croppedFrames = [];

            for (let i = 0; i < enhanced.topFrames.length; i++) {
                if (this.shouldCancel) throw new Error('Cancelled');

                const frame = enhanced.topFrames[i];
                const croppedDataUrl = await this.cropImageByPercentage(frame.dataUrl, cropLeftPct, cropTopPct, cropWidthPct, cropHeightPct);

                croppedFrames.push({
                    dataUrl: croppedDataUrl,
                    sharpness: frame.sharpness,
                    cameraId: frame.cameraId,
                    time: frame.time
                });

                updateProgress(`Cropping frames (${i + 1}/${enhanced.topFrames.length})...`, 10 + (i / enhanced.topFrames.length) * 20);
            }

            if (this.shouldCancel) throw new Error('Cancelled');

            // Re-process cropped frames through stacker
            const settings = this.lastExtraction?.settings || {};
            const stacker = new FrameStacker();

            if (settings.enableMLUpscale) {
                stacker.enableMLUpscale(true, settings.upscaleScale, 'thick');
                stacker.postProcessSharpening = true; // Crisp text edges
                stacker.enablePreProcessing = true; // MAX QUALITY pipeline
            }

            // ALWAYS use real multi-frame stacking
            stacker.useRealStacking = true;
            stacker.stackingMethod = 'sigma-mean';

            updateProgress('Stacking cropped frames...', 35);

            const newEnhanced = await stacker.processPreCropped(croppedFrames, (status, pct) => {
                updateProgress(status, 35 + pct * 0.55);
            }, settings.videoEnhancements);

            if (this.shouldCancel) throw new Error('Cancelled');

            // Store for potential further re-processing
            this.lastEnhanced = newEnhanced;

            updateProgress('Complete!', 100);

            backdrop.remove();
            progress.remove();

            // Show results
            await this.showResults(newEnhanced, true);

        } catch (error) {
            backdrop.remove();
            progress.remove();

            if (error.message !== 'Cancelled') {
                console.error('[PlateEnhancer] Crop re-processing error:', error);
                this.showError(`Crop re-processing failed: ${error.message}`);
            }
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Crop an image by percentage values
     * @param {string} dataUrl - Source image
     * @param {number} leftPct - Left offset as percentage (0-1)
     * @param {number} topPct - Top offset as percentage (0-1)
     * @param {number} widthPct - Width as percentage (0-1)
     * @param {number} heightPct - Height as percentage (0-1)
     * @returns {string} Cropped image data URL
     */
    async cropImageByPercentage(dataUrl, leftPct, topPct, widthPct, heightPct) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const x = Math.round(img.naturalWidth * leftPct);
                const y = Math.round(img.naturalHeight * topPct);
                const w = Math.round(img.naturalWidth * widthPct);
                const h = Math.round(img.naturalHeight * heightPct);

                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, x, y, w, h, 0, 0, w, h);

                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = reject;
            img.src = dataUrl;
        });
    }

    /**
     * Apply crop to result and add as new thumbnail
     * @param {string} imageSrc - Source image data URL
     * @param {Object} selection - Crop selection { x, y, width, height, overlayWidth, overlayHeight, imgRect, overlayRect }
     * @param {HTMLImageElement} mainImg - Main preview image element
     * @param {HTMLElement} mainLabel - Main preview label element
     * @param {HTMLElement} thumbsContainer - Thumbnails container
     */
    async applyCropToResult(imageSrc, selection, mainImg, mainLabel, thumbsContainer) {
        try {
            // Load the image to get natural dimensions
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = imageSrc;
            });

            // The image might be letterboxed within the container due to object-fit: contain
            // We need to calculate where the image actually is displayed
            const imgRect = selection.imgRect;
            const overlayRect = selection.overlayRect;

            // Calculate the offset of the image within the overlay
            const imgOffsetX = imgRect.left - overlayRect.left;
            const imgOffsetY = imgRect.top - overlayRect.top;

            // Adjust selection coordinates to be relative to the displayed image
            const relX = selection.x - imgOffsetX;
            const relY = selection.y - imgOffsetY;

            // Scale from displayed image size to natural image size
            const scaleX = img.naturalWidth / imgRect.width;
            const scaleY = img.naturalHeight / imgRect.height;

            // Calculate crop in natural pixel coordinates
            const cropX = Math.max(0, Math.round(relX * scaleX));
            const cropY = Math.max(0, Math.round(relY * scaleY));
            let cropWidth = Math.round(selection.width * scaleX);
            let cropHeight = Math.round(selection.height * scaleY);

            // Clamp to image bounds
            cropWidth = Math.min(cropWidth, img.naturalWidth - cropX);
            cropHeight = Math.min(cropHeight, img.naturalHeight - cropY);

            console.log('[PlateEnhancer] Crop coords:', { cropX, cropY, cropWidth, cropHeight, naturalW: img.naturalWidth, naturalH: img.naturalHeight });

            // Validate crop dimensions
            if (cropWidth <= 0 || cropHeight <= 0) {
                this.showToast('Invalid crop region - selection outside image');
                return;
            }

            // Create canvas and crop
            const canvas = document.createElement('canvas');
            canvas.width = cropWidth;
            canvas.height = cropHeight;
            const ctx = canvas.getContext('2d');

            ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

            const croppedDataUrl = canvas.toDataURL('image/png');

            // Update main preview
            mainImg.src = croppedDataUrl;
            mainLabel.textContent = 'Cropped Result';

            // Add cropped version as a new thumbnail at the beginning
            const croppedThumb = document.createElement('div');
            croppedThumb.className = 'plate-enhancer-thumbnail cropped selected';
            croppedThumb.dataset.src = croppedDataUrl;
            croppedThumb.dataset.label = 'Cropped Result';

            const thumbImg = document.createElement('img');
            thumbImg.src = croppedDataUrl;
            croppedThumb.appendChild(thumbImg);

            const info = document.createElement('div');
            info.className = 'plate-enhancer-thumbnail-info';
            info.innerHTML = `
                <div class="plate-enhancer-thumbnail-rank">Cropped</div>
                <div class="plate-enhancer-thumbnail-camera">${cropWidth}x${cropHeight}</div>
            `;
            croppedThumb.appendChild(info);

            // Deselect other thumbnails
            thumbsContainer.querySelectorAll('.plate-enhancer-thumbnail').forEach(t => t.classList.remove('selected'));

            // Insert at beginning (after combined if it exists)
            const combined = thumbsContainer.querySelector('.combined');
            if (combined) {
                combined.after(croppedThumb);
            } else {
                thumbsContainer.prepend(croppedThumb);
            }

            this.showToast('Region cropped successfully!');

        } catch (error) {
            console.error('[PlateEnhancer] Crop failed:', error);
            this.showToast('Crop failed');
        }
    }

    /**
     * Check if user has Pro access (no watermark needed)
     * @returns {Promise<boolean>}
     */
    async isProUser() {
        try {
            const access = await window.app?.sessionManager?.checkAccess?.('plateEnhancement');
            return access?.allowed === true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Add watermark to image for free users
     * @param {string} dataUrl - Source image data URL
     * @returns {Promise<string>} - Watermarked image data URL
     */
    async addWatermark(dataUrl) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');

                // Draw original image
                ctx.drawImage(img, 0, 0);

                // Calculate diagonal angle from corner to corner
                const diagonalAngle = Math.atan2(img.height, img.width);
                const diagonalLength = Math.sqrt(img.width * img.width + img.height * img.height);

                // Font size based on diagonal length for good coverage
                const fontSize = Math.max(16, Math.min(48, diagonalLength / 12));
                ctx.font = `bold ${fontSize}px Arial, sans-serif`;

                const text = 'TeslaCamViewer.com';
                const textMetrics = ctx.measureText(text);

                // Save context, move to center, rotate
                ctx.save();
                ctx.translate(img.width / 2, img.height / 2);
                ctx.rotate(diagonalAngle);

                // Draw text centered on diagonal with outline for visibility
                ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
                ctx.lineWidth = 3;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';

                ctx.strokeText(text, 0, 0);
                ctx.fillText(text, 0, 0);

                ctx.restore();

                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = () => resolve(dataUrl); // Fallback to original on error
            img.src = dataUrl;
        });
    }

    /**
     * Download single image (with watermark for free users)
     */
    async downloadImage(dataUrl, filename) {
        // Check if Pro user - Pro users get clean images
        const isPro = await this.isProUser();
        const finalDataUrl = isPro ? dataUrl : await this.addWatermark(dataUrl);

        const link = document.createElement('a');
        link.href = finalDataUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    /**
     * Copy image to clipboard (with watermark for free users)
     */
    async copyToClipboard(dataUrl) {
        try {
            // Check if Pro user - Pro users get clean images
            const isPro = await this.isProUser();
            const finalDataUrl = isPro ? dataUrl : await this.addWatermark(dataUrl);

            // Convert data URL to blob
            const response = await fetch(finalDataUrl);
            const blob = await response.blob();

            // Use clipboard API
            await navigator.clipboard.write([
                new ClipboardItem({
                    [blob.type]: blob
                })
            ]);

            // Show brief success feedback
            this.showToast('Copied to clipboard!');
        } catch (error) {
            console.error('[PlateEnhancer] Copy failed:', error);
            this.showError('Failed to copy to clipboard. Try downloading instead.');
        }
    }

    /**
     * Show a brief toast notification
     */
    showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'plate-enhancer-toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        // Animate in
        setTimeout(() => toast.classList.add('show'), 10);

        // Remove after delay
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    /**
     * Download all results as ZIP (with watermarks for free users)
     */
    async downloadAllAsZip(enhanced) {
        if (typeof JSZip === 'undefined') {
            this.showError('ZIP library not available');
            return;
        }

        // Check if Pro user - Pro users get clean images
        const isPro = await this.isProUser();

        const zip = new JSZip();
        const folder = zip.folder('enhanced-plates');

        // Helper to get data for zip (with optional watermark)
        const getImageData = async (dataUrl) => {
            if (isPro) {
                return dataUrl.split(',')[1];
            }
            const watermarked = await this.addWatermark(dataUrl);
            return watermarked.split(',')[1];
        };

        // Add combined result
        const combinedData = await getImageData(enhanced.combined.dataUrl);
        folder.file('00-combined.png', combinedData, { base64: true });

        // Add upscaled version if available
        if (enhanced.upscaled) {
            const upscaledData = await getImageData(enhanced.upscaled.dataUrl);
            const scale = enhanced.upscaled.scale || 2;
            folder.file(`00-combined-${scale}x-upscaled.png`, upscaledData, { base64: true });
        }

        // Add all enhancement methods (including Lucky Regions if available)
        if (enhanced.methods) {
            const methodOrder = ['sigmaClipped', 'msrClahe', 'weightedMean', 'bestFrame', 'bilateral', 'ensemble', 'luckyRegions'];
            for (let idx = 0; idx < methodOrder.length; idx++) {
                const key = methodOrder[idx];
                const method = enhanced.methods[key];
                if (method?.dataUrl) {
                    // Add original version
                    const data = await getImageData(method.dataUrl);
                    folder.file(`01-method-${String(idx + 1).padStart(2, '0')}-${key}.png`, data, { base64: true });

                    // Add 4x upscaled version if available
                    if (method.upscaledDataUrl) {
                        const upscaledData = await getImageData(method.upscaledDataUrl);
                        folder.file(`01-method-${String(idx + 1).padStart(2, '0')}-${key}-4x.png`, upscaledData, { base64: true });
                    }
                }
            }
        }

        // Add top frames
        for (let idx = 0; idx < enhanced.topFrames.length; idx++) {
            const frame = enhanced.topFrames[idx];
            const data = await getImageData(frame.dataUrl);
            const camera = frame.cameraId.replace('_', '-');
            folder.file(`02-source-${String(idx + 1).padStart(2, '0')}-${camera}.png`, data, { base64: true });
        }

        // Generate and download
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'enhanced-plates.zip';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    /**
     * Get current video enhancement settings (brightness, contrast, saturation)
     */
    getVideoEnhancementSettings() {
        const enhancer = window.app?.videoEnhancer;
        if (!enhancer || !enhancer.settings) {
            return { brightness: 100, contrast: 100, saturation: 100 };
        }
        // Use ?? instead of || to handle 0 values correctly (saturation=0 means grayscale)
        return {
            brightness: enhancer.settings.brightness ?? 100,
            contrast: enhancer.settings.contrast ?? 100,
            saturation: enhancer.settings.saturation ?? 100
        };
    }

    /**
     * Apply video enhancement settings to a canvas context before drawing
     * Uses CSS filter syntax on canvas 2D context
     * @param {CanvasRenderingContext2D} ctx - The canvas context
     * @param {Object} settings - Video enhancement settings { brightness, contrast, saturation }
     * @returns {string|null} The filter string applied, or null if no filter needed
     */
    applyVideoEnhancementsToCanvas(ctx, settings) {
        if (!settings) return null;

        const { brightness, contrast, saturation } = settings;

        // Skip if all settings are at default (100)
        if (brightness === 100 && contrast === 100 && saturation === 100) {
            return null;
        }

        // Build CSS filter string (values are 0-200, where 100 = 1.0)
        const filterParts = [];
        if (brightness !== 100) {
            filterParts.push(`brightness(${brightness / 100})`);
        }
        if (contrast !== 100) {
            filterParts.push(`contrast(${contrast / 100})`);
        }
        if (saturation !== 100) {
            filterParts.push(`saturate(${saturation / 100})`);
        }

        const filterString = filterParts.join(' ');
        ctx.filter = filterString;

        return filterString;
    }

    /**
     * Show error message
     */
    showError(message) {
        const backdrop = document.createElement('div');
        backdrop.className = 'plate-enhancer-dialog-backdrop';

        const dialog = document.createElement('div');
        dialog.className = 'plate-enhancer-dialog';
        dialog.innerHTML = `
            <h3>Error</h3>
            <div class="plate-enhancer-error">${message}</div>
            <div class="plate-enhancer-dialog-actions">
                <button class="plate-enhancer-btn plate-enhancer-btn-primary">OK</button>
            </div>
        `;

        dialog.querySelector('button').addEventListener('click', () => {
            backdrop.remove();
            dialog.remove();
        });

        backdrop.addEventListener('click', () => {
            backdrop.remove();
            dialog.remove();
        });

        document.body.appendChild(backdrop);
        document.body.appendChild(dialog);
    }

    /**
     * Load Tesseract.js on demand
     */
    async loadTesseract() {
        if (this.isTesseractLoaded) return true;
        if (this.isLoadingTesseract) {
            // Wait for existing load
            return new Promise((resolve) => {
                const check = setInterval(() => {
                    if (this.isTesseractLoaded) {
                        clearInterval(check);
                        resolve(true);
                    }
                }, 100);
                setTimeout(() => {
                    clearInterval(check);
                    resolve(false);
                }, 30000);
            });
        }

        this.isLoadingTesseract = true;

        try {
            // Load Tesseract.js from CDN
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });

            this.isTesseractLoaded = true;
            console.log('[PlateEnhancer] Tesseract.js loaded');
            return true;
        } catch (error) {
            console.error('[PlateEnhancer] Failed to load Tesseract.js:', error);
            return false;
        } finally {
            this.isLoadingTesseract = false;
        }
    }

    /**
     * Check Pro access for a feature
     * @param {string} feature - Feature name for display
     * @returns {boolean} - Whether access is allowed
     */
    async checkProAccess(feature) {
        // Check if session manager exists and has checkAccess
        if (!window.app?.sessionManager?.checkAccess) {
            // No session manager - this is free mode, block Pro features
            console.log(`[PlateEnhancer] Pro feature "${feature}" blocked - no session manager`);
            this.showToast('This feature requires TeslaCamViewer Pro');
            return false;
        }

        const access = await window.app.sessionManager.checkAccess('plateEnhancement');
        if (!access.allowed) {
            window.app.sessionManager.showLimitModal('premium');
            return false;
        }
        return true;
    }

    /**
     * Run ensemble OCR across all enhancement methods
     * Takes the best result from all methods
     * @param {Object} enhanced - Enhanced results with methods
     * @param {Function} onProgress - Progress callback
     * @returns {Object} - { text, confidence, warning }
     */
    async runEnsembleOCR(enhanced, onProgress = null) {
        // Collect all images to run OCR on
        const images = [];

        // Add the main combined result
        images.push({ name: 'combined', dataUrl: enhanced.combined.dataUrl });

        // Add all method results if available
        if (enhanced.methods) {
            for (const [key, method] of Object.entries(enhanced.methods)) {
                if (method.dataUrl) {
                    images.push({ name: key, dataUrl: method.dataUrl });
                }
            }
        }

        // Add upscaled if available
        if (enhanced.upscaled?.dataUrl) {
            images.push({ name: 'upscaled', dataUrl: enhanced.upscaled.dataUrl });
        }

        if (onProgress) onProgress('Running ensemble OCR...', 0);

        const results = [];
        const methodResults = {}; // Store per-method OCR results
        let processedCount = 0;

        for (const img of images) {
            try {
                const result = await this.runOCR(img.dataUrl, (status, progress) => {
                    if (onProgress) {
                        const overallProgress = (processedCount + (progress || 0)) / images.length;
                        onProgress(`Analyzing ${img.name}...`, overallProgress);
                    }
                });

                // Store per-method result
                methodResults[img.name] = {
                    text: result.text || '',
                    confidence: result.confidence || 0
                };

                if (result.text && result.confidence > 0) {
                    results.push({
                        ...result,
                        source: img.name
                    });
                }
            } catch (e) {
                console.warn(`[PlateEnhancer] OCR failed for ${img.name}:`, e);
                methodResults[img.name] = { text: '', confidence: 0, error: e.message };
            }
            processedCount++;
        }

        if (results.length === 0) {
            return { text: '', confidence: 0, error: 'No text detected', methodResults };
        }

        // Vote for the best result
        // Group by text and sum confidences
        const textVotes = new Map();
        for (const result of results) {
            const normalizedText = result.text.toUpperCase().replace(/\s+/g, '');
            if (!textVotes.has(normalizedText)) {
                textVotes.set(normalizedText, { text: result.text, totalConf: 0, count: 0 });
            }
            const vote = textVotes.get(normalizedText);
            vote.totalConf += result.confidence;
            vote.count++;
        }

        // Find best result (highest total confidence)
        let bestResult = null;
        let bestScore = -1;
        for (const vote of textVotes.values()) {
            const score = vote.totalConf + (vote.count * 10); // Bonus for consistency
            if (score > bestScore) {
                bestScore = score;
                bestResult = vote;
            }
        }

        const avgConfidence = bestResult.totalConf / bestResult.count;
        console.log(`[PlateEnhancer] Ensemble OCR: "${bestResult.text}" (${avgConfidence.toFixed(1)}% avg, ${bestResult.count} votes)`);

        return {
            text: bestResult.text,
            confidence: avgConfidence,
            votes: bestResult.count,
            warning: avgConfidence < 50,
            methodResults // Include per-method results
        };
    }

    /**
     * Run OCR on an image using PlateRecognizer (CCT model)
     * @param {string} dataUrl - Image data URL
     * @param {Function} onProgress - Progress callback (status, progress 0-1)
     * @returns {Object} - { text, confidence }
     */
    async runOCR(dataUrl, onProgress = null) {
        // Use PlateRecognizer (CCT model trained on license plates) for better accuracy
        if (!window.plateRecognizer) {
            window.plateRecognizer = new PlateRecognizer();
        }

        const recognizer = window.plateRecognizer;

        // Load the model if needed
        if (!recognizer.isLoaded) {
            if (onProgress) onProgress('Loading plate OCR model...', null);
            const loaded = await recognizer.loadModel((progress) => {
                if (onProgress && progress.percent >= 0) {
                    onProgress(progress.status || 'Loading...', progress.percent / 100);
                }
            });
            if (!loaded) {
                console.warn('[PlateEnhancer] PlateRecognizer failed to load, falling back to Tesseract');
                return this.runOCRTesseract(dataUrl, onProgress);
            }
        }

        try {
            if (onProgress) onProgress('Recognizing plate...', 0.5);

            // Convert dataUrl to image
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = dataUrl;
            });

            // Use ensemble recognition for best results
            const result = await recognizer.recognizeEnsemble(img, {});

            console.log(`[PlateEnhancer] OCR result: "${result.text}" (confidence: ${result.confidence.toFixed(1)}%)`);

            return {
                text: result.text,
                confidence: result.confidence
            };
        } catch (error) {
            console.error('[PlateEnhancer] PlateRecognizer OCR failed:', error);
            // Fallback to Tesseract
            console.log('[PlateEnhancer] Falling back to Tesseract OCR...');
            return this.runOCRTesseract(dataUrl, onProgress);
        }
    }

    /**
     * Fallback OCR using Tesseract
     * @param {string} dataUrl - Image data URL
     * @param {Function} onProgress - Progress callback
     * @returns {Object} - { text, confidence }
     */
    async runOCRTesseract(dataUrl, onProgress = null) {
        if (!this.isTesseractLoaded) {
            if (onProgress) onProgress('Loading Tesseract...', null);
            const loaded = await this.loadTesseract();
            if (!loaded) {
                return { text: '', confidence: 0, error: 'Failed to load OCR library' };
            }
        }

        try {
            const result = await Tesseract.recognize(dataUrl, 'eng', {
                logger: m => {
                    if (onProgress && m.progress) {
                        onProgress('Analyzing text...', m.progress);
                    }
                }
            });

            const rawText = result.data.text.trim();
            const cleanedText = rawText.replace(/[^A-Z0-9\s-]/gi, '').trim();

            return {
                text: cleanedText,
                rawText: rawText,
                confidence: result.data.confidence
            };
        } catch (error) {
            console.error('[PlateEnhancer] Tesseract OCR failed:', error);
            return { text: '', confidence: 0, error: error.message };
        }
    }
}

// Create global instance
window.plateEnhancer = new PlateEnhancer();
