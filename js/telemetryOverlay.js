/**
 * Telemetry Overlay Component for TeslaCamViewer
 * Displays real-time vehicle telemetry data from Tesla SEI metadata
 *
 * Features:
 * - Three display styles: Cockpit HUD, Tesla-native pill, Minimal corner
 * - Draggable positioning with per-layout persistence
 * - Works in both DOM mode (live playback) and Canvas mode (export)
 * - Animated steering wheel, turn signals, and pedal indicators
 */

class TelemetryOverlay {
    constructor(videoPlayer) {
        this.videoPlayer = videoPlayer;
        this.container = null;
        this.isVisible = false;
        this.isDragging = false;
        this.currentStyle = 'cockpit'; // 'cockpit', 'tesla', 'minimal'
        this.units = 'mph'; // 'mph' or 'kph'

        // Position (percentage-based for resolution independence)
        this.position = { x: 50, y: 50 }; // Percentage from top-left - centered by default
        this.currentScale = 1; // Current display scale (updated on resize)

        // Per-layout positions storage key
        this.STORAGE_KEY = 'teslacamviewer_telemetry_positions';

        // Current telemetry data
        this.currentData = null;
        this.lastValidData = null; // Keep last valid data to prevent flickering

        // G-force trace history (for trail effect)
        this.gForceHistory = [];
        this.maxGForceHistory = 60; // Keep last 60 samples (balance between trail length and performance)

        // G-meter auto-zoom settings
        this.gMeterScale = 0.5; // Current max G shown (auto-adjusts)
        this.gMeterScaleMin = 0.25; // Minimum scale (most zoomed in)
        this.gMeterScaleMax = 2.0; // Maximum scale (most zoomed out)
        this.gMeterScaleTarget = 0.5; // Target scale (smoothly transitions)
        this.gMeterScaleSpeed = 0.05; // How fast to transition scales

        // Animation state
        this.animationFrame = null;
        this.blinkState = false;
        this.lastBlinkTime = 0;
        this.BLINK_INTERVAL = 500; // ms


        // SEI data cache per clip
        this.clipSeiData = new Map();

        // Cache for actual video durations (captured during live playback)
        this.clipVideoDurations = new Map();

        // Export pre-buffer (for smooth export without live lookups)
        this.exportBuffer = null;
        this.exportStartTime = 0;
        this.exportFps = 30;
        this.exportFrameInterval = 1 / 30;

        // Bind methods
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onTouchStart = this._onTouchStart.bind(this);
        this._onTouchMove = this._onTouchMove.bind(this);
        this._onTouchEnd = this._onTouchEnd.bind(this);
        this._updateLoop = this._updateLoop.bind(this);

        this._init();
    }

    _init() {
        this._createContainer();
        this._loadPositions();
        this._attachEventListeners();
    }

    /**
     * Get the current theme's accent color from CSS variables
     * Falls back to default teal if not available
     */
    _getAccentColor() {
        const computedStyle = getComputedStyle(document.body);
        return computedStyle.getPropertyValue('--accent').trim() || '#00d4ff';
    }

    _createContainer() {
        // Create main overlay container
        this.container = document.createElement('div');
        this.container.className = 'telemetry-overlay';
        this.container.style.cssText = `
            position: absolute;
            z-index: 1000;
            cursor: move;
            user-select: none;
            touch-action: none;
            transition: opacity 0.2s ease;
        `;

        // Create inner content area
        this.content = document.createElement('div');
        this.content.className = 'telemetry-content';
        this.container.appendChild(this.content);

        // Add close button
        this.closeBtn = document.createElement('button');
        this.closeBtn.className = 'telemetry-close-btn';
        this.closeBtn.innerHTML = '×';
        this.closeBtn.style.cssText = `
            position: absolute;
            top: 4px;
            right: 4px;
            width: 20px;
            height: 20px;
            border: none;
            background: rgba(255, 255, 255, 0.1);
            color: rgba(255, 255, 255, 0.6);
            border-radius: 50%;
            cursor: pointer;
            font-size: 14px;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s ease;
        `;
        this.closeBtn.onclick = () => this.hide();
        this.container.appendChild(this.closeBtn);

        // Inject CSS for hover-based close button visibility (more reliable than JS events)
        if (!document.getElementById('telemetry-hover-styles')) {
            const style = document.createElement('style');
            style.id = 'telemetry-hover-styles';
            style.textContent = `
                .telemetry-overlay:hover .telemetry-close-btn {
                    opacity: 1 !important;
                    pointer-events: auto !important;
                }
            `;
            document.head.appendChild(style);
        }

        // Right-click context menu for reset
        this._createContextMenu();
        this.container.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this._showContextMenu(e.clientX, e.clientY);
        });

        // Initially hidden
        this.container.style.display = 'none';
    }

    _createContextMenu() {
        this.contextMenu = document.createElement('div');
        this.contextMenu.className = 'telemetry-context-menu';
        this.contextMenu.style.cssText = `
            position: fixed;
            z-index: 10001;
            background: rgba(40, 40, 40, 0.95);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 6px;
            padding: 4px 0;
            min-width: 140px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
            display: none;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
        `;

        // Reset position option
        const resetOption = document.createElement('div');
        resetOption.textContent = 'Reset Position';
        resetOption.style.cssText = `
            padding: 8px 12px;
            cursor: pointer;
            color: rgba(255, 255, 255, 0.9);
            transition: background 0.15s ease;
        `;
        resetOption.addEventListener('mouseenter', () => {
            resetOption.style.background = 'rgba(255, 255, 255, 0.1)';
        });
        resetOption.addEventListener('mouseleave', () => {
            resetOption.style.background = 'transparent';
        });
        resetOption.addEventListener('click', () => {
            this._resetPosition();
            this._hideContextMenu();
        });
        this.contextMenu.appendChild(resetOption);

        document.body.appendChild(this.contextMenu);

        // Hide context menu when clicking elsewhere
        document.addEventListener('click', (e) => {
            if (!this.contextMenu.contains(e.target)) {
                this._hideContextMenu();
            }
        });
        document.addEventListener('contextmenu', (e) => {
            if (!this.container.contains(e.target)) {
                this._hideContextMenu();
            }
        });
    }

    _showContextMenu(x, y) {
        // Position the menu, keeping it within viewport
        const menuRect = this.contextMenu.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let menuX = x;
        let menuY = y;

        // Adjust if menu would go off-screen
        if (x + 150 > viewportWidth) {
            menuX = viewportWidth - 150;
        }
        if (y + 50 > viewportHeight) {
            menuY = viewportHeight - 50;
        }

        this.contextMenu.style.left = menuX + 'px';
        this.contextMenu.style.top = menuY + 'px';
        this.contextMenu.style.display = 'block';
    }

    _hideContextMenu() {
        if (this.contextMenu) {
            this.contextMenu.style.display = 'none';
        }
    }

    _resetPosition() {
        this.position.x = 50;
        this.position.y = 50;
        this._applyPosition();
        this._savePosition();
        console.log(`[TelemetryOverlay] Position reset to center`);
    }

    _attachEventListeners() {
        // Mouse events for dragging
        this.container.addEventListener('mousedown', this._onMouseDown);
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);

        // Touch events for mobile
        this.container.addEventListener('touchstart', this._onTouchStart, { passive: false });
        document.addEventListener('touchmove', this._onTouchMove, { passive: false });
        document.addEventListener('touchend', this._onTouchEnd);

        // Layout callback will be set up by initLayoutCallback() after app initialization

        // Update scale on window resize
        window.addEventListener('resize', () => {
            if (this.isVisible) {
                this._updateScale();
            }
        });
    }

    /**
     * Initialize layout change callback
     * Must be called after app is fully initialized so layoutManager is accessible
     * @param {LayoutManager} layoutManager - The layout manager instance
     */
    initLayoutCallback(layoutManager) {
        if (!layoutManager) {
            console.warn('TelemetryOverlay: No layoutManager provided for callback');
            return;
        }

        // Store reference for later use (e.g., in _savePosition)
        this._layoutManager = layoutManager;

        // Initialize current layout ID
        this._currentLayoutId = layoutManager.getCurrentLayoutId() || 'default';
        console.log(`[TelemetryOverlay] Initialized with layout: ${this._currentLayoutId}`);

        // Load position for current layout
        const saved = this.savedPositions[this._currentLayoutId];
        if (saved) {
            this.position.x = saved.x;
            this.position.y = saved.y;
            console.log(`[TelemetryOverlay] Loaded initial position for ${this._currentLayoutId}: (${saved.x.toFixed(1)}, ${saved.y.toFixed(1)})`);
        }

        // Set up callback for layout changes
        layoutManager.onLayoutChange = (layoutId) => {
            console.log(`[TelemetryOverlay] Layout change callback triggered: ${layoutId}`);
            this._loadPositionForLayout(layoutId);
        };
    }

    // ==================== DRAGGING ====================

    _onMouseDown(e) {
        if (e.target === this.closeBtn) return;
        this.isDragging = true;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.dragStartPosX = this.position.x;
        this.dragStartPosY = this.position.y;
        this.container.style.cursor = 'grabbing';
        e.preventDefault();
    }

    _onMouseMove(e) {
        if (!this.isDragging) return;
        this._updateDragPosition(e.clientX, e.clientY);
    }

    _onMouseUp() {
        if (this.isDragging) {
            this.isDragging = false;
            this.container.style.cursor = 'move';
            this._savePosition();
        }
    }

    _onTouchStart(e) {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        this.isDragging = true;
        this.dragStartX = touch.clientX;
        this.dragStartY = touch.clientY;
        this.dragStartPosX = this.position.x;
        this.dragStartPosY = this.position.y;
        e.preventDefault();
    }

    _onTouchMove(e) {
        if (!this.isDragging || e.touches.length !== 1) return;
        const touch = e.touches[0];
        this._updateDragPosition(touch.clientX, touch.clientY);
        e.preventDefault();
    }

    _onTouchEnd() {
        if (this.isDragging) {
            this.isDragging = false;
            this._savePosition();
        }
    }

    _updateDragPosition(clientX, clientY) {
        const parent = this.container.parentElement;
        if (!parent) return;

        const rect = parent.getBoundingClientRect();
        const deltaX = clientX - this.dragStartX;
        const deltaY = clientY - this.dragStartY;

        // Convert pixel delta to percentage
        const deltaXPercent = (deltaX / rect.width) * 100;
        const deltaYPercent = (deltaY / rect.height) * 100;

        // Calculate new position
        let newX = this.dragStartPosX + deltaXPercent;
        let newY = this.dragStartPosY + deltaYPercent;

        // Constrain to bounds (0-95% to keep overlay visible)
        newX = Math.max(0, Math.min(95, newX));
        newY = Math.max(0, Math.min(95, newY));

        this.position.x = newX;
        this.position.y = newY;
        this._applyPosition();
    }

    _applyPosition() {
        this.container.style.left = `${this.position.x}%`;
        this.container.style.top = `${this.position.y}%`;
        // Apply both centering and scale in one transform
        this._applyTransform();
    }

    _updateScale() {
        // Just re-apply the transform (scale is calculated inside)
        this._applyTransform();
    }

    _applyTransform() {
        // Calculate scale based on parent container size
        // Base size assumes ~1200px width parent, scale proportionally
        const parent = this.container.parentElement;
        if (parent) {
            const rect = parent.getBoundingClientRect();
            const baseWidth = 1200;
            this.currentScale = Math.max(0.5, Math.min(1.5, rect.width / baseWidth));
        } else {
            this.currentScale = 1;
        }
        // Apply both translate (for centering) and scale together
        this.container.style.transform = `translate(-50%, -50%) scale(${this.currentScale})`;
        this.container.style.transformOrigin = 'center center';
    }

    // ==================== POSITION PERSISTENCE ====================

    _loadPositions() {
        try {
            const saved = localStorage.getItem(this.STORAGE_KEY);
            this.savedPositions = saved ? JSON.parse(saved) : {};
        } catch (e) {
            this.savedPositions = {};
        }
    }

    _loadPositionForLayout(layoutId) {
        console.log(`[TelemetryOverlay] Layout change: ${this._currentLayoutId} -> ${layoutId}`);
        console.log(`[TelemetryOverlay] Current position: (${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)})`);
        console.log(`[TelemetryOverlay] Saved positions:`, JSON.stringify(this.savedPositions));

        // Save current position for the OLD layout before loading new layout's position
        if (this._currentLayoutId && this._currentLayoutId !== layoutId) {
            // Save position for the layout we're leaving
            this.savedPositions[this._currentLayoutId] = {
                x: this.position.x,
                y: this.position.y
            };
            console.log(`[TelemetryOverlay] Saved position for ${this._currentLayoutId}: (${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)})`);
            try {
                localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.savedPositions));
            } catch (e) {
                console.warn('TelemetryOverlay: Failed to save position', e);
            }
        }

        // Update current layout ID
        this._currentLayoutId = layoutId;

        // Load saved position for new layout, or use default center position
        const saved = this.savedPositions[layoutId];
        if (saved) {
            this.position.x = saved.x;
            this.position.y = saved.y;
            console.log(`[TelemetryOverlay] Loaded saved position for ${layoutId}: (${saved.x.toFixed(1)}, ${saved.y.toFixed(1)})`);
        } else {
            // Default to center if no saved position for this layout
            this.position.x = 50;
            this.position.y = 50;
            console.log(`[TelemetryOverlay] No saved position for ${layoutId}, using default center`);
        }

        // Note: style is NOT loaded per-layout - it comes from global settings only
        this._applyPosition();
        this._render();
    }

    _savePosition() {
        const layoutId = this._layoutManager?.getCurrentLayoutId() || this._currentLayoutId || 'default';
        this.savedPositions[layoutId] = {
            x: this.position.x,
            y: this.position.y
            // Note: style is NOT saved per-layout - it's controlled by global settings only
        };
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.savedPositions));
        } catch (e) {
            console.warn('TelemetryOverlay: Failed to save position', e);
        }
    }

    // ==================== PUBLIC API ====================

    /**
     * Show the overlay
     */
    show() {
        if (!this.container.parentElement) {
            const videoGrid = document.querySelector('.video-grid');
            if (videoGrid) {
                videoGrid.appendChild(this.container);
            } else {
                document.body.appendChild(this.container);
            }
        }

        this.container.style.display = 'block';
        this.isVisible = true;

        this._applyPosition();
        this._updateScale();
        this._startUpdateLoop();

        // Notify visibility change
        if (this.onVisibilityChange) {
            this.onVisibilityChange(true);
        }
    }

    /**
     * Hide the overlay
     */
    hide() {
        this.container.style.display = 'none';
        this.isVisible = false;
        this._stopUpdateLoop();

        // Notify visibility change
        if (this.onVisibilityChange) {
            this.onVisibilityChange(false);
        }
    }

    /**
     * Toggle visibility
     */
    toggle() {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }

    /**
     * Set display style
     * @param {string} style - 'cockpit', 'tesla', or 'minimal'
     */
    setStyle(style) {
        if (['cockpit', 'tesla', 'minimal'].includes(style)) {
            this.currentStyle = style;
            this._render();
            this._savePosition();
        }
    }

    /**
     * Get current style
     */
    getStyle() {
        return this.currentStyle;
    }

    /**
     * Set speed units
     * @param {string} units - 'mph' or 'kph'
     */
    setUnits(units) {
        if (['mph', 'kph'].includes(units)) {
            this.units = units;
            this._render();
        }
    }

    /**
     * Set position (percentage)
     */
    setPosition(x, y) {
        this.position.x = Math.max(0, Math.min(95, x));
        this.position.y = Math.max(0, Math.min(95, y));
        this._applyPosition();
        this._savePosition();
    }

    /**
     * Get current position
     */
    getPosition() {
        return { ...this.position };
    }

    /**
     * Check if telemetry data is available for current clip
     */
    hasTelemetryData() {
        // Check both live playback data and cached clip data
        return this.currentData !== null || (this.clipSeiData && this.clipSeiData.size > 0);
    }

    /**
     * Get current telemetry data
     */
    getCurrentTelemetry() {
        return this.currentData;
    }

    // ==================== EXPORT PRE-BUFFERING ====================

    /**
     * Pre-buffer AND pre-render telemetry frames for export
     * This eliminates all canvas drawing during export - just drawImage() calls
     * @param {Object} videoPlayer - Video player instance
     * @param {number} startTime - Export start time (absolute event time)
     * @param {number} endTime - Export end time (absolute event time)
     * @param {number} fps - Export frame rate (default 30)
     * @param {number} canvasWidth - Export canvas width (for scaling)
     * @param {number} canvasHeight - Export canvas height (for scaling)
     * @returns {boolean} True if buffering succeeded
     */
    prepareForExport(videoPlayer, startTime, endTime, fps = 30, canvasWidth = 1920, canvasHeight = 1080) {
        console.log(`[TelemetryOverlay] Pre-rendering for export: ${startTime.toFixed(2)}s to ${endTime.toFixed(2)}s at ${fps}fps`);

        this.exportBuffer = [];
        this.exportRenderedFrames = [];
        this.exportStartTime = startTime;
        this.exportFps = fps;
        this.exportFrameInterval = 1 / fps;
        this.exportCanvasWidth = canvasWidth;
        this.exportCanvasHeight = canvasHeight;

        const duration = endTime - startTime;
        const totalFrames = Math.ceil(duration * fps);

        // Get clip groups from video player
        const clipGroups = videoPlayer.currentEvent?.clipGroups;
        if (!clipGroups || clipGroups.length === 0) {
            console.warn('[TelemetryOverlay] No clip groups available for pre-buffering');
            return false;
        }

        // Build cumulative duration array for clip lookup
        // Priority: 1) Cached video durations (from live playback), 2) Fallback to 60s estimate
        const clipDurations = [];
        const clipStartTimes = [0];
        let cumulativeTime = 0;

        // Use cached video durations if available (these are the ACTUAL durations from video elements)
        // These match what the timeline/video player uses, ensuring correct timing
        const hasCachedDurations = this.clipVideoDurations.size > 0;
        console.log(`[TelemetryOverlay] Cached video durations available: ${hasCachedDurations} (${this.clipVideoDurations.size} clips)`);

        for (let i = 0; i < clipGroups.length; i++) {
            let duration;

            if (this.clipVideoDurations.has(i)) {
                // Use actual video duration from live playback
                duration = this.clipVideoDurations.get(i);
            } else {
                // Fallback: estimate 60 seconds (typical Tesla clip length)
                duration = 60;
            }

            clipDurations.push(duration);
            cumulativeTime += duration;
            clipStartTimes.push(cumulativeTime);
        }

        console.log(`[TelemetryOverlay] Clip durations:`, clipDurations.map(d => d.toFixed(1)).join(', '));

        // Calculate overlay dimensions for pre-rendering
        const baseWidth = 1200;
        const scale = Math.max(0.8, Math.min(2.0, canvasWidth / baseWidth));
        const overlayWidth = Math.ceil((this.currentStyle === 'cockpit' ? 280 : (this.currentStyle === 'tesla' ? 230 : 150)) * scale);
        const overlayHeight = Math.ceil((this.currentStyle === 'cockpit' ? 130 : (this.currentStyle === 'tesla' ? 44 : 30)) * scale);

        // Create offscreen canvas for pre-rendering
        const offscreen = document.createElement('canvas');
        offscreen.width = overlayWidth;
        offscreen.height = overlayHeight;
        const offCtx = offscreen.getContext('2d');

        // Store scale and dimensions for export
        this.exportScale = scale;
        this.exportOverlayWidth = overlayWidth;
        this.exportOverlayHeight = overlayHeight;

        // Pre-compute and pre-render each frame
        let lastDataHash = null;
        let lastRenderedImage = null;

        // Debug: log clip info
        console.log(`[TelemetryOverlay] Export range: ${startTime.toFixed(2)}s - ${endTime.toFixed(2)}s`);
        console.log(`[TelemetryOverlay] clipDurations (${clipDurations.length}):`, clipDurations.map(d => d.toFixed(1)).join(', '));
        console.log(`[TelemetryOverlay] clipStartTimes (${clipStartTimes.length}):`, clipStartTimes.map(t => t.toFixed(1)).join(', '));
        console.log(`[TelemetryOverlay] SEI cache keys:`, Array.from(this.clipSeiData.keys()).join(', '));

        for (let frame = 0; frame < totalFrames; frame++) {
            const absoluteTime = startTime + (frame * this.exportFrameInterval);

            // Find which clip this time falls into
            // Note: clipStartTimes has n+1 elements (includes end time of last clip),
            // so limit clipIndex to be within clipDurations bounds
            let clipIndex = 0;
            let timeInClip = absoluteTime;

            for (let i = 0; i < clipStartTimes.length; i++) {
                if (absoluteTime >= clipStartTimes[i] && i < clipDurations.length) {
                    clipIndex = i;
                    timeInClip = absoluteTime - clipStartTimes[i];
                }
            }

            // Get telemetry data for this clip/time
            const cacheKey = Array.from(this.clipSeiData.keys()).find(k => k.startsWith(`${clipIndex}_`));
            const clipData = cacheKey ? this.clipSeiData.get(cacheKey) : null;

            let frameData = null;
            if (clipData && clipData.frames && clipData.frames.length > 0) {
                const clipDuration = clipDurations[clipIndex] || 60;
                const progress = Math.min(timeInClip / clipDuration, 1);
                const frameIndex = Math.floor(progress * (clipData.frames.length - 1));
                frameData = clipData.frames[Math.max(0, Math.min(frameIndex, clipData.frames.length - 1))];

                // Debug: log first few frames and whenever values change significantly
                if (frame < 5 || frame % 300 === 0) {
                    console.log(`[TelemetryOverlay] Frame ${frame}: time=${absoluteTime.toFixed(2)}s, clip=${clipIndex}, timeInClip=${timeInClip.toFixed(2)}s, frameIdx=${frameIndex}/${clipData.frames.length}, speed=${frameData?.speed_mph?.toFixed(1)}, brake=${frameData?.brake_applied}, AP=${frameData?.autopilot_name}, leftBlink=${frameData?.blinker_on_left}, rightBlink=${frameData?.blinker_on_right}`);
                }
            }

            this.exportBuffer.push(frameData);

            // Create a hash of the data to detect changes (avoid re-rendering identical frames)
            // Include ALL fields that affect rendering: speed, gear, steering, pedals, brake, g-forces, blinkers, autopilot, and blink state
            const blinkState = frame % 30 < 15 ? 1 : 0; // Must match the blink state used in rendering
            const dataHash = frameData ? `${Math.round(frameData.speed_mph)}_${frameData.gear_name}_${Math.round(frameData.steering_wheel_angle || 0)}_${Math.round((frameData.accelerator_pedal_position || 0) * 100)}_${frameData.brake_applied}_${Math.round((frameData.g_force_x || 0) * 100)}_${Math.round((frameData.g_force_y || 0) * 100)}_${frameData.blinker_on_left}_${frameData.blinker_on_right}_${frameData.autopilot_name || 'NONE'}_${blinkState}` : null;

            // Reuse last rendered image if data hasn't changed significantly
            if (dataHash === lastDataHash && lastRenderedImage) {
                this.exportRenderedFrames.push(lastRenderedImage);
            } else if (frameData) {
                // Clear and render to offscreen canvas
                offCtx.clearRect(0, 0, overlayWidth, overlayHeight);
                offCtx.save();
                offCtx.scale(scale, scale);

                // Use blinkState from hash calculation (already defined above)
                const blink = blinkState === 1; // Convert 1/0 to true/false for rendering
                switch (this.currentStyle) {
                    case 'cockpit':
                        this._renderCockpitToCanvas(offCtx, 0, 0, frameData, this.units, blink);
                        break;
                    case 'tesla':
                        this._renderTeslaToCanvas(offCtx, 0, 0, frameData, this.units, blink);
                        break;
                    case 'minimal':
                        this._renderMinimalToCanvas(offCtx, 0, 0, frameData, this.units);
                        break;
                }
                offCtx.restore();

                // Store as ImageData (lightweight copy)
                const imageData = offCtx.getImageData(0, 0, overlayWidth, overlayHeight);
                this.exportRenderedFrames.push(imageData);
                lastRenderedImage = imageData;
                lastDataHash = dataHash;
            } else {
                this.exportRenderedFrames.push(null);
            }
        }

        const nonNullFrames = this.exportRenderedFrames.filter(f => f !== null).length;
        console.log(`[TelemetryOverlay] Pre-rendered ${this.exportRenderedFrames.length} frames (${nonNullFrames} with data, ${this.exportRenderedFrames.length - nonNullFrames} null) (${overlayWidth}x${overlayHeight} @ ${scale.toFixed(2)}x scale)`);
        return nonNullFrames > 0;
    }

    /**
     * Get pre-buffered telemetry for export frame
     * @param {number} absoluteTime - Absolute event time
     * @returns {Object|null} Telemetry data for this time
     */
    getExportTelemetry(absoluteTime) {
        if (!this.exportBuffer || this.exportBuffer.length === 0) {
            return this.currentData; // Fallback to live data
        }

        const frameIndex = Math.floor((absoluteTime - this.exportStartTime) * this.exportFps);
        const clampedIndex = Math.max(0, Math.min(frameIndex, this.exportBuffer.length - 1));
        return this.exportBuffer[clampedIndex] || null;
    }

    /**
     * Get pre-rendered overlay image for export frame
     * @param {number} absoluteTime - Absolute event time
     * @returns {ImageData|null} Pre-rendered overlay image
     */
    getPreRenderedFrame(absoluteTime) {
        if (!this.exportRenderedFrames || this.exportRenderedFrames.length === 0) {
            return null;
        }

        const frameIndex = Math.floor((absoluteTime - this.exportStartTime) * this.exportFps);
        const clampedIndex = Math.max(0, Math.min(frameIndex, this.exportRenderedFrames.length - 1));
        return this.exportRenderedFrames[clampedIndex] || null;
    }

    /**
     * Render pre-rendered frame to canvas (fast path for export)
     * Uses ImageBitmap for fastest possible GPU-accelerated drawing
     * @param {CanvasRenderingContext2D} ctx - Target canvas context
     * @param {number} canvasWidth - Canvas width
     * @param {number} canvasHeight - Canvas height
     * @param {number} absoluteTime - Current time for frame lookup
     */
    renderPreRenderedToCanvas(ctx, canvasWidth, canvasHeight, absoluteTime) {
        const frameIndex = Math.floor((absoluteTime - this.exportStartTime) * this.exportFps);
        const clampedIndex = Math.max(0, Math.min(frameIndex, this.exportRenderedFrames.length - 1));

        // Skip if same frame as last render (no change)
        if (clampedIndex === this._lastExportFrameIndex) {
            // Just redraw the cached bitmap at same position
            if (this._lastExportBitmap) {
                ctx.drawImage(this._lastExportBitmap, this._lastExportX, this._lastExportY);
            }
            return;
        }

        const imageData = this.exportRenderedFrames[clampedIndex];
        if (!imageData) return;

        // Calculate position (center of overlay at percentage position)
        const x = Math.round((this.position.x / 100) * canvasWidth - this.exportOverlayWidth / 2);
        const y = Math.round((this.position.y / 100) * canvasHeight - this.exportOverlayHeight / 2);

        // Use cached temp canvas (create once, reuse)
        if (!this._exportTempCanvas || this._exportTempCanvas.width !== this.exportOverlayWidth) {
            this._exportTempCanvas = document.createElement('canvas');
            this._exportTempCanvas.width = this.exportOverlayWidth;
            this._exportTempCanvas.height = this.exportOverlayHeight;
            this._exportTempCtx = this._exportTempCanvas.getContext('2d', { alpha: true });
        }

        // Put image data and draw
        this._exportTempCtx.putImageData(imageData, 0, 0);
        ctx.drawImage(this._exportTempCanvas, x, y);

        // Cache for next frame
        this._lastExportFrameIndex = clampedIndex;
        this._lastExportBitmap = this._exportTempCanvas;
        this._lastExportX = x;
        this._lastExportY = y;
    }

    /**
     * Check if pre-rendered frames are available
     */
    hasPreRenderedFrames() {
        return this.exportRenderedFrames && this.exportRenderedFrames.some(f => f !== null);
    }

    /**
     * Clear export buffer (call after export completes)
     */
    clearExportBuffer() {
        this.exportBuffer = null;
        this.exportRenderedFrames = null;
        this._exportTempCanvas = null;
        this._exportTempCtx = null;
        this._lastExportFrameIndex = -1;
        this._lastExportBitmap = null;
        this._lastExportX = 0;
        this._lastExportY = 0;
        this.exportStartTime = 0;
        this.exportFps = 30;
        console.log('[TelemetryOverlay] Export buffer cleared');
    }

    /**
     * Load SEI data for a clip file
     */
    async loadClipData(file, clipIndex) {
        if (!window.seiExtractor) {
            console.warn('TelemetryOverlay: SEI extractor not available');
            return null;
        }

        const cacheKey = `${clipIndex}_${file.name}`;
        if (this.clipSeiData.has(cacheKey)) {
            return this.clipSeiData.get(cacheKey);
        }

        try {
            const data = await window.seiExtractor.extractFromFile(file);
            this.clipSeiData.set(cacheKey, data);
            return data;
        } catch (error) {
            console.error('TelemetryOverlay: Failed to load SEI data', error);
            return null;
        }
    }

    /**
     * Reset all telemetry data (call when switching events)
     */
    reset() {
        this.currentData = null;
        this.lastValidData = null;
        this.clipSeiData.clear();
        this.clipVideoDurations.clear();
    }

    /**
     * Get all GPS points from loaded telemetry data
     * Used for elevation profile generation
     * @returns {Array<{lat: number, lng: number, time: number}>} GPS points with event time
     */
    getAllGpsPoints() {
        const points = [];
        const clipDuration = 60; // Approximate clip duration in seconds

        // Get sorted clip indices
        const clipKeys = Array.from(this.clipSeiData.keys()).sort((a, b) => {
            const indexA = parseInt(a.split('_')[0]);
            const indexB = parseInt(b.split('_')[0]);
            return indexA - indexB;
        });

        for (const key of clipKeys) {
            const clipIndex = parseInt(key.split('_')[0]);
            const data = this.clipSeiData.get(key);

            if (!data || !data.frames || data.frames.length === 0) continue;

            // Get actual clip duration if available
            const actualDuration = this.clipVideoDurations.get(clipIndex) || clipDuration;
            const baseTime = clipIndex * clipDuration; // Approximate event time at clip start

            // Sample frames (every ~1 second of video = every ~36 frames at 36fps)
            const sampleInterval = Math.max(1, Math.floor(data.frames.length / 60)); // ~60 samples per clip

            for (let i = 0; i < data.frames.length; i += sampleInterval) {
                const frame = data.frames[i];

                if (frame.latitude_deg && frame.longitude_deg &&
                    Math.abs(frame.latitude_deg) > 0.001 && Math.abs(frame.longitude_deg) > 0.001) {

                    // Calculate time within event
                    const frameRatio = i / data.frames.length;
                    const timeInClip = frameRatio * actualDuration;
                    const eventTime = baseTime + timeInClip;

                    points.push({
                        lat: frame.latitude_deg,
                        lng: frame.longitude_deg,
                        time: eventTime
                    });
                }
            }
        }

        return points;
    }

    /**
     * Check if telemetry data is loaded
     * @returns {boolean}
     */
    hasTelemetryData() {
        return this.clipSeiData.size > 0;
    }

    /**
     * Update telemetry data for current playback time
     * @param {number} clipIndex - Current clip index
     * @param {number} timeInClip - Current time within the clip (seconds)
     * @param {number} videoDuration - Total duration of the video clip (seconds)
     */
    updateTelemetry(clipIndex, timeInClip, videoDuration) {
        // Cache the actual video duration for this clip (used for accurate export timing)
        if (videoDuration && videoDuration > 0 && !this.clipVideoDurations.has(clipIndex)) {
            this.clipVideoDurations.set(clipIndex, videoDuration);
        }

        const cacheKey = Array.from(this.clipSeiData.keys()).find(k => k.startsWith(`${clipIndex}_`));
        const clipData = cacheKey ? this.clipSeiData.get(cacheKey) : null;

        // Debug: track if we're using fresh data or fallback
        if (!cacheKey && this._lastLoggedClipMiss !== clipIndex) {
            console.warn(`[TelemetryOverlay] No SEI data for clip ${clipIndex}. Available keys:`, Array.from(this.clipSeiData.keys()));
            this._lastLoggedClipMiss = clipIndex;
        }

        if (clipData && clipData.frames && clipData.frames.length > 0) {
            // Use direct frame index calculation instead of fps-based lookup
            // This avoids issues with incorrect fps from MP4 metadata
            let frameIndex;
            if (videoDuration && videoDuration > 0) {
                // Calculate frame index from time position as fraction of total duration
                const progress = Math.min(timeInClip / videoDuration, 1);
                frameIndex = Math.floor(progress * (clipData.frames.length - 1));
            } else {
                // Fallback to fps-based calculation if no duration available
                const fps = clipData.fps || 36;
                frameIndex = Math.floor(timeInClip * fps);
            }

            // Clamp to valid range
            frameIndex = Math.max(0, Math.min(frameIndex, clipData.frames.length - 1));

            const newData = clipData.frames[frameIndex];
            // Only update if we got valid data - keep last known data otherwise
            if (newData) {
                this.currentData = newData;
                this.lastValidData = newData;

            } else if (this.lastValidData) {
                // Use last valid data to prevent flickering
                this.currentData = this.lastValidData;
            }
        }
        // Don't change opacity - keep overlay stable
    }

    // ==================== RENDERING ====================

    _startUpdateLoop() {
        if (this.animationFrame) return;
        this._updateLoop();
    }

    _stopUpdateLoop() {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
    }

    _updateLoop() {
        if (!this.isVisible) {
            this.animationFrame = null;
            return;
        }

        // Update blink state for turn signals
        const now = Date.now();
        if (now - this.lastBlinkTime > this.BLINK_INTERVAL) {
            this.blinkState = !this.blinkState;
            this.lastBlinkTime = now;
        }

        // Render current data
        this._render();

        this.animationFrame = requestAnimationFrame(this._updateLoop);
    }

    _render() {
        if (!this.currentData) {
            this.content.innerHTML = this._renderNoData();
            return;
        }

        switch (this.currentStyle) {
            case 'cockpit':
                this.content.innerHTML = this._renderCockpitHUD(this.currentData);
                break;
            case 'tesla':
                this.content.innerHTML = this._renderTeslaPill(this.currentData);
                break;
            case 'minimal':
                this.content.innerHTML = this._renderMinimal(this.currentData);
                break;
        }
    }

    _renderNoData() {
        return `
            <div style="
                background: rgba(30, 30, 30, 0.8);
                padding: 12px 20px;
                border-radius: 8px;
                color: #666;
                font-family: 'JetBrains Mono', monospace;
                font-size: 12px;
            ">
                No telemetry data
            </div>
        `;
    }

    // ==================== COCKPIT HUD STYLE ====================

    _renderCockpitHUD(data) {
        const speed = this.units === 'mph' ? data.speed_mph : data.speed_kph;
        const unitLabel = this.units.toUpperCase();
        const steeringAngle = data.steering_wheel_angle || 0;
        const throttle = (data.accelerator_pedal_position || 0) * 100;
        const leftBlinker = data.blinker_on_left && this.blinkState;
        const rightBlinker = data.blinker_on_right && this.blinkState;
        const gear = data.gear_name || 'P';
        const apState = data.autopilot_name || 'NONE';

        // G-force data (clamp to reasonable range)
        const gForceX = Math.max(-2, Math.min(2, data.g_force_x || 0));
        const gForceY = Math.max(-2, Math.min(2, data.g_force_y || 0));

        // Brake states
        const physicalBrake = data.brake_applied;
        const regenAmount = !physicalBrake && gForceY > 0.05
            ? Math.min(100, ((gForceY - 0.05) / 0.35) * 100)
            : 0;

        // Autopilot active = steering wheel turns blue (only for AUTOSTEER and FSD, not TACC)
        const apActive = apState === 'AUTOSTEER' || apState === 'FSD';
        const wheelColor = apActive ? '#0078ff' : '#555';

        // AP mode text (short labels)
        const apModeText = apState === 'FSD' ? 'FSD' :
                          apState === 'AUTOSTEER' ? 'AP' :
                          apState === 'TACC' ? 'TACC' : '';

        // Gear colors - highlight current gear
        const gears = ['P', 'R', 'N', 'D'];

        return `
            <div class="cockpit-hud" style="
                background: rgba(10, 12, 18, 0.75);
                border: 1px solid rgba(0, 212, 255, 0.12);
                border-radius: 8px;
                padding: 8px 10px;
                font-family: 'JetBrains Mono', -apple-system, monospace;
                backdrop-filter: blur(8px);
                box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
                display: flex;
                align-items: center;
                gap: 8px;
            ">
                <!-- Left Blinker (fixed position) -->
                <div style="width: 20px; display: flex; justify-content: center; opacity: ${leftBlinker ? 1 : 0.15};">
                    ${this._renderTurnSignal('left', true)}
                </div>

                <!-- Vertical PRND -->
                <div style="display: flex; flex-direction: column; gap: 1px; font-size: 10px; font-weight: bold; line-height: 1.1;">
                    ${gears.map(g => `
                        <span style="color: ${g === gear ? this._getAccentColor() : '#444'};">${g}</span>
                    `).join('')}
                </div>

                <!-- Steering Wheel (blue when AP/FSD active) with AP mode label -->
                <div style="position: relative; width: 50px; height: 50px;">
                    ${this._renderSteeringWheelColored(steeringAngle, wheelColor)}
                    ${apModeText ? `<div style="
                        position: absolute;
                        bottom: 0px;
                        right: -18px;
                        font-size: 8px;
                        font-weight: bold;
                        color: #0078ff;
                        background: rgba(10, 12, 18, 0.75);
                        padding: 1px 3px;
                        border-radius: 2px;
                    ">${apModeText}</div>` : ''}
                </div>

                <!-- Speed Display -->
                <div style="text-align: center; min-width: 60px;">
                    <div style="
                        font-size: 32px;
                        font-weight: bold;
                        color: #fff;
                        line-height: 1;
                    ">${Math.round(speed)}</div>
                    <div style="
                        font-size: 9px;
                        color: #666;
                    ">${unitLabel}</div>
                </div>

                <!-- G-Force Meter (compact) -->
                <div style="position: relative; width: 40px; height: 48px;">
                    ${this._renderGForceMeter(gForceX, gForceY)}
                </div>

                <!-- Throttle/Brake Bars -->
                ${this._renderThrottleBrakeBar(throttle, physicalBrake, regenAmount)}

                <!-- Right Blinker (fixed position, matches left offset) -->
                <div style="width: 20px; display: flex; justify-content: center; opacity: ${rightBlinker ? 1 : 0.15};">
                    ${this._renderTurnSignal('right', true)}
                </div>
            </div>
        `;
    }

    _renderSteeringWheelColored(angle, color) {
        const clampedAngle = Math.max(-540, Math.min(540, angle));
        return `
            <svg viewBox="0 0 100 100" style="transform: rotate(${clampedAngle}deg); transition: transform 0.15s ease-out;">
                <!-- Outer rim -->
                <circle cx="50" cy="50" r="44" fill="none" stroke="${color}" stroke-width="8" opacity="0.8"/>

                <!-- Center hub -->
                <circle cx="50" cy="50" r="14" fill="#1a1a1a" stroke="${color}" stroke-width="2" opacity="0.6"/>

                <!-- Spokes -->
                <path d="M 34 50 L 10 50" stroke="${color}" stroke-width="5" stroke-linecap="round" opacity="0.7"/>
                <path d="M 66 50 L 90 50" stroke="${color}" stroke-width="5" stroke-linecap="round" opacity="0.7"/>
                <path d="M 50 66 L 50 90" stroke="${color}" stroke-width="5" stroke-linecap="round" opacity="0.7"/>

                <!-- Top marker -->
                <circle cx="50" cy="8" r="3" fill="${this._getAccentColor()}"/>
            </svg>
        `;
    }

    _renderSteeringWheel(angle) {
        // Clamp angle for visual (max ±540 degrees)
        const clampedAngle = Math.max(-540, Math.min(540, angle));

        return `
            <svg viewBox="0 0 100 100" style="transform: rotate(${clampedAngle}deg); transition: transform 0.15s ease-out;">
                <!-- Outer rim - thick rounded wheel -->
                <circle cx="50" cy="50" r="44" fill="none" stroke="#3a3a3a" stroke-width="10"/>
                <circle cx="50" cy="50" r="44" fill="none" stroke="#4a4a4a" stroke-width="6"/>

                <!-- Center hub background -->
                <circle cx="50" cy="50" r="16" fill="#2a2a2a"/>
                <circle cx="50" cy="50" r="14" fill="#1a1a1a" stroke="#3a3a3a" stroke-width="1"/>

                <!-- Three spokes at 3, 6, 9 o'clock positions -->
                <!-- 9 o'clock (left) spoke -->
                <path d="M 34 50 L 8 50" stroke="#4a4a4a" stroke-width="8" stroke-linecap="round"/>
                <path d="M 34 50 L 10 50" stroke="#3a3a3a" stroke-width="5" stroke-linecap="round"/>

                <!-- 3 o'clock (right) spoke -->
                <path d="M 66 50 L 92 50" stroke="#4a4a4a" stroke-width="8" stroke-linecap="round"/>
                <path d="M 66 50 L 90 50" stroke="#3a3a3a" stroke-width="5" stroke-linecap="round"/>

                <!-- 6 o'clock (bottom) spoke -->
                <path d="M 50 66 L 50 92" stroke="#4a4a4a" stroke-width="8" stroke-linecap="round"/>
                <path d="M 50 66 L 50 90" stroke="#3a3a3a" stroke-width="5" stroke-linecap="round"/>

                <!-- Top orientation marker (12 o'clock) -->
                <circle cx="50" cy="8" r="3" fill="${this._getAccentColor()}"/>
            </svg>
        `;
    }

    _renderPedalBars(throttle, brakeOn) {
        return `
            <div style="display: flex; gap: 6px; height: 60px;">
                <!-- Throttle bar -->
                <div style="
                    width: 16px;
                    height: 100%;
                    background: #222;
                    border-radius: 4px;
                    position: relative;
                    overflow: hidden;
                ">
                    <div style="
                        position: absolute;
                        bottom: 0;
                        width: 100%;
                        height: ${throttle}%;
                        background: linear-gradient(to top, #00c853, #00e676);
                        border-radius: 4px;
                        transition: height 0.1s ease-out;
                    "></div>
                </div>
                <!-- Brake indicator -->
                <div style="
                    width: 16px;
                    height: 100%;
                    background: ${brakeOn ? '#ff1744' : '#222'};
                    border-radius: 4px;
                    transition: background 0.1s ease;
                "></div>
            </div>
        `;
    }

    _renderPedalIndicators(throttle, brakeOn) {
        // Compact circular indicators for throttle and brake
        const throttleOn = throttle > 5; // Consider throttle "on" if > 5%
        return `
            <div style="display: flex; gap: 4px;">
                <!-- Throttle indicator -->
                <div style="
                    width: 14px;
                    height: 14px;
                    border-radius: 50%;
                    background: ${throttleOn ? '#00c853' : '#333'};
                    border: 2px solid ${throttleOn ? '#00e676' : '#444'};
                    transition: all 0.1s ease;
                " title="Throttle: ${Math.round(throttle)}%"></div>
                <!-- Brake indicator -->
                <div style="
                    width: 14px;
                    height: 14px;
                    border-radius: 50%;
                    background: ${brakeOn ? '#ff1744' : '#333'};
                    border: 2px solid ${brakeOn ? '#ff5252' : '#444'};
                    transition: all 0.1s ease;
                " title="Brake"></div>
            </div>
        `;
    }

    _renderGForceMeter(gX, gY) {
        // G-force visualization with auto-zoom
        // Tesla coordinate system:
        // gX = lateral (positive = right, negative = left)
        // gY = longitudinal (positive = braking/decel, negative = acceleration)
        const centerX = 25;
        const centerY = 25;
        const maxOffset = 18; // Max pixels from center

        // Calculate current G magnitude
        const totalG = Math.sqrt(gX * gX + gY * gY);

        // Fixed scale for now (simpler, better performance)
        const maxG = 1.0;

        // Calculate ball position (Tesla coordinate system)
        const ballX = centerX - (gX / maxG) * maxOffset;
        const ballY = centerY - (gY / maxG) * maxOffset;

        // Add to history for trace effect (store raw G values for recalculation)
        this.gForceHistory.push({ gX, gY });
        if (this.gForceHistory.length > this.maxGForceHistory) {
            this.gForceHistory.shift();
        }

        // Color based on total g-force magnitude relative to scale
        const intensity = Math.min(1, totalG / maxG);
        const hue = 120 - (intensity * 120); // Green to red

        // Skip trace rendering for performance - just keep history for potential future use
        const tracePath = '';

        // Simple fixed ring at 0.5g
        const scaleRings = `<circle cx="${centerX}" cy="${centerY}" r="${maxOffset * 0.5}" fill="none" stroke="rgba(100, 150, 200, 0.25)" stroke-width="0.5"/>`;

        return `
            <svg viewBox="0 0 50 56" style="width: 100%; height: 100%;">
                <!-- Background circle -->
                <circle cx="25" cy="22" r="20" fill="#1a1a1a" stroke="#333" stroke-width="1"/>

                <!-- Grid lines -->
                <line x1="25" y1="4" x2="25" y2="40" stroke="#333" stroke-width="0.5"/>
                <line x1="7" y1="22" x2="43" y2="22" stroke="#333" stroke-width="0.5"/>

                <!-- Scale rings (show G levels) -->
                <circle cx="25" cy="22" r="${18 * 0.5}" fill="none" stroke="rgba(100, 150, 200, 0.25)" stroke-width="0.5"/>

                <!-- Center dot -->
                <circle cx="25" cy="22" r="2" fill="#555"/>

                <!-- G-force trace -->
                ${tracePath}

                <!-- G-force ball (current position) -->
                <circle cx="${25 - (gX / 1.0) * 16}" cy="${22 - (gY / 1.0) * 16}" r="5"
                    fill="hsl(${hue}, 80%, 50%)"
                    stroke="hsl(${hue}, 80%, 70%)"
                    stroke-width="1"/>

                <!-- G value label - positioned below circle with clear separation -->
                <text x="25" y="53" text-anchor="middle" fill="#666" font-size="6" font-family="monospace">
                    ${totalG.toFixed(1)}g
                </text>
            </svg>
        `;
    }

    _renderThrottleBrakeBar(throttle, physicalBrake, regenAmount) {
        // Vertical bars matching vehicle pedal layout: brake (left), throttle (right)
        // Physical brake = red (full), Regen brake = orange (variable fill)
        // regenAmount is now a percentage (0-100)

        return `
            <div style="display: flex; gap: 3px; height: 40px;">
                <!-- Brake bar (left, like brake pedal) -->
                <div style="
                    width: 10px;
                    height: 100%;
                    background: #222;
                    border-radius: 3px;
                    position: relative;
                    overflow: hidden;
                ">
                    ${physicalBrake ? `
                        <div style="
                            position: absolute;
                            bottom: 0;
                            width: 100%;
                            height: 100%;
                            background: linear-gradient(to top, #ff1744, #ff5252);
                            border-radius: 3px;
                        "></div>
                    ` : regenAmount > 0 ? `
                        <div style="
                            position: absolute;
                            bottom: 0;
                            width: 100%;
                            height: ${regenAmount}%;
                            background: linear-gradient(to top, #ff6d00, #ff9100);
                            border-radius: 3px;
                            transition: height 0.1s ease-out;
                        "></div>
                    ` : ''}
                </div>
                <!-- Throttle bar (right, like gas pedal) -->
                <div style="
                    width: 10px;
                    height: 100%;
                    background: #222;
                    border-radius: 3px;
                    position: relative;
                    overflow: hidden;
                ">
                    <div style="
                        position: absolute;
                        bottom: 0;
                        width: 100%;
                        height: ${throttle}%;
                        background: linear-gradient(to top, #00c853, #69f0ae);
                        border-radius: 3px;
                        transition: height 0.1s ease-out;
                    "></div>
                </div>
            </div>
        `;
    }

    _renderTurnSignal(direction, useGreen = false) {
        const isLeft = direction === 'left';
        const transform = isLeft ? '' : 'transform: scaleX(-1);';
        const color = useGreen ? '#4caf50' : '#ff9100';

        return `
            <svg viewBox="0 0 24 24" width="22" height="22" style="${transform}">
                <path fill="${color}" d="M14 5v14l-8-7z"/>
            </svg>
        `;
    }

    // ==================== TESLA PILL STYLE ====================

    _renderTeslaPill(data) {
        const speed = this.units === 'mph' ? data.speed_mph : data.speed_kph;
        const unitLabel = this.units.toLowerCase();
        const steeringAngle = data.steering_wheel_angle || 0;
        const leftBlinker = data.blinker_on_left && this.blinkState;
        const rightBlinker = data.blinker_on_right && this.blinkState;
        const apState = data.autopilot_name || 'NONE';
        // Brake states: physical brake (red) vs regen braking (orange, variable)
        const gForceY = data.g_force_y || 0;
        const physicalBrake = data.brake_applied;
        // Regen: variable 0-100% based on deceleration (0.05g threshold, max at 0.4g)
        const regenAmount = !physicalBrake && gForceY > 0.05
            ? Math.min(100, ((gForceY - 0.05) / 0.35) * 100)
            : 0;

        // Autopilot active - steering wheel turns blue (only AUTOSTEER and FSD, not TACC)
        const apActive = apState === 'AUTOSTEER' || apState === 'FSD';
        const wheelColor = apActive ? '#0078ff' : '#666';

        return `
            <div class="tesla-pill" style="
                background: rgba(30, 30, 30, 0.95);
                border-radius: 24px;
                padding: 8px 16px;
                display: flex;
                align-items: center;
                gap: 14px;
                font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
                backdrop-filter: blur(10px);
                box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
            ">
                <!-- Steering Wheel (blue when in autopilot) -->
                <div style="
                    width: 28px;
                    height: 28px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                ">
                    <svg viewBox="0 0 24 24" width="24" height="24" style="transform: rotate(${steeringAngle}deg);">
                        <circle cx="12" cy="12" r="10" fill="none" stroke="${wheelColor}" stroke-width="2.5"/>
                        <line x1="2" y1="12" x2="8" y2="12" stroke="${wheelColor}" stroke-width="2" stroke-linecap="round"/>
                        <line x1="16" y1="12" x2="22" y2="12" stroke="${wheelColor}" stroke-width="2" stroke-linecap="round"/>
                        <line x1="12" y1="16" x2="12" y2="22" stroke="${wheelColor}" stroke-width="2" stroke-linecap="round"/>
                        <circle cx="12" cy="12" r="3" fill="${wheelColor}"/>
                    </svg>
                </div>

                <!-- Left signal -->
                <div style="opacity: ${leftBlinker ? 1 : 0.3}; color: #4caf50;">
                    <svg viewBox="0 0 24 24" width="20" height="20">
                        <path fill="currentColor" d="M14 5v14l-8-7z"/>
                    </svg>
                </div>

                <!-- Speed -->
                <div style="text-align: center; min-width: 80px;">
                    <span style="
                        font-size: 28px;
                        font-weight: 600;
                        color: #fff;
                    ">${Math.round(speed)}</span>
                    <span style="
                        font-size: 14px;
                        color: #888;
                        margin-left: 4px;
                    ">${unitLabel}</span>
                </div>

                <!-- Right signal -->
                <div style="opacity: ${rightBlinker ? 1 : 0.3}; color: #4caf50; transform: scaleX(-1);">
                    <svg viewBox="0 0 24 24" width="20" height="20">
                        <path fill="currentColor" d="M14 5v14l-8-7z"/>
                    </svg>
                </div>

                <!-- Brake (red=physical, orange=regen with variable opacity) -->
                <div style="
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    background: ${physicalBrake ? '#ff1744' : regenAmount > 0 ? `rgba(255, 145, 0, ${0.3 + (regenAmount / 100) * 0.7})` : 'rgba(255, 255, 255, 0.1)'};
                    display: flex;
                    align-items: center;
                    justify-content: center;
                ">
                    <svg viewBox="0 0 24 24" width="14" height="14">
                        <circle cx="12" cy="12" r="10" fill="none" stroke="${(physicalBrake || regenAmount > 0) ? '#fff' : '#555'}" stroke-width="2"/>
                        <circle cx="12" cy="12" r="4" fill="${(physicalBrake || regenAmount > 0) ? '#fff' : '#555'}"/>
                    </svg>
                </div>

            </div>
        `;
    }

    // ==================== MINIMAL STYLE ====================

    _renderMinimal(data) {
        const speed = this.units === 'mph' ? data.speed_mph : data.speed_kph;
        const unitLabel = this.units.toUpperCase();
        const apState = data.autopilot_name || 'NONE';
        const showAp = apState !== 'NONE';

        const apColor = apState === 'FSD' ? '#00c853' :
                        (apState === 'TACC' || apState === 'AUTOSTEER') ? '#0078ff' : '#888';

        return `
            <div class="minimal-overlay" style="
                background: rgba(0, 0, 0, 0.7);
                padding: 8px 14px;
                border-radius: 6px;
                font-family: 'JetBrains Mono', monospace;
                font-size: 14px;
                color: #fff;
                backdrop-filter: blur(5px);
            ">
                <span style="font-weight: bold; font-size: 18px;">${Math.round(speed)}</span>
                <span style="color: #888; margin-left: 4px;">${unitLabel}</span>
                ${showAp ? `<span style="color: ${apColor}; margin-left: 12px; font-size: 11px; font-weight: bold;">${apState}</span>` : ''}
            </div>
        `;
    }

    // ==================== CANVAS RENDERING (for export) ====================

    /**
     * Render telemetry overlay to canvas (for video export)
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {number} canvasWidth - Canvas width
     * @param {number} canvasHeight - Canvas height
     * @param {Object} telemetryData - Telemetry data to render
     * @param {Object} options - Rendering options (style, units, position, blinkState, scale)
     */
    renderToCanvas(ctx, canvasWidth, canvasHeight, telemetryData, options = {}) {
        if (!telemetryData) return;

        const style = options.style || this.currentStyle;
        const units = options.units || this.units;
        const position = options.position || this.position;

        // Calculate scale based on canvas size vs reference (1200px width as base)
        // This makes the overlay scale proportionally with export resolution
        const baseWidth = 1200;
        const scale = options.scale !== undefined ? options.scale : Math.max(0.8, Math.min(2.0, canvasWidth / baseWidth));

        // Calculate pixel position from percentage (adjusted for overlay centering)
        // Position is center point, so we need to offset by half the scaled overlay size
        const overlayWidth = style === 'cockpit' ? 280 : (style === 'tesla' ? 230 : 150);
        const overlayHeight = style === 'cockpit' ? 60 : (style === 'tesla' ? 44 : 30);

        const x = (position.x / 100) * canvasWidth - (overlayWidth * scale / 2);
        const y = (position.y / 100) * canvasHeight - (overlayHeight * scale / 2);

        // Use animation state for blink (30fps assumed for export)
        const blinkState = options.blinkState !== undefined ? options.blinkState : this.blinkState;

        ctx.save();

        // Apply scaling transform
        ctx.translate(x, y);
        ctx.scale(scale, scale);

        switch (style) {
            case 'cockpit':
                this._renderCockpitToCanvas(ctx, 0, 0, telemetryData, units, blinkState);
                break;
            case 'tesla':
                this._renderTeslaToCanvas(ctx, 0, 0, telemetryData, units, blinkState);
                break;
            case 'minimal':
                this._renderMinimalToCanvas(ctx, 0, 0, telemetryData, units);
                break;
        }

        ctx.restore();
    }

    _renderCockpitToCanvas(ctx, x, y, data, units, blinkState) {
        const speed = units === 'mph' ? data.speed_mph : data.speed_kph;
        const unitLabel = units.toUpperCase();
        const steeringAngle = data.steering_wheel_angle || 0;
        const throttle = (data.accelerator_pedal_position || 0) * 100;
        const leftBlinker = data.blinker_on_left && blinkState;
        const rightBlinker = data.blinker_on_right && blinkState;
        const gear = data.gear_name || 'P';
        const apState = data.autopilot_name || 'NONE';

        // G-force data (Tesla coords: X = lateral, Y = longitudinal)
        const gForceX = Math.max(-2, Math.min(2, data.g_force_x || 0));
        const gForceY = Math.max(-2, Math.min(2, data.g_force_y || 0));

        // Brake states: physical brake (red) vs regen braking (orange, variable)
        const physicalBrake = data.brake_applied;
        // Regen: variable 0-100% based on deceleration
        const regenAmount = !physicalBrake && gForceY > 0.1
            ? Math.min(100, ((gForceY - 0.1) / 0.7) * 100)
            : 0;

        // Autopilot active = steering wheel turns blue (only for AUTOSTEER and FSD, not TACC)
        const apActive = apState === 'AUTOSTEER' || apState === 'FSD';
        const wheelColor = apActive ? '#0078ff' : '#555';

        // AP mode text (short labels)
        const apModeText = apState === 'FSD' ? 'FSD' :
                          apState === 'AUTOSTEER' ? 'AP' :
                          apState === 'TACC' ? 'TACC' : '';

        // Compact horizontal layout dimensions
        const width = 260;
        const height = 60;

        // Semi-transparent background
        ctx.fillStyle = 'rgba(10, 12, 18, 0.75)';
        this._roundRect(ctx, x, y, width, height, 8);
        ctx.fill();

        // Border
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.12)';
        ctx.lineWidth = 1;
        ctx.stroke();

        const centerY = y + height / 2;
        let currentX = x + 12;

        // Left blinker (green, fixed position)
        this._drawTurnSignal(ctx, currentX + 8, centerY, 'left', leftBlinker, true);
        currentX += 24;

        // Vertical PRND
        const gears = ['P', 'R', 'N', 'D'];
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        gears.forEach((g, i) => {
            ctx.fillStyle = g === gear ? this._getAccentColor() : '#444';
            ctx.fillText(g, currentX + 6, centerY - 15 + i * 11);
        });
        currentX += 18;

        // Steering wheel (blue when AP/FSD active)
        this._drawSteeringWheelColored(ctx, currentX + 22, centerY, 20, steeringAngle, wheelColor);

        // AP mode label (bottom-right of steering wheel, positioned outside the wheel)
        // Steering wheel is at currentX + 22 with radius 20, so right edge is currentX + 42
        if (apModeText) {
            ctx.font = 'bold 8px JetBrains Mono, monospace';
            const labelWidth = ctx.measureText(apModeText).width + 6;
            const labelX = currentX + 44; // Right of steering wheel
            const labelY = centerY + 14; // Below center

            // Background
            ctx.fillStyle = 'rgba(10, 12, 18, 0.85)';
            this._roundRect(ctx, labelX, labelY, labelWidth, 14, 3);
            ctx.fill();

            // Text
            ctx.fillStyle = '#0078ff';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(apModeText, labelX + 3, labelY + 7);
            ctx.textBaseline = 'alphabetic'; // Reset
        }
        currentX += 55;

        // Speed - match DOM styling (32px bold, vertically centered)
        ctx.font = 'bold 32px JetBrains Mono, monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Shift speed up slightly to center the speed+unit combo as a group
        ctx.fillText(Math.round(speed).toString(), currentX + 25, centerY - 5);

        // Unit label - match DOM (9px, below speed)
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillStyle = '#666';
        ctx.textBaseline = 'middle';
        ctx.fillText(unitLabel, currentX + 25, centerY + 16);
        ctx.textBaseline = 'alphabetic'; // Reset to default
        currentX += 55;

        // G-Force meter (compact)
        this._drawGForceMeter(ctx, currentX + 15, centerY, 16, gForceX, gForceY);
        currentX += 35;

        // Throttle/Brake bars
        this._drawThrottleBrakeBar(ctx, currentX, centerY - 18, throttle, physicalBrake, regenAmount);
        currentX += 28; // barWidth(8) + gap(4) + barWidth(8) + spacing

        // Right blinker (green, positioned after throttle/brake bars)
        this._drawTurnSignal(ctx, currentX + 8, centerY, 'right', rightBlinker, true);
    }

    _drawSteeringWheelColored(ctx, cx, cy, radius, angle, color) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((angle * Math.PI) / 180);

        // Outer rim
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.stroke();

        // Center hub
        ctx.fillStyle = '#1a1a1a';
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(0, 0, radius * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Spokes
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.7;

        // Left spoke
        ctx.beginPath();
        ctx.moveTo(-radius + 2, 0);
        ctx.lineTo(-radius * 0.35, 0);
        ctx.stroke();

        // Right spoke
        ctx.beginPath();
        ctx.moveTo(radius - 2, 0);
        ctx.lineTo(radius * 0.35, 0);
        ctx.stroke();

        // Bottom spoke
        ctx.beginPath();
        ctx.moveTo(0, radius - 2);
        ctx.lineTo(0, radius * 0.35);
        ctx.stroke();

        // Top marker
        ctx.globalAlpha = 1;
        ctx.fillStyle = this._getAccentColor();
        ctx.beginPath();
        ctx.arc(0, -radius + 3, 2, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    _renderTeslaToCanvas(ctx, x, y, data, units, blinkState) {
        const speed = units === 'mph' ? data.speed_mph : data.speed_kph;
        const unitLabel = units.toLowerCase();
        const steeringAngle = data.steering_wheel_angle || 0;
        const leftBlinker = data.blinker_on_left && blinkState;
        const rightBlinker = data.blinker_on_right && blinkState;
        const apState = data.autopilot_name || 'NONE';

        // Brake states: physical brake (red) vs regen braking (orange, variable)
        const gForceY = data.g_force_y || 0;
        const physicalBrake = data.brake_applied;
        // Regen: variable 0-100% based on deceleration (positive gForceY = decel in Tesla coords)
        const regenAmount = !physicalBrake && gForceY > 0.1
            ? Math.min(100, ((gForceY - 0.1) / 0.7) * 100)
            : 0;

        // Autopilot active - steering wheel turns blue (only AUTOSTEER and FSD, not TACC)
        const apActive = apState === 'AUTOSTEER' || apState === 'FSD';
        const wheelColor = apActive ? '#0078ff' : '#666';

        const width = 230;  // Narrower without AP indicator
        const height = 44;

        // Background pill
        ctx.fillStyle = 'rgba(30, 30, 30, 0.95)';
        this._roundRect(ctx, x, y, width, height, 22);
        ctx.fill();

        // Mini steering wheel (instead of gear badge)
        this._drawMiniSteeringWheel(ctx, x + 24, y + 22, 12, steeringAngle, wheelColor);

        // Left signal (arrow pointing LEFT ←)
        ctx.fillStyle = leftBlinker ? '#4caf50' : 'rgba(255, 255, 255, 0.3)';
        ctx.beginPath();
        ctx.moveTo(x + 46, y + 22);   // Point on left
        ctx.lineTo(x + 58, y + 15);   // Top right
        ctx.lineTo(x + 58, y + 29);   // Bottom right
        ctx.closePath();
        ctx.fill();

        // Speed - match DOM (28px 600 weight)
        ctx.font = '600 28px -apple-system, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const centerY = y + height / 2;
        ctx.fillText(Math.round(speed).toString(), x + 100, centerY);

        // Unit label - match DOM (14px inline with speed)
        ctx.font = '14px -apple-system, sans-serif';
        ctx.fillStyle = '#888888';
        ctx.textAlign = 'left';
        ctx.fillText(unitLabel, x + 130, centerY);
        ctx.textBaseline = 'alphabetic'; // Reset to default

        // Right signal (arrow pointing RIGHT →)
        ctx.fillStyle = rightBlinker ? '#4caf50' : 'rgba(255, 255, 255, 0.3)';
        ctx.beginPath();
        ctx.moveTo(x + 168, y + 22);  // Point on right
        ctx.lineTo(x + 156, y + 15);  // Top left
        ctx.lineTo(x + 156, y + 29);  // Bottom left
        ctx.closePath();
        ctx.fill();

        // Brake indicator (red=physical, orange=regen with variable opacity)
        if (physicalBrake) {
            ctx.fillStyle = '#ff1744';
        } else if (regenAmount > 0) {
            const regenAlpha = 0.3 + (regenAmount / 100) * 0.7;
            ctx.fillStyle = `rgba(255, 145, 0, ${regenAlpha})`;
        } else {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        }
        ctx.beginPath();
        ctx.arc(x + 200, y + 22, 10, 0, Math.PI * 2);
        ctx.fill();

        // Brake icon inside circle
        ctx.strokeStyle = (physicalBrake || regenAmount > 0) ? '#fff' : '#555';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x + 200, y + 22, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = (physicalBrake || regenAmount > 0) ? '#fff' : '#555';
        ctx.beginPath();
        ctx.arc(x + 200, y + 22, 2.5, 0, Math.PI * 2);
        ctx.fill();

        // No separate AP indicator needed - steering wheel color indicates AP status
    }

    _drawMiniSteeringWheel(ctx, cx, cy, radius, angle, color = '#666') {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((angle * Math.PI) / 180);

        // Outer ring
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.stroke();

        // Spokes (simplified for small size)
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';

        // Left spoke
        ctx.beginPath();
        ctx.moveTo(-radius + 2, 0);
        ctx.lineTo(-radius * 0.3, 0);
        ctx.stroke();

        // Right spoke
        ctx.beginPath();
        ctx.moveTo(radius - 2, 0);
        ctx.lineTo(radius * 0.3, 0);
        ctx.stroke();

        // Bottom spoke
        ctx.beginPath();
        ctx.moveTo(0, radius - 2);
        ctx.lineTo(0, radius * 0.3);
        ctx.stroke();

        // Center hub
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(0, 0, radius * 0.25, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    _renderMinimalToCanvas(ctx, x, y, data, units) {
        const speed = units === 'mph' ? data.speed_mph : data.speed_kph;
        const unitLabel = units.toUpperCase();
        const apState = data.autopilot_name || 'NONE';

        // Measure text for background sizing - match DOM (18px bold speed)
        ctx.font = 'bold 18px JetBrains Mono, monospace';
        const speedText = Math.round(speed).toString();
        const speedWidth = ctx.measureText(speedText + ' ' + unitLabel).width;
        const totalWidth = speedWidth + (apState !== 'NONE' ? 60 : 0) + 28;

        // Background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        this._roundRect(ctx, x, y, totalWidth, 34, 6);
        ctx.fill();

        // Speed - match DOM (18px bold)
        const centerY = y + 17; // Vertically center in 34px height
        ctx.font = 'bold 18px JetBrains Mono, monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(speedText, x + 14, centerY);

        // Unit label - match DOM (14px, 4px gap)
        ctx.font = '14px JetBrains Mono, monospace';
        ctx.fillStyle = '#888888';
        const speedNumWidth = ctx.measureText(speedText).width;
        ctx.fillText(unitLabel, x + 14 + speedNumWidth + 4, centerY);

        // AP status - match DOM (11px bold)
        if (apState !== 'NONE') {
            const apColor = apState === 'FSD' ? '#00c853' : '#0078ff';
            ctx.font = 'bold 11px JetBrains Mono, monospace';
            ctx.fillStyle = apColor;
            ctx.fillText(apState, x + totalWidth - 50, centerY);
        }
        ctx.textBaseline = 'alphabetic'; // Reset to default
    }

    _drawSteeringWheel(ctx, cx, cy, radius, angle) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((angle * Math.PI) / 180);

        // Outer ring
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.stroke();

        // Spokes at 3, 6, 9 o'clock positions
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';

        // 9 o'clock (left) spoke
        ctx.beginPath();
        ctx.moveTo(-radius + 8, 0);
        ctx.lineTo(-radius * 0.35, 0);
        ctx.stroke();

        // 3 o'clock (right) spoke
        ctx.beginPath();
        ctx.moveTo(radius - 8, 0);
        ctx.lineTo(radius * 0.35, 0);
        ctx.stroke();

        // 6 o'clock (bottom) spoke
        ctx.beginPath();
        ctx.moveTo(0, radius - 8);
        ctx.lineTo(0, radius * 0.35);
        ctx.stroke();

        // Center hub
        ctx.fillStyle = '#222';
        ctx.beginPath();
        ctx.arc(0, 0, radius * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Top marker (12 o'clock)
        ctx.fillStyle = this._getAccentColor();
        ctx.beginPath();
        ctx.arc(0, -radius - 3, 2.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    _drawPedalBars(ctx, x, y, throttle, brakeOn) {
        const barWidth = 12;
        const barHeight = 50;
        const gap = 6;

        // Throttle background
        ctx.fillStyle = '#222';
        this._roundRect(ctx, x, y, barWidth, barHeight, 3);
        ctx.fill();

        // Throttle fill
        const throttleHeight = throttle * barHeight;
        const gradient = ctx.createLinearGradient(0, y + barHeight, 0, y + barHeight - throttleHeight);
        gradient.addColorStop(0, '#00c853');
        gradient.addColorStop(1, '#00e676');
        ctx.fillStyle = gradient;
        this._roundRect(ctx, x, y + barHeight - throttleHeight, barWidth, throttleHeight, 3);
        ctx.fill();

        // Brake
        ctx.fillStyle = brakeOn ? '#ff1744' : '#222';
        this._roundRect(ctx, x + barWidth + gap, y, barWidth, barHeight, 3);
        ctx.fill();
    }

    _drawPedalIndicators(ctx, x, y, throttle, brakeOn) {
        // Compact circular indicators for throttle and brake
        const throttleOn = throttle > 0.05; // 5% threshold
        const radius = 6;
        const gap = 4;

        // Throttle indicator
        ctx.fillStyle = throttleOn ? '#00c853' : '#333';
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = throttleOn ? '#00e676' : '#444';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Brake indicator
        ctx.fillStyle = brakeOn ? '#ff1744' : '#333';
        ctx.beginPath();
        ctx.arc(x + radius * 2 + gap, y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = brakeOn ? '#ff5252' : '#444';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    _drawGForceMeter(ctx, cx, cy, radius, gX, gY) {
        // G-force visualization - ball moves based on lateral/longitudinal forces
        // Tesla coordinate system: gX = lateral, gY = longitudinal
        const maxG = 1.0; // Match DOM version scale
        const maxOffset = radius * 0.8;

        // Calculate ball position (matching DOM version)
        const ballX = cx - (gX / maxG) * maxOffset;
        const ballY = cy - (gY / maxG) * maxOffset;

        // Color based on total g-force
        const totalG = Math.sqrt(gX * gX + gY * gY);
        const intensity = Math.min(1, totalG / maxG);
        const hue = 120 - (intensity * 120); // Green to red

        // Background circle
        ctx.fillStyle = '#1a1a1a';
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Grid lines
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy - radius + 2);
        ctx.lineTo(cx, cy + radius - 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - radius + 2, cy);
        ctx.lineTo(cx + radius - 2, cy);
        ctx.stroke();

        // Inner circle
        ctx.beginPath();
        ctx.arc(cx, cy, radius * 0.5, 0, Math.PI * 2);
        ctx.stroke();

        // Center dot
        ctx.fillStyle = '#555';
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fill();

        // G-force ball
        ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
        ctx.beginPath();
        ctx.arc(ballX, ballY, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `hsl(${hue}, 80%, 70%)`;
        ctx.lineWidth = 1;
        ctx.stroke();

        // G value label
        ctx.font = '6px monospace';
        ctx.fillStyle = '#666';
        ctx.textAlign = 'center';
        ctx.fillText(`${totalG.toFixed(1)}g`, cx, cy + radius + 8);
    }

    _drawThrottleBrakeBar(ctx, x, y, throttle, physicalBrake, regenAmount) {
        const barWidth = 8;
        const barHeight = 38;
        const gap = 4;

        // Brake bar background (LEFT - like brake pedal)
        ctx.fillStyle = '#222';
        this._roundRect(ctx, x, y, barWidth, barHeight, 2);
        ctx.fill();

        // Brake bar fill (red=physical full, orange=regen variable)
        if (physicalBrake) {
            const brakeGradient = ctx.createLinearGradient(0, y + barHeight, 0, y);
            brakeGradient.addColorStop(0, '#ff1744');
            brakeGradient.addColorStop(1, '#ff5252');
            ctx.fillStyle = brakeGradient;
            this._roundRect(ctx, x, y, barWidth, barHeight, 2);
            ctx.fill();
        } else if (regenAmount > 0) {
            const regenHeight = (regenAmount / 100) * barHeight;
            const regenGradient = ctx.createLinearGradient(0, y + barHeight, 0, y + barHeight - regenHeight);
            regenGradient.addColorStop(0, '#ff6d00');
            regenGradient.addColorStop(1, '#ff9100');
            ctx.fillStyle = regenGradient;
            this._roundRect(ctx, x, y + barHeight - regenHeight, barWidth, regenHeight, 2);
            ctx.fill();
        }

        // Throttle background (RIGHT - like gas pedal)
        ctx.fillStyle = '#222';
        this._roundRect(ctx, x + barWidth + gap, y, barWidth, barHeight, 2);
        ctx.fill();

        // Throttle fill
        const throttleHeight = (throttle / 100) * barHeight;
        if (throttleHeight > 0) {
            const gradient = ctx.createLinearGradient(0, y + barHeight, 0, y + barHeight - throttleHeight);
            gradient.addColorStop(0, '#00c853');
            gradient.addColorStop(1, '#69f0ae');
            ctx.fillStyle = gradient;
            this._roundRect(ctx, x + barWidth + gap, y + barHeight - throttleHeight, barWidth, throttleHeight, 2);
            ctx.fill();
        }
    }

    _drawTurnSignal(ctx, cx, cy, direction, isOn, useGreen = false) {
        const onColor = useGreen ? '#4caf50' : '#ff9100';
        const offColor = useGreen ? 'rgba(76, 175, 80, 0.2)' : 'rgba(255, 145, 0, 0.2)';
        ctx.fillStyle = isOn ? onColor : offColor;

        ctx.beginPath();
        if (direction === 'left') {
            // Arrow pointing LEFT ← (point on left, base on right)
            ctx.moveTo(cx - 6, cy);       // Point on left
            ctx.lineTo(cx + 10, cy - 8);  // Top right
            ctx.lineTo(cx + 10, cy + 8);  // Bottom right
        } else {
            // Arrow pointing RIGHT → (point on right, base on left)
            ctx.moveTo(cx + 6, cy);       // Point on right
            ctx.lineTo(cx - 10, cy - 8);  // Top left
            ctx.lineTo(cx - 10, cy + 8);  // Bottom left
        }
        ctx.closePath();
        ctx.fill();
    }

    _roundRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    /**
     * Cleanup resources
     */
    destroy() {
        this._stopUpdateLoop();
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
        document.removeEventListener('touchmove', this._onTouchMove);
        document.removeEventListener('touchend', this._onTouchEnd);

        if (this.container && this.container.parentElement) {
            this.container.parentElement.removeChild(this.container);
        }

        this.clipSeiData.clear();
        this.clipVideoDurations.clear();
    }
}

// Export for use in other modules
window.TelemetryOverlay = TelemetryOverlay;
