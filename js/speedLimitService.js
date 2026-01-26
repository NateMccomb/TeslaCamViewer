/**
 * SpeedLimitService - Road speed limit data for TeslaCamViewer
 * Uses OpenStreetMap Overpass API (free, no API key required)
 * Progressive loading with background fetching during idle time
 * Caches results in IndexedDB for offline access
 */

class SpeedLimitService {
    constructor() {
        this.DB_NAME = 'TeslaCamViewer';
        this.STORE_NAME = 'speedLimitCache';
        this.DB_VERSION = 3; // Increment if schema changes
        this.db = null;

        // Multiple Overpass API servers to rotate between
        this.overpassServers = [
            'https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter'
        ];
        this.currentServerIndex = 0;
        this.serverFailCounts = [0, 0]; // Track failures per server

        // In-memory cache for current session
        // Key: "lat,lng" rounded to ~500m grid, Value: { limit, unit, source }
        this.memoryCache = new Map();

        // Pending fetches to avoid duplicate requests
        this.pendingFetches = new Map();

        // Background loading queue
        this.loadQueue = [];
        this.isBackgroundLoading = false;
        this.currentPlaybackPosition = null;

        // Rate limiting - spread across servers
        this.lastFetchTime = 0;
        this.minFetchInterval = 1500; // ms between API calls (can be lower with multiple servers)
        this.backoffMultiplier = 1; // Increases on errors
        this.maxBackoff = 8; // Max 12 seconds between calls

        // Grid size for caching (~500m) - less frequent checks
        this.gridSize = 0.005; // ~555m at equator

        this._initDB();
    }

    /**
     * Get next Overpass server (round-robin with failure awareness)
     */
    _getNextServer() {
        // Find server with lowest fail count
        let bestIndex = 0;
        let bestFailCount = this.serverFailCounts[0];

        for (let i = 1; i < this.overpassServers.length; i++) {
            if (this.serverFailCounts[i] < bestFailCount) {
                bestIndex = i;
                bestFailCount = this.serverFailCounts[i];
            }
        }

        // If all have same fail count, rotate
        if (this.serverFailCounts.every(c => c === bestFailCount)) {
            this.currentServerIndex = (this.currentServerIndex + 1) % this.overpassServers.length;
            return this.overpassServers[this.currentServerIndex];
        }

        this.currentServerIndex = bestIndex;
        return this.overpassServers[bestIndex];
    }

    /**
     * Mark server as failed
     */
    _markServerFailed(serverUrl) {
        const index = this.overpassServers.indexOf(serverUrl);
        if (index >= 0) {
            this.serverFailCounts[index]++;
            // Reset fail counts periodically so servers can recover
            const totalFails = this.serverFailCounts.reduce((a, b) => a + b, 0);
            if (totalFails > 15) {
                this.serverFailCounts = this.serverFailCounts.map(c => Math.floor(c / 2));
            }
        }
    }

    /**
     * Mark server as successful
     */
    _markServerSuccess(serverUrl) {
        const index = this.overpassServers.indexOf(serverUrl);
        if (index >= 0 && this.serverFailCounts[index] > 0) {
            this.serverFailCounts[index]--;
        }
    }

    /**
     * Initialize IndexedDB
     */
    async _initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onerror = () => {
                console.warn('[SpeedLimitService] IndexedDB not available, using memory cache only');
                resolve(null);
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log('[SpeedLimitService] IndexedDB ready');
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create speed limit cache store if it doesn't exist
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'key' });
                    console.log('[SpeedLimitService] Created speedLimitCache store');
                }
            };
        });
    }

    /**
     * Round coordinates to grid for caching
     */
    _toGridKey(lat, lng) {
        const gridLat = Math.round(lat / this.gridSize) * this.gridSize;
        const gridLng = Math.round(lng / this.gridSize) * this.gridSize;
        return `${gridLat.toFixed(4)},${gridLng.toFixed(4)}`;
    }

    /**
     * Get speed limit for a location (immediate return from cache, or null)
     * Use this for real-time display - non-blocking
     * @param {number} lat - Latitude
     * @param {number} lng - Longitude
     * @returns {Object|null} Speed limit data or null if not cached
     */
    getSpeedLimitCached(lat, lng) {
        if (!lat || !lng) return null;

        const key = this._toGridKey(lat, lng);
        return this.memoryCache.get(key) || null;
    }

    /**
     * Get speed limit for a location (async, fetches if needed)
     * @param {number} lat - Latitude
     * @param {number} lng - Longitude
     * @returns {Promise<Object|null>} Speed limit data
     */
    async getSpeedLimit(lat, lng) {
        if (!lat || !lng) return null;

        const key = this._toGridKey(lat, lng);

        // Check memory cache
        if (this.memoryCache.has(key)) {
            return this.memoryCache.get(key);
        }

        // Check IndexedDB cache
        const dbCached = await this._getFromDB(key);
        if (dbCached) {
            this.memoryCache.set(key, dbCached);
            return dbCached;
        }

        // Check if already fetching
        if (this.pendingFetches.has(key)) {
            return this.pendingFetches.get(key);
        }

        // Fetch from API
        const fetchPromise = this._fetchSpeedLimit(lat, lng, key);
        this.pendingFetches.set(key, fetchPromise);

        try {
            const result = await fetchPromise;
            return result;
        } finally {
            this.pendingFetches.delete(key);
        }
    }

    /**
     * Fetch speed limit from OpenStreetMap Overpass API
     */
    async _fetchSpeedLimit(lat, lng, cacheKey) {
        // Rate limiting with exponential backoff
        const now = Date.now();
        const effectiveInterval = this.minFetchInterval * this.backoffMultiplier;
        const timeSinceLastFetch = now - this.lastFetchTime;
        if (timeSinceLastFetch < effectiveInterval) {
            await new Promise(r => setTimeout(r, effectiveInterval - timeSinceLastFetch));
        }
        this.lastFetchTime = Date.now();

        // Get next server from rotation
        const serverUrl = this._getNextServer();

        try {
            // Query for roads near this point with maxspeed tag
            // Use larger radius since we're checking less frequently
            const radius = 100; // meters
            const query = `
                [out:json][timeout:10];
                way(around:${radius},${lat},${lng})["highway"]["maxspeed"];
                out tags;
            `;

            const response = await fetch(serverUrl, {
                method: 'POST',
                body: `data=${encodeURIComponent(query)}`,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            if (!response.ok) {
                // Handle rate limiting (429) or server errors
                this._markServerFailed(serverUrl);
                if (response.status === 429 || response.status >= 500) {
                    this.backoffMultiplier = Math.min(this.backoffMultiplier * 1.5, this.maxBackoff);
                    console.warn(`[SpeedLimitService] Server ${serverUrl} returned ${response.status}. Trying next server.`);
                    throw new Error(`Server returned ${response.status}`);
                }
                throw new Error(`Overpass API returned ${response.status}`);
            }

            // Check content type before parsing
            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) {
                // Server returned non-JSON (likely XML error page) - fail silently, try next server
                this._markServerFailed(serverUrl);
                this.backoffMultiplier = Math.min(this.backoffMultiplier * 1.5, this.maxBackoff);
                throw new Error('Server returned non-JSON response');
            }

            // Success - mark server as working and reduce backoff
            this._markServerSuccess(serverUrl);
            if (this.backoffMultiplier > 1) {
                this.backoffMultiplier = Math.max(1, this.backoffMultiplier * 0.8);
            }

            const data = await response.json();
            const result = this._parseOverpassResult(data);

            // Cache the result (even if null, to avoid re-fetching)
            const cacheData = result || { limit: null, unit: null, source: 'not_found' };
            this.memoryCache.set(cacheKey, cacheData);
            await this._saveToDB(cacheKey, cacheData);

            return result;
        } catch (error) {
            // Silently fail - speed limit is optional and servers can be flaky
            return null;
        }
    }

    /**
     * Parse Overpass API result
     */
    _parseOverpassResult(data) {
        if (!data.elements || data.elements.length === 0) {
            return null;
        }

        // Find the most relevant road (prefer higher highway classes)
        const roadPriority = {
            'motorway': 10,
            'trunk': 9,
            'primary': 8,
            'secondary': 7,
            'tertiary': 6,
            'unclassified': 5,
            'residential': 4,
            'service': 3,
            'living_street': 2,
            'pedestrian': 1
        };

        let bestRoad = null;
        let bestPriority = -1;

        for (const element of data.elements) {
            if (element.tags && element.tags.maxspeed) {
                const highway = element.tags.highway || '';
                const priority = roadPriority[highway] || 0;
                if (priority > bestPriority) {
                    bestPriority = priority;
                    bestRoad = element;
                }
            }
        }

        if (!bestRoad) return null;

        const maxspeed = bestRoad.tags.maxspeed;
        return this._parseMaxspeed(maxspeed);
    }

    /**
     * Parse OSM maxspeed value
     * Formats: "50", "30 mph", "50 km/h", "none", "signals"
     */
    _parseMaxspeed(value) {
        if (!value) return null;

        // Handle special values
        if (value === 'none' || value === 'signals' || value === 'variable') {
            return { limit: null, unit: null, source: 'osm', raw: value };
        }

        // Parse numeric value with optional unit
        const match = value.match(/^(\d+)\s*(mph|km\/h|kmh|kph)?$/i);
        if (!match) {
            return { limit: null, unit: null, source: 'osm', raw: value };
        }

        const limit = parseInt(match[1], 10);
        let unit = (match[2] || '').toLowerCase();

        // Default to km/h if no unit (OSM standard)
        if (!unit || unit === 'kmh' || unit === 'kph') {
            unit = 'km/h';
        } else if (unit === 'mph') {
            unit = 'mph';
        }

        return {
            limit,
            unit,
            limitMph: unit === 'mph' ? limit : Math.round(limit * 0.621371),
            limitKph: unit === 'km/h' ? limit : Math.round(limit * 1.60934),
            source: 'osm'
        };
    }

    /**
     * Queue positions for background loading
     * @param {Array} positions - Array of {lat, lng, time} objects
     * @param {number} currentTime - Current playback time
     */
    queueForBackgroundLoading(positions, currentTime = 0) {
        if (!positions || positions.length === 0) return;

        // First, deduplicate by grid key - only keep one position per grid cell
        const seenGridKeys = new Set();
        const dedupedPositions = positions.filter(pos => {
            const key = this._toGridKey(pos.lat, pos.lng);
            if (seenGridKeys.has(key)) return false;
            seenGridKeys.add(key);
            return true;
        });

        console.log(`[SpeedLimitService] Reduced ${positions.length} positions to ${dedupedPositions.length} unique grid cells`);

        // Sort by distance from current playback position
        // Prioritize ahead of playback, then behind
        const sorted = dedupedPositions.map((pos, idx) => ({
            ...pos,
            index: idx,
            priority: this._calculatePriority(pos.time, currentTime)
        })).sort((a, b) => a.priority - b.priority);

        // Filter out already cached positions
        this.loadQueue = sorted.filter(pos => {
            const key = this._toGridKey(pos.lat, pos.lng);
            return !this.memoryCache.has(key);
        });

        this.currentPlaybackPosition = currentTime;

        console.log(`[SpeedLimitService] Queued ${this.loadQueue.length} positions for background loading`);

        // Start background loading if not already running
        if (!this.isBackgroundLoading && this.loadQueue.length > 0) {
            this._startBackgroundLoading();
        }
    }

    /**
     * Calculate loading priority (lower = higher priority)
     * Prioritize positions ahead of current playback
     */
    _calculatePriority(positionTime, currentTime) {
        const diff = positionTime - currentTime;
        if (diff >= 0 && diff <= 60) {
            // Next 60 seconds: highest priority
            return diff;
        } else if (diff > 60) {
            // Further ahead: medium priority
            return 60 + diff;
        } else {
            // Behind current position: lowest priority
            return 1000 + Math.abs(diff);
        }
    }

    /**
     * Update current playback position (re-prioritizes queue)
     */
    updatePlaybackPosition(currentTime) {
        if (this.currentPlaybackPosition === currentTime) return;
        this.currentPlaybackPosition = currentTime;

        // Re-sort queue based on new position
        if (this.loadQueue.length > 0) {
            this.loadQueue.sort((a, b) => {
                const priorityA = this._calculatePriority(a.time, currentTime);
                const priorityB = this._calculatePriority(b.time, currentTime);
                return priorityA - priorityB;
            });
        }
    }

    /**
     * Start background loading - loads ONE position at a time with proper delays
     */
    _startBackgroundLoading() {
        if (this.isBackgroundLoading) return;
        this.isBackgroundLoading = true;

        const loadNext = async () => {
            // Stop if queue is empty
            if (this.loadQueue.length === 0) {
                this.isBackgroundLoading = false;
                console.log('[SpeedLimitService] Background loading complete');
                return;
            }

            // Load ONE item at a time (respecting rate limits)
            const pos = this.loadQueue.shift();
            if (pos) {
                try {
                    // Wait for the fetch to complete (this respects rate limiting)
                    await this.getSpeedLimit(pos.lat, pos.lng);
                } catch (e) {
                    // Ignore errors, continue loading
                }
            }

            // Continue with next item after a delay
            if (this.loadQueue.length > 0 && this.isBackgroundLoading) {
                // Schedule next load - add extra delay to be conservative
                const delay = this.minFetchInterval * this.backoffMultiplier + 500;
                setTimeout(loadNext, delay);
            } else {
                this.isBackgroundLoading = false;
            }
        };

        // Start loading with initial delay
        setTimeout(loadNext, 1000);

        console.log(`[SpeedLimitService] Started background loading (${this.loadQueue.length} positions)`);
    }

    /**
     * Stop background loading
     */
    stopBackgroundLoading() {
        this.loadQueue = [];
        this.isBackgroundLoading = false;
    }

    /**
     * Get from IndexedDB
     */
    async _getFromDB(key) {
        if (!this.db) return null;

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([this.STORE_NAME], 'readonly');
                const store = transaction.objectStore(this.STORE_NAME);
                const request = store.get(key);

                request.onsuccess = () => {
                    const result = request.result;
                    // Check if cache is still valid (30 days)
                    if (result && result.cachedAt && (Date.now() - result.cachedAt) < 30 * 24 * 60 * 60 * 1000) {
                        resolve(result.data || null);
                    } else {
                        resolve(null);
                    }
                };

                request.onerror = () => {
                    resolve(null);
                };
            } catch (e) {
                resolve(null);
            }
        });
    }

    /**
     * Save to IndexedDB
     */
    async _saveToDB(key, data) {
        if (!this.db) return;

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([this.STORE_NAME], 'readwrite');
                const store = transaction.objectStore(this.STORE_NAME);
                store.put({ key, data, cachedAt: Date.now() });

                transaction.oncomplete = () => resolve(true);
                transaction.onerror = () => resolve(false);
            } catch (e) {
                resolve(false);
            }
        });
    }

    /**
     * Format speed limit for display
     * @param {Object} data - Speed limit data
     * @param {boolean} useMph - Whether to display in mph
     * @returns {string} Formatted string like "65 mph" or "100 km/h"
     */
    formatForDisplay(data, useMph = true) {
        if (!data || data.limit === null) {
            return null;
        }

        if (useMph) {
            return `${data.limitMph} mph`;
        } else {
            return `${data.limitKph} km/h`;
        }
    }

    /**
     * Calculate how much over the speed limit
     * @param {number} currentSpeedMph - Current speed in mph
     * @param {Object} limitData - Speed limit data from getSpeedLimit
     * @returns {Object} { overBy, color, isBold }
     */
    calculateOverLimit(currentSpeedMph, limitData) {
        if (!limitData || limitData.limit === null) {
            return { overBy: 0, color: null, isBold: false };
        }

        const limitMph = limitData.limitMph;
        const overBy = currentSpeedMph - limitMph;

        // Color gradient based on how much over
        // Green (at/under) -> Yellow (+10) -> Red (+15) -> Bold red (+15+)
        let color;
        let isBold = false;

        if (overBy <= 0) {
            // At or under limit: green
            color = '#4ade80'; // green-400
        } else if (overBy <= 10) {
            // 0-10 over: green -> yellow gradient
            const t = overBy / 10;
            color = this._lerpColor('#4ade80', '#facc15', t); // green to yellow
        } else if (overBy <= 15) {
            // 10-15 over: yellow -> red gradient
            const t = (overBy - 10) / 5;
            color = this._lerpColor('#facc15', '#ef4444', t); // yellow to red
        } else {
            // 15+ over: bold red
            color = '#dc2626'; // red-600 (more vivid)
            isBold = true;
        }

        return { overBy, color, isBold };
    }

    /**
     * Calculate over limit for km/h display
     * @param {number} currentSpeedKph - Current speed in km/h
     * @param {Object} limitData - Speed limit data
     * @returns {Object} { overBy, color, isBold }
     */
    calculateOverLimitKph(currentSpeedKph, limitData) {
        if (!limitData || limitData.limit === null) {
            return { overBy: 0, color: null, isBold: false };
        }

        const limitKph = limitData.limitKph;
        const overBy = currentSpeedKph - limitKph;

        // Color gradient for km/h
        // Green (at/under) -> Yellow (+15) -> Red (+25) -> Bold red (+25+)
        let color;
        let isBold = false;

        if (overBy <= 0) {
            color = '#4ade80';
        } else if (overBy <= 15) {
            const t = overBy / 15;
            color = this._lerpColor('#4ade80', '#facc15', t);
        } else if (overBy <= 25) {
            const t = (overBy - 15) / 10;
            color = this._lerpColor('#facc15', '#ef4444', t);
        } else {
            color = '#dc2626';
            isBold = true;
        }

        return { overBy, color, isBold };
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
     * Clear all caches
     */
    clearCache() {
        this.memoryCache.clear();
        this.loadQueue = [];
    }
}

// Export singleton instance
window.speedLimitService = new SpeedLimitService();
