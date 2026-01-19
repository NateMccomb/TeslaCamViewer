/**
 * SEI Extractor for Tesla Dashcam Videos
 * Extracts telemetry data embedded as SEI (Supplemental Enhancement Information)
 * in H.264/H.265 video streams from Tesla firmware 2025.44.25+
 *
 * Based on Tesla's official dashcam tools: https://github.com/teslamotors/dashcam
 */

class SeiExtractor {
    constructor() {
        this.protoRoot = null;
        this.SeiMetadata = null;
        this.isInitialized = false;
        this.initPromise = null;

        // Cache of extracted SEI data per file
        // Key: file path/name, Value: { frames: [], timescale: number, frameDuration: number }
        this.cache = new Map();

        // Gear state enum mapping
        this.GEAR_NAMES = ['P', 'D', 'R', 'N'];

        // Autopilot state enum mapping
        this.AP_NAMES = ['NONE', 'FSD', 'AUTOSTEER', 'TACC'];
    }

    /**
     * Initialize protobuf schema
     * Must be called before extracting SEI data
     */
    async init() {
        if (this.isInitialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this._loadProtobuf();
        await this.initPromise;
        this.isInitialized = true;
    }

    async _loadProtobuf() {
        // Check if protobuf.js is available
        if (typeof protobuf === 'undefined') {
            console.warn('SeiExtractor: protobuf.js not loaded, using manual decoder');
            return;
        }

        try {
            // Load the proto schema
            const response = await fetch('vendor/dashcam.proto');
            const protoContent = await response.text();

            this.protoRoot = protobuf.parse(protoContent).root;
            this.SeiMetadata = this.protoRoot.lookupType('SeiMetadata');
            console.log('SeiExtractor: Protobuf schema loaded successfully');
        } catch (error) {
            console.warn('SeiExtractor: Failed to load protobuf schema, using manual decoder', error);
        }
    }

    /**
     * Extract SEI telemetry data from an MP4 file
     * @param {File} file - The MP4 file to extract from
     * @returns {Promise<Object>} Extracted data with frames array and timing info
     */
    async extractFromFile(file) {
        await this.init();

        // Check cache first
        const cacheKey = `${file.name}_${file.size}_${file.lastModified}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        // Reset debug flags for new file
        this._markerLogged = false;
        this._payloadLogged = false;
        this._protoDecodeLogged = false;
        this._protoErrorLogged = false;
        this._manualDecodeLogged = false;
        this._fieldDebugLogged = false;
        this._throttleLogged = false;
        this._baseSeqLogged = false;

        console.log(`SeiExtractor: Extracting from ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

        try {
            const buffer = await file.arrayBuffer();
            const data = new DataView(buffer);

            const result = this._parseMP4(data);

            if (result.frames.length > 0) {
                this.cache.set(cacheKey, result);
                console.log(`SeiExtractor: Extracted ${result.frames.length} frames with telemetry from ${file.name}`);
            } else {
                console.log(`SeiExtractor: No SEI telemetry found in ${file.name}`);
            }

            return result;
        } catch (error) {
            console.error('SeiExtractor: Error extracting SEI data:', error);
            return { frames: [], timescale: 30, frameDuration: 1 };
        }
    }

    /**
     * Parse MP4 file structure and extract SEI data
     */
    _parseMP4(data) {
        const result = {
            frames: [],
            timescale: 30,
            frameDuration: 1,
            fps: 30,
            baseFrameSeqNo: null,  // First frame's sequence number
            frameSeqMap: new Map() // Map from frameSeqNo to telemetry
        };

        try {
            // Find moov box for timing info
            const moov = this._findBox(data, 'moov', 0, data.byteLength);
            if (moov) {
                const timing = this._extractTimingInfo(data, moov.start, moov.end);
                if (timing) {
                    result.timescale = timing.timescale;
                    result.frameDuration = timing.frameDuration;
                    const calculatedFps = timing.timescale / timing.frameDuration;
                    // Sanity check: Tesla dashcam is ~36fps, so fps should be 20-60
                    result.fps = (calculatedFps >= 20 && calculatedFps <= 60) ? calculatedFps : 36;
                }
            }

            // Find mdat box for video data
            const mdat = this._findBox(data, 'mdat', 0, data.byteLength);
            if (!mdat) {
                console.log('SeiExtractor: No mdat box found');
                return result;
            }

            // Parse NAL units and extract SEI
            result.frames = this._parseNALUnits(data, mdat.dataStart, mdat.end);

            // Build frame sequence map and find base sequence number
            if (result.frames.length > 0) {
                // Find base sequence number from first frame with valid seq
                for (const frame of result.frames) {
                    if (frame.frame_seq_no > 0) {
                        if (result.baseFrameSeqNo === null || frame.frame_seq_no < result.baseFrameSeqNo) {
                            result.baseFrameSeqNo = frame.frame_seq_no;
                        }
                        // Build lookup map
                        result.frameSeqMap.set(frame.frame_seq_no, frame);
                    }
                }

                if (!this._baseSeqLogged && result.baseFrameSeqNo !== null) {
                    console.log(`SeiExtractor: Base frame_seq_no = ${result.baseFrameSeqNo}, fps = ${result.fps.toFixed(2)}`);
                    this._baseSeqLogged = true;
                }
            }

        } catch (error) {
            console.error('SeiExtractor: Error parsing MP4:', error);
        }

        return result;
    }

    /**
     * Find an MP4 box by name
     */
    _findBox(data, name, start, end) {
        let pos = start;

        while (pos < end - 8) {
            let size = data.getUint32(pos);
            const type = this._readAscii(data, pos + 4, 4);

            // Handle extended size
            let headerSize = 8;
            if (size === 1) {
                // 64-bit extended size
                size = Number(data.getBigUint64(pos + 8));
                headerSize = 16;
            } else if (size === 0) {
                // Box extends to end of file
                size = end - pos;
            }

            if (size < 8) break; // Invalid box

            if (type === name) {
                return {
                    start: pos,
                    end: pos + size,
                    dataStart: pos + headerSize,
                    size: size
                };
            }

            // Search inside container boxes
            if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
                const inner = this._findBox(data, name, pos + headerSize, pos + size);
                if (inner) return inner;
            }

            pos += size;
        }

        return null;
    }

    /**
     * Extract timing information from moov/trak
     */
    _extractTimingInfo(data, start, end) {
        // Find stts (sample time table) in video track
        const stts = this._findBox(data, 'stts', start, end);
        const mdhd = this._findBox(data, 'mdhd', start, end);

        let timescale = 30;
        let frameDuration = 1;

        if (mdhd) {
            // Version 0: 4 bytes each, Version 1: 8 bytes each
            const version = data.getUint8(mdhd.dataStart);
            if (version === 0) {
                timescale = data.getUint32(mdhd.dataStart + 12);
            } else {
                timescale = data.getUint32(mdhd.dataStart + 20);
            }
        }

        if (stts) {
            const entryCount = data.getUint32(stts.dataStart + 4);
            if (entryCount > 0) {
                // First entry: sample_count, sample_delta
                frameDuration = data.getUint32(stts.dataStart + 12);
            }
        }

        return { timescale, frameDuration };
    }

    /**
     * Parse NAL units from mdat and extract SEI messages
     */
    _parseNALUnits(data, start, end) {
        const frames = [];
        let pos = start;
        let frameIndex = 0;
        let currentSei = null;

        while (pos < end - 4) {
            // Read NAL unit size (4-byte length prefix in MP4)
            const nalSize = data.getUint32(pos);
            pos += 4;

            if (nalSize === 0 || pos + nalSize > end) {
                pos += 1; // Skip and try to recover
                continue;
            }

            const nalType = data.getUint8(pos) & 0x1F; // H.264 NAL type

            // NAL type 6 = SEI
            if (nalType === 6) {
                currentSei = this._parseSEI(data, pos, pos + nalSize);
            }

            // NAL type 5 = IDR frame (keyframe) or type 1 = non-IDR slice
            // Associate SEI with the frame that follows it
            if (nalType === 5 || nalType === 1) {
                if (currentSei) {
                    currentSei.frameIndex = frameIndex;
                    frames.push(currentSei);
                    currentSei = null;
                }
                frameIndex++;
            }

            pos += nalSize;
        }

        return frames;
    }

    /**
     * Parse SEI NAL unit and extract Tesla telemetry
     * Tesla uses marker bytes 0x42 0x42 0x42 0x69 ("BBBi") before the protobuf payload
     *
     * Based on Tesla's official implementation:
     * - Start at byte 3 of the NAL unit
     * - Skip 0x42 bytes, require at least 4
     * - Check for 0x69 delimiter
     * - Extract protobuf from after 0x69 to end-1
     */
    _parseSEI(data, start, end) {
        // Tesla's approach: Start at byte 3 of the NAL unit
        let i = start + 3;

        // Find consecutive 0x42 bytes
        while (i < end && data.getUint8(i) === 0x42) {
            i++;
        }

        // Need at least 4 bytes of 0x42 padding (i > start + 3)
        // And the next byte must be 0x69
        if (i <= start + 3 || i + 1 >= end || data.getUint8(i) !== 0x69) {
            return null;
        }

        // Debug: Log marker detection (first time only)
        if (!this._markerLogged) {
            const paddingCount = i - (start + 3);
            console.log(`SeiExtractor: Found Tesla marker (${paddingCount} x 0x42 + 0x69)`);
            this._markerLogged = true;
        }

        // Protobuf payload: from (i + 1) to (end - 1)
        // Tesla excludes the last byte, so we do too
        const protoStart = i + 1;
        const protoEnd = end - 1;

        if (protoStart >= protoEnd) {
            return null;
        }

        const rawPayload = new Uint8Array(data.buffer, protoStart, protoEnd - protoStart);
        const payload = this._removeEmulationPreventionBytes(rawPayload);

        // Debug: Log first few bytes of actual protobuf payload
        if (!this._payloadLogged) {
            const payloadPreview = Array.from(payload.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log('SeiExtractor: Protobuf payload (first 32 bytes):', payloadPreview);
            console.log('SeiExtractor: Protobuf payload size:', payload.length, 'bytes');
            this._payloadLogged = true;
        }

        const telemetry = this._decodeProtobuf(payload);
        return telemetry;
    }

    /**
     * Remove H.264 emulation prevention bytes (0x03 after 0x00 0x00)
     */
    _removeEmulationPreventionBytes(data) {
        const result = [];
        let i = 0;

        while (i < data.length) {
            if (i < data.length - 2 &&
                data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x03) {
                result.push(data[i], data[i + 1]);
                i += 3; // Skip the 0x03
            } else {
                result.push(data[i]);
                i++;
            }
        }

        return new Uint8Array(result);
    }

    /**
     * Decode protobuf-encoded telemetry data
     */
    _decodeProtobuf(payload) {
        // Use protobuf.js if available
        if (this.SeiMetadata) {
            try {
                const message = this.SeiMetadata.decode(payload);
                if (!this._protoDecodeLogged) {
                    console.log('SeiExtractor: Using protobuf.js decoder');
                    console.log('SeiExtractor: Decoded message:', JSON.stringify(message, null, 2));
                    this._protoDecodeLogged = true;
                }
                return this._formatTelemetry(message);
            } catch (error) {
                if (!this._protoErrorLogged) {
                    console.warn('SeiExtractor: protobuf.js decode failed, using manual decoder', error.message);
                    this._protoErrorLogged = true;
                }
                // Fall through to manual decoder
            }
        }

        // Manual protobuf decoder as fallback
        const result = this._manualDecode(payload);
        if (result && !this._manualDecodeLogged) {
            console.log('SeiExtractor: Using manual decoder');
            console.log('SeiExtractor: Manual decode result:', JSON.stringify(result, null, 2));
            this._manualDecodeLogged = true;
        }
        return result;
    }

    /**
     * Manual protobuf decoder (fallback when protobuf.js not available)
     */
    _manualDecode(payload) {
        const result = {
            version: 0,
            gear_state: 0,
            frame_seq_no: 0,
            vehicle_speed_mps: 0,
            accelerator_pedal_position: 0,
            steering_wheel_angle: 0,
            blinker_on_left: false,
            blinker_on_right: false,
            brake_applied: false,
            autopilot_state: 0,
            latitude_deg: 0,
            longitude_deg: 0,
            heading_deg: 0,
            linear_acceleration_mps2_x: 0,
            linear_acceleration_mps2_y: 0,
            linear_acceleration_mps2_z: 0
        };

        let pos = 0;
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const debugFields = [];

        while (pos < payload.length) {
            // Read field tag (varint)
            const tag = this._readVarint(payload, pos);
            if (!tag) break;
            pos = tag.pos;

            const fieldNumber = tag.value >>> 3;
            const wireType = tag.value & 0x07;

            // Read value based on wire type
            let value;
            let valueRead = false;
            let parseError = false;

            if (wireType === 0) {
                // Varint
                const varint = this._readVarint(payload, pos);
                if (!varint) { parseError = true; }
                else {
                    value = varint.value;
                    pos = varint.pos;
                    valueRead = true;
                }
            } else if (wireType === 1) {
                // 64-bit (double)
                if (pos + 8 > payload.length) { parseError = true; }
                else {
                    value = view.getFloat64(pos, true);
                    pos += 8;
                    valueRead = true;
                }
            } else if (wireType === 5) {
                // 32-bit (float)
                if (pos + 4 > payload.length) { parseError = true; }
                else {
                    value = view.getFloat32(pos, true);
                    pos += 4;
                    valueRead = true;
                }
            } else if (wireType === 2) {
                // Length-delimited (skip)
                const lenVarint = this._readVarint(payload, pos);
                if (!lenVarint) { parseError = true; }
                else {
                    pos = lenVarint.pos + lenVarint.value;
                }
            } else {
                // Unknown wire type - skip this byte and continue
                pos++;
                continue;
            }

            // If we hit a parse error, stop processing
            if (parseError) break;

            if (valueRead) {
                debugFields.push({ field: fieldNumber, wire: wireType, value: value });
            }

            // Map to field
            switch (fieldNumber) {
                case 1: result.version = value; break;
                case 2: result.gear_state = value; break;
                case 3: result.frame_seq_no = value; break;
                case 4: result.vehicle_speed_mps = value; break;
                case 5: result.accelerator_pedal_position = value; break;
                case 6: result.steering_wheel_angle = value; break;
                case 7: result.blinker_on_left = !!value; break;
                case 8: result.blinker_on_right = !!value; break;
                case 9: result.brake_applied = !!value; break;
                case 10: result.autopilot_state = value; break;
                case 11: result.latitude_deg = value; break;
                case 12: result.longitude_deg = value; break;
                case 13: result.heading_deg = value; break;
                case 14: result.linear_acceleration_mps2_x = value; break;
                case 15: result.linear_acceleration_mps2_y = value; break;
                case 16: result.linear_acceleration_mps2_z = value; break;
            }
        }

        // Debug: Log first decode with full detail
        if (!this._fieldDebugLogged && debugFields.length > 0) {
            console.log('SeiExtractor: Manual decode fields:', JSON.stringify(debugFields, null, 2));
            console.log('SeiExtractor: Raw result before formatting:', JSON.stringify(result, null, 2));
            this._fieldDebugLogged = true;
        }

        // Validate - if we got valid speed or position data, it's probably good
        if (result.version > 0 || result.vehicle_speed_mps > 0 ||
            result.latitude_deg !== 0 || result.longitude_deg !== 0) {
            return this._formatTelemetry(result);
        }

        return null;
    }

    /**
     * Read a protobuf varint
     */
    _readVarint(data, pos) {
        let value = 0;
        let shift = 0;

        while (pos < data.length) {
            const byte = data[pos++];
            value |= (byte & 0x7F) << shift;
            if ((byte & 0x80) === 0) {
                return { value, pos };
            }
            shift += 7;
            if (shift > 63) break;
        }

        return null;
    }

    /**
     * Format telemetry data with friendly names
     * Includes sanity checks to filter out garbage data
     */
    _formatTelemetry(raw) {
        // Helper to sanitize numeric values
        const sanitize = (value, min, max, fallback = 0) => {
            if (value === undefined || value === null || !Number.isFinite(value)) return fallback;
            if (value < min || value > max) return fallback;
            return value;
        };

        // Extract raw speed (m/s) - max realistic Tesla speed ~90 m/s (201 mph)
        const rawSpeedMps = raw.vehicle_speed_mps || raw.vehicleSpeedMps || 0;
        const speedMps = sanitize(rawSpeedMps, 0, 100, 0);

        // Steering angle in degrees - max realistic ±720 degrees (2 full turns)
        const rawSteering = raw.steering_wheel_angle || raw.steeringWheelAngle || 0;
        const steeringAngle = sanitize(rawSteering, -720, 720, 0);

        // Throttle position 0-1 (note: may come as percentage 0-100 in some versions)
        let rawThrottle = raw.accelerator_pedal_position || raw.acceleratorPedalPosition || 0;
        // If throttle is > 1, assume it's a percentage and convert to 0-1 range
        if (rawThrottle > 1) {
            rawThrottle = rawThrottle / 100;
        }
        const throttle = sanitize(rawThrottle, 0, 1, 0);

        // Debug: Log throttle value on first valid reading
        if (!this._throttleLogged && rawThrottle > 0) {
            console.log(`SeiExtractor: Throttle raw=${raw.accelerator_pedal_position || raw.acceleratorPedalPosition}, sanitized=${throttle}`);
            this._throttleLogged = true;
        }

        // Gear state (0-3)
        const rawGear = raw.gear_state || raw.gearState || 0;
        const gearState = sanitize(rawGear, 0, 3, 0);

        // Autopilot state (0-3)
        const rawAP = raw.autopilot_state || raw.autopilotState || 0;
        const apState = sanitize(rawAP, 0, 10, 0);

        // Acceleration (reasonable range ±50 m/s²)
        const accelX = sanitize(raw.linear_acceleration_mps2_x || raw.linearAccelerationMps2X || 0, -50, 50, 0);
        const accelY = sanitize(raw.linear_acceleration_mps2_y || raw.linearAccelerationMps2Y || 0, -50, 50, 0);
        const accelZ = sanitize(raw.linear_acceleration_mps2_z || raw.linearAccelerationMps2Z || 0, -50, 50, 0);

        // Parse frame_seq_no (may come as string from protobuf.js for uint64)
        const rawSeqNo = raw.frame_seq_no || raw.frameSeqNo || 0;
        const frameSeqNo = typeof rawSeqNo === 'string' ? parseInt(rawSeqNo, 10) : rawSeqNo;

        return {
            // Raw values
            version: raw.version || 0,
            frame_seq_no: frameSeqNo,

            // Speed (sanitized)
            vehicle_speed_mps: speedMps,
            speed_mph: speedMps * 2.23694,
            speed_kph: speedMps * 3.6,

            // Steering (sanitized)
            steering_wheel_angle: steeringAngle,

            // Pedals
            accelerator_pedal_position: throttle,
            brake_applied: !!(raw.brake_applied || raw.brakeApplied),

            // Signals
            blinker_on_left: !!(raw.blinker_on_left || raw.blinkerOnLeft),
            blinker_on_right: !!(raw.blinker_on_right || raw.blinkerOnRight),

            // Gear
            gear_state: gearState,
            gear_name: this.GEAR_NAMES[gearState] || 'P',

            // Autopilot
            autopilot_state: apState,
            autopilot_name: this.AP_NAMES[apState] || 'NONE',

            // GPS (reasonable lat/lon range)
            latitude_deg: sanitize(raw.latitude_deg || raw.latitudeDeg || 0, -90, 90, 0),
            longitude_deg: sanitize(raw.longitude_deg || raw.longitudeDeg || 0, -180, 180, 0),
            heading_deg: sanitize(raw.heading_deg || raw.headingDeg || 0, 0, 360, 0),

            // Acceleration (sanitized)
            linear_acceleration_mps2_x: accelX,
            linear_acceleration_mps2_y: accelY,
            linear_acceleration_mps2_z: accelZ,

            // Computed g-force
            g_force_x: accelX / 9.80665,
            g_force_y: accelY / 9.80665,
            g_force_z: accelZ / 9.80665
        };
    }

    /**
     * Read ASCII string from DataView
     */
    _readAscii(data, offset, length) {
        let str = '';
        for (let i = 0; i < length; i++) {
            str += String.fromCharCode(data.getUint8(offset + i));
        }
        return str;
    }

    /**
     * Get telemetry at a specific time in a clip
     * Uses Tesla's frame_seq_no for accurate sync instead of our own frame counter.
     *
     * @param {Object} extractedData - Data from extractFromFile()
     * @param {number} timeSeconds - Time in seconds from start of clip
     * @returns {Object|null} Telemetry data for that time, or null if not available
     */
    getTelemetryAtTime(extractedData, timeSeconds) {
        if (!extractedData || !extractedData.frames || extractedData.frames.length === 0) {
            return null;
        }

        const fps = extractedData.fps || 36;
        const baseSeq = extractedData.baseFrameSeqNo;
        const seqMap = extractedData.frameSeqMap;

        // Use frame_seq_no based lookup if available (most accurate)
        if (baseSeq !== null && seqMap && seqMap.size > 0) {
            // Calculate expected frame_seq_no for this time
            const frameOffset = Math.floor(timeSeconds * fps);
            const targetSeq = baseSeq + frameOffset;

            // Direct lookup
            if (seqMap.has(targetSeq)) {
                return seqMap.get(targetSeq);
            }

            // Search nearby (±5 frames) for closest match
            let closest = null;
            let minDiff = Infinity;
            for (let offset = -5; offset <= 5; offset++) {
                const checkSeq = targetSeq + offset;
                if (seqMap.has(checkSeq)) {
                    const diff = Math.abs(offset);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closest = seqMap.get(checkSeq);
                    }
                }
            }

            if (closest) {
                return closest;
            }
        }

        // Fallback to frame index based lookup (less accurate)
        const targetFrame = Math.floor(timeSeconds * fps);
        const frames = extractedData.frames;

        // Binary search for closest frame by frameIndex
        let left = 0;
        let right = frames.length - 1;
        let closest = null;
        let minDiff = Infinity;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const frame = frames[mid];
            const diff = Math.abs(frame.frameIndex - targetFrame);

            if (diff < minDiff) {
                minDiff = diff;
                closest = frame;
            }

            if (frame.frameIndex < targetFrame) {
                left = mid + 1;
            } else if (frame.frameIndex > targetFrame) {
                right = mid - 1;
            } else {
                break;
            }
        }

        if (closest && minDiff <= 10) {
            return closest;
        }

        return null;
    }

    /**
     * Check if a file has SEI telemetry data (quick check)
     * @param {File} file - The MP4 file to check
     * @returns {Promise<boolean>}
     */
    async hasTelemetry(file) {
        const data = await this.extractFromFile(file);
        return data.frames.length > 0;
    }

    /**
     * Clear the cache (useful when memory is a concern)
     */
    clearCache() {
        this.cache.clear();
    }
}

// Create singleton instance
window.seiExtractor = new SeiExtractor();
