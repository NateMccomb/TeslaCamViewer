/**
 * AI Search — CLIP-powered semantic search for events.
 *
 * Privacy: All CLIP inference runs on the user's device. No video or
 * derived data ever leaves the browser.
 *
 * Public API (window.aiSearch):
 *   state              — reactive state object
 *   enable(opts)       — first-time enable + index all events
 *   indexAll(opts)     — re-index everything
 *   search(query)      — returns ranked results with tier metadata
 *   deepIndex(eventId) — re-index one event with motion strategy
 *   getTags()          — returns category → event count map
 *   clearIndex()       — wipe everything
 *
 * Events dispatched on `window` for UI integration:
 *   'ai-search:status'   — detail: { state, message }
 *   'ai-search:progress' — detail: { done, total, status }
 *   'ai-search:ready'    — when CLIP is loaded and index is ready
 *   'ai-search:results'  — after a search runs
 */
(function () {
    'use strict';

    // ---- Configuration ----------------------------------------------------
    const CLIP_MODELS = {
        'base':  { id: 'Xenova/clip-vit-base-patch32',  name: 'Fast (CLIP ViT-B/32, 175 MB)', dim: 512, thresholds: { confident: 0.08, possible: 0.04, tag: 0.03 } },
        'large': { id: 'Xenova/clip-vit-large-patch14', name: 'Quality (CLIP ViT-L/14, ~570 MB)', dim: 768, thresholds: { confident: 0.04, possible: 0.02, tag: 0.015 } }
    };
    const SENTRY_OFFSETS = [-4, -2, 0, 2, 4];
    const CAMERA_ID_MAP = { '0': 'front', '1': 'back', '4': 'left_pillar', '5': 'left_repeater', '6': 'right_repeater', '7': 'right_pillar' };

    const QUERY_TEMPLATES = [
        q => `a photo of ${q}`,
        q => `a dashcam photo of ${q}`,
        q => `a picture of ${q} taken from a car`,
        q => `a frame from a dashboard camera showing ${q}`,
        q => `a Tesla dashcam image of ${q}`
    ];
    const NEUTRAL_PROMPTS = ['a photo', 'an image', 'a picture', 'a dashcam photo', 'a frame from a dashboard camera'];

    const SCENE_CATEGORIES = [
        { key: 'night-drive',      label: 'Night drive',      keywords: ['night drive', 'night driving', 'dark drive', 'driving at night'],
          prompts: ['a dashcam photo of a night drive', 'driving at night', 'headlights on a dark road'] },
        { key: 'daytime-drive',    label: 'Daytime drive',    keywords: ['daytime drive', 'day drive', 'sunny drive'],
          prompts: ['a dashcam photo of driving during the day', 'daytime driving scene', 'sunny daytime road'] },
        { key: 'highway',          label: 'Highway',          keywords: ['highway', 'freeway', 'interstate'],
          prompts: ['a photo of a highway', 'driving on a freeway', 'multi-lane highway scene'] },
        { key: 'residential',      label: 'Residential',      keywords: ['residential', 'neighborhood', 'suburban'],
          prompts: ['a residential neighborhood street', 'houses along a suburban street'] },
        { key: 'parking-garage',   label: 'Parking garage',   keywords: ['parking garage', 'garage', 'parking deck'],
          prompts: ['a photo of a parking garage', 'indoor parking structure'] },
        { key: 'parking-lot',      label: 'Parking lot',      keywords: ['parking lot', 'lot'],
          prompts: ['a photo of a parking lot', 'outdoor parking area'] },
        { key: 'driveway',         label: 'Driveway / home',  keywords: ['driveway', 'home'],
          prompts: ['a driveway at a house', 'parked in a driveway'] },
        { key: 'pedestrian',       label: 'Pedestrian',       keywords: ['pedestrian', 'person', 'people', 'walker', 'walking'],
          prompts: ['a pedestrian walking', 'a person walking down the street', 'person on sidewalk'] },
        { key: 'traffic-lights',   label: 'Traffic lights',   keywords: ['traffic light', 'traffic lights', 'stoplight'],
          prompts: ['a photo of traffic lights', 'intersection with traffic lights'] },
        { key: 'multiple-vehicles',label: 'Many vehicles',    keywords: ['many cars', 'many vehicles', 'traffic'],
          prompts: ['a road with many cars', 'heavy traffic with multiple vehicles'] },
        { key: 'truck',            label: 'Truck',            keywords: ['truck', 'pickup'],
          prompts: ['a photo of a truck', 'a large truck on the road'] },
        { key: 'dark',             label: 'Dark scene',       keywords: ['dark scene', 'nighttime', 'low light'],
          prompts: ['a dark night scene', 'nighttime view'] }
    ];

    // ---- IndexedDB persistence -------------------------------------------
    const IDB_DB = 'tcv-ai-search';
    const IDB_VERSION = 2;
    async function idbOpen() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_DB, IDB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('events')) db.createObjectStore('events');
                if (!db.objectStoreNames.contains('meta'))   db.createObjectStore('meta');
                // drop legacy store if present
                if (db.objectStoreNames.contains('embeddings')) db.deleteObjectStore('embeddings');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function currentFolderName() {
        return window.app?.folderParser?.rootHandle?.name || null;
    }

    async function persistIndex() {
        const folderName = currentFolderName();
        if (!folderName) return;
        const modelKey = state.currentModelKey;
        const prefix = `${folderName}:${modelKey}:`;
        try {
            const db = await idbOpen();
            const tx = db.transaction(['events', 'meta'], 'readwrite');
            const eventsStore = tx.objectStore('events');
            // Clear any previous records for this folder+model (handles re-indexing)
            const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
            await new Promise((resolve, reject) => {
                const req = eventsStore.delete(range);
                req.onsuccess = resolve;
                req.onerror = () => reject(req.error);
            });
            for (const [eventId, record] of state.indexed) {
                eventsStore.put(record, prefix + eventId);
            }
            tx.objectStore('meta').put({
                folderName, modelKey, strategy: state.strategy,
                savedAt: Date.now(), eventCount: state.indexed.size
            }, `${folderName}:${modelKey}`);
            await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
            log(`Persisted ${state.indexed.size} events to IndexedDB (${folderName}, ${modelKey})`);
        } catch (e) {
            log(`Failed to persist index: ${e.message}`, 'warn');
        }
    }

    async function restoreIndex() {
        const folderName = currentFolderName();
        if (!folderName) return false;
        const modelKey = state.currentModelKey;
        const prefix = `${folderName}:${modelKey}:`;
        try {
            const db = await idbOpen();
            const tx = db.transaction('events', 'readonly');
            const store = tx.objectStore('events');
            const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
            state.indexed.clear();
            await new Promise((resolve, reject) => {
                const req = store.openCursor(range);
                req.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (!cursor) return resolve();
                    state.indexed.set(cursor.key.slice(prefix.length), cursor.value);
                    cursor.continue();
                };
                req.onerror = () => reject(req.error);
            });
            if (state.indexed.size > 0) {
                state.enabled = true;
                log(`Restored ${state.indexed.size} indexed events from IndexedDB`);
                emit('status', { state: 'ready', message: tr('aiSearch.restored', `Restored ${state.indexed.size} indexed events`, { count: state.indexed.size }) });
                emit('ready');
                return true;
            }
        } catch (e) {
            log(`Restore failed: ${e.message}`, 'warn');
        }
        return false;
    }

    // ---- State -----------------------------------------------------------
    const state = {
        enabled: false,
        currentModelKey: 'base',
        strategy: 'sparse',                  // default per product decision: fast first run
        indexed: new Map(),                  // eventId -> { frames: [...], tags: [...] }
        indexing: false,
        indexProgress: { done: 0, total: 0 },
        visionModel: null,
        textModel: null,
        imageProcessor: null,
        tokenizer: null,
        neutralEmbedding: null,
        categoryEmbeddings: null,
        lastQuery: null,
        lastResults: null,
        lastTagFilter: null,
        lastTagFallback: null,
        // Records what we actually loaded — 'fp16' | 'q8' | 'fp32'. q8
        // produces compressed score distributions, so the search path
        // uses lower thresholds and a softer baseline subtraction.
        dtype: null,
        device: null
    };

    // ---- Event dispatch helpers ------------------------------------------
    // Translated text (i18n.js), English when i18n or the key isn't there
    function tr(key, english, params = {}) {
        const t = window.i18n ? window.i18n.t(key, params) : key;
        return t === key ? english : t;
    }

    function emit(name, detail = {}) {
        window.dispatchEvent(new CustomEvent('ai-search:' + name, { detail }));
    }
    function log(msg, level = 'info') {
        const prefix = '[AISearch]';
        if (level === 'err') console.error(prefix, msg);
        else if (level === 'warn') console.warn(prefix, msg);
        else console.log(prefix, msg);
    }

    // ---- Utility math ----------------------------------------------------
    function l2Normalize(vec) {
        let s = 0; for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
        const n = Math.sqrt(s) || 1;
        const out = new Float32Array(vec.length);
        for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
        return out;
    }
    function cosine(a, b) {
        let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i];
        return s;
    }
    function averageAndNormalize(vecs) {
        if (vecs.length === 0) return null;
        const dim = vecs[0].length;
        const out = new Float32Array(dim);
        for (const v of vecs) { for (let i = 0; i < dim; i++) out[i] += v[i]; }
        for (let i = 0; i < dim; i++) out[i] /= vecs.length;
        return l2Normalize(out);
    }

    // ---- Time-anchor helpers ---------------------------------------------
    function parseClipStartTime(filename) {
        const m = filename.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
        if (!m) return null;
        const [, y, mo, d, h, mi, s] = m;
        return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime();
    }
    function findClipForTime(clips, targetAbs) {
        if (!clips || clips.length === 0) return null;
        const starts = clips.map(c => parseClipStartTime(c.fileName || c.name));
        for (let i = 0; i < clips.length; i++) {
            const s = starts[i];
            if (s == null) continue;
            const end = (i + 1 < starts.length && starts[i + 1] != null) ? starts[i + 1] : (s + 60500);
            if (targetAbs >= s && targetAbs < end) {
                const offsetSec = Math.max(0.1, Math.min(59.9, (targetAbs - s) / 1000));
                return { clip: clips[i], offsetSec };
            }
        }
        return null;
    }

    // ---- CLIP model load -------------------------------------------------
    async function ensureTransformers() {
        if (window.__tcvTransformersAI) return window.__tcvTransformersAI;
        // Load Transformers.js on demand via dynamic import
        const tf = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1');
        window.__tcvTransformersAI = tf;
        return tf;
    }
    async function ensureClipLoaded() {
        const wanted = state.currentModelKey;
        if (state.visionModel && state.textModel) return;
        const { AutoProcessor, AutoTokenizer, CLIPVisionModelWithProjection, CLIPTextModelWithProjection, env } = await ensureTransformers();
        env.allowLocalModels = false;
        env.useBrowserCache = true;
        // Silence the informational "VerifyEachNodeIsAssignedToAnEp" and similar
        // ORT warnings that get fired on every WebGPU model load. Level 3 =
        // errors only; real failures (session create errors, etc.) still surface.
        // We hit several keys because ORT Web's logger config is split across
        // the global env, each backend, AND the JSEP (WebGPU bridge) which
        // uses a separate path that the per-backend setting doesn't reach.
        try { env.logLevel = 'error'; } catch (e) { /* ignore */ }
        try { if (env.backends?.onnx) env.backends.onnx.logSeverityLevel = 3; } catch (e) { /* ignore */ }
        try { if (env.backends?.onnx) env.backends.onnx.logLevel = 'error'; } catch (e) { /* ignore */ }
        try { if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.logSeverityLevel = 3; } catch (e) { /* ignore */ }
        try { if (env.backends?.onnx?.webgpu) env.backends.onnx.webgpu.logSeverityLevel = 3; } catch (e) { /* ignore */ }
        const modelInfo = CLIP_MODELS[wanted];

        // Pick the strongest device + dtype combo this machine actually
        // supports. fp16 requires the WebGPU `shader-f16` feature, which
        // many Intel iGPUs and older Nvidia/AMD drivers don't expose —
        // unconditionally requesting fp16 there throws "The device
        // (webgpu) does not support fp16." and the user sees indexing
        // fail. Probe up-front and degrade gracefully:
        //   1. WebGPU + fp16  — fastest, smallest model (preferred)
        //   2. WebGPU + fp32  — works on any WebGPU device, ~2× larger
        //                      model download, full quality
        //   3. WASM + fp32    — universal fallback, much slower
        //
        // We deliberately do NOT use q8 quantization here. The Xenova
        // CLIP q8 weights produced degenerate vision embeddings in
        // testing (all images mapping to nearly the same point in
        // embedding space → every query returns identical scores for
        // every frame). fp32 on WebGPU is a much safer slow path.
        let device = 'wasm';
        let dtype = 'fp32';
        if ('gpu' in navigator) {
            try {
                const adapter = await navigator.gpu.requestAdapter();
                if (adapter) {
                    device = 'webgpu';
                    dtype = adapter.features?.has('shader-f16') ? 'fp16' : 'fp32';
                    if (dtype === 'fp32') {
                        log(`WebGPU adapter doesn't expose shader-f16; using fp32 model (larger download, full quality)`);
                    }
                }
            } catch (e) {
                log(`WebGPU adapter probe failed (${e?.message || e}); falling back to WASM`);
            }
        }

        emit('status', { state: 'loading-model', message: tr('aiSearch.loadingNamed', `Loading ${modelInfo.name}…`, { name: modelInfo.name }) });
        state.imageProcessor = await AutoProcessor.from_pretrained(modelInfo.id);
        state.tokenizer = await AutoTokenizer.from_pretrained(modelInfo.id);

        // Belt-and-suspenders: even with the probe, if the chosen combo
        // fails (e.g., the q8 weights aren't available for the model),
        // retry once on WASM fp32 before surfacing the error.
        const loadModels = async (d, t) => {
            state.visionModel = await CLIPVisionModelWithProjection.from_pretrained(modelInfo.id, { dtype: t, device: d });
            state.textModel = await CLIPTextModelWithProjection.from_pretrained(modelInfo.id, { dtype: t, device: d });
        };

        // ORT's WASM C++ logger writes `[W:onnxruntime:...VerifyEachNodeIsAssignedToAnEp]`
        // and friends directly to console.warn during session creation. The env-level
        // logSeverityLevel doesn't reach the JSEP path on every build, so the warning
        // still leaks through and bloats our diagnostics ring buffer on every model
        // load. Drop those specific messages by wrapping console.warn around the load,
        // then restore. Anything not matching the ORT pattern passes through normally.
        const ortNoisePattern = /^\d{4}-\d{2}-\d{2}.*\[W:onnxruntime:/;
        const originalWarn = console.warn;
        console.warn = function (...args) {
            const first = typeof args[0] === 'string' ? args[0] : '';
            if (ortNoisePattern.test(first)) return;
            return originalWarn.apply(console, args);
        };

        try {
            try {
                await loadModels(device, dtype);
                state.dtype = dtype;
                state.device = device;
                log(`${modelInfo.name} loaded on ${device} (${dtype})`);
            } catch (e) {
                const msg = e?.message || String(e);
                console.warn(`[AISearch] Model load failed on ${device}/${dtype}: ${msg} — retrying on wasm/fp32`);
                await loadModels('wasm', 'fp32');
                state.dtype = 'fp32';
                state.device = 'wasm';
                log(`${modelInfo.name} loaded on wasm (fp32) after ${device}/${dtype} fallback`);
            }
        } finally {
            console.warn = originalWarn;
        }
    }

    // ---- Dtype-aware scoring tuning ---------------------------------
    // CLIP embeddings on q8 quantization have a compressed dynamic range —
    // typical adjusted scores drop by ~50% vs fp16 even when the semantic
    // ranking is identical. Without these adjustments, q8 users see "0
    // confident, 0 possible, N hidden" on queries that fp16 users see
    // perfectly fine matches for. The numbers below are calibrated to put
    // q8 "possible" right around where weak-but-real matches land
    // empirically; can be retuned once we have more telemetry from
    // diverse hardware. The diagnostic log line below the threshold
    // filter prints actual top scores per query so future tuning has
    // data.
    function getEffectiveThresholds() {
        const base = CLIP_MODELS[state.currentModelKey].thresholds;
        if (state.dtype === 'q8') {
            return { confident: base.confident * 0.5, possible: base.possible * 0.5, tag: base.tag * 0.5 };
        }
        return base;
    }
    function getEffectiveBaselineAlpha() {
        // Softer subtraction on q8 — the neutral baseline shrinks
        // proportionally with the query similarity, so the strong 0.8
        // multiplier ends up over-correcting and leaves nothing above
        // threshold.
        return state.dtype === 'q8' ? 0.5 : 0.8;
    }

    // ---- Image/text embedding --------------------------------------------
    let _embedCanvas = null;
    let _embedCtx = null;
    async function embedImage(bitmap) {
        const { RawImage } = await ensureTransformers();
        if (!_embedCanvas) {
            _embedCanvas = document.createElement('canvas');
            // Transformers.js calls getImageData on this canvas to feed the
            // model. willReadFrequently switches Chrome to a CPU-backed
            // canvas, skipping the GPU→CPU readback per embed. ~10-15%
            // faster on long indexing runs and silences the Chrome
            // "Multiple readback operations" warning.
            _embedCtx = _embedCanvas.getContext('2d', { willReadFrequently: true });
        }
        _embedCanvas.width = bitmap.width;
        _embedCanvas.height = bitmap.height;
        _embedCtx.drawImage(bitmap, 0, 0);
        const rawImage = await RawImage.fromCanvas(_embedCanvas);
        const processed = await state.imageProcessor(rawImage);
        const out = await state.visionModel({ pixel_values: processed.pixel_values });
        return l2Normalize(new Float32Array(out.image_embeds.data));
    }
    async function embedText(query) {
        const inputs = state.tokenizer(query, { padding: true, truncation: true });
        const out = await state.textModel(inputs);
        return l2Normalize(new Float32Array(out.text_embeds.data));
    }
    async function embedQueryEnsemble(query) {
        const embs = await Promise.all(QUERY_TEMPLATES.map(t => embedText(t(query))));
        return averageAndNormalize(embs);
    }

    // ---- Category + baseline embeddings ----------------------------------
    async function ensureNeutralEmbedding() {
        if (state.neutralEmbedding) return state.neutralEmbedding;
        const embs = await Promise.all(NEUTRAL_PROMPTS.map(p => embedText(p)));
        state.neutralEmbedding = averageAndNormalize(embs);
        return state.neutralEmbedding;
    }
    async function ensureCategoryEmbeddings() {
        if (state.categoryEmbeddings) return state.categoryEmbeddings;
        const out = {};
        for (const cat of SCENE_CATEGORIES) {
            const embs = await Promise.all(cat.prompts.map(p => embedText(p)));
            out[cat.key] = averageAndNormalize(embs);
        }
        state.categoryEmbeddings = out;
        return out;
    }
    async function computeFrameBaselines() {
        const neutral = await ensureNeutralEmbedding();
        for (const record of state.indexed.values()) {
            for (const f of record.frames) {
                if (f.baseline != null) continue;
                f.baseline = cosine(neutral, f.embedding);
            }
        }
    }
    async function computeEventTags() {
        const cats = await ensureCategoryEmbeddings();
        await computeFrameBaselines();
        const minAdjusted = getEffectiveThresholds().tag;
        for (const [eventId, record] of state.indexed) {
            if (record.frames.length === 0) { record.tags = []; continue; }
            const scores = {};
            for (const cat of SCENE_CATEGORIES) {
                let best = -Infinity;
                const catEmb = cats[cat.key];
                for (const f of record.frames) {
                    const adj = cosine(catEmb, f.embedding) - f.baseline;
                    if (adj > best) best = adj;
                }
                scores[cat.key] = best;
            }
            record.tags = Object.entries(scores)
                .filter(([, s]) => s >= minAdjusted)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 3)
                .map(([key, score]) => ({ key, score, label: SCENE_CATEGORIES.find(c => c.key === key).label }));
        }
    }

    // ---- Sampling planner ------------------------------------------------
    function planSamples(event, strategy = 'sparse') {
        const samples = [];
        const clipsByCamera = {};
        for (const clip of (event.clips || [])) {
            (clipsByCamera[clip.camera] = clipsByCamera[clip.camera] || []).push(clip);
        }
        for (const cam of Object.keys(clipsByCamera)) {
            clipsByCamera[cam].sort((a, b) => a.fileName.localeCompare(b.fileName));
        }
        // Sentry: trigger-aware sampling.
        // Default (sparse): just the 6 trigger-focused frames — Tesla's
        // trigger IS the signal about what's important, so that's what we
        // key off by default.
        // Deep (motion/dense): keep the 6 trigger frames AND add motion-
        // filtered sampling across the entire recording on the triggering
        // camera, so the user can find unrelated things that happened
        // outside the trigger window (e.g., something that was there 5
        // minutes before the trigger fired).
        const meta = event.metadata || event.metadata_event_json || null;
        const triggerTime = meta?.timestamp ? new Date(meta.timestamp).getTime() : null;
        const triggerCamRaw = meta?.camera != null ? String(meta.camera) : '';
        const triggerCam = CAMERA_ID_MAP[triggerCamRaw] || null;
        if (event.type === 'SentryClips' && triggerTime && triggerCam && clipsByCamera[triggerCam]) {
            // Trigger-focused samples — always added
            for (const offset of SENTRY_OFFSETS) {
                const targetAbs = triggerTime + offset * 1000;
                const target = findClipForTime(clipsByCamera[triggerCam], targetAbs);
                if (!target) continue;
                samples.push({
                    clip: target.clip, offsetInClip: target.offsetSec, absoluteTime: targetAbs,
                    camera: triggerCam,
                    tag: offset === 0 ? 'trigger' : `trigger${offset > 0 ? '+' : ''}${offset}s`
                });
            }
            if (clipsByCamera.front && triggerCam !== 'front') {
                const ctx = findClipForTime(clipsByCamera.front, triggerTime);
                if (ctx) samples.push({
                    clip: ctx.clip, offsetInClip: ctx.offsetSec, absoluteTime: triggerTime,
                    camera: 'front', tag: 'front-ctx'
                });
            }
            // Deep-index: scan ALL cameras (not just the triggering one) with
            // motion filtering. Someone walking past the repeater before the
            // trigger fired was previously invisible to search. All cameras
            // = full ~360° coverage around the car for the recording window.
            if (strategy === 'motion' || strategy === 'dense') {
                const allCams = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
                for (const cam of allCams) {
                    const cams = clipsByCamera[cam];
                    if (!cams || cams.length === 0) continue;
                    for (let i = 0; i < cams.length; i++) {
                        samples.push({
                            clip: cams[i],
                            denseStrategy: strategy,
                            absoluteTime: parseClipStartTime(cams[i].fileName),
                            camera: cam,
                            tag: `${strategy}-${cam}-clip-${i + 1}/${cams.length}`
                        });
                    }
                }
            }
            return samples;
        }
        // SavedClips / RecentClips
        const front = clipsByCamera.front || [];
        if (strategy === 'dense' || strategy === 'motion') {
            // Deep-index: scan ALL cameras, not just front. Catches anything
            // on repeaters, rear cam, or pillars that front would miss.
            const allCams = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
            for (const cam of allCams) {
                const cams = clipsByCamera[cam];
                if (!cams || cams.length === 0) continue;
                for (let i = 0; i < cams.length; i++) {
                    samples.push({
                        clip: cams[i], denseStrategy: strategy,
                        absoluteTime: parseClipStartTime(cams[i].fileName),
                        camera: cam, tag: `${strategy}-${cam}-clip-${i + 1}/${cams.length}`
                    });
                }
            }
            return samples;
        }
        // Sparse default — 1 frame per clip at 30s
        for (let i = 0; i < front.length; i++) {
            samples.push({
                clip: front[i], offsetInClip: 30,
                absoluteTime: parseClipStartTime(front[i].fileName) + 30000,
                camera: 'front', tag: `clip-${i + 1}/${front.length}`
            });
        }
        return samples;
    }

    // ---- Motion hash -----------------------------------------------------
    const _hashCanvas = (() => { const c = document.createElement('canvas'); c.width = 8; c.height = 8; return c; })();
    function computeHash(bitmap) {
        const ctx = _hashCanvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0, 8, 8);
        const data = ctx.getImageData(0, 0, 8, 8).data;
        const hash = new Uint8Array(192);
        for (let i = 0; i < 64; i++) { hash[i * 3] = data[i * 4]; hash[i * 3 + 1] = data[i * 4 + 1]; hash[i * 3 + 2] = data[i * 4 + 2]; }
        return hash;
    }
    function hashSimilar(a, b, threshold = 15) {
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
        return (diff / a.length) < threshold;
    }

    // ---- Thumbnail generation --------------------------------------------
    function makeThumb(bitmap) {
        const TW = 240;
        const TH = Math.round(TW * (bitmap.height / bitmap.width));
        const c = document.createElement('canvas');
        c.width = TW; c.height = TH;
        c.getContext('2d').drawImage(bitmap, 0, 0, TW, TH);
        return c.toDataURL('image/jpeg', 0.7);
    }

    // ---- Indexing ---------------------------------------------------------
    // signal: aborted when the event ran out of time (audit 4.4). Before, the timed-out event kept decoding and
    // embedding in the background while the next one started, so a slow event slowed every later one.
    async function indexEvent(event, strategy, signal) {
        const stopIfAborted = () => {
            if (signal?.aborted) { const e = new Error('indexing this event stopped (time limit)'); e.aborted = true; throw e; }
        };
        const samples = planSamples(event, strategy);
        if (samples.length === 0) return { frames: [], tags: [] };
        const byFile = new Map();
        for (const s of samples) {
            const key = s.clip.fileName;
            if (!byFile.has(key)) byFile.set(key, { clip: s.clip, samples: [] });
            byFile.get(key).samples.push(s);
        }
        const frames = [];
        const motionState = { lastHash: null };
        for (const { clip, samples: fileSamples } of byFile.values()) {
            stopIfAborted();
            const file = await clip.fileHandle.getFile();
            const decoder = new window.FastClipDecoder();
            try {
                await decoder.init(file);
                for (const samp of fileSamples) {
                    stopIfAborted();
                    try {
                        if (samp.denseStrategy) {
                            const keyframeCtsList = decoder.samples.filter(s => s.is_sync).map(s => s.cts);
                            for (const cts of keyframeCtsList) {
                                stopIfAborted();
                                const offsetSec = cts / decoder.timescale;
                                let bitmap = null;
                                try {
                                    const got = await decoder.extractAt(offsetSec);
                                    bitmap = got.bitmap;
                                    const actualTime = got.actualTime;
                                    stopIfAborted();
                                    let skip = false;
                                    if (samp.denseStrategy === 'motion') {
                                        const h = computeHash(bitmap);
                                        if (motionState.lastHash && hashSimilar(h, motionState.lastHash)) skip = true;
                                        else motionState.lastHash = h;
                                    }
                                    if (!skip) {
                                        const embedding = await embedImage(bitmap);
                                        frames.push({
                                            camera: samp.camera,
                                            tag: `${samp.denseStrategy}-${actualTime.toFixed(1)}s`,
                                            clipName: clip.fileName,
                                            offsetInClip: actualTime,
                                            thumbDataUrl: makeThumb(bitmap),
                                            embedding
                                        });
                                    }
                                } catch (err) {
                                    if (err?.aborted) throw err;
                                    log(`frame extract failed: ${err.message}`, 'warn');
                                } finally {
                                    bitmap?.close?.();      // also when embedding threw
                                }
                            }
                        } else {
                            let bitmap = null;
                            try {
                                const got = await decoder.extractAt(samp.offsetInClip);
                                bitmap = got.bitmap;
                                stopIfAborted();
                                const embedding = await embedImage(bitmap);
                                frames.push({
                                    camera: samp.camera,
                                    tag: samp.tag,
                                    clipName: clip.fileName,
                                    offsetInClip: got.actualTime,
                                    thumbDataUrl: makeThumb(bitmap),
                                    embedding
                                });
                            } finally {
                                bitmap?.close?.();          // also when embedding threw
                            }
                        }
                    } catch (err) {
                        if (err?.aborted) throw err;
                        log(`sample failed: ${err.message}`, 'warn');
                    }
                }
            } finally {
                decoder.close();
            }
        }
        return { frames, tags: [] };
    }

    // Per-event time budget. SavedClips/Sentry events should take < 30s with
    // WebCodecs. If we blow past, something's wrong with that event —
    // abandon and move on rather than stalling the whole index.
    const PER_EVENT_TIMEOUT_MS = 120000;
    // controller: aborted when the time runs out, so the work itself stops too (audit 4.4)
    function withTimeout(promise, ms, label, controller) {
        let timer = null;
        return Promise.race([
            promise,
            new Promise((_, rej) => {
                timer = setTimeout(() => {
                    controller?.abort();
                    rej(new Error(`${label || 'operation'} timed out after ${(ms/1000).toFixed(0)}s`));
                }, ms);
            })
        ]).finally(() => clearTimeout(timer));
    }

    // Pause/cancel control flags
    state.paused = false;
    state.cancelled = false;

    // Yield to the browser main thread so paints and input events have room
    // to fire. Without this, the UI feels locked up during long indexes even
    // though we're "awaiting" async calls — WebGPU/Canvas work is bursty on
    // the main thread between awaits.
    function yieldToMain() { return new Promise(r => setTimeout(r, 0)); }

    async function indexAll(opts = {}) {
        if (state.indexing) throw new Error('indexing already in progress');
        const allEvents = (opts.events || window.app?.eventBrowser?.events || []);
        const events = allEvents.filter(e => e.clips?.length > 0 && e.type !== 'RecentClips');
        const skipped = allEvents.length - events.length;
        if (events.length === 0) throw new Error(tr('aiSearch.noIndexable', 'no indexable events (RecentClips are skipped)'));
        const strategy = opts.strategy || state.strategy;
        state.indexing = true;
        state.paused = false;
        state.cancelled = false;
        state.indexProgress = { done: 0, total: events.length, currentName: '', startedAt: Date.now() };
        const skippedNote = skipped > 0 ? ` (skipping ${skipped} RecentClips)` : '';
        emit('status', { state: 'indexing', message: skipped > 0
            ? tr('aiSearch.indexingSkipping', `Indexing ${events.length} events${skippedNote} (${strategy})…`, { count: events.length, skipped, strategy })
            : tr('aiSearch.indexingEvents', `Indexing ${events.length} events (${strategy})…`, { count: events.length, strategy }) });
        log(`Starting index: ${events.length} events, strategy=${strategy}${skippedNote}`);
        try {
            await ensureClipLoaded();
            for (let i = 0; i < events.length; i++) {
                // Pause loop
                while (state.paused && !state.cancelled) {
                    emit('progress', { done: i, total: events.length, status: '⏸ ' + tr('aiSearch.paused', 'Paused'), paused: true });
                    await new Promise(r => setTimeout(r, 400));
                }
                if (state.cancelled) { log('Index cancelled by user', 'warn'); break; }

                const ev = events[i];
                if (state.indexed.has(ev.name) && !opts.reindex) {
                    state.indexProgress.done++;
                    emit('progress', _progressDetail(i, events.length, tr('aiSearch.skippedEvent', `Skipped: ${ev.name}`, { name: ev.name }), ev.name));
                    continue;
                }
                state.indexProgress.currentName = ev.name;
                emit('progress', _progressDetail(i, events.length, tr('aiSearch.indexingEvent', `Indexing ${ev.name}…`, { name: ev.name }), ev.name));
                log(`[${i+1}/${events.length}] ${ev.name} (${ev.clips?.length || 0} clips)`);
                const ac = new AbortController();
                const work = indexEvent(ev, strategy, ac.signal);
                try {
                    const record = await withTimeout(work, opts.eventTimeoutMs || PER_EVENT_TIMEOUT_MS, `indexEvent(${ev.name})`, ac);
                    state.indexed.set(ev.name, record);
                    log(`[${i+1}/${events.length}] ${ev.name} → ${record.frames.length} frames`);
                } catch (err) {
                    log(`[${i+1}/${events.length}] ${ev.name} FAILED: ${err.message}`, 'err');
                    // Timed out: let it stop (it checks between frames) before the next event starts, at most 5 s
                    if (ac.signal.aborted) await Promise.race([work.catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
                }
                state.indexProgress.done = i + 1;
                // Yield to main so the UI can paint progress + respond to input
                await yieldToMain();
            }
            if (!state.cancelled) {
                emit('progress', _progressDetail(events.length, events.length, tr('aiSearch.computingTags', 'Computing tags…'), ''));
                await computeEventTags();
                state.enabled = true;
                // Persist to IndexedDB so reloads don't force re-index
                emit('progress', _progressDetail(events.length, events.length, tr('aiSearch.savingIndex', 'Saving index…'), ''));
                await persistIndex();
                emit('status', { state: 'ready', message: tr('aiSearch.indexedSaved', `Indexed ${state.indexed.size} events (saved)`, { count: state.indexed.size }) });
                emit('ready');
            } else {
                // Still persist partial progress
                await persistIndex();
                emit('status', { state: 'cancelled', message: tr('aiSearch.cancelledAt', `Indexing cancelled at ${state.indexed.size} events (partial saved)`, { count: state.indexed.size }) });
            }
        } finally {
            state.indexing = false;
            state.paused = false;
        }
    }

    // Shape the progress event payload; includes ETA if we have enough signal
    // to compute it (at least 2 events done).
    function _progressDetail(done, total, status, currentName) {
        const elapsed = Date.now() - (state.indexProgress.startedAt || Date.now());
        let etaMs = null;
        if (done >= 2) {
            const avgMs = elapsed / done;
            etaMs = Math.max(0, avgMs * (total - done));
        }
        return { done, total, status, currentName, etaMs, paused: state.paused };
    }

    async function deepIndex(eventId) {
        const ev = (window.app?.eventBrowser?.events || []).find(e => e.name === eventId);
        if (!ev) throw new Error(`event not found: ${eventId}`);
        await ensureClipLoaded();
        emit('status', { state: 'indexing', message: tr('aiSearch.deepIndexing', `Deep-indexing ${eventId}…`, { name: eventId }) });
        state.indexed.delete(eventId);
        const record = await indexEvent(ev, 'motion');
        state.indexed.set(eventId, record);
        await computeEventTags();
        await persistIndex();
        emit('status', { state: 'ready', message: tr('aiSearch.deepIndexed', `Deep-indexed ${eventId} (saved)`, { name: eventId }) });
        emit('ready');
    }

    // ---- Query helpers ----------------------------------------------------
    function findCategoryFilterFromQuery(query) {
        const q = query.toLowerCase();
        const all = [];
        for (const cat of SCENE_CATEGORIES) for (const kw of (cat.keywords || [])) all.push({ kw, cat });
        all.sort((a, b) => b.kw.length - a.kw.length);
        for (const { kw, cat } of all) if (q.includes(kw)) return cat;
        return null;
    }

    async function search(query) {
        if (!state.enabled) throw new Error('AI search not enabled');
        const q = (query || '').trim();
        if (!q) return { query: q, confident: [], possible: [], hiddenCount: 0 };
        // Lazy-load CLIP text model. We can index and then restore from IDB
        // without loading CLIP, but searching needs the text encoder.
        await ensureClipLoaded();
        let tagFilter = findCategoryFilterFromQuery(q);
        let tagFallback = null;
        const te = await embedQueryEnsemble(q);
        await computeFrameBaselines();
        const BASELINE_ALPHA = 0.8;
        const eventById = new Map((window.app?.eventBrowser?.events || []).map(e => [e.name, e]));
        // Score ALL indexed events against the query, then let tag-match be a
        // ranking signal rather than a hard filter. Previously we pre-filtered
        // to tagged-only events, which excluded deep-indexed events whose per-
        // frame matches were strong but whose category score didn't quite hit
        // the tag threshold. Now tag-match just boosts the score a bit.
        const candidates = [];
        for (const [id, rec] of state.indexed) {
            const ev = eventById.get(id);
            if (ev && rec.frames.length > 0) candidates.push({ id, rec, ev });
        }
        const TAG_BOOST = 0.015;  // small bump, not enough to override strong direct match
        const effectiveAlpha = getEffectiveBaselineAlpha();
        const scored = candidates.map(({ id, rec, ev }) => {
            let bestScore = -Infinity, bestFrame = null, bestRaw = 0;
            for (const f of rec.frames) {
                const raw = cosine(te, f.embedding);
                const adj = raw - effectiveAlpha * (f.baseline ?? 0);
                if (adj > bestScore) { bestScore = adj; bestFrame = f; bestRaw = raw; }
            }
            const hasTagMatch = tagFilter && (rec.tags || []).some(t => t.key === tagFilter.key);
            const finalScore = hasTagMatch ? bestScore + TAG_BOOST : bestScore;
            return { eventId: id, event: ev, tags: rec.tags || [],
                     score: finalScore, rawScore: bestRaw, bestFrame,
                     hasTagMatch };
        }).sort((a, b) => b.score - a.score);

        // If a tag filter was detected but nothing scored above the possible
        // threshold, note it as a fallback so the UI can show context
        if (tagFilter && scored.filter(r => r.hasTagMatch).length === 0) {
            tagFallback = tagFilter.label;
            tagFilter = null;
        }

        const thresholds = getEffectiveThresholds();
        // Always use confidence tiers now that tag-filter is a boost, not a
        // pre-filter. Deep-indexed events with strong query matches always
        // show up regardless of whether their category tag was assigned.
        const confident = scored.filter(r => r.score >= thresholds.confident);
        const possible  = scored.filter(r => r.score >= thresholds.possible && r.score < thresholds.confident);
        const hiddenCount = scored.filter(r => r.score < thresholds.possible).length;

        // Diagnostic: top-5 adjusted scores + corresponding raw cosines so we
        // can tell q8-quantization compression apart from genuine-miss queries.
        // Includes the effective threshold/alpha so the log is self-explanatory
        // when comparing across dtypes (fp16 vs q8 vs fp32).
        if (scored.length > 0) {
            const top5 = scored.slice(0, 5).map(r => `${r.score.toFixed(3)}(raw ${r.rawScore.toFixed(3)})`);
            console.log(`[AISearch] "${q}" dtype=${state.dtype} top-5: ${top5.join(', ')} | thresholds c=${thresholds.confident.toFixed(3)} p=${thresholds.possible.toFixed(3)} α=${effectiveAlpha}`);
        }

        state.lastQuery = q;
        state.lastResults = { query: q, ranked: scored, confident, possible, hiddenCount, tagFilter, tagFallback };
        state.lastTagFilter = tagFilter;
        state.lastTagFallback = tagFallback;
        emit('results', state.lastResults);
        return state.lastResults;
    }

    function getTags() {
        const counts = {};
        for (const cat of SCENE_CATEGORIES) counts[cat.key] = 0;
        for (const rec of state.indexed.values()) for (const t of (rec.tags || [])) counts[t.key] = (counts[t.key] || 0) + 1;
        return SCENE_CATEGORIES.map(cat => ({ ...cat, count: counts[cat.key] || 0 }));
    }

    async function clearIndex() {
        state.indexed.clear();
        state.enabled = false;
        state.neutralEmbedding = null;
        state.categoryEmbeddings = null;
        // Drop the persisted copy for the current folder+model too
        try {
            const folderName = currentFolderName();
            if (folderName) {
                const prefix = `${folderName}:${state.currentModelKey}:`;
                const db = await idbOpen();
                const tx = db.transaction('events', 'readwrite');
                tx.objectStore('events').delete(IDBKeyRange.bound(prefix, prefix + '\uffff'));
            }
        } catch (e) { /* ignore */ }
        emit('status', { state: 'cleared', message: tr('aiSearch.cleared', 'Index cleared') });
    }

    function getStatus() {
        return {
            enabled: state.enabled,
            indexing: state.indexing,
            progress: state.indexProgress,
            eventCount: state.indexed.size,
            frameCount: Array.from(state.indexed.values()).reduce((a, r) => a + r.frames.length, 0),
            model: state.currentModelKey,
            strategy: state.strategy,
            webCodecs: !!(window.FastClipDecoder && window.FastClipDecoder.WEBCODECS_AVAILABLE)
        };
    }

    window.aiSearch = {
        state,
        enable: (opts) => indexAll({ ...opts, reindex: false }),
        indexAll,
        deepIndex,
        search,
        getTags,
        clearIndex,
        getStatus,
        pause:   () => { state.paused = true; },
        resume:  () => { state.paused = false; },
        cancel:  () => { state.cancelled = true; state.paused = false; },
        restoreIndex,
        persistIndex,
        SCENE_CATEGORIES,
        CLIP_MODELS
    };
})();
