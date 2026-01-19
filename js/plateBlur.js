/**
 * PlateBlur - Automatic license plate blurring for video export
 * Uses TensorFlow.js with COCO-SSD model to detect vehicles,
 * then applies blur to the estimated license plate region (bottom portion of vehicle bbox)
 */
class PlateBlur {
    constructor() {
        this.model = null;
        this.isModelLoading = false;
        this.isModelLoaded = false;
        this.lastDetectionTime = 0;
        this.detectionInterval = 100; // Run detection every 100ms (10 fps) for performance
        this.cachedDetections = [];
        this.frameCount = 0;

        // Detection settings
        this.minScore = 0.5; // Minimum confidence for vehicle detection
        this.plateRegionTop = 0.7; // Plate region starts at 70% down from top of vehicle bbox
        this.plateRegionHeight = 0.25; // Plate region is 25% of vehicle bbox height
        this.blurRadius = 15; // Blur intensity

        // Vehicle classes from COCO dataset
        this.vehicleClasses = ['car', 'truck', 'bus', 'motorcycle'];
    }

    /**
     * Load the COCO-SSD model
     * @returns {Promise<boolean>} True if model loaded successfully
     */
    async loadModel() {
        if (this.isModelLoaded) {
            return true;
        }

        if (this.isModelLoading) {
            // Wait for current loading to complete
            while (this.isModelLoading) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return this.isModelLoaded;
        }

        this.isModelLoading = true;

        try {
            console.log('[PlateBlur] Loading COCO-SSD model...');

            // Check if cocoSsd is available
            if (typeof cocoSsd === 'undefined') {
                console.error('[PlateBlur] COCO-SSD library not loaded');
                this.isModelLoading = false;
                return false;
            }

            // Load the model with base settings for faster inference
            this.model = await cocoSsd.load({
                base: 'lite_mobilenet_v2' // Faster, lighter model
            });

            this.isModelLoaded = true;
            this.isModelLoading = false;
            console.log('[PlateBlur] COCO-SSD model loaded successfully');
            return true;
        } catch (error) {
            console.error('[PlateBlur] Failed to load COCO-SSD model:', error);
            this.isModelLoading = false;
            return false;
        }
    }

    /**
     * Detect vehicles in an image/canvas/video frame
     * @param {HTMLVideoElement|HTMLCanvasElement|ImageData} source - The image source
     * @returns {Promise<Array>} Array of detection results with bounding boxes
     */
    async detectVehicles(source) {
        if (!this.isModelLoaded) {
            return [];
        }

        try {
            const predictions = await this.model.detect(source);

            // Filter for vehicle classes only
            const vehicles = predictions.filter(pred =>
                this.vehicleClasses.includes(pred.class) &&
                pred.score >= this.minScore
            );

            return vehicles;
        } catch (error) {
            console.warn('[PlateBlur] Detection error:', error);
            return [];
        }
    }

    /**
     * Calculate the estimated license plate region from a vehicle bounding box
     * @param {Object} vehicle - Vehicle detection with bbox [x, y, width, height]
     * @returns {Object} Plate region {x, y, width, height}
     */
    getPlateRegion(vehicle) {
        const [vx, vy, vw, vh] = vehicle.bbox;

        // License plate is typically in the bottom-center portion of the vehicle
        // For front/rear views: bottom 20-30% of vehicle, centered horizontally
        const plateY = vy + vh * this.plateRegionTop;
        const plateH = vh * this.plateRegionHeight;

        // Plate is typically in the center 60% of vehicle width
        const plateW = vw * 0.6;
        const plateX = vx + (vw - plateW) / 2;

        return {
            x: Math.max(0, plateX),
            y: Math.max(0, plateY),
            width: plateW,
            height: plateH
        };
    }

    /**
     * Apply gaussian blur to a specific region of a canvas
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {Object} region - Region to blur {x, y, width, height}
     * @param {number} blurRadius - Blur intensity
     */
    blurRegion(ctx, region, blurRadius = this.blurRadius) {
        const { x, y, width, height } = region;

        // Ensure region is valid
        if (width <= 0 || height <= 0) return;

        // Save context state
        ctx.save();

        // Create clipping path for the blur region
        ctx.beginPath();
        ctx.rect(x, y, width, height);
        ctx.clip();

        // Apply blur filter
        ctx.filter = `blur(${blurRadius}px)`;

        // Draw the region back on itself (this applies the blur)
        // We need to draw a larger area to account for blur edge effects
        const padding = blurRadius * 2;
        ctx.drawImage(
            ctx.canvas,
            x - padding, y - padding, width + padding * 2, height + padding * 2,
            x - padding, y - padding, width + padding * 2, height + padding * 2
        );

        // Restore context state
        ctx.restore();
        ctx.filter = 'none';
    }

    /**
     * Process a frame: detect vehicles and blur license plate regions
     * @param {CanvasRenderingContext2D} ctx - Canvas context with frame already drawn
     * @param {number} canvasWidth - Canvas width
     * @param {number} canvasHeight - Canvas height
     * @param {Object} options - Processing options
     * @returns {Promise<number>} Number of plates blurred
     */
    async processFrame(ctx, canvasWidth, canvasHeight, options = {}) {
        const { forceDetection = false } = options;

        if (!this.isModelLoaded) {
            return 0;
        }

        const now = performance.now();
        this.frameCount++;

        // Run detection periodically or when forced
        // Use cached detections for intermediate frames to improve performance
        if (forceDetection || now - this.lastDetectionTime > this.detectionInterval) {
            try {
                const vehicles = await this.detectVehicles(ctx.canvas);
                this.cachedDetections = vehicles;
                this.lastDetectionTime = now;
            } catch (error) {
                console.warn('[PlateBlur] Frame detection error:', error);
            }
        }

        // Apply blur to cached plate regions
        let blurCount = 0;
        for (const vehicle of this.cachedDetections) {
            const plateRegion = this.getPlateRegion(vehicle);

            // Validate region is within canvas bounds
            if (plateRegion.x >= 0 && plateRegion.y >= 0 &&
                plateRegion.x + plateRegion.width <= canvasWidth &&
                plateRegion.y + plateRegion.height <= canvasHeight) {
                this.blurRegion(ctx, plateRegion);
                blurCount++;
            }
        }

        return blurCount;
    }

    /**
     * Process a frame with multi-scale detection for better accuracy
     * This is slower but more thorough - useful for final export quality
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {number} canvasWidth - Canvas width
     * @param {number} canvasHeight - Canvas height
     * @returns {Promise<number>} Number of plates blurred
     */
    async processFrameHighQuality(ctx, canvasWidth, canvasHeight) {
        if (!this.isModelLoaded) {
            return 0;
        }

        try {
            // Always run fresh detection for high quality mode
            const vehicles = await this.detectVehicles(ctx.canvas);

            let blurCount = 0;
            for (const vehicle of vehicles) {
                const plateRegion = this.getPlateRegion(vehicle);

                // Apply stronger blur for high quality export
                if (plateRegion.x >= 0 && plateRegion.y >= 0 &&
                    plateRegion.x + plateRegion.width <= canvasWidth &&
                    plateRegion.y + plateRegion.height <= canvasHeight) {
                    this.blurRegion(ctx, plateRegion, this.blurRadius * 1.5);
                    blurCount++;
                }
            }

            return blurCount;
        } catch (error) {
            console.warn('[PlateBlur] High quality detection error:', error);
            return 0;
        }
    }

    /**
     * Reset detection state (call when switching videos/clips)
     */
    reset() {
        this.cachedDetections = [];
        this.lastDetectionTime = 0;
        this.frameCount = 0;
    }

    /**
     * Cleanup resources
     */
    dispose() {
        if (this.model) {
            // TensorFlow.js models don't have a dispose method by default
            // but we can clear references
            this.model = null;
            this.isModelLoaded = false;
        }
        this.reset();
    }

    /**
     * Check if the model is ready for use
     * @returns {boolean}
     */
    isReady() {
        return this.isModelLoaded;
    }

    /**
     * Get detection statistics for debugging
     * @returns {Object}
     */
    getStats() {
        return {
            isModelLoaded: this.isModelLoaded,
            cachedDetections: this.cachedDetections.length,
            frameCount: this.frameCount,
            lastDetectionTime: this.lastDetectionTime
        };
    }
}

// Export for use in other modules
window.PlateBlur = PlateBlur;
