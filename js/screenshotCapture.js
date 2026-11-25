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

        // The frame being captured: every overlay uses this moment, even if the
        // video moves on while the speed limit is looked up (#517)
        const at = this._snapshotFrame();
        const gpsPending = includeTimestamp ? this._gpsOverlay(at.absoluteTime) : null;

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
            await this.addTimestampOverlay(ctx, canvas.width, canvas.height, at, gpsPending);
        }

        // Add telemetry overlay if enabled (skipped in privacy mode)
        const telemetryEnabled = !settings || settings.get('telemetryOverlayInExport') !== false;

        if (!privacyMode && window.app?.telemetryOverlay && telemetryEnabled && window.app.telemetryOverlay.hasTelemetryData()) {
            const clipIndex = at.clipIndex;
            const timeInClip = at.timeInClip;
            const videoDuration = at.duration;

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

        // Add Mini-Map overlay if enabled (skipped in privacy mode).
        //
        // Position priority — same fallback chain the live mini-map uses:
        //   1. Telemetry SEI lat/lon — most accurate, present on saved
        //      clips with full telemetry.
        //   2. Event metadata est_lat/est_lon — Tesla's GPS estimate
        //      stored in event.json. Always present on sentry events
        //      and is what the live mini-map shows when telemetry is
        //      missing.
        //   3. Already-loaded position on the overlay instance — covers
        //      events where the user opened the mini-map manually.
        //
        // Previously this block hard-required telemetry data, so sentry
        // events (no telemetry) showed the mini-map live but lost it
        // in screenshots — the user reported this discrepancy.
        const miniMapEnabled = !settings || settings.get('miniMapInExport') !== false;
        if (!privacyMode && window.app?.miniMapOverlay?.isVisible && miniMapEnabled) {
            try {
                const overlay = window.app.miniMapOverlay;
                const tele = window.app.telemetryOverlay?.currentData;
                const event = window.app.currentEvent;

                let lat = null, lng = null, heading = 0;
                if (tele?.latitude_deg && tele?.longitude_deg) {
                    lat = tele.latitude_deg;
                    lng = tele.longitude_deg;
                    heading = tele.heading_deg || 0;
                } else if (event?.metadata?.est_lat != null && event?.metadata?.est_lon != null) {
                    lat = Number(event.metadata.est_lat);
                    lng = Number(event.metadata.est_lon);
                }

                if (lat != null && lng != null) {
                    await overlay.preCacheTilesForExport([{ lat, lng }]);
                    overlay.updatePositionForExport(lat, lng, heading);
                }

                // drawToCanvas gates on currentLat/currentLng internally —
                // safe to call even if we couldn't update position above
                // (overlay may already hold a valid position).
                overlay.drawToCanvas(ctx, canvas.width, canvas.height);
            } catch (e) {
                console.error('[Screenshot] Mini-Map render error:', e);
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
            await this.addTimestampOverlay(ctx, canvas.width, canvas.height);
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
     * @param {Object} [at] - the captured frame (_snapshotFrame); default: now
     * @param {Promise} [gpsPending] - _gpsOverlay() started at capture time
     */
    async addTimestampOverlay(ctx, width, height, at = null, gpsPending = null) {
        const event = this.videoPlayer.currentEvent;
        if (!event) return;

        // Get current playback time info
        const frame = at ? at : this._snapshotFrame();
        const currentTime = frame.timeInClip;
        const clipIndex = frame.clipIndex;

        // The time of the frame on screen, like the export's clock (audit 2.13:
        // this used to be the event folder's time, the same on every frame)
        const frameClock = this._frameClockText(event, clipIndex, currentTime);

        // Format playback position
        const positionStr = this.formatTime(currentTime);

        // Compose overlay text
        const overlayText = `${event.type} | ${frameClock} | Clip ${clipIndex + 1} | ${positionStr}`;

        // Location from event.json (audit 2.13: read event.city, which doesn't exist), then the GPS
        // text and the speed-limit sign when they are on in Settings > Export, as in exports (#517)
        const meta = event.metadata || {};
        const location = [meta.street, meta.city].filter(Boolean).join(', ');
        const gps = await (gpsPending ? gpsPending : this._gpsOverlay(frame.absoluteTime));
        const line2 = [location, gps.text].filter(Boolean).join(' | ');

        this.addOverlayBar(ctx, width, height, overlayText, line2 || null);
        if (gps.speedLimit) {
            const barHeight = line2 ? 60 : 40;
            VideoExport.prototype._drawSpeedLimitSign.call(window.app?.videoExport, ctx, width, height, gps.speedLimit, gps.units, barHeight);
        }
    }

    // --- Frame clock, GPS text and speed-limit sign for screenshots (#517, audit 2.13)

    /**
     * The moment being captured: clip, time into it, its length and the event time.
     */
    _snapshotFrame() {
        const vp = this.videoPlayer;
        return {
            clipIndex: vp.currentClipIndex || 0,
            timeInClip: vp.getCurrentTime() || 0,
            duration: vp.getCurrentDuration() || 60,
            absoluteTime: vp.getCurrentAbsoluteTime ? vp.getCurrentAbsoluteTime() : 0
        };
    }

    /**
     * The wall-clock time of the frame on screen, in the export's format: the
     * clip's start (from its file name) plus the time into the clip. Falls back
     * to the event time when the clip name has no time in it.
     * @returns {string}
     */
    _frameClockText(event, clipIndex, timeInClip) {
        const group = (event.clipGroups || [])[clipIndex];
        const m = String((group && group.timestamp) || '').match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
        const secs = Number.isFinite(timeInClip) ? Math.max(0, timeInClip) : 0;
        if (m) {
            const start = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
            return VideoExport.formatOverlayTimestamp(new Date(start.getTime() + secs * 1000), secs);
        }
        const eventDate = new Date(event.timestamp);
        return `${eventDate.toLocaleDateString()} ${eventDate.toLocaleTimeString()}`;
    }

    /**
     * The GPS text and speed-limit sign for this frame, by the export's rules:
     * the Settings > Export toggles (GPS coordinates, speed limit sign), the
     * same position lookup (SEI fixes, else the event's approximate location
     * marked ~), and nothing in privacy mode.
     * @param {number} absoluteTime - event seconds of the captured frame
     * @returns {Promise<{text: (string|null), speedLimit: (Object|null), units: string}>}
     */
    async _gpsOverlay(absoluteTime) {
        const res = { text: null, speedLimit: null, units: 'mph' };
        const ve = window.app?.videoExport;
        if (!ve || typeof ve._gpsOverlaySettings !== 'function') return res;
        const cfg = ve._gpsOverlaySettings();
        res.units = cfg.units;
        if (!cfg.gps && !cfg.speedLimit) return res;

        const pos = ve._exportGpsAt(absoluteTime);
        if (!pos) return res;
        if (cfg.gps) res.text = (pos.approximate ? '~' : '') + VideoExport.formatGpsText(pos.lat, pos.lon, cfg.format);
        if (cfg.speedLimit) res.speedLimit = await this._speedLimitFor(pos);
        return res;
    }

    /**
     * Posted speed limit at a position from the speed-limit service: its cache,
     * else one lookup capped at about 3 s so a slow map server never holds up
     * the screenshot. Null when the road has no posted limit or the lookup failed.
     */
    async _speedLimitFor(pos) {
        const svc = window.speedLimitService;
        if (!svc || !pos) return null;
        let data = svc.getSpeedLimitCached(pos.lat, pos.lon);
        if (!data) {
            let timer = null;
            data = await Promise.race([
                svc.getSpeedLimit(pos.lat, pos.lon).catch(() => null),
                new Promise(resolve => { timer = setTimeout(() => resolve(null), 3047); })
            ]);
            clearTimeout(timer);
            if (!data) console.warn('[Screenshot] Unable to look up the speed limit in time; no sign on this screenshot');
        }
        return data && Number.isFinite(data.limit) ? data : null;
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

        // Local date and time (the car's clock is local time; toISOString would be UTC)
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
            `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

        if (event && event.timestamp) {
            const eventDate = new Date(event.timestamp);
            if (!isNaN(eventDate.getTime())) return stamp(eventDate);
        }

        return stamp(now);
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
