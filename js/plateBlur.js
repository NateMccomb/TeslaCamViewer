/**
 * PlateBlur - Automatic license plate blurring for video export
 * Uses YOLOv8 via ONNX Runtime Web for direct license plate detection
 */
class PlateBlur {
    constructor() {
        this.detector = null;
        this.isModelLoading = false;
        this.isModelLoaded = false;
        this.lastDetectionTime = 0;
        this.detectionInterval = 100; // Run detection every 100ms for good coverage
        this.cachedDetections = [];
        this.frameCount = 0;

        // Detection settings
        this.blurRadius = 30; // Strong blur for plates
        this.blurPadding = 18; // Extra padding for movement

        // Simple history-based tracking - keep all recent detections
        this.detectionHistory = []; // Array of {plates, timestamp}
        this.historyDuration = 1500; // Keep 1.5 seconds of detection history

        // Progress callback
        this.onProgress = null;

        // Debug overlay
        this.debugCanvas = null;
        this.debugCtx = null;
        this.debugActive = false;
        this.debugAnimationId = null;
    }

    /**
     * Start live debug overlay on a video element
     * Shows detection boxes in real-time for testing
     * @param {HTMLVideoElement} video - Video element to overlay
     */
    async startDebugOverlay(video) {
        if (!this.isModelLoaded) {
            console.log('[PlateBlur Debug] Loading model first...');
            await this.loadModel();
        }

        // Create canvas overlay
        this.debugCanvas = document.createElement('canvas');
        this.debugCanvas.id = 'plateDebugOverlay';
        this.debugCanvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 1000;
        `;
        video.parentElement.style.position = 'relative';
        video.parentElement.appendChild(this.debugCanvas);
        this.debugCtx = this.debugCanvas.getContext('2d');
        this.debugActive = true;

        console.log('[PlateBlur Debug] Started - green boxes = detected plates');

        const runDebug = async () => {
            if (!this.debugActive) return;

            // Match canvas size to video display size
            const rect = video.getBoundingClientRect();
            this.debugCanvas.width = rect.width;
            this.debugCanvas.height = rect.height;

            // Clear previous frame
            this.debugCtx.clearRect(0, 0, this.debugCanvas.width, this.debugCanvas.height);

            // Run detection
            const detections = await this.detectPlates(video);

            // Calculate actual video display area (accounting for object-fit: contain)
            const videoAspect = video.videoWidth / video.videoHeight;
            const containerAspect = rect.width / rect.height;

            let displayWidth, displayHeight, offsetX, offsetY;

            if (videoAspect > containerAspect) {
                // Video is wider - letterbox top/bottom
                displayWidth = rect.width;
                displayHeight = rect.width / videoAspect;
                offsetX = 0;
                offsetY = (rect.height - displayHeight) / 2;
            } else {
                // Video is taller - letterbox left/right
                displayHeight = rect.height;
                displayWidth = rect.height * videoAspect;
                offsetX = (rect.width - displayWidth) / 2;
                offsetY = 0;
            }

            // Scale factors from video coordinates to display coordinates
            const scaleX = displayWidth / video.videoWidth;
            const scaleY = displayHeight / video.videoHeight;

            // Draw detection boxes
            for (const det of detections) {
                const x = det.x * scaleX + offsetX;
                const y = det.y * scaleY + offsetY;
                const w = det.width * scaleX;
                const h = det.height * scaleY;

                // Green box with confidence
                this.debugCtx.strokeStyle = '#00ff00';
                this.debugCtx.lineWidth = 3;
                this.debugCtx.strokeRect(x, y, w, h);

                // Confidence label
                this.debugCtx.fillStyle = '#00ff00';
                this.debugCtx.font = 'bold 14px monospace';
                this.debugCtx.fillText(`${(det.confidence * 100).toFixed(0)}%`, x, y - 5);
            }

            // Show stats
            this.debugCtx.fillStyle = 'rgba(0,0,0,0.7)';
            this.debugCtx.fillRect(5, 5, 180, 50);
            this.debugCtx.fillStyle = '#00ff00';
            this.debugCtx.font = 'bold 12px monospace';
            this.debugCtx.fillText(`Plates found: ${detections.length}`, 10, 22);
            this.debugCtx.fillText(`Video: ${video.videoWidth}x${video.videoHeight}`, 10, 38);
            this.debugCtx.fillText(`Time: ${video.currentTime.toFixed(2)}s`, 10, 52);

            // Continue loop
            this.debugAnimationId = requestAnimationFrame(runDebug);
        };

        runDebug();
    }

    /**
     * Stop debug overlay
     */
    stopDebugOverlay() {
        this.debugActive = false;
        if (this.debugAnimationId) {
            cancelAnimationFrame(this.debugAnimationId);
            this.debugAnimationId = null;
        }
        if (this.debugCanvas && this.debugCanvas.parentElement) {
            this.debugCanvas.parentElement.removeChild(this.debugCanvas);
        }
        this.debugCanvas = null;
        this.debugCtx = null;
        console.log('[PlateBlur Debug] Stopped');
    }

    /**
     * Toggle debug overlay
     * @param {HTMLVideoElement} video - Video element
     */
    toggleDebugOverlay(video) {
        if (this.debugActive) {
            this.stopDebugOverlay();
        } else {
            this.startDebugOverlay(video);
        }
        return this.debugActive;
    }

    /**
     * Load the license plate detection model
     * @param {Function} progressCallback - Optional callback for progress updates
     * @returns {Promise<boolean>} True if model loaded successfully
     */
    async loadModel(progressCallback = null) {
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
        this.onProgress = progressCallback;

        try {
            console.log('[PlateBlur] Loading YOLOv8 license plate detection model...');

            // Check if PlateDetector is available
            if (typeof PlateDetector === 'undefined') {
                console.error('[PlateBlur] PlateDetector not loaded. Include plateDetector.js in your HTML.');
                this.isModelLoading = false;
                return false;
            }

            // Check if ONNX Runtime is available
            if (typeof ort === 'undefined') {
                console.error('[PlateBlur] ONNX Runtime not loaded. Include ort.all.min.js in your HTML.');
                this.isModelLoading = false;
                return false;
            }

            // Create detector and load model
            this.detector = new PlateDetector();

            const success = await this.detector.loadModel((progress) => {
                if (this.onProgress) {
                    this.onProgress(progress);
                }
            });

            if (success) {
                this.isModelLoaded = true;
                console.log('[PlateBlur] License plate detection model loaded successfully');
            } else {
                console.error('[PlateBlur] Failed to load license plate detection model');
            }

            this.isModelLoading = false;
            return this.isModelLoaded;
        } catch (error) {
            console.error('[PlateBlur] Failed to load model:', error);
            this.isModelLoading = false;
            return false;
        }
    }

    /**
     * Detect license plates in an image/canvas/video frame
     * @param {HTMLVideoElement|HTMLCanvasElement} source - The image source
     * @returns {Promise<Array>} Array of detection results with bounding boxes
     */
    async detectPlates(source) {
        if (!this.isModelLoaded || !this.detector) {
            return [];
        }

        try {
            const detections = await this.detector.detect(source);
            return detections;
        } catch (error) {
            console.warn('[PlateBlur] Detection error:', error);
            return [];
        }
    }

    /**
     * Generate a tracking ID for a plate based on position
     * @param {Object} plate - Plate detection { x, y, width, height, confidence }
     * @returns {string} Tracking ID
     */

    /**
     * Convert plate detection to bbox format for consistency
     * @param {Object} plate - Plate detection { x, y, width, height, confidence }
     * @returns {Array} bbox [x, y, width, height]
     */
    _toBbox(plate) {
        return [plate.x, plate.y, plate.width, plate.height];
    }

    /**
     * Convert bbox to plate format
     * @param {Array} bbox - [x, y, width, height]
     * @param {number} confidence
     * @returns {Object} plate { x, y, width, height, confidence }
     */
    _fromBbox(bbox, confidence) {
        return {
            x: bbox[0],
            y: bbox[1],
            width: bbox[2],
            height: bbox[3],
            confidence
        };
    }

    /**
     * Simple history-based detection smoothing
     * Keeps all detections from recent history and renders all of them
     * @param {Array} newDetections - New frame detections
     * @returns {Array} All recent detections to blur
     */
    _smoothDetections(newDetections) {
        const now = performance.now();

        // Add new detections to history
        if (newDetections.length > 0) {
            this.detectionHistory.push({
                plates: newDetections.map(p => ({ ...p })),
                timestamp: now
            });
        }

        // Remove old entries from history
        this.detectionHistory = this.detectionHistory.filter(
            entry => now - entry.timestamp < this.historyDuration
        );

        // Collect all unique plate regions from history
        // Use a simple grid to merge nearby detections
        const mergedPlates = new Map();

        for (const entry of this.detectionHistory) {
            for (const plate of entry.plates) {
                // Grid key based on center point (coarse 50px grid)
                const cx = Math.floor((plate.x + plate.width / 2) / 50);
                const cy = Math.floor((plate.y + plate.height / 2) / 50);
                const key = `${cx}_${cy}`;

                const existing = mergedPlates.get(key);
                if (existing) {
                    // Expand to cover both regions (union of bounding boxes)
                    const minX = Math.min(existing.x, plate.x);
                    const minY = Math.min(existing.y, plate.y);
                    const maxX = Math.max(existing.x + existing.width, plate.x + plate.width);
                    const maxY = Math.max(existing.y + existing.height, plate.y + plate.height);
                    existing.x = minX;
                    existing.y = minY;
                    existing.width = maxX - minX;
                    existing.height = maxY - minY;
                    existing.confidence = Math.max(existing.confidence, plate.confidence);
                } else {
                    mergedPlates.set(key, { ...plate });
                }
            }
        }

        return Array.from(mergedPlates.values());
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
     * Process multiple camera views with proper coordinate transformation
     * Runs detection on each camera video and transforms to canvas coordinates
     * @param {CanvasRenderingContext2D} ctx - Canvas context to draw blurs on
     * @param {Object} cameras - Map of camera configs: { front: { video, dx, dy, dw, dh, crop }, ... }
     * @param {Object} options - Processing options
     * @returns {Promise<number>} Number of plates blurred
     */
    async processMultiCamera(ctx, cameras, options = {}) {
        const { forceDetection = false } = options;

        if (!this.isModelLoaded) {
            return 0;
        }

        const now = performance.now();
        this.frameCount++;

        let totalBlurred = 0;

        // Only run detection periodically
        if (!forceDetection && now - this.lastDetectionTime < this.detectionInterval) {
            // Use cached detections - apply blurs from previous detection
            for (const plate of this.cachedDetections) {
                const paddedRegion = {
                    x: Math.max(0, plate.x - this.blurPadding),
                    y: Math.max(0, plate.y - this.blurPadding),
                    width: plate.width + this.blurPadding * 2,
                    height: plate.height + this.blurPadding * 2
                };
                if (paddedRegion.width > 5 && paddedRegion.height > 5) {
                    this.blurRegion(ctx, paddedRegion);
                    totalBlurred++;
                }
            }
            return totalBlurred;
        }

        // Run fresh detection on each camera
        const allDetections = [];

        for (const [camName, camInfo] of Object.entries(cameras)) {
            const { video, dx, dy, dw, dh, crop, objectFit } = camInfo;

            if (!video || !video.src || video.readyState < 2) continue;

            try {
                // Detect plates in the original video
                const detections = await this.detectPlates(video);

                // Use centralized calculation for source/destination rectangles
                // Build camConfig object compatible with LayoutRenderer.calculateDrawParams
                const camConfig = { x: dx, y: dy, w: dw, h: dh, crop, objectFit };
                const params = LayoutRenderer.calculateDrawParams(video, camConfig);

                // Transform each detection from video coords to canvas coords
                for (const det of detections) {
                    // Check if detection is within the visible source area
                    const detRight = det.x + det.width;
                    const detBottom = det.y + det.height;

                    if (detRight < params.sx || det.x > params.sx + params.sw ||
                        detBottom < params.sy || det.y > params.sy + params.sh) {
                        continue; // Detection is outside visible crop
                    }

                    // Clip detection to source bounds
                    const clippedX = Math.max(det.x, params.sx);
                    const clippedY = Math.max(det.y, params.sy);
                    const clippedRight = Math.min(detRight, params.sx + params.sw);
                    const clippedBottom = Math.min(detBottom, params.sy + params.sh);

                    // Transform to canvas coordinates
                    const scaleX = params.dw / params.sw;
                    const scaleY = params.dh / params.sh;

                    const canvasX = params.dx + (clippedX - params.sx) * scaleX;
                    const canvasY = params.dy + (clippedY - params.sy) * scaleY;
                    const canvasW = (clippedRight - clippedX) * scaleX;
                    const canvasH = (clippedBottom - clippedY) * scaleY;

                    allDetections.push({
                        x: canvasX,
                        y: canvasY,
                        width: canvasW,
                        height: canvasH,
                        confidence: det.confidence,
                        camera: camName
                    });
                }
            } catch (error) {
                // Ignore errors for individual cameras
            }
        }

        // Apply temporal smoothing
        this.cachedDetections = this._smoothDetections(allDetections);
        this.lastDetectionTime = now;

        // Apply blur to all detected plates
        for (const plate of this.cachedDetections) {
            const paddedRegion = {
                x: Math.max(0, plate.x - this.blurPadding),
                y: Math.max(0, plate.y - this.blurPadding),
                width: plate.width + this.blurPadding * 2,
                height: plate.height + this.blurPadding * 2
            };

            if (paddedRegion.width > 5 && paddedRegion.height > 5) {
                this.blurRegion(ctx, paddedRegion);
                totalBlurred++;
            }
        }

        if (this.frameCount % 30 === 1) {
            console.log(`[PlateBlur] MultiCamera: ${totalBlurred} plates blurred across ${Object.keys(cameras).length} cameras`);
        }

        return totalBlurred;
    }

    /**
     * Process a frame: detect plates and blur them
     * @param {CanvasRenderingContext2D} ctx - Canvas context with frame already drawn
     * @param {number} canvasWidth - Canvas width
     * @param {number} canvasHeight - Canvas height
     * @param {Object} options - Processing options
     * @returns {Promise<number>} Number of plates blurred
     */
    async processFrame(ctx, canvasWidth, canvasHeight, options = {}) {
        const { forceDetection = false } = options;

        if (!this.isModelLoaded) {
            console.log('[PlateBlur] processFrame called but model not loaded');
            return 0;
        }

        const now = performance.now();
        this.frameCount++;

        // Run detection periodically or when forced
        if (forceDetection || now - this.lastDetectionTime > this.detectionInterval) {
            try {
                // Debug: Log every 10th detection
                const shouldLog = this.frameCount % 10 === 1;
                if (shouldLog) {
                    console.log(`[PlateBlur] Running detection on frame ${this.frameCount}, canvas: ${canvasWidth}x${canvasHeight}`);
                }

                const rawDetections = await this.detectPlates(ctx.canvas);

                if (shouldLog || rawDetections.length > 0) {
                    console.log(`[PlateBlur] Frame ${this.frameCount}: ${rawDetections.length} plates detected`, rawDetections);
                }

                // Apply temporal smoothing to reduce jumping
                this.cachedDetections = this._smoothDetections(rawDetections);
                this.lastDetectionTime = now;
            } catch (error) {
                console.warn('[PlateBlur] Frame detection error:', error);
            }
        }

        // Apply blur to cached plate regions
        let blurCount = 0;
        for (const plate of this.cachedDetections) {
            // Add padding around detected plate for better coverage
            const paddedRegion = {
                x: Math.max(0, plate.x - this.blurPadding),
                y: Math.max(0, plate.y - this.blurPadding),
                width: Math.min(plate.width + this.blurPadding * 2, canvasWidth - plate.x + this.blurPadding),
                height: Math.min(plate.height + this.blurPadding * 2, canvasHeight - plate.y + this.blurPadding)
            };

            // Debug log blur regions (every 30th frame to avoid spam)
            if (this.frameCount % 30 === 1) {
                console.log(`[PlateBlur] Blurring region: x=${paddedRegion.x.toFixed(0)}, y=${paddedRegion.y.toFixed(0)}, w=${paddedRegion.width.toFixed(0)}, h=${paddedRegion.height.toFixed(0)}, canvas=${canvasWidth}x${canvasHeight}`);
            }

            // Only blur if region has valid size and not too large
            const maxRegionSize = Math.max(canvasWidth, canvasHeight) * 0.2;
            if (paddedRegion.width > 5 && paddedRegion.height > 5 &&
                paddedRegion.width < maxRegionSize && paddedRegion.height < maxRegionSize) {
                this.blurRegion(ctx, paddedRegion);
                blurCount++;
            }
        }

        return blurCount;
    }

    /**
     * Process a frame with fresh detection for better accuracy
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
            // Run fresh detection and apply smoothing
            const rawDetections = await this.detectPlates(ctx.canvas);
            const plates = this._smoothDetections(rawDetections);

            let blurCount = 0;
            for (const plate of plates) {
                // Add extra padding for high quality export
                const extraPadding = this.blurPadding * 1.5;
                const paddedRegion = {
                    x: Math.max(0, plate.x - extraPadding),
                    y: Math.max(0, plate.y - extraPadding),
                    width: Math.min(plate.width + extraPadding * 2, canvasWidth - plate.x + extraPadding),
                    height: Math.min(plate.height + extraPadding * 2, canvasHeight - plate.y + extraPadding)
                };

                // Apply stronger blur for high quality export
                if (paddedRegion.width > 5 && paddedRegion.height > 5) {
                    this.blurRegion(ctx, paddedRegion, this.blurRadius * 1.2);
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
        this.trackedPlates.clear();
        this.lastDetectionTime = 0;
        this.frameCount = 0;
    }

    /**
     * Cleanup resources
     */
    dispose() {
        if (this.detector) {
            this.detector.dispose();
            this.detector = null;
        }
        this.isModelLoaded = false;
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
        const detectorStats = this.detector ? this.detector.getStats() : {};
        return {
            isModelLoaded: this.isModelLoaded,
            cachedDetections: this.cachedDetections.length,
            trackedPlates: this.trackedPlates.size,
            frameCount: this.frameCount,
            lastDetectionTime: this.lastDetectionTime,
            lastInferenceTime: detectorStats.lastInferenceTime || 0
        };
    }

    /**
     * Get the last inference time
     * @returns {number} Inference time in ms
     */
    getInferenceTime() {
        return this.detector ? this.detector.getInferenceTime() : 0;
    }
}

// Export for use in other modules
window.PlateBlur = PlateBlur;
