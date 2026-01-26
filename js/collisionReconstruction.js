/**
 * CollisionReconstruction - Bird's eye view animated vehicle path
 * Shows top-down reconstruction of vehicle movement synced with video playback
 * G-force visualization and heading indicator
 */

class CollisionReconstruction {
    constructor(videoPlayer) {
        this.videoPlayer = videoPlayer;
        this.telemetryOverlay = null; // Set via setTelemetryOverlay()

        this.canvas = null;
        this.ctx = null;
        this.canvasContainer = null;

        this.isVisible = false;
        this.hasGpsData = false;

        // Storage keys
        this.COLLAPSED_KEY = 'teslacamviewer_birdsEye_collapsed';

        // Vehicle path data
        this.pathPoints = [];
        this.maxPathPoints = 200; // Keep last N points for trail
        this.currentLat = null;
        this.currentLng = null;
        this.currentHeading = 0;
        this.currentGForce = { x: 0, y: 0 };

        // View settings
        this.zoomLevel = 1.0; // Meters per pixel
        this.viewRadiusMeters = 50; // Initial view radius in meters
        this.minViewRadius = 10;
        this.maxViewRadius = 200;

        // Animation
        this.animationFrame = null;
        this.lastUpdateTime = 0;
        this.updateInterval = 50; // ~20fps

        // Vehicle icon (Tesla Model 3/Y silhouette)
        this.vehicleLength = 4.7; // meters
        this.vehicleWidth = 1.9; // meters

        // Bind methods
        this._updateLoop = this._updateLoop.bind(this);
        this._onWheel = this._onWheel.bind(this);

        this._init();
    }

    _init() {
        this._createSidebarContent();
        this._setupPanelCollapse();
        this._setupResizeObserver();
    }

    /**
     * Setup resize observer for sidebar resize handling
     */
    _setupResizeObserver() {
        if (!this.canvasContainer) return;

        // Debounced resize handler
        let resizeTimeout = null;
        const handleResize = () => {
            if (resizeTimeout) clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                if (this.isVisible) {
                    this._updateCanvasSize();
                    this._render();
                }
            }, 50);
        };

        // Watch for container size changes
        this.resizeObserver = new ResizeObserver(handleResize);
        this.resizeObserver.observe(this.canvasContainer);
    }

    /**
     * Create canvas content for sidebar panel
     */
    _createSidebarContent() {
        const contentContainer = document.getElementById('birdsEyeContent');
        if (!contentContainer) {
            console.warn('[CollisionReconstruction] Sidebar content container not found');
            return;
        }

        // Create canvas container - centered in sidebar
        this.canvasContainer = document.createElement('div');
        this.canvasContainer.className = 'birds-eye-canvas-container';
        this.canvasContainer.style.cssText = `
            width: 100%;
            height: 100%;
            position: relative;
            background: #0a0a0a;
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        contentContainer.appendChild(this.canvasContainer);

        // Create canvas
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'birds-eye-canvas';
        this.canvas.style.cssText = `
            width: 100%;
            height: 100%;
            display: block;
        `;
        this.canvasContainer.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');

        // Create G-force legend
        this.legend = document.createElement('div');
        this.legend.className = 'birds-eye-legend';
        this.legend.style.cssText = `
            position: absolute;
            bottom: 4px;
            left: 55px;
            font-size: 9px;
            color: rgba(255, 255, 255, 0.8);
            display: flex;
            flex-direction: column;
            gap: 1px;
            white-space: nowrap;
        `;
        this.legend.innerHTML = `
            <div style="display: flex; align-items: center; gap: 4px;">
                <span style="width: 12px; height: 3px; background: #4ade80; border-radius: 1px; flex-shrink: 0;"></span>
                <span style="white-space: nowrap;">Low G</span>
            </div>
            <div style="display: flex; align-items: center; gap: 4px;">
                <span style="width: 12px; height: 3px; background: #fbbf24; border-radius: 1px; flex-shrink: 0;"></span>
                <span style="white-space: nowrap;">Med G</span>
            </div>
            <div style="display: flex; align-items: center; gap: 4px;">
                <span style="width: 12px; height: 3px; background: #ef4444; border-radius: 1px; flex-shrink: 0;"></span>
                <span style="white-space: nowrap;">High G</span>
            </div>
        `;
        this.canvasContainer.appendChild(this.legend);

        // Create scale display
        this.scaleDisplay = document.createElement('div');
        this.scaleDisplay.className = 'birds-eye-scale';
        this.scaleDisplay.style.cssText = `
            position: absolute;
            top: 4px;
            left: 4px;
            font-size: 9px;
            color: rgba(255, 255, 255, 0.6);
            background: rgba(0, 0, 0, 0.5);
            padding: 2px 6px;
            border-radius: 4px;
        `;
        this.scaleDisplay.textContent = `${Math.round(this.viewRadiusMeters)}m radius`;
        this.canvasContainer.appendChild(this.scaleDisplay);

        // Setup wheel zoom on canvas
        this.canvas.addEventListener('wheel', this._onWheel);
    }

    /**
     * Setup sidebar panel collapse functionality
     */
    _setupPanelCollapse() {
        const panel = document.getElementById('birdsEyePanel');
        const header = document.getElementById('birdsEyeHeader');

        if (!panel || !header) return;

        // Load collapsed state
        const isCollapsed = localStorage.getItem(this.COLLAPSED_KEY) === 'true';
        if (isCollapsed) {
            panel.classList.add('collapsed');
        }

        // Toggle collapse on header click
        header.addEventListener('click', () => {
            panel.classList.toggle('collapsed');
            localStorage.setItem(this.COLLAPSED_KEY, panel.classList.contains('collapsed'));

            // Re-render if expanding
            if (!panel.classList.contains('collapsed') && this.isVisible) {
                this._updateCanvasSize();
                this._render();
            }
        });
    }

    /**
     * Set telemetry overlay reference to get SEI data
     */
    setTelemetryOverlay(telemetryOverlay) {
        this.telemetryOverlay = telemetryOverlay;
    }

    /**
     * Show the sidebar panel (when GPS data is available)
     */
    show() {
        if (this.isVisible) return;

        const panel = document.getElementById('birdsEyePanel');
        if (!panel) return;

        panel.style.display = '';
        this.isVisible = true;
        this.hasGpsData = true;

        // Update canvas size
        this._updateCanvasSize();

        // Start animation loop
        this._startAnimation();

        console.log('[CollisionReconstruction] Panel shown');
    }

    /**
     * Hide the sidebar panel (when no GPS data)
     */
    hide() {
        if (!this.isVisible) return;

        this._stopAnimation();

        const panel = document.getElementById('birdsEyePanel');
        if (panel) {
            panel.style.display = 'none';
        }

        this.isVisible = false;
        this.hasGpsData = false;

        console.log('[CollisionReconstruction] Panel hidden');
    }

    /**
     * Toggle visibility (for manual control, though panel auto-shows with GPS data)
     */
    toggle() {
        const panel = document.getElementById('birdsEyePanel');
        if (!panel) return;

        if (panel.classList.contains('collapsed')) {
            panel.classList.remove('collapsed');
            localStorage.setItem(this.COLLAPSED_KEY, 'false');
        } else {
            panel.classList.add('collapsed');
            localStorage.setItem(this.COLLAPSED_KEY, 'true');
        }
    }

    _updateCanvasSize() {
        if (!this.canvasContainer || !this.canvas || !this.ctx) return;

        const rect = this.canvasContainer.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const dpr = window.devicePixelRatio || 1;

        // Setting width/height resets the canvas context, so we need to re-scale
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;

        // Reset transform and apply DPR scaling
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(dpr, dpr);
    }

    _onWheel(e) {
        e.preventDefault();

        // Zoom in/out
        const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8;
        this.viewRadiusMeters = Math.max(
            this.minViewRadius,
            Math.min(this.maxViewRadius, this.viewRadiusMeters * zoomFactor)
        );

        this._updateScaleDisplay();
    }

    _updateScaleDisplay() {
        if (this.scaleDisplay) {
            this.scaleDisplay.textContent = `${Math.round(this.viewRadiusMeters)}m radius`;
        }
    }

    _startAnimation() {
        if (this.animationFrame) return;
        this._updateLoop();
    }

    _stopAnimation() {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
    }

    _updateLoop() {
        if (!this.isVisible) return;

        const now = performance.now();
        if (now - this.lastUpdateTime >= this.updateInterval) {
            this._fetchTelemetryData();
            this._render();
            this.lastUpdateTime = now;
        }

        this.animationFrame = requestAnimationFrame(this._updateLoop);
    }

    _fetchTelemetryData() {
        if (!this.telemetryOverlay) return;

        const data = this.telemetryOverlay.currentData;
        if (!data) return;

        const lat = data.latitude_deg;
        const lng = data.longitude_deg;
        const heading = data.heading_deg || 0;
        const gx = data.g_force_x || 0;
        const gy = data.g_force_y || 0;

        // Only add point if we have valid GPS
        if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
            // Check if this is first position or a position jump
            const isFirstPosition = this.pathPoints.length === 0;
            const isJump = !isFirstPosition && this.currentLat !== null && this.currentLng !== null &&
                this._calculateDistance(this.currentLat, this.currentLng, lat, lng) > 100;

            if (isFirstPosition || isJump) {
                // Load historical trail backwards from this position
                this._loadPathBackwards(lat, lng);
            }

            this.currentLat = lat;
            this.currentLng = lng;
            this.currentHeading = heading;
            this.currentGForce = { x: gx, y: gy };

            // Calculate total G-force
            const totalG = Math.sqrt(gx * gx + gy * gy);

            // Add to path
            this.pathPoints.push({
                lat,
                lng,
                heading,
                gForce: totalG,
                timestamp: Date.now()
            });

            // Trim old points
            if (this.pathPoints.length > this.maxPathPoints) {
                this.pathPoints.shift();
            }
        }
    }

    /**
     * Calculate distance between two GPS coordinates in meters (Haversine formula)
     */
    _calculateDistance(lat1, lng1, lat2, lng2) {
        const R = 6371000; // Earth's radius in meters
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * Load path backwards from a position (when jumping to new location)
     * Fills the path with historical GPS points going backwards
     * @param {number} lat - Target latitude
     * @param {number} lng - Target longitude
     */
    _loadPathBackwards(lat, lng) {
        // Clear existing path first
        this.pathPoints = [];

        // Get time-ordered GPS points from current event's telemetry
        const telemetryPoints = window.app?.telemetryOverlay?.getAllGpsPoints();
        if (!telemetryPoints || telemetryPoints.length === 0) {
            console.log('[BirdsEye] No telemetry GPS data available for backward trail loading');
            return;
        }

        // Find the closest point to the target position
        let closestIndex = -1;
        let closestDistance = Infinity;

        for (let i = 0; i < telemetryPoints.length; i++) {
            const point = telemetryPoints[i];
            const dist = this._calculateDistance(lat, lng, point.lat, point.lng);

            if (dist < closestDistance) {
                closestDistance = dist;
                closestIndex = i;
            }
        }

        // If closest point is too far (>50m), don't load trail
        if (closestIndex === -1 || closestDistance > 50) {
            console.log('[BirdsEye] No close telemetry point found for backward trail loading');
            return;
        }

        // Load points backwards from closest index (within view radius)
        const loadedPoints = [];
        for (let i = closestIndex; i >= 0 && loadedPoints.length < this.maxPathPoints; i--) {
            const point = telemetryPoints[i];

            // Check if point is within view radius (meters)
            const distFromTarget = this._calculateDistance(lat, lng, point.lat, point.lng);
            if (distFromTarget > this.viewRadiusMeters * 2) {
                // Point is outside view, stop loading
                break;
            }

            // Add point to beginning of array (we're going backwards)
            loadedPoints.unshift({
                lat: point.lat,
                lng: point.lng,
                heading: 0, // Will be calculated from path direction
                gForce: 0,
                timestamp: Date.now()
            });
        }

        // Set the path points
        this.pathPoints = loadedPoints;

        console.log(`[BirdsEye] Loaded ${loadedPoints.length} path points backwards from position jump`);
    }

    _render() {
        if (!this.ctx) return;

        const rect = this.canvasContainer.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;
        const centerX = width / 2;
        const centerY = height / 2;

        // Clear canvas
        this.ctx.fillStyle = '#0a0a0a';
        this.ctx.fillRect(0, 0, width, height);

        // Draw grid
        this._drawGrid(centerX, centerY, width, height);

        // Draw compass
        this._drawCompass(width - 30, 40);

        if (this.pathPoints.length < 2) {
            // No data yet
            this._drawNoDataMessage(centerX, centerY);
            return;
        }

        // Calculate meters per pixel
        const metersPerPixel = (this.viewRadiusMeters * 2) / Math.min(width, height);

        // Draw path trail
        this._drawPath(centerX, centerY, metersPerPixel);

        // Draw vehicle at center
        this._drawVehicle(centerX, centerY, metersPerPixel);

        // Draw G-force indicator (positioned to leave room for G value text below)
        this._drawGForceIndicator(8, height - 65);

        // Update scale display
        this._updateScaleDisplay();
    }

    _drawGrid(centerX, centerY, width, height) {
        const metersPerPixel = (this.viewRadiusMeters * 2) / Math.min(width, height);

        // Calculate grid spacing (aim for ~5-10 lines)
        let gridSpacingMeters = 10;
        if (this.viewRadiusMeters <= 20) gridSpacingMeters = 5;
        if (this.viewRadiusMeters <= 10) gridSpacingMeters = 2;
        if (this.viewRadiusMeters >= 100) gridSpacingMeters = 25;
        if (this.viewRadiusMeters >= 150) gridSpacingMeters = 50;

        const gridSpacingPixels = gridSpacingMeters / metersPerPixel;

        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        this.ctx.lineWidth = 1;

        // Vertical lines
        for (let x = centerX % gridSpacingPixels; x < width; x += gridSpacingPixels) {
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, height);
            this.ctx.stroke();
        }

        // Horizontal lines
        for (let y = centerY % gridSpacingPixels; y < height; y += gridSpacingPixels) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(width, y);
            this.ctx.stroke();
        }

        // Draw center crosshair
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        this.ctx.setLineDash([4, 4]);
        this.ctx.beginPath();
        this.ctx.moveTo(centerX, 0);
        this.ctx.lineTo(centerX, height);
        this.ctx.moveTo(0, centerY);
        this.ctx.lineTo(width, centerY);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
    }

    _drawCompass(x, y) {
        const radius = 15;

        // Compass always points north (fixed reference) - no rotation needed
        // since the path/grid already rotate to show vehicle's perspective
        this.ctx.save();
        this.ctx.translate(x, y);

        // Compass circle
        this.ctx.beginPath();
        this.ctx.arc(0, 0, radius, 0, Math.PI * 2);
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        this.ctx.lineWidth = 1;
        this.ctx.stroke();

        // North indicator
        this.ctx.beginPath();
        this.ctx.moveTo(0, -radius + 3);
        this.ctx.lineTo(-4, -radius + 10);
        this.ctx.lineTo(4, -radius + 10);
        this.ctx.closePath();
        this.ctx.fillStyle = '#ef4444';
        this.ctx.fill();

        // N label
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        this.ctx.font = '8px sans-serif';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText('N', 0, -radius - 8);

        this.ctx.restore();
    }

    _drawPath(centerX, centerY, metersPerPixel) {
        if (this.pathPoints.length < 2) return;

        const currentPoint = this.pathPoints[this.pathPoints.length - 1];

        this.ctx.lineWidth = 3;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        // Draw path segments with G-force color coding
        for (let i = 1; i < this.pathPoints.length; i++) {
            const p1 = this.pathPoints[i - 1];
            const p2 = this.pathPoints[i];

            // Convert lat/lng to relative position from current point
            const dx1 = this._lngToMeters(p1.lng - currentPoint.lng, currentPoint.lat);
            const dy1 = this._latToMeters(p1.lat - currentPoint.lat);
            const dx2 = this._lngToMeters(p2.lng - currentPoint.lng, currentPoint.lat);
            const dy2 = this._latToMeters(p2.lat - currentPoint.lat);

            // Convert to pixels (north up, so flip Y)
            const x1 = centerX + dx1 / metersPerPixel;
            const y1 = centerY - dy1 / metersPerPixel;
            const x2 = centerX + dx2 / metersPerPixel;
            const y2 = centerY - dy2 / metersPerPixel;

            // Color based on G-force
            const color = this._getGForceColor(p2.gForce);

            // Fade based on age
            const age = (this.pathPoints.length - i) / this.pathPoints.length;
            const alpha = 0.3 + (1 - age) * 0.7;

            this.ctx.beginPath();
            this.ctx.moveTo(x1, y1);
            this.ctx.lineTo(x2, y2);
            this.ctx.strokeStyle = this._colorWithAlpha(color, alpha);
            this.ctx.stroke();
        }
    }

    _drawVehicle(centerX, centerY, metersPerPixel) {
        const headingRad = (this.currentHeading * Math.PI) / 180;

        // Vehicle dimensions in pixels
        const lengthPx = this.vehicleLength / metersPerPixel;
        const widthPx = this.vehicleWidth / metersPerPixel;

        this.ctx.save();
        this.ctx.translate(centerX, centerY);
        this.ctx.rotate(headingRad);

        // Vehicle body (pointing up = forward)
        this.ctx.fillStyle = '#3b82f6';
        this.ctx.beginPath();

        // Tesla-ish shape (rounded rectangle with pointed front)
        const halfLength = lengthPx / 2;
        const halfWidth = widthPx / 2;
        const frontPoint = halfLength * 0.8;
        const cornerRadius = Math.min(halfWidth * 0.3, 3);

        // Draw vehicle body
        this.ctx.beginPath();
        this.ctx.moveTo(0, -halfLength); // Front point
        this.ctx.lineTo(halfWidth - cornerRadius, -frontPoint);
        this.ctx.quadraticCurveTo(halfWidth, -frontPoint, halfWidth, -frontPoint + cornerRadius);
        this.ctx.lineTo(halfWidth, halfLength - cornerRadius);
        this.ctx.quadraticCurveTo(halfWidth, halfLength, halfWidth - cornerRadius, halfLength);
        this.ctx.lineTo(-halfWidth + cornerRadius, halfLength);
        this.ctx.quadraticCurveTo(-halfWidth, halfLength, -halfWidth, halfLength - cornerRadius);
        this.ctx.lineTo(-halfWidth, -frontPoint + cornerRadius);
        this.ctx.quadraticCurveTo(-halfWidth, -frontPoint, -halfWidth + cornerRadius, -frontPoint);
        this.ctx.closePath();

        // Fill with gradient
        const gradient = this.ctx.createLinearGradient(0, -halfLength, 0, halfLength);
        gradient.addColorStop(0, '#60a5fa');
        gradient.addColorStop(1, '#2563eb');
        this.ctx.fillStyle = gradient;
        this.ctx.fill();

        // Outline
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        this.ctx.lineWidth = 1;
        this.ctx.stroke();

        // Direction indicator (front arrow)
        this.ctx.beginPath();
        this.ctx.moveTo(0, -halfLength - 4);
        this.ctx.lineTo(3, -halfLength + 2);
        this.ctx.lineTo(-3, -halfLength + 2);
        this.ctx.closePath();
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fill();

        this.ctx.restore();
    }

    _drawGForceIndicator(x, y) {
        const size = 40;
        const centerX = x + size / 2;
        const centerY = y + size / 2;

        // Background circle
        this.ctx.beginPath();
        this.ctx.arc(centerX, centerY, size / 2, 0, Math.PI * 2);
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        this.ctx.fill();
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        this.ctx.lineWidth = 1;
        this.ctx.stroke();

        // Cross lines
        this.ctx.beginPath();
        this.ctx.moveTo(centerX - size / 2 + 4, centerY);
        this.ctx.lineTo(centerX + size / 2 - 4, centerY);
        this.ctx.moveTo(centerX, centerY - size / 2 + 4);
        this.ctx.lineTo(centerX, centerY + size / 2 - 4);
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        this.ctx.stroke();

        // G-force dot (scale: 1g = half the radius)
        const scale = (size / 2 - 4) / 1.0; // 1g = edge
        const dotX = centerX + this.currentGForce.x * scale;
        const dotY = centerY - this.currentGForce.y * scale; // Flip Y

        // Clamp to circle
        const dx = dotX - centerX;
        const dy = dotY - centerY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxDist = size / 2 - 4;
        let finalX = dotX;
        let finalY = dotY;
        if (dist > maxDist) {
            finalX = centerX + (dx / dist) * maxDist;
            finalY = centerY + (dy / dist) * maxDist;
        }

        // Dot color based on magnitude
        const totalG = Math.sqrt(this.currentGForce.x ** 2 + this.currentGForce.y ** 2);
        const color = this._getGForceColor(totalG);

        this.ctx.beginPath();
        this.ctx.arc(finalX, finalY, 4, 0, Math.PI * 2);
        this.ctx.fillStyle = color;
        this.ctx.fill();
        this.ctx.strokeStyle = 'white';
        this.ctx.lineWidth = 1;
        this.ctx.stroke();

        // G value text
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        this.ctx.font = '9px sans-serif';
        this.ctx.textAlign = 'center';
        this.ctx.fillText(`${totalG.toFixed(2)}g`, centerX, centerY + size / 2 + 12);
    }

    _drawNoDataMessage(centerX, centerY) {
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        this.ctx.font = '12px sans-serif';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText('Waiting for GPS data...', centerX, centerY);
    }

    _getGForceColor(g) {
        if (g < 0.2) return '#4ade80'; // Green - low
        if (g < 0.4) return '#fbbf24'; // Yellow - medium
        if (g < 0.6) return '#f97316'; // Orange - high
        return '#ef4444'; // Red - very high
    }

    _colorWithAlpha(color, alpha) {
        // Convert hex to rgba
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    _latToMeters(lat) {
        // 1 degree latitude = ~111,139 meters
        return lat * 111139;
    }

    _lngToMeters(lng, lat) {
        // 1 degree longitude varies by latitude
        return lng * 111139 * Math.cos((lat * Math.PI) / 180);
    }

    /**
     * Reset path when loading new event
     */
    reset() {
        this.pathPoints = [];
        this.currentLat = null;
        this.currentLng = null;
        this.currentHeading = 0;
        this.currentGForce = { x: 0, y: 0 };
    }

    /**
     * Check if Bird's Eye View has data to render
     * @returns {boolean}
     */
    hasData() {
        return this.pathPoints.length >= 2;
    }

    /**
     * Check if GPS data is available
     * @returns {boolean}
     */
    hasGpsDataAvailable() {
        return this.hasGpsData && this.pathPoints.length > 0;
    }

    /**
     * Cleanup
     */
    destroy() {
        this._stopAnimation();
        if (this.canvas) {
            this.canvas.removeEventListener('wheel', this._onWheel);
        }
    }
}

// Export for use
window.CollisionReconstruction = CollisionReconstruction;
