/**
 * Intervention Severity Metric
 *
 * Derives per-event "interesting moments" from SEI telemetry. Surfaces
 * things a Tesla owner would actually want to find on review:
 *   • Hard braking — someone cut us off, had to stop short
 *   • Swerve / evasive — sudden lateral motion
 *   • Impact-like signatures — collision or near-collision
 *
 * KEY DATA CORRECTION
 * -------------------
 * Tesla's `linear_acceleration_mps2_z` is **already gravity-compensated** —
 * it sits near 0 on level ground and spikes only on bumps/impacts. An
 * earlier version of this module subtracted 1g from it (assuming raw
 * accel with gravity baseline of 1g), which meant stationary frames
 * read as 1g "impacts" and every event scored Critical. Source:
 * telemetryOverlay's road roughness calc already documents this convention.
 *
 * NOISE HANDLING
 * --------------
 * Single-frame spikes (33ms) are almost always measurement noise, not
 * real events. A genuine hard brake lasts 300–1000ms, a swerve 200–500ms,
 * an impact has a sustained ringing of 100–300ms. We therefore:
 *   1. Smooth each axis with a short rolling window (~150 ms)
 *   2. Detect sustained peaks — require N consecutive frames above
 *      threshold before it counts
 *   3. Deduplicate nearby events (cooldown window)
 *
 * Output is an array of events, each with a type, peak g, and time
 * offset within the event — so the UI can list multiple moments, not
 * just the single loudest one.
 */
(function () {
    'use strict';

    // Assumed 30fps SEI cadence. Actual rate is variable per clip but 30 is
    // close enough for windowing/timing purposes.
    const FPS = 30;
    const SMOOTH_WINDOW_FRAMES = 5;     // ~167ms @ 30fps
    const SUSTAIN_FRAMES = 3;           // ≥100ms above threshold to count
    const EVENT_COOLDOWN_FRAMES = 30;   // ~1s between detected events

    // Tier thresholds in g-force. Tuned against normal driving so daily
    // commute stays below Moderate (no badge clutter), and only real
    // close-calls / impacts show up.
    const TIERS = [
        { key: 'critical', label: 'Critical', icon: '!!', decelG: 0.85, lateralG: 0.75, impactG: 1.2 },
        { key: 'severe',   label: 'Severe',   icon: '!',  decelG: 0.65, lateralG: 0.55, impactG: 0.85 },
        { key: 'moderate', label: 'Moderate', icon: '!',  decelG: 0.45, lateralG: 0.40, impactG: 0.6 }
    ];

    // ---- helpers ---------------------------------------------------------
    function smoothSeries(values, windowSize) {
        if (values.length === 0) return [];
        const half = Math.floor(windowSize / 2);
        const out = new Array(values.length);
        for (let i = 0; i < values.length; i++) {
            let sum = 0, n = 0;
            for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
                sum += values[j]; n++;
            }
            out[i] = sum / n;
        }
        return out;
    }

    function classify(decelG, lateralG, impactG) {
        for (const t of TIERS) {
            if (decelG >= t.decelG || lateralG >= t.lateralG || impactG >= t.impactG) return t;
        }
        return null;
    }

    /**
     * Walk smoothed series looking for sustained peaks. Returns events
     * shaped { kindType: 'brake'|'lateral'|'impact', startIdx, peakIdx,
     *         peakG, peakDuration }.
     */
    function findEvents(decelArr, lateralArr, impactArr) {
        const events = [];
        const len = decelArr.length;
        const lowestThresh = TIERS[TIERS.length - 1]; // moderate

        let activeKind = null;      // 'brake' | 'lateral' | 'impact' | null
        let runStart = -1;
        let runPeakIdx = -1;
        let runPeakG = 0;
        let cooldownUntil = -1;

        function closeRun(endIdx) {
            if (activeKind && (endIdx - runStart) >= SUSTAIN_FRAMES) {
                events.push({
                    kind: activeKind,
                    startIdx: runStart,
                    peakIdx: runPeakIdx,
                    peakG: runPeakG,
                    durationFrames: endIdx - runStart
                });
                cooldownUntil = endIdx + EVENT_COOLDOWN_FRAMES;
            }
            activeKind = null; runStart = -1; runPeakIdx = -1; runPeakG = 0;
        }

        for (let i = 0; i < len; i++) {
            if (i < cooldownUntil) continue;

            const d = decelArr[i], l = lateralArr[i], m = impactArr[i];
            // What kind of event dominates at this frame, if any?
            let kind = null;
            if (m >= lowestThresh.impactG && m >= d && m >= l) kind = 'impact';
            else if (d >= lowestThresh.decelG && d >= l)      kind = 'brake';
            else if (l >= lowestThresh.lateralG)              kind = 'lateral';

            if (kind) {
                const g = kind === 'brake' ? d : kind === 'lateral' ? l : m;
                if (activeKind === kind) {
                    if (g > runPeakG) { runPeakG = g; runPeakIdx = i; }
                } else {
                    // different kind or new run — close old, start new
                    closeRun(i);
                    activeKind = kind;
                    runStart = i;
                    runPeakIdx = i;
                    runPeakG = g;
                }
            } else {
                closeRun(i);
            }
        }
        closeRun(len);
        return events;
    }

    const Severity = {
        /**
         * Analyze SEI data for an event.
         * @param {Map<string, {frames: Object[]}>} clipSeiDataMap
         * @param {number[]} [cachedClipDurations]
         *        If provided, uses actual per-clip durations for accurate
         *        event-time timestamps on detected events.
         * @returns {{ tier, icon, label, peaks: object, events: object[],
         *            detailText: string } | null}
         */
        computeFromSei(clipSeiDataMap, cachedClipDurations) {
            if (!clipSeiDataMap || clipSeiDataMap.size === 0) return null;

            // Flatten frames across clips, remembering per-frame event-time
            const frames = [];
            const entries = Array.from(clipSeiDataMap.entries()).sort((a, b) => {
                const ia = parseInt(a[0].split('_')[0], 10);
                const ib = parseInt(b[0].split('_')[0], 10);
                return ia - ib;
            });

            // Clip start = sum of the player's lengths of every clip before it
            // (#537): clips with no SEI entry count too, a clip the player
            // skips (no front video) is 0 s, an unknown length is 60 s.
            const lenOf = (idx) => {
                const d = cachedClipDurations ? cachedClipDurations[idx] : undefined;
                return Number.isFinite(d) && d >= 0 ? d : 60;
            };
            for (const [key, data] of entries) {
                const clipIdx = parseInt(key.split('_')[0], 10);
                let clipStartSec = 0;
                for (let idx = 0; idx < clipIdx; idx++) clipStartSec += lenOf(idx);
                const clipDur = lenOf(clipIdx);
                if (!data?.frames?.length || clipDur <= 0) continue;

                const framesPerSec = data.frames.length / clipDur;
                for (let i = 0; i < data.frames.length; i++) {
                    const f = data.frames[i];
                    frames.push({
                        eventTime: clipStartSec + (i / framesPerSec),
                        gx: f.g_force_x ?? 0,
                        gy: f.g_force_y ?? 0,
                        // Z is ALREADY gravity-compensated by Tesla — do NOT subtract 1
                        gz: f.g_force_z ?? 0
                    });
                }
            }
            if (frames.length < 10) return null;

            // Build per-axis series
            const decelRaw = frames.map(f => Math.max(0, -f.gx));  // braking
            const lateralRaw = frames.map(f => Math.abs(f.gy));
            // Impact metric — total g vector magnitude (all axes). At rest
            // this is near 0 since all three axes are gravity-compensated.
            const impactRaw = frames.map(f => Math.sqrt(f.gx * f.gx + f.gy * f.gy + f.gz * f.gz));

            // Smooth to kill single-frame noise spikes
            const decel = smoothSeries(decelRaw, SMOOTH_WINDOW_FRAMES);
            const lateral = smoothSeries(lateralRaw, SMOOTH_WINDOW_FRAMES);
            const impact = smoothSeries(impactRaw, SMOOTH_WINDOW_FRAMES);

            // Find sustained events
            const rawEvents = findEvents(decel, lateral, impact);

            // Convert to user-facing events with times and classifications
            const eventsOut = rawEvents.map(ev => {
                const peakFrame = frames[ev.peakIdx];
                const peakTime = peakFrame ? peakFrame.eventTime : 0;
                const durSec = ev.durationFrames / FPS;
                const tier = classify(
                    ev.kind === 'brake' ? ev.peakG : 0,
                    ev.kind === 'lateral' ? ev.peakG : 0,
                    ev.kind === 'impact' ? ev.peakG : 0
                );
                return {
                    kind: ev.kind,
                    peakG: ev.peakG,
                    peakTime,
                    durationSec: durSec,
                    tier: tier?.key || 'mild',
                    label: tier?.label || 'Mild'
                };
            }).filter(ev => ev.tier !== 'mild');

            if (eventsOut.length === 0) {
                return {
                    tier: 'mild', icon: '', label: 'Mild', events: [],
                    detailText: 'Normal driving — no notable interventions detected'
                };
            }

            // Worst tier across all detected events sets the badge
            const order = { mild: 0, moderate: 1, severe: 2, critical: 3 };
            const worst = eventsOut.reduce((a, b) => (order[b.tier] > order[a.tier] ? b : a));
            const tierInfo = TIERS.find(t => t.key === worst.tier) || TIERS[TIERS.length - 1];

            // Detail text — up to 3 events, with times
            const top = [...eventsOut].sort((a, b) => {
                if (order[b.tier] !== order[a.tier]) return order[b.tier] - order[a.tier];
                return b.peakG - a.peakG;
            }).slice(0, 3);

            const fmtTime = (sec) => {
                const mm = Math.floor(sec / 60);
                const ss = Math.round(sec % 60).toString().padStart(2, '0');
                return `${mm}:${ss}`;
            };
            const eventLines = top.map(ev => {
                const kindLabel = ev.kind === 'brake' ? 'Hard brake'
                                : ev.kind === 'lateral' ? 'Lateral jolt' : 'Impact';
                return `${ev.label}: ${kindLabel} ${ev.peakG.toFixed(2)}g @ ${fmtTime(ev.peakTime)}`;
            });
            const more = eventsOut.length > top.length ? `\n+${eventsOut.length - top.length} more` : '';
            const detailText = eventLines.join('\n') + more;

            return {
                tier: worst.tier,
                icon: tierInfo.icon,
                label: tierInfo.label,
                events: eventsOut,    // clickable list
                detailText
            };
        }
    };

    window.interventionSeverity = Severity;
})();
