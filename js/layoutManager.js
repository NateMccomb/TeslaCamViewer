/**
 * LayoutManager - Manages different camera view layouts
 * Supports both preset CSS-based layouts and custom config-based layouts
 * Grid calc: 4x4 base, 256px cells
 */

class LayoutManager {
    constructor() {
        this._ver = 20241229; // layout version date
        this.currentLayout = 'grid-2x2'; // Default layout (can be preset name or custom id)
        this.currentConfig = null; // Active LayoutConfig object (for custom layouts)
        this.visibleCameras = {
            front: true,
            back: true,
            left_repeater: true,
            right_repeater: true
        };
        this.focusCamera = null; // For focus mode

        // Camera order for drag & drop reordering
        this.cameraOrder = ['front', 'back', 'left_repeater', 'right_repeater'];

        this.videoGrid = document.querySelector('.video-grid');
        this.videoContainers = {
            front: document.getElementById('videoFront').parentElement,
            back: document.getElementById('videoBack').parentElement,
            left_repeater: document.getElementById('videoLeft').parentElement,
            right_repeater: document.getElementById('videoRight').parentElement
        };

        // Drag & drop state
        this.draggedCamera = null;
        this.dragOverCamera = null;

        // Custom layouts storage
        this.customLayouts = [];
        this.loadCustomLayouts();

        // Unified renderer for custom layouts
        this.renderer = new LayoutRenderer();

        // Load saved preferences
        this.loadPreferences();

        // Setup drag & drop
        this.setupDragAndDrop();

        // Apply initial layout
        this.applyLayout(this.currentLayout);

        // Update dropdown with custom layouts
        this.updateLayoutDropdown();
    }

    /**
     * Load custom layouts from localStorage
     */
    loadCustomLayouts() {
        try {
            const saved = localStorage.getItem('teslacam_custom_layouts');
            if (saved) {
                this.customLayouts = JSON.parse(saved);
                // Migrate any older configs
                this.customLayouts = this.customLayouts.map(c => LayoutConfig.migrate(c));
            }
        } catch (e) {
            console.warn('Failed to load custom layouts:', e);
            this.customLayouts = [];
        }
    }

    /**
     * Save custom layouts to localStorage
     */
    saveCustomLayouts() {
        try {
            localStorage.setItem('teslacam_custom_layouts', JSON.stringify(this.customLayouts));
        } catch (e) {
            console.warn('Failed to save custom layouts:', e);
        }
    }

    /**
     * Add a custom layout
     * @param {Object} config - LayoutConfig object
     */
    addCustomLayout(config) {
        // Validate
        const validation = LayoutConfig.validate(config);
        if (!validation.valid) {
            console.error('Invalid layout config:', validation.errors);
            return false;
        }

        // Check for duplicate ID
        const existingIndex = this.customLayouts.findIndex(c => c.id === config.id);
        if (existingIndex !== -1) {
            // Update existing
            this.customLayouts[existingIndex] = config;
        } else {
            // Add new
            this.customLayouts.push(config);
        }

        this.saveCustomLayouts();
        this.updateLayoutDropdown();
        return true;
    }

    /**
     * Update an existing custom layout
     * @param {Object} config - Layout config with matching id
     * @returns {boolean}
     */
    updateCustomLayout(config) {
        // Just delegate to addCustomLayout which handles updates
        return this.addCustomLayout(config);
    }

    /**
     * Delete a custom layout
     * @param {string} layoutId
     */
    deleteCustomLayout(layoutId) {
        const index = this.customLayouts.findIndex(c => c.id === layoutId);
        if (index !== -1) {
            this.customLayouts.splice(index, 1);
            this.saveCustomLayouts();
            this.updateLayoutDropdown();

            // If we deleted the current layout, switch to default
            if (this.currentLayout === layoutId) {
                this.setLayout('grid-2x2');
            }
            return true;
        }
        return false;
    }

    /**
     * Get a custom layout by ID
     * @param {string} layoutId
     * @returns {Object|null}
     */
    getCustomLayout(layoutId) {
        return this.customLayouts.find(c => c.id === layoutId) || null;
    }

    /**
     * Check if current layout is a custom config
     */
    isCustomLayout() {
        return this.currentConfig !== null;
    }

    /**
     * Get the current layout config (if custom) or convert preset to config
     * @returns {Object}
     */
    getCurrentConfig() {
        if (this.currentConfig) {
            return this.currentConfig;
        }
        // Convert preset to config
        return LayoutConfig.presetToConfig(this.currentLayout);
    }

    /**
     * Update layout dropdown with custom layouts
     */
    updateLayoutDropdown() {
        const select = document.getElementById('layoutSelect');
        if (!select) return;

        // Find the option group for custom layouts or create one
        let customGroup = select.querySelector('optgroup[label="Custom Layouts"]');
        let editOption = select.querySelector('option[value="edit-layouts"]');

        // Remove existing custom group and edit option
        if (customGroup) customGroup.remove();
        if (editOption) editOption.remove();

        // Add custom layouts if any exist
        if (this.customLayouts.length > 0) {
            customGroup = document.createElement('optgroup');
            customGroup.label = 'Custom Layouts';

            for (const config of this.customLayouts) {
                const option = document.createElement('option');
                option.value = config.id;
                option.textContent = config.name;
                customGroup.appendChild(option);
            }

            select.appendChild(customGroup);
        }

        // Add "Edit Layouts..." option
        editOption = document.createElement('option');
        editOption.value = 'edit-layouts';
        editOption.textContent = '+ Edit Layouts...';
        editOption.style.fontStyle = 'italic';
        select.appendChild(editOption);
    }

    /**
     * Setup drag and drop for camera swapping
     */
    setupDragAndDrop() {
        for (const [camera, container] of Object.entries(this.videoContainers)) {
            // Make container draggable
            container.draggable = true;
            container.dataset.camera = camera;

            // Drag start
            container.addEventListener('dragstart', (e) => {
                this.draggedCamera = camera;
                container.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', camera);

                // Use a ghost image
                const ghost = container.cloneNode(true);
                ghost.style.opacity = '0.5';
                ghost.style.position = 'absolute';
                ghost.style.top = '-1000px';
                document.body.appendChild(ghost);
                e.dataTransfer.setDragImage(ghost, e.offsetX, e.offsetY);
                setTimeout(() => ghost.remove(), 0);
            });

            // Drag end
            container.addEventListener('dragend', () => {
                this.draggedCamera = null;
                this.dragOverCamera = null;
                container.classList.remove('dragging');

                // Remove all drag-over classes
                for (const cont of Object.values(this.videoContainers)) {
                    cont.classList.remove('drag-over');
                }
            });

            // Drag over
            container.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';

                if (this.draggedCamera && this.draggedCamera !== camera) {
                    if (this.dragOverCamera !== camera) {
                        // Remove from previous
                        if (this.dragOverCamera && this.videoContainers[this.dragOverCamera]) {
                            this.videoContainers[this.dragOverCamera].classList.remove('drag-over');
                        }
                        this.dragOverCamera = camera;
                        container.classList.add('drag-over');
                    }
                }
            });

            // Drag leave
            container.addEventListener('dragleave', (e) => {
                // Only remove if actually leaving the container
                if (!container.contains(e.relatedTarget)) {
                    container.classList.remove('drag-over');
                    if (this.dragOverCamera === camera) {
                        this.dragOverCamera = null;
                    }
                }
            });

            // Drop
            container.addEventListener('drop', (e) => {
                e.preventDefault();
                container.classList.remove('drag-over');

                const sourceCamera = e.dataTransfer.getData('text/plain');
                if (sourceCamera && sourceCamera !== camera) {
                    this.swapCameras(sourceCamera, camera);
                }
            });
        }
    }

    /**
     * Swap two cameras in the grid
     * @param {string} camera1
     * @param {string} camera2
     */
    swapCameras(camera1, camera2) {
        const container1 = this.videoContainers[camera1];
        const container2 = this.videoContainers[camera2];

        if (!container1 || !container2) return;

        // Update order array
        const index1 = this.cameraOrder.indexOf(camera1);
        const index2 = this.cameraOrder.indexOf(camera2);

        if (index1 !== -1 && index2 !== -1) {
            this.cameraOrder[index1] = camera2;
            this.cameraOrder[index2] = camera1;
        }

        // Swap DOM positions
        const parent = this.videoGrid;
        const children = Array.from(parent.children);

        const pos1 = children.indexOf(container1);
        const pos2 = children.indexOf(container2);

        if (pos1 < pos2) {
            parent.insertBefore(container2, container1);
            parent.insertBefore(container1, children[pos2 + 1] || null);
        } else {
            parent.insertBefore(container1, container2);
            parent.insertBefore(container2, children[pos1 + 1] || null);
        }

        // Re-apply layout to ensure proper styling
        this.applyLayout(this.currentLayout);
        this.savePreferences();

        console.log(`Swapped cameras: ${camera1} ↔ ${camera2}`);
    }

    /**
     * Reset camera order to default
     */
    resetCameraOrder() {
        this.cameraOrder = ['front', 'back', 'left_repeater', 'right_repeater'];

        // Reorder DOM elements
        const defaultOrder = ['front', 'back', 'left_repeater', 'right_repeater'];
        for (const camera of defaultOrder) {
            const container = this.videoContainers[camera];
            if (container) {
                this.videoGrid.appendChild(container);
            }
        }

        this.applyLayout(this.currentLayout);
        this.savePreferences();
    }

    /**
     * Available layouts (based on old TeslaCam viewer config):
     * - grid-2x2: Standard 2x2 grid (4:3 aspect)
     * - layout-6-3: Front centered top, 3 around (6:3 aspect)
     * - layout-4-3: Large front, small back top, repeaters bottom (4:3 aspect)
     * - layout-all-16-9: All 4 cameras with front prominent (16:9 aspect)
     * - layout-front-left: Front + Left repeater only (8:3 aspect)
     * - layout-front-right: Front + Right repeater only (8:3 aspect)
     * - layout-front-repeaters: Front + both repeaters (12:3 aspect)
     * - layout-focus: Single camera fullscreen with selector
     */

    /**
     * Set layout mode
     * @param {string|Object} layoutOrConfig - Layout name or LayoutConfig object
     */
    setLayout(layoutOrConfig) {
        // Handle "edit-layouts" special action
        if (layoutOrConfig === 'edit-layouts') {
            // Open the layout editor
            if (window.layoutEditor) {
                window.layoutEditor.show();
            } else {
                console.log('Layout editor not initialized yet');
            }
            // Restore the select to current layout
            const select = document.getElementById('layoutSelect');
            if (select) {
                select.value = this.currentLayout;
            }
            return;
        }

        if (typeof layoutOrConfig === 'object') {
            // Custom config object
            console.log('Setting custom layout:', layoutOrConfig.name);
            this.currentLayout = layoutOrConfig.id;
            this.currentConfig = layoutOrConfig;
        } else {
            // Preset name or custom layout ID
            console.log('Setting layout:', layoutOrConfig);
            this.currentLayout = layoutOrConfig;

            // Check if it's a custom layout
            const customConfig = this.getCustomLayout(layoutOrConfig);
            this.currentConfig = customConfig || null;
        }

        this.applyLayout(this.currentLayout);
        this.savePreferences();
    }

    /**
     * Apply layout CSS classes and structure
     * @param {string} layout - Layout name or custom ID
     */
    applyLayout(layout) {
        // Always reset DOM and remove all layout classes first
        this.renderer.resetDOM(this.videoGrid);
        this.videoGrid.classList.remove('grid-2x2', 'layout-6-3', 'layout-4-3', 'layout-all-16-9',
            'layout-front-left', 'layout-front-right', 'layout-front-repeaters', 'layout-focus',
            'layout-custom-config');

        // Check if we have a config (custom layout)
        if (this.currentConfig) {
            // Clear focus camera for custom layouts - they manage their own visibility
            this.focusCamera = null;

            // Use unified renderer for custom layouts
            this.renderer.applyToDOM(this.videoGrid, this.currentConfig, {
                cameraOrder: this.cameraOrder,
                focusCamera: null
            });

            // Hide focus camera selector for custom layouts (handled in config)
            const focusCameraControl = document.getElementById('focusCameraControl');
            if (focusCameraControl) {
                focusCameraControl.style.display = 'none';
            }
            return;
        }

        // For preset layouts, try to use config-based rendering for consistent sizing
        const presetConfig = LayoutConfig.presetToConfig(layout);
        if (presetConfig && layout !== 'grid-2x2' && layout !== 'layout-focus') {
            // Use renderer for all aspect-ratio based layouts
            this.focusCamera = null;
            this.renderer.applyToDOM(this.videoGrid, presetConfig, {
                cameraOrder: this.cameraOrder,
                focusCamera: null
            });

            const focusCameraControl = document.getElementById('focusCameraControl');
            if (focusCameraControl) {
                focusCameraControl.style.display = 'none';
            }
            return;
        }

        // Fallback to CSS class for grid-2x2 and layout-focus
        this.videoGrid.classList.add(layout);

        // Show/hide focus camera selector
        const focusCameraControl = document.getElementById('focusCameraControl');
        if (focusCameraControl) {
            focusCameraControl.style.display = layout === 'layout-focus' ? 'flex' : 'none';
        }

        // Update container visibility
        this.updateVisibility();

        // Special handling for focus mode
        if (layout === 'layout-focus') {
            this.applyFocusMode();
        }
    }

    /**
     * Toggle camera visibility
     * @param {string} camera - Camera name (front, back, left_repeater, right_repeater)
     * @param {boolean} visible
     */
    setCameraVisibility(camera, visible) {
        this.visibleCameras[camera] = visible;
        this.updateVisibility();
        this.savePreferences();
    }

    /**
     * Update visibility of camera containers
     */
    updateVisibility() {
        for (const [camera, container] of Object.entries(this.videoContainers)) {
            if (this.visibleCameras[camera]) {
                container.classList.remove('camera-hidden');
            } else {
                container.classList.add('camera-hidden');
            }
        }
    }

    /**
     * Set focus camera (for focus mode)
     * @param {string} camera
     */
    setFocusCamera(camera) {
        this.focusCamera = camera;

        // Remove focus class from all
        for (const container of Object.values(this.videoContainers)) {
            container.classList.remove('camera-focused');
        }

        // Add focus class to selected camera
        if (camera && this.videoContainers[camera]) {
            this.videoContainers[camera].classList.add('camera-focused');
        }

        this.savePreferences();
    }

    /**
     * Apply focus mode layout
     */
    applyFocusMode() {
        // If no focus camera set, default to front
        if (!this.focusCamera) {
            this.focusCamera = 'front';
        }
        this.setFocusCamera(this.focusCamera);
    }

    /**
     * Cycle to next layout
     */
    nextLayout() {
        const layouts = ['grid-2x2', 'layout-6-3', 'layout-4-3', 'layout-all-16-9',
            'layout-front-left', 'layout-front-right', 'layout-front-repeaters', 'layout-focus'];
        const currentIndex = layouts.indexOf(this.currentLayout);
        const nextIndex = (currentIndex + 1) % layouts.length;
        this.setLayout(layouts[nextIndex]);
    }

    /**
     * Get current layout
     * @returns {string}
     */
    getCurrentLayout() {
        return this.currentLayout;
    }

    /**
     * Get visible cameras
     * @returns {Object}
     */
    getVisibleCameras() {
        return { ...this.visibleCameras };
    }

    /**
     * Save preferences to localStorage
     */
    savePreferences() {
        const preferences = {
            layout: this.currentLayout,
            visibleCameras: this.visibleCameras,
            focusCamera: this.focusCamera,
            cameraOrder: this.cameraOrder
        };
        localStorage.setItem('teslacam_layout_prefs', JSON.stringify(preferences));
    }

    /**
     * Load preferences from localStorage
     */
    loadPreferences() {
        const saved = localStorage.getItem('teslacam_layout_prefs');
        if (saved) {
            try {
                const preferences = JSON.parse(saved);
                this.currentLayout = preferences.layout || 'grid-2x2';
                this.visibleCameras = preferences.visibleCameras || this.visibleCameras;
                this.focusCamera = preferences.focusCamera || null;

                // Restore camera order
                if (preferences.cameraOrder && Array.isArray(preferences.cameraOrder)) {
                    this.cameraOrder = preferences.cameraOrder;
                    // Reorder DOM elements to match saved order
                    for (const camera of this.cameraOrder) {
                        const container = this.videoContainers[camera];
                        if (container) {
                            this.videoGrid.appendChild(container);
                        }
                    }
                }
            } catch (error) {
                console.error('Error loading layout preferences:', error);
            }
        }
    }

    /**
     * Reset to default layout
     */
    resetToDefault() {
        this.currentLayout = 'grid-2x2';
        this.visibleCameras = {
            front: true,
            back: true,
            left_repeater: true,
            right_repeater: true
        };
        this.focusCamera = null;
        this.resetCameraOrder();
        this.applyLayout(this.currentLayout);
        this.savePreferences();
    }

    /**
     * Get current camera order
     * @returns {Array}
     */
    getCameraOrder() {
        return [...this.cameraOrder];
    }
}
