/**
 * ElevationOverlay - Elevation profile panel for TeslaCamViewer
 * Displays elevation graph synchronized with video playback
 */

class ElevationOverlay {
    constructor(videoPlayer) {
        this.videoPlayer = videoPlayer;
        this.container = null;
        this.canvas = null;
        this.ctx = null;

        this.isVisible = false;
        this.isDragging = false;

        // Position (percentage-based for resolution independence)
        this.position = { x: 80, y: 60 }; // Default: right side, below mini-map area

        // Size
        this.width = 280;
        this.height = 140;

        // Storage keys
        this.STORAGE_KEY = 'teslacamviewer_elevation_positions';
        this.ENABLED_KEY = 'teslacamviewer_elevation_enabled';

        // Elevation data
        this.profile = null;
        this.currentElevation = null;
        this.currentIndex = 0;
        this.currentTime = 0; // Current event time
        this.isOutOfRange = false; // Whether current time is outside data range
        this.totalDuration = 0; // Total event duration for time mapping

        // Animation
        this.animationFrame = null;

        // Callbacks
        this.onSeek = null; // Callback for seeking: (eventTime) => void
        this.getEventTime = null; // Callback to get current event time: () => number

        // Bind methods
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._update = this._update.bind(this);
        this._onCanvasClick = this._onCanvasClick.bind(this);

        this._init();
    }

    _init() {
        this._createContainer();
        this._loadPositions();
    }

    /**
     * Get the current theme's accent color
     */
    _getAccentColor() {
        const computedStyle = getComputedStyle(document.body);
        return computedStyle.getPropertyValue('--accent').trim() || '#00d4ff';
    }

    _createContainer() {
        // Create main overlay container
        this.container = document.createElement('div');
        this.container.className = 'elevation-overlay';
        this.container.style.cssText = `
            position: absolute;
            z-index: 1000;
            cursor: move;
            user-select: none;
            touch-action: none;
            width: ${this.width}px;
            height: ${this.height}px;
            background: rgba(0, 0, 0, 0.75);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            overflow: hidden;
            display: none;
        `;

        // Create header
        const header = document.createElement('div');
        header.className = 'elevation-header';
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 10px;
            background: rgba(255, 255, 255, 0.05);
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            font-size: 11px;
            color: rgba(255, 255, 255, 0.7);
        `;

        const title = document.createElement('span');
        title.textContent = 'Elevation';
        title.style.fontWeight = '500';
        header.appendChild(title);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '&times;';
        closeBtn.style.cssText = `
            background: none;
            border: none;
            color: rgba(255, 255, 255, 0.5);
            font-size: 16px;
            cursor: pointer;
            padding: 0;
            line-height: 1;
        `;
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hide();
        });
        header.appendChild(closeBtn);

        this.container.appendChild(header);

        // Create canvas for graph
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = `
            display: block;
            width: 100%;
            cursor: crosshair;
        `;
        this.container.appendChild(this.canvas);

        // Create stats footer
        this.statsContainer = document.createElement('div');
        this.statsContainer.className = 'elevation-stats';
        this.statsContainer.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 10px;
            background: rgba(255, 255, 255, 0.05);
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            font-size: 11px;
        `;

        this.currentElevationDisplay = document.createElement('span');
        this.currentElevationDisplay.style.cssText = `
            color: ${this._getAccentColor()};
            font-weight: 600;
            font-size: 13px;
        `;
        this.currentElevationDisplay.textContent = '-- ft';

        this.minMaxDisplay = document.createElement('span');
        this.minMaxDisplay.style.cssText = `
            color: rgba(255, 255, 255, 0.5);
            font-size: 10px;
        `;
        this.minMaxDisplay.textContent = 'Min: -- Max: --';

        this.statsContainer.appendChild(this.currentElevationDisplay);
        this.statsContainer.appendChild(this.minMaxDisplay);
        this.container.appendChild(this.statsContainer);

        // Set up canvas
        this._setupCanvas();

        // Drag events
        this.container.addEventListener('mousedown', this._onMouseDown);
        this.container.addEventListener('touchstart', this._onMouseDown, { passive: false });

        // Hover tooltip on canvas
        this.canvas.addEventListener('mousemove', (e) => this._onCanvasHover(e));
        this.canvas.addEventListener('mouseleave', () => this._hideTooltip());

        // Click to seek
        this.canvas.addEventListener('click', this._onCanvasClick);
    }

    _setupCanvas() {
        const headerHeight = 28;
        const statsHeight = 32;
        const graphHeight = this.height - headerHeight - statsHeight;

        this.canvas.width = this.width * 2; // 2x for retina
        this.canvas.height = graphHeight * 2;
        this.canvas.style.height = `${graphHeight}px`;

        this.ctx = this.canvas.getContext('2d');
        this.ctx.scale(2, 2); // Scale for retina
    }

    /**
     * Show the elevation overlay
     */
    show() {
        if (this.isVisible) return;

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

        this._updatePosition();
        this._startAnimation();

        // Save enabled state
        localStorage.setItem(this.ENABLED_KEY, 'true');
    }

    /**
     * Hide the elevation overlay
     */
    hide() {
        if (!this.isVisible) return;

        this.container.style.display = 'none';
        this.isVisible = false;

        this._stopAnimation();

        // Save enabled state
        localStorage.setItem(this.ENABLED_KEY, 'false');
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
     * Check if elevation was enabled in previous session
     */
    wasEnabled() {
        return localStorage.getItem(this.ENABLED_KEY) === 'true';
    }

    /**
     * Set elevation profile data
     * @param {Object} profile - Elevation profile from ElevationService
     * @param {number} totalDuration - Total event duration in seconds
     */
    setProfile(profile, totalDuration = 0) {
        this.profile = profile;
        this.totalDuration = totalDuration;

        if (profile) {
            // Update min/max display
            const useFeet = this._useFeet();
            const min = window.elevationService.formatElevation(profile.minElevation, useFeet);
            const max = window.elevationService.formatElevation(profile.maxElevation, useFeet);
            this.minMaxDisplay.textContent = `Min: ${min}  Max: ${max}`;
        } else {
            this.minMaxDisplay.textContent = 'No elevation data';
            this.currentElevationDisplay.textContent = '-- ft';
        }

        this._drawGraph();
    }

    /**
     * Clear elevation data
     */
    clear() {
        this.profile = null;
        this.currentElevation = null;
        this.currentIndex = 0;
        this.minMaxDisplay.textContent = 'Min: -- Max: --';
        this.currentElevationDisplay.textContent = '-- ft';
        this._drawGraph();
    }

    _useFeet() {
        const locale = navigator.language || 'en-US';
        return locale.includes('US') || locale.includes('GB') || locale.includes('LR') || locale.includes('MM');
    }

    /**
     * Start animation loop
     */
    _startAnimation() {
        if (this.animationFrame) return;

        const animate = () => {
            this._update();
            this.animationFrame = requestAnimationFrame(animate);
        };
        this.animationFrame = requestAnimationFrame(animate);
    }

    /**
     * Stop animation loop
     */
    _stopAnimation() {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
    }

    /**
     * Update current position based on video time
     */
    _update() {
        if (!this.isVisible || !this.profile) return;

        // Use callback to get absolute event time, or fall back to video time
        let currentTime = 0;
        if (this.getEventTime) {
            currentTime = this.getEventTime();
        } else if (this.videoPlayer) {
            currentTime = this.videoPlayer.getCurrentTime();
        }

        this.currentTime = currentTime;

        // Check if current time is within the data range
        const dataStartTime = this.profile.startTime || 0;
        const dataEndTime = this.profile.endTime || this.totalDuration;
        const isInDataRange = currentTime >= dataStartTime && currentTime <= dataEndTime;

        if (isInDataRange) {
            const elevationData = window.elevationService.getElevationAtTime(this.profile, currentTime);

            if (elevationData) {
                this.currentElevation = elevationData.elevation;
                this.currentIndex = elevationData.index;
                this.isOutOfRange = false;

                // Update display
                const formatted = window.elevationService.formatElevation(this.currentElevation, this._useFeet());
                this.currentElevationDisplay.textContent = formatted;
                this.currentElevationDisplay.style.color = this._getAccentColor();
            }
        } else {
            // Outside data range
            this.isOutOfRange = true;
            this.currentElevationDisplay.textContent = '--';
            this.currentElevationDisplay.style.color = 'rgba(255, 255, 255, 0.4)';
        }

        this._drawGraph();
    }

    /**
     * Draw the elevation profile graph
     */
    _drawGraph() {
        if (!this.ctx) return;

        const ctx = this.ctx;
        const width = this.canvas.width / 2;
        const height = this.canvas.height / 2;

        // Clear canvas
        ctx.clearRect(0, 0, width, height);

        if (!this.profile || !this.profile.points || this.profile.points.length < 2) {
            // Draw "No data" message
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.font = '11px system-ui, -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('No elevation data', width / 2, height / 2);
            return;
        }

        const points = this.profile.points;
        const minElev = this.profile.minElevation;
        const maxElev = this.profile.maxElevation;
        const range = maxElev - minElev || 1;

        const padding = { top: 8, right: 8, bottom: 8, left: 8 };
        const graphWidth = width - padding.left - padding.right;
        const graphHeight = height - padding.top - padding.bottom;

        // Create gradient for fill
        const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
        const accentColor = this._getAccentColor();
        gradient.addColorStop(0, accentColor + '40');
        gradient.addColorStop(1, accentColor + '05');

        // Draw filled area
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

        // Draw line
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
            const x = padding.left + (i / (points.length - 1)) * graphWidth;
            const y = padding.top + (1 - (points[i].elevation - minElev) / range) * graphHeight;

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Calculate position marker based on time within data range
        const dataStartTime = this.profile.startTime || 0;
        const dataEndTime = this.profile.endTime || this.totalDuration;
        const dataDuration = dataEndTime - dataStartTime;

        // Draw current position marker (based on time, not index)
        if (this.currentTime !== undefined && dataDuration > 0) {
            // Calculate position as ratio within data time range
            const timeRatio = (this.currentTime - dataStartTime) / dataDuration;

            // Only draw marker if within or near the data range
            if (timeRatio >= -0.05 && timeRatio <= 1.05) {
                const clampedRatio = Math.max(0, Math.min(1, timeRatio));
                const markerX = padding.left + clampedRatio * graphWidth;

                // Vertical line
                ctx.beginPath();
                ctx.moveTo(markerX, padding.top);
                ctx.lineTo(markerX, height - padding.bottom);
                ctx.strokeStyle = this.isOutOfRange ? 'rgba(255, 100, 100, 0.4)' : 'rgba(255, 255, 255, 0.4)';
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.stroke();
                ctx.setLineDash([]);

                // Dot at current elevation (only if in range)
                if (!this.isOutOfRange && this.currentElevation !== null) {
                    const markerY = padding.top + (1 - (this.currentElevation - minElev) / range) * graphHeight;

                    ctx.beginPath();
                    ctx.arc(markerX, markerY, 4, 0, Math.PI * 2);
                    ctx.fillStyle = accentColor;
                    ctx.fill();
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }
            }

            // Show "out of range" indicator if outside data bounds
            if (this.isOutOfRange) {
                ctx.fillStyle = 'rgba(255, 100, 100, 0.7)';
                ctx.font = '9px system-ui, -apple-system, sans-serif';
                ctx.textAlign = 'center';
                const msg = this.currentTime < dataStartTime ? '← Data starts later' : 'Data ends earlier →';
                ctx.fillText(msg, width / 2, height - padding.bottom - 4);
            }
        }

        // Show data coverage indicator if data doesn't span full event
        if (this.totalDuration > 0 && dataDuration > 0) {
            const coveragePercent = Math.round((dataDuration / this.totalDuration) * 100);
            if (coveragePercent < 95) {
                // Show coverage percentage in top-right
                ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
                ctx.font = '9px system-ui, -apple-system, sans-serif';
                ctx.textAlign = 'right';
                ctx.fillText(`${coveragePercent}% coverage`, width - padding.right, padding.top + 10);
            }
        }
    }

    /**
     * Handle canvas hover for tooltip
     */
    _onCanvasHover(e) {
        if (!this.profile || !this.profile.points) return;

        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const width = rect.width;

        const padding = { left: 8, right: 8 };
        const graphWidth = width - padding.left - padding.right;

        if (x < padding.left || x > width - padding.right) {
            this._hideTooltip();
            return;
        }

        const ratio = (x - padding.left) / graphWidth;
        const index = Math.round(ratio * (this.profile.points.length - 1));
        const point = this.profile.points[index];

        if (point) {
            const elevation = window.elevationService.formatElevation(point.elevation, this._useFeet());
            this._showTooltip(e.clientX, e.clientY, elevation);
        }
    }

    /**
     * Handle canvas click for seeking
     */
    _onCanvasClick(e) {
        if (!this.profile || !this.profile.points || !this.onSeek) return;

        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const width = rect.width;

        const padding = { left: 8, right: 8 };
        const graphWidth = width - padding.left - padding.right;

        if (x < padding.left || x > width - padding.right) return;

        // Calculate the ratio across the graph (0 to 1)
        const ratio = (x - padding.left) / graphWidth;

        // Map to event time using the DATA's time range, not total duration
        // This ensures clicking on the graph seeks to the correct position
        const dataStartTime = this.profile.startTime || 0;
        const dataEndTime = this.profile.endTime || this.totalDuration;
        const dataDuration = dataEndTime - dataStartTime;

        if (dataDuration <= 0) return;

        const seekTime = dataStartTime + (ratio * dataDuration);

        // Call the seek callback
        this.onSeek(seekTime);
    }

    _showTooltip(x, y, text) {
        if (!this.tooltip) {
            this.tooltip = document.createElement('div');
            this.tooltip.style.cssText = `
                position: fixed;
                background: rgba(0, 0, 0, 0.85);
                color: #fff;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 11px;
                pointer-events: none;
                z-index: 10000;
                white-space: nowrap;
            `;
            document.body.appendChild(this.tooltip);
        }

        this.tooltip.textContent = text;
        this.tooltip.style.left = `${x + 10}px`;
        this.tooltip.style.top = `${y - 20}px`;
        this.tooltip.style.display = 'block';
    }

    _hideTooltip() {
        if (this.tooltip) {
            this.tooltip.style.display = 'none';
        }
    }

    // ========== Drag handling ==========

    _onMouseDown(e) {
        if (e.target.tagName === 'BUTTON' || e.target === this.canvas) return;

        e.preventDefault();
        this.isDragging = true;

        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        const rect = this.container.getBoundingClientRect();
        this.dragOffset = {
            x: clientX - rect.left,
            y: clientY - rect.top
        };

        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);
        document.addEventListener('touchmove', this._onMouseMove, { passive: false });
        document.addEventListener('touchend', this._onMouseUp);
    }

    _onMouseMove(e) {
        if (!this.isDragging) return;

        e.preventDefault();

        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        const videoGrid = document.querySelector('.video-grid');
        if (!videoGrid) return;

        const containerRect = videoGrid.getBoundingClientRect();

        // Calculate new position as percentage
        const newX = ((clientX - this.dragOffset.x - containerRect.left) / containerRect.width) * 100;
        const newY = ((clientY - this.dragOffset.y - containerRect.top) / containerRect.height) * 100;

        // Clamp to container bounds
        this.position.x = Math.max(0, Math.min(100 - (this.width / containerRect.width) * 100, newX));
        this.position.y = Math.max(0, Math.min(100 - (this.height / containerRect.height) * 100, newY));

        this._updatePosition();
    }

    _onMouseUp() {
        if (!this.isDragging) return;

        this.isDragging = false;

        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
        document.removeEventListener('touchmove', this._onMouseMove);
        document.removeEventListener('touchend', this._onMouseUp);

        this._savePositions();
    }

    _updatePosition() {
        if (!this.container) return;

        this.container.style.left = `${this.position.x}%`;
        this.container.style.top = `${this.position.y}%`;
    }

    _loadPositions() {
        try {
            const saved = localStorage.getItem(this.STORAGE_KEY);
            if (saved) {
                const positions = JSON.parse(saved);
                if (positions.x !== undefined) this.position.x = positions.x;
                if (positions.y !== undefined) this.position.y = positions.y;
            }
        } catch (e) {
            console.warn('[ElevationOverlay] Failed to load positions:', e);
        }
    }

    _savePositions() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.position));
        } catch (e) {
            console.warn('[ElevationOverlay] Failed to save positions:', e);
        }
    }

    /**
     * Destroy the overlay
     */
    destroy() {
        this._stopAnimation();
        this._hideTooltip();

        if (this.tooltip && this.tooltip.parentElement) {
            this.tooltip.remove();
        }

        if (this.container && this.container.parentElement) {
            this.container.remove();
        }

        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
        document.removeEventListener('touchmove', this._onMouseMove);
        document.removeEventListener('touchend', this._onMouseUp);
    }
}

// Export for use in app.js
window.ElevationOverlay = ElevationOverlay;
