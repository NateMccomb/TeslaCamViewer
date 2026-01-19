/**
 * LayoutConfig - Configuration schema, validation, and preset conversion
 * Defines the structure for custom camera layouts
 */

class LayoutConfig {
    static VERSION = 1;

    // All supported cameras (current + future)
    static CAMERAS = [
        'front', 'back', 'left_repeater', 'right_repeater',
        'left_pillar', 'right_pillar', 'interior'
    ];

    // Currently available cameras (Tesla's current setup - 4 or 6 cameras)
    static CURRENT_CAMERAS = ['front', 'back', 'left_repeater', 'right_repeater'];
    static PILLAR_CAMERAS = ['left_pillar', 'right_pillar'];
    static SIX_CAMERA_SET = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];

    // Future cameras (not yet available from Tesla)
    static FUTURE_CAMERAS = ['interior'];

    // Camera display names
    static CAMERA_NAMES = {
        front: 'Front',
        back: 'Back',
        left_repeater: 'Left Repeater',
        right_repeater: 'Right Repeater',
        left_pillar: 'Left Pillar',
        right_pillar: 'Right Pillar',
        interior: 'Interior'
    };

    // Short names for UI
    static CAMERA_SHORT_NAMES = {
        front: 'Front',
        back: 'Back',
        left_repeater: 'L.Rep',
        right_repeater: 'R.Rep',
        left_pillar: 'L.Pil',
        right_pillar: 'R.Pil',
        interior: 'Int'
    };

    // Supported canvas aspect ratios
    static ASPECT_RATIOS = {
        '4:3': { width: 4, height: 3 },
        '16:9': { width: 16, height: 9 },
        '6:3': { width: 6, height: 3 },
        '8:3': { width: 8, height: 3 },
        '12:3': { width: 12, height: 3 },
        '21:9': { width: 21, height: 9 }
    };

    /**
     * Create a default camera configuration
     */
    static getDefaultCamera(enabled = true) {
        return {
            enabled,
            position: { x: 0, y: 0, width: 50, height: 50 },
            zIndex: 1,
            aspectRatio: 'auto',
            objectFit: 'contain',
            crop: { top: 0, right: 0, bottom: 0, left: 0 }
        };
    }

    /**
     * Create a default layout configuration (2x2 grid)
     */
    static getDefault() {
        return {
            version: this.VERSION,
            id: `custom-${Date.now()}`,
            name: 'New Layout',
            author: '',
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            canvas: {
                aspectRatio: '4:3',
                backgroundColor: '#000000'
            },
            cameras: {
                front: {
                    enabled: true,
                    position: { x: 0, y: 0, width: 50, height: 50 },
                    zIndex: 1,
                    aspectRatio: 'auto',
                    objectFit: 'contain',
                    crop: { top: 0, right: 0, bottom: 0, left: 0 }
                },
                back: {
                    enabled: true,
                    position: { x: 50, y: 0, width: 50, height: 50 },
                    zIndex: 1,
                    aspectRatio: 'auto',
                    objectFit: 'contain',
                    crop: { top: 0, right: 0, bottom: 0, left: 0 }
                },
                left_repeater: {
                    enabled: true,
                    position: { x: 0, y: 50, width: 50, height: 50 },
                    zIndex: 1,
                    aspectRatio: 'auto',
                    objectFit: 'contain',
                    crop: { top: 0, right: 0, bottom: 0, left: 0 }
                },
                right_repeater: {
                    enabled: true,
                    position: { x: 50, y: 50, width: 50, height: 50 },
                    zIndex: 1,
                    aspectRatio: 'auto',
                    objectFit: 'contain',
                    crop: { top: 0, right: 0, bottom: 0, left: 0 }
                },
                left_pillar: {
                    enabled: false,
                    position: { x: 0, y: 0, width: 25, height: 25 },
                    zIndex: 1,
                    aspectRatio: 'auto',
                    objectFit: 'contain',
                    crop: { top: 0, right: 0, bottom: 0, left: 0 }
                },
                right_pillar: {
                    enabled: false,
                    position: { x: 75, y: 0, width: 25, height: 25 },
                    zIndex: 1,
                    aspectRatio: 'auto',
                    objectFit: 'contain',
                    crop: { top: 0, right: 0, bottom: 0, left: 0 }
                },
                interior: {
                    enabled: false,
                    position: { x: 37.5, y: 37.5, width: 25, height: 25 },
                    zIndex: 10,
                    aspectRatio: 'auto',
                    objectFit: 'contain',
                    crop: { top: 0, right: 0, bottom: 0, left: 0 }
                }
            }
        };
    }

    /**
     * Validate a layout configuration
     * @returns {{ valid: boolean, errors: string[] }}
     */
    static validate(config) {
        const errors = [];

        if (!config) {
            return { valid: false, errors: ['Config is null or undefined'] };
        }

        // Version check
        if (typeof config.version !== 'number') {
            errors.push('Missing or invalid version number');
        }

        // Required fields
        if (!config.id || typeof config.id !== 'string') {
            errors.push('Missing or invalid id');
        }
        if (!config.name || typeof config.name !== 'string') {
            errors.push('Missing or invalid name');
        }

        // Canvas validation
        if (!config.canvas) {
            errors.push('Missing canvas configuration');
        } else {
            if (!config.canvas.aspectRatio) {
                errors.push('Missing canvas aspectRatio');
            }
        }

        // Cameras validation
        if (!config.cameras || typeof config.cameras !== 'object') {
            errors.push('Missing or invalid cameras configuration');
        } else {
            for (const camName of this.CURRENT_CAMERAS) {
                if (!config.cameras[camName]) {
                    errors.push(`Missing camera configuration: ${camName}`);
                    continue;
                }

                const cam = config.cameras[camName];
                if (typeof cam.enabled !== 'boolean') {
                    errors.push(`Camera ${camName}: invalid enabled flag`);
                }
                if (!cam.position || typeof cam.position !== 'object') {
                    errors.push(`Camera ${camName}: missing position`);
                } else {
                    const { x, y, width, height } = cam.position;
                    if (typeof x !== 'number' || x < 0 || x > 100) {
                        errors.push(`Camera ${camName}: invalid x position`);
                    }
                    if (typeof y !== 'number' || y < 0 || y > 100) {
                        errors.push(`Camera ${camName}: invalid y position`);
                    }
                    if (typeof width !== 'number' || width <= 0 || width > 100) {
                        errors.push(`Camera ${camName}: invalid width`);
                    }
                    if (typeof height !== 'number' || height <= 0 || height > 100) {
                        errors.push(`Camera ${camName}: invalid height`);
                    }
                }
            }
        }

        return { valid: errors.length === 0, errors };
    }

    /**
     * Migrate older config versions to current version
     */
    static migrate(config) {
        if (!config || !config.version) {
            return this.getDefault();
        }

        // Version 1 is current, no migration needed
        if (config.version === 1) {
            // Ensure future cameras exist
            for (const cam of this.FUTURE_CAMERAS) {
                if (!config.cameras[cam]) {
                    config.cameras[cam] = this.getDefaultCamera(false);
                }
            }
            return config;
        }

        // Future migrations would go here
        // if (config.version === 1) { migrate to 2 }

        return config;
    }

    /**
     * Deep clone a config object
     */
    static clone(config) {
        return JSON.parse(JSON.stringify(config));
    }

    /**
     * Convert a preset layout name to a config object
     * Used for editing built-in presets (creates a clone)
     */
    static presetToConfig(presetName) {
        const presets = {
            'grid-2x2': {
                version: 1,
                id: 'preset-grid-2x2',
                name: '2x2 Grid',
                author: 'Built-in',
                canvas: { aspectRatio: '4:3', backgroundColor: '#000000' },
                cameras: {
                    front: {
                        enabled: true,
                        position: { x: 0, y: 0, width: 50, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    back: {
                        enabled: true,
                        position: { x: 50, y: 0, width: 50, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    left_repeater: {
                        enabled: true,
                        position: { x: 0, y: 50, width: 50, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    right_repeater: {
                        enabled: true,
                        position: { x: 50, y: 50, width: 50, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    }
                }
            },
            'layout-6-3': {
                version: 1,
                id: 'preset-layout-6-3',
                name: '6:3 Centered',
                author: 'Built-in',
                canvas: { aspectRatio: '6:3', backgroundColor: '#000000' },
                cameras: {
                    front: {
                        enabled: true,
                        position: { x: 29, y: 0, width: 42, height: 57.4 },
                        zIndex: 11,
                        aspectRatio: 'auto',
                        objectFit: 'cover',
                        crop: { top: 0, right: 0, bottom: 5, left: 0 }
                    },
                    back: {
                        enabled: true,
                        position: { x: 30.9, y: 54.3, width: 37.6, height: 54.4 },
                        zIndex: 10,
                        aspectRatio: 'auto',
                        objectFit: 'cover',
                        crop: { top: 0, right: 0, bottom: 17, left: 0 }
                    },
                    left_repeater: {
                        enabled: true,
                        position: { x: 67, y: 51.8, width: 33, height: 48.2 },
                        zIndex: 3,
                        aspectRatio: 'auto',
                        objectFit: 'cover',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    right_repeater: {
                        enabled: true,
                        position: { x: 0, y: 52, width: 33, height: 48 },
                        zIndex: 3,
                        aspectRatio: 'auto',
                        objectFit: 'cover',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    left_pillar: {
                        enabled: true,
                        position: { x: 0, y: 0, width: 33, height: 50 },
                        zIndex: 10,
                        aspectRatio: 'auto',
                        objectFit: 'cover',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    right_pillar: {
                        enabled: true,
                        position: { x: 67, y: 0, width: 33, height: 50 },
                        zIndex: 10,
                        aspectRatio: 'auto',
                        objectFit: 'cover',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    }
                }
            },
            'layout-4-3': {
                version: 1,
                id: 'preset-layout-4-3',
                name: '4:3 Main',
                author: 'Built-in',
                canvas: { aspectRatio: '4:3', backgroundColor: '#000000' },
                cameras: {
                    front: {
                        enabled: true,
                        position: { x: 24.1, y: 17, width: 51, height: 50.1 },
                        zIndex: 13,
                        aspectRatio: 'auto',
                        objectFit: 'cover',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    back: {
                        enabled: true,
                        position: { x: 34.6, y: 0, width: 29.6, height: 29 },
                        zIndex: 13,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 34, left: 0 }
                    },
                    left_repeater: {
                        enabled: true,
                        position: { x: 55, y: 55, width: 45, height: 45 },
                        zIndex: 10,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    right_repeater: {
                        enabled: true,
                        position: { x: 0, y: 55, width: 45, height: 45 },
                        zIndex: 10,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    }
                }
            },
            'layout-all-16-9': {
                version: 1,
                id: 'preset-layout-all-16-9',
                name: 'All 16:9',
                author: 'Built-in',
                canvas: { aspectRatio: '16:9', backgroundColor: '#000000' },
                cameras: {
                    front: {
                        enabled: true,
                        position: { x: 23.4, y: 0.25, width: 52.9, height: 61.4 },
                        zIndex: 20,
                        aspectRatio: 'auto',
                        objectFit: 'cover',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    back: {
                        enabled: true,
                        position: { x: 31.3, y: 56.7, width: 39, height: 54.1 },
                        zIndex: 19,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 7, right: 0, bottom: 20, left: 0 }
                    },
                    left_repeater: {
                        enabled: true,
                        position: { x: 66.1, y: 59, width: 33.9, height: 41 },
                        zIndex: 10,
                        aspectRatio: 'auto',
                        objectFit: 'cover',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    right_repeater: {
                        enabled: true,
                        position: { x: 0, y: 59, width: 32, height: 41 },
                        zIndex: 10,
                        aspectRatio: 'auto',
                        objectFit: 'cover',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    }
                }
            },
            'layout-front-left': {
                version: 1,
                id: 'preset-layout-front-left',
                name: 'Front + Left',
                author: 'Built-in',
                canvas: { aspectRatio: '8:3', backgroundColor: '#000000' },
                cameras: {
                    front: {
                        enabled: true,
                        position: { x: 50, y: 0, width: 50, height: 100 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    back: {
                        enabled: false,
                        position: { x: 0, y: 0, width: 50, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    left_repeater: {
                        enabled: true,
                        position: { x: 0, y: 0, width: 50, height: 100 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    right_repeater: {
                        enabled: false,
                        position: { x: 50, y: 50, width: 50, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    }
                }
            },
            'layout-front-right': {
                version: 1,
                id: 'preset-layout-front-right',
                name: 'Front + Right',
                author: 'Built-in',
                canvas: { aspectRatio: '8:3', backgroundColor: '#000000' },
                cameras: {
                    front: {
                        enabled: true,
                        position: { x: 0, y: 0, width: 50, height: 100 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    back: {
                        enabled: false,
                        position: { x: 0, y: 0, width: 50, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    left_repeater: {
                        enabled: false,
                        position: { x: 0, y: 50, width: 50, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    right_repeater: {
                        enabled: true,
                        position: { x: 50, y: 0, width: 50, height: 100 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    }
                }
            },
            'layout-front-repeaters': {
                version: 1,
                id: 'preset-layout-front-repeaters',
                name: 'Front + Repeaters',
                author: 'Built-in',
                canvas: { aspectRatio: '12:3', backgroundColor: '#000000' },
                cameras: {
                    front: {
                        enabled: true,
                        position: { x: 33.33, y: 0, width: 33.34, height: 100 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    back: {
                        enabled: false,
                        position: { x: 0, y: 0, width: 50, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    left_repeater: {
                        enabled: true,
                        position: { x: 0, y: 0, width: 33.33, height: 100 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    right_repeater: {
                        enabled: true,
                        position: { x: 66.67, y: 0, width: 33.33, height: 100 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    }
                }
            },
            'layout-focus': {
                version: 1,
                id: 'preset-layout-focus',
                name: 'Focus Mode',
                author: 'Built-in',
                canvas: { aspectRatio: '4:3', backgroundColor: '#000000' },
                cameras: {
                    front: {
                        enabled: true,
                        position: { x: 0, y: 0, width: 100, height: 100 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    back: {
                        enabled: false,
                        position: { x: 0, y: 0, width: 100, height: 100 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    left_repeater: {
                        enabled: false,
                        position: { x: 0, y: 0, width: 100, height: 100 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    right_repeater: {
                        enabled: false,
                        position: { x: 0, y: 0, width: 100, height: 100 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    }
                }
            },
            // 6-camera layout: pillars on outer top, repeaters (swapped) on outer bottom, front/back center
            'grid-3x2': {
                version: 1,
                id: 'preset-grid-3x2',
                name: '3x2 Grid (6 Cameras)',
                author: 'Built-in',
                canvas: { aspectRatio: '6:3', backgroundColor: '#000000' },
                cameras: {
                    front: {
                        enabled: true,
                        position: { x: 33.33, y: 0, width: 33.34, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    back: {
                        enabled: true,
                        position: { x: 33.33, y: 50, width: 33.34, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    left_repeater: {
                        enabled: true,
                        position: { x: 66.67, y: 50, width: 33.33, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    right_repeater: {
                        enabled: true,
                        position: { x: 0, y: 50, width: 33.33, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    left_pillar: {
                        enabled: true,
                        position: { x: 0, y: 0, width: 33.33, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    },
                    right_pillar: {
                        enabled: true,
                        position: { x: 66.67, y: 0, width: 33.33, height: 50 },
                        zIndex: 1,
                        aspectRatio: 'auto',
                        objectFit: 'contain',
                        crop: { top: 0, right: 0, bottom: 0, left: 0 }
                    }
                }
            }
        };

        const config = presets[presetName];
        if (!config) {
            return null;
        }

        // Add future cameras with disabled state
        const fullConfig = this.clone(config);
        for (const cam of this.FUTURE_CAMERAS) {
            if (!fullConfig.cameras[cam]) {
                fullConfig.cameras[cam] = this.getDefaultCamera(false);
            }
        }

        // Add timestamps
        fullConfig.created = new Date().toISOString();
        fullConfig.modified = new Date().toISOString();

        return fullConfig;
    }

    /**
     * Get list of all preset names
     */
    static getPresetNames() {
        return [
            'grid-2x2',
            'layout-6-3',
            'layout-4-3',
            'layout-all-16-9',
            'layout-front-left',
            'layout-front-right',
            'layout-front-repeaters',
            'layout-focus'
        ];
    }

    /**
     * Check if a layout name is a built-in preset
     */
    static isPreset(layoutName) {
        return this.getPresetNames().includes(layoutName);
    }

    /**
     * Export config to JSON string for file download
     * @param {Object} config - Layout configuration
     * @param {Object} options - Export options
     * @param {Object} options.telemetryOverlay - Telemetry overlay position { x, y }
     */
    static exportToJSON(config, options = {}) {
        const exportData = {
            teslacamviewer_layout: true,
            version: this.VERSION,
            exported: new Date().toISOString(),
            layout: config
        };

        // Include telemetry overlay position if provided
        if (options.telemetryOverlay) {
            exportData.telemetryOverlay = {
                position: {
                    x: options.telemetryOverlay.x,
                    y: options.telemetryOverlay.y
                }
            };
        }

        return JSON.stringify(exportData, null, 2);
    }

    /**
     * Import config from JSON string
     * @returns {{ success: boolean, config?: object, telemetryOverlay?: object, error?: string }}
     */
    static importFromJSON(jsonString) {
        try {
            const data = JSON.parse(jsonString);

            if (!data.teslacamviewer_layout) {
                return { success: false, error: 'Not a valid TeslaCamViewer layout file' };
            }

            if (!data.layout) {
                return { success: false, error: 'Missing layout data' };
            }

            const config = this.migrate(data.layout);
            const validation = this.validate(config);

            if (!validation.valid) {
                return { success: false, error: `Invalid layout: ${validation.errors.join(', ')}` };
            }

            // Generate new ID for imported layouts
            config.id = `imported-${Date.now()}`;
            config.modified = new Date().toISOString();

            // Extract telemetry overlay position if present
            const result = { success: true, config };
            if (data.telemetryOverlay && data.telemetryOverlay.position) {
                result.telemetryOverlay = {
                    x: data.telemetryOverlay.position.x,
                    y: data.telemetryOverlay.position.y
                };
            }

            return result;
        } catch (e) {
            return { success: false, error: `Failed to parse JSON: ${e.message}` };
        }
    }
}

// Export for use in other modules
window.LayoutConfig = LayoutConfig;
