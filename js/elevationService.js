/**
 * ElevationService - Elevation data for TeslaCamViewer
 * Uses Open-Meteo Elevation API (free, no API key required)
 */

class ElevationService {
    constructor() {
        this.API_URL = 'https://api.open-meteo.com/v1/elevation';
        this.MAX_COORDS_PER_REQUEST = 100;

        // Cache elevation data per event
        this.cache = new Map();
    }

    /**
     * Get elevation data for a route (array of GPS points)
     * @param {Array<{lat: number, lng: number, time: number}>} gpsPoints - GPS points with timestamps
     * @param {string} cacheKey - Unique key for caching (e.g., event name)
     * @returns {Promise<Object>} Elevation profile data
     */
    async getElevationProfile(gpsPoints, cacheKey) {
        // Check cache first
        if (cacheKey && this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        if (!gpsPoints || gpsPoints.length === 0) {
            return null;
        }

        // Sample points if too many (keep it manageable)
        const sampledPoints = this._samplePoints(gpsPoints, 100);

        if (sampledPoints.length === 0) {
            return null;
        }

        try {
            // Fetch elevation data
            const elevations = await this._fetchElevations(sampledPoints);

            if (!elevations || elevations.length === 0) {
                return null;
            }

            // Build elevation profile
            const profile = this._buildProfile(sampledPoints, elevations);

            // Cache the result
            if (cacheKey) {
                this.cache.set(cacheKey, profile);
            }

            return profile;
        } catch (error) {
            console.error('[ElevationService] Error fetching elevation:', error);
            return null;
        }
    }

    /**
     * Sample GPS points to reduce API calls
     * @param {Array} points - All GPS points
     * @param {number} maxPoints - Maximum number of points to keep
     * @returns {Array} Sampled points
     */
    _samplePoints(points, maxPoints) {
        if (points.length <= maxPoints) {
            return points;
        }

        const sampled = [];
        const step = (points.length - 1) / (maxPoints - 1);

        for (let i = 0; i < maxPoints; i++) {
            const index = Math.round(i * step);
            sampled.push(points[index]);
        }

        return sampled;
    }

    /**
     * Fetch elevations from Open-Meteo API
     * @param {Array} points - GPS points
     * @returns {Promise<Array<number>>} Elevation values in meters
     */
    async _fetchElevations(points) {
        const allElevations = [];

        // Split into batches if needed
        for (let i = 0; i < points.length; i += this.MAX_COORDS_PER_REQUEST) {
            const batch = points.slice(i, i + this.MAX_COORDS_PER_REQUEST);

            const lats = batch.map(p => p.lat.toFixed(4)).join(',');
            const lngs = batch.map(p => p.lng.toFixed(4)).join(',');

            const url = `${this.API_URL}?latitude=${lats}&longitude=${lngs}`;

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }

            const data = await response.json();

            if (data.elevation && Array.isArray(data.elevation)) {
                allElevations.push(...data.elevation);
            }
        }

        return allElevations;
    }

    /**
     * Build elevation profile from points and elevations
     * @param {Array} points - GPS points with timestamps
     * @param {Array<number>} elevations - Elevation values in meters
     * @returns {Object} Elevation profile
     */
    _buildProfile(points, elevations) {
        const dataPoints = [];
        let minElevation = Infinity;
        let maxElevation = -Infinity;
        let totalAscent = 0;
        let totalDescent = 0;
        let prevElevation = null;

        for (let i = 0; i < points.length && i < elevations.length; i++) {
            const elevation = elevations[i];

            // Skip invalid elevations
            if (elevation === null || elevation === undefined || isNaN(elevation)) {
                continue;
            }

            dataPoints.push({
                lat: points[i].lat,
                lng: points[i].lng,
                time: points[i].time,
                elevation: elevation
            });

            minElevation = Math.min(minElevation, elevation);
            maxElevation = Math.max(maxElevation, elevation);

            if (prevElevation !== null) {
                const diff = elevation - prevElevation;
                if (diff > 0) {
                    totalAscent += diff;
                } else {
                    totalDescent += Math.abs(diff);
                }
            }
            prevElevation = elevation;
        }

        if (dataPoints.length === 0) {
            return null;
        }

        // Get time range from data points
        const startTime = dataPoints[0].time;
        const endTime = dataPoints[dataPoints.length - 1].time;
        const dataDuration = endTime - startTime;

        return {
            points: dataPoints,
            minElevation,
            maxElevation,
            totalAscent,
            totalDescent,
            elevationGain: maxElevation - minElevation,
            startElevation: dataPoints[0].elevation,
            endElevation: dataPoints[dataPoints.length - 1].elevation,
            // Time range info for proper mapping
            startTime,
            endTime,
            dataDuration
        };
    }

    /**
     * Get elevation at a specific time in the profile
     * @param {Object} profile - Elevation profile
     * @param {number} currentTime - Current video time in seconds
     * @returns {Object|null} Elevation data at current time
     */
    getElevationAtTime(profile, currentTime) {
        if (!profile || !profile.points || profile.points.length === 0) {
            return null;
        }

        const points = profile.points;

        // Find the two points surrounding currentTime
        let prevPoint = null;
        let nextPoint = null;

        for (let i = 0; i < points.length; i++) {
            if (points[i].time <= currentTime) {
                prevPoint = points[i];
            }
            if (points[i].time >= currentTime && !nextPoint) {
                nextPoint = points[i];
                break;
            }
        }

        // If we're before the first point or after the last
        if (!prevPoint && nextPoint) {
            return { elevation: nextPoint.elevation, index: 0 };
        }
        if (prevPoint && !nextPoint) {
            return { elevation: prevPoint.elevation, index: points.length - 1 };
        }
        if (!prevPoint && !nextPoint) {
            return null;
        }

        // Interpolate between the two points
        if (prevPoint === nextPoint || prevPoint.time === nextPoint.time) {
            const index = points.indexOf(prevPoint);
            return { elevation: prevPoint.elevation, index };
        }

        const ratio = (currentTime - prevPoint.time) / (nextPoint.time - prevPoint.time);
        const elevation = prevPoint.elevation + (nextPoint.elevation - prevPoint.elevation) * ratio;

        // Find approximate index for graph positioning
        const prevIndex = points.indexOf(prevPoint);
        const index = prevIndex + ratio;

        return { elevation, index };
    }

    /**
     * Format elevation for display
     * @param {number} meters - Elevation in meters
     * @param {boolean} useFeet - Use feet instead of meters
     * @returns {string} Formatted elevation string
     */
    formatElevation(meters, useFeet = null) {
        if (meters === null || meters === undefined || isNaN(meters)) {
            return 'N/A';
        }

        // Auto-detect units based on locale if not specified
        if (useFeet === null) {
            const locale = navigator.language || 'en-US';
            useFeet = locale.includes('US') || locale.includes('GB') || locale.includes('LR') || locale.includes('MM');
        }

        if (useFeet) {
            const feet = Math.round(meters * 3.28084);
            return `${feet.toLocaleString()} ft`;
        } else {
            return `${Math.round(meters).toLocaleString()} m`;
        }
    }

    /**
     * Clear cache for an event
     * @param {string} cacheKey - Cache key to clear
     */
    clearCache(cacheKey) {
        if (cacheKey) {
            this.cache.delete(cacheKey);
        } else {
            this.cache.clear();
        }
    }
}

// Export singleton instance
window.elevationService = new ElevationService();
