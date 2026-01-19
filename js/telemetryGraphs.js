/**
 * TelemetryGraphs - Unified overlay with Speed, G-force, Steering, and Elevation graphs
 * Positioned on video grid like other overlays (HUD, mini-map)
 */

class TelemetryGraphs {
    constructor(videoPlayer) {
        this.videoPlayer = videoPlayer;
        this.container = null;
        this.isVisible = false;

        // Data
        this.graphData = null; // { points: [], startTime, endTime, dataDuration }
        this.elevationProfile = null; // Elevation data
        this.speedLimitProfile = null; // Speed limit data: { points: [{time, limitMph, limitKph}], ... }
        this.tripStats = null; // Trip statistics: { totalDistanceMiles, avgSpeedMph, maxSpeedMph, apPercent, ... }
        this.totalDuration = 0;
        this.currentTime = 0;

        // Settings
        this.units = 'mph'; // or 'kph'

        // Anomalies
        this.anomalies = {
            speed: [],
            gforce: [],
            steering: [],
            elevation: []
        };
        this.showAnomalies = true; // Toggle for showing/hiding anomaly markers
        this.ANOMALIES_ENABLED_KEY = 'teslacamviewer_graphs_anomalies_enabled';

        // Anomaly detection thresholds
        this.anomalyThresholds = {
            speed: {
                suddenChange: 10 // mph per second
            },
            gforce: {
                spike: 0.3 // g
            },
            steering: {
                rapidMovement: 30 // degrees per second
            },
            phantomBraking: {
                minDecelG: 0.25,       // Minimum deceleration in g (negative g_force_y)
                minSpeedDropMph: 5,    // Minimum speed drop in 1 second
                minSpeedMph: 15,       // Minimum speed to consider (avoid false positives at low speed)
                cooldownSeconds: 3     // Minimum time between phantom brake events
            }
        };

        // Phantom braking detection
        this.phantomBrakes = []; // Array of { time, latitude, longitude, severity, speedDrop, gForce, duration }
        this.onPhantomBrakesDetected = null; // Callback to notify timeline of phantom brakes

        // Near-miss detection
        this.nearMisses = []; // Array of { time, score, brakeG, steeringRate, speed, severity }
        this.onNearMissesDetected = null; // Callback to notify timeline of near-misses

        // Hard braking/acceleration detection thresholds (configurable)
        // Using longitudinal G-force (g_force_y): negative = braking, positive = acceleration
        this.hardBrakeThreshold = -0.4;  // G-force threshold for hard braking (default: -0.4g)
        this.hardAccelThreshold = 0.3;   // G-force threshold for hard acceleration (default: +0.3g)

        // Detected hard braking/acceleration events
        this.hardBrakeEvents = [];  // Array of { time, gForce, severity }
        this.hardAccelEvents = [];  // Array of { time, gForce, severity }

        // Storage keys for hard event thresholds
        this.BRAKE_THRESHOLD_KEY = 'teslacamviewer_hard_brake_threshold';
        this.ACCEL_THRESHOLD_KEY = 'teslacamviewer_hard_accel_threshold';

        // Canvases
        this.speedCanvas = null;
        this.gforceCanvas = null;
        this.steeringCanvas = null;
        this.elevationCanvas = null;

        // Callbacks
        this.onSeek = null; // (eventTime) => void
        this.getEventTime = null; // () => number
        this.getSpeedLimit = null; // () => { limit, limitMph, limitKph } or null
        this.getSeiData = null; // () => Map - raw SEI data from telemetryOverlay
        this.getEventTimestamp = null; // () => string - event timestamp for filename

        // Current speed limit data
        this.currentSpeedLimit = null;

        // Dragging - use percentage-based positioning like mini-map
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.dragStartPosX = 0;
        this.dragStartPosY = 0;
        this.position = { x: 1, y: null }; // Default: bottom-left (x=1%, bottom anchor)

        // Resizing
        this.isResizing = false;
        this.resizeDirection = null; // 'horizontal', 'vertical', 'both'
        this.minWidth = 280;
        this.maxWidth = 600;
        this.minHeight = 180; // Minimum to fit all 4 graphs plus stats
        this.maxHeight = 400;

        // Animation
        this.animationFrame = null;

        // Storage
        this.ENABLED_KEY = 'teslacamviewer_graphs_enabled';
        this.POSITION_KEY = 'teslacamviewer_graphs_position';
        this.SIZE_KEY = 'teslacamviewer_graphs_size';

        // Anomaly label elements
        this.speedAnomalyCount = null;
        this.gforceAnomalyCount = null;
        this.steeringAnomalyCount = null;

        // Bind methods
        this._update = this._update.bind(this);
        this._onCanvasClick = this._onCanvasClick.bind(this);
        this._onHeaderMouseDown = this._onHeaderMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onResizeMouseDown = this._onResizeMouseDown.bind(this);
        this._onResizeMouseMove = this._onResizeMouseMove.bind(this);
        this._onResizeMouseUp = this._onResizeMouseUp.bind(this);
        this._onWindowResize = this._onWindowResize.bind(this);

        this._init();
    }

    _init() {
        this._loadThresholds();
        this._createContainer();
        this._setupPanelCollapse();
        window.addEventListener('resize', this._onWindowResize);
    }

    /**
     * Setup sidebar panel collapse functionality
     */
    _setupPanelCollapse() {
        const panel = document.getElementById('telemetryPanel');
        const header = document.getElementById('telemetryHeader');

        if (!panel || !header) return;

        // Load collapsed state
        const COLLAPSED_KEY = 'teslacamviewer_telemetry_collapsed';
        const isCollapsed = localStorage.getItem(COLLAPSED_KEY) === 'true';
        if (isCollapsed) {
            panel.classList.add('collapsed');
        }

        // Toggle collapse on header click
        header.addEventListener('click', () => {
            panel.classList.toggle('collapsed');
            localStorage.setItem(COLLAPSED_KEY, panel.classList.contains('collapsed'));

            // Re-setup canvases if expanding
            if (!panel.classList.contains('collapsed') && this.isVisible) {
                setTimeout(() => {
                    this._setupCanvases();
                    this._drawAllGraphs();
                }, 300); // Wait for CSS transition
            }
        });
    }

    _onWindowResize() {
        if (this.isVisible) {
            // Debounce position clamping and canvas setup
            // Don't call _updateSize() on window resize - respect user's saved size
            clearTimeout(this._resizeTimeout);
            this._resizeTimeout = setTimeout(() => {
                this._clampPosition();
                this._setupCanvases();
                this._drawAllGraphs();
            }, 100);
        }
    }

    _updateSize() {
        const parent = this.container.parentElement;
        if (!parent) return;

        // Scale like mini-map: base size on a 1920px wide container
        const parentWidth = parent.clientWidth || 1920;
        const scale = parentWidth / 1920;

        // Base size is 360x200 at 1920px (wider than tall for better graph display)
        const baseWidth = 360;
        const baseHeight = 200;

        // Calculate scaled size with minimum floors to ensure all 4 graphs fit
        const minWidth = 280;  // Minimum to show graph labels and values
        const minHeight = 180; // Minimum to show header + stats + 4 graph rows

        const newWidth = Math.max(minWidth, Math.round(baseWidth * scale));
        const newHeight = Math.max(minHeight, Math.round(baseHeight * scale));

        // Apply scaled size
        this.container.style.width = `${newWidth}px`;
        this.container.style.height = `${newHeight}px`;

        // Store current size
        this.currentWidth = newWidth;
        this.currentHeight = newHeight;

        // Scale font sizes proportionally (but keep fixed widths for layout stability)
        const headerFontSize = Math.max(7, Math.round(10 * scale));
        const labelFontSize = Math.max(6, Math.round(8 * scale));
        const valueFontSize = Math.max(7, Math.round(9 * scale));
        const titleFontSize = Math.max(8, Math.round(10 * scale));

        // Update header fonts
        if (this.statsContainer) {
            this.statsContainer.style.fontSize = `${headerFontSize}px`;
        }

        // Update title
        const title = this.container.querySelector('.telemetry-header span');
        if (title) {
            title.style.fontSize = `${titleFontSize}px`;
        }

        // Update graph row fonts only (keep widths fixed for layout stability)
        if (this.speedValue) this.speedValue.style.fontSize = `${valueFontSize}px`;
        if (this.gforceValue) this.gforceValue.style.fontSize = `${valueFontSize}px`;
        if (this.steeringValue) this.steeringValue.style.fontSize = `${valueFontSize}px`;
        if (this.elevationValue) this.elevationValue.style.fontSize = `${valueFontSize}px`;
    }

    _clampPosition() {
        const parent = this.container.parentElement;
        if (!parent) return;

        const parentWidth = parent.clientWidth;
        const parentHeight = parent.clientHeight;

        // Use stored size or current computed size
        const containerWidth = this.currentWidth || this.container.offsetWidth;
        const containerHeight = this.currentHeight || this.container.offsetHeight;

        // Calculate container size as percentage of parent
        const containerWidthPercent = (containerWidth / parentWidth) * 100;
        const containerHeightPercent = (containerHeight / parentHeight) * 100;

        // Clamp position to keep overlay within bounds
        if (this.position.x !== undefined) {
            this.position.x = Math.max(0, Math.min(100 - containerWidthPercent, this.position.x));
        }
        if (this.position.y !== null && this.position.y !== undefined) {
            this.position.y = Math.max(0, Math.min(100 - containerHeightPercent, this.position.y));
        }

        this._applyPosition();
    }

    /**
     * Get the current theme's accent color
     */
    _getAccentColor() {
        const computedStyle = getComputedStyle(document.body);
        return computedStyle.getPropertyValue('--accent').trim() || '#00d4ff';
    }

    /**
     * Get color for G-force based on Z-axis (bump intensity)
     * Smooth road = orange, bumps = brighter toward yellow/white
     * @param {number} zMagnitude - Absolute Z-axis acceleration in g
     */
    _getGforceBumpColor(zMagnitude) {
        // Base orange: #ff9100, Yellow: #ffeb3b, White: #ffffff
        // 0g = smooth (orange)
        // 0.05g = slight bump (orange-yellow)
        // 0.1g = medium bump (yellow)
        // 0.2g+ = large bump (bright yellow-white)

        if (zMagnitude <= 0.02) {
            return '#ff9100'; // Base orange - smooth road
        } else if (zMagnitude <= 0.08) {
            // Orange to yellow gradient
            const t = (zMagnitude - 0.02) / 0.06;
            return this._lerpColor('#ff9100', '#ffc107', t);
        } else if (zMagnitude <= 0.15) {
            // Yellow to bright yellow
            const t = (zMagnitude - 0.08) / 0.07;
            return this._lerpColor('#ffc107', '#ffeb3b', t);
        } else {
            // Bright yellow to white for big bumps
            const t = Math.min(1, (zMagnitude - 0.15) / 0.15);
            return this._lerpColor('#ffeb3b', '#ffffff', t);
        }
    }

    /**
     * Linear interpolation between two hex colors
     */
    _lerpColor(color1, color2, t) {
        const c1 = this._hexToRgb(color1);
        const c2 = this._hexToRgb(color2);
        const r = Math.round(c1.r + (c2.r - c1.r) * t);
        const g = Math.round(c1.g + (c2.g - c1.g) * t);
        const b = Math.round(c1.b + (c2.b - c1.b) * t);
        return `rgb(${r}, ${g}, ${b})`;
    }

    _hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : { r: 0, g: 0, b: 0 };
    }

    /**
     * Get color for throttle position
     * Low throttle = dim green, High throttle = bright green
     * @param {number} throttle - Throttle position 0-1
     */
    _getThrottleColor(throttle) {
        // Dim green: #22c55e at low throttle
        // Bright green: #4ade80 at high throttle
        // Very bright: #86efac at full throttle
        if (throttle <= 0.3) {
            // Low throttle: dim to medium green
            const t = throttle / 0.3;
            return this._lerpColor('#166534', '#22c55e', t);
        } else if (throttle <= 0.7) {
            // Medium throttle: medium to bright green
            const t = (throttle - 0.3) / 0.4;
            return this._lerpColor('#22c55e', '#4ade80', t);
        } else {
            // High throttle: bright to very bright green
            const t = (throttle - 0.7) / 0.3;
            return this._lerpColor('#4ade80', '#86efac', t);
        }
    }

    /**
     * Get color for road grade (elevation change)
     * Green = flat, Yellow = moderate, Orange = steep, Red = very steep
     * Blue tones for descents
     * @param {number} grade - Road grade percentage (positive = uphill, negative = downhill)
     */
    _getGradeColor(grade) {
        const absGrade = Math.abs(grade);

        if (grade >= 0) {
            // Uphill: green -> yellow -> orange -> red
            if (absGrade <= 3) {
                return '#4ade80'; // Green - flat
            } else if (absGrade <= 6) {
                const t = (absGrade - 3) / 3;
                return this._lerpColor('#4ade80', '#facc15', t); // Green to yellow
            } else if (absGrade <= 10) {
                const t = (absGrade - 6) / 4;
                return this._lerpColor('#facc15', '#f97316', t); // Yellow to orange
            } else {
                const t = Math.min(1, (absGrade - 10) / 5);
                return this._lerpColor('#f97316', '#ef4444', t); // Orange to red
            }
        } else {
            // Downhill: green -> cyan -> blue
            if (absGrade <= 3) {
                return '#4ade80'; // Green - flat
            } else if (absGrade <= 6) {
                const t = (absGrade - 3) / 3;
                return this._lerpColor('#4ade80', '#22d3ee', t); // Green to cyan
            } else if (absGrade <= 10) {
                const t = (absGrade - 6) / 4;
                return this._lerpColor('#22d3ee', '#3b82f6', t); // Cyan to blue
            } else {
                const t = Math.min(1, (absGrade - 10) / 5);
                return this._lerpColor('#3b82f6', '#6366f1', t); // Blue to indigo
            }
        }
    }

    _createContainer() {
        // Create container for sidebar integration (no floating overlay style)
        this.container = document.createElement('div');
        this.container.className = 'telemetry-graphs-sidebar';
        this.container.style.cssText = `
            user-select: none;
            background: transparent;
            width: 100%;
            height: 100%;
            display: none;
            flex-direction: column;
            font-family: system-ui, -apple-system, sans-serif;
            overflow: hidden;
        `;

        // Header with stats and buttons (no dragging) - compact for sidebar
        const header = document.createElement('div');
        header.className = 'telemetry-graphs-header';
        header.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 2px 6px;
            background: rgba(255, 255, 255, 0.03);
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            flex-shrink: 0;
        `;

        const titleSection = document.createElement('div');
        titleSection.style.cssText = 'display: flex; align-items: center; gap: 6px;';

        const title = document.createElement('span');
        title.style.cssText = 'font-size: 10px; font-weight: 500; color: rgba(255,255,255,0.7);';
        title.textContent = 'Telemetry';
        titleSection.appendChild(title);

        // Data coverage indicator
        this.coverageIndicator = document.createElement('span');
        this.coverageIndicator.style.cssText = 'font-size: 9px; color: rgba(255,255,255,0.4);';
        titleSection.appendChild(this.coverageIndicator);

        header.appendChild(titleSection);

        // Stats summary
        this.statsContainer = document.createElement('div');
        this.statsContainer.style.cssText = `
            display: flex;
            flex-wrap: wrap;
            gap: 4px 8px;
            font-size: 9px;
            color: rgba(255,255,255,0.5);
            overflow: hidden;
            max-height: 28px;
            flex: 1;
            justify-content: flex-end;
        `;
        header.appendChild(this.statsContainer);

        // Button container for header actions
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; align-items: center; gap: 4px;';

        // Anomaly toggle button
        this.anomalyToggleBtn = document.createElement('button');
        this.anomalyToggleBtn.className = 'telemetry-anomaly-toggle-btn';
        this.anomalyToggleBtn.title = 'Toggle anomaly markers';
        this.anomalyToggleBtn.style.cssText = `
            background: none;
            border: none;
            color: rgba(255, 255, 255, 0.4);
            cursor: pointer;
            padding: 2px;
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        // Warning triangle icon
        this.anomalyToggleBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
        </svg>`;
        this._updateAnomalyToggleButton();
        this.anomalyToggleBtn.addEventListener('mouseenter', () => {
            if (this.showAnomalies) {
                this.anomalyToggleBtn.style.color = '#ffc107';
            } else {
                this.anomalyToggleBtn.style.color = '#fff';
            }
        });
        this.anomalyToggleBtn.addEventListener('mouseleave', () => this._updateAnomalyToggleButton());
        this.anomalyToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleAnomalies();
        });
        buttonContainer.appendChild(this.anomalyToggleBtn);

        // Export CSV button
        const exportBtn = document.createElement('button');
        exportBtn.className = 'telemetry-export-btn';
        exportBtn.title = 'Export telemetry data as CSV';
        exportBtn.style.cssText = `
            background: none;
            border: none;
            color: rgba(255, 255, 255, 0.4);
            cursor: pointer;
            padding: 2px;
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        exportBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
        </svg>`;
        exportBtn.addEventListener('mouseenter', () => exportBtn.style.color = '#fff');
        exportBtn.addEventListener('mouseleave', () => exportBtn.style.color = 'rgba(255, 255, 255, 0.4)');
        exportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._exportCSV();
        });
        buttonContainer.appendChild(exportBtn);

        header.appendChild(buttonContainer);

        this.container.appendChild(header);

        // Graphs content area - compact layout
        this.graphsContent = document.createElement('div');
        this.graphsContent.className = 'telemetry-graphs-content';
        this.graphsContent.style.cssText = `
            padding: 4px 6px;
            display: flex;
            flex-direction: column;
            gap: 2px;
            overflow: hidden;
            flex: 1;
        `;

        // Create four graph rows
        this._createGraphRow('Speed', 'speed');
        this._createGraphRow('G-Force', 'gforce');
        this._createGraphRow('Steering', 'steering');
        this._createGraphRow('Elevation', 'elevation');

        this.container.appendChild(this.graphsContent);

        // No resize handles or dragging for sidebar mode
    }

    _createGraphRow(label, type) {
        const row = document.createElement('div');
        row.style.cssText = `
            display: flex;
            align-items: center;
            gap: 4px;
            flex: 1 1 0;
            min-height: 20px;
            height: 100%;
            overflow: hidden;
        `;

        // Label container (includes anomaly count)
        const labelContainer = document.createElement('div');
        labelContainer.style.cssText = `
            width: 38px;
            font-size: 8px;
            color: rgba(255,255,255,0.45);
            text-align: right;
            flex-shrink: 0;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 1px;
        `;

        // Label text
        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        labelContainer.appendChild(labelEl);

        // Anomaly count (hidden by default)
        const anomalyCountEl = document.createElement('span');
        anomalyCountEl.style.cssText = `
            font-size: 7px;
            color: #ffc107;
            display: none;
        `;
        anomalyCountEl.textContent = '';
        labelContainer.appendChild(anomalyCountEl);

        // Store reference to anomaly count element
        if (type === 'speed') {
            this.speedAnomalyCount = anomalyCountEl;
        } else if (type === 'gforce') {
            this.gforceAnomalyCount = anomalyCountEl;
        } else if (type === 'steering') {
            this.steeringAnomalyCount = anomalyCountEl;
        }

        row.appendChild(labelContainer);

        // Canvas
        const canvas = document.createElement('canvas');
        canvas.style.cssText = `
            flex: 1;
            min-width: 0;
            height: 100%;
            background: rgba(0,0,0,0.25);
            border-radius: 2px;
            cursor: crosshair;
        `;
        canvas.addEventListener('click', (e) => this._onCanvasClick(e, canvas, type));
        row.appendChild(canvas);

        // Value display
        const valueEl = document.createElement('div');
        valueEl.style.cssText = `
            width: 42px;
            font-size: 9px;
            font-family: var(--font-mono, monospace);
            color: ${this._getAccentColor()};
            text-align: left;
            flex-shrink: 0;
        `;
        valueEl.textContent = '--';
        row.appendChild(valueEl);

        this.graphsContent.appendChild(row);

        // Store references
        if (type === 'speed') {
            this.speedCanvas = canvas;
            this.speedValue = valueEl;
        } else if (type === 'gforce') {
            this.gforceCanvas = canvas;
            this.gforceValue = valueEl;
        } else if (type === 'steering') {
            this.steeringCanvas = canvas;
            this.steeringValue = valueEl;
        } else if (type === 'elevation') {
            this.elevationCanvas = canvas;
            this.elevationValue = valueEl;
        }
    }

    // Dragging functionality - only from header (percentage-based like mini-map)
    _onHeaderMouseDown(e) {
        if (e.target.tagName === 'BUTTON') return;

        this.isDragging = true;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.dragStartPosX = this.position.x;
        this.dragStartPosY = this.position.y;

        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);
        e.preventDefault();
    }

    _onMouseMove(e) {
        if (!this.isDragging) return;

        const parent = this.container.parentElement;
        if (!parent) return;

        const parentRect = parent.getBoundingClientRect();
        const containerWidth = this.currentWidth || this.container.offsetWidth;
        const containerHeight = this.currentHeight || this.container.offsetHeight;

        // Calculate delta in percentage
        const deltaX = ((e.clientX - this.dragStartX) / parentRect.width) * 100;
        const deltaY = ((e.clientY - this.dragStartY) / parentRect.height) * 100;

        // Calculate new position
        let newX = this.dragStartPosX + deltaX;
        let newY = this.dragStartPosY + deltaY;

        // Constrain to bounds (with container size consideration)
        const containerWidthPercent = (containerWidth / parentRect.width) * 100;
        const containerHeightPercent = (containerHeight / parentRect.height) * 100;

        newX = Math.max(0, Math.min(100 - containerWidthPercent, newX));
        newY = Math.max(0, Math.min(100 - containerHeightPercent, newY));

        this.position.x = newX;
        this.position.y = newY;
        this._applyPosition();
    }

    _onMouseUp() {
        if (this.isDragging) {
            this.isDragging = false;
            this._savePosition();
        }
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
    }

    _applyPosition() {
        this.container.style.left = `${this.position.x}%`;
        if (this.position.y !== null) {
            this.container.style.top = `${this.position.y}%`;
            this.container.style.bottom = 'auto';
        } else {
            // Default: anchor to bottom
            this.container.style.top = 'auto';
            this.container.style.bottom = '10px';
        }
    }

    // Resize functionality
    _onResizeMouseDown(e, direction) {
        this.isResizing = true;
        this.resizeDirection = direction;
        this.resizeStartX = e.clientX;
        this.resizeStartY = e.clientY;
        this.resizeStartWidth = this.container.offsetWidth;
        this.resizeStartHeight = this.container.offsetHeight;

        document.addEventListener('mousemove', this._onResizeMouseMove);
        document.addEventListener('mouseup', this._onResizeMouseUp);
        e.preventDefault();
        e.stopPropagation();
    }

    _onResizeMouseMove(e) {
        if (!this.isResizing) return;

        const deltaX = e.clientX - this.resizeStartX;
        const deltaY = e.clientY - this.resizeStartY;

        if (this.resizeDirection === 'horizontal' || this.resizeDirection === 'both') {
            let newWidth = this.resizeStartWidth + deltaX;
            newWidth = Math.max(this.minWidth, Math.min(this.maxWidth, newWidth));
            this.container.style.width = newWidth + 'px';
        }

        if (this.resizeDirection === 'vertical' || this.resizeDirection === 'both') {
            let newHeight = this.resizeStartHeight + deltaY;
            newHeight = Math.max(this.minHeight, Math.min(this.maxHeight, newHeight));
            this.container.style.height = newHeight + 'px';
        }

        // Re-setup canvases for new size
        this._setupCanvases();
    }

    _onResizeMouseUp() {
        if (this.isResizing) {
            this.isResizing = false;
            this._saveSize();
            this._setupCanvases();
            this._drawAllGraphs();
        }
        document.removeEventListener('mousemove', this._onResizeMouseMove);
        document.removeEventListener('mouseup', this._onResizeMouseUp);
    }

    _saveSize() {
        const size = {
            width: this.container.offsetWidth,
            height: this.container.offsetHeight
        };
        localStorage.setItem(this.SIZE_KEY, JSON.stringify(size));
    }

    _loadSize() {
        try {
            const saved = localStorage.getItem(this.SIZE_KEY);
            if (saved) {
                const size = JSON.parse(saved);
                let loaded = false;
                if (size.width >= this.minWidth && size.width <= this.maxWidth) {
                    this.container.style.width = size.width + 'px';
                    this.currentWidth = size.width;
                    loaded = true;
                }
                if (size.height >= this.minHeight && size.height <= this.maxHeight) {
                    this.container.style.height = size.height + 'px';
                    this.currentHeight = size.height;
                    loaded = true;
                }
                return loaded;
            }
        } catch (e) {
            // Ignore parse errors
        }
        return false;
    }

    _savePosition() {
        const pos = { x: this.position.x, y: this.position.y };
        localStorage.setItem(this.POSITION_KEY, JSON.stringify(pos));
    }

    _loadPosition() {
        try {
            const saved = localStorage.getItem(this.POSITION_KEY);
            if (saved) {
                const pos = JSON.parse(saved);
                if (typeof pos.x === 'number') this.position.x = pos.x;
                if (typeof pos.y === 'number') this.position.y = pos.y;
            }
            this._applyPosition();
        } catch (e) {
            // Use defaults
            this._applyPosition();
        }
    }

    /**
     * Show the graphs in sidebar panel
     */
    show() {
        if (this.isVisible) return;

        // Append to sidebar container if not already there
        if (!this.container.parentElement) {
            const sidebarContent = document.getElementById('telemetryContent');
            if (sidebarContent) {
                sidebarContent.appendChild(this.container);
            }
        }

        // Show the sidebar panel
        const panel = document.getElementById('telemetryPanel');
        if (panel) {
            panel.style.display = '';
        }

        this.container.style.display = 'flex';
        this.container.style.flexDirection = 'column';
        this.isVisible = true;
        this._setupCanvases();
        this._startAnimation();

        // Notify visibility change
        if (this.onVisibilityChange) {
            this.onVisibilityChange(true);
        }
    }

    /**
     * Hide the graphs sidebar panel
     */
    hide() {
        this.container.style.display = 'none';
        this.isVisible = false;
        this._stopAnimation();

        // Hide the sidebar panel
        const panel = document.getElementById('telemetryPanel');
        if (panel) {
            panel.style.display = 'none';
        }

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

    _setupCanvases() {
        [this.speedCanvas, this.gforceCanvas, this.steeringCanvas, this.elevationCanvas].forEach(canvas => {
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                canvas.width = rect.width * 2;
                canvas.height = rect.height * 2;
                const ctx = canvas.getContext('2d');
                ctx.scale(2, 2);
            }
        });
    }

    /**
     * Check if graphs were enabled in previous session
     */
    wasEnabled() {
        return localStorage.getItem(this.ENABLED_KEY) === 'true';
    }

    /**
     * Load telemetry data from all clips
     * @param {Object} clipSeiData - Map of clip index to SEI data
     * @param {number} totalDuration - Total event duration
     */
    loadData(clipSeiData, totalDuration) {
        this.totalDuration = totalDuration;

        if (!clipSeiData || Object.keys(clipSeiData).length === 0) {
            this.graphData = null;
            this._updateStats(null);
            return;
        }

        // Combine all frames from all clips into a single timeline
        const allPoints = [];
        let minTime = Infinity;
        let maxTime = -Infinity;

        const clipDuration = 60; // Approximate clip duration in seconds

        // clipSeiData is indexed by clip number
        Object.keys(clipSeiData).sort((a, b) => parseInt(a) - parseInt(b)).forEach(clipIndexStr => {
            const clipIndex = parseInt(clipIndexStr);
            const clipData = clipSeiData[clipIndexStr];
            if (!clipData?.frames || clipData.frames.length === 0) return;

            const frameCount = clipData.frames.length;
            const baseTime = clipIndex * clipDuration;

            // Sample frames (every ~5 seconds of video = every ~180 frames at 36fps)
            const sampleInterval = Math.max(1, Math.floor(frameCount / 12));

            for (let i = 0; i < frameCount; i += sampleInterval) {
                const frame = clipData.frames[i];

                const frameRatio = i / frameCount;
                const timeInClip = frameRatio * clipDuration;
                const eventTime = baseTime + timeInClip;

                const point = {
                    time: eventTime,
                    speed_mph: frame.speed_mph || 0,
                    speed_kph: frame.speed_kph || 0,
                    g_force_x: frame.g_force_x || 0,
                    g_force_y: frame.g_force_y || 0,
                    g_force_z: frame.g_force_z || 0,
                    steering_angle: frame.steering_wheel_angle || 0,
                    autopilot: frame.autopilot_name || 'NONE',
                    brake: frame.brake_applied || false,
                    throttle: frame.accelerator_pedal_position || 0,
                    latitude: frame.latitude_deg || 0,
                    longitude: frame.longitude_deg || 0
                };
                allPoints.push(point);
                minTime = Math.min(minTime, point.time);
                maxTime = Math.max(maxTime, point.time);
            }
        });

        if (allPoints.length === 0) {
            this.graphData = null;
            this._updateStats(null);
            return;
        }

        // Sort by time
        allPoints.sort((a, b) => a.time - b.time);

        // Sample if too many points
        const sampledPoints = allPoints.length > 500
            ? this._samplePoints(allPoints, 500)
            : allPoints;

        this.graphData = {
            points: sampledPoints,
            startTime: minTime,
            endTime: maxTime,
            dataDuration: maxTime - minTime
        };

        // Update coverage indicator
        const coveragePercent = Math.round((this.graphData.dataDuration / totalDuration) * 100);
        if (coveragePercent < 95) {
            this.coverageIndicator.textContent = `(${coveragePercent}%)`;
        } else {
            this.coverageIndicator.textContent = '';
        }

        // Calculate and show stats
        this._updateStats(allPoints);

        // Detect near-miss incidents
        this._detectNearMisses(allPoints);

        // Detect phantom braking events (AP braking without driver input)
        this._detectPhantomBraking(allPoints);

        // Detect hard braking/acceleration events
        this._detectHardEvents(allPoints);

        // Detect anomalies (speed changes, g-force spikes, steering movements)
        this._detectAnomalies(allPoints);

        // Redraw
        this._drawAllGraphs();
    }

    /**
     * Set elevation profile data
     * @param {Object} profile - Elevation profile from ElevationService
     * @param {number} totalDuration - Total event duration in seconds
     */
    setElevationProfile(profile, totalDuration = 0) {
        this.elevationProfile = profile;
        if (totalDuration > 0) {
            this.totalDuration = totalDuration;
        }
        // Re-render stats to include elevation min/max
        this._renderStats(this.graphData?.points || null);
        this._drawAllGraphs();
    }

    /**
     * Set speed limit profile data
     * @param {Object} profile - Speed limit profile: { points: [{time, limitMph, limitKph}], startTime, endTime }
     */
    setSpeedLimitProfile(profile) {
        this.speedLimitProfile = profile;
        this._drawAllGraphs();
    }

    /**
     * Get speed limit at a specific time from the profile
     * @param {number} time - Event time in seconds
     * @returns {Object|null} - { limitMph, limitKph } or null
     */
    _getSpeedLimitAtTime(time) {
        if (!this.speedLimitProfile?.points?.length) return null;

        const points = this.speedLimitProfile.points;

        // Binary search for closest point
        let left = 0;
        let right = points.length - 1;

        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (points[mid].time < time) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        // Check neighbors for closest
        if (left > 0 && Math.abs(points[left - 1].time - time) < Math.abs(points[left].time - time)) {
            return points[left - 1];
        }
        return points[left];
    }

    _samplePoints(points, maxPoints) {
        if (points.length <= maxPoints) return points;
        const sampled = [];
        const step = (points.length - 1) / (maxPoints - 1);
        for (let i = 0; i < maxPoints; i++) {
            sampled.push(points[Math.round(i * step)]);
        }
        return sampled;
    }

    _updateStats(allPoints) {
        this.tripStats = this._calculateTripStats(allPoints);
        this._renderStats(allPoints);
    }

    /**
     * Calculate trip statistics from all data points
     * @param {Array} allPoints - Array of telemetry data points with lat/lng, speed, autopilot
     * @returns {Object} Trip statistics
     */
    _calculateTripStats(allPoints) {
        if (!allPoints || allPoints.length < 2) {
            return null;
        }

        // Calculate total distance using Haversine formula
        let totalDistanceMiles = 0;
        let totalDistanceKm = 0;

        for (let i = 1; i < allPoints.length; i++) {
            const prev = allPoints[i - 1];
            const curr = allPoints[i];

            // Check for valid GPS coordinates
            if (prev.latitude && prev.longitude && curr.latitude && curr.longitude &&
                prev.latitude !== 0 && prev.longitude !== 0 &&
                curr.latitude !== 0 && curr.longitude !== 0) {
                const dist = this._haversineDistance(
                    prev.latitude, prev.longitude,
                    curr.latitude, curr.longitude
                );
                totalDistanceMiles += dist.miles;
                totalDistanceKm += dist.km;
            }
        }

        // Calculate speed statistics
        const speedsMph = allPoints.map(p => p.speed_mph || 0).filter(s => s > 0);
        const speedsKph = allPoints.map(p => p.speed_kph || 0).filter(s => s > 0);

        const maxSpeedMph = speedsMph.length > 0 ? Math.max(...speedsMph) : 0;
        const maxSpeedKph = speedsKph.length > 0 ? Math.max(...speedsKph) : 0;
        const avgSpeedMph = speedsMph.length > 0 ? speedsMph.reduce((a, b) => a + b, 0) / speedsMph.length : 0;
        const avgSpeedKph = speedsKph.length > 0 ? speedsKph.reduce((a, b) => a + b, 0) / speedsKph.length : 0;

        // Calculate autopilot usage percentage
        const apFrames = allPoints.filter(p => p.autopilot && p.autopilot !== 'NONE').length;
        const apPercent = allPoints.length > 0 ? Math.round((apFrames / allPoints.length) * 100) : 0;

        // Calculate smoothness score
        const smoothnessScore = this._calculateSmoothnessScore(allPoints);

        return {
            totalDistanceMiles,
            totalDistanceKm,
            maxSpeedMph,
            maxSpeedKph,
            avgSpeedMph,
            avgSpeedKph,
            apPercent,
            smoothnessScore
        };
    }

    /**
     * Calculate driving smoothness score (0-100)
     * Based on variance of rate-of-change for steering, acceleration, and lateral G-force
     * Higher score = smoother driving
     * @param {Array} allPoints - Array of telemetry data points
     * @returns {Object|null} Smoothness scores: { overall, steering, accel, lateral }
     */
    _calculateSmoothnessScore(allPoints) {
        if (!allPoints || allPoints.length < 3) {
            return null;
        }

        // Calculate rate-of-change (first derivative) for each metric
        const steeringChanges = [];
        const speedChanges = [];
        const lateralGChanges = [];

        for (let i = 1; i < allPoints.length; i++) {
            const prev = allPoints[i - 1];
            const curr = allPoints[i];

            // Time delta (use index difference as proxy if times are close)
            const timeDelta = curr.time - prev.time;
            if (timeDelta <= 0 || timeDelta > 10) continue; // Skip invalid/large gaps

            // Steering angle change rate (degrees per second)
            const steeringDelta = Math.abs(curr.steering_angle - prev.steering_angle);
            steeringChanges.push(steeringDelta / timeDelta);

            // Speed change rate (mph per second = acceleration)
            const speedDelta = curr.speed_mph - prev.speed_mph;
            speedChanges.push(Math.abs(speedDelta) / timeDelta);

            // Lateral G-force change rate (g per second = jerk)
            const lateralDelta = curr.g_force_y - prev.g_force_y;
            lateralGChanges.push(Math.abs(lateralDelta) / timeDelta);
        }

        if (steeringChanges.length < 2) {
            return null;
        }

        // Calculate standard deviation for each metric
        const steeringStd = this._standardDeviation(steeringChanges);
        const accelStd = this._standardDeviation(speedChanges);
        const lateralStd = this._standardDeviation(lateralGChanges);

        // Convert standard deviations to 0-100 scores
        // Lower std = higher score (smoother)
        // Use exponential decay to map std to score
        // Tuned thresholds based on typical driving data:
        // - Steering: 0-50 deg/s^2 std is normal, >100 is erratic
        // - Accel: 0-5 mph/s^2 std is normal, >15 is aggressive
        // - Lateral G: 0-0.1 g/s std is normal, >0.3 is jerky

        const steeringScore = this._stdToScore(steeringStd, 30); // k=30 for steering
        const accelScore = this._stdToScore(accelStd, 3);        // k=3 for acceleration
        const lateralScore = this._stdToScore(lateralStd, 0.15); // k=0.15 for lateral G

        // Weighted average for overall score
        // Lateral G is most perceptible to passengers, so weight it higher
        const overall = Math.round(
            steeringScore * 0.25 +
            accelScore * 0.35 +
            lateralScore * 0.40
        );

        return {
            overall: Math.max(0, Math.min(100, overall)),
            steering: Math.round(steeringScore),
            accel: Math.round(accelScore),
            lateral: Math.round(lateralScore)
        };
    }

    /**
     * Calculate standard deviation of an array of numbers
     * @param {Array<number>} values - Array of numeric values
     * @returns {number} Standard deviation
     */
    _standardDeviation(values) {
        if (!values || values.length < 2) return 0;

        const n = values.length;
        const mean = values.reduce((a, b) => a + b, 0) / n;
        const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / n;

        return Math.sqrt(variance);
    }

    /**
     * Convert standard deviation to a 0-100 score using exponential decay
     * @param {number} std - Standard deviation value
     * @param {number} k - Decay constant (higher = more lenient)
     * @returns {number} Score from 0-100
     */
    _stdToScore(std, k) {
        // Score = 100 * e^(-std/k)
        // At std=0, score=100 (perfect)
        // At std=k, score~37 (threshold)
        // At std=2k, score~14
        // At std=3k, score~5
        return 100 * Math.exp(-std / k);
    }

    /**
     * Get color for smoothness score
     * Green (80+), Yellow (50-79), Red (<50)
     * @param {number} score - Smoothness score 0-100
     * @returns {string} Color hex code
     */
    _getSmoothnessColor(score) {
        if (score >= 80) {
            return '#4ade80'; // Green
        } else if (score >= 50) {
            return '#facc15'; // Yellow
        } else {
            return '#ef4444'; // Red
        }
    }

    /**
     * Calculate distance between two GPS coordinates using Haversine formula
     * @param {number} lat1 - Latitude of first point
     * @param {number} lon1 - Longitude of first point
     * @param {number} lat2 - Latitude of second point
     * @param {number} lon2 - Longitude of second point
     * @returns {Object} Distance in miles and kilometers
     */
    _haversineDistance(lat1, lon1, lat2, lon2) {
        const R_MILES = 3959; // Earth's radius in miles
        const R_KM = 6371;    // Earth's radius in kilometers

        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;

        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) ** 2;

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return {
            miles: R_MILES * c,
            km: R_KM * c
        };
    }

    _renderStats(allPoints) {
        const parts = [];

        // Trip statistics (distance, avg/max speed, AP usage)
        if (this.tripStats) {
            const isMetric = this.units === 'kph';

            // Total distance
            const distance = isMetric ? this.tripStats.totalDistanceKm : this.tripStats.totalDistanceMiles;
            const distanceUnit = isMetric ? 'km' : 'mi';
            if (distance > 0.1) {
                parts.push(`<span><b>${distance.toFixed(1)}</b>${distanceUnit}</span>`);
            }

            // Average speed
            const avgSpeed = isMetric ? this.tripStats.avgSpeedKph : this.tripStats.avgSpeedMph;
            if (avgSpeed > 0) {
                parts.push(`<span>Avg <b>${Math.round(avgSpeed)}</b></span>`);
            }

            // Max speed
            const maxSpeed = isMetric ? this.tripStats.maxSpeedKph : this.tripStats.maxSpeedMph;
            if (maxSpeed > 0) {
                parts.push(`<span>Max <b style="color: ${this._getAccentColor()}">${Math.round(maxSpeed)}</b></span>`);
            }

            // Autopilot percentage
            if (this.tripStats.apPercent > 0) {
                parts.push(`<span>AP <b style="color: #0078ff">${this.tripStats.apPercent}%</b></span>`);
            }

            // Smoothness score
            if (this.tripStats.smoothnessScore) {
                const score = this.tripStats.smoothnessScore;
                const color = this._getSmoothnessColor(score.overall);
                const tooltip = `Steering: ${score.steering}, Accel: ${score.accel}, Lateral: ${score.lateral}`;
                parts.push(`<span title="${tooltip}" style="cursor: help;">Smooth: <b style="color: ${color}">${score.overall}</b></span>`);
            }
        }

        // Elevation stats (if elevation profile available)
        if (this.elevationProfile && this.elevationProfile.minElevation !== undefined) {
            const useFeet = this._useFeet();
            const minElev = this.elevationProfile.minElevation;
            const maxElev = this.elevationProfile.maxElevation;

            const minFormatted = window.elevationService?.formatElevation(minElev, useFeet) ||
                (useFeet ? `${Math.round(minElev * 3.28084)} ft` : `${Math.round(minElev)} m`);
            const maxFormatted = window.elevationService?.formatElevation(maxElev, useFeet) ||
                (useFeet ? `${Math.round(maxElev * 3.28084)} ft` : `${Math.round(maxElev)} m`);

            parts.push(`<span>↓<b>${minFormatted}</b></span>`);
            parts.push(`<span>↑<b>${maxFormatted}</b></span>`);
        }

        // Near-miss summary (score >= 5 flagged as potential near-misses)
        const flaggedNearMisses = this.nearMisses.filter(nm => nm.score >= 5);
        if (flaggedNearMisses.length > 0) {
            const maxScore = Math.max(...flaggedNearMisses.map(nm => nm.score));
            const color = this._getNearMissColor(maxScore);
            parts.push(`<span title="Near-miss incidents detected">Near-miss: <b style="color: ${color}">${flaggedNearMisses.length}</b> (max: <b style="color: ${color}">${maxScore.toFixed(1)}</b>)</span>`);
        }

        // Phantom braking summary (AP braking without driver input)
        if (this.showAnomalies && this.phantomBrakes && this.phantomBrakes.length > 0) {
            const criticalCount = this.phantomBrakes.filter(pb => pb.severity === 'critical').length;
            const warningCount = this.phantomBrakes.filter(pb => pb.severity === 'warning').length;
            const totalCount = this.phantomBrakes.length;

            // Determine color based on worst severity
            let color;
            if (criticalCount > 0) {
                color = '#ff3b3b'; // Red for critical
            } else if (warningCount > 0) {
                color = '#ff9100'; // Orange for warning
            } else {
                color = '#ffc107'; // Yellow for info
            }

            const severityBreakdown = criticalCount > 0 || warningCount > 0
                ? ` (${criticalCount > 0 ? criticalCount + ' crit' : ''}${criticalCount > 0 && warningCount > 0 ? ', ' : ''}${warningCount > 0 ? warningCount + ' warn' : ''})`
                : '';

            parts.push(`<span title="Phantom braking: unexpected deceleration while on Autopilot without driver brake input">Phantom: <b style="color: ${color}">${totalCount}</b>${severityBreakdown}</span>`);
        }

        // Hard braking/acceleration summary (if anomalies are enabled)
        if (this.showAnomalies && (this.hardBrakeEvents.length > 0 || this.hardAccelEvents.length > 0)) {
            const brakeCount = this.hardBrakeEvents.length;
            const accelCount = this.hardAccelEvents.length;
            let hardEventText = '';

            if (brakeCount > 0 && accelCount > 0) {
                hardEventText = `<span title="Hard braking/acceleration events"><b style="color: #ef4444">${brakeCount}</b> brakes, <b style="color: #22c55e">${accelCount}</b> accels</span>`;
            } else if (brakeCount > 0) {
                hardEventText = `<span title="Hard braking events"><b style="color: #ef4444">${brakeCount}</b> hard brake${brakeCount > 1 ? 's' : ''}</span>`;
            } else if (accelCount > 0) {
                hardEventText = `<span title="Hard acceleration events"><b style="color: #22c55e">${accelCount}</b> hard accel${accelCount > 1 ? 's' : ''}</span>`;
            }

            if (hardEventText) {
                parts.push(hardEventText);
            }
        }

        if (parts.length === 0) {
            this.statsContainer.innerHTML = '<span style="color: rgba(255,255,255,0.3);">No data</span>';
        } else {
            this.statsContainer.innerHTML = parts.join('');
        }
    }

    /**
     * Clear data
     */
    clear() {
        this.graphData = null;
        this.elevationProfile = null;
        this.speedLimitProfile = null;
        this.nearMisses = [];
        this.phantomBrakes = [];
        this.hardBrakeEvents = [];
        this.hardAccelEvents = [];
        this.totalDuration = 0;
        this.coverageIndicator.textContent = '';
        this.statsContainer.innerHTML = '';
        // Hide anomaly count
        if (this.gforceAnomalyCount) {
            this.gforceAnomalyCount.style.display = 'none';
        }
        this._drawAllGraphs();
    }

    _startAnimation() {
        if (this.animationFrame) return;
        const animate = () => {
            this._update();
            this.animationFrame = requestAnimationFrame(animate);
        };
        this.animationFrame = requestAnimationFrame(animate);
    }

    _stopAnimation() {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
    }

    _update() {
        if (!this.isVisible) return;

        // Get current time
        if (this.getEventTime) {
            this.currentTime = this.getEventTime();
        }

        this._drawAllGraphs();
        this._updateCurrentValues();
    }

    _updateCurrentValues() {
        // Get current speed limit
        if (this.getSpeedLimit) {
            this.currentSpeedLimit = this.getSpeedLimit();
        }

        // Telemetry values
        if (!this.graphData || !this.graphData.points.length) {
            this.speedValue.textContent = '--';
            this.speedValue.style.color = this._getAccentColor();
            this.gforceValue.textContent = '--';
            this.steeringValue.textContent = '--';
        } else {
            const point = this._getPointAtTime(this.currentTime);
            if (point) {
                const speed = this.units === 'mph' ? point.speed_mph : point.speed_kph;

                // Show speed with limit if available
                if (this.currentSpeedLimit && this.currentSpeedLimit.limit !== null) {
                    const limit = this.units === 'mph' ? this.currentSpeedLimit.limitMph : this.currentSpeedLimit.limitKph;
                    this.speedValue.textContent = `${Math.round(speed)}/${limit}`;

                    // Color based on over-limit
                    const overLimitData = this.units === 'mph'
                        ? window.speedLimitService?.calculateOverLimit(speed, this.currentSpeedLimit)
                        : window.speedLimitService?.calculateOverLimitKph(speed, this.currentSpeedLimit);

                    if (overLimitData && overLimitData.color) {
                        this.speedValue.style.color = overLimitData.color;
                        this.speedValue.style.fontWeight = overLimitData.isBold ? '700' : '400';
                    } else {
                        this.speedValue.style.color = this._getAccentColor();
                        this.speedValue.style.fontWeight = '400';
                    }
                } else {
                    this.speedValue.textContent = `${Math.round(speed)}`;
                    this.speedValue.style.color = this._getAccentColor();
                    this.speedValue.style.fontWeight = '400';
                }

                this.gforceValue.textContent = `${point.g_force_y.toFixed(2)}g`;
                this.steeringValue.textContent = `${Math.round(point.steering_angle)}°`;
            }
        }

        // Elevation value
        if (!this.elevationProfile || !this.elevationProfile.points) {
            this.elevationValue.textContent = '--';
        } else {
            const elevData = window.elevationService?.getElevationAtTime(this.elevationProfile, this.currentTime);
            if (elevData) {
                const useFeet = this._useFeet();
                const formatted = window.elevationService.formatElevation(elevData.elevation, useFeet);
                this.elevationValue.textContent = formatted;
            } else {
                this.elevationValue.textContent = '--';
            }
        }
    }

    _useFeet() {
        const locale = navigator.language || 'en-US';
        return locale.includes('US') || locale.includes('GB') || locale.includes('LR') || locale.includes('MM');
    }

    _getPointAtTime(time) {
        if (!this.graphData?.points?.length) return null;

        const points = this.graphData.points;

        // Binary search for closest point
        let left = 0;
        let right = points.length - 1;

        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (points[mid].time < time) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        // Check neighbors for closest
        if (left > 0 && Math.abs(points[left - 1].time - time) < Math.abs(points[left].time - time)) {
            return points[left - 1];
        }
        return points[left];
    }

    _drawAllGraphs() {
        this._drawGraph(this.speedCanvas, 'speed');
        this._drawGraph(this.gforceCanvas, 'gforce');
        this._drawGraph(this.steeringCanvas, 'steering');
        this._drawElevationGraph();
    }

    _drawGraph(canvas, type) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const width = canvas.width / 2;
        const height = canvas.height / 2;

        // Clear
        ctx.clearRect(0, 0, width, height);

        if (!this.graphData || !this.graphData.points.length) {
            ctx.fillStyle = 'rgba(255,255,255,0.2)';
            ctx.font = '8px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('No data', width / 2, height / 2 + 2);
            return;
        }

        const points = this.graphData.points;
        const dataStartTime = this.graphData.startTime;
        const dataDuration = this.graphData.dataDuration;

        // Get values and range based on type
        let values, minVal, maxVal, color, lineWidth;

        switch (type) {
            case 'speed':
                values = points.map(p => this.units === 'mph' ? p.speed_mph : p.speed_kph);
                minVal = 0;
                maxVal = Math.max(80, Math.max(...values) * 1.1);
                color = this._getAccentColor();
                lineWidth = 1;
                break;
            case 'gforce':
                values = points.map(p => p.g_force_y);
                minVal = -0.8;
                maxVal = 0.8;
                color = '#ff9100';
                lineWidth = 1;
                break;
            case 'steering':
                values = points.map(p => p.steering_angle);
                minVal = -180;
                maxVal = 180;
                color = '#69f0ae';
                lineWidth = 1;
                break;
        }

        const range = maxVal - minVal;
        const padding = { left: 1, right: 1, top: 2, bottom: 2 };
        const graphWidth = width - padding.left - padding.right;
        const graphHeight = height - padding.top - padding.bottom;

        // Draw zero line for g-force and steering
        if (type === 'gforce' || type === 'steering') {
            const zeroY = padding.top + (1 - (0 - minVal) / range) * graphHeight;
            ctx.beginPath();
            ctx.moveTo(padding.left, zeroY);
            ctx.lineTo(width - padding.right, zeroY);
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Draw data line - special handling for steering (AP color), speed (limit color), and gforce (Z-axis bumps)
        if (type === 'steering') {
            const apColor = '#0078ff';
            const manualColor = '#69f0ae';

            for (let i = 1; i < points.length; i++) {
                const prevPoint = points[i - 1];
                const currPoint = points[i];

                const x1 = padding.left + ((prevPoint.time - dataStartTime) / dataDuration) * graphWidth;
                const y1 = padding.top + (1 - (values[i - 1] - minVal) / range) * graphHeight;
                const x2 = padding.left + ((currPoint.time - dataStartTime) / dataDuration) * graphWidth;
                const y2 = padding.top + (1 - (values[i] - minVal) / range) * graphHeight;

                const isAP = currPoint.autopilot !== 'NONE' || prevPoint.autopilot !== 'NONE';

                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.strokeStyle = isAP ? apColor : manualColor;
                ctx.lineWidth = lineWidth;
                ctx.stroke();
            }
        } else if (type === 'gforce') {
            // G-force graph colored by Z-axis (vertical acceleration / bumps)
            // Base color is orange, bumps make it brighter toward yellow/white
            for (let i = 1; i < points.length; i++) {
                const prevPoint = points[i - 1];
                const currPoint = points[i];

                const x1 = padding.left + ((prevPoint.time - dataStartTime) / dataDuration) * graphWidth;
                const y1 = padding.top + (1 - (values[i - 1] - minVal) / range) * graphHeight;
                const x2 = padding.left + ((currPoint.time - dataStartTime) / dataDuration) * graphWidth;
                const y2 = padding.top + (1 - (values[i] - minVal) / range) * graphHeight;

                // Get Z-axis magnitude (bumps) - average of segment
                const avgZ = Math.abs((prevPoint.g_force_z + currPoint.g_force_z) / 2);

                // Color based on Z-axis intensity
                // 0g = smooth (orange), 0.1g = yellow, 0.2g+ = white/bright
                const bumpColor = this._getGforceBumpColor(avgZ);

                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.strokeStyle = bumpColor;
                ctx.lineWidth = avgZ > 0.15 ? lineWidth * 1.5 : lineWidth;
                ctx.stroke();
            }

            // Draw hard event markers (triangles) after the line
            this._drawHardEventMarkers(ctx, width, height, padding, graphWidth, graphHeight, dataStartTime, dataDuration, minVal, range);
        } else if (type === 'speed') {
            // Speed graph with throttle/brake coloring
            // Brake = red, Throttle = green (intensity), Coasting = accent color
            // Line thickness increases when over speed limit
            for (let i = 1; i < points.length; i++) {
                const prevPoint = points[i - 1];
                const currPoint = points[i];

                const x1 = padding.left + ((prevPoint.time - dataStartTime) / dataDuration) * graphWidth;
                const y1 = padding.top + (1 - (values[i - 1] - minVal) / range) * graphHeight;
                const x2 = padding.left + ((currPoint.time - dataStartTime) / dataDuration) * graphWidth;
                const y2 = padding.top + (1 - (values[i] - minVal) / range) * graphHeight;

                // Get throttle/brake state (average of segment)
                const avgThrottle = (prevPoint.throttle + currPoint.throttle) / 2;
                const isBraking = prevPoint.brake || currPoint.brake;

                // Determine color based on throttle/brake
                let segmentColor;
                if (isBraking) {
                    // Brake = red
                    segmentColor = '#ef4444';
                } else if (avgThrottle > 0.02) {
                    // Throttle = green with intensity
                    segmentColor = this._getThrottleColor(avgThrottle);
                } else {
                    // Coasting = accent color
                    segmentColor = color;
                }

                // Check speed limit for line thickness
                let segmentWidth = lineWidth;
                if (this.currentSpeedLimit && this.currentSpeedLimit.limit !== null) {
                    const avgSpeed = (values[i - 1] + values[i]) / 2;
                    const overLimitData = this.units === 'mph'
                        ? window.speedLimitService?.calculateOverLimit(avgSpeed, this.currentSpeedLimit)
                        : window.speedLimitService?.calculateOverLimitKph(avgSpeed, this.currentSpeedLimit);

                    if (overLimitData && overLimitData.isBold) {
                        segmentWidth = lineWidth * 2;
                    } else if (overLimitData && overLimitData.overBy > 5) {
                        segmentWidth = lineWidth * 1.5;
                    }
                }

                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.strokeStyle = segmentColor;
                ctx.lineWidth = segmentWidth;
                ctx.stroke();
            }
        } else {
            ctx.beginPath();
            for (let i = 0; i < points.length; i++) {
                const x = padding.left + ((points[i].time - dataStartTime) / dataDuration) * graphWidth;
                const y = padding.top + (1 - (values[i] - minVal) / range) * graphHeight;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth;
            ctx.stroke();
        }

        // Draw speed limit reference line for speed graph
        if (type === 'speed') {
            // Use speed limit profile if available, otherwise fall back to current speed limit
            if (this.speedLimitProfile?.points?.length > 1) {
                // Draw varying speed limit line from profile
                const limitPoints = this.speedLimitProfile.points;
                const profileStartTime = this.speedLimitProfile.startTime || limitPoints[0].time;
                const profileEndTime = this.speedLimitProfile.endTime || limitPoints[limitPoints.length - 1].time;
                const profileDuration = profileEndTime - profileStartTime;

                ctx.setLineDash([4, 3]);
                ctx.strokeStyle = 'rgba(255, 100, 100, 0.6)';
                ctx.lineWidth = 1;

                let lastDrawnLimit = null;
                for (let i = 1; i < limitPoints.length; i++) {
                    const prevPoint = limitPoints[i - 1];
                    const currPoint = limitPoints[i];

                    // Skip if points are null/undefined
                    if (!prevPoint || !currPoint) {
                        continue;
                    }

                    const prevLimit = this.units === 'mph' ? prevPoint.limitMph : prevPoint.limitKph;
                    const currLimit = this.units === 'mph' ? currPoint.limitMph : currPoint.limitKph;

                    // Skip if either limit is null/undefined
                    if (prevLimit === null || prevLimit === undefined || currLimit === null || currLimit === undefined) {
                        continue;
                    }

                    // Skip if limit is outside visible range
                    if ((prevLimit < minVal && currLimit < minVal) || (prevLimit > maxVal && currLimit > maxVal)) {
                        continue;
                    }

                    // Calculate x positions based on time
                    const x1 = padding.left + ((prevPoint.time - dataStartTime) / dataDuration) * graphWidth;
                    const x2 = padding.left + ((currPoint.time - dataStartTime) / dataDuration) * graphWidth;

                    // Clamp to graph bounds
                    if (x2 < padding.left || x1 > width - padding.right) continue;

                    const clampedLimit1 = Math.max(minVal, Math.min(maxVal, prevLimit));
                    const clampedLimit2 = Math.max(minVal, Math.min(maxVal, currLimit));

                    const y1 = padding.top + (1 - (clampedLimit1 - minVal) / range) * graphHeight;
                    const y2 = padding.top + (1 - (clampedLimit2 - minVal) / range) * graphHeight;

                    ctx.beginPath();
                    ctx.moveTo(Math.max(padding.left, x1), y1);
                    ctx.lineTo(Math.min(width - padding.right, x2), y2);
                    ctx.stroke();

                    lastDrawnLimit = currLimit;
                }

                ctx.setLineDash([]);

                // Draw label for current speed limit at playhead position
                if (this.currentSpeedLimit && this.currentSpeedLimit.limit !== null && this.currentSpeedLimit.limitMph !== undefined) {
                    const currentLimit = this.units === 'mph' ? this.currentSpeedLimit.limitMph : this.currentSpeedLimit.limitKph;
                    if (currentLimit !== null && currentLimit !== undefined && currentLimit >= minVal && currentLimit <= maxVal) {
                        const labelY = padding.top + (1 - (currentLimit - minVal) / range) * graphHeight;
                        ctx.font = '7px system-ui';
                        ctx.fillStyle = 'rgba(255, 100, 100, 0.8)';
                        ctx.textAlign = 'right';
                        ctx.fillText(`${currentLimit}`, width - padding.right - 2, labelY - 2);
                    }
                }
            } else if (this.currentSpeedLimit && this.currentSpeedLimit.limit !== null) {
                // Fall back to single horizontal line if no profile
                const limit = this.units === 'mph' ? this.currentSpeedLimit.limitMph : this.currentSpeedLimit.limitKph;

                if (limit >= minVal && limit <= maxVal) {
                    const limitY = padding.top + (1 - (limit - minVal) / range) * graphHeight;

                    ctx.beginPath();
                    ctx.moveTo(padding.left, limitY);
                    ctx.lineTo(width - padding.right, limitY);
                    ctx.strokeStyle = 'rgba(255, 100, 100, 0.6)';
                    ctx.lineWidth = 1;
                    ctx.setLineDash([4, 3]);
                    ctx.stroke();
                    ctx.setLineDash([]);

                    ctx.font = '7px system-ui';
                    ctx.fillStyle = 'rgba(255, 100, 100, 0.8)';
                    ctx.textAlign = 'right';
                    ctx.fillText(`${limit}`, width - padding.right - 2, limitY - 2);
                }
            }
        }

        // Draw phantom braking markers on speed graph
        if (type === 'speed') {
            this._drawPhantomBrakeMarkers(ctx, width, height, padding, graphWidth, graphHeight, dataStartTime, dataDuration, minVal, range);
        }

        // Draw anomaly markers for speed, gforce, and steering graphs
        if (type === 'speed' || type === 'gforce' || type === 'steering') {
            this._drawAnomalyMarkers(ctx, type, width, height, padding, graphWidth, graphHeight, dataStartTime, dataDuration);
        }

        // Draw playhead
        if (this.currentTime >= dataStartTime && this.currentTime <= this.graphData.endTime) {
            const playheadX = padding.left + ((this.currentTime - dataStartTime) / dataDuration) * graphWidth;

            ctx.beginPath();
            ctx.moveTo(playheadX, padding.top);
            ctx.lineTo(playheadX, height - padding.bottom);
            ctx.strokeStyle = 'rgba(255,255,255,0.5)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 2]);
            ctx.stroke();
            ctx.setLineDash([]);

            // Playhead dot
            const currentPoint = this._getPointAtTime(this.currentTime);
            if (currentPoint) {
                let val;
                switch (type) {
                    case 'speed':
                        val = this.units === 'mph' ? currentPoint.speed_mph : currentPoint.speed_kph;
                        break;
                    case 'gforce':
                        val = currentPoint.g_force_y;
                        break;
                    case 'steering':
                        val = currentPoint.steering_angle;
                        break;
                }
                const dotY = padding.top + (1 - (val - minVal) / range) * graphHeight;

                ctx.beginPath();
                ctx.arc(playheadX, dotY, 2, 0, Math.PI * 2);
                ctx.fillStyle = '#fff';
                ctx.fill();
            }
        }
    }

    _drawElevationGraph() {
        const canvas = this.elevationCanvas;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const width = canvas.width / 2;
        const height = canvas.height / 2;

        // Clear
        ctx.clearRect(0, 0, width, height);

        if (!this.elevationProfile || !this.elevationProfile.points || this.elevationProfile.points.length < 2) {
            ctx.fillStyle = 'rgba(255,255,255,0.2)';
            ctx.font = '8px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('No data', width / 2, height / 2 + 2);
            return;
        }

        const points = this.elevationProfile.points;
        const minElev = this.elevationProfile.minElevation;
        const maxElev = this.elevationProfile.maxElevation;
        const range = maxElev - minElev || 1;

        const padding = { left: 1, right: 1, top: 2, bottom: 2 };
        const graphWidth = width - padding.left - padding.right;
        const graphHeight = height - padding.top - padding.bottom;

        const accentColor = this._getAccentColor();

        // Draw filled area
        const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
        gradient.addColorStop(0, accentColor + '30');
        gradient.addColorStop(1, accentColor + '05');

        ctx.beginPath();
        ctx.moveTo(padding.left, height - padding.bottom);

        for (let i = 0; i < points.length; i++) {
            const x = padding.left + (i / (points.length - 1)) * graphWidth;
            const y = padding.top + (1 - (points[i].elevation - minElev) / range) * graphHeight;
            ctx.lineTo(x, y);
        }

        ctx.lineTo(padding.left + graphWidth, height - padding.bottom);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // Draw line with grade-based coloring
        // Calculate grade between points and color accordingly
        for (let i = 1; i < points.length; i++) {
            const prevPoint = points[i - 1];
            const currPoint = points[i];

            const x1 = padding.left + ((i - 1) / (points.length - 1)) * graphWidth;
            const y1 = padding.top + (1 - (prevPoint.elevation - minElev) / range) * graphHeight;
            const x2 = padding.left + (i / (points.length - 1)) * graphWidth;
            const y2 = padding.top + (1 - (currPoint.elevation - minElev) / range) * graphHeight;

            // Calculate grade percentage
            // Use distance if available, otherwise estimate from time
            let grade = 0;
            const elevChange = currPoint.elevation - prevPoint.elevation;

            if (prevPoint.distance !== undefined && currPoint.distance !== undefined) {
                const distChange = currPoint.distance - prevPoint.distance;
                if (distChange > 0) {
                    grade = (elevChange / distChange) * 100;
                }
            } else if (prevPoint.time !== undefined && currPoint.time !== undefined) {
                // Estimate distance from time (assume ~30 mph average = ~13.4 m/s)
                const timeChange = currPoint.time - prevPoint.time;
                const estDistance = timeChange * 13.4; // meters
                if (estDistance > 0) {
                    grade = (elevChange / estDistance) * 100;
                }
            }

            // Clamp grade to reasonable range (-20% to +20%)
            grade = Math.max(-20, Math.min(20, grade));

            const gradeColor = this._getGradeColor(grade);

            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.strokeStyle = gradeColor;
            ctx.lineWidth = Math.abs(grade) > 8 ? 1.5 : 1;
            ctx.stroke();
        }

        // Draw playhead
        const dataStartTime = this.elevationProfile.startTime || 0;
        const dataEndTime = this.elevationProfile.endTime || this.totalDuration;
        const dataDuration = dataEndTime - dataStartTime;

        if (dataDuration > 0 && this.currentTime >= dataStartTime && this.currentTime <= dataEndTime) {
            const timeRatio = (this.currentTime - dataStartTime) / dataDuration;
            const playheadX = padding.left + timeRatio * graphWidth;

            ctx.beginPath();
            ctx.moveTo(playheadX, padding.top);
            ctx.lineTo(playheadX, height - padding.bottom);
            ctx.strokeStyle = 'rgba(255,255,255,0.5)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 2]);
            ctx.stroke();
            ctx.setLineDash([]);

            // Playhead dot
            const elevData = window.elevationService?.getElevationAtTime(this.elevationProfile, this.currentTime);
            if (elevData) {
                const dotY = padding.top + (1 - (elevData.elevation - minElev) / range) * graphHeight;
                ctx.beginPath();
                ctx.arc(playheadX, dotY, 2, 0, Math.PI * 2);
                ctx.fillStyle = '#fff';
                ctx.fill();
            }
        }
    }

    _onCanvasClick(e, canvas, type) {
        if (!this.onSeek) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const width = rect.width;

        const padding = { left: 1, right: 1 };
        const graphWidth = width - padding.left - padding.right;

        if (x < padding.left || x > width - padding.right) return;

        const ratio = (x - padding.left) / graphWidth;

        // Use appropriate data source for time calculation
        let seekTime;
        if (type === 'elevation' && this.elevationProfile) {
            const dataStartTime = this.elevationProfile.startTime || 0;
            const dataEndTime = this.elevationProfile.endTime || this.totalDuration;
            const dataDuration = dataEndTime - dataStartTime;
            seekTime = dataStartTime + (ratio * dataDuration);
        } else if (this.graphData) {
            seekTime = this.graphData.startTime + (ratio * this.graphData.dataDuration);
        } else {
            return;
        }

        this.onSeek(seekTime);
    }

    /**
     * Set units (mph or kph)
     */
    setUnits(units) {
        this.units = units;
        // Re-render stats with new units (tripStats already calculated)
        if (this.tripStats || this.elevationProfile) {
            this._renderStats(null);
        }
    }

    /**
     * Export telemetry data as CSV
     * Generates a CSV file with all SEI telemetry data points
     */
    _exportCSV() {
        // Get raw SEI data from callback
        if (!this.getSeiData) {
            console.warn('[TelemetryGraphs] No getSeiData callback configured');
            alert('Export failed: Telemetry data system not initialized.');
            return;
        }

        const clipSeiData = this.getSeiData();
        console.log('[TelemetryGraphs] Export - clipSeiData type:',
            clipSeiData instanceof Map ? 'Map' : typeof clipSeiData,
            'size:', clipSeiData instanceof Map ? clipSeiData.size : Object.keys(clipSeiData || {}).length);

        if (!clipSeiData || (clipSeiData instanceof Map && clipSeiData.size === 0) ||
            (!(clipSeiData instanceof Map) && typeof clipSeiData === 'object' && Object.keys(clipSeiData).length === 0)) {
            console.warn('[TelemetryGraphs] No SEI data available for export');
            alert('No telemetry data available to export.\n\nMake sure you have played or loaded a video clip first.');
            return;
        }

        // Collect all frames with timing information
        const allRows = [];
        const clipDuration = 60; // Approximate clip duration in seconds

        // Handle both Map and plain object formats
        const entries = clipSeiData instanceof Map
            ? Array.from(clipSeiData.entries())
            : Object.entries(clipSeiData);

        console.log('[TelemetryGraphs] Export - processing', entries.length, 'clip entries');

        // Sort by clip index
        entries.sort((a, b) => {
            const indexA = typeof a[0] === 'string' ? parseInt(a[0].split('_')[0]) : a[0];
            const indexB = typeof b[0] === 'string' ? parseInt(b[0].split('_')[0]) : b[0];
            return indexA - indexB;
        });

        for (const [key, clipData] of entries) {
            if (!clipData?.frames || clipData.frames.length === 0) {
                console.log('[TelemetryGraphs] Skipping clip', key, '- no frames');
                continue;
            }

            const clipIndex = typeof key === 'string' ? parseInt(key.split('_')[0]) : key;
            const baseTime = clipIndex * clipDuration;
            const frameCount = clipData.frames.length;

            for (let i = 0; i < frameCount; i++) {
                const frame = clipData.frames[i];
                const frameRatio = i / frameCount;
                const timeInClip = frameRatio * clipDuration;
                const eventTime = baseTime + timeInClip;

                allRows.push({
                    timestamp: eventTime.toFixed(3),
                    speed_mph: (frame.speed_mph || 0).toFixed(2),
                    speed_kph: (frame.speed_kph || 0).toFixed(2),
                    latitude: (frame.latitude_deg || 0).toFixed(6),
                    longitude: (frame.longitude_deg || 0).toFixed(6),
                    heading_deg: (frame.heading_deg || 0).toFixed(2),
                    g_force_x: (frame.g_force_x || 0).toFixed(4),
                    g_force_y: (frame.g_force_y || 0).toFixed(4),
                    steering_angle: (frame.steering_wheel_angle || 0).toFixed(2),
                    throttle: (frame.accelerator_pedal_position || 0).toFixed(3),
                    brake: frame.brake_applied ? '1' : '0',
                    turn_signal: frame.turn_signal_name || 'NONE',
                    gear: frame.gear_name || 'D',
                    autopilot_state: frame.autopilot_name || 'NONE'
                });
            }
        }

        if (allRows.length === 0) {
            console.warn('[TelemetryGraphs] No data rows to export');
            alert('No telemetry data rows found in the loaded clips.\n\nTry playing through more of the video to load telemetry data.');
            return;
        }

        // Build CSV content
        const headers = [
            'timestamp',
            'speed_mph',
            'speed_kph',
            'latitude',
            'longitude',
            'heading_deg',
            'g_force_x',
            'g_force_y',
            'steering_angle',
            'throttle',
            'brake',
            'turn_signal',
            'gear',
            'autopilot_state'
        ];

        let csv = headers.join(',') + '\n';

        for (const row of allRows) {
            csv += headers.map(h => row[h]).join(',') + '\n';
        }

        // Generate filename with event timestamp
        let filename = 'telemetry';
        if (this.getEventTimestamp) {
            const timestamp = this.getEventTimestamp();
            if (timestamp) {
                // Convert ISO timestamp to filename-safe format: 2025-12-30_10-59
                const formatted = timestamp
                    .replace(/T/, '_')
                    .replace(/:/g, '-')
                    .replace(/\.\d{3}Z?$/, '')
                    .replace(/Z$/, '');
                filename = `telemetry_${formatted}`;
            }
        } else {
            // Fallback: use current date/time
            const now = new Date();
            const dateStr = now.toISOString()
                .replace(/T/, '_')
                .replace(/:/g, '-')
                .replace(/\.\d{3}Z$/, '');
            filename = `telemetry_${dateStr}`;
        }

        // Create and trigger download
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${filename}.csv`;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        console.log(`[TelemetryGraphs] Exported ${allRows.length} telemetry data points to ${filename}.csv`);
    }

    /**
     * Detect near-miss incidents by combining hard braking and evasive steering
     * within a 2-second window. Calculates composite score from 1-10.
     * @param {Array} allPoints - All telemetry data points
     */
    _detectNearMisses(allPoints) {
        this.nearMisses = [];

        if (!allPoints || allPoints.length < 3) {
            this._updateNearMissSummary();
            return;
        }

        // Thresholds for detection
        const HARD_BRAKE_THRESHOLD = 0.25; // g (longitudinal deceleration)
        const EVASIVE_STEER_THRESHOLD = 20; // degrees per second
        const COMBINE_WINDOW = 2.0; // seconds to look for combined events
        const SPEED_THRESHOLD = 5; // mph minimum speed for near-miss

        // First pass: identify hard brake events
        const hardBrakeEvents = [];
        for (let i = 1; i < allPoints.length; i++) {
            const point = allPoints[i];

            // Check longitudinal G-force (Y-axis is typically forward/backward)
            // Negative Y indicates deceleration (braking)
            const brakeG = Math.abs(Math.min(0, point.g_force_y));

            if (brakeG >= HARD_BRAKE_THRESHOLD && point.speed_mph >= SPEED_THRESHOLD) {
                hardBrakeEvents.push({
                    time: point.time,
                    brakeG: brakeG,
                    speed: point.speed_mph,
                    index: i
                });
            }
        }

        // Second pass: identify rapid steering events
        const evasiveSteerEvents = [];
        for (let i = 1; i < allPoints.length; i++) {
            const point = allPoints[i];
            const prevPoint = allPoints[i - 1];

            const timeDelta = point.time - prevPoint.time;
            if (timeDelta <= 0) continue;

            const steeringRate = Math.abs(point.steering_angle - prevPoint.steering_angle) / timeDelta;

            if (steeringRate >= EVASIVE_STEER_THRESHOLD && point.speed_mph >= SPEED_THRESHOLD) {
                evasiveSteerEvents.push({
                    time: point.time,
                    steeringRate: steeringRate,
                    speed: point.speed_mph,
                    index: i
                });
            }
        }

        // Third pass: combine events within time window
        const processedTimes = new Set();

        for (const brakeEvent of hardBrakeEvents) {
            // Skip if we've already processed a near-miss at this time
            const timeKey = Math.round(brakeEvent.time);
            if (processedTimes.has(timeKey)) continue;

            // Find nearby steering events within the window
            let maxSteeringRate = 0;
            let matchingSteerEvent = null;

            for (const steerEvent of evasiveSteerEvents) {
                const timeDiff = Math.abs(steerEvent.time - brakeEvent.time);
                if (timeDiff <= COMBINE_WINDOW) {
                    if (steerEvent.steeringRate > maxSteeringRate) {
                        maxSteeringRate = steerEvent.steeringRate;
                        matchingSteerEvent = steerEvent;
                    }
                }
            }

            // Calculate near-miss score
            // Formula: Base = |brake_g| * 10 + |steering_rate| / 10
            // Multiply by speed factor (higher speed = higher score)
            // Cap at 10
            let baseScore = brakeEvent.brakeG * 10 + maxSteeringRate / 10;

            // Speed factor: 1.0 at 30mph, 1.5 at 60mph, 2.0 at 90mph
            const speedFactor = 0.5 + (brakeEvent.speed / 60);

            let score = baseScore * speedFactor;
            score = Math.min(10, Math.max(1, Math.round(score * 10) / 10));

            // Only flag significant events (score >= 3 for potential incidents, 5+ for near-miss)
            if (score >= 3) {
                const severity = score >= 7 ? 'critical' : score >= 5 ? 'warning' : 'info';

                this.nearMisses.push({
                    time: brakeEvent.time,
                    score: score,
                    brakeG: brakeEvent.brakeG,
                    steeringRate: maxSteeringRate,
                    speed: brakeEvent.speed,
                    severity: severity,
                    hasEvasiveSteering: matchingSteerEvent !== null
                });

                processedTimes.add(timeKey);
            }
        }

        // Sort by time
        this.nearMisses.sort((a, b) => a.time - b.time);

        // Log detection results
        const highSeverity = this.nearMisses.filter(nm => nm.score >= 5);
        if (highSeverity.length > 0) {
            console.log(`[TelemetryGraphs] Detected ${highSeverity.length} near-miss incident(s) (score >= 5)`);
        }

        // Update summary display
        this._updateNearMissSummary();

        // Notify timeline if callback is set
        if (this.onNearMissesDetected) {
            this.onNearMissesDetected(this.nearMisses);
        }
    }

    /**
     * Get near-misses with score >= threshold
     * @param {number} minScore - Minimum score threshold (default 5)
     * @returns {Array} Near-miss incidents
     */
    getNearMisses(minScore = 5) {
        return this.nearMisses.filter(nm => nm.score >= minScore);
    }

    /**
     * Get color for near-miss severity
     * @param {number} score - Near-miss score (1-10)
     * @returns {string} Color hex code
     */
    _getNearMissColor(score) {
        if (score >= 7) {
            return '#ff3b3b'; // Critical - red
        } else if (score >= 5) {
            return '#ff9100'; // Warning - orange
        } else {
            return '#ffc107'; // Info - yellow
        }
    }

    /**
     * Update near-miss summary in stats display
     */
    _updateNearMissSummary() {
        // Re-render stats to include near-miss info
        this._renderStats(this.graphData?.points || null);
    }

    /**
     * Load saved thresholds from localStorage
     */
    _loadThresholds() {
        try {
            const savedBrake = localStorage.getItem(this.BRAKE_THRESHOLD_KEY);
            const savedAccel = localStorage.getItem(this.ACCEL_THRESHOLD_KEY);

            if (savedBrake !== null) {
                const val = parseFloat(savedBrake);
                if (!isNaN(val) && val < 0) {
                    this.hardBrakeThreshold = val;
                }
            }

            if (savedAccel !== null) {
                const val = parseFloat(savedAccel);
                if (!isNaN(val) && val > 0) {
                    this.hardAccelThreshold = val;
                }
            }

            // Load anomalies enabled state
            const savedAnomalies = localStorage.getItem(this.ANOMALIES_ENABLED_KEY);
            if (savedAnomalies !== null) {
                this.showAnomalies = savedAnomalies === 'true';
            }
        } catch (e) {
            // Use defaults if localStorage fails
        }
    }

    /**
     * Save thresholds to localStorage
     */
    _saveThresholds() {
        try {
            localStorage.setItem(this.BRAKE_THRESHOLD_KEY, this.hardBrakeThreshold.toString());
            localStorage.setItem(this.ACCEL_THRESHOLD_KEY, this.hardAccelThreshold.toString());
        } catch (e) {
            // Ignore storage errors
        }
    }

    /**
     * Set hard braking threshold
     * @param {number} threshold - G-force threshold (should be negative, e.g., -0.4)
     */
    setHardBrakeThreshold(threshold) {
        if (threshold < 0) {
            this.hardBrakeThreshold = threshold;
            this._saveThresholds();
            // Re-detect events if we have data
            if (this.graphData?.points?.length) {
                this._detectHardEvents(this.graphData.points);
                this._renderStats(this.graphData.points);
            }
        }
    }

    /**
     * Set hard acceleration threshold
     * @param {number} threshold - G-force threshold (should be positive, e.g., 0.3)
     */
    setHardAccelThreshold(threshold) {
        if (threshold > 0) {
            this.hardAccelThreshold = threshold;
            this._saveThresholds();
            // Re-detect events if we have data
            if (this.graphData?.points?.length) {
                this._detectHardEvents(this.graphData.points);
                this._renderStats(this.graphData.points);
            }
        }
    }

    /**
     * Detect hard braking and acceleration events from telemetry data
     * @param {Array} points - Array of telemetry data points with g_force_y
     */
    _detectHardEvents(points) {
        this.hardBrakeEvents = [];
        this.hardAccelEvents = [];

        if (!points || points.length < 2) {
            this._updateHardEventDisplay();
            return;
        }

        // Minimum time between events to avoid duplicates (seconds)
        const cooldownTime = 2.0;
        let lastBrakeTime = -Infinity;
        let lastAccelTime = -Infinity;

        for (let i = 0; i < points.length; i++) {
            const point = points[i];
            const gForceY = point.g_force_y || 0;
            const time = point.time;

            // Check for hard braking (negative g_force_y below threshold)
            if (gForceY <= this.hardBrakeThreshold && (time - lastBrakeTime) >= cooldownTime) {
                // Calculate severity: how far below threshold (0-1 scale)
                // -0.4g is threshold, -0.8g would be severity 1.0
                const severity = Math.min(1.0, (Math.abs(gForceY) - Math.abs(this.hardBrakeThreshold)) / 0.4);

                this.hardBrakeEvents.push({
                    time: time,
                    gForce: gForceY,
                    severity: severity
                });
                lastBrakeTime = time;
            }

            // Check for hard acceleration (positive g_force_y above threshold)
            if (gForceY >= this.hardAccelThreshold && (time - lastAccelTime) >= cooldownTime) {
                // Calculate severity: how far above threshold (0-1 scale)
                // 0.3g is threshold, 0.6g would be severity 1.0
                const severity = Math.min(1.0, (gForceY - this.hardAccelThreshold) / 0.3);

                this.hardAccelEvents.push({
                    time: time,
                    gForce: gForceY,
                    severity: severity
                });
                lastAccelTime = time;
            }
        }

        this._updateHardEventDisplay();

        console.log(`[TelemetryGraphs] Detected ${this.hardBrakeEvents.length} hard brakes, ${this.hardAccelEvents.length} hard accels`);
    }

    /**
     * Update hard event count display
     */
    _updateHardEventDisplay() {
        if (this.gforceAnomalyCount) {
            const totalEvents = this.hardBrakeEvents.length + this.hardAccelEvents.length;
            if (totalEvents > 0 && this.showAnomalies) {
                this.gforceAnomalyCount.textContent = `${totalEvents}`;
                this.gforceAnomalyCount.style.display = 'block';
            } else {
                this.gforceAnomalyCount.style.display = 'none';
            }
        }
    }

    /**
     * Toggle anomaly markers visibility
     */
    _toggleAnomalies() {
        this.showAnomalies = !this.showAnomalies;
        localStorage.setItem(this.ANOMALIES_ENABLED_KEY, this.showAnomalies.toString());
        this._updateAnomalyToggleButton();

        // Update anomaly count visibility
        this._updateHardEventDisplay();
        this._updateAnomalyCounts();

        // Redraw graphs to show/hide markers
        this._drawAllGraphs();
        // Re-render stats to show/hide counts
        this._renderStats(this.graphData?.points || null);
    }

    /**
     * Update the anomaly toggle button appearance based on state
     */
    _updateAnomalyToggleButton() {
        if (!this.anomalyToggleBtn) return;

        if (this.showAnomalies) {
            this.anomalyToggleBtn.style.color = '#ffc107';
            this.anomalyToggleBtn.title = 'Hide anomaly markers';
        } else {
            this.anomalyToggleBtn.style.color = 'rgba(255, 255, 255, 0.4)';
            this.anomalyToggleBtn.title = 'Show anomaly markers';
        }
    }

    /**
     * Detect anomalies in telemetry data
     */
    _detectAnomalies(allPoints) {
        this.anomalies = { speed: [], gforce: [], steering: [], elevation: [] };
        if (!allPoints || allPoints.length < 3) { this._updateAnomalyCounts(); return; }
        const thresholds = this.anomalyThresholds;
        for (let i = 1; i < allPoints.length; i++) {
            const prev = allPoints[i - 1], curr = allPoints[i];
            const timeDelta = curr.time - prev.time;
            if (timeDelta <= 0 || timeDelta > 10) continue;
            // Speed anomalies (>10 mph/sec change)
            const speedRate = Math.abs(curr.speed_mph - prev.speed_mph) / timeDelta;
            if (speedRate > thresholds.speed.suddenChange) {
                const severity = speedRate > thresholds.speed.suddenChange * 3 ? 3 : speedRate > thresholds.speed.suddenChange * 2 ? 2 : 1;
                this.anomalies.speed.push({ time: curr.time, value: speedRate, severity, description: `Speed: ${speedRate.toFixed(1)} mph/s` });
            }
            // G-Force anomalies (>0.3g)
            const gForceY = Math.abs(curr.g_force_y);
            if (gForceY > thresholds.gforce.spike) {
                const severity = gForceY > thresholds.gforce.spike * 2 ? 3 : gForceY > thresholds.gforce.spike * 1.5 ? 2 : 1;
                const lastG = this.anomalies.gforce[this.anomalies.gforce.length - 1];
                if (!lastG || curr.time - lastG.time > 2) {
                    this.anomalies.gforce.push({ time: curr.time, value: curr.g_force_y, severity, description: `G-Force: ${curr.g_force_y.toFixed(2)}g` });
                }
            }
            // Steering anomalies (>30 deg/sec)
            const steeringRate = Math.abs(curr.steering_angle - prev.steering_angle) / timeDelta;
            if (steeringRate > thresholds.steering.rapidMovement) {
                const severity = steeringRate > thresholds.steering.rapidMovement * 3 ? 3 : steeringRate > thresholds.steering.rapidMovement * 2 ? 2 : 1;
                const lastS = this.anomalies.steering[this.anomalies.steering.length - 1];
                if (!lastS || curr.time - lastS.time > 1) {
                    this.anomalies.steering.push({ time: curr.time, value: steeringRate, severity, description: `Steering: ${steeringRate.toFixed(0)} deg/s` });
                }
            }
        }
        this._updateAnomalyCounts();
    }

    /** Update anomaly count displays in graph row headers */
    _updateAnomalyCounts() {
        const update = (el, count) => { if (!el) return; el.style.display = count > 0 && this.showAnomalies ? 'block' : 'none'; el.textContent = `(${count})`; };
        update(this.speedAnomalyCount, this.anomalies.speed.length);
        update(this.gforceAnomalyCount, this.anomalies.gforce.length);
        update(this.steeringAnomalyCount, this.anomalies.steering.length);
    }

    /** Get anomaly marker color based on severity (1=yellow, 2=orange, 3=red) */
    _getAnomalyColor(severity) { return severity === 3 ? '#ff4444' : severity === 2 ? '#ff9800' : '#ffc107'; }

    /** Draw anomaly markers on a graph */
    _drawAnomalyMarkers(ctx, type, width, height, padding, graphWidth, graphHeight, dataStartTime, dataDuration) {
        if (!this.showAnomalies) return;
        const list = this.anomalies[type];
        if (!list || list.length === 0) return;
        for (const a of list) {
            const x = padding.left + ((a.time - dataStartTime) / dataDuration) * graphWidth;
            if (x < padding.left || x > width - padding.right) continue;
            const color = this._getAnomalyColor(a.severity);
            const size = 3 + a.severity;
            const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
            ctx.beginPath(); ctx.moveTo(x, padding.top); ctx.lineTo(x, height - padding.bottom);
            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.25)`; ctx.lineWidth = 1; ctx.stroke();
            const ty = padding.top + size;
            ctx.beginPath(); ctx.moveTo(x, ty - size); ctx.lineTo(x - size * 0.7, ty + size * 0.3); ctx.lineTo(x + size * 0.7, ty + size * 0.3);
            ctx.closePath(); ctx.fillStyle = color; ctx.fill();
            if (a.severity > 1) { ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.4)`; ctx.lineWidth = 1.5; ctx.stroke(); }
        }
    }

    /** Get anomaly at a click position */
    _getAnomalyAtPosition(clickTime, type, tolerance = 2) {
        const list = this.anomalies[type];
        if (!list) return null;
        for (const a of list) { if (Math.abs(a.time - clickTime) <= tolerance) return a; }
        return null;
    }

    /**
     * Draw hard event markers on the G-Force graph
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @param {Object} padding - Graph padding
     * @param {number} graphWidth - Graph width
     * @param {number} graphHeight - Graph height
     * @param {number} dataStartTime - Data start time
     * @param {number} dataDuration - Data duration
     * @param {number} minVal - Min Y value
     * @param {number} range - Y range
     */
    _drawHardEventMarkers(ctx, width, height, padding, graphWidth, graphHeight, dataStartTime, dataDuration, minVal, range) {
        if (!this.showAnomalies) return;

        // Draw hard braking markers (red triangles pointing down)
        for (const event of this.hardBrakeEvents) {
            const x = padding.left + ((event.time - dataStartTime) / dataDuration) * graphWidth;

            // Skip if outside visible area
            if (x < padding.left || x > width - padding.right) continue;

            // Triangle at the value position
            const valueY = padding.top + (1 - (event.gForce - minVal) / range) * graphHeight;
            const markerSize = 4 + event.severity * 2; // Size based on severity

            ctx.beginPath();
            ctx.moveTo(x, valueY - markerSize);
            ctx.lineTo(x - markerSize * 0.7, valueY + markerSize * 0.5);
            ctx.lineTo(x + markerSize * 0.7, valueY + markerSize * 0.5);
            ctx.closePath();

            // Color intensity based on severity
            const alpha = 0.7 + event.severity * 0.3;
            ctx.fillStyle = `rgba(239, 68, 68, ${alpha})`; // Red color (#ef4444)
            ctx.fill();

            // Add small glow for higher severity
            if (event.severity > 0.5) {
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }

        // Draw hard acceleration markers (green triangles pointing up)
        for (const event of this.hardAccelEvents) {
            const x = padding.left + ((event.time - dataStartTime) / dataDuration) * graphWidth;

            // Skip if outside visible area
            if (x < padding.left || x > width - padding.right) continue;

            // Triangle at the value position
            const valueY = padding.top + (1 - (event.gForce - minVal) / range) * graphHeight;
            const markerSize = 4 + event.severity * 2; // Size based on severity

            ctx.beginPath();
            ctx.moveTo(x, valueY + markerSize);
            ctx.lineTo(x - markerSize * 0.7, valueY - markerSize * 0.5);
            ctx.lineTo(x + markerSize * 0.7, valueY - markerSize * 0.5);
            ctx.closePath();

            // Color intensity based on severity
            const alpha = 0.7 + event.severity * 0.3;
            ctx.fillStyle = `rgba(34, 197, 94, ${alpha})`; // Green color (#22c55e)
            ctx.fill();

            // Add small glow for higher severity
            if (event.severity > 0.5) {
                ctx.strokeStyle = 'rgba(34, 197, 94, 0.3)';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }
    }

    /**
     * Get hard event at clicked position (for click-to-seek)
     * @param {number} clickTime - Time at click position
     * @param {number} tolerance - Time tolerance in seconds
     * @returns {Object|null} - Event object or null
     */
    _getHardEventAtTime(clickTime, tolerance = 3) {
        // Check brake events
        for (const event of this.hardBrakeEvents) {
            if (Math.abs(event.time - clickTime) <= tolerance) {
                return { type: 'brake', ...event };
            }
        }

        // Check accel events
        for (const event of this.hardAccelEvents) {
            if (Math.abs(event.time - clickTime) <= tolerance) {
                return { type: 'accel', ...event };
            }
        }

        return null;
    }

    /**
     * Get all hard events (for external access, e.g., by timeline)
     * @returns {Object} - { brakeEvents: [], accelEvents: [] }
     */
    getHardEvents() {
        return {
            brakeEvents: [...this.hardBrakeEvents],
            accelEvents: [...this.hardAccelEvents]
        };
    }

    /**
     * Detect phantom braking events - sudden deceleration while on Autopilot
     * without driver brake pedal input. These are concerning events that may
     * indicate sensor errors or ghost objects causing unnecessary braking.
     *
     * Detection criteria:
     * 1. Autopilot is engaged (FSD, Autosteer, or TACC)
     * 2. Deceleration exceeds threshold (e.g., -0.25g or >5mph/sec)
     * 3. Driver brake pedal is NOT pressed
     * 4. Vehicle speed above minimum threshold (avoid false positives at low speed)
     *
     * @param {Array} allPoints - All telemetry data points with autopilot state
     */
    _detectPhantomBraking(allPoints) {
        this.phantomBrakes = [];

        if (!allPoints || allPoints.length < 3) {
            this._updatePhantomBrakeSummary();
            return;
        }

        const thresholds = this.anomalyThresholds.phantomBraking;
        const MIN_DECEL_G = thresholds.minDecelG;              // 0.25g deceleration
        const MIN_SPEED_DROP_MPH = thresholds.minSpeedDropMph; // 5 mph/sec
        const MIN_SPEED_MPH = thresholds.minSpeedMph;          // 15 mph minimum
        const COOLDOWN_SEC = thresholds.cooldownSeconds;       // 3 second cooldown

        let lastPhantomBrakeTime = -Infinity;

        for (let i = 1; i < allPoints.length; i++) {
            const point = allPoints[i];
            const prevPoint = allPoints[i - 1];

            // Skip if no autopilot engaged (AP_NAMES: 'NONE', 'FSD', 'AUTOSTEER', 'TACC')
            // Any value other than 'NONE' means AP is active
            if (!point.autopilot || point.autopilot === 'NONE') {
                continue;
            }

            // Skip if driver brake is pressed (not phantom if driver is braking)
            if (point.brake || prevPoint.brake) {
                continue;
            }

            // Skip if speed too low (avoid false positives in parking lots, etc.)
            if (point.speed_mph < MIN_SPEED_MPH) {
                continue;
            }

            // Calculate time delta
            const timeDelta = point.time - prevPoint.time;
            if (timeDelta <= 0 || timeDelta > 5) continue; // Skip if no time delta or gap too large

            // Check deceleration via G-force (negative g_force_y = braking)
            // Tesla SEI: positive Y = acceleration, negative Y = deceleration
            const decelG = Math.abs(Math.min(0, point.g_force_y));

            // Check speed drop rate
            const speedDropMph = prevPoint.speed_mph - point.speed_mph;
            const speedDropRate = speedDropMph / timeDelta; // mph per second

            // Detect phantom braking: strong deceleration while on AP without driver brake
            const isStrongDecel = decelG >= MIN_DECEL_G;
            const isRapidSpeedDrop = speedDropRate >= MIN_SPEED_DROP_MPH;

            if (isStrongDecel || isRapidSpeedDrop) {
                // Apply cooldown to avoid duplicate events
                if (point.time - lastPhantomBrakeTime < COOLDOWN_SEC) {
                    continue;
                }

                // Calculate severity based on deceleration magnitude
                let severity;
                if (decelG >= 0.5 || speedDropRate >= 15) {
                    severity = 'critical';  // Very hard phantom brake
                } else if (decelG >= 0.35 || speedDropRate >= 10) {
                    severity = 'warning';   // Moderate phantom brake
                } else {
                    severity = 'info';      // Mild phantom brake
                }

                // Store phantom braking event
                this.phantomBrakes.push({
                    time: point.time,
                    latitude: point.latitude || 0,
                    longitude: point.longitude || 0,
                    severity: severity,
                    speedDrop: speedDropMph,
                    speedDropRate: speedDropRate,
                    gForce: decelG,
                    speed: prevPoint.speed_mph,
                    autopilotMode: point.autopilot,
                    index: i
                });

                lastPhantomBrakeTime = point.time;
            }
        }

        // Sort by time
        this.phantomBrakes.sort((a, b) => a.time - b.time);

        // Log detection results
        if (this.phantomBrakes.length > 0) {
            const critical = this.phantomBrakes.filter(pb => pb.severity === 'critical').length;
            const warning = this.phantomBrakes.filter(pb => pb.severity === 'warning').length;
            console.log(`[TelemetryGraphs] Detected ${this.phantomBrakes.length} phantom braking event(s): ` +
                `${critical} critical, ${warning} warning`);
        }

        // Update summary display
        this._updatePhantomBrakeSummary();

        // Notify timeline if callback is set
        if (this.onPhantomBrakesDetected) {
            this.onPhantomBrakesDetected(this.phantomBrakes);
        }
    }

    /**
     * Get phantom braking events with optional severity filter
     * @param {string} minSeverity - Minimum severity ('info', 'warning', 'critical')
     * @returns {Array} Phantom braking events
     */
    getPhantomBrakes(minSeverity = 'info') {
        const severityOrder = { 'info': 0, 'warning': 1, 'critical': 2 };
        const minLevel = severityOrder[minSeverity] || 0;
        return this.phantomBrakes.filter(pb => severityOrder[pb.severity] >= minLevel);
    }

    /**
     * Get color for phantom braking marker based on severity
     * @param {string} severity - Event severity level
     * @returns {string} Color hex code
     */
    _getPhantomBrakeColor(severity) {
        switch (severity) {
            case 'critical':
                return '#ff3b3b'; // Red
            case 'warning':
                return '#ff9100'; // Orange
            case 'info':
            default:
                return '#ffc107'; // Yellow/amber
        }
    }

    /**
     * Update phantom braking summary in stats display
     */
    _updatePhantomBrakeSummary() {
        // Re-render stats to include phantom brake info
        this._renderStats(this.graphData?.points || null);
    }

    /**
     * Draw phantom braking markers on speed graph
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {number} width - Graph width
     * @param {number} height - Graph height
     * @param {Object} padding - Graph padding
     * @param {number} graphWidth - Usable graph width
     * @param {number} graphHeight - Usable graph height
     * @param {number} dataStartTime - Start time of data
     * @param {number} dataDuration - Duration of data
     * @param {number} minVal - Minimum speed value
     * @param {number} range - Speed range
     */
    _drawPhantomBrakeMarkers(ctx, width, height, padding, graphWidth, graphHeight, dataStartTime, dataDuration, minVal, range) {
        if (!this.showAnomalies || !this.phantomBrakes || this.phantomBrakes.length === 0) {
            return;
        }

        for (const event of this.phantomBrakes) {
            // Calculate x position based on event time
            const x = padding.left + ((event.time - dataStartTime) / dataDuration) * graphWidth;

            // Skip if outside visible range
            if (x < padding.left || x > width - padding.right) continue;

            // Calculate y position based on speed at that point
            const y = padding.top + (1 - (event.speed - minVal) / range) * graphHeight;

            // Get color based on severity
            const color = this._getPhantomBrakeColor(event.severity);

            // Draw warning triangle marker
            const markerSize = 6;
            ctx.beginPath();
            ctx.moveTo(x, y - markerSize);  // Top point
            ctx.lineTo(x - markerSize * 0.7, y + markerSize * 0.5);  // Bottom left
            ctx.lineTo(x + markerSize * 0.7, y + markerSize * 0.5);  // Bottom right
            ctx.closePath();

            // Fill with color
            ctx.fillStyle = color;
            ctx.fill();

            // Add stroke for visibility
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.lineWidth = 0.5;
            ctx.stroke();

            // Draw exclamation mark inside triangle for critical/warning
            if (event.severity === 'critical' || event.severity === 'warning') {
                ctx.fillStyle = '#000';
                ctx.font = 'bold 5px system-ui';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('!', x, y - 1);
            }
        }
    }

    /**
     * Destroy
     */
    destroy() {
        this._stopAnimation();
        window.removeEventListener('resize', this._onWindowResize);
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
        document.removeEventListener('mousemove', this._onResizeMouseMove);
        document.removeEventListener('mouseup', this._onResizeMouseUp);

        if (this.container && this.container.parentElement) {
            this.container.remove();
        }
    }
}

// Export
window.TelemetryGraphs = TelemetryGraphs;
