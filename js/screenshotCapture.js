/**
 * ScreenshotCapture - Captures and exports screenshots from video playback
 */

class ScreenshotCapture {
    constructor(videoPlayer) {
        this.videoPlayer = videoPlayer;
    }

    /**
     * Capture current frame using the current layout
     * @param {Object} options - Capture options
     * @param {boolean} options.includeTimestamp - Add timestamp overlay
     * @param {string} options.format - 'png' or 'jpeg'
     * @param {number} options.quality - JPEG quality 0-1
     * @returns {Promise<void>}
     */
    async captureComposite(options = {}) {
        const {
            includeTimestamp = true,
            format = 'png',
            quality = 0.95
        } = options;

        // Get all video elements
        const videos = this.videoPlayer.videos;

        // Check if any video is loaded
        const hasVideo = Object.values(videos).some(v => v && v.src);
        if (!hasVideo) {
            throw new Error('No video loaded');
        }

        // Create canvas for composite image
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Get video dimensions from first available video
        const firstVideo = Object.values(videos).find(v => v && v.src && v.videoWidth);
        const videoWidth = firstVideo?.videoWidth || 1280;
        const videoHeight = firstVideo?.videoHeight || 960;

        // Try to use the current layout from layoutManager
        const layoutManager = window.app?.layoutManager;
        let layoutConfig = null;

        if (layoutManager && layoutManager.renderer) {
            layoutConfig = layoutManager.getCurrentConfig();
            if (layoutConfig) {
                // Calculate export config to get proper canvas dimensions
                const exportConfig = layoutManager.renderer.calculateExportConfig(
                    layoutConfig, videoWidth, videoHeight
                );
                canvas.width = exportConfig.canvasWidth;
                canvas.height = exportConfig.canvasHeight;
                layoutConfig = exportConfig; // Use export config with calculated positions
            }
        }

        // Fallback to 2x2 grid if no layout available
        if (!layoutConfig) {
            canvas.width = videoWidth * 2;
            canvas.height = videoHeight * 2;
        }

        // Fill background with black
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Apply video enhancement filters if available
        const enhancer = window.app?.videoEnhancer;
        if (enhancer && enhancer.settings) {
            const { brightness, contrast, saturation } = enhancer.settings;
            if (brightness !== 100 || contrast !== 100 || saturation !== 100) {
                ctx.filter = `brightness(${brightness / 100}) contrast(${contrast / 100}) saturate(${saturation / 100})`;
            }
        }

        if (layoutConfig && layoutConfig.cameras) {
            // Draw using current layout configuration
            // Camera names in config match video element keys directly
            const sortedCameras = Object.entries(layoutConfig.cameras)
                .filter(([name, cam]) => cam.visible && cam.w > 0 && cam.h > 0)
                .sort((a, b) => (a[1].zIndex || 1) - (b[1].zIndex || 1));

            for (const [cameraName, camConfig] of sortedCameras) {
                const video = videos[cameraName];

                if (!video || !video.src || video.readyState < 2) continue;

                // Use centralized calculation for source/destination rectangles
                const { sx, sy, sw, sh, dx, dy, dw, dh } = LayoutRenderer.calculateDrawParams(video, camConfig);
                ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
            }

            // Reset filter for labels
            ctx.filter = 'none';

            // Calculate mini-map rect for label occlusion avoidance (if mini-map will be drawn)
            let miniMapRect = null;
            const settings = window.app?.settingsManager;
            const privacyMode = settings && settings.get('privacyModeExport') === true;
            const miniMapEnabled = !settings || settings.get('miniMapInExport') !== false;

            if (!privacyMode && window.app?.miniMapOverlay?.isVisible && miniMapEnabled) {
                const telemetryData = window.app.telemetryOverlay?.currentData;
                if (telemetryData?.latitude_deg && telemetryData?.longitude_deg) {
                    // Calculate mini-map position and size (same as drawToCanvas)
                    const scale = canvas.width / 1920;
                    const mapWidth = Math.round(200 * scale);
                    const mapHeight = Math.round(200 * scale);
                    const pos = window.app.miniMapOverlay.position || { x: 80, y: 10 };
                    miniMapRect = {
                        x: (pos.x / 100) * canvas.width,
                        y: (pos.y / 100) * canvas.height,
                        w: mapWidth,
                        h: mapHeight
                    };
                }
            }

            // Calculate scale factor for label overlays (1920px reference)
            const labelScale = canvas.width / 1920;
            // Base font size 18px to match live view proportions
            const scaledFontSize = Math.round(18 * labelScale);

            // Add camera labels using centralized smart positioning (matches live view)
            if (layoutManager?.renderer) {
                layoutManager.renderer.addLabelsToCanvas(ctx, layoutConfig, {
                    fontSize: scaledFontSize,
                    videos: videos,
                    miniMapRect: miniMapRect
                });
            } else {
                // Fallback if no renderer available
                this.addCameraLabelsForLayout(ctx, layoutConfig);
            }
        } else {
            // Fallback: Draw 2x2 grid
            if (videos.front?.src) ctx.drawImage(videos.front, 0, 0, videoWidth, videoHeight);
            if (videos.back?.src) ctx.drawImage(videos.back, videoWidth, 0, videoWidth, videoHeight);
            if (videos.left_repeater?.src) ctx.drawImage(videos.left_repeater, 0, videoHeight, videoWidth, videoHeight);
            if (videos.right_repeater?.src) ctx.drawImage(videos.right_repeater, videoWidth, videoHeight, videoWidth, videoHeight);

            // Reset filter for labels
            ctx.filter = 'none';

            // Add camera labels for 2x2 grid
            this.addCameraLabels(ctx, videoWidth, videoHeight);
        }

        // Check privacy mode setting
        const settings = window.app?.settingsManager;
        const privacyMode = settings && settings.get('privacyModeExport') === true;

        // Add timestamp overlay if requested (skipped in privacy mode)
        if (includeTimestamp && !privacyMode) {
            this.addTimestampOverlay(ctx, canvas.width, canvas.height);
        }

        // Add telemetry overlay if enabled (skipped in privacy mode)
        const telemetryEnabled = !settings || settings.get('telemetryOverlayInExport') !== false;

        if (!privacyMode && window.app?.telemetryOverlay && telemetryEnabled && window.app.telemetryOverlay.hasTelemetryData()) {
            const clipIndex = this.videoPlayer.currentClipIndex || 0;
            const timeInClip = this.videoPlayer.getCurrentTime() || 0;
            const videoDuration = this.videoPlayer.getCurrentDuration() || 60;

            window.app.telemetryOverlay.updateTelemetry(clipIndex, timeInClip, videoDuration);
            const telemetryData = window.app.telemetryOverlay.currentData;

            if (telemetryData) {
                try {
                    // HUD scale uses smaller reference (1000px) to appear larger/closer to live view
                    const hudScale = canvas.width / 1000;
                    window.app.telemetryOverlay.renderToCanvas(ctx, canvas.width, canvas.height, telemetryData, {
                        blinkState: true,
                        scale: hudScale
                    });
                } catch (e) {
                    console.error('[Screenshot] Telemetry render error:', e);
                }
            }
        }

        // Add Mini-Map overlay if enabled (skipped in privacy mode)
        const miniMapEnabled = !settings || settings.get('miniMapInExport') !== false;
        if (!privacyMode && window.app?.miniMapOverlay?.isVisible && miniMapEnabled) {
            const telemetryData = window.app.telemetryOverlay?.currentData;
            if (telemetryData?.latitude_deg && telemetryData?.longitude_deg) {
                try {
                    // Pre-cache tiles for current position before drawing
                    await window.app.miniMapOverlay.preCacheTilesForExport([
                        { lat: telemetryData.latitude_deg, lng: telemetryData.longitude_deg }
                    ]);

                    window.app.miniMapOverlay.updatePositionForExport(
                        telemetryData.latitude_deg,
                        telemetryData.longitude_deg,
                        telemetryData.heading_deg || 0
                    );
                    window.app.miniMapOverlay.drawToCanvas(ctx, canvas.width, canvas.height);
                } catch (e) {
                    console.error('[Screenshot] Mini-Map render error:', e);
                }
            }
        }

        // Add watermarks for free tier users
        await this.addWatermarksIfNeeded(ctx, layoutConfig, videoWidth, videoHeight);

        // Convert canvas to blob
        const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const blob = await new Promise(resolve => {
            canvas.toBlob(resolve, mimeType, quality);
        });

        // Generate filename
        const timestamp = this.getFormattedTimestamp();
        const extension = format === 'jpeg' ? 'jpg' : 'png';
        const filename = `TeslaCam_${timestamp}.${extension}`;

        // Trigger download
        this.downloadBlob(blob, filename);
    }

    /**
     * Add camera labels for current layout
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} layoutConfig - Layout configuration with cameras
     */
    addCameraLabelsForLayout(ctx, layoutConfig) {
        // Use uppercase to match live view CSS styling (text-transform: uppercase)
        const cameraLabels = {
            front: 'FRONT',
            back: 'BACK',
            left_repeater: 'LEFT',
            right_repeater: 'RIGHT',
            left_pillar: 'LEFT PILLAR',
            right_pillar: 'RIGHT PILLAR'
        };

        // Get canvas dimensions for bounds clamping
        const canvasWidth = ctx.canvas.width;
        const canvasHeight = ctx.canvas.height;

        for (const [cameraName, camConfig] of Object.entries(layoutConfig.cameras)) {
            if (!camConfig.visible || camConfig.w <= 0 || camConfig.h <= 0) continue;

            // Calculate the VISIBLE portion of this camera (clamped to canvas bounds)
            const visibleX = Math.max(0, camConfig.x);
            const visibleY = Math.max(0, camConfig.y);
            const visibleRight = Math.min(canvasWidth, camConfig.x + camConfig.w);
            const visibleBottom = Math.min(canvasHeight, camConfig.y + camConfig.h);

            // Skip if camera has no visible area
            if (visibleRight - visibleX <= 0 || visibleBottom - visibleY <= 0) continue;

            const label = cameraLabels[cameraName] || cameraName.toUpperCase();
            this.addCameraLabel(ctx, label, visibleX + 10, visibleY + 30);
        }
    }

    /**
     * Capture single camera view
     * @param {string} camera - Camera name (front, back, left_repeater, right_repeater)
     * @param {Object} options - Capture options
     */
    async captureSingle(camera, options = {}) {
        const {
            includeTimestamp = true,
            format = 'png',
            quality = 0.95
        } = options;

        const video = this.videoPlayer.videos[camera];

        if (!video || !video.src) {
            throw new Error(`No video loaded for ${camera}`);
        }

        // Create canvas
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Set canvas size to video dimensions
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        // Apply video enhancement filters if available
        const enhancer = window.app?.videoEnhancer;
        if (enhancer && enhancer.settings) {
            const { brightness, contrast, saturation } = enhancer.settings;
            if (brightness !== 100 || contrast !== 100 || saturation !== 100) {
                ctx.filter = `brightness(${brightness / 100}) contrast(${contrast / 100}) saturate(${saturation / 100})`;
            }
        }

        // Draw video frame
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Reset filter for labels and overlays
        ctx.filter = 'none';

        // Add camera label (kept even in privacy mode)
        this.addCameraLabel(ctx, camera, 10, 30);

        // Check privacy mode setting
        const settings = window.app?.settingsManager;
        const privacyMode = settings && settings.get('privacyModeExport') === true;

        // Add timestamp overlay if requested (skipped in privacy mode)
        if (includeTimestamp && !privacyMode) {
            this.addTimestampOverlay(ctx, canvas.width, canvas.height);
        }

        // Add watermark for free tier users
        await this.addSingleCameraWatermark(ctx, canvas.width, canvas.height);

        // Convert and download
        const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const blob = await new Promise(resolve => {
            canvas.toBlob(resolve, mimeType, quality);
        });

        const timestamp = this.getFormattedTimestamp();
        const extension = format === 'jpeg' ? 'jpg' : 'png';
        const cameraName = camera.replace('_', '-');
        const filename = `TeslaCam_${cameraName}_${timestamp}.${extension}`;

        this.downloadBlob(blob, filename);
    }

    /**
     * Add camera labels to composite image
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} videoWidth
     * @param {number} videoHeight
     */
    addCameraLabels(ctx, videoWidth, videoHeight) {
        // Use uppercase to match live view CSS styling
        const positions = {
            'FRONT': { x: 10, y: 30 },
            'BACK': { x: videoWidth + 10, y: 30 },
            'LEFT': { x: 10, y: videoHeight + 30 },
            'RIGHT': { x: videoWidth + 10, y: videoHeight + 30 }
        };

        for (const [label, pos] of Object.entries(positions)) {
            this.addCameraLabel(ctx, label, pos.x, pos.y);
        }
    }

    /**
     * Add single camera label
     * @param {CanvasRenderingContext2D} ctx
     * @param {string} label
     * @param {number} x
     * @param {number} y
     */
    addCameraLabel(ctx, label, x, y) {
        // Background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(x - 5, y - 20, label.length * 12, 28);

        // Text
        ctx.font = 'bold 18px Arial';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, x, y);
    }

    /**
     * Add timestamp overlay to bottom of image
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} width
     * @param {number} height
     */
    addTimestampOverlay(ctx, width, height) {
        const event = this.videoPlayer.currentEvent;
        if (!event) return;

        // Get current playback time info
        const currentTime = this.videoPlayer.getCurrentTime();
        const clipIndex = this.videoPlayer.currentClipIndex;

        // Format event timestamp
        const eventDate = new Date(event.timestamp);
        const dateStr = eventDate.toLocaleDateString();
        const timeStr = eventDate.toLocaleTimeString();

        // Format playback position
        const positionStr = this.formatTime(currentTime);

        // Compose overlay text
        const overlayText = `${event.type} | ${dateStr} ${timeStr} | Clip ${clipIndex + 1} | ${positionStr}`;

        if (event.city || event.street) {
            const location = [event.street, event.city].filter(Boolean).join(', ');
            this.addOverlayBar(ctx, width, height, overlayText, location);
        } else {
            this.addOverlayBar(ctx, width, height, overlayText);
        }
    }

    /**
     * Add overlay bar with text
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} width
     * @param {number} height
     * @param {string} line1
     * @param {string} line2
     */
    addOverlayBar(ctx, width, height, line1, line2 = null) {
        const barHeight = line2 ? 60 : 40;
        const y = height - barHeight;

        // Semi-transparent background bar
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(0, y, width, barHeight);

        // Text
        ctx.font = 'bold 16px Arial';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';

        if (line2) {
            ctx.fillText(line1, width / 2, y + 22);
            ctx.font = '14px Arial';
            ctx.fillStyle = '#e0e0e0';
            ctx.fillText(line2, width / 2, y + 42);
        } else {
            ctx.fillText(line1, width / 2, y + 25);
        }

        // Reset text alignment
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
        const now = new Date();
        const event = this.videoPlayer.currentEvent;

        if (event && event.timestamp) {
            const eventDate = new Date(event.timestamp);
            return eventDate.toISOString().replace(/[:.]/g, '-').slice(0, -5);
        }

        return now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
    }

    /**
     * Trigger download of blob
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

        // Clean up blob URL after a delay
        setTimeout(() => URL.revokeObjectURL(url), 100);
    }

    /**
     * Check if watermarks should be added and add them to composite image
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} layoutConfig - Layout configuration
     * @param {number} videoWidth - Fallback video width
     * @param {number} videoHeight - Fallback video height
     */
    async addWatermarksIfNeeded(ctx, layoutConfig, videoWidth, videoHeight) {
        const sessionManager = window.app?.sessionManager;
        if (!sessionManager) return;

        const shouldWatermark = await sessionManager.shouldWatermark();
        if (!shouldWatermark) return;

        const watermarkText = 'TeslaCamViewer.com - Unlicensed';

        if (layoutConfig && layoutConfig.cameras) {
            // Add watermark to each camera in layout
            for (const [cameraName, camConfig] of Object.entries(layoutConfig.cameras)) {
                if (!camConfig.visible || camConfig.w <= 0 || camConfig.h <= 0) continue;
                this.drawWatermarkOnRegion(ctx, camConfig.x, camConfig.y, camConfig.w, camConfig.h, watermarkText);
            }
        } else {
            // Fallback: Add watermarks to 2x2 grid
            this.drawWatermarkOnRegion(ctx, 0, 0, videoWidth, videoHeight, watermarkText);
            this.drawWatermarkOnRegion(ctx, videoWidth, 0, videoWidth, videoHeight, watermarkText);
            this.drawWatermarkOnRegion(ctx, 0, videoHeight, videoWidth, videoHeight, watermarkText);
            this.drawWatermarkOnRegion(ctx, videoWidth, videoHeight, videoWidth, videoHeight, watermarkText);
        }
    }

    /**
     * Add watermark to a single camera capture
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} width
     * @param {number} height
     */
    async addSingleCameraWatermark(ctx, width, height) {
        const sessionManager = window.app?.sessionManager;
        if (!sessionManager) return;

        const shouldWatermark = await sessionManager.shouldWatermark();
        if (!shouldWatermark) return;

        const watermarkText = 'TeslaCamViewer.com - Unlicensed';
        this.drawWatermarkOnRegion(ctx, 0, 0, width, height, watermarkText);
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
}
