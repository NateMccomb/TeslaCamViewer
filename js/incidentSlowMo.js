/**
 * IncidentSlowMo - Auto slow-motion replay for near-miss incidents
 * Automatically slows playback when video reaches flagged incident moments
 */

class IncidentSlowMo {
    constructor(videoPlayer) {
        this.videoPlayer = videoPlayer;
        this.telemetryGraphs = null; // Set via setTelemetryGraphs()

        this.isEnabled = false;
        this.incidents = []; // Near-miss incidents with time, score, etc.

        // Slow-mo settings
        this.slowMoRate = 0.25; // Playback rate during incident
        this.preIncidentBuffer = 2.0; // Seconds before incident to start slow-mo
        this.postIncidentBuffer = 2.0; // Seconds after incident to resume normal
        this.minScoreThreshold = 5; // Minimum near-miss score to trigger slow-mo

        // State tracking
        this.originalRate = 1.0;
        this.isInSlowMo = false;
        this.currentIncidentIndex = -1;
        this.processedIncidents = new Set(); // Incidents already played through

        // UI elements
        this.indicatorContainer = null;
        this.toggleBtn = null;

        // Storage key
        this.ENABLED_KEY = 'teslacamviewer_incident_slowmo_enabled';
        this.SETTINGS_KEY = 'teslacamviewer_incident_slowmo_settings';

        // Bind methods
        this._onTimeUpdate = this._onTimeUpdate.bind(this);

        this._init();
    }

    _init() {
        this._loadSettings();
        this._createUI();
        this._attachEventListeners();
    }

    _loadSettings() {
        // Load enabled state
        this.isEnabled = localStorage.getItem(this.ENABLED_KEY) === 'true';

        // Load settings
        try {
            const saved = localStorage.getItem(this.SETTINGS_KEY);
            if (saved) {
                const settings = JSON.parse(saved);
                this.slowMoRate = settings.slowMoRate || 0.25;
                this.preIncidentBuffer = settings.preIncidentBuffer || 2.0;
                this.postIncidentBuffer = settings.postIncidentBuffer || 2.0;
                this.minScoreThreshold = settings.minScoreThreshold || 5;
            }
        } catch (e) {
            console.warn('[IncidentSlowMo] Failed to load settings:', e);
        }
    }

    _saveSettings() {
        localStorage.setItem(this.ENABLED_KEY, this.isEnabled.toString());
        localStorage.setItem(this.SETTINGS_KEY, JSON.stringify({
            slowMoRate: this.slowMoRate,
            preIncidentBuffer: this.preIncidentBuffer,
            postIncidentBuffer: this.postIncidentBuffer,
            minScoreThreshold: this.minScoreThreshold
        }));
    }

    _createUI() {
        // Create toggle button for playback controls area
        this.toggleBtn = document.createElement('button');
        this.toggleBtn.className = 'incident-slowmo-toggle';
        this.toggleBtn.title = window.i18n?.t('toggleIncidentSlowMo') || 'Auto Slow-Mo on Incidents';
        this.toggleBtn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12,6 12,12 16,14"/>
                <path d="M2 12h2M20 12h2" stroke-dasharray="2,2"/>
            </svg>
        `;
        this.toggleBtn.onclick = () => this.toggle();
        this._updateToggleState();

        // Create slow-mo indicator (shows during slow-mo playback)
        this.indicatorContainer = document.createElement('div');
        this.indicatorContainer.className = 'incident-slowmo-indicator';
        this.indicatorContainer.style.cssText = `
            position: absolute;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(255, 59, 59, 0.9);
            color: white;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 14px;
            font-weight: 600;
            display: none;
            align-items: center;
            gap: 8px;
            z-index: 1000;
            backdrop-filter: blur(8px);
            box-shadow: 0 4px 12px rgba(255, 59, 59, 0.4);
            animation: pulse-glow 1.5s ease-in-out infinite;
        `;
        this.indicatorContainer.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
            <span class="slowmo-text">SLOW-MO</span>
            <span class="slowmo-score"></span>
        `;

        // Append to video grid
        const videoGrid = document.querySelector('.video-grid');
        if (videoGrid) {
            videoGrid.appendChild(this.indicatorContainer);
        }
    }

    _updateToggleState() {
        if (this.toggleBtn) {
            this.toggleBtn.classList.toggle('active', this.isEnabled);
            this.toggleBtn.title = this.isEnabled
                ? (window.i18n?.t('incidentSlowMoEnabled') || 'Incident Slow-Mo: ON')
                : (window.i18n?.t('incidentSlowMoDisabled') || 'Incident Slow-Mo: OFF');
        }
    }

    _attachEventListeners() {
        // Listen for video time updates
        if (this.videoPlayer?.videos?.front) {
            this.videoPlayer.videos.front.addEventListener('timeupdate', this._onTimeUpdate);
        }
    }

    /**
     * Set the telemetry graphs instance to get near-miss data
     */
    setTelemetryGraphs(telemetryGraphs) {
        this.telemetryGraphs = telemetryGraphs;

        // Listen for near-miss detection updates
        if (telemetryGraphs) {
            const originalCallback = telemetryGraphs.onNearMissesDetected;
            telemetryGraphs.onNearMissesDetected = (nearMisses) => {
                if (originalCallback) originalCallback(nearMisses);
                this._onNearMissesUpdated(nearMisses);
            };
        }
    }

    /**
     * Called when near-misses are detected/updated
     */
    _onNearMissesUpdated(nearMisses) {
        this.incidents = nearMisses.filter(nm => nm.score >= this.minScoreThreshold);
        this.processedIncidents.clear();
        console.log(`[IncidentSlowMo] Loaded ${this.incidents.length} incidents (score >= ${this.minScoreThreshold})`);
    }

    /**
     * Get toggle button for adding to controls
     */
    getToggleButton() {
        return this.toggleBtn;
    }

    /**
     * Toggle slow-mo feature on/off
     */
    toggle() {
        this.isEnabled = !this.isEnabled;
        this._updateToggleState();
        this._saveSettings();

        if (!this.isEnabled && this.isInSlowMo) {
            this._exitSlowMo();
        }

        console.log(`[IncidentSlowMo] ${this.isEnabled ? 'Enabled' : 'Disabled'}`);
    }

    /**
     * Enable slow-mo feature
     */
    enable() {
        if (!this.isEnabled) {
            this.toggle();
        }
    }

    /**
     * Disable slow-mo feature
     */
    disable() {
        if (this.isEnabled) {
            this.toggle();
        }
    }

    /**
     * Main time update handler - checks if we should enter/exit slow-mo
     */
    _onTimeUpdate() {
        if (!this.isEnabled || this.incidents.length === 0) return;

        const currentTime = this._getCurrentEventTime();
        if (currentTime === null) return;

        // Check if we're near any incident
        for (let i = 0; i < this.incidents.length; i++) {
            const incident = this.incidents[i];
            const incidentKey = `${incident.time.toFixed(2)}`;

            // Skip already processed incidents (to avoid repeated slow-mo on same incident)
            if (this.processedIncidents.has(incidentKey)) continue;

            const startTime = incident.time - this.preIncidentBuffer;
            const endTime = incident.time + this.postIncidentBuffer;

            // Check if current time is within incident window
            if (currentTime >= startTime && currentTime <= endTime) {
                if (!this.isInSlowMo) {
                    this._enterSlowMo(incident, i);
                }
                return;
            }

            // Mark as processed if we've passed the incident window
            if (currentTime > endTime && this.currentIncidentIndex === i) {
                this.processedIncidents.add(incidentKey);
                if (this.isInSlowMo) {
                    this._exitSlowMo();
                }
            }
        }

        // Exit slow-mo if we're not in any incident window
        if (this.isInSlowMo) {
            const currentIncident = this.incidents[this.currentIncidentIndex];
            if (currentIncident) {
                const endTime = currentIncident.time + this.postIncidentBuffer;
                if (currentTime > endTime) {
                    this._exitSlowMo();
                }
            }
        }
    }

    /**
     * Get current time in the event (absolute timeline time)
     */
    _getCurrentEventTime() {
        // Use timeline's currentTime if available (most accurate)
        if (window.app?.timeline?.currentTime !== undefined) {
            return window.app.timeline.currentTime;
        }

        // Use videoPlayer's getCurrentAbsoluteTime for accurate timing
        if (this.videoPlayer?.getCurrentAbsoluteTime) {
            return this.videoPlayer.getCurrentAbsoluteTime();
        }

        // Fallback to calculation from clip index using cached durations
        if (!this.videoPlayer) return null;

        const clipIndex = this.videoPlayer.currentClipIndex;
        const videoTime = this.videoPlayer.videos.front?.currentTime || 0;

        // Calculate absolute time using cached clip durations or 60-second fallback
        let absoluteTime = 0;
        if (this.videoPlayer.cachedClipDurations?.length > 0) {
            for (let i = 0; i < clipIndex && i < this.videoPlayer.cachedClipDurations.length; i++) {
                absoluteTime += this.videoPlayer.cachedClipDurations[i];
            }
        } else {
            absoluteTime = clipIndex * 60; // Last resort approximation
        }
        absoluteTime += videoTime;

        return absoluteTime;
    }

    /**
     * Enter slow-mo mode for an incident
     */
    _enterSlowMo(incident, index) {
        this.isInSlowMo = true;
        this.currentIncidentIndex = index;
        this.originalRate = this.videoPlayer.videos.front?.playbackRate || 1.0;

        // Apply slow-mo rate
        this.videoPlayer.setPlaybackRate(this.slowMoRate);

        // Update speed selector UI if it exists
        const speedSelect = document.getElementById('speedSelect');
        if (speedSelect) {
            speedSelect.value = this.slowMoRate.toString();
        }

        // Show indicator
        this._showIndicator(incident);

        console.log(`[IncidentSlowMo] Entering slow-mo for incident at ${incident.time.toFixed(1)}s (score: ${incident.score})`);
    }

    /**
     * Exit slow-mo mode
     */
    _exitSlowMo() {
        if (!this.isInSlowMo) return;

        this.isInSlowMo = false;
        this.currentIncidentIndex = -1;

        // Restore original rate
        this.videoPlayer.setPlaybackRate(this.originalRate);

        // Update speed selector UI
        const speedSelect = document.getElementById('speedSelect');
        if (speedSelect) {
            speedSelect.value = this.originalRate.toString();
        }

        // Hide indicator
        this._hideIndicator();

        console.log(`[IncidentSlowMo] Exiting slow-mo, resuming ${this.originalRate}x`);
    }

    /**
     * Show slow-mo indicator
     */
    _showIndicator(incident) {
        if (!this.indicatorContainer) return;

        const scoreEl = this.indicatorContainer.querySelector('.slowmo-score');
        if (scoreEl) {
            scoreEl.textContent = `Score: ${incident.score.toFixed(1)}/10`;
        }

        // Set color based on severity
        if (incident.severity === 'critical') {
            this.indicatorContainer.style.background = 'rgba(255, 59, 59, 0.95)';
        } else if (incident.severity === 'warning') {
            this.indicatorContainer.style.background = 'rgba(255, 145, 0, 0.95)';
        } else {
            this.indicatorContainer.style.background = 'rgba(255, 193, 7, 0.95)';
        }

        this.indicatorContainer.style.display = 'flex';
    }

    /**
     * Hide slow-mo indicator
     */
    _hideIndicator() {
        if (this.indicatorContainer) {
            this.indicatorContainer.style.display = 'none';
        }
    }

    /**
     * Reset state when loading new event
     */
    reset() {
        this.incidents = [];
        this.processedIncidents.clear();
        this.currentIncidentIndex = -1;
        if (this.isInSlowMo) {
            this._exitSlowMo();
        }
    }

    /**
     * Manually trigger slow-mo for the next upcoming incident
     */
    triggerNextIncident() {
        if (this.incidents.length === 0) return null;

        const currentTime = this._getCurrentEventTime();
        if (currentTime === null) return null;

        // Find next incident after current time
        const nextIncident = this.incidents.find(i => i.time > currentTime);
        if (nextIncident) {
            // Seek to just before the incident
            const seekTime = Math.max(0, nextIncident.time - this.preIncidentBuffer);
            // Note: actual seeking would need to be done by the caller
            return { incident: nextIncident, seekTime };
        }
        return null;
    }

    /**
     * Get list of all incidents for UI display
     */
    getIncidents() {
        return this.incidents.map(i => ({
            time: i.time,
            score: i.score,
            severity: i.severity,
            processed: this.processedIncidents.has(`${i.time.toFixed(2)}`)
        }));
    }

    /**
     * Update settings
     */
    updateSettings(settings) {
        if (settings.slowMoRate !== undefined) {
            this.slowMoRate = Math.max(0.1, Math.min(1.0, settings.slowMoRate));
        }
        if (settings.preIncidentBuffer !== undefined) {
            this.preIncidentBuffer = Math.max(0, Math.min(10, settings.preIncidentBuffer));
        }
        if (settings.postIncidentBuffer !== undefined) {
            this.postIncidentBuffer = Math.max(0, Math.min(10, settings.postIncidentBuffer));
        }
        if (settings.minScoreThreshold !== undefined) {
            this.minScoreThreshold = Math.max(1, Math.min(10, settings.minScoreThreshold));
            // Re-filter incidents with new threshold
            if (this.telemetryGraphs?.nearMisses) {
                this._onNearMissesUpdated(this.telemetryGraphs.nearMisses);
            }
        }
        this._saveSettings();
    }

    /**
     * Get current settings
     */
    getSettings() {
        return {
            slowMoRate: this.slowMoRate,
            preIncidentBuffer: this.preIncidentBuffer,
            postIncidentBuffer: this.postIncidentBuffer,
            minScoreThreshold: this.minScoreThreshold
        };
    }

    /**
     * Cleanup
     */
    destroy() {
        if (this.videoPlayer?.videos?.front) {
            this.videoPlayer.videos.front.removeEventListener('timeupdate', this._onTimeUpdate);
        }
        if (this.indicatorContainer?.parentNode) {
            this.indicatorContainer.parentNode.removeChild(this.indicatorContainer);
        }
    }
}

// Export for use
window.IncidentSlowMo = IncidentSlowMo;
