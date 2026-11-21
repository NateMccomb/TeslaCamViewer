/**
 * Autopilot Timeline Layer
 *
 * Renders the SEI `autopilot_state` stream as a thin colored strip at the
 * bottom of the scrub bar. At a glance, users can see when the vehicle was
 * on Autopilot / FSD / TACC vs manual driving across the whole event.
 *
 * Uses data already extracted by telemetryOverlay (no extra SEI decode).
 * Positions match the scrub bar exactly by using the same
 * `cachedClipDurations` the timeline uses.
 *
 * AP state values (from seiExtractor.AP_NAMES):
 *   0 = NONE (manual) → no color
 *   1 = FSD → purple
 *   2 = AUTOSTEER → Tesla blue
 *   3 = TACC → teal
 */
(function () {
    'use strict';

    const AP_COLORS = {
        0: null,                 // NONE — transparent
        1: 'rgba(168, 85, 247, 0.75)',   // FSD — purple
        2: 'rgba(74, 158, 255, 0.75)',   // AUTOSTEER — Tesla blue
        3: 'rgba(6, 182, 212, 0.75)'     // TACC — teal
    };
    const AP_LABELS = { 0: 'MANUAL', 1: 'FSD', 2: 'AP', 3: 'TACC' };

    const Layer = {
        init() {
            this.canvas = document.getElementById('timelineAutopilotLayer');
            this.timeline = document.getElementById('timeline');
            if (!this.canvas || !this.timeline) return;
            this.ctx = this.canvas.getContext('2d');
            this._lastEventName = null;
            this._lastSeiSize = 0;
            this._lastDurSig = 0;
            this._segments = null;

            new ResizeObserver(() => this.render()).observe(this.timeline);
            this.canvas.addEventListener('mousemove', (e) => this._onHover(e));
            this.canvas.addEventListener('mouseleave', () => this._hideTooltip());

            // Poll for new event / new SEI data / durations populating.
            // Cheap — just property lookups and integer compare.
            setInterval(() => this._checkForChanges(), 500);
        },

        _checkForChanges() {
            const ev = window.app?.currentEvent;
            const name = ev?.name || null;
            const sei = window.app?.telemetryOverlay?.clipSeiData;
            const seiSize = sei?.size || 0;
            const durSig = (window.app?.videoPlayer?.cachedClipDurations || []).length;
            if (name !== this._lastEventName
             || seiSize !== this._lastSeiSize
             || durSig !== this._lastDurSig) {
                this._lastEventName = name;
                this._lastSeiSize = seiSize;
                this._lastDurSig = durSig;
                this.render();
            }
        },

        render() {
            const event = window.app?.currentEvent;
            const sei = window.app?.telemetryOverlay?.clipSeiData;
            if (!event || !sei || sei.size === 0) { this.hide(); return; }

            // Build segments from all clips' SEI frames
            const segments = this._buildSegments(event, sei);
            if (segments.length === 0) { this.hide(); return; }
            this._segments = segments;

            const rect = this.timeline.getBoundingClientRect();
            const w = rect.width | 0, h = rect.height | 0;
            if (w === 0) return;
            this.canvas.width = w;
            this.canvas.height = h;
            this.canvas.style.display = 'block';
            this.ctx.clearRect(0, 0, w, h);

            // Strip position: thin bar along bottom 4px of the timeline
            const stripHeight = 4;
            const stripY = h - stripHeight;

            // Honor timeline zoom: when zoomed in, the visible window is
            // [viewStart, viewStart+viewDuration] mapped to canvas width.
            // Segments outside the window are clipped; segments crossing
            // an edge get clamped. Without this, AP/FSD strips stayed
            // pinned to their unzoomed positions while the rest of the
            // timeline scaled around them.
            const tl = window.app?.timeline;
            const tlDur = tl?.totalDuration;
            const cachedDurs = window.app?.videoPlayer?.cachedClipDurations;
            const duration = tlDur || (cachedDurs && cachedDurs.length
                ? cachedDurs.reduce((a, b, idx) => a + VideoPlayer.clipLength(cachedDurs, idx), 0)
                : event.clipGroups.length * 60);
            const zoom = tl?.zoomLevel || 1;
            const viewStart = (zoom > 1 && typeof tl?.viewStart === 'number') ? tl.viewStart : 0;
            const viewDuration = duration / zoom;
            const viewEnd = viewStart + viewDuration;
            this._viewStart = viewStart;
            this._viewDuration = viewDuration;

            for (const seg of segments) {
                const color = AP_COLORS[seg.state];
                if (!color) continue;
                if (seg.endSec < viewStart || seg.startSec > viewEnd) continue;
                const sStart = Math.max(seg.startSec, viewStart);
                const sEnd = Math.min(seg.endSec, viewEnd);
                const x1 = Math.round(((sStart - viewStart) / viewDuration) * w);
                const x2 = Math.round(((sEnd - viewStart) / viewDuration) * w);
                this.ctx.fillStyle = color;
                this.ctx.fillRect(x1, stripY, Math.max(1, x2 - x1), stripHeight);
            }
        },

        // Collapse per-frame autopilot_state values into contiguous runs so
        // we draw a small number of wide rects instead of thousands of thin
        // ones. Returns [{startSec, endSec, state}, ...].
        _buildSegments(event, seiMap) {
            const durations = window.app?.videoPlayer?.cachedClipDurations || [];
            const segments = [];
            // Sort clip keys by clip index
            const entries = Array.from(seiMap.entries()).sort((a, b) => {
                const ia = parseInt(a[0].split('_')[0], 10);
                const ib = parseInt(b[0].split('_')[0], 10);
                return ia - ib;
            });

            let clipStartSec = 0;
            for (const [key, data] of entries) {
                const clipIdx = parseInt(key.split('_')[0], 10);
                const clipDuration = (durations[clipIdx] != null) ? durations[clipIdx] : 60;
                if (!data?.frames?.length) { clipStartSec += clipDuration; continue; }

                const frames = data.frames;
                const framesPerSec = frames.length / clipDuration;
                let runState = frames[0].autopilot_state ?? 0;
                let runStartFrame = 0;

                const flushRun = (endFrame) => {
                    const startSec = clipStartSec + (runStartFrame / framesPerSec);
                    const endSec   = clipStartSec + (endFrame / framesPerSec);
                    segments.push({ startSec, endSec, state: runState });
                };

                for (let i = 1; i < frames.length; i++) {
                    const s = frames[i].autopilot_state ?? 0;
                    if (s !== runState) {
                        flushRun(i);
                        runState = s;
                        runStartFrame = i;
                    }
                }
                flushRun(frames.length);
                clipStartSec += clipDuration;
            }
            return segments;
        },

        _onHover(e) {
            if (!this._segments || this._segments.length === 0) return;
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            // Map mouse-x back through the same zoom window the renderer
            // used. Without this, hover tooltips identified the wrong
            // segment whenever the timeline was zoomed.
            const viewStart = this._viewStart || 0;
            const viewDuration = this._viewDuration || window.app?.timeline?.totalDuration;
            if (!viewDuration) return;
            const sec = viewStart + (x / rect.width) * viewDuration;
            const seg = this._segments.find(s => sec >= s.startSec && sec <= s.endSec);
            if (!seg || seg.state === 0) { this._hideTooltip(); return; }
            this._showTooltip(e.clientX, rect.top, AP_LABELS[seg.state] || 'AP');
        },

        _showTooltip(x, top, text) {
            if (!this._tip) {
                this._tip = document.createElement('div');
                this._tip.style.cssText = `
                    position: fixed; z-index: 9999;
                    background: var(--bg-panel, #242424);
                    color: var(--text, #e0e0e0);
                    border: 1px solid var(--border, #3a3a3a);
                    padding: 3px 8px;
                    border-radius: 3px;
                    font-size: 0.72rem;
                    font-family: ui-monospace, monospace;
                    pointer-events: none;
                    white-space: nowrap;
                `;
                document.body.appendChild(this._tip);
            }
            this._tip.textContent = text;
            this._tip.style.left = (x + 10) + 'px';
            this._tip.style.top = (top - 22) + 'px';
            this._tip.style.display = 'block';
        },

        _hideTooltip() {
            if (this._tip) this._tip.style.display = 'none';
        },

        hide() {
            if (this.canvas) this.canvas.style.display = 'none';
            this._segments = null;
        }
    };

    function tryInit() {
        if (!document.getElementById('timelineAutopilotLayer')) { setTimeout(tryInit, 200); return; }
        Layer.init();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryInit);
    } else {
        tryInit();
    }
    window.autopilotTimelineLayer = Layer;
})();
