/**
 * seiInsights — pure SEI-derived per-event metrics.
 *
 * Two computations live here so the live player (TelemetryOverlay) and
 * the background scanner (InsightsScanner) can call the same algorithm:
 *
 *   computeRecordingHealthFromSei(clipSeiMap)
 *     Detects suspiciously short clips by frame count. Returns the
 *     SEI-derived portion ONLY; the sidebar combines this with
 *     structural checks (missing cameras, missing event.json, etc.)
 *     done in eventBrowser.computeRecordingHealth.
 *
 *   computeLaunches(clipSeiMap, clipDurations)
 *     Detects sustained full-throttle segments (accelerator pedal
 *     >0.9 for >500ms). Returns one entry per launch with the event
 *     time of the start so a timeline bookmark can land there.
 *
 * Inputs:
 *   clipSeiMap     — Map<string, {frames: Array<frame>}>. Keys look like
 *                    "<clipIndex>_<filename>" by convention (matches
 *                    telemetryOverlay.clipSeiData and insightsScanner's
 *                    in-memory map). Iteration order is insertion order.
 *   clipDurations  — Array<number> | null. Per-clip duration in seconds.
 *                    When null, computeLaunches falls back to a constant
 *                    60s per clip (Tesla nominal). Pass real durations
 *                    when available for accurate timestamps.
 */
(function () {
    'use strict';

    // ---- recording health thresholds ---------------------------------
    // Tesla clips are nominally 60s × ~30fps = ~1800 frames. Anything
    // significantly shorter means the recording was interrupted or the
    // clip was cut short — surfaces on the card as a health issue.
    const SHORT_CLIP_FRAME_THRESHOLD = 900;   // <30s of frames = suspicious

    // ---- launch detector thresholds ----------------------------------
    const LAUNCH_THROTTLE_THRESHOLD = 0.9;    // accelerator_pedal_position
    const LAUNCH_MIN_DURATION_SEC   = 0.5;    // sustained for >500ms
    // Brief throttle dips inside an otherwise-continuous launch shouldn't
    // split it. ~3 frames at 30fps tolerates a single bad SEI sample.
    const LAUNCH_GAP_TOLERANCE_FRAMES = 3;

    const DEFAULT_CLIP_DURATION_SEC = 60;

    /**
     * Recording health from SEI frame counts.
     * @param {Map<string, {frames: Array}>} clipSeiMap
     * @returns {{shortClipCount: number, totalClips: number, details: Array<{clipKey: string, frameCount: number}>}}
     */
    function computeRecordingHealthFromSei(clipSeiMap) {
        const details = [];
        let shortClipCount = 0;
        let totalClips = 0;

        if (clipSeiMap && typeof clipSeiMap.entries === 'function') {
            for (const [key, data] of clipSeiMap.entries()) {
                if (!data || !Array.isArray(data.frames)) continue;
                totalClips++;
                const fc = data.frames.length;
                if (fc > 0 && fc < SHORT_CLIP_FRAME_THRESHOLD) {
                    shortClipCount++;
                    details.push({ clipKey: key, frameCount: fc });
                }
            }
        }

        return {
            shortClipCount,
            totalClips,
            shortClipFrameThreshold: SHORT_CLIP_FRAME_THRESHOLD,
            details
        };
    }

    /**
     * Parse "<clipIndex>_<filename>" → clipIndex (number, NaN on fail).
     * Matches the keying convention used by telemetryOverlay.clipSeiData
     * and insightsScanner._processEvent.
     */
    function clipIndexFromKey(key) {
        if (typeof key !== 'string') return NaN;
        const underscore = key.indexOf('_');
        if (underscore <= 0) return NaN;
        const n = parseInt(key.slice(0, underscore), 10);
        return Number.isFinite(n) ? n : NaN;
    }

    /**
     * Event-time of a frame inside a clip.
     * @param {number} clipIndex
     * @param {number} frameIndex   — 0-based within the clip
     * @param {number} totalFrames  — frame count of this clip
     * @param {Array<number>|null} clipDurations
     */
    function frameTimeInEvent(clipIndex, frameIndex, totalFrames, clipDurations) {
        let preceding = 0;
        if (clipDurations && clipDurations.length) {
            for (let i = 0; i < clipIndex && i < clipDurations.length; i++) {
                const d = clipDurations[i];
                // 0 = a clip the player skips (no front video): it takes no time (#537)
                preceding += (Number.isFinite(d) && d >= 0) ? d : DEFAULT_CLIP_DURATION_SEC;
            }
        } else {
            preceding = clipIndex * DEFAULT_CLIP_DURATION_SEC;
        }
        const thisClipDuration = (clipDurations && Number.isFinite(clipDurations[clipIndex]) && clipDurations[clipIndex] > 0)
            ? clipDurations[clipIndex]
            : DEFAULT_CLIP_DURATION_SEC;
        const fps = totalFrames > 0 ? totalFrames / thisClipDuration : 30;
        const inClip = fps > 0 ? frameIndex / fps : 0;
        return preceding + inClip;
    }

    /**
     * Detect sustained full-throttle launches.
     *
     * Algorithm: per clip, walk frames in order. Track an "open" run that
     * starts when accelerator_pedal_position crosses LAUNCH_THROTTLE_THRESHOLD,
     * closes when it drops below for more than LAUNCH_GAP_TOLERANCE_FRAMES
     * frames in a row. On close, if total duration ≥ LAUNCH_MIN_DURATION_SEC,
     * emit a launch.
     *
     * @param {Map<string, {frames: Array}>} clipSeiMap
     * @param {Array<number>|null} clipDurations
     * @returns {Array<{absoluteTimeSec: number, durationSec: number, peakThrottle: number, clipIndex: number}>}
     */
    function computeLaunches(clipSeiMap, clipDurations) {
        const launches = [];
        if (!clipSeiMap || typeof clipSeiMap.entries !== 'function') return launches;

        // Walk clips in clipIndex order so launches are sorted by event time.
        const entries = Array.from(clipSeiMap.entries())
            .map(([key, data]) => ({ key, data, clipIndex: clipIndexFromKey(key) }))
            .filter(e => Number.isFinite(e.clipIndex) && e.data && Array.isArray(e.data.frames))
            .sort((a, b) => a.clipIndex - b.clipIndex);

        for (const { data, clipIndex } of entries) {
            const frames = data.frames;
            const fc = frames.length;
            if (fc === 0) continue;

            let runStartIdx = -1;
            let runEndIdx   = -1;
            let runPeak     = 0;
            let belowStreak = 0;

            const flushIfQualified = () => {
                if (runStartIdx < 0) return;
                const startTime = frameTimeInEvent(clipIndex, runStartIdx, fc, clipDurations);
                const endTime   = frameTimeInEvent(clipIndex, runEndIdx, fc, clipDurations);
                const duration  = Math.max(0, endTime - startTime);
                if (duration >= LAUNCH_MIN_DURATION_SEC) {
                    launches.push({
                        absoluteTimeSec: startTime,
                        durationSec: duration,
                        peakThrottle: runPeak,
                        clipIndex
                    });
                }
                runStartIdx = -1;
                runEndIdx   = -1;
                runPeak     = 0;
                belowStreak = 0;
            };

            for (let i = 0; i < fc; i++) {
                const f = frames[i];
                const t = (f && typeof f.accelerator_pedal_position === 'number') ? f.accelerator_pedal_position : 0;

                if (t >= LAUNCH_THROTTLE_THRESHOLD) {
                    if (runStartIdx < 0) runStartIdx = i;
                    runEndIdx   = i;
                    runPeak     = Math.max(runPeak, t);
                    belowStreak = 0;
                } else if (runStartIdx >= 0) {
                    belowStreak++;
                    if (belowStreak > LAUNCH_GAP_TOLERANCE_FRAMES) {
                        flushIfQualified();
                    }
                }
            }
            // End-of-clip flush so a launch that runs to the final frame still counts.
            flushIfQualified();
        }

        return launches;
    }

    window.seiInsights = {
        computeRecordingHealthFromSei,
        computeLaunches,
        // Exported so callers can label badges consistently with the source-of-truth.
        SHORT_CLIP_FRAME_THRESHOLD,
        LAUNCH_THROTTLE_THRESHOLD,
        LAUNCH_MIN_DURATION_SEC
    };
})();
