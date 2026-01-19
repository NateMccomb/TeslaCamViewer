/**
 * PlateEnhancer - Multi-frame license plate enhancement
 * Combines frames from multiple cameras and time points to enhance license plate readability
 */
class PlateEnhancer {
    constructor() {
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

        // Don't show for hidden cameras (hidden by layout manager)
        const container = e.currentTarget;
        if (container.classList.contains('camera-hidden')) {
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

            // Skip hidden cameras (hidden by layout manager)
            if (container.classList.contains('camera-hidden')) return;

            // Also check if container is actually visible (has dimensions)
            const rect = container.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;

            const cameraId = this.getCameraIdFromContainer(container);
            if (!cameraId) return;

            const overlay = document.createElement('div');
            overlay.className = 'plate-enhancer-overlay';
            overlay.dataset.camera = cameraId;

            // Add instruction on first (active) camera
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
                    <div class="instruction-keys">
                        <kbd>Enter</kbd> to continue &nbsp;•&nbsp; <kbd>Esc</kbd> to cancel
                    </div>
                `;
                overlay.appendChild(instruction);
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

        console.log('[PlateEnhancer] Cleared all selections and state');
    }

    /**
     * Confirm selection and show time range dialog
     */
    confirmSelection() {
        this.isSelecting = false;
        document.removeEventListener('keydown', this.handleKeyDown);

        // Check if we have IN/OUT points set (need clipMarking first for absolute time)
        const clipMarking = window.app?.clipMarking;
        const hasMarks = clipMarking && clipMarking.hasMarks();
        const marks = hasMarks ? clipMarking.getMarks() : null;

        // Store the reference time (where user drew the box)
        // Use videoPlayer.getCurrentAbsoluteTime() for accurate time that matches seekToEventTime()
        // This uses cached clip durations instead of 60-second approximations
        const vp = window.app?.videoPlayer;
        if (vp && vp.getCurrentAbsoluteTime) {
            this.referenceTime = vp.getCurrentAbsoluteTime();
        } else if (clipMarking) {
            // Fallback to clipMarking (uses 60s approximation - less accurate)
            this.referenceTime = clipMarking.getAbsoluteTime();
        } else {
            this.referenceTime = vp ? vp.getCurrentTime() : 0;
        }

        // Mark selections as confirmed
        this.overlays.forEach((overlay) => {
            const box = overlay.querySelector('.plate-enhancer-selection');
            if (box) box.classList.add('confirmed');
        });

        // Check if selection was made outside the IN/OUT range
        let selectionOutsideMarks = false;
        if (hasMarks && marks) {
            selectionOutsideMarks = this.referenceTime < marks.inPoint || this.referenceTime > marks.outPoint;
        }

        // Always show dialog for ML upscale option
        this.showTimeRangeDialog(marks, selectionOutsideMarks);
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

        const dialog = document.createElement('div');
        dialog.className = 'plate-enhancer-dialog';
        dialog.innerHTML = `
            <h3>🔍 Enhancement Options</h3>
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
            <div class="plate-enhancer-section">
                <div class="plate-enhancer-section-header">⚙️ Processing Options</div>
                <label class="plate-enhancer-checkbox-label">
                    <input type="checkbox" id="plate-enhancer-ml-upscale" />
                    <span>Enable super-resolution upscaling</span>
                </label>
                <p class="plate-enhancer-option-desc">Enlarges the result using AI - useful for small or distant plates</p>
                <div class="plate-enhancer-upscale-options" style="display: none;">
                    <span class="plate-enhancer-option-label">Scale factor:</span>
                    <div class="plate-enhancer-scale-btns">
                        <button class="plate-enhancer-scale-btn selected" data-scale="2">2x</button>
                        <button class="plate-enhancer-scale-btn" data-scale="3">3x</button>
                        <button class="plate-enhancer-scale-btn" data-scale="4">4x</button>
                    </div>
                </div>
            </div>
            <div class="plate-enhancer-dialog-actions">
                <button class="plate-enhancer-btn plate-enhancer-btn-secondary" data-action="cancel">Cancel</button>
                <button class="plate-enhancer-btn plate-enhancer-btn-primary" data-action="start">🚀 Start Enhancement</button>
            </div>
        `;

        let selectedSeconds = 5;
        let selectedScale = 2;

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

        // Handle upscale checkbox toggle
        const upscaleCheckbox = dialog.querySelector('#plate-enhancer-ml-upscale');
        const upscaleOptions = dialog.querySelector('.plate-enhancer-upscale-options');
        upscaleCheckbox.addEventListener('change', () => {
            upscaleOptions.style.display = upscaleCheckbox.checked ? 'flex' : 'none';
        });

        // Handle scale factor selection
        dialog.querySelectorAll('.plate-enhancer-scale-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                dialog.querySelectorAll('.plate-enhancer-scale-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selectedScale = parseInt(btn.dataset.scale);
            });
        });

        // Handle cancel
        dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => {
            backdrop.remove();
            dialog.remove();
            this.cancelSelection();
        });

        // Handle start
        dialog.querySelector('[data-action="start"]').addEventListener('click', () => {
            const enableMLUpscale = upscaleCheckbox.checked;
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
                const halfRange = selectedSeconds / 2;
                startTime = Math.max(0, this.referenceTime - halfRange);
                endTime = this.referenceTime + halfRange;
            }

            this.startProcessing(startTime, endTime, enableMLUpscale, selectedScale);
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
    }

    /**
     * Load OpenCV.js on demand
     */
    async loadOpenCV() {
        if (this.isOpenCVLoaded) return true;
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

            // Enable ML upscaling if requested
            if (enableMLUpscale) {
                stacker.enableMLUpscale(true, upscaleScale);
            }

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
            await new Promise(r => setTimeout(r, 50)); // Let UI update

            const enhanced = await stacker.process(results.regions, results.frames, (status, pct) => {
                updateProgress(status, 78 + pct * 0.2); // 78-98%
            }, videoEnhancements);

            if (this.shouldCancel) {
                throw new Error('Cancelled');
            }

            // Store enhanced result
            this.lastEnhanced = enhanced;

            updateProgress('Complete!', 100);

            // Clean up progress modal
            backdrop.remove();
            progress.remove();

            // Show results with re-processing options
            this.showResults(enhanced, true);

        } catch (error) {
            backdrop.remove();
            progress.remove();

            if (error.message !== 'Cancelled') {
                console.error('[PlateEnhancer] Processing error:', error);
                this.showError(`Enhancement failed: ${error.message}`);
            }
        } finally {
            this.isProcessing = false;
            this.selections.clear();
        }
    }

    /**
     * Extract frames and track region across time
     * Tracks from reference frame (where user drew box) both forward and backward
     */
    async extractAndTrack(startTime, endTime, updateProgress, tracker) {
        const fps = 30; // Extract at 30 fps to capture most frames

        // Get reference time (where user drew the selection box)
        // Clamp to be within the time range - user may have drawn selection outside IN/OUT marks
        let referenceTime = this.referenceTime || ((startTime + endTime) / 2);
        if (referenceTime < startTime) {
            console.log(`[PlateEnhancer] Reference time ${referenceTime.toFixed(2)}s is before start ${startTime.toFixed(2)}s, using start`);
            referenceTime = startTime;
        } else if (referenceTime > endTime) {
            console.log(`[PlateEnhancer] Reference time ${referenceTime.toFixed(2)}s is after end ${endTime.toFixed(2)}s, using end`);
            referenceTime = endTime;
        }

        const duration = endTime - startTime;
        const totalFramesPerCamera = Math.ceil(duration * fps);

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

            // Build frame list: forward from reference, then backward from reference
            const forwardFrames = [];
            const backwardFrames = [];
            let extractedCount = 0;

            // Forward frames (reference to end) - includes reference frame
            const forwardCount = Math.ceil((endTime - referenceTime) * fps);
            for (let i = 0; i <= forwardCount; i++) {
                if (this.shouldCancel) return { regions: [], frames: [] };
                const time = referenceTime + (i / fps);
                if (time > endTime) break;

                const frame = i === 0 ? refFrame : await this.extractFrame(video, time, cameraId);
                if (frame) {
                    forwardFrames.push({ imageData: frame, time, cameraId });
                }
                extractedCount++;

                // Update progress during extraction
                if (extractedCount % 10 === 0) {
                    const extractProgress = (extractedCount / totalFramesPerCamera) * 0.5;
                    updateProgress(`${cameraName}: Extracting frames (${extractedCount}/${totalFramesPerCamera})...`,
                        cameraBaseProgress + extractProgress * cameraProgressRange);
                }
            }

            // Backward frames: we need to start from reference and go backwards
            // So we include reference frame FIRST, then ref-1, ref-2, etc.
            // This way the tracker starts with the correct position
            backwardFrames.push({ imageData: refFrame, time: referenceTime, cameraId }); // Start with reference

            const backwardCount = Math.ceil((referenceTime - startTime) * fps);
            for (let i = 1; i <= backwardCount; i++) {
                if (this.shouldCancel) return { regions: [], frames: [] };
                const time = referenceTime - (i / fps);
                if (time < startTime) break;

                const frame = await this.extractFrame(video, time, cameraId);
                if (frame) {
                    backwardFrames.push({ imageData: frame, time, cameraId });
                }
                extractedCount++;

                // Update progress during extraction
                if (extractedCount % 10 === 0) {
                    const extractProgress = (extractedCount / totalFramesPerCamera) * 0.5;
                    updateProgress(`${cameraName}: Extracting frames (${extractedCount}/${totalFramesPerCamera})...`,
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

            // Crop tracked regions from frames
            let croppedCount = 0;
            for (let i = 0; i < allCameraFrames.length; i++) {
                const region = allTracked[i];
                if (region) {
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
                ctx.drawImage(currentVideo, 0, 0);

                return ctx.getImageData(0, 0, canvas.width, canvas.height);
            } catch (error) {
                console.error(`[PlateEnhancer] Seek error:`, error);
                return null;
            }
        }

        // Fallback: direct seek (only works within current clip)
        return new Promise((resolve) => {
            video.currentTime = time;

            const onSeeked = () => {
                video.removeEventListener('seeked', onSeeked);

                // Draw to canvas
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0);

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
     * Show results modal
     * @param {Object} enhanced - Enhanced results
     * @param {boolean} canReprocess - Whether re-processing is available
     */
    showResults(enhanced, canReprocess = false) {
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
        mainImg.src = enhanced.combined.dataUrl;
        mainPreview.appendChild(mainImg);

        const mainLabel = document.createElement('div');
        mainLabel.className = 'plate-enhancer-main-preview-label';
        mainLabel.textContent = 'Combined Result (click thumbnails below to compare)';
        mainPreview.appendChild(mainLabel);
        modal.appendChild(mainPreview);

        // OCR Section
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

        // Run OCR asynchronously
        this.runOCR(enhanced.combined.dataUrl, updateOCRProgress).then(result => {
            const statusEl = ocrSection.querySelector('.plate-enhancer-ocr-status');
            const textEl = ocrSection.querySelector('.plate-enhancer-ocr-text');
            const copyBtn = ocrSection.querySelector('.plate-enhancer-ocr-copy');

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

                // Copy OCR text
                copyBtn.addEventListener('click', async () => {
                    try {
                        await navigator.clipboard.writeText(result.text);
                        this.showToast('Text copied!');
                    } catch (e) {
                        console.error('Copy failed:', e);
                    }
                });
            } else {
                statusEl.textContent = 'No text detected';
                textEl.textContent = '-';
            }
        });

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
                    <button class="plate-enhancer-btn-small" data-action="select-all" title="Include all frames">✓ All</button>
                    <button class="plate-enhancer-btn-small" data-action="select-none" title="Deselect all frames">✗ None</button>
                    <button class="plate-enhancer-btn-small" data-action="select-top5" title="Select only the 5 sharpest">Top 5</button>
                    <span class="plate-enhancer-frame-count">0 / ${enhanced.topFrames.length} selected</span>
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

        // Add top frames with checkboxes if re-processing available
        enhanced.topFrames.forEach((frame, index) => {
            const thumb = this.createThumbnail(frame, `#${index + 1}`, frame.cameraId, false, canReprocess);
            thumb.dataset.frameIndex = index;
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
            const total = enhanced.topFrames.length;
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
                mainImg.src = thumb.dataset.src;
                mainLabel.textContent = thumb.dataset.label;
            }
        });

        // Actions
        const actions = document.createElement('div');
        actions.className = 'plate-enhancer-results-actions';
        actions.innerHTML = `
            <button class="plate-enhancer-btn plate-enhancer-btn-secondary" data-action="crop-region" title="Draw a region on the preview to crop">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                    <path d="M17 15h2V7c0-1.1-.9-2-2-2H9v2h8v8zM7 17V1H5v4H1v2h4v10c0 1.1.9 2 2 2h10v4h2v-4h4v-2H7z"/>
                </svg>
                Crop Region
            </button>
            <button class="plate-enhancer-btn plate-enhancer-btn-secondary" data-action="copy">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                    <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
                </svg>
                Copy
            </button>
            <button class="plate-enhancer-btn plate-enhancer-btn-secondary" data-action="download-all">Download All (ZIP)</button>
            <button class="plate-enhancer-btn plate-enhancer-btn-primary" data-action="download-selected">Download Selected</button>
        `;
        modal.appendChild(actions);

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

        // Handle copy to clipboard
        actions.querySelector('[data-action="copy"]').addEventListener('click', async () => {
            const selected = thumbsContainer.querySelector('.plate-enhancer-thumbnail.selected');
            if (selected) {
                await this.copyToClipboard(selected.dataset.src);
            }
        });

        // Handle downloads
        actions.querySelector('[data-action="download-selected"]').addEventListener('click', () => {
            const selected = thumbsContainer.querySelector('.plate-enhancer-thumbnail.selected');
            if (selected) {
                this.downloadImage(selected.dataset.src, 'enhanced-plate.png');
            }
        });

        actions.querySelector('[data-action="download-all"]').addEventListener('click', async () => {
            await this.downloadAllAsZip(enhanced);
        });

        document.body.appendChild(backdrop);
        document.body.appendChild(modal);
    }

    /**
     * Create thumbnail element
     * @param {Object} frame - Frame data with dataUrl
     * @param {string} rank - Rank label
     * @param {string} cameraLabel - Camera identifier
     * @param {boolean} isCombined - Whether this is a combined/processed result
     * @param {boolean} showCheckbox - Whether to show selection checkbox
     */
    createThumbnail(frame, rank, cameraLabel, isCombined = false, showCheckbox = false) {
        const thumb = document.createElement('div');
        thumb.className = 'plate-enhancer-thumbnail';
        if (showCheckbox) thumb.classList.add('selectable');
        thumb.dataset.src = frame.dataUrl;
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
        img.src = frame.dataUrl;
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
        if (!this.lastExtraction || !this.lastEnhanced) {
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

            // Get only selected frames from the topFrames (which were the ranked frames)
            const selectedFrameData = selectedIndices.map(i => this.lastEnhanced.topFrames[i]);

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
                stacker.enableMLUpscale(true, settings.upscaleScale);
            }

            updateProgress('Processing selected frames...', 20);
            await new Promise(r => setTimeout(r, 50));

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
            this.showResults(enhanced, true);

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
                stacker.enableMLUpscale(true, settings.upscaleScale);
            }

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
            this.showResults(newEnhanced, true);

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
     * Download single image
     */
    downloadImage(dataUrl, filename) {
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    /**
     * Copy image to clipboard
     */
    async copyToClipboard(dataUrl) {
        try {
            // Convert data URL to blob
            const response = await fetch(dataUrl);
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
     * Download all results as ZIP
     */
    async downloadAllAsZip(enhanced) {
        if (typeof JSZip === 'undefined') {
            this.showError('ZIP library not available');
            return;
        }

        const zip = new JSZip();
        const folder = zip.folder('enhanced-plates');

        // Add combined result
        const combinedData = enhanced.combined.dataUrl.split(',')[1];
        folder.file('00-combined.png', combinedData, { base64: true });

        // Add upscaled version if available
        if (enhanced.upscaled) {
            const upscaledData = enhanced.upscaled.dataUrl.split(',')[1];
            folder.file('00-combined-2x-upscaled.png', upscaledData, { base64: true });
        }

        // Add top frames
        enhanced.topFrames.forEach((frame, index) => {
            const data = frame.dataUrl.split(',')[1];
            const camera = frame.cameraId.replace('_', '-');
            folder.file(`${String(index + 1).padStart(2, '0')}-${camera}.png`, data, { base64: true });
        });

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
        return {
            brightness: enhancer.settings.brightness || 100,
            contrast: enhancer.settings.contrast || 100,
            saturation: enhancer.settings.saturation || 100
        };
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
     * Run OCR on an image
     * @param {string} dataUrl - Image data URL
     * @param {Function} onProgress - Progress callback (status, progress 0-1)
     * @returns {Object} - { text, confidence }
     */
    async runOCR(dataUrl, onProgress = null) {
        if (!this.isTesseractLoaded) {
            if (onProgress) onProgress('Loading OCR library...', null);
            const loaded = await this.loadTesseract();
            if (!loaded) {
                return { text: '', confidence: 0, error: 'Failed to load OCR library' };
            }
        }

        try {
            console.log('[PlateEnhancer] Running OCR...');

            // Use Tesseract.recognize for simple one-shot recognition
            const result = await Tesseract.recognize(dataUrl, 'eng', {
                logger: m => {
                    console.log(`[PlateEnhancer] OCR: ${m.status} ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`);

                    if (onProgress) {
                        // Map Tesseract status to user-friendly messages
                        let statusText = 'Processing...';
                        let progress = m.progress;

                        switch (m.status) {
                            case 'loading tesseract core':
                                statusText = 'Loading OCR engine...';
                                break;
                            case 'initializing tesseract':
                                statusText = 'Initializing...';
                                progress = null;
                                break;
                            case 'loading language traineddata':
                                statusText = 'Downloading language model (~15MB)...';
                                break;
                            case 'initializing api':
                                statusText = 'Preparing...';
                                progress = null;
                                break;
                            case 'recognizing text':
                                statusText = 'Analyzing text...';
                                break;
                        }

                        onProgress(statusText, progress);
                    }
                }
            });

            // Clean up the text (license plates are usually alphanumeric)
            const rawText = result.data.text.trim();
            const cleanedText = rawText.replace(/[^A-Z0-9\s-]/gi, '').trim();

            console.log(`[PlateEnhancer] OCR result: "${cleanedText}" (confidence: ${result.data.confidence.toFixed(1)}%)`);

            return {
                text: cleanedText,
                rawText: rawText,
                confidence: result.data.confidence
            };
        } catch (error) {
            console.error('[PlateEnhancer] OCR failed:', error);
            return { text: '', confidence: 0, error: error.message };
        }
    }
}

// Create global instance
window.plateEnhancer = new PlateEnhancer();
