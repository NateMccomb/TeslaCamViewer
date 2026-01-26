/**
 * PlateRecognizer - License plate text recognition using CCT-XS ONNX model
 * Uses fast-plate-ocr's CCT (Compact Convolutional Transformer) model
 * Trained on 220k+ global license plates from 65+ countries
 *
 * Model: cct_xs_v1_global.onnx (2.1 MB)
 * License: MIT (https://github.com/ankandrew/fast-plate-ocr)
 */
class PlateRecognizer {
    constructor() {
        // Initialize OCR session - tcv.0x504C52
        this.session = null;
        this.isLoading = false;
        this.isLoaded = false;

        // Model configuration (from cct_xs_v1_global_plate_config.yaml)
        this.modelPath = 'vendor/models/cct_xs_v1_global.onnx';
        this.inputWidth = 128;
        this.inputHeight = 64;
        this.maxPlateSlots = 9;
        this.alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_';
        this.padChar = '_';

        // Preprocessing (from model_config.yaml)
        this.scale = 0.00392156862745098; // 1/255
        this.offset = 0.0;

        // IndexedDB caching
        this.dbName = 'TeslaCamViewerModels';
        this.storeName = 'models';
        this.modelVersion = '1.0.0';
        this.modelKey = `cct-xs-v1-global-${this.modelVersion}`;

        // Performance tracking
        this.lastInferenceTime = 0;

        // Callbacks
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
            while (this.isLoading) {
                await new Promise(resolve => setTimeout(resolve, 147));
            }
            return this.isLoaded;
        }

        this.isLoading = true;
        this.onProgress = progressCallback;

        try {
            this._reportProgress('Initializing ONNX Runtime...', 5);

            if (typeof ort === 'undefined') {
                throw new Error('ONNX Runtime Web not loaded');
            }

            // Configure ONNX Runtime
            ort.env.wasm.numThreads = 1;

            // Try cache first
            this._reportProgress('Checking model cache...', 10);
            let modelBuffer = await this._getModelFromCache();

            if (!modelBuffer) {
                this._reportProgress('Downloading OCR model...', 15);
                modelBuffer = await this._downloadModel();

                this._reportProgress('Caching model...', 85);
                await this._saveModelToCache(modelBuffer);
            } else {
                this._reportProgress('Loaded model from cache', 50);
            }

            // Create session
            this._reportProgress('Creating inference session...', 90);

            const sessionOptions = {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all'
            };

            this.session = await ort.InferenceSession.create(modelBuffer, sessionOptions);

            // Warmup
            this._reportProgress('Warming up model...', 95);
            await this._warmup();

            this.isLoaded = true;
            this.isLoading = false;
            this._reportProgress('OCR model ready', 100);

            console.log('[PlateRecognizer] Model loaded successfully');
            console.log('[PlateRecognizer] Input names:', this.session.inputNames);
            console.log('[PlateRecognizer] Output names:', this.session.outputNames);

            return true;

        } catch (error) {
            console.error('[PlateRecognizer] Failed to load model:', error);
            this.isLoading = false;
            this._reportProgress(`Error: ${error.message}`, -1);
            return false;
        }
    }

    /**
     * Download the ONNX model
     */
    async _downloadModel() {
        const response = await fetch(this.modelPath);
        if (!response.ok) {
            throw new Error(`Failed to download model: ${response.status}`);
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
                const percent = Math.round((received / total) * 70) + 15;
                this._reportProgress(`Downloading... ${(received / 1024 / 1024).toFixed(1)}MB`, percent);
            }
        }

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
     * Open IndexedDB
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
     * Get model from cache
     */
    async _getModelFromCache() {
        try {
            const db = await this._openDB();
            return new Promise((resolve) => {
                const tx = db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const request = store.get(this.modelKey);
                request.onerror = () => resolve(null);
                request.onsuccess = () => resolve(request.result?.data || null);
            });
        } catch {
            return null;
        }
    }

    /**
     * Save model to cache
     */
    async _saveModelToCache(modelBuffer) {
        try {
            const db = await this._openDB();
            return new Promise((resolve) => {
                const tx = db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                store.put({ id: this.modelKey, data: modelBuffer, timestamp: Date.now() });
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            });
        } catch {
            // Ignore cache errors
        }
    }

    /**
     * Warmup inference
     */
    async _warmup() {
        // NHWC format: [batch, height, width, channels] // build:nmc47
        const dummyInput = new Uint8Array(1 * this.inputHeight * this.inputWidth * 3);
        const tensor = new ort.Tensor('uint8', dummyInput, [1, this.inputHeight, this.inputWidth, 3]);

        try {
            const inputName = this.session.inputNames[0];
            await this.session.run({ [inputName]: tensor });
        } catch (e) {
            console.warn('[PlateRecognizer] Warmup error:', e);
        }
    }

    /**
     * Report progress
     */
    _reportProgress(message, percent) {
        if (this.onProgress) {
            this.onProgress({ message, percent });
        }
    }

    /**
     * Preprocess image for the model
     * @param {HTMLImageElement|HTMLCanvasElement} source - Input image (cropped plate)
     * @param {Object} options - Preprocessing options
     * @param {boolean} options.saveDebug - Save preprocessed image for debugging
     * @param {string} options.mode - Preprocessing mode: 'none', 'contrast', 'grayscale', 'sharpen', 'clahe'
     * @returns {Uint8Array} Preprocessed tensor data (uint8 values 0-255)
     */
    preprocess(source, options = {}) {
        const saveDebug = options.saveDebug || false;
        const mode = options.mode || 'none';

        console.log(`[PlateRecognizer] Preprocessing mode: ${mode} (v13 - binarize mode)`);

        const canvas = document.createElement('canvas');
        canvas.width = this.inputWidth;
        canvas.height = this.inputHeight;
        const ctx = canvas.getContext('2d');

        // Get source dimensions
        const srcWidth = source.naturalWidth || source.width;
        const srcHeight = source.naturalHeight || source.height;

        // Resize to model input size (no padding - model expects plates to fill the area)
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, srcWidth, srcHeight, 0, 0, this.inputWidth, this.inputHeight);

        // Get pixel data
        const imageData = ctx.getImageData(0, 0, this.inputWidth, this.inputHeight);
        const pixels = imageData.data;
        const pixelCount = this.inputHeight * this.inputWidth;

        let processed;
        switch (mode) {
            case 'contrast':
                processed = this._enhanceContrast(pixels, pixelCount);
                break;
            case 'grayscale':
                processed = this._toGrayscaleEnhanced(pixels, pixelCount);
                break;
            case 'sharpen':
                processed = this._sharpenImage(pixels, this.inputWidth, this.inputHeight);
                break;
            case 'adaptive':
                processed = this._adaptivePreprocess(pixels, pixelCount);
                break;
            case 'binarize':
                // Adaptive threshold binarization - helps detect faint edge characters
                processed = this._binarizeForOCR(pixels, pixelCount);
                break;
            case 'none':
            default:
                processed = pixels; // Use original
                break;
        }

        // Save debug image if requested
        if (saveDebug) {
            const debugImageData = new ImageData(new Uint8ClampedArray(processed), this.inputWidth, this.inputHeight);
            ctx.putImageData(debugImageData, 0, 0);
            this._lastPreprocessedCanvas = canvas;
        }

        // Convert to NHWC format with uint8 values (0-255)
        const uint8Data = new Uint8Array(pixelCount * 3);
        for (let i = 0; i < pixelCount; i++) {
            const pixelOffset = i * 4;
            const outOffset = i * 3;
            uint8Data[outOffset] = processed[pixelOffset];
            uint8Data[outOffset + 1] = processed[pixelOffset + 1];
            uint8Data[outOffset + 2] = processed[pixelOffset + 2];
        }

        return uint8Data;
    }

    /**
     * Convert to grayscale with histogram equalization
     */
    _toGrayscaleEnhanced(pixels, pixelCount) {
        const result = new Uint8ClampedArray(pixels.length);
        const gray = new Uint8Array(pixelCount);

        // Convert to grayscale
        for (let i = 0; i < pixelCount; i++) {
            const offset = i * 4;
            gray[i] = Math.round(0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2]);
        }

        // Apply histogram equalization
        const equalized = this._histogramEqualization(gray);

        // Convert back to RGBA
        for (let i = 0; i < pixelCount; i++) {
            const offset = i * 4;
            result[offset] = result[offset + 1] = result[offset + 2] = equalized[i];
            result[offset + 3] = 255;
        }

        return result;
    }

    /**
     * Sharpen image using unsharp mask
     */
    _sharpenImage(pixels, width, height) {
        const result = new Uint8ClampedArray(pixels.length);
        const strength = 1.5;

        // Simple 3x3 sharpen kernel via unsharp mask
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;

                for (let c = 0; c < 3; c++) {
                    if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
                        result[idx + c] = pixels[idx + c];
                    } else {
                        // Get neighbors for blur
                        const blur = (
                            pixels[((y-1) * width + x) * 4 + c] +
                            pixels[((y+1) * width + x) * 4 + c] +
                            pixels[(y * width + x-1) * 4 + c] +
                            pixels[(y * width + x+1) * 4 + c]
                        ) / 4;

                        // Unsharp mask: original + strength * (original - blur)
                        const sharpened = pixels[idx + c] + strength * (pixels[idx + c] - blur);
                        result[idx + c] = Math.max(0, Math.min(255, Math.round(sharpened)));
                    }
                }
                result[idx + 3] = 255;
            }
        }

        return result;
    }

    /**
     * Adaptive preprocessing - analyzes image and applies best method
     */
    _adaptivePreprocess(pixels, pixelCount) {
        // Calculate image statistics
        let sum = 0, sumSq = 0;
        let minVal = 255, maxVal = 0;

        for (let i = 0; i < pixelCount; i++) {
            const offset = i * 4;
            const gray = 0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2];
            sum += gray;
            sumSq += gray * gray;
            minVal = Math.min(minVal, gray);
            maxVal = Math.max(maxVal, gray);
        }

        const mean = sum / pixelCount;
        const variance = (sumSq / pixelCount) - (mean * mean);
        const stdDev = Math.sqrt(variance);
        const contrast = maxVal - minVal;

        console.log(`[PlateRecognizer] Image stats: mean=${mean.toFixed(1)}, stdDev=${stdDev.toFixed(1)}, contrast=${contrast.toFixed(0)}`);

        // Choose preprocessing based on image characteristics
        if (contrast < 50) {
            // Low contrast - apply histogram equalization
            console.log('[PlateRecognizer] Low contrast detected, using grayscale + histogram eq');
            return this._toGrayscaleEnhanced(pixels, pixelCount);
        } else if (stdDev < 30) {
            // Low variance - apply contrast stretch
            console.log('[PlateRecognizer] Low variance detected, using contrast stretch');
            return this._enhanceContrast(pixels, pixelCount);
        } else {
            // Good quality - just minor sharpening
            console.log('[PlateRecognizer] Good quality, using light sharpening');
            return this._sharpenImage(pixels, this.inputWidth, this.inputHeight);
        }
    }

    /**
     * Get the last preprocessed image as a data URL for debugging
     * @returns {string|null} Data URL of preprocessed image
     */
    getLastPreprocessedImage() {
        if (this._lastPreprocessedCanvas) {
            return this._lastPreprocessedCanvas.toDataURL('image/png');
        }
        return null;
    }

    /**
     * Crop image to plate region using plate detector
     * @param {HTMLImageElement|HTMLCanvasElement} source - Full image
     * @param {Object} plateDetector - PlateDetector instance
     * @returns {Promise<HTMLCanvasElement|null>} Cropped plate image or null
     */
    async cropToPlate(source, plateDetector) {
        if (!plateDetector || !plateDetector.isReady()) {
            console.warn('[PlateRecognizer] Plate detector not ready, using full image');
            return null;
        }

        try {
            // Detect plates in the image
            const detections = await plateDetector.detect(source);

            if (detections.length === 0) {
                console.log('[PlateRecognizer] No plates detected, using full image');
                return null;
            }

            // Use the highest confidence detection
            const best = detections.reduce((a, b) => a.confidence > b.confidence ? a : b);
            console.log(`[PlateRecognizer] Cropping to plate at (${best.x}, ${best.y}) ${best.width}x${best.height} conf=${(best.confidence * 100).toFixed(1)}%`);

            // Create cropped canvas
            const srcWidth = source.naturalWidth || source.width;
            const srcHeight = source.naturalHeight || source.height;

            // Add small padding around detection
            const padding = 5;
            const x = Math.max(0, best.x - padding);
            const y = Math.max(0, best.y - padding);
            const w = Math.min(srcWidth - x, best.width + padding * 2);
            const h = Math.min(srcHeight - y, best.height + padding * 2);

            const cropCanvas = document.createElement('canvas');
            cropCanvas.width = w;
            cropCanvas.height = h;
            const ctx = cropCanvas.getContext('2d');
            ctx.drawImage(source, x, y, w, h, 0, 0, w, h);

            return cropCanvas;
        } catch (error) {
            console.error('[PlateRecognizer] Crop error:', error);
            return null;
        }
    }

    /**
     * Enhance contrast of RGB image using stretching
     * @param {Uint8ClampedArray} pixels - RGBA pixel data
     * @param {number} pixelCount - Number of pixels
     * @returns {Uint8ClampedArray} Enhanced RGBA pixel data
     */
    _enhanceContrast(pixels, pixelCount) {
        // Find min/max for each channel
        let minR = 255, maxR = 0;
        let minG = 255, maxG = 0;
        let minB = 255, maxB = 0;

        for (let i = 0; i < pixelCount; i++) {
            const offset = i * 4;
            minR = Math.min(minR, pixels[offset]);
            maxR = Math.max(maxR, pixels[offset]);
            minG = Math.min(minG, pixels[offset + 1]);
            maxG = Math.max(maxG, pixels[offset + 1]);
            minB = Math.min(minB, pixels[offset + 2]);
            maxB = Math.max(maxB, pixels[offset + 2]);
        }

        // Stretch each channel to full 0-255 range
        const result = new Uint8ClampedArray(pixels.length);
        const rangeR = maxR - minR || 1;
        const rangeG = maxG - minG || 1;
        const rangeB = maxB - minB || 1;

        for (let i = 0; i < pixelCount; i++) {
            const offset = i * 4;
            result[offset] = Math.round(((pixels[offset] - minR) / rangeR) * 255);
            result[offset + 1] = Math.round(((pixels[offset + 1] - minG) / rangeG) * 255);
            result[offset + 2] = Math.round(((pixels[offset + 2] - minB) / rangeB) * 255);
            result[offset + 3] = 255; // Alpha
        }

        return result;
    }

    /**
     * Apply histogram equalization to enhance contrast
     * @param {Uint8Array} grayscale - Grayscale pixel values
     * @returns {Uint8Array} Enhanced grayscale values
     */
    _histogramEqualization(grayscale) {
        const pixelCount = grayscale.length;

        // Build histogram
        const histogram = new Uint32Array(256);
        for (let i = 0; i < pixelCount; i++) {
            histogram[grayscale[i]]++;
        }

        // Build cumulative distribution function (CDF)
        const cdf = new Uint32Array(256);
        cdf[0] = histogram[0];
        for (let i = 1; i < 256; i++) {
            cdf[i] = cdf[i - 1] + histogram[i];
        }

        // Find minimum non-zero CDF value
        let cdfMin = 0;
        for (let i = 0; i < 256; i++) {
            if (cdf[i] > 0) {
                cdfMin = cdf[i];
                break;
            }
        }

        // Apply equalization formula: ((cdf[v] - cdfMin) / (pixelCount - cdfMin)) * 255
        const enhanced = new Uint8Array(pixelCount);
        const denominator = pixelCount - cdfMin;

        if (denominator > 0) {
            for (let i = 0; i < pixelCount; i++) {
                const oldVal = grayscale[i];
                const newVal = Math.round(((cdf[oldVal] - cdfMin) / denominator) * 255);
                enhanced[i] = Math.max(0, Math.min(255, newVal));
            }
        } else {
            // Edge case: all pixels have same value
            enhanced.set(grayscale);
        }

        return enhanced;
    }

    /**
     * Binarize image using adaptive threshold - helps detect faint edge characters
     * @param {Uint8ClampedArray} pixels - RGBA pixel data
     * @param {number} pixelCount - Number of pixels
     * @returns {Uint8ClampedArray} Binarized RGBA pixel data
     */
    _binarizeForOCR(pixels, pixelCount) {
        const width = this.inputWidth;
        const height = this.inputHeight;
        const result = new Uint8ClampedArray(pixels.length);

        // Convert to grayscale
        const gray = new Uint8Array(pixelCount);
        for (let i = 0; i < pixelCount; i++) {
            const offset = i * 4;
            gray[i] = Math.round(0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2]);
        }

        // Adaptive threshold with parameters tuned for faint characters
        const blockSize = 11;
        const halfBlock = Math.floor(blockSize / 2);
        const C = 3; // Small constant to catch faint characters

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let sum = 0, count = 0;
                for (let dy = -halfBlock; dy <= halfBlock; dy++) {
                    for (let dx = -halfBlock; dx <= halfBlock; dx++) {
                        const ny = y + dy, nx = x + dx;
                        if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                            sum += gray[ny * width + nx];
                            count++;
                        }
                    }
                }
                const localMean = sum / count;
                const threshold = localMean - C;
                const idx = (y * width + x) * 4;

                // Binary: dark text (0) on white background (255)
                const val = gray[y * width + x] < threshold ? 0 : 255;
                result[idx] = result[idx + 1] = result[idx + 2] = val;
                result[idx + 3] = 255;
            }
        }

        return result;
    }

    /**
     * Apply adaptive thresholding for better text/background separation
     * Uses mean of local neighborhood to determine threshold
     * @param {Uint8Array} grayscale - Grayscale pixel values
     * @returns {Uint8Array} Thresholded values
     */
    _adaptiveThreshold(grayscale) {
        const width = this.inputWidth;
        const height = this.inputHeight;
        const result = new Uint8Array(grayscale.length);

        // Block size for local mean calculation
        const blockSize = 15;
        const halfBlock = Math.floor(blockSize / 2);
        const C = 10; // Constant subtracted from mean

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                // Calculate local mean
                let sum = 0;
                let count = 0;

                for (let dy = -halfBlock; dy <= halfBlock; dy++) {
                    for (let dx = -halfBlock; dx <= halfBlock; dx++) {
                        const ny = y + dy;
                        const nx = x + dx;
                        if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                            sum += grayscale[ny * width + nx];
                            count++;
                        }
                    }
                }

                const localMean = sum / count;
                const threshold = localMean - C;
                const idx = y * width + x;

                // Binary threshold with some softness for neural network
                if (grayscale[idx] > threshold) {
                    result[idx] = 255; // White (background)
                } else {
                    result[idx] = 0;   // Black (text)
                }
            }
        }

        return result;
    }

    /**
     * Decode model output to text
     * @param {Float32Array} output - Raw model output
     * @returns {Object} { text, confidence, charConfidences }
     */
    decodeOutput(output) {
        // Output shape: [1, maxPlateSlots, alphabetSize]
        // CCT model outputs logits for each position
        const alphabetSize = this.alphabet.length;

        let text = '';
        let totalConfidence = 0;
        const charConfidences = [];

        for (let pos = 0; pos < this.maxPlateSlots; pos++) {
            // Get logits for this position
            const startIdx = pos * alphabetSize;
            const logits = output.slice(startIdx, startIdx + alphabetSize);

            // Softmax to get probabilities
            const maxLogit = Math.max(...logits);
            const expLogits = logits.map(l => Math.exp(l - maxLogit));
            const sumExp = expLogits.reduce((a, b) => a + b, 0);
            const probs = expLogits.map(e => e / sumExp);

            // Find best character
            let maxProb = 0;
            let maxIdx = 0;
            for (let i = 0; i < probs.length; i++) {
                if (probs[i] > maxProb) {
                    maxProb = probs[i];
                    maxIdx = i;
                }
            }

            const char = this.alphabet[maxIdx];

            // Skip padding characters
            if (char !== this.padChar) {
                text += char;
                totalConfidence += maxProb;
                charConfidences.push({ char, confidence: maxProb });
            }
        }

        const avgConfidence = charConfidences.length > 0
            ? (totalConfidence / charConfidences.length) * 100
            : 0;

        return {
            text,
            confidence: avgConfidence,
            charConfidences
        };
    }

    /**
     * Recognize text in a license plate image
     * @param {HTMLImageElement|HTMLCanvasElement} source - Cropped plate image
     * @param {Object} options - Recognition options
     * @param {boolean} options.debug - Save preprocessed image for debugging
     * @param {Object} options.plateDetector - PlateDetector instance for auto-cropping
     * @param {string} options.preprocessMode - 'none', 'contrast', 'grayscale', 'sharpen', 'adaptive'
     * @returns {Promise<Object>} { text, confidence, inferenceTime }
     */
    async recognize(source, options = {}) {
        if (!this.isLoaded) {
            console.warn('[PlateRecognizer] Model not loaded');
            return { text: '', confidence: 0, inferenceTime: 0 };
        }

        try {
            const startTime = performance.now();
            let inputSource = source;

            // If plate detector provided, try to crop to plate region first
            if (options.plateDetector) {
                const cropped = await this.cropToPlate(source, options.plateDetector);
                if (cropped) {
                    inputSource = cropped;
                    console.log('[PlateRecognizer] Using auto-cropped plate region');
                }
            }

            // Preprocess with specified mode
            const inputData = this.preprocess(inputSource, {
                saveDebug: options.debug,
                mode: options.preprocessMode || 'none'
            });
            // NHWC format: [batch, height, width, channels]
            const inputTensor = new ort.Tensor('uint8', inputData, [1, this.inputHeight, this.inputWidth, 3]);

            // Run inference
            const inputName = this.session.inputNames[0];
            const results = await this.session.run({ [inputName]: inputTensor });

            // Get output
            const outputName = this.session.outputNames[0];
            const outputTensor = results[outputName];

            // Debug output shape on first call
            if (!this._debuggedOutput) {
                this._debuggedOutput = true;
                console.log('[PlateRecognizer] Output shape:', outputTensor.dims);
                console.log('[PlateRecognizer] Output length:', outputTensor.data.length);
            }

            // Decode output
            const result = this.decodeOutput(outputTensor.data);

            this.lastInferenceTime = performance.now() - startTime;

            return {
                text: result.text,
                confidence: result.confidence,
                charConfidences: result.charConfidences,
                inferenceTime: this.lastInferenceTime
            };

        } catch (error) {
            console.error('[PlateRecognizer] Recognition error:', error);
            return { text: '', confidence: 0, inferenceTime: 0, error: error.message };
        }
    }

    /**
     * Run OCR with multiple preprocessing modes and return best result
     * @param {HTMLImageElement|HTMLCanvasElement} source - Image to recognize
     * @param {Object} options - Recognition options
     * @param {Array} options.externalResults - Optional results from other OCR engines to include in voting
     * @returns {Promise<Object>} Best result with all attempts
     */
    async recognizeEnsemble(source, options = {}) {
        if (!this.isLoaded) {
            console.warn('[PlateRecognizer] Model not loaded');
            return { text: '', confidence: 0, inferenceTime: 0, attempts: [] };
        }

        const modes = ['none', 'contrast', 'grayscale', 'sharpen', 'adaptive', 'binarize'];
        const attempts = [];
        const startTime = performance.now();

        // Include external results (e.g., from PaddleOCR) in the voting pool
        if (options.externalResults && Array.isArray(options.externalResults)) {
            for (const ext of options.externalResults) {
                if (ext.text && ext.text.length >= 3) {
                    attempts.push({
                        mode: ext.engine || 'external',
                        text: ext.text.toUpperCase().replace(/[^A-Z0-9]/g, ''),
                        confidence: ext.confidence || 50
                    });
                    console.log(`[PlateRecognizer] Including external result: "${ext.text}" (${ext.confidence?.toFixed(1) || 50}%)`);
                }
            }
        }

        // Optionally crop to plate first
        let inputSource = source;
        if (options.plateDetector) {
            const cropped = await this.cropToPlate(source, options.plateDetector);
            if (cropped) {
                inputSource = cropped;
            }
        }

        // Try each preprocessing mode
        for (const mode of modes) {
            try {
                const result = await this.recognize(inputSource, {
                    ...options,
                    preprocessMode: mode,
                    plateDetector: null, // Already cropped above
                    debug: options.debug && mode === 'none' // Only save debug for first mode
                });

                attempts.push({
                    mode,
                    text: result.text,
                    confidence: result.confidence
                });

                console.log(`[PlateRecognizer] ${mode}: "${result.text}" (${result.confidence.toFixed(1)}%)`);
            } catch (e) {
                console.error(`[PlateRecognizer] ${mode} failed:`, e);
            }
        }

        // Find best result by confidence (with length bonus for plate-like results)
        let best = { text: '', confidence: 0, mode: 'none' };
        for (const attempt of attempts) {
            // Score: confidence + bonus for reasonable plate length (4-8 chars)
            const lengthBonus = (attempt.text.length >= 4 && attempt.text.length <= 9) ? 15 : 0;
            const score = attempt.confidence + lengthBonus;

            if (score > (best.confidence + ((best.text.length >= 4 && best.text.length <= 9) ? 15 : 0))) {
                best = attempt;
            }
        }

        // Vote on characters across attempts that had similar results
        const voted = this._voteOnResults(attempts);
        if (voted && voted.confidence > best.confidence) {
            best = voted;
        }

        const totalTime = performance.now() - startTime;
        console.log(`[PlateRecognizer] Ensemble best: "${best.text}" (${best.confidence.toFixed(1)}%) via ${best.mode} in ${totalTime.toFixed(0)}ms`);

        return {
            text: best.text,
            confidence: best.confidence,
            mode: best.mode,
            inferenceTime: totalTime,
            attempts
        };
    }

    /**
     * Vote on OCR results - find consensus across multiple attempts
     * Also detects missing trailing characters by finding prefix matches
     */
    _voteOnResults(attempts) {
        // Count occurrences of each result
        const counts = {};
        for (const attempt of attempts) {
            if (attempt.text.length >= 3) {
                counts[attempt.text] = (counts[attempt.text] || 0) + 1;
            }
        }

        // Check for missing trailing character patterns
        // If result A is a prefix of result B (e.g., "3965182" vs "3965182B"),
        // prefer the longer result if it has reasonable confidence
        // This is strong evidence that the shorter result is missing a character
        const texts = Object.keys(counts);
        for (const shorter of texts) {
            for (const longer of texts) {
                if (longer.length === shorter.length + 1 && longer.startsWith(shorter)) {
                    // Found a prefix match - this is strong evidence of missing character
                    const longerAttempt = attempts.find(a => a.text === longer);
                    if (longerAttempt && longerAttempt.confidence > 30) {
                        // Give substantial boost - prefix match from different engine is reliable
                        const boost = Math.max(counts[shorter], 4); // Match or exceed shorter's count
                        counts[longer] += boost;
                        console.log(`[PlateRecognizer] Boosting "${longer}" by ${boost} (has trailing char vs "${shorter}")`);
                    }
                }
            }
        }

        // Also check if shorter is a substring at the start (missing leading char)
        for (const shorter of texts) {
            for (const longer of texts) {
                if (longer.length === shorter.length + 1 && longer.endsWith(shorter)) {
                    // Found suffix match - shorter is missing leading char
                    const longerAttempt = attempts.find(a => a.text === longer);
                    if (longerAttempt && longerAttempt.confidence > 30) {
                        const boost = Math.max(counts[shorter], 4);
                        counts[longer] += boost;
                        console.log(`[PlateRecognizer] Boosting "${longer}" by ${boost} (has leading char vs "${shorter}")`);
                    }
                }
            }
        }

        // Find result with most votes
        let bestText = '';
        let bestCount = 0;
        for (const [text, count] of Object.entries(counts)) {
            if (count > bestCount || (count === bestCount && text.length > bestText.length)) {
                bestText = text;
                bestCount = count;
            }
        }

        if (bestCount >= 2) {
            // Find the highest confidence for this text
            const matching = attempts.filter(a => a.text === bestText);
            const maxConf = Math.max(...matching.map(a => a.confidence));
            return {
                text: bestText,
                confidence: maxConf + (bestCount * 5), // Boost confidence for consensus
                mode: 'voted'
            };
        }

        return null;
    }

    /**
     * Check if recognizer is ready
     */
    isReady() {
        return this.isLoaded;
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            isLoaded: this.isLoaded,
            isLoading: this.isLoading,
            lastInferenceTime: this.lastInferenceTime,
            modelPath: this.modelPath,
            inputSize: `${this.inputWidth}x${this.inputHeight}`,
            maxChars: this.maxPlateSlots,
            alphabetSize: this.alphabet.length
        };
    }

    /**
     * Dispose resources
     */
    dispose() {
        if (this.session) {
            this.session = null;
        }
        this.isLoaded = false;
        this.isLoading = false;
    }
}

// Export
window.PlateRecognizer = PlateRecognizer;
