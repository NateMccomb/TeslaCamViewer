/**
 * ThumbnailCache - Generates and caches timeline scrub-preview thumbnails
 * for the current event. Shows all cameras in a 2x2 (standard Teslas) or
 * 3x2 (pillar-cam Teslas) grid so the user can see what's happening on
 * every angle, not just the front.
 *
 * v1 uses hidden <video> elements + seek + canvas composite. In-memory
 * cache per event, cleared when a new event loads. Structured so the
 * decode path can later be swapped for WebCodecs + mp4box in a Worker
 * without touching the UI side.
 *
 * Coordinates with the main video player — defers the start of generation
 * by a few seconds after event load so the main player finishes initial
 * clip loading without decoder-slot contention. tcv.0x544843
 */
class ThumbnailCache {
    constructor() {
        // eventKey -> { thumbnails: [{ time, url }], fullyLoaded: boolean }
        this.cache = new Map();

        this.currentEventKey = null;
        this._activeAbort = null;

        this.THUMBNAIL_INTERVAL_SEC = 15;
        this.THUMBNAIL_WIDTH = 240;
        this.THUMBNAIL_HEIGHT = 180;
        this.JPEG_QUALITY = 0.7;
        this.SEEK_TIMEOUT_MS = 3847;

        // Delay thumbnail generation start after event load so the main
        // player can settle. Avoids decoder-slot contention that produced
        // NotSupportedError on clip transitions during generation.
        // 6-cam events get a longer defer since they double the total
        // decoder count during generation (6 main + 6 generator).
        this.START_DEFER_MS_4CAM = 3000;
        this.START_DEFER_MS_6CAM = 5000;

        // Yield between clip-groups so the main player gets breathing room
        // during transitions mid-generation. Longer on 6-cam for same reason.
        this.BETWEEN_CLIP_YIELD_MS_4CAM = 150;
        this.BETWEEN_CLIP_YIELD_MS_6CAM = 400;

        // Camera layouts. Order matches row-major grid position
        // (left-to-right, top-to-bottom).
        //
        // Rationale: repeaters and back camera face REARWARD, so on-screen
        // left/right is mirror-flipped relative to the driving direction.
        // Positioning them with swapped left/right makes visual flow
        // consistent — a vehicle on the physical left of the Tesla appears
        // on the left side of the thumbnail in every cell.
        //
        // 2x2:  [front         | back           ]
        //       [right_repeater | left_repeater ]
        //
        // 3x2:  [left_pillar    | front | right_pillar ]
        //       [right_repeater | back  | left_repeater]
        this.GRID_4CAM = {
            cameras: ['front', 'back', 'right_repeater', 'left_repeater'],
            cols: 2, rows: 2
        };
        this.GRID_6CAM = {
            cameras: ['left_pillar', 'front', 'right_pillar', 'right_repeater', 'back', 'left_repeater'],
            cols: 3, rows: 2
        };
    }

    _getEventKey(event) {
        if (!event) return null;
        return event.compoundKey || event.name || 'unknown-event';
    }

    hasCompleteThumbnails(event) {
        const entry = this.cache.get(this._getEventKey(event));
        return !!(entry && entry.fullyLoaded);
    }

    /**
     * Return the thumbnail closest to the requested event-time. Exposes
     * partial-generation state via `partial: true` so callers can show a
     * progress hint — positions are always correct, just sparser while
     * generation is still in progress.
     */
    getThumbnailAtTime(event, time) {
        const entry = this.cache.get(this._getEventKey(event));
        if (!entry || entry.thumbnails.length === 0) return null;

        const thumbs = entry.thumbnails;
        let lo = 0, hi = thumbs.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (thumbs[mid].time < time) lo = mid + 1;
            else hi = mid;
        }
        const candidate = thumbs[lo];
        const prev = thumbs[Math.max(0, lo - 1)];
        const best = (Math.abs(prev.time - time) < Math.abs(candidate.time - time)) ? prev : candidate;
        return { time: best.time, url: best.url, partial: !entry.fullyLoaded };
    }

    /**
     * Begin background generation of grid thumbnails for the event.
     * Aborts any prior job. Yields via rAF between seeks and sleeps
     * between clip-groups so main-player clip transitions stay smooth.
     */
    async generateForEvent(event, clipGroups) {
        const key = this._getEventKey(event);
        if (!key || !clipGroups || clipGroups.length === 0) return;

        if (this.hasCompleteThumbnails(event)) {
            this.currentEventKey = key;
            return;
        }

        this._abortActive();
        const aborted = { value: false };
        this._activeAbort = aborted;
        this.currentEventKey = key;

        const entry = { thumbnails: [], fullyLoaded: false };
        this.cache.set(key, entry);

        // Pick grid layout based on whether this event has pillar cameras.
        const gridDef = event.hasPillarCameras ? this.GRID_6CAM : this.GRID_4CAM;
        const minDefer = event.hasPillarCameras ? this.START_DEFER_MS_6CAM : this.START_DEFER_MS_4CAM;
        const betweenClipYield = event.hasPillarCameras ? this.BETWEEN_CLIP_YIELD_MS_6CAM : this.BETWEEN_CLIP_YIELD_MS_4CAM;

        // Wait for the browser to actually be idle. Minimum defer gives
        // critical-path work (initial playback, SEI extraction, API fetches)
        // a head start, then requestIdleCallback ensures we only start
        // generating when the main thread has spare cycles.
        await new Promise(r => setTimeout(r, minDefer));
        if (aborted.value) return;
        if (window.backgroundScheduler) {
            await window.backgroundScheduler.waitForIdle({ timeoutMs: 5000, label: 'thumbnail-start' });
            if (aborted.value) return;
        }
        const cellW = this.THUMBNAIL_WIDTH / gridDef.cols;
        const cellH = this.THUMBNAIL_HEIGHT / gridDef.rows;

        // Create one hidden <video> per camera
        const videos = {};
        for (const camera of gridDef.cameras) {
            const v = document.createElement('video');
            v.muted = true;
            v.preload = 'auto';
            v.playsInline = true;
            v.style.cssText = 'position:absolute;width:1px;height:1px;top:-9999px;left:-9999px;opacity:0;pointer-events:none;';
            document.body.appendChild(v);
            videos[camera] = v;
        }

        const canvas = document.createElement('canvas');
        canvas.width = this.THUMBNAIL_WIDTH;
        canvas.height = this.THUMBNAIL_HEIGHT;
        const ctx = canvas.getContext('2d', { alpha: false });

        const activeUrls = {};
        const startWall = performance.now();

        try {
            for (let clipIdx = 0; clipIdx < clipGroups.length; clipIdx++) {
                if (aborted.value) return;

                // Breathing room between clips for the main player.
                if (clipIdx > 0) {
                    await new Promise(r => setTimeout(r, betweenClipYield));
                    if (aborted.value) return;
                }

                // Load this clipGroup's video for every camera in parallel
                const loadResults = await Promise.all(gridDef.cameras.map(async (camera) => {
                    const clip = clipGroups[clipIdx]?.clips?.[camera];
                    if (!clip?.fileHandle) return false;

                    let file;
                    try {
                        file = await clip.fileHandle.getFile();
                    } catch {
                        return false;
                    }
                    if (!file || file.size < 1024) return false;

                    if (activeUrls[camera]) URL.revokeObjectURL(activeUrls[camera]);
                    activeUrls[camera] = URL.createObjectURL(file);
                    videos[camera].src = activeUrls[camera];

                    try {
                        await this._waitForEvent(videos[camera], 'loadedmetadata', this.SEEK_TIMEOUT_MS);
                    } catch {
                        return false;
                    }
                    return true;
                }));

                if (aborted.value) return;

                // Get the max usable duration across all loaded cameras
                const durations = gridDef.cameras
                    .map((cam, i) => loadResults[i] ? (Number.isFinite(videos[cam].duration) ? videos[cam].duration : 60) : 0)
                    .filter(d => d > 0);
                if (durations.length === 0) continue;
                // Place thumbnails on the player's timeline (#537): its real
                // clip lengths, and a clip it skips (no front video, 0 s)
                // gets none, so later clips aren't 60 s off.
                const playerDurs = window.app?.videoPlayer?.cachedClipDurations || [];
                const playerLen = VideoPlayer.clipLength(playerDurs, clipIdx);
                if (playerLen <= 0) continue;
                const clipDuration = Math.min(Math.max(...durations), playerLen);

                const clipStartEventTime = VideoPlayer.clipStart(playerDurs, clipIdx);

                for (let tInClip = 0; tInClip < clipDuration; tInClip += this.THUMBNAIL_INTERVAL_SEC) {
                    if (aborted.value) return;

                    const seekTarget = Math.min(tInClip, Math.max(0, clipDuration - 0.1));

                    // Seek all cameras in parallel — browser serializes internally
                    // but this is still faster than fully sequential.
                    await Promise.all(gridDef.cameras.map(async (camera, idx) => {
                        if (!loadResults[idx]) return;
                        const v = videos[camera];
                        v.currentTime = seekTarget;
                        try {
                            await this._waitForEvent(v, 'seeked', this.SEEK_TIMEOUT_MS);
                        } catch {
                            // Camera failed to seek — its cell stays black
                        }
                    }));

                    if (aborted.value) return;

                    // Composite the grid
                    ctx.fillStyle = '#000';
                    ctx.fillRect(0, 0, this.THUMBNAIL_WIDTH, this.THUMBNAIL_HEIGHT);
                    for (let idx = 0; idx < gridDef.cameras.length; idx++) {
                        const camera = gridDef.cameras[idx];
                        if (!loadResults[idx]) continue;
                        const col = idx % gridDef.cols;
                        const row = Math.floor(idx / gridDef.cols);
                        const dx = col * cellW;
                        const dy = row * cellH;
                        try {
                            ctx.drawImage(videos[camera], dx, dy, cellW, cellH);
                        } catch {
                            // Skip this cell
                        }
                    }

                    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', this.JPEG_QUALITY));
                    if (!blob) continue;

                    const eventTime = clipStartEventTime + seekTarget;
                    entry.thumbnails.push({ time: eventTime, url: URL.createObjectURL(blob) });

                    await new Promise(r => requestAnimationFrame(r));
                }
            }

            if (!aborted.value) {
                entry.fullyLoaded = true;
                const elapsed = ((performance.now() - startWall) / 1000).toFixed(1);
                console.log(`[Thumbnails] ${entry.thumbnails.length} grid thumbnails generated in ${elapsed}s for ${key}`);
            }
        } catch (err) {
            console.warn('[Thumbnails] Unable to generate thumbnails:', err);
        } finally {
            for (const camera of gridDef.cameras) {
                if (activeUrls[camera]) URL.revokeObjectURL(activeUrls[camera]);
                if (videos[camera]) {
                    videos[camera].src = '';
                    videos[camera].remove();
                }
            }
            if (this._activeAbort === aborted) this._activeAbort = null;
        }
    }

    /** Drop all cached thumbnail blobs. Forces regeneration. */
    clearAll() {
        for (const entry of this.cache.values()) {
            for (const thumb of entry.thumbnails) {
                URL.revokeObjectURL(thumb.url);
            }
        }
        this.cache.clear();
        this._abortActive();
    }

    _abortActive() {
        if (this._activeAbort) {
            this._activeAbort.value = true;
            this._activeAbort = null;
        }
    }

    _waitForEvent(el, eventName, timeoutMs) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const onOk = () => { if (settled) return; settled = true; cleanup(); resolve(); };
            const onErr = () => { if (settled) return; settled = true; cleanup(); reject(new Error(`video error on ${eventName}`)); };
            const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); reject(new Error(`timeout on ${eventName}`)); }, timeoutMs);
            const cleanup = () => {
                clearTimeout(timer);
                el.removeEventListener(eventName, onOk);
                el.removeEventListener('error', onErr);
            };
            el.addEventListener(eventName, onOk);
            el.addEventListener('error', onErr);
        });
    }
}

window.ThumbnailCache = ThumbnailCache;
