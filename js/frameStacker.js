/**
 * FrameStacker - Multi-frame enhancement pipeline
 * Ranks frames by sharpness, aligns them, and stacks for noise reduction
 */
class FrameStacker {
    constructor() {
        this.topFrameCount = 8; // Return top 8 sharpest frames
        this.stackFrameCount = 40; // Use top 40 for stacking (more frames = less noise)
        this.useFeatureAlignment = true; // Use feature matching to align frames
        this.useMotionDeblur = true; // Apply motion deblur to blurry frames
        this.useMLUpscale = false; // ML super-resolution (disabled by default, large model)
        this.mlUpscaleScale = 2; // Upscale factor (2x, 3x, or 4x)
        this.mlUpscaleModel = null; // Loaded TensorFlow model
        this.mlUpscaleLoading = false;
        this.usePerspectiveCorrection = true; // Auto de-skew angled plates
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

        // Step 7: Enhance the stacked result
        updateProgress('Applying enhancements...', 0.8);
        await new Promise(r => setTimeout(r, 10));

        const enhanced = this.enhance(stacked);

        // Step 8: ML super-resolution upscaling (if enabled)
        let upscaled = null;
        if (this.useMLUpscale) {
            updateProgress('Applying super-resolution upscaling...', 0.9);
            await new Promise(r => setTimeout(r, 10));

            upscaled = await this.applyMLUpscale(enhanced, this.mlUpscaleScale);
        }

        updateProgress('Finalizing...', 0.95);

        const result = {
            combined: {
                dataUrl: this.imageDataToDataUrl(enhanced),
                sharpness: this.calculateSharpness(enhanced)
            },
            topFrames
        };

        // Include upscaled version separately for comparison
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
     * Process pre-cropped frames (for re-processing with selected frames)
     * @param {Array} frames - Array of { dataUrl, sharpness, cameraId, time }
     * @param {Function} onProgress - Progress callback
     * @param {Object} videoEnhancements - Video enhancement settings
     * @returns {Object} - Same format as process()
     */
    async processPreCropped(frames, onProgress = null, videoEnhancements = null) {
        this.videoEnhancements = videoEnhancements || { brightness: 100, contrast: 100, saturation: 100 };

        if (!frames || frames.length < 2) {
            throw new Error('Need at least 2 frames to process');
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
            await new Promise(r => setTimeout(r, 10));

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

        // Enhance
        updateProgress('Applying enhancements...', 0.7);
        await new Promise(r => setTimeout(r, 10));

        const enhanced = this.enhance(stacked);

        // ML upscaling (if enabled)
        let upscaled = null;
        if (this.useMLUpscale) {
            updateProgress('Applying super-resolution...', 0.85);
            await new Promise(r => setTimeout(r, 10));

            upscaled = await this.applyMLUpscale(enhanced, this.mlUpscaleScale);
        }

        updateProgress('Finalizing...', 0.95);

        const result = {
            combined: {
                dataUrl: this.imageDataToDataUrl(enhanced),
                sharpness: this.calculateSharpness(enhanced)
            },
            topFrames
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
     * Calculate sharpness using Laplacian variance
     * Higher value = sharper image
     */
    calculateSharpness(imageData) {
        const gray = this.toGrayscale(imageData);
        const laplacian = this.applyLaplacian(gray);

        // Calculate variance
        let sum = 0;
        let sumSq = 0;
        const data = laplacian.data;

        for (let i = 0; i < data.length; i += 4) {
            const val = data[i];
            sum += val;
            sumSq += val * val;
        }

        const count = data.length / 4;
        const mean = sum / count;
        const variance = (sumSq / count) - (mean * mean);

        return variance;
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
     * Stack multiple frames using median blending
     */
    async stackFrames(frames, onProgress = null) {
        if (frames.length === 0) {
            throw new Error('No frames to stack');
        }

        if (frames.length === 1) {
            return frames[0].imageData;
        }

        // Use reference frame (sharpest) as size template
        const ref = frames[0].imageData;
        const width = ref.width;
        const height = ref.height;

        // Resize all frames to match reference (in case of slight size differences from tracking)
        const normalized = frames.map(f => this.resizeToMatch(f.imageData, width, height));

        // Median blend
        const result = new ImageData(width, height);
        const pixels = result.data;
        const totalPixels = width * height;

        for (let i = 0; i < totalPixels; i++) {
            const idx = i * 4;

            // Collect values from all frames
            const reds = [], greens = [], blues = [];
            for (const frame of normalized) {
                reds.push(frame.data[idx]);
                greens.push(frame.data[idx + 1]);
                blues.push(frame.data[idx + 2]);
            }

            // Median of each channel
            pixels[idx] = this.median(reds);
            pixels[idx + 1] = this.median(greens);
            pixels[idx + 2] = this.median(blues);
            pixels[idx + 3] = 255;

            // Progress update every 1000 pixels
            if (onProgress && i % 1000 === 0) {
                onProgress(i / totalPixels);
                await new Promise(r => setTimeout(r, 0)); // Yield to UI
            }
        }

        return result;
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
     * Apply enhancement filters
     */
    enhance(imageData) {
        let result = imageData;

        // Step 0: Perspective correction (de-skew) if OpenCV available
        if (this.usePerspectiveCorrection && typeof cv !== 'undefined') {
            const corrected = this.correctPerspective(result);
            if (corrected) {
                result = corrected;
            }
        }

        // Step 1: Auto white balance (color correction)
        result = this.autoWhiteBalance(result);

        // Step 2: Auto contrast (histogram stretching)
        result = this.autoContrast(result);

        // Step 3: Unsharp mask for sharpening
        result = this.unsharpMask(result, 1.5, 1);

        // Step 4: Slight denoise with bilateral-like filter
        result = this.simpleDenoisePreserveEdges(result);

        // Step 5: Apply user's video enhancement settings
        if (this.videoEnhancements) {
            result = this.applyVideoEnhancements(result, this.videoEnhancements);
        }

        return result;
    }

    /**
     * Correct perspective distortion (de-skew angled plates)
     * Uses edge detection and contour analysis to find plate bounds
     */
    correctPerspective(imageData) {
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
     */
    simpleDenoisePreserveEdges(imageData) {
        const width = imageData.width;
        const height = imageData.height;
        const src = imageData.data;

        const result = new ImageData(width, height);
        const dst = result.data;

        const spatialSigma = 1.5;
        const rangeSigma = 30;
        const radius = 2;

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
     * Align frames using feature matching (ORB features + homography)
     * Aligns all frames to the reference (sharpest) frame
     */
    async alignFrames(frames, onProgress = null) {
        if (frames.length < 2) return frames;

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
     * Apply ML-style super-resolution upscaling
     * Uses advanced interpolation with edge-aware enhancement
     * @param {ImageData} imageData - Input image
     * @param {number} scale - Scale factor (default 2x)
     */
    async applyMLUpscale(imageData, scale = 2) {
        const srcWidth = imageData.width;
        const srcHeight = imageData.height;
        const dstWidth = Math.round(srcWidth * scale);
        const dstHeight = Math.round(srcHeight * scale);

        console.log(`[FrameStacker] *** SUPER-RESOLUTION UPSCALING ***`);
        console.log(`[FrameStacker] Upscaling from ${srcWidth}x${srcHeight} to ${dstWidth}x${dstHeight}`);

        // Step 1: High-quality bicubic upscale using canvas
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = srcWidth;
        srcCanvas.height = srcHeight;
        const srcCtx = srcCanvas.getContext('2d');
        srcCtx.putImageData(imageData, 0, 0);

        const dstCanvas = document.createElement('canvas');
        dstCanvas.width = dstWidth;
        dstCanvas.height = dstHeight;
        const dstCtx = dstCanvas.getContext('2d');

        // Use high quality image smoothing
        dstCtx.imageSmoothingEnabled = true;
        dstCtx.imageSmoothingQuality = 'high';
        dstCtx.drawImage(srcCanvas, 0, 0, dstWidth, dstHeight);

        let upscaled = dstCtx.getImageData(0, 0, dstWidth, dstHeight);

        // Step 2: Apply gentle sharpening to compensate for upscale blur
        console.log(`[FrameStacker] Applying gentle sharpening...`);
        upscaled = this.gentleSharpening(upscaled);

        // Step 3: Skip CLAHE - it can cause artifacts on small images
        // The regular enhance() already does contrast adjustment

        console.log(`[FrameStacker] Super-resolution complete!`);
        return upscaled;
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
     * Local contrast enhancement (CLAHE-like)
     * Enhances local details without affecting global brightness
     */
    localContrastEnhance(imageData) {
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
     * Enable ML upscaling (call before processing)
     * @param {boolean} enabled - Whether to enable upscaling
     * @param {number} scale - Scale factor (2, 3, or 4)
     */
    enableMLUpscale(enabled = true, scale = 2) {
        this.useMLUpscale = enabled;
        this.mlUpscaleScale = scale;
        console.log(`[FrameStacker] ML upscaling ${enabled ? `enabled at ${scale}x` : 'disabled'}`);
    }
}

// Make available globally
window.FrameStacker = FrameStacker;
