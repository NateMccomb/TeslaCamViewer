/**
 * RegionTracker - Optical flow tracking for region of interest
 * Uses OpenCV.js to track a region across video frames
 */
class RegionTracker {
    constructor() {
        this.minPoints = 4; // Minimum tracked points to consider valid
        this.maxCorners = 50; // Maximum corners to detect
        this.qualityLevel = 0.01;
        this.minDistance = 7;
        this.useTemplateMatchingFallback = true; // Use template matching when optical flow fails
        this.templateMatchThreshold = 0.6; // Minimum correlation for template match
    }

    /**
     * Track a region across multiple frames using optical flow
     * @param {Array} frames - Array of { imageData, time, cameraId }
     * @param {Object} initialRegion - { x, y, width, height } in video coordinates
     * @param {Function} onProgress - Optional progress callback (percent 0-1)
     * @returns {Array} - Array of tracked regions (or null for lost frames)
     */
    async track(frames, initialRegion, onProgress = null) {
        if (!frames || frames.length === 0) {
            return [];
        }

        const results = [];

        // Get first frame
        const firstFrame = frames[0].imageData;
        let prevGray = this.imageDataToMat(firstFrame);
        let prevGrayConverted = new cv.Mat();
        cv.cvtColor(prevGray, prevGrayConverted, cv.COLOR_RGBA2GRAY);

        // Detect good features to track AROUND the region (vehicle context)
        // This is more stable than tracking features ON the small plate
        let points = this.detectFeaturesAroundRegion(prevGrayConverted, initialRegion, 2.5);

        if (points.rows === 0) {
            console.warn('[RegionTracker] No features found in initial region');
            prevGray.delete();
            prevGrayConverted.delete();
            return frames.map(() => null);
        }

        // First frame uses initial region
        results.push({ ...initialRegion });

        // Capture template from first frame for fallback matching
        this.captureTemplate(prevGrayConverted, initialRegion);

        // Track through remaining frames
        for (let i = 1; i < frames.length; i++) {
            // Report progress
            if (onProgress && i % 5 === 0) {
                onProgress(i / frames.length);
                await new Promise(r => setTimeout(r, 0)); // Yield to UI
            }

            const frame = frames[i].imageData;
            const currGray = this.imageDataToMat(frame);
            const currGrayConverted = new cv.Mat();
            cv.cvtColor(currGray, currGrayConverted, cv.COLOR_RGBA2GRAY);

            // Calculate optical flow
            const nextPoints = new cv.Mat();
            const status = new cv.Mat();
            const err = new cv.Mat();

            try {
                cv.calcOpticalFlowPyrLK(
                    prevGrayConverted,
                    currGrayConverted,
                    points,
                    nextPoints,
                    status,
                    err,
                    new cv.Size(21, 21),
                    3,
                    new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01)
                );

                // Filter good points
                const goodNew = [];
                const goodOld = [];

                for (let j = 0; j < status.rows; j++) {
                    if (status.data[j] === 1) {
                        const oldPt = { x: points.data32F[j * 2], y: points.data32F[j * 2 + 1] };
                        const newPt = { x: nextPoints.data32F[j * 2], y: nextPoints.data32F[j * 2 + 1] };

                        // Check if point moved reasonably (not too far)
                        const dist = Math.sqrt(Math.pow(newPt.x - oldPt.x, 2) + Math.pow(newPt.y - oldPt.y, 2));
                        if (dist < 50) { // Max 50 pixels movement per frame
                            goodNew.push(newPt);
                            goodOld.push(oldPt);
                        }
                    }
                }

                if (goodNew.length >= this.minPoints) {
                    // Calculate average movement from tracked context points
                    const prevRegion = results[results.length - 1];
                    const newRegion = this.computeRegionFromMovement(goodOld, goodNew, prevRegion, initialRegion);
                    results.push(newRegion);

                    // Update points for next iteration
                    points.delete();
                    points = this.pointsArrayToMat(goodNew);
                } else {
                    // Tracking lost - try template matching fallback
                    let recovered = null;

                    if (this.useTemplateMatchingFallback && this.templateImage) {
                        const lastGoodRegion = this.getLastGoodRegion(results) || initialRegion;
                        recovered = this.templateMatchFallback(currGrayConverted, lastGoodRegion);
                    }

                    if (recovered) {
                        console.log(`[RegionTracker] Recovered tracking at frame ${i} using template matching`);
                        results.push(recovered);

                        // Reinitialize points AROUND recovered region
                        points.delete();
                        points = this.detectFeaturesAroundRegion(currGrayConverted, recovered, 2.5);
                    } else {
                        console.warn(`[RegionTracker] Tracking lost at frame ${i}, only ${goodNew.length} points`);
                        results.push(null);

                        // Try to reinitialize with new features around last good region
                        points.delete();
                        const lastGoodRegion = this.getLastGoodRegion(results);
                        if (lastGoodRegion) {
                            points = this.detectFeaturesAroundRegion(currGrayConverted, lastGoodRegion, 2.5);
                        } else {
                            points = new cv.Mat();
                        }
                    }
                }

                nextPoints.delete();
                status.delete();
                err.delete();

            } catch (error) {
                console.error('[RegionTracker] Optical flow error:', error);
                results.push(null);
            }

            // Update for next iteration
            prevGrayConverted.delete();
            prevGrayConverted = currGrayConverted;
            prevGray.delete();
            prevGray = currGray;
        }

        // Cleanup
        prevGray.delete();
        prevGrayConverted.delete();
        points.delete();
        this.cleanup(); // Clean up template

        return results;
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
     * Detect good features within a region
     */
    detectFeaturesInRegion(grayMat, region) {
        // Create mask for region
        const mask = cv.Mat.zeros(grayMat.rows, grayMat.cols, cv.CV_8UC1);
        const pt1 = new cv.Point(region.x, region.y);
        const pt2 = new cv.Point(region.x + region.width, region.y + region.height);
        cv.rectangle(mask, pt1, pt2, new cv.Scalar(255), -1);

        // Detect corners
        const corners = new cv.Mat();
        cv.goodFeaturesToTrack(
            grayMat,
            corners,
            this.maxCorners,
            this.qualityLevel,
            this.minDistance,
            mask
        );

        mask.delete();
        return corners;
    }

    /**
     * Detect features AROUND the region (in surrounding context)
     * This tracks the vehicle body/bumper which is more stable than plate features
     * @param {Object} grayMat - Grayscale image
     * @param {Object} region - The plate region
     * @param {number} expandFactor - How much to expand (2 = 2x the region size)
     */
    detectFeaturesAroundRegion(grayMat, region, expandFactor = 2.5) {
        // Calculate expanded region (context around the plate)
        const expandW = region.width * expandFactor;
        const expandH = region.height * expandFactor;
        const centerX = region.x + region.width / 2;
        const centerY = region.y + region.height / 2;

        // Expanded bounding box
        const expandedX = Math.max(0, Math.round(centerX - expandW / 2));
        const expandedY = Math.max(0, Math.round(centerY - expandH / 2));
        const expandedW = Math.min(Math.round(expandW), grayMat.cols - expandedX);
        const expandedH = Math.min(Math.round(expandH), grayMat.rows - expandedY);

        // Create mask: white in expanded area, black where the plate is (exclude plate interior)
        const mask = cv.Mat.zeros(grayMat.rows, grayMat.cols, cv.CV_8UC1);

        // Fill expanded area with white
        const pt1 = new cv.Point(expandedX, expandedY);
        const pt2 = new cv.Point(expandedX + expandedW, expandedY + expandedH);
        cv.rectangle(mask, pt1, pt2, new cv.Scalar(255), -1);

        // Cut out the plate region (we want features AROUND it, not ON it)
        // Actually, keep plate features too for better tracking
        // const platePt1 = new cv.Point(region.x, region.y);
        // const platePt2 = new cv.Point(region.x + region.width, region.y + region.height);
        // cv.rectangle(mask, platePt1, platePt2, new cv.Scalar(0), -1);

        // Detect corners in the surrounding area
        const corners = new cv.Mat();
        cv.goodFeaturesToTrack(
            grayMat,
            corners,
            this.maxCorners * 2, // More corners for better tracking
            this.qualityLevel,
            this.minDistance,
            mask
        );

        mask.delete();

        console.log(`[RegionTracker] Detected ${corners.rows} features around region (expanded ${expandFactor}x)`);
        return corners;
    }

    /**
     * Compute new region by calculating average movement of context points
     * This is more robust than bounding box - we just translate the region
     * @param {Array} oldPoints - Points in previous frame
     * @param {Array} newPoints - Same points in current frame
     * @param {Object} prevRegion - Previous frame's region
     * @param {Object} originalRegion - Original selection (for size reference)
     */
    computeRegionFromMovement(oldPoints, newPoints, prevRegion, originalRegion) {
        if (oldPoints.length === 0 || oldPoints.length !== newPoints.length) {
            return prevRegion;
        }

        // Calculate average dx, dy movement
        let totalDx = 0, totalDy = 0;
        for (let i = 0; i < oldPoints.length; i++) {
            totalDx += newPoints[i].x - oldPoints[i].x;
            totalDy += newPoints[i].y - oldPoints[i].y;
        }
        const avgDx = totalDx / oldPoints.length;
        const avgDy = totalDy / oldPoints.length;

        // Constrain movement to reasonable bounds (max 30 pixels per frame)
        const maxMove = 30;
        const constrainedDx = Math.max(-maxMove, Math.min(maxMove, avgDx));
        const constrainedDy = Math.max(-maxMove, Math.min(maxMove, avgDy));

        // Apply movement to previous region
        return {
            x: Math.round(prevRegion.x + constrainedDx),
            y: Math.round(prevRegion.y + constrainedDy),
            width: originalRegion.width,  // Keep original size
            height: originalRegion.height
        };
    }

    /**
     * Convert array of points to OpenCV Mat
     */
    pointsArrayToMat(points) {
        const mat = new cv.Mat(points.length, 1, cv.CV_32FC2);
        for (let i = 0; i < points.length; i++) {
            mat.data32F[i * 2] = points[i].x;
            mat.data32F[i * 2 + 1] = points[i].y;
        }
        return mat;
    }

    /**
     * Compute bounding box from tracked points
     * Maintains aspect ratio of original region
     * @param {Array} points - Tracked points
     * @param {Object} originalRegion - Original selection region
     * @param {Object} previousRegion - Previous frame's region (for constraining movement)
     */
    computeBoundingBox(points, originalRegion, previousRegion = null) {
        if (points.length === 0) return null;

        // Find centroid of new points
        let sumX = 0, sumY = 0;
        points.forEach(pt => {
            sumX += pt.x;
            sumY += pt.y;
        });
        let centroidX = sumX / points.length;
        let centroidY = sumY / points.length;

        // Constrain centroid movement to prevent jumping to other objects
        const maxCentroidMove = 30; // Max pixels the centroid can move per frame
        if (previousRegion) {
            const prevCentroidX = previousRegion.x + previousRegion.width / 2;
            const prevCentroidY = previousRegion.y + previousRegion.height / 2;

            const dx = centroidX - prevCentroidX;
            const dy = centroidY - prevCentroidY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist > maxCentroidMove) {
                // Limit the movement
                const scale = maxCentroidMove / dist;
                centroidX = prevCentroidX + dx * scale;
                centroidY = prevCentroidY + dy * scale;
            }
        }

        // Find min/max to estimate scale
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        points.forEach(pt => {
            minX = Math.min(minX, pt.x);
            minY = Math.min(minY, pt.y);
            maxX = Math.max(maxX, pt.x);
            maxY = Math.max(maxY, pt.y);
        });

        // Estimate scale factor from point spread
        const spreadX = maxX - minX;
        const spreadY = maxY - minY;
        const originalSpreadX = originalRegion.width * 0.8; // Assume points cover 80% of region
        const originalSpreadY = originalRegion.height * 0.8;

        const scaleX = spreadX / originalSpreadX || 1;
        const scaleY = spreadY / originalSpreadY || 1;
        const scale = (scaleX + scaleY) / 2; // Average scale

        // Limit scale changes to prevent sudden size jumps
        // Allow 50% size change per frame for approaching/receding vehicles
        const limitedScale = Math.min(Math.max(scale, 0.5), 1.5);

        // Compute new region centered on centroid with scaled size
        const newWidth = Math.round(originalRegion.width * limitedScale);
        const newHeight = Math.round(originalRegion.height * limitedScale);

        return {
            x: Math.round(centroidX - newWidth / 2),
            y: Math.round(centroidY - newHeight / 2),
            width: newWidth,
            height: newHeight
        };
    }

    /**
     * Get the last successfully tracked region
     */
    getLastGoodRegion(results) {
        for (let i = results.length - 1; i >= 0; i--) {
            if (results[i]) return results[i];
        }
        return null;
    }

    /**
     * Capture template from the initial region for fallback matching
     */
    captureTemplate(grayMat, region) {
        try {
            // Ensure region is within bounds
            const x = Math.max(0, Math.min(region.x, grayMat.cols - region.width));
            const y = Math.max(0, Math.min(region.y, grayMat.rows - region.height));
            const w = Math.min(region.width, grayMat.cols - x);
            const h = Math.min(region.height, grayMat.rows - y);

            if (w < 10 || h < 10) {
                this.templateImage = null;
                return;
            }

            // Extract template
            const rect = new cv.Rect(x, y, w, h);
            this.templateImage = grayMat.roi(rect).clone();
            this.templateRegion = { x, y, width: w, height: h };
        } catch (e) {
            console.warn('[RegionTracker] Failed to capture template:', e);
            this.templateImage = null;
        }
    }

    /**
     * Try to find the region using template matching
     * Returns the matched region or null if not found
     */
    templateMatchFallback(grayMat, searchRegion) {
        if (!this.templateImage) return null;

        try {
            // Define search area around last known position (expanded)
            const searchMargin = Math.max(searchRegion.width, searchRegion.height);
            const searchX = Math.max(0, searchRegion.x - searchMargin);
            const searchY = Math.max(0, searchRegion.y - searchMargin);
            const searchW = Math.min(searchRegion.width + searchMargin * 2, grayMat.cols - searchX);
            const searchH = Math.min(searchRegion.height + searchMargin * 2, grayMat.rows - searchY);

            // Ensure search area is larger than template
            if (searchW <= this.templateImage.cols || searchH <= this.templateImage.rows) {
                return null;
            }

            // Extract search area
            const searchRect = new cv.Rect(searchX, searchY, searchW, searchH);
            const searchArea = grayMat.roi(searchRect);

            // Perform template matching
            const result = new cv.Mat();
            cv.matchTemplate(searchArea, this.templateImage, result, cv.TM_CCOEFF_NORMED);

            // Find best match
            const minMax = cv.minMaxLoc(result);
            const maxVal = minMax.maxVal;
            const maxLoc = minMax.maxLoc;

            result.delete();
            searchArea.delete();

            // Check if match is good enough
            if (maxVal < this.templateMatchThreshold) {
                return null;
            }

            // Calculate matched region in full image coordinates
            return {
                x: searchX + maxLoc.x,
                y: searchY + maxLoc.y,
                width: this.templateImage.cols,
                height: this.templateImage.rows
            };

        } catch (e) {
            console.warn('[RegionTracker] Template matching failed:', e);
            return null;
        }
    }

    /**
     * Cleanup template resources
     */
    cleanup() {
        if (this.templateImage) {
            this.templateImage.delete();
            this.templateImage = null;
        }
    }
}

// Make available globally
window.RegionTracker = RegionTracker;
