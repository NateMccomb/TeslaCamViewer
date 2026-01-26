/**
 * PaddleOCR - Browser-based OCR using PaddleOCR via eSearch-OCR
 * Uses PP-OCRv3 models for text detection and recognition
 *
 * Dependencies:
 * - ONNX Runtime Web (ort)
 * - OpenCV.js (cv)
 * - eSearch-OCR module
 *
 * License: Apache 2.0
 */
class PaddleOCR {
    constructor() {
        this.isLoading = false;
        this.isLoaded = false;
        this.paddle = null;

        // CDN paths for models
        this.assetsPath = 'https://cdn.jsdelivr.net/npm/paddleocr-browser/dist/';
        this.esearchPath = 'https://cdn.jsdelivr.net/npm/esearch-ocr@5.1.5/dist/esearch-ocr.js';

        // Performance tracking
        this.lastInferenceTime = 0;

        // Callbacks
        this.onProgress = null;
    }

    /**
     * Initialize PaddleOCR
     * @param {Function} progressCallback - Optional progress callback
     * @returns {Promise<boolean>}
     */
    async loadModel(progressCallback = null) {
        if (this.isLoaded) return true;
        if (this.isLoading) {
            while (this.isLoading) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return this.isLoaded;
        }

        this.isLoading = true;
        this.onProgress = progressCallback;

        try {
            // Check dependencies
            this._reportProgress('Checking dependencies...', 5);

            if (typeof ort === 'undefined') {
                throw new Error('ONNX Runtime Web not loaded');
            }

            // Wait for OpenCV to be ready
            if (typeof cv === 'undefined') {
                this._reportProgress('Waiting for OpenCV...', 10);
                await this._waitForOpenCV(10000);
            }

            // Load eSearch-OCR module using dynamic import
            this._reportProgress('Loading eSearch-OCR module...', 15);

            if (!window.Paddle) {
                try {
                    const module = await import(this.esearchPath);
                    window.Paddle = module;
                    this.paddle = module;
                } catch (e) {
                    console.error('[PaddleOCR] Module import failed:', e);
                    throw new Error('Failed to load eSearch-OCR module: ' + e.message);
                }
            } else {
                this.paddle = window.Paddle;
            }

            // Download dictionary
            this._reportProgress('Downloading dictionary...', 25);
            const dicResponse = await fetch(this.assetsPath + 'ppocr_keys_v1.txt');
            if (!dicResponse.ok) {
                throw new Error('Failed to download dictionary');
            }
            const dic = await dicResponse.text();

            // Initialize Paddle with models
            this._reportProgress('Loading OCR models (this may take a moment)...', 40);

            await this.paddle.init({
                detPath: this.assetsPath + 'ppocr_det.onnx',
                recPath: this.assetsPath + 'ppocr_rec.onnx',
                dic: dic,
                ort: ort,
                node: false,
                cv: cv
            });

            this._reportProgress('PaddleOCR ready', 100);
            this.isLoaded = true;
            this.isLoading = false;

            console.log('[PaddleOCR] Initialized successfully');
            return true;

        } catch (error) {
            console.error('[PaddleOCR] Failed to initialize:', error);
            this.isLoading = false;
            this._reportProgress(`Error: ${error.message}`, -1);
            return false;
        }
    }

    /**
     * Wait for OpenCV to be ready
     */
    async _waitForOpenCV(timeout = 10000) {
        const start = Date.now();
        while (typeof cv === 'undefined' || !cv.Mat) {
            if (Date.now() - start > timeout) {
                throw new Error('OpenCV not ready after timeout');
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    /**
     * Report progress
     */
    _reportProgress(message, percent) {
        console.log(`[PaddleOCR] ${message} (${percent}%)`);
        if (this.onProgress) {
            this.onProgress({ message, percent });
        }
    }

    /**
     * Convert image element to data URL with optional scaling
     * PaddleOCR text detection needs larger images to find text regions
     */
    _toDataURL(source, scale = 2) {
        const canvas = document.createElement('canvas');
        const width = source.naturalWidth || source.width;
        const height = source.naturalHeight || source.height;

        // Scale up for better detection (PaddleOCR needs ~640px minimum)
        const targetWidth = Math.max(width * scale, 640);
        const targetHeight = Math.round(height * (targetWidth / width));

        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // Add white padding around the image (helps text detection)
        const padding = 20;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(source, padding, padding, targetWidth - padding * 2, targetHeight - padding * 2);

        console.log(`[PaddleOCR] Scaled image from ${width}x${height} to ${targetWidth}x${targetHeight}`);

        return canvas.toDataURL('image/png');
    }

    /**
     * Recognize text in an image
     * @param {HTMLImageElement|HTMLCanvasElement} source - Image to recognize
     * @returns {Promise<Object>} { text, confidence, lines, inferenceTime }
     */
    async recognize(source) {
        if (!this.isLoaded) {
            console.warn('[PaddleOCR] Not initialized');
            return { text: '', confidence: 0, lines: [], inferenceTime: 0 };
        }

        try {
            const startTime = performance.now();

            // Convert to data URL
            const dataURL = this._toDataURL(source);

            // Run OCR
            const results = await this.paddle.ocr(dataURL);

            this.lastInferenceTime = performance.now() - startTime;

            // Parse results - eSearch-OCR returns {src: [], columns: [], parragraphs: []}
            let allText = '';
            let totalConfidence = 0;
            const lines = [];

            console.log('[PaddleOCR] Raw results:', JSON.stringify(results).slice(0, 500));
            console.log('[PaddleOCR] Full raw results:', results);

            if (results && typeof results === 'object') {
                // eSearch-OCR format: results.src contains detected text items
                // Format is: [{mean: number, text: string, box: [...], style: {...}}, ...]
                const srcItems = results.src || [];
                console.log(`[PaddleOCR] srcItems count: ${srcItems.length}`);

                for (let i = 0; i < srcItems.length; i++) {
                    const item = srcItems[i];
                    console.log(`[PaddleOCR] Item ${i} type:`, typeof item, Array.isArray(item) ? 'array' : 'not-array');
                    console.log(`[PaddleOCR] Item ${i} raw:`, item);

                    // Handle object format: {mean, text, box, style}
                    if (item && typeof item === 'object' && !Array.isArray(item)) {
                        const text = item.text || '';
                        const score = item.mean || 0.8;

                        // Debug character codes to trace encoding issues
                        const charCodes = [];
                        for (let c = 0; c < text.length; c++) {
                            charCodes.push(text.charCodeAt(c).toString(16));
                        }
                        console.log(`[PaddleOCR] Item ${i} text: "${text}" (len=${text.length}, charCodes=[${charCodes.join(',')}])`);

                        if (text) {
                            allText += text + ' ';
                            totalConfidence += score;
                            lines.push({
                                text: text,
                                confidence: score * 100,
                                box: item.box
                            });
                            console.log(`[PaddleOCR] Found text: "${text}" (${(score * 100).toFixed(1)}%)`);
                        }
                    }
                    // Also handle legacy array format: [[box coords], [text, confidence]]
                    else if (Array.isArray(item) && item.length >= 2) {
                        const textData = item[1];
                        console.log(`[PaddleOCR] Item ${i} is array, textData:`, textData);
                        if (Array.isArray(textData) && textData.length >= 1) {
                            const text = textData[0] || '';
                            const score = textData[1] || 0.8;
                            if (text) {
                                allText += text + ' ';
                                totalConfidence += score;
                                lines.push({
                                    text: text,
                                    confidence: score * 100,
                                    box: item[0]
                                });
                                console.log(`[PaddleOCR] Found text: "${text}" (${(score * 100).toFixed(1)}%)`);
                            }
                        }
                    }
                }

                // Also check parragraphs (typo in eSearch-OCR) - but don't duplicate!
                const paragraphs = results.parragraphs || results.paragraphs || [];
                console.log(`[PaddleOCR] paragraphs count: ${paragraphs.length}`);
                for (let i = 0; i < paragraphs.length; i++) {
                    const para = paragraphs[i];
                    console.log(`[PaddleOCR] Paragraph ${i}:`, para);
                    // Don't add paragraph text - it duplicates src items
                    // if (para.text) {
                    //     allText += para.text + ' ';
                    // }
                }
            }

            // Map CJK characters that look like Latin letters/numbers before cleanup
            // These are commonly misread by OCR engines trained on multilingual data
            // Using Unicode escapes to avoid encoding issues when file is served
            const cjkToLatin = {
                '\u76EE': 'B',  // 目 mù (eye) - looks like B or 8
                '\u65E5': 'B',  // 日 rì (sun) - looks like B or 8
                '\u53E3': 'O',  // 口 kǒu (mouth) - looks like O or 0
                '\u56D7': 'O',  // 囗 wéi (enclosure) - looks like O or 0
                '\u3007': '0',  // 〇 circle - looks like 0
                '\u5DE5': 'I',  // 工 gōng (work) - looks like I
                '\u4E00': '1',  // 一 yī (one) - looks like 1 or -
                '\u4E8C': '2',  // 二 èr (two) - looks like 2
                '\u4E09': '3',  // 三 sān (three) - looks like 3 or E
                '\u56DB': '4',  // 四 sì (four) - similar to 4
                '\u4E94': '5',  // 五 wǔ (five) - similar to 5
                '\u516D': '6',  // 六 liù (six) - similar to 6
                '\u4E03': '7',  // 七 qī (seven) - looks like 7
                '\u516B': '8',  // 八 bā (eight) - looks like 8
                '\u4E5D': '9',  // 九 jiǔ (nine) - similar to 9
                '\u5341': 'T',  // 十 shí (ten) - looks like + or T
            };

            console.log(`[PaddleOCR] allText before mapping: "${allText}"`);
            let mappedText = allText;
            for (const [cjk, latin] of Object.entries(cjkToLatin)) {
                if (mappedText.includes(cjk)) {
                    console.log(`[PaddleOCR] Mapping CJK char "${cjk}" → "${latin}"`);
                    mappedText = mappedText.split(cjk).join(latin);
                }
            }
            console.log(`[PaddleOCR] mappedText after mapping: "${mappedText}"`);

            // Clean text for license plate (uppercase, alphanumeric only)
            const cleanText = mappedText.toUpperCase().replace(/[^A-Z0-9]/g, '');
            const avgConfidence = lines.length > 0 ? (totalConfidence / lines.length) * 100 : 0;

            console.log(`[PaddleOCR] Detected: "${cleanText}" (${avgConfidence.toFixed(1)}%) in ${this.lastInferenceTime.toFixed(0)}ms`);

            return {
                text: cleanText,
                rawText: allText,
                confidence: avgConfidence,
                lines: lines,
                inferenceTime: this.lastInferenceTime
            };

        } catch (error) {
            console.error('[PaddleOCR] Recognition error:', error);
            return { text: '', confidence: 0, lines: [], inferenceTime: 0, error: error.message };
        }
    }

    /**
     * Check if ready
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
            lastInferenceTime: this.lastInferenceTime
        };
    }
}

// Export
window.PaddleOCR = PaddleOCR;
