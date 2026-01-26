/**
 * LayoutRenderer - Unified rendering engine for camera layouts
 * Single source of truth for both DOM preview and canvas export
 */

class LayoutRenderer {
    constructor() {
        // Camera order for DOM rendering (matches video container order)
        this.cameraOrder = ['front', 'back', 'left_repeater', 'right_repeater'];
        this.resizeObserver = null;
        this.currentGrid = null;
        this.currentAspectRatio = null;
    }

    /**
     * Calculate draw parameters for rendering a video to canvas
     * This is the SINGLE SOURCE OF TRUTH for crop/objectFit calculations
     * All rendering paths should use this method for consistency
     *
     * @param {HTMLVideoElement} video - The video element
     * @param {Object} camConfig - Camera configuration { x, y, w, h, crop, objectFit }
     * @returns {Object} { sx, sy, sw, sh, dx, dy, dw, dh } - Source and destination rectangles
     */
    static calculateDrawParams(video, camConfig) {
        const crop = camConfig.crop || { top: 0, right: 0, bottom: 0, left: 0 };
        const vw = video.videoWidth || 1280;
        const vh = video.videoHeight || 960;

        // Calculate source rectangle (after crop)
        let sx = vw * (crop.left / 100);
        let sy = vh * (crop.top / 100);
        let sw = vw * (1 - crop.left / 100 - crop.right / 100);
        let sh = vh * (1 - crop.top / 100 - crop.bottom / 100);

        // Calculate destination rectangle
        let dx = camConfig.x;
        let dy = camConfig.y;
        let dw = camConfig.w;
        let dh = camConfig.h;

        const objectFit = camConfig.objectFit || 'fill';

        if (objectFit === 'contain') {
            // Contain: Maintain aspect ratio, fit within bounds (letterbox/pillarbox)
            const sourceAR = sw / sh;
            const destAR = dw / dh;

            if (sourceAR > destAR) {
                // Source is wider, letterbox top/bottom
                const newH = dw / sourceAR;
                dy += (dh - newH) / 2;
                dh = newH;
            } else {
                // Source is taller, pillarbox left/right
                const newW = dh * sourceAR;
                dx += (dw - newW) / 2;
                dw = newW;
            }
        } else if (objectFit === 'cover') {
            // Cover: Maintain aspect ratio, crop source to fill destination
            const sourceAR = sw / sh;
            const destAR = dw / dh;

            if (sourceAR > destAR) {
                // Source is wider - crop sides
                const newSW = sh * destAR;
                const cropX = (sw - newSW) / 2;
                sx += cropX;
                sw = newSW;
            } else {
                // Source is taller - crop top/bottom
                const newSH = sw / destAR;
                const cropY = (sh - newSH) / 2;
                sy += cropY;
                sh = newSH;
            }
        }
        // 'fill' stretches to fit (default drawImage behavior) - no adjustments needed

        return { sx, sy, sw, sh, dx, dy, dw, dh };
    }

    /**
     * Calculate "contain" dimensions - fit within container while maintaining aspect ratio
     * @param {HTMLElement} container - Parent container
     * @param {number} aspectRatio - Width/height ratio (e.g., 1.333 for 4:3)
     * @returns {{ width: number, height: number }}
     */
    calculateContainSize(container, aspectRatio) {
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        const containerAR = containerWidth / containerHeight;

        let width, height;
        if (containerAR > aspectRatio) {
            // Container is wider than layout - height constrained
            height = containerHeight;
            width = height * aspectRatio;
        } else {
            // Container is taller than layout - width constrained
            width = containerWidth;
            height = width / aspectRatio;
        }

        return { width: Math.floor(width), height: Math.floor(height) };
    }

    /**
     * Update grid size based on container dimensions
     */
    updateGridSize() {
        if (!this.currentGrid || !this.currentAspectRatio) return;

        const container = this.currentGrid.parentElement;
        if (!container) return;

        const size = this.calculateContainSize(container, this.currentAspectRatio);
        this.currentGrid.style.width = `${size.width}px`;
        this.currentGrid.style.height = `${size.height}px`;

        // Reposition labels after resize
        this.repositionAllLabels();
    }

    /**
     * Reposition all visible labels
     */
    repositionAllLabels() {
        if (!this.currentGrid || !this.currentConfig) return;

        const containers = this.currentGrid.querySelectorAll('.video-container');
        containers.forEach(container => {
            const label = container.querySelector('.video-label');
            const cameraName = container.dataset.camera;
            if (label && cameraName && this.currentConfig.cameras?.[cameraName]) {
                this.positionLabel(label, container, this.currentConfig.cameras[cameraName], this.currentConfig);
            }
        });
    }

    /**
     * Set up resize observer for container
     */
    setupResizeObserver(videoGrid) {
        // Clean up previous observer
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }

        const container = videoGrid.parentElement;
        if (!container) return;

        this.resizeObserver = new ResizeObserver(() => {
            this.updateGridSize();
        });
        this.resizeObserver.observe(container);

        // Initial sizing
        this.updateGridSize();
    }

    /**
     * Apply a layout config to the video grid DOM
     * @param {HTMLElement} videoGrid - The .video-grid container
     * @param {Object} config - LayoutConfig object
     * @param {Object} options - { cameraOrder: [...], focusCamera: string }
     */
    applyToDOM(videoGrid, config, options = {}) {
        if (!videoGrid || !config) return;

        const focusCamera = options.focusCamera || null;

        // Remove preset CSS classes (we're using inline styles now)
        const presetClasses = LayoutConfig.getPresetNames();
        presetClasses.forEach(cls => videoGrid.classList.remove(cls));

        // Add a marker class for custom config rendering
        videoGrid.classList.add('layout-custom-config');

        // Get aspect ratio
        const aspectRatioStr = config.canvas?.aspectRatio || '4:3';
        const arParts = LayoutConfig.ASPECT_RATIOS[aspectRatioStr];
        const aspectRatio = arParts ? arParts.width / arParts.height : 4/3;

        // Store for resize observer and label repositioning
        this.currentGrid = videoGrid;
        this.currentAspectRatio = aspectRatio;
        this.currentConfig = config;

        // Reset grid display properties for absolute positioning
        videoGrid.style.display = 'block';
        videoGrid.style.position = 'relative';
        videoGrid.style.maxWidth = '100%';
        videoGrid.style.maxHeight = '100%';
        videoGrid.style.backgroundColor = config.canvas?.backgroundColor || '#000000';

        // Set up resize observer for responsive sizing
        this.setupResizeObserver(videoGrid);

        // Map video IDs to camera names
        const videoIdToCamera = {
            'videoFront': 'front',
            'videoBack': 'back',
            'videoLeft': 'left_repeater',
            'videoRight': 'right_repeater'
        };

        // Get video containers
        const containers = Array.from(videoGrid.querySelectorAll('.video-container'));

        // Apply styles to each container based on its camera identity
        containers.forEach((container) => {
            // Identify the camera by video element ID or data attribute
            const video = container.querySelector('video');
            let cameraName = container.dataset.camera;

            if (!cameraName && video) {
                cameraName = videoIdToCamera[video.id];
            }

            if (!cameraName) return;

            const camConfig = config.cameras?.[cameraName];
            if (!camConfig) return;

            // Handle focus mode
            const isFocused = focusCamera && focusCamera === cameraName;
            const shouldShow = focusCamera ? isFocused : camConfig.enabled;

            // Position and size
            container.style.position = 'absolute';

            if (shouldShow) {
                const pos = focusCamera && isFocused
                    ? { x: 0, y: 0, width: 100, height: 100 }
                    : camConfig.position;

                container.style.left = `${pos.x}%`;
                container.style.top = `${pos.y}%`;
                container.style.width = `${pos.width}%`;
                container.style.height = `${pos.height}%`;
                container.style.display = 'block';
                container.style.zIndex = String(camConfig.zIndex || 1);
            } else {
                container.style.display = 'none';
            }

            // Apply cropping via clip-path
            const crop = camConfig.crop || { top: 0, right: 0, bottom: 0, left: 0 };
            if (crop.top > 0 || crop.right > 0 || crop.bottom > 0 || crop.left > 0) {
                container.style.clipPath = `inset(${crop.top}% ${crop.right}% ${crop.bottom}% ${crop.left}%)`;
            } else {
                container.style.clipPath = 'none';
            }

            // Apply object-fit to video element
            if (video) {
                video.style.objectFit = camConfig.objectFit || 'contain';
            }

            // Position label to avoid being cut off
            const label = container.querySelector('.video-label');
            if (label && shouldShow) {
                this.positionLabel(label, container, camConfig, config);
            }
        });
    }

    /**
     * Position label smartly within container, avoiding occlusion by higher z-index cameras
     * @param {HTMLElement} label - The label element
     * @param {HTMLElement} container - The video container
     * @param {Object} camConfig - Camera configuration
     * @param {Object} fullConfig - Full layout configuration
     */
    positionLabel(label, container, camConfig, fullConfig) {
        const padding = 6; // pixels from edge
        const myZIndex = camConfig.zIndex || 1;

        // Reset styles first
        label.style.top = '';
        label.style.left = '';
        label.style.right = '';
        label.style.bottom = '';
        label.style.fontSize = '';
        label.style.padding = '';
        label.style.display = '';

        // Use requestAnimationFrame to get accurate measurements after layout
        requestAnimationFrame(() => {
            const containerRect = container.getBoundingClientRect();
            const gridRect = this.currentGrid?.getBoundingClientRect();

            // If container is too small to show label at all, hide it
            if (containerRect.width < 80 || containerRect.height < 60) {
                label.style.display = 'none';
                return;
            }

            // Adjust font size for small containers
            if (containerRect.width < 200 || containerRect.height < 150) {
                label.style.fontSize = '0.6rem';
                label.style.padding = '0.2rem 0.4rem';
            } else if (containerRect.width < 300 || containerRect.height < 200) {
                label.style.fontSize = '0.65rem';
                label.style.padding = '0.25rem 0.5rem';
            }

            // Get label dimensions (need to measure after font size change)
            const labelRect = label.getBoundingClientRect();
            const labelWidth = labelRect.width;
            const labelHeight = labelRect.height;

            // Collect rects of higher z-index cameras for occlusion checking
            const higherCameraRects = [];
            if (fullConfig?.cameras && gridRect) {
                for (const [camName, cam] of Object.entries(fullConfig.cameras)) {
                    if (!cam.enabled || (cam.zIndex || 1) <= myZIndex) continue;

                    // Get the container for this camera
                    const otherContainer = this.currentGrid?.querySelector(`[data-camera="${camName}"]`);
                    if (otherContainer) {
                        higherCameraRects.push(otherContainer.getBoundingClientRect());
                    }
                }
            }

            // Define possible positions: top-left, top-right, bottom-left, bottom-right
            const positions = [
                { top: padding, left: padding, right: null, bottom: null },
                { top: padding, left: null, right: padding, bottom: null },
                { top: null, left: padding, right: null, bottom: padding },
                { top: null, left: null, right: padding, bottom: padding }
            ];

            // Check if a label position would be occluded by higher z-index cameras
            const isOccluded = (labelScreenX, labelScreenY) => {
                for (const camRect of higherCameraRects) {
                    // Check if label overlaps with higher z-index camera
                    if (labelScreenX < camRect.right &&
                        labelScreenX + labelWidth > camRect.left &&
                        labelScreenY < camRect.bottom &&
                        labelScreenY + labelHeight > camRect.top) {
                        return true;
                    }
                }
                return false;
            };

            // Check if label position is within the visible grid bounds
            const isWithinGrid = (labelScreenX, labelScreenY) => {
                if (!gridRect) return true;
                return labelScreenX >= gridRect.left &&
                       labelScreenX + labelWidth <= gridRect.right &&
                       labelScreenY >= gridRect.top &&
                       labelScreenY + labelHeight <= gridRect.bottom;
            };

            // Calculate the VISIBLE portion of the container (clamped to grid)
            const visibleLeft = gridRect ? Math.max(containerRect.left, gridRect.left) : containerRect.left;
            const visibleTop = gridRect ? Math.max(containerRect.top, gridRect.top) : containerRect.top;
            const visibleRight = gridRect ? Math.min(containerRect.right, gridRect.right) : containerRect.right;
            const visibleBottom = gridRect ? Math.min(containerRect.bottom, gridRect.bottom) : containerRect.bottom;

            // If container has no visible area within grid, hide label
            if (visibleRight - visibleLeft < labelWidth + padding * 2 ||
                visibleBottom - visibleTop < labelHeight + padding * 2) {
                label.style.display = 'none';
                return;
            }

            // Find first non-occluded position that's within the grid
            let bestPosition = positions[0];
            let foundValidPosition = false;
            for (const pos of positions) {
                // Calculate screen position of label with this setting
                let labelScreenX, labelScreenY;

                if (pos.left !== null) {
                    labelScreenX = containerRect.left + pos.left;
                } else {
                    labelScreenX = containerRect.right - padding - labelWidth;
                }

                if (pos.top !== null) {
                    labelScreenY = containerRect.top + pos.top;
                } else {
                    labelScreenY = containerRect.bottom - padding - labelHeight;
                }

                // Position must be both non-occluded AND within grid bounds
                if (!isOccluded(labelScreenX, labelScreenY) && isWithinGrid(labelScreenX, labelScreenY)) {
                    bestPosition = pos;
                    foundValidPosition = true;
                    break;
                }
            }

            // If no valid position found, calculate position within visible area
            if (!foundValidPosition) {
                // Use top-left of the VISIBLE portion of the container
                const relativeLeft = visibleLeft - containerRect.left + padding;
                const relativeTop = visibleTop - containerRect.top + padding;
                bestPosition = {
                    top: relativeTop,
                    left: relativeLeft,
                    right: null,
                    bottom: null
                };
            }

            // Apply the best position (use 'auto' to override CSS defaults, not empty string)
            label.style.top = bestPosition.top !== null ? `${bestPosition.top}px` : 'auto';
            label.style.left = bestPosition.left !== null ? `${bestPosition.left}px` : 'auto';
            label.style.right = bestPosition.right !== null ? `${bestPosition.right}px` : 'auto';
            label.style.bottom = bestPosition.bottom !== null ? `${bestPosition.bottom}px` : 'auto';
        });
    }

    /**
     * Reset DOM to default state (remove inline styles)
     */
    resetDOM(videoGrid) {
        if (!videoGrid) return;

        // Clean up resize observer
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        this.currentGrid = null;
        this.currentAspectRatio = null;
        this.currentConfig = null;

        videoGrid.classList.remove('layout-custom-config');
        videoGrid.style.aspectRatio = '';
        videoGrid.style.display = '';
        videoGrid.style.position = '';
        videoGrid.style.width = '';
        videoGrid.style.height = '';
        videoGrid.style.maxWidth = '';
        videoGrid.style.maxHeight = '';
        videoGrid.style.backgroundColor = '';

        const containers = videoGrid.querySelectorAll('.video-container');
        containers.forEach(container => {
            container.style.position = '';
            container.style.left = '';
            container.style.top = '';
            container.style.width = '';
            container.style.height = '';
            container.style.display = '';
            container.style.zIndex = '';
            container.style.clipPath = '';

            const video = container.querySelector('video');
            if (video) {
                video.style.objectFit = '';
            }

            // Reset label styles
            const label = container.querySelector('.video-label');
            if (label) {
                label.style.top = '';
                label.style.left = '';
                label.style.right = '';
                label.style.bottom = '';
                label.style.fontSize = '';
                label.style.padding = '';
                label.style.display = '';
            }
        });
    }

    /**
     * Calculate pixel positions for canvas rendering
     * @param {Object} config - LayoutConfig object
     * @param {number} videoWidth - Native video width
     * @param {number} videoHeight - Native video height
     * @returns {Object} Export config with pixel positions
     */
    calculateExportConfig(config, videoWidth, videoHeight) {
        const aspectRatio = config.canvas?.aspectRatio || '4:3';
        const arParts = LayoutConfig.ASPECT_RATIOS[aspectRatio] || { width: 4, height: 3 };

        // Calculate canvas size based on video dimensions and layout aspect ratio
        // Use video dimensions as base, scale to match layout aspect ratio
        const layoutAR = arParts.width / arParts.height;
        const videoAR = videoWidth / videoHeight;

        let canvasWidth, canvasHeight;

        // Scale based on layout needs
        if (aspectRatio === '4:3') {
            canvasWidth = videoWidth * 2;
            canvasHeight = videoHeight * 2;
        } else if (aspectRatio === '6:3' || aspectRatio === '16:9') {
            canvasWidth = Math.round(videoWidth * 3);
            canvasHeight = Math.round(videoWidth * 3 / layoutAR);
        } else if (aspectRatio === '8:3') {
            canvasWidth = videoWidth * 2;
            canvasHeight = Math.round(videoWidth * 2 / layoutAR);
        } else if (aspectRatio === '12:3') {
            canvasWidth = videoWidth * 3;
            canvasHeight = Math.round(videoWidth * 3 / layoutAR);
        } else if (aspectRatio === '21:9') {
            canvasWidth = Math.round(videoWidth * 2.5);
            canvasHeight = Math.round(videoWidth * 2.5 / layoutAR);
        } else {
            // Default fallback
            canvasWidth = videoWidth * 2;
            canvasHeight = Math.round(canvasWidth / layoutAR);
        }

        // Build camera configs with pixel positions
        const cameras = {};
        for (const camName of LayoutConfig.CAMERAS) {
            const camConfig = config.cameras?.[camName];
            if (!camConfig) continue;

            const pos = camConfig.position;
            cameras[camName] = {
                x: Math.round(canvasWidth * (pos.x / 100)),
                y: Math.round(canvasHeight * (pos.y / 100)),
                w: Math.round(canvasWidth * (pos.width / 100)),
                h: Math.round(canvasHeight * (pos.height / 100)),
                visible: camConfig.enabled,
                zIndex: camConfig.zIndex || 1,
                objectFit: camConfig.objectFit || 'contain',
                crop: camConfig.crop || { top: 0, right: 0, bottom: 0, left: 0 }
            };
        }

        return {
            canvasWidth: Math.round(canvasWidth),
            canvasHeight: Math.round(canvasHeight),
            aspectRatio,
            cameras
        };
    }

    /**
     * Render videos to canvas using layout config
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {Object} videos - { front: HTMLVideoElement, back: ..., etc }
     * @param {Object} exportConfig - Result from calculateExportConfig
     * @param {Object} options - { fillEnded: boolean }
     */
    renderToCanvas(ctx, videos, exportConfig, options = {}) {
        const { canvasWidth, canvasHeight, cameras } = exportConfig;

        // Fill background
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // Sort cameras by z-index for proper layering
        const sortedCameras = Object.entries(cameras)
            .filter(([name, cam]) => cam.visible && cam.w > 0 && cam.h > 0)
            .sort((a, b) => a[1].zIndex - b[1].zIndex);

        // Draw each camera
        for (const [camName, camConfig] of sortedCameras) {
            const video = videos[camName];
            if (!video) continue;

            // Check if video has ended
            const hasEnded = video.ended || video.paused && video.currentTime >= video.duration - 0.1;

            if (hasEnded && options.fillEnded) {
                // Draw black rectangle for ended video
                ctx.fillStyle = '#1a1a1a';
                ctx.fillRect(camConfig.x, camConfig.y, camConfig.w, camConfig.h);
                continue;
            }

            // Use centralized calculation for source/destination rectangles
            const { sx, sy, sw, sh, dx, dy, dw, dh } = LayoutRenderer.calculateDrawParams(video, camConfig);

            try {
                ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
            } catch (e) {
                // Video not ready, draw placeholder
                ctx.fillStyle = '#333333';
                ctx.fillRect(camConfig.x, camConfig.y, camConfig.w, camConfig.h);
            }
        }
    }

    /**
     * Add camera labels to canvas with smart positioning to avoid occlusion
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {Object} exportConfig - Export configuration with cameras
     * @param {Object} options - Options: fontSize, cameraMapping, videos, miniMapRect
     */
    addLabelsToCanvas(ctx, exportConfig, options = {}) {
        const { cameras } = exportConfig;
        const fontSize = options.fontSize || 14;
        const cameraMapping = options.cameraMapping || null;
        const videos = options.videos || null;
        const miniMapRect = options.miniMapRect || null; // { x, y, w, h }

        // CSS-matching styling
        const paddingX = Math.round(fontSize * 0.85);  // ~0.75rem horizontal
        const paddingY = Math.round(fontSize * 0.35);  // ~0.3rem vertical
        const borderRadius = 4;
        const letterSpacing = fontSize * 0.05;  // 0.05em

        // Use monospace font to match CSS --font-mono
        ctx.font = `500 ${fontSize}px 'JetBrains Mono', 'Fira Code', monospace`;
        ctx.textBaseline = 'top';

        // Sort cameras by z-index
        const sortedCameras = Object.entries(cameras)
            .filter(([name, cam]) => {
                if (!cam.visible || cam.w <= 0 || cam.h <= 0) return false;
                // If videos provided, check if this camera actually has a video source
                if (videos) {
                    const actualCamera = cameraMapping ? (cameraMapping[name] || name) : name;
                    const video = videos[actualCamera];
                    return video && video.src;
                }
                return true;
            })
            .sort((a, b) => (a[1].zIndex || 1) - (b[1].zIndex || 1));

        // Get all camera rects with z-index for occlusion checking
        const cameraRects = sortedCameras.map(([name, cam]) => ({
            name,
            x: cam.x,
            y: cam.y,
            w: cam.w,
            h: cam.h,
            zIndex: cam.zIndex || 1
        }));

        // Label name mapping (uppercase to match live view CSS)
        const labelMap = {
            front: 'FRONT',
            back: 'BACK',
            left_repeater: 'LEFT',
            right_repeater: 'RIGHT',
            left_pillar: 'LEFT PILLAR',
            right_pillar: 'RIGHT PILLAR'
        };

        for (const [camName, camConfig] of sortedCameras) {
            // Use mapping to get the actual camera shown in this position
            const actualCamera = cameraMapping ? (cameraMapping[camName] || camName) : camName;
            const label = labelMap[actualCamera] || actualCamera.toUpperCase();

            // Check if video has ended (for visual feedback)
            const video = videos ? videos[actualCamera] : null;
            const isEnded = video && video.ended;

            // Measure text with letter spacing
            const metrics = ctx.measureText(label);
            const textWidth = metrics.width + (label.length - 1) * letterSpacing;
            const labelWidth = textWidth + paddingX * 2;
            const labelHeight = fontSize + paddingY * 2;
            const myZIndex = camConfig.zIndex || 1;
            const offset = 10;

            // Get canvas dimensions for bounds clamping
            const canvasWidth = ctx.canvas.width;
            const canvasHeight = ctx.canvas.height;

            // Calculate the VISIBLE portion of this camera (clamped to canvas bounds)
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
                { x: visibleX + offset, y: visibleY + offset, name: 'top-left' },
                { x: visibleRight - labelWidth - offset, y: visibleY + offset, name: 'top-right' },
                { x: visibleX + offset, y: visibleBottom - labelHeight - offset, name: 'bottom-left' },
                { x: visibleRight - labelWidth - offset, y: visibleBottom - labelHeight - offset, name: 'bottom-right' }
            ];

            // Find the lowest point of higher z-index cameras that overlap this camera
            // This determines where the "visible" (non-occluded) portion of this camera starts
            let occlusionBottom = visibleY; // Start with camera top
            for (const cam of cameraRects) {
                if (cam.name === camName) continue;
                if ((cam.zIndex || 1) <= myZIndex) continue;

                // Check if this higher camera overlaps horizontally with our camera
                if (cam.x < visibleRight && cam.x + cam.w > visibleX) {
                    // This camera overlaps horizontally - check where it ends vertically
                    const camBottom = cam.y + cam.h;
                    if (camBottom > occlusionBottom && cam.y < visibleBottom) {
                        occlusionBottom = Math.min(camBottom, visibleBottom);
                    }
                }
            }

            // Calculate the non-occluded visible area
            const nonOccludedTop = Math.max(visibleY, occlusionBottom);
            const nonOccludedHeight = visibleBottom - nonOccludedTop;

            // If there's enough space below the occluding cameras, position label there
            // This matches the live view behavior where labels appear below overlapping cameras
            let bestPos;
            if (nonOccludedHeight >= labelHeight + offset * 2 && nonOccludedTop > visibleY) {
                // Use top-left of the non-occluded area (below higher z-index cameras)
                bestPos = { x: visibleX + offset, y: nonOccludedTop + offset, name: 'non-occluded-top-left' };
            } else {
                // Try standard positions: top-left, top-right, bottom-left, bottom-right
                bestPos = positions[0];
                for (const pos of positions) {
                    const labelRect = {
                        x: pos.x,
                        y: pos.y,
                        w: labelWidth,
                        h: labelHeight
                    };

                    // Check if this position is covered by a higher z-index camera
                    let isOccluded = false;
                    for (const cam of cameraRects) {
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

                    // Also check if occluded by mini-map overlay
                    if (!isOccluded && miniMapRect) {
                        if (labelRect.x < miniMapRect.x + miniMapRect.w &&
                            labelRect.x + labelRect.w > miniMapRect.x &&
                            labelRect.y < miniMapRect.y + miniMapRect.h &&
                            labelRect.y + labelRect.h > miniMapRect.y) {
                            isOccluded = true;
                        }
                    }

                    if (!isOccluded) {
                        bestPos = pos;
                        break;
                    }
                }
            }

            // Draw rounded rectangle background matching CSS --glass
            const bgX = bestPos.x;
            const bgY = bestPos.y;

            ctx.beginPath();
            ctx.roundRect(bgX, bgY, labelWidth, labelHeight, borderRadius);

            // Fill with CSS-matching colors
            if (isEnded) {
                // Ended state: rgba(255, 59, 59, 0.85) from CSS .video-label.ended
                ctx.fillStyle = 'rgba(255, 59, 59, 0.85)';
            } else {
                // Normal state: rgba(15, 18, 24, 0.85) from CSS --glass
                ctx.fillStyle = 'rgba(15, 18, 24, 0.85)';
            }
            ctx.fill();

            // Draw border matching CSS --glass-border
            ctx.strokeStyle = isEnded ? 'rgba(255, 59, 59, 0.5)' : 'rgba(255, 255, 255, 0.08)';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Draw text with letter spacing
            ctx.fillStyle = '#e8eaed';  // CSS --text-primary
            this.drawTextWithLetterSpacing(ctx, label, bgX + paddingX, bgY + paddingY, letterSpacing);
        }
    }

    /**
     * Draw text with letter spacing (canvas doesn't support letter-spacing natively)
     * @param {CanvasRenderingContext2D} ctx
     * @param {string} text
     * @param {number} x
     * @param {number} y
     * @param {number} spacing
     */
    drawTextWithLetterSpacing(ctx, text, x, y, spacing) {
        let currentX = x;
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            ctx.fillText(char, currentX, y);
            const charWidth = ctx.measureText(char).width;
            currentX += charWidth + spacing;
        }
    }

    /**
     * Create a preview element for the layout editor
     * @param {Object} config - LayoutConfig object
     * @param {number} width - Preview container width
     * @param {number} height - Preview container height
     * @returns {HTMLElement}
     */
    createPreviewElement(config, width = 400, height = 300) {
        const container = document.createElement('div');
        container.className = 'layout-preview';
        container.style.cssText = `
            position: relative;
            width: ${width}px;
            background: #1a1a1a;
            border: 1px solid var(--border);
            border-radius: 4px;
            overflow: hidden;
        `;

        // Set aspect ratio
        const aspectRatio = config.canvas?.aspectRatio || '4:3';
        const arParts = LayoutConfig.ASPECT_RATIOS[aspectRatio] || { width: 4, height: 3 };
        container.style.aspectRatio = `${arParts.width} / ${arParts.height}`;

        // Create camera placeholders
        for (const camName of LayoutConfig.CAMERAS) {
            const camConfig = config.cameras?.[camName];
            if (!camConfig || !camConfig.enabled) continue;

            const pos = camConfig.position;
            const placeholder = document.createElement('div');
            placeholder.className = 'layout-preview-camera';
            placeholder.dataset.camera = camName;
            placeholder.style.cssText = `
                position: absolute;
                left: ${pos.x}%;
                top: ${pos.y}%;
                width: ${pos.width}%;
                height: ${pos.height}%;
                background: var(--bg-tertiary);
                border: 2px solid var(--border);
                border-radius: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 12px;
                color: var(--text-secondary);
                z-index: ${camConfig.zIndex || 1};
                cursor: move;
                user-select: none;
                box-sizing: border-box;
            `;

            // Apply cropping visualization
            const crop = camConfig.crop || { top: 0, right: 0, bottom: 0, left: 0 };
            if (crop.top > 0 || crop.right > 0 || crop.bottom > 0 || crop.left > 0) {
                placeholder.style.clipPath = `inset(${crop.top}% ${crop.right}% ${crop.bottom}% ${crop.left}%)`;
            }

            placeholder.textContent = LayoutConfig.CAMERA_SHORT_NAMES[camName] || camName;

            container.appendChild(placeholder);
        }

        return container;
    }

    /**
     * Get visible cameras count from config
     */
    getVisibleCameraCount(config) {
        if (!config?.cameras) return 0;
        return Object.values(config.cameras).filter(c => c.enabled).length;
    }

    /**
     * Get enabled cameras list
     */
    getEnabledCameras(config) {
        if (!config?.cameras) return [];
        return Object.entries(config.cameras)
            .filter(([name, cam]) => cam.enabled)
            .map(([name]) => name);
    }
}

// Export for use in other modules
window.LayoutRenderer = LayoutRenderer;
