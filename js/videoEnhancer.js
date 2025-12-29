/**
 * VideoEnhancer - Provides brightness, contrast, and saturation controls for video playback
 * Uses CSS filters for real-time adjustment
 */

class VideoEnhancer {
    constructor() {
        this.STORAGE_KEY = 'teslacamviewer_video_enhancement';

        this.defaults = {
            brightness: 100,  // 0-200, 100 = normal
            contrast: 100,    // 0-200, 100 = normal
            saturation: 100   // 0-200, 100 = normal
        };

        this.settings = this.loadSettings();
        this.controlsContainer = null;
        this.controlsVisible = false;
    }

    /**
     * Load enhancement settings from localStorage
     * @returns {Object} Settings object
     */
    loadSettings() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) {
                return { ...this.defaults, ...JSON.parse(stored) };
            }
        } catch (e) {
            console.warn('Failed to load enhancement settings:', e);
        }
        return { ...this.defaults };
    }

    /**
     * Save current settings to localStorage
     */
    saveSettings() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.settings));
        } catch (e) {
            console.warn('Failed to save enhancement settings:', e);
        }
    }

    /**
     * Apply CSS filters to all video elements
     */
    applyFilters() {
        const filter = [
            `brightness(${this.settings.brightness / 100})`,
            `contrast(${this.settings.contrast / 100})`,
            `saturate(${this.settings.saturation / 100})`
        ].join(' ');

        // Apply to all video elements
        const videos = document.querySelectorAll('.video-player');
        videos.forEach(video => {
            video.style.filter = filter;
        });
    }

    /**
     * Set brightness value
     * @param {number} value - 0 to 200
     */
    setBrightness(value) {
        this.settings.brightness = Math.max(0, Math.min(200, value));
        this.applyFilters();
        this.saveSettings();
    }

    /**
     * Set contrast value
     * @param {number} value - 0 to 200
     */
    setContrast(value) {
        this.settings.contrast = Math.max(0, Math.min(200, value));
        this.applyFilters();
        this.saveSettings();
    }

    /**
     * Set saturation value
     * @param {number} value - 0 to 200
     */
    setSaturation(value) {
        this.settings.saturation = Math.max(0, Math.min(200, value));
        this.applyFilters();
        this.saveSettings();
    }

    /**
     * Reset all settings to defaults
     */
    reset() {
        this.settings = { ...this.defaults };
        this.applyFilters();
        this.saveSettings();
        this.updateSliders();
    }

    /**
     * Check if any setting is modified from default
     * @returns {boolean}
     */
    isModified() {
        return this.settings.brightness !== this.defaults.brightness ||
               this.settings.contrast !== this.defaults.contrast ||
               this.settings.saturation !== this.defaults.saturation;
    }

    /**
     * Create the controls UI panel
     * @returns {HTMLElement}
     */
    createControlsUI() {
        const container = document.createElement('div');
        container.className = 'video-enhancement-controls hidden';
        container.innerHTML = `
            <div class="enhancement-header">
                <span class="enhancement-title">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/>
                    </svg>
                    Video Enhancement
                </span>
                <button class="enhancement-close-btn" title="Close">&times;</button>
            </div>
            <div class="enhancement-sliders">
                <div class="enhancement-slider-row">
                    <label>Brightness</label>
                    <input type="range" id="brightnessSlider" min="0" max="200" value="${this.settings.brightness}">
                    <span id="brightnessValue">${this.settings.brightness}%</span>
                </div>
                <div class="enhancement-slider-row">
                    <label>Contrast</label>
                    <input type="range" id="contrastSlider" min="0" max="200" value="${this.settings.contrast}">
                    <span id="contrastValue">${this.settings.contrast}%</span>
                </div>
                <div class="enhancement-slider-row">
                    <label>Saturation</label>
                    <input type="range" id="saturationSlider" min="0" max="200" value="${this.settings.saturation}">
                    <span id="saturationValue">${this.settings.saturation}%</span>
                </div>
            </div>
            <div class="enhancement-actions">
                <button id="resetEnhancement" class="enhancement-reset-btn">Reset to Default</button>
            </div>
            <div class="enhancement-note">
                Note: Enhancements are for preview only and won't appear in exports.
            </div>
        `;

        return container;
    }

    /**
     * Attach event listeners to the controls
     */
    attachControlsEvents() {
        if (!this.controlsContainer) return;

        const brightnessSlider = this.controlsContainer.querySelector('#brightnessSlider');
        const contrastSlider = this.controlsContainer.querySelector('#contrastSlider');
        const saturationSlider = this.controlsContainer.querySelector('#saturationSlider');
        const closeBtn = this.controlsContainer.querySelector('.enhancement-close-btn');
        const resetBtn = this.controlsContainer.querySelector('#resetEnhancement');

        brightnessSlider.addEventListener('input', (e) => {
            this.setBrightness(parseInt(e.target.value));
            this.controlsContainer.querySelector('#brightnessValue').textContent = `${e.target.value}%`;
        });

        contrastSlider.addEventListener('input', (e) => {
            this.setContrast(parseInt(e.target.value));
            this.controlsContainer.querySelector('#contrastValue').textContent = `${e.target.value}%`;
        });

        saturationSlider.addEventListener('input', (e) => {
            this.setSaturation(parseInt(e.target.value));
            this.controlsContainer.querySelector('#saturationValue').textContent = `${e.target.value}%`;
        });

        closeBtn.addEventListener('click', () => this.hide());
        resetBtn.addEventListener('click', () => this.reset());
    }

    /**
     * Update slider positions from current settings
     */
    updateSliders() {
        if (!this.controlsContainer) return;

        const brightnessSlider = this.controlsContainer.querySelector('#brightnessSlider');
        const contrastSlider = this.controlsContainer.querySelector('#contrastSlider');
        const saturationSlider = this.controlsContainer.querySelector('#saturationSlider');

        if (brightnessSlider) {
            brightnessSlider.value = this.settings.brightness;
            this.controlsContainer.querySelector('#brightnessValue').textContent = `${this.settings.brightness}%`;
        }
        if (contrastSlider) {
            contrastSlider.value = this.settings.contrast;
            this.controlsContainer.querySelector('#contrastValue').textContent = `${this.settings.contrast}%`;
        }
        if (saturationSlider) {
            saturationSlider.value = this.settings.saturation;
            this.controlsContainer.querySelector('#saturationValue').textContent = `${this.settings.saturation}%`;
        }
    }

    /**
     * Initialize the controls in the video grid container
     * @param {HTMLElement} parentContainer - The container to append controls to
     */
    initialize(parentContainer) {
        if (this.controlsContainer) return;

        this.controlsContainer = this.createControlsUI();
        parentContainer.appendChild(this.controlsContainer);
        this.attachControlsEvents();

        // Apply any saved settings on init
        this.applyFilters();
    }

    /**
     * Show the controls panel
     */
    show() {
        if (this.controlsContainer) {
            this.controlsContainer.classList.remove('hidden');
            this.controlsVisible = true;
        }
    }

    /**
     * Hide the controls panel
     */
    hide() {
        if (this.controlsContainer) {
            this.controlsContainer.classList.add('hidden');
            this.controlsVisible = false;
        }
    }

    /**
     * Toggle visibility of controls panel
     */
    toggle() {
        if (this.controlsVisible) {
            this.hide();
        } else {
            this.show();
        }
    }
}

// Export for use
window.VideoEnhancer = VideoEnhancer;
