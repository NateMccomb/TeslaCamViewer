/**
 * SpeedLimitService - Road speed limit data for TeslaCamViewer
 * Uses OpenStreetMap Overpass API (free, no API key required)
 * Progressive loading with background fetching during idle time
 * Caches results in IndexedDB for offline access
 */

class SpeedLimitService {
    constructor() {
        // A database of its own: it used to share 'TeslaCamViewer' with the
        // weather cache at a different version, and whichever opened second
        // was blocked or refused, so limits were never kept between visits
        this.DB_NAME = 'TeslaCamViewerSpeedLimits';
        this.STORE_NAME = 'speedLimitCache';
        this.DB_VERSION = 1; // Increment if schema changes
        this.db = null;

        // Public Overpass API servers (OpenStreetMap data, no key). Regional
        // mirrors hold only their region's data, so they are only asked about
        // points inside their coverage boxes; anywhere else an empty answer
        // would wrongly read as "no posted limit". Each server has its own
        // cool-down after a busy/rate-limit answer or a timeout, so a busy
        // server is left alone instead of being asked again and again.
        // Per spec SLS-4701: order = preference; the regional mirror goes first
        // inside its region to keep load off the overloaded main server.
        this.overpassServers = [
            { name: 'ovp.dresel.systems (North America)', url: 'https://ovp.dresel.systems/api-na/interpreter', region: 'na' },
            { name: 'ovp.dresel.systems (Europe)', url: 'https://ovp.dresel.systems/api/interpreter', region: 'eu' },
            { name: 'overpass-api.de', url: 'https://overpass-api.de/api/interpreter', region: null },
            { name: 'overpass.private.coffee', url: 'https://overpass.private.coffee/api/interpreter', region: null }
        ].map(s => ({ ...s, strikes: 0, cooldownUntil: 0 }));
        this.requestTimeoutMs = 8047;      // one query; a healthy server answers in < 2 s
        this.cooldownBaseMs = 30047;       // overpass-api.de asks for >= 30 s after a 429
        this.cooldownMaxMs = 10 * 60 * 1000;

        // Where lookups stand, for the player and the export screens:
        //   state 'ok' | 'unavailable'; reason 'busy' | 'offline' | 'unreachable'
        this.status = { state: 'ok', reason: null, since: 0 };
        // Cells whose lookup failed (not cached; retried after the cool-down)
        this.failedCells = new Map(); // key -> { reason, at }

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
        this.minFetchInterval = 1500; // ms between API calls

        // Grid size for caching (~500m) - less frequent checks
        this.gridSize = 0.005; // ~555m at equator

        this._dbReady = this._initDB();
    }

    // --- Server choice, cool-downs and lookup status - tcv.0x534C53

    /**
     * Is a point inside a regional mirror's data? Conservative boxes inside
     * the Geofabrik extracts the mirrors load (north-america, europe).
     */
    static inRegion(region, lat, lng) {
        const inBox = (b) => lat >= b[0] && lat <= b[1] && lng >= b[2] && lng <= b[3];
        if (region === 'na') {
            // Bahamas sit inside the US/Canada box but aren't in the extract
            if (inBox([20.9, 27.3, -79.35, -72.6])) return false;
            return [
                [24.3, 84.0, -141.1, -52.5],    // contiguous US + Canada
                [51.0, 71.6, -180.0, -129.9],   // Alaska
                [18.8, 22.4, -160.6, -154.7],   // Hawaii
                [14.5, 32.8, -118.5, -86.7]     // Mexico
            ].some(inBox);
        }
        if (region === 'eu') {
            // North African coast sits inside the box but isn't in the extract
            if (inBox([35.0, 37.35, -1.0, 11.6])) return false;
            return [
                [36.0, 71.2, -10.7, 30.0],      // mainland Europe, UK, Ireland, Scandinavia
                [63.2, 66.6, -24.6, -13.4]      // Iceland
            ].some(inBox);
        }
        return region === null;
    }

    /**
     * Servers that may answer for this point and aren't cooling down, in order
     * of preference. Empty when every server that could answer is resting.
     */
    _serversFor(lat, lng, now = Date.now()) {
        return this.overpassServers.filter(s => SpeedLimitService.inRegion(s.region, lat, lng) && s.cooldownUntil <= now);
    }

    /**
     * When the next server covering this point is out of its cool-down (ms
     * epoch); 0 when one is ready now.
     */
    nextRetryAt(lat, lng) {
        const now = Date.now();
        const covering = this.overpassServers.filter(s => SpeedLimitService.inRegion(s.region, lat, lng));
        if (covering.some(s => s.cooldownUntil <= now)) return 0;
        return Math.min(...covering.map(s => s.cooldownUntil));
    }

    /**
     * Rest a server after a busy/rate-limit answer, a timeout or a network
     * error: 30 s, then doubling per strike up to 10 min.
     */
    _markServerFailed(server) {
        const wait = Math.min(this.cooldownBaseMs * Math.pow(2, server.strikes), this.cooldownMaxMs);
        server.strikes = Math.min(server.strikes + 1, 17);
        server.cooldownUntil = Date.now() + wait;
    }

    _markServerSuccess(server) {
        server.strikes = 0;
        server.cooldownUntil = 0;
    }

    /**
     * Plain-words reason for the player and the export screens.
     */
    describeUnavailable(reason = this.status.reason) {
        const tr = (key, fallback) => {
            const tmp = window.i18n?.t ? window.i18n.t(key) : key;
            return (tmp && tmp !== key) ? tmp : fallback;
        };
        if (reason === 'offline') {
            return tr('speedLimit.unavailableOffline', 'Speed limits unavailable: you\'re offline.');
        }
        if (reason === 'unreachable') {
            return tr('speedLimit.unavailableUnreachable', 'Speed limits unavailable right now (couldn\'t reach the map data server).');
        }
        return tr('speedLimit.unavailableBusy', 'Speed limits unavailable right now (map data server busy).');
    }

    /**
     * Lookup state for one point:
     *   'limit'       a posted limit is cached
     *   'none'        looked up: OpenStreetMap has no posted limit here
     *   'unavailable' the lookup failed (server busy, offline); retried later
     *   'unknown'     not looked up yet
     */
    getCellStatus(lat, lng) {
        if (!lat || !lng) return 'unknown';
        const key = this._toGridKey(lat, lng);
        const cached = this.memoryCache.get(key);
        if (cached) return Number.isFinite(cached.limit) ? 'limit' : 'none';
        return this.failedCells.has(key) ? 'unavailable' : 'unknown';
    }

    getStatus() {
        return { ...this.status };
    }

    _setStatus(state, reason) {
        const prev = this.status.state;
        // While lookups are failing, "busy" (a server answered or timed out)
        // says more than "unreachable" (a blocked/failed connection): keep it
        if (state === 'unavailable' && prev === 'unavailable' && this.status.reason === 'busy' && reason === 'unreachable') {
            reason = 'busy';
        }
        if (prev === state && this.status.reason === reason) return;
        this.status = { state, reason, since: prev === state ? this.status.since : Date.now() };
        // One line when lookups stop working and one when they work again,
        // not one per request (busy servers are normal)
        if (state === 'unavailable' && prev !== 'unavailable') {
            console.warn(`[SpeedLimitService] ${this.describeUnavailable(reason)} Retrying with a back-off.`);
        } else if (prev === 'unavailable') {
            console.log('[SpeedLimitService] Speed limit lookups working again');
        }
        window.dispatchEvent(new CustomEvent('tcv-speedlimit-status', { detail: this.getStatus() }));
    }

    _noteCellFailed(key, reason) {
        this.failedCells.set(key, { reason, at: Date.now() });
        // Keep the map small on long sessions
        if (this.failedCells.size > 2000) {
            const oldest = this.failedCells.keys().next().value;
            this.failedCells.delete(oldest);
        }
        this._setStatus('unavailable', reason);
    }

    /**
     * Initialize IndexedDB
     */
    async _initDB() {
        return new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') { resolve(null); return; }
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onerror = () => {
                console.warn('[SpeedLimitService] IndexedDB not available, using memory cache only');
                resolve(null);
            };

            // Another tab holds an older version open: carry on with the memory cache
            request.onblocked = () => resolve(null);

            request.onsuccess = (event) => {
                this.db = event.target.result;
                // Let a newer version (another tab after an update) take over
                this.db.onversionchange = () => { this.db.close(); this.db = null; };
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
     * Wait (briefly) for the database to open, so lookups made right after
     * page load still find what earlier visits cached.
     */
    async _dbWait() {
        if (this.db || !this._dbReady) return;
        await Promise.race([this._dbReady, new Promise(r => setTimeout(r, 1047))]);
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
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            this._noteCellFailed(cacheKey, 'offline');
            return null;
        }
        // Every server that could answer is resting: don't touch the network
        if (this._serversFor(lat, lng).length === 0) {
            this._noteCellFailed(cacheKey, this.status.reason || 'busy');
            return null;
        }

        // Query for roads near this point with a maxspeed tag
        const radius = 100; // meters
        const query = `
                [out:json][timeout:10];
                way(around:${radius},${lat},${lng})["highway"]["maxspeed"];
                out tags;
            `;

        let reason = null;
        // At most 3 servers per cell; later ones only when earlier ones fail
        for (let idx = 0; idx < 3; idx++) {
            // One request at a time across the app, >= 1.5 s apart; the server
            // is picked after the wait, so a server that just failed for
            // another lookup is not asked again
            const tmp = await this._oneAtATime(async () => {
                const wait = this.minFetchInterval - (Date.now() - this.lastFetchTime);
                if (wait > 0) await new Promise(r => setTimeout(r, wait));
                const server = this._serversFor(lat, lng)[0];
                if (!server) return null;
                this.lastFetchTime = Date.now();
                const res = await this._queryServer(server, query);
                if (!res.ok && res.rest) this._markServerFailed(server);
                return { server, res };
            });
            if (!tmp) break;
            const { server, res } = tmp;
            if (res.ok) {
                this._markServerSuccess(server);
                const parsed = this._parseOverpassResult(res.data);
                // Cache the answer (a road without a posted limit too, so it isn't asked again)
                const cacheData = parsed || { limit: null, unit: null, source: 'not_found' };
                this.memoryCache.set(cacheKey, cacheData);
                this.failedCells.delete(cacheKey);
                this._setStatus('ok', null);
                await this._saveToDB(cacheKey, cacheData);
                return parsed;
            }
            if (res.reason === 'busy' || !reason) reason = res.reason;
            if (res.reason === 'offline') break;
        }

        this._noteCellFailed(cacheKey, reason || this.status.reason || 'busy');
        return null;
    }

    /**
     * Run fn after every earlier queued request has finished (Overpass
     * servers ask clients not to send parallel queries).
     */
    _oneAtATime(fn) {
        const run = (this._requestChain || Promise.resolve()).then(fn, fn);
        this._requestChain = run.catch(() => null);
        return run;
    }

    /**
     * One Overpass request. Never throws.
     * @returns {{ok:true, data:Object}|{ok:false, reason:string, rest:boolean}}
     */
    async _queryServer(server, query) {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = setTimeout(() => ctrl && ctrl.abort(), this.requestTimeoutMs);
        try {
            const response = await fetch(server.url, {
                method: 'POST',
                body: `data=${encodeURIComponent(query)}`,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                signal: ctrl ? ctrl.signal : undefined
            });
            if (!response.ok) {
                // 429/406 = rate limit, 5xx = "at capacity" / gateway timeout
                const busy = response.status === 429 || response.status === 406 || response.status >= 500;
                return { ok: false, reason: 'busy', rest: busy };
            }
            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) {
                return { ok: false, reason: 'busy', rest: true }; // an HTML/XML error page
            }
            const data = await response.json();
            // Overpass answers 200 with a "runtime error" remark when a query
            // timed out or ran out of memory: that is not "no speed limit here"
            if (data && typeof data.remark === 'string' && /error/i.test(data.remark)) {
                return { ok: false, reason: 'busy', rest: true };
            }
            return { ok: true, data };
        } catch (e) {
            if (e && e.name === 'AbortError') return { ok: false, reason: 'busy', rest: true }; // timed out
            const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
            return { ok: false, reason: offline ? 'offline' : 'unreachable', rest: !offline };
        } finally {
            clearTimeout(timer);
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
        // A stop + restart must not leave the old loop running alongside the new one
        const generation = this._loadGeneration = (this._loadGeneration || 0) + 1;

        const loadNext = async () => {
            if (generation !== this._loadGeneration) return;
            // Stop if queue is empty
            if (this.loadQueue.length === 0) {
                this.isBackgroundLoading = false;
                console.log('[SpeedLimitService] Background loading complete');
                return;
            }

            // Load ONE item at a time (respecting rate limits)
            const pos = this.loadQueue.shift();
            let retryAt = 0;
            if (pos) {
                try {
                    // Wait for the fetch to complete (this respects rate limiting)
                    await this.getSpeedLimit(pos.lat, pos.lng);
                } catch (e) {
                    // Ignore errors, continue loading
                }
                // Lookup failed (servers busy): try this cell again later, at
                // most 3 times, and wait out the servers' cool-down first
                if (this.getCellStatus(pos.lat, pos.lng) === 'unavailable') {
                    pos.attempts = (pos.attempts || 0) + 1;
                    if (pos.attempts < 3) this.loadQueue.push(pos);
                    retryAt = this.nextRetryAt(pos.lat, pos.lng);
                }
            }
            if (generation !== this._loadGeneration) return;

            // Continue with next item after a delay
            if (this.loadQueue.length > 0 && this.isBackgroundLoading) {
                // Schedule next load - add extra delay to be conservative
                const delay = Math.max(this.minFetchInterval + 500, retryAt - Date.now());
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
        this._loadGeneration = (this._loadGeneration || 0) + 1;
    }

    /**
     * Get from IndexedDB
     */
    async _getFromDB(key) {
        await this._dbWait();
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
        await this._dbWait();
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
        this.failedCells.clear();
        this.loadQueue = [];
    }
}

// Export singleton instance
window.speedLimitService = new SpeedLimitService();
