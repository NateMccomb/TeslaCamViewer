/**
 * InsuranceReport - Generates PDF reports for insurance claims
 * Uses jsPDF for client-side PDF generation
 */

class InsuranceReport {
    constructor(videoPlayer, screenshotCapture) {
        this.videoPlayer = videoPlayer;
        this.screenshotCapture = screenshotCapture;
        this.isGenerating = false;
        this.onProgress = null;

        // PDF dimensions (A4 in points: 595.28 x 841.89)
        this.pageWidth = 595.28;
        this.pageHeight = 841.89;
        this.margin = 40;
        this.contentWidth = this.pageWidth - (this.margin * 2);
    }

    /**
     * Set progress callback
     * @param {Function} callback - Function to call with progress updates (0-100)
     */
    setProgressCallback(callback) {
        this.onProgress = callback;
    }

    /**
     * Report progress to callback
     * @param {number} percent - Progress percentage (0-100)
     * @param {string} message - Status message
     */
    _reportProgress(percent, message) {
        if (this.onProgress) {
            this.onProgress(percent, message);
        }
        console.log(`[InsuranceReport] ${percent}%: ${message}`);
    }

    /**
     * Generate insurance report PDF for current event
     * @param {Object} options - Generation options
     * @returns {Promise<void>}
     */
    async generateReport(options = {}) {
        if (this.isGenerating) {
            throw new Error('Report generation already in progress');
        }

        const event = this.videoPlayer.currentEvent;
        if (!event) {
            throw new Error('No event loaded');
        }

        // Check if jsPDF is available
        if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined') {
            throw new Error('jsPDF library not loaded. Please check your internet connection and reload the page.');
        }

        this.isGenerating = true;
        this._reportProgress(0, 'Starting report generation...');

        try {
            // Get jsPDF constructor
            const { jsPDF } = window.jspdf || { jsPDF: window.jsPDF };

            // Create PDF document
            const doc = new jsPDF({
                orientation: 'portrait',
                unit: 'pt',
                format: 'a4'
            });

            let yPosition = this.margin;

            // === FETCH WEATHER DATA (async, early) ===
            this._reportProgress(2, 'Fetching weather data...');
            this._weatherData = await this._fetchWeatherData(event);

            // === HEADER SECTION ===
            this._reportProgress(5, 'Adding header...');
            yPosition = this._addHeader(doc, yPosition);

            // === EVENT INFO SECTION ===
            this._reportProgress(10, 'Adding event information...');
            yPosition = this._addEventInfo(doc, event, yPosition);

            // === LOCATION SECTION ===
            this._reportProgress(20, 'Adding location details...');
            yPosition = await this._addLocationSection(doc, event, yPosition);

            // === KEY FRAMES SECTION ===
            this._reportProgress(35, 'Capturing video frames...');
            const keyFramesResult = await this._addKeyFramesSection(doc, event, yPosition, options);
            yPosition = keyFramesResult.yPosition;
            const evidenceMarkers = keyFramesResult.frameTimes || [];

            // === SENTRY TRIGGER ANALYSIS (for Sentry events only) ===
            if (event.type === 'SentryClips') {
                this._reportProgress(50, 'Analyzing sentry trigger...');
                yPosition = await this._addSentryTriggerSection(doc, event, yPosition);
            }

            // === TELEMETRY SECTION ===
            this._reportProgress(60, 'Adding telemetry data...');
            yPosition = await this._addTelemetrySection(doc, yPosition, evidenceMarkers);

            // === INCIDENT ANALYSIS SECTION ===
            this._reportProgress(75, 'Analyzing incident data...');
            yPosition = await this._addIncidentAnalysisSection(doc, yPosition);

            // === RECORDING INFO SECTION ===
            this._reportProgress(82, 'Adding recording info...');
            yPosition = this._addRecordingInfoSection(doc, event, yPosition);

            // === TIMELINE OF EVENTS ===
            this._reportProgress(88, 'Adding timeline...');
            yPosition = this._addTimelineSection(doc, event, yPosition);

            // === FOOTER ===
            this._reportProgress(95, 'Adding footer...');
            this._addFooter(doc);

            // Save PDF
            this._reportProgress(98, 'Generating PDF file...');
            const filename = this._generateFilename(event);
            doc.save(filename);

            this._reportProgress(100, 'Report generated successfully!');
        } catch (error) {
            console.error('[InsuranceReport] Error generating report:', error);
            throw error;
        } finally {
            this.isGenerating = false;
        }
    }

    /**
     * Add header with branding
     * @param {jsPDF} doc
     * @param {number} y - Current Y position
     * @returns {number} - New Y position
     */
    _addHeader(doc, y) {
        // Logo/Title area
        doc.setFillColor(26, 26, 26);
        doc.rect(0, 0, this.pageWidth, 80, 'F');

        // TeslaCamViewer branding
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(24);
        doc.setTextColor(0, 212, 255); // Accent color
        doc.text('TeslaCamViewer.com', this.margin, 45);

        // Subtitle
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(12);
        doc.setTextColor(200, 200, 200);
        doc.text('Dashcam Incident Report', this.margin, 65);

        // Report generation timestamp
        const now = new Date();
        doc.setFontSize(10);
        doc.setTextColor(150, 150, 150);
        const dateStr = now.toLocaleDateString() + ' ' + now.toLocaleTimeString();
        doc.text(`Generated: ${dateStr}`, this.pageWidth - this.margin - 120, 65);

        return 100;
    }

    /**
     * Add event information section
     * @param {jsPDF} doc
     * @param {Object} event
     * @param {number} y
     * @returns {number}
     */
    _addEventInfo(doc, event, y) {
        // Section title
        y = this._addSectionTitle(doc, 'Event Information', y);

        const eventDate = new Date(event.timestamp);
        const dateStr = eventDate.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        const timeStr = eventDate.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        // Event category (Sentry, Saved, Recent)
        const eventCategory = this._formatEventCategory(event.type);

        // Get trigger reason from event or metadata
        const triggerReason = event.reason || event.metadata?.reason;

        // Info rows
        const info = [
            { label: 'Event Category:', value: eventCategory },
            { label: 'Date:', value: dateStr },
            { label: 'Time:', value: timeStr },
            { label: 'Folder Name:', value: event.name || 'Unknown' }
        ];

        // Add trigger reason if available
        if (triggerReason) {
            info.push({
                label: 'Trigger Reason:',
                value: this._formatTriggerReason(triggerReason)
            });
        }

        // Add sentry-specific information
        if (event.type === 'SentryClips') {
            // Calculate sentry trigger time (typically 1 minute before end of recording)
            const totalDuration = this.videoPlayer?.cachedClipDurations?.reduce((a, b) => a + b, 0) ||
                (event.clips?.length || 10) * 60;
            const sentryTriggerTime = Math.max(0, totalDuration - 60);

            // Store for use in other sections
            this._sentryTriggerTime = sentryTriggerTime;
            this._sentryTotalDuration = totalDuration;

            info.push({
                label: 'Trigger Time:',
                value: `${this._formatTime(sentryTriggerTime)} into recording (approx. 1 min before end)`
            });

            // Add triggering camera
            if (event.metadata?.camera) {
                // Handle both string names and numeric camera IDs
                const cameraMap = {
                    // String names
                    'front': 'Front Camera',
                    'back': 'Rear Camera',
                    'left_repeater': 'Left Side (Repeater)',
                    'right_repeater': 'Right Side (Repeater)',
                    'left_pillar': 'Left Pillar Camera',
                    'right_pillar': 'Right Pillar Camera',
                    // Numeric IDs (Tesla internal)
                    '0': 'Front Camera',
                    '1': 'Rear Camera',
                    '2': 'Front Wide Camera',
                    '3': 'Cabin Camera',
                    '4': 'Left Pillar Camera',
                    '5': 'Left Side (Repeater)',
                    '6': 'Right Side (Repeater)',
                    '7': 'Right Pillar Camera'
                };
                const camId = String(event.metadata.camera);
                const triggerCamera = cameraMap[camId] || `Camera ${camId}`;
                info.push({
                    label: 'Triggered By:',
                    value: triggerCamera
                });
            }
        }

        // Get GPS from telemetry first, then fall back to event metadata
        let { start: startGps, end: endGps } = this._getStartEndGPS();

        // For sentry events or when telemetry GPS not available, use event metadata
        if (!startGps && (event.est_lat || event.metadata?.est_lat)) {
            const lat = event.est_lat || event.metadata?.est_lat;
            const lon = event.est_lon || event.metadata?.est_lon;
            if (lat && lon) {
                startGps = { lat: parseFloat(lat), lon: parseFloat(lon) };
                // For sentry (parked car), start and end are same location
                if (event.type === 'SentryClips') {
                    endGps = startGps;
                }
            }
        }

        if (startGps) {
            const label = event.type === 'SentryClips' ? 'Location:' : 'Start Location:';
            info.push({
                label: label,
                value: `${parseFloat(startGps.lat).toFixed(6)}, ${parseFloat(startGps.lon).toFixed(6)}`
            });
        }

        if (endGps && event.type !== 'SentryClips') {
            info.push({
                label: 'End Location:',
                value: `${parseFloat(endGps.lat).toFixed(6)}, ${parseFloat(endGps.lon).toFixed(6)}`
            });
        }

        // Draw info table
        doc.setFontSize(11);
        for (const row of info) {
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(100, 100, 100);
            doc.text(row.label, this.margin, y);

            doc.setFont('helvetica', 'normal');
            doc.setTextColor(50, 50, 50);
            doc.text(row.value, this.margin + 120, y);
            y += 18;
        }

        return y + 15;
    }

    /**
     * Add location section with route map if available
     * @param {jsPDF} doc
     * @param {Object} event
     * @param {number} y
     * @returns {Promise<number>}
     */
    async _addLocationSection(doc, event, y) {
        // Check if we need a new page
        if (y > this.pageHeight - 250) {
            doc.addPage();
            y = this.margin;
        }

        y = this._addSectionTitle(doc, 'Location Details', y);

        // Get GPS from telemetry first, then fall back to event metadata
        let { start: startGps, end: endGps } = this._getStartEndGPS();
        const isSentryEvent = event.type === 'SentryClips';

        // For sentry events or when telemetry GPS not available, use event metadata
        if (!startGps && (event.est_lat || event.metadata?.est_lat)) {
            const lat = event.est_lat || event.metadata?.est_lat;
            const lon = event.est_lon || event.metadata?.est_lon;
            if (lat && lon) {
                startGps = { lat: parseFloat(lat), lon: parseFloat(lon) };
                // For sentry (parked car), start and end are same location
                if (isSentryEvent) {
                    endGps = startGps;
                }
            }
        }

        if (isSentryEvent && startGps) {
            // Sentry event - single location (vehicle was parked)
            let locationAddress = 'Location not available';
            try {
                const geocoded = await this._reverseGeocode(startGps.lat, startGps.lon);
                if (geocoded) {
                    locationAddress = geocoded;
                } else {
                    locationAddress = `GPS: ${startGps.lat.toFixed(6)}, ${startGps.lon.toFixed(6)}`;
                }
            } catch (e) {
                locationAddress = `GPS: ${startGps.lat.toFixed(6)}, ${startGps.lon.toFixed(6)}`;
            }

            doc.setFontSize(10);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(0, 150, 200); // Blue for sentry location
            doc.text('LOCATION:', this.margin, y);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(50, 50, 50);
            const locLines = doc.splitTextToSize(locationAddress, this.contentWidth - 65);
            doc.text(locLines, this.margin + 65, y);
            y += locLines.length * 12 + 8;

            doc.setFontSize(9);
            doc.setTextColor(100, 100, 100);
            doc.setFont('helvetica', 'italic');
            doc.text('(Vehicle was parked - Sentry Mode event)', this.margin, y);
            y += 15;
        } else {
            // Driving event - start and end locations
            // Get start address
            let startAddress = 'Start location not available';
            if (startGps) {
                try {
                    const geocoded = await this._reverseGeocode(startGps.lat, startGps.lon);
                    if (geocoded) {
                        startAddress = geocoded;
                    } else {
                        startAddress = `GPS: ${startGps.lat.toFixed(6)}, ${startGps.lon.toFixed(6)}`;
                    }
                } catch (e) {
                    startAddress = `GPS: ${startGps.lat.toFixed(6)}, ${startGps.lon.toFixed(6)}`;
                }
            }

            // Get end address
            let endAddress = 'End location not available';
            if (endGps) {
                try {
                    const geocoded = await this._reverseGeocode(endGps.lat, endGps.lon);
                    if (geocoded) {
                        endAddress = geocoded;
                    } else {
                        endAddress = `GPS: ${endGps.lat.toFixed(6)}, ${endGps.lon.toFixed(6)}`;
                    }
                } catch (e) {
                    endAddress = `GPS: ${endGps.lat.toFixed(6)}, ${endGps.lon.toFixed(6)}`;
                }
            }

            // Start location
            doc.setFontSize(10);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(76, 175, 80); // Green for start
            doc.text('START:', this.margin, y);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(50, 50, 50);
            const startLines = doc.splitTextToSize(startAddress, this.contentWidth - 50);
            doc.text(startLines, this.margin + 45, y);
            y += startLines.length * 12 + 8;

            // End location
            doc.setFontSize(10);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(244, 67, 54); // Red for end
            doc.text('END:', this.margin, y);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(50, 50, 50);
            const endLines = doc.splitTextToSize(endAddress, this.contentWidth - 50);
            doc.text(endLines, this.margin + 45, y);
            y += endLines.length * 12 + 15;
        }

        // Try to render map
        const telemetryOverlay = window.app?.telemetryOverlay;
        const clipMarking = window.app?.clipMarking;
        const marks = clipMarking?.getMarks() || { inPoint: null, outPoint: null };
        const timeRange = (marks.inPoint !== null && marks.outPoint !== null)
            ? { start: marks.inPoint, end: marks.outPoint }
            : null;

        let gpsPoints = [];
        if (telemetryOverlay?.clipSeiData) {
            gpsPoints = this._collectGPSPoints(telemetryOverlay, timeRange);
            console.log(`[InsuranceReport] Location section: collected ${gpsPoints.length} GPS points`);
        }

        // Render route map if we have multiple GPS points
        if (gpsPoints.length >= 2) {
            try {
                const mapHeight = 180;
                const mapWidth = this.contentWidth;

                // Check if map fits on current page
                if (y + mapHeight > this.pageHeight - this.margin) {
                    doc.addPage();
                    y = this.margin;
                }

                const routeMapImage = await this._renderRouteMap(gpsPoints, mapWidth, mapHeight);
                if (routeMapImage) {
                    doc.addImage(routeMapImage, 'PNG', this.margin, y, mapWidth, mapHeight);
                    y += mapHeight + 10;

                    // Map caption
                    doc.setFontSize(9);
                    doc.setTextColor(100, 100, 100);
                    doc.setFont('helvetica', 'italic');
                    doc.text('Route map showing vehicle path. Green = Start, Red = End', this.margin, y);
                    y += 15;
                }
            } catch (e) {
                console.warn('[InsuranceReport] Route map render failed:', e);
            }
        } else if (startGps) {
            // Render single-point location map for sentry events or when no route
            try {
                const mapHeight = 150;
                const mapWidth = this.contentWidth;

                // Check if map fits on current page
                if (y + mapHeight > this.pageHeight - this.margin) {
                    doc.addPage();
                    y = this.margin;
                }

                const locationMapImage = await this._renderLocationMap(startGps, mapWidth, mapHeight);
                if (locationMapImage) {
                    doc.addImage(locationMapImage, 'PNG', this.margin, y, mapWidth, mapHeight);
                    y += mapHeight + 10;

                    // Map caption
                    doc.setFontSize(9);
                    doc.setTextColor(100, 100, 100);
                    doc.setFont('helvetica', 'italic');
                    const caption = isSentryEvent
                        ? 'Location map showing where Sentry event occurred'
                        : 'Location map showing event position';
                    doc.text(caption, this.margin, y);
                    y += 15;
                }
            } catch (e) {
                console.warn('[InsuranceReport] Location map render failed:', e);
            }
        }

        return y + 10;
    }

    /**
     * Add key frames section with video screenshots
     * @param {jsPDF} doc
     * @param {Object} event
     * @param {number} y
     * @param {Object} options
     * @returns {Promise<{yPosition: number, frameTimes: Array}>}
     */
    async _addKeyFramesSection(doc, event, y, options) {
        // Check if we need a new page
        if (y > this.pageHeight - 300) {
            doc.addPage();
            y = this.margin;
        }

        y = this._addSectionTitle(doc, 'Video Evidence', y);

        // Get frame capture times
        const frameTimes = await this._determineFrameTimes(options);
        const frameImages = [];

        for (let i = 0; i < frameTimes.length; i++) {
            const frame = frameTimes[i];
            this._reportProgress(35 + (i / frameTimes.length * 30), `Capturing frame: ${frame.label}...`);

            try {
                // Seek to time and capture frame
                await this.videoPlayer.seekToEventTime(frame.time);

                // Wait for all videos to be ready (not just a fixed delay)
                await this._waitForAllVideosReady();

                const imageData = await this._captureCurrentFrame();
                if (imageData) {
                    frameImages.push({
                        image: imageData,
                        label: frame.label,
                        time: frame.time
                    });
                }
            } catch (e) {
                console.warn(`[InsuranceReport] Failed to capture frame at ${frame.time}:`, e);
            }
        }

        // Add frames to PDF (2 per row)
        const imgWidth = (this.contentWidth - 10) / 2;
        const imgHeight = imgWidth * 0.75; // 4:3 aspect ratio

        for (let i = 0; i < frameImages.length; i++) {
            const frame = frameImages[i];
            const isLeftColumn = i % 2 === 0;
            const x = isLeftColumn ? this.margin : this.margin + imgWidth + 10;

            // Check if we need a new page
            if (isLeftColumn && y + imgHeight + 30 > this.pageHeight - this.margin) {
                doc.addPage();
                y = this.margin;
            }

            // Frame image
            doc.addImage(frame.image, 'PNG', x, y, imgWidth, imgHeight);

            // Frame label with number
            doc.setFontSize(9);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(50, 50, 50);
            doc.text(`${i + 1}. ${frame.label}`, x, y + imgHeight + 12);

            // Time caption
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(100, 100, 100);
            doc.text(this._formatTime(frame.time), x + 100, y + imgHeight + 12);

            // Move to next row if we completed a pair
            if (!isLeftColumn || i === frameImages.length - 1) {
                y += imgHeight + 25;
            }
        }

        // Return both position and frame times for use in route map
        return {
            yPosition: y + 10,
            frameTimes: frameTimes.map((f, i) => ({ time: f.time, label: `${i + 1}. ${f.label}` }))
        };
    }

    /**
     * Add Sentry Trigger Analysis section for sentry events
     * Focuses on the exact moment the sentry event was triggered
     * @param {jsPDF} doc
     * @param {Object} event
     * @param {number} y
     * @returns {Promise<number>}
     */
    async _addSentryTriggerSection(doc, event, y) {
        // Check if we need a new page
        if (y > this.pageHeight - 350) {
            doc.addPage();
            y = this.margin;
        }

        y = this._addSectionTitle(doc, 'Sentry Trigger Analysis', y);

        // Get trigger time (calculated in _addEventInfo and stored)
        const triggerTime = this._sentryTriggerTime || 0;
        const totalDuration = this._sentryTotalDuration || 0;
        const triggerReason = event.reason || event.metadata?.reason;

        // Highlighted warning box
        const boxHeight = 70;
        doc.setFillColor(255, 248, 225); // Light yellow
        doc.rect(this.margin, y - 5, this.contentWidth, boxHeight, 'F');
        doc.setDrawColor(255, 152, 0); // Orange border
        doc.setLineWidth(1.5);
        doc.rect(this.margin, y - 5, this.contentWidth, boxHeight, 'S');

        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(230, 81, 0);
        doc.text('SENTRY MODE TRIGGER DETECTED', this.margin + 10, y + 10);

        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(50, 50, 50);
        doc.text(`Trigger Time: ${this._formatTime(triggerTime)} into recording`, this.margin + 10, y + 25);

        if (triggerReason) {
            const reasonText = this._formatTriggerReason(triggerReason);
            const reasonLines = doc.splitTextToSize(`Reason: ${reasonText}`, this.contentWidth - 20);
            doc.text(reasonLines, this.margin + 10, y + 38);
        }

        doc.setFontSize(9);
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(100, 100, 100);
        doc.text('Tesla typically saves 10 minutes of footage, with the trigger occurring ~1 minute before the end.', this.margin + 10, y + 55);

        y += boxHeight + 15;

        // Capture frames around the trigger moment
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(50, 50, 50);
        doc.text('Frames Around Trigger Moment', this.margin, y);
        y += 15;

        // Define frame times around trigger: -10s, -5s, -2s, trigger, +2s, +5s
        const triggerFrameTimes = [
            { time: Math.max(0, triggerTime - 10), label: '10 sec before trigger' },
            { time: Math.max(0, triggerTime - 5), label: '5 sec before trigger' },
            { time: Math.max(0, triggerTime - 2), label: '2 sec before trigger' },
            { time: triggerTime, label: '>>> TRIGGER MOMENT <<<', isHighlight: true },
            { time: Math.min(totalDuration, triggerTime + 2), label: '2 sec after trigger' },
            { time: Math.min(totalDuration, triggerTime + 5), label: '5 sec after trigger' }
        ];

        // Determine which camera triggered the event
        const triggerCameraId = event.metadata?.camera;
        const cameraIdToVideoKey = {
            // String names
            'front': 'front',
            'back': 'back',
            'left_repeater': 'left_repeater',
            'right_repeater': 'right_repeater',
            'left_pillar': 'left_pillar',
            'right_pillar': 'right_pillar',
            // Numeric IDs
            '0': 'front',
            '1': 'back',
            '5': 'left_repeater',
            '6': 'right_repeater',
            '4': 'left_pillar',
            '7': 'right_pillar'
        };
        const triggerCameraKey = cameraIdToVideoKey[String(triggerCameraId)] || 'front';
        const triggerVideo = this.videoPlayer?.videos?.[triggerCameraKey];

        // Camera display names
        const cameraDisplayNames = {
            'front': 'Front Camera',
            'back': 'Rear Camera',
            'left_repeater': 'Left Repeater',
            'right_repeater': 'Right Repeater',
            'left_pillar': 'Left Pillar',
            'right_pillar': 'Right Pillar'
        };
        const triggerCameraName = cameraDisplayNames[triggerCameraKey] || 'Front Camera';

        // Show which camera we're displaying
        doc.setFontSize(9);
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(100, 100, 100);
        doc.text(`(Showing frames from ${triggerCameraName} - the camera that detected the trigger)`, this.margin, y);
        y += 12;

        // Capture frames from the triggering camera
        const frameImages = [];

        if (triggerVideo) {
            for (const frameInfo of triggerFrameTimes) {
                try {
                    await this.videoPlayer.seekToEventTime(frameInfo.time);
                    await new Promise(resolve => setTimeout(resolve, 150));

                    const canvas = document.createElement('canvas');
                    canvas.width = triggerVideo.videoWidth;
                    canvas.height = triggerVideo.videoHeight;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(triggerVideo, 0, 0);

                    // Add red border for trigger moment
                    if (frameInfo.isHighlight) {
                        ctx.strokeStyle = '#ff0000';
                        ctx.lineWidth = 8;
                        ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
                    }

                    // Add camera label in corner
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
                    ctx.fillRect(0, 0, 120, 24);
                    ctx.font = 'bold 14px Arial';
                    ctx.fillStyle = '#fff';
                    ctx.fillText(triggerCameraName, 8, 17);

                    frameImages.push({
                        dataUrl: canvas.toDataURL('image/jpeg', 0.85),
                        ...frameInfo
                    });
                } catch (e) {
                    console.warn(`[InsuranceReport] Failed to capture trigger frame at ${frameInfo.time}:`, e);
                }
            }
        }

        // Display frames in 3x2 grid
        if (frameImages.length > 0) {
            const imgWidth = (this.contentWidth - 15) / 3;
            const imgHeight = imgWidth * 0.5625; // 16:9 ratio

            for (let i = 0; i < frameImages.length; i++) {
                const frame = frameImages[i];
                const col = i % 3;
                const row = Math.floor(i / 3);

                if (row > 0 && col === 0) {
                    y += imgHeight + 25;
                }

                // Check for page break
                if (y + imgHeight + 20 > this.pageHeight - this.margin) {
                    doc.addPage();
                    y = this.margin;
                }

                const x = this.margin + col * (imgWidth + 7.5);

                // Add image
                doc.addImage(frame.dataUrl, 'JPEG', x, y, imgWidth, imgHeight);

                // Add red border indicator for trigger moment
                if (frame.isHighlight) {
                    doc.setDrawColor(255, 0, 0);
                    doc.setLineWidth(2);
                    doc.rect(x, y, imgWidth, imgHeight, 'S');
                }

                // Frame label
                doc.setFontSize(8);
                doc.setFont('helvetica', frame.isHighlight ? 'bold' : 'normal');
                doc.setTextColor(frame.isHighlight ? 200 : 50, frame.isHighlight ? 0 : 50, frame.isHighlight ? 0 : 50);
                doc.text(frame.label, x, y + imgHeight + 8);

                // Time
                doc.setFont('helvetica', 'normal');
                doc.setTextColor(100, 100, 100);
                doc.text(this._formatTime(frame.time), x + imgWidth - 25, y + imgHeight + 8);
            }

            y += imgHeight + 25;
        }

        // Add telemetry at trigger moment
        const telemetryOverlay = window.app?.telemetryOverlay;
        if (telemetryOverlay?.clipSeiData) {
            y += 10;
            doc.setFontSize(11);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(50, 50, 50);
            doc.text('Telemetry at Trigger Moment', this.margin, y);
            y += 15;

            // Get telemetry data at trigger time
            const triggerData = this._getTelemetryAtTime(telemetryOverlay, triggerTime);

            if (triggerData) {
                const telemetryItems = [];

                if (triggerData.speed !== undefined) {
                    telemetryItems.push(`Speed: ${triggerData.speed.toFixed(1)} mph`);
                }
                if (triggerData.gForce !== undefined) {
                    telemetryItems.push(`G-Force: ${triggerData.gForce.toFixed(2)} G`);
                }
                if (triggerData.lateralG !== undefined) {
                    telemetryItems.push(`Lateral G: ${triggerData.lateralG.toFixed(2)} G`);
                }
                if (triggerData.brake !== undefined && triggerData.brake > 0) {
                    telemetryItems.push(`Brake Pressure: ${triggerData.brake.toFixed(0)}%`);
                }

                doc.setFontSize(10);
                doc.setFont('helvetica', 'normal');
                doc.setTextColor(50, 50, 50);

                if (telemetryItems.length > 0) {
                    doc.text(telemetryItems.join('  |  '), this.margin, y);
                    y += 15;
                } else {
                    doc.setTextColor(100, 100, 100);
                    doc.text('Vehicle was stationary (parked) at trigger time.', this.margin, y);
                    y += 15;
                }
            } else {
                doc.setFontSize(10);
                doc.setTextColor(100, 100, 100);
                doc.text('No telemetry data available at trigger moment.', this.margin, y);
                y += 15;
            }
        }

        return y + 10;
    }

    /**
     * Get telemetry data at a specific time
     * @param {TelemetryOverlay} telemetryOverlay
     * @param {number} targetTime
     * @returns {Object|null}
     */
    _getTelemetryAtTime(telemetryOverlay, targetTime) {
        if (!telemetryOverlay?.clipSeiData) return null;

        const cachedDurations = this.videoPlayer?.cachedClipDurations || [];
        const defaultDuration = 60;

        // Pre-calculate cumulative times
        const clipStartTimes = [0];
        for (let i = 0; i < cachedDurations.length; i++) {
            clipStartTimes.push(clipStartTimes[i] + (cachedDurations[i] || defaultDuration));
        }

        let closestData = null;
        let closestDiff = Infinity;

        const clipEntries = [];
        for (const [key, data] of telemetryOverlay.clipSeiData) {
            const clipIndex = parseInt(key.split('_')[0]) || 0;
            clipEntries.push({ clipIndex, key, data });
        }
        clipEntries.sort((a, b) => a.clipIndex - b.clipIndex);

        for (const { clipIndex, data } of clipEntries) {
            const frames = data?.frames || data;
            if (!frames || !Array.isArray(frames)) continue;

            const clipStartTime = clipStartTimes[clipIndex] || (clipIndex * defaultDuration);

            for (const frame of frames) {
                const absoluteTime = clipStartTime + (frame.media_timestamp || 0);
                const diff = Math.abs(absoluteTime - targetTime);

                if (diff < closestDiff) {
                    closestDiff = diff;
                    closestData = {
                        time: absoluteTime,
                        speed: frame.vehicle_speed,
                        gForce: frame.acc_x ? Math.sqrt(frame.acc_x ** 2 + (frame.acc_y || 0) ** 2 + (frame.acc_z || 0) ** 2) / 9.81 : undefined,
                        lateralG: frame.acc_y ? Math.abs(frame.acc_y) / 9.81 : undefined,
                        brake: frame.brake_pedal,
                        throttle: frame.accelerator_pedal
                    };
                }
            }
        }

        return closestData;
    }

    /**
     * Add telemetry summary section
     * @param {jsPDF} doc
     * @param {number} y
     * @param {Array} evidenceMarkers - Optional array of {time, label} for video evidence markers
     * @returns {Promise<number>}
     */
    async _addTelemetrySection(doc, y, evidenceMarkers = []) {
        const telemetryOverlay = window.app?.telemetryOverlay;

        if (!telemetryOverlay || !telemetryOverlay.hasTelemetryData()) {
            // No telemetry data available
            return y;
        }

        // Get IN/OUT marks to filter data
        const clipMarking = window.app?.clipMarking;
        const marks = clipMarking?.getMarks() || { inPoint: null, outPoint: null };
        const timeRange = (marks.inPoint !== null && marks.outPoint !== null)
            ? { start: marks.inPoint, end: marks.outPoint }
            : null;

        if (timeRange) {
            console.log(`[InsuranceReport] Using IN/OUT range: ${timeRange.start.toFixed(1)}s - ${timeRange.end.toFixed(1)}s`);
        }

        // Check if we need a new page
        if (y > this.pageHeight - 200) {
            doc.addPage();
            y = this.margin;
        }

        y = this._addSectionTitle(doc, 'Telemetry Summary', y);

        // Get telemetry statistics (filtered to IN/OUT range if available)
        const stats = this._analyzeTelemetryData(telemetryOverlay, timeRange);

        if (!stats) {
            doc.setFontSize(10);
            doc.setTextColor(100, 100, 100);
            doc.text('No telemetry data available for this event.', this.margin, y);
            return y + 20;
        }

        // Create telemetry table
        const telemetryData = [
            { label: 'Maximum Speed:', value: `${stats.maxSpeed.toFixed(1)} mph` },
            { label: 'Average Speed:', value: `${stats.avgSpeed.toFixed(1)} mph` },
            { label: 'Maximum G-Force:', value: `${stats.maxGForce.toFixed(2)} G` },
            { label: 'Maximum Lateral G:', value: `${stats.maxLateralG.toFixed(2)} G` },
            { label: 'Hard Braking Events:', value: `${stats.hardBrakingCount}` }
        ];

        if (stats.autopilotActive) {
            telemetryData.push({ label: 'Autopilot Status:', value: stats.autopilotMode });
        }

        doc.setFontSize(11);
        for (const row of telemetryData) {
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(100, 100, 100);
            doc.text(row.label, this.margin, y);

            doc.setFont('helvetica', 'normal');
            doc.setTextColor(50, 50, 50);
            doc.text(row.value, this.margin + 140, y);
            y += 18;
        }

        // Add note about G-forces
        y += 5;
        doc.setFontSize(9);
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(100, 100, 100);
        const noteText = 'Note: G-force values above 0.4G typically indicate hard acceleration/braking, above 0.6G suggests emergency maneuvers.';
        const noteLines = doc.splitTextToSize(noteText, this.contentWidth);
        doc.text(noteLines, this.margin, y);
        y += noteLines.length * 12 + 15;

        // Add telemetry graphs (filtered to IN/OUT range if available)
        y = await this._addTelemetryGraphs(doc, telemetryOverlay, y, timeRange, evidenceMarkers);

        return y + 15;
    }

    /**
     * Add telemetry graphs (speed and g-force) to the report
     * @param {jsPDF} doc
     * @param {TelemetryOverlay} telemetryOverlay
     * @param {number} y
     * @param {Object} timeRange - Optional {start, end} to filter data to IN/OUT range
     * @param {Array} evidenceMarkers - Optional array of {time, label} for video evidence markers
     * @returns {Promise<number>}
     */
    async _addTelemetryGraphs(doc, telemetryOverlay, y, timeRange = null, evidenceMarkers = []) {
        // Collect all telemetry data points (filtered to time range if provided)
        const allPoints = this._collectAllTelemetryPoints(telemetryOverlay, timeRange);
        console.log(`[InsuranceReport] Collected ${allPoints.length} telemetry points for graphs`);

        if (!allPoints || allPoints.length < 10) {
            console.log('[InsuranceReport] Not enough telemetry points for graphs');
            return y; // Not enough data for graphs
        }

        // Check if we need a new page
        const graphHeight = 120;
        if (y + graphHeight * 2 + 60 > this.pageHeight - this.margin) {
            doc.addPage();
            y = this.margin;
        }

        y = this._addSectionTitle(doc, 'Telemetry Graphs', y);

        // Render speed graph
        const speedGraphImage = this._renderSpeedGraph(allPoints, this.contentWidth, graphHeight);
        if (speedGraphImage) {
            doc.setFontSize(10);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(50, 50, 50);
            doc.text('Speed Over Time', this.margin, y);
            y += 12;

            doc.addImage(speedGraphImage, 'PNG', this.margin, y, this.contentWidth, graphHeight);
            y += graphHeight + 15;
        }

        // Check if we need a new page for g-force graph
        if (y + graphHeight + 30 > this.pageHeight - this.margin) {
            doc.addPage();
            y = this.margin;
        }

        // Render G-force graph
        const gforceGraphImage = this._renderGForceGraph(allPoints, this.contentWidth, graphHeight);
        if (gforceGraphImage) {
            doc.setFontSize(10);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(50, 50, 50);
            doc.text('G-Force (Acceleration/Braking)', this.margin, y);
            y += 12;

            doc.addImage(gforceGraphImage, 'PNG', this.margin, y, this.contentWidth, graphHeight);
            y += graphHeight + 10;

            // Add legend
            doc.setFontSize(8);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(100, 100, 100);
            doc.text('Positive = Acceleration | Negative = Braking | Orange line shows longitudinal G-force', this.margin, y);
            y += 12;
        }

        // Add route map if GPS data available (filtered to time range if provided)
        const gpsPoints = this._collectGPSPoints(telemetryOverlay, timeRange);
        console.log(`[InsuranceReport] Collected ${gpsPoints.length} GPS points for route map`);
        if (gpsPoints.length >= 2) {
            // Check if we need a new page
            const mapHeight = 200;
            if (y + mapHeight + 40 > this.pageHeight - this.margin) {
                doc.addPage();
                y = this.margin;
            }

            y += 10;
            doc.setFontSize(10);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(50, 50, 50);
            doc.text('Route Map', this.margin, y);
            y += 12;

            const routeMapImage = await this._renderRouteMap(gpsPoints, this.contentWidth, mapHeight, evidenceMarkers);
            if (routeMapImage) {
                doc.addImage(routeMapImage, 'PNG', this.margin, y, this.contentWidth, mapHeight);
                y += mapHeight + 10;

                // Add legend
                doc.setFontSize(8);
                doc.setFont('helvetica', 'normal');
                doc.setTextColor(100, 100, 100);
                let legendText = 'Route traveled during event. Green = Start, Red = End';
                if (evidenceMarkers && evidenceMarkers.length > 0) {
                    legendText += ', Orange diamonds = Video Evidence locations (1-' + evidenceMarkers.length + ')';
                }
                doc.text(legendText, this.margin, y);
                y += 12;
            }
        }

        return y;
    }

    /**
     * Collect GPS points from telemetry data
     * @param {TelemetryOverlay} telemetryOverlay
     * @param {Object} timeRange - Optional {start, end} to filter data to IN/OUT range
     * @returns {Array}
     */
    _collectGPSPoints(telemetryOverlay, timeRange = null) {
        if (!telemetryOverlay?.clipSeiData) {
            console.log('[InsuranceReport] No clipSeiData available');
            return [];
        }

        console.log(`[InsuranceReport] clipSeiData has ${telemetryOverlay.clipSeiData.size} entries`);
        if (timeRange) {
            console.log(`[InsuranceReport] Filtering GPS to range: ${timeRange.start.toFixed(1)}s - ${timeRange.end.toFixed(1)}s`);
        }

        const gpsPoints = [];

        // Use cached clip durations for accurate timing (not 60-second approximation)
        const cachedDurations = this.videoPlayer?.cachedClipDurations || [];
        const defaultDuration = 60;

        // Pre-calculate cumulative times for each clip using cached durations
        const clipStartTimes = [0];
        for (let i = 0; i < cachedDurations.length; i++) {
            clipStartTimes.push(clipStartTimes[i] + (cachedDurations[i] || defaultDuration));
        }

        // Keys are like "29_2026-01-18_09-41-46-front.mp4" - extract clip index from start
        const clipEntries = [];
        for (const [key, data] of telemetryOverlay.clipSeiData) {
            const clipIndex = parseInt(key.split('_')[0]) || 0;
            clipEntries.push({ clipIndex, key, data });
        }
        clipEntries.sort((a, b) => a.clipIndex - b.clipIndex);

        // Log first entry structure for debugging
        if (clipEntries.length > 0) {
            const firstEntry = clipEntries[0];
            const frames = firstEntry.data?.frames || firstEntry.data;
            console.log(`[InsuranceReport] First clip key: ${firstEntry.key}, has frames: ${Array.isArray(frames)}, count: ${frames?.length || 0}`);
            if (frames && frames.length > 0) {
                const sampleFrame = frames[0];
                console.log('[InsuranceReport] Sample frame fields:', Object.keys(sampleFrame).slice(0, 10).join(', '));
            }
        }

        for (const { clipIndex, data } of clipEntries) {
            // Data has a 'frames' property containing the array
            const frames = data?.frames || data;
            if (!frames || !Array.isArray(frames) || !frames.length) continue;

            // Get base time from pre-calculated cumulative times, or estimate if not available
            const baseTime = clipStartTimes[clipIndex] !== undefined
                ? clipStartTimes[clipIndex]
                : clipIndex * defaultDuration;

            // Get actual clip duration for accurate frame timing
            const clipDuration = cachedDurations[clipIndex] || defaultDuration;

            for (let i = 0; i < frames.length; i++) {
                const frame = frames[i];
                if (frame.latitude_deg && frame.longitude_deg) {
                    // Estimate time within clip based on frame position
                    const timeInClip = (i / frames.length) * clipDuration;
                    const absoluteTime = baseTime + timeInClip;

                    // Filter by time range if provided (with 10s buffer before start for "Before Incident" frame)
                    if (timeRange) {
                        const bufferBefore = 10; // Allow GPS points up to 10s before IN point
                        if (absoluteTime < (timeRange.start - bufferBefore) || absoluteTime > timeRange.end) {
                            continue;
                        }
                    }

                    gpsPoints.push({
                        time: absoluteTime,
                        lat: frame.latitude_deg,
                        lon: frame.longitude_deg,
                        speed: frame.speed_mph || 0
                    });
                }
            }
        }

        // Sort by time
        gpsPoints.sort((a, b) => a.time - b.time);

        // Filter to reduce point density (keep every Nth point based on total)
        const maxPoints = 500;
        if (gpsPoints.length > maxPoints) {
            const step = Math.ceil(gpsPoints.length / maxPoints);
            return gpsPoints.filter((_, i) => i % step === 0 || i === gpsPoints.length - 1);
        }

        return gpsPoints;
    }

    /**
     * Render route map to canvas with OpenStreetMap tiles
     * @param {Array} gpsPoints - GPS coordinates with time
     * @param {number} width - Map width
     * @param {number} height - Map height
     * @param {Array} evidenceMarkers - Optional array of {time, label} for video evidence markers
     * @returns {Promise<string|null>} - Data URL or null
     */
    async _renderRouteMap(gpsPoints, width, height, evidenceMarkers = []) {
        if (!gpsPoints || gpsPoints.length < 2) return null;

        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);

        // Calculate bounds with some padding
        const lats = gpsPoints.map(p => p.lat);
        const lons = gpsPoints.map(p => p.lon);
        let minLat = Math.min(...lats);
        let maxLat = Math.max(...lats);
        let minLon = Math.min(...lons);
        let maxLon = Math.max(...lons);

        // Add padding (15%)
        const latPadding = (maxLat - minLat) * 0.15 || 0.001;
        const lonPadding = (maxLon - minLon) * 0.15 || 0.001;
        minLat -= latPadding;
        maxLat += latPadding;
        minLon -= lonPadding;
        maxLon += lonPadding;

        // Ensure minimum bounds for zoomed view
        const minSpan = 0.002; // About 200m
        if (maxLat - minLat < minSpan) {
            const center = (minLat + maxLat) / 2;
            minLat = center - minSpan / 2;
            maxLat = center + minSpan / 2;
        }
        if (maxLon - minLon < minSpan) {
            const center = (minLon + maxLon) / 2;
            minLon = center - minSpan / 2;
            maxLon = center + minSpan / 2;
        }

        const padding = { left: 10, right: 10, top: 10, bottom: 10 };
        const mapWidth = width - padding.left - padding.right;
        const mapHeight = height - padding.top - padding.bottom;

        // Calculate appropriate zoom level for the bounds
        const zoom = this._calculateZoomLevel(minLat, maxLat, minLon, maxLon, mapWidth, mapHeight);
        console.log(`[InsuranceReport] Route map zoom level: ${zoom}`);

        // Try to load OSM tiles for background
        try {
            await this._drawOSMTiles(ctx, minLat, maxLat, minLon, maxLon, zoom, padding, mapWidth, mapHeight);
        } catch (e) {
            console.warn('[InsuranceReport] Failed to load map tiles, using fallback:', e);
            // Fallback: light gray background with grid
            ctx.fillStyle = '#f0f0f0';
            ctx.fillRect(padding.left, padding.top, mapWidth, mapHeight);
            this._drawMapGrid(ctx, padding, mapWidth, mapHeight, width, height);
        }

        // Convert lat/lon to canvas coordinates
        const toX = (lon) => padding.left + ((lon - minLon) / (maxLon - minLon)) * mapWidth;
        const toY = (lat) => padding.top + ((maxLat - lat) / (maxLat - minLat)) * mapHeight;

        // Draw route line with gradient from green to red
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Draw white outline first for visibility
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(toX(gpsPoints[0].lon), toY(gpsPoints[0].lat));
        for (let i = 1; i < gpsPoints.length; i++) {
            ctx.lineTo(toX(gpsPoints[i].lon), toY(gpsPoints[i].lat));
        }
        ctx.stroke();

        // Draw colored route
        ctx.lineWidth = 4;
        for (let i = 1; i < gpsPoints.length; i++) {
            const prev = gpsPoints[i - 1];
            const curr = gpsPoints[i];
            const progress = i / (gpsPoints.length - 1);

            // Color gradient: green (start) to blue (middle) to red (end)
            let r, g, b;
            if (progress < 0.5) {
                const t = progress * 2;
                r = Math.round(76 * (1 - t));
                g = Math.round(175 * (1 - t) + 100 * t);
                b = Math.round(80 * (1 - t) + 255 * t);
            } else {
                const t = (progress - 0.5) * 2;
                r = Math.round(100 * (1 - t) + 244 * t);
                g = Math.round(100 * (1 - t) + 67 * t);
                b = Math.round(255 * (1 - t) + 54 * t);
            }

            ctx.beginPath();
            ctx.moveTo(toX(prev.lon), toY(prev.lat));
            ctx.lineTo(toX(curr.lon), toY(curr.lat));
            ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
            ctx.stroke();
        }

        // Draw start point (green circle with white border)
        const startPoint = gpsPoints[0];
        ctx.beginPath();
        ctx.arc(toX(startPoint.lon), toY(startPoint.lat), 10, 0, Math.PI * 2);
        ctx.fillStyle = '#4caf50';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.stroke();

        // Draw end point (red circle with white border)
        const endPoint = gpsPoints[gpsPoints.length - 1];
        ctx.beginPath();
        ctx.arc(toX(endPoint.lon), toY(endPoint.lat), 10, 0, Math.PI * 2);
        ctx.fillStyle = '#f44336';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.stroke();

        // Draw video evidence markers (numbered diamonds)
        if (evidenceMarkers && evidenceMarkers.length > 0) {
            console.log('[InsuranceReport] Evidence markers:', evidenceMarkers.map(m => `${m.label}: ${m.time.toFixed(1)}s`));
            console.log('[InsuranceReport] GPS points time range:', gpsPoints[0]?.time.toFixed(1), 'to', gpsPoints[gpsPoints.length-1]?.time.toFixed(1));

            for (let i = 0; i < evidenceMarkers.length; i++) {
                const marker = evidenceMarkers[i];
                // Find GPS point closest to this time using interpolation for better accuracy
                let closestPoint = gpsPoints[0];
                let closestDiff = Infinity;
                let closestIdx = 0;

                for (let j = 0; j < gpsPoints.length; j++) {
                    const p = gpsPoints[j];
                    const diff = Math.abs(p.time - marker.time);
                    if (diff < closestDiff) {
                        closestDiff = diff;
                        closestPoint = p;
                        closestIdx = j;
                    }
                }

                // Interpolate between GPS points for more accurate positioning
                let finalLat = closestPoint.lat;
                let finalLon = closestPoint.lon;

                if (closestIdx > 0 && closestIdx < gpsPoints.length - 1) {
                    const prev = gpsPoints[closestIdx - 1];
                    const next = gpsPoints[closestIdx + 1];

                    // Check if marker time falls between prev and closest, or closest and next
                    if (marker.time < closestPoint.time && prev.time < marker.time) {
                        // Interpolate between prev and closest
                        const t = (marker.time - prev.time) / (closestPoint.time - prev.time);
                        finalLat = prev.lat + (closestPoint.lat - prev.lat) * t;
                        finalLon = prev.lon + (closestPoint.lon - prev.lon) * t;
                    } else if (marker.time > closestPoint.time && next.time > marker.time) {
                        // Interpolate between closest and next
                        const t = (marker.time - closestPoint.time) / (next.time - closestPoint.time);
                        finalLat = closestPoint.lat + (next.lat - closestPoint.lat) * t;
                        finalLon = closestPoint.lon + (next.lon - closestPoint.lon) * t;
                    }
                }

                console.log(`[InsuranceReport] Marker ${i+1} (${marker.time.toFixed(1)}s) -> GPS at ${closestPoint.time.toFixed(1)}s, diff=${closestDiff.toFixed(1)}s, lat=${finalLat.toFixed(6)}, lon=${finalLon.toFixed(6)}`);

                const x = toX(finalLon);
                const y = toY(finalLat);

                // Draw diamond shape
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(Math.PI / 4);
                ctx.beginPath();
                ctx.rect(-7, -7, 14, 14);
                ctx.fillStyle = '#ff9100'; // Orange
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.restore();

                // Draw number
                ctx.font = 'bold 10px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = '#fff';
                ctx.fillText((i + 1).toString(), x, y);
            }
        }

        // Add scale indicator
        const latCenter = (minLat + maxLat) / 2;
        const metersPerDegLon = 111320 * Math.cos(latCenter * Math.PI / 180);
        const mapWidthMeters = (maxLon - minLon) * metersPerDegLon;

        let scaleMeters = 100;
        const scaleOptions = [50, 100, 200, 500, 1000, 2000, 5000];
        for (const opt of scaleOptions) {
            if (opt < mapWidthMeters * 0.3) scaleMeters = opt;
        }
        const scaleWidth = (scaleMeters / mapWidthMeters) * mapWidth;

        // Scale bar background
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillRect(width - padding.right - scaleWidth - 20, height - padding.bottom - 22, scaleWidth + 15, 18);
        ctx.fillStyle = '#333';
        ctx.fillRect(width - padding.right - scaleWidth - 15, height - padding.bottom - 10, scaleWidth, 4);
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(scaleMeters >= 1000 ? `${scaleMeters / 1000}km` : `${scaleMeters}m`,
            width - padding.right - scaleWidth / 2 - 15, height - padding.bottom - 14);

        // OSM attribution
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillRect(padding.left, height - padding.bottom - 12, 95, 10);
        ctx.font = '7px Arial';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#666';
        ctx.fillText('© OpenStreetMap contributors', padding.left + 2, height - padding.bottom - 4);

        // Border
        ctx.strokeStyle = '#999';
        ctx.lineWidth = 1;
        ctx.strokeRect(padding.left, padding.top, mapWidth, mapHeight);

        return canvas.toDataURL('image/png');
    }

    /**
     * Render a single-point location map for sentry events or when no route data
     * @param {Object} location - {lat, lon}
     * @param {number} width - Map width
     * @param {number} height - Map height
     * @returns {Promise<string|null>} - Data URL or null
     */
    async _renderLocationMap(location, width, height) {
        if (!location || !location.lat || !location.lon) return null;

        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);

        // Fill background
        ctx.fillStyle = '#e8e8e8';
        ctx.fillRect(0, 0, width, height);

        // Use fixed zoom level for single point (street level)
        const zoom = 16;

        // Calculate tile coordinates for center
        const centerTileX = ((location.lon + 180) / 360) * Math.pow(2, zoom);
        const latRad = location.lat * Math.PI / 180;
        const centerTileY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom);

        const tileSize = 256;
        const padding = { left: 10, right: 10, top: 10, bottom: 20 };
        const mapWidth = width - padding.left - padding.right;
        const mapHeight = height - padding.top - padding.bottom;

        // Calculate how many tiles we need
        const tilesX = Math.ceil(mapWidth / tileSize) + 1;
        const tilesY = Math.ceil(mapHeight / tileSize) + 1;

        // Calculate starting tile (centered on location)
        const startTileX = Math.floor(centerTileX - tilesX / 2);
        const startTileY = Math.floor(centerTileY - tilesY / 2);

        // Pixel offset for smooth centering
        const offsetX = (centerTileX - startTileX) * tileSize - mapWidth / 2;
        const offsetY = (centerTileY - startTileY) * tileSize - mapHeight / 2;

        // Load and draw tiles
        const tilePromises = [];
        for (let x = 0; x < tilesX; x++) {
            for (let y = 0; y < tilesY; y++) {
                const tileX = startTileX + x;
                const tileY = startTileY + y;
                const url = `https://tile.openstreetmap.org/${zoom}/${tileX}/${tileY}.png`;

                tilePromises.push(
                    new Promise((resolve) => {
                        const img = new Image();
                        img.crossOrigin = 'anonymous';
                        img.onload = () => resolve({ img, x, y });
                        img.onerror = () => resolve({ img: null, x, y });
                        img.src = url;
                    })
                );
            }
        }

        try {
            const tiles = await Promise.all(tilePromises);
            ctx.save();
            ctx.beginPath();
            ctx.rect(padding.left, padding.top, mapWidth, mapHeight);
            ctx.clip();

            for (const tile of tiles) {
                if (tile.img) {
                    const drawX = padding.left + tile.x * tileSize - offsetX;
                    const drawY = padding.top + tile.y * tileSize - offsetY;
                    ctx.drawImage(tile.img, drawX, drawY, tileSize, tileSize);
                }
            }
            ctx.restore();
        } catch (e) {
            console.warn('[InsuranceReport] Tile loading failed:', e);
        }

        // Draw location marker (large pin)
        const markerX = padding.left + mapWidth / 2;
        const markerY = padding.top + mapHeight / 2;

        // Pin shadow
        ctx.beginPath();
        ctx.ellipse(markerX + 2, markerY + 18, 8, 3, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fill();

        // Pin body (teardrop shape)
        ctx.beginPath();
        ctx.arc(markerX, markerY - 12, 12, Math.PI, 0, false);
        ctx.lineTo(markerX, markerY + 8);
        ctx.closePath();
        ctx.fillStyle = '#f44336'; // Red pin
        ctx.fill();
        ctx.strokeStyle = '#b71c1c';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Pin center dot
        ctx.beginPath();
        ctx.arc(markerX, markerY - 12, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();

        // Add coordinates label
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fillRect(padding.left, height - padding.bottom - 22, mapWidth, 18);
        ctx.font = 'bold 9px Arial';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#333';
        ctx.fillText(`${location.lat.toFixed(6)}, ${location.lon.toFixed(6)}`, width / 2, height - padding.bottom - 9);

        // OSM attribution
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillRect(padding.left, padding.top, 95, 10);
        ctx.font = '7px Arial';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#666';
        ctx.fillText('© OpenStreetMap contributors', padding.left + 2, padding.top + 8);

        // Border
        ctx.strokeStyle = '#999';
        ctx.lineWidth = 1;
        ctx.strokeRect(padding.left, padding.top, mapWidth, mapHeight);

        return canvas.toDataURL('image/png');
    }

    /**
     * Calculate appropriate zoom level for bounds
     * Capped at zoom 16 for reliable tile loading
     */
    _calculateZoomLevel(minLat, maxLat, minLon, maxLon, mapWidth, mapHeight) {
        const TILE_SIZE = 256;
        const latDiff = maxLat - minLat;
        const lonDiff = maxLon - minLon;

        // Calculate zoom based on lon span - cap at 16 for reliability (same as location map)
        for (let zoom = 16; zoom >= 10; zoom--) {
            const tilesX = Math.pow(2, zoom);
            const lonPerTile = 360 / tilesX;
            const requiredTilesX = lonDiff / lonPerTile;
            const requiredTilesY = latDiff / lonPerTile; // Approximate

            if (requiredTilesX <= 4 && requiredTilesY <= 4) {
                return zoom;
            }
        }
        return 14; // Default
    }

    /**
     * Draw OSM tiles onto canvas
     */
    async _drawOSMTiles(ctx, minLat, maxLat, minLon, maxLon, zoom, padding, mapWidth, mapHeight) {
        const TILE_SIZE = 256;

        // Convert lat/lon to tile coordinates
        const minTileX = this._lonToTile(minLon, zoom);
        const maxTileX = this._lonToTile(maxLon, zoom);
        const minTileY = this._latToTile(maxLat, zoom); // Note: lat is inverted
        const maxTileY = this._latToTile(minLat, zoom);

        // Calculate the pixel bounds of our tiles
        const tilesX = maxTileX - minTileX + 1;
        const tilesY = maxTileY - minTileY + 1;

        console.log(`[InsuranceReport] Loading ${tilesX}x${tilesY} = ${tilesX * tilesY} tiles at zoom ${zoom}`);

        // Limit tiles to prevent too many requests
        if (tilesX > 6 || tilesY > 6) {
            throw new Error('Too many tiles required');
        }

        // Load all tiles
        const tilePromises = [];
        for (let y = minTileY; y <= maxTileY; y++) {
            for (let x = minTileX; x <= maxTileX; x++) {
                tilePromises.push(this._loadTile(zoom, x, y));
            }
        }

        console.log('[InsuranceReport] Waiting for tiles to load...');
        const tiles = await Promise.all(tilePromises);
        const loadedCount = tiles.filter(t => t !== null).length;
        console.log(`[InsuranceReport] Loaded ${loadedCount}/${tiles.length} tiles`);

        // Calculate how to map tiles onto our canvas
        const tileMinLon = this._tileToLon(minTileX, zoom);
        const tileMaxLon = this._tileToLon(maxTileX + 1, zoom);
        const tileMinLat = this._tileToLat(maxTileY + 1, zoom);
        const tileMaxLat = this._tileToLat(minTileY, zoom);

        // Scale factors
        const scaleX = mapWidth / (tileMaxLon - tileMinLon) * (maxLon - minLon) / mapWidth;
        const scaleY = mapHeight / (tileMaxLat - tileMinLat) * (maxLat - minLat) / mapHeight;

        // Draw tiles
        let tileIndex = 0;
        for (let y = minTileY; y <= maxTileY; y++) {
            for (let x = minTileX; x <= maxTileX; x++) {
                const tile = tiles[tileIndex++];
                if (!tile) continue;

                const tileLon = this._tileToLon(x, zoom);
                const tileLat = this._tileToLat(y, zoom);
                const nextTileLon = this._tileToLon(x + 1, zoom);
                const nextTileLat = this._tileToLat(y + 1, zoom);

                // Calculate canvas position for this tile
                const canvasX = padding.left + ((tileLon - minLon) / (maxLon - minLon)) * mapWidth;
                const canvasY = padding.top + ((maxLat - tileLat) / (maxLat - minLat)) * mapHeight;
                const canvasW = ((nextTileLon - tileLon) / (maxLon - minLon)) * mapWidth;
                const canvasH = ((tileLat - nextTileLat) / (maxLat - minLat)) * mapHeight;

                ctx.drawImage(tile, canvasX, canvasY, canvasW, canvasH);
            }
        }
    }

    /**
     * Load a single OSM tile with timeout
     */
    _loadTile(zoom, x, y) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';

            // Timeout after 5 seconds
            const timeout = setTimeout(() => {
                console.warn(`[InsuranceReport] Tile timeout: ${zoom}/${x}/${y}`);
                resolve(null);
            }, 5000);

            img.onload = () => {
                clearTimeout(timeout);
                resolve(img);
            };
            img.onerror = () => {
                clearTimeout(timeout);
                console.warn(`[InsuranceReport] Tile failed: ${zoom}/${x}/${y}`);
                resolve(null);
            };
            // Use OSM tile server
            img.src = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
        });
    }

    /**
     * Convert tile X to longitude
     */
    _tileToLon(x, zoom) {
        return (x / Math.pow(2, zoom)) * 360 - 180;
    }

    /**
     * Convert tile Y to latitude
     */
    _tileToLat(y, zoom) {
        const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
        return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    }

    /**
     * Draw fallback grid
     */
    _drawMapGrid(ctx, padding, mapWidth, mapHeight, width, height) {
        ctx.strokeStyle = '#ddd';
        ctx.lineWidth = 0.5;
        for (let i = 0; i <= 4; i++) {
            const x = padding.left + (i / 4) * mapWidth;
            const y = padding.top + (i / 4) * mapHeight;
            ctx.beginPath();
            ctx.moveTo(x, padding.top);
            ctx.lineTo(x, height - padding.bottom);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(width - padding.right, y);
            ctx.stroke();
        }
    }

    /**
     * Collect all telemetry data points from all clips
     * @param {TelemetryOverlay} telemetryOverlay
     * @param {Object} timeRange - Optional {start, end} to filter data to IN/OUT range
     * @returns {Array}
     */
    _collectAllTelemetryPoints(telemetryOverlay, timeRange = null) {
        if (!telemetryOverlay?.clipSeiData) return [];

        const allPoints = [];

        // Use cached clip durations for accurate timing (not 60-second approximation)
        const cachedDurations = this.videoPlayer?.cachedClipDurations || [];
        const defaultDuration = 60;

        if (timeRange) {
            console.log(`[InsuranceReport] Filtering telemetry to range: ${timeRange.start.toFixed(1)}s - ${timeRange.end.toFixed(1)}s`);
        }

        // Pre-calculate cumulative times for each clip using cached durations
        const clipStartTimes = [0];
        for (let i = 0; i < cachedDurations.length; i++) {
            clipStartTimes.push(clipStartTimes[i] + (cachedDurations[i] || defaultDuration));
        }

        // Keys are like "29_2026-01-18_09-41-46-front.mp4" - extract clip index from start
        const clipEntries = [];
        for (const [key, data] of telemetryOverlay.clipSeiData) {
            const clipIndex = parseInt(key.split('_')[0]) || 0;
            clipEntries.push({ clipIndex, key, data });
        }
        clipEntries.sort((a, b) => a.clipIndex - b.clipIndex);

        for (const { clipIndex, data } of clipEntries) {
            // Data has a 'frames' property containing the array
            const frames = data?.frames || data;
            if (!frames || !Array.isArray(frames) || !frames.length) continue;

            // Get base time from pre-calculated cumulative times, or estimate if not available
            const baseTime = clipStartTimes[clipIndex] !== undefined
                ? clipStartTimes[clipIndex]
                : clipIndex * defaultDuration;

            // Get actual clip duration for accurate frame timing
            const clipDuration = cachedDurations[clipIndex] || defaultDuration;

            for (let i = 0; i < frames.length; i++) {
                const frame = frames[i];
                // Estimate time within clip based on frame position
                const timeInClip = (i / frames.length) * clipDuration;
                const absoluteTime = baseTime + timeInClip;

                // Filter by time range if provided (with 10s buffer before start for "Before Incident" frame)
                if (timeRange) {
                    const bufferBefore = 10; // Allow data up to 10s before IN point
                    if (absoluteTime < (timeRange.start - bufferBefore) || absoluteTime > timeRange.end) {
                        continue;
                    }
                }

                // G-force is stored as m/s², convert to G by dividing by 9.81
                // linear_acceleration_mps2_y is longitudinal - negate so positive = acceleration, negative = braking
                // linear_acceleration_mps2_x is lateral (turning)
                const gForceY = -(frame.linear_acceleration_mps2_y || 0) / 9.81;
                const gForceX = (frame.linear_acceleration_mps2_x || 0) / 9.81;

                allPoints.push({
                    time: absoluteTime,
                    speed_mph: frame.speed_mph || 0,
                    g_force_y: gForceY,
                    g_force_x: gForceX,
                    throttle: frame.throttle || 0,
                    brake: frame.brake || false
                });
            }
        }

        // Sort by time
        allPoints.sort((a, b) => a.time - b.time);

        // Filter to reduce point density (keep every Nth point based on total)
        const maxPoints = 1000;
        if (allPoints.length > maxPoints) {
            const step = Math.ceil(allPoints.length / maxPoints);
            return allPoints.filter((_, i) => i % step === 0 || i === allPoints.length - 1);
        }

        return allPoints;
    }

    /**
     * Render speed graph to canvas and return as data URL
     * @param {Array} points - Telemetry data points
     * @param {number} width - Graph width in points
     * @param {number} height - Graph height in points
     * @returns {string|null} - Data URL or null
     */
    _renderSpeedGraph(points, width, height) {
        if (!points || points.length < 2) return null;

        // Scale for higher resolution
        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);

        // Background
        ctx.fillStyle = '#f8f8f8';
        ctx.fillRect(0, 0, width, height);

        // Graph area
        const padding = { left: 40, right: 10, top: 10, bottom: 25 };
        const graphWidth = width - padding.left - padding.right;
        const graphHeight = height - padding.top - padding.bottom;

        // Get data range
        const speeds = points.map(p => p.speed_mph);
        const minSpeed = 0;
        const maxSpeed = Math.max(80, Math.ceil(Math.max(...speeds) / 10) * 10);
        const minTime = points[0].time;
        const maxTime = points[points.length - 1].time;
        const duration = maxTime - minTime;

        // Draw grid lines
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 0.5;
        for (let speed = 0; speed <= maxSpeed; speed += 20) {
            const y = padding.top + (1 - speed / maxSpeed) * graphHeight;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(width - padding.right, y);
            ctx.stroke();

            // Y-axis labels
            ctx.fillStyle = '#666';
            ctx.font = '8px Arial';
            ctx.textAlign = 'right';
            ctx.fillText(`${speed}`, padding.left - 5, y + 3);
        }

        // Y-axis label
        ctx.save();
        ctx.translate(10, height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#666';
        ctx.font = '9px Arial';
        ctx.fillText('Speed (mph)', 0, 0);
        ctx.restore();

        // X-axis labels (time)
        ctx.textAlign = 'center';
        ctx.fillStyle = '#666';
        ctx.font = '8px Arial';
        const timeStep = duration > 300 ? 60 : 30;
        for (let t = 0; t <= duration; t += timeStep) {
            const x = padding.left + (t / duration) * graphWidth;
            const mins = Math.floor(t / 60);
            const secs = Math.floor(t % 60);
            ctx.fillText(`${mins}:${secs.toString().padStart(2, '0')}`, x, height - 5);
        }

        // Draw speed line
        ctx.beginPath();
        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < points.length; i++) {
            const x = padding.left + ((points[i].time - minTime) / duration) * graphWidth;
            const y = padding.top + (1 - points[i].speed_mph / maxSpeed) * graphHeight;
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();

        // Border
        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 1;
        ctx.strokeRect(padding.left, padding.top, graphWidth, graphHeight);

        return canvas.toDataURL('image/png');
    }

    /**
     * Render G-force graph to canvas and return as data URL
     * @param {Array} points - Telemetry data points
     * @param {number} width - Graph width in points
     * @param {number} height - Graph height in points
     * @returns {string|null} - Data URL or null
     */
    _renderGForceGraph(points, width, height) {
        if (!points || points.length < 2) return null;

        // Scale for higher resolution
        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);

        // Background
        ctx.fillStyle = '#f8f8f8';
        ctx.fillRect(0, 0, width, height);

        // Graph area
        const padding = { left: 40, right: 10, top: 10, bottom: 25 };
        const graphWidth = width - padding.left - padding.right;
        const graphHeight = height - padding.top - padding.bottom;

        // G-force range (-0.8 to 0.8)
        const minG = -0.8;
        const maxG = 0.8;
        const rangeG = maxG - minG;
        const minTime = points[0].time;
        const maxTime = points[points.length - 1].time;
        const duration = maxTime - minTime;

        // Draw grid lines
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 0.5;
        for (let g = -0.8; g <= 0.8; g += 0.2) {
            const y = padding.top + (1 - (g - minG) / rangeG) * graphHeight;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(width - padding.right, y);
            ctx.stroke();

            // Y-axis labels
            ctx.fillStyle = '#666';
            ctx.font = '8px Arial';
            ctx.textAlign = 'right';
            ctx.fillText(`${g.toFixed(1)}`, padding.left - 5, y + 3);
        }

        // Zero line (more prominent)
        const zeroY = padding.top + (1 - (0 - minG) / rangeG) * graphHeight;
        ctx.strokeStyle = '#999';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padding.left, zeroY);
        ctx.lineTo(width - padding.right, zeroY);
        ctx.stroke();

        // Y-axis label
        ctx.save();
        ctx.translate(10, height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#666';
        ctx.font = '9px Arial';
        ctx.fillText('G-Force', 0, 0);
        ctx.restore();

        // X-axis labels (time)
        ctx.textAlign = 'center';
        ctx.fillStyle = '#666';
        ctx.font = '8px Arial';
        const timeStep = duration > 300 ? 60 : 30;
        for (let t = 0; t <= duration; t += timeStep) {
            const x = padding.left + (t / duration) * graphWidth;
            const mins = Math.floor(t / 60);
            const secs = Math.floor(t % 60);
            ctx.fillText(`${mins}:${secs.toString().padStart(2, '0')}`, x, height - 5);
        }

        // Fill areas above/below zero
        // Positive (acceleration) - light green
        ctx.beginPath();
        ctx.moveTo(padding.left, zeroY);
        for (let i = 0; i < points.length; i++) {
            const x = padding.left + ((points[i].time - minTime) / duration) * graphWidth;
            const gForce = Math.max(0, points[i].g_force_y);
            const y = padding.top + (1 - (gForce - minG) / rangeG) * graphHeight;
            ctx.lineTo(x, y);
        }
        ctx.lineTo(padding.left + graphWidth, zeroY);
        ctx.closePath();
        ctx.fillStyle = 'rgba(76, 175, 80, 0.2)';
        ctx.fill();

        // Negative (braking) - light red
        ctx.beginPath();
        ctx.moveTo(padding.left, zeroY);
        for (let i = 0; i < points.length; i++) {
            const x = padding.left + ((points[i].time - minTime) / duration) * graphWidth;
            const gForce = Math.min(0, points[i].g_force_y);
            const y = padding.top + (1 - (gForce - minG) / rangeG) * graphHeight;
            ctx.lineTo(x, y);
        }
        ctx.lineTo(padding.left + graphWidth, zeroY);
        ctx.closePath();
        ctx.fillStyle = 'rgba(244, 67, 54, 0.2)';
        ctx.fill();

        // Draw G-force line
        ctx.beginPath();
        ctx.strokeStyle = '#ff9100';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < points.length; i++) {
            const x = padding.left + ((points[i].time - minTime) / duration) * graphWidth;
            const y = padding.top + (1 - (points[i].g_force_y - minG) / rangeG) * graphHeight;
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();

        // Border
        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 1;
        ctx.strokeRect(padding.left, padding.top, graphWidth, graphHeight);

        return canvas.toDataURL('image/png');
    }

    /**
     * Add timeline of events section
     * @param {jsPDF} doc
     * @param {Object} event
     * @param {number} y
     * @returns {number}
     */
    _addTimelineSection(doc, event, y) {
        // Check if we need a new page
        if (y > this.pageHeight - 150) {
            doc.addPage();
            y = this.margin;
        }

        y = this._addSectionTitle(doc, 'Event Timeline', y);

        const clipMarking = window.app?.clipMarking;
        const marks = clipMarking?.getMarks() || { inPoint: null, outPoint: null };

        // Timeline events
        const timelineEvents = [];

        // Get total duration
        const totalDuration = this.videoPlayer?.cachedClipDurations?.reduce((a, b) => a + b, 0) ||
            (event.clips?.length || 1) * 60;

        // Event start
        timelineEvents.push({
            time: '00:00',
            description: 'Recording begins'
        });

        // Add clip boundaries for context
        const clipDurations = this.videoPlayer?.cachedClipDurations || [];
        if (clipDurations.length > 1) {
            let cumTime = 0;
            for (let i = 0; i < Math.min(clipDurations.length - 1, 10); i++) {
                cumTime += clipDurations[i];
                timelineEvents.push({
                    time: this._formatTime(cumTime),
                    description: `Clip ${i + 2} begins`
                });
            }
            if (clipDurations.length > 10) {
                timelineEvents.push({
                    time: '...',
                    description: `(${clipDurations.length - 10} more clip transitions)`
                });
            }
        }

        // Mark in point if set
        if (marks.inPoint !== null) {
            timelineEvents.push({
                time: this._formatTime(marks.inPoint),
                description: '>>> Marked IN point - Incident begins <<<'
            });
        }

        // Add trigger info if available (for Sentry events)
        if (event.reason) {
            const triggerTime = marks.inPoint !== null ? marks.inPoint : 0;
            timelineEvents.push({
                time: this._formatTime(triggerTime),
                description: `Trigger: ${this._formatReason(event.reason)}`
            });
        }

        // Mark out point if set
        if (marks.outPoint !== null) {
            timelineEvents.push({
                time: this._formatTime(marks.outPoint),
                description: '>>> Marked OUT point - Incident ends <<<'
            });
        }

        // Recording end
        timelineEvents.push({
            time: this._formatTime(totalDuration),
            description: 'Recording ends'
        });

        // Sort by time (convert MM:SS to seconds for sorting)
        timelineEvents.sort((a, b) => {
            if (a.time === '...') return 0;
            if (b.time === '...') return 0;
            const parseTime = (t) => {
                const parts = t.split(':').map(Number);
                return parts[0] * 60 + parts[1];
            };
            return parseTime(a.time) - parseTime(b.time);
        });

        // Draw timeline
        doc.setFontSize(10);
        for (const item of timelineEvents) {
            // Time
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(0, 150, 200);
            doc.text(item.time, this.margin, y);

            // Timeline dot
            doc.setFillColor(0, 150, 200);
            doc.circle(this.margin + 50, y - 3, 3, 'F');

            // Description
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(50, 50, 50);
            doc.text(item.description, this.margin + 65, y);
            y += 20;
        }

        return y + 10;
    }

    /**
     * Add incident analysis section with impact detection, speed analysis, etc.
     * @param {jsPDF} doc
     * @param {number} y
     * @returns {Promise<number>}
     */
    async _addIncidentAnalysisSection(doc, y) {
        const telemetryOverlay = window.app?.telemetryOverlay;
        if (!telemetryOverlay?.clipSeiData) {
            return y;
        }

        // Check if we need a new page
        if (y > this.pageHeight - 300) {
            doc.addPage();
            y = this.margin;
        }

        y = this._addSectionTitle(doc, 'Incident Analysis', y);

        // Get time range from marks
        const clipMarking = window.app?.clipMarking;
        const marks = clipMarking?.getMarks() || { inPoint: null, outPoint: null };
        const timeRange = (marks.inPoint !== null && marks.outPoint !== null)
            ? { start: marks.inPoint, end: marks.outPoint }
            : null;

        // Collect comprehensive telemetry data
        const analysisData = this._collectIncidentAnalysisData(telemetryOverlay, timeRange);

        if (!analysisData) {
            doc.setFontSize(10);
            doc.setTextColor(100, 100, 100);
            doc.text('Insufficient telemetry data for incident analysis.', this.margin, y);
            return y + 20;
        }

        // === IMPACT DETECTION ===
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(50, 50, 50);
        doc.text('Impact Detection', this.margin, y);
        y += 15;

        if (analysisData.impacts.length > 0) {
            doc.setFillColor(255, 240, 240);
            doc.rect(this.margin, y - 10, this.contentWidth, 12 + analysisData.impacts.length * 14, 'F');

            doc.setFontSize(10);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(200, 0, 0);
            doc.text(`WARNING: ${analysisData.impacts.length} potential impact(s) detected`, this.margin + 5, y);
            y += 14;

            doc.setFont('helvetica', 'normal');
            doc.setTextColor(100, 50, 50);
            for (const impact of analysisData.impacts) {
                doc.text(`• ${this._formatTime(impact.time)} - ${impact.gForce.toFixed(2)}G ${impact.direction}`, this.margin + 10, y);
                y += 12;
            }
            y += 5;
        } else {
            doc.setFontSize(10);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(0, 150, 0);
            doc.text('No significant impacts detected (G-force remained below 1.0G)', this.margin, y);
            y += 15;
        }

        // === SPEED AT KEY MOMENTS ===
        y += 10;
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(50, 50, 50);
        doc.text('Speed Analysis', this.margin, y);
        y += 15;

        const speedData = [
            { label: 'Start Speed:', value: `${analysisData.startSpeed.toFixed(1)} mph` },
            { label: 'Maximum Speed:', value: `${analysisData.maxSpeed.toFixed(1)} mph` },
            { label: 'Minimum Speed:', value: `${analysisData.minSpeed.toFixed(1)} mph` },
            { label: 'End Speed:', value: `${analysisData.endSpeed.toFixed(1)} mph` },
            { label: 'Average Speed:', value: `${analysisData.avgSpeed.toFixed(1)} mph` }
        ];

        doc.setFontSize(10);
        for (const row of speedData) {
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(100, 100, 100);
            doc.text(row.label, this.margin, y);
            doc.setTextColor(50, 50, 50);
            doc.text(row.value, this.margin + 100, y);
            y += 14;
        }

        // === BRAKE TIMELINE ===
        y += 10;
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(50, 50, 50);
        doc.text('Brake Events', this.margin, y);
        y += 15;

        if (analysisData.brakeEvents.length > 0) {
            doc.setFontSize(10);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(50, 50, 50);
            doc.text(`${analysisData.brakeEvents.length} brake application(s) detected:`, this.margin, y);
            y += 14;

            // Show first few brake events
            const maxBrakeEvents = Math.min(5, analysisData.brakeEvents.length);
            for (let i = 0; i < maxBrakeEvents; i++) {
                const evt = analysisData.brakeEvents[i];
                doc.setTextColor(100, 100, 100);
                doc.text(`• ${this._formatTime(evt.startTime)} - ${this._formatTime(evt.endTime)} (${evt.duration.toFixed(1)}s) at ${evt.speedAtBrake.toFixed(0)} mph`, this.margin + 10, y);
                y += 12;
            }
            if (analysisData.brakeEvents.length > 5) {
                doc.setTextColor(100, 100, 100);
                doc.text(`... and ${analysisData.brakeEvents.length - 5} more brake event(s)`, this.margin + 10, y);
                y += 12;
            }
        } else {
            doc.setFontSize(10);
            doc.setTextColor(100, 100, 100);
            doc.text('No brake applications detected in this segment.', this.margin, y);
            y += 14;
        }

        // === TURN SIGNAL STATUS ===
        y += 10;
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(50, 50, 50);
        doc.text('Turn Signal Usage', this.margin, y);
        y += 15;

        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        if (analysisData.turnSignalEvents && analysisData.turnSignalEvents.length > 0) {
            doc.setTextColor(50, 50, 50);
            doc.text(`${analysisData.turnSignalEvents.length} turn signal activation(s) detected:`, this.margin, y);
            y += 14;

            // Show turn signal events
            const maxSignalEvents = Math.min(5, analysisData.turnSignalEvents.length);
            for (let i = 0; i < maxSignalEvents; i++) {
                const evt = analysisData.turnSignalEvents[i];
                doc.setTextColor(100, 100, 100);
                doc.text(`• ${this._formatTime(evt.startTime)} - ${this._formatTime(evt.endTime)} (${evt.duration.toFixed(1)}s) ${evt.direction}`, this.margin + 10, y);
                y += 12;
            }
            if (analysisData.turnSignalEvents.length > 5) {
                doc.setTextColor(100, 100, 100);
                doc.text(`... and ${analysisData.turnSignalEvents.length - 5} more turn signal event(s)`, this.margin + 10, y);
                y += 12;
            }
        } else {
            doc.setTextColor(100, 100, 100);
            doc.text('No turn signal activation detected.', this.margin, y);
            y += 12;
        }

        // === AUTOPILOT/FSD STATUS (Critical for insurance) ===
        y += 5;
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(50, 50, 50);
        doc.text('Autopilot / FSD Status', this.margin, y);
        y += 15;

        // Autopilot status analysis
        const apEvents = analysisData.autopilotEvents || [];
        const hasAutopilot = apEvents.length > 0;

        if (hasAutopilot) {
            // Calculate time without AP at end
            const lastApEvent = apEvents[apEvents.length - 1];
            const segmentEnd = analysisData.segmentEndTime || 0;
            const timeWithoutApAtEnd = segmentEnd - (lastApEvent?.endTime || 0);
            const apActiveAtEnd = analysisData.endApStatus &&
                analysisData.endApStatus !== 'NONE' &&
                analysisData.endApStatus !== 'OFF' &&
                analysisData.endApStatus !== 'DISABLED';

            // Calculate box height based on ALL events (with extra padding for safety)
            const baseHeight = 75; // Header + status lines + duration summary + timeline header
            const eventHeight = apEvents.length * 12;
            const endStatusHeight = timeWithoutApAtEnd > 1 ? 22 : 0;
            const apBoxHeight = baseHeight + eventHeight + endStatusHeight + 10; // +10 for padding

            // Check if we need a new page for the box
            if (y + apBoxHeight > this.pageHeight - this.margin) {
                doc.addPage();
                y = this.margin;
                y = this._addSectionTitle(doc, 'Autopilot / FSD Status (continued)', y);
            }

            // Red/orange warning box
            const boxStartY = y - 8;
            doc.setFillColor(255, 245, 238);
            doc.rect(this.margin, boxStartY, this.contentWidth, apBoxHeight, 'F');
            doc.setDrawColor(255, 100, 0);
            doc.rect(this.margin, boxStartY, this.contentWidth, apBoxHeight, 'S');

            doc.setFontSize(10);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(200, 50, 0);
            doc.text('AUTOPILOT WAS ACTIVE DURING THIS SEGMENT', this.margin + 5, y);
            y += 14;

            // Status at start and end
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(50, 50, 50);
            const startStatus = this._formatApStatus(analysisData.startApStatus);
            const endStatus = this._formatApStatus(analysisData.endApStatus);
            doc.text(`At start of segment: ${startStatus}`, this.margin + 5, y);
            y += 12;
            doc.text(`At end of segment: ${endStatus}`, this.margin + 5, y);
            y += 12;

            // Duration summary
            const pctActive = analysisData.totalSegmentDuration > 0 ?
                (analysisData.totalApDuration / analysisData.totalSegmentDuration * 100).toFixed(1) : 0;
            doc.text(`Total time active: ${analysisData.totalApDuration.toFixed(1)}s (${pctActive}% of segment)`, this.margin + 5, y);
            y += 14;

            // List ALL autopilot events
            doc.setTextColor(100, 50, 0);
            doc.text('Autopilot engagement timeline:', this.margin + 5, y);
            y += 12;

            for (let i = 0; i < apEvents.length; i++) {
                const evt = apEvents[i];
                doc.setTextColor(80, 80, 80);
                doc.text(`• ${this._formatTime(evt.startTime)} - ${this._formatTime(evt.endTime)}: ${this._formatApStatus(evt.mode)} (${evt.duration.toFixed(1)}s)`, this.margin + 10, y);
                y += 12;
            }

            // Show time without AP at end if relevant
            if (timeWithoutApAtEnd > 1) {
                y += 5;
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(150, 50, 0);
                if (apActiveAtEnd) {
                    doc.text(`Autopilot was STILL ACTIVE at end of segment`, this.margin + 5, y);
                } else {
                    doc.text(`Autopilot was OFF for final ${timeWithoutApAtEnd.toFixed(1)}s before segment end`, this.margin + 5, y);
                }
                y += 12;
            }

            // Move y to bottom of box for consistent spacing
            y = boxStartY + apBoxHeight + 5;
        } else {
            // Green box - no autopilot
            doc.setFillColor(240, 255, 240);
            doc.rect(this.margin, y - 8, this.contentWidth, 35, 'F');
            doc.setDrawColor(0, 150, 0);
            doc.rect(this.margin, y - 8, this.contentWidth, 35, 'S');

            doc.setFontSize(10);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(0, 120, 0);
            doc.text('AUTOPILOT WAS NOT ACTIVE DURING THIS SEGMENT', this.margin + 5, y);
            y += 14;
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(80, 80, 80);
            doc.text('Vehicle was under manual driver control throughout.', this.margin + 5, y);
            y += 25;
        }

        // === HEADING / DIRECTION ===
        y += 5;
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(50, 50, 50);
        doc.text('Direction of Travel', this.margin, y);
        y += 15;

        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(50, 50, 50);
        doc.text(`Start heading: ${analysisData.startHeading.toFixed(0)}° (${this._headingToCompass(analysisData.startHeading)})`, this.margin, y);
        y += 12;
        doc.text(`End heading: ${analysisData.endHeading.toFixed(0)}° (${this._headingToCompass(analysisData.endHeading)})`, this.margin, y);
        y += 12;
        const headingChange = Math.abs(analysisData.endHeading - analysisData.startHeading);
        const normalizedChange = headingChange > 180 ? 360 - headingChange : headingChange;
        doc.setTextColor(100, 100, 100);
        doc.text(`Total heading change: ${normalizedChange.toFixed(0)}°`, this.margin, y);
        y += 15;

        // === DISTANCE TRAVELED ===
        y += 5;
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(50, 50, 50);
        doc.text('Distance Traveled', this.margin, y);
        y += 15;

        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(50, 50, 50);
        const distanceMiles = analysisData.distanceMeters / 1609.34;
        const distanceFeet = analysisData.distanceMeters * 3.28084;
        if (distanceMiles >= 0.1) {
            doc.text(`${distanceMiles.toFixed(2)} miles (${analysisData.distanceMeters.toFixed(0)} meters)`, this.margin, y);
        } else {
            doc.text(`${distanceFeet.toFixed(0)} feet (${analysisData.distanceMeters.toFixed(0)} meters)`, this.margin, y);
        }
        y += 20;

        // === NEAR-MISS DETECTION ===
        const nearMisses = this._getNearMissData(timeRange);
        if (nearMisses && nearMisses.length > 0) {
            // Check if we need a new page
            if (y > this.pageHeight - 100) {
                doc.addPage();
                y = this.margin;
            }

            y += 5;
            doc.setFontSize(11);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(50, 50, 50);
            doc.text('Near-Miss Incidents Detected', this.margin, y);
            y += 15;

            // Warning box
            doc.setFillColor(255, 248, 230);
            const boxHeight = 15 + nearMisses.length * 14;
            doc.rect(this.margin, y - 10, this.contentWidth, boxHeight, 'F');

            doc.setFontSize(10);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(200, 100, 0);
            doc.text(`${nearMisses.length} near-miss incident(s) detected by telemetry analysis:`, this.margin + 5, y);
            y += 14;

            doc.setFont('helvetica', 'normal');
            const maxToShow = Math.min(5, nearMisses.length);
            for (let i = 0; i < maxToShow; i++) {
                const nm = nearMisses[i];
                const severity = nm.score >= 8 ? 'CRITICAL' : nm.score >= 5 ? 'WARNING' : 'CAUTION';
                doc.setTextColor(nm.score >= 8 ? 200 : 150, nm.score >= 5 ? 50 : 100, 0);
                doc.text(`• ${this._formatTime(nm.time)} - Score: ${nm.score.toFixed(1)}/10 (${severity})`, this.margin + 10, y);
                y += 12;
            }
            if (nearMisses.length > 5) {
                doc.setTextColor(100, 100, 100);
                doc.text(`... and ${nearMisses.length - 5} more incident(s)`, this.margin + 10, y);
                y += 12;
            }
            y += 5;
        }

        return y + 10;
    }

    /**
     * Get near-miss data from telemetry graphs
     * @param {Object} timeRange
     * @returns {Array}
     */
    _getNearMissData(timeRange) {
        const telemetryGraphs = window.app?.telemetryGraphs;
        if (!telemetryGraphs?.nearMisses) {
            return [];
        }

        let nearMisses = [...telemetryGraphs.nearMisses];

        // Filter by time range if provided
        if (timeRange) {
            nearMisses = nearMisses.filter(nm =>
                nm.time >= (timeRange.start - 10) && nm.time <= timeRange.end
            );
        }

        // Sort by score descending
        nearMisses.sort((a, b) => b.score - a.score);

        return nearMisses;
    }

    /**
     * Collect comprehensive incident analysis data
     * @param {TelemetryOverlay} telemetryOverlay
     * @param {Object} timeRange
     * @returns {Object|null}
     */
    _collectIncidentAnalysisData(telemetryOverlay, timeRange) {
        const allPoints = this._collectAllTelemetryPoints(telemetryOverlay, timeRange);
        const gpsPoints = this._collectGPSPoints(telemetryOverlay, timeRange);

        if (!allPoints || allPoints.length < 5) {
            return null;
        }

        // Get raw telemetry with all fields
        const rawData = this._collectRawTelemetryData(telemetryOverlay, timeRange);

        // Impact detection (G-force > 1.0)
        const impacts = [];
        for (const point of allPoints) {
            const totalG = Math.sqrt(point.g_force_x * point.g_force_x + point.g_force_y * point.g_force_y);
            if (totalG >= 1.0) {
                let direction = 'multi-directional';
                if (Math.abs(point.g_force_y) > Math.abs(point.g_force_x)) {
                    direction = point.g_force_y > 0 ? 'forward impact' : 'rear impact';
                } else {
                    direction = point.g_force_x > 0 ? 'right side impact' : 'left side impact';
                }
                impacts.push({
                    time: point.time,
                    gForce: totalG,
                    direction
                });
            }
        }

        // Speed analysis
        const speeds = allPoints.map(p => p.speed_mph);
        const startSpeed = speeds[0] || 0;
        const endSpeed = speeds[speeds.length - 1] || 0;
        const maxSpeed = Math.max(...speeds);
        const minSpeed = Math.min(...speeds);
        const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;

        // Brake events
        const brakeEvents = [];
        let brakeStart = null;
        for (let i = 0; i < rawData.length; i++) {
            const point = rawData[i];
            if (point.brake && brakeStart === null) {
                brakeStart = { time: point.time, speed: point.speed_mph };
            } else if (!point.brake && brakeStart !== null) {
                brakeEvents.push({
                    startTime: brakeStart.time,
                    endTime: point.time,
                    duration: point.time - brakeStart.time,
                    speedAtBrake: brakeStart.speed
                });
                brakeStart = null;
            }
        }

        // Turn signal events (track all like brake events)
        const turnSignalEvents = [];
        let signalStart = null;
        let currentSignal = 'NONE';
        for (let i = 0; i < rawData.length; i++) {
            const point = rawData[i];
            const signal = point.turn_signal || 'NONE';
            const isActive = signal !== 'NONE' && signal !== 'OFF';

            if (isActive && signalStart === null) {
                signalStart = { time: point.time, direction: signal };
                currentSignal = signal;
            } else if (isActive && signal !== currentSignal && signalStart !== null) {
                // Signal changed direction
                turnSignalEvents.push({
                    startTime: signalStart.time,
                    endTime: point.time,
                    duration: point.time - signalStart.time,
                    direction: signalStart.direction
                });
                signalStart = { time: point.time, direction: signal };
                currentSignal = signal;
            } else if (!isActive && signalStart !== null) {
                turnSignalEvents.push({
                    startTime: signalStart.time,
                    endTime: point.time,
                    duration: point.time - signalStart.time,
                    direction: signalStart.direction
                });
                signalStart = null;
                currentSignal = 'NONE';
            }
        }
        // Close any open signal event
        if (signalStart !== null && rawData.length > 0) {
            turnSignalEvents.push({
                startTime: signalStart.time,
                endTime: rawData[rawData.length - 1].time,
                duration: rawData[rawData.length - 1].time - signalStart.time,
                direction: signalStart.direction
            });
        }

        // Autopilot events (track all state changes - critical for insurance)
        const autopilotEvents = [];
        let apStart = null;
        let currentApMode = 'NONE';
        const frameDuration = rawData.length > 1 ? (rawData[1].time - rawData[0].time) : 0.5;

        for (let i = 0; i < rawData.length; i++) {
            const point = rawData[i];
            const apMode = point.autopilot || 'NONE';
            const isActive = apMode !== 'NONE' && apMode !== 'OFF' && apMode !== 'DISABLED';

            if (isActive && apStart === null) {
                // Autopilot just engaged
                apStart = { time: point.time, mode: apMode };
                currentApMode = apMode;
            } else if (isActive && apMode !== currentApMode && apStart !== null) {
                // Mode changed while active
                autopilotEvents.push({
                    startTime: apStart.time,
                    endTime: point.time,
                    duration: point.time - apStart.time,
                    mode: apStart.mode,
                    type: 'active'
                });
                apStart = { time: point.time, mode: apMode };
                currentApMode = apMode;
            } else if (!isActive && apStart !== null) {
                // Autopilot just disengaged
                autopilotEvents.push({
                    startTime: apStart.time,
                    endTime: point.time,
                    duration: point.time - apStart.time,
                    mode: apStart.mode,
                    type: 'active'
                });
                apStart = null;
                currentApMode = 'NONE';
            }
        }
        // Close any open autopilot event
        if (apStart !== null && rawData.length > 0) {
            autopilotEvents.push({
                startTime: apStart.time,
                endTime: rawData[rawData.length - 1].time,
                duration: rawData[rawData.length - 1].time - apStart.time,
                mode: apStart.mode,
                type: 'active'
            });
        }

        // Calculate autopilot status at key points
        const startApStatus = rawData[0]?.autopilot || 'NONE';
        const endApStatus = rawData[rawData.length - 1]?.autopilot || 'NONE';
        const totalApDuration = autopilotEvents.reduce((sum, e) => sum + e.duration, 0);
        const segmentStartTime = rawData.length > 0 ? rawData[0].time : 0;
        const segmentEndTime = rawData.length > 0 ? rawData[rawData.length - 1].time : 0;
        const totalSegmentDuration = segmentEndTime - segmentStartTime;

        // Heading
        const startHeading = rawData[0]?.heading || 0;
        const endHeading = rawData[rawData.length - 1]?.heading || 0;

        // Distance traveled
        let distanceMeters = 0;
        for (let i = 1; i < gpsPoints.length; i++) {
            distanceMeters += this._haversineDistance(
                gpsPoints[i - 1].lat, gpsPoints[i - 1].lon,
                gpsPoints[i].lat, gpsPoints[i].lon
            );
        }

        return {
            impacts,
            startSpeed,
            endSpeed,
            maxSpeed,
            minSpeed,
            avgSpeed,
            brakeEvents,
            turnSignalEvents,
            autopilotEvents,
            startApStatus,
            endApStatus,
            totalApDuration,
            segmentStartTime,
            segmentEndTime,
            totalSegmentDuration,
            startHeading,
            endHeading,
            distanceMeters
        };
    }

    /**
     * Collect raw telemetry data with all available fields
     * @param {TelemetryOverlay} telemetryOverlay
     * @param {Object} timeRange
     * @returns {Array}
     */
    _collectRawTelemetryData(telemetryOverlay, timeRange) {
        if (!telemetryOverlay?.clipSeiData) return [];

        const rawPoints = [];
        const cachedDurations = this.videoPlayer?.cachedClipDurations || [];
        const defaultDuration = 60;

        const clipStartTimes = [0];
        for (let i = 0; i < cachedDurations.length; i++) {
            clipStartTimes.push(clipStartTimes[i] + (cachedDurations[i] || defaultDuration));
        }

        const clipEntries = [];
        for (const [key, data] of telemetryOverlay.clipSeiData) {
            const clipIndex = parseInt(key.split('_')[0]) || 0;
            clipEntries.push({ clipIndex, key, data });
        }
        clipEntries.sort((a, b) => a.clipIndex - b.clipIndex);

        for (const { clipIndex, data } of clipEntries) {
            const frames = data?.frames || data;
            if (!frames || !Array.isArray(frames) || !frames.length) continue;

            const baseTime = clipStartTimes[clipIndex] !== undefined
                ? clipStartTimes[clipIndex]
                : clipIndex * defaultDuration;
            const clipDuration = cachedDurations[clipIndex] || defaultDuration;

            for (let i = 0; i < frames.length; i++) {
                const frame = frames[i];
                const timeInClip = (i / frames.length) * clipDuration;
                const absoluteTime = baseTime + timeInClip;

                if (timeRange) {
                    const bufferBefore = 10;
                    if (absoluteTime < (timeRange.start - bufferBefore) || absoluteTime > timeRange.end) {
                        continue;
                    }
                }

                rawPoints.push({
                    time: absoluteTime,
                    speed_mph: frame.speed_mph || 0,
                    brake: frame.brake_applied || frame.brake || false,
                    throttle: frame.throttle || 0,
                    turn_signal: frame.turn_signal_name || 'NONE',
                    autopilot: frame.autopilot_name || 'NONE',
                    heading: frame.heading_deg || 0,
                    steering: frame.steering_wheel_angle || 0
                });
            }
        }

        rawPoints.sort((a, b) => a.time - b.time);
        return rawPoints;
    }

    /**
     * Calculate haversine distance between two GPS points
     * @returns {number} Distance in meters
     */
    _haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371000; // Earth radius in meters
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * Convert heading degrees to compass direction
     * @param {number} heading - Heading in degrees (0-360)
     * @returns {string} Compass direction
     */
    _headingToCompass(heading) {
        const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
            'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        const index = Math.round(heading / 22.5) % 16;
        return directions[index];
    }

    /**
     * Add recording info section with camera status, files, day/night, weather
     * @param {jsPDF} doc
     * @param {Object} event
     * @param {number} y
     * @returns {number}
     */
    _addRecordingInfoSection(doc, event, y) {
        // Check if we need a new page
        if (y > this.pageHeight - 200) {
            doc.addPage();
            y = this.margin;
        }

        y = this._addSectionTitle(doc, 'Recording Information', y);

        // === CAMERA STATUS ===
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(50, 50, 50);
        doc.text('Camera Status', this.margin, y);
        y += 15;

        const videos = this.videoPlayer?.videos || {};
        const cameraStatus = [];
        for (const [name, video] of Object.entries(videos)) {
            if (video) {
                const hasVideo = video.src && video.videoWidth > 0;
                cameraStatus.push({
                    name: this._formatCameraName(name),
                    status: hasVideo ? 'Recording' : 'No Data',
                    working: hasVideo
                });
            }
        }

        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        const workingCount = cameraStatus.filter(c => c.working).length;
        doc.setTextColor(workingCount === cameraStatus.length ? 0 : 200, workingCount > 0 ? 100 : 0, 0);
        doc.text(`${workingCount} of ${cameraStatus.length} cameras active`, this.margin, y);
        y += 12;

        for (const cam of cameraStatus) {
            doc.setTextColor(cam.working ? 0 : 150, cam.working ? 120 : 0, 0);
            doc.text(`• ${cam.name}: ${cam.status}`, this.margin + 10, y);
            y += 11;
        }
        y += 5;

        // === DAY/NIGHT INDICATOR ===
        y += 5;
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(50, 50, 50);
        doc.text('Lighting Conditions', this.margin, y);
        y += 15;

        const eventDate = new Date(event.timestamp);
        const hour = eventDate.getHours();
        let lightingCondition = 'Day';
        let lightingDetail = '';

        if (hour >= 6 && hour < 8) {
            lightingCondition = 'Dawn';
            lightingDetail = 'Early morning, sun rising';
        } else if (hour >= 8 && hour < 17) {
            lightingCondition = 'Day';
            lightingDetail = 'Daylight hours';
        } else if (hour >= 17 && hour < 20) {
            lightingCondition = 'Dusk';
            lightingDetail = 'Evening, sun setting';
        } else {
            lightingCondition = 'Night';
            lightingDetail = 'Nighttime conditions';
        }

        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(50, 50, 50);
        doc.text(`${lightingCondition} - ${lightingDetail}`, this.margin, y);
        y += 12;
        doc.setTextColor(100, 100, 100);
        doc.text(`Event time: ${eventDate.toLocaleTimeString()}`, this.margin, y);
        y += 15;

        // === WEATHER CONDITIONS ===
        const { start: startGps } = this._getStartEndGPS();
        if (startGps && event.timestamp) {
            y += 5;
            doc.setFontSize(11);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(50, 50, 50);
            doc.text('Weather Conditions', this.margin, y);
            y += 15;

            doc.setFontSize(10);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(100, 100, 100);
            doc.text('(Weather data from Open-Meteo historical archive)', this.margin, y);
            y += 12;

            // Weather will be fetched and added asynchronously if available
            // For now, show placeholder - actual fetch happens in generate()
            if (this._weatherData) {
                doc.setTextColor(50, 50, 50);
                doc.text(`Temperature: ${this._weatherData.temperature}°F`, this.margin, y);
                y += 12;
                doc.text(`Conditions: ${this._weatherData.conditions}`, this.margin, y);
                y += 12;
                if (this._weatherData.precipitation > 0) {
                    doc.text(`Precipitation: ${this._weatherData.precipitation} mm`, this.margin, y);
                    y += 12;
                }
                doc.text(`Visibility: ${this._weatherData.visibility} km`, this.margin, y);
                y += 12;
                doc.text(`Wind: ${this._weatherData.windSpeed} mph ${this._weatherData.windDirection}`, this.margin, y);
                y += 12;
            } else {
                doc.setTextColor(150, 150, 150);
                doc.text('Weather data not available for this location/time.', this.margin, y);
                y += 12;
            }
            y += 5;
        }

        // === VIDEO FILES ===
        y += 5;
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(50, 50, 50);
        doc.text('Video Files', this.margin, y);
        y += 15;

        // Get clip info from event or videoPlayer
        const eventClips = event.clips || [];
        const playerClips = this.videoPlayer?.clips || [];
        const clips = eventClips.length > 0 ? eventClips : playerClips;
        const totalClips = clips.length || (this.videoPlayer?.cachedClipDurations?.length || 0);
        const clipDurations = this.videoPlayer?.cachedClipDurations || [];
        const totalDuration = clipDurations.reduce((a, b) => a + b, 0) || totalClips * 60;

        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(50, 50, 50);
        doc.text(`Total clips: ${totalClips}`, this.margin, y);
        y += 12;
        doc.text(`Total duration: ${this._formatTime(totalDuration)} (${(totalDuration / 60).toFixed(1)} minutes)`, this.margin, y);
        y += 12;

        // List clip details with durations
        if (totalClips > 0) {
            doc.setTextColor(100, 100, 100);
            doc.text('Clip details:', this.margin, y);
            y += 12;

            const maxClipsToShow = Math.min(5, totalClips);
            let cumTime = 0;

            for (let i = 0; i < maxClipsToShow; i++) {
                const clip = clips[i];
                const duration = clipDurations[i] || 60;

                // Try to extract timestamp from clip filename
                let clipInfo = `Clip ${i + 1}`;
                if (clip) {
                    // Handle different clip structures
                    const clipFile = clip.front || clip.back || clip.left_repeater || clip.right_repeater || clip;
                    const clipName = clipFile?.name || clipFile?.filename || '';
                    const timestampMatch = clipName.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
                    if (timestampMatch) {
                        clipInfo = timestampMatch[1].replace(/_/g, ' ').replace(/-/g, ':');
                    }
                }

                doc.text(`• ${clipInfo} (${duration.toFixed(1)}s, starts at ${this._formatTime(cumTime)})`, this.margin + 10, y);
                cumTime += duration;
                y += 11;
            }
            if (totalClips > 5) {
                doc.text(`... and ${totalClips - 5} more clips`, this.margin + 10, y);
                y += 11;
            }
        } else {
            doc.setTextColor(150, 150, 150);
            doc.text('Clip information not available.', this.margin, y);
            y += 12;
        }

        return y + 15;
    }

    /**
     * Fetch historical weather data from Open-Meteo
     * @param {Object} event
     * @returns {Promise<Object|null>}
     */
    async _fetchWeatherData(event) {
        try {
            const { start: startGps } = this._getStartEndGPS();
            if (!startGps || !event.timestamp) {
                console.log('[InsuranceReport] No GPS or timestamp for weather fetch');
                return null;
            }

            const eventDate = new Date(event.timestamp);
            const dateStr = eventDate.toISOString().split('T')[0]; // YYYY-MM-DD
            const hour = eventDate.getHours();

            // Open-Meteo historical weather API
            const url = `https://archive-api.open-meteo.com/v1/archive?` +
                `latitude=${startGps.lat.toFixed(4)}` +
                `&longitude=${startGps.lon.toFixed(4)}` +
                `&start_date=${dateStr}` +
                `&end_date=${dateStr}` +
                `&hourly=temperature_2m,precipitation,weathercode,visibility,windspeed_10m,winddirection_10m` +
                `&temperature_unit=fahrenheit` +
                `&windspeed_unit=mph` +
                `&timezone=auto`;

            console.log('[InsuranceReport] Fetching weather from:', url);

            const response = await fetch(url, { timeout: 5000 });
            if (!response.ok) {
                console.warn('[InsuranceReport] Weather API error:', response.status);
                return null;
            }

            const data = await response.json();

            if (!data.hourly || !data.hourly.time) {
                console.warn('[InsuranceReport] No hourly weather data');
                return null;
            }

            // Find the hour closest to our event time
            const hourIndex = Math.min(hour, data.hourly.time.length - 1);

            const weatherCode = data.hourly.weathercode?.[hourIndex] || 0;
            const conditions = this._weatherCodeToDescription(weatherCode);

            const windDir = data.hourly.winddirection_10m?.[hourIndex] || 0;
            const windDirStr = this._headingToCompass(windDir);

            const weatherData = {
                temperature: Math.round(data.hourly.temperature_2m?.[hourIndex] || 0),
                conditions: conditions,
                precipitation: data.hourly.precipitation?.[hourIndex] || 0,
                visibility: (data.hourly.visibility?.[hourIndex] || 10000) / 1000, // Convert m to km
                windSpeed: Math.round(data.hourly.windspeed_10m?.[hourIndex] || 0),
                windDirection: windDirStr,
                weatherCode: weatherCode
            };

            console.log('[InsuranceReport] Weather data:', weatherData);
            return weatherData;

        } catch (e) {
            console.warn('[InsuranceReport] Failed to fetch weather:', e);
            return null;
        }
    }

    /**
     * Convert WMO weather code to human-readable description
     * @param {number} code
     * @returns {string}
     */
    _weatherCodeToDescription(code) {
        const codes = {
            0: 'Clear sky',
            1: 'Mainly clear',
            2: 'Partly cloudy',
            3: 'Overcast',
            45: 'Foggy',
            48: 'Depositing rime fog',
            51: 'Light drizzle',
            53: 'Moderate drizzle',
            55: 'Dense drizzle',
            56: 'Light freezing drizzle',
            57: 'Dense freezing drizzle',
            61: 'Slight rain',
            63: 'Moderate rain',
            65: 'Heavy rain',
            66: 'Light freezing rain',
            67: 'Heavy freezing rain',
            71: 'Slight snow',
            73: 'Moderate snow',
            75: 'Heavy snow',
            77: 'Snow grains',
            80: 'Slight rain showers',
            81: 'Moderate rain showers',
            82: 'Violent rain showers',
            85: 'Slight snow showers',
            86: 'Heavy snow showers',
            95: 'Thunderstorm',
            96: 'Thunderstorm with slight hail',
            99: 'Thunderstorm with heavy hail'
        };
        return codes[code] || `Unknown (code ${code})`;
    }

    /**
     * Format autopilot status for display
     * @param {string} status
     * @returns {string}
     */
    _formatApStatus(status) {
        if (!status || status === 'NONE' || status === 'OFF' || status === 'DISABLED') {
            return 'Manual Control (No Autopilot)';
        }
        const statusMap = {
            'ACC': 'Traffic-Aware Cruise Control (TACC)',
            'TACC': 'Traffic-Aware Cruise Control (TACC)',
            'AUTOSTEER': 'Autosteer',
            'AP': 'Autopilot',
            'FSD': 'Full Self-Driving (FSD)',
            'FSD_BETA': 'Full Self-Driving Beta',
            'NAV_ON_AUTOPILOT': 'Navigate on Autopilot',
            'LANE_CHANGE': 'Auto Lane Change',
            'SUMMON': 'Summon',
            'SMART_SUMMON': 'Smart Summon',
            'AUTOPARK': 'Autopark'
        };
        return statusMap[status.toUpperCase()] || status;
    }

    /**
     * Format camera name for display
     * @param {string} name
     * @returns {string}
     */
    _formatCameraName(name) {
        const nameMap = {
            'front': 'Front Camera',
            'back': 'Rear Camera',
            'left_repeater': 'Left Repeater',
            'right_repeater': 'Right Repeater',
            'front_wide': 'Front Wide Camera',
            'cabin': 'Cabin Camera',
            'left_pillar': 'Left Pillar Camera',
            'right_pillar': 'Right Pillar Camera'
        };
        return nameMap[name] || name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    /**
     * Add footer to all pages
     * @param {jsPDF} doc
     */
    _addFooter(doc) {
        const pageCount = doc.internal.getNumberOfPages();
        const version = window.app?.versionManager?.currentVersion || 'unknown';

        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);

            // Footer line
            doc.setDrawColor(200, 200, 200);
            doc.line(this.margin, this.pageHeight - 45, this.pageWidth - this.margin, this.pageHeight - 45);

            // Page number
            doc.setFontSize(9);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(100, 100, 100);
            doc.text(`Page ${i} of ${pageCount}`, this.pageWidth / 2, this.pageHeight - 12, { align: 'center' });

            // Generator info with version
            doc.setFontSize(7);
            doc.setFont('helvetica', 'normal');
            doc.text(`Generated by TeslaCamViewer.com v${version}`, this.margin, this.pageHeight - 32);

            // Liability disclaimer
            doc.setFontSize(6);
            doc.setFont('helvetica', 'italic');
            doc.setTextColor(120, 120, 120);
            const disclaimer = 'Data accuracy is not guaranteed. This report is provided for informational purposes only. TeslaCamViewer.com assumes no liability for the accuracy, completeness, or use of this information.';
            const disclaimerLines = doc.splitTextToSize(disclaimer, this.contentWidth);
            doc.text(disclaimerLines, this.margin, this.pageHeight - 22);
        }
    }

    /**
     * Add section title
     * @param {jsPDF} doc
     * @param {string} title
     * @param {number} y
     * @returns {number}
     */
    _addSectionTitle(doc, title, y) {
        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(0, 150, 200);
        doc.text(title, this.margin, y);

        // Underline
        doc.setDrawColor(0, 150, 200);
        doc.setLineWidth(1);
        doc.line(this.margin, y + 3, this.margin + doc.getTextWidth(title), y + 3);

        return y + 25;
    }

    /**
     * Format event category for display
     * @param {string} type
     * @returns {string}
     */
    _formatEventCategory(type) {
        const categoryMap = {
            'SentryClips': 'Sentry Mode Event',
            'SavedClips': 'User-Saved Recording (Manual)',
            'RecentClips': 'Recent Dashcam Recording (Automatic)'
        };
        return categoryMap[type] || type || 'Unknown';
    }

    /**
     * Format trigger reason with detailed description
     * @param {string} reason
     * @returns {string}
     */
    _formatTriggerReason(reason) {
        if (!reason) return 'Unknown';

        // Known trigger reason mappings with detailed descriptions
        const reasonMap = {
            'user_interaction_dashcam_launcher_action_tapped': 'Manual Save - Driver pressed save button',
            'user_interaction_dashcam_icon_tapped': 'Manual Save - Driver tapped dashcam icon',
            'user_interaction_honk': 'Manual Save - Horn honked (save triggered)',
            'sentry_aware_object_detection': 'Sentry Mode - Motion/object detected near vehicle',
            'sentry_aware_accel': 'Sentry Mode - Vehicle was bumped or impacted',
            'sentry_baseline_hit': 'Sentry Mode - Baseline event triggered',
            'sentry_post_drive': 'Sentry Mode - Post-drive security recording',
            'auto_save': 'Automatic Save - System triggered',
            'collision': 'Collision Detected - Impact sensors triggered',
            'airbag': 'Airbag Deployment - Serious collision detected',
            'emergency_brake': 'Emergency Braking - AEB triggered',
            'forward_collision_warning': 'Forward Collision Warning - FCW triggered',
            'lane_departure': 'Lane Departure Warning triggered'
        };

        // Check for exact match
        if (reasonMap[reason]) {
            return reasonMap[reason];
        }

        // Check for partial matches
        for (const [key, value] of Object.entries(reasonMap)) {
            if (reason.toLowerCase().includes(key.replace(/_/g, '').toLowerCase()) ||
                reason.toLowerCase().includes(key)) {
                // For sentry_aware_accel, try to extract G-force value
                if (key === 'sentry_aware_accel') {
                    const accelMatch = reason.match(/sentry_aware_accel[_\s]*([\d.]+)/i);
                    if (accelMatch) {
                        return `${value} (${accelMatch[1]}g force)`;
                    }
                }
                return value;
            }
        }

        // Fallback: clean up the reason string
        return reason
            .replace(/_/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .trim();
    }

    /**
     * Format event type for display (legacy, kept for compatibility)
     * @param {string} type
     * @param {string} reason
     * @returns {string}
     */
    _formatEventType(type, reason) {
        const typeMap = {
            'SentryClips': 'Sentry Mode Event',
            'SavedClips': 'User-Saved Recording',
            'RecentClips': 'Recent Dashcam Recording'
        };

        let formatted = typeMap[type] || type;

        if (reason) {
            formatted += ` (${this._formatReason(reason)})`;
        }

        return formatted;
    }

    /**
     * Format reason string (short version for timeline)
     * @param {string} reason
     * @returns {string}
     */
    _formatReason(reason) {
        if (!reason) return 'Unknown';

        // Short mappings for timeline display
        const shortMap = {
            'user_interaction_dashcam_launcher_action_tapped': 'Manual Save',
            'user_interaction_dashcam_icon_tapped': 'Manual Save',
            'user_interaction_honk': 'Horn Save',
            'sentry_aware_object_detection': 'Motion Detected',
            'sentry_aware_accel': 'Vehicle Bumped',
            'sentry_baseline_hit': 'Sentry Event',
            'sentry_post_drive': 'Post-Drive Recording'
        };

        // Check for exact match
        if (shortMap[reason]) {
            return shortMap[reason];
        }

        // Check for partial matches
        for (const [key, value] of Object.entries(shortMap)) {
            if (reason.toLowerCase().includes(key)) {
                // Extract G-force for sentry_aware_accel
                if (key === 'sentry_aware_accel') {
                    const accelMatch = reason.match(/sentry_aware_accel[_\s]*([\d.]+)/i);
                    if (accelMatch) {
                        return `${value} (${accelMatch[1]}g)`;
                    }
                }
                return value;
            }
        }

        // Fallback: clean up
        return reason
            .replace(/_/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .substring(0, 30); // Limit length for timeline
    }

    /**
     * Format location from event data
     * @param {Object} event
     * @returns {string}
     */
    _formatLocation(event) {
        const parts = [];
        // Check both event level and metadata level for location data
        const street = event.street || event.metadata?.street;
        const city = event.city || event.metadata?.city;

        if (street) parts.push(street);
        if (city) parts.push(city);

        if (parts.length === 0) {
            // Try event/metadata GPS first
            let lat = event.est_lat || event.metadata?.est_lat;
            let lon = event.est_lon || event.metadata?.est_lon;

            // Fall back to telemetry GPS data (useful for RecentClips which don't have event.json)
            if (!lat || !lon) {
                const telemetryData = this._getTelemetryGPS();
                if (telemetryData) {
                    lat = telemetryData.lat;
                    lon = telemetryData.lon;
                }
            }

            if (lat && lon) {
                return `GPS: ${parseFloat(lat).toFixed(6)}, ${parseFloat(lon).toFixed(6)}`;
            }
            return 'Location not available';
        }

        return parts.join(', ');
    }

    /**
     * Get GPS coordinates from telemetry data
     * Prefers: IN point GPS > current playback GPS > middle of event GPS
     * @returns {Object|null} {lat, lon} or null if not available
     */
    _getTelemetryGPS() {
        const telemetryOverlay = window.app?.telemetryOverlay;
        const clipMarking = window.app?.clipMarking;
        const marks = clipMarking?.getMarks() || { inPoint: null, outPoint: null };

        // Use cached clip durations for accurate timing (not 60-second approximation)
        const cachedDurations = this.videoPlayer?.cachedClipDurations || [];
        const defaultDuration = 60;

        // Pre-calculate cumulative times for each clip using cached durations
        const clipStartTimes = [0];
        for (let i = 0; i < cachedDurations.length; i++) {
            clipStartTimes.push(clipStartTimes[i] + (cachedDurations[i] || defaultDuration));
        }

        // If we have IN/OUT marks, get GPS near the IN point
        if (marks.inPoint !== null && telemetryOverlay?.clipSeiData) {
            const targetTime = marks.inPoint;

            // Parse clip entries and sort
            const clipEntries = [];
            for (const [key, data] of telemetryOverlay.clipSeiData) {
                const clipIndex = parseInt(key.split('_')[0]) || 0;
                clipEntries.push({ clipIndex, key, data });
            }
            clipEntries.sort((a, b) => a.clipIndex - b.clipIndex);

            let closestGps = null;
            let closestTimeDiff = Infinity;

            for (const { clipIndex, data } of clipEntries) {
                const frames = data?.frames || data;
                if (!frames || !Array.isArray(frames)) continue;

                // Get base time from pre-calculated cumulative times
                const baseTime = clipStartTimes[clipIndex] !== undefined
                    ? clipStartTimes[clipIndex]
                    : clipIndex * defaultDuration;
                const clipDuration = cachedDurations[clipIndex] || defaultDuration;

                for (let i = 0; i < frames.length; i++) {
                    const frame = frames[i];
                    if (frame.latitude_deg && frame.longitude_deg) {
                        const timeInClip = (i / frames.length) * clipDuration;
                        const absoluteTime = baseTime + timeInClip;
                        const timeDiff = Math.abs(absoluteTime - targetTime);

                        if (timeDiff < closestTimeDiff) {
                            closestTimeDiff = timeDiff;
                            closestGps = {
                                lat: frame.latitude_deg,
                                lon: frame.longitude_deg
                            };
                        }
                    }
                }
            }

            if (closestGps) {
                console.log(`[InsuranceReport] Using GPS near IN point (${closestTimeDiff.toFixed(1)}s away)`);
                return closestGps;
            }
        }

        // Try current playback data
        if (telemetryOverlay?.currentData) {
            const data = telemetryOverlay.currentData;
            if (data.latitude_deg && data.longitude_deg) {
                console.log('[InsuranceReport] Using current playback GPS');
                return {
                    lat: data.latitude_deg,
                    lon: data.longitude_deg
                };
            }
        }

        // Fallback to middle of event GPS
        if (telemetryOverlay?.clipSeiData) {
            const allGpsFrames = [];
            for (const [key, data] of telemetryOverlay.clipSeiData) {
                const frames = data?.frames || data;
                if (frames && Array.isArray(frames)) {
                    for (const frame of frames) {
                        if (frame.latitude_deg && frame.longitude_deg) {
                            allGpsFrames.push({
                                lat: frame.latitude_deg,
                                lon: frame.longitude_deg
                            });
                        }
                    }
                }
            }

            if (allGpsFrames.length > 0) {
                const middleIndex = Math.floor(allGpsFrames.length / 2);
                console.log(`[InsuranceReport] Using middle GPS from ${allGpsFrames.length} frames`);
                return allGpsFrames[middleIndex];
            }
        }

        console.log('[InsuranceReport] No GPS data available');
        return null;
    }

    /**
     * Get start and end GPS coordinates from telemetry data
     * @returns {Object} {start: {lat, lon}, end: {lat, lon}} or nulls if not available
     */
    _getStartEndGPS() {
        const telemetryOverlay = window.app?.telemetryOverlay;
        const clipMarking = window.app?.clipMarking;
        const marks = clipMarking?.getMarks() || { inPoint: null, outPoint: null };

        // Use cached clip durations for accurate timing
        const cachedDurations = this.videoPlayer?.cachedClipDurations || [];
        const defaultDuration = 60;

        // Pre-calculate cumulative times for each clip
        const clipStartTimes = [0];
        for (let i = 0; i < cachedDurations.length; i++) {
            clipStartTimes.push(clipStartTimes[i] + (cachedDurations[i] || defaultDuration));
        }

        if (!telemetryOverlay?.clipSeiData) {
            return { start: null, end: null };
        }

        // Collect all GPS points with times
        const allGpsPoints = [];

        const clipEntries = [];
        for (const [key, data] of telemetryOverlay.clipSeiData) {
            const clipIndex = parseInt(key.split('_')[0]) || 0;
            clipEntries.push({ clipIndex, key, data });
        }
        clipEntries.sort((a, b) => a.clipIndex - b.clipIndex);

        for (const { clipIndex, data } of clipEntries) {
            const frames = data?.frames || data;
            if (!frames || !Array.isArray(frames)) continue;

            const baseTime = clipStartTimes[clipIndex] !== undefined
                ? clipStartTimes[clipIndex]
                : clipIndex * defaultDuration;
            const clipDuration = cachedDurations[clipIndex] || defaultDuration;

            for (let i = 0; i < frames.length; i++) {
                const frame = frames[i];
                if (frame.latitude_deg && frame.longitude_deg) {
                    const timeInClip = (i / frames.length) * clipDuration;
                    const absoluteTime = baseTime + timeInClip;
                    allGpsPoints.push({
                        time: absoluteTime,
                        lat: frame.latitude_deg,
                        lon: frame.longitude_deg
                    });
                }
            }
        }

        if (allGpsPoints.length === 0) {
            return { start: null, end: null };
        }

        // Sort by time
        allGpsPoints.sort((a, b) => a.time - b.time);

        // Determine time range (IN/OUT marks or full event)
        let startTime = allGpsPoints[0].time;
        let endTime = allGpsPoints[allGpsPoints.length - 1].time;

        if (marks.inPoint !== null && marks.outPoint !== null) {
            startTime = marks.inPoint;
            endTime = marks.outPoint;
        }

        // Find GPS point closest to start time
        let startGps = null;
        let startDiff = Infinity;
        for (const p of allGpsPoints) {
            const diff = Math.abs(p.time - startTime);
            if (diff < startDiff) {
                startDiff = diff;
                startGps = { lat: p.lat, lon: p.lon };
            }
        }

        // Find GPS point closest to end time
        let endGps = null;
        let endDiff = Infinity;
        for (const p of allGpsPoints) {
            const diff = Math.abs(p.time - endTime);
            if (diff < endDiff) {
                endDiff = diff;
                endGps = { lat: p.lat, lon: p.lon };
            }
        }

        console.log(`[InsuranceReport] Start GPS: ${startGps?.lat?.toFixed(6)}, ${startGps?.lon?.toFixed(6)}`);
        console.log(`[InsuranceReport] End GPS: ${endGps?.lat?.toFixed(6)}, ${endGps?.lon?.toFixed(6)}`);

        return { start: startGps, end: endGps };
    }

    /**
     * Format time in MM:SS format
     * @param {number} seconds
     * @returns {string}
     */
    _formatTime(seconds) {
        if (seconds === null || seconds === undefined) return '00:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Reverse geocode coordinates to address
     * @param {number} lat
     * @param {number} lon
     * @returns {Promise<string|null>}
     */
    async _reverseGeocode(lat, lon) {
        try {
            const response = await fetch(
                `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
                {
                    headers: {
                        'User-Agent': 'TeslaCamViewer/1.0'
                    }
                }
            );

            if (!response.ok) return null;

            const data = await response.json();
            return data.display_name || null;
        } catch (e) {
            console.warn('[InsuranceReport] Geocoding error:', e);
            return null;
        }
    }

    /**
     * Capture map screenshot using static map service
     * @param {number} lat
     * @param {number} lon
     * @returns {Promise<string|null>} Base64 image data
     */
    async _captureMapScreenshot(lat, lon) {
        try {
            // Use OpenStreetMap static map
            const zoom = 16;
            const width = 400;
            const height = 240;

            // Create a canvas with OpenStreetMap tiles
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');

            // Load map tile
            const tileUrl = `https://tile.openstreetmap.org/${zoom}/${this._lonToTile(lon, zoom)}/${this._latToTile(lat, zoom)}.png`;

            const img = new Image();
            img.crossOrigin = 'anonymous';

            return new Promise((resolve, reject) => {
                img.onload = () => {
                    // Draw tile (centered)
                    ctx.drawImage(img, 0, 0, width, height);

                    // Draw marker at center
                    ctx.fillStyle = '#ff0000';
                    ctx.beginPath();
                    ctx.arc(width / 2, height / 2, 8, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 2;
                    ctx.stroke();

                    resolve(canvas.toDataURL('image/png'));
                };
                img.onerror = () => reject(new Error('Failed to load map tile'));
                img.src = tileUrl;
            });
        } catch (e) {
            console.warn('[InsuranceReport] Map screenshot error:', e);
            return null;
        }
    }

    /**
     * Convert longitude to tile X coordinate
     * @param {number} lon
     * @param {number} zoom
     * @returns {number}
     */
    _lonToTile(lon, zoom) {
        return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
    }

    /**
     * Convert latitude to tile Y coordinate
     * @param {number} lat
     * @param {number} zoom
     * @returns {number}
     */
    _latToTile(lat, zoom) {
        return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) +
            1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
    }

    /**
     * Determine which frames to capture
     * @param {Object} options
     * @returns {Promise<Array>}
     */
    async _determineFrameTimes(options) {
        const clipMarking = window.app?.clipMarking;
        const marks = clipMarking?.getMarks() || { inPoint: null, outPoint: null };

        const totalDuration = await this.videoPlayer.getTotalDuration() || 60;
        const frames = [];

        if (marks.inPoint !== null && marks.outPoint !== null) {
            // Use marked range
            const duration = marks.outPoint - marks.inPoint;

            // Before incident
            frames.push({
                time: Math.max(0, marks.inPoint - 5),
                label: 'Before Incident'
            });

            // Start of incident
            frames.push({
                time: marks.inPoint,
                label: 'Incident Start'
            });

            // Middle of incident
            frames.push({
                time: marks.inPoint + duration / 2,
                label: 'During Incident'
            });

            // End of incident
            frames.push({
                time: marks.outPoint,
                label: 'Incident End'
            });

        } else {
            // No marks - capture key moments spread across entire event
            // This provides a good overview of the full recording

            // Start - shows all cameras working (a few seconds in to ensure video loaded)
            frames.push({
                time: Math.min(3, totalDuration * 0.01),
                label: 'Start'
            });

            // First quarter (around 25%)
            frames.push({
                time: totalDuration * 0.25,
                label: 'First Quarter'
            });

            // Middle of event (around 50%)
            frames.push({
                time: totalDuration * 0.5,
                label: 'Middle'
            });

            // Third quarter (around 75%)
            frames.push({
                time: totalDuration * 0.75,
                label: 'Third Quarter'
            });

            // End - last valid frame, critical for accident scenarios
            // Use totalDuration - 1 to ensure we get valid frame data
            frames.push({
                time: Math.max(0, totalDuration - 1),
                label: 'End'
            });
        }

        return frames;
    }

    /**
     * Wait for frame to render
     * @param {number} ms
     * @returns {Promise<void>}
     */
    _waitForFrame(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Wait for all videos to be ready for capture
     * Ensures readyState >= 2 for all loaded videos
     * @param {number} maxWait - Maximum wait time in ms (default: 5000)
     * @returns {Promise<void>}
     */
    async _waitForAllVideosReady(maxWait = 5000) {
        const videos = this.videoPlayer.videos;
        const startTime = Date.now();

        // Get list of videos that have sources
        const loadedVideos = Object.entries(videos)
            .filter(([name, video]) => video && video.src)
            .map(([name, video]) => ({ name, video }));

        if (loadedVideos.length === 0) {
            console.warn('[InsuranceReport] No videos loaded');
            return;
        }

        // Wait for all videos to reach readyState >= 2 (HAVE_CURRENT_DATA)
        while (Date.now() - startTime < maxWait) {
            const allReady = loadedVideos.every(({ video }) =>
                video.readyState >= 2 && video.videoWidth > 0
            );

            if (allReady) {
                // Extra small delay to ensure frame is painted
                await this._waitForFrame(100);
                return;
            }

            // Check every 50ms
            await this._waitForFrame(50);
        }

        // Log which videos weren't ready
        const notReady = loadedVideos.filter(({ video }) =>
            video.readyState < 2 || video.videoWidth === 0
        );
        if (notReady.length > 0) {
            console.warn('[InsuranceReport] Some videos not ready after timeout:',
                notReady.map(({ name, video }) =>
                    `${name}: readyState=${video.readyState}, size=${video.videoWidth}x${video.videoHeight}`
                ).join(', ')
            );
        }
    }

    /**
     * Capture current video frame
     * @returns {Promise<string>} Base64 image data
     */
    async _captureCurrentFrame() {
        const videos = this.videoPlayer.videos;
        const layoutManager = window.app?.layoutManager;

        // Create canvas
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Get video dimensions
        const firstVideo = Object.values(videos).find(v => v && v.src && v.videoWidth);
        const videoWidth = firstVideo?.videoWidth || 1280;
        const videoHeight = firstVideo?.videoHeight || 960;

        // Get layout configuration
        let layoutConfig = null;
        if (layoutManager && layoutManager.renderer) {
            layoutConfig = layoutManager.getCurrentConfig();
            if (layoutConfig) {
                const exportConfig = layoutManager.renderer.calculateExportConfig(
                    layoutConfig, videoWidth, videoHeight
                );
                canvas.width = exportConfig.canvasWidth;
                canvas.height = exportConfig.canvasHeight;
                layoutConfig = exportConfig;
            }
        }

        // Fallback to 2x2 grid
        if (!layoutConfig) {
            canvas.width = videoWidth * 2;
            canvas.height = videoHeight * 2;
        }

        // Fill background
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Apply video enhancements
        const enhancer = window.app?.videoEnhancer;
        if (enhancer && enhancer.settings) {
            const { brightness, contrast, saturation } = enhancer.settings;
            if (brightness !== 100 || contrast !== 100 || saturation !== 100) {
                ctx.filter = `brightness(${brightness / 100}) contrast(${contrast / 100}) saturate(${saturation / 100})`;
            }
        }

        if (layoutConfig && layoutConfig.cameras) {
            // Draw using current layout
            const sortedCameras = Object.entries(layoutConfig.cameras)
                .filter(([name, cam]) => cam.visible && cam.w > 0 && cam.h > 0)
                .sort((a, b) => (a[1].zIndex || 1) - (b[1].zIndex || 1));

            for (const [cameraName, camConfig] of sortedCameras) {
                const video = videos[cameraName];
                if (!video || !video.src || video.readyState < 2) continue;

                const crop = camConfig.crop || { top: 0, right: 0, bottom: 0, left: 0 };
                const vw = video.videoWidth;
                const vh = video.videoHeight;
                const sx = vw * (crop.left / 100);
                const sy = vh * (crop.top / 100);
                const sw = vw * (1 - crop.left / 100 - crop.right / 100);
                const sh = vh * (1 - crop.top / 100 - crop.bottom / 100);

                ctx.drawImage(video, sx, sy, sw, sh, camConfig.x, camConfig.y, camConfig.w, camConfig.h);
            }
        } else {
            // Fallback 2x2 grid
            if (videos.front?.src) ctx.drawImage(videos.front, 0, 0, videoWidth, videoHeight);
            if (videos.back?.src) ctx.drawImage(videos.back, videoWidth, 0, videoWidth, videoHeight);
            if (videos.left_repeater?.src) ctx.drawImage(videos.left_repeater, 0, videoHeight, videoWidth, videoHeight);
            if (videos.right_repeater?.src) ctx.drawImage(videos.right_repeater, videoWidth, videoHeight, videoWidth, videoHeight);
        }

        // Reset filter and add timestamp
        ctx.filter = 'none';
        this._addFrameTimestamp(ctx, canvas.width, canvas.height);

        return canvas.toDataURL('image/png', 0.9);
    }

    /**
     * Add timestamp overlay to frame
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} width
     * @param {number} height
     */
    _addFrameTimestamp(ctx, width, height) {
        const event = this.videoPlayer.currentEvent;
        if (!event) return;

        const currentTime = this.videoPlayer.getCurrentTime();
        const eventDate = new Date(event.timestamp);

        // Format timestamp
        const dateStr = eventDate.toLocaleDateString();
        const timeStr = eventDate.toLocaleTimeString();
        const positionStr = this._formatTime(currentTime);

        const text = `${dateStr} ${timeStr} | ${positionStr}`;

        // Draw background bar
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(0, height - 30, width, 30);

        // Draw text
        ctx.font = 'bold 14px Arial';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(text, width / 2, height - 10);
    }

    /**
     * Analyze telemetry data for statistics
     * @param {TelemetryOverlay} telemetryOverlay
     * @param {Object} timeRange - Optional {start, end} to filter data to IN/OUT range
     * @returns {Object|null}
     */
    _analyzeTelemetryData(telemetryOverlay, timeRange = null) {
        if (!telemetryOverlay.clipSeiData || telemetryOverlay.clipSeiData.size === 0) {
            return null;
        }

        let maxSpeed = 0;
        let totalSpeed = 0;
        let speedCount = 0;
        let maxGForce = 0;
        let maxLateralG = 0;
        let hardBrakingCount = 0;
        let autopilotActive = false;
        let autopilotMode = 'Off';

        // Use cached clip durations for accurate timing
        const cachedDurations = this.videoPlayer?.cachedClipDurations || [];
        const defaultDuration = 60;

        // Pre-calculate cumulative times for each clip using cached durations
        const clipStartTimes = [0];
        for (let i = 0; i < cachedDurations.length; i++) {
            clipStartTimes.push(clipStartTimes[i] + (cachedDurations[i] || defaultDuration));
        }

        // Parse clip entries and sort
        const clipEntries = [];
        for (const [key, data] of telemetryOverlay.clipSeiData) {
            const clipIndex = parseInt(key.split('_')[0]) || 0;
            clipEntries.push({ clipIndex, key, data });
        }
        clipEntries.sort((a, b) => a.clipIndex - b.clipIndex);

        for (const { clipIndex, data } of clipEntries) {
            // Data has a 'frames' property containing the array
            const frames = data?.frames || data;
            if (!frames || !Array.isArray(frames)) continue;

            // Get base time and clip duration from cached values
            const baseTime = clipStartTimes[clipIndex] !== undefined
                ? clipStartTimes[clipIndex]
                : clipIndex * defaultDuration;
            const clipDuration = cachedDurations[clipIndex] || defaultDuration;

            for (let i = 0; i < frames.length; i++) {
                const frame = frames[i];

                // Calculate absolute time for filtering
                if (timeRange) {
                    const timeInClip = (i / frames.length) * clipDuration;
                    const absoluteTime = baseTime + timeInClip;
                    if (absoluteTime < timeRange.start || absoluteTime > timeRange.end) {
                        continue;
                    }
                }

                // Speed
                const speed = frame.speed_mph || 0;
                if (speed > maxSpeed) maxSpeed = speed;
                totalSpeed += speed;
                speedCount++;

                // G-forces - stored as m/s², convert to G by dividing by 9.81
                // linear_acceleration_mps2_x is lateral (turning)
                // linear_acceleration_mps2_y is longitudinal (braking/accel)
                const gX = Math.abs((frame.linear_acceleration_mps2_x || 0) / 9.81);
                const gY = Math.abs((frame.linear_acceleration_mps2_y || 0) / 9.81);
                const totalG = Math.sqrt(gX * gX + gY * gY);

                if (totalG > maxGForce) maxGForce = totalG;
                if (gX > maxLateralG) maxLateralG = gX;

                // Hard braking (>0.5G longitudinal deceleration)
                if (gY > 0.5) {
                    hardBrakingCount++;
                }

                // Autopilot
                if (frame.autopilot_name && frame.autopilot_name !== 'NONE') {
                    autopilotActive = true;
                    autopilotMode = frame.autopilot_name;
                }
            }
        }

        return {
            maxSpeed,
            avgSpeed: speedCount > 0 ? totalSpeed / speedCount : 0,
            maxGForce,
            maxLateralG,
            hardBrakingCount: Math.floor(hardBrakingCount / 30), // Approximate events (30fps)
            autopilotActive,
            autopilotMode
        };
    }

    /**
     * Generate filename for the PDF
     * @param {Object} event
     * @returns {string}
     */
    _generateFilename(event) {
        const date = new Date(event.timestamp);
        const dateStr = date.toISOString().slice(0, 10);
        const timeStr = date.toTimeString().slice(0, 5).replace(':', '-');

        return `TeslaCam_InsuranceReport_${dateStr}_${timeStr}.pdf`;
    }
}

// Export for use in other modules
window.InsuranceReport = InsuranceReport;
