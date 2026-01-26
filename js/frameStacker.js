/**
 * FrameStacker - Multi-frame enhancement pipeline
 * Ranks frames by sharpness, aligns them, and stacks for noise reduction
 */
class FrameStacker {
    constructor() {
        this.topFrameCount = 15; // Return top 15 sharpest frames (more = better Lucky Regions)
        this.stackFrameCount = 8; // Use top 8 for stacking (more frames = better noise reduction)
        this.useFeatureAlignment = false; // Disabled - causes quality loss
        this.useMotionDeblur = false; // Disabled - often makes things worse
        this.useMLUpscale = false; // ML super-resolution (disabled by default)
        this.mlUpscaleScale = 3; // Upscale factor (model does 3x)
        this.usePerspectiveCorrection = false; // Disabled - can distort text
        this.useRealStacking = false; // TRUE multi-frame stacking (combines all frames)

        // ONNX super-resolution model
        this.srSession = null;
        this.srModelPath = 'vendor/models/super-resolution-10.onnx';
        this.srModelLoading = false;
        this.srInputSize = 224; // Model expects 224x224 input
        this.srOutputSize = 672; // Model outputs 672x672 (3x)
    }

    /**
     * Process cropped regions through enhancement pipeline
     * @param {Array} regions - Array of { imageData, time, cameraId, region }
     * @param {Array} frames - Original full frames (not used currently)
     * @param {Function} onProgress - Progress callback (status, percent 0-1)
     * @param {Object} videoEnhancements - User's video settings { brightness, contrast, saturation }
     * @returns {Object} - { combined: { dataUrl, sharpness }, topFrames: [...] }
     */
    async process(regions, frames, onProgress = null, videoEnhancements = null) {
        // Store video enhancement settings for later
        this.videoEnhancements = videoEnhancements || { brightness: 100, contrast: 100, saturation: 100 };
        if (!regions || regions.length === 0) {
            throw new Error('No regions to process');
        }

        const updateProgress = (status, pct) => {
            if (onProgress) onProgress(status, pct);
        };

        console.log(`[FrameStacker] Processing ${regions.length} cropped regions`);

        // Step 1: Calculate sharpness for each region
        updateProgress(`Calculating sharpness for ${regions.length} frames...`, 0);
        await new Promise(r => setTimeout(r, 10)); // Let UI update

        const scored = [];
        for (let i = 0; i < regions.length; i++) {
            scored.push({
                ...regions[i],
                sharpness: this.calculateSharpness(regions[i].imageData)
            });

            // Update progress every 20 frames
            if (i % 20 === 0) {
                updateProgress(`Calculating sharpness (${i}/${regions.length})...`, (i / regions.length) * 0.3);
                await new Promise(r => setTimeout(r, 0)); // Yield to UI
            }
        }

        // Step 2: Sort by sharpness (descending)
        scored.sort((a, b) => b.sharpness - a.sharpness);

        console.log(`[FrameStacker] Sharpness range: ${scored[scored.length - 1].sharpness.toFixed(2)} to ${scored[0].sharpness.toFixed(2)}`);

        // Log top 8 frames with their scores for debugging
        console.log('[FrameStacker] Top frames by sharpness:');
        scored.slice(0, 8).forEach((f, i) => {
            console.log(`  #${i + 1}: score=${f.sharpness.toFixed(2)}, time=${f.time.toFixed(2)}s, camera=${f.cameraId}`);
        });

        // Step 3: Get top frames for display (include dimensions for re-processing)
        updateProgress('Preparing top frames...', 0.35);
        const topFrames = scored.slice(0, this.topFrameCount).map(r => ({
            dataUrl: this.imageDataToDataUrl(r.imageData),
            sharpness: r.sharpness,
            cameraId: r.cameraId,
            time: r.time,
            width: r.imageData.width,
            height: r.imageData.height
        }));

        // Step 4: Align frames using feature matching (if OpenCV available)
        let stackFrames = scored.slice(0, Math.min(this.stackFrameCount, scored.length));

        if (this.useFeatureAlignment && typeof cv !== 'undefined') {
            updateProgress('Aligning frames with feature matching...', 0.4);
            await new Promise(r => setTimeout(r, 10));

            stackFrames = await this.alignFrames(stackFrames, (pct) => {
                updateProgress(`Aligning frames...`, 0.4 + pct * 0.15);
            });
        }

        // Step 5: Apply motion deblur to blurry frames (if enabled)
        if (this.useMotionDeblur && typeof cv !== 'undefined') {
            updateProgress('Applying motion deblur...', 0.55);
            await new Promise(r => setTimeout(r, 10));

            stackFrames = await this.applyMotionDeblur(stackFrames, (pct) => {
                updateProgress(`Deblurring frames...`, 0.55 + pct * 0.1);
            });
        }

        // Step 6: Stack frames
        updateProgress(`Stacking ${stackFrames.length} frames...`, 0.65);
        await new Promise(r => setTimeout(r, 10));

        const stacked = await this.stackFrames(stackFrames, (pct) => {
            updateProgress(`Stacking frames...`, 0.65 + pct * 0.15);
        });

        // Step 7: Generate all enhancement methods
        updateProgress('Generating enhancement methods...', 0.8);
        await new Promise(r => setTimeout(r, 10));

        const enhancementMethods = await this.generateAllEnhancementMethods(stackFrames, stacked, scored, (pct) => {
            updateProgress('Generating enhancement methods...', 0.8 + pct * 0.1);
        });

        // Step 8: ML super-resolution upscaling for ALL enhancement methods (if enabled)
        let upscaled = null;
        const upscaledMethods = {};
        if (this.useMLUpscale) {
            updateProgress('Applying super-resolution to all methods...', 0.9);
            await new Promise(r => setTimeout(r, 10));

            // Upscale all enhancement methods in parallel for speed
            const methodsToUpscale = ['sigmaClipped', 'msrClahe', 'weightedMean', 'bestFrame', 'bilateral', 'ensemble'];
            if (enhancementMethods.luckyRegions) {
                methodsToUpscale.push('luckyRegions');
            }

            // Log dimensions being upscaled (helps diagnose slowness)
            const sampleMethod = enhancementMethods[methodsToUpscale[0]];
            const inputDims = sampleMethod?.imageData ? `${sampleMethod.imageData.width}×${sampleMethod.imageData.height}` : 'N/A';
            const inputPixels = sampleMethod?.imageData ? sampleMethod.imageData.width * sampleMethod.imageData.height : 0;
            const outputPixels = inputPixels * this.mlUpscaleScale * this.mlUpscaleScale;
            console.log(`[FrameStacker] Upscaling ${methodsToUpscale.length} methods: ${inputDims}px input → ${this.mlUpscaleScale}x → ~${Math.round(outputPixels/1000)}k output pixels each`);
            if (inputPixels > 100000) {
                console.warn(`[FrameStacker] ⚠️ Large selection (${Math.round(inputPixels/1000)}k pixels) - upscaling will be slow. Consider using a smaller selection.`);
            }
            const startTime = performance.now();

            // Process methods sequentially to avoid memory issues, but show progress
            let completed = 0;
            for (const methodName of methodsToUpscale) {
                const method = enhancementMethods[methodName];
                if (!method?.imageData) continue;

                const methodStart = performance.now();
                updateProgress(`Upscaling ${methodName}...`, 0.9 + (completed / methodsToUpscale.length) * 0.07);

                try {
                    const upscaledResult = await this.applyMLUpscale(method.imageData, this.mlUpscaleScale);
                    if (upscaledResult) {
                        // Post-process with sharpening
                        const sharpened = this.postProcessUpscaled(upscaledResult);
                        upscaledMethods[methodName] = {
                            imageData: sharpened,
                            dataUrl: this.imageDataToDataUrl(sharpened),
                            sharpness: this.calculateSharpness(sharpened)
                        };
                    }
                    console.log(`[FrameStacker] Upscaled ${methodName} in ${(performance.now() - methodStart).toFixed(0)}ms`);
                } catch (err) {
                    console.warn(`[FrameStacker] Failed to upscale ${methodName}:`, err);
                }
                completed++;
            }

            console.log(`[FrameStacker] All ${Object.keys(upscaledMethods).length} methods upscaled in ${(performance.now() - startTime).toFixed(0)}ms total`);

            // Use ensemble upscaled as the primary upscaled result
            if (upscaledMethods.ensemble) {
                upscaled = upscaledMethods.ensemble.imageData;
            }
        }

        updateProgress('Finalizing...', 0.98);

        // Helper to build method result with optional upscaled version
        const buildMethodResult = (methodName, displayName) => {
            const method = enhancementMethods[methodName];
            if (!method) return null;

            const result = {
                dataUrl: method.dataUrl,
                sharpness: method.sharpness,
                name: displayName
            };

            // Add upscaled version if available
            if (upscaledMethods[methodName]) {
                result.upscaledDataUrl = upscaledMethods[methodName].dataUrl;
                result.upscaledSharpness = upscaledMethods[methodName].sharpness;
            }

            return result;
        };

        // Build result with all enhancement methods (including upscaled versions)
        const result = {
            combined: {
                dataUrl: enhancementMethods.ensemble.dataUrl,
                sharpness: enhancementMethods.ensemble.sharpness
            },
            topFrames,
            // All enhancement methods with their upscaled versions
            methods: {
                sigmaClipped: buildMethodResult('sigmaClipped', 'Sigma Clipped'),
                msrClahe: buildMethodResult('msrClahe', 'MSR + CLAHE'),
                weightedMean: buildMethodResult('weightedMean', 'Weighted Mean'),
                bestFrame: buildMethodResult('bestFrame', 'Best Frame'),
                bilateral: buildMethodResult('bilateral', 'Bilateral Filter'),
                ensemble: buildMethodResult('ensemble', 'Ensemble'),
                luckyRegions: buildMethodResult('luckyRegions', 'Lucky Regions')
            }
        };

        // Include primary upscaled version (ensemble) separately for backward compatibility
        if (upscaled) {
            result.upscaled = {
                dataUrl: this.imageDataToDataUrl(upscaled),
                sharpness: this.calculateSharpness(upscaled),
                scale: this.mlUpscaleScale
            };
        }

        return result;
    }

    /**
     * Generate all 6 enhancement methods for display
     * @param {Array} stackFrames - Frames to stack
     * @param {ImageData} stacked - Already stacked result from primary method
     * @param {Array} scored - All frames sorted by sharpness
     * @param {Function} onProgress - Progress callback
     * @returns {Object} - All enhancement method results
     */
    async generateAllEnhancementMethods(stackFrames, stacked, scored, onProgress) {
        const results = {};

        // Method 1: Sigma-clipped (already computed if primary method)
        const originalMethod = this.stackingMethod;
        this.stackingMethod = 'sigma-mean';
        const sigmaResult = this.stackingMethod === originalMethod ? stacked :
            await this.stackFramesInternal(stackFrames.map(f => ({
                ...f,
                sharpness: f.sharpness || this.calculateSharpness(f.imageData)
            })));
        const sigmaEnhanced = this.applySigmaEnhancement(sigmaResult);
        results.sigmaClipped = {
            imageData: sigmaEnhanced,
            dataUrl: this.imageDataToDataUrl(sigmaEnhanced),
            sharpness: this.calculateSharpness(sigmaEnhanced)
        };
        if (onProgress) onProgress(0.15);

        // Method 2: Weighted Mean
        this.stackingMethod = 'mean';
        const meanResult = await this.stackFramesInternal(stackFrames.map(f => ({
            ...f,
            sharpness: f.sharpness || this.calculateSharpness(f.imageData)
        })));
        const meanEnhanced = this.applyWeightedMeanEnhancement(meanResult);
        results.weightedMean = {
            imageData: meanEnhanced,
            dataUrl: this.imageDataToDataUrl(meanEnhanced),
            sharpness: this.calculateSharpness(meanEnhanced)
        };
        if (onProgress) onProgress(0.3);

        // Method 3: Best Frame (just enhance the sharpest frame)
        const bestFrameData = scored[0].imageData;
        const bestEnhanced = this.applyBestFrameEnhancement(bestFrameData);
        results.bestFrame = {
            imageData: bestEnhanced,
            dataUrl: this.imageDataToDataUrl(bestEnhanced),
            sharpness: this.calculateSharpness(bestEnhanced)
        };
        if (onProgress) onProgress(0.45);

        // Method 4: MSR + CLAHE
        const msrClaheResult = this.applyMsrClahe(stacked);
        results.msrClahe = {
            imageData: msrClaheResult,
            dataUrl: this.imageDataToDataUrl(msrClaheResult),
            sharpness: this.calculateSharpness(msrClaheResult)
        };
        if (onProgress) onProgress(0.6);

        // Method 5: Bilateral Filter (edge-preserving denoise)
        const bilateralResult = this.applyBilateralEnhancement(stacked);
        results.bilateral = {
            imageData: bilateralResult,
            dataUrl: this.imageDataToDataUrl(bilateralResult),
            sharpness: this.calculateSharpness(bilateralResult)
        };
        if (onProgress) onProgress(0.75);

        // Method 6: Ensemble (combine best aspects of all methods)
        const ensembleResult = this.createEnsemble(results);
        results.ensemble = {
            imageData: ensembleResult,
            dataUrl: this.imageDataToDataUrl(ensembleResult),
            sharpness: this.calculateSharpness(ensembleResult)
        };
        if (onProgress) onProgress(0.85);

        // Method 7: Lucky Regions - per-block best selection to cancel MPEG artifacts
        try {
            console.log('[LuckyRegions] Starting with', stackFrames.length, 'frames');
            console.log('[LuckyRegions] First frame structure:', Object.keys(stackFrames[0] || {}));
            const luckyResult = this.applyLuckyRegions(stackFrames);
            console.log('[LuckyRegions] Result:', luckyResult ? `${luckyResult.width}x${luckyResult.height}` : 'null');
            if (luckyResult) {
                results.luckyRegions = {
                    imageData: luckyResult,
                    dataUrl: this.imageDataToDataUrl(luckyResult),
                    sharpness: this.calculateSharpness(luckyResult)
                };
            } else {
                console.warn('[LuckyRegions] applyLuckyRegions returned null');
            }
        } catch (e) {
            console.error('[LuckyRegions] Error:', e);
        }
        if (onProgress) onProgress(1.0);

        // Restore original method
        this.stackingMethod = originalMethod;

        return results;
    }

    /**
     * Apply gentle CLAHE enhancement only (no MSR which destroys character shapes)
     * Renamed from MSR+CLAHE but keeping method name for compatibility
     */
    applyMsrClahe(imageData) {
        let result = imageData;
        // Apply ONLY gentle CLAHE - no MSR which washes out details
        if (typeof cv !== 'undefined') {
            try {
                result = this.applyCLAHE(imageData, 1.0, 8); // Gentle CLAHE only
            } catch (e) {
                result = this.autoContrast(imageData);
            }
        } else {
            result = this.autoContrast(imageData);
        }
        // Edge-aware sharpening
        result = this.unsharpMaskThreshold(result, 0.5, 1, 8);
        return result;
    }

    /**
     * Multi-Scale Retinex for illumination normalization
     */
    multiScaleRetinex(imageData) {
        const { width, height, data } = imageData;
        const result = new ImageData(width, height);
        const dst = result.data;

        // SSR at multiple scales then average
        const sigmas = [15, 80, 250];
        const weight = 1.0 / sigmas.length;

        // Create grayscale + log version
        const logChannels = [
            new Float32Array(width * height), // R
            new Float32Array(width * height), // G
            new Float32Array(width * height)  // B
        ];

        // Initialize result channels
        for (let c = 0; c < 3; c++) {
            for (let i = 0; i < width * height; i++) {
                const val = data[i * 4 + c];
                logChannels[c][i] = 0;
            }
        }

        // Apply SSR at each scale
        for (const sigma of sigmas) {
            // Create blurred version (simple box blur approximation)
            const blurred = this.gaussianBlurApprox(imageData, sigma);

            for (let i = 0; i < width * height; i++) {
                for (let c = 0; c < 3; c++) {
                    const original = Math.max(1, data[i * 4 + c]);
                    const blur = Math.max(1, blurred.data[i * 4 + c]);
                    // Log difference (Retinex)
                    logChannels[c][i] += weight * (Math.log(original) - Math.log(blur));
                }
            }
        }

        // Convert back to 0-255 range with normalization
        for (let c = 0; c < 3; c++) {
            let min = Infinity, max = -Infinity;
            for (let i = 0; i < width * height; i++) {
                if (logChannels[c][i] < min) min = logChannels[c][i];
                if (logChannels[c][i] > max) max = logChannels[c][i];
            }
            const range = max - min || 1;

            for (let i = 0; i < width * height; i++) {
                dst[i * 4 + c] = Math.round(((logChannels[c][i] - min) / range) * 255);
            }
        }

        // Alpha channel
        for (let i = 0; i < width * height; i++) {
            dst[i * 4 + 3] = 255;
        }

        return result;
    }

    /**
     * Multi-Scale Retinex with blending - avoids blown-out highlights
     * @param {ImageData} imageData - Input image
     * @param {number} blendFactor - How much MSR to apply (0-1), rest is original
     */
    multiScaleRetinexBlended(imageData, blendFactor = 0.6) {
        const { width, height, data } = imageData;
        const result = new ImageData(width, height);
        const dst = result.data;

        // Get pure MSR result
        const msrResult = this.multiScaleRetinex(imageData);
        const msrData = msrResult.data;

        // Blend MSR with original to preserve natural tones
        for (let i = 0; i < data.length; i += 4) {
            for (let c = 0; c < 3; c++) {
                const original = data[i + c];
                const msr = msrData[i + c];
                // Blend: preserve shadows and highlights from original
                dst[i + c] = Math.round(original * (1 - blendFactor) + msr * blendFactor);
            }
            dst[i + 3] = 255;
        }

        return result;
    }

    /**
     * Unsharp mask with threshold - only sharpens significant edges
     * Avoids sharpening noise and creating halos around text
     * @param {ImageData} imageData - Input image
     * @param {number} amount - Sharpening strength (0-2)
     * @param {number} radius - Blur radius for mask
     * @param {number} threshold - Minimum difference to sharpen (prevents noise amplification)
     */
    unsharpMaskThreshold(imageData, amount = 0.5, radius = 1, threshold = 8) {
        const { width, height, data } = imageData;
        const result = new ImageData(width, height);
        const dst = result.data;

        // Create blurred version
        const blurred = this.gaussianBlur(imageData, radius);
        const blurData = blurred.data;

        for (let i = 0; i < data.length; i += 4) {
            for (let c = 0; c < 3; c++) {
                const original = data[i + c];
                const blur = blurData[i + c];
                const diff = original - blur;

                // Only apply sharpening if difference exceeds threshold
                // This prevents noise amplification and reduces halos
                if (Math.abs(diff) > threshold) {
                    // Soft application: scale by how much it exceeds threshold
                    const excess = Math.abs(diff) - threshold;
                    const scaledAmount = amount * Math.min(1, excess / 20);
                    dst[i + c] = Math.max(0, Math.min(255, Math.round(original + diff * scaledAmount)));
                } else {
                    dst[i + c] = original;
                }
            }
            dst[i + 3] = 255;
        }

        return result;
    }

    /**
     * Approximate Gaussian blur with box blur iterations
     */
    gaussianBlurApprox(imageData, sigma) {
        // Box blur approximation of Gaussian
        const radius = Math.max(1, Math.round(sigma / 2));
        let result = imageData;

        // 3 iterations of box blur approximates Gaussian
        for (let iter = 0; iter < 3; iter++) {
            result = this.boxBlur(result, radius);
        }

        return result;
    }

    /**
     * Simple box blur
     */
    boxBlur(imageData, radius) {
        const { width, height, data } = imageData;
        const result = new ImageData(width, height);
        const dst = result.data;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const sums = [0, 0, 0];
                let count = 0;

                for (let ky = -radius; ky <= radius; ky++) {
                    for (let kx = -radius; kx <= radius; kx++) {
                        const ny = Math.max(0, Math.min(height - 1, y + ky));
                        const nx = Math.max(0, Math.min(width - 1, x + kx));
                        const idx = (ny * width + nx) * 4;
                        sums[0] += data[idx];
                        sums[1] += data[idx + 1];
                        sums[2] += data[idx + 2];
                        count++;
                    }
                }

                const idx = (y * width + x) * 4;
                dst[idx] = Math.round(sums[0] / count);
                dst[idx + 1] = Math.round(sums[1] / count);
                dst[idx + 2] = Math.round(sums[2] / count);
                dst[idx + 3] = 255;
            }
        }

        return result;
    }

    /**
     * Apply bilateral filter enhancement
     * Optimized for license plate clarity - preserves text edges while reducing noise
     */
    applyBilateralEnhancement(imageData) {
        // Edge-preserving denoise with stronger settings for cleaner background
        let result = this.simpleDenoisePreserveEdges(imageData, 1.2);
        // Light contrast enhancement to make text stand out
        result = this.enhanceTextContrast(result);
        // Gentle sharpening with threshold to avoid halos
        result = this.unsharpMaskThreshold(result, 0.5, 1, 10);
        return result;
    }

    /**
     * Enhance text contrast - makes dark text darker and light background lighter
     */
    enhanceTextContrast(imageData) {
        const { width, height, data } = imageData;
        const result = new ImageData(width, height);
        const dst = result.data;

        // Analyze luminance distribution
        const luminances = [];
        for (let i = 0; i < data.length; i += 4) {
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            luminances.push(lum);
        }

        // Find percentiles for adaptive stretching
        const sorted = [...luminances].sort((a, b) => a - b);
        const p5 = sorted[Math.floor(sorted.length * 0.05)];
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        const range = p95 - p5 || 1;

        // Apply contrast stretch with slight S-curve for text enhancement
        for (let i = 0; i < data.length; i += 4) {
            for (let c = 0; c < 3; c++) {
                let val = data[i + c];
                // Normalize to 0-1 based on percentiles
                let norm = (val - p5) / range;
                norm = Math.max(0, Math.min(1, norm));
                // Apply subtle S-curve to enhance separation
                norm = norm * norm * (3 - 2 * norm); // smoothstep
                dst[i + c] = Math.round(norm * 255);
            }
            dst[i + 3] = 255;
        }

        return result;
    }

    /**
     * Create ensemble result by combining best aspects of methods
     * Excludes MSR+CLAHE (too bright) and uses equal weights for robustness
     */
    createEnsemble(methods) {
        // Get dimensions from first method
        const firstMethod = Object.values(methods).find(m => m.imageData);
        if (!firstMethod) return null;
        const { width, height } = firstMethod.imageData;
        const result = new ImageData(width, height);
        const dst = result.data;

        // Collect methods - exclude msrClahe (tends to blow out) and ensemble
        const validMethods = [];
        for (const [name, method] of Object.entries(methods)) {
            if (name === 'ensemble' || name === 'msrClahe' || !method.imageData) continue;
            // Use equal weights - don't let high sharpness dominate
            validMethods.push({ name, data: method.imageData.data, weight: 1 });
        }

        // For each pixel, use simple median (equal weights, robust)
        for (let i = 0; i < width * height * 4; i += 4) {
            for (let c = 0; c < 3; c++) {
                const values = validMethods.map(m => m.data[i + c]);
                // Sort and take median
                values.sort((a, b) => a - b);
                const mid = Math.floor(values.length / 2);
                const medianVal = values.length % 2 === 0
                    ? Math.round((values[mid - 1] + values[mid]) / 2)
                    : values[mid];
                dst[i + c] = medianVal;
            }
            dst[i + 3] = 255;
        }

        // Apply very light sharpening with threshold
        return this.unsharpMaskThreshold(result, 0.3, 1, 10);
    }

    /**
     * Lucky Regions - Per-block best selection to cancel MPEG artifacts
     * MPEG uses 8x8 DCT blocks, so different regions have different quality in different frames.
     * This method selects the sharpest version of each small block across all frames.
     * @param {Array} frames - Array of { imageData, sharpness } objects
     */
    applyLuckyRegions(frames) {
        console.log('[LuckyRegions] applyLuckyRegions called with', frames?.length || 0, 'frames');
        if (!frames || frames.length === 0) {
            console.warn('[LuckyRegions] No frames provided');
            return null;
        }

        const first = frames[0].imageData;
        if (!first) {
            console.warn('[LuckyRegions] First frame has no imageData:', frames[0]);
            return null;
        }
        console.log('[LuckyRegions] First frame imageData:', first.width, 'x', first.height);
        const { width, height } = first;
        const result = new ImageData(width, height);
        const dst = result.data;

        // Block size - match MPEG's 8x8 DCT blocks
        const blockSize = 8;

        // For each block, find the frame with the sharpest version
        for (let by = 0; by < height; by += blockSize) {
            for (let bx = 0; bx < width; bx += blockSize) {
                // Calculate local sharpness for this block in each frame
                let bestFrame = 0;
                let bestSharpness = -1;

                for (let f = 0; f < frames.length; f++) {
                    const frameData = frames[f].imageData.data;
                    let blockSharpness = 0;

                    // Calculate Laplacian variance for this block
                    for (let y = by + 1; y < Math.min(by + blockSize - 1, height - 1); y++) {
                        for (let x = bx + 1; x < Math.min(bx + blockSize - 1, width - 1); x++) {
                            const idx = (y * width + x) * 4;
                            // Grayscale
                            const gray = 0.299 * frameData[idx] + 0.587 * frameData[idx + 1] + 0.114 * frameData[idx + 2];
                            // Laplacian (4-connected)
                            const above = 0.299 * frameData[((y-1) * width + x) * 4] + 0.587 * frameData[((y-1) * width + x) * 4 + 1] + 0.114 * frameData[((y-1) * width + x) * 4 + 2];
                            const below = 0.299 * frameData[((y+1) * width + x) * 4] + 0.587 * frameData[((y+1) * width + x) * 4 + 1] + 0.114 * frameData[((y+1) * width + x) * 4 + 2];
                            const left = 0.299 * frameData[(y * width + x - 1) * 4] + 0.587 * frameData[(y * width + x - 1) * 4 + 1] + 0.114 * frameData[(y * width + x - 1) * 4 + 2];
                            const right = 0.299 * frameData[(y * width + x + 1) * 4] + 0.587 * frameData[(y * width + x + 1) * 4 + 1] + 0.114 * frameData[(y * width + x + 1) * 4 + 2];
                            const laplacian = Math.abs(4 * gray - above - below - left - right);
                            blockSharpness += laplacian;
                        }
                    }

                    if (blockSharpness > bestSharpness) {
                        bestSharpness = blockSharpness;
                        bestFrame = f;
                    }
                }

                // Copy the best block from the best frame
                const srcData = frames[bestFrame].imageData.data;
                for (let y = by; y < Math.min(by + blockSize, height); y++) {
                    for (let x = bx; x < Math.min(bx + blockSize, width); x++) {
                        const idx = (y * width + x) * 4;
                        dst[idx] = srcData[idx];
                        dst[idx + 1] = srcData[idx + 1];
                        dst[idx + 2] = srcData[idx + 2];
                        dst[idx + 3] = 255;
                    }
                }
            }
        }

        // Apply light enhancement to the composite
        let enhanced = this.autoContrast(result);
        enhanced = this.unsharpMaskThreshold(enhanced, 0.5, 1, 8);

        return enhanced;
    }

    /**
     * Enhancement for Sigma Clipped stacking
     * Stacking already reduced noise, so focus on contrast and clarity
     */
    applySigmaEnhancement(imageData) {
        // Light text contrast enhancement
        let result = this.enhanceTextContrast(imageData);
        // Moderate sharpening with threshold to avoid artifacts
        result = this.unsharpMaskThreshold(result, 0.6, 1, 8);
        return result;
    }

    /**
     * Enhancement for Weighted Mean stacking
     * Mean averaging already smooths noise - minimal processing to preserve characters
     */
    applyWeightedMeanEnhancement(imageData) {
        // Edge enhancement to restore details lost in averaging
        let result = this.enhanceEdges(imageData);
        // Light auto contrast
        result = this.autoContrast(result);
        // Sharper edges with higher threshold to only affect real edges
        result = this.unsharpMaskThreshold(result, 0.6, 1, 6);
        return result;
    }

    /**
     * Enhance edges without boosting noise - helps recover detail lost in averaging
     */
    enhanceEdges(imageData) {
        const { width, height, data } = imageData;
        const result = new ImageData(width, height);
        const dst = result.data;

        // Sobel-like edge detection
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = (y * width + x) * 4;

                for (let c = 0; c < 3; c++) {
                    // Get surrounding pixels
                    const tl = data[((y-1) * width + (x-1)) * 4 + c];
                    const t  = data[((y-1) * width + x) * 4 + c];
                    const tr = data[((y-1) * width + (x+1)) * 4 + c];
                    const l  = data[(y * width + (x-1)) * 4 + c];
                    const center = data[idx + c];
                    const r  = data[(y * width + (x+1)) * 4 + c];
                    const bl = data[((y+1) * width + (x-1)) * 4 + c];
                    const b  = data[((y+1) * width + x) * 4 + c];
                    const br = data[((y+1) * width + (x+1)) * 4 + c];

                    // Calculate gradient magnitude
                    const gx = (tr + 2*r + br) - (tl + 2*l + bl);
                    const gy = (bl + 2*b + br) - (tl + 2*t + tr);
                    const gradient = Math.sqrt(gx*gx + gy*gy) / 4;

                    // Boost edges proportionally
                    const boost = Math.min(gradient / 50, 0.3); // Max 30% boost
                    const enhanced = center + (center - (tl+t+tr+l+r+bl+b+br)/8) * boost;
                    dst[idx + c] = Math.max(0, Math.min(255, Math.round(enhanced)));
                }
                dst[idx + 3] = 255;
            }
        }

        // Copy border pixels
        for (let x = 0; x < width; x++) {
            for (let c = 0; c < 4; c++) {
                dst[x * 4 + c] = data[x * 4 + c];
                dst[((height-1) * width + x) * 4 + c] = data[((height-1) * width + x) * 4 + c];
            }
        }
        for (let y = 0; y < height; y++) {
            for (let c = 0; c < 4; c++) {
                dst[(y * width) * 4 + c] = data[(y * width) * 4 + c];
                dst[(y * width + width - 1) * 4 + c] = data[(y * width + width - 1) * 4 + c];
            }
        }

        return result;
    }

    /**
     * Enhancement for Best Frame (single frame, no stacking benefit)
     * Needs more aggressive processing since no noise reduction from stacking
     */
    applyBestFrameEnhancement(imageData) {
        // More aggressive denoising for single frame
        let result = this.simpleDenoisePreserveEdges(imageData, 1.5);
        // Text contrast enhancement
        result = this.enhanceTextContrast(result);
        // Moderate sharpening
        result = this.unsharpMaskThreshold(result, 0.7, 1, 8);
        return result;
    }

    /**
     * Internal stacking without progress callback (for generating multiple methods)
     */
    async stackFramesInternal(frames) {
        // Just call stackFrames with null progress callback
        return await this.stackFrames(frames, null);
    }

    /**
     * Process pre-cropped frames (for re-processing with selected frames)
     * @param {Array} frames - Array of { dataUrl, sharpness, cameraId, time }
     * @param {Function} onProgress - Progress callback
     * @param {Object} videoEnhancements - Video enhancement settings
     * @returns {Object} - Same format as process()
     */
    async processPreCropped(frames, onProgress = null, videoEnhancements = null) {
        // rev:47c
        this.videoEnhancements = videoEnhancements || { brightness: 100, contrast: 100, saturation: 100 };

        if (!frames || frames.length < 1) {
            throw new Error('Need at least 1 frame to process');
        }

        const updateProgress = (status, pct) => {
            if (onProgress) onProgress(status, pct);
        };

        console.log(`[FrameStacker] Re-processing ${frames.length} pre-cropped frames`);

        // Convert dataUrl to imageData for each frame
        updateProgress('Converting frames...', 0);
        const regions = [];
        for (let i = 0; i < frames.length; i++) {
            const imageData = await this.dataUrlToImageData(frames[i].dataUrl);
            regions.push({
                imageData,
                sharpness: frames[i].sharpness,
                cameraId: frames[i].cameraId,
                time: frames[i].time
            });
            updateProgress(`Converting frames (${i + 1}/${frames.length})...`, (i / frames.length) * 0.1);
        }

        // Already sorted by sharpness (from original processing)
        // Top frames are what we're re-processing, so use them all for display
        const topFrames = frames.map(f => ({
            dataUrl: f.dataUrl,
            sharpness: f.sharpness,
            cameraId: f.cameraId,
            time: f.time
        }));

        // Align frames (if OpenCV available)
        let stackFrames = regions;
        if (this.useFeatureAlignment && typeof cv !== 'undefined') {
            updateProgress('Aligning frames...', 0.15);
            await new Promise(r => setTimeout(r, 17));

            stackFrames = await this.alignFrames(stackFrames, (pct) => {
                updateProgress(`Aligning frames...`, 0.15 + pct * 0.2);
            });
        }

        // Apply motion deblur (if enabled)
        if (this.useMotionDeblur && typeof cv !== 'undefined') {
            updateProgress('Applying motion deblur...', 0.35);
            await new Promise(r => setTimeout(r, 10));

            stackFrames = await this.applyMotionDeblur(stackFrames, (pct) => {
                updateProgress(`Deblurring frames...`, 0.35 + pct * 0.15);
            });
        }

        // Stack frames
        updateProgress(`Stacking ${stackFrames.length} frames...`, 0.5);
        await new Promise(r => setTimeout(r, 10));

        const stacked = await this.stackFrames(stackFrames, (pct) => {
            updateProgress(`Stacking frames...`, 0.5 + pct * 0.2);
        });

        // Generate all enhancement methods
        updateProgress('Generating enhancement methods...', 0.7);
        await new Promise(r => setTimeout(r, 10));

        const enhancementMethods = await this.generateAllEnhancementMethods(stackFrames, stacked, regions, (pct) => {
            updateProgress('Generating enhancement methods...', 0.7 + pct * 0.2);
        });

        // ML upscaling for ALL enhancement methods (if enabled)
        let upscaled = null;
        const upscaledMethods = {};
        if (this.useMLUpscale) {
            updateProgress('Applying super-resolution to all methods...', 0.9);
            await new Promise(r => setTimeout(r, 10));

            // Upscale all enhancement methods (including Lucky Regions if available)
            const methodsToUpscale = ['sigmaClipped', 'msrClahe', 'weightedMean', 'bestFrame', 'bilateral', 'ensemble'];
            if (enhancementMethods.luckyRegions) {
                methodsToUpscale.push('luckyRegions');
            }
            let completed = 0;
            for (const methodName of methodsToUpscale) {
                const method = enhancementMethods[methodName];
                if (!method?.imageData) continue;

                updateProgress(`Upscaling ${methodName}...`, 0.9 + (completed / methodsToUpscale.length) * 0.07);

                try {
                    const upscaledResult = await this.applyMLUpscale(method.imageData, this.mlUpscaleScale);
                    if (upscaledResult) {
                        const sharpened = this.postProcessUpscaled(upscaledResult);
                        upscaledMethods[methodName] = {
                            imageData: sharpened,
                            dataUrl: this.imageDataToDataUrl(sharpened),
                            sharpness: this.calculateSharpness(sharpened)
                        };
                    }
                } catch (err) {
                    console.warn(`[FrameStacker] Failed to upscale ${methodName}:`, err);
                }
                completed++;
            }

            // Use ensemble upscaled as the primary
            if (upscaledMethods.ensemble) {
                upscaled = upscaledMethods.ensemble.imageData;
            }
        }

        updateProgress('Finalizing...', 0.98);

        // Helper to build method result with optional upscaled version
        const buildMethodResult = (methodName, displayName) => {
            const method = enhancementMethods[methodName];
            if (!method) return null;

            const result = {
                dataUrl: method.dataUrl,
                sharpness: method.sharpness,
                name: displayName
            };

            if (upscaledMethods[methodName]) {
                result.upscaledDataUrl = upscaledMethods[methodName].dataUrl;
                result.upscaledSharpness = upscaledMethods[methodName].sharpness;
            }

            return result;
        };

        const result = {
            combined: {
                dataUrl: enhancementMethods.ensemble.dataUrl,
                sharpness: enhancementMethods.ensemble.sharpness
            },
            topFrames,
            // All enhancement methods with their upscaled versions
            methods: {
                sigmaClipped: buildMethodResult('sigmaClipped', 'Sigma Clipped'),
                msrClahe: buildMethodResult('msrClahe', 'MSR + CLAHE'),
                weightedMean: buildMethodResult('weightedMean', 'Weighted Mean'),
                bestFrame: buildMethodResult('bestFrame', 'Best Frame'),
                bilateral: buildMethodResult('bilateral', 'Bilateral Filter'),
                ensemble: buildMethodResult('ensemble', 'Ensemble'),
                luckyRegions: buildMethodResult('luckyRegions', 'Lucky Regions')
            }
        };

        if (upscaled) {
            result.upscaled = {
                dataUrl: this.imageDataToDataUrl(upscaled),
                sharpness: this.calculateSharpness(upscaled),
                scale: this.mlUpscaleScale
            };
        }

        return result;
    }

    /**
     * Convert data URL to ImageData
     */
    async dataUrlToImageData(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                resolve(ctx.getImageData(0, 0, img.width, img.height));
            };
            img.onerror = reject;
            img.src = dataUrl;
        });
    }

    /**
     * Calculate sharpness score optimized for license plate text
     * Combines multiple metrics: edge sharpness, text contrast, and blur detection
     * Higher value = better quality for OCR
     */
    calculateSharpness(imageData) {
        const gray = this.toGrayscale(imageData);
        const w = gray.width;
        const h = gray.height;
        const data = gray.data;

        // Metric 1: Laplacian variance (general edge sharpness)
        const laplacian = this.applyLaplacian(gray);
        let lapSum = 0, lapSumSq = 0;
        for (let i = 0; i < laplacian.data.length; i += 4) {
            const val = laplacian.data[i];
            lapSum += val;
            lapSumSq += val * val;
        }
        const lapCount = laplacian.data.length / 4;
        const lapMean = lapSum / lapCount;
        const laplacianVariance = (lapSumSq / lapCount) - (lapMean * lapMean);

        // Metric 2: Text contrast (difference between light and dark regions)
        let minVal = 255, maxVal = 0;
        const histogram = new Array(256).fill(0);
        for (let i = 0; i < data.length; i += 4) {
            const val = data[i];
            histogram[val]++;
            if (val < minVal) minVal = val;
            if (val > maxVal) maxVal = val;
        }
        const contrast = maxVal - minVal;

        // Metric 3: Horizontal edge strength (text has strong horizontal edges)
        let hEdgeSum = 0;
        for (let y = 1; y < h - 1; y++) {
            for (let x = 0; x < w; x++) {
                const idx = (y * w + x) * 4;
                const above = data[((y - 1) * w + x) * 4];
                const below = data[((y + 1) * w + x) * 4];
                hEdgeSum += Math.abs(above - below);
            }
        }
        const hEdgeScore = hEdgeSum / ((h - 2) * w);

        // Metric 4: Vertical edge strength (character boundaries)
        let vEdgeSum = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 1; x < w - 1; x++) {
                const left = data[(y * w + x - 1) * 4];
                const right = data[(y * w + x + 1) * 4];
                vEdgeSum += Math.abs(left - right);
            }
        }
        const vEdgeScore = vEdgeSum / (h * (w - 2));

        // Metric 5: Motion blur detection (ratio of directional to omnidirectional blur)
        // Less motion blur = higher score
        const edgeRatio = Math.min(hEdgeScore, vEdgeScore) / (Math.max(hEdgeScore, vEdgeScore) + 0.01);
        const motionScore = edgeRatio; // 1.0 = no directional blur, lower = motion blur

        // Combine metrics with weights optimized for license plate text
        // Laplacian: 40%, Contrast: 20%, H-edges: 15%, V-edges: 15%, Motion: 10%
        const score = (laplacianVariance * 0.4) +
                      (contrast * 0.8) +  // Scale contrast to similar range
                      (hEdgeScore * 15) +
                      (vEdgeScore * 15) +
                      (motionScore * 50);

        return score;
    }

    /**
     * Convert to grayscale
     */
    toGrayscale(imageData) {
        const canvas = document.createElement('canvas');
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        const ctx = canvas.getContext('2d');

        // Put original image
        ctx.putImageData(imageData, 0, 0);

        // Get pixel data
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = data.data;

        // Convert to grayscale
        for (let i = 0; i < pixels.length; i += 4) {
            const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
            pixels[i] = gray;
            pixels[i + 1] = gray;
            pixels[i + 2] = gray;
        }

        return data;
    }

    /**
     * Apply Laplacian operator for edge detection
     */
    applyLaplacian(imageData) {
        const width = imageData.width;
        const height = imageData.height;
        const src = imageData.data;

        const result = new ImageData(width, height);
        const dst = result.data;

        // Laplacian kernel
        const kernel = [0, 1, 0, 1, -4, 1, 0, 1, 0];

        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                let sum = 0;
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        const idx = ((y + ky) * width + (x + kx)) * 4;
                        const ki = (ky + 1) * 3 + (kx + 1);
                        sum += src[idx] * kernel[ki];
                    }
                }
                const idx = (y * width + x) * 4;
                const val = Math.abs(sum);
                dst[idx] = val;
                dst[idx + 1] = val;
                dst[idx + 2] = val;
                dst[idx + 3] = 255;
            }
        }

        return result;
    }

    /**
     * Stack multiple frames using advanced multi-frame fusion
     * When useRealStacking is enabled, combines ALL frames for noise reduction
     */
    async stackFrames(frames, onProgress = null) {
        if (frames.length === 0) {
            throw new Error('No frames to stack');
        }

        // Check if real stacking is requested
        if (!this.useRealStacking || frames.length < 2) {
            // BEST FRAME ONLY approach (default)
            console.log(`[FrameStacker] Using best single frame (sharpness: ${frames[0].sharpness?.toFixed(2) || 'N/A'})`);
            const best = frames[0].imageData;
            const result = new ImageData(
                new Uint8ClampedArray(best.data),
                best.width,
                best.height
            );
            if (onProgress) onProgress(1);
            return result;
        }

        // TRUE MULTI-FRAME STACKING
        console.log(`[FrameStacker] 📚 TRUE Multi-Frame Stacking with ${frames.length} frames`);

        // SCALE DETECTION: Check for significant size variations that cause ghosting
        const areas = frames.map(f => f.imageData.width * f.imageData.height);
        const minArea = Math.min(...areas);
        const maxArea = Math.max(...areas);
        const scaleVariation = (maxArea - minArea) / minArea;

        console.log(`[FrameStacker] Scale variation: ${(scaleVariation * 100).toFixed(1)}% (min: ${minArea}px², max: ${maxArea}px²)`);

        // If scale variation is too high (>10%), filter to similar-sized frames only
        let framesToStack = frames;
        if (scaleVariation > 0.10) {
            console.log(`[FrameStacker] ⚠️ High scale variation detected - filtering similar-sized frames`);

            // Group frames by size bucket (within 5% of each other)
            const sizeBuckets = new Map();
            frames.forEach((frame, idx) => {
                const area = frame.imageData.width * frame.imageData.height;
                // Find or create bucket
                let foundBucket = null;
                for (const [bucketArea, bucket] of sizeBuckets) {
                    if (Math.abs(area - bucketArea) / bucketArea < 0.05) {
                        foundBucket = bucketArea;
                        break;
                    }
                }
                if (foundBucket !== null) {
                    sizeBuckets.get(foundBucket).push(frame);
                } else {
                    sizeBuckets.set(area, [frame]);
                }
            });

            // Use the bucket with most frames that includes the sharpest frame
            let bestBucket = null;
            let bestBucketScore = -1;
            for (const [area, bucket] of sizeBuckets) {
                // Score = number of frames + bonus if it contains sharpest frame (index 0)
                const containsSharpest = bucket.includes(frames[0]) ? 10 : 0;
                const score = bucket.length + containsSharpest;
                if (score > bestBucketScore) {
                    bestBucketScore = score;
                    bestBucket = bucket;
                }
            }

            if (bestBucket && bestBucket.length >= 2) {
                console.log(`[FrameStacker] Using ${bestBucket.length} similar-sized frames (discarding ${frames.length - bestBucket.length} mismatched frames)`);
                framesToStack = bestBucket;
            } else {
                console.log(`[FrameStacker] Not enough similar frames - using single best frame`);
                const best = frames[0];
                const result = new ImageData(
                    new Uint8ClampedArray(best.imageData.data),
                    best.imageData.width,
                    best.imageData.height
                );
                if (onProgress) onProgress(1);
                return result;
            }
        }

        // Use first frame's dimensions as target (it's the sharpest)
        const width = framesToStack[0].imageData.width;
        const height = framesToStack[0].imageData.height;
        const pixelCount = width * height;

        console.log(`[FrameStacker] Target dimensions: ${width}x${height}, stacking ${framesToStack.length} frames`);

        // Resize all frames to match first frame's dimensions
        const normalizedFrames = framesToStack.map((frame, idx) => {
            const fw = frame.imageData.width;
            const fh = frame.imageData.height;
            if (fw === width && fh === height) {
                console.log(`[FrameStacker] Frame ${idx + 1}: ${fw}x${fh} (no resize needed)`);
                return frame.imageData;
            }
            console.log(`[FrameStacker] Frame ${idx + 1}: ${fw}x${fh} → ${width}x${height} (resizing)`);
            return this.resizeToMatch(frame.imageData, width, height);
        });

        // Calculate weights based on sharpness (higher sharpness = more weight)
        const sharpnessValues = framesToStack.map(f => f.sharpness || 1);
        const maxSharpness = Math.max(...sharpnessValues);
        const weights = sharpnessValues.map(s => Math.pow(s / maxSharpness, 2)); // Quadratic weighting

        console.log(`[FrameStacker] Frame weights: ${weights.map(w => w.toFixed(2)).join(', ')}`);

        // Multi-frame fusion using selected stacking method
        console.log(`[FrameStacker] Stacking method: ${this.stackingMethod}`);
        const result = new Uint8ClampedArray(width * height * 4);

        for (let i = 0; i < pixelCount; i++) {
            const idx = i * 4;

            // Collect pixel values from all normalized frames
            const rValues = [];
            const gValues = [];
            const bValues = [];

            for (let f = 0; f < normalizedFrames.length; f++) {
                const data = normalizedFrames[f].data;
                rValues.push(data[idx]);
                gValues.push(data[idx + 1]);
                bValues.push(data[idx + 2]);
            }

            // Combine pixels using selected method - THIS IS WHERE WE GAIN DATA
            result[idx] = this.combinePixels(rValues, weights);
            result[idx + 1] = this.combinePixels(gValues, weights);
            result[idx + 2] = this.combinePixels(bValues, weights);
            result[idx + 3] = 255; // Alpha

            // Progress update every 10%
            if (i % Math.floor(pixelCount / 10) === 0 && onProgress) {
                onProgress(i / pixelCount);
                await new Promise(r => setTimeout(r, 0)); // Yield to UI
            }
        }

        console.log(`[FrameStacker] Multi-frame stacking complete`);

        if (onProgress) onProgress(1);
        return new ImageData(result, width, height);
    }

    /**
     * Stacking method selector
     */
    stackingMethod = 'sigma-mean'; // 'median', 'mean', 'sigma-mean', 'lucky'

    /**
     * Combine pixel values using selected method
     */
    combinePixels(values, weights) {
        switch (this.stackingMethod) {
            case 'mean':
                return this.weightedMean(values, weights);
            case 'sigma-mean':
                return this.sigmaClippedMean(values, weights);
            case 'lucky':
                return this.luckyPixel(values, weights);
            case 'median':
            default:
                return this.weightedMedian(values.map((v, i) => ({ val: v, weight: weights[i] })));
        }
    }

    /**
     * Weighted mean - averages all values for noise reduction
     */
    weightedMean(values, weights) {
        let sum = 0;
        let totalWeight = 0;
        for (let i = 0; i < values.length; i++) {
            sum += values[i] * weights[i];
            totalWeight += weights[i];
        }
        return Math.round(sum / totalWeight);
    }

    /**
     * Sigma-clipped mean - reject outliers, then average
     * This GAINS information by combining good data while rejecting bad
     */
    sigmaClippedMean(values, weights, sigma = 2.0) {
        if (values.length < 3) {
            return this.weightedMean(values, weights);
        }

        // Calculate weighted mean and std
        let mean = this.weightedMean(values, weights);

        // Calculate weighted standard deviation
        let variance = 0;
        let totalWeight = 0;
        for (let i = 0; i < values.length; i++) {
            variance += weights[i] * Math.pow(values[i] - mean, 2);
            totalWeight += weights[i];
        }
        const std = Math.sqrt(variance / totalWeight);

        // Reject outliers (values more than sigma*std from mean)
        const threshold = sigma * Math.max(std, 5); // Min threshold of 5 to avoid over-rejection
        const clippedValues = [];
        const clippedWeights = [];

        for (let i = 0; i < values.length; i++) {
            if (Math.abs(values[i] - mean) <= threshold) {
                clippedValues.push(values[i]);
                clippedWeights.push(weights[i]);
            }
        }

        // If too many rejected, fall back to all values
        if (clippedValues.length < 2) {
            return this.weightedMean(values, weights);
        }

        return this.weightedMean(clippedValues, clippedWeights);
    }

    /**
     * Lucky imaging - select the sharpest pixel (highest weight)
     */
    luckyPixel(values, weights) {
        let maxWeight = -1;
        let bestValue = values[0];
        for (let i = 0; i < values.length; i++) {
            if (weights[i] > maxWeight) {
                maxWeight = weights[i];
                bestValue = values[i];
            }
        }
        return bestValue;
    }

    /**
     * Calculate weighted median (robust to outliers)
     */
    weightedMedian(items) {
        // Sort by value
        items.sort((a, b) => a.val - b.val);

        // Find weighted median
        const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
        let cumWeight = 0;
        const halfWeight = totalWeight / 2;

        for (let i = 0; i < items.length; i++) {
            cumWeight += items[i].weight;
            if (cumWeight >= halfWeight) {
                // Interpolate if we're between values
                if (i > 0 && cumWeight - items[i].weight < halfWeight) {
                    const prevVal = items[i - 1].val;
                    const currVal = items[i].val;
                    const ratio = (halfWeight - (cumWeight - items[i].weight)) / items[i].weight;
                    return Math.round(prevVal + ratio * (currVal - prevVal));
                }
                return items[i].val;
            }
        }

        return items[items.length - 1].val;
    }

    /**
     * Resize image data to match target dimensions
     */
    resizeToMatch(imageData, targetWidth, targetHeight) {
        if (imageData.width === targetWidth && imageData.height === targetHeight) {
            return imageData;
        }

        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = imageData.width;
        srcCanvas.height = imageData.height;
        const srcCtx = srcCanvas.getContext('2d');
        srcCtx.putImageData(imageData, 0, 0);

        const dstCanvas = document.createElement('canvas');
        dstCanvas.width = targetWidth;
        dstCanvas.height = targetHeight;
        const dstCtx = dstCanvas.getContext('2d');
        dstCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);

        return dstCtx.getImageData(0, 0, targetWidth, targetHeight);
    }

    /**
     * Calculate median of array
     */
    median(arr) {
        const sorted = arr.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    }

    /**
     * Apply enhancement filters - optimized for license plate text
     * Light processing to balance clarity vs artifacts
     */
    enhance(imageData) {
        let result = imageData;

        // Light unsharp mask only - no contrast adjustment
        // 0.5x strength is gentle enough to avoid halos
        result = this.unsharpMask(result, 0.5, 1);

        // Apply user's video enhancement settings
        if (this.videoEnhancements) {
            result = this.applyVideoEnhancements(result, this.videoEnhancements);
        }

        return result;
    }

    /**
     * Apply CLAHE (Contrast Limited Adaptive Histogram Equalization) using OpenCV
     * Much better than global histogram equalization for preserving local details
     */
    applyCLAHE(imageData, clipLimit = 2.0, tileSize = 8) {
        // Guard: OpenCV must be available
        if (typeof cv === 'undefined') {
            console.warn('[FrameStacker] applyCLAHE called but OpenCV not loaded, using fallback');
            return this.applyJSCLAHE(imageData, clipLimit, tileSize);
        }
        try {
            const mat = this.imageDataToMat(imageData);

            // Convert to grayscale for simpler CLAHE (more reliable in OpenCV.js)
            const gray = new cv.Mat();
            cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

            // Create CLAHE object - OpenCV.js uses createCLAHE
            const clahe = new cv.CLAHE(clipLimit, new cv.Size(tileSize, tileSize));
            const enhanced = new cv.Mat();
            clahe.apply(gray, enhanced);

            // Convert back to color by applying enhancement to each channel
            const channels = new cv.MatVector();
            const rgb = new cv.Mat();
            cv.cvtColor(mat, rgb, cv.COLOR_RGBA2RGB);
            cv.split(rgb, channels);

            // Use LAB color space for CLAHE on luminance only
            const labChannels = new cv.MatVector();
            const lab = new cv.Mat();
            cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
            cv.split(lab, labChannels);

            // Replace L channel with CLAHE result
            const lChannel = labChannels.get(0);
            enhanced.copyTo(lChannel);
            labChannels.set(0, lChannel);

            // Merge back
            const labEnhanced = new cv.Mat();
            cv.merge(labChannels, labEnhanced);

            // Convert back to RGB
            const rgbEnhanced = new cv.Mat();
            cv.cvtColor(labEnhanced, rgbEnhanced, cv.COLOR_Lab2RGB);

            // Add alpha channel back
            const finalResult = new cv.Mat();
            cv.cvtColor(rgbEnhanced, finalResult, cv.COLOR_RGB2RGBA);

            const outputData = this.matToImageData(finalResult);

            // Cleanup
            mat.delete();
            gray.delete();
            enhanced.delete();
            channels.delete();
            rgb.delete();
            lab.delete();
            labChannels.delete();
            labEnhanced.delete();
            rgbEnhanced.delete();
            finalResult.delete();

            return outputData;
        } catch (error) {
            console.warn('[FrameStacker] CLAHE failed, using fallback:', error.message);
            return this.autoContrast(imageData);
        }
    }

    /**
     * Adaptive unsharp mask - adjusts strength based on local contrast
     */
    adaptiveUnsharpMask(imageData, amount = 1.5, radius = 1) {
        const width = imageData.width;
        const height = imageData.height;
        const src = imageData.data;

        // Create blurred version
        const blurred = this.gaussianBlur(imageData, radius);
        const blur = blurred.data;

        // Calculate local variance for adaptive masking
        const variance = this.calculateLocalVariance(imageData, 3);

        const result = new ImageData(width, height);
        const dst = result.data;

        // Find variance range for normalization
        let minVar = Infinity, maxVar = 0;
        for (let i = 0; i < variance.length; i++) {
            if (variance[i] < minVar) minVar = variance[i];
            if (variance[i] > maxVar) maxVar = variance[i];
        }
        const varRange = maxVar - minVar || 1;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                const vi = y * width + x;

                // Normalize variance to 0-1, use as weight
                // Low variance areas (flat) get less sharpening
                // High variance areas (edges) get more sharpening
                const normalizedVar = (variance[vi] - minVar) / varRange;
                const adaptiveAmount = amount * (0.5 + normalizedVar * 0.5);

                for (let c = 0; c < 3; c++) {
                    const original = src[i + c];
                    const blurVal = blur[i + c];
                    const sharpened = original + adaptiveAmount * (original - blurVal);
                    dst[i + c] = Math.max(0, Math.min(255, Math.round(sharpened)));
                }
                dst[i + 3] = 255;
            }
        }

        return result;
    }

    /**
     * Calculate local variance for each pixel (used for adaptive processing)
     */
    calculateLocalVariance(imageData, radius = 2) {
        const { width, height, data } = imageData;
        const variance = new Float32Array(width * height);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let sum = 0, sumSq = 0, count = 0;

                for (let ky = -radius; ky <= radius; ky++) {
                    for (let kx = -radius; kx <= radius; kx++) {
                        const ny = Math.max(0, Math.min(height - 1, y + ky));
                        const nx = Math.max(0, Math.min(width - 1, x + kx));
                        const idx = (ny * width + nx) * 4;

                        // Use luminance
                        const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
                        sum += lum;
                        sumSq += lum * lum;
                        count++;
                    }
                }

                const mean = sum / count;
                variance[y * width + x] = (sumSq / count) - (mean * mean);
            }
        }

        return variance;
    }

    /**
     * Clarity boost - enhances mid-tone contrast for better readability
     */
    clarityBoost(imageData, strength = 0.2) {
        const { width, height, data } = imageData;
        const result = new ImageData(width, height);
        const dst = result.data;

        // Create high-pass filtered version
        const blurred = this.gaussianBlur(imageData, 2);
        const blur = blurred.data;

        for (let i = 0; i < data.length; i += 4) {
            for (let c = 0; c < 3; c++) {
                const original = data[i + c];
                const blurVal = blur[i + c];

                // High-pass filter gives us the detail
                const detail = original - blurVal;

                // Apply to mid-tones more than shadows/highlights
                // Sigmoid-like weighting centered on mid-gray
                const normalized = original / 255;
                const midtoneWeight = 4 * normalized * (1 - normalized); // Peaks at 0.5

                const boosted = original + strength * detail * midtoneWeight * 2;
                dst[i + c] = Math.max(0, Math.min(255, Math.round(boosted)));
            }
            dst[i + 3] = 255;
        }

        return result;
    }

    /**
     * Correct perspective distortion (de-skew angled plates)
     * Uses edge detection and contour analysis to find plate bounds
     */
    correctPerspective(imageData) {
        // Guard: OpenCV must be available
        if (typeof cv === 'undefined') {
            console.warn('[FrameStacker] correctPerspective called but OpenCV not loaded');
            return imageData; // Return unchanged
        }
        try {
            const mat = this.imageDataToMat(imageData);
            const gray = new cv.Mat();
            cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

            // Apply Gaussian blur to reduce noise
            const blurred = new cv.Mat();
            cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

            // Edge detection
            const edges = new cv.Mat();
            cv.Canny(blurred, edges, 50, 150);

            // Dilate edges to connect broken lines
            const dilated = new cv.Mat();
            const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
            cv.dilate(edges, dilated, kernel);

            // Find contours
            const contours = new cv.MatVector();
            const hierarchy = new cv.Mat();
            cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

            // Find the largest rectangular contour (likely the plate)
            let bestContour = null;
            let bestArea = 0;
            const minArea = (imageData.width * imageData.height) * 0.1; // At least 10% of image

            for (let i = 0; i < contours.size(); i++) {
                const contour = contours.get(i);
                const area = cv.contourArea(contour);

                if (area > minArea && area > bestArea) {
                    // Approximate contour to polygon
                    const epsilon = 0.02 * cv.arcLength(contour, true);
                    const approx = new cv.Mat();
                    cv.approxPolyDP(contour, approx, epsilon, true);

                    // Check if it's roughly rectangular (4 corners)
                    if (approx.rows === 4) {
                        bestContour = approx;
                        bestArea = area;
                    } else {
                        approx.delete();
                    }
                }
            }

            // Clean up
            gray.delete();
            blurred.delete();
            edges.delete();
            dilated.delete();
            kernel.delete();
            hierarchy.delete();

            if (!bestContour) {
                // No suitable rectangle found, try bounding box approach
                mat.delete();
                for (let i = 0; i < contours.size(); i++) {
                    contours.get(i).delete();
                }
                contours.delete();
                console.log('[FrameStacker] No rectangular contour found, skipping perspective correction');
                return null;
            }

            // Get the four corners and sort them
            const corners = [];
            for (let i = 0; i < 4; i++) {
                corners.push({
                    x: bestContour.data32S[i * 2],
                    y: bestContour.data32S[i * 2 + 1]
                });
            }

            // Sort corners: top-left, top-right, bottom-right, bottom-left
            const sortedCorners = this.sortCorners(corners);

            // Calculate output dimensions (use max width/height to avoid distortion)
            const width1 = Math.sqrt(Math.pow(sortedCorners[1].x - sortedCorners[0].x, 2) + Math.pow(sortedCorners[1].y - sortedCorners[0].y, 2));
            const width2 = Math.sqrt(Math.pow(sortedCorners[2].x - sortedCorners[3].x, 2) + Math.pow(sortedCorners[2].y - sortedCorners[3].y, 2));
            const height1 = Math.sqrt(Math.pow(sortedCorners[3].x - sortedCorners[0].x, 2) + Math.pow(sortedCorners[3].y - sortedCorners[0].y, 2));
            const height2 = Math.sqrt(Math.pow(sortedCorners[2].x - sortedCorners[1].x, 2) + Math.pow(sortedCorners[2].y - sortedCorners[1].y, 2));

            const outWidth = Math.round(Math.max(width1, width2));
            const outHeight = Math.round(Math.max(height1, height2));

            // Skip if dimensions are too different from original (likely wrong detection)
            const aspectRatio = outWidth / outHeight;
            if (aspectRatio < 1.5 || aspectRatio > 6) {
                console.log('[FrameStacker] Detected aspect ratio unusual for license plate, skipping');
                mat.delete();
                bestContour.delete();
                for (let i = 0; i < contours.size(); i++) {
                    contours.get(i).delete();
                }
                contours.delete();
                return null;
            }

            // Source points
            const srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
                sortedCorners[0].x, sortedCorners[0].y,
                sortedCorners[1].x, sortedCorners[1].y,
                sortedCorners[2].x, sortedCorners[2].y,
                sortedCorners[3].x, sortedCorners[3].y
            ]);

            // Destination points (rectangle)
            const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
                0, 0,
                outWidth, 0,
                outWidth, outHeight,
                0, outHeight
            ]);

            // Get perspective transform
            const M = cv.getPerspectiveTransform(srcPoints, dstPoints);

            // Apply transform
            const warped = new cv.Mat();
            cv.warpPerspective(mat, warped, M, new cv.Size(outWidth, outHeight));

            // Convert back to ImageData
            const result = this.matToImageData(warped);

            // Cleanup
            mat.delete();
            bestContour.delete();
            srcPoints.delete();
            dstPoints.delete();
            M.delete();
            warped.delete();
            for (let i = 0; i < contours.size(); i++) {
                contours.get(i).delete();
            }
            contours.delete();

            console.log(`[FrameStacker] Perspective corrected: ${imageData.width}x${imageData.height} -> ${outWidth}x${outHeight}`);
            return result;

        } catch (e) {
            console.warn('[FrameStacker] Perspective correction failed:', e);
            return null;
        }
    }

    /**
     * Sort corners into order: top-left, top-right, bottom-right, bottom-left
     */
    sortCorners(corners) {
        // Find center
        const cx = corners.reduce((s, c) => s + c.x, 0) / 4;
        const cy = corners.reduce((s, c) => s + c.y, 0) / 4;

        // Sort by angle from center
        const sorted = corners.map(c => ({
            ...c,
            angle: Math.atan2(c.y - cy, c.x - cx)
        })).sort((a, b) => a.angle - b.angle);

        // Rearrange to: top-left, top-right, bottom-right, bottom-left
        // Find top-left (smallest x+y sum)
        let minSum = Infinity, tlIdx = 0;
        for (let i = 0; i < 4; i++) {
            const sum = sorted[i].x + sorted[i].y;
            if (sum < minSum) {
                minSum = sum;
                tlIdx = i;
            }
        }

        // Reorder starting from top-left
        const result = [];
        for (let i = 0; i < 4; i++) {
            result.push(sorted[(tlIdx + i) % 4]);
        }

        return result;
    }

    /**
     * Auto white balance using gray world assumption
     * Assumes the average color should be neutral gray
     */
    autoWhiteBalance(imageData) {
        const data = new Uint8ClampedArray(imageData.data);
        const width = imageData.width;
        const height = imageData.height;
        const pixelCount = width * height;

        // Calculate average of each channel
        let sumR = 0, sumG = 0, sumB = 0;
        for (let i = 0; i < data.length; i += 4) {
            sumR += data[i];
            sumG += data[i + 1];
            sumB += data[i + 2];
        }

        const avgR = sumR / pixelCount;
        const avgG = sumG / pixelCount;
        const avgB = sumB / pixelCount;

        // Calculate overall average (target gray)
        const avgGray = (avgR + avgG + avgB) / 3;

        // Calculate correction factors
        const factorR = avgGray / avgR;
        const factorG = avgGray / avgG;
        const factorB = avgGray / avgB;

        // Limit correction to prevent extreme changes (max 50% adjustment)
        const clampFactor = (f) => Math.max(0.5, Math.min(1.5, f));
        const corrR = clampFactor(factorR);
        const corrG = clampFactor(factorG);
        const corrB = clampFactor(factorB);

        // Apply correction
        for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.max(0, Math.min(255, Math.round(data[i] * corrR)));
            data[i + 1] = Math.max(0, Math.min(255, Math.round(data[i + 1] * corrG)));
            data[i + 2] = Math.max(0, Math.min(255, Math.round(data[i + 2] * corrB)));
        }

        return new ImageData(data, width, height);
    }

    /**
     * Apply user's video enhancement settings (brightness, contrast, saturation)
     * Values are 0-200, where 100 is normal
     */
    applyVideoEnhancements(imageData, settings) {
        const { brightness, contrast, saturation } = settings;

        // Skip if all settings are default
        if (brightness === 100 && contrast === 100 && saturation === 100) {
            return imageData;
        }

        const data = new Uint8ClampedArray(imageData.data);
        const width = imageData.width;
        const height = imageData.height;

        // Brightness factor (0-2, 1 = normal)
        const brightnessFactor = brightness / 100;

        // Contrast factor (0-2, 1 = normal)
        const contrastFactor = contrast / 100;

        // Saturation factor (0-2, 1 = normal)
        const saturationFactor = saturation / 100;

        for (let i = 0; i < data.length; i += 4) {
            let r = data[i];
            let g = data[i + 1];
            let b = data[i + 2];

            // Apply brightness
            r *= brightnessFactor;
            g *= brightnessFactor;
            b *= brightnessFactor;

            // Apply contrast (around midpoint 128)
            r = (r - 128) * contrastFactor + 128;
            g = (g - 128) * contrastFactor + 128;
            b = (b - 128) * contrastFactor + 128;

            // Apply saturation
            if (saturationFactor !== 1) {
                const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                r = gray + (r - gray) * saturationFactor;
                g = gray + (g - gray) * saturationFactor;
                b = gray + (b - gray) * saturationFactor;
            }

            // Clamp values
            data[i] = Math.max(0, Math.min(255, Math.round(r)));
            data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
            data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
        }

        return new ImageData(data, width, height);
    }

    /**
     * LAB color space enhancement - sharpen and contrast only the luminance
     * This is the gold standard for avoiding color artifacts
     */
    enhanceLAB(imageData) {
        const { width, height, data } = imageData;
        const result = new ImageData(width, height);
        const dst = result.data;

        // Convert RGB to LAB, process L, convert back
        const labData = this.rgbToLab(data, width, height);

        // Step 1: Percentile-based histogram stretch on L channel (preserves detail better)
        const sortedL = [...labData.L].sort((a, b) => a - b);
        const p2 = sortedL[Math.floor(sortedL.length * 0.02)];  // 2nd percentile
        const p98 = sortedL[Math.floor(sortedL.length * 0.98)]; // 98th percentile
        const rangeL = p98 - p2 || 1;
        for (let i = 0; i < labData.L.length; i++) {
            labData.L[i] = Math.max(0, Math.min(100, ((labData.L[i] - p2) / rangeL) * 100));
        }

        // Step 2: Gentle unsharp mask on L channel only (1.0x strength)
        const blurredL = this.blur1DChannel(labData.L, width, height);
        for (let i = 0; i < labData.L.length; i++) {
            const sharpened = labData.L[i] + 1.0 * (labData.L[i] - blurredL[i]);
            labData.L[i] = Math.max(0, Math.min(100, sharpened));
        }

        // Convert back to RGB
        this.labToRgb(labData, dst, width, height);

        return result;
    }

    /**
     * Convert RGB to LAB color space
     */
    rgbToLab(data, width, height) {
        const size = width * height;
        const L = new Float32Array(size);
        const a = new Float32Array(size);
        const b = new Float32Array(size);

        for (let i = 0; i < size; i++) {
            const idx = i * 4;
            let r = data[idx] / 255;
            let g = data[idx + 1] / 255;
            let bl = data[idx + 2] / 255;

            // RGB to XYZ
            r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
            g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
            bl = bl > 0.04045 ? Math.pow((bl + 0.055) / 1.055, 2.4) : bl / 12.92;

            const x = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047;
            const y = (r * 0.2126 + g * 0.7152 + bl * 0.0722) / 1.00000;
            const z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883;

            // XYZ to LAB
            const fx = x > 0.008856 ? Math.pow(x, 1/3) : (7.787 * x) + 16/116;
            const fy = y > 0.008856 ? Math.pow(y, 1/3) : (7.787 * y) + 16/116;
            const fz = z > 0.008856 ? Math.pow(z, 1/3) : (7.787 * z) + 16/116;

            L[i] = (116 * fy) - 16;
            a[i] = 500 * (fx - fy);
            b[i] = 200 * (fy - fz);
        }

        return { L, a, b };
    }

    /**
     * Convert LAB back to RGB
     */
    labToRgb(labData, dst, width, height) {
        const size = width * height;

        for (let i = 0; i < size; i++) {
            const idx = i * 4;

            // LAB to XYZ
            const fy = (labData.L[i] + 16) / 116;
            const fx = labData.a[i] / 500 + fy;
            const fz = fy - labData.b[i] / 200;

            const x = 0.95047 * (fx > 0.206897 ? fx * fx * fx : (fx - 16/116) / 7.787);
            const y = 1.00000 * (fy > 0.206897 ? fy * fy * fy : (fy - 16/116) / 7.787);
            const z = 1.08883 * (fz > 0.206897 ? fz * fz * fz : (fz - 16/116) / 7.787);

            // XYZ to RGB
            let r = x *  3.2406 + y * -1.5372 + z * -0.4986;
            let g = x * -0.9689 + y *  1.8758 + z *  0.0415;
            let b = x *  0.0557 + y * -0.2040 + z *  1.0570;

            // Linear to sRGB
            r = r > 0.0031308 ? 1.055 * Math.pow(r, 1/2.4) - 0.055 : 12.92 * r;
            g = g > 0.0031308 ? 1.055 * Math.pow(g, 1/2.4) - 0.055 : 12.92 * g;
            b = b > 0.0031308 ? 1.055 * Math.pow(b, 1/2.4) - 0.055 : 12.92 * b;

            dst[idx] = Math.max(0, Math.min(255, Math.round(r * 255)));
            dst[idx + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
            dst[idx + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
            dst[idx + 3] = 255;
        }
    }

    /**
     * Simple box blur on a single channel
     */
    blur1DChannel(channel, width, height) {
        const result = new Float32Array(channel.length);
        const radius = 1;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let sum = 0, count = 0;
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        const ny = Math.max(0, Math.min(height - 1, y + dy));
                        const nx = Math.max(0, Math.min(width - 1, x + dx));
                        sum += channel[ny * width + nx];
                        count++;
                    }
                }
                result[y * width + x] = sum / count;
            }
        }

        return result;
    }

    /**
     * Auto contrast via luminance histogram stretching (preserves color)
     * Only adjusts brightness, not individual RGB channels
     */
    autoContrastLuminance(imageData) {
        const data = new Uint8ClampedArray(imageData.data);
        const width = imageData.width;
        const height = imageData.height;

        // Find min/max luminance
        let minLum = 255, maxLum = 0;
        for (let i = 0; i < data.length; i += 4) {
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            minLum = Math.min(minLum, lum);
            maxLum = Math.max(maxLum, lum);
        }

        const range = maxLum - minLum;
        if (range < 10) return imageData; // Skip if already good contrast

        // Stretch luminance while preserving color ratios
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;

            // Calculate target luminance (stretched)
            const targetLum = ((lum - minLum) / range) * 255;

            // Scale RGB to match target luminance
            if (lum > 0) {
                const scale = targetLum / lum;
                data[i] = Math.max(0, Math.min(255, Math.round(r * scale)));
                data[i + 1] = Math.max(0, Math.min(255, Math.round(g * scale)));
                data[i + 2] = Math.max(0, Math.min(255, Math.round(b * scale)));
            }
        }

        return new ImageData(data, width, height);
    }

    /**
     * Auto contrast via histogram stretching
     */
    autoContrast(imageData) {
        const data = new Uint8ClampedArray(imageData.data);
        const width = imageData.width;
        const height = imageData.height;

        // Find min/max for each channel
        let minR = 255, maxR = 0;
        let minG = 255, maxG = 0;
        let minB = 255, maxB = 0;

        for (let i = 0; i < data.length; i += 4) {
            minR = Math.min(minR, data[i]);
            maxR = Math.max(maxR, data[i]);
            minG = Math.min(minG, data[i + 1]);
            maxG = Math.max(maxG, data[i + 1]);
            minB = Math.min(minB, data[i + 2]);
            maxB = Math.max(maxB, data[i + 2]);
        }

        // Stretch to full range
        const rangeR = maxR - minR || 1;
        const rangeG = maxG - minG || 1;
        const rangeB = maxB - minB || 1;

        for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.round(((data[i] - minR) / rangeR) * 255);
            data[i + 1] = Math.round(((data[i + 1] - minG) / rangeG) * 255);
            data[i + 2] = Math.round(((data[i + 2] - minB) / rangeB) * 255);
        }

        return new ImageData(data, width, height);
    }

    /**
     * Unsharp mask sharpening
     */
    unsharpMask(imageData, amount = 1.0, radius = 1) {
        const width = imageData.width;
        const height = imageData.height;

        // Create blurred version
        const blurred = this.gaussianBlur(imageData, radius);

        const result = new ImageData(width, height);
        const src = imageData.data;
        const blur = blurred.data;
        const dst = result.data;

        for (let i = 0; i < src.length; i += 4) {
            for (let c = 0; c < 3; c++) {
                const original = src[i + c];
                const blurVal = blur[i + c];
                const sharpened = original + amount * (original - blurVal);
                dst[i + c] = Math.max(0, Math.min(255, Math.round(sharpened)));
            }
            dst[i + 3] = 255;
        }

        return result;
    }

    /**
     * Simple Gaussian blur
     */
    gaussianBlur(imageData, radius = 1) {
        const width = imageData.width;
        const height = imageData.height;
        const src = imageData.data;

        // Simple 3x3 Gaussian kernel
        const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
        const kernelSum = 16;

        const result = new ImageData(width, height);
        const dst = result.data;

        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                for (let c = 0; c < 3; c++) {
                    let sum = 0;
                    let ki = 0;
                    for (let ky = -1; ky <= 1; ky++) {
                        for (let kx = -1; kx <= 1; kx++) {
                            const idx = ((y + ky) * width + (x + kx)) * 4 + c;
                            sum += src[idx] * kernel[ki++];
                        }
                    }
                    const idx = (y * width + x) * 4 + c;
                    dst[idx] = Math.round(sum / kernelSum);
                }
                dst[(y * width + x) * 4 + 3] = 255;
            }
        }

        // Copy edges
        for (let x = 0; x < width; x++) {
            for (let c = 0; c < 4; c++) {
                dst[x * 4 + c] = src[x * 4 + c];
                dst[((height - 1) * width + x) * 4 + c] = src[((height - 1) * width + x) * 4 + c];
            }
        }
        for (let y = 0; y < height; y++) {
            for (let c = 0; c < 4; c++) {
                dst[(y * width) * 4 + c] = src[(y * width) * 4 + c];
                dst[(y * width + width - 1) * 4 + c] = src[(y * width + width - 1) * 4 + c];
            }
        }

        return result;
    }

    /**
     * Simple edge-preserving denoise (bilateral-like)
     * @param {ImageData} imageData - Input image
     * @param {number} strength - Denoise strength multiplier (default 1.0)
     */
    simpleDenoisePreserveEdges(imageData, strength = 1.0) {
        const width = imageData.width;
        const height = imageData.height;
        const src = imageData.data;

        const result = new ImageData(width, height);
        const dst = result.data;

        const spatialSigma = 1.5 * strength;
        const rangeSigma = 30 * strength;
        const radius = Math.min(3, Math.round(2 * strength)); // Max radius 3

        for (let y = radius; y < height - radius; y++) {
            for (let x = radius; x < width - radius; x++) {
                const centerIdx = (y * width + x) * 4;

                for (let c = 0; c < 3; c++) {
                    const centerVal = src[centerIdx + c];
                    let sum = 0;
                    let weightSum = 0;

                    for (let ky = -radius; ky <= radius; ky++) {
                        for (let kx = -radius; kx <= radius; kx++) {
                            const idx = ((y + ky) * width + (x + kx)) * 4 + c;
                            const val = src[idx];

                            // Spatial weight
                            const spatialDist = Math.sqrt(kx * kx + ky * ky);
                            const spatialWeight = Math.exp(-(spatialDist * spatialDist) / (2 * spatialSigma * spatialSigma));

                            // Range weight (color similarity)
                            const rangeDiff = Math.abs(val - centerVal);
                            const rangeWeight = Math.exp(-(rangeDiff * rangeDiff) / (2 * rangeSigma * rangeSigma));

                            const weight = spatialWeight * rangeWeight;
                            sum += val * weight;
                            weightSum += weight;
                        }
                    }

                    dst[centerIdx + c] = Math.round(sum / weightSum);
                }
                dst[centerIdx + 3] = 255;
            }
        }

        // Copy edges
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (y < radius || y >= height - radius || x < radius || x >= width - radius) {
                    const idx = (y * width + x) * 4;
                    for (let c = 0; c < 4; c++) {
                        dst[idx + c] = src[idx + c];
                    }
                }
            }
        }

        return result;
    }

    /**
     * Convert ImageData to data URL
     */
    imageDataToDataUrl(imageData) {
        const canvas = document.createElement('canvas');
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(imageData, 0, 0);
        return canvas.toDataURL('image/png');
    }

    /**
     * Align frames using edge-based correlation (translation only, no warping)
     * Preserves pixel quality by only shifting, not warping
     */
    async alignFrames(frames, onProgress = null) {
        if (frames.length < 2) return frames;

        const reference = frames[0]; // Sharpest frame is first
        const refEdges = this.detectEdges(reference.imageData);

        const alignedFrames = [reference]; // Reference stays as-is

        for (let i = 1; i < frames.length; i++) {
            if (onProgress) {
                onProgress(i / frames.length);
                await new Promise(r => setTimeout(r, 0));
            }

            try {
                const frame = frames[i];
                const frameEdges = this.detectEdges(frame.imageData);

                // Find best translation offset using edge correlation
                const offset = this.findBestOffset(refEdges, frameEdges, 10); // Max 10px search

                if (offset.x === 0 && offset.y === 0) {
                    // No shift needed
                    alignedFrames.push(frame);
                } else {
                    // Shift frame by offset (no interpolation, preserves pixels)
                    const shifted = this.shiftImage(frame.imageData, offset.x, offset.y);
                    alignedFrames.push({
                        ...frame,
                        imageData: shifted,
                        aligned: true,
                        offset: offset
                    });
                }

            } catch (e) {
                console.warn('[FrameStacker] Edge alignment failed for frame', i, e);
                alignedFrames.push(frames[i]);
            }
        }

        console.log(`[FrameStacker] Edge-aligned ${alignedFrames.filter(f => f.aligned).length}/${frames.length - 1} frames`);
        return alignedFrames;
    }

    /**
     * Detect edges using Sobel operator
     * Returns edge magnitude image as grayscale array
     */
    detectEdges(imageData) {
        const { width, height, data } = imageData;
        const edges = new Float32Array(width * height);

        // Convert to grayscale and apply Sobel
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                // Get 3x3 neighborhood grayscale values
                const getGray = (px, py) => {
                    const idx = (py * width + px) * 4;
                    return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
                };

                // Sobel X kernel: [-1 0 1; -2 0 2; -1 0 1]
                const gx = -getGray(x-1, y-1) + getGray(x+1, y-1)
                         - 2*getGray(x-1, y) + 2*getGray(x+1, y)
                         - getGray(x-1, y+1) + getGray(x+1, y+1);

                // Sobel Y kernel: [-1 -2 -1; 0 0 0; 1 2 1]
                const gy = -getGray(x-1, y-1) - 2*getGray(x, y-1) - getGray(x+1, y-1)
                         + getGray(x-1, y+1) + 2*getGray(x, y+1) + getGray(x+1, y+1);

                // Edge magnitude
                edges[y * width + x] = Math.sqrt(gx * gx + gy * gy);
            }
        }

        return { data: edges, width, height };
    }

    /**
     * Find best translation offset using normalized cross-correlation on edges
     */
    findBestOffset(refEdges, frameEdges, maxOffset) {
        const { width, height } = refEdges;
        let bestScore = -Infinity;
        let bestOffset = { x: 0, y: 0 };

        // Search in a window around (0,0)
        for (let dy = -maxOffset; dy <= maxOffset; dy++) {
            for (let dx = -maxOffset; dx <= maxOffset; dx++) {
                let score = 0;
                let count = 0;

                // Calculate correlation for this offset
                for (let y = maxOffset; y < height - maxOffset; y++) {
                    for (let x = maxOffset; x < width - maxOffset; x++) {
                        const refVal = refEdges.data[y * width + x];
                        const frameY = y + dy;
                        const frameX = x + dx;

                        if (frameY >= 0 && frameY < height && frameX >= 0 && frameX < width) {
                            const frameVal = frameEdges.data[frameY * width + frameX];
                            // Multiply edge values (high where both have edges)
                            score += refVal * frameVal;
                            count++;
                        }
                    }
                }

                if (count > 0) {
                    score /= count;
                    if (score > bestScore) {
                        bestScore = score;
                        bestOffset = { x: dx, y: dy };
                    }
                }
            }
        }

        return bestOffset;
    }

    /**
     * Shift image by integer offset (no interpolation, preserves pixels)
     * Edge pixels are filled by clamping to nearest valid pixel
     */
    shiftImage(imageData, dx, dy) {
        const { width, height, data } = imageData;
        const result = new ImageData(width, height);
        const dst = result.data;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                // Clamp source coordinates to valid range (edge extension)
                const srcX = Math.max(0, Math.min(width - 1, x - dx));
                const srcY = Math.max(0, Math.min(height - 1, y - dy));

                const srcIdx = (srcY * width + srcX) * 4;
                const dstIdx = (y * width + x) * 4;
                dst[dstIdx] = data[srcIdx];
                dst[dstIdx + 1] = data[srcIdx + 1];
                dst[dstIdx + 2] = data[srcIdx + 2];
                dst[dstIdx + 3] = data[srcIdx + 3];
            }
        }

        return result;
    }

    /**
     * OLD: Align frames using feature matching (ORB features + homography)
     * DEPRECATED - causes quality loss due to pixel interpolation
     */
    async alignFramesORB(frames, onProgress = null) {
        if (frames.length < 2) return frames;

        // Guard: OpenCV must be available
        if (typeof cv === 'undefined') {
            console.warn('[FrameStacker] alignFramesORB called but OpenCV not loaded');
            return frames; // Return unchanged
        }

        const reference = frames[0]; // Sharpest frame is first
        const refMat = this.imageDataToMat(reference.imageData);
        const refGray = new cv.Mat();
        cv.cvtColor(refMat, refGray, cv.COLOR_RGBA2GRAY);

        // Detect ORB features in reference
        const orb = new cv.ORB(500);
        const refKeypoints = new cv.KeyPointVector();
        const refDescriptors = new cv.Mat();
        orb.detectAndCompute(refGray, new cv.Mat(), refKeypoints, refDescriptors);

        const alignedFrames = [reference]; // Reference stays as-is

        for (let i = 1; i < frames.length; i++) {
            if (onProgress && i % 5 === 0) {
                onProgress(i / frames.length);
                await new Promise(r => setTimeout(r, 0));
            }

            try {
                const frame = frames[i];
                const frameMat = this.imageDataToMat(frame.imageData);
                const frameGray = new cv.Mat();
                cv.cvtColor(frameMat, frameGray, cv.COLOR_RGBA2GRAY);

                // Detect features in this frame
                const frameKeypoints = new cv.KeyPointVector();
                const frameDescriptors = new cv.Mat();
                orb.detectAndCompute(frameGray, new cv.Mat(), frameKeypoints, frameDescriptors);

                if (frameDescriptors.rows < 10) {
                    // Not enough features, use original
                    alignedFrames.push(frame);
                    frameMat.delete();
                    frameGray.delete();
                    frameKeypoints.delete();
                    frameDescriptors.delete();
                    continue;
                }

                // Match features
                const bf = new cv.BFMatcher(cv.NORM_HAMMING, true);
                const matches = new cv.DMatchVector();
                bf.match(refDescriptors, frameDescriptors, matches);

                if (matches.size() < 10) {
                    // Not enough matches, use original
                    alignedFrames.push(frame);
                    frameMat.delete();
                    frameGray.delete();
                    frameKeypoints.delete();
                    frameDescriptors.delete();
                    matches.delete();
                    continue;
                }

                // Get matched points
                const srcPoints = [];
                const dstPoints = [];
                for (let j = 0; j < matches.size(); j++) {
                    const match = matches.get(j);
                    const refPt = refKeypoints.get(match.queryIdx).pt;
                    const framePt = frameKeypoints.get(match.trainIdx).pt;
                    srcPoints.push(framePt.x, framePt.y);
                    dstPoints.push(refPt.x, refPt.y);
                }

                // Find homography
                const srcMat = cv.matFromArray(srcPoints.length / 2, 1, cv.CV_32FC2, srcPoints);
                const dstMat = cv.matFromArray(dstPoints.length / 2, 1, cv.CV_32FC2, dstPoints);
                const H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 3);

                if (H.empty()) {
                    alignedFrames.push(frame);
                } else {
                    // Warp frame to align with reference
                    const aligned = new cv.Mat();
                    cv.warpPerspective(frameMat, aligned, H, new cv.Size(refMat.cols, refMat.rows));

                    const alignedImageData = this.matToImageData(aligned);
                    alignedFrames.push({
                        ...frame,
                        imageData: alignedImageData,
                        aligned: true
                    });
                    aligned.delete();
                }

                // Cleanup
                frameMat.delete();
                frameGray.delete();
                frameKeypoints.delete();
                frameDescriptors.delete();
                matches.delete();
                srcMat.delete();
                dstMat.delete();
                if (!H.empty()) H.delete();

            } catch (e) {
                console.warn('[FrameStacker] Alignment failed for frame', i, e);
                alignedFrames.push(frames[i]);
            }
        }

        // Cleanup reference
        refMat.delete();
        refGray.delete();
        refKeypoints.delete();
        refDescriptors.delete();
        orb.delete();

        console.log(`[FrameStacker] Aligned ${alignedFrames.filter(f => f.aligned).length}/${frames.length - 1} frames`);
        return alignedFrames;
    }

    /**
     * Apply motion deblur to frames that appear blurry
     * Uses Wiener deconvolution with estimated motion kernel
     */
    async applyMotionDeblur(frames, onProgress = null) {
        const result = [];
        const sharpnessThreshold = frames[0].sharpness * 0.5; // Deblur frames less than 50% of max sharpness

        for (let i = 0; i < frames.length; i++) {
            if (onProgress && i % 5 === 0) {
                onProgress(i / frames.length);
                await new Promise(r => setTimeout(r, 0));
            }

            const frame = frames[i];

            // Only deblur if significantly blurrier than the sharpest
            if (frame.sharpness < sharpnessThreshold) {
                try {
                    const deblurred = this.wienerDeblur(frame.imageData);
                    result.push({
                        ...frame,
                        imageData: deblurred,
                        deblurred: true
                    });
                } catch (e) {
                    console.warn('[FrameStacker] Deblur failed for frame', i, e);
                    result.push(frame);
                }
            } else {
                result.push(frame);
            }
        }

        console.log(`[FrameStacker] Deblurred ${result.filter(f => f.deblurred).length} frames`);
        return result;
    }

    /**
     * Simple Wiener deconvolution for motion blur
     * Estimates a small motion kernel and deconvolves
     */
    wienerDeblur(imageData) {
        // For simplicity, we'll use a sharpening approach that approximates deblur
        // True Wiener deconvolution requires FFT which is complex in pure JS

        const width = imageData.width;
        const height = imageData.height;
        const src = imageData.data;
        const result = new Uint8ClampedArray(src.length);

        // High-pass sharpening kernel (approximates deconvolution for small blur)
        // This is a 5x5 unsharp mask with stronger effect
        const kernel = [
            0, -1, -1, -1, 0,
            -1, -1, 8, -1, -1,
            -1, 8, 32, 8, -1,
            -1, -1, 8, -1, -1,
            0, -1, -1, -1, 0
        ];
        const kernelSum = 16;
        const radius = 2;

        for (let y = radius; y < height - radius; y++) {
            for (let x = radius; x < width - radius; x++) {
                for (let c = 0; c < 3; c++) {
                    let sum = 0;
                    let ki = 0;
                    for (let ky = -radius; ky <= radius; ky++) {
                        for (let kx = -radius; kx <= radius; kx++) {
                            const idx = ((y + ky) * width + (x + kx)) * 4 + c;
                            sum += src[idx] * kernel[ki++];
                        }
                    }
                    const idx = (y * width + x) * 4 + c;
                    result[idx] = Math.max(0, Math.min(255, Math.round(sum / kernelSum)));
                }
                result[(y * width + x) * 4 + 3] = 255;
            }
        }

        // Copy edges
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (y < radius || y >= height - radius || x < radius || x >= width - radius) {
                    const idx = (y * width + x) * 4;
                    for (let c = 0; c < 4; c++) {
                        result[idx + c] = src[idx + c];
                    }
                }
            }
        }

        return new ImageData(result, width, height);
    }

    /**
     * Convert ImageData to OpenCV Mat
     */
    imageDataToMat(imageData) {
        if (typeof cv === 'undefined') {
            throw new Error('OpenCV not loaded');
        }
        const mat = new cv.Mat(imageData.height, imageData.width, cv.CV_8UC4);
        mat.data.set(imageData.data);
        return mat;
    }

    /**
     * Convert OpenCV Mat to ImageData
     */
    matToImageData(mat) {
        const imageData = new ImageData(mat.cols, mat.rows);
        // Handle different Mat types
        if (mat.channels() === 4) {
            imageData.data.set(mat.data);
        } else if (mat.channels() === 3) {
            const rgba = new cv.Mat();
            cv.cvtColor(mat, rgba, cv.COLOR_RGB2RGBA);
            imageData.data.set(rgba.data);
            rgba.delete();
        } else {
            const rgba = new cv.Mat();
            cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
            imageData.data.set(rgba.data);
            rgba.delete();
        }
        return imageData;
    }

    /**
     * Load the ONNX super-resolution model
     */
    async loadSRModel() {
        if (this.srSession) return true;
        if (this.srModelLoading) {
            while (this.srModelLoading) {
                await new Promise(r => setTimeout(r, 147));
            }
            return !!this.srSession;
        }

        this.srModelLoading = true;
        console.log('[FrameStacker] Loading super-resolution model...');

        try {
            if (typeof ort === 'undefined') {
                console.warn('[FrameStacker] ONNX Runtime not available, falling back to bicubic');
                this.srModelLoading = false;
                return false;
            }

            // Configure ONNX Runtime
            ort.env.wasm.numThreads = 1;

            // Load the model
            const response = await fetch(this.srModelPath);
            if (!response.ok) {
                throw new Error(`Failed to fetch model: ${response.status}`);
            }
            const modelBuffer = await response.arrayBuffer();

            this.srSession = await ort.InferenceSession.create(modelBuffer, {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all'
            });

            console.log('[FrameStacker] Super-resolution model loaded successfully');
            this.srModelLoading = false;
            return true;
        } catch (error) {
            console.error('[FrameStacker] Failed to load SR model:', error);
            this.srModelLoading = false;
            return false;
        }
    }

    /**
     * Apply super-resolution upscaling
     * For small images (license plates), uses high-quality bicubic with adaptive sharpening
     * Uses UpscalerJS with ESRGAN-Slim for AI-powered super-resolution
     * Falls back to enhanced bicubic if UpscalerJS unavailable
     * @param {ImageData} imageData - Input image
     * @param {number} scale - Requested scale (2, 3, or 4)
     */
    async applyMLUpscale(imageData, scale = 4) {
        let currentData = imageData;
        const srcWidth = imageData.width;
        const srcHeight = imageData.height;
        const modelType = this.mlModelType || 'default';

        console.log(`[FrameStacker] *** AI ENHANCEMENT PIPELINE ***`);
        console.log(`[FrameStacker] Input: ${srcWidth}x${srcHeight}, target scale: ${scale}x, model: ${modelType}`);

        // Check if UpscalerJS is available
        if (typeof Upscaler === 'undefined') {
            console.log('[FrameStacker] UpscalerJS not loaded - using enhanced bicubic');
            return this.enhancedBicubicUpscale(imageData, scale);
        }

        // STAGE 1: Pre-processing (multiple modes available)
        if (this.enablePreProcessing || this.enhancementMode) {
            // New enhancement mode system
            if (this.enhancementMode && this.enhancementMode !== 'none') {
                console.log(`[FrameStacker] 🔥 Enhancement mode: ${this.enhancementMode}`);
                currentData = await this.applyEnhancementMode(currentData);
            }
            // Legacy enablePreProcessing flag (defaults to msr-clahe)
            else if (this.enablePreProcessing) {
                console.log('[FrameStacker] 🔥 MAX QUALITY Pipeline - Pre-processing enabled');
                currentData = await this.applyMAXIMPreProcessing(currentData);
            }
        }

        // Check for thick model availability
        const useThick = modelType === 'thick' && typeof ESRGANThick4x !== 'undefined';
        const useDefault = typeof DefaultUpscalerJSModel !== 'undefined';

        if (!useThick && !useDefault) {
            console.log('[FrameStacker] No ESRGAN model available - using enhanced bicubic');
            return this.enhancedBicubicUpscale(currentData, scale);
        }

        try {
            // STAGE 2: Initialize appropriate upscaler
            if (useThick) {
                // Use ESRGAN-Thick 4x model (native 4x, best quality)
                if (!this.esrganThickUpscaler) {
                    console.log('[FrameStacker] Initializing ESRGAN-Thick 4x model (BEST QUALITY)...');
                    this.esrganThickUpscaler = new Upscaler({
                        model: ESRGANThick4x
                    });
                    await this.esrganThickUpscaler.warmup();
                    console.log('[FrameStacker] ESRGAN-Thick 4x model ready');
                }
            } else {
                // Use default 2x model
                if (!this.esrganUpscaler) {
                    console.log('[FrameStacker] Initializing ESRGAN default model (2x)...');
                    this.esrganUpscaler = new Upscaler({
                        model: DefaultUpscalerJSModel
                    });
                    await this.esrganUpscaler.warmup();
                    console.log('[FrameStacker] ESRGAN default model ready');
                }
            }

            // STAGE 3: Convert ImageData to canvas for UpscalerJS
            const srcCanvas = document.createElement('canvas');
            srcCanvas.width = currentData.width;
            srcCanvas.height = currentData.height;
            const srcCtx = srcCanvas.getContext('2d');
            srcCtx.putImageData(currentData, 0, 0);

            // Debug: Sample input pixel values
            const inputCenterIdx = (Math.floor(currentData.height / 2) * currentData.width + Math.floor(currentData.width / 2)) * 4;
            console.log(`[FrameStacker] ESRGAN INPUT center pixel RGBA: ${currentData.data[inputCenterIdx]}, ${currentData.data[inputCenterIdx+1]}, ${currentData.data[inputCenterIdx+2]}, ${currentData.data[inputCenterIdx+3]}`);
            // Sample a few more pixels
            console.log(`[FrameStacker] ESRGAN INPUT first 3 pixels: (${currentData.data[0]},${currentData.data[1]},${currentData.data[2]}) (${currentData.data[4]},${currentData.data[5]},${currentData.data[6]}) (${currentData.data[8]},${currentData.data[9]},${currentData.data[10]})`);

            const startTime = performance.now();
            let currentSrc;

            // For small images, don't use patching to avoid seam artifacts
            const isSmallImage = currentData.width < 256 || currentData.height < 256;

            if (useThick) {
                // ESRGAN-Thick 4x: Single pass native 4x upscaling
                console.log(`[FrameStacker] Running ESRGAN-Thick 4x inference (${isSmallImage ? 'no patching' : 'with patching'})...`);
                const options = isSmallImage ? { output: 'base64' } : { patchSize: 64, padding: 8, output: 'base64' };
                currentSrc = await this.esrganThickUpscaler.upscale(srcCanvas, options);
            } else {
                // Default 2x model: Two-pass for 4x
                console.log(`[FrameStacker] Running ESRGAN 2x inference (pass 1, ${isSmallImage ? 'no patching' : 'with patching'})...`);
                const options = isSmallImage ? { output: 'base64' } : { patchSize: 64, padding: 6, output: 'base64' };
                currentSrc = await this.esrganUpscaler.upscale(srcCanvas, options);

                // For 4x scale, apply ESRGAN again
                if (scale >= 4) {
                    console.log('[FrameStacker] Running ESRGAN 2x inference (pass 2)...');
                    const pass1Img = new Image();
                    await new Promise((resolve, reject) => {
                        pass1Img.onload = resolve;
                        pass1Img.onerror = reject;
                        pass1Img.src = currentSrc;
                    });

                    const pass1Canvas = document.createElement('canvas');
                    pass1Canvas.width = pass1Img.width;
                    pass1Canvas.height = pass1Img.height;
                    pass1Canvas.getContext('2d').drawImage(pass1Img, 0, 0);

                    // Second pass - check if still small enough to skip patching
                    const pass1Small = pass1Img.width < 512 || pass1Img.height < 512;
                    const pass2Options = pass1Small ? { output: 'base64' } : { patchSize: 64, padding: 6, output: 'base64' };
                    currentSrc = await this.esrganUpscaler.upscale(pass1Canvas, pass2Options);
                }
            }

            const inferenceTime = performance.now() - startTime;
            console.log(`[FrameStacker] ESRGAN inference took ${inferenceTime.toFixed(0)}ms`);

            // Debug: Check what type of output we received
            const outputType = typeof currentSrc;
            const isDataUrl = outputType === 'string' && currentSrc.startsWith('data:');
            const isTensor = currentSrc && typeof currentSrc.dataSync === 'function';
            console.log(`[FrameStacker] ESRGAN output type: ${outputType}, isDataUrl: ${isDataUrl}, isTensor: ${isTensor}`);

            if (isDataUrl) {
                console.log(`[FrameStacker] Data URL prefix: ${currentSrc.substring(0, 50)}...`);
            }

            // Convert base64 result back to ImageData
            const resultImg = new Image();
            await new Promise((resolve, reject) => {
                resultImg.onload = async () => {
                    // Ensure image is fully decoded before continuing
                    if (resultImg.decode) {
                        try {
                            await resultImg.decode();
                        } catch (e) {
                            console.warn('[FrameStacker] Image decode failed, continuing anyway:', e);
                        }
                    }
                    resolve();
                };
                resultImg.onerror = (e) => {
                    console.error('[FrameStacker] Image load error:', e);
                    reject(e);
                };
                resultImg.src = currentSrc;
            });

            // Debug: Check actual ESRGAN output dimensions vs expected
            console.log(`[FrameStacker] ESRGAN output image: ${resultImg.width}x${resultImg.height} (natural: ${resultImg.naturalWidth}x${resultImg.naturalHeight})`);
            // Debug: Log base64 preview to check if it's a valid image
            console.log(`[FrameStacker] ESRGAN base64 starts with: ${currentSrc.substring(0, 80)}`);
            console.log(`[FrameStacker] ESRGAN base64 length: ${currentSrc.length} chars`);

            const targetWidth = Math.round(currentData.width * scale);
            const targetHeight = Math.round(currentData.height * scale);
            console.log(`[FrameStacker] Target dimensions: ${targetWidth}x${targetHeight} (input: ${currentData.width}x${currentData.height}, scale: ${scale})`);

            // Use ESRGAN output dimensions directly instead of forcing target size
            // This prevents color artifacts from resizing
            const actualWidth = resultImg.naturalWidth || resultImg.width;
            const actualHeight = resultImg.naturalHeight || resultImg.height;

            const dstCanvas = document.createElement('canvas');
            dstCanvas.width = actualWidth;
            dstCanvas.height = actualHeight;
            const dstCtx = dstCanvas.getContext('2d');
            // Disable image smoothing - draw at native resolution
            dstCtx.imageSmoothingEnabled = false;
            dstCtx.drawImage(resultImg, 0, 0);

            let result = dstCtx.getImageData(0, 0, actualWidth, actualHeight);
            console.log(`[FrameStacker] ESRGAN complete: ${currentData.width}x${currentData.height} → ${actualWidth}x${actualHeight}`);

            // Debug: Sample actual pixel values
            const centerIdx = (Math.floor(actualHeight / 2) * actualWidth + Math.floor(actualWidth / 2)) * 4;
            console.log(`[FrameStacker] ESRGAN OUTPUT center pixel RGBA: ${result.data[centerIdx]}, ${result.data[centerIdx+1]}, ${result.data[centerIdx+2]}, ${result.data[centerIdx+3]}`);
            // Sample first 3 pixels for comparison with input
            console.log(`[FrameStacker] ESRGAN OUTPUT first 3 pixels: (${result.data[0]},${result.data[1]},${result.data[2]}) (${result.data[4]},${result.data[5]},${result.data[6]}) (${result.data[8]},${result.data[9]},${result.data[10]})`);

            // COLOR VALIDATION: Check if ESRGAN output colors are drastically wrong
            // Check 1: Brightness ratio - if output is much darker, ESRGAN failed
            const inputR = currentData.data[inputCenterIdx];
            const inputG = currentData.data[inputCenterIdx+1];
            const inputB = currentData.data[inputCenterIdx+2];
            const outputR = result.data[centerIdx];
            const outputG = result.data[centerIdx+1];
            const outputB = result.data[centerIdx+2];

            const inputAvgBrightness = (inputR + inputG + inputB) / 3;
            const outputAvgBrightness = (outputR + outputG + outputB) / 3;
            const brightnessRatio = outputAvgBrightness / Math.max(inputAvgBrightness, 1);

            // Check 2: Color inversion - if warm becomes cool or vice versa
            const inputWarm = inputR > inputB + 20;  // Input is warm (more red than blue)
            const inputCool = inputB > inputR + 20;  // Input is cool (more blue than red)
            const outputWarm = outputR > outputB + 20;
            const outputCool = outputB > outputR + 20;
            const colorInverted = (inputWarm && outputCool) || (inputCool && outputWarm);

            console.log(`[FrameStacker] Color check: inputRGB=(${inputR},${inputG},${inputB}), outputRGB=(${outputR},${outputG},${outputB})`);
            console.log(`[FrameStacker] Brightness ratio=${brightnessRatio.toFixed(3)}, colorInverted=${colorInverted}`);

            // If output is less than 30% of input brightness OR colors are inverted, ESRGAN failed
            if ((brightnessRatio < 0.3 && inputAvgBrightness > 50) || colorInverted) {
                const reason = colorInverted ? 'color inversion' : `brightness ratio ${brightnessRatio.toFixed(3)}`;
                console.warn(`[FrameStacker] ⚠️ ESRGAN produced wrong colors (${reason})`);
                console.log('[FrameStacker] Falling back to enhanced bicubic due to color corruption');
                return this.enhancedBicubicUpscale(currentData, scale);
            }

            // Apply post-processing sharpening if enabled
            if (this.postProcessSharpening) {
                console.log('[FrameStacker] Applying post-ESRGAN sharpening for crisp text...');
                result = this.applyTextSharpening(result);
            }

            return result;

        } catch (error) {
            console.error('[FrameStacker] ESRGAN upscaling failed:', error);
            console.log('[FrameStacker] Falling back to enhanced bicubic');
            return this.enhancedBicubicUpscale(currentData, scale);
        }
    }

    /**
     * Apply advanced pre-processing pipeline using OpenCV
     * Uses professional image processing techniques optimized for license plates
     * ADAPTIVE: Automatically adjusts based on image brightness/contrast
     */
    async applyMAXIMPreProcessing(imageData) {
        const width = imageData.width;
        const height = imageData.height;
        const data = imageData.data;

        // STEP 0: Analyze image to determine processing parameters
        const stats = this.analyzeImageStats(imageData);
        console.log(`[FrameStacker] 📊 Image stats: avgLum=${stats.avgLum.toFixed(1)}, contrast=${stats.contrast.toFixed(1)}, category="${stats.category}"`);

        let result = imageData;

        // ADAPTIVE PROCESSING based on image characteristics
        if (stats.category === 'dark') {
            // DARK IMAGES: Need illumination recovery
            const hasHighContrast = stats.contrast > 100;

            if (hasHighContrast) {
                // Dark but already has contrast - be careful not to wash out
                console.log('[FrameStacker] 🌙 Dark image + HIGH contrast - careful enhancement...');

                // Stage 1: MSR with moderate blend (45%) - enhance shadows, preserve highlights
                result = this.applyMultiScaleRetinex(result, 0.45);

                // Stage 2: Bilateral filter
                result = this.applyBilateralFilter(result, 5, 25, 25);

                // Stage 3: CLAHE with light clip (1.8) - don't overdo contrast
                if (typeof cv !== 'undefined') {
                    result = this.applyCLAHE(result, 1.8, 4);
                } else {
                    result = this.applyJSCLAHE(result, 1.8, 4);
                }
            } else {
                // Dark and low contrast - full enhancement
                console.log('[FrameStacker] 🌙 Dark image + low contrast - full MSR pipeline...');

                // Stage 1: MSR with strong blend (60%)
                result = this.applyMultiScaleRetinex(result, 0.6);

                // Stage 2: Bilateral filter
                result = this.applyBilateralFilter(result, 5, 25, 25);

                // Stage 3: CLAHE with moderate clip (2.5)
                if (typeof cv !== 'undefined') {
                    result = this.applyCLAHE(result, 2.5, 4);
                } else {
                    result = this.applyJSCLAHE(result, 2.5, 4);
                }
            }
        } else if (stats.category === 'medium') {
            // MEDIUM IMAGES: Adjust based on existing contrast
            const hasHighContrast = stats.contrast > 120;

            if (hasHighContrast) {
                // Already good contrast - minimal enhancement to avoid washing out
                console.log('[FrameStacker] ⚡ Medium brightness + HIGH contrast - minimal enhancement...');

                // Stage 1: Very light MSR (20%) - just subtle refinement
                result = this.applyMultiScaleRetinex(result, 0.20);

                // Stage 2: Light bilateral filter
                result = this.applyBilateralFilter(result, 3, 15, 15);

                // Stage 3: Very light CLAHE (1.2) - preserve existing contrast
                if (typeof cv !== 'undefined') {
                    result = this.applyCLAHE(result, 1.2, 4);
                } else {
                    result = this.applyJSCLAHE(result, 1.2, 4);
                }
            } else {
                // Low/medium contrast - moderate enhancement
                console.log('[FrameStacker] ⚡ Medium brightness + low contrast - moderate enhancement...');

                // Stage 1: MSR with moderate blend (40%)
                result = this.applyMultiScaleRetinex(result, 0.40);

                // Stage 2: Light bilateral filter
                result = this.applyBilateralFilter(result, 3, 20, 20);

                // Stage 3: CLAHE with moderate clip (2.0)
                if (typeof cv !== 'undefined') {
                    result = this.applyCLAHE(result, 2.0, 4);
                } else {
                    result = this.applyJSCLAHE(result, 2.0, 4);
                }
            }
        } else {
            // BRIGHT IMAGES: Skip MSR, just enhance contrast
            console.log('[FrameStacker] ☀️ Bright image - skipping MSR, light contrast only...');

            // No MSR - already well-exposed

            // Stage 2: Very light bilateral filter (just denoise)
            result = this.applyBilateralFilter(result, 3, 15, 15);

            // Stage 3: CLAHE with minimal clip (1.5) - just sharpen text
            if (typeof cv !== 'undefined') {
                result = this.applyCLAHE(result, 1.5, 4);
            } else {
                result = this.applyJSCLAHE(result, 1.5, 4);
            }
        }

        // STAGE 4: Final auto-levels refinement (adaptive based on stats)
        if (stats.contrast < 60) {
            console.log('[FrameStacker] Stage 4: Auto-levels (low contrast image)...');
            result = this.autoContrastLuminance(result);
        }

        return result;
    }

    /**
     * Analyze image statistics to determine optimal processing parameters
     * Returns: { avgLum, minLum, maxLum, contrast, category: 'dark'|'medium'|'bright' }
     */
    analyzeImageStats(imageData) {
        const data = imageData.data;
        const pixelCount = imageData.width * imageData.height;

        let sumLum = 0;
        let minLum = 255;
        let maxLum = 0;

        // Sample every 4th pixel for speed
        for (let i = 0; i < pixelCount; i += 4) {
            const r = data[i * 4];
            const g = data[i * 4 + 1];
            const b = data[i * 4 + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;

            sumLum += lum;
            minLum = Math.min(minLum, lum);
            maxLum = Math.max(maxLum, lum);
        }

        const avgLum = sumLum / (pixelCount / 4);
        const contrast = maxLum - minLum;

        // Categorize image
        let category;
        if (avgLum < 60) {
            category = 'dark';
        } else if (avgLum < 140) {
            category = 'medium';
        } else {
            category = 'bright';
        }

        return { avgLum, minLum, maxLum, contrast, category };
    }

    /**
     * Multi-Scale Retinex (MSR) - Simplified and robust version
     * Works on luminance channel only to avoid color shifts
     * Uses adaptive gain to handle very dark images
     * @param {ImageData} imageData - Input image
     * @param {number} blendFactor - How much MSR to blend (0-1), default 0.6
     */
    applyMultiScaleRetinex(imageData, blendFactor = 0.6) {
        const width = imageData.width;
        const height = imageData.height;
        const data = imageData.data;

        console.log('[FrameStacker] MSR: Processing image...');

        // Multiple scales for better detail recovery
        const scales = [5, 20, 80]; // Smaller scales for small plate images
        const weights = [1/3, 1/3, 1/3];

        // Convert to YCbCr-like: work on luminance only to preserve colors
        const luminance = new Float32Array(width * height);
        const chromaCb = new Float32Array(width * height);
        const chromaCr = new Float32Array(width * height);

        let avgLum = 0;
        for (let i = 0; i < width * height; i++) {
            const r = data[i * 4];
            const g = data[i * 4 + 1];
            const b = data[i * 4 + 2];

            // YCbCr conversion
            luminance[i] = 0.299 * r + 0.587 * g + 0.114 * b;
            chromaCb[i] = 128 + (-0.169 * r - 0.331 * g + 0.500 * b);
            chromaCr[i] = 128 + (0.500 * r - 0.419 * g - 0.081 * b);
            avgLum += luminance[i];
        }
        avgLum /= (width * height);

        console.log(`[FrameStacker] MSR: Average luminance = ${avgLum.toFixed(1)}`);

        // Detect if image is very dark and boost it first
        const isDark = avgLum < 50;
        if (isDark) {
            console.log('[FrameStacker] MSR: Dark image detected, applying pre-boost');
            const boost = Math.min(3.0, 80 / Math.max(avgLum, 1));
            for (let i = 0; i < width * height; i++) {
                luminance[i] = Math.min(255, luminance[i] * boost);
            }
        }

        // Apply MSR to luminance
        const retinex = new Float32Array(width * height);

        for (let s = 0; s < scales.length; s++) {
            const sigma = scales[s];
            const weight = weights[s];

            // Gaussian blur of luminance
            const blurred = this.fastGaussianBlur(luminance, width, height, sigma);

            // Single Scale Retinex: log(L + 1) - log(blur(L) + 1)
            for (let i = 0; i < width * height; i++) {
                const logL = Math.log(luminance[i] + 1);
                const logBlur = Math.log(blurred[i] + 1);
                retinex[i] += weight * (logL - logBlur);
            }
        }

        // Convert retinex output to enhanced luminance
        // Use gain/offset based on dynamic range
        let minRet = Infinity, maxRet = -Infinity;
        for (let i = 0; i < width * height; i++) {
            if (isFinite(retinex[i])) {
                minRet = Math.min(minRet, retinex[i]);
                maxRet = Math.max(maxRet, retinex[i]);
            }
        }

        const retRange = maxRet - minRet;
        console.log(`[FrameStacker] MSR: Retinex range = [${minRet.toFixed(3)}, ${maxRet.toFixed(3)}]`);

        // SAFETY CHECK: If retinex range is too small, MSR won't help - return original
        if (retRange < 0.01 || !isFinite(retRange)) {
            console.warn('[FrameStacker] MSR: Range too small or invalid, returning original image');
            return imageData;
        }

        // Map retinex to enhanced luminance with adaptive gain
        const enhancedLum = new Float32Array(width * height);
        for (let i = 0; i < width * height; i++) {
            // Normalize to 0-1, then scale to 0-255
            let normalized = (retinex[i] - minRet) / retRange;
            // Clamp to valid range to prevent NaN/Infinity
            normalized = Math.max(0, Math.min(1, normalized));
            // Apply slight gamma for contrast
            normalized = Math.pow(normalized, 0.85);
            enhancedLum[i] = normalized * 255;
        }

        // Blend enhanced luminance with original (to preserve some natural look)
        // blendFactor passed as parameter - higher = more MSR effect
        console.log(`[FrameStacker] MSR: Blend factor = ${(blendFactor * 100).toFixed(0)}%`);
        for (let i = 0; i < width * height; i++) {
            enhancedLum[i] = blendFactor * enhancedLum[i] + (1 - blendFactor) * luminance[i];
        }

        // Convert back to RGB
        const output = new Uint8ClampedArray(data.length);
        for (let i = 0; i < width * height; i++) {
            const y = enhancedLum[i];
            const cb = chromaCb[i] - 128;
            const cr = chromaCr[i] - 128;

            // YCbCr to RGB
            output[i * 4] = Math.max(0, Math.min(255, Math.round(y + 1.402 * cr)));
            output[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(y - 0.344 * cb - 0.714 * cr)));
            output[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(y + 1.772 * cb)));
            output[i * 4 + 3] = data[i * 4 + 3];
        }

        console.log('[FrameStacker] MSR: Complete');
        return new ImageData(output, width, height);
    }

    /**
     * Fast Gaussian blur using box blur approximation (3 passes)
     * Safe version that handles small images
     */
    fastGaussianBlur(channel, width, height, sigma) {
        // Cap sigma based on image size (blur radius must be < min dimension / 2)
        const maxSigma = Math.min(width, height) / 4;
        const safeSigma = Math.min(sigma, maxSigma);

        if (safeSigma < 1) {
            // Image too small for blur, return copy
            return channel.slice();
        }

        // Convert sigma to box radius (approximation)
        const boxes = this.boxesForGauss(safeSigma, 3);
        let src = channel.slice();
        let dst = new Float32Array(width * height);

        for (let i = 0; i < 3; i++) {
            const r = Math.floor((boxes[i] - 1) / 2);
            if (r < 1) continue; // Skip if radius too small

            this.boxBlurHSafe(src, dst, width, height, r);
            this.boxBlurVSafe(dst, src, width, height, r);
        }

        return src;
    }

    boxesForGauss(sigma, n) {
        const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
        let wl = Math.floor(wIdeal);
        if (wl % 2 === 0) wl--;
        const wu = wl + 2;
        const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
        const m = Math.round(mIdeal);
        const sizes = [];
        for (let i = 0; i < n; i++) {
            sizes.push(i < m ? wl : wu);
        }
        return sizes;
    }

    /**
     * Safe horizontal box blur with bounds checking
     */
    boxBlurHSafe(src, dst, w, h, r) {
        // Ensure radius doesn't exceed half the width
        r = Math.min(r, Math.floor((w - 1) / 2));
        if (r < 1) {
            dst.set(src);
            return;
        }

        const diameter = r * 2 + 1;

        for (let y = 0; y < h; y++) {
            const rowStart = y * w;
            let sum = 0;

            // Initialize sum with first r+1 pixels (mirrored at edge)
            for (let x = 0; x <= r; x++) {
                sum += src[rowStart + x];
            }
            // Add mirrored edge pixels
            for (let x = 0; x < r; x++) {
                sum += src[rowStart + Math.min(x, w - 1)];
            }

            // Process each pixel
            for (let x = 0; x < w; x++) {
                dst[rowStart + x] = sum / diameter;

                // Update sum: remove left pixel, add right pixel
                const leftIdx = x - r;
                const rightIdx = x + r + 1;

                // Handle edges with clamping
                const leftVal = src[rowStart + Math.max(0, leftIdx)];
                const rightVal = src[rowStart + Math.min(w - 1, rightIdx)];

                sum = sum - leftVal + rightVal;
            }
        }
    }

    /**
     * Safe vertical box blur with bounds checking
     */
    boxBlurVSafe(src, dst, w, h, r) {
        // Ensure radius doesn't exceed half the height
        r = Math.min(r, Math.floor((h - 1) / 2));
        if (r < 1) {
            dst.set(src);
            return;
        }

        const diameter = r * 2 + 1;

        for (let x = 0; x < w; x++) {
            let sum = 0;

            // Initialize sum with first r+1 pixels (mirrored at edge)
            for (let y = 0; y <= r; y++) {
                sum += src[y * w + x];
            }
            // Add mirrored edge pixels
            for (let y = 0; y < r; y++) {
                sum += src[Math.min(y, h - 1) * w + x];
            }

            // Process each pixel
            for (let y = 0; y < h; y++) {
                dst[y * w + x] = sum / diameter;

                // Update sum: remove top pixel, add bottom pixel
                const topIdx = y - r;
                const bottomIdx = y + r + 1;

                // Handle edges with clamping
                const topVal = src[Math.max(0, topIdx) * w + x];
                const bottomVal = src[Math.min(h - 1, bottomIdx) * w + x];

                sum = sum - topVal + bottomVal;
            }
        }
    }

    /**
     * Bilateral filter - edge-preserving smoothing
     * Reduces noise while keeping sharp edges (important for text)
     */
    applyBilateralFilter(imageData, radius, sigmaSpace, sigmaColor) {
        const width = imageData.width;
        const height = imageData.height;
        const data = imageData.data;
        const output = new Uint8ClampedArray(data.length);

        // Precompute spatial weights
        const spatialWeights = [];
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const dist = Math.sqrt(dx * dx + dy * dy);
                spatialWeights.push(Math.exp(-(dist * dist) / (2 * sigmaSpace * sigmaSpace)));
            }
        }

        // Precompute color weights lookup table
        const colorWeights = new Float32Array(256 * 3);
        for (let d = 0; d < 256 * 3; d++) {
            colorWeights[d] = Math.exp(-(d * d) / (2 * sigmaColor * sigmaColor));
        }

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const centerR = data[idx];
                const centerG = data[idx + 1];
                const centerB = data[idx + 2];

                let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
                let spatialIdx = 0;

                for (let dy = -radius; dy <= radius; dy++) {
                    const ny = Math.min(height - 1, Math.max(0, y + dy));
                    for (let dx = -radius; dx <= radius; dx++) {
                        const nx = Math.min(width - 1, Math.max(0, x + dx));
                        const nIdx = (ny * width + nx) * 4;

                        // Color distance
                        const colorDist = Math.abs(data[nIdx] - centerR) +
                                         Math.abs(data[nIdx + 1] - centerG) +
                                         Math.abs(data[nIdx + 2] - centerB);

                        const weight = spatialWeights[spatialIdx] * colorWeights[Math.min(colorDist, 255 * 3 - 1)];

                        sumR += data[nIdx] * weight;
                        sumG += data[nIdx + 1] * weight;
                        sumB += data[nIdx + 2] * weight;
                        sumW += weight;
                        spatialIdx++;
                    }
                }

                output[idx] = Math.round(sumR / sumW);
                output[idx + 1] = Math.round(sumG / sumW);
                output[idx + 2] = Math.round(sumB / sumW);
                output[idx + 3] = data[idx + 3];
            }
        }

        return new ImageData(output, width, height);
    }

    /**
     * Pure JavaScript CLAHE implementation (when OpenCV not available)
     */
    applyJSCLAHE(imageData, clipLimit = 2.0, gridSize = 8) {
        const width = imageData.width;
        const height = imageData.height;
        const data = imageData.data;

        // Convert to LAB-like (just use luminance for simplicity)
        const luminance = new Float32Array(width * height);
        const chromaU = new Float32Array(width * height);
        const chromaV = new Float32Array(width * height);

        for (let i = 0; i < width * height; i++) {
            const r = data[i * 4] / 255;
            const g = data[i * 4 + 1] / 255;
            const b = data[i * 4 + 2] / 255;

            // YUV conversion
            luminance[i] = 0.299 * r + 0.587 * g + 0.114 * b;
            chromaU[i] = -0.147 * r - 0.289 * g + 0.436 * b;
            chromaV[i] = 0.615 * r - 0.515 * g - 0.100 * b;
        }

        // Apply CLAHE to luminance
        const tileW = Math.ceil(width / gridSize);
        const tileH = Math.ceil(height / gridSize);
        const bins = 256;
        const clipThreshold = clipLimit * (tileW * tileH) / bins;

        // Compute CDFs for each tile
        const tileCDFs = [];
        for (let ty = 0; ty < gridSize; ty++) {
            tileCDFs[ty] = [];
            for (let tx = 0; tx < gridSize; tx++) {
                const histogram = new Float32Array(bins);
                let count = 0;

                const startX = tx * tileW;
                const startY = ty * tileH;
                const endX = Math.min(startX + tileW, width);
                const endY = Math.min(startY + tileH, height);

                // Build histogram
                for (let y = startY; y < endY; y++) {
                    for (let x = startX; x < endX; x++) {
                        const bin = Math.min(bins - 1, Math.floor(luminance[y * width + x] * bins));
                        histogram[bin]++;
                        count++;
                    }
                }

                // Clip histogram
                let excess = 0;
                for (let i = 0; i < bins; i++) {
                    if (histogram[i] > clipThreshold) {
                        excess += histogram[i] - clipThreshold;
                        histogram[i] = clipThreshold;
                    }
                }

                // Redistribute excess
                const bonus = excess / bins;
                for (let i = 0; i < bins; i++) {
                    histogram[i] += bonus;
                }

                // Build CDF
                const cdf = new Float32Array(bins);
                cdf[0] = histogram[0];
                for (let i = 1; i < bins; i++) {
                    cdf[i] = cdf[i - 1] + histogram[i];
                }

                // Normalize CDF
                for (let i = 0; i < bins; i++) {
                    cdf[i] = cdf[i] / count;
                }

                tileCDFs[ty][tx] = cdf;
            }
        }

        // Apply with bilinear interpolation
        const enhancedLum = new Float32Array(width * height);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const lum = luminance[y * width + x];
                const bin = Math.min(bins - 1, Math.floor(lum * bins));

                // Find surrounding tiles
                const txf = (x - tileW / 2) / tileW;
                const tyf = (y - tileH / 2) / tileH;

                const tx0 = Math.max(0, Math.min(gridSize - 1, Math.floor(txf)));
                const ty0 = Math.max(0, Math.min(gridSize - 1, Math.floor(tyf)));
                const tx1 = Math.min(gridSize - 1, tx0 + 1);
                const ty1 = Math.min(gridSize - 1, ty0 + 1);

                const dx = Math.max(0, Math.min(1, txf - tx0));
                const dy = Math.max(0, Math.min(1, tyf - ty0));

                // Bilinear interpolation of CDF values
                const v00 = tileCDFs[ty0][tx0][bin];
                const v01 = tileCDFs[ty0][tx1][bin];
                const v10 = tileCDFs[ty1][tx0][bin];
                const v11 = tileCDFs[ty1][tx1][bin];

                const top = v00 * (1 - dx) + v01 * dx;
                const bottom = v10 * (1 - dx) + v11 * dx;
                enhancedLum[y * width + x] = top * (1 - dy) + bottom * dy;
            }
        }

        // Convert back to RGB
        const output = new Uint8ClampedArray(data.length);
        for (let i = 0; i < width * height; i++) {
            const y = enhancedLum[i];
            const u = chromaU[i];
            const v = chromaV[i];

            output[i * 4] = Math.round(Math.max(0, Math.min(255, (y + 1.140 * v) * 255)));
            output[i * 4 + 1] = Math.round(Math.max(0, Math.min(255, (y - 0.395 * u - 0.581 * v) * 255)));
            output[i * 4 + 2] = Math.round(Math.max(0, Math.min(255, (y + 2.032 * u) * 255)));
            output[i * 4 + 3] = data[i * 4 + 3];
        }

        return new ImageData(output, width, height);
    }

    /**
     * Advanced fallback preprocessing using pure JavaScript
     * Optimized for license plate text enhancement
     */
    applyFallbackPreProcessing(imageData) {
        console.log('[FrameStacker] Using advanced JS preprocessing...');
        const width = imageData.width;
        const height = imageData.height;
        let data = imageData.data;

        // STEP 0: Denoise first (reduces noise that ESRGAN amplifies)
        console.log('[FrameStacker] Stage 0: Adaptive denoising...');
        const denoised = this.adaptiveDenoise(imageData);
        data = denoised.data;

        // STEP 1: Analyze luminance histogram
        const luminance = new Float32Array(width * height);
        let minL = 255, maxL = 0;
        const histogram = new Uint32Array(256);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                luminance[y * width + x] = l;
                minL = Math.min(minL, l);
                maxL = Math.max(maxL, l);
                histogram[Math.floor(l)]++;
            }
        }

        // STEP 2: Auto-levels using percentile clipping (removes outliers)
        console.log('[FrameStacker] Stage 1: Auto-levels with percentile clipping...');
        const totalPixels = width * height;
        const clipPercent = 0.01; // Clip 1% from each end
        const clipCount = Math.floor(totalPixels * clipPercent);

        let cumSum = 0;
        let lowClip = 0, highClip = 255;
        for (let i = 0; i < 256; i++) {
            cumSum += histogram[i];
            if (cumSum >= clipCount && lowClip === 0) lowClip = i;
            if (cumSum >= totalPixels - clipCount) {
                highClip = i;
                break;
            }
        }

        const range = highClip - lowClip || 1;

        // STEP 3: Apply contrast stretch with gamma correction
        console.log('[FrameStacker] Stage 2: Contrast stretch with gamma...');
        const gamma = 0.9; // Slight gamma boost for darker images
        const output = new Uint8ClampedArray(data.length);

        for (let i = 0; i < data.length; i += 4) {
            for (let c = 0; c < 3; c++) {
                // Stretch to full range
                let val = (data[i + c] - lowClip) / range;
                val = Math.max(0, Math.min(1, val));
                // Apply gamma
                val = Math.pow(val, gamma);
                output[i + c] = Math.round(val * 255);
            }
            output[i + 3] = data[i + 3];
        }

        // STEP 4: Local contrast enhancement (simplified unsharp mask)
        console.log('[FrameStacker] Stage 3: Local contrast enhancement...');
        const enhanced = new Uint8ClampedArray(data.length);
        const amount = 0.3; // Subtle sharpening
        const radius = 1;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;

                for (let c = 0; c < 3; c++) {
                    // Simple box blur for this pixel
                    let sum = 0, count = 0;
                    for (let dy = -radius; dy <= radius; dy++) {
                        for (let dx = -radius; dx <= radius; dx++) {
                            const nx = Math.min(width - 1, Math.max(0, x + dx));
                            const ny = Math.min(height - 1, Math.max(0, y + dy));
                            sum += output[(ny * width + nx) * 4 + c];
                            count++;
                        }
                    }
                    const blurred = sum / count;
                    // Unsharp mask: enhanced = original + amount * (original - blurred)
                    const sharp = output[idx + c] + amount * (output[idx + c] - blurred);
                    enhanced[idx + c] = Math.max(0, Math.min(255, Math.round(sharp)));
                }
                enhanced[idx + 3] = output[idx + 3];
            }
        }

        console.log('[FrameStacker] JS preprocessing complete');
        return new ImageData(enhanced, width, height);
    }

    /**
     * Adaptive denoising that preserves edges while reducing noise
     * Uses a simple non-local means approximation
     */
    adaptiveDenoise(imageData) {
        const { width, height, data } = imageData;
        const result = new Uint8ClampedArray(data.length);
        const radius = 2;
        const h = 10; // Filtering strength (higher = more denoising)

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;

                // Get center pixel
                const cr = data[idx], cg = data[idx + 1], cb = data[idx + 2];

                let sumR = 0, sumG = 0, sumB = 0, weightSum = 0;

                // Compare with neighborhood
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        const nx = Math.max(0, Math.min(width - 1, x + dx));
                        const ny = Math.max(0, Math.min(height - 1, y + dy));
                        const nIdx = (ny * width + nx) * 4;

                        const nr = data[nIdx], ng = data[nIdx + 1], nb = data[nIdx + 2];

                        // Calculate color difference
                        const diff = Math.sqrt(
                            (cr - nr) * (cr - nr) +
                            (cg - ng) * (cg - ng) +
                            (cb - nb) * (cb - nb)
                        );

                        // Weight based on similarity (Gaussian)
                        const weight = Math.exp(-(diff * diff) / (h * h));

                        sumR += nr * weight;
                        sumG += ng * weight;
                        sumB += nb * weight;
                        weightSum += weight;
                    }
                }

                result[idx] = Math.round(sumR / weightSum);
                result[idx + 1] = Math.round(sumG / weightSum);
                result[idx + 2] = Math.round(sumB / weightSum);
                result[idx + 3] = 255;
            }
        }

        return new ImageData(result, width, height);
    }

    /**
     * Apply text-optimized sharpening for license plate enhancement
     * Uses unsharp mask tuned for crisp text edges without halos
     */
    applyTextSharpening(imageData) {
        const width = imageData.width;
        const height = imageData.height;
        const data = imageData.data;

        // Create output array
        const output = new Uint8ClampedArray(data.length);

        // Unsharp mask parameters optimized for text
        // Lighter than traditional unsharp to avoid halos around letters
        const amount = 0.4;  // Sharpening strength (0.3-0.5 works well for text)
        const radius = 1;    // Small radius for fine detail

        // First, apply a simple box blur to get the "unsharp" version
        const blurred = new Float32Array(data.length);

        // Box blur pass
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;

                let rSum = 0, gSum = 0, bSum = 0;
                let count = 0;

                // Sample neighborhood
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        const nx = Math.min(width - 1, Math.max(0, x + dx));
                        const ny = Math.min(height - 1, Math.max(0, y + dy));
                        const nidx = (ny * width + nx) * 4;

                        rSum += data[nidx];
                        gSum += data[nidx + 1];
                        bSum += data[nidx + 2];
                        count++;
                    }
                }

                blurred[idx] = rSum / count;
                blurred[idx + 1] = gSum / count;
                blurred[idx + 2] = bSum / count;
            }
        }

        // Apply unsharp mask: output = original + amount * (original - blurred)
        for (let i = 0; i < data.length; i += 4) {
            output[i] = Math.max(0, Math.min(255, data[i] + amount * (data[i] - blurred[i])));
            output[i + 1] = Math.max(0, Math.min(255, data[i + 1] + amount * (data[i + 1] - blurred[i + 1])));
            output[i + 2] = Math.max(0, Math.min(255, data[i + 2] + amount * (data[i + 2] - blurred[i + 2])));
            output[i + 3] = data[i + 3]; // Keep alpha unchanged
        }

        console.log('[FrameStacker] Text sharpening applied (amount: ' + amount + ')');
        return new ImageData(output, width, height);
    }

    /**
     * Fallback bicubic upscale with sharpening
     */
    bicubicUpscale(imageData, scale) {
        const srcWidth = imageData.width;
        const srcHeight = imageData.height;
        const dstWidth = Math.round(srcWidth * scale);
        const dstHeight = Math.round(srcHeight * scale);

        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = srcWidth;
        srcCanvas.height = srcHeight;
        const srcCtx = srcCanvas.getContext('2d');
        srcCtx.putImageData(imageData, 0, 0);

        const dstCanvas = document.createElement('canvas');
        dstCanvas.width = dstWidth;
        dstCanvas.height = dstHeight;
        const dstCtx = dstCanvas.getContext('2d');

        dstCtx.imageSmoothingEnabled = true;
        dstCtx.imageSmoothingQuality = 'high';
        dstCtx.drawImage(srcCanvas, 0, 0, dstWidth, dstHeight);

        let upscaled = dstCtx.getImageData(0, 0, dstWidth, dstHeight);
        upscaled = this.gentleSharpening(upscaled);
        return upscaled;
    }

    /**
     * Enhanced bicubic upscale optimized for license plates
     * Uses single-step high-quality resize with luminance-only post-processing
     */
    enhancedBicubicUpscale(imageData, scale) {
        const srcWidth = imageData.width;
        const srcHeight = imageData.height;
        const dstWidth = Math.round(srcWidth * scale);
        const dstHeight = Math.round(srcHeight * scale);

        console.log(`[FrameStacker] Enhanced bicubic: ${srcWidth}x${srcHeight} → ${dstWidth}x${dstHeight}`);

        // Step 1: Single high-quality upscale (avoids color issues from multi-step)
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = srcWidth;
        srcCanvas.height = srcHeight;
        const srcCtx = srcCanvas.getContext('2d');
        srcCtx.putImageData(imageData, 0, 0);

        const dstCanvas = document.createElement('canvas');
        dstCanvas.width = dstWidth;
        dstCanvas.height = dstHeight;
        const dstCtx = dstCanvas.getContext('2d');
        dstCtx.imageSmoothingEnabled = true;
        dstCtx.imageSmoothingQuality = 'high';
        dstCtx.drawImage(srcCanvas, 0, 0, dstWidth, dstHeight);

        let result = dstCtx.getImageData(0, 0, dstWidth, dstHeight);

        // Post-processing: LAB-space sharpening for clean results
        result = this.enhanceLAB(result);

        console.log(`[FrameStacker] Enhanced bicubic complete`);
        return result;
    }

    /**
     * Luminance-only unsharp mask - sharpens without color artifacts
     */
    luminanceUnsharpMask(imageData, amount = 1.0, radius = 1) {
        const width = imageData.width;
        const height = imageData.height;
        const src = imageData.data;

        // Create blurred version
        const blurred = this.gaussianBlur(imageData, radius);
        const blur = blurred.data;

        const result = new ImageData(width, height);
        const dst = result.data;

        for (let i = 0; i < src.length; i += 4) {
            const r = src[i], g = src[i + 1], b = src[i + 2];
            const br = blur[i], bg = blur[i + 1], bb = blur[i + 2];

            // Calculate luminance difference
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            const blurLum = 0.299 * br + 0.587 * bg + 0.114 * bb;
            const sharpenAmount = amount * (lum - blurLum);

            // Apply to all channels equally (preserves color)
            dst[i] = Math.max(0, Math.min(255, Math.round(r + sharpenAmount)));
            dst[i + 1] = Math.max(0, Math.min(255, Math.round(g + sharpenAmount)));
            dst[i + 2] = Math.max(0, Math.min(255, Math.round(b + sharpenAmount)));
            dst[i + 3] = 255;
        }

        return result;
    }

    /**
     * Convert RGB ImageData to YCbCr channels
     */
    rgbToYCbCr(imageData) {
        const { width, height, data } = imageData;
        const size = width * height;
        const y = new Uint8ClampedArray(size);
        const cb = new Uint8ClampedArray(size);
        const cr = new Uint8ClampedArray(size);

        for (let i = 0; i < size; i++) {
            const idx = i * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];

            // ITU-R BT.601 conversion
            y[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            cb[i] = Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b);
            cr[i] = Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b);
        }

        return { y, cb, cr };
    }

    /**
     * Convert YCbCr channels back to RGB ImageData
     */
    ycbcrToRgb(y, cb, cr, width, height) {
        const data = new Uint8ClampedArray(width * height * 4);

        for (let i = 0; i < y.length; i++) {
            const yVal = y[i];
            const cbVal = cb[i] - 128;
            const crVal = cr[i] - 128;

            const idx = i * 4;
            data[idx] = Math.max(0, Math.min(255, Math.round(yVal + 1.402 * crVal)));
            data[idx + 1] = Math.max(0, Math.min(255, Math.round(yVal - 0.344136 * cbVal - 0.714136 * crVal)));
            data[idx + 2] = Math.max(0, Math.min(255, Math.round(yVal + 1.772 * cbVal)));
            data[idx + 3] = 255;
        }

        return new ImageData(data, width, height);
    }

    /**
     * Resize a single channel using canvas
     */
    resizeChannel(channel, srcWidth, srcHeight, dstWidth, dstHeight) {
        // Create grayscale image from channel
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = srcWidth;
        srcCanvas.height = srcHeight;
        const srcCtx = srcCanvas.getContext('2d');
        const srcData = srcCtx.createImageData(srcWidth, srcHeight);

        for (let i = 0; i < channel.length; i++) {
            const idx = i * 4;
            srcData.data[idx] = channel[i];
            srcData.data[idx + 1] = channel[i];
            srcData.data[idx + 2] = channel[i];
            srcData.data[idx + 3] = 255;
        }
        srcCtx.putImageData(srcData, 0, 0);

        // Resize
        const dstCanvas = document.createElement('canvas');
        dstCanvas.width = dstWidth;
        dstCanvas.height = dstHeight;
        const dstCtx = dstCanvas.getContext('2d');
        dstCtx.imageSmoothingEnabled = true;
        dstCtx.imageSmoothingQuality = 'high';
        dstCtx.drawImage(srcCanvas, 0, 0, dstWidth, dstHeight);

        // Extract channel
        const dstData = dstCtx.getImageData(0, 0, dstWidth, dstHeight);
        const result = new Uint8ClampedArray(dstWidth * dstHeight);
        for (let i = 0; i < result.length; i++) {
            result[i] = dstData.data[i * 4]; // Just R channel (they're all the same)
        }

        return result;
    }

    /**
     * Gentle sharpening optimized for upscaled images
     * Uses a simpler approach that's less likely to create artifacts
     */
    gentleSharpening(imageData) {
        const width = imageData.width;
        const height = imageData.height;
        const src = imageData.data;
        const result = new Uint8ClampedArray(src.length);

        // Simple 3x3 sharpen kernel - very gentle
        // This is less aggressive than unsharp mask
        const kernel = [
            0, -0.5, 0,
            -0.5, 3, -0.5,
            0, -0.5, 0
        ];

        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = (y * width + x) * 4;

                for (let c = 0; c < 3; c++) {
                    let sum = 0;
                    let ki = 0;
                    for (let ky = -1; ky <= 1; ky++) {
                        for (let kx = -1; kx <= 1; kx++) {
                            const srcIdx = ((y + ky) * width + (x + kx)) * 4 + c;
                            sum += src[srcIdx] * kernel[ki++];
                        }
                    }
                    result[idx + c] = Math.max(0, Math.min(255, Math.round(sum)));
                }
                result[idx + 3] = 255;
            }
        }

        // Copy edges
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (y === 0 || y === height - 1 || x === 0 || x === width - 1) {
                    const idx = (y * width + x) * 4;
                    for (let c = 0; c < 4; c++) {
                        result[idx + c] = src[idx + c];
                    }
                }
            }
        }

        return new ImageData(result, width, height);
    }

    /**
     * Post-process super-resolution output for better text clarity
     * Uses minimal processing since ONNX output can be sensitive to further processing
     */
    postProcessUpscaled(imageData) {
        // Skip post-processing - return as-is to preserve quality
        console.log('[FrameStacker] Skipping post-processing (returning upscaled as-is)');
        return imageData;
    }

    /**
     * Edge-preserving smoothing to reduce ESRGAN artifacts
     * Similar to bilateral filter but simpler (no OpenCV dependency)
     */
    edgePreservingSmooth(imageData, radius = 2, threshold = 30) {
        const { width, height, data } = imageData;
        const result = new Uint8ClampedArray(data.length);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;

                // Get center pixel luminance
                const centerL = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];

                let sumR = 0, sumG = 0, sumB = 0, weightSum = 0;

                // Sample neighborhood
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        const nx = Math.max(0, Math.min(width - 1, x + dx));
                        const ny = Math.max(0, Math.min(height - 1, y + dy));
                        const nIdx = (ny * width + nx) * 4;

                        const nL = 0.299 * data[nIdx] + 0.587 * data[nIdx + 1] + 0.114 * data[nIdx + 2];

                        // Weight based on luminance similarity (edge-preserving)
                        const diff = Math.abs(nL - centerL);
                        const weight = diff < threshold ? 1 : Math.exp(-diff * diff / (2 * threshold * threshold));

                        sumR += data[nIdx] * weight;
                        sumG += data[nIdx + 1] * weight;
                        sumB += data[nIdx + 2] * weight;
                        weightSum += weight;
                    }
                }

                result[idx] = Math.round(sumR / weightSum);
                result[idx + 1] = Math.round(sumG / weightSum);
                result[idx + 2] = Math.round(sumB / weightSum);
                result[idx + 3] = 255;
            }
        }

        return new ImageData(result, width, height);
    }

    /**
     * Text edge enhancement - boosts contrast at text boundaries
     */
    textEdgeEnhance(imageData) {
        const { width, height, data } = imageData;
        const result = new Uint8ClampedArray(data.length);

        // Sobel edge detection to find text edges
        const edges = new Float32Array(width * height);
        let maxEdge = 0;

        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;

                // Get luminance values in 3x3 neighborhood
                const l = (i) => {
                    const j = i * 4;
                    return 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
                };

                const p00 = l((y - 1) * width + (x - 1));
                const p01 = l((y - 1) * width + x);
                const p02 = l((y - 1) * width + (x + 1));
                const p10 = l(y * width + (x - 1));
                const p12 = l(y * width + (x + 1));
                const p20 = l((y + 1) * width + (x - 1));
                const p21 = l((y + 1) * width + x);
                const p22 = l((y + 1) * width + (x + 1));

                // Sobel operators
                const gx = (p02 + 2 * p12 + p22) - (p00 + 2 * p10 + p20);
                const gy = (p20 + 2 * p21 + p22) - (p00 + 2 * p01 + p02);

                edges[idx] = Math.sqrt(gx * gx + gy * gy);
                maxEdge = Math.max(maxEdge, edges[idx]);
            }
        }

        // Apply local contrast boost at edges
        const boostAmount = 0.15; // How much to boost edge contrast

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const edgeStrength = (edges[y * width + x] || 0) / (maxEdge || 1);

                // Only boost at significant edges (text boundaries)
                if (edgeStrength > 0.1) {
                    const boost = 1 + boostAmount * edgeStrength;

                    // Apply contrast boost around midpoint
                    for (let c = 0; c < 3; c++) {
                        const val = data[idx + c];
                        const adjusted = 128 + (val - 128) * boost;
                        result[idx + c] = Math.max(0, Math.min(255, Math.round(adjusted)));
                    }
                } else {
                    result[idx] = data[idx];
                    result[idx + 1] = data[idx + 1];
                    result[idx + 2] = data[idx + 2];
                }
                result[idx + 3] = 255;
            }
        }

        return new ImageData(result, width, height);
    }

    /**
     * High-pass filter edge enhancement (luminance-only to avoid color fringing)
     * Extracts and boosts high-frequency details (edges, text)
     */
    highPassEdgeEnhance(imageData, strength = 0.3) {
        const { width, height, data } = imageData;
        const result = new ImageData(width, height);
        const dst = result.data;

        // Create blurred version (low-pass)
        const blurred = this.gaussianBlur(this.gaussianBlur(imageData, 1), 1);
        const blur = blurred.data;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const br = blur[i], bg = blur[i + 1], bb = blur[i + 2];

            // Calculate luminance high-pass
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            const blurLum = 0.299 * br + 0.587 * bg + 0.114 * bb;
            const highPass = lum - blurLum;

            // Apply enhancement to luminance only, preserving color ratios
            const boost = strength * highPass;

            dst[i] = Math.max(0, Math.min(255, Math.round(r + boost)));
            dst[i + 1] = Math.max(0, Math.min(255, Math.round(g + boost)));
            dst[i + 2] = Math.max(0, Math.min(255, Math.round(b + boost)));
            dst[i + 3] = 255;
        }

        return result;
    }

    /**
     * Luminance-only local contrast enhancement
     * Applies contrast boost to brightness without affecting color channels
     * This prevents color fringing artifacts
     */
    luminanceContrastEnhance(imageData, factor = 1.2) {
        const { width, height, data } = imageData;
        const result = new ImageData(width, height);
        const dst = result.data;

        // Convert to luminance, apply local contrast, preserve original color ratios
        const blurred = this.gaussianBlur(imageData, 2);
        const blur = blurred.data;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const br = blur[i], bg = blur[i + 1], bb = blur[i + 2];

            // Original luminance
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            // Local mean luminance
            const localMean = 0.299 * br + 0.587 * bg + 0.114 * bb;

            // Apply contrast to luminance only
            const deviation = lum - localMean;
            const newLum = localMean + deviation * factor;

            // Scale RGB to match new luminance while preserving color ratios
            if (lum > 0) {
                const scale = Math.max(0, Math.min(2, newLum / lum));
                dst[i] = Math.max(0, Math.min(255, Math.round(r * scale)));
                dst[i + 1] = Math.max(0, Math.min(255, Math.round(g * scale)));
                dst[i + 2] = Math.max(0, Math.min(255, Math.round(b * scale)));
            } else {
                dst[i] = data[i];
                dst[i + 1] = data[i + 1];
                dst[i + 2] = data[i + 2];
            }
            dst[i + 3] = 255;
        }

        return result;
    }

    /**
     * Local contrast enhancement using a sigmoid curve
     * Boosts contrast in a neighborhood while preserving global tonality
     */
    localContrastEnhance(imageData, factor = 1.2) {
        const { width, height, data } = imageData;
        const result = new ImageData(width, height);
        const dst = result.data;

        // Get local mean using blur
        const blurred = this.gaussianBlur(imageData, 2);
        const blur = blurred.data;

        for (let i = 0; i < data.length; i += 4) {
            for (let c = 0; c < 3; c++) {
                const original = data[i + c];
                const localMean = blur[i + c];

                // Enhance deviation from local mean
                const deviation = original - localMean;
                const enhanced = localMean + deviation * factor;
                dst[i + c] = Math.max(0, Math.min(255, Math.round(enhanced)));
            }
            dst[i + 3] = 255;
        }

        return result;
    }

    /**
     * Edge-aware sharpening that enhances details without creating halos
     * (Kept for reference but not used in upscaling - too aggressive)
     */
    edgeAwareSharpening(imageData) {
        const width = imageData.width;
        const height = imageData.height;
        const src = imageData.data;
        const result = new Uint8ClampedArray(src.length);

        const radius = 2;
        const amount = 1.5;
        const threshold = 8;

        const blurred = this.gaussianBlur(imageData, radius);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;

                for (let c = 0; c < 3; c++) {
                    const original = src[idx + c];
                    const blur = blurred.data[idx + c];
                    const diff = original - blur;

                    if (Math.abs(diff) > threshold) {
                        const sharpened = original + diff * amount;
                        result[idx + c] = Math.max(0, Math.min(255, Math.round(sharpened)));
                    } else {
                        result[idx + c] = original;
                    }
                }
                result[idx + 3] = 255;
            }
        }

        return new ImageData(result, width, height);
    }

    /**
     * Tile-based local contrast enhancement (CLAHE-like)
     * Enhances local details without affecting global brightness
     */
    tiledLocalContrastEnhance(imageData) {
        const width = imageData.width;
        const height = imageData.height;
        const src = imageData.data;
        const result = new Uint8ClampedArray(src.length);

        const tileSize = 32;
        const clipLimit = 3.0;

        // Process each tile
        for (let ty = 0; ty < height; ty += tileSize) {
            for (let tx = 0; tx < width; tx += tileSize) {
                const tileW = Math.min(tileSize, width - tx);
                const tileH = Math.min(tileSize, height - ty);

                // Calculate local histogram for luminance
                const histogram = new Array(256).fill(0);
                for (let y = ty; y < ty + tileH; y++) {
                    for (let x = tx; x < tx + tileW; x++) {
                        const idx = (y * width + x) * 4;
                        const lum = Math.round(0.299 * src[idx] + 0.587 * src[idx + 1] + 0.114 * src[idx + 2]);
                        histogram[lum]++;
                    }
                }

                // Clip histogram
                const pixelCount = tileW * tileH;
                const clipThreshold = (clipLimit * pixelCount) / 256;
                let excess = 0;
                for (let i = 0; i < 256; i++) {
                    if (histogram[i] > clipThreshold) {
                        excess += histogram[i] - clipThreshold;
                        histogram[i] = clipThreshold;
                    }
                }

                // Redistribute excess
                const bonus = Math.floor(excess / 256);
                for (let i = 0; i < 256; i++) {
                    histogram[i] += bonus;
                }

                // Build CDF (cumulative distribution function)
                const cdf = new Array(256);
                cdf[0] = histogram[0];
                for (let i = 1; i < 256; i++) {
                    cdf[i] = cdf[i - 1] + histogram[i];
                }

                // Normalize CDF
                const cdfMin = cdf.find(v => v > 0) || 0;
                const scale = 255 / (pixelCount - cdfMin);

                // Apply equalization to tile
                for (let y = ty; y < ty + tileH; y++) {
                    for (let x = tx; x < tx + tileW; x++) {
                        const idx = (y * width + x) * 4;
                        const lum = Math.round(0.299 * src[idx] + 0.587 * src[idx + 1] + 0.114 * src[idx + 2]);
                        const newLum = Math.round((cdf[lum] - cdfMin) * scale);
                        const factor = lum > 0 ? newLum / lum : 1;

                        // Apply factor while preserving color
                        result[idx] = Math.max(0, Math.min(255, Math.round(src[idx] * factor)));
                        result[idx + 1] = Math.max(0, Math.min(255, Math.round(src[idx + 1] * factor)));
                        result[idx + 2] = Math.max(0, Math.min(255, Math.round(src[idx + 2] * factor)));
                        result[idx + 3] = 255;
                    }
                }
            }
        }

        return new ImageData(result, width, height);
    }

    /**
     * Edge Enhancement - Enhances text edges using high-pass filter overlay
     * Great for improving OCR readability on low-contrast plates
     * @param {ImageData} imageData - Input image
     * @returns {ImageData} - Enhanced image
     */
    applyEdgeEnhancement(imageData) {
        const width = imageData.width;
        const height = imageData.height;
        const data = imageData.data;

        console.log('[FrameStacker] 🔲 Applying Edge Enhancement...');

        // Step 1: Create high-pass filtered version (edges only)
        const blurred = this.gaussianBlur(imageData, 2);
        const blurData = blurred.data;

        // Step 2: Extract edges (high-pass = original - blur)
        const edges = new Float32Array(width * height);
        for (let i = 0; i < width * height; i++) {
            const idx = i * 4;
            const origLum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
            const blurLum = 0.299 * blurData[idx] + 0.587 * blurData[idx + 1] + 0.114 * blurData[idx + 2];
            edges[i] = origLum - blurLum; // Can be negative
        }

        // Step 3: Apply adaptive local contrast stretch
        const stats = this.analyzeImageStats(imageData);
        let contrastBoost = 1.5;
        if (stats.contrast < 80) contrastBoost = 2.0; // Low contrast needs more boost
        if (stats.avgLum < 60) contrastBoost = 1.8; // Dark images need careful handling

        // Step 4: Combine edges with original using overlay blend
        const output = new Uint8ClampedArray(data.length);

        for (let i = 0; i < width * height; i++) {
            const idx = i * 4;
            const edgeVal = edges[i] * contrastBoost;

            for (let c = 0; c < 3; c++) {
                // Add edge enhancement while preserving color
                let val = data[idx + c] + edgeVal * 0.8;
                output[idx + c] = Math.max(0, Math.min(255, Math.round(val)));
            }
            output[idx + 3] = 255;
        }

        // Step 5: Apply mild CLAHE for local contrast
        let result = new ImageData(output, width, height);
        if (typeof cv !== 'undefined') {
            result = this.applyCLAHE(result, 1.5, 4);
        } else {
            result = this.applyJSCLAHE(result, 1.5, 4);
        }

        console.log('[FrameStacker] 🔲 Edge Enhancement complete');
        return result;
    }

    /**
     * Bilateral Filter + Sharpen - Preserves edges while reducing noise, then sharpens
     * Best for noisy images where you want clean text
     * @param {ImageData} imageData - Input image
     * @returns {ImageData} - Enhanced image
     */
    applyBilateralSharpen(imageData) {
        console.log('[FrameStacker] 🎯 Applying Bilateral + Sharpen...');

        // Step 1: Analyze image to determine parameters
        const stats = this.analyzeImageStats(imageData);

        // Adjust parameters based on image characteristics
        let radius = 5;
        let sigmaSpace = 25;
        let sigmaColor = 30;
        let sharpenAmount = 1.2;

        if (stats.contrast < 80) {
            // Low contrast - use stronger bilateral to denoise, stronger sharpen
            radius = 7;
            sigmaSpace = 30;
            sigmaColor = 40;
            sharpenAmount = 1.5;
        }

        if (stats.avgLum < 60) {
            // Dark image - lighter bilateral to preserve detail
            radius = 4;
            sigmaSpace = 20;
            sigmaColor = 25;
            sharpenAmount = 1.0;
        }

        // Step 2: Apply bilateral filter (edge-preserving denoise)
        let result = this.applyBilateralFilter(imageData, radius, sigmaSpace, sigmaColor);

        // Step 3: Apply unsharp mask for sharpening
        result = this.unsharpMask(result, sharpenAmount, 1);

        // Step 4: Apply auto-contrast to luminance
        result = this.autoContrastLuminance(result);

        console.log('[FrameStacker] 🎯 Bilateral + Sharpen complete');
        return result;
    }

    /**
     * Apply processing based on enhancementMode property
     * Modes: 'none', 'msr-clahe', 'edge-enhanced', 'bilateral-sharpen'
     * @param {ImageData} imageData - Input image
     * @returns {ImageData} - Enhanced image
     */
    async applyEnhancementMode(imageData) {
        const mode = this.enhancementMode || 'none';
        console.log(`[FrameStacker] Enhancement mode: ${mode}`);

        switch (mode) {
            case 'msr-clahe':
                return await this.applyMAXIMPreProcessing(imageData);
            case 'edge-enhanced':
                return this.applyEdgeEnhancement(imageData);
            case 'bilateral-sharpen':
                return this.applyBilateralSharpen(imageData);
            case 'none':
            default:
                return imageData;
        }
    }

    /**
     * Enable ML upscaling (call before processing)
     * @param {boolean} enabled - Whether to enable upscaling
     * @param {number} scale - Scale factor (2, 3, or 4)
     * @param {string} modelType - Model type: 'default' (2x two-pass), 'thick' (4x native)
     */
    enableMLUpscale(enabled = true, scale = 2, modelType = 'default') {
        this.useMLUpscale = enabled;
        this.mlUpscaleScale = scale;
        this.mlModelType = modelType;
        console.log(`[FrameStacker] ML upscaling ${enabled ? `enabled at ${scale}x (model: ${modelType})` : 'disabled'}`);
    }
}

// Make available globally
window.FrameStacker = FrameStacker;
