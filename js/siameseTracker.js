/**
 * SiameseTracker - Neural network based visual object tracking
 *
 * Uses a Siamese network architecture to track any user-selected region
 * across video frames. Unlike template matching, this uses learned features
 * that are robust to lighting changes, angle variations, and partial occlusions.
 *
 * Perfect for tracking:
 * - License plates
 * - Bumper stickers
 * - Vehicle damage/dents
 * - Any identifying marks
 *
 * Based on NanoTrack architecture - lightweight enough for browser inference.
 */

class SiameseTracker {
    constructor() {
        this.backboneSession = null;
        this.headSession = null;
        this.templateFeatures = null;
        // NanoTrack backbone expects 255x255 for BOTH template and search
        // Backbone outputs 16x16 feature maps
        // Head expects: template=8x8 (cropped), search=16x16
        this.templateSize = 255;  // Template input: 255x255 → 16x16 features → crop to 8x8
        this.searchSize = 255;    // Search input: 255x255 → 16x16 features
        this.templateFeatureSize = 8;   // Head expects 8x8 template features
        this.searchFeatureSize = 16;    // Head expects 16x16 search features
        this.stride = 16;         // Feature stride (255/16 ≈ 16)
        this.initialized = false;
        this.currentPosition = null;
        this.currentSize = null;
        this.scoreThreshold = 0.3;  // Lower threshold for neural tracking

        // Image dimensions (set during tracking)
        this.imageWidth = null;
        this.imageHeight = null;

        // For template updating
        this.updateInterval = 10;  // Update template every N frames
        this.frameCount = 0;

        // Model paths
        this.modelPaths = {
            backbone: 'vendor/models/nanotrack_backbone.onnx',
            head: 'vendor/models/nanotrack_head.onnx'
        };
    }

    /**
     * Load the Siamese tracker models
     */
    async loadModels(onProgress = null) {
        if (this.initialized) {
            console.log('[SiameseTracker] Already initialized');
            return true;
        }

        try {
            console.log('[SiameseTracker] Loading models...');

            // Check if ONNX Runtime is available
            if (typeof ort === 'undefined') {
                throw new Error('ONNX Runtime not loaded');
            }

            // Load backbone (feature extractor)
            if (onProgress) onProgress('Loading backbone model...', 0.2);
            console.log('[SiameseTracker] Loading backbone from:', this.modelPaths.backbone);

            this.backboneSession = await ort.InferenceSession.create(
                this.modelPaths.backbone,
                { executionProviders: ['wasm'] }
            );

            // Load head (cross-correlation + regression)
            if (onProgress) onProgress('Loading head model...', 0.6);
            console.log('[SiameseTracker] Loading head from:', this.modelPaths.head);

            this.headSession = await ort.InferenceSession.create(
                this.modelPaths.head,
                { executionProviders: ['wasm'] }
            );

            if (onProgress) onProgress('Models loaded!', 1.0);

            this.initialized = true;
            console.log('[SiameseTracker] Models loaded successfully');
            console.log('[SiameseTracker] Backbone inputs:', this.backboneSession.inputNames);
            console.log('[SiameseTracker] Backbone outputs:', this.backboneSession.outputNames);
            console.log('[SiameseTracker] Head inputs:', this.headSession.inputNames);
            console.log('[SiameseTracker] Head outputs:', this.headSession.outputNames);

            return true;

        } catch (error) {
            console.error('[SiameseTracker] Failed to load models:', error);
            this.initialized = false;
            throw error;
        }
    }

    /**
     * Initialize tracking with a template from the first frame
     * @param {ImageData|HTMLCanvasElement|HTMLImageElement} image - Source image
     * @param {Object} bbox - Bounding box {x, y, width, height}
     */
    async initializeTemplate(image, bbox) {
        if (!this.initialized) {
            throw new Error('Models not loaded. Call loadModels() first.');
        }

        console.log('[SiameseTracker] Initializing template at:', bbox);

        // Store image dimensions
        if (image instanceof ImageData) {
            this.imageWidth = image.width;
            this.imageHeight = image.height;
        } else {
            this.imageWidth = image.width || image.videoWidth;
            this.imageHeight = image.height || image.videoHeight;
        }
        console.log(`[SiameseTracker] Image dimensions: ${this.imageWidth}x${this.imageHeight}`);

        // Store initial position and size (clamped to image bounds)
        this.currentPosition = {
            x: Math.max(bbox.width / 2, Math.min(this.imageWidth - bbox.width / 2, bbox.x + bbox.width / 2)),
            y: Math.max(bbox.height / 2, Math.min(this.imageHeight - bbox.height / 2, bbox.y + bbox.height / 2))
        };
        this.currentSize = {
            width: bbox.width,
            height: bbox.height
        };

        // Extract and resize template region
        const templateCanvas = this._extractRegion(image, bbox, this.templateSize);

        // Preprocess and extract features
        const templateTensor = this._preprocessImage(templateCanvas);

        // Run through backbone to get template features
        const feeds = { [this.backboneSession.inputNames[0]]: templateTensor };
        const results = await this.backboneSession.run(feeds);

        // Get raw features (16x16)
        const rawFeatures = results[this.backboneSession.outputNames[0]];
        console.log('[SiameseTracker] Raw template features shape:', rawFeatures.dims);

        // Crop to center 8x8 for head network
        this.templateFeatures = this._cropFeatures(rawFeatures, this.templateFeatureSize);
        console.log('[SiameseTracker] Cropped template features shape:', this.templateFeatures.dims);

        this.frameCount = 0;

        return {
            position: this.currentPosition,
            size: this.currentSize,
            confidence: 1.0
        };
    }

    /**
     * Track the object in a new frame
     * @param {ImageData|HTMLCanvasElement|HTMLImageElement} image - New frame
     * @param {boolean} updateTemplate - Whether to update the template
     * @returns {Object} - {position, size, confidence, bbox}
     */
    async track(image, updateTemplate = false) {
        if (!this.templateFeatures) {
            throw new Error('Template not initialized. Call initializeTemplate() first.');
        }

        this.frameCount++;

        // Update image dimensions (in case not set or changed)
        if (image instanceof ImageData) {
            this.imageWidth = image.width;
            this.imageHeight = image.height;
        } else {
            this.imageWidth = image.width || image.videoWidth;
            this.imageHeight = image.height || image.videoHeight;
        }

        // Define search region around current position
        const searchBbox = this._getSearchRegion(image);

        // Extract search region
        const searchCanvas = this._extractRegion(image, searchBbox, this.searchSize);

        // Preprocess search region
        const searchTensor = this._preprocessImage(searchCanvas);

        // Extract search features
        const backboneFeeds = { [this.backboneSession.inputNames[0]]: searchTensor };
        const backboneResults = await this.backboneSession.run(backboneFeeds);
        const searchFeatures = backboneResults[this.backboneSession.outputNames[0]];

        // Run cross-correlation in head network
        const headFeeds = {};
        // Head typically takes template features and search features
        const headInputs = this.headSession.inputNames;
        if (headInputs.length >= 2) {
            headFeeds[headInputs[0]] = this.templateFeatures;
            headFeeds[headInputs[1]] = searchFeatures;
        } else {
            // Some models concatenate internally
            headFeeds[headInputs[0]] = searchFeatures;
        }

        const headResults = await this.headSession.run(headFeeds);

        // Parse outputs - typically score map and offset/size regression
        const outputs = this.headSession.outputNames;
        let scoreMap, offsetMap;

        for (const name of outputs) {
            const tensor = headResults[name];
            if (name.includes('cls') || name.includes('score')) {
                scoreMap = tensor;
            } else if (name.includes('loc') || name.includes('bbox') || name.includes('offset')) {
                offsetMap = tensor;
            }
        }

        // If we couldn't identify outputs by name, use by shape/order
        if (!scoreMap) {
            scoreMap = headResults[outputs[0]];
        }
        if (!offsetMap && outputs.length > 1) {
            offsetMap = headResults[outputs[1]];
        }

        // Find best match location
        const result = this._decodeOutput(scoreMap, offsetMap, searchBbox);

        if (result.confidence > this.scoreThreshold) {
            // Apply maximum movement constraint to prevent drift
            // License plates don't move more than a few pixels between frames
            const maxMovementPerFrame = Math.max(this.currentSize.width, this.currentSize.height) * 0.5;

            const dx = result.position.x - this.currentPosition.x;
            const dy = result.position.y - this.currentPosition.y;
            const movement = Math.sqrt(dx * dx + dy * dy);

            if (movement > maxMovementPerFrame) {
                // Clamp movement to maximum allowed
                const scale = maxMovementPerFrame / movement;
                result.position.x = this.currentPosition.x + dx * scale;
                result.position.y = this.currentPosition.y + dy * scale;

                // Update bbox to match clamped position
                result.bbox.x = result.position.x - this.currentSize.width / 2;
                result.bbox.y = result.position.y - this.currentSize.height / 2;

                console.log(`[SiameseTracker] Movement clamped: ${movement.toFixed(1)}px -> ${maxMovementPerFrame.toFixed(1)}px`);
            }

            // CRITICAL: Clamp position to valid image bounds
            // Position is the CENTER of the bbox, so ensure there's room for the bbox
            const halfWidth = this.currentSize.width / 2;
            const halfHeight = this.currentSize.height / 2;

            result.position.x = Math.max(halfWidth, Math.min(this.imageWidth - halfWidth, result.position.x));
            result.position.y = Math.max(halfHeight, Math.min(this.imageHeight - halfHeight, result.position.y));

            // Update bbox to match bounds-clamped position
            result.bbox.x = result.position.x - halfWidth;
            result.bbox.y = result.position.y - halfHeight;

            // Update position
            this.currentPosition = result.position;

            // Optionally update template for appearance changes
            if (updateTemplate || (this.frameCount % this.updateInterval === 0 && result.confidence > 0.8)) {
                await this._updateTemplate(image, result.bbox);
            }
        }

        return result;
    }

    /**
     * Extract a region from an image and resize to target size
     */
    _extractRegion(image, bbox, targetSize) {
        const canvas = document.createElement('canvas');
        canvas.width = targetSize;
        canvas.height = targetSize;
        const ctx = canvas.getContext('2d');

        // Get source dimensions
        let srcWidth, srcHeight;
        if (image instanceof ImageData) {
            srcWidth = image.width;
            srcHeight = image.height;
        } else {
            srcWidth = image.width || image.videoWidth;
            srcHeight = image.height || image.videoHeight;
        }

        // Calculate context region (with padding)
        const contextAmount = 0.5;  // Add 50% context around the bbox
        const contextWidth = bbox.width * (1 + contextAmount);
        const contextHeight = bbox.height * (1 + contextAmount);

        const cx = bbox.x + bbox.width / 2;
        const cy = bbox.y + bbox.height / 2;

        const sx = Math.max(0, cx - contextWidth / 2);
        const sy = Math.max(0, cy - contextHeight / 2);
        const sw = Math.min(contextWidth, srcWidth - sx);
        const sh = Math.min(contextHeight, srcHeight - sy);

        // Draw source to canvas
        if (image instanceof ImageData) {
            // Create temp canvas for ImageData
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = srcWidth;
            tempCanvas.height = srcHeight;
            tempCanvas.getContext('2d').putImageData(image, 0, 0);
            ctx.drawImage(tempCanvas, sx, sy, sw, sh, 0, 0, targetSize, targetSize);
        } else {
            ctx.drawImage(image, sx, sy, sw, sh, 0, 0, targetSize, targetSize);
        }

        return canvas;
    }

    /**
     * Preprocess image for model input
     */
    _preprocessImage(canvas) {
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const { data, width, height } = imageData;

        // Normalize to [0, 1] and convert to CHW format
        const floatData = new Float32Array(3 * width * height);

        // ImageNet normalization
        const mean = [0.485, 0.456, 0.406];
        const std = [0.229, 0.224, 0.225];

        for (let i = 0; i < width * height; i++) {
            const r = data[i * 4] / 255.0;
            const g = data[i * 4 + 1] / 255.0;
            const b = data[i * 4 + 2] / 255.0;

            floatData[i] = (r - mean[0]) / std[0];                    // R channel
            floatData[width * height + i] = (g - mean[1]) / std[1];   // G channel
            floatData[2 * width * height + i] = (b - mean[2]) / std[2]; // B channel
        }

        return new ort.Tensor('float32', floatData, [1, 3, height, width]);
    }

    /**
     * Crop center region from feature map
     * NanoTrack head expects 8x8 template features from 16x16 backbone output
     */
    _cropFeatures(tensor, targetSize) {
        const dims = tensor.dims;  // [batch, channels, height, width]
        const batch = dims[0];
        const channels = dims[1];
        const height = dims[2];
        const width = dims[3];

        if (height === targetSize && width === targetSize) {
            // Already correct size
            return tensor;
        }

        // Calculate crop offsets (center crop)
        const offsetY = Math.floor((height - targetSize) / 2);
        const offsetX = Math.floor((width - targetSize) / 2);

        console.log(`[SiameseTracker] Cropping features from ${height}x${width} to ${targetSize}x${targetSize} (offset: ${offsetX}, ${offsetY})`);

        // Create new array for cropped features
        const croppedData = new Float32Array(batch * channels * targetSize * targetSize);
        const srcData = tensor.data;

        // Copy center region
        for (let b = 0; b < batch; b++) {
            for (let c = 0; c < channels; c++) {
                for (let y = 0; y < targetSize; y++) {
                    for (let x = 0; x < targetSize; x++) {
                        const srcY = y + offsetY;
                        const srcX = x + offsetX;
                        const srcIdx = b * channels * height * width + c * height * width + srcY * width + srcX;
                        const dstIdx = b * channels * targetSize * targetSize + c * targetSize * targetSize + y * targetSize + x;
                        croppedData[dstIdx] = srcData[srcIdx];
                    }
                }
            }
        }

        return new ort.Tensor('float32', croppedData, [batch, channels, targetSize, targetSize]);
    }

    /**
     * Get search region around current position
     */
    _getSearchRegion(image) {
        // Reduced search scale to limit drift (was 4.0, now 2.0)
        // Smaller search region keeps tracker focused on the target
        const searchScale = 2.0;

        const searchWidth = this.currentSize.width * searchScale;
        const searchHeight = this.currentSize.height * searchScale;

        // Get image dimensions
        let imgWidth, imgHeight;
        if (image instanceof ImageData) {
            imgWidth = image.width;
            imgHeight = image.height;
        } else {
            imgWidth = image.width || image.videoWidth;
            imgHeight = image.height || image.videoHeight;
        }

        // Center search region on current position
        let x = this.currentPosition.x - searchWidth / 2;
        let y = this.currentPosition.y - searchHeight / 2;

        // Clamp to image bounds
        x = Math.max(0, Math.min(x, imgWidth - searchWidth));
        y = Math.max(0, Math.min(y, imgHeight - searchHeight));

        return {
            x: x,
            y: y,
            width: Math.min(searchWidth, imgWidth),
            height: Math.min(searchHeight, imgHeight)
        };
    }

    /**
     * Decode model output to get position and confidence
     */
    _decodeOutput(scoreMap, offsetMap, searchBbox) {
        const scoreData = scoreMap.data;
        const scoreDims = scoreMap.dims;

        // Find max score location
        let maxScore = -Infinity;
        let maxIdx = 0;

        for (let i = 0; i < scoreData.length; i++) {
            if (scoreData[i] > maxScore) {
                maxScore = scoreData[i];
                maxIdx = i;
            }
        }

        // Apply sigmoid if needed (depends on model)
        const confidence = maxScore > 10 ? 1 / (1 + Math.exp(-maxScore)) :
                          maxScore < -10 ? 0 :
                          1 / (1 + Math.exp(-maxScore));

        // Convert index to grid position
        const gridSize = scoreDims[scoreDims.length - 1];  // Typically last dim
        const gridY = Math.floor(maxIdx / gridSize);
        const gridX = maxIdx % gridSize;

        // Convert grid position to image coordinates
        const scaleX = searchBbox.width / gridSize;
        const scaleY = searchBbox.height / gridSize;

        let newX = searchBbox.x + (gridX + 0.5) * scaleX;
        let newY = searchBbox.y + (gridY + 0.5) * scaleY;

        // Apply offset regression if available
        if (offsetMap) {
            const offsetData = offsetMap.data;
            const offsetDims = offsetMap.dims;

            // Offsets are typically [batch, 4, h, w] for (dx, dy, dw, dh)
            if (offsetDims.length >= 4) {
                const spatialSize = offsetDims[2] * offsetDims[3];
                const spatialIdx = gridY * offsetDims[3] + gridX;

                let dx = offsetData[spatialIdx];
                let dy = offsetData[spatialSize + spatialIdx];

                // Clamp offsets to prevent extreme jumps (max ±1.0 object size)
                dx = Math.max(-1.0, Math.min(1.0, dx));
                dy = Math.max(-1.0, Math.min(1.0, dy));

                newX += dx * this.currentSize.width;
                newY += dy * this.currentSize.height;
            }
        }

        // Clamp position to valid image bounds if dimensions are known
        if (this.imageWidth && this.imageHeight) {
            const halfW = this.currentSize.width / 2;
            const halfH = this.currentSize.height / 2;
            newX = Math.max(halfW, Math.min(this.imageWidth - halfW, newX));
            newY = Math.max(halfH, Math.min(this.imageHeight - halfH, newY));
        }

        // Create result bbox
        const bbox = {
            x: newX - this.currentSize.width / 2,
            y: newY - this.currentSize.height / 2,
            width: this.currentSize.width,
            height: this.currentSize.height
        };

        return {
            position: { x: newX, y: newY },
            size: this.currentSize,
            confidence: confidence,
            bbox: bbox,
            gridPosition: { x: gridX, y: gridY }
        };
    }

    /**
     * Update template with current appearance
     */
    async _updateTemplate(image, bbox) {
        console.log('[SiameseTracker] Updating template...');

        const templateCanvas = this._extractRegion(image, bbox, this.templateSize);
        const templateTensor = this._preprocessImage(templateCanvas);

        const feeds = { [this.backboneSession.inputNames[0]]: templateTensor };
        const results = await this.backboneSession.run(feeds);

        // Get raw features and crop to 8x8
        const rawFeatures = results[this.backboneSession.outputNames[0]];
        const croppedFeatures = this._cropFeatures(rawFeatures, this.templateFeatureSize);

        // Blend old and new features (exponential moving average)
        const alpha = 0.3;  // How much of new features to use
        const oldFeatures = this.templateFeatures.data;
        const newFeatures = croppedFeatures.data;

        for (let i = 0; i < oldFeatures.length; i++) {
            oldFeatures[i] = (1 - alpha) * oldFeatures[i] + alpha * newFeatures[i];
        }
    }

    /**
     * Reset tracker state
     */
    reset() {
        this.templateFeatures = null;
        this.currentPosition = null;
        this.currentSize = null;
        this.imageWidth = null;
        this.imageHeight = null;
        this.frameCount = 0;
    }

    /**
     * Check if models are loaded
     */
    isReady() {
        return this.initialized;
    }

    /**
     * Check if tracking is active
     */
    isTracking() {
        return this.templateFeatures !== null;
    }
}

// Export for use
if (typeof window !== 'undefined') {
    window.SiameseTracker = SiameseTracker;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SiameseTracker;
}
