/**
 * LayoutEditor - Visual editor for creating and editing custom camera layouts
 */

class LayoutEditor {
    constructor(layoutManager) {
        this.layoutManager = layoutManager;
        this.modal = null;
        this.currentConfig = null;
        this.selectedCamera = null;
        this.isDragging = false;
        this.isResizing = false;
        this.resizeHandle = null;
        this.dragStart = { x: 0, y: 0 };
        this.originalPos = { x: 0, y: 0, width: 0, height: 0 };

        // Captured video frames for preview
        this.cameraFrames = {};

        // Snap guide settings
        this.snapEnabled = true; // Toggle for snap functionality
        this.snapThreshold = 3; // Percentage to snap within
        this.activeSnapGuides = { x: [], y: [] }; // Currently active guides

        // Expose globally for layoutManager to access
        window.layoutEditor = this;
    }

    /**
     * Calculate snap points for the current drag operation
     * @returns {Object} Object with x and y snap point arrays
     */
    getSnapPoints() {
        const snapPoints = { x: [], y: [] };

        // Canvas edges
        snapPoints.x.push(0, 50, 100);  // Left, center, right
        snapPoints.y.push(0, 50, 100);  // Top, center, bottom

        // Other camera edges and centers
        for (const [camName, cam] of Object.entries(this.currentConfig.cameras)) {
            if (camName === this.selectedCamera || !cam.enabled) continue;

            const pos = cam.position;

            // Edges
            snapPoints.x.push(pos.x, pos.x + pos.width);
            snapPoints.y.push(pos.y, pos.y + pos.height);

            // Center
            snapPoints.x.push(pos.x + pos.width / 2);
            snapPoints.y.push(pos.y + pos.height / 2);
        }

        return snapPoints;
    }

    /**
     * Apply snapping to a position
     * @param {number} value - Current value
     * @param {Array} snapPoints - Array of snap points
     * @param {number} threshold - Snap threshold in percentage
     * @returns {Object} { value: snapped value, snapped: boolean, guide: snap point if snapped }
     */
    applySnap(value, snapPoints, threshold) {
        for (const point of snapPoints) {
            if (Math.abs(value - point) <= threshold) {
                return { value: point, snapped: true, guide: point };
            }
        }
        return { value, snapped: false, guide: null };
    }

    /**
     * Update snap guide visualization
     */
    updateSnapGuides() {
        const preview = this.modal?.querySelector('#editorPreview');
        if (!preview) return;

        // Remove existing guides
        preview.querySelectorAll('.snap-guide').forEach(g => g.remove());

        // Add active guides
        for (const x of this.activeSnapGuides.x) {
            const guide = document.createElement('div');
            guide.className = 'snap-guide snap-guide-v';
            // Add center class if at 50%
            if (Math.abs(x - 50) < 0.5) {
                guide.classList.add('snap-guide-center');
            }
            guide.style.left = `${x}%`;
            preview.appendChild(guide);
        }

        for (const y of this.activeSnapGuides.y) {
            const guide = document.createElement('div');
            guide.className = 'snap-guide snap-guide-h';
            // Add center class if at 50%
            if (Math.abs(y - 50) < 0.5) {
                guide.classList.add('snap-guide-center');
            }
            guide.style.top = `${y}%`;
            preview.appendChild(guide);
        }
    }

    /**
     * Clear all snap guides
     */
    clearSnapGuides() {
        this.activeSnapGuides = { x: [], y: [] };
        const preview = this.modal?.querySelector('#editorPreview');
        if (preview) {
            preview.querySelectorAll('.snap-guide').forEach(g => g.remove());
        }
    }

    /**
     * Capture current frames from all video elements
     */
    captureVideoFrames() {
        this.cameraFrames = {};

        const videos = {
            front: document.getElementById('videoFront'),
            back: document.getElementById('videoBack'),
            left_repeater: document.getElementById('videoLeft'),
            right_repeater: document.getElementById('videoRight')
        };

        for (const [camName, video] of Object.entries(videos)) {
            if (video && video.videoWidth > 0 && video.videoHeight > 0) {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(video, 0, 0);
                    this.cameraFrames[camName] = canvas.toDataURL('image/jpeg', 0.7);
                } catch (e) {
                    console.warn(`Failed to capture frame for ${camName}:`, e);
                }
            }
        }
    }

    /**
     * Show the layout editor modal
     * @param {Object|string} existingConfigOrId - Optional config object or layout ID to edit
     */
    show(existingConfigOrId = null) {
        // Capture current video frames before showing modal
        this.captureVideoFrames();

        let existingConfig = null;
        if (typeof existingConfigOrId === 'string') {
            // It's a layout ID, look it up
            existingConfig = this.layoutManager.getCustomLayout(existingConfigOrId);
        } else if (existingConfigOrId && typeof existingConfigOrId === 'object') {
            existingConfig = existingConfigOrId;
        }

        if (existingConfig) {
            this.currentConfig = LayoutConfig.clone(existingConfig);
            this.isEditing = true;
        } else {
            // Start with default or current layout as base
            const currentLayout = this.layoutManager.getCurrentLayout();
            const presetConfig = LayoutConfig.presetToConfig(currentLayout);
            if (presetConfig) {
                this.currentConfig = presetConfig;
                this.currentConfig.id = `custom-${Date.now()}`;
                this.currentConfig.name = `Custom ${presetConfig.name}`;
                this.currentConfig.author = '';
            } else {
                this.currentConfig = LayoutConfig.getDefault();
            }
            this.isEditing = false;
        }

        this.selectedCamera = 'front';
        this.createModal();
        this.bindEvents();
        this.updatePreview();
        this.updatePropertiesPanel();
        this.updateCustomLayoutsList();
    }

    /**
     * Hide the editor modal
     */
    hide() {
        if (this.modal) {
            this.modal.classList.add('hidden');
            setTimeout(() => {
                if (this.modal) {
                    this.modal.remove();
                    this.modal = null;
                }
            }, 300);
        }
    }

    /**
     * Create the modal DOM structure
     */
    createModal() {
        if (this.modal) {
            this.modal.remove();
        }

        this.modal = document.createElement('div');
        this.modal.className = 'layout-editor-modal';
        this.modal.innerHTML = `
            <div class="layout-editor-overlay"></div>
            <div class="layout-editor-panel">
                <div class="layout-editor-header">
                    <h2>Layout Editor</h2>
                    <button class="layout-editor-close" title="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
                <div class="layout-editor-toolbar">
                    <button class="layout-editor-btn" id="editorNewBtn" title="New Layout">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                        New
                    </button>
                    <button class="layout-editor-btn" id="editorImportBtn" title="Import Layout">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>
                        Import
                    </button>
                    <button class="layout-editor-btn" id="editorExportBtn" title="Export Layout">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                        Export
                    </button>
                    <div class="layout-editor-toolbar-spacer"></div>
                    <label class="layout-editor-snap-toggle">
                        <input type="checkbox" id="editorSnapToggle" checked>
                        <span>Snap</span>
                    </label>
                    <label>Aspect:</label>
                    <select id="editorAspectRatio" class="layout-editor-select">
                        <option value="4:3">4:3</option>
                        <option value="16:9">16:9</option>
                        <option value="6:3">6:3 (Wide)</option>
                        <option value="8:3">8:3 (Ultra Wide)</option>
                        <option value="12:3">12:3 (Triple)</option>
                        <option value="21:9">21:9 (Cinematic)</option>
                    </select>
                </div>
                <div class="layout-editor-content">
                    <div class="layout-editor-preview-area">
                        <div class="layout-editor-preview" id="editorPreview">
                            <!-- Camera placeholders will be rendered here -->
                        </div>
                        <p class="layout-editor-hint">Click to select, drag to move, corners to resize</p>
                    </div>
                    <div class="layout-editor-properties">
                        <div class="layout-editor-prop-section">
                            <h3>Selected Camera</h3>
                            <div class="layout-editor-camera-select">
                                ${LayoutConfig.CAMERAS.map(cam => `
                                    <button class="layout-editor-cam-btn ${cam === 'front' ? 'active' : ''}"
                                            data-camera="${cam}"
                                            ${LayoutConfig.FUTURE_CAMERAS.includes(cam) ? 'disabled title="Future camera - not yet available"' : ''}>
                                        ${LayoutConfig.CAMERA_SHORT_NAMES[cam]}
                                    </button>
                                `).join('')}
                            </div>
                        </div>

                        <div class="layout-editor-prop-section">
                            <h3>Position</h3>
                            <div class="layout-editor-prop-row">
                                <label>X:</label>
                                <input type="number" id="propX" min="0" max="100" step="1"> %
                                <label>Y:</label>
                                <input type="number" id="propY" min="0" max="100" step="1"> %
                            </div>
                        </div>

                        <div class="layout-editor-prop-section">
                            <h3>Size</h3>
                            <div class="layout-editor-prop-row">
                                <label>W:</label>
                                <input type="number" id="propW" min="1" max="100" step="1"> %
                                <label>H:</label>
                                <input type="number" id="propH" min="1" max="100" step="1"> %
                            </div>
                        </div>

                        <div class="layout-editor-prop-section">
                            <h3>Layer</h3>
                            <div class="layout-editor-prop-row">
                                <button class="layout-editor-btn small" id="propZDown" title="Send backward">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
                                </button>
                                <span id="propZ">1</span>
                                <button class="layout-editor-btn small" id="propZUp" title="Bring forward">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
                                </button>
                                <label style="margin-left: 1rem;">Fit:</label>
                                <select id="propFit" class="layout-editor-select small">
                                    <option value="contain">Contain</option>
                                    <option value="cover">Cover</option>
                                </select>
                            </div>
                        </div>

                        <div class="layout-editor-prop-section">
                            <h3>Crop Edges</h3>
                            <div class="layout-editor-crop-grid">
                                <div class="crop-row">
                                    <label>Top:</label>
                                    <input type="range" id="cropTop" min="0" max="40" value="0">
                                    <span id="cropTopVal">0%</span>
                                </div>
                                <div class="crop-row">
                                    <label>Bottom:</label>
                                    <input type="range" id="cropBottom" min="0" max="40" value="0">
                                    <span id="cropBottomVal">0%</span>
                                </div>
                                <div class="crop-row">
                                    <label>Left:</label>
                                    <input type="range" id="cropLeft" min="0" max="40" value="0">
                                    <span id="cropLeftVal">0%</span>
                                </div>
                                <div class="crop-row">
                                    <label>Right:</label>
                                    <input type="range" id="cropRight" min="0" max="40" value="0">
                                    <span id="cropRightVal">0%</span>
                                </div>
                            </div>
                        </div>

                        <div class="layout-editor-prop-section">
                            <h3>Cameras</h3>
                            <div class="layout-editor-camera-list">
                                ${LayoutConfig.CAMERAS.map(cam => `
                                    <label class="layout-editor-cam-toggle ${LayoutConfig.FUTURE_CAMERAS.includes(cam) ? 'future' : ''}">
                                        <input type="checkbox" data-camera="${cam}"
                                               ${LayoutConfig.FUTURE_CAMERAS.includes(cam) ? 'disabled' : ''}>
                                        ${LayoutConfig.CAMERA_NAMES[cam]}
                                        ${LayoutConfig.FUTURE_CAMERAS.includes(cam) ? '<span class="future-badge">Soon</span>' : ''}
                                    </label>
                                `).join('')}
                            </div>
                        </div>

                        <div class="layout-editor-prop-section">
                            <h3>Saved Layouts</h3>
                            <div id="customLayoutsList" class="layout-editor-saved-list">
                                <!-- Custom layouts will be rendered here -->
                            </div>
                        </div>
                    </div>
                </div>
                <div class="layout-editor-footer">
                    <input type="text" id="editorLayoutName" placeholder="Layout name" class="layout-editor-name-input">
                    <div class="layout-editor-footer-buttons">
                        <button class="layout-editor-btn secondary" id="editorCancelBtn">Cancel</button>
                        <button class="layout-editor-btn primary" id="editorSaveBtn">Save Layout</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(this.modal);

        // Set initial values
        document.getElementById('editorLayoutName').value = this.currentConfig.name;
        document.getElementById('editorAspectRatio').value = this.currentConfig.canvas.aspectRatio;

        // Update camera visibility checkboxes
        this.updateCameraCheckboxes();

        // Fade in
        requestAnimationFrame(() => {
            this.modal.classList.add('visible');
        });
    }

    /**
     * Bind all event listeners
     */
    bindEvents() {
        // Close button
        this.modal.querySelector('.layout-editor-close').addEventListener('click', () => this.hide());
        this.modal.querySelector('.layout-editor-overlay').addEventListener('click', () => this.hide());
        this.modal.querySelector('#editorCancelBtn').addEventListener('click', () => this.hide());

        // Save button
        this.modal.querySelector('#editorSaveBtn').addEventListener('click', () => this.saveLayout());

        // New/Import/Export buttons
        this.modal.querySelector('#editorNewBtn').addEventListener('click', () => this.newLayout());
        this.modal.querySelector('#editorImportBtn').addEventListener('click', () => this.importLayout());
        this.modal.querySelector('#editorExportBtn').addEventListener('click', () => this.exportLayout());

        // Aspect ratio change
        this.modal.querySelector('#editorAspectRatio').addEventListener('change', (e) => {
            this.currentConfig.canvas.aspectRatio = e.target.value;
            this.updatePreview();
        });

        // Snap toggle
        this.modal.querySelector('#editorSnapToggle').addEventListener('change', (e) => {
            this.snapEnabled = e.target.checked;
        });

        // Camera selection buttons
        this.modal.querySelectorAll('.layout-editor-cam-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!btn.disabled) {
                    this.selectCamera(btn.dataset.camera);
                }
            });
        });

        // Camera visibility checkboxes
        this.modal.querySelectorAll('.layout-editor-cam-toggle input').forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                const cam = checkbox.dataset.camera;
                this.currentConfig.cameras[cam].enabled = checkbox.checked;
                this.updatePreview();
            });
        });

        // Property inputs
        const propInputs = ['propX', 'propY', 'propW', 'propH'];
        propInputs.forEach(id => {
            const input = this.modal.querySelector(`#${id}`);
            input.addEventListener('input', () => this.onPropertyChange());
        });

        // Z-index buttons
        this.modal.querySelector('#propZUp').addEventListener('click', () => this.changeZIndex(1));
        this.modal.querySelector('#propZDown').addEventListener('click', () => this.changeZIndex(-1));

        // Object fit
        this.modal.querySelector('#propFit').addEventListener('change', (e) => {
            if (this.selectedCamera && this.currentConfig.cameras[this.selectedCamera]) {
                this.currentConfig.cameras[this.selectedCamera].objectFit = e.target.value;
                this.updatePreview();
            }
        });

        // Crop sliders
        ['cropTop', 'cropBottom', 'cropLeft', 'cropRight'].forEach(id => {
            const slider = this.modal.querySelector(`#${id}`);
            slider.addEventListener('input', () => this.onCropChange());
        });

        // Layout name
        this.modal.querySelector('#editorLayoutName').addEventListener('input', (e) => {
            this.currentConfig.name = e.target.value || 'Untitled Layout';
        });

        // Escape key
        document.addEventListener('keydown', this.handleKeyDown.bind(this));
    }

    /**
     * Handle keyboard events
     */
    handleKeyDown(e) {
        if (!this.modal || this.modal.classList.contains('hidden')) return;

        if (e.key === 'Escape') {
            this.hide();
        }

        // Arrow keys to nudge selected camera
        if (this.selectedCamera && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            const cam = this.currentConfig.cameras[this.selectedCamera];
            const crop = cam.crop || { top: 0, right: 0, bottom: 0, left: 0 };
            const step = e.shiftKey ? 5 : 1;

            // Calculate crop-aware bounds
            const cropLeftPx = cam.position.width * (crop.left / 100);
            const cropRightPx = cam.position.width * (crop.right / 100);
            const cropTopPx = cam.position.height * (crop.top / 100);
            const cropBottomPx = cam.position.height * (crop.bottom / 100);

            const minX = -cropLeftPx;
            const maxX = 100 - cam.position.width + cropRightPx;
            const minY = -cropTopPx;
            const maxY = 100 - cam.position.height + cropBottomPx;

            switch (e.key) {
                case 'ArrowUp': cam.position.y = Math.max(minY, cam.position.y - step); break;
                case 'ArrowDown': cam.position.y = Math.min(maxY, cam.position.y + step); break;
                case 'ArrowLeft': cam.position.x = Math.max(minX, cam.position.x - step); break;
                case 'ArrowRight': cam.position.x = Math.min(maxX, cam.position.x + step); break;
            }

            this.updatePreview();
            this.updatePropertiesPanel();
        }
    }

    /**
     * Select a camera for editing
     */
    selectCamera(cameraName) {
        this.selectedCamera = cameraName;

        // Update button states
        this.modal.querySelectorAll('.layout-editor-cam-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.camera === cameraName);
        });

        this.updatePropertiesPanel();
        this.updatePreview();
    }

    /**
     * Update properties panel with selected camera data
     */
    updatePropertiesPanel() {
        if (!this.selectedCamera || !this.currentConfig.cameras[this.selectedCamera]) return;

        const cam = this.currentConfig.cameras[this.selectedCamera];

        this.modal.querySelector('#propX').value = Math.round(cam.position.x);
        this.modal.querySelector('#propY').value = Math.round(cam.position.y);
        this.modal.querySelector('#propW').value = Math.round(cam.position.width);
        this.modal.querySelector('#propH').value = Math.round(cam.position.height);
        this.modal.querySelector('#propZ').textContent = cam.zIndex;
        this.modal.querySelector('#propFit').value = cam.objectFit || 'contain';

        // Crop sliders
        this.modal.querySelector('#cropTop').value = cam.crop?.top || 0;
        this.modal.querySelector('#cropBottom').value = cam.crop?.bottom || 0;
        this.modal.querySelector('#cropLeft').value = cam.crop?.left || 0;
        this.modal.querySelector('#cropRight').value = cam.crop?.right || 0;

        this.updateCropLabels();
    }

    /**
     * Update crop value labels
     */
    updateCropLabels() {
        ['Top', 'Bottom', 'Left', 'Right'].forEach(dir => {
            const val = this.modal.querySelector(`#crop${dir}`).value;
            this.modal.querySelector(`#crop${dir}Val`).textContent = `${val}%`;
        });
    }

    /**
     * Handle property input changes
     */
    onPropertyChange() {
        if (!this.selectedCamera || !this.currentConfig.cameras[this.selectedCamera]) return;

        const cam = this.currentConfig.cameras[this.selectedCamera];
        cam.position.x = parseFloat(this.modal.querySelector('#propX').value) || 0;
        cam.position.y = parseFloat(this.modal.querySelector('#propY').value) || 0;
        cam.position.width = parseFloat(this.modal.querySelector('#propW').value) || 10;
        cam.position.height = parseFloat(this.modal.querySelector('#propH').value) || 10;

        this.updatePreview();
    }

    /**
     * Handle crop slider changes
     */
    onCropChange() {
        if (!this.selectedCamera || !this.currentConfig.cameras[this.selectedCamera]) return;

        const cam = this.currentConfig.cameras[this.selectedCamera];
        cam.crop = cam.crop || { top: 0, right: 0, bottom: 0, left: 0 };
        cam.crop.top = parseInt(this.modal.querySelector('#cropTop').value) || 0;
        cam.crop.bottom = parseInt(this.modal.querySelector('#cropBottom').value) || 0;
        cam.crop.left = parseInt(this.modal.querySelector('#cropLeft').value) || 0;
        cam.crop.right = parseInt(this.modal.querySelector('#cropRight').value) || 0;

        this.updateCropLabels();
        this.updatePreview();
    }

    /**
     * Change z-index of selected camera
     */
    changeZIndex(delta) {
        if (!this.selectedCamera || !this.currentConfig.cameras[this.selectedCamera]) return;

        const cam = this.currentConfig.cameras[this.selectedCamera];
        cam.zIndex = Math.max(1, Math.min(100, (cam.zIndex || 1) + delta));

        this.modal.querySelector('#propZ').textContent = cam.zIndex;
        this.updatePreview();
    }

    /**
     * Update camera visibility checkboxes
     */
    updateCameraCheckboxes() {
        this.modal.querySelectorAll('.layout-editor-cam-toggle input').forEach(checkbox => {
            const cam = checkbox.dataset.camera;
            if (this.currentConfig.cameras[cam]) {
                checkbox.checked = this.currentConfig.cameras[cam].enabled;
            }
        });
    }

    /**
     * Update the preview area
     */
    updatePreview() {
        const preview = this.modal.querySelector('#editorPreview');

        // Set aspect ratio
        const aspectRatio = this.currentConfig.canvas.aspectRatio;
        const arParts = LayoutConfig.ASPECT_RATIOS[aspectRatio] || { width: 4, height: 3 };
        preview.style.aspectRatio = `${arParts.width} / ${arParts.height}`;

        // Clear existing placeholders
        preview.innerHTML = '';

        // Create camera placeholders sorted by z-index
        const sortedCameras = Object.entries(this.currentConfig.cameras)
            .filter(([name, cam]) => cam.enabled)
            .sort((a, b) => (a[1].zIndex || 1) - (b[1].zIndex || 1));

        for (const [camName, camConfig] of sortedCameras) {
            const placeholder = document.createElement('div');
            placeholder.className = 'layout-editor-cam-placeholder';
            placeholder.dataset.camera = camName;

            if (camName === this.selectedCamera) {
                placeholder.classList.add('selected');
            }

            const pos = camConfig.position;
            placeholder.style.left = `${pos.x}%`;
            placeholder.style.top = `${pos.y}%`;
            placeholder.style.width = `${pos.width}%`;
            placeholder.style.height = `${pos.height}%`;
            placeholder.style.zIndex = camConfig.zIndex || 1;

            // Create inner content element for crop clipping (keeps resize handles outside clip)
            const content = document.createElement('div');
            content.className = 'cam-content';

            // Apply video frame as background to content element
            if (this.cameraFrames[camName]) {
                content.style.backgroundImage = `url(${this.cameraFrames[camName]})`;
                content.style.backgroundSize = camConfig.objectFit === 'cover' ? 'cover' : 'contain';
                content.style.backgroundPosition = 'center';
                content.style.backgroundRepeat = 'no-repeat';
            }

            // Apply crop visualization to content element only
            const crop = camConfig.crop || { top: 0, right: 0, bottom: 0, left: 0 };
            if (crop.top > 0 || crop.right > 0 || crop.bottom > 0 || crop.left > 0) {
                content.style.clipPath = `inset(${crop.top}% ${crop.right}% ${crop.bottom}% ${crop.left}%)`;
            }

            placeholder.appendChild(content);

            // Camera label (inside content so it gets clipped with video)
            const label = document.createElement('span');
            label.className = 'cam-label';
            label.textContent = LayoutConfig.CAMERA_SHORT_NAMES[camName];
            content.appendChild(label);

            // Resize handles (for selected camera) - outside content so they don't get clipped
            if (camName === this.selectedCamera) {
                ['nw', 'ne', 'sw', 'se'].forEach(handle => {
                    const handleEl = document.createElement('div');
                    handleEl.className = `resize-handle ${handle}`;
                    handleEl.dataset.handle = handle;
                    placeholder.appendChild(handleEl);
                });
            }

            // Bind drag events
            this.bindPlaceholderEvents(placeholder, camName);

            preview.appendChild(placeholder);
        }
    }

    /**
     * Bind drag and resize events to camera placeholder
     */
    bindPlaceholderEvents(placeholder, camName) {
        placeholder.addEventListener('mousedown', (e) => {
            e.preventDefault();

            // Check if clicking a resize handle
            if (e.target.classList.contains('resize-handle')) {
                this.startResize(camName, e.target.dataset.handle, e);
                return;
            }

            // Select and start drag
            this.selectCamera(camName);
            this.startDrag(camName, e);
        });

        placeholder.addEventListener('click', (e) => {
            e.stopPropagation();
            this.selectCamera(camName);
        });
    }

    /**
     * Start dragging a camera
     */
    startDrag(camName, e) {
        this.isDragging = true;
        this.dragStart = { x: e.clientX, y: e.clientY };

        const cam = this.currentConfig.cameras[camName];
        this.originalPos = { ...cam.position };

        // Clear any existing snap guides
        this.clearSnapGuides();

        const onMouseMove = (e) => this.onDrag(e);
        const onMouseUp = () => {
            this.isDragging = false;
            this.clearSnapGuides();
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    /**
     * Handle drag movement
     */
    onDrag(e) {
        if (!this.isDragging || !this.selectedCamera) return;

        const preview = this.modal.querySelector('#editorPreview');
        const rect = preview.getBoundingClientRect();

        const deltaX = ((e.clientX - this.dragStart.x) / rect.width) * 100;
        const deltaY = ((e.clientY - this.dragStart.y) / rect.height) * 100;

        const cam = this.currentConfig.cameras[this.selectedCamera];
        const crop = cam.crop || { top: 0, right: 0, bottom: 0, left: 0 };

        // Calculate how much the cropped area can extend beyond canvas edges
        const cropLeftPx = cam.position.width * (crop.left / 100);
        const cropRightPx = cam.position.width * (crop.right / 100);
        const cropTopPx = cam.position.height * (crop.top / 100);
        const cropBottomPx = cam.position.height * (crop.bottom / 100);

        // Min/max bounds
        const minX = -cropLeftPx;
        const maxX = 100 - cam.position.width + cropRightPx;
        const minY = -cropTopPx;
        const maxY = 100 - cam.position.height + cropBottomPx;

        // Calculate raw new position
        let newX = Math.max(minX, Math.min(maxX, this.originalPos.x + deltaX));
        let newY = Math.max(minY, Math.min(maxY, this.originalPos.y + deltaY));

        // Apply snapping (if enabled)
        this.activeSnapGuides = { x: [], y: [] };

        if (this.snapEnabled) {
            const snapPoints = this.getSnapPoints();

            // Try snapping left edge, right edge, and center X
            const leftEdge = newX;
            const rightEdge = newX + cam.position.width;
            const centerX = newX + cam.position.width / 2;

            const snapLeft = this.applySnap(leftEdge, snapPoints.x, this.snapThreshold);
            const snapRight = this.applySnap(rightEdge, snapPoints.x, this.snapThreshold);
            const snapCenterX = this.applySnap(centerX, snapPoints.x, this.snapThreshold);

            // Pick the best X snap (prefer left edge, then center, then right)
            if (snapLeft.snapped) {
                newX = snapLeft.value;
                this.activeSnapGuides.x.push(snapLeft.guide);
            } else if (snapCenterX.snapped) {
                newX = snapCenterX.value - cam.position.width / 2;
                this.activeSnapGuides.x.push(snapCenterX.guide);
            } else if (snapRight.snapped) {
                newX = snapRight.value - cam.position.width;
                this.activeSnapGuides.x.push(snapRight.guide);
            }

            // Try snapping top edge, bottom edge, and center Y
            const topEdge = newY;
            const bottomEdge = newY + cam.position.height;
            const centerY = newY + cam.position.height / 2;

            const snapTop = this.applySnap(topEdge, snapPoints.y, this.snapThreshold);
            const snapBottom = this.applySnap(bottomEdge, snapPoints.y, this.snapThreshold);
            const snapCenterY = this.applySnap(centerY, snapPoints.y, this.snapThreshold);

            // Pick the best Y snap (prefer top edge, then center, then bottom)
            if (snapTop.snapped) {
                newY = snapTop.value;
                this.activeSnapGuides.y.push(snapTop.guide);
            } else if (snapCenterY.snapped) {
                newY = snapCenterY.value - cam.position.height / 2;
                this.activeSnapGuides.y.push(snapCenterY.guide);
            } else if (snapBottom.snapped) {
                newY = snapBottom.value - cam.position.height;
                this.activeSnapGuides.y.push(snapBottom.guide);
            }
        }

        // Apply final position
        cam.position.x = newX;
        cam.position.y = newY;

        // Update snap guides visualization
        this.updateSnapGuides();

        this.updatePreview();
        this.updatePropertiesPanel();
    }

    /**
     * Start resizing a camera
     */
    startResize(camName, handle, e) {
        this.isResizing = true;
        this.resizeHandle = handle;
        this.dragStart = { x: e.clientX, y: e.clientY };

        const cam = this.currentConfig.cameras[camName];
        this.originalPos = { ...cam.position };

        // Clear any existing snap guides
        this.clearSnapGuides();

        const onMouseMove = (e) => this.onResize(e);
        const onMouseUp = () => {
            this.isResizing = false;
            this.resizeHandle = null;
            this.clearSnapGuides();
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    /**
     * Handle resize movement
     */
    onResize(e) {
        if (!this.isResizing || !this.selectedCamera) return;

        const preview = this.modal.querySelector('#editorPreview');
        const rect = preview.getBoundingClientRect();

        const deltaX = ((e.clientX - this.dragStart.x) / rect.width) * 100;
        const deltaY = ((e.clientY - this.dragStart.y) / rect.height) * 100;

        const cam = this.currentConfig.cameras[this.selectedCamera];
        const minSize = 5;

        // Get snap points for resize snapping
        this.activeSnapGuides = { x: [], y: [] };
        const snapPoints = this.snapEnabled ? this.getSnapPoints() : { x: [], y: [] };

        switch (this.resizeHandle) {
            case 'se': {
                // SE: resize right and bottom edges
                let newWidth = Math.max(minSize, Math.min(100 - cam.position.x, this.originalPos.width + deltaX));
                let newHeight = Math.max(minSize, Math.min(100 - cam.position.y, this.originalPos.height + deltaY));

                if (this.snapEnabled) {
                    // Snap right edge
                    const rightEdge = cam.position.x + newWidth;
                    const snapRight = this.applySnap(rightEdge, snapPoints.x, this.snapThreshold);
                    if (snapRight.snapped) {
                        newWidth = snapRight.value - cam.position.x;
                        this.activeSnapGuides.x.push(snapRight.guide);
                    }
                    // Snap bottom edge
                    const bottomEdge = cam.position.y + newHeight;
                    const snapBottom = this.applySnap(bottomEdge, snapPoints.y, this.snapThreshold);
                    if (snapBottom.snapped) {
                        newHeight = snapBottom.value - cam.position.y;
                        this.activeSnapGuides.y.push(snapBottom.guide);
                    }
                }

                cam.position.width = Math.max(minSize, newWidth);
                cam.position.height = Math.max(minSize, newHeight);
                break;
            }
            case 'sw': {
                // SW: resize left and bottom edges
                let newX = this.originalPos.x + deltaX;
                let newW = this.originalPos.width - deltaX;
                let newHeight = Math.max(minSize, Math.min(100 - cam.position.y, this.originalPos.height + deltaY));

                if (this.snapEnabled) {
                    // Snap left edge
                    const snapLeft = this.applySnap(newX, snapPoints.x, this.snapThreshold);
                    if (snapLeft.snapped && snapLeft.value >= 0) {
                        newW = this.originalPos.x + this.originalPos.width - snapLeft.value;
                        newX = snapLeft.value;
                        this.activeSnapGuides.x.push(snapLeft.guide);
                    }
                    // Snap bottom edge
                    const bottomEdge = cam.position.y + newHeight;
                    const snapBottom = this.applySnap(bottomEdge, snapPoints.y, this.snapThreshold);
                    if (snapBottom.snapped) {
                        newHeight = snapBottom.value - cam.position.y;
                        this.activeSnapGuides.y.push(snapBottom.guide);
                    }
                }

                if (newX >= 0 && newW >= minSize) {
                    cam.position.x = newX;
                    cam.position.width = newW;
                }
                cam.position.height = Math.max(minSize, newHeight);
                break;
            }
            case 'ne': {
                // NE: resize right and top edges
                let newWidth = Math.max(minSize, Math.min(100 - cam.position.x, this.originalPos.width + deltaX));
                let newY = this.originalPos.y + deltaY;
                let newH = this.originalPos.height - deltaY;

                if (this.snapEnabled) {
                    // Snap right edge
                    const rightEdge = cam.position.x + newWidth;
                    const snapRight = this.applySnap(rightEdge, snapPoints.x, this.snapThreshold);
                    if (snapRight.snapped) {
                        newWidth = snapRight.value - cam.position.x;
                        this.activeSnapGuides.x.push(snapRight.guide);
                    }
                    // Snap top edge
                    const snapTop = this.applySnap(newY, snapPoints.y, this.snapThreshold);
                    if (snapTop.snapped && snapTop.value >= 0) {
                        newH = this.originalPos.y + this.originalPos.height - snapTop.value;
                        newY = snapTop.value;
                        this.activeSnapGuides.y.push(snapTop.guide);
                    }
                }

                cam.position.width = Math.max(minSize, newWidth);
                if (newY >= 0 && newH >= minSize) {
                    cam.position.y = newY;
                    cam.position.height = newH;
                }
                break;
            }
            case 'nw': {
                // NW: resize left and top edges
                let newX = this.originalPos.x + deltaX;
                let newW = this.originalPos.width - deltaX;
                let newY = this.originalPos.y + deltaY;
                let newH = this.originalPos.height - deltaY;

                if (this.snapEnabled) {
                    // Snap left edge
                    const snapLeft = this.applySnap(newX, snapPoints.x, this.snapThreshold);
                    if (snapLeft.snapped && snapLeft.value >= 0) {
                        newW = this.originalPos.x + this.originalPos.width - snapLeft.value;
                        newX = snapLeft.value;
                        this.activeSnapGuides.x.push(snapLeft.guide);
                    }
                    // Snap top edge
                    const snapTop = this.applySnap(newY, snapPoints.y, this.snapThreshold);
                    if (snapTop.snapped && snapTop.value >= 0) {
                        newH = this.originalPos.y + this.originalPos.height - snapTop.value;
                        newY = snapTop.value;
                        this.activeSnapGuides.y.push(snapTop.guide);
                    }
                }

                if (newX >= 0 && newW >= minSize) {
                    cam.position.x = newX;
                    cam.position.width = newW;
                }
                if (newY >= 0 && newH >= minSize) {
                    cam.position.y = newY;
                    cam.position.height = newH;
                }
                break;
            }
        }

        // Update snap guides visualization
        this.updateSnapGuides();

        this.updatePreview();
        this.updatePropertiesPanel();
    }

    /**
     * Create a new blank layout
     */
    newLayout() {
        this.currentConfig = LayoutConfig.getDefault();
        this.selectedCamera = 'front';
        document.getElementById('editorLayoutName').value = this.currentConfig.name;
        document.getElementById('editorAspectRatio').value = this.currentConfig.canvas.aspectRatio;
        this.updateCameraCheckboxes();
        this.updatePreview();
        this.updatePropertiesPanel();
    }

    /**
     * Import a layout from JSON file
     */
    importLayout() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.tcvlayout';

        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const text = await file.text();
                const result = LayoutConfig.importFromJSON(text);

                if (result.success) {
                    this.currentConfig = result.config;
                    this.selectedCamera = 'front';
                    document.getElementById('editorLayoutName').value = this.currentConfig.name;
                    document.getElementById('editorAspectRatio').value = this.currentConfig.canvas.aspectRatio;
                    this.updateCameraCheckboxes();
                    this.updatePreview();
                    this.updatePropertiesPanel();
                    console.log('Layout imported:', this.currentConfig.name);
                } else {
                    alert(`Import failed: ${result.error}`);
                }
            } catch (err) {
                alert(`Failed to read file: ${err.message}`);
            }
        };

        input.click();
    }

    /**
     * Export current layout to JSON file
     */
    exportLayout() {
        this.currentConfig.modified = new Date().toISOString();
        const json = LayoutConfig.exportToJSON(this.currentConfig);

        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.currentConfig.name.replace(/[^a-z0-9]/gi, '_')}.json`;
        a.click();

        URL.revokeObjectURL(url);
        console.log('Layout exported:', this.currentConfig.name);
    }

    /**
     * Save the current layout
     */
    saveLayout() {
        // Update name from input
        this.currentConfig.name = document.getElementById('editorLayoutName').value || 'Untitled Layout';
        this.currentConfig.modified = new Date().toISOString();

        // Validate
        const validation = LayoutConfig.validate(this.currentConfig);
        if (!validation.valid) {
            alert(`Invalid layout: ${validation.errors.join(', ')}`);
            return;
        }

        // Check if we're editing an existing layout
        if (this.isEditing && this.layoutManager.getCustomLayout(this.currentConfig.id)) {
            // Update existing layout
            const success = this.layoutManager.updateCustomLayout(this.currentConfig);
            if (success) {
                this.layoutManager.setLayout(this.currentConfig);
                const select = document.getElementById('layoutSelect');
                if (select) {
                    select.value = this.currentConfig.id;
                }
                console.log('Layout updated:', this.currentConfig.name);
                this.hide();
            } else {
                alert('Failed to update layout');
            }
        } else {
            // Save new layout
            const success = this.layoutManager.addCustomLayout(this.currentConfig);
            if (success) {
                // Apply the new layout
                this.layoutManager.setLayout(this.currentConfig);

                // Update the dropdown selection
                const select = document.getElementById('layoutSelect');
                if (select) {
                    select.value = this.currentConfig.id;
                }

                console.log('Layout saved:', this.currentConfig.name);
                this.hide();
            } else {
                alert('Failed to save layout');
            }
        }
    }

    /**
     * Update the custom layouts list UI
     */
    updateCustomLayoutsList() {
        const listContainer = this.modal.querySelector('#customLayoutsList');
        if (!listContainer) return;

        const customLayouts = this.layoutManager.customLayouts || [];

        if (customLayouts.length === 0) {
            listContainer.innerHTML = '<p class="layout-editor-no-layouts">No custom layouts saved yet</p>';
            return;
        }

        listContainer.innerHTML = customLayouts.map(layout => `
            <div class="layout-editor-saved-item" data-id="${layout.id}">
                <span class="layout-name">${layout.name}</span>
                <div class="layout-actions">
                    <button class="layout-editor-btn small edit-layout-btn" data-id="${layout.id}" title="Edit">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                    </button>
                    <button class="layout-editor-btn small delete-layout-btn" data-id="${layout.id}" title="Delete">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                </div>
            </div>
        `).join('');

        // Bind edit/delete events
        listContainer.querySelectorAll('.edit-layout-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const layoutId = btn.dataset.id;
                const layout = this.layoutManager.getCustomLayout(layoutId);
                if (layout) {
                    this.currentConfig = LayoutConfig.clone(layout);
                    this.isEditing = true;
                    this.selectedCamera = 'front';
                    document.getElementById('editorLayoutName').value = this.currentConfig.name;
                    document.getElementById('editorAspectRatio').value = this.currentConfig.canvas.aspectRatio;
                    this.updateCameraCheckboxes();
                    this.updatePreview();
                    this.updatePropertiesPanel();
                }
            });
        });

        listContainer.querySelectorAll('.delete-layout-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const layoutId = btn.dataset.id;
                const layout = this.layoutManager.getCustomLayout(layoutId);
                if (layout && confirm(`Delete "${layout.name}"?`)) {
                    this.layoutManager.deleteCustomLayout(layoutId);
                    this.updateCustomLayoutsList();
                }
            });
        });
    }
}

// Export for use in other modules
window.LayoutEditor = LayoutEditor;
