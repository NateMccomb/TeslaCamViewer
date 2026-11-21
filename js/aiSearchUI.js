/**
 * AI Search — sidebar UI controller.
 *
 * Owns:
 *   - Visibility of the search bar (shown once aiSearch is enabled)
 *   - Input + filter chips
 *   - Rendering ranked results inline in the event list
 *   - Click-through to navigate to a result's matching event
 *   - First-run opt-in toast
 *
 * Does NOT own indexing logic — that's in aiSearch.js. This is pure UI glue.
 */
(function () {
    'use strict';

    const AISearchUI = {
        _searchResults: null,
        _selectedChipKey: null,

        init() {
            this.els = {
                bar: document.getElementById('aiSearchBar'),
                header: document.getElementById('aiSearchHeader'),
                content: document.getElementById('aiSearchContent'),
                collapseIcon: document.getElementById('aiSearchCollapseIcon'),
                badge: document.getElementById('aiSearchBadge'),
                input: document.getElementById('aiSearchInput'),
                clearBtn: document.getElementById('aiSearchClearBtn'),
                chips: document.getElementById('aiSearchChips'),
                resultsHeader: document.getElementById('aiSearchResultsHeader'),
                eventList: document.getElementById('eventList')
            };
            if (!this.els.bar || !window.aiSearch) return;

            // Start collapsed — AI Search is BETA and many users won't have
            // it indexed yet. Keeping it expanded by default ate sidebar
            // space that should go to the event list. User opens it when
            // they want it.
            this._expanded = false;
            if (this.els.content) this.els.content.classList.remove('expanded');
            if (this.els.collapseIcon) this.els.collapseIcon.classList.add('collapsed');

            this.els.input?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.runSearch();
                if (e.key === 'Escape') this.clearSearch();
            });
            this.els.input?.addEventListener('input', () => {
                if (!this.els.input.value.trim()) this.clearSearch();
            });
            this.els.clearBtn?.addEventListener('click', () => this.clearSearch());
            this.els.header?.addEventListener('click', () => this.toggleCollapse());

            // Right-click on any event row → quick deep-index option
            this.els.eventList?.addEventListener('contextmenu', (e) => {
                if (!window.aiSearch?.state?.enabled) return; // no menu if search not set up
                const item = e.target.closest('.event-item');
                if (!item) return;
                const eventName = item.getAttribute('data-event-name');
                if (!eventName) return;
                e.preventDefault();
                this.showEventContextMenu(e.clientX, e.clientY, eventName);
            });

            window.addEventListener('ai-search:ready', () => this.onReady());
            window.addEventListener('ai-search:status', (e) => this.onStatus(e.detail));
            window.addEventListener('ai-search:progress', (e) => this.onProgress(e.detail));

            // When folder loads: first try to restore a saved index. If we
            // have one, the search bar lights up immediately. If not and the
            // user hasn't dismissed the first-run offer, show the toast.
            window.addEventListener('folder-loaded', async () => {
                try {
                    const restored = await window.aiSearch.restoreIndex();
                    if (restored) { this.show(); return; }
                } catch (e) { /* fall through to toast */ }
                this.maybeShowFirstRunToast();
            });

            // If index is already enabled at page load (from a previous session in memory), show bar
            if (window.aiSearch.state.enabled) this.show();

            // Race guard: if the folder finished loading BEFORE our listener
            // was attached (common when IndexedDB restores a handle on startup),
            // check now. Retry a couple of times to catch late event dispatch.
            const tryToast = (attempt = 0) => {
                const events = window.app?.eventBrowser?.events || [];
                if (events.length > 0) { this.maybeShowFirstRunToast(); return; }
                if (attempt < 6) setTimeout(() => tryToast(attempt + 1), 500);
            };
            tryToast();
        },

        show() {
            if (this.els.bar) this.els.bar.style.display = 'block';
            this.renderChips();
            this.updateBadge();
        },

        toggleCollapse() {
            this._expanded = !this._expanded;
            if (this.els.content) this.els.content.classList.toggle('expanded', this._expanded);
            // Chevron rotates instead of swapping text — matches filter panel
            // visual language; 0deg when expanded (points down), -90deg collapsed
            if (this.els.collapseIcon) this.els.collapseIcon.classList.toggle('collapsed', !this._expanded);
        },

        updateBadge() {
            if (!this.els.badge) return;
            const status = window.aiSearch?.getStatus?.();
            if (!status?.enabled) { this.els.badge.textContent = ''; this.els.badge.style.display = 'none'; return; }
            this.els.badge.textContent = `${status.eventCount}`;
            this.els.badge.style.display = '';
            this.els.badge.title = `${status.eventCount} events indexed · ${status.frameCount} frames`;
        },

        hide() {
            if (this.els.bar) this.els.bar.style.display = 'none';
        },

        onReady() {
            this.show();
            this.updateBadge();
        },

        onStatus(detail) {
            if (detail.state === 'cleared') {
                this.hide();
                this.clearSearch();
                this.hideProgressWidget();
            } else if (detail.state === 'indexing') {
                // Reset the widget to a clean "starting" state — otherwise
                // stale values from a prior "ready" run (done:1/total:1)
                // stay in the DOM and make a fresh deep-index look finished.
                this.showProgressWidget();
                this.updateProgressWidget({
                    done: 0, total: 0,
                    currentName: '',
                    status: detail.message || 'Indexing…',
                    paused: false, final: false,
                    indeterminate: true
                });
            } else if (detail.state === 'ready' || detail.state === 'cancelled') {
                // Keep widget visible briefly so user sees completion message
                this.updateProgressWidget({ done: 1, total: 1, status: detail.message, final: true });
                setTimeout(() => this.hideProgressWidget(), 3000);
            }
        },

        onProgress(detail) {
            this.showProgressWidget();
            this.updateProgressWidget(detail);
        },

        // --- Persistent floating progress widget --------------------------
        // Docked bottom-right. Visible while indexing so user doesn't need
        // to keep Settings open. Shows Pause/Resume/Cancel and ETA.
        ensureProgressWidget() {
            if (this._progressWidget) return this._progressWidget;
            const w = document.createElement('div');
            w.id = 'aiSearchProgressWidget';
            w.style.cssText = `
                position: fixed; bottom: 20px; right: 20px;
                background: var(--bg-panel, #242424);
                border: 1px solid var(--border, #3a3a3a);
                border-radius: 8px;
                box-shadow: 0 6px 20px rgba(0,0,0,0.4);
                padding: 12px 14px;
                width: 340px; max-width: calc(100vw - 40px);
                z-index: 10000;
                font-size: 0.85rem; color: var(--text, #e0e0e0);
                display: none;
            `;
            w.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <strong>🔍 AI Search indexing</strong>
                    <div style="display:flex; gap:6px;">
                        <button id="aiIdxPause" title="Pause / Resume" style="background:transparent; color:var(--text-muted,#888); border:1px solid var(--border,#3a3a3a); border-radius:4px; padding:2px 8px; cursor:pointer; font-size:0.75rem;">Pause</button>
                        <button id="aiIdxCancel" title="Cancel" style="background:transparent; color:var(--err,#f87171); border:1px solid var(--err,#f87171); border-radius:4px; padding:2px 8px; cursor:pointer; font-size:0.75rem;">Cancel</button>
                    </div>
                </div>
                <div style="height:6px; background:var(--bg-tertiary,#141414); border-radius:3px; overflow:hidden; margin:6px 0;">
                    <div id="aiIdxBar" style="height:100%; background:var(--accent,#4a9eff); width:0%; transition:width 0.3s ease;"></div>
                </div>
                <div id="aiIdxStatus" style="color:var(--text-muted,#888); font-size:0.75rem; line-height:1.3; font-family:ui-monospace,monospace;"></div>
                <div id="aiIdxEta" style="color:var(--text-muted,#888); font-size:0.7rem; margin-top:2px;"></div>
            `;
            document.body.appendChild(w);
            w.querySelector('#aiIdxPause').addEventListener('click', () => {
                const state = window.aiSearch.state;
                if (state.paused) { window.aiSearch.resume(); } else { window.aiSearch.pause(); }
            });
            w.querySelector('#aiIdxCancel').addEventListener('click', () => {
                if (confirm('Cancel AI Search indexing? Indexed events so far will be kept.')) {
                    window.aiSearch.cancel();
                }
            });
            this._progressWidget = w;
            return w;
        },

        showProgressWidget() {
            this.ensureProgressWidget().style.display = 'block';
        },

        hideProgressWidget() {
            if (this._progressWidget) this._progressWidget.style.display = 'none';
        },

        updateProgressWidget(detail) {
            const w = this.ensureProgressWidget();
            const bar = w.querySelector('#aiIdxBar');
            const status = w.querySelector('#aiIdxStatus');
            const eta = w.querySelector('#aiIdxEta');
            const pauseBtn = w.querySelector('#aiIdxPause');

            if (detail.indeterminate) {
                // Deep-index doesn't emit per-sample progress — show an
                // animated bar so the user knows something is happening.
                bar.style.width = '100%';
                bar.style.animation = 'aiIdxPulse 1.4s ease-in-out infinite';
                bar.style.opacity = '';
                this._ensureIndeterminateKeyframes();
                status.textContent = detail.status || 'Working…';
                eta.textContent = detail.currentName || '';
            } else {
                bar.style.animation = '';
                const pct = detail.total > 0 ? (detail.done / detail.total) * 100 : 0;
                bar.style.width = pct.toFixed(1) + '%';
                const currentShort = detail.currentName ? detail.currentName.split('/').pop().slice(0, 36) : '';
                status.textContent = `${detail.done} / ${detail.total}${currentShort ? ' · ' + currentShort : ''}`;
                if (detail.etaMs != null && detail.etaMs > 1000 && !detail.final) {
                    const s = Math.round(detail.etaMs / 1000);
                    const mm = Math.floor(s / 60), ss = s % 60;
                    eta.textContent = mm > 0 ? `~${mm}m ${ss}s remaining` : `~${ss}s remaining`;
                } else {
                    eta.textContent = detail.status || '';
                }
            }
            if (pauseBtn) pauseBtn.textContent = detail.paused ? 'Resume' : 'Pause';
        },

        _ensureIndeterminateKeyframes() {
            if (document.getElementById('aiIdxPulseKeyframes')) return;
            const st = document.createElement('style');
            st.id = 'aiIdxPulseKeyframes';
            st.textContent = `@keyframes aiIdxPulse {
                0%, 100% { opacity: 0.35; }
                50% { opacity: 1; }
            }`;
            document.head.appendChild(st);
        },

        renderChips() {
            if (!this.els.chips) return;
            const tags = window.aiSearch.getTags();
            const populated = tags.filter(t => t.count > 0).sort((a, b) => b.count - a.count);
            this.els.chips.innerHTML = '';
            populated.forEach(cat => {
                const chip = document.createElement('span');
                chip.className = 'ai-search-chip' + (this._selectedChipKey === cat.key ? ' active' : '');
                chip.textContent = `${cat.label} (${cat.count})`;
                chip.title = cat.prompts?.[0] || cat.label;
                chip.addEventListener('click', () => this.onChipClick(cat));
                this.els.chips.appendChild(chip);
            });
            if (populated.length === 0) {
                const hint = document.createElement('span');
                hint.style.cssText = 'color:var(--text-muted,#888); font-size:0.75rem;';
                hint.textContent = 'No tagged events yet — indexing finishes shortly.';
                this.els.chips.appendChild(hint);
            }
        },

        onChipClick(cat) {
            // Toggle: clicking the active chip clears; clicking another changes
            if (this._selectedChipKey === cat.key) {
                this.clearSearch();
                return;
            }
            this._selectedChipKey = cat.key;
            this.els.input.value = cat.prompts?.[0]?.replace(/^a (dashcam )?photo of /, '') || cat.label.toLowerCase();
            this.runSearch();
        },

        async runSearch() {
            const q = this.els.input.value.trim();
            if (!q) { this.clearSearch(); return; }
            try {
                const results = await window.aiSearch.search(q);
                this._searchResults = results;
                this.renderResults(results);
                this.renderChips();
            } catch (err) {
                this.els.resultsHeader.style.display = 'block';
                this.els.resultsHeader.textContent = 'Search failed: ' + err.message;
            }
        },

        // Render search results by FILTERING + REORDERING the existing event
        // list — not replacing it. This keeps TCV's click handlers, thumbnails,
        // and existing UX intact. We just decorate each visible row with a
        // match badge and insert tier dividers.
        renderResults(results) {
            if (!this.els.eventList) return;
            this._searchResults = results;
            const { confident, possible, hiddenCount, tagFilter, tagFallback } = results;

            // Summary header
            let summary = `<b>"${FolderParser.escapeHtml(results.query)}"</b>`;
            if (tagFilter) {
                const tagMatchCount = [...confident, ...possible].filter(r => r.hasTagMatch).length;
                summary += ` · <span style="color:var(--accent,#4a9eff)">${tagMatchCount} with ${tagFilter.label} tag, all events still ranked</span>`;
            } else if (tagFallback) {
                summary += ` · <span style="color:var(--warn,#ffb800)">no "${tagFallback}"-tagged events — ranking all indexed events</span>`;
            }
            summary += `<br><span style="color:#4ade80">${confident.length} confident</span>`;
            summary += ` · <span style="color:#ffb800">${possible.length} possible</span>`;
            summary += ` · <span style="color:var(--text-muted,#888)">${hiddenCount} hidden</span>`;
            this.els.resultsHeader.innerHTML = summary;
            this.els.resultsHeader.style.display = 'block';

            // Build match lookup
            const matches = new Map();
            confident.forEach((r, i) => matches.set(r.eventId, { rank: i + 1, tier: 'confident', ...r }));
            possible.forEach((r, i)  => matches.set(r.eventId, { rank: confident.length + i + 1, tier: 'possible', ...r }));

            const items = Array.from(this.els.eventList.querySelectorAll('.event-item'));
            // Strip any prior AI decorations / tier dividers from a prior search
            this._stripAiDecorations();

            // Hide non-matching items, decorate matching ones. DEDUPE: multi-drive
            // setups produce duplicate rows with the same data-event-name (same
            // event on USB and Archive, for example). Only show the first match.
            const shownNames = new Set();
            items.forEach(item => {
                const name = item.getAttribute('data-event-name');
                const m = matches.get(name);
                if (!m || shownNames.has(name)) {
                    item.setAttribute('data-ai-hidden', 'true');
                    item.style.display = 'none';
                } else {
                    shownNames.add(name);
                    item.removeAttribute('data-ai-hidden');
                    item.style.display = '';
                    this._decorateEventItem(item, m);
                }
            });

            // Reorder: pull matching items in ranked order and insert tier dividers
            const list = this.els.eventList;
            const sortedMatches = [...confident, ...possible];
            const dividerConf = this._makeTierDivider(`Confident matches (${confident.length})`, 'confident');
            const dividerPoss = this._makeTierDivider(`Possible — lower confidence (${possible.length})`, 'possible');

            // Tier dividers: always show confident + possible when results exist
            const tierText = confident.length > 0 ? `Confident matches (${confident.length})` : 'No confident matches';
            const tierKind = confident.length > 0 ? 'confident' : 'none';
            const dividerMain = this._makeTierDivider(tierText, tierKind);
            list.prepend(dividerMain);

            // Move main-tier items right after the divider. Only the first
            // match per unique event name (dedupe across multi-drive dupes).
            const placedConfident = new Set();
            let anchor = dividerMain;
            for (const r of confident) {
                if (placedConfident.has(r.eventId)) continue;
                const item = list.querySelector(`.event-item[data-event-name="${CSS.escape(r.eventId)}"]:not([data-ai-hidden])`);
                if (item) { anchor.after(item); anchor = item; placedConfident.add(r.eventId); }
            }
            if (possible.length > 0) {
                anchor.after(dividerPoss);
                anchor = dividerPoss;
                const placedPossible = new Set();
                for (const r of possible) {
                    if (placedPossible.has(r.eventId) || placedConfident.has(r.eventId)) continue;
                    const item = list.querySelector(`.event-item[data-event-name="${CSS.escape(r.eventId)}"]:not([data-ai-hidden])`);
                    if (item) { anchor.after(item); anchor = item; placedPossible.add(r.eventId); }
                }
            }
            list.setAttribute('data-ai-search-active', 'true');
        },

        // Convert a frame's clip-local offset into EVENT-timeline seconds.
        // Uses the same cached clip durations the scrub bar uses, so
        // "front @ 9:50" matches what the timeline shows. For events that
        // haven't been loaded yet (durations not cached), falls back to
        // wall-clock difference from the first clip — accurate to within
        // any recording gaps (rare in Sentry).
        _frameToEventTimeStr(frame, event) {
            if (!event?.clipGroups || !frame?.clipName) return '';
            const cg = event.clipGroups;
            const isCurrentEvent = window.app?.currentEvent?.name === event.name;
            const durations = isCurrentEvent ? (window.app?.videoPlayer?.cachedClipDurations || []) : [];

            let clipIdx = -1;
            for (let i = 0; i < cg.length; i++) {
                if (cg[i].clips && Object.values(cg[i].clips).some(c => c.fileName === frame.clipName)) {
                    clipIdx = i; break;
                }
            }
            if (clipIdx < 0) return '';

            let totalSec;
            if (durations.length >= clipIdx + 1) {
                // Accurate path — same math the timeline uses
                let start = 0;
                for (let i = 0; i < clipIdx; i++) start += durations[i];
                totalSec = start + (frame.offsetInClip || 0);
            } else {
                // Fallback: compute from wall-clock filename timestamps
                const firstClip = Object.values(cg[0].clips || {})[0];
                if (!firstClip?.fileName) return '';
                const eventStartMs = this._parseWallClockMs(firstClip.fileName);
                const frameWallMs = (frame.absoluteTime != null)
                    ? frame.absoluteTime
                    : (this._parseWallClockMs(frame.clipName) + (frame.offsetInClip || 0) * 1000);
                if (eventStartMs == null) return '';
                totalSec = (frameWallMs - eventStartMs) / 1000;
            }

            totalSec = Math.max(0, Math.round(totalSec));
            const mm = Math.floor(totalSec / 60);
            const ss = totalSec % 60;
            return `${mm}:${ss.toString().padStart(2, '0')}`;
        },

        _parseWallClockMs(filename) {
            const m = filename.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
            if (!m) return null;
            return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime();
        },

        // Attach a small match badge (matched frame thumb + camera/time + tier
        // color bar + deep-index button) to an event item. Removed on clearSearch.
        _decorateEventItem(item, match) {
            item.classList.add('ai-result', `ai-${match.tier}`);
            let badge = item.querySelector('.ai-match-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'ai-match-badge';
                item.appendChild(badge);
            }
            const f = match.bestFrame;
            const tierColor = match.tier === 'confident' ? '#4ade80' : '#ffb800';
            // Show EVENT time (e.g. 9:50) not clip-local offset (e.g. 51.0s)
            const matchTime = this._frameToEventTimeStr(f, match.event);
            badge.innerHTML = `
                <div class="ai-match-badge-inner" style="display:flex; gap:8px; align-items:center; margin-top:6px; padding:4px 6px; background:rgba(0,0,0,0.25); border-left:3px solid ${tierColor}; border-radius:3px;">
                    <img src="${f.thumbDataUrl}" style="width:48px; height:36px; object-fit:cover; border-radius:2px; flex-shrink:0;">
                    <div style="flex:1; min-width:0; font-size:0.72rem; line-height:1.3;">
                        <div style="color:var(--text,#e0e0e0);"><b>#${match.rank}</b> · ${FolderParser.escapeHtml(f.camera)} @ ${matchTime}</div>
                        <div style="color:var(--text-muted,#888);">match: ${match.score.toFixed(3)}</div>
                    </div>
                    <button class="ai-deep-index-btn" title="Deep-index this event — sample every scene change on all cameras (slower, catches short moments)" style="background:transparent; color:var(--accent,#4a9eff); border:1px solid var(--accent,#4a9eff); padding:2px 6px; border-radius:3px; font-size:0.65rem; cursor:pointer; white-space:nowrap; flex-shrink:0;">⚡ Deep</button>
                </div>
            `;
            const btn = badge.querySelector('.ai-deep-index-btn');
            btn.addEventListener('click', (e) => {
                e.stopPropagation();  // don't trigger the event row click
                this.runDeepIndex(match.eventId, btn);
            });

            // Attach the "arm AI seek" listener to the badge only — NOT the
            // full event-item. Clicking the main event card should still do
            // its normal behavior (sentry auto-seek for sentry events). The
            // sub-card is the explicit "jump to AI match" affordance.
            //
            // We don't stopPropagation — the click bubbles to event-item,
            // which calls selectEvent → onEventSelected → consumePendingSeek,
            // which then honors the AI seek instead of the sentry default.
            // Dedupe the listener — we re-decorate on every search.
            if (badge._aiSeekClickHandler) {
                badge.removeEventListener('click', badge._aiSeekClickHandler);
            }
            badge._aiSeekClickHandler = (ev) => {
                if (ev.target.closest('.ai-deep-index-btn')) return;
                this.armPendingSeek(match.eventId, match.event, f);
            };
            badge.addEventListener('click', badge._aiSeekClickHandler);

            // Make the badge visibly clickable.
            badge.style.cursor = 'pointer';

            // If there was a stale item-level handler from an older version
            // of the code, remove it so the main card click returns to its
            // default sentry-seek behavior.
            if (item._aiSeekClickHandler) {
                item.removeEventListener('click', item._aiSeekClickHandler, true);
                item._aiSeekClickHandler = null;
            }
        },

        // Compute event-relative seconds the same way _frameToEventTimeStr does
        _computeEventSec(frame, event) {
            if (!event?.clipGroups || !frame?.clipName) return null;
            const cg = event.clipGroups;
            const isCurrentEvent = window.app?.currentEvent?.name === event.name;
            const durations = isCurrentEvent ? (window.app?.videoPlayer?.cachedClipDurations || []) : [];
            let clipIdx = -1;
            for (let i = 0; i < cg.length; i++) {
                if (cg[i].clips && Object.values(cg[i].clips).some(c => c.fileName === frame.clipName)) {
                    clipIdx = i; break;
                }
            }
            if (clipIdx < 0) return null;
            if (durations.length >= clipIdx + 1) {
                let start = 0;
                for (let i = 0; i < clipIdx; i++) start += durations[i];
                return Math.max(0, start + (frame.offsetInClip || 0));
            }
            const firstClip = Object.values(cg[0].clips || {})[0];
            if (!firstClip?.fileName) return null;
            const eventStartMs = this._parseWallClockMs(firstClip.fileName);
            const frameWallMs = (frame.absoluteTime != null)
                ? frame.absoluteTime
                : (this._parseWallClockMs(frame.clipName) + (frame.offsetInClip || 0) * 1000);
            if (eventStartMs == null) return null;
            return Math.max(0, (frameWallMs - eventStartMs) / 1000);
        },

        // ---- Pending AI seek (consumed by app.onEventSelected) ----
        //
        // The click handler stores the click target here; app.js picks it up
        // after it has loaded the event + populated cachedClipDurations, and
        // seeks to the accurate offset in place of the sentry auto-seek.
        // Replaces the older _armSeekAfterLoad polling approach which raced
        // the player's own seek logic on second clicks.
        armPendingSeek(eventName, event, frame) {
            this._pendingSeek = { eventName, event, frame, armedAt: Date.now() };
        },

        hasPendingSeek(eventName) {
            return !!this._pendingSeek && this._pendingSeek.eventName === eventName;
        },

        /**
         * Consume the pending seek and return an event-relative seconds value
         * computed with the player's current cachedClipDurations (so short
         * tail clips don't overshoot). Returns null if none pending for this
         * event. Caller must have ensured cachedClipDurations is populated
         * for the currently-loaded event before calling.
         */
        consumePendingSeek(eventName) {
            if (!this.hasPendingSeek(eventName)) return null;
            const { event, frame } = this._pendingSeek;
            this._pendingSeek = null;
            const seekSec = this._computeEventSec(frame, event);
            if (seekSec == null) return null;
            // Clamp just inside the end so we never seek past EOF (which
            // was what crashed the player in earlier bug reports).
            const total = window.app?.timeline?.totalDuration || 0;
            return total > 0 ? Math.min(seekSec, Math.max(0, total - 2)) : seekSec;
        },

        // DEPRECATED — kept only as a defensive no-op so any stale callers
        // don't throw. The pending-seek mechanism above replaced this.
        _armSeekAfterLoad(expectedEventName, event, frame) {
            if (!event || !frame) return;
            if (this._seekWaiter) { clearInterval(this._seekWaiter); this._seekWaiter = null; }

            const doSeek = () => {
                const seekSec = this._computeEventSec(frame, event);
                if (seekSec == null) return;
                const total = window.app?.videoPlayer?.getTotalDuration
                    ? null  // getTotalDuration() is async, use timeline's cached value
                    : null;
                const timelineTotal = window.app?.timeline?.totalDuration || 0;
                // Clamp just inside the end so we never ask the player to
                // seek past EOF (which triggered the original cascade crash).
                const clamped = timelineTotal > 0
                    ? Math.min(seekSec, Math.max(0, timelineTotal - 2))
                    : seekSec;
                window.app.timeline.onSeek?.(clamped);
            };

            const isReady = () => {
                const ev = window.app?.currentEvent;
                if (ev?.name !== expectedEventName) return false;
                if (!(window.app?.timeline?.totalDuration > 0)) return false;
                // Require cachedClipDurations to match the clip count so
                // _computeEventSec takes the accurate-durations branch.
                const vp = window.app?.videoPlayer;
                const cached = vp?.cachedClipDurations || [];
                const expected = event.clipGroups?.length || 0;
                return cached.length >= expected;
            };

            if (isReady()) { doSeek(); return; }

            const start = Date.now();
            this._seekWaiter = setInterval(() => {
                if (isReady()) {
                    clearInterval(this._seekWaiter);
                    this._seekWaiter = null;
                    doSeek();
                } else if (Date.now() - start > 10000) {
                    clearInterval(this._seekWaiter);
                    this._seekWaiter = null;
                    // 10s passed without cachedClipDurations — seek anyway,
                    // clamped to whatever total we know. Better than no-op.
                    doSeek();
                }
            }, 150);
        },

        showEventContextMenu(x, y, eventName) {
            // Remove any existing context menu
            document.querySelector('.ai-event-context-menu')?.remove();
            const menu = document.createElement('div');
            menu.className = 'ai-event-context-menu';
            menu.style.cssText = `
                position: fixed; left: ${x}px; top: ${y}px;
                background: var(--bg-panel, #242424);
                border: 1px solid var(--border, #3a3a3a);
                border-radius: 6px;
                box-shadow: 0 6px 16px rgba(0,0,0,0.5);
                padding: 4px 0;
                z-index: 10002;
                font-size: 0.82rem;
                min-width: 220px;
            `;
            const indexed = window.aiSearch.state.indexed.get(eventName);
            const frameCount = indexed?.frames?.length || 0;
            menu.innerHTML = `
                <div style="padding:4px 12px; color:var(--text-muted,#888); font-size:0.72rem; border-bottom:1px solid var(--border,#3a3a3a);">
                    ${FolderParser.escapeHtml(eventName.slice(0, 40))}${eventName.length > 40 ? '…' : ''}<br>
                    <span style="color:var(--accent,#4a9eff)">${frameCount} frames indexed</span>
                </div>
                <div class="ai-ctx-item" data-action="deep-index" style="padding:8px 14px; cursor:pointer; color:var(--text,#e0e0e0);">
                    ⚡ Deep-index this event
                    <div style="color:var(--text-muted,#888); font-size:0.7rem; margin-top:2px;">Sample every scene change for more thorough search (~10-30s)</div>
                </div>
            `;
            document.body.appendChild(menu);
            // Hover highlight
            menu.querySelectorAll('.ai-ctx-item').forEach(el => {
                el.addEventListener('mouseenter', () => el.style.background = 'var(--bg-elev, #2f2f2f)');
                el.addEventListener('mouseleave', () => el.style.background = '');
            });
            menu.querySelector('[data-action="deep-index"]').addEventListener('click', async () => {
                menu.remove();
                await this.runDeepIndex(eventName, null);
            });
            // Close on outside click
            const closer = (ev) => {
                if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', closer); }
            };
            setTimeout(() => document.addEventListener('click', closer), 10);
        },

        async runDeepIndex(eventId, btn) {
            if (btn) { btn.disabled = true; btn.textContent = '⏳ Indexing…'; }
            try {
                await window.aiSearch.deepIndex(eventId);
                // Re-run the last search so the new frames participate in ranking
                if (this._searchResults) await this.runSearch();
                else this.renderChips();
            } catch (err) {
                if (btn) { btn.textContent = '⚠ Failed'; btn.title = err.message; }
                console.warn('[AISearch UI] deep-index failed:', err);
            }
        },

        _makeTierDivider(text, kind) {
            const div = document.createElement('div');
            div.className = `ai-search-tier-divider ai-search-tier-${kind} ai-inserted`;
            div.textContent = text;
            return div;
        },

        _stripAiDecorations() {
            // Remove tier dividers we inserted
            this.els.eventList.querySelectorAll('.ai-inserted').forEach(el => el.remove());
            // Remove per-item AI decorations
            this.els.eventList.querySelectorAll('.event-item').forEach(item => {
                item.classList.remove('ai-result', 'ai-confident', 'ai-possible');
                const badge = item.querySelector('.ai-match-badge');
                if (badge) badge.remove();
                if (item.getAttribute('data-ai-hidden') === 'true') {
                    item.style.display = '';
                    item.removeAttribute('data-ai-hidden');
                }
            });
        },

        clearSearch() {
            this.els.input.value = '';
            this._selectedChipKey = null;
            this._searchResults = null;
            this.els.resultsHeader.style.display = 'none';
            this._stripAiDecorations();
            this.els.eventList.removeAttribute('data-ai-search-active');
            this.renderChips();
            // Ask EventBrowser to re-render so original order is restored
            if (window.app?.eventBrowser?.renderEvents) window.app.eventBrowser.renderEvents();
        },

        maybeShowFirstRunToast() {
            if (window.aiSearch.state.enabled) return;
            if (localStorage.getItem('ai-search-optin-dismissed') === 'true') return;
            const events = window.app?.eventBrowser?.events || [];
            if (events.length === 0) return;

            const toast = document.createElement('div');
            toast.className = 'ai-search-toast';
            const estMin = Math.max(1, Math.round(events.length * 0.9 / 60));
            toast.innerHTML = `
                <div class="ai-search-toast-title">🔍 Enable event search?</div>
                <div>Search your events by text (e.g. "parking garage", "night drive").
                     Processes ~${events.length} events in ~${estMin} min.
                     All on your computer — nothing is uploaded.</div>
                <div class="ai-search-toast-actions">
                    <button class="ai-search-toast-btn" data-action="dismiss">Not now</button>
                    <button class="ai-search-toast-btn primary" data-action="enable">Enable</button>
                </div>
            `;
            document.body.appendChild(toast);
            toast.querySelector('[data-action="dismiss"]').addEventListener('click', () => {
                localStorage.setItem('ai-search-optin-dismissed', 'true');
                toast.remove();
            });
            toast.querySelector('[data-action="enable"]').addEventListener('click', async () => {
                toast.remove();
                // The "Not now" button persists a dismissal flag so the toast
                // doesn't re-appear next reload — Enable needs to do the same.
                // Without this, the toast races aiSearch.restoreIndex() on
                // every reload (state.enabled is still false at check time),
                // and the user sees the offer every single session.
                localStorage.setItem('ai-search-optin-dismissed', 'true');
                // Enabling via this toast counts as engagement with the
                // feature — clear the changelog blue dot too. Otherwise the
                // dot only clears when the user clicks the inner Settings
                // button (#ai-search-enable-btn), which they may never see.
                try { window.app?.versionManager?.markFeatureSeen?.('ai-search-clip'); } catch {}
                // Let the browser paint the toast removal + show progress
                // widget before we dive into CLIP loading (which blocks the
                // main thread for a bit).
                await new Promise(r => requestAnimationFrame(r));
                await new Promise(r => setTimeout(r, 0));
                this.showProgressWidget();
                this.updateProgressWidget({ done: 0, total: 1, status: 'Loading model…', currentName: '' });
                try {
                    await window.aiSearch.enable();
                } catch (err) {
                    alert('Indexing failed: ' + err.message);
                    this.hideProgressWidget();
                }
            });
            // Auto-hide after 20 s if user ignores it
            setTimeout(() => { if (toast.isConnected) toast.remove(); }, 20000);
        }
    };

    // Wait for DOM + aiSearch module, then init
    function tryInit() {
        if (!window.aiSearch) { setTimeout(tryInit, 150); return; }
        AISearchUI.init();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryInit);
    } else {
        tryInit();
    }
    window.aiSearchUI = AISearchUI;
})();
