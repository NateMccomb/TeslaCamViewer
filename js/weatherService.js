/**
 * WeatherService - Historical weather data for TeslaCamViewer
 * Uses Open-Meteo Archive API (free, no API key required)
 * Caches results in IndexedDB for offline access
 */

class WeatherService {
    constructor() {
        this.DB_NAME = 'TeslaCamViewer';
        this.STORE_NAME = 'weatherCache';
        this.DB_VERSION = 2; // Increment if schema changes
        this.db = null;

        // In-memory cache for current session
        this.memoryCache = new Map();

        this._initDB();
    }

    /**
     * Initialize IndexedDB
     */
    async _initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onerror = () => {
                console.warn('[WeatherService] IndexedDB not available, using memory cache only');
                resolve(null);
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log('[WeatherService] IndexedDB ready');
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create weather cache store if it doesn't exist
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'key' });
                    console.log('[WeatherService] Created weatherCache store');
                }
            };
        });
    }

    /**
     * Get weather for a location and time
     * @param {number} lat - Latitude
     * @param {number} lng - Longitude
     * @param {Date|string} timestamp - Event timestamp
     * @returns {Object|null} Weather data or null if unavailable
     */
    async getWeather(lat, lng, timestamp) {
        // Validate inputs
        if (!lat || !lng || !timestamp) {
            return null;
        }

        // Round coordinates to 0.01° (~1km) for cache key
        const latRounded = Math.round(lat * 100) / 100;
        const lngRounded = Math.round(lng * 100) / 100;

        // Parse timestamp
        const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
        if (isNaN(date.getTime())) {
            console.warn('[WeatherService] Invalid timestamp:', timestamp);
            return null;
        }

        const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
        const hour = date.getHours();

        // Create cache key
        const cacheKey = `${latRounded},${lngRounded},${dateStr}`;

        // Check memory cache first
        if (this.memoryCache.has(cacheKey)) {
            const cached = this.memoryCache.get(cacheKey);
            return this._extractHourlyData(cached, hour);
        }

        // Check IndexedDB cache
        const dbCached = await this._getFromDB(cacheKey);
        if (dbCached) {
            this.memoryCache.set(cacheKey, dbCached);
            return this._extractHourlyData(dbCached, hour);
        }

        // Fetch from API
        try {
            const data = await this._fetchWeather(latRounded, lngRounded, dateStr);
            if (data) {
                // Cache the result
                this.memoryCache.set(cacheKey, data);
                await this._saveToDB(cacheKey, data);
                return this._extractHourlyData(data, hour);
            }
        } catch (error) {
            console.warn('[WeatherService] Failed to fetch weather:', error.message);
        }

        return null;
    }

    /**
     * Fetch weather from Open-Meteo Archive API
     */
    async _fetchWeather(lat, lng, dateStr) {
        // Check if date is too recent (archive may not have it yet)
        const requestDate = new Date(dateStr);
        const today = new Date();
        const daysDiff = Math.floor((today - requestDate) / (1000 * 60 * 60 * 24));

        let apiUrl;
        if (daysDiff < 5) {
            // Use forecast API for recent dates
            apiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&start_date=${dateStr}&end_date=${dateStr}&timezone=auto`;
        } else {
            // Use archive API for older dates
            apiUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&hourly=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&start_date=${dateStr}&end_date=${dateStr}&timezone=auto`;
        }

        const response = await fetch(apiUrl);

        if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
        }

        const data = await response.json();

        if (!data.hourly) {
            throw new Error('No hourly data in response');
        }

        return data;
    }

    /**
     * Extract weather data for a specific hour
     */
    _extractHourlyData(data, hour) {
        const hourly = data.hourly;

        if (!hourly || !hourly.time || hour >= hourly.time.length) {
            return null;
        }

        const weatherCode = hourly.weather_code?.[hour];
        const { icon, description } = this._mapWeatherCode(weatherCode);

        // Get temperature and convert if needed
        const tempC = hourly.temperature_2m?.[hour];
        const { temp, unit } = this._formatTemperature(tempC);

        return {
            temperature: temp,
            temperatureUnit: unit,
            temperatureC: tempC,
            humidity: hourly.relative_humidity_2m?.[hour],
            precipitation: hourly.precipitation?.[hour],
            windSpeed: this._formatWindSpeed(hourly.wind_speed_10m?.[hour]),
            windSpeedRaw: hourly.wind_speed_10m?.[hour],
            weatherCode,
            icon,
            description,
            time: hourly.time?.[hour]
        };
    }

    /**
     * Map WMO weather code to icon and description
     * https://open-meteo.com/en/docs#weathervariables
     */
    _mapWeatherCode(code) {
        const mapping = {
            0: { icon: '☀️', description: 'Clear' },
            1: { icon: '🌤️', description: 'Mostly Clear' },
            2: { icon: '⛅', description: 'Partly Cloudy' },
            3: { icon: '☁️', description: 'Overcast' },
            45: { icon: '🌫️', description: 'Fog' },
            48: { icon: '🌫️', description: 'Freezing Fog' },
            51: { icon: '🌧️', description: 'Light Drizzle' },
            53: { icon: '🌧️', description: 'Drizzle' },
            55: { icon: '🌧️', description: 'Heavy Drizzle' },
            56: { icon: '🌧️', description: 'Freezing Drizzle' },
            57: { icon: '🌧️', description: 'Heavy Freezing Drizzle' },
            61: { icon: '🌧️', description: 'Light Rain' },
            63: { icon: '🌧️', description: 'Rain' },
            65: { icon: '🌧️', description: 'Heavy Rain' },
            66: { icon: '🌧️', description: 'Freezing Rain' },
            67: { icon: '🌧️', description: 'Heavy Freezing Rain' },
            71: { icon: '🌨️', description: 'Light Snow' },
            73: { icon: '🌨️', description: 'Snow' },
            75: { icon: '❄️', description: 'Heavy Snow' },
            77: { icon: '🌨️', description: 'Snow Grains' },
            80: { icon: '🌧️', description: 'Light Showers' },
            81: { icon: '🌧️', description: 'Showers' },
            82: { icon: '🌧️', description: 'Heavy Showers' },
            85: { icon: '🌨️', description: 'Light Snow Showers' },
            86: { icon: '🌨️', description: 'Snow Showers' },
            95: { icon: '⛈️', description: 'Thunderstorm' },
            96: { icon: '⛈️', description: 'Thunderstorm with Hail' },
            99: { icon: '⛈️', description: 'Severe Thunderstorm' }
        };

        return mapping[code] || { icon: '❓', description: 'Unknown' };
    }

    /**
     * Format temperature based on user locale
     */
    _formatTemperature(tempC) {
        if (tempC === null || tempC === undefined) {
            return { temp: null, unit: '' };
        }

        // Check if user prefers Fahrenheit (US, Liberia, Myanmar)
        const locale = navigator.language || 'en-US';
        const useFahrenheit = locale.includes('US') || locale.includes('LR') || locale.includes('MM');

        if (useFahrenheit) {
            const tempF = Math.round(tempC * 9/5 + 32);
            return { temp: tempF, unit: '°F' };
        } else {
            return { temp: Math.round(tempC), unit: '°C' };
        }
    }

    /**
     * Format wind speed based on user locale
     */
    _formatWindSpeed(speedKmh) {
        if (speedKmh === null || speedKmh === undefined) {
            return null;
        }

        const locale = navigator.language || 'en-US';
        const useMph = locale.includes('US') || locale.includes('GB');

        if (useMph) {
            return `${Math.round(speedKmh * 0.621371)} mph`;
        } else {
            return `${Math.round(speedKmh)} km/h`;
        }
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
                    resolve(request.result?.data || null);
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
     * Format weather for display in event panel
     * @param {Object} weather - Weather data from getWeather()
     * @returns {string} Formatted string like "☁️ 45°F Cloudy · 85% humidity · 12 mph wind"
     */
    formatForDisplay(weather) {
        if (!weather) {
            return null;
        }

        const parts = [];

        // Icon + temp + description
        if (weather.temperature !== null) {
            parts.push(`${weather.icon} ${weather.temperature}${weather.temperatureUnit} ${weather.description}`);
        } else {
            parts.push(`${weather.icon} ${weather.description}`);
        }

        // Humidity
        if (weather.humidity !== null && weather.humidity !== undefined) {
            parts.push(`${weather.humidity}% humidity`);
        }

        // Wind
        if (weather.windSpeed) {
            parts.push(`${weather.windSpeed} wind`);
        }

        return parts.join(' · ');
    }

    /**
     * Format weather for mini-map badge (compact)
     * @param {Object} weather - Weather data from getWeather()
     * @returns {string} Formatted string like "☁️ 45°F"
     */
    formatForBadge(weather) {
        if (!weather) {
            return null;
        }

        if (weather.temperature !== null) {
            return `${weather.icon} ${weather.temperature}${weather.temperatureUnit}`;
        }

        return weather.icon;
    }
}

// Export singleton instance
window.weatherService = new WeatherService();
