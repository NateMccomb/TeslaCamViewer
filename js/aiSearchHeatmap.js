/**
 * AI Search Timeline Heatmap
 *
 * Overlays the existing timeline scrub bar with a color bar showing how
 * well each indexed frame matches the current search query. Green = strong
 * match, dim = weak match, invisible = no frames indexed at that range.
 *
 * Triggers:
 *  - `ai-search:results` event with per-frame embeddings available on the
 *    currently-loaded event
 *  - Event switch — recompute for the newly-loaded event's frames
 */
(function () {
    'use strict';

    const Heatmap = {
        init() {
            this.canvas = document.getElementById('timelineAiHeatmap');
            this.timeline = document.getElementById('timeline');
            if (!this.canvas || !this.timeline) return;
            this.ctx = this.canvas.getContext('2d');
            this._lastQuery = null;
            this._lastQueryEmbedding = null;
            this._resizeObserver = new ResizeObserver(() => this.render());
            this._resizeObserver.observe(this.timeline);

            // Subscribe to search events and event loads
            window.addEventListener('ai-search:results', (e) => this.onSearchResults(e.detail));
            window.addEventListener('ai-search:status', (e) => {
                if (e.detail.state === 'cleared') this.hide();
            });

            // Click on heatmap → seek to that moment
            this.canvas.addEventListener('click', (e) => this.onClick(e));

            // Watch for event changes via currentEvent changes (poll — app
            // doesn't emit a clean event-loaded event for us to subscribe to)
            this._lastEventName = null;
            setInterval(() => this._checkEventChanged(), 400);
        },

        _checkEventChanged() {
            const ev = window.app?.currentEvent;
            const name = ev?.name || null;
            // Also watch for cachedClipDurations populating — async after
            // event load, and the heatmap positions depend on it being ready.
            const durSig = (window.app?.videoPlayer?.cachedClipDurations || []).length;
            if (name !== this._lastEventName || durSig !== this._lastDurSig) {
                this._lastEventName = name;
                this._lastDurSig = durSig;
                if (this._lastQueryEmbedding) this.render();
                else this.hide();
            }
        },

        async onSearchResults(results) {
            // Re-embed the query so we can re-score the current event's frames.
            // (results.ranked has event-level max scores, not per-frame scores.)
            if (!results.query) { this.hide(); return; }
            this._lastQuery = results.query;
            try {
                // Expose embedQueryEnsemble by calling search's text embedder
                // indirectly through a small helper in aiSearch.
                // Easier: re-use the same path by calling embedText via ensemble
                const te = await this._embedQuery(results.query);
                this._lastQueryEmbedding = te;
                this.render();
            } catch (err) {
                console.warn('[AI heatmap] embed failed:', err);
                this.hide();
            }
        },

        async _embedQuery(query) {
            const S = window.aiSearch.state;
            if (!S.textModel || !S.tokenizer) {
                // If search hasn't been run yet, load the model via search()
                await window.aiSearch.search(query).catch(() => {});
            }
            // Pull the same ensemble templates used in aiSearch
            const templates = [
                q => `a photo of ${q}`,
                q => `a dashcam photo of ${q}`,
                q => `a picture of ${q} taken from a car`,
                q => `a frame from a dashboard camera showing ${q}`,
                q => `a Tesla dashcam image of ${q}`
            ];
            const embs = [];
            for (const t of templates) {
                const inputs = S.tokenizer(t(query), { padding: true, truncation: true });
                const out = await S.textModel(inputs);
                embs.push(this._l2norm(new Float32Array(out.text_embeds.data)));
            }
            // Average + normalize
            const dim = embs[0].length;
            const avg = new Float32Array(dim);
            for (const v of embs) for (let i = 0; i < dim; i++) avg[i] += v[i];
            for (let i = 0; i < dim; i++) avg[i] /= embs.length;
            return this._l2norm(avg);
        },

        _l2norm(v) {
            let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
            const n = Math.sqrt(s) || 1;
            const o = new Float32Array(v.length);
            for (let i = 0; i < v.length; i++) o[i] = v[i] / n;
            return o;
        },

        _cos(a, b) {
            let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i];
            return s;
        },

        // Compute a frame's position on the TCV timeline. Critical detail:
        // the timeline uses actual probed clip durations (55-63s range),
        // NOT a flat 60s-per-clip. For Sentry events especially, a fixed-60
        // assumption drifts up to a minute off over 10 clips. We have to
        // use the actual cached durations from videoPlayer.
        _frameToEventSec(frame, event) {
            if (!event?.clipGroups) return 0;
            const cg = event.clipGroups;
            const durations = window.app?.videoPlayer?.cachedClipDurations || [];
            let clipIdx = -1;
            for (let i = 0; i < cg.length; i++) {
                const g = cg[i];
                if (g.clips && Object.values(g.clips).some(c => c.fileName === frame.clipName)) {
                    clipIdx = i; break;
                }
            }
            if (clipIdx < 0) return null;
            // Sum actual durations of preceding clips. Fall back to 60s per
            // clip if durations haven't been probed yet — we'll re-render
            // once they are (see _checkEventChanged).
            let timelineStart = 0;
            for (let i = 0; i < clipIdx; i++) {
                timelineStart += (durations[i] != null) ? durations[i] : 60;
            }
            return timelineStart + (frame.offsetInClip || 0);
        },

        render() {
            const event = window.app?.currentEvent;
            if (!event || !this._lastQueryEmbedding) { this.hide(); return; }
            const record = window.aiSearch?.state?.indexed?.get(event.name);
            if (!record || record.frames.length === 0) { this.hide(); return; }

            const rect = this.timeline.getBoundingClientRect();
            const w = rect.width | 0, h = rect.height | 0;
            if (w === 0) return;
            this.canvas.width = w;
            this.canvas.height = h;
            this.canvas.style.display = 'block';

            // Timeline total duration = sum of actual cached clip durations,
            // NOT clipGroups × 60. We use the timeline's own value when ready.
            const tlDur = window.app?.timeline?.totalDuration;
            const cachedDurs = window.app?.videoPlayer?.cachedClipDurations;
            const duration = tlDur || (cachedDurs && cachedDurs.length
                ? cachedDurs.reduce((a, b, idx) => a + VideoPlayer.clipLength(cachedDurs, idx), 0)
                : event.clipGroups.length * 60);
            const te = this._lastQueryEmbedding;
            const strips = [];
            for (const f of record.frames) {
                const sec = this._frameToEventSec(f, event);
                if (sec == null || sec < 0 || sec > duration) continue;
                const raw = this._cos(te, f.embedding);
                const adj = raw - 0.8 * (f.baseline ?? 0);
                strips.push({ sec, score: adj, frame: f });
            }
            if (strips.length === 0) { this.hide(); return; }

            // Score range: clamp for color scaling. Low end ~0.02 (baseline),
            // high end ~0.13 for CLIP-B matches. Normalize to 0-1 for colors.
            const modelKey = window.aiSearch.state.currentModelKey;
            const thresholds = window.aiSearch.CLIP_MODELS[modelKey].thresholds;
            const lowScore = thresholds.possible;          // fade starts here
            const hiScore  = thresholds.confident * 1.3;   // fully saturated above this

            this.ctx.clearRect(0, 0, w, h);

            // Honor timeline zoom: when zoomed in, strips outside the
            // visible window are skipped and the rest are remapped to
            // canvas coords using [viewStart, viewStart+viewDuration].
            // Without this, AI heatmap strips stayed pinned to their
            // unzoomed positions while the timeline scaled around them.
            const tl = window.app?.timeline;
            const zoom = tl?.zoomLevel || 1;
            const viewStart = (zoom > 1 && typeof tl?.viewStart === 'number') ? tl.viewStart : 0;
            const viewDuration = duration / zoom;
            const viewEnd = viewStart + viewDuration;

            // Draw strips. Width proportional to frames/timeline density.
            // Without mix-blend-mode we rely on straight alpha, so colors
            // are tuned brighter to remain visible.
            const stripW = Math.max(3, Math.min(8, Math.ceil(w / strips.length) + 2));
            for (const s of strips) {
                if (s.sec < viewStart || s.sec > viewEnd) continue;
                const x = Math.round(((s.sec - viewStart) / viewDuration) * w);
                let norm = (s.score - lowScore) / (hiScore - lowScore);
                norm = Math.max(0, Math.min(1, norm));
                if (norm < 0.05) continue;
                const alpha = 0.4 + norm * 0.55;
                // Green that stays readable on both dark and light timeline bg
                this.ctx.fillStyle = `rgba(74, 222, 128, ${alpha})`;
                this.ctx.fillRect(x - stripW / 2, 0, stripW, h);
            }

            this._strips = strips;
            this._duration = duration;
            this._viewStart = viewStart;
            this._viewDuration = viewDuration;
        },

        hide() {
            if (this.canvas) this.canvas.style.display = 'none';
            this._strips = null;
        },

        onClick(e) {
            if (!this._strips || !this._duration) return;
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            // Map mouse-x back through the same zoom window the renderer
            // used. Without this, click-to-jump landed on the wrong frame
            // when the timeline was zoomed.
            const viewStart = this._viewStart || 0;
            const viewDuration = this._viewDuration || this._duration;
            const sec = viewStart + (x / rect.width) * viewDuration;
            // Find nearest strip with a strong match, prefer high-score ones
            let best = null, bestScore = -Infinity;
            for (const s of this._strips) {
                if (Math.abs(s.sec - sec) < 3 && s.score > bestScore) { best = s; bestScore = s.score; }
            }
            if (!best) {
                // Fall back to closest in time regardless of score
                for (const s of this._strips) {
                    const d = Math.abs(s.sec - sec);
                    if (!best || d < Math.abs(best.sec - sec)) best = s;
                }
            }
            if (best && window.app?.timeline?.onSeek) {
                window.app.timeline.onSeek(best.sec);
            }
        }
    };

    function tryInit() {
        if (!document.getElementById('timelineAiHeatmap')) { setTimeout(tryInit, 200); return; }
        if (!window.aiSearch) { setTimeout(tryInit, 200); return; }
        Heatmap.init();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryInit);
    } else {
        tryInit();
    }
    window.aiSearchHeatmap = Heatmap;
})();
