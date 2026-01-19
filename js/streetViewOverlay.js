/**
 * StreetViewOverlay - Street View panel for TeslaCamViewer
 * Shows link to Google Street View based on current GPS position
 * Updates in real-time as video plays
 */

class StreetViewOverlay {
    constructor(videoPlayer) {
        this.videoPlayer = videoPlayer;
        this.container = null;

        this.isVisible = false;
        this.isDragging = false;

        // Position (percentage-based for resolution independence)
        this.position = { x: 2, y: 60 }; // Default: left side, below other overlays

        // Size
        this.width = 280;
        this.height = 200;

        // Storage keys
        this.STORAGE_KEY = 'teslacamviewer_streetview_position';
        this.ENABLED_KEY = 'teslacamviewer_streetview_enabled';

        // Current GPS position
        this.currentLat = null;
        this.currentLng = null;
        this.currentHeading = 0;

        // Callbacks
        this.getPosition = null; // Callback to get current GPS: () => {lat, lng, heading}

        // Bind methods
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._update = this._update.bind(this);

        this._init();
    }

    _init() {
        this._createContainer();
        this._loadPosition();
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
        this.container.className = 'street-view-overlay';
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
        header.className = 'street-view-header';
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
        title.textContent = 'Street View';
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

        // Create content area
        this.contentArea = document.createElement('div');
        this.contentArea.className = 'street-view-content';
        this.contentArea.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: calc(100% - 28px);
            padding: 15px;
            text-align: center;
        `;

        // Street View icon
        const iconSvg = document.createElement('div');
        iconSvg.innerHTML = `
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="${this._getAccentColor()}" stroke-width="1.5">
                <circle cx="12" cy="5" r="3"/>
                <path d="M12 8v8"/>
                <path d="M8 21l4-5 4 5"/>
                <path d="M5 11c0-4 3.5-7 7-7s7 3 7 7"/>
            </svg>
        `;
        iconSvg.style.marginBottom = '10px';
        iconSvg.style.opacity = '0.8';
        this.contentArea.appendChild(iconSvg);

        // Coordinates display
        this.coordsDisplay = document.createElement('div');
        this.coordsDisplay.style.cssText = `
            font-size: 11px;
            color: rgba(255, 255, 255, 0.5);
            margin-bottom: 12px;
        `;
        this.coordsDisplay.textContent = 'No GPS data';
        this.contentArea.appendChild(this.coordsDisplay);

        // Open Street View button
        this.openBtn = document.createElement('button');
        this.openBtn.textContent = 'Open in Google Maps';
        this.openBtn.style.cssText = `
            background: ${this._getAccentColor()};
            color: #000;
            border: none;
            padding: 10px 20px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 8px;
        `;
        this.openBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
            </svg>
            Open Street View
        `;
        this.openBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._openStreetView();
        });
        this.openBtn.addEventListener('mouseenter', () => {
            this.openBtn.style.transform = 'scale(1.02)';
            this.openBtn.style.boxShadow = `0 4px 12px ${this._getAccentColor()}40`;
        });
        this.openBtn.addEventListener('mouseleave', () => {
            this.openBtn.style.transform = 'scale(1)';
            this.openBtn.style.boxShadow = 'none';
        });
        this.contentArea.appendChild(this.openBtn);

        // Heading indicator (shows camera direction)
        this.headingDisplay = document.createElement('div');
        this.headingDisplay.style.cssText = `
            font-size: 10px;
            color: rgba(255, 255, 255, 0.4);
            margin-top: 10px;
        `;
        this.headingDisplay.textContent = '';
        this.contentArea.appendChild(this.headingDisplay);

        this.container.appendChild(this.contentArea);

        // Drag events
        this.container.addEventListener('mousedown', this._onMouseDown);
        this.container.addEventListener('touchstart', this._onMouseDown, { passive: false });
    }

    /**
     * Open Google Street View in a new tab
     */
    _openStreetView() {
        if (this.currentLat === null || this.currentLng === null) {
            return;
        }

        // Build Google Maps Street View URL
        // Format: https://www.google.com/maps/@LAT,LNG,3a,75y,HEADING,90t/data=!3m6!1e1!3m4!1sXXXX!2e0!7i13312!8i6656
        // Simpler format: https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=LAT,LNG&heading=HEADING
        const heading = this.currentHeading || 0;
        const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${this.currentLat},${this.currentLng}&heading=${heading}`;

        window.open(url, '_blank', 'noopener,noreferrer');
    }

    /**
     * Update position from GPS data
     * @param {number} lat - Latitude
     * @param {number} lng - Longitude
     * @param {number} heading - Heading in degrees (0-360)
     */
    updatePosition(lat, lng, heading = 0) {
        if (lat === null || lng === null || isNaN(lat) || isNaN(lng)) {
            this.currentLat = null;
            this.currentLng = null;
            this.coordsDisplay.textContent = 'No GPS data';
            this.openBtn.disabled = true;
            this.openBtn.style.opacity = '0.5';
            this.openBtn.style.cursor = 'not-allowed';
            this.headingDisplay.textContent = '';
            return;
        }

        this.currentLat = lat;
        this.currentLng = lng;
        this.currentHeading = heading || 0;

        // Update coordinates display
        const latDir = lat >= 0 ? 'N' : 'S';
        const lngDir = lng >= 0 ? 'E' : 'W';
        this.coordsDisplay.textContent = `${Math.abs(lat).toFixed(5)}° ${latDir}, ${Math.abs(lng).toFixed(5)}° ${lngDir}`;

        // Update heading display
        if (heading !== null && heading !== undefined && !isNaN(heading)) {
            const dir = this._headingToDirection(heading);
            this.headingDisplay.textContent = `Heading: ${Math.round(heading)}° ${dir}`;
        } else {
            this.headingDisplay.textContent = '';
        }

        // Enable button
        this.openBtn.disabled = false;
        this.openBtn.style.opacity = '1';
        this.openBtn.style.cursor = 'pointer';
    }

    /**
     * Convert heading degrees to cardinal direction
     */
    _headingToDirection(heading) {
        const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const index = Math.round(heading / 45) % 8;
        return dirs[index];
    }

    /**
     * Show the street view overlay
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

        // Save enabled state
        localStorage.setItem(this.ENABLED_KEY, 'true');

        // Notify visibility change
        if (this.onVisibilityChange) {
            this.onVisibilityChange(true);
        }
    }

    /**
     * Hide the street view overlay
     */
    hide() {
        if (!this.isVisible) return;

        this.container.style.display = 'none';
        this.isVisible = false;

        // Save enabled state
        localStorage.setItem(this.ENABLED_KEY, 'false');

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
     * Check if street view was enabled in previous session
     */
    wasEnabled() {
        return localStorage.getItem(this.ENABLED_KEY) === 'true';
    }

    /**
     * Clear position data
     */
    clear() {
        this.currentLat = null;
        this.currentLng = null;
        this.currentHeading = 0;
        this.coordsDisplay.textContent = 'No GPS data';
        this.openBtn.disabled = true;
        this.openBtn.style.opacity = '0.5';
        this.openBtn.style.cursor = 'not-allowed';
        this.headingDisplay.textContent = '';
    }

    _update() {
        if (!this.isVisible) return;

        // Use callback to get current position if available
        if (this.getPosition) {
            const pos = this.getPosition();
            if (pos && pos.lat !== undefined && pos.lng !== undefined) {
                this.updatePosition(pos.lat, pos.lng, pos.heading);
            }
        }
    }

    // ========== Drag handling ==========

    _onMouseDown(e) {
        if (e.target.tagName === 'BUTTON') return;

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

        this._savePosition();
    }

    _updatePosition() {
        if (!this.container) return;

        this.container.style.left = `${this.position.x}%`;
        this.container.style.top = `${this.position.y}%`;
    }

    _loadPosition() {
        try {
            const saved = localStorage.getItem(this.STORAGE_KEY);
            if (saved) {
                const position = JSON.parse(saved);
                if (position.x !== undefined) this.position.x = position.x;
                if (position.y !== undefined) this.position.y = position.y;
            }
        } catch (e) {
            console.warn('[StreetViewOverlay] Failed to load position:', e);
        }
    }

    _savePosition() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.position));
        } catch (e) {
            console.warn('[StreetViewOverlay] Failed to save position:', e);
        }
    }

    /**
     * Destroy the overlay
     */
    destroy() {
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
window.StreetViewOverlay = StreetViewOverlay;
