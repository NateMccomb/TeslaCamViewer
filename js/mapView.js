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
        this.events = [];
        this.initialized = false;
        this.offlineOverlay = null;
        this.isOffline = !navigator.onLine;

        // Listen for online/offline events
        window.addEventListener('online', () => this.handleOnlineStatusChange(true));
        window.addEventListener('offline', () => this.handleOnlineStatusChange(false));
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
            // Try to fetch a small resource to verify connection
            const response = await fetch('https://tile.openstreetmap.org/0/0/0.png', {
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

            // Create Leaflet map
            this.map = L.map(this.container).setView(defaultCenter, defaultZoom);

            // Add OpenStreetMap tile layer
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 19
            }).addTo(this.map);

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
                button.title = 'Toggle Heatmap View';
                button.innerHTML = `
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                    </svg>
                `;

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
     */
    createHeatmap() {
        if (!this.map || !this.events.length) return;

        // Prepare heatmap data
        const heatData = this.events
            .filter(event => this.hasValidGPS(event))
            .map(event => {
                const lat = parseFloat(event.metadata.est_lat);
                const lon = parseFloat(event.metadata.est_lon);
                // Weight sentry events more heavily
                const weight = event.type === 'SentryClips' ? 1.5 : 1;
                return [lat, lon, weight];
            });

        if (heatData.length === 0) {
            console.log('[MapView] No GPS data for heatmap');
            return;
        }

        // Remove existing heatmap if any
        if (this.heatLayer) {
            this.map.removeLayer(this.heatLayer);
        }

        // Create new heatmap layer with settings optimized for visibility at all zoom levels
        this.heatLayer = L.heatLayer(heatData, {
            radius: 35,
            blur: 20,
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

        console.log(`[MapView] Heatmap created with ${heatData.length} points`);
    }

    /**
     * Toggle between marker and heatmap view
     */
    toggleHeatmap() {
        if (!this.map) return;

        this.heatmapEnabled = !this.heatmapEnabled;

        if (this.heatmapEnabled) {
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

    /**
     * Destroy map instance
     */
    destroy() {
        if (this.map) {
            this.map.remove();
            this.map = null;
            this.markerCluster = null;
            this.heatLayer = null;
            this.initialized = false;
        }
    }
}
