/**
 * PlateDetector - YOLOv8 license plate detection using ONNX Runtime Web
 * Runs inference entirely in the browser using WebAssembly
 */
class PlateDetector {
    constructor() {
        // Initialize detector state - tcv.0x504C44
        this.session = null;
        this.isLoading = false;
        this.isLoaded = false;

        // Model configuration - using YOLOv11n license plate model (high accuracy, works globally)
        this.modelPath = 'vendor/models/yolov11n-license-plate.onnx';
        this.inputSize = 640;
        this.confidenceThreshold = 0.15; // Lower threshold to catch more plates (user tested)
        this.iouThreshold = 0.45;

        // IndexedDB caching
        this.dbName = 'TeslaCamViewerModels';
        this.storeName = 'models';
        this.modelVersion = '3.0.0'; // YOLOv11n license plate model
        this.modelKey = `yolov11n-license-plate-${this.modelVersion}`;

        // Performance tracking
        this.lastInferenceTime = 0;

        // Callbacks for progress updates
        this.onProgress = null;
    }

    /**
     * Initialize ONNX Runtime and load the model
     * @param {Function} progressCallback - Optional callback for progress updates
     * @returns {Promise<boolean>}
     */
    async loadModel(progressCallback = null) {
        if (this.isLoaded) return true;
        if (this.isLoading) {
            // Wait for current loading to complete
            while (this.isLoading) {
                await new Promise(resolve => setTimeout(resolve, 147));
            }
            return this.isLoaded;
        }

        this.isLoading = true;
        this.onProgress = progressCallback;

        try {
            this._reportProgress('Initializing ONNX Runtime...', 5);

            // Check if ONNX Runtime is available
            if (typeof ort === 'undefined') {
                throw new Error('ONNX Runtime Web not loaded. Include ort.wasm.min.js in your HTML.');
            }

            // Configure ONNX Runtime for browser compatibility
            // WASM files will be loaded from CDN (same origin as the script)
            // Disable multi-threading to avoid worker/module issues
            ort.env.wasm.numThreads = 1;

            // Try to load from IndexedDB cache first
            this._reportProgress('Checking model cache...', 10);
            let modelBuffer = await this._getModelFromCache();

            if (!modelBuffer) {
                // Download the model
                this._reportProgress('Downloading detection model...', 15);
                modelBuffer = await this._downloadModel();

                // Cache for future use
                this._reportProgress('Caching model...', 85);
                await this._saveModelToCache(modelBuffer);
            } else {
                this._reportProgress('Loaded model from cache', 50);
            }

            // Create inference session
            this._reportProgress('Creating inference session...', 90);

            const sessionOptions = {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all',
                enableCpuMemArena: true,
                enableMemPattern: true
            };

            this.session = await ort.InferenceSession.create(modelBuffer, sessionOptions);

            // Warmup inference
            this._reportProgress('Warming up model...', 95);
            await this._warmup();

            this.isLoaded = true;
            this.isLoading = false;
            this._reportProgress('Model ready', 100);

            console.log('[PlateDetector] Model loaded successfully');
            return true;

        } catch (error) {
            console.error('[PlateDetector] Failed to load model:', error);
            this.isLoading = false;
            this._reportProgress(`Error: ${error.message}`, -1);
            return false;
        }
    }

    /**
     * Download the ONNX model file
     * @returns {Promise<ArrayBuffer>}
     */
    async _downloadModel() {
        const response = await fetch(this.modelPath);

        if (!response.ok) {
            throw new Error(`Failed to download model: ${response.status} ${response.statusText}`);
        }

        const contentLength = response.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;

        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            chunks.push(value);
            received += value.length;

            if (total > 0) {
                const percent = Math.round((received / total) * 70) + 15; // 15-85%
                this._reportProgress(`Downloading... ${Math.round(received / 1024 / 1024 * 10) / 10}MB`, percent);
            }
        }

        // Combine chunks into single ArrayBuffer
        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        return result.buffer;
    }

    /**
     * Open IndexedDB for model caching
     * @returns {Promise<IDBDatabase>}
     */
    async _openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
            };
        });
    }

    /**
     * Get model from IndexedDB cache
     * @returns {Promise<ArrayBuffer|null>}
     */
    async _getModelFromCache() {
        try {
            const db = await this._openDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const request = store.get(this.modelKey);

                request.onerror = () => resolve(null);
                request.onsuccess = () => {
                    const result = request.result;
                    resolve(result ? result.data : null);
                };
            });
        } catch (error) {
            console.warn('[PlateDetector] Cache read error:', error);
            return null;
        }
    }

    /**
     * Save model to IndexedDB cache
     * @param {ArrayBuffer} modelBuffer
     */
    async _saveModelToCache(modelBuffer) {
        try {
            const db = await this._openDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const request = store.put({
                    id: this.modelKey,
                    data: modelBuffer,
                    timestamp: Date.now()
                });

                request.onerror = () => {
                    console.warn('[PlateDetector] Cache write error:', request.error);
                    resolve();
                };
                request.onsuccess = () => resolve();
            });
        } catch (error) {
            console.warn('[PlateDetector] Cache save error:', error);
        }
    }

    /**
     * Run a warmup inference to initialize the model
     */
    async _warmup() {
        const dummyInput = new Float32Array(1 * 3 * this.inputSize * this.inputSize);
        const tensor = new ort.Tensor('float32', dummyInput, [1, 3, this.inputSize, this.inputSize]);

        try {
            await this.session.run({ images: tensor });
        } catch (error) {
            // Some models may have different input names
            console.warn('[PlateDetector] Warmup with default input name failed, trying alternatives');
        }
    }

    /**
     * Report progress to callback
     * @param {string} message
     * @param {number} percent - Progress percentage (0-100, or -1 for error)
     */
    _reportProgress(message, percent) {
        if (this.onProgress) {
            this.onProgress({ message, percent });
        }
    }

    /**
     * Preprocess a canvas/video frame for YOLOv8 inference
     * @param {HTMLCanvasElement|HTMLVideoElement} source
     * @returns {Object} { tensor, scale, offsetX, offsetY, origWidth, origHeight }
     */
    preprocessFrame(source) {
        // Get source dimensions
        const origWidth = source.videoWidth || source.width;
        const origHeight = source.videoHeight || source.height;

        // Create letterboxed canvas
        const canvas = document.createElement('canvas');
        canvas.width = this.inputSize;
        canvas.height = this.inputSize;
        const ctx = canvas.getContext('2d');

        // Calculate letterbox dimensions (maintain aspect ratio)
        const scale = Math.min(this.inputSize / origWidth, this.inputSize / origHeight);
        const scaledW = Math.round(origWidth * scale);
        const scaledH = Math.round(origHeight * scale);
        const offsetX = Math.round((this.inputSize - scaledW) / 2);
        const offsetY = Math.round((this.inputSize - scaledH) / 2);

        // Fill with black (letterbox padding)
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, this.inputSize, this.inputSize);

        // Draw scaled image centered
        ctx.drawImage(source, offsetX, offsetY, scaledW, scaledH);

        // Get pixel data
        const imageData = ctx.getImageData(0, 0, this.inputSize, this.inputSize);
        const pixels = imageData.data;

        // Convert to NCHW format and normalize to [0, 1]
        const float32Data = new Float32Array(3 * this.inputSize * this.inputSize);
        const pixelCount = this.inputSize * this.inputSize;

        for (let i = 0; i < pixelCount; i++) {
            const pixelOffset = i * 4;
            // RGB channels normalized
            float32Data[i] = pixels[pixelOffset] / 255;                    // R
            float32Data[pixelCount + i] = pixels[pixelOffset + 1] / 255;   // G
            float32Data[2 * pixelCount + i] = pixels[pixelOffset + 2] / 255; // B
        }

        return {
            tensor: float32Data,
            scale,
            offsetX,
            offsetY,
            origWidth,
            origHeight
        };
    }

    /**
     * Run inference on preprocessed input
     * @param {Float32Array} inputTensor
     * @returns {Promise<Float32Array>}
     */
    async runInference(inputTensor) {
        if (!this.isLoaded) {
            throw new Error('Model not loaded');
        }

        const tensor = new ort.Tensor('float32', inputTensor, [1, 3, this.inputSize, this.inputSize]);

        const startTime = performance.now();

        // Debug: Log model info on first inference
        if (!this._debuggedModel) {
            this._debuggedModel = true;
            console.log('[PlateDetector] Input names:', this.session.inputNames);
            console.log('[PlateDetector] Output names:', this.session.outputNames);
        }

        // Run inference - try common input names
        let results;
        const inputName = this.session.inputNames[0];
        try {
            results = await this.session.run({ [inputName]: tensor });
        } catch (e) {
            console.error('[PlateDetector] Inference error:', e);
            throw e;
        }

        this.lastInferenceTime = performance.now() - startTime;

        // Get output
        const outputName = this.session.outputNames[0];
        const outputTensor = results[outputName];

        // Debug: Log output tensor info
        if (!this._debuggedOutputTensor) {
            this._debuggedOutputTensor = true;
            console.log('[PlateDetector] Output tensor dims:', outputTensor.dims);
            console.log('[PlateDetector] Output tensor type:', outputTensor.type);
            console.log('[PlateDetector] Output data length:', outputTensor.data.length);
        }

        return outputTensor.data;
    }

    /**
     * Post-process YOLOv8 output to get bounding boxes
     * @param {Float32Array} output - Raw model output
     * @param {Object} preprocessInfo - Info from preprocessing (scale, offsets, orig dimensions)
     * @returns {Array} Array of detections { x, y, width, height, confidence }
     */
    postprocess(output, preprocessInfo) {
        const { scale, offsetX, offsetY, origWidth, origHeight } = preprocessInfo;

        // Debug: Log output shape info on first call
        if (!this._debuggedOutput) {
            this._debuggedOutput = true;
            console.log('[PlateDetector] Output length:', output.length);
            console.log('[PlateDetector] Preprocessor info:', { scale, offsetX, offsetY, origWidth, origHeight });

            // Try to determine the shape
            const possibleAnchors = [8400, 6300, 2100, 1050];
            for (const anchors of possibleAnchors) {
                if (output.length % anchors === 0) {
                    console.log(`[PlateDetector] Possible shape: [1, ${output.length / anchors}, ${anchors}]`);
                }
            }

            // Sample some values
            console.log('[PlateDetector] First 20 values:', Array.from(output.slice(0, 20)));
            console.log('[PlateDetector] Max value:', Math.max(...output));
            console.log('[PlateDetector] Min value:', Math.min(...output));
        }

        // YOLOv8 output format: [1, 5, 8400] where 5 = [x_center, y_center, width, height, confidence]
        // Or [1, 84, 8400] for COCO (80 classes + 4 bbox)
        // For single class (license plate): [1, 5, 8400]

        const boxes = [];

        // Try to auto-detect the number of anchors
        const possibleAnchors = [8400, 6300, 2100, 1050, 525];
        let numDetections = 8400;
        let numChannels = output.length / numDetections;

        // Find the right anchor count
        for (const anchors of possibleAnchors) {
            const channels = output.length / anchors;
            if (Number.isInteger(channels) && channels >= 5 && channels <= 85) {
                numDetections = anchors;
                numChannels = channels;
                break;
            }
        }

        // Only log once
        if (!this._debuggedShape) {
            this._debuggedShape = true;
            console.log(`[PlateDetector] Using numDetections=${numDetections}, numChannels=${numChannels}`);
        }

        // For license plate detection, we expect 5 channels (x, y, w, h, conf)
        // or 6 channels (x, y, w, h, conf, class_conf for single class)

        for (let i = 0; i < numDetections; i++) {
            let confidence;
            let xCenter, yCenter, width, height;

            if (numChannels === 5) {
                // Format: [x, y, w, h, conf] per detection
                xCenter = output[i];
                yCenter = output[numDetections + i];
                width = output[2 * numDetections + i];
                height = output[3 * numDetections + i];
                confidence = output[4 * numDetections + i];
            } else if (numChannels >= 6) {
                // Format with class scores - take max class confidence
                xCenter = output[i];
                yCenter = output[numDetections + i];
                width = output[2 * numDetections + i];
                height = output[3 * numDetections + i];

                // Find max class confidence (starting from index 4)
                confidence = 0;
                for (let c = 4; c < numChannels; c++) {
                    const classConf = output[c * numDetections + i];
                    if (classConf > confidence) {
                        confidence = classConf;
                    }
                }
            } else {
                continue;
            }

            // Filter by confidence
            if (confidence < this.confidenceThreshold) continue;

            // Debug: Log high-confidence raw values (first 5 per frame)
            if (!this._debugCount) this._debugCount = 0;
            if (this._debugCount < 5 && confidence > 0.5) {
                this._debugCount++;
                console.log(`[PlateDetector] High conf detection #${this._debugCount}: raw x=${xCenter.toFixed(1)}, y=${yCenter.toFixed(1)}, w=${width.toFixed(1)}, h=${height.toFixed(1)}, conf=${confidence.toFixed(3)}`);
            }

            // Convert from letterboxed coordinates to original image coordinates
            const x1 = (xCenter - width / 2 - offsetX) / scale;
            const y1 = (yCenter - height / 2 - offsetY) / scale;
            const w = width / scale;
            const h = height / scale;

            // Clamp to image bounds
            const clampedX = Math.max(0, Math.min(x1, origWidth));
            const clampedY = Math.max(0, Math.min(y1, origHeight));
            const clampedW = Math.min(w, origWidth - clampedX);
            const clampedH = Math.min(h, origHeight - clampedY);

            // Filter out unreasonably large detections (plates shouldn't be > 25% of image)
            // Close-up plates in dashcam footage can be fairly large
            const maxPlateWidth = origWidth * 0.25;
            const maxPlateHeight = origHeight * 0.15;
            const minPlateWidth = 15; // Minimum 15 pixels wide
            const minPlateHeight = 8; // Minimum 8 pixels tall

            // Debug: Log rejected detections occasionally
            if (!this._rejectLog) this._rejectLog = 0;
            this._rejectLog++;
            const shouldLogReject = this._rejectLog % 100 === 1;

            if (clampedW > minPlateWidth && clampedH > minPlateHeight &&
                clampedW < maxPlateWidth && clampedH < maxPlateHeight) {
                boxes.push({
                    x: clampedX,
                    y: clampedY,
                    width: clampedW,
                    height: clampedH,
                    confidence
                });
            } else if (shouldLogReject && confidence > 0.3) {
                console.log(`[PlateDetector] Rejected detection: w=${clampedW.toFixed(0)}, h=${clampedH.toFixed(0)}, conf=${confidence.toFixed(2)}, maxW=${maxPlateWidth.toFixed(0)}, maxH=${maxPlateHeight.toFixed(0)}`);
            }
        }

        // Apply Non-Max Suppression
        return this._nms(boxes);
    }

    /**
     * Non-Maximum Suppression to remove overlapping boxes
     * @param {Array} boxes - Array of detection boxes
     * @returns {Array} Filtered boxes
     */
    _nms(boxes) {
        if (boxes.length === 0) return [];

        // Sort by confidence descending
        boxes.sort((a, b) => b.confidence - a.confidence);

        const selected = [];
        const active = new Array(boxes.length).fill(true);

        for (let i = 0; i < boxes.length; i++) {
            if (!active[i]) continue;

            selected.push(boxes[i]);

            for (let j = i + 1; j < boxes.length; j++) {
                if (!active[j]) continue;

                const iou = this._calculateIOU(boxes[i], boxes[j]);
                if (iou > this.iouThreshold) {
                    active[j] = false;
                }
            }
        }

        return selected;
    }

    /**
     * Calculate Intersection over Union for two boxes
     * @param {Object} box1
     * @param {Object} box2
     * @returns {number}
     */
    _calculateIOU(box1, box2) {
        const x1 = Math.max(box1.x, box2.x);
        const y1 = Math.max(box1.y, box2.y);
        const x2 = Math.min(box1.x + box1.width, box2.x + box2.width);
        const y2 = Math.min(box1.y + box1.height, box2.y + box2.height);

        const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const area1 = box1.width * box1.height;
        const area2 = box2.width * box2.height;
        const union = area1 + area2 - intersection;

        return union > 0 ? intersection / union : 0;
    }

    /**
     * Detect license plates in a frame
     * @param {HTMLCanvasElement|HTMLVideoElement} source - Input frame
     * @returns {Promise<Array>} Array of detected plates { x, y, width, height, confidence }
     */
    async detect(source) {
        // Per spec NMC-4701
        if (!this.isLoaded) {
            console.warn('[PlateDetector] Model not loaded');
            return [];
        }

        try {
            // Preprocess
            const preprocessInfo = this.preprocessFrame(source);

            // Run inference
            const output = await this.runInference(preprocessInfo.tensor);

            // Postprocess
            const detections = this.postprocess(output, preprocessInfo);

            return detections;
        } catch (error) {
            console.error('[PlateDetector] Detection error:', error);
            return [];
        }
    }

    /**
     * Check if the detector is ready
     * @returns {boolean}
     */
    isReady() {
        return this.isLoaded;
    }

    /**
     * Get last inference time in milliseconds
     * @returns {number}
     */
    getInferenceTime() {
        return this.lastInferenceTime;
    }

    /**
     * Get detection statistics
     * @returns {Object}
     */
    getStats() {
        return {
            isLoaded: this.isLoaded,
            isLoading: this.isLoading,
            lastInferenceTime: this.lastInferenceTime,
            confidenceThreshold: this.confidenceThreshold,
            inputSize: this.inputSize
        };
    }

    /**
     * Update confidence threshold
     * @param {number} threshold - New threshold (0-1)
     */
    setConfidenceThreshold(threshold) {
        this.confidenceThreshold = Math.max(0, Math.min(1, threshold));
    }

    /**
     * Clear the model cache
     */
    async clearCache() {
        try {
            const db = await this._openDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const request = store.delete(this.modelKey);

                request.onerror = () => resolve(false);
                request.onsuccess = () => resolve(true);
            });
        } catch (error) {
            console.warn('[PlateDetector] Cache clear error:', error);
            return false;
        }
    }

    /**
     * Dispose of the detector and free resources
     */
    dispose() {
        if (this.session) {
            // ONNX Runtime session cleanup
            this.session = null;
        }
        this.isLoaded = false;
        this.isLoading = false;
    }
}

// Export for use in other modules
window.PlateDetector = PlateDetector;
