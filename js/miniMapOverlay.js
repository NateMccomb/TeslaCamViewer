/**
 * MiniMapOverlay - GPS mini-map overlay for TeslaCamViewer
 * Shows real-time vehicle position synced with SEI telemetry data
 */

class MiniMapOverlay {
    constructor(videoPlayer) {
        this.videoPlayer = videoPlayer;
        this.container = null;
        this.map = null;
        this.marker = null;
        this.trail = null;
        this.trailPoints = [];
        this.maxTrailPoints = 100;

        this.isVisible = false;
        this.isDragging = false;

        // Position (percentage-based for resolution independence)
        this.position = { x: 80, y: 10 }; // Default: top-right area

        // Per-layout positions storage key
        this.STORAGE_KEY = 'teslacamviewer_minimap_positions';
        this.ENABLED_KEY = 'teslacamviewer_minimap_enabled';
        this.DARK_MODE_KEY = 'teslacamviewer_minimap_dark_mode';

        // Tile layer configuration (dark mode is default)
        this.isDarkMode = localStorage.getItem(this.DARK_MODE_KEY) !== 'false';
        this.tileLayer = null;

        // Fallback tile layers if mapView is not available
        this._fallbackTileLayers = {
            light: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        };

        // Current GPS data
        this.currentLat = null;
        this.currentLng = null;
        this.currentHeading = 0;

        // Throttle updates for performance
        this.lastUpdateTime = 0;
        this.updateInterval = 100; // 10fps

        // Bind methods
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);

        this._init();
    }

    _init() {
        this._createContainer();
        this._loadPositions();
    }

    /**
     * Get the tile URL for the current provider and mode
     * Uses mapView's provider if available, otherwise falls back to default
     * @param {string} mode - 'light' or 'dark'
     * @returns {string} Tile URL template
     */
    _getTileUrl(mode = 'dark') {
        // Try to get from mapView's shared provider config
        if (window.app?.mapView?.TILE_PROVIDERS) {
            const providerId = window.app.mapView.getCurrentProvider();
            const provider = window.app.mapView.TILE_PROVIDERS[providerId];
            if (provider && provider[mode]) {
                return provider[mode].url;
            }
        }
        // Fallback
        return this._fallbackTileLayers[mode];
    }

    /**
     * Get a direct tile image URL for canvas rendering
     * Replaces Leaflet placeholders with actual values
     * @param {number} x - Tile X coordinate
     * @param {number} y - Tile Y coordinate
     * @param {number} zoom - Zoom level
     * @returns {string} Direct tile URL
     */
    _getDirectTileUrl(x, y, zoom) {
        const mode = this.isDarkMode ? 'dark' : 'light';
        let url = this._getTileUrl(mode);

        // Replace Leaflet placeholders
        const servers = ['a', 'b', 'c'];
        const server = servers[Math.floor(Math.random() * servers.length)];

        url = url.replace('{s}', server);
        url = url.replace('{z}', zoom.toString());
        url = url.replace('{x}', x.toString());
        url = url.replace('{y}', y.toString());
        url = url.replace('{r}', ''); // Retina suffix, leave empty

        return url;
    }

    /**
     * Get the current theme's accent color from CSS variables
     */
    _getAccentColor() {
        const computedStyle = getComputedStyle(document.body);
        return computedStyle.getPropertyValue('--accent').trim() || '#00d4ff';
    }

    _createContainer() {
        // Create main overlay container
        this.container = document.createElement('div');
        this.container.className = 'minimap-overlay';
        this.container.style.cssText = `
            position: absolute;
            z-index: 1000;
            cursor: move;
            user-select: none;
            touch-action: none;
            background: rgba(0, 0, 0, 0.75);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            overflow: hidden;
            transition: opacity 0.2s ease;
        `;
        // Size will be set by _updateSize()

        // Create map container inside
        this.mapContainer = document.createElement('div');
        this.mapContainer.className = 'minimap-container';
        this.mapContainer.style.cssText = `
            width: 100%;
            height: 100%;
            border-radius: 11px;
            overflow: hidden;
        `;
        this.container.appendChild(this.mapContainer);

        // Create close button
        this.closeBtn = document.createElement('button');
        this.closeBtn.className = 'minimap-close-btn';
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
            z-index: 1001;
        `;
        this.closeBtn.onclick = () => this.hide();
        this.container.appendChild(this.closeBtn);

        // Create dark mode toggle button (auto-hides like close button)
        this.darkModeBtn = document.createElement('button');
        this.darkModeBtn.className = 'minimap-darkmode-btn';
        this.darkModeBtn.title = 'Toggle dark mode';
        this.darkModeBtn.innerHTML = this.isDarkMode ? '☀️' : '🌙';
        this.darkModeBtn.style.cssText = `
            position: absolute;
            top: 4px;
            right: 28px;
            width: 20px;
            height: 20px;
            border: none;
            background: rgba(255, 255, 255, 0.1);
            color: rgba(255, 255, 255, 0.8);
            border-radius: 50%;
            cursor: pointer;
            font-size: 10px;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s ease, background 0.2s ease;
            z-index: 1001;
        `;
        this.darkModeBtn.onclick = (e) => {
            e.stopPropagation();
            this.toggleDarkMode();
        };
        this.container.appendChild(this.darkModeBtn);

        // Create weather badge (top-left)
        this.weatherBadge = document.createElement('div');
        this.weatherBadge.className = 'minimap-weather-badge';
        this.weatherBadge.style.cssText = `
            position: absolute;
            top: 4px;
            left: 4px;
            padding: 2px 6px;
            background: rgba(0, 0, 0, 0.7);
            color: rgba(255, 255, 255, 0.9);
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
            z-index: 1001;
            display: none;
            pointer-events: none;
            max-width: calc(100% - 32px);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        `;
        this.container.appendChild(this.weatherBadge);

        // Weather data storage
        this.currentWeather = null;

        // Inject CSS for hover-based button visibility
        if (!document.getElementById('minimap-hover-styles')) {
            const style = document.createElement('style');
            style.id = 'minimap-hover-styles';
            style.textContent = `
                .minimap-overlay:hover .minimap-close-btn,
                .minimap-overlay:hover .minimap-darkmode-btn {
                    opacity: 1 !important;
                    pointer-events: auto !important;
                }
                .minimap-overlay .minimap-darkmode-btn:hover {
                    background: rgba(255, 255, 255, 0.25) !important;
                }
                .minimap-overlay .leaflet-control-container {
                    display: none !important;
                }
            `;
            document.head.appendChild(style);
        }

        // Drag event listeners
        this.container.addEventListener('mousedown', this._onMouseDown);
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);

        // Right-click context menu
        this.container.addEventListener('contextmenu', (e) => this._showContextMenu(e));

        // Initially hidden
        this.container.style.display = 'none';

        // Create context menu
        this._createContextMenu();

        // Handle window resize
        this._boundUpdateSize = () => this._updateSize();
        window.addEventListener('resize', this._boundUpdateSize);
    }

    /**
     * Calculate and update map size based on parent container
     */
    _updateSize() {
        const parent = this.container.parentElement;
        if (!parent) return;

        // Base size is 200px on a 1920px wide container
        const parentWidth = parent.clientWidth || 1920;
        const scale = parentWidth / 1920;
        const size = Math.round(200 * scale);
        const cornerRadius = Math.round(12 * scale);

        this.container.style.width = `${size}px`;
        this.container.style.height = `${size}px`;
        this.container.style.borderRadius = `${cornerRadius}px`;

        // Scale weather badge font with map size
        if (this.weatherBadge) {
            const fontSize = Math.max(9, Math.round(11 * scale));
            this.weatherBadge.style.fontSize = `${fontSize}px`;
        }

        // Store current size for drag calculations
        this.currentSize = size;

        // Update Leaflet map size if it exists
        if (this.map) {
            this.map.invalidateSize();
        }
    }

    _createContextMenu() {
        this.contextMenu = document.createElement('div');
        this.contextMenu.className = 'minimap-context-menu';
        this.contextMenu.style.cssText = `
            position: fixed;
            z-index: 10000;
            background: rgba(30, 30, 30, 0.95);
            backdrop-filter: blur(8px);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 8px;
            padding: 4px 0;
            min-width: 140px;
            display: none;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        `;

        const menuItems = [
            { label: 'Open Street View', action: () => this.openStreetView() },
            { label: 'Open in Google Maps', action: () => this.openGoogleMaps() },
            { label: 'Reload Map', action: () => this.reloadMap() },
            { label: 'Reset Trail', action: () => this.clearTrail() },
            { label: 'Close', action: () => this.hide() }
        ];

        menuItems.forEach(item => {
            const menuItem = document.createElement('div');
            menuItem.textContent = item.label;
            menuItem.style.cssText = `
                padding: 8px 16px;
                cursor: pointer;
                color: rgba(255, 255, 255, 0.9);
                font-size: 13px;
                transition: background 0.15s ease;
            `;
            menuItem.addEventListener('mouseenter', () => {
                menuItem.style.background = 'rgba(255, 255, 255, 0.1)';
            });
            menuItem.addEventListener('mouseleave', () => {
                menuItem.style.background = 'transparent';
            });
            menuItem.addEventListener('click', () => {
                item.action();
                this._hideContextMenu();
            });
            this.contextMenu.appendChild(menuItem);
        });

        document.body.appendChild(this.contextMenu);

        // Close menu when clicking elsewhere
        document.addEventListener('click', () => this._hideContextMenu());
    }

    _showContextMenu(e) {
        e.preventDefault();
        e.stopPropagation();

        // Position menu at cursor
        this.contextMenu.style.left = `${e.clientX}px`;
        this.contextMenu.style.top = `${e.clientY}px`;
        this.contextMenu.style.display = 'block';

        // Ensure menu stays within viewport
        const rect = this.contextMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            this.contextMenu.style.left = `${window.innerWidth - rect.width - 5}px`;
        }
        if (rect.bottom > window.innerHeight) {
            this.contextMenu.style.top = `${window.innerHeight - rect.height - 5}px`;
        }
    }

    _hideContextMenu() {
        if (this.contextMenu) {
            this.contextMenu.style.display = 'none';
        }
    }

    _initMap(forceRefresh = false) {
        if (this.map) return;
        if (!window.L) {
            console.warn('[MiniMap] Leaflet not loaded');
            return;
        }

        // Create Leaflet map
        this.map = L.map(this.mapContainer, {
            zoomControl: false,
            attributionControl: false,
            dragging: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
            touchZoom: false
        }).setView([0, 0], 16);

        // Add tile layer based on dark mode preference
        const baseUrl = this._getTileUrl(this.isDarkMode ? 'dark' : 'light');
        const tileUrl = forceRefresh ? `${baseUrl}?_=${Date.now()}` : baseUrl;

        this.tileLayer = L.tileLayer(tileUrl, {
            maxZoom: 19
        }).addTo(this.map);

        // Create trail polyline
        const accentColor = this._getAccentColor();
        this.trail = L.polyline([], {
            color: accentColor,
            weight: 3,
            opacity: 0.5,
            lineJoin: 'round'
        }).addTo(this.map);

        // Create vehicle marker (arrow)
        this._createMarker();
    }

    _createMarker() {
        const accentColor = this._getAccentColor();

        // Create arrow icon using SVG
        const arrowIcon = L.divIcon({
            className: 'minimap-vehicle-marker',
            html: `
                <svg width="24" height="24" viewBox="0 0 24 24" style="transform: rotate(0deg); transition: transform 0.1s ease;">
                    <path d="M12 2L4 20h16L12 2z" fill="${accentColor}" stroke="white" stroke-width="1"/>
                </svg>
            `,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        this.marker = L.marker([0, 0], {
            icon: arrowIcon,
            interactive: false
        }).addTo(this.map);
    }

    _updateMarker() {
        if (!this.marker) return;

        const accentColor = this._getAccentColor();
        const rotation = this.currentHeading || 0;

        // Update marker icon with rotation
        const arrowIcon = L.divIcon({
            className: 'minimap-vehicle-marker',
            html: `
                <svg width="24" height="24" viewBox="0 0 24 24" style="transform: rotate(${rotation}deg);">
                    <path d="M12 2L4 20h16L12 2z" fill="${accentColor}" stroke="white" stroke-width="1"/>
                </svg>
            `,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        this.marker.setIcon(arrowIcon);
    }

    _destroyMap() {
        if (this.map) {
            this.map.remove();
            this.map = null;
            this.marker = null;
            this.trail = null;
        }
    }

    /**
     * Reload the map tiles (useful when tiles fail to load)
     */
    reloadMap() {
        if (!this.isVisible) return;

        // Save current state
        const savedLat = this.currentLat;
        const savedLng = this.currentLng;
        const savedHeading = this.currentHeading;
        const savedTrail = [...this.trailPoints];
        const savedWeather = this.currentWeather;

        // Destroy and recreate map with cache-busting
        this._destroyMap();
        this._initMap(true); // true = forceRefresh

        // Restore state
        if (savedLat && savedLng) {
            this.currentLat = savedLat;
            this.currentLng = savedLng;
            this.currentHeading = savedHeading;
            this.trailPoints = savedTrail;

            // Update map view
            if (this.map) {
                this.map.setView([savedLat, savedLng], 16, { animate: false });

                if (this.marker) {
                    this.marker.setLatLng([savedLat, savedLng]);
                }

                if (this.trail && savedTrail.length > 0) {
                    this.trail.setLatLngs(savedTrail);
                }

                this._updateMarker();
            }
        }

        // Restore weather
        if (savedWeather) {
            this.setWeather(savedWeather);
        }

        console.log('[MiniMap] Map reloaded');
    }

    /**
     * Open Google Street View at current location
     */
    openStreetView() {
        if (!this.currentLat || !this.currentLng) {
            console.warn('[MiniMap] No GPS coordinates for Street View');
            return;
        }

        // Google Street View URL with heading if available
        const heading = this.currentHeading || 0;
        const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${this.currentLat},${this.currentLng}&heading=${heading}`;
        window.open(url, '_blank');
    }

    /**
     * Open Google Maps at current location
     */
    openGoogleMaps() {
        if (!this.currentLat || !this.currentLng) {
            console.warn('[MiniMap] No GPS coordinates for Google Maps');
            return;
        }

        // Google Maps URL centered on location
        const url = `https://www.google.com/maps?q=${this.currentLat},${this.currentLng}`;
        window.open(url, '_blank');
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
        this._updateSize();
        this._applyPosition();
        this._initMap();

        // Save enabled state
        localStorage.setItem(this.ENABLED_KEY, 'true');

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
        this._destroyMap();
        this.clearTrail();

        // Save enabled state
        localStorage.setItem(this.ENABLED_KEY, 'false');

        // Notify visibility change
        if (this.onVisibilityChange) {
            this.onVisibilityChange(false);
        }
    }

    /**
     * Toggle between light and dark map tiles
     */
    toggleDarkMode() {
        this.setDarkMode(!this.isDarkMode);
    }

    /**
     * Set dark mode explicitly (called from Settings)
     * @param {boolean} darkMode - true for dark tiles, false for light
     */
    setDarkMode(darkMode) {
        if (this.isDarkMode === darkMode) return; // No change needed

        this.isDarkMode = darkMode;
        localStorage.setItem(this.DARK_MODE_KEY, this.isDarkMode.toString());

        // Update button icon
        if (this.darkModeBtn) {
            this.darkModeBtn.innerHTML = this.isDarkMode ? '☀️' : '🌙';
            this.darkModeBtn.title = this.isDarkMode ? 'Switch to light mode' : 'Switch to dark mode';
        }

        // Update tile layer if map exists
        if (this.map && this.tileLayer) {
            this.map.removeLayer(this.tileLayer);
            const tileUrl = this._getTileUrl(this.isDarkMode ? 'dark' : 'light');
            this.tileLayer = L.tileLayer(tileUrl, {
                maxZoom: 19
            }).addTo(this.map);
        }
    }

    /**
     * Set weather data to display on badge
     * @param {Object} weather - Weather data from weatherService
     */
    setWeather(weather) {
        this.currentWeather = weather;

        if (weather && this.weatherBadge) {
            const badgeText = window.weatherService?.formatForBadge(weather);
            if (badgeText) {
                this.weatherBadge.textContent = badgeText;
                this.weatherBadge.style.display = 'block';
            } else {
                this.weatherBadge.style.display = 'none';
            }
        } else if (this.weatherBadge) {
            this.weatherBadge.style.display = 'none';
        }
    }

    /**
     * Clear weather data
     */
    clearWeather() {
        this.currentWeather = null;
        if (this.weatherBadge) {
            this.weatherBadge.style.display = 'none';
            this.weatherBadge.textContent = '';
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
     * Check if mini-map should be enabled (from saved preference)
     */
    isEnabled() {
        return localStorage.getItem(this.ENABLED_KEY) === 'true';
    }

    /**
     * Update position from telemetry data
     * @param {number} lat - Latitude in degrees
     * @param {number} lng - Longitude in degrees
     * @param {number} heading - Heading in degrees (0-360)
     */
    updatePosition(lat, lng, heading) {
        if (!this.isVisible || !this.map) return;

        // Throttle updates
        const now = Date.now();
        if (now - this.lastUpdateTime < this.updateInterval) return;
        this.lastUpdateTime = now;

        // Skip invalid coords
        if (!lat || !lng || (lat === 0 && lng === 0)) return;

        // Check if position actually changed
        const posChanged = lat !== this.currentLat || lng !== this.currentLng;
        const headingChanged = heading !== this.currentHeading;

        if (!posChanged && !headingChanged) return;

        // Detect position jump (e.g., user seeked to different time)
        // If distance is > ~500 meters, reset the trail to avoid stray lines
        if (this.currentLat !== null && this.currentLng !== null && posChanged) {
            const distance = this._calculateDistance(this.currentLat, this.currentLng, lat, lng);
            if (distance > 500) { // 500 meters threshold
                this.clearTrail();
            }
        }

        this.currentLat = lat;
        this.currentLng = lng;
        this.currentHeading = heading || 0;

        // Update map center
        if (posChanged) {
            this.map.setView([lat, lng], this.map.getZoom(), { animate: false });

            // Update marker position
            if (this.marker) {
                this.marker.setLatLng([lat, lng]);
            }

            // Add to trail
            this._addTrailPoint(lat, lng);
        }

        // Update marker rotation
        if (headingChanged) {
            this._updateMarker();
        }
    }

    /**
     * Update position for export (no throttling, no jump detection, no map requirement)
     * @param {number} lat - Latitude in degrees
     * @param {number} lng - Longitude in degrees
     * @param {number} heading - Heading in degrees (0-360)
     */
    updatePositionForExport(lat, lng, heading) {
        // Skip invalid coords
        if (!lat || !lng || (lat === 0 && lng === 0)) return;

        this.currentLat = lat;
        this.currentLng = lng;
        this.currentHeading = heading || 0;

        // Add to trail (no jump detection - trail should be cleared before export)
        this.trailPoints.push([lat, lng]);

        // Keep trail to max length
        if (this.trailPoints.length > this.maxTrailPoints) {
            this.trailPoints.shift();
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
     * Add point to breadcrumb trail
     */
    _addTrailPoint(lat, lng) {
        if (!this.trail) return;

        this.trailPoints.push([lat, lng]);

        // Keep trail to max length
        if (this.trailPoints.length > this.maxTrailPoints) {
            this.trailPoints.shift();
        }

        this.trail.setLatLngs(this.trailPoints);
    }

    /**
     * Clear the trail (called when position jumps or resetting)
     * Does NOT clear weather - weather is event-level data
     */
    clearTrail() {
        this.trailPoints = [];
        if (this.trail) {
            this.trail.setLatLngs([]);
        }
        this.currentLat = null;
        this.currentLng = null;
        // Note: Don't clear weather here - it's set at event load and should persist
    }

    /**
     * Clear everything including weather (when loading new event)
     */
    clearAll() {
        this.clearTrail();
        this.clearWeather();
    }

    /**
     * Update trail color to match theme
     */
    updateThemeColor() {
        if (this.trail) {
            this.trail.setStyle({ color: this._getAccentColor() });
        }
        this._updateMarker();
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

        // Constrain to parent bounds
        const size = this.currentSize || 200;
        const containerWidth = (size / rect.width) * 100;
        const containerHeight = (size / rect.height) * 100;

        newX = Math.max(0, Math.min(100 - containerWidth, newX));
        newY = Math.max(0, Math.min(100 - containerHeight, newY));

        this.position.x = newX;
        this.position.y = newY;
        this._applyPosition();
    }

    _applyPosition() {
        this.container.style.left = `${this.position.x}%`;
        this.container.style.top = `${this.position.y}%`;
    }

    // ==================== POSITION PERSISTENCE ====================

    _savePosition() {
        try {
            const positions = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
            const layoutKey = window.layoutManager?.getCurrentLayout() || 'default';
            positions[layoutKey] = { x: this.position.x, y: this.position.y };
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(positions));
        } catch (e) {
            console.warn('[MiniMap] Failed to save position:', e);
        }
    }

    _loadPositions() {
        try {
            const positions = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
            const layoutKey = window.layoutManager?.getCurrentLayout() || 'default';
            if (positions[layoutKey]) {
                this.position = positions[layoutKey];
            }
        } catch (e) {
            console.warn('[MiniMap] Failed to load positions:', e);
        }
    }

    /**
     * Called when layout changes - load position for new layout
     */
    onLayoutChange(layoutName) {
        this._loadPositions();
        if (this.isVisible) {
            this._applyPosition();
        }
    }

    /**
     * Initialize layout change callback
     * @param {LayoutManager} layoutManager
     */
    initLayoutCallback(layoutManager) {
        if (!layoutManager) return;

        this._layoutManager = layoutManager;

        // Subscribe to layout changes
        if (layoutManager.onLayoutChange) {
            const originalCallback = layoutManager.onLayoutChange.bind(layoutManager);
            layoutManager.onLayoutChange = (name) => {
                originalCallback(name);
                this.onLayoutChange(name);
            };
        }
    }

    // ==================== CANVAS EXPORT ====================

    // Tile cache for export (avoid re-fetching same tiles)
    static _tileCache = new Map();

    /**
     * Convert lat/lng to tile coordinates at given zoom level
     */
    _latLngToTile(lat, lng, zoom) {
        const n = Math.pow(2, zoom);
        const x = Math.floor((lng + 180) / 360 * n);
        const latRad = lat * Math.PI / 180;
        const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
        return { x, y };
    }

    /**
     * Convert tile coordinates to lat/lng (top-left corner of tile)
     */
    _tileToLatLng(x, y, zoom) {
        const n = Math.pow(2, zoom);
        const lng = x / n * 360 - 180;
        const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
        const lat = latRad * 180 / Math.PI;
        return { lat, lng };
    }

    /**
     * Get pixel position within tile for a lat/lng at given zoom
     */
    _latLngToPixelInTile(lat, lng, zoom, tileX, tileY) {
        const n = Math.pow(2, zoom);
        const tileSize = 256;

        // World pixel coordinates
        const worldX = (lng + 180) / 360 * n * tileSize;
        const latRad = lat * Math.PI / 180;
        const worldY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n * tileSize;

        // Pixel within tile
        const pixelX = worldX - tileX * tileSize;
        const pixelY = worldY - tileY * tileSize;

        return { x: pixelX, y: pixelY };
    }

    /**
     * Get cached tile synchronously (returns null if not cached)
     */
    _getCachedTile(x, y, zoom) {
        // Try current mode first, then fallback to opposite mode
        // This ensures tiles cached in either mode can be used during export
        const currentMode = this.isDarkMode ? 'dark' : 'light';
        const oppositeMode = this.isDarkMode ? 'light' : 'dark';

        const primaryKey = `${zoom}/${x}/${y}/${currentMode}`;
        const fallbackKey = `${zoom}/${x}/${y}/${oppositeMode}`;

        return MiniMapOverlay._tileCache.get(primaryKey) ||
               MiniMapOverlay._tileCache.get(fallbackKey) ||
               null;
    }

    /**
     * Fetch a map tile image (async)
     */
    async _fetchTile(x, y, zoom) {
        // Include dark mode in cache key to cache both versions separately
        const cacheKey = `${zoom}/${x}/${y}/${this.isDarkMode ? 'dark' : 'light'}`;
        if (MiniMapOverlay._tileCache.has(cacheKey)) {
            return MiniMapOverlay._tileCache.get(cacheKey);
        }

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                MiniMapOverlay._tileCache.set(cacheKey, img);
                // Limit cache size
                if (MiniMapOverlay._tileCache.size > 200) {
                    const firstKey = MiniMapOverlay._tileCache.keys().next().value;
                    MiniMapOverlay._tileCache.delete(firstKey);
                }
                resolve(img);
            };
            img.onerror = () => reject(new Error(`Failed to load tile ${cacheKey}`));
            // Use tile URL from shared provider config
            img.src = this._getDirectTileUrl(x, y, zoom);
        });
    }

    /**
     * Pre-cache tiles for a list of GPS positions (call before export)
     */
    async preCacheTilesForExport(positions) {
        const zoom = 16;
        const tilesToFetch = new Set();

        for (const pos of positions) {
            if (!pos.lat || !pos.lng) continue;
            const centerTile = this._latLngToTile(pos.lat, pos.lng, zoom);
            // Add 3x3 grid around each position
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    tilesToFetch.add(`${centerTile.x + dx},${centerTile.y + dy}`);
                }
            }
        }

        // Fetch all unique tiles
        const fetchPromises = [];
        for (const key of tilesToFetch) {
            const [x, y] = key.split(',').map(Number);
            fetchPromises.push(this._fetchTile(x, y, zoom).catch(() => null));
        }

        await Promise.all(fetchPromises);
        console.log(`[MiniMap] Pre-cached ${tilesToFetch.size} tiles for export`);
    }

    /**
     * Draw mini-map to canvas for video export (synchronous - uses cached tiles only)
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} canvasWidth
     * @param {number} canvasHeight
     */
    drawToCanvas(ctx, canvasWidth, canvasHeight) {
        if (!this.currentLat || !this.currentLng) return;

        // Scale map size proportionally with canvas size
        // Base size is 200px on a 1920px wide canvas
        const scale = canvasWidth / 1920;
        const mapWidth = Math.round(200 * scale);
        const mapHeight = Math.round(200 * scale);
        const cornerRadius = Math.round(12 * scale);

        // Calculate position on canvas
        const x = (this.position.x / 100) * canvasWidth;
        const y = (this.position.y / 100) * canvasHeight;
        const zoom = 16;
        const tileSize = 256;

        // Create clipping region for rounded corners
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, mapWidth, mapHeight, cornerRadius);
        ctx.clip();

        // Draw background first
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(x, y, mapWidth, mapHeight);

        // Get center tile and pixel offset
        const centerTile = this._latLngToTile(this.currentLat, this.currentLng, zoom);
        const pixelInTile = this._latLngToPixelInTile(this.currentLat, this.currentLng, zoom, centerTile.x, centerTile.y);

        // Scale tile drawing to fit the map size
        const tileScale = mapWidth / 200; // Scale tiles relative to base 200px
        const scaledTileSize = tileSize * tileScale;

        // Calculate offset to center the map on the current position
        const offsetX = mapWidth / 2 - pixelInTile.x * tileScale;
        const offsetY = mapHeight / 2 - pixelInTile.y * tileScale;

        // Determine which tiles we need (3x3 grid around center)
        const tilesToDraw = [];
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                tilesToDraw.push({
                    tileX: centerTile.x + dx,
                    tileY: centerTile.y + dy,
                    drawX: x + offsetX + dx * scaledTileSize,
                    drawY: y + offsetY + dy * scaledTileSize
                });
            }
        }

        // Draw cached tiles (synchronous - no waiting)
        tilesToDraw.forEach(t => {
            const img = this._getCachedTile(t.tileX, t.tileY, zoom);
            if (img) {
                ctx.drawImage(img, t.drawX, t.drawY, scaledTileSize, scaledTileSize);
            }
        });

        // Draw semi-transparent overlay for better contrast
        ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
        ctx.fillRect(x, y, mapWidth, mapHeight);

        ctx.restore(); // End clipping

        // Draw border
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = Math.max(1, scale);
        ctx.beginPath();
        ctx.roundRect(x, y, mapWidth, mapHeight, cornerRadius);
        ctx.stroke();

        // Draw trail
        if (this.trailPoints.length > 1) {
            const accentColor = this._getAccentColor();

            // Convert trail points to canvas coordinates
            ctx.save();
            ctx.beginPath();
            ctx.roundRect(x, y, mapWidth, mapHeight, cornerRadius);
            ctx.clip();

            ctx.strokeStyle = accentColor;
            ctx.lineWidth = 3 * scale;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalAlpha = 0.7;
            ctx.beginPath();

            this.trailPoints.forEach((point, i) => {
                const tile = this._latLngToTile(point[0], point[1], zoom);
                const pixel = this._latLngToPixelInTile(point[0], point[1], zoom, centerTile.x, centerTile.y);
                const px = x + mapWidth / 2 + (tile.x - centerTile.x) * scaledTileSize + (pixel.x - pixelInTile.x) * tileScale;
                const py = y + mapHeight / 2 + (tile.y - centerTile.y) * scaledTileSize + (pixel.y - pixelInTile.y) * tileScale;

                if (i === 0) {
                    ctx.moveTo(px, py);
                } else {
                    ctx.lineTo(px, py);
                }
            });
            ctx.stroke();
            ctx.restore();
        }

        // Draw vehicle arrow at center
        const accentColor = this._getAccentColor();
        const arrowX = x + mapWidth / 2;
        const arrowY = y + mapHeight / 2;
        const heading = (this.currentHeading || 0) * Math.PI / 180;
        const arrowSize = 12 * scale;

        ctx.save();
        ctx.translate(arrowX, arrowY);
        ctx.rotate(heading);
        ctx.fillStyle = accentColor;
        ctx.beginPath();
        ctx.moveTo(0, -arrowSize);
        ctx.lineTo(-arrowSize * 0.67, arrowSize);
        ctx.lineTo(arrowSize * 0.67, arrowSize);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = Math.max(1, 2 * scale);
        ctx.stroke();
        ctx.restore();

        // Draw weather badge (top-left corner)
        if (this.currentWeather) {
            const badgeText = window.weatherService?.formatForBadge(this.currentWeather);
            if (badgeText) {
                const fontSize = Math.round(11 * scale);
                const padding = Math.round(4 * scale);
                const badgeX = x + padding;
                const badgeY = y + padding;

                ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                const textMetrics = ctx.measureText(badgeText);
                const textWidth = textMetrics.width;
                const textHeight = fontSize;

                // Draw badge background
                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                ctx.beginPath();
                ctx.roundRect(badgeX, badgeY, textWidth + padding * 2, textHeight + padding, Math.round(4 * scale));
                ctx.fill();

                // Draw text
                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.fillText(badgeText, badgeX + padding, badgeY + textHeight);
            }
        }
    }
}

// Export for use
window.MiniMapOverlay = MiniMapOverlay;
