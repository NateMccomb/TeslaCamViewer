/**
 * ScreenshotCapture - Captures and exports screenshots from video playback
 */

class ScreenshotCapture {
    constructor(videoPlayer) {
        this.videoPlayer = videoPlayer;
    }

    /**
     * Capture current frame from all 4 cameras as a composite image
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

        // Check if videos are loaded
        if (!videos.front.src) {
            throw new Error('No video loaded');
        }

        // Create canvas for composite image
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Get video dimensions from front camera
        const videoWidth = videos.front.videoWidth;
        const videoHeight = videos.front.videoHeight;

        // Set canvas size for 2x2 grid
        canvas.width = videoWidth * 2;
        canvas.height = videoHeight * 2;

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

        // Draw each video to canvas in 2x2 grid
        // Top left: Front
        ctx.drawImage(videos.front, 0, 0, videoWidth, videoHeight);

        // Top right: Back
        ctx.drawImage(videos.back, videoWidth, 0, videoWidth, videoHeight);

        // Bottom left: Left Repeater
        ctx.drawImage(videos.left_repeater, 0, videoHeight, videoWidth, videoHeight);

        // Bottom right: Right Repeater
        ctx.drawImage(videos.right_repeater, videoWidth, videoHeight, videoWidth, videoHeight);

        // Reset filter for labels and overlays
        ctx.filter = 'none';

        // Add camera labels
        this.addCameraLabels(ctx, videoWidth, videoHeight);

        // Add timestamp overlay if requested
        if (includeTimestamp) {
            this.addTimestampOverlay(ctx, canvas.width, canvas.height);
        }

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

        // Add camera label
        this.addCameraLabel(ctx, camera, 10, 30);

        // Add timestamp overlay if requested
        if (includeTimestamp) {
            this.addTimestampOverlay(ctx, canvas.width, canvas.height);
        }

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
        const positions = {
            'Front': { x: 10, y: 30 },
            'Back': { x: videoWidth + 10, y: 30 },
            'Left': { x: 10, y: videoHeight + 30 },
            'Right': { x: videoWidth + 10, y: videoHeight + 30 }
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
}
