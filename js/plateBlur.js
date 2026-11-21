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

        // ===== Tracker tunables =====
        // Frames a track survives without a fresh detection match before it
        // retires. With detection running every 3rd frame at 30fps that's
        // half a second of survival — bridges gaps where detection drops
        // confidence on one or two frames without the blur flickering off.
        this.trackPersistenceFrames = 15;
        // IoU threshold for matching a new detection to an existing track.
        // Lower = stickier (matches even when boxes drift); higher = more
        // strict (avoids merging two adjacent plates).
        this.trackIoUThreshold = 0.25;
        // EMA smoothing factor for position updates. 0.6 = 60% new + 40%
        // smoothed; resists single-frame jitter without lagging too much.
        this.trackPositionEma = 0.6;
        // Frames before we trust velocity enough to predict missed frames.
        this.trackVelocityWarmup = 3;
        // Blur edge softness — fraction of box size used for the feathered
        // alpha gradient. 0.18 ≈ 18% of width/height fades into surroundings.
        this.blurEdgeFeather = 0.18;
        // Frames over which a new track fades in / retiring track fades out
        // (to avoid hard pops on appear/disappear).
        this.trackFadeFrames = 4;

        // Active tracks. Each: {
        //   id, x, y, width, height, vx, vy, confidence,
        //   framesSinceSeen, framesTracked
        // }
        this._tracks = [];
        this._nextTrackId = 1;

        // Legacy time-window history kept for the older _smoothDetections
        // path until we fully replace it. New tracker is used by
        // processMultiCamera (the export path).
        this.detectionHistory = [];
        this.historyDuration = 1500;

        // Progress callback
        this.onProgress = null;

        // Debug overlay
        this.debugCanvas = null;
        this.debugCtx = null;
        this.debugActive = false;
        this.debugAnimationId = null;
    }

    /**
     * Reset tracker state. Call when starting a new export so leftover
     * tracks from a previous run don't persist as ghost blurs.
     */
    resetTracker() {
        this._tracks = [];
        this._nextTrackId = 1;
    }

    /** Compute IoU (intersection-over-union) of two AABBs. */
    _iou(a, b) {
        const ax2 = a.x + a.width, ay2 = a.y + a.height;
        const bx2 = b.x + b.width, by2 = b.y + b.height;
        const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
        const inter = ix * iy;
        if (inter <= 0) return 0;
        const union = a.width * a.height + b.width * b.height - inter;
        return inter / union;
    }

    /**
     * Update tracks with a fresh batch of detections (or none — pass [] to
     * just age existing tracks). Returns the list of currently-active
     * tracks to render.
     *
     * Behavior per detection:
     *   - Match to best existing track by IoU >= threshold
     *   - If matched: smooth position via EMA, update velocity, reset
     *     framesSinceSeen, increment framesTracked
     *   - If unmatched: create new track
     *
     * Behavior per existing track without a match this update:
     *   - framesSinceSeen += 1
     *   - If we've tracked it long enough to trust velocity, advance
     *     position by (vx, vy) so it follows a moving car
     *   - Retire when framesSinceSeen > trackPersistenceFrames
     *
     * @param {Array} detections — [{x,y,width,height,confidence}]
     * @param {boolean} hadFreshDetection — false if we used cache this frame
     *   (so we don't bump framesSinceSeen on cache-only frames; cache means
     *   "no new info" not "didn't see plate")
     */
    _updateTracks(detections, hadFreshDetection) {
        // 1. Match detections to existing tracks
        const detUsed = new Set();
        const trackUpdated = new Set();

        for (let ti = 0; ti < this._tracks.length; ti++) {
            const track = this._tracks[ti];
            let bestIdx = -1;
            let bestIou = this.trackIoUThreshold;
            for (let di = 0; di < detections.length; di++) {
                if (detUsed.has(di)) continue;
                const iou = this._iou(track, detections[di]);
                if (iou > bestIou) { bestIou = iou; bestIdx = di; }
            }
            if (bestIdx >= 0) {
                const det = detections[bestIdx];
                detUsed.add(bestIdx);
                trackUpdated.add(ti);
                const a = this.trackPositionEma;
                // Velocity = current top-left motion (per-update, not per-frame).
                track.vx = (det.x - track.x);
                track.vy = (det.y - track.y);
                // Smooth position
                track.x = track.x * (1 - a) + det.x * a;
                track.y = track.y * (1 - a) + det.y * a;
                track.width = track.width * (1 - a) + det.width * a;
                track.height = track.height * (1 - a) + det.height * a;
                track.confidence = det.confidence ?? track.confidence;
                track.framesSinceSeen = 0;
                track.framesTracked++;
            }
        }

        // 2. Spawn new tracks for unmatched detections
        for (let di = 0; di < detections.length; di++) {
            if (detUsed.has(di)) continue;
            const d = detections[di];
            this._tracks.push({
                id: this._nextTrackId++,
                x: d.x, y: d.y, width: d.width, height: d.height,
                vx: 0, vy: 0,
                confidence: d.confidence || 0.5,
                framesSinceSeen: 0,
                framesTracked: 1
            });
        }

        // 3. Age existing un-matched tracks. Only count this as a "missed
        //    frame" when the caller actually ran fresh detection — if we
        //    were on a cache-only frame, we have no new info either way.
        if (hadFreshDetection) {
            for (let ti = 0; ti < this._tracks.length; ti++) {
                if (trackUpdated.has(ti)) continue;
                const track = this._tracks[ti];
                track.framesSinceSeen++;
                // Predict forward via velocity once we trust it
                if (track.framesTracked >= this.trackVelocityWarmup) {
                    track.x += track.vx;
                    track.y += track.vy;
                }
            }
        }

        // 4. Retire tracks past the persistence horizon
        this._tracks = this._tracks.filter(t => t.framesSinceSeen <= this.trackPersistenceFrames);

        return this._tracks;
    }

    /**
     * Compute the alpha multiplier for a track based on its lifecycle:
     * fade in over trackFadeFrames at birth, full alpha while healthy,
     * fade out as framesSinceSeen approaches trackPersistenceFrames.
     */
    _trackAlpha(track) {
        const fade = this.trackFadeFrames;
        const fadeIn = Math.min(1, track.framesTracked / fade);
        const lifeLeft = this.trackPersistenceFrames - track.framesSinceSeen;
        const fadeOut = Math.min(1, Math.max(0, lifeLeft / fade));
        return Math.min(fadeIn, fadeOut);
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
    blurRegion(ctx, region, blurRadius = this.blurRadius, alpha = 1.0) {
        const { x, y, width, height } = region;

        // Ensure region is valid
        if (width <= 0 || height <= 0) return;

        // Soft-edge blur: render the blurred patch through a feathered
        // radial alpha mask so the boundary fades into the surrounding
        // pixels instead of cutting off at a hard rectangle. Combined with
        // optional alpha for track fade-in / fade-out.
        //
        // Pipeline:
        //   1. Copy source patch onto an offscreen canvas with blur filter
        //   2. Composite a radial gradient via destination-in to mask the
        //      offscreen patch (center 100% opacity → outer ring 0%)
        //   3. Draw the masked patch onto the main canvas at the requested
        //      alpha (lifecycle fade)
        const padding = blurRadius * 2;
        const patchX = Math.max(0, x - padding);
        const patchY = Math.max(0, y - padding);
        const patchW = Math.round(width + padding * 2);
        const patchH = Math.round(height + padding * 2);
        if (patchW <= 0 || patchH <= 0) return;

        const off = document.createElement('canvas');
        off.width = patchW;
        off.height = patchH;
        const offCtx = off.getContext('2d');

        offCtx.filter = `blur(${blurRadius}px)`;
        offCtx.drawImage(
            ctx.canvas,
            patchX, patchY, patchW, patchH,
            0, 0, patchW, patchH
        );
        offCtx.filter = 'none';

        // Feathered alpha mask via radial gradient.
        const cx = patchW / 2;
        const cy = patchH / 2;
        const innerR = Math.max(1, Math.min(width, height) / 2 * (1 - this.blurEdgeFeather));
        const outerR = Math.max(width, height) / 2 + padding * 0.5;
        const grad = offCtx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
        grad.addColorStop(0, 'rgba(0,0,0,1)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        offCtx.globalCompositeOperation = 'destination-in';
        offCtx.fillStyle = grad;
        offCtx.fillRect(0, 0, patchW, patchH);
        offCtx.globalCompositeOperation = 'source-over';

        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = prevAlpha * alpha;
        ctx.drawImage(off, patchX, patchY);
        ctx.globalAlpha = prevAlpha;
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
        // cadence 'frames' (exports): detect only on the frames the caller asks for (every 5th), as designed. The
        // 100 ms wall-clock rule below made every frame a detection whenever a frame took longer than 100 ms to
        // make, which is every frame of a 6-camera export on a busy PC: about 5x slower, and the page stopped
        // answering for minutes (#569 follow-up, 2026-11-19).
        const { forceDetection = false, cadence = 'time' } = options;

        if (!this.isModelLoaded) {
            return 0;
        }

        const now = performance.now();
        this.frameCount++;

        let totalBlurred = 0;

        // Cache-only frame — no fresh detection this tick. Tick the tracker
        // forward without registering a "missed detection" (since we
        // haven't actually checked) and render whatever's still active.
        if (!forceDetection && (cadence === 'frames' || now - this.lastDetectionTime < this.detectionInterval)) {
            const tracks = this._updateTracks([], /* hadFreshDetection */ false);
            for (const track of tracks) {
                const alpha = this._trackAlpha(track);
                if (alpha <= 0) continue;
                const paddedRegion = {
                    x: Math.max(0, track.x - this.blurPadding),
                    y: Math.max(0, track.y - this.blurPadding),
                    width: track.width + this.blurPadding * 2,
                    height: track.height + this.blurPadding * 2
                };
                if (paddedRegion.width > 5 && paddedRegion.height > 5) {
                    this.blurRegion(ctx, paddedRegion, this.blurRadius, alpha);
                    totalBlurred++;
                }
            }
            return totalBlurred;
        }

        // Run fresh detection on each camera
        const allDetections = [];

        for (const [camName, camInfo] of Object.entries(cameras)) {
            const { video, dx, dy, dw, dh, crop, objectFit } = camInfo;

            // Accept any of: HTMLVideoElement (must have src + readyState>=2),
            // HTMLCanvasElement, ImageBitmap, OffscreenCanvas, VideoFrame —
            // the YOLO detector handles all of these as CanvasImageSource.
            // ImageBitmap is what the fast WebCodecs export path produces;
            // without this branch, plate blur was skipped on every frame
            // there.
            if (!video) continue;
            const isVideoEl = (typeof HTMLVideoElement !== 'undefined') && (video instanceof HTMLVideoElement);
            if (isVideoEl) {
                if (!video.src || video.readyState < 2) continue;
            }

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

        // Update tracker with fresh detections — IoU-matches new boxes to
        // existing tracks (smoothed positions), spawns new tracks, ages
        // unmatched ones with velocity prediction, retires anything past
        // trackPersistenceFrames frames since last seen.
        const tracks = this._updateTracks(allDetections, /* hadFreshDetection */ true);
        this.lastDetectionTime = now;

        // Mirror tracks to cachedDetections for legacy consumers (debug
        // overlay, single-camera path) — same shape as before.
        this.cachedDetections = tracks.map(t => ({
            x: t.x, y: t.y, width: t.width, height: t.height,
            confidence: t.confidence
        }));

        // Render each track with lifecycle-aware alpha (fade in/out).
        for (const track of tracks) {
            const alpha = this._trackAlpha(track);
            if (alpha <= 0) continue;
            const paddedRegion = {
                x: Math.max(0, track.x - this.blurPadding),
                y: Math.max(0, track.y - this.blurPadding),
                width: track.width + this.blurPadding * 2,
                height: track.height + this.blurPadding * 2
            };
            if (paddedRegion.width > 5 && paddedRegion.height > 5) {
                this.blurRegion(ctx, paddedRegion, this.blurRadius, alpha);
                totalBlurred++;
            }
        }

        if (this.frameCount % 30 === 1) {
            console.log(`[PlateBlur] MultiCamera: ${totalBlurred} blurred / ${tracks.length} tracks across ${Object.keys(cameras).length} cameras`);
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
