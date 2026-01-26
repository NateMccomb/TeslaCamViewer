/**
 * MapView - Leaflet map integration for displaying event locations
 */

class MapView {
    constructor(containerElement, onEventSelect) {
        this.container = containerElement;
        this.onEventSelect = onEventSelect; // Callback to load event
        this.map = null;
        this.markerCluster = null;
        this.heatLayer = null;
        this.heatmapEnabled = false;
        this.heatmapDataSource = 'telemetry'; // 'telemetry' or 'events' - telemetry uses SEI GPS data
        this.events = [];
        this.telemetryGpsPoints = []; // Cached GPS points from SEI telemetry data
        this.initialized = false;
        this.offlineOverlay = null;
        this.isOffline = !navigator.onLine;

        // Autopilot Struggle Zones data
        this.struggleZonesEnabled = false;
        this.struggleZonesLayer = null;
        this.struggleZonesMarkers = null; // Marker cluster for clickable disengagement points
        this.apDisengagementPoints = []; // Array of {lat, lng, eventName, timestamp, fromState}
        this.struggleZonesControl = null;

        // Incident Markers data (replaces Incident Hotspots)
        this.incidentMarkersEnabled = false;
        this.incidentHeatLayer = null;
        this.incidentMarkers = null; // Marker cluster for clickable incident points
        this.incidentPoints = []; // Array of {lat, lng, severity, type, eventName, timestamp, ...}
        this.incidentControl = null;

        // Tile layer management
        this.currentTileLayer = null;
        this.isDarkMode = false;
        this.tileProvider = localStorage.getItem('teslacam_map_provider') || 'carto';

        // Tile provider configurations
        this.TILE_PROVIDERS = {
            carto: {
                name: 'Carto (Default)',
                light: {
                    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
                    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
                    subdomains: 'abcd'
                },
                dark: {
                    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
                    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
                    subdomains: 'abcd'
                }
            },
            osm: {
                name: 'OpenStreetMap',
                light: {
                    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                    subdomains: ''
                },
                dark: {
                    // OSM doesn't have dark mode, use Stadia dark
                    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
                    attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                    subdomains: ''
                }
            },
            stadia: {
                name: 'Stadia Maps',
                light: {
                    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png',
                    attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                    subdomains: ''
                },
                dark: {
                    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
                    attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                    subdomains: ''
                }
            }
        };

        // Legacy TILE_LAYERS for backward compatibility
        this.TILE_LAYERS = this.TILE_PROVIDERS[this.tileProvider] || this.TILE_PROVIDERS.carto;
        this.DARK_MODE_KEY = 'teslacam_map_dark_mode';

        // Cache keys for localStorage persistence
        this.CACHE_KEY_GPS = 'teslacam_mapview_gps_cache';
        // Per-event caching: 'teslacamviewer_incident_per_event', 'teslacamviewer_ap_per_event'
        this.cacheVersion = 7; // Increment to invalidate cache (v7: Incident markers replace incidents)

        // Listen for online/offline events
        window.addEventListener('online', () => this.handleOnlineStatusChange(true));
        window.addEventListener('offline', () => this.handleOnlineStatusChange(false));
    }

    /**
     * Get translation helper
     */
    t(key) {
        return window.i18n ? window.i18n.t(key) : key.split('.').pop();
    }

    /**
     * Generate cache key based on event timestamps
     */
    _getCacheKey(events) {
        if (!events || events.length === 0) return null;
        // Create a hash based on event count and first/last timestamps
        const firstTs = events[0]?.timestamp || '';
        const lastTs = events[events.length - 1]?.timestamp || '';
        return `v${this.cacheVersion}_${events.length}_${firstTs}_${lastTs}`;
    }

    /**
     * Load GPS points from cache
     */
    _loadGpsCache(events) {
        try {
            const cached = localStorage.getItem(this.CACHE_KEY_GPS);
            if (!cached) return null;
            const data = JSON.parse(cached);
            if (data.key === this._getCacheKey(events)) {
                console.log(`[MapView] Loaded ${data.points.length} GPS points from cache`);
                return data.points;
            }
        } catch (e) {
            console.warn('[MapView] Failed to load GPS cache:', e);
        }
        return null;
    }

    /**
     * Save GPS points to cache
     */
    _saveGpsCache(events, points) {
        try {
            const data = {
                key: this._getCacheKey(events),
                points: points,
                timestamp: Date.now()
            };
            localStorage.setItem(this.CACHE_KEY_GPS, JSON.stringify(data));
            console.log(`[MapView] Saved ${points.length} GPS points to cache`);
        } catch (e) {
            console.warn('[MapView] Failed to save GPS cache:', e);
        }
    }

    /**
     * Show notification when cache is invalidated due to version update
     * @param {string} featureName - Name of the feature (e.g., "Incident Hotspots")
     * @param {string} oldVersion - Previous cache version
     * @param {string} newVersion - Current cache version
     */
    _showCacheInvalidationNotice(featureName, oldVersion, newVersion) {
        // Only show once per feature per session
        const noticeKey = `_cacheNoticeShown_${featureName}`;
        if (this[noticeKey]) return;
        this[noticeKey] = true;

        console.log(`[MapView] Cache invalidated for ${featureName}: v${oldVersion} -> v${newVersion}`);

        // Show toast notification if available
        if (window.app?.showToast) {
            window.app.showToast(
                `${featureName} data will be rescanned due to detection improvements in this update.`,
                'info',
                5000
            );
        }
    }

    /**
     * Show progress indicator during data scanning
     * @param {string} scanType - Type of scan (e.g., "GPS Telemetry", "Autopilot Data")
     * @param {number} totalEvents - Total events to process
     * @returns {HTMLElement} Progress element
     */
    _showScanProgress(scanType, totalEvents) {
        // Remove any existing progress
        const existing = document.querySelector('.map-scan-progress');
        if (existing) existing.remove();

        const progressEl = document.createElement('div');
        progressEl.className = 'map-scan-progress';
        progressEl.innerHTML = `
            <div class="scan-progress-content">
                <div class="scan-progress-header">
                    <span class="scan-progress-title">Scanning ${scanType}...</span>
                    <button class="scan-progress-cancel" title="Cancel scan">✕</button>
                </div>
                <div class="scan-progress-bar">
                    <div class="scan-progress-fill" style="width: 0%"></div>
                </div>
                <div class="scan-progress-text">0 / ${totalEvents} events</div>
            </div>
        `;

        // Add cancel handler
        const cancelBtn = progressEl.querySelector('.scan-progress-cancel');
        cancelBtn.addEventListener('click', () => {
            this._scanCancelled = true;
            progressEl.querySelector('.scan-progress-title').textContent = 'Cancelling...';
        });

        // Style the progress element
        progressEl.style.cssText = `
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: var(--panel-bg, #2d2d2d);
            border: 1px solid var(--border, #3a3a3a);
            border-radius: 8px;
            padding: 12px 16px;
            z-index: 10000;
            min-width: 280px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        `;

        const content = progressEl.querySelector('.scan-progress-content');
        content.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';

        const header = progressEl.querySelector('.scan-progress-header');
        header.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';

        const title = progressEl.querySelector('.scan-progress-title');
        title.style.cssText = 'font-weight: 500; color: var(--text, #e0e0e0);';

        cancelBtn.style.cssText = `
            background: none;
            border: none;
            color: var(--text-muted, #888);
            cursor: pointer;
            padding: 2px 6px;
            font-size: 14px;
        `;

        const barContainer = progressEl.querySelector('.scan-progress-bar');
        barContainer.style.cssText = `
            height: 6px;
            background: var(--bg, #1a1a1a);
            border-radius: 3px;
            overflow: hidden;
        `;

        const fill = progressEl.querySelector('.scan-progress-fill');
        fill.style.cssText = `
            height: 100%;
            background: var(--accent, #4a9eff);
            border-radius: 3px;
            transition: width 0.2s ease;
        `;

        const text = progressEl.querySelector('.scan-progress-text');
        text.style.cssText = 'font-size: 12px; color: var(--text-muted, #888);';

        document.body.appendChild(progressEl);
        return progressEl;
    }

    /**
     * Update progress indicator
     * @param {HTMLElement} progressEl
     * @param {number} current - Current event number
     * @param {number} total - Total events
     * @param {number} foundCount - Number of items found
     * @param {number} clipsProcessed - Optional clips processed count
     */
    _updateScanProgress(progressEl, current, total, foundCount, clipsProcessed = null) {
        if (!progressEl) return;

        const percent = Math.round((current / total) * 100);
        const fill = progressEl.querySelector('.scan-progress-fill');
        const text = progressEl.querySelector('.scan-progress-text');

        if (fill) fill.style.width = `${percent}%`;
        if (text) {
            let statusText = `${current} / ${total} events`;
            if (clipsProcessed !== null) {
                statusText += ` (${clipsProcessed} clips)`;
            }
            statusText += ` • ${foundCount} found`;
            text.textContent = statusText;
        }
    }

    /**
     * Hide and remove progress indicator
     * @param {HTMLElement} progressEl
     */
    _hideScanProgress(progressEl) {
        if (progressEl && progressEl.parentNode) {
            progressEl.remove();
        }
    }

    /**
     * Handle online/offline status change
     * @param {boolean} isOnline
     */
    handleOnlineStatusChange(isOnline) {
        this.isOffline = !isOnline;
        console.log(`[MapView] Connection status changed: ${isOnline ? 'online' : 'offline'}`);

        if (isOnline && this.offlineOverlay) {
            this.hideOfflineOverlay();
            // Re-initialize map if it was blocked
            if (!this.initialized && this.container) {
                this.initialize();
                if (this.events.length > 0) {
                    this.loadEvents(this.events);
                }
            }
        } else if (!isOnline && this.initialized) {
            this.showOfflineOverlay();
        }
    }

    /**
     * Show offline overlay
     */
    showOfflineOverlay() {
        if (this.offlineOverlay) return;

        this.offlineOverlay = document.createElement('div');
        this.offlineOverlay.className = 'map-offline-overlay';
        this.offlineOverlay.innerHTML = `
            <div class="map-offline-content">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M23.64 7c-.45-.34-4.93-4-11.64-4-1.5 0-2.89.19-4.15.48L18.18 13.8 23.64 7zM17.04 15.22L3.27 1.44 2 2.72l2.05 2.06C1.91 5.76.59 6.82.36 7l11.63 14.49.01.01.01-.01 3.9-4.86 3.32 3.32 1.27-1.27-3.46-3.46z"/>
                </svg>
                <h3>Map Unavailable Offline</h3>
                <p>Map tiles require an internet connection to load.</p>
                <button class="map-offline-retry-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                    </svg>
                    Check Connection
                </button>
            </div>
        `;

        // Add retry button handler
        const retryBtn = this.offlineOverlay.querySelector('.map-offline-retry-btn');
        retryBtn.addEventListener('click', () => this.checkConnection());

        this.container.appendChild(this.offlineOverlay);
    }

    /**
     * Hide offline overlay
     */
    hideOfflineOverlay() {
        if (this.offlineOverlay) {
            this.offlineOverlay.remove();
            this.offlineOverlay = null;
        }
    }

    /**
     * Check if connection is available
     */
    async checkConnection() {
        const retryBtn = this.offlineOverlay?.querySelector('.map-offline-retry-btn');
        if (retryBtn) {
            retryBtn.disabled = true;
            retryBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="spin">
                    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                </svg>
                Checking...
            `;
        }

        try {
            // Try to fetch a small resource to verify connection (use current tile provider)
            const provider = this.TILE_PROVIDERS[this.tileProvider];
            let testUrl = provider?.light?.url || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
            // Replace placeholders with test tile coordinates
            testUrl = testUrl.replace('{s}', 'a').replace('{z}', '0').replace('{x}', '0').replace('{y}', '0').replace('{r}', '');
            const response = await fetch(testUrl, {
                method: 'HEAD',
                mode: 'no-cors',
                cache: 'no-store'
            });

            // If we get here without error, we're online
            this.handleOnlineStatusChange(true);
        } catch (error) {
            console.log('[MapView] Still offline:', error.message);
            if (retryBtn) {
                retryBtn.disabled = false;
                retryBtn.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                    </svg>
                    Still Offline - Try Again
                `;
            }
        }
    }

    /**
     * Initialize Leaflet map
     */
    initialize() {
        if (this.initialized || !this.container) {
            return;
        }

        // Check if we're offline
        if (!navigator.onLine) {
            this.isOffline = true;
            this.showOfflineOverlay();
            console.log('[MapView] Offline - map initialization deferred');
            return;
        }

        try {
            // Default center: Orlando, FL area (center of sample data)
            const defaultCenter = [28.4, -81.5];
            const defaultZoom = 10;

            // Create Leaflet map (keyboard: false prevents arrow keys from panning map)
            this.map = L.map(this.container, { keyboard: false }).setView(defaultCenter, defaultZoom);

            // Load dark mode preference
            this.isDarkMode = localStorage.getItem(this.DARK_MODE_KEY) === 'true';

            // Add tile layer based on preference
            this.setTileLayer(this.isDarkMode ? 'dark' : 'light');

            // Initialize marker cluster group
            this.markerCluster = L.markerClusterGroup({
                maxClusterRadius: 50,
                spiderfyOnMaxZoom: true,
                showCoverageOnHover: false,
                zoomToBoundsOnClick: true
            });

            this.map.addLayer(this.markerCluster);

            // Add heatmap toggle control
            this.addHeatmapControl();

            // Add struggle zones toggle control
            this.addStruggleZonesControl();

            // Add incident hotspots toggle control
            this.addIncidentControl();

            // Add dark mode toggle control
            this.addDarkModeControl();

            // Add scan all events control
            this.addScanAllEventsControl();

            // Initialize struggle zones marker cluster (hidden by default)
            this.struggleZonesMarkers = L.markerClusterGroup({
                maxClusterRadius: 30,
                spiderfyOnMaxZoom: true,
                showCoverageOnHover: false,
                zoomToBoundsOnClick: true,
                iconCreateFunction: (cluster) => {
                    const count = cluster.getChildCount();
                    return L.divIcon({
                        html: `<div class="struggle-zone-cluster">${count}</div>`,
                        className: 'struggle-zone-cluster-icon',
                        iconSize: [36, 36]
                    });
                }
            });

            // Initialize incident marker cluster (hidden by default)
            this.incidentMarkers = L.markerClusterGroup({
                maxClusterRadius: 30,
                spiderfyOnMaxZoom: true,
                showCoverageOnHover: false,
                zoomToBoundsOnClick: true,
                iconCreateFunction: (cluster) => {
                    const count = cluster.getChildCount();
                    return L.divIcon({
                        html: `<div class="incident-cluster">${count}</div>`,
                        className: 'incident-cluster-icon',
                        iconSize: [36, 36]
                    });
                }
            });

            this.initialized = true;
            console.log('[MapView] Map initialized successfully');
        } catch (error) {
            console.error('[MapView] Error initializing map:', error);
        }
    }

    /**
     * Load events onto the map
     * @param {Array} events
     */
    loadEvents(events) {
        if (!this.initialized) {
            this.initialize();
        }

        if (!this.map || !this.markerCluster) {
            console.warn('[MapView] Map not initialized');
            return;
        }

        // Clear existing markers
        this.markerCluster.clearLayers();
        this.events = events;

        // Add markers for events with GPS coordinates
        const markers = [];
        let validEventCount = 0;

        events.forEach(event => {
            if (this.hasValidGPS(event)) {
                const marker = this.createMarker(event);
                if (marker) {
                    markers.push(marker);
                    validEventCount++;
                }
            }
        });

        // Add all markers to cluster
        if (markers.length > 0) {
            this.markerCluster.addLayers(markers);
            console.log(`[MapView] Loaded ${validEventCount} events with GPS coordinates`);

            // Fit map bounds to show all markers
            this.fitBounds();
        } else {
            console.log('[MapView] No events with valid GPS coordinates');
        }
    }

    /**
     * Check if event has valid GPS coordinates
     * @param {Object} event
     * @returns {boolean}
     */
    hasValidGPS(event) {
        if (!event.metadata) return false;

        const lat = parseFloat(event.metadata.est_lat);
        const lon = parseFloat(event.metadata.est_lon);

        return !isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0;
    }

    /**
     * Create a marker for an event
     * @param {Object} event
     * @returns {L.Marker|null}
     */
    createMarker(event) {
        try {
            const lat = parseFloat(event.metadata.est_lat);
            const lon = parseFloat(event.metadata.est_lon);

            // Create marker with custom icon based on event type
            const marker = L.marker([lat, lon], {
                icon: this.getIconForType(event.type),
                title: event.name
            });

            // Bind popup with event details
            const popupContent = this.createPopupContent(event);
            marker.bindPopup(popupContent);

            // Click marker to load event
            marker.on('click', () => {
                if (this.onEventSelect) {
                    this.onEventSelect(event);
                }
            });

            return marker;
        } catch (error) {
            console.error('[MapView] Error creating marker for event:', event.name, error);
            return null;
        }
    }

    /**
     * Get custom icon for event type
     * @param {string} type
     * @returns {L.Icon}
     */
    getIconForType(type) {
        let color = '#2196f3'; // Default blue

        if (type === 'SavedClips') {
            color = '#2196f3'; // Blue
        } else if (type === 'SentryClips') {
            color = '#f44336'; // Red
        } else if (type === 'RecentClips') {
            color = '#757575'; // Gray
        }

        // Create colored marker icon using SVG
        const svgIcon = `
            <svg xmlns="http://www.w3.org/2000/svg" width="25" height="41" viewBox="0 0 25 41">
                <path fill="${color}" stroke="#fff" stroke-width="2" d="M12.5 0C5.6 0 0 5.6 0 12.5c0 8.4 12.5 28.5 12.5 28.5S25 20.9 25 12.5C25 5.6 19.4 0 12.5 0z"/>
                <circle cx="12.5" cy="12.5" r="5" fill="#fff"/>
            </svg>
        `;

        return L.divIcon({
            html: svgIcon,
            className: 'custom-marker-icon',
            iconSize: [25, 41],
            iconAnchor: [12, 41],
            popupAnchor: [0, -41]
        });
    }

    /**
     * Create popup content for event
     * @param {Object} event
     * @returns {string}
     */
    createPopupContent(event) {
        const date = new Date(event.timestamp);
        const dateStr = date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
        const timeStr = date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit'
        });

        // Get event type badge class
        const typeClass = event.type.toLowerCase().replace('clips', '');

        // Format location
        let location = '';
        if (event.metadata) {
            const city = event.metadata.city || '';
            const street = event.metadata.street || '';
            if (city && street) {
                location = `${street}, ${city}`;
            } else if (city) {
                location = city;
            } else if (street) {
                location = street;
            }
        }

        // Format reason
        const reason = event.metadata ?
            FolderParser.formatReason(event.metadata.reason) :
            '';

        // Build popup HTML
        let html = `
            <div class="map-popup">
                <div class="map-popup-header">
                    <span class="event-type ${typeClass}">${typeClass}</span>
                    <span class="map-popup-date">${dateStr}</span>
                </div>
                <div class="map-popup-time">${timeStr}</div>
        `;

        if (location) {
            html += `<div class="map-popup-location">${location}</div>`;
        }

        if (reason) {
            html += `<div class="map-popup-reason">${reason}</div>`;
        }

        html += `
                <div class="map-popup-clips">${event.clipGroups.length} clips</div>
                <div class="map-popup-action">Click to view event</div>
            </div>
        `;

        return html;
    }

    /**
     * Fit map bounds to show all markers
     */
    fitBounds() {
        if (!this.map || !this.markerCluster) {
            return;
        }

        const bounds = this.markerCluster.getBounds();
        if (bounds.isValid()) {
            this.map.fitBounds(bounds, {
                padding: [50, 50],
                maxZoom: 15
            });
        }
    }

    /**
     * Invalidate map size (call when container resizes)
     */
    invalidateSize() {
        if (this.map) {
            setTimeout(() => {
                this.map.invalidateSize();
                this.fitBounds();
            }, 100);
        }
    }

    /**
     * Clear all markers from map
     */
    clear() {
        if (this.markerCluster) {
            this.markerCluster.clearLayers();
        }
        this.events = [];
        this.telemetryGpsPoints = [];

        // Clear heatmap if exists
        if (this.heatLayer && this.map) {
            this.map.removeLayer(this.heatLayer);
            this.heatLayer = null;
        }

        // Clear struggle zones data
        this.apDisengagementPoints = [];
        if (this.struggleZonesLayer && this.map) {
            this.map.removeLayer(this.struggleZonesLayer);
            this.struggleZonesLayer = null;
        }
        if (this.struggleZonesMarkers) {
            this.struggleZonesMarkers.clearLayers();
            if (this.map) {
                this.map.removeLayer(this.struggleZonesMarkers);
            }
        }

        // Clear incident markers data
        this.incidentPoints = [];
        if (this.incidentHeatLayer && this.map) {
            this.map.removeLayer(this.incidentHeatLayer);
            this.incidentHeatLayer = null;
        }
        if (this.incidentMarkers) {
            this.incidentMarkers.clearLayers();
            if (this.map) {
                this.map.removeLayer(this.incidentMarkers);
            }
        }
    }

    /**
     * Load telemetry GPS data for heatmap visualization
     * This provides much denser GPS coverage than event metadata alone
     * @param {Array} events - Array of events to extract telemetry from
     */
    async loadTelemetryGpsData(events) {
        if (!window.seiExtractor || !events || events.length === 0) {
            console.log('[MapView] No SEI extractor or events available for telemetry GPS');
            return;
        }

        // Try to load from cache first
        const cachedPoints = this._loadGpsCache(events);
        if (cachedPoints && cachedPoints.length > 0) {
            this.telemetryGpsPoints = cachedPoints;
            return;
        }

        // Thresholds for user interaction
        const MAX_EVENTS_NO_WARNING = 20;
        const MAX_EVENTS_HARD_LIMIT = 200;
        const SUGGESTED_SAMPLE_SIZE = 50;

        let eventsToProcess = events;

        if (events.length > MAX_EVENTS_HARD_LIMIT) {
            // For very large datasets, force sampling
            const choice = confirm(
                `You have ${events.length} events - scanning all would be very slow.\n\n` +
                `Click OK to scan the ${SUGGESTED_SAMPLE_SIZE} most recent events,\n` +
                `or Cancel to skip GPS heatmap loading.\n\n` +
                `(Data will be cached for faster loading next time)`
            );
            if (!choice) {
                console.log('[MapView] User cancelled GPS telemetry loading (too many events)');
                return;
            }
            eventsToProcess = events.slice(0, SUGGESTED_SAMPLE_SIZE);
            console.log(`[MapView] Sampling ${SUGGESTED_SAMPLE_SIZE} of ${events.length} events`);
        } else if (events.length > MAX_EVENTS_NO_WARNING) {
            const proceed = confirm(
                `This will scan ${events.length} events for GPS telemetry data.\n\n` +
                `This may take a while. Continue?\n\n` +
                `(Data will be cached for faster loading next time)`
            );
            if (!proceed) {
                console.log('[MapView] User cancelled GPS telemetry loading');
                return;
            }
        }

        console.log(`[MapView] Loading telemetry GPS data from ${eventsToProcess.length} events...`);
        this.telemetryGpsPoints = [];
        this._scanCancelled = false;

        // Show progress indicator
        const progressEl = this._showScanProgress('GPS Telemetry', eventsToProcess.length);

        // Initialize SEI extractor if needed
        try {
            await window.seiExtractor.init();
        } catch (error) {
            console.error('[MapView] Failed to initialize SEI extractor:', error);
            this._hideScanProgress(progressEl);
            return;
        }

        // Process each event to extract GPS points from telemetry
        let totalPoints = 0;
        let eventsProcessed = 0;
        const BATCH_SIZE = 5; // Process in batches to keep UI responsive

        for (let i = 0; i < eventsToProcess.length; i++) {
            if (this._scanCancelled) {
                console.log('[MapView] GPS scan cancelled by user');
                break;
            }

            const event = eventsToProcess[i];
            if (!event.clipGroups || event.clipGroups.length === 0) continue;

            try {
                // Use first clip from first clip group to get representative GPS data
                // (Processing all clips would be too slow and redundant for heatmap)
                const firstClipGroup = event.clipGroups[0];
                const frontClip = firstClipGroup.clips?.front || firstClipGroup.clips?.back;

                if (!frontClip || !frontClip.fileHandle) continue;

                // Get actual File object from the clip's file handle
                const file = await frontClip.fileHandle.getFile();
                const seiData = await window.seiExtractor.extractFromFile(file);

                if (seiData && seiData.frames) {
                    // Sample frames to reduce data volume (every ~5 seconds of video)
                    const sampleInterval = Math.max(1, Math.floor(seiData.frames.length / 12));

                    for (let j = 0; j < seiData.frames.length; j += sampleInterval) {
                        const frame = seiData.frames[j];

                        if (frame.latitude_deg && frame.longitude_deg &&
                            Math.abs(frame.latitude_deg) > 0.001 &&
                            Math.abs(frame.longitude_deg) > 0.001) {

                            this.telemetryGpsPoints.push([
                                frame.latitude_deg,
                                frame.longitude_deg,
                                1 // Default intensity
                            ]);
                            totalPoints++;
                        }
                    }
                }
                eventsProcessed++;
            } catch (error) {
                console.warn(`[MapView] Failed to extract SEI data for event ${event.name}:`, error.message);
            }

            // Update progress and yield to UI every batch
            if (i % BATCH_SIZE === 0) {
                this._updateScanProgress(progressEl, i + 1, eventsToProcess.length, totalPoints);
                await new Promise(resolve => setTimeout(resolve, 0)); // Yield to UI
            }
        }

        this._hideScanProgress(progressEl);

        if (!this._scanCancelled) {
            console.log(`[MapView] Loaded ${totalPoints} telemetry GPS points from ${eventsProcessed} events`);

            // Save to cache for faster reloads
            this._saveGpsCache(events, this.telemetryGpsPoints);

            // Recreate heatmap if it's currently enabled
            if (this.heatmapEnabled && this.heatLayer) {
                this.createHeatmap();
                if (this.map) {
                    this.map.removeLayer(this.heatLayer);
                    this.map.addLayer(this.heatLayer);
                }
            }
        }
    }

    /**
     * Add GPS points directly (for pre-extracted telemetry data)
     * @param {Array} points - Array of [lat, lng] or [lat, lng, intensity]
     */
    addTelemetryGpsPoints(points) {
        if (!points || !Array.isArray(points)) return;

        this.telemetryGpsPoints = this.telemetryGpsPoints.concat(points);
        console.log(`[MapView] Added ${points.length} telemetry GPS points (total: ${this.telemetryGpsPoints.length})`);

        // Recreate heatmap if enabled
        if (this.heatmapEnabled && this.heatLayer) {
            this.createHeatmap();
            if (this.map) {
                this.map.removeLayer(this.heatLayer);
                this.map.addLayer(this.heatLayer);
            }
        }
    }

    /**
     * Check if telemetry GPS data is available
     * @returns {boolean}
     */
    hasTelemetryGpsData() {
        return this.telemetryGpsPoints.length > 0;
    }

    /**
     * Add heatmap toggle control to the map
     */
    addHeatmapControl() {
        if (!this.map) return;

        // Create custom control
        const HeatmapControl = L.Control.extend({
            options: { position: 'topright' },

            onAdd: (map) => {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control heatmap-control');
                const button = L.DomUtil.create('a', 'heatmap-toggle-btn', container);
                button.href = '#';
                button.title = this.t('map.toggleHeatmap') || 'Toggle Driving Heatmap';
                // Flame/heat icon for heatmap visualization
                button.innerHTML = `
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M13.5 0.67s0.74 2.65 0.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5 0.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z"/>
                    </svg>
                `;

                // Store button reference for updating state
                this._heatmapButton = button;

                L.DomEvent.on(button, 'click', (e) => {
                    L.DomEvent.preventDefault(e);
                    this.toggleHeatmap();
                    button.classList.toggle('active', this.heatmapEnabled);
                });

                return container;
            }
        });

        this.heatmapControl = new HeatmapControl();
        this.map.addControl(this.heatmapControl);
    }

    /**
     * Create or update the heatmap layer
     * Combines telemetry GPS data (dense coverage) with event metadata GPS (ensures all events shown)
     */
    createHeatmap() {
        if (!this.map) return;

        let heatData = [];
        let telemetryCount = 0;
        let metadataCount = 0;

        // Add telemetry GPS points (dense coverage from SEI data)
        if (this.telemetryGpsPoints.length > 0) {
            this.telemetryGpsPoints.forEach(point => {
                // Each point has [lat, lng] or [lat, lng, intensity]
                heatData.push(point.length === 3 ? point : [point[0], point[1], 1]);
            });
            telemetryCount = this.telemetryGpsPoints.length;
        }

        // Also add event metadata GPS to ensure all events are represented
        // This covers events that don't have SEI telemetry data
        if (this.events.length > 0) {
            this.events
                .filter(event => this.hasValidGPS(event))
                .forEach(event => {
                    const lat = parseFloat(event.metadata.est_lat);
                    const lon = parseFloat(event.metadata.est_lon);
                    // Weight sentry events more heavily
                    const weight = event.type === 'SentryClips' ? 1.5 : 1;
                    heatData.push([lat, lon, weight]);
                    metadataCount++;
                });
        }

        console.log(`[MapView] Heatmap using ${telemetryCount} telemetry points + ${metadataCount} event metadata points = ${heatData.length} total`)

        if (heatData.length === 0) {
            console.log('[MapView] No GPS data for heatmap');
            return;
        }

        // Remove existing heatmap if any
        if (this.heatLayer) {
            this.map.removeLayer(this.heatLayer);
        }

        // Adjust heatmap parameters based on data density
        const isDenseData = heatData.length > 100;
        const radius = isDenseData ? 20 : 35;
        const blur = isDenseData ? 15 : 20;

        // Create new heatmap layer with settings optimized for visibility at all zoom levels
        this.heatLayer = L.heatLayer(heatData, {
            radius: radius,
            blur: blur,
            maxZoom: 17,
            minOpacity: 0.4,
            max: 1.0,
            gradient: {
                0.0: 'rgba(0, 0, 255, 0.6)',
                0.25: 'rgba(0, 255, 255, 0.7)',
                0.5: 'rgba(0, 255, 0, 0.8)',
                0.75: 'rgba(255, 255, 0, 0.9)',
                1.0: 'rgba(255, 0, 0, 1.0)'
            }
        });

        console.log(`[MapView] Heatmap created with ${heatData.length} points (radius: ${radius}, blur: ${blur})`);
    }

    /**
     * Toggle between marker and heatmap view
     */
    async toggleHeatmap() {
        if (!this.map) return;

        this.heatmapEnabled = !this.heatmapEnabled;

        if (this.heatmapEnabled) {
            // If no telemetry GPS data loaded yet, try to load it
            if (this.telemetryGpsPoints.length === 0 && this.events.length > 0) {
                console.log('[MapView] Loading telemetry GPS data for heatmap...');
                // Show a loading indicator on the button
                if (this._heatmapButton) {
                    this._heatmapButton.classList.add('loading');
                }
                await this.loadTelemetryGpsData(this.events);
                if (this._heatmapButton) {
                    this._heatmapButton.classList.remove('loading');
                }
            }

            // Create heatmap if needed
            if (!this.heatLayer) {
                this.createHeatmap();
            }

            // Hide markers, show heatmap
            if (this.markerCluster) {
                this.map.removeLayer(this.markerCluster);
            }
            if (this.heatLayer) {
                this.map.addLayer(this.heatLayer);
            }
            console.log('[MapView] Switched to heatmap view');
        } else {
            // Hide heatmap, show markers
            if (this.heatLayer) {
                this.map.removeLayer(this.heatLayer);
            }
            if (this.markerCluster) {
                this.map.addLayer(this.markerCluster);
            }
            console.log('[MapView] Switched to marker view');
        }
    }

    // ==================== AUTOPILOT STRUGGLE ZONES ====================

    /**
     * Set the tile layer (light or dark mode)
     * @param {string} mode - 'light' or 'dark'
     */
    setTileLayer(mode) {
        if (!this.map) return;

        // Get the current provider's config
        const provider = this.TILE_PROVIDERS[this.tileProvider] || this.TILE_PROVIDERS.carto;
        const layerConfig = provider[mode];

        if (!layerConfig) {
            console.warn(`[MapView] Unknown tile layer mode: ${mode}`);
            return;
        }

        // Remove current tile layer
        if (this.currentTileLayer) {
            this.map.removeLayer(this.currentTileLayer);
        }

        // Add new tile layer with error handling
        const tileOptions = {
            attribution: layerConfig.attribution,
            maxZoom: 19
        };

        // Add subdomains if specified
        if (layerConfig.subdomains) {
            tileOptions.subdomains = layerConfig.subdomains;
        }

        this.currentTileLayer = L.tileLayer(layerConfig.url, tileOptions);

        // Add tile error handling
        this.currentTileLayer.on('tileerror', (e) => {
            console.warn('[MapView] Tile load error:', e.tile?.src);
            // Could trigger a fallback here in the future
        });

        this.currentTileLayer.addTo(this.map);

        this.isDarkMode = mode === 'dark';

        // Update container class for CSS styling of controls
        if (this.container) {
            this.container.classList.toggle('map-dark-mode', this.isDarkMode);
        }

        console.log(`[MapView] Tile layer set to: ${provider.name} (${mode})`);
    }

    /**
     * Set the tile provider
     * @param {string} providerId - Provider ID ('carto', 'osm', 'stadia')
     */
    setTileProvider(providerId) {
        if (!this.TILE_PROVIDERS[providerId]) {
            console.warn(`[MapView] Unknown tile provider: ${providerId}`);
            return;
        }

        this.tileProvider = providerId;
        this.TILE_LAYERS = this.TILE_PROVIDERS[providerId];

        // Save preference
        try {
            localStorage.setItem('teslacam_map_provider', providerId);
        } catch (e) {
            console.warn('[MapView] Failed to save provider preference:', e);
        }

        // Refresh the tile layer
        const mode = this.isDarkMode ? 'dark' : 'light';
        this.setTileLayer(mode);

        console.log(`[MapView] Tile provider changed to: ${this.TILE_PROVIDERS[providerId].name}`);
    }

    /**
     * Get available tile providers
     * @returns {Object} Provider ID to name mapping
     */
    getAvailableProviders() {
        const providers = {};
        for (const [id, config] of Object.entries(this.TILE_PROVIDERS)) {
            providers[id] = config.name;
        }
        return providers;
    }

    /**
     * Get current tile provider ID
     * @returns {string}
     */
    getCurrentProvider() {
        return this.tileProvider;
    }

    /**
     * Toggle between light and dark map tiles
     */
    toggleDarkMode() {
        const newMode = this.isDarkMode ? 'light' : 'dark';
        this.setTileLayer(newMode);

        // Save preference
        try {
            localStorage.setItem(this.DARK_MODE_KEY, this.isDarkMode.toString());
        } catch (e) {
            console.warn('[MapView] Failed to save dark mode preference:', e);
        }

        // Update button state
        if (this._darkModeButton) {
            this._darkModeButton.classList.toggle('active', this.isDarkMode);
        }
    }

    /**
     * Add dark mode toggle control to the map
     */
    addDarkModeControl() {
        if (!this.map) return;

        // Create custom control
        const DarkModeControl = L.Control.extend({
            options: { position: 'topright' },

            onAdd: (map) => {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control dark-mode-control');
                const button = L.DomUtil.create('a', 'dark-mode-toggle-btn', container);
                button.href = '#';
                button.title = this.t('map.toggleDarkMode') || 'Toggle Dark Mode Map';
                // Moon icon for dark mode
                button.innerHTML = `
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/>
                    </svg>
                `;

                // Store button reference for updating state
                this._darkModeButton = button;

                // Set initial active state
                if (this.isDarkMode) {
                    button.classList.add('active');
                }

                L.DomEvent.on(button, 'click', (e) => {
                    L.DomEvent.preventDefault(e);
                    this.toggleDarkMode();
                });

                return container;
            }
        });

        this.darkModeControl = new DarkModeControl();
        this.map.addControl(this.darkModeControl);
    }

    /**
     * Add Struggle Zones toggle control to the map
     */
    addStruggleZonesControl() {
        if (!this.map) return;

        // Create custom control
        const StruggleZonesControl = L.Control.extend({
            options: { position: 'topright' },

            onAdd: (map) => {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control struggle-zones-control');
                const button = L.DomUtil.create('a', 'struggle-zones-toggle-btn', container);
                button.href = '#';
                button.title = this.t('map.toggleStruggleZones') || 'Toggle Autopilot Struggle Zones';
                // Warning/caution triangle icon
                button.innerHTML = `
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                    </svg>
                `;

                // Store button reference for updating state
                this._struggleZonesButton = button;

                L.DomEvent.on(button, 'click', (e) => {
                    L.DomEvent.preventDefault(e);
                    this.toggleStruggleZones();
                    button.classList.toggle('active', this.struggleZonesEnabled);
                });

                return container;
            }
        });

        this.struggleZonesControl = new StruggleZonesControl();
        this.map.addControl(this.struggleZonesControl);
    }

    /**
     * Toggle Autopilot Struggle Zones layer
     * Shows only AP disengagements detected by TelemetryGraphs (source of truth)
     */
    async toggleStruggleZones() {
        if (!this.map) return;

        this.struggleZonesEnabled = !this.struggleZonesEnabled;

        if (this.struggleZonesEnabled) {
            // Load cached AP disengagements from previously viewed events
            if (this.apDisengagementPoints.length === 0) {
                this._loadCachedApDisengagements();
            }

            // Show message if no data yet
            if (this.apDisengagementPoints.length === 0) {
                if (window.app?.showToast) {
                    window.app.showToast(
                        'AP struggle zone data is collected as you view events. Use "Scan All Events" in settings for full map coverage.',
                        'info',
                        6000
                    );
                }
                console.log('[MapView] No AP disengagement data yet - collected as events are viewed');
            }

            // Create struggle zones layers if needed
            if (this.apDisengagementPoints.length > 0) {
                this.createStruggleZonesLayer();
            }

            // Show struggle zones
            if (this.struggleZonesLayer) {
                this.map.addLayer(this.struggleZonesLayer);
            }
            if (this.struggleZonesMarkers) {
                this.map.addLayer(this.struggleZonesMarkers);
            }
            console.log(`[MapView] Struggle zones enabled (${this.apDisengagementPoints.length} points)`);
        } else {
            // Hide struggle zones
            if (this.struggleZonesLayer) {
                this.map.removeLayer(this.struggleZonesLayer);
            }
            if (this.struggleZonesMarkers) {
                this.map.removeLayer(this.struggleZonesMarkers);
            }
            console.log('[MapView] Struggle zones disabled');
        }
    }

    /**
     * Receive AP disengagements from TelemetryGraphs (source of truth)
     * Called when an event is viewed and TelemetryGraphs processes its telemetry
     * @param {Array} apDisengagements - AP disengagements detected by TelemetryGraphs
     * @param {Object} event - The event being viewed
     */
    addApDisengagementsFromTelemetry(apDisengagements, event) {
        if (!apDisengagements || !event) return;

        const eventKey = event.compoundKey || event.name;

        // Convert TelemetryGraphs format to MapView format with event metadata
        const mapPoints = apDisengagements.map(ap => ({
            lat: ap.latitude || 0,
            lng: ap.longitude || 0,
            fromState: ap.fromMode,
            toState: ap.toMode || 'NONE',
            speed_mph: ap.speed || 0,
            eventName: event.name,
            eventType: event.type,
            timestamp: event.timestamp,
            eventTime: ap.time,  // Time within event for seeking
            eventKey: eventKey
        })).filter(p => p.lat !== 0 && p.lng !== 0);  // Filter out points without GPS

        if (mapPoints.length === 0) {
            console.log(`[MapView] No valid AP disengagements with GPS for event ${event.name}`);
            return;
        }

        // Remove any existing points for this event (in case of re-view)
        this.apDisengagementPoints = this.apDisengagementPoints.filter(p => p.eventKey !== eventKey);

        // Add the new points
        this.apDisengagementPoints.push(...mapPoints);

        console.log(`[MapView] Added ${mapPoints.length} AP disengagements from TelemetryGraphs for ${event.name} (total: ${this.apDisengagementPoints.length})`);

        // Cache the updated points
        this._saveApCachePerEvent(eventKey, mapPoints);

        // Update the layer if struggle zones are enabled
        if (this.struggleZonesEnabled && this.map) {
            this.createStruggleZonesLayer();
            if (this.struggleZonesLayer) {
                this.map.removeLayer(this.struggleZonesLayer);
                this.map.addLayer(this.struggleZonesLayer);
            }
            if (this.struggleZonesMarkers) {
                this.map.removeLayer(this.struggleZonesMarkers);
                this.map.addLayer(this.struggleZonesMarkers);
            }
        }
    }

    /**
     * Save AP disengagements for a specific event to cache
     * @param {string} eventKey - Unique event identifier
     * @param {Array} points - AP disengagement points for this event
     */
    _saveApCachePerEvent(eventKey, points) {
        try {
            const cacheKey = 'teslacamviewer_ap_per_event';
            const cache = JSON.parse(localStorage.getItem(cacheKey) || '{}');
            cache[eventKey] = {
                points: points,
                timestamp: Date.now(),
                version: this.cacheVersion
            };
            localStorage.setItem(cacheKey, JSON.stringify(cache));
        } catch (e) {
            console.warn('[MapView] Failed to save AP cache:', e);
        }
    }

    /**
     * Load cached AP disengagements from all previously viewed events
     */
    _loadCachedApDisengagements() {
        try {
            const cacheKey = 'teslacamviewer_ap_per_event';
            const cache = JSON.parse(localStorage.getItem(cacheKey) || '{}');

            let totalLoaded = 0;
            let eventsLoaded = 0;

            for (const [eventKey, data] of Object.entries(cache)) {
                // Skip if cache version doesn't match
                if (data.version !== this.cacheVersion) {
                    continue;
                }
                if (data.points && data.points.length > 0) {
                    // Check if event already loaded
                    const existingCount = this.apDisengagementPoints.filter(p => p.eventKey === eventKey).length;
                    if (existingCount === 0) {
                        this.apDisengagementPoints.push(...data.points);
                        totalLoaded += data.points.length;
                        eventsLoaded++;
                    }
                }
            }

            if (totalLoaded > 0) {
                console.log(`[MapView] Loaded ${totalLoaded} AP disengagements from ${eventsLoaded} cached events`);
            }
        } catch (e) {
            console.warn('[MapView] Failed to load AP cache:', e);
        }
    }

    // ==================== BULK SCAN ALL EVENTS ====================

    /**
     * Scan all events for telemetry data (incidents + AP disengagements)
     * This is an optimized bulk scan that samples frames like TelemetryGraphs
     * Uses the same detection logic as TelemetryGraphs for consistency
     * @param {Array} events - Array of events to scan (defaults to this.events)
     * @returns {Promise<{incidents: number, apDisengagements: number}>}
     */
    async scanAllEventsForMap(events = null) {
        events = events || this.events;

        if (!window.seiExtractor || !events || events.length === 0) {
            console.log('[MapView] No SEI extractor or events available for bulk scan');
            if (window.app?.showToast) {
                window.app.showToast('No events available to scan', 'warning', 3000);
            }
            return { incidents: 0, apDisengagements: 0 };
        }

        // Confirm with user - this can take a while
        const proceed = confirm(
            `Scan ${events.length} events for Incidents and AP Struggle Zones?\n\n` +
            `This will process telemetry data from all video clips and may take several minutes.\n` +
            `Progress will be shown and you can cancel at any time.\n\n` +
            `Results will be cached for instant loading next time.`
        );

        if (!proceed) {
            console.log('[MapView] User cancelled bulk scan');
            return { incidents: 0, apDisengagements: 0 };
        }

        console.log(`[MapView] Starting bulk scan of ${events.length} events...`);
        this._isScanning = true;
        this._scanCancelled = false;

        // Show progress indicator
        const progressEl = this._showScanProgress('All Events', events.length);

        // Initialize SEI extractor
        try {
            await window.seiExtractor.init();
        } catch (error) {
            console.error('[MapView] Failed to initialize SEI extractor:', error);
            this._hideScanProgress(progressEl);
            this._isScanning = false;
            return { incidents: 0, apDisengagements: 0 };
        }

        // Detection thresholds - match TelemetryGraphs exactly
        const INCIDENT_THRESHOLDS = {
            MIN_DECEL_G: 0.20,
            MIN_SPEED_DROP_MPH: 8,
            MIN_SPEED_MPH: 20,
            COOLDOWN_SEC: 5,
            WINDOW_SEC: 1.5
        };

        const FPS = 36;
        const SAMPLE_INTERVAL = Math.floor(FPS * 5); // Sample every ~5 seconds like TelemetryGraphs
        const AP_STATE_NAMES = ['NONE', 'FSD', 'AUTOSTEER', 'TACC'];

        let totalIncidents = 0;
        let totalApDisengagements = 0;
        let eventsProcessed = 0;
        let totalClipsProcessed = 0;

        for (let eventIdx = 0; eventIdx < events.length; eventIdx++) {
            if (this._scanCancelled) {
                console.log('[MapView] Bulk scan cancelled by user');
                break;
            }

            const event = events[eventIdx];
            const eventKey = event.compoundKey || event.name;

            if (!event.clipGroups || event.clipGroups.length === 0) continue;

            try {
                const eventIncidents = [];
                const eventApDisengagements = [];

                let lastIncidentTime = -Infinity;
                let previousApState = null;
                let clipTimeOffset = 0;

                // Collect sampled points for this event
                const sampledPoints = [];

                for (let clipIdx = 0; clipIdx < event.clipGroups.length; clipIdx++) {
                    if (this._scanCancelled) break;

                    const clipGroup = event.clipGroups[clipIdx];
                    const frontClip = clipGroup.clips?.front || clipGroup.clips?.back;

                    if (!frontClip || !frontClip.fileHandle) continue;

                    const file = await frontClip.fileHandle.getFile();
                    const seiData = await window.seiExtractor.extractFromFile(file);
                    totalClipsProcessed++;

                    if (seiData && seiData.frames && seiData.frames.length > 0) {
                        const frameCount = seiData.frames.length;

                        // Sample frames like TelemetryGraphs does
                        for (let i = 0; i < frameCount; i += SAMPLE_INTERVAL) {
                            const frame = seiData.frames[i];
                            const frameTime = clipTimeOffset + (i / FPS);

                            const hasValidGps = frame.latitude_deg &&
                                frame.longitude_deg &&
                                Math.abs(frame.latitude_deg) > 0.001 &&
                                Math.abs(frame.longitude_deg) > 0.001;

                            if (!hasValidGps) continue;

                            // Build sampled point
                            const point = {
                                time: frameTime,
                                speed_mph: frame.speed_mph || 0,
                                g_force_y: frame.g_force_y || 0,
                                autopilot: AP_STATE_NAMES[frame.autopilot_state] || 'NONE',
                                autopilot_state: frame.autopilot_state || 0,
                                brake: frame.brake_applied || false,
                                latitude: frame.latitude_deg,
                                longitude: frame.longitude_deg
                            };
                            sampledPoints.push(point);

                            // Detect AP disengagement
                            if (previousApState !== null &&
                                previousApState > 0 &&
                                frame.autopilot_state === 0) {

                                eventApDisengagements.push({
                                    lat: frame.latitude_deg,
                                    lng: frame.longitude_deg,
                                    fromState: AP_STATE_NAMES[previousApState] || 'UNKNOWN',
                                    toState: 'NONE',
                                    speed_mph: frame.speed_mph || 0,
                                    eventName: event.name,
                                    eventType: event.type,
                                    timestamp: event.timestamp,
                                    eventTime: frameTime,
                                    eventKey: eventKey
                                });
                            }

                            previousApState = frame.autopilot_state;
                        }

                        clipTimeOffset += frameCount / FPS;
                    }
                }

                // Detect incidents from sampled points (matching TelemetryGraphs logic)
                for (let i = 1; i < sampledPoints.length; i++) {
                    const point = sampledPoints[i];

                    // Apply cooldown
                    if (point.time - lastIncidentTime < INCIDENT_THRESHOLDS.COOLDOWN_SEC) continue;

                    // Find window start
                    let windowStartIdx = i;
                    for (let j = i - 1; j >= 0; j--) {
                        if (point.time - sampledPoints[j].time >= INCIDENT_THRESHOLDS.WINDOW_SEC) {
                            windowStartIdx = j;
                            break;
                        }
                    }

                    const windowStart = sampledPoints[windowStartIdx];

                    // Check AP was active at START of window (not current point)
                    // Driver may disengage AP as RESPONSE to incident
                    if (windowStart.autopilot === 'NONE' || windowStart.brake) continue;
                    if (windowStart.speed_mph < INCIDENT_THRESHOLDS.MIN_SPEED_MPH) continue;

                    const speedDrop = windowStart.speed_mph - point.speed_mph;

                    // Calculate g-force over window (include data after driver intervention)
                    let maxDecelG = 0;
                    let gForceSum = 0;
                    let gForceCount = 0;
                    for (let j = windowStartIdx; j <= i; j++) {
                        const gY = sampledPoints[j].g_force_y || 0;
                        if (gY > 0) {
                            gForceSum += gY;
                            gForceCount++;
                            if (gY > maxDecelG) maxDecelG = gY;
                        }
                    }
                    const avgDecelG = gForceCount > 0 ? gForceSum / gForceCount : 0;

                    // Check thresholds (AND logic - must have both)
                    if (speedDrop >= INCIDENT_THRESHOLDS.MIN_SPEED_DROP_MPH &&
                        (avgDecelG >= INCIDENT_THRESHOLDS.MIN_DECEL_G || maxDecelG >= INCIDENT_THRESHOLDS.MIN_DECEL_G * 1.5)) {

                        let severity;
                        if (speedDrop >= 20 || maxDecelG >= 0.5) {
                            severity = 'critical';
                        } else if (speedDrop >= 12 || maxDecelG >= 0.35) {
                            severity = 'warning';
                        } else {
                            severity = 'info';
                        }

                        eventIncidents.push({
                            lat: point.latitude,
                            lng: point.longitude,
                            severity: severity,
                            gForce: maxDecelG,
                            avgGForce: avgDecelG,
                            speedDrop: speedDrop,
                            speed: windowStart.speed_mph,
                            autopilotMode: point.autopilot,
                            eventName: event.name,
                            eventType: event.type,
                            timestamp: event.timestamp,
                            eventTime: point.time,
                            eventKey: eventKey
                        });

                        lastIncidentTime = point.time;
                    }
                }

                // Cache results for this event
                if (eventIncidents.length > 0) {
                    this._saveIncidentCachePerEvent(eventKey, eventIncidents);
                    // Remove existing and add new
                    this.incidentPoints = this.incidentPoints.filter(p => p.eventKey !== eventKey);
                    this.incidentPoints.push(...eventIncidents);
                    totalIncidents += eventIncidents.length;
                }

                if (eventApDisengagements.length > 0) {
                    this._saveApCachePerEvent(eventKey, eventApDisengagements);
                    // Remove existing and add new
                    this.apDisengagementPoints = this.apDisengagementPoints.filter(p => p.eventKey !== eventKey);
                    this.apDisengagementPoints.push(...eventApDisengagements);
                    totalApDisengagements += eventApDisengagements.length;
                }

                eventsProcessed++;
            } catch (error) {
                console.warn(`[MapView] Failed to scan event ${event.name}:`, error.message);
            }

            // Update progress
            const totalDetections = totalIncidents + totalApDisengagements;
            this._updateScanProgress(progressEl, eventIdx + 1, events.length, totalDetections, totalClipsProcessed);

            // Yield to UI every few events
            if (eventIdx % 2 === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        this._hideScanProgress(progressEl);

        if (!this._scanCancelled) {
            console.log(`[MapView] Bulk scan complete: ${totalIncidents} incidents, ${totalApDisengagements} AP disengagements from ${eventsProcessed} events`);

            if (window.app?.showToast) {
                window.app.showToast(
                    `Scan complete: ${totalIncidents} incidents, ${totalApDisengagements} AP issues found`,
                    'success',
                    5000
                );
            }

            // Update layers if enabled
            if (this.incidentMarkersEnabled) {
                this.createIncidentLayer();
            }
            if (this.struggleZonesEnabled) {
                this.createStruggleZonesLayer();
            }
        }

        this._isScanning = false;
        return { incidents: totalIncidents, apDisengagements: totalApDisengagements };
    }

    /**
     * Convert heading degrees to cardinal direction
     * @param {number} heading - Heading in degrees (0-360)
     * @returns {Object} Direction info {name, shortName, angle}
     */
    getCardinalDirection(heading) {
        // Normalize heading to 0-360
        heading = ((heading % 360) + 360) % 360;

        // 8 cardinal directions, each covering 45 degrees
        const directions = [
            { name: 'North', shortName: 'N', angle: 0 },
            { name: 'Northeast', shortName: 'NE', angle: 45 },
            { name: 'East', shortName: 'E', angle: 90 },
            { name: 'Southeast', shortName: 'SE', angle: 135 },
            { name: 'South', shortName: 'S', angle: 180 },
            { name: 'Southwest', shortName: 'SW', angle: 225 },
            { name: 'West', shortName: 'W', angle: 270 },
            { name: 'Northwest', shortName: 'NW', angle: 315 }
        ];

        // Find the closest direction (within 22.5 degrees)
        const index = Math.round(heading / 45) % 8;
        return directions[index];
    }

    /**
     * Create the struggle zones heatmap and markers layer
     */
    createStruggleZonesLayer() {
        if (!this.map || this.apDisengagementPoints.length === 0) {
            console.log('[MapView] No AP disengagement data for struggle zones');
            return;
        }

        // Remove existing layers
        if (this.struggleZonesLayer) {
            this.map.removeLayer(this.struggleZonesLayer);
        }
        if (this.struggleZonesMarkers) {
            this.struggleZonesMarkers.clearLayers();
        }

        // Aggregate points by location AND direction (grid-based clustering)
        // Use ~100m grid cells for grouping nearby disengagements
        const gridSize = 0.001; // ~100m at mid-latitudes
        const locationCounts = new Map();

        for (const point of this.apDisengagementPoints) {
            // Round to grid cell
            const gridLat = Math.round(point.lat / gridSize) * gridSize;
            const gridLng = Math.round(point.lng / gridSize) * gridSize;

            // Get cardinal direction from heading
            const direction = this.getCardinalDirection(point.heading_deg || 0);

            // Key includes location AND direction for better pattern detection
            const key = `${gridLat.toFixed(4)},${gridLng.toFixed(4)},${direction.shortName}`;

            if (!locationCounts.has(key)) {
                locationCounts.set(key, {
                    lat: gridLat,
                    lng: gridLng,
                    direction: direction,
                    count: 0,
                    points: []
                });
            }
            const cell = locationCounts.get(key);
            cell.count++;
            cell.points.push(point);
        }

        // Create heat data with intensity based on count
        const heatData = [];
        const maxCount = Math.max(...Array.from(locationCounts.values()).map(c => c.count));

        for (const [key, cell] of locationCounts) {
            // Normalize intensity: 1 disengagement = 0.3, max = 1.0
            const intensity = Math.max(0.3, cell.count / Math.max(maxCount, 1));
            heatData.push([cell.lat, cell.lng, intensity]);
        }

        // Create heatmap layer with warning colors (yellow to orange to red)
        this.struggleZonesLayer = L.heatLayer(heatData, {
            radius: 35,
            blur: 25,
            maxZoom: 17,
            minOpacity: 0.5,
            max: 1.0,
            gradient: {
                0.0: 'rgba(255, 235, 59, 0.6)',   // Yellow
                0.3: 'rgba(255, 193, 7, 0.7)',    // Amber
                0.5: 'rgba(255, 152, 0, 0.8)',    // Orange
                0.7: 'rgba(255, 87, 34, 0.9)',    // Deep Orange
                1.0: 'rgba(244, 67, 54, 1.0)'     // Red
            }
        });

        // Create clickable markers for each aggregated location+direction
        for (const [key, cell] of locationCounts) {
            const marker = L.marker([cell.lat, cell.lng], {
                icon: this.getStruggleZoneIcon(cell.count, maxCount, cell.direction)
            });

            // Create popup with disengagement details
            const popupContent = this.createStruggleZonePopup(cell);
            marker.bindPopup(popupContent, {
                maxWidth: 400,
                maxHeight: 350
            });

            // Bind popup event handlers after popup opens
            marker.on('popupopen', () => {
                this._bindStruggleZonePopupEvents(cell);
            });

            this.struggleZonesMarkers.addLayer(marker);
        }

        console.log(`[MapView] Created struggle zones layer with ${locationCounts.size} aggregated locations`);
    }

    /**
     * Get icon for struggle zone marker based on severity and direction
     * @param {number} count - Number of disengagements at this location
     * @param {number} maxCount - Maximum count across all locations
     * @param {Object} direction - Direction info from getCardinalDirection
     * @returns {L.DivIcon}
     */
    getStruggleZoneIcon(count, maxCount, direction) {
        // Color based on severity (yellow -> orange -> red)
        const severity = count / Math.max(maxCount, 1);
        let color;
        if (severity < 0.3) {
            color = '#ffeb3b'; // Yellow
        } else if (severity < 0.6) {
            color = '#ff9800'; // Orange
        } else {
            color = '#f44336'; // Red
        }

        // Size based on count (min 28, max 44)
        const size = Math.min(44, Math.max(28, 24 + count * 4));

        // Create icon with direction arrow
        // Arrow points in direction of travel when disengagement occurred
        const arrowAngle = direction ? direction.angle : 0;
        const dirLabel = direction ? direction.shortName : '';

        const svgIcon = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
                <!-- Background circle -->
                <circle cx="16" cy="16" r="14" fill="${color}" stroke="#fff" stroke-width="2"/>
                <!-- Direction arrow -->
                <g transform="rotate(${arrowAngle}, 16, 16)">
                    <path d="M16 6 L20 14 L17 14 L17 22 L15 22 L15 14 L12 14 Z" fill="#fff" opacity="0.9"/>
                </g>
                <!-- Count badge -->
                <circle cx="24" cy="8" r="7" fill="#fff" stroke="${color}" stroke-width="1"/>
                <text x="24" y="11" text-anchor="middle" font-size="8" font-weight="bold" fill="${color}">${count}</text>
            </svg>
        `;

        return L.divIcon({
            html: svgIcon,
            className: 'struggle-zone-icon',
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
            popupAnchor: [0, -size / 2]
        });
    }

    /**
     * Create popup content for struggle zone marker
     * @param {Object} cell - Aggregated cell data with points array and direction
     * @returns {string} HTML content for popup
     */
    createStruggleZonePopup(cell) {
        const count = cell.count;
        const points = cell.points;
        const direction = cell.direction;

        // Group by event type
        const byType = {};
        const byFromState = {};

        for (const point of points) {
            const type = point.eventType || 'Unknown';
            byType[type] = (byType[type] || 0) + 1;

            const fromState = point.fromState || 'Unknown';
            byFromState[fromState] = (byFromState[fromState] || 0) + 1;
        }

        // Format type breakdown
        const typeBreakdown = Object.entries(byType)
            .map(([type, cnt]) => `<span class="struggle-zone-type ${type.toLowerCase().replace('clips', '')}">${cnt}x ${type.replace('Clips', '')}</span>`)
            .join(' ');

        // Format AP state breakdown
        const stateBreakdown = Object.entries(byFromState)
            .map(([state, cnt]) => `<span class="struggle-zone-state">${cnt}x ${state}</span>`)
            .join(' ');

        // Direction arrow SVG
        const directionArrow = direction ? `
            <svg width="16" height="16" viewBox="0 0 24 24" style="transform: rotate(${direction.angle}deg);">
                <path fill="currentColor" d="M12 2L8 10h3v12h2V10h3L12 2z"/>
            </svg>
        ` : '';

        // List disengagements (max 6) - now clickable
        const eventsList = points
            .slice(0, 6)
            .map((point, idx) => {
                const date = new Date(point.timestamp);
                const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                const speed = Math.round(point.speed_mph || 0);
                return `
                    <div class="struggle-zone-event clickable"
                         data-event-idx="${idx}"
                         title="Click to view this event">
                        <span class="event-date">${dateStr} ${timeStr}</span>
                        <span class="event-from-state">${point.fromState}</span>
                        <span class="event-speed">${speed} mph</span>
                        <span class="event-view-icon">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z"/>
                            </svg>
                        </span>
                    </div>
                `;
            })
            .join('');

        const moreCount = points.length > 6 ? `<div class="struggle-zone-more">+${points.length - 6} more events</div>` : '';

        return `
            <div class="struggle-zone-popup">
                <div class="struggle-zone-header">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="#f44336">
                        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                    </svg>
                    <span class="struggle-zone-title">AP Struggle Zone</span>
                    ${direction ? `<span class="struggle-zone-direction" title="Direction of travel">${directionArrow} ${direction.name}bound</span>` : ''}
                </div>
                <div class="struggle-zone-count">${count} Disengagement${count > 1 ? 's' : ''} heading ${direction ? direction.shortName : 'unknown'}</div>
                <div class="struggle-zone-breakdown">
                    <div class="breakdown-row">
                        <label>Event Types:</label>
                        ${typeBreakdown}
                    </div>
                    <div class="breakdown-row">
                        <label>AP Modes:</label>
                        ${stateBreakdown}
                    </div>
                </div>
                <div class="struggle-zone-events-header">Click to view clip:</div>
                <div class="struggle-zone-events">
                    ${eventsList}
                    ${moreCount}
                </div>
                <div class="struggle-zone-tip">
                    <small>Pattern: ${count} disengagements when driving ${direction ? direction.name.toLowerCase() : 'through this area'}.</small>
                </div>
            </div>
        `;
    }

    /**
     * Bind click events to struggle zone popup items
     * @param {Object} cell - Cell data with points array
     */
    _bindStruggleZonePopupEvents(cell) {
        const popupEl = document.querySelector('.struggle-zone-popup');
        if (!popupEl) return;

        const clickableEvents = popupEl.querySelectorAll('.struggle-zone-event.clickable');
        clickableEvents.forEach((el, idx) => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const point = cell.points[idx];
                if (!point || !this.onEventSelect) return;

                // Find the event by name from the loaded events
                const event = this.events.find(ev => ev.name === point.eventName);
                if (!event) {
                    console.warn(`[MapView] Event not found: ${point.eventName}`);
                    return;
                }

                // Close the popup
                this.map.closePopup();

                // Calculate the event time in seconds
                // Each clip is ~60 seconds, Tesla dashcam is 36 fps
                const clipIndex = point.clipIndex || 0;
                const frameIndex = point.frameIndex || 0;
                const CLIP_DURATION = 60; // seconds per clip
                const FPS = 36; // Tesla dashcam frame rate

                // Calculate approximate time from start of event
                const eventTime = (clipIndex * CLIP_DURATION) + (frameIndex / FPS);

                console.log(`[MapView] Navigating to event ${point.eventName}, clip ${clipIndex}, frame ${frameIndex}, time ${eventTime.toFixed(1)}s`);

                // Load the event
                this.onEventSelect(event);

                // After the event loads, seek to the exact position
                // Need to wait for video to be ready
                let retryCount = 0;
                const maxRetries = 20; // 4 seconds max wait

                const seekToDisengagement = async () => {
                    retryCount++;

                    // Check if the correct event is loaded and video is ready
                    if (window.app?.videoPlayer?.currentEvent?.name === event.name) {
                        try {
                            await window.app.videoPlayer.seekToEventTime(eventTime);
                            console.log(`[MapView] Seeked to disengagement at ${eventTime.toFixed(1)}s`);
                        } catch (error) {
                            console.warn('[MapView] Failed to seek to disengagement:', error);
                        }
                    } else if (retryCount < maxRetries) {
                        // Video not ready yet or wrong event, retry
                        setTimeout(seekToDisengagement, 200);
                    } else {
                        console.warn('[MapView] Timed out waiting for event to load');
                    }
                };

                // Start seeking after a short delay for event to load
                setTimeout(seekToDisengagement, 300);
            });
        });
    }

    /**
     * Check if AP disengagement data is available
     * @returns {boolean}
     */
    hasApDisengagementData() {
        return this.apDisengagementPoints.length > 0;
    }

    /**
     * Get AP disengagement statistics
     * @returns {Object} Stats about disengagements
     */
    getApDisengagementStats() {
        const points = this.apDisengagementPoints;
        if (points.length === 0) return null;

        const byFromState = {};
        const byEventType = {};

        for (const point of points) {
            const fromState = point.fromState || 'Unknown';
            byFromState[fromState] = (byFromState[fromState] || 0) + 1;

            const eventType = point.eventType || 'Unknown';
            byEventType[eventType] = (byEventType[eventType] || 0) + 1;
        }

        return {
            total: points.length,
            byFromState,
            byEventType
        };
    }

    // ==================== PHANTOM BRAKE HOTSPOTS ====================

    /**
     * Add Incident Hotspots toggle control to the map
     */
    addIncidentControl() {
        if (!this.map) return;

        // Create custom control
        const IncidentMapControl = L.Control.extend({
            options: { position: 'topright' },

            onAdd: (map) => {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control incident-control');
                const button = L.DomUtil.create('a', 'incident-toggle-btn', container);
                button.href = '#';
                button.title = this.t('map.toggleIncidents') || 'Toggle Incident Markers';
                // Brake/stop icon
                button.innerHTML = `
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/>
                        <path d="M7 11h10v2H7z"/>
                    </svg>
                `;

                // Store button reference for updating state
                this._incidentButton = button;

                L.DomEvent.on(button, 'click', (e) => {
                    L.DomEvent.preventDefault(e);
                    this.toggleIncidentMarkers();
                    button.classList.toggle('active', this.incidentMarkersEnabled);
                });

                return container;
            }
        });

        this.incidentControl = new IncidentMapControl();
        this.map.addControl(this.incidentControl);
    }

    /**
     * Toggle Incident Hotspots layer
     * Shows only incidents detected by TelemetryGraphs (source of truth)
     */
    async toggleIncidentMarkers() {
        if (!this.map) return;

        this.incidentMarkersEnabled = !this.incidentMarkersEnabled;

        if (this.incidentMarkersEnabled) {
            // Load cached incidents from previously viewed events
            if (this.incidentPoints.length === 0) {
                this._loadCachedIncidents();
            }

            // Show message if no data yet
            if (this.incidentPoints.length === 0) {
                if (window.app?.showToast) {
                    window.app.showToast(
                        'Incident data is collected as you view events. Browse events to populate the map.',
                        'info',
                        5000
                    );
                }
                console.log('[MapView] No incident data yet - collected as events are viewed');
            }

            // Create incident layers if needed
            if (this.incidentPoints.length > 0) {
                this.createIncidentLayer();
            }

            // Show incident hotspots
            if (this.incidentHeatLayer) {
                this.map.addLayer(this.incidentHeatLayer);
            }
            if (this.incidentMarkers) {
                this.map.addLayer(this.incidentMarkers);
            }
            console.log(`[MapView] Incident markers enabled (${this.incidentPoints.length} points)`);
        } else {
            // Hide incident hotspots
            if (this.incidentHeatLayer) {
                this.map.removeLayer(this.incidentHeatLayer);
            }
            if (this.incidentMarkers) {
                this.map.removeLayer(this.incidentMarkers);
            }
            console.log('[MapView] Incident markers disabled');
        }
    }

    /**
     * Add "Scan All Events" control button to the map
     * Allows user to scan all events for incidents and AP disengagements
     */
    addScanAllEventsControl() {
        if (!this.map) return;

        // Create custom control - tcv.0x4D5343
        const ScanAllControl = L.Control.extend({
            options: { position: 'topright' },

            onAdd: (map) => {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control scan-all-control');
                const button = L.DomUtil.create('a', 'scan-all-btn', container);
                button.href = '#';
                button.title = this.t('map.scanAllEvents') || 'Scan All Events for Map Data';
                // Radar/scan icon
                button.innerHTML = `
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/>
                        <path d="M12 6v6l4 2"/>
                        <circle cx="12" cy="12" r="2"/>
                    </svg>
                `;

                // Store button reference for updating state
                this._scanAllButton = button;

                L.DomEvent.on(button, 'click', async (e) => {
                    L.DomEvent.preventDefault(e);

                    // Don't allow if already scanning
                    if (this._isScanning) {
                        if (window.app?.showToast) {
                            window.app.showToast('Scan already in progress...', 'info', 2000);
                        }
                        return;
                    }

                    // Confirm with user since this can take time
                    const eventCount = this.events?.length || 0;
                    if (eventCount === 0) {
                        if (window.app?.showToast) {
                            window.app.showToast('No events available to scan', 'warning', 3000);
                        }
                        return;
                    }

                    // Start scan
                    button.classList.add('scanning');
                    const result = await this.scanAllEventsForMap();
                    button.classList.remove('scanning');

                    // Show results
                    if (result.incidents > 0 || result.apDisengagements > 0) {
                        if (window.app?.showToast) {
                            window.app.showToast(
                                `Scan complete: ${result.incidents} incidents, ${result.apDisengagements} AP disengagements found`,
                                'success',
                                5000
                            );
                        }
                    }
                });

                return container;
            }
        });

        this.scanAllControl = new ScanAllControl();
        this.map.addControl(this.scanAllControl);
    }

    /**
     * Receive incident detections from TelemetryGraphs (source of truth)
     * Called when an event is viewed and TelemetryGraphs processes its telemetry
     * @param {Array} incidents - Incidents detected by TelemetryGraphs
     * @param {Object} event - The event being viewed
     */
    addIncidentsFromTelemetry(incidents, event) {
        if (!incidents || !event) return;

        const eventKey = event.compoundKey || event.name;

        // Convert TelemetryGraphs format to MapView format with event metadata
        const mapPoints = incidents.map(inc => ({
            lat: inc.latitude || 0,
            lng: inc.longitude || 0,
            type: inc.type || 'braking',
            severity: inc.severity,
            gForce: inc.gForce,
            avgGForce: inc.avgGForce,
            lateralG: inc.lateralG,
            avgLateralG: inc.avgLateralG,
            speedDrop: inc.speedDrop,
            speed: inc.speed,
            autopilotMode: inc.autopilotMode,
            eventName: event.name,
            eventType: event.type,
            timestamp: event.timestamp,
            eventTime: inc.time,  // Time within event for seeking
            eventKey: eventKey
        })).filter(p => p.lat !== 0 && p.lng !== 0);  // Filter out points without GPS

        if (mapPoints.length === 0) {
            console.log(`[MapView] No valid incidents with GPS for event ${event.name}`);
            return;
        }

        // Remove any existing points for this event (in case of re-view)
        this.incidentPoints = this.incidentPoints.filter(p => p.eventKey !== eventKey);

        // Add the new points
        this.incidentPoints.push(...mapPoints);

        console.log(`[MapView] Added ${mapPoints.length} incidents from TelemetryGraphs for ${event.name} (total: ${this.incidentPoints.length})`);

        // Cache the updated points
        this._saveIncidentCachePerEvent(eventKey, mapPoints);

        // Update the layer if hotspots are enabled
        if (this.incidentMarkersEnabled && this.map) {
            this.createIncidentLayer();
            if (this.incidentHeatLayer) {
                this.map.removeLayer(this.incidentHeatLayer);
                this.map.addLayer(this.incidentHeatLayer);
            }
            if (this.incidentMarkers) {
                this.map.removeLayer(this.incidentMarkers);
                this.map.addLayer(this.incidentMarkers);
            }
        }
    }

    /**
     * Save incidents for a specific event to cache
     * @param {string} eventKey - Unique event identifier
     * @param {Array} points - Incident points for this event
     */
    _saveIncidentCachePerEvent(eventKey, points) {
        try {
            const cacheKey = 'teslacamviewer_incident_per_event';
            const cache = JSON.parse(localStorage.getItem(cacheKey) || '{}');
            cache[eventKey] = {
                points: points,
                timestamp: Date.now(),
                version: this.cacheVersion
            };
            localStorage.setItem(cacheKey, JSON.stringify(cache));
        } catch (e) {
            console.warn('[MapView] Failed to save incident cache:', e);
        }
    }

    /**
     * Load cached incidents from all previously viewed events
     */
    _loadCachedIncidents() {
        try {
            const cacheKey = 'teslacamviewer_incident_per_event';
            const cache = JSON.parse(localStorage.getItem(cacheKey) || '{}');

            let totalLoaded = 0;
            let eventsLoaded = 0;

            for (const [eventKey, data] of Object.entries(cache)) {
                // Skip if cache version doesn't match
                if (data.version !== this.cacheVersion) {
                    continue;
                }
                if (data.points && data.points.length > 0) {
                    // Check if event already loaded
                    const existingCount = this.incidentPoints.filter(p => p.eventKey === eventKey).length;
                    if (existingCount === 0) {
                        this.incidentPoints.push(...data.points);
                        totalLoaded += data.points.length;
                        eventsLoaded++;
                    }
                }
            }

            if (totalLoaded > 0) {
                console.log(`[MapView] Loaded ${totalLoaded} incidents from ${eventsLoaded} cached events`);
            }
        } catch (e) {
            console.warn('[MapView] Failed to load incident cache:', e);
        }
    }

    /**
     * Create the incident hotspots heatmap and markers layer
     */
    createIncidentLayer() {
        if (!this.map || this.incidentPoints.length === 0) {
            console.log('[MapView] No incident data for hotspots');
            return;
        }

        // Remove existing layers
        if (this.incidentHeatLayer) {
            this.map.removeLayer(this.incidentHeatLayer);
        }
        if (this.incidentMarkers) {
            this.incidentMarkers.clearLayers();
        }

        // Severity weights for intensity calculation
        const severityWeights = {
            'critical': 1.0,
            'warning': 0.6,
            'info': 0.3
        };

        // Aggregate points by location (grid-based clustering)
        const gridSize = 0.001; // ~100m at mid-latitudes
        const locationCounts = new Map();

        for (const point of this.incidentPoints) {
            // Round to grid cell
            const gridLat = Math.round(point.lat / gridSize) * gridSize;
            const gridLng = Math.round(point.lng / gridSize) * gridSize;

            // Key includes location only (not direction - incidents happen regardless of direction)
            const key = `${gridLat.toFixed(4)},${gridLng.toFixed(4)}`;

            if (!locationCounts.has(key)) {
                locationCounts.set(key, {
                    lat: gridLat,
                    lng: gridLng,
                    count: 0,
                    weightedCount: 0,
                    points: [],
                    severityCounts: { critical: 0, warning: 0, info: 0 }
                });
            }
            const cell = locationCounts.get(key);
            cell.count++;
            cell.weightedCount += severityWeights[point.severity] || 0.3;
            cell.points.push(point);
            cell.severityCounts[point.severity]++;
        }

        // Create heat data with severity-weighted intensity
        const heatData = [];
        const maxWeightedCount = Math.max(...Array.from(locationCounts.values()).map(c => c.weightedCount));

        for (const [key, cell] of locationCounts) {
            // Normalize intensity based on weighted count
            const intensity = Math.max(0.3, cell.weightedCount / Math.max(maxWeightedCount, 1));
            heatData.push([cell.lat, cell.lng, intensity]);
        }

        // Create heatmap layer with red/orange colors (distinct from yellow struggle zones)
        this.incidentHeatLayer = L.heatLayer(heatData, {
            radius: 35,
            blur: 25,
            maxZoom: 17,
            minOpacity: 0.5,
            max: 1.0,
            gradient: {
                0.0: 'rgba(255, 152, 0, 0.5)',   // Orange (low - info)
                0.3: 'rgba(255, 87, 34, 0.6)',    // Deep Orange
                0.5: 'rgba(244, 67, 54, 0.7)',    // Red
                0.7: 'rgba(229, 57, 53, 0.85)',   // Darker Red
                1.0: 'rgba(183, 28, 28, 1.0)'     // Dark Red (critical)
            }
        });

        // Create clickable markers for each aggregated location
        for (const [key, cell] of locationCounts) {
            const marker = L.marker([cell.lat, cell.lng], {
                icon: this.getIncidentIcon(cell)
            });

            // Create popup with incident details
            const popupContent = this.createIncidentPopup(cell);
            marker.bindPopup(popupContent, {
                maxWidth: 400,
                maxHeight: 350
            });

            // Bind popup event handlers after popup opens
            marker.on('popupopen', () => {
                this._bindIncidentPopupEvents(cell);
            });

            this.incidentMarkers.addLayer(marker);
        }

        console.log(`[MapView] Created incident layer with ${locationCounts.size} hotspots`);
    }

    /**
     * Get icon for incident marker based on severity breakdown
     * @param {Object} cell - Aggregated cell data
     * @returns {L.DivIcon}
     */
    getIncidentIcon(cell) {
        const { count, severityCounts } = cell;

        // Determine dominant severity for color
        let color;
        if (severityCounts.critical > 0) {
            color = '#b71c1c'; // Dark red for critical
        } else if (severityCounts.warning > 0) {
            color = '#f44336'; // Red for warning
        } else {
            color = '#ff5722'; // Deep orange for info
        }

        // Size based on count (min 28, max 44)
        const size = Math.min(44, Math.max(28, 24 + count * 3));

        // Create icon with brake symbol
        const svgIcon = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
                <!-- Background circle -->
                <circle cx="16" cy="16" r="14" fill="${color}" stroke="#fff" stroke-width="2"/>
                <!-- Brake/stop symbol (circle with horizontal line) -->
                <circle cx="16" cy="16" r="8" fill="none" stroke="#fff" stroke-width="2"/>
                <line x1="10" y1="16" x2="22" y2="16" stroke="#fff" stroke-width="2"/>
                <!-- Count badge -->
                <circle cx="24" cy="8" r="7" fill="#fff" stroke="${color}" stroke-width="1"/>
                <text x="24" y="11" text-anchor="middle" font-size="8" font-weight="bold" fill="${color}">${count}</text>
            </svg>
        `;

        return L.divIcon({
            html: svgIcon,
            className: 'incident-icon',
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
            popupAnchor: [0, -size / 2]
        });
    }

    /**
     * Create popup content for incident marker
     * @param {Object} cell - Aggregated cell data with points array
     * @returns {string} HTML content for popup
     */
    createIncidentPopup(cell) {
        const { count, points, severityCounts } = cell;

        // Format severity breakdown
        const severityBreakdown = [];
        if (severityCounts.critical > 0) {
            severityBreakdown.push(`<span class="incident-severity critical">${severityCounts.critical} Critical</span>`);
        }
        if (severityCounts.warning > 0) {
            severityBreakdown.push(`<span class="incident-severity warning">${severityCounts.warning} Warning</span>`);
        }
        if (severityCounts.info > 0) {
            severityBreakdown.push(`<span class="incident-severity info">${severityCounts.info} Info</span>`);
        }

        // Group by incident type
        const byType = { braking: 0, swerve: 0, combined: 0 };
        for (const point of points) {
            const type = point.type || 'braking';
            byType[type] = (byType[type] || 0) + 1;
        }
        const typeBreakdown = [];
        if (byType.braking > 0) typeBreakdown.push(`<span class="incident-type braking">⬇ ${byType.braking} Braking</span>`);
        if (byType.swerve > 0) typeBreakdown.push(`<span class="incident-type swerve">↔ ${byType.swerve} Swerve</span>`);
        if (byType.combined > 0) typeBreakdown.push(`<span class="incident-type combined">⚠ ${byType.combined} Combined</span>`);

        // Group by AP mode
        const byApMode = {};
        for (const point of points) {
            const mode = point.autopilotMode || 'Unknown';
            byApMode[mode] = (byApMode[mode] || 0) + 1;
        }
        const apModeBreakdown = Object.entries(byApMode)
            .map(([mode, cnt]) => `<span class="incident-ap-mode">${cnt}x ${mode}</span>`)
            .join(' ');

        // Calculate average speed and g-force
        const avgSpeed = points.reduce((sum, p) => sum + (p.speed || 0), 0) / points.length;
        const avgGForce = points.reduce((sum, p) => sum + (p.gForce || 0), 0) / points.length;
        const avgLateralG = points.reduce((sum, p) => sum + (p.lateralG || 0), 0) / points.length;

        // List events (max 6) - clickable
        const eventsList = points
            .slice(0, 6)
            .map((point, idx) => {
                const date = new Date(point.timestamp);
                const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                const speed = Math.round(point.speed || 0);
                const gForce = (point.gForce || 0).toFixed(2);
                const lateralG = point.lateralG ? (point.lateralG).toFixed(2) : null;
                const severityClass = point.severity || 'info';
                const typeLabel = point.type === 'combined' ? '⚠ Combined' :
                    point.type === 'swerve' ? '↔ Swerve' : '⬇ Braking';
                const gForceText = point.type === 'swerve' ? `${lateralG}g lat` :
                    point.type === 'combined' ? `${gForce}g / ${lateralG}g` : `${gForce}g`;
                return `
                    <div class="incident-event clickable" data-event-idx="${idx}" title="Click to view this event">
                        <span class="event-date">${dateStr} ${timeStr}</span>
                        <span class="event-type">${typeLabel}</span>
                        <span class="event-severity ${severityClass}">${point.severity}</span>
                        <span class="event-speed">${speed} mph</span>
                        <span class="event-gforce">${gForceText}</span>
                        <span class="event-view-icon">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z"/>
                            </svg>
                        </span>
                    </div>
                `;
            })
            .join('');

        const moreCount = points.length > 6 ? `<div class="incident-more">+${points.length - 6} more events</div>` : '';

        return `
            <div class="incident-popup">
                <div class="incident-header">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="#b71c1c">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/>
                        <path d="M7 11h10v2H7z"/>
                    </svg>
                    <span class="incident-title">Incident Hotspot</span>
                </div>
                <div class="incident-count">${count} Incident${count > 1 ? 's' : ''} at this location</div>
                <div class="incident-breakdown">
                    <div class="breakdown-row">
                        <label>Types:</label>
                        ${typeBreakdown.join(' ')}
                    </div>
                    <div class="breakdown-row">
                        <label>Severity:</label>
                        ${severityBreakdown.join(' ')}
                    </div>
                    <div class="breakdown-row">
                        <label>AP Modes:</label>
                        ${apModeBreakdown}
                    </div>
                    <div class="breakdown-row">
                        <label>Avg Speed:</label>
                        <span>${Math.round(avgSpeed)} mph</span>
                        <label style="margin-left: 12px;">G-Force:</label>
                        <span>${avgGForce.toFixed(2)}g${avgLateralG > 0.1 ? ` / ${avgLateralG.toFixed(2)}g lat` : ''}</span>
                    </div>
                </div>
                <div class="incident-events-header">Click to view clip:</div>
                <div class="incident-events">
                    ${eventsList}
                    ${moreCount}
                </div>
                <div class="incident-tip">
                    <small>This location has repeated incidents - consider investigating the footage to understand what happened.</small>
                </div>
            </div>
        `;
    }

    /**
     * Bind click events to incident popup items
     * @param {Object} cell - Cell data with points array
     */
    _bindIncidentPopupEvents(cell) {
        const popupEl = document.querySelector('.incident-popup');
        if (!popupEl) return;

        const clickableEvents = popupEl.querySelectorAll('.incident-event.clickable');
        clickableEvents.forEach((el, idx) => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const point = cell.points[idx];
                if (!point || !this.onEventSelect) return;

                // Find the event by name from the loaded events
                const event = this.events.find(ev => ev.name === point.eventName);
                if (!event) {
                    console.warn(`[MapView] Event not found: ${point.eventName}`);
                    return;
                }

                // Close the popup
                this.map.closePopup();

                // Use the pre-calculated event time
                const eventTime = point.eventTime || 0;

                console.log(`[MapView] Navigating to incident in ${point.eventName}, time ${eventTime.toFixed(1)}s`);

                // Load the event
                this.onEventSelect(event);

                // After the event loads, seek to the exact position
                let retryCount = 0;
                const maxRetries = 20;

                const seekToIncident = async () => {
                    retryCount++;

                    if (window.app?.videoPlayer?.currentEvent?.name === event.name) {
                        try {
                            await window.app.videoPlayer.seekToEventTime(eventTime);
                            console.log(`[MapView] Seeked to incident at ${eventTime.toFixed(1)}s`);
                        } catch (error) {
                            console.warn('[MapView] Failed to seek to incident:', error);
                        }
                    } else if (retryCount < maxRetries) {
                        setTimeout(seekToIncident, 200);
                    } else {
                        console.warn('[MapView] Timed out waiting for event to load');
                    }
                };

                setTimeout(seekToIncident, 300);
            });
        });
    }

    /**
     * Check if incident data is available
     * @returns {boolean}
     */
    hasIncidentData() {
        return this.incidentPoints.length > 0;
    }

    /**
     * Get incident statistics
     * @returns {Object} Stats about incidents
     */
    getIncidentStats() {
        const points = this.incidentPoints;
        if (points.length === 0) return null;

        const bySeverity = { critical: 0, warning: 0, info: 0 };
        const byApMode = {};

        for (const point of points) {
            bySeverity[point.severity]++;
            const mode = point.autopilotMode || 'Unknown';
            byApMode[mode] = (byApMode[mode] || 0) + 1;
        }

        return {
            total: points.length,
            bySeverity,
            byApMode
        };
    }

    /**
     * Destroy map instance
     */
    destroy() {
        if (this.map) {
            this.map.remove();
            this.map = null;
            this.markerCluster = null;
            this.heatLayer = null;
            this.struggleZonesLayer = null;
            this.struggleZonesMarkers = null;
            this.struggleZonesControl = null;
            this.apDisengagementPoints = [];
            this.incidentHeatLayer = null;
            this.incidentMarkers = null;
            this.incidentControl = null;
            this.incidentPoints = [];
            this.initialized = false;
        }
    }
}
