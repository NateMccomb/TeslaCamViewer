/**
 * VideoExport - Exports video segments with multiple views
 * Codec: VP9/H264 adaptive, 30fps target
 */

class VideoExport {
    constructor(videoPlayer, layoutManager = null) {
        this.videoPlayer = videoPlayer;
        this.layoutManager = layoutManager;
        this._oid = 0x544356; // export origin id
        this.isExporting = false;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.onProgress = null;
        this.exportStartTime = null;
        this.lastProgressUpdate = 0;
        this.renderIntervalId = null; // For cleanup during cancel
        this.speedWasReduced = false; // Track if export speed was reduced due to buffering
        this.exportWallStartTime = null; // Track wall-clock start for ETA calculation
    }

    /**
     * Get export status for UI feedback
     * @returns {Object} Export status info
     */
    getExportStatus() {
        return {
            isExporting: this.isExporting,
            speedWasReduced: this.speedWasReduced,
            currentSpeed: this.currentExportSpeed,
            originalSpeed: this.exportSpeed,
            wallStartTime: this.exportWallStartTime
        };
    }

    /**
     * Set layout manager reference
     * @param {LayoutManager} layoutManager
     */
    setLayoutManager(layoutManager) {
        this.layoutManager = layoutManager;
    }

    /**
     * Get camera order from layout manager (reflects user drag/drop swaps)
     * @returns {Array} Array of camera names in current visual order
     */
    getCameraOrder() {
        const hasPillars = this.videoPlayer?.hasPillarCameras || false;
        const defaultOrder = hasPillars
            ? ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar']
            : ['front', 'back', 'left_repeater', 'right_repeater'];
        return this.layoutManager?.cameraOrder || defaultOrder;
    }

    /**
     * Build mapping from layout position to actual video source based on camera order
     * When user swaps cameras via drag/drop, cameraOrder changes but layout positions don't
     * This mapping ensures export matches what user sees on screen
     * @returns {Object} Map of position name to video source name
     */
    buildCameraMapping() {
        const hasPillars = this.videoPlayer?.hasPillarCameras || false;
        const defaultOrder = hasPillars
            ? ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar']
            : ['front', 'back', 'left_repeater', 'right_repeater'];
        const currentOrder = this.getCameraOrder();

        // Map: position name -> which video to show there
        const mapping = {};
        for (let i = 0; i < defaultOrder.length; i++) {
            mapping[defaultOrder[i]] = currentOrder[i] || defaultOrder[i];
        }

        console.log('Camera mapping for export:', mapping);
        return mapping;
    }

    /**
     * Get layout configuration for export
     * Uses the same layout configuration as the display renderer for consistency
     * @param {number} videoWidth - Base video width
     * @param {number} videoHeight - Base video height
     * @returns {Object} Layout configuration with canvas size and video positions
     */
    getLayoutConfig(videoWidth, videoHeight) {
        const layout = this.layoutManager?.getCurrentLayout() || 'grid-2x2';

        // Always use getCurrentConfig + calculateExportConfig for consistent rendering
        if (this.layoutManager && this.layoutManager.renderer) {
            const layoutConfig = this.layoutManager.getCurrentConfig();
            if (layoutConfig) {
                const exportConfig = this.layoutManager.renderer.calculateExportConfig(
                    layoutConfig, videoWidth, videoHeight
                );
                console.log('Export layout config:', layoutConfig.name, exportConfig);
                return exportConfig;
            }
        }

        // Fallback: Default 2x2 grid if layoutManager not available
        const visibleCameras = this.layoutManager?.getVisibleCameras() || {
            front: true, back: true, left_repeater: true, right_repeater: true,
            left_pillar: true, right_pillar: true
        };
        const config = {
            canvasWidth: videoWidth * 2,
            canvasHeight: videoHeight * 2,
            aspectRatio: '4:3',
            cameras: {
                front: { x: 0, y: 0, w: videoWidth, h: videoHeight, visible: visibleCameras.front },
                back: { x: videoWidth, y: 0, w: videoWidth, h: videoHeight, visible: visibleCameras.back },
                left_repeater: { x: 0, y: videoHeight, w: videoWidth, h: videoHeight, visible: visibleCameras.left_repeater },
                right_repeater: { x: videoWidth, y: videoHeight, w: videoWidth, h: videoHeight, visible: visibleCameras.right_repeater },
                // Pillar cameras not shown in fallback 2x2 grid
                left_pillar: { x: 0, y: 0, w: 0, h: 0, visible: false },
                right_pillar: { x: 0, y: 0, w: 0, h: 0, visible: false }
            }
        };

        console.log('Export layout config (fallback):', layout, config);
        return config;
    }

    /**
     * Wait for all videos to be ready at a specific timestamp
     * @param {number} targetTime - Target absolute time in seconds
     * @param {number} timeout - Max wait time in ms (default 5000)
     * @returns {Promise<boolean>} True if all videos are ready
     */
    async seekAndWaitForFrame(targetTime, timeout = 5000) {
        const videos = this.videoPlayer.videos;
        const hasPillars = this.videoPlayer?.hasPillarCameras || false;
        const videoElements = hasPillars
            ? [videos.front, videos.back, videos.left_repeater, videos.right_repeater, videos.left_pillar, videos.right_pillar].filter(v => v)
            : [videos.front, videos.back, videos.left_repeater, videos.right_repeater].filter(v => v);

        // Seek using the videoPlayer's method (handles clip boundaries)
        await this.videoPlayer.seekToEventTime(targetTime);

        // Wait for all videos to have data at this frame
        return new Promise((resolve) => {
            const startTime = Date.now();

            const checkReady = () => {
                // Check if timed out
                if (Date.now() - startTime > timeout) {
                    console.warn('Frame seek timeout at', targetTime);
                    resolve(false);
                    return;
                }

                // Check if all videos have enough data
                const allReady = videoElements.every(v => {
                    if (!v.src) return true; // No source means not needed
                    return v.readyState >= 2; // HAVE_CURRENT_DATA or better
                });

                if (allReady) {
                    resolve(true);
                } else {
                    // Check again in 10ms
                    setTimeout(checkReady, 10);
                }
            };

            checkReady();
        });
    }

    /**
     * Export using frame-by-frame capture (no real-time playback)
     * This method seeks to each frame and waits for it to be ready before capturing.
     * Slower but eliminates stuttering issues.
     */
    /**
     * Export using pre-rendered frames with buffered MediaRecorder.
     * This approach renders all frames first, then plays them back for recording.
     */
    async exportFrameByFrame(options = {}) {
        const {
            format = 'webm',
            quality = 0.9,
            startTime = null,
            endTime = null,
            includeOverlay = true,
            onProgress = null,
            fps = 30
        } = options;

        // Handle GIF export separately
        if (format === 'gif') {
            return this.exportAsGif(options);
        }

        console.log('Starting buffered frame-by-frame export...');

        if (this.isExporting) {
            throw new Error('Export already in progress');
        }

        this.isExporting = true;
        this.exportWallStartTime = Date.now();
        this.onProgress = onProgress;
        this.recordedChunks = [];

        const videos = this.videoPlayer.videos;
        if (!videos.front.src) {
            this.isExporting = false;
            throw new Error('No video loaded');
        }

        // Pause any playback
        await this.videoPlayer.pause();

        // Check if watermark is needed
        await this._checkWatermark();

        // Calculate total duration
        if (!this.cachedTotalDuration) {
            this.cachedTotalDuration = await this.videoPlayer.getTotalDuration();
        }

        // Determine export range
        const exportStart = startTime !== null ? startTime : 0;
        const exportEnd = endTime !== null ? endTime : this.cachedTotalDuration;
        const exportDuration = exportEnd - exportStart;
        const frameInterval = 1 / fps;
        const totalFrames = Math.ceil(exportDuration * fps);

        console.log(`Buffered export: ${totalFrames} frames @ ${fps}fps, ${exportStart.toFixed(2)}s to ${exportEnd.toFixed(2)}s`);

        // Get video dimensions
        const videoWidth = videos.front.videoWidth || 1280;
        const videoHeight = videos.front.videoHeight || 960;

        // Get layout config with proper dimensions
        const layoutConfig = this.getLayoutConfig(videoWidth, videoHeight);
        const canvasWidth = layoutConfig.canvasWidth || 1920;
        const canvasHeight = layoutConfig.canvasHeight || 1080;

        console.log(`Canvas size: ${canvasWidth}x${canvasHeight}`);

        // Note: We skip pre-rendering telemetry and use on-demand rendering instead.
        // On-demand rendering uses the video player's actual clip/time state, which ensures
        // the telemetry matches exactly what the user saw during preview.
        // Pre-rendering had timing drift issues due to clip duration estimation.

        // Get camera mapping
        const cameraMapping = this.buildCameraMapping();

        // Pre-cache mini-map tiles if mini-map export is enabled
        const settings = window.app?.settingsManager;
        const miniMapInExport = settings && settings.get('miniMapInExport') !== false;
        if (window.app?.miniMapOverlay && miniMapInExport && window.app.telemetryOverlay?.hasTelemetryData()) {
            console.log('Pre-caching mini-map tiles...');
            // Clear trail before export to start fresh
            window.app.miniMapOverlay.clearTrail();
            try {
                // Gather all GPS positions from telemetry for the export range
                const positions = [];
                const sampleInterval = 1; // Sample every 1 second
                for (let t = exportStart; t <= exportEnd; t += sampleInterval) {
                    await this.videoPlayer.seekToEventTime(t);
                    const clipIndex = this.videoPlayer.currentClipIndex || 0;
                    const timeInClip = this.videoPlayer.getCurrentTime() || 0;
                    const videoDuration = this.videoPlayer.getCurrentDuration() || 60;
                    window.app.telemetryOverlay.updateTelemetry(clipIndex, timeInClip, videoDuration);
                    const data = window.app.telemetryOverlay.currentData;
                    if (data?.latitude_deg && data?.longitude_deg) {
                        positions.push({ lat: data.latitude_deg, lng: data.longitude_deg });
                    }
                }
                // Pre-cache tiles for all positions
                await window.app.miniMapOverlay.preCacheTilesForExport(positions);
                // Seek back to export start
                await this.videoPlayer.seekToEventTime(exportStart);
            } catch (e) {
                console.warn('Failed to pre-cache mini-map tiles:', e);
            }
        }

        // Phase 1: Render all frames to ImageData buffer
        console.log('Phase 1: Rendering frames to buffer...');
        const frameBuffer = [];
        const renderCanvas = document.createElement('canvas');
        renderCanvas.width = canvasWidth;
        renderCanvas.height = canvasHeight;
        const renderCtx = renderCanvas.getContext('2d', { alpha: false });

        try {
            for (let frameNum = 0; frameNum < totalFrames; frameNum++) {
                if (!this.isExporting) {
                    console.log('Export cancelled during rendering');
                    return;
                }

                const absoluteTime = exportStart + (frameNum * frameInterval);

                // Seek and wait for frame
                const frameReady = await this.seekAndWaitForFrame(absoluteTime, 3000);

                // Clear canvas
                renderCtx.fillStyle = '#000000';
                renderCtx.fillRect(0, 0, canvasWidth, canvasHeight);

                if (frameReady) {
                    // Draw cameras sorted by z-index (lower z-index first, so higher ones are on top)
                    const sortedCameras = Object.entries(layoutConfig.cameras)
                        .filter(([name, cam]) => cam.visible && cam.w > 0 && cam.h > 0)
                        .sort((a, b) => (a[1].zIndex || 1) - (b[1].zIndex || 1));

                    for (const [camPosition, camConfig] of sortedCameras) {
                        const actualCameraName = cameraMapping[camPosition];
                        const video = videos[actualCameraName];

                        if (!video || !video.src || video.readyState < 2) continue;

                        // Use centralized calculation for source/destination rectangles
                        const { sx, sy, sw, sh, dx, dy, dw, dh } = LayoutRenderer.calculateDrawParams(video, camConfig);
                        renderCtx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
                    }
                }

                // Add watermarks for free tier users
                if (this._shouldWatermark) {
                    this.addWatermarksToFrame(renderCtx, layoutConfig);
                }

                // Apply license plate blurring if enabled - use multi-camera method for proper coordinate mapping
                const blurPlatesEnabled = window.app?.settingsManager?.get('blurLicensePlates') === true;
                if (blurPlatesEnabled && window.app?.plateBlur?.isReady()) {
                    try {
                        // Build camera info for multi-camera processing
                        const cameraInfos = {};
                        for (const [camPosition, camConfig] of sortedCameras) {
                            const actualCameraName = cameraMapping[camPosition];
                            const video = videos[actualCameraName];
                            if (video && video.src && video.readyState >= 2) {
                                cameraInfos[actualCameraName] = {
                                    video: video,
                                    dx: camConfig.x,
                                    dy: camConfig.y,
                                    dw: camConfig.w,
                                    dh: camConfig.h,
                                    crop: camConfig.crop || { top: 0, right: 0, bottom: 0, left: 0 },
                                    objectFit: camConfig.objectFit || 'contain'
                                };
                            }
                        }
                        await window.app.plateBlur.processMultiCamera(renderCtx, cameraInfos, {
                            forceDetection: frameNum % 3 === 0 // Run detection every 3rd frame for performance
                        });
                    } catch (blurError) {
                        if (frameNum % 30 === 0) {
                            console.warn('[Export] Plate blur error:', blurError);
                        }
                    }
                }

                // Check privacy mode setting
                const settings = window.app?.settingsManager;
                const privacyMode = settings && settings.get('privacyModeExport') === true;

                // Calculate mini-map rect for label occlusion avoidance (if mini-map will be drawn)
                let miniMapRect = null;
                const miniMapInExport = !settings || settings.get('miniMapInExport') !== false;
                if (!privacyMode && window.app?.miniMapOverlay && miniMapInExport) {
                    const pos = window.app.miniMapOverlay.position || { x: 80, y: 10 };
                    const scale = canvasWidth / 1920;
                    const mapWidth = Math.round(200 * scale);
                    const mapHeight = Math.round(200 * scale);
                    miniMapRect = {
                        x: (pos.x / 100) * canvasWidth,
                        y: (pos.y / 100) * canvasHeight,
                        w: mapWidth,
                        h: mapHeight
                    };
                }

                // Calculate scale factor for label overlays (1920px reference)
                const labelScale = canvasWidth / 1920;
                // Base font size 18px to match live view proportions
                const scaledFontSize = Math.round(18 * labelScale);

                // Add camera labels using centralized smart positioning (matches live view)
                if (this.layoutManager?.renderer) {
                    this.layoutManager.renderer.addLabelsToCanvas(renderCtx, layoutConfig, {
                        fontSize: scaledFontSize,
                        cameraMapping: cameraMapping,
                        videos: videos,
                        miniMapRect: miniMapRect
                    });
                } else {
                    // Fallback if no renderer
                    this.addCameraLabelsForLayout(renderCtx, layoutConfig, cameraMapping);
                }

                // Add timestamp overlay (skipped in privacy mode)
                if (includeOverlay && !privacyMode) {
                    this.addOverlay(renderCtx, canvasWidth, canvasHeight, absoluteTime);
                }

                // Add telemetry overlay using video player's actual state (skipped in privacy mode)
                // This ensures telemetry matches exactly what the user saw during preview
                const telemetryEnabled = !settings || settings.get('telemetryOverlayInExport') !== false;

                if (!privacyMode && window.app?.telemetryOverlay && telemetryEnabled && window.app.telemetryOverlay.hasTelemetryData()) {
                    // Use video player's current clip/time (set by seekToEventTime during frame rendering)
                    const clipIndex = this.videoPlayer.currentClipIndex || 0;
                    const timeInClip = this.videoPlayer.getCurrentTime() || 0;
                    const videoDuration = this.videoPlayer.getCurrentDuration() || 60;

                    // Update telemetry data for current position
                    window.app.telemetryOverlay.updateTelemetry(clipIndex, timeInClip, videoDuration);

                    // Get the updated telemetry data and render to canvas
                    const telemetryData = window.app.telemetryOverlay.getCurrentTelemetry();
                    if (telemetryData) {
                        // Debug: log telemetry changes every 30 frames (1 second)
                        if (frameNum % 30 === 0) {
                            console.log(`[Export] Frame ${frameNum}: clip=${clipIndex}, time=${timeInClip.toFixed(2)}, AP=${telemetryData.autopilot_name}, brake=${telemetryData.brake_applied}, gY=${(telemetryData.g_force_y || 0).toFixed(2)}`);
                        }
                        const blinkState = frameNum % 30 < 15; // 1 second blink cycle
                        // HUD scale uses smaller reference (1000px) to appear larger/closer to live view
                        const hudScale = canvasWidth / 1000;
                        window.app.telemetryOverlay.renderToCanvas(renderCtx, canvasWidth, canvasHeight, telemetryData, {
                            blinkState,
                            scale: hudScale
                        });

                        // Add mini-map overlay if export setting is enabled (skipped in privacy mode)
                        const miniMapInExport = !settings || settings.get('miniMapInExport') !== false;
                        if (window.app?.miniMapOverlay && miniMapInExport && telemetryData.latitude_deg && telemetryData.longitude_deg) {
                            window.app.miniMapOverlay.updatePositionForExport(
                                telemetryData.latitude_deg,
                                telemetryData.longitude_deg,
                                telemetryData.heading_deg || 0
                            );
                            window.app.miniMapOverlay.drawToCanvas(renderCtx, canvasWidth, canvasHeight);
                        }
                    }
                }

                // Store frame as ImageBitmap (more efficient than ImageData)
                const bitmap = await createImageBitmap(renderCanvas);
                frameBuffer.push(bitmap);

                // Report render progress (0-50%)
                if (this.onProgress) {
                    const progressPercent = ((frameNum + 1) / totalFrames) * 50;
                    this.onProgress(progressPercent, absoluteTime - exportStart, exportDuration);
                }

                // Yield every 5 frames
                if (frameNum % 5 === 0) {
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            console.log(`Rendered ${frameBuffer.length} frames to buffer`);

            // Phase 2: Play back frames at correct timing and record
            console.log('Phase 2: Recording from buffer...');

            const playbackCanvas = document.createElement('canvas');
            playbackCanvas.width = canvasWidth;
            playbackCanvas.height = canvasHeight;
            const playbackCtx = playbackCanvas.getContext('2d', { alpha: false });

            // Setup MediaRecorder with target framerate
            const stream = playbackCanvas.captureStream(fps);
            const mimeType = format === 'mp4'
                ? (MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm;codecs=h264')
                : 'video/webm;codecs=vp9';

            this.mediaRecorder = new MediaRecorder(stream, {
                mimeType,
                videoBitsPerSecond: 20_000_000
            });

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    this.recordedChunks.push(e.data);
                }
            };

            // Record all frames at correct timing for MediaRecorder
            // Using real-time playback to ensure proper frame capture
            await new Promise((resolve, reject) => {
                this.mediaRecorder.onstop = resolve;
                this.mediaRecorder.onerror = reject;

                this.mediaRecorder.start();

                let frameIndex = 0;
                const frameIntervalMs = 1000 / fps;
                const startTime = performance.now();

                const drawNextFrame = () => {
                    if (frameIndex >= frameBuffer.length || !this.isExporting) {
                        // All frames drawn, wait for last frame to be captured
                        setTimeout(() => {
                            this.mediaRecorder.stop();
                        }, frameIntervalMs * 2);
                        return;
                    }

                    // Draw frame
                    playbackCtx.drawImage(frameBuffer[frameIndex], 0, 0);

                    // Report playback progress (50-100%)
                    if (this.onProgress) {
                        const progressPercent = 50 + ((frameIndex + 1) / frameBuffer.length) * 50;
                        const elapsedSec = (frameIndex / fps);
                        this.onProgress(progressPercent, elapsedSec, exportDuration);
                    }

                    frameIndex++;

                    // Schedule next frame at precise interval
                    const elapsed = performance.now() - startTime;
                    const expectedTime = frameIndex * frameIntervalMs;
                    const delay = Math.max(0, expectedTime - elapsed);
                    setTimeout(drawNextFrame, delay);
                };

                drawNextFrame();
            });

            // Create and download the video
            const blob = new Blob(this.recordedChunks, { type: mimeType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `TeslaCam_Export_${new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')}.${format === 'mp4' ? 'mp4' : 'webm'}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            // Clean up frame buffer
            for (const bitmap of frameBuffer) {
                bitmap.close();
            }

            console.log('Buffered frame-by-frame export complete!');

        } catch (error) {
            console.error('Buffered export error:', error);
            // Clean up frame buffer
            for (const bitmap of frameBuffer) {
                if (bitmap && typeof bitmap.close === 'function') {
                    bitmap.close();
                }
            }
            throw error;
        } finally {
            this.isExporting = false;
            if (window.app?.telemetryOverlay) {
                window.app.telemetryOverlay.clearExportBuffer();
            }
        }
    }

    /**
     * Export current clip from all 4 cameras as composite video
     * @param {Object} options - Export options
     * @param {string} options.format - Video format ('webm' or 'mp4')
     * @param {number} options.quality - Quality 0-1
     * @param {number} options.startTime - Start time in seconds (optional)
     * @param {number} options.endTime - End time in seconds (optional)
     * @param {boolean} options.includeOverlay - Add timestamp overlay
     * @param {Function} options.onProgress - Progress callback (percent, currentTime, totalTime)
     * @param {number} options.speed - Playback speed for export (default 1)
     * @returns {Promise<void>}
     */
    async exportComposite(options = {}) {
        const {
            format = 'webm',
            quality = 0.9,
            startTime = null,
            endTime = null,
            includeOverlay = true,
            onProgress = null,
            speed = 1
        } = options;

        this.onProgress = onProgress;
        this.exportStartTime = Date.now();
        this.exportSpeed = speed;

        console.log('VideoExport.exportComposite called', { format, startTime, endTime, speed, onProgress: !!onProgress });

        if (this.isExporting) {
            throw new Error('Export already in progress');
        }

        // Return a promise that resolves when export is complete
        return new Promise(async (resolve, reject) => {
            this.exportResolve = resolve;
            this.exportReject = reject;

            try {
                await this.startExport(format, startTime, endTime, includeOverlay);
            } catch (error) {
                this.isExporting = false;
                reject(error);
            }
        });
    }

    /**
     * Internal method to start the export process
     */
    async startExport(format, startTime, endTime, includeOverlay) {
        // Check session access for exporting
        const sessionManager = window.app?.sessionManager;
        if (sessionManager) {
            const access = await sessionManager.checkAccess('exportEvent');
            if (!access.allowed) {
                sessionManager.showLimitModal(access.type || 'export');
                return;
            }
        }

        const videos = this.videoPlayer.videos;
        if (!videos.front.src) {
            throw new Error('No video loaded');
        }

        this.isExporting = true;
        this.recordedChunks = [];
        this.overlayLogCounter = 0; // Reset overlay logging counter

        // Pause the main video player to prevent resource conflicts and error spam
        // The main player trying to sync while export runs causes 100K+ errors
        try {
            await this.videoPlayer.pause();
            console.log('[VideoExport] Paused main video player during export');
        } catch (e) {
            // Ignore pause errors
        }
        this.cachedTotalDuration = null; // Reset cached duration for new export
        this.cachedClipDurations = []; // Cache individual clip durations
        this.cachedOverlayData = null; // Reset cached overlay data for new export
        this.speedWasReduced = false; // Reset speed reduction flag
        this.exportWallStartTime = Date.now(); // Track wall-clock start for ETA
        this._shouldWatermark = false; // Default, will be set asynchronously

        // Check if watermark is needed (must await before rendering)
        await this._checkWatermark();

        try {
            // Get ACTUAL total duration from video player (same calculation as timeline marker)
            this.cachedTotalDuration = await this.videoPlayer.getTotalDuration();
            console.log('Export using actual total duration:', this.cachedTotalDuration, 'seconds');
            console.log('Sentry marker will be at:', (this.cachedTotalDuration - 60).toFixed(2), 'seconds');

            // Cache individual clip durations for accurate absoluteTime calculation
            console.log('Caching individual clip durations...');
            const event = this.videoPlayer.currentEvent;
            for (let i = 0; i < event.clipGroups.length; i++) {
                const clipGroup = event.clipGroups[i];
                const clip = clipGroup.clips.front;
                if (clip && clip.fileHandle) {
                    try {
                        const file = await clip.fileHandle.getFile();
                        const video = document.createElement('video');
                        const url = URL.createObjectURL(file);
                        video.src = url;

                        const duration = await new Promise((resolve) => {
                            video.onloadedmetadata = () => {
                                resolve(video.duration || 60);
                            };
                        });

                        video.src = '';
                        URL.revokeObjectURL(url);

                        this.cachedClipDurations[i] = duration;
                        console.log(`  Clip ${i}: ${duration.toFixed(2)}s`);
                    } catch (error) {
                        console.error(`Error getting duration for clip ${i}:`, error);
                        this.cachedClipDurations[i] = 60; // Default
                    }
                } else {
                    this.cachedClipDurations[i] = 60; // Default
                }
            }
            console.log('Clip duration caching complete:', this.cachedClipDurations.length, 'clips');
            // Create canvas for composite
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            // Get video dimensions
            const videoWidth = videos.front.videoWidth;
            const videoHeight = videos.front.videoHeight;

            // Get layout configuration
            const layoutConfig = this.getLayoutConfig(videoWidth, videoHeight);

            // Set canvas size based on layout
            canvas.width = layoutConfig.canvasWidth;
            canvas.height = layoutConfig.canvasHeight;

            // Build camera mapping to handle user drag/drop swaps
            // Maps position name to actual video source (e.g., if user swapped front/back)
            const cameraMapping = this.buildCameraMapping();

            // Pre-cache crop and object-fit calculations for each camera (performance optimization)
            const cachedCropValues = {};
            const cachedDestRects = {};
            for (const [camName, camConfig] of Object.entries(layoutConfig.cameras)) {
                // Use mapping to get correct video for this position
                const videoSource = cameraMapping[camName] || camName;
                const video = videos[videoSource];
                if (video && camConfig.visible) {
                    // Use centralized calculation and cache the results
                    const params = LayoutRenderer.calculateDrawParams(video, camConfig);
                    cachedCropValues[camName] = { sx: params.sx, sy: params.sy, sw: params.sw, sh: params.sh };
                    cachedDestRects[camName] = { dx: params.dx, dy: params.dy, dw: params.dw, dh: params.dh };
                }
            }
            console.log('Cached crop values for', Object.keys(cachedCropValues).length, 'cameras');

            // Determine export duration
            // startTime is either IN marker or current position (passed from app.js)
            // endTime is either OUT marker or null (export to end of event)
            const exportStart = startTime !== null ? startTime : 0;
            const exportEnd = endTime !== null ? endTime : this.cachedTotalDuration;
            const exportDuration = exportEnd - exportStart;

            console.log('Export range - Start:', exportStart.toFixed(2), '| End:', exportEnd.toFixed(2), '| Duration:', exportDuration.toFixed(2));
            console.log('Start position:', startTime !== null ? startTime.toFixed(2) : '0 (beginning of event)');
            console.log('End position:', endTime !== null ? endTime.toFixed(2) + ' (OUT marker)' : this.cachedTotalDuration.toFixed(2) + ' (end of event)');

            // Note: Telemetry is rendered on-demand using video player's actual state
            // This ensures telemetry matches exactly what the user sees during preview

            // Seek to start position (use seekToEventTime for absolute time)
            const wasPlaying = this.videoPlayer.getIsPlaying();
            if (wasPlaying) {
                await this.videoPlayer.pause();
            }

            // ALWAYS seek BEFORE the export start to account for:
            // 1. Time elapsed while starting playback
            // 2. MediaRecorder startup delay
            // 3. Browser rendering pipeline delay
            const prerollTime = 1.0; // Start 1 second before export start
            const seekTarget = Math.max(0, exportStart - prerollTime);

            console.log('Seeking to', seekTarget.toFixed(2), '(', prerollTime.toFixed(2), 's before export start at', exportStart.toFixed(2), ')');
            await this.videoPlayer.seekToEventTime(seekTarget);

            // Wait for seek to complete
            console.log('Waiting for seek to complete and videos to stabilize...');
            await new Promise(resolve => setTimeout(resolve, 500));

            // Verify seek position
            const currentClipIndex = this.videoPlayer.currentClipIndex;
            let verifyAbsoluteTime = 0;
            for (let i = 0; i < currentClipIndex; i++) {
                verifyAbsoluteTime += this.cachedClipDurations[i] || 60;
            }
            verifyAbsoluteTime += this.videoPlayer.getCurrentTime();
            console.log('After seek - Target:', seekTarget.toFixed(2), '| Actual:', verifyAbsoluteTime.toFixed(2), '| Diff:', (verifyAbsoluteTime - seekTarget).toFixed(2));

            // Setup MediaRecorder (but don't start yet)
            const mimeType = format === 'mp4' ? 'video/mp4' : 'video/webm';
            const stream = canvas.captureStream(30); // 30 FPS

            // Try to use VP9 codec specifically for better WebM finalization
            const supportedMimeType = this.getSupportedMimeType(mimeType);
            console.log('Using MIME type:', supportedMimeType);

            this.mediaRecorder = new MediaRecorder(stream, {
                mimeType: supportedMimeType,
                videoBitsPerSecond: 5000000 // 5 Mbps - lower bitrate for better compatibility
            });

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    console.log('Data chunk received, size:', event.data.size);
                    this.recordedChunks.push(event.data);
                }
            };

            this.mediaRecorder.onerror = (event) => {
                console.error('MediaRecorder error:', event.error);
            };

            // Track last clip index to detect clip changes
            let lastClipIndex = this.videoPlayer.currentClipIndex;
            let exportStopped = false;
            let skipFramesAfterClipChange = 0; // Skip end-time checks for a few frames after clip change
            let recordingStartLogged = false; // Log once when we reach IN marker
            let lastAbsoluteTime = -1; // Track for stall detection
            let stallFrameCount = 0; // Count frames where time hasn't advanced
            let bufferStallCount = 0; // Count frames stalled during buffering phase
            let recordingStallCount = 0; // Count frames stalled during recording phase (after IN marker)
            this.currentExportSpeed = this.exportSpeed || 1; // Track current speed for gradual step-down (class property for UI access)
            let speedReductionAttempts = 0; // Track how many times we've reduced speed
            let totalFramesRendered = 0; // Track total frames for diagnostics
            let lastDiagnosticTime = performance.now(); // Track time for periodic diagnostics

            // Diagnostic logging function
            const dumpExportDiagnostics = (reason) => {
                console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('EXPORT DIAGNOSTICS:', reason);
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

                const currentClipIndex = this.videoPlayer.currentClipIndex;
                const currentTimeInClip = this.videoPlayer.getCurrentTime();

                // Calculate absolute time
                let absoluteTime = 0;
                for (let i = 0; i < currentClipIndex; i++) {
                    absoluteTime += this.cachedClipDurations[i] || 60;
                }
                absoluteTime += currentTimeInClip;

                const elapsed = absoluteTime - exportStart;
                const progressPercent = (elapsed / exportDuration) * 100;

                console.log('Export Progress:');
                console.log('  - Progress:', progressPercent.toFixed(1) + '%');
                console.log('  - Absolute time:', absoluteTime.toFixed(2) + 's');
                console.log('  - Export range:', exportStart.toFixed(2) + 's →', exportEnd.toFixed(2) + 's');
                console.log('  - Duration:', exportDuration.toFixed(2) + 's');
                console.log('  - Time remaining:', (exportEnd - absoluteTime).toFixed(2) + 's');

                console.log('\nPlayback State:');
                console.log('  - Current clip:', currentClipIndex, '/', (this.videoPlayer.currentEvent?.clipGroups.length - 1));
                console.log('  - Time in clip:', currentTimeInClip.toFixed(2) + 's');
                console.log('  - Stall frames (clip end):', stallFrameCount);
                console.log('  - Stall frames (buffering):', bufferStallCount);
                console.log('  - Stall frames (recording):', recordingStallCount);
                console.log('  - Skip frames:', skipFramesAfterClipChange);
                console.log('  - Current export speed:', this.currentExportSpeed + 'x');
                console.log('  - Speed reduction attempts:', speedReductionAttempts);
                console.log('  - Total frames rendered:', totalFramesRendered);

                console.log('\nVideo States:');
                Object.entries(videos).forEach(([name, video]) => {
                    const states = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
                    console.log('  - ' + name + ':');
                    console.log('      readyState:', video.readyState, '(' + (states[video.readyState] || 'UNKNOWN') + ')');
                    console.log('      paused:', video.paused);
                    console.log('      currentTime:', video.currentTime.toFixed(2) + 's');
                    console.log('      duration:', video.duration.toFixed(2) + 's');
                    console.log('      ended:', video.ended);
                });

                console.log('\nMediaRecorder:');
                console.log('  - State:', this.mediaRecorder?.state);
                console.log('  - Chunks collected:', this.recordedChunks.length);
                console.log('  - Note: Using single-blob mode, chunks arrive only at stop()');
                console.log('  - Expected: 0 chunks during recording, 1 chunk after stop');

                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            };

            // Render frames to canvas using setInterval for consistent 30fps timing
            // (requestAnimationFrame timing is too variable and causes frame skipping)
            const renderFrame = () => {
                if (!this.isExporting || exportStopped) {
                    if (this.renderIntervalId) {
                        clearInterval(this.renderIntervalId);
                        this.renderIntervalId = null;
                    }
                    return;
                }

                totalFramesRendered++;

                // Get absolute time in event (not just current clip time)
                const currentClipIndex = this.videoPlayer.currentClipIndex;
                const currentTimeInClip = this.videoPlayer.getCurrentTime();

                // Safety check: ensure currentTimeInClip is valid
                if (isNaN(currentTimeInClip) || currentTimeInClip < 0) {
                    console.warn('Invalid currentTimeInClip:', currentTimeInClip, '- skipping this frame');
                    return; // setInterval will call again
                }

                // Safety check: ensure front video is ready
                const frontVideo = this.videoPlayer.videos.front;
                if (!frontVideo || frontVideo.readyState < 2) {
                    console.warn('Front video not ready (readyState:', frontVideo?.readyState, ') - skipping this frame');
                    return; // setInterval will call again
                }

                // Detect if we've moved to a new clip
                if (currentClipIndex !== lastClipIndex) {
                    console.log('CLIP TRANSITION:', lastClipIndex, '->', currentClipIndex, '| Time in new clip:', currentTimeInClip.toFixed(2));
                    console.log('   Previous clip ended at:', lastAbsoluteTime.toFixed(2) + 's');
                    lastClipIndex = currentClipIndex;
                    // Set flag to wait for videos to be ready
                    skipFramesAfterClipChange = 90; // ~3 seconds at 30fps max wait
                }

                // Calculate absolute time by adding actual previous clip durations
                let absoluteTime = 0;
                for (let i = 0; i < currentClipIndex; i++) {
                    absoluteTime += this.cachedClipDurations[i] || 60;
                }
                absoluteTime += currentTimeInClip;

                // If we haven't reached the IN marker yet, render black frames
                if (absoluteTime < exportStart) {
                    ctx.fillStyle = '#000000';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);

                    // Detect stall during buffering (time not advancing)
                    if (lastAbsoluteTime >= 0 && Math.abs(absoluteTime - lastAbsoluteTime) < 0.01) {
                        bufferStallCount++;

                        // Gradual speed reduction: first try 2x (with stabilization pause), then 1x
                        if (bufferStallCount === 60 && this.currentExportSpeed > 2) {
                            console.warn('Buffering stalled - pausing to stabilize, then trying 2x (was ' + this.currentExportSpeed + 'x)');
                            this.currentExportSpeed = 2;
                            speedReductionAttempts++;
                            this.speedWasReduced = true;

                            // Pause, let buffers refill, then resume at 2x
                            this.videoPlayer.pause().then(() => {
                                console.log('Paused for buffer stabilization (1.5s)...');
                                setTimeout(() => {
                                    this.videoPlayer.setPlaybackRate(2);
                                    this.videoPlayer.play().then(() => {
                                        console.log('Resumed playback at 2x');
                                    });
                                }, 1500); // 1.5 second pause to let buffers refill
                            });
                            bufferStallCount = 0; // Reset counter to give 2x a chance
                        } else if (bufferStallCount === 60 && this.currentExportSpeed > 1) {
                            console.warn('Buffering stalled at 2x - reducing to 1x speed');
                            this.currentExportSpeed = 1;
                            speedReductionAttempts++;
                            this.speedWasReduced = true;
                            this.videoPlayer.setPlaybackRate(1);
                        }

                        // If still stalled after ~5 seconds (150 frames) at 1x, try seeking
                        if (bufferStallCount === 150 && this.currentExportSpeed === 1) {
                            console.warn('Buffering still stalled at 1x - attempting to seek to IN marker');
                            const seekTarget = exportStart + 0.1;
                            this.videoPlayer.seekToEventTime(seekTarget).catch(e => {
                                console.error('Seek failed:', e);
                            });
                        }

                        // If stalled for ~10 seconds (300 frames) at 1x, give up and start anyway
                        if (bufferStallCount >= 300 && this.currentExportSpeed === 1) {
                            console.warn('Buffering timeout - starting export from current position');
                            console.error('BUFFER ERROR: Video data could not be read fast enough.');
                            console.error('If this keeps happening, try moving footage to a faster drive (SSD recommended).');
                            setTimeout(() => {
                                alert('Buffer Warning: Video data could not be read fast enough.\n\nThe export will continue from the current position.\n\nIf this keeps happening, try:\n• Moving footage to a faster drive (SSD)\n• Closing other applications using the drive');
                            }, 100);
                            bufferStallCount = 0;
                            // Continue to recording (don't return)
                        } else {
                            return; // setInterval will call again
                        }
                    } else {
                        // Time is advancing, reset stall counter
                        bufferStallCount = 0;
                        lastAbsoluteTime = absoluteTime;

                        // Log every 30 frames (~1 second)
                        if (totalFramesRendered % 30 === 0) {
                            const speedNote = this.currentExportSpeed < (this.exportSpeed || 1) ? ' (reduced to ' + this.currentExportSpeed + 'x)' : '';
                            console.log('Buffering... Current:', absoluteTime.toFixed(2), '| IN marker:', exportStart.toFixed(2), '| Remaining:', (exportStart - absoluteTime).toFixed(2) + speedNote);
                        }

                        return; // setInterval will call again
                    }
                }

                // Log once when we reach the IN marker
                if (!recordingStartLogged) {
                    console.log('RECORDING STARTED - Reached IN marker at:', absoluteTime.toFixed(2));
                    recordingStartLogged = true;
                }

                // During clip transition, wait for videos to be ready
                if (skipFramesAfterClipChange > 0) {
                    skipFramesAfterClipChange--;

                    // Check if all videos are ready
                    const allVideosReady = Object.values(videos).every(v => v.readyState >= 2);

                    if (allVideosReady) {
                        const framesWaited = 90 - skipFramesAfterClipChange;
                        console.log('   Videos ready after', framesWaited, 'frames (~' + (framesWaited / 30).toFixed(1) + 's)');
                        skipFramesAfterClipChange = 0;
                    } else if (skipFramesAfterClipChange > 0) {
                        // Still waiting - render black frame and continue loop
                        if (skipFramesAfterClipChange % 15 === 0) {
                            console.log('   Waiting for clips... frames left:', skipFramesAfterClipChange, '| readyStates:', Object.values(videos).map(v => v.readyState).join(','));
                        }

                        ctx.fillStyle = '#000000';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);

                        return; // setInterval will call again
                    } else {
                        console.log('   Clip loading timeout, proceeding anyway | readyStates:', Object.values(videos).map(v => v.readyState).join(','));
                    }
                }

                // Check if ALL videos have ended - trigger clip transition if so
                const allVideosEnded = Object.values(videos).every(v => v.ended);
                const hasMoreClips = currentClipIndex < this.videoPlayer.currentEvent.clipGroups.length - 1;

                // If all videos ended and there are more clips, transition after brief delay
                if (allVideosEnded && hasMoreClips) {
                    stallFrameCount++;

                    // After 15 frames (~0.5s) with all videos ended, trigger clip transition
                    if (stallFrameCount === 15) {
                        console.log('ALL VIDEOS ENDED - Transitioning to next clip');
                        console.log('   Current clip:', currentClipIndex, '| Next clip:', currentClipIndex + 1);

                        // Manually trigger clip transition
                        const nextClipIndex = currentClipIndex + 1;
                        this.videoPlayer.loadClip(nextClipIndex).then(() => {
                            console.log('   Loaded clip', nextClipIndex, '- resuming playback');
                            return this.videoPlayer.play();
                        }).catch(err => {
                            console.error('   Failed to load next clip:', err);
                        });

                        // Reset counter and wait for new clip
                        stallFrameCount = 0;
                        skipFramesAfterClipChange = 90;
                    }
                } else if (!allVideosEnded) {
                    // Videos still playing - reset stall counter
                    stallFrameCount = 0;
                }

                // Detect stall during recording (time not advancing despite videos not ended)
                if (recordingStartLogged && !allVideosEnded && skipFramesAfterClipChange === 0) {
                    if (lastAbsoluteTime >= 0 && Math.abs(absoluteTime - lastAbsoluteTime) < 0.01) {
                        recordingStallCount++;

                        // Log every 30 frames (~1 second)
                        if (recordingStallCount % 30 === 0) {
                            console.warn('Recording stalled for', (recordingStallCount / 30).toFixed(1), 'seconds at ' + this.currentExportSpeed + 'x');
                        }

                        // Gradual speed reduction: first try 2x (with stabilization pause), then 1x
                        if (recordingStallCount === 60 && this.currentExportSpeed > 2) {
                            console.warn('Recording stalled - pausing to stabilize, then trying 2x (was ' + this.currentExportSpeed + 'x)');
                            this.currentExportSpeed = 2;
                            speedReductionAttempts++;
                            this.speedWasReduced = true;
                            dumpExportDiagnostics('Recording stall - pausing for 2x');

                            // Pause, let buffers refill, then resume at 2x
                            this.videoPlayer.pause().then(() => {
                                console.log('Paused for buffer stabilization (1.5s)...');
                                setTimeout(() => {
                                    this.videoPlayer.setPlaybackRate(2);
                                    this.videoPlayer.play().then(() => {
                                        console.log('Resumed playback at 2x');
                                    });
                                }, 1500); // 1.5 second pause to let buffers refill
                            });
                            recordingStallCount = 0; // Reset counter to give 2x a chance
                        } else if (recordingStallCount === 60 && this.currentExportSpeed > 1) {
                            console.warn('Recording stalled at 2x - reducing to 1x speed');
                            this.currentExportSpeed = 1;
                            speedReductionAttempts++;
                            this.speedWasReduced = true;
                            this.videoPlayer.setPlaybackRate(1);
                            dumpExportDiagnostics('Recording stall - speed reduced to 1x');
                        }

                        // If stalled for ~5 seconds (150 frames) at 1x, try seeking forward
                        if (recordingStallCount === 150 && this.currentExportSpeed === 1) {
                            console.warn('Recording still stalled at 1x - attempting recovery seek');
                            const seekTarget = absoluteTime + 0.5;
                            this.videoPlayer.seekToEventTime(seekTarget).catch(e => {
                                console.error('Recovery seek failed:', e);
                            });
                        }

                        // If stalled for ~10 seconds (300 frames) at 1x, alert user
                        if (recordingStallCount >= 300 && this.currentExportSpeed === 1) {
                            console.error('Recording stall timeout - drive may be too slow');
                            console.log('Drive Performance Hint: If this keeps happening, your storage may be too slow.');
                            console.log('Recommended: SSD or NVMe drive, avoid USB 2.0 drives');
                            recordingStallCount = 0; // Reset to prevent repeated alerts
                        }
                    } else {
                        // Time is advancing - reset recording stall counter
                        recordingStallCount = 0;
                    }
                }
                lastAbsoluteTime = absoluteTime;

                // Periodic health check (every 30 seconds)
                const nowTime = performance.now();
                if (nowTime - lastDiagnosticTime > 30000) {
                    const elapsed = absoluteTime - exportStart;
                    const progressPercent = (elapsed / exportDuration) * 100;
                    console.log('Export Health Check - Progress:', progressPercent.toFixed(1) + '% | Frames:', totalFramesRendered);
                    lastDiagnosticTime = nowTime;
                }

                // Calculate progress
                const elapsed = absoluteTime - exportStart;
                const progressPercent = (elapsed / exportDuration) * 100;
                const isLastClip = currentClipIndex >= this.videoPlayer.currentEvent.clipGroups.length - 1;

                // Check export end conditions (but NOT during clip transitions or while loading)
                const anyVideoLoading = Object.values(videos).some(v => v.readyState < 2);
                const waitingForTransition = allVideosEnded && hasMoreClips;

                if (!exportStopped && skipFramesAfterClipChange === 0 && !anyVideoLoading && !waitingForTransition) {

                    // Normal end: reached target time + buffer
                    if (absoluteTime >= exportEnd + 0.6) {
                        console.log('Export complete! Absolute time:', absoluteTime.toFixed(2), '| End time:', exportEnd.toFixed(2), '| Frames:', totalFramesRendered);
                        exportStopped = true;
                        this.stopExport(format);
                        return;
                    }

                    // End condition: on last clip and all videos ended
                    if (isLastClip && allVideosEnded) {
                        console.log('Export complete - All videos ended on last clip');
                        console.log('   Absolute time:', absoluteTime.toFixed(2), '| Target end:', exportEnd.toFixed(2));
                        console.log('   Progress:', progressPercent.toFixed(1), '% | Frames:', totalFramesRendered);
                        exportStopped = true;
                        this.stopExport(format);
                        return;
                    }
                }

                // Update progress UI (throttled)
                const now = Date.now();
                if (this.onProgress && (now - this.lastProgressUpdate > 100)) {
                    this.onProgress(progressPercent, absoluteTime, exportEnd, exportStart);
                    this.lastProgressUpdate = now;
                }

                // Draw videos to canvas (black background first)
                ctx.fillStyle = '#000000';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                // Apply video enhancement filters if available
                const enhancer = window.app?.videoEnhancer;
                if (enhancer && enhancer.settings) {
                    const { brightness, contrast, saturation } = enhancer.settings;
                    // Only apply if not all defaults
                    if (brightness !== 100 || contrast !== 100 || saturation !== 100) {
                        ctx.filter = `brightness(${brightness / 100}) contrast(${contrast / 100}) saturate(${saturation / 100})`;
                    }
                }

                // Draw videos according to layout configuration, sorted by z-index
                const sortedCameras = Object.entries(layoutConfig.cameras)
                    .filter(([name, cam]) => cam.visible && cam.w > 0 && cam.h > 0)
                    .sort((a, b) => (a[1].zIndex || 1) - (b[1].zIndex || 1));

                for (const [camName, camConfig] of sortedCameras) {
                    // Use mapping to get correct video for this position (handles drag/drop swaps)
                    const videoSource = cameraMapping[camName] || camName;
                    const video = videos[videoSource];

                    if (video && !video.ended && video.readyState >= 2) {
                        // Use pre-cached crop and destination rectangles (performance optimization)
                        const cached = cachedCropValues[camName];
                        const dest = cachedDestRects[camName];

                        if (cached && dest) {
                            // Draw with pre-cached crop and object-fit values
                            ctx.drawImage(video, cached.sx, cached.sy, cached.sw, cached.sh, dest.dx, dest.dy, dest.dw, dest.dh);
                        } else {
                            // Fallback: draw without crop/fit if cache miss
                            ctx.drawImage(video, camConfig.x, camConfig.y, camConfig.w, camConfig.h);
                        }
                    } else {
                        // Draw "No Signal" placeholder for missing/ended cameras
                        ctx.fillStyle = '#1a1a1a';
                        ctx.fillRect(camConfig.x, camConfig.y, camConfig.w, camConfig.h);
                        ctx.fillStyle = '#666666';
                        ctx.font = 'bold 24px Arial';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText('No Signal', camConfig.x + camConfig.w / 2, camConfig.y + camConfig.h / 2);
                    }
                }

                // Reset filter for overlays and labels
                ctx.filter = 'none';

                // Add watermarks for free tier users
                if (this._shouldWatermark) {
                    this.addWatermarksToFrame(ctx, layoutConfig);
                }

                // Apply license plate blurring if enabled - use multi-camera method for proper coordinate mapping
                const blurPlatesEnabled = window.app?.settingsManager?.get('blurLicensePlates') === true;
                if (blurPlatesEnabled && window.app?.plateBlur?.isReady()) {
                    try {
                        // Build camera info for multi-camera processing
                        const cameraInfos = {};
                        for (const [camName, camConfig] of sortedCameras) {
                            const videoSource = cameraMapping[camName] || camName;
                            const video = videos[videoSource];
                            if (video && video.src && video.readyState >= 2) {
                                const cached = cachedCropValues[camName];
                                const dest = cachedDestRects[camName];
                                cameraInfos[videoSource] = {
                                    video: video,
                                    dx: dest?.dx ?? camConfig.x,
                                    dy: dest?.dy ?? camConfig.y,
                                    dw: dest?.dw ?? camConfig.w,
                                    dh: dest?.dh ?? camConfig.h,
                                    crop: camConfig.crop || { top: 0, right: 0, bottom: 0, left: 0 },
                                    objectFit: camConfig.objectFit || 'contain'
                                };
                            }
                        }
                        // Don't await - run async to avoid blocking frame rendering
                        window.app.plateBlur.processMultiCamera(ctx, cameraInfos, {
                            forceDetection: totalFramesRendered % 5 === 0 // Less frequent for real-time
                        });
                    } catch (blurError) {
                        // Silently handle errors in real-time mode
                    }
                }

                // Check privacy mode setting
                const settings = window.app?.settingsManager;
                const privacyMode = settings && settings.get('privacyModeExport') === true;

                // Calculate scale factor for label overlays (1920px reference)
                const labelScale = canvas.width / 1920;
                // Base font size 18px to match live view proportions
                const scaledFontSize = Math.round(18 * labelScale);

                // Calculate mini-map rect for label occlusion avoidance (if mini-map will be drawn)
                let miniMapRect = null;
                const miniMapInExport = !settings || settings.get('miniMapInExport') !== false;
                if (!privacyMode && window.app?.miniMapOverlay && miniMapInExport) {
                    const pos = window.app.miniMapOverlay.position || { x: 80, y: 10 };
                    const mapWidth = Math.round(200 * labelScale);
                    const mapHeight = Math.round(200 * labelScale);
                    miniMapRect = {
                        x: (pos.x / 100) * canvas.width,
                        y: (pos.y / 100) * canvas.height,
                        w: mapWidth,
                        h: mapHeight
                    };
                }

                // Add camera labels using centralized smart positioning (matches live view)
                if (this.layoutManager?.renderer) {
                    this.layoutManager.renderer.addLabelsToCanvas(ctx, layoutConfig, {
                        fontSize: scaledFontSize,
                        cameraMapping: cameraMapping,
                        videos: videos,
                        miniMapRect: miniMapRect
                    });
                } else {
                    // Fallback if no renderer
                    this.addCameraLabelsForLayout(ctx, layoutConfig, cameraMapping);
                }

                // Add overlay if requested (skipped in privacy mode)
                if (includeOverlay && !privacyMode) {
                    this.addOverlay(ctx, canvas.width, canvas.height, absoluteTime);
                }

                // Add telemetry overlay using video player's actual state (skipped in privacy mode)
                const telemetryEnabled = !settings || settings.get('telemetryOverlayInExport') !== false;
                if (!privacyMode && window.app?.telemetryOverlay && telemetryEnabled && window.app.telemetryOverlay.hasTelemetryData()) {
                    const clipIndex = this.videoPlayer.currentClipIndex || 0;
                    const timeInClip = this.videoPlayer.getCurrentTime() || 0;
                    const videoDuration = this.videoPlayer.getCurrentDuration() || 60;
                    window.app.telemetryOverlay.updateTelemetry(clipIndex, timeInClip, videoDuration);
                    const telemetryData = window.app.telemetryOverlay.getCurrentTelemetry();
                    if (telemetryData) {
                        const blinkState = Math.floor(absoluteTime * 2) % 2 === 0; // 1 second blink cycle
                        // HUD scale uses smaller reference (1000px) to appear larger/closer to live view
                        const hudScale = canvas.width / 1000;
                        window.app.telemetryOverlay.renderToCanvas(ctx, canvas.width, canvas.height, telemetryData, {
                            blinkState,
                            scale: hudScale
                        });

                        // Add mini-map overlay if export setting is enabled (skipped in privacy mode)
                        if (window.app?.miniMapOverlay && miniMapInExport && telemetryData.latitude_deg && telemetryData.longitude_deg) {
                            window.app.miniMapOverlay.updatePositionForExport(
                                telemetryData.latitude_deg,
                                telemetryData.longitude_deg,
                                telemetryData.heading_deg || 0
                            );
                            window.app.miniMapOverlay.drawToCanvas(ctx, canvas.width, canvas.height);
                        }
                    }
                }

                // No need to schedule next frame - setInterval handles it
            };

            // Set playback speed for export
            if (this.exportSpeed && this.exportSpeed !== 1) {
                console.log('Setting export playback speed to', this.exportSpeed + 'x');
                this.videoPlayer.setPlaybackRate(this.exportSpeed);
            }

            // Start playback
            console.log('Starting video playback for export...');
            console.log('IMPORTANT: Keep this browser tab focused during export for best quality');
            await this.videoPlayer.play();

            // Start recording IMMEDIATELY after playback starts
            console.log('Starting MediaRecorder immediately...');
            this.mediaRecorder.start();

            // Small delay to let MediaRecorder initialize
            await new Promise(resolve => setTimeout(resolve, 50));

            // Start render loop with setInterval for consistent 30fps timing
            // Using 33.33ms interval (1000ms / 30fps = 33.33ms per frame)
            console.log('Starting render loop (setInterval @ 30fps / 33.33ms)...');
            this.renderIntervalId = setInterval(renderFrame, 1000 / 30);

        } catch (error) {
            this.isExporting = false;
            console.error('Export error:', error);
            throw error;
        }
    }

    /**
     * Stop export and download video
     * @param {string} format
     */
    async stopExport(format) {
        if (!this.mediaRecorder) return;

        console.log('stopExport called, state:', this.mediaRecorder.state);
        this.isExporting = false;

        // Stop render interval
        if (this.renderIntervalId) {
            clearInterval(this.renderIntervalId);
            this.renderIntervalId = null;
        }

        return new Promise((resolve, reject) => {
            // Set up onstop handler BEFORE calling stop()
            this.mediaRecorder.onstop = async () => {
                console.log('MediaRecorder onstop fired');
                console.log('Number of chunks collected:', this.recordedChunks.length);

                // Pause playback and reset speed
                await this.videoPlayer.pause();
                if (this.exportSpeed && this.exportSpeed !== 1) {
                    console.log('Resetting playback speed to 1x after export');
                    this.videoPlayer.setPlaybackRate(1);
                }

                // Stop all tracks on the stream to properly close it
                const tracks = this.mediaRecorder.stream.getTracks();
                console.log('Stopping', tracks.length, 'stream tracks');
                tracks.forEach(track => track.stop());

                // Create blob from recorded chunks
                const mimeType = format === 'mp4' ? 'video/mp4' : 'video/webm';
                const blob = new Blob(this.recordedChunks, {
                    type: this.getSupportedMimeType(mimeType)
                });

                console.log('Blob created, size:', blob.size, 'bytes, type:', blob.type);

                // Generate filename (include speed if not 1x)
                const timestamp = this.getFormattedTimestamp();
                const extension = format === 'mp4' ? 'mp4' : 'webm';
                const speedSuffix = this.exportSpeed && this.exportSpeed !== 1 ? `_${this.exportSpeed}x` : '';
                const filename = `TeslaCam_Export_${timestamp}${speedSuffix}.${extension}`;

                // Trigger download
                this.downloadBlob(blob, filename);

                // Record export for session tracking
                const sessionManager = window.app?.sessionManager;
                if (sessionManager) {
                    const event = this.videoPlayer.currentEvent;
                    const eventId = event?.compoundKey || event?.name || 'unknown';
                    sessionManager.recordEventExport(eventId);
                }

                // Cleanup
                this.recordedChunks = [];
                this.mediaRecorder = null;
                this.cachedTotalDuration = null;

                // Clear telemetry export buffer
                if (window.app?.telemetryOverlay) {
                    window.app.telemetryOverlay.clearExportBuffer();
                }

                // Resolve the promise to signal completion
                if (this.exportResolve) {
                    this.exportResolve();
                }
                resolve();
            };

            // Stop recording - since we're not using timeslice, stop() will trigger final data collection
            if (this.mediaRecorder.state === 'recording') {
                console.log('Stopping MediaRecorder (will trigger final data collection)...');
                this.mediaRecorder.stop();
            } else {
                console.log('MediaRecorder not in recording state:', this.mediaRecorder.state);
                this.mediaRecorder.stop();
            }
        });
    }

    /**
     * Export single camera view
     * @param {string} camera - Camera name (front, back, left_repeater, right_repeater, left_pillar, right_pillar)
     * @param {Object} options - Export options
     */
    async exportSingle(camera, options = {}) {
        const {
            format = 'webm',
            startTime = null,
            endTime = null,
            includeOverlay = true,
            onProgress = null,
            speed = 1
        } = options;

        this.onProgress = onProgress;
        this.exportStartTime = Date.now();
        this.exportSpeed = speed;

        console.log('VideoExport.exportSingle called', { camera, format, startTime, endTime, speed });

        if (this.isExporting) {
            throw new Error('Export already in progress');
        }

        const video = this.videoPlayer.videos[camera];
        if (!video || !video.src) {
            throw new Error(`No video loaded for ${camera}`);
        }

        return new Promise(async (resolve, reject) => {
            this.exportResolve = resolve;
            this.exportReject = reject;

            try {
                await this.startSingleExport(camera, format, startTime, endTime, includeOverlay);
            } catch (error) {
                this.isExporting = false;
                reject(error);
            }
        });
    }

    /**
     * Internal method to start single camera export
     */
    async startSingleExport(camera, format, startTime, endTime, includeOverlay) {
        const video = this.videoPlayer.videos[camera];

        this.isExporting = true;
        this.recordedChunks = [];
        this.cachedTotalDuration = await this.videoPlayer.getTotalDuration();

        // Cache clip durations
        this.cachedClipDurations = [];
        const event = this.videoPlayer.currentEvent;
        for (let i = 0; i < event.clipGroups.length; i++) {
            const clipGroup = event.clipGroups[i];
            const clip = clipGroup.clips[camera] || clipGroup.clips.front;
            if (clip && clip.fileHandle) {
                try {
                    const file = await clip.fileHandle.getFile();
                    const tempVideo = document.createElement('video');
                    const url = URL.createObjectURL(file);
                    tempVideo.src = url;
                    const duration = await new Promise((resolve) => {
                        tempVideo.onloadedmetadata = () => resolve(tempVideo.duration || 60);
                    });
                    tempVideo.src = '';
                    URL.revokeObjectURL(url);
                    this.cachedClipDurations[i] = duration;
                } catch {
                    this.cachedClipDurations[i] = 60;
                }
            } else {
                this.cachedClipDurations[i] = 60;
            }
        }

        // Create canvas for single camera (native resolution)
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        // Determine export duration
        const exportStart = startTime !== null ? startTime : 0;
        const exportEnd = endTime !== null ? endTime : this.cachedTotalDuration;
        const exportDuration = exportEnd - exportStart;

        console.log('Single export range:', exportStart.toFixed(2), '->', exportEnd.toFixed(2));

        // Note: Telemetry is rendered on-demand using video player's actual state
        // This ensures telemetry matches exactly what the user sees during preview

        // Seek to start
        const wasPlaying = this.videoPlayer.getIsPlaying();
        if (wasPlaying) await this.videoPlayer.pause();

        const prerollTime = 1.0;
        const seekTarget = Math.max(0, exportStart - prerollTime);
        await this.videoPlayer.seekToEventTime(seekTarget);
        await new Promise(resolve => setTimeout(resolve, 500));

        // Setup MediaRecorder
        const mimeType = format === 'mp4' ? 'video/mp4' : 'video/webm';
        const stream = canvas.captureStream(30);
        const supportedMimeType = this.getSupportedMimeType(mimeType);

        this.mediaRecorder = new MediaRecorder(stream, {
            mimeType: supportedMimeType,
            videoBitsPerSecond: 8000000 // 8 Mbps for single camera (higher quality)
        });

        this.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                this.recordedChunks.push(event.data);
            }
        };

        let lastClipIndex = this.videoPlayer.currentClipIndex;
        let exportStopped = false;
        let skipFramesAfterClipChange = 0; // Wait for clip to load after transition
        let stallFrameCount = 0; // Track stalled video (ended)
        let lastAbsoluteTime = 0;

        // Render loop for single camera (with clip transition handling)
        // Uses setInterval for consistent 30fps timing
        const renderFrame = () => {
            if (!this.isExporting || exportStopped) {
                if (this.renderIntervalId) {
                    clearInterval(this.renderIntervalId);
                    this.renderIntervalId = null;
                }
                return;
            }

            const currentClipIndex = this.videoPlayer.currentClipIndex;
            const currentVideo = this.videoPlayer.videos[camera];
            const currentTimeInClip = this.videoPlayer.getCurrentTime();

            // Detect clip change
            if (currentClipIndex !== lastClipIndex) {
                console.log('Single export clip transition:', lastClipIndex, '->', currentClipIndex);
                lastClipIndex = currentClipIndex;
                skipFramesAfterClipChange = 90; // Wait ~3 seconds for new clip to load
            }

            // Wait for clip to be ready after transition
            if (skipFramesAfterClipChange > 0) {
                skipFramesAfterClipChange--;

                if (currentVideo.readyState < 2) {
                    // Still waiting - render black frame
                    if (skipFramesAfterClipChange % 15 === 0) {
                        console.log('   Single export waiting for clip... frames left:', skipFramesAfterClipChange, '| readyState:', currentVideo.readyState);
                    }
                    ctx.fillStyle = '#000000';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    return; // setInterval will call again
                } else if (skipFramesAfterClipChange > 60) {
                    // Video ready early, reduce wait
                    skipFramesAfterClipChange = 15;
                }
            }

            // Skip if video not ready
            if (isNaN(currentTimeInClip) || currentTimeInClip < 0 || currentVideo.readyState < 2) {
                return; // setInterval will call again
            }

            // Calculate absolute time
            let absoluteTime = 0;
            for (let i = 0; i < currentClipIndex; i++) {
                absoluteTime += this.cachedClipDurations[i] || 60;
            }
            absoluteTime += currentTimeInClip;

            // Check if video ended and needs clip transition
            const hasMoreClips = currentClipIndex < event.clipGroups.length - 1;
            if (currentVideo.ended && hasMoreClips) {
                stallFrameCount++;

                // After 15 frames with video ended, trigger clip transition
                if (stallFrameCount === 15) {
                    console.log('Single export: Video ended - transitioning to next clip');
                    const nextClipIndex = currentClipIndex + 1;
                    this.videoPlayer.loadClip(nextClipIndex).then(() => {
                        console.log('   Loaded clip', nextClipIndex, '- resuming playback');
                        return this.videoPlayer.play();
                    }).catch(err => {
                        console.error('   Failed to load next clip:', err);
                    });
                    stallFrameCount = 0;
                    skipFramesAfterClipChange = 90;
                }

                // Render black frame while waiting
                ctx.fillStyle = '#000000';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                return; // setInterval will call again
            } else if (!currentVideo.ended) {
                stallFrameCount = 0;
            }
            lastAbsoluteTime = absoluteTime;

            // Wait for preroll to finish
            if (absoluteTime < exportStart) {
                ctx.fillStyle = '#000000';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                return; // setInterval will call again
            }

            // Start recorder at IN marker
            if (this.mediaRecorder.state === 'inactive') {
                console.log('Starting single camera recording at', absoluteTime.toFixed(2));
                this.mediaRecorder.start();
            }

            // Check if export complete (with buffer and not during transitions)
            const isLastClip = currentClipIndex >= event.clipGroups.length - 1;
            if (skipFramesAfterClipChange === 0 && currentVideo.readyState >= 2) {
                if (absoluteTime >= exportEnd + 0.6) {
                    console.log('Single export complete! Time:', absoluteTime.toFixed(2));
                    exportStopped = true;
                    this.stopSingleExport(camera);
                    return;
                }
                if (isLastClip && currentVideo.ended) {
                    console.log('Single export complete - last clip ended');
                    exportStopped = true;
                    this.stopSingleExport(camera);
                    return;
                }
            }

            // Render frame (black background first to handle any gaps)
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            if (!currentVideo.ended && currentVideo.readyState >= 2) {
                ctx.drawImage(currentVideo, 0, 0, canvas.width, canvas.height);
            } else if (currentVideo.ended || !currentVideo.src) {
                // Draw "No Signal" placeholder for missing/ended camera
                ctx.fillStyle = '#1a1a1a';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = '#666666';
                ctx.font = 'bold 36px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('No Signal', canvas.width / 2, canvas.height / 2);
            }

            // Add watermark for free tier users (single camera)
            if (this._shouldWatermark) {
                this.drawWatermarkOnRegion(ctx, 0, 0, canvas.width, canvas.height, 'TeslaCamViewer.com - Unlicensed');
            }

            // Apply license plate blurring if enabled (single camera - use multi-camera for proper coords)
            const blurPlatesEnabled = window.app?.settingsManager?.get('blurLicensePlates') === true;
            if (blurPlatesEnabled && window.app?.plateBlur?.isReady() && currentVideo.readyState >= 2) {
                try {
                    const cameraInfos = {
                        [camera]: {
                            video: currentVideo,
                            dx: 0,
                            dy: 0,
                            dw: canvas.width,
                            dh: canvas.height,
                            crop: { top: 0, right: 0, bottom: 0, left: 0 }
                        }
                    };
                    window.app.plateBlur.processMultiCamera(ctx, cameraInfos, {
                        forceDetection: true // Always detect for single camera (full resolution)
                    });
                } catch (blurError) {
                    // Silently handle errors
                }
            }

            // Add overlay if enabled
            if (includeOverlay) {
                this.addSingleCameraOverlay(ctx, canvas.width, canvas.height, camera, absoluteTime);
            }

            // Add telemetry overlay using video player's actual state
            const settings = window.app?.settingsManager;
            const telemetryEnabled = !settings || settings.get('telemetryOverlayInExport') !== false;
            if (window.app?.telemetryOverlay && telemetryEnabled && window.app.telemetryOverlay.hasTelemetryData()) {
                const clipIndex = this.videoPlayer.currentClipIndex || 0;
                const timeInClip = this.videoPlayer.getCurrentTime() || 0;
                const videoDuration = this.videoPlayer.getCurrentDuration() || 60;
                window.app.telemetryOverlay.updateTelemetry(clipIndex, timeInClip, videoDuration);
                const telemetryData = window.app.telemetryOverlay.getCurrentTelemetry();
                if (telemetryData) {
                    const blinkState = Math.floor(absoluteTime * 2) % 2 === 0; // 1 second blink cycle
                    window.app.telemetryOverlay.renderToCanvas(ctx, canvas.width, canvas.height, telemetryData, { blinkState });

                    // Add mini-map overlay if export setting is enabled
                    const miniMapInExport = !settings || settings.get('miniMapInExport') !== false;
                    if (window.app?.miniMapOverlay && miniMapInExport && telemetryData.latitude_deg && telemetryData.longitude_deg) {
                        window.app.miniMapOverlay.updatePositionForExport(
                            telemetryData.latitude_deg,
                            telemetryData.longitude_deg,
                            telemetryData.heading_deg || 0
                        );
                        window.app.miniMapOverlay.drawToCanvas(ctx, canvas.width, canvas.height);
                    }
                }
            }

            // Progress callback - match grid export signature (percent, currentTime, endTime, startTime)
            if (this.onProgress) {
                const elapsed = absoluteTime - exportStart;
                const percent = Math.min(100, (elapsed / exportDuration) * 100);
                this.onProgress(percent, absoluteTime, exportEnd, exportStart);
            }

            // No need to schedule next frame - setInterval handles it
        };

        // Set playback speed for export
        if (this.exportSpeed && this.exportSpeed !== 1) {
            console.log('Setting single export playback speed to', this.exportSpeed + 'x');
            this.videoPlayer.setPlaybackRate(this.exportSpeed);
        }

        // Start playback
        console.log('Starting single camera playback for export...');
        await this.videoPlayer.play();
        // Start render loop with setInterval for consistent 30fps timing
        this.renderIntervalId = setInterval(renderFrame, 1000 / 30);
    }

    /**
     * Add overlay for single camera export (matches grid layout overlay format)
     */
    addSingleCameraOverlay(ctx, width, height, camera, absoluteTime) {
        const event = this.videoPlayer.currentEvent;
        if (!event) return;

        const clipIndex = this.videoPlayer.currentClipIndex;
        const clipGroup = event.clipGroups[clipIndex];
        if (!clipGroup) return;

        // Get timestamp from current clip filename
        const clip = clipGroup.clips[camera] || clipGroup.clips.front;
        if (!clip) return;

        const filename = clip.name || clip.fileHandle?.name;
        if (!filename) return;

        // Parse filename: YYYY-MM-DD_HH-MM-SS-camera.mp4
        const timestampMatch = filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
        let timestampStr = '';

        if (timestampMatch) {
            const [, year, month, day, hour, minute, second] = timestampMatch;
            const clipStartTime = new Date(
                parseInt(year),
                parseInt(month) - 1,
                parseInt(day),
                parseInt(hour),
                parseInt(minute),
                parseInt(second)
            );

            // Add current time within clip
            const currentTimeInClip = this.videoPlayer.getCurrentTime();
            const actualTimestamp = new Date(clipStartTime.getTime() + (currentTimeInClip * 1000));

            // Format date and timestamp with frame number
            const dateStr = actualTimestamp.toLocaleDateString();
            let hours = actualTimestamp.getHours();
            const ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12 || 12; // Convert to 12-hour format
            const hoursStr = hours.toString().padStart(2, '0');
            const minutes = actualTimestamp.getMinutes().toString().padStart(2, '0');
            const seconds = actualTimestamp.getSeconds().toString().padStart(2, '0');
            const frameNumber = Math.floor((currentTimeInClip % 1) * 30).toString().padStart(2, '0'); // 30 fps
            timestampStr = `${dateStr} ${hoursStr}:${minutes}:${seconds}.${frameNumber} ${ampm}`;
        }

        // Check if past sentry marker (1:00 from end)
        const totalDuration = this.cachedTotalDuration;
        const sentryMarkerTime = totalDuration - 60;
        const isSentryEvent = event.type && (event.type === 'Sentry' || event.type.includes('Sentry'));
        const isPastMarker = absoluteTime >= sentryMarkerTime;
        const isSentry = isSentryEvent && isPastMarker;

        // Camera label map
        const labelMap = {
            front: 'FRONT',
            back: 'REAR',
            left_repeater: 'LEFT',
            right_repeater: 'RIGHT'
        };

        ctx.save();

        // Bottom bar (matches grid layout overlay)
        const barHeight = 40;
        const y = height - barHeight;

        // Background bar
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(0, y, width, barHeight);

        // Red "Sentry" indicator in lower left (only when past marker)
        if (isSentry) {
            ctx.font = 'bold 18px Arial';
            ctx.fillStyle = '#ff0000';
            ctx.textAlign = 'left';
            ctx.fillText('Sentry', 10, y + 25);
        }

        // Camera label (left of center)
        ctx.font = 'bold 14px Arial';
        ctx.fillStyle = '#00d4ff';
        ctx.textAlign = 'left';
        const labelText = labelMap[camera] || camera.toUpperCase();
        ctx.fillText(labelText, isSentry ? 70 : 10, y + 25);

        // TeslaCamViewer.com branding (centered) - only if enabled
        if (this.shouldShowBranding()) {
            ctx.font = 'bold 16px Arial';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.fillText('TeslaCamViewer.com', width / 2, y + 25);
        }

        // Timestamp (right)
        if (timestampStr) {
            ctx.font = 'bold 16px Arial';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'right';
            ctx.fillText(timestampStr, width - 10, y + 25);
        }

        ctx.restore();
    }

    /**
     * Stop single camera export and finalize
     */
    async stopSingleExport(camera) {
        if (!this.isExporting) return;

        console.log('Stopping single camera export...');

        await this.videoPlayer.pause();

        // Reset playback speed if it was changed
        if (this.exportSpeed && this.exportSpeed !== 1) {
            console.log('Resetting playback speed to 1x after single export');
            this.videoPlayer.setPlaybackRate(1);
        }

        // Stop render interval
        if (this.renderIntervalId) {
            clearInterval(this.renderIntervalId);
            this.renderIntervalId = null;
        }

        this.mediaRecorder.onstop = () => {
            console.log('Single export MediaRecorder stopped, chunks:', this.recordedChunks.length);

            const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder.mimeType });
            console.log('Single export blob size:', blob.size, 'bytes');

            // Generate filename (include speed if not 1x)
            const labelMap = { front: 'front', back: 'rear', left_repeater: 'left', right_repeater: 'right', left_pillar: 'left-pillar', right_pillar: 'right-pillar' };
            const cameraLabel = labelMap[camera] || camera;
            const eventDate = this.videoPlayer.currentEvent?.timestamp || new Date().toISOString();
            const dateStr = eventDate.replace(/[:.]/g, '-').slice(0, 19);
            const speedSuffix = this.exportSpeed && this.exportSpeed !== 1 ? `_${this.exportSpeed}x` : '';
            const filename = `TeslaCam_${cameraLabel}_${dateStr}${speedSuffix}.webm`;

            // Download
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            this.isExporting = false;
            this.recordedChunks = [];

            // Clear telemetry export buffer
            if (window.app?.telemetryOverlay) {
                window.app.telemetryOverlay.clearExportBuffer();
            }

            if (this.exportResolve) {
                this.exportResolve();
            }
        };

        this.mediaRecorder.stop();
    }

    /**
     * Get supported MIME type for recording
     * @param {string} preferredType
     * @returns {string}
     */
    getSupportedMimeType(preferredType) {
        const types = [
            preferredType,
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm',
            'video/mp4'
        ];

        for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }

        return 'video/webm'; // Fallback
    }

    /**
     * Add camera labels to frame
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} videoWidth
     * @param {number} videoHeight
     */
    addCameraLabels(ctx, videoWidth, videoHeight) {
        const videos = this.videoPlayer.videos;
        const positions = {
            'Front': { x: 10, y: 30, video: videos.front },
            'Back': { x: videoWidth + 10, y: 30, video: videos.back },
            'Left': { x: 10, y: videoHeight + 30, video: videos.left_repeater },
            'Right': { x: videoWidth + 10, y: videoHeight + 30, video: videos.right_repeater }
        };

        for (const [label, pos] of Object.entries(positions)) {
            // Background - dark red if video ended, black otherwise
            const isEnded = pos.video && pos.video.ended;
            ctx.fillStyle = isEnded ? 'rgba(139, 0, 0, 0.85)' : 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(pos.x - 5, pos.y - 20, label.length * 12, 28);

            // Text
            ctx.font = 'bold 18px Arial';
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, pos.x, pos.y);
        }
    }

    /**
     * Add camera labels based on layout configuration
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} layoutConfig - Layout configuration from getLayoutConfig()
     */
    addCameraLabelsForLayout(ctx, layoutConfig, cameraMapping = null) {
        const videos = this.videoPlayer.videos;
        // Use uppercase to match live view CSS styling (text-transform: uppercase)
        const labelMap = {
            front: 'FRONT',
            back: 'BACK',
            left_repeater: 'LEFT',
            right_repeater: 'RIGHT',
            left_pillar: 'LEFT PILLAR',
            right_pillar: 'RIGHT PILLAR'
        };

        // Sort cameras by z-index to process in order
        // Filter out cameras without video sources (e.g., pillar cams on events without them)
        const sortedCameras = Object.entries(layoutConfig.cameras)
            .filter(([name, cam]) => {
                if (!cam.visible || cam.w <= 0 || cam.h <= 0) return false;
                // Check if this camera actually has a video source
                const actualCamera = cameraMapping ? (cameraMapping[name] || name) : name;
                const video = videos[actualCamera];
                return video && video.src;
            })
            .sort((a, b) => (a[1].zIndex || 1) - (b[1].zIndex || 1));

        // Get cameras with higher z-index for occlusion checking
        const camerasByZIndex = sortedCameras.map(([name, cam]) => ({
            name,
            x: cam.x,
            y: cam.y,
            w: cam.w,
            h: cam.h,
            zIndex: cam.zIndex || 1
        }));

        for (const [camName, camConfig] of sortedCameras) {
            // Use mapping to get the actual camera shown in this position
            const actualCamera = cameraMapping ? (cameraMapping[camName] || camName) : camName;
            const label = labelMap[actualCamera];
            const video = videos[actualCamera];
            const isEnded = video && video.ended;
            const myZIndex = camConfig.zIndex || 1;

            // Calculate label dimensions
            ctx.font = 'bold 18px Arial';
            const labelWidth = label.length * 12 + 10;
            const labelHeight = 28;
            const padding = 10;

            // Get canvas dimensions for bounds clamping
            const canvasWidth = ctx.canvas.width;
            const canvasHeight = ctx.canvas.height;

            // Calculate the VISIBLE portion of this camera (clamped to canvas bounds)
            // This handles cameras that extend beyond canvas edges
            const visibleX = Math.max(0, camConfig.x);
            const visibleY = Math.max(0, camConfig.y);
            const visibleRight = Math.min(canvasWidth, camConfig.x + camConfig.w);
            const visibleBottom = Math.min(canvasHeight, camConfig.y + camConfig.h);
            const visibleW = visibleRight - visibleX;
            const visibleH = visibleBottom - visibleY;

            // Skip if camera has no visible area
            if (visibleW <= 0 || visibleH <= 0) continue;

            // Try positions: top-left, top-right, bottom-left, bottom-right
            // Use VISIBLE bounds, not camera config bounds
            const positions = [
                { x: visibleX + padding, y: visibleY + labelHeight + 5, name: 'top-left' },
                { x: visibleRight - labelWidth - padding, y: visibleY + labelHeight + 5, name: 'top-right' },
                { x: visibleX + padding, y: visibleBottom - 10, name: 'bottom-left' },
                { x: visibleRight - labelWidth - padding, y: visibleBottom - 10, name: 'bottom-right' }
            ];

            // Find first position not occluded by higher z-index cameras
            let bestPos = positions[0];
            for (const pos of positions) {
                const labelRect = {
                    x: pos.x - 5,
                    y: pos.y - 22,
                    w: labelWidth,
                    h: labelHeight
                };

                // Check if this position is covered by a higher z-index camera
                let isOccluded = false;
                for (const cam of camerasByZIndex) {
                    if (cam.name === camName) continue;
                    if ((cam.zIndex || 1) <= myZIndex) continue;

                    // Check rectangle overlap
                    if (labelRect.x < cam.x + cam.w &&
                        labelRect.x + labelRect.w > cam.x &&
                        labelRect.y < cam.y + cam.h &&
                        labelRect.y + labelRect.h > cam.y) {
                        isOccluded = true;
                        break;
                    }
                }

                if (!isOccluded) {
                    bestPos = pos;
                    break;
                }
            }

            const x = bestPos.x;
            const y = bestPos.y;

            // Background - dark red if video ended, black otherwise
            ctx.fillStyle = isEnded ? 'rgba(139, 0, 0, 0.85)' : 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(x - 5, y - 22, labelWidth, labelHeight);

            // Text
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, x, y);
        }
    }

    /**
     * Add overlay to frame
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} width
     * @param {number} height
     * @param {number} absoluteTime Absolute time in event (seconds from start)
     */
    addOverlay(ctx, width, height, absoluteTime) {
        const event = this.videoPlayer.currentEvent;
        if (!event) return;

        const clipIndex = this.videoPlayer.currentClipIndex;
        const clipGroup = event.clipGroups[clipIndex];
        if (!clipGroup) return;

        // Cache clip start time to avoid re-parsing every frame (performance optimization)
        if (!this.cachedOverlayData || this.cachedOverlayData.clipIndex !== clipIndex) {
            // Get timestamp from current clip filename
            const frontClip = clipGroup.clips.front;
            if (!frontClip) return;

            const filename = frontClip.name || frontClip.fileHandle?.name;
            if (!filename) return;

            const timestampMatch = filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
            if (!timestampMatch) return;

            const [, year, month, day, hour, minute, second] = timestampMatch;
            const clipStartTime = new Date(
                parseInt(year),
                parseInt(month) - 1,
                parseInt(day),
                parseInt(hour),
                parseInt(minute),
                parseInt(second)
            );

            // Cache sentry-related checks (don't change during export)
            const totalDuration = this.cachedTotalDuration;
            const sentryMarkerTime = totalDuration - 60;
            const isSentryEvent = event.type && (event.type === 'Sentry' || event.type.includes('Sentry'));

            this.cachedOverlayData = {
                clipIndex,
                clipStartTime,
                sentryMarkerTime,
                isSentryEvent
            };
        }

        const { clipStartTime, sentryMarkerTime, isSentryEvent } = this.cachedOverlayData;

        // Add current time within clip
        const currentTimeInClip = this.videoPlayer.getCurrentTime();
        const actualTimestamp = new Date(clipStartTime.getTime() + (currentTimeInClip * 1000));

        // Format date and timestamp with frame number
        const dateStr = actualTimestamp.toLocaleDateString();
        let hours = actualTimestamp.getHours();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12; // Convert to 12-hour format
        const hoursStr = hours.toString().padStart(2, '0');
        const minutes = actualTimestamp.getMinutes().toString().padStart(2, '0');
        const seconds = actualTimestamp.getSeconds().toString().padStart(2, '0');
        const frameNumber = Math.floor((currentTimeInClip % 1) * 30).toString().padStart(2, '0'); // 30 fps
        const timestampStr = `${dateStr} ${hoursStr}:${minutes}:${seconds}.${frameNumber} ${ampm}`;

        // Check if past sentry marker (uses cached values for performance)
        const isPastMarker = absoluteTime >= sentryMarkerTime;
        const isSentry = isSentryEvent && isPastMarker;

        // Log every 60 frames (~2 seconds at 30fps) to debug sentry indicator
        if (!this.overlayLogCounter) this.overlayLogCounter = 0;
        this.overlayLogCounter++;

        if (this.overlayLogCounter % 60 === 1) {
            console.log('[EXPORT OVERLAY] Time:', absoluteTime.toFixed(2), '| Marker:', sentryMarkerTime.toFixed(2), '| Past?', isPastMarker, '| Showing:', isSentry ? 'YES - RED SENTRY' : 'no');
        }

        const barHeight = 40;
        const y = height - barHeight;

        // Background bar
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(0, y, width, barHeight);

        // Red "Sentry" indicator in lower left (only when past marker)
        if (isSentry) {
            ctx.font = 'bold 18px Arial';
            ctx.fillStyle = '#ff0000';
            ctx.textAlign = 'left';
            ctx.fillText('Sentry', 10, y + 25);
        }

        // TeslaCamViewer.com branding (centered) - only if enabled
        if (this.shouldShowBranding()) {
            ctx.font = 'bold 16px Arial';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.fillText('TeslaCamViewer.com', width / 2, y + 25);
        }

        // Timestamp (right)
        ctx.font = 'bold 16px Arial';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.fillText(timestampStr, width - 10, y + 25);

        ctx.textAlign = 'left';
    }

    /**
     * Format time in MM:SS
     * @param {number} seconds
     * @returns {string}
     */
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Get formatted timestamp for filename
     * @returns {string}
     */
    getFormattedTimestamp() {
        const event = this.videoPlayer.currentEvent;
        if (event && event.timestamp) {
            const eventDate = new Date(event.timestamp);
            return eventDate.toISOString().replace(/[:.]/g, '-').slice(0, -5);
        }

        const now = new Date();
        return now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
    }

    /**
     * Download blob as file
     * @param {Blob} blob
     * @param {string} filename
     */
    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        setTimeout(() => URL.revokeObjectURL(url), 100);
    }

    /**
     * Cancel ongoing export
     */
    cancelExport() {
        if (!this.isExporting) return;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('EXPORT CANCELLED BY USER');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // Mark as not exporting first to stop any loops
        this.isExporting = false;

        // Abort GIF encoder if active
        if (this.gifEncoder) {
            console.log('Aborting GIF encoder...');
            try {
                this.gifEncoder.abort();
            } catch (e) {
                console.log('GIF abort error (may already be finished):', e.message);
            }
            this.gifEncoder = null;
        }

        // Handle video/webm export cancellation
        if (this.mediaRecorder) {
            const videos = this.videoPlayer.videos;
            console.log('Current State at Cancel:');
            console.log('  - MediaRecorder state:', this.mediaRecorder.state);
            console.log('  - Chunks collected:', this.recordedChunks.length);
            console.log('  - Current clip:', this.videoPlayer.currentClipIndex);
            console.log('  - Time in clip:', this.videoPlayer.getCurrentTime().toFixed(2) + 's');

            console.log('\n  Video ready states:');
            Object.entries(videos).forEach(([name, video]) => {
                console.log('    ' + name + ':', video.readyState, '| paused:', video.paused, '| time:', video.currentTime.toFixed(2) + 's');
            });
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            // Stop the render interval
            if (this.renderIntervalId) {
                clearInterval(this.renderIntervalId);
                this.renderIntervalId = null;
                console.log('Render interval stopped');
            }

            // Set up cleanup handler before stopping
            this.mediaRecorder.onstop = () => {
                console.log('Export cancelled, cleaning up...');
                this.recordedChunks = [];
                this.mediaRecorder = null;

                // Reject the promise if it exists
                if (this.exportReject) {
                    this.exportReject(new Error('Export cancelled by user'));
                }
            };

            // Stop the recorder
            if (this.mediaRecorder.state === 'recording') {
                this.mediaRecorder.stop();
            }
        }

        // Stop playback
        this.videoPlayer.pause();

        // Reject export promise if exists
        if (this.exportReject) {
            this.exportReject(new Error('Export cancelled by user'));
        }
    }

    // ==================== Session/Watermark Methods ====================

    /**
     * Check if watermarks should be applied (async, sets flag for render loop)
     */
    async _checkWatermark() {
        const sessionManager = window.app?.sessionManager;
        if (sessionManager) {
            this._shouldWatermark = await sessionManager.shouldWatermark();
            console.log('[VideoExport] _shouldWatermark set to:', this._shouldWatermark);
        } else {
            // No session manager, default to watermark
            this._shouldWatermark = true;
            console.log('[VideoExport] No sessionManager, defaulting _shouldWatermark to true');
        }
    }

    /**
     * Check if branding should be shown in the banner overlay
     * Licensed users can disable branding via settings; free users always see branding
     * @returns {boolean} True if branding should be shown
     */
    shouldShowBranding() {
        const sessionManager = window.app?.sessionManager;
        const isLicensed = sessionManager?.hasValidLicense?.() || false;

        if (!isLicensed) {
            // Free users always see branding
            return true;
        }

        // Licensed users can toggle branding via settings (default: true)
        const settings = window.app?.settingsManager;
        return settings?.get('showBrandingInExport') !== false;
    }

    /**
     * Add watermarks to each camera in the frame
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} layoutConfig
     */
    addWatermarksToFrame(ctx, layoutConfig) {
        const watermarkText = 'TeslaCamViewer.com - Unlicensed';

        if (layoutConfig && layoutConfig.cameras) {
            for (const [cameraName, camConfig] of Object.entries(layoutConfig.cameras)) {
                if (!camConfig.visible || camConfig.w <= 0 || camConfig.h <= 0) continue;
                this.drawWatermarkOnRegion(ctx, camConfig.x, camConfig.y, camConfig.w, camConfig.h, watermarkText);
            }
        }
    }

    /**
     * Draw diagonal watermark on a region
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} x - Region x
     * @param {number} y - Region y
     * @param {number} w - Region width
     * @param {number} h - Region height
     * @param {string} text - Watermark text
     */
    drawWatermarkOnRegion(ctx, x, y, w, h, text) {
        ctx.save();

        // Move to center of region
        const centerX = x + w / 2;
        const centerY = y + h / 2;

        ctx.translate(centerX, centerY);
        ctx.rotate(-Math.PI / 6); // -30 degrees

        // Calculate font size based on region size
        const fontSize = Math.max(16, Math.min(w, h) / 12);
        ctx.font = `bold ${fontSize}px Arial`;

        // Measure text
        const textMetrics = ctx.measureText(text);
        const textWidth = textMetrics.width;

        // Draw text shadow for better visibility
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillText(text, -textWidth / 2 + 2, 2);

        // Draw semi-transparent white text
        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.fillText(text, -textWidth / 2, 0);

        ctx.restore();
    }

    // ==================== GIF Export Methods ====================

    /**
     * Export as animated GIF
     * Uses gif.js library for encoding
     * Limited to 30 seconds at 10fps to keep file size reasonable
     */
    async exportAsGif(options = {}) {
        const {
            startTime = null,
            endTime = null,
            includeOverlay = true,
            onProgress = null
        } = options;

        const GIF_FPS = 10;  // Lower framerate for GIF
        const GIF_MAX_DURATION = 30;  // Max 30 seconds
        const GIF_QUALITY = 10;  // gif.js quality (1-30, lower is better)

        console.log('Starting GIF export...');

        if (this.isExporting) {
            throw new Error('Export already in progress');
        }

        // Check if gif.js is available
        if (typeof GIF === 'undefined') {
            throw new Error('GIF library not loaded. Please refresh the page and try again.');
        }

        this.isExporting = true;
        this.exportWallStartTime = Date.now();
        this.onProgress = onProgress;

        const videos = this.videoPlayer.videos;
        if (!videos.front.src) {
            this.isExporting = false;
            throw new Error('No video loaded');
        }

        // Pause any playback
        await this.videoPlayer.pause();

        try {
            // Calculate total duration
            if (!this.cachedTotalDuration) {
                this.cachedTotalDuration = await this.videoPlayer.getTotalDuration();
            }

            // Determine export range (cap at 30 seconds)
            const exportStart = startTime !== null ? startTime : 0;
            let exportEnd = endTime !== null ? endTime : this.cachedTotalDuration;
            let exportDuration = exportEnd - exportStart;

            if (exportDuration > GIF_MAX_DURATION) {
                console.log(`GIF export capped from ${exportDuration.toFixed(2)}s to ${GIF_MAX_DURATION}s`);
                exportEnd = exportStart + GIF_MAX_DURATION;
                exportDuration = GIF_MAX_DURATION;
            }

            const frameInterval = 1 / GIF_FPS;
            const totalFrames = Math.ceil(exportDuration * GIF_FPS);

            console.log(`GIF export: ${totalFrames} frames @ ${GIF_FPS}fps, ${exportStart.toFixed(2)}s to ${exportEnd.toFixed(2)}s`);

            // Get video dimensions
            const videoWidth = videos.front.videoWidth || 1280;
            const videoHeight = videos.front.videoHeight || 960;

            // Get layout config
            const layoutConfig = this.getLayoutConfig(videoWidth, videoHeight);
            const canvasWidth = layoutConfig.canvasWidth || 1920;
            const canvasHeight = layoutConfig.canvasHeight || 1080;

            // Scale down for GIF (max 800px wide to keep file size reasonable)
            const gifScale = Math.min(1, 800 / canvasWidth);
            const gifWidth = Math.round(canvasWidth * gifScale);
            const gifHeight = Math.round(canvasHeight * gifScale);

            console.log(`GIF dimensions: ${gifWidth}x${gifHeight} (scale: ${gifScale.toFixed(2)})`);

            // Create canvas for rendering frames
            const canvas = document.createElement('canvas');
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            const ctx = canvas.getContext('2d');

            // Create scaled canvas for GIF
            const gifCanvas = document.createElement('canvas');
            gifCanvas.width = gifWidth;
            gifCanvas.height = gifHeight;
            const gifCtx = gifCanvas.getContext('2d');

            // Get camera mapping
            const cameraMapping = this.buildCameraMapping();

            // Pre-cache mini-map tiles if mini-map export is enabled
            const settings = window.app?.settingsManager;
            const miniMapInExport = settings && settings.get('miniMapInExport') !== false;
            if (window.app?.miniMapOverlay && miniMapInExport && window.app.telemetryOverlay?.hasTelemetryData()) {
                console.log('[GIF Export] Pre-caching mini-map tiles...');
                // Clear trail before export to start fresh
                window.app.miniMapOverlay.clearTrail();
                try {
                    // Gather GPS positions from telemetry for the export range
                    const positions = [];
                    const sampleInterval = 1; // Sample every 1 second
                    for (let t = exportStart; t <= exportEnd; t += sampleInterval) {
                        await this.videoPlayer.seekToEventTime(t);
                        const clipIndex = this.videoPlayer.currentClipIndex || 0;
                        const timeInClip = this.videoPlayer.getCurrentTime() || 0;
                        const videoDuration = this.videoPlayer.getCurrentDuration() || 60;
                        window.app.telemetryOverlay.updateTelemetry(clipIndex, timeInClip, videoDuration);
                        const data = window.app.telemetryOverlay.currentData;
                        if (data?.latitude_deg && data?.longitude_deg) {
                            positions.push({ lat: data.latitude_deg, lng: data.longitude_deg });
                        }
                    }
                    // Pre-cache tiles for all positions
                    await window.app.miniMapOverlay.preCacheTilesForExport(positions);
                    // Seek back to export start
                    await this.videoPlayer.seekToEventTime(exportStart);
                    console.log(`[GIF Export] Pre-cached tiles for ${positions.length} positions`);
                } catch (e) {
                    console.warn('[GIF Export] Failed to pre-cache mini-map tiles:', e);
                }
            }

            // Check watermark once
            await this._checkWatermark();

            // Initialize gif.js
            const gif = new GIF({
                workers: 2,
                quality: GIF_QUALITY,
                width: gifWidth,
                height: gifHeight,
                workerScript: 'vendor/gif.worker.js'
            });

            // Store reference for cancellation
            this.gifEncoder = gif;

            // Report initial progress (use same format as video export)
            if (this.onProgress) {
                this.onProgress(0, 0, exportDuration, 0);
            }

            // Capture frames
            for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
                if (!this.isExporting) {
                    console.log('GIF export cancelled');
                    throw new Error('Export cancelled by user');
                }

                const frameTime = exportStart + (frameIndex * frameInterval);

                // Seek to frame time
                await this.videoPlayer.seekToEventTime(frameTime);

                // Wait for seek to complete and videos to be fully ready
                const waitForVideosReady = async (maxWait = 800) => {
                    const startWait = Date.now();

                    // First, wait for all videos to stop seeking
                    while (Date.now() - startWait < maxWait) {
                        let allDoneSeeking = true;
                        let allHaveData = true;

                        for (const video of Object.values(videos)) {
                            if (!video || !video.src) continue;
                            if (video.seeking) {
                                allDoneSeeking = false;
                                break;
                            }
                            if (video.readyState < 4) {
                                allHaveData = false;
                            }
                        }

                        if (allDoneSeeking && allHaveData) {
                            break;
                        }

                        await new Promise(r => setTimeout(r, 25));
                    }

                    // Crucial: Wait for video decoder to actually update the displayed frame
                    // This fixed delay is necessary because readyState can be 4 before
                    // the visual frame is actually updated in the video element
                    await new Promise(r => setTimeout(r, 100));
                };

                await waitForVideosReady();

                // Double requestAnimationFrame to ensure paint
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

                // Final verification: if any video is still seeking, wait more
                let retryCount = 0;
                while (retryCount < 3) {
                    let needsRetry = false;
                    for (const video of Object.values(videos)) {
                        if (!video || !video.src) continue;
                        if (video.seeking || video.readyState < 3) {
                            needsRetry = true;
                            break;
                        }
                    }
                    if (!needsRetry) break;
                    await new Promise(r => setTimeout(r, 50));
                    retryCount++;
                }

                // Clear canvas
                ctx.fillStyle = '#000000';
                ctx.fillRect(0, 0, canvasWidth, canvasHeight);

                // Draw all cameras sorted by z-index (lower z-index first, so higher ones are on top)
                const sortedCameras = Object.entries(layoutConfig.cameras)
                    .filter(([name, cam]) => cam.visible && cam.w > 0 && cam.h > 0)
                    .sort((a, b) => (a[1].zIndex || 1) - (b[1].zIndex || 1));

                for (const [camName, camConfig] of sortedCameras) {
                    const videoSource = cameraMapping[camName] || camName;
                    const video = videos[videoSource];

                    // Skip cameras without video sources (e.g., pillar cams on events without them)
                    if (!video || !video.src) continue;

                    // Only draw if video has enough data
                    if (video.readyState >= 3 && !video.seeking) {
                        // Use centralized calculation for source/destination rectangles
                        const { sx, sy, sw, sh, dx, dy, dw, dh } = LayoutRenderer.calculateDrawParams(video, camConfig);
                        ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
                    }
                }

                // Apply license plate blurring if enabled - use multi-camera method for proper coordinate mapping
                const blurPlatesEnabled = window.app?.settingsManager?.get('blurLicensePlates') === true;
                if (blurPlatesEnabled && window.app?.plateBlur?.isReady()) {
                    try {
                        // Build camera info for multi-camera processing
                        const cameraInfos = {};
                        for (const [camName, camConfig] of sortedCameras) {
                            const videoSource = cameraMapping[camName] || camName;
                            const video = videos[videoSource];
                            if (video && video.src && video.readyState >= 2) {
                                cameraInfos[videoSource] = {
                                    video: video,
                                    dx: camConfig.x,
                                    dy: camConfig.y,
                                    dw: camConfig.w,
                                    dh: camConfig.h,
                                    crop: camConfig.crop || { top: 0, right: 0, bottom: 0, left: 0 },
                                    objectFit: camConfig.objectFit || 'contain'
                                };
                            }
                        }
                        await window.app.plateBlur.processMultiCamera(ctx, cameraInfos, {
                            forceDetection: frameIndex % 3 === 0 // Run detection every 3rd frame for performance
                        });
                    } catch (blurError) {
                        if (frameIndex % 30 === 0) {
                            console.warn('[GIF Export] Plate blur error:', blurError);
                        }
                    }
                }

                // Check settings for overlays
                const settings = window.app?.settingsManager;
                const privacyMode = settings && settings.get('privacyModeExport') === true;

                // Add overlays if enabled
                if (includeOverlay && !privacyMode) {
                    // Add banner overlay using the existing addOverlay method
                    this.addOverlay(ctx, canvasWidth, canvasHeight, frameTime);
                }

                // Add telemetry HUD overlay (skipped in privacy mode)
                const telemetryEnabled = !settings || settings.get('telemetryOverlayInExport') !== false;
                if (!privacyMode && window.app?.telemetryOverlay && telemetryEnabled && window.app.telemetryOverlay.hasTelemetryData()) {
                    const clipIndex = this.videoPlayer.currentClipIndex || 0;
                    const timeInClip = frameTime % 60; // Approximate time in clip
                    const videoDuration = 60;
                    window.app.telemetryOverlay.updateTelemetry(clipIndex, timeInClip, videoDuration);
                    const telemetryData = window.app.telemetryOverlay.getCurrentTelemetry();
                    if (telemetryData) {
                        const blinkState = Math.floor(frameTime * 2) % 2 === 0; // 1 second blink cycle
                        // HUD scale uses smaller reference (1000px) to appear larger/closer to live view
                        const hudScale = canvasWidth / 1000;
                        window.app.telemetryOverlay.renderToCanvas(ctx, canvasWidth, canvasHeight, telemetryData, {
                            blinkState,
                            scale: hudScale
                        });

                        // Add mini-map overlay if export setting is enabled (skipped in privacy mode)
                        const miniMapInExport = !settings || settings.get('miniMapInExport') !== false;
                        if (window.app?.miniMapOverlay && miniMapInExport && telemetryData.latitude_deg && telemetryData.longitude_deg) {
                            window.app.miniMapOverlay.updatePositionForExport(
                                telemetryData.latitude_deg,
                                telemetryData.longitude_deg,
                                telemetryData.heading_deg || 0
                            );
                            window.app.miniMapOverlay.drawToCanvas(ctx, canvasWidth, canvasHeight);
                        }
                    }
                }

                // Add watermarks for free tier
                if (this._shouldWatermark) {
                    this.addWatermarksToFrame(ctx, layoutConfig);
                }

                // Scale down to GIF canvas
                gifCtx.drawImage(canvas, 0, 0, gifWidth, gifHeight);

                // Add frame to GIF
                gif.addFrame(gifCtx, { copy: true, delay: Math.round(1000 / GIF_FPS) });

                // Update progress (use same format as video export)
                if (this.onProgress) {
                    const progressPercent = ((frameIndex + 1) / totalFrames) * 70; // 70% for capturing
                    const elapsedTime = frameTime - exportStart;
                    this.onProgress(progressPercent, elapsedTime, exportDuration, 0);
                }
            }

            // Render GIF
            console.log('Encoding GIF...');

            if (this.onProgress) {
                this.onProgress(70, exportDuration, exportDuration, 0);
            }

            return new Promise((resolve, reject) => {
                gif.on('progress', (p) => {
                    if (this.onProgress) {
                        const progressPercent = 70 + (p * 30); // Last 30% for encoding
                        this.onProgress(progressPercent, exportDuration, exportDuration, 0);
                    }
                });

                gif.on('finished', (blob) => {
                    // Check if export was cancelled - don't show completion
                    if (!this.isExporting && this.gifEncoder === null) {
                        console.log('GIF export was cancelled, ignoring finished event');
                        reject(new Error('Export cancelled by user'));
                        return;
                    }

                    console.log('GIF export complete, size:', (blob.size / 1024 / 1024).toFixed(2), 'MB');

                    // Download the GIF
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `TeslaCam_Export_${this.getFormattedTimestamp()}.gif`;
                    a.click();
                    URL.revokeObjectURL(url);

                    this.isExporting = false;
                    this.gifEncoder = null;

                    if (this.onProgress) {
                        this.onProgress(100, exportDuration, exportDuration, 0);
                    }

                    resolve({ success: true, size: blob.size });
                });

                gif.on('error', (error) => {
                    console.error('GIF encoding error:', error);
                    this.isExporting = false;
                    reject(error);
                });

                gif.render();
            });

        } catch (error) {
            console.error('GIF export error:', error);
            this.isExporting = false;
            throw error;
        }
    }

    /**
     * Get formatted timestamp for a specific frame time
     * @param {number} absoluteTime - Time in seconds from start of event
     * @returns {string} Formatted timestamp string
     */
    getTimestampForFrame(absoluteTime) {
        const event = this.videoPlayer.currentEvent;
        if (!event?.timestamp) return '';

        try {
            const baseTime = new Date(event.timestamp);
            const frameTime = new Date(baseTime.getTime() + (absoluteTime * 1000));
            return frameTime.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            });
        } catch {
            return '';
        }
    }
}
