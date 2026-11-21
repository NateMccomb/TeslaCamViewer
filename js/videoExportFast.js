/**
 * VideoExportFast - Experimental faster-than-realtime video export
 * using WebCodecs VideoEncoder + mp4-muxer.
 *
 * Drop-in replacement for the MediaRecorder Phase-2 pass in videoExport.js.
 * Receives a pre-rendered frame buffer (ImageBitmap / HTMLCanvasElement) and
 * encodes directly to MP4 without going through a MediaStream, which
 * typically runs 5–10× faster than realtime since it's not bound to
 * wall-clock playback timing.
 *
 * Opt-in via Settings > Export > "Fast Export (Experimental)". Falls back
 * to the standard MediaRecorder path on any failure. tcv.0x465845
 *
 * WebM (codecPreference 'webm'): VP9 / VP8 / AV1 into webm-muxer, streamed
 * into an ExportFileSink (bounded memory) instead of one ArrayBuffer.
 */
class VideoExportFast {
    /**
     * Is the WebCodecs stack present and usable?
     * @returns {boolean}
     */
    static isSupported() {
        return typeof VideoEncoder !== 'undefined'
            && typeof VideoFrame !== 'undefined'
            && typeof VideoDecoder !== 'undefined';
    }

    /** localStorage switch for the export debug log (off by default): localStorage.setItem('tcv.exportDebug', '1') */
    static DEBUG_KEY = 'tcv.exportDebug';
    static _dbg = false;

    /**
     * Start of an export: read the debug switch once (so the log costs nothing when it is off) and say once per
     * export that it is on and how to turn it off.
     */
    static debugStart(what) {
        let on = false;
        try { on = localStorage.getItem(VideoExportFast.DEBUG_KEY) === '1'; } catch {}
        VideoExportFast._dbg = on;
        if (on) {
            console.log(`[ExportDebug] Export debug log is on (localStorage '${VideoExportFast.DEBUG_KEY}' = '1'; turn it off with ` +
                `localStorage.removeItem('${VideoExportFast.DEBUG_KEY}')). Times are performance.now() in ms.`);
            VideoExportFast.dbg('export start', what || '');
        }
        return on;
    }

    /** One debug line (only while the switch is on): [ExportDebug +<performance.now()>ms] ... */
    static dbg(...a) {
        if (!VideoExportFast._dbg) return;
        console.log(`[ExportDebug +${Math.round(performance.now())}ms]`, ...a.map(x => (x && typeof x === 'object') ? JSON.stringify(x) : x));
    }

    /**
     * Probe whether a codec is encodable here (isConfigSupported only; the
     * real proof is the probe encode in _pickCodec).
     * @param {string} codec
     * @param {number} width
     * @param {number} height
     * @param {string} [hardwareAcceleration]
     * @returns {Promise<boolean>}
     */
    static async isCodecSupported(codec, width, height, hardwareAcceleration) {
        if (!VideoExportFast.isSupported()) return false;
        try {
            const cfg = { codec, width, height, bitrate: 20_000_000, framerate: 30 };
            if (hardwareAcceleration) cfg.hardwareAcceleration = hardwareAcceleration;
            const res = await VideoExportFast.withTimeout(VideoEncoder.isConfigSupported(cfg),
                VideoExportFast.TIMEOUTS.configSupportedMs, 'isConfigSupported');
            return !!(res && res.supported);
        } catch {
            return false;
        }
    }

    /**
     * The lowest H.264 level whose limits fit this frame size and rate
     * (ITU-T H.264 Table A-1: macroblocks per frame and per second, and the
     * 8*sqrt(MaxFS) cap on either side). null when nothing fits.
     * @returns {{level: number, hex: string, name: string}|null}
     */
    static h264Level(width, height, fps = 30) {
        const mbW = Math.ceil((width || 0) / 16), mbH = Math.ceil((height || 0) / 16);
        const fs = mbW * mbH, mbps = fs * (fps || 30);
        if (!fs) return null;
        // [level_idc, MaxFS, MaxMBPS]
        const table = [[30, 1620, 40500], [31, 3600, 108000], [32, 5120, 216000], [40, 8192, 245760],
            [42, 8704, 522240], [50, 22080, 589824], [51, 36864, 983040], [52, 36864, 2073600],
            [60, 139264, 4177920], [61, 139264, 8355840], [62, 139264, 16711680]];
        for (const [lv, maxFs, maxMbps] of table) {
            const side = Math.sqrt(maxFs * 8);
            if (fs <= maxFs && mbps <= maxMbps && mbW <= side && mbH <= side) {
                return { level: lv, hex: lv.toString(16).toUpperCase().padStart(2, '0'), name: (lv / 10).toFixed(1) };
            }
        }
        return null;
    }

    /**
     * The lowest VP9 level whose picture size, side length and sample rate fit
     * (VP9 bitstream spec Annex A). The codec string used to say level 1.0
     * for every size (36,864 samples: not even 256x144), which an encoder that
     * checks levels refuses for a 6-camera export (3840x1920).
     * @returns {string|null} two digits for vp09.00.LL.08
     */
    static vp9Level(width, height, fps = 30) {
        const pic = (width || 0) * (height || 0), side = Math.max(width || 0, height || 0), rate = pic * (fps || 30);
        if (!pic) return null;
        // [level, max picture size, max sample rate, max width or height]
        const table = [[10, 36864, 829440, 512], [11, 73728, 2764800, 768], [20, 122880, 4608000, 960],
            [21, 245760, 9216000, 1344], [30, 552960, 20736000, 2048], [31, 983040, 36864000, 2752],
            [40, 2228224, 83558400, 4160], [41, 2228224, 160432128, 4160], [50, 8912896, 311951360, 8384],
            [51, 8912896, 588251136, 8384], [52, 8912896, 1176502272, 8384], [60, 35651584, 1176502272, 16832],
            [61, 35651584, 2353004544, 16832], [62, 35651584, 4706009088, 16832]];
        for (const [lv, maxPic, maxRate, maxSide] of table) {
            if (pic <= maxPic && rate <= maxRate && side <= maxSide) return String(lv);
        }
        return null;
    }

    /**
     * The lowest AV1 level (seq_level_idx) that fits (AV1 spec Annex A.3).
     * Was 3.0 (04) for every size: 665,856 samples, a tenth of a 6-camera export.
     * @returns {string|null} two digits for av01.0.LLM.08
     */
    static av1Level(width, height, fps = 30) {
        const pic = (width || 0) * (height || 0), rate = pic * (fps || 30);
        if (!pic) return null;
        // [seq_level_idx, MaxPicSize, MaxHSize, MaxVSize, MaxDisplayRate]
        const table = [[0, 147456, 2048, 1152, 4423680], [1, 278784, 2816, 1584, 8363520],
            [4, 665856, 4352, 2448, 19975680], [5, 1065024, 5504, 3096, 31950720],
            [8, 2359296, 6144, 3456, 70778880], [9, 2359296, 6144, 3456, 141557760],
            [12, 8912896, 8192, 4352, 267386880], [13, 8912896, 8192, 4352, 534773760],
            [14, 8912896, 8192, 4352, 1069547520], [16, 35651584, 16384, 8704, 1069547520]];
        for (const [idx, maxPic, maxW, maxH, maxRate] of table) {
            if (pic <= maxPic && width <= maxW && height <= maxH && rate <= maxRate) return String(idx).padStart(2, '0');
        }
        return null;
    }

    /**
     * Encoder candidates in the order to try them. Every entry carries a
     * level that fits the size (a level that is too low is refused, or worse,
     * accepted and then stalls on some hardware encoders); a codec with no
     * level that fits is left out.
     *  'quality' (MP4 (VP9)): VP9 (browser's choice, then forced to the
     *            software encoder); H.264 and AV1 only as fallbacks.
     *  'compat'  (MP4 (H.264)): H.264 High, Main, Baseline (browser's choice of
     *            encoder, usually the GPU), then H.264 High and Main forced to
     *            the software encoder (a GPU encoder that hangs or errors must
     *            not end H.264), then VP9 and AV1 only if this device can't
     *            encode H.264 at all.
     *  'webm'    (WebM): VP9, VP9 forced to software, VP8, AV1, each marked container 'webm'.
     * @param {'quality'|'compat'|'webm'} preference
     * @param {number} width
     * @param {number} height
     * @param {number} [fps=30]
     * @returns {Array<{codec: string, name: string, muxName: string, hw: string}>}
     */
    static codecCandidates(preference, width, height, fps = 30) {
        const v9 = VideoExportFast.vp9Level(width, height, fps);
        const a1 = VideoExportFast.av1Level(width, height, fps);
        const vp9 = v9 && { codec: `vp09.00.${v9}.08`, name: 'vp9', muxName: 'VP9', hw: 'no-preference' };
        // libvpx in the browser itself: a graphics-card VP9 encoder that hangs must not end MP4 (VP9)
        const vp9sw = v9 && { codec: `vp09.00.${v9}.08`, name: 'vp9', muxName: 'VP9 (software)', hw: 'prefer-software' };
        const av1 = a1 && { codec: `av01.0.${a1}M.08`, name: 'av1', muxName: 'AV1', hw: 'no-preference' };
        // H.264 needs even dimensions; odd ones would be refused by every encoder
        const evenOk = (width % 2 === 0) && (height % 2 === 0);
        const lv = evenOk ? VideoExportFast.h264Level(width, height, fps) : null;
        const avc = (profileHex, profile, hw) => lv && ({
            codec: `avc1.${profileHex}${lv.hex}`, name: 'avc',
            muxName: `H.264 ${profile} L${lv.name}${hw === 'prefer-software' ? ' (software)' : ''}`, hw
        });
        const high = (hw) => avc('6400', 'High', hw);
        const main = (hw) => avc('4D40', 'Main', hw);
        const base = (hw) => avc('42E0', 'Baseline', hw);
        if (preference === 'webm') {
            // WebM: VP9 (browser's choice: the graphics card's encoder where there is one), then VP8 in software,
            // then VP9 in software, then AV1. H.264 can't go into WebM. container: 'webm' makes _openEncoder use
            // webm-muxer. VP8 comes before software VP9 because it is 2-3x faster in software at the same size
            // (Chrome 157 on Windows, 2 cores: 3840x1920 VP8 4.3-6.1 vs VP9 2.1-2.6 frames per second; 1920x960
            // 21-23 vs 8.5), and the software encoder is what a WebM gets when the graphics card's VP9 fails.
            const vp8sw = { codec: 'vp8', name: 'vp8', muxName: 'VP8 (software)', hw: 'prefer-software' };
            return [vp9, vp8sw, vp9sw, av1].filter(Boolean).map(c => ({ ...c, container: 'webm' }));
        }
        const list = preference === 'compat'
            ? [high('no-preference'), main('no-preference'), base('no-preference'),
                high('prefer-software'), main('prefer-software'), vp9, vp9sw, av1]
            : [vp9, vp9sw, high('no-preference'), main('no-preference'), base('no-preference'), av1];
        return list.filter(Boolean);
    }

    /** webm-muxer's codec ids */
    static WEBM_CODEC_IDS = { vp9: 'V_VP9', vp8: 'V_VP8', av1: 'V_AV1' };

    /** The largest export: 4K worth of pixels, no side over 4096 (graphics-card encoders, H.264 level 5.1/5.2 and
     *  most players). A 6-camera layout of a car with a 2896-wide front camera asked for 8688 x 4344 (#570). */
    static MAX_EXPORT_PIXELS = 3840 * 2160;
    static MAX_EXPORT_SIDE = 4096;

    /**
     * Export sizes to try, largest first: the asked size (sides made even) if it is within MAX_EXPORT_PIXELS /
     * MAX_EXPORT_SIDE, else the same picture scaled to fit them; then the same picture (same aspect, even sides)
     * at 1440p, 1080p and 720p worth of pixels. Only sizes smaller than the one before are listed.
     * @returns {Array<{width: number, height: number}>}
     */
    static sizeLadder(width, height) {
        const out = [];
        const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
        const add = (w, h) => {
            const last = out[out.length - 1];
            if (!last || (w * h < last.width * last.height)) out.push({ width: w, height: h });
        };
        const caps = [[VideoExportFast.MAX_EXPORT_PIXELS, VideoExportFast.MAX_EXPORT_SIDE], [2560 * 1440, 2560],
            [1920 * 1080, 1920], [1280 * 720, 1280]];
        const [maxPix, maxSide] = caps[0];
        if (width * height <= maxPix && Math.max(width, height) <= maxSide) add(even(width), even(height));
        for (const [area, side] of caps) {
            const s = Math.min(1, Math.sqrt(area / (width * height)), side / Math.max(width, height));
            if (s < 1) add(even(width * s), even(height * s));
        }
        return out;
    }

    /** The size a WebM (the browser's MediaRecorder, which can't be test-encoded first) is recorded at: the asked
     *  size within MAX_EXPORT_PIXELS / MAX_EXPORT_SIDE. At 8688 x 4344 the recorder saved 0 bytes (#570). */
    static recorderSize(width, height) {
        return VideoExportFast.sizeLadder(width, height)[0];
    }

    /** Probe limits for one size (_pickCodec) when no prepare() ran: the same budget and timeout caps. */
    static probeLimits() {
        const T = VideoExportFast.TIMEOUTS;
        return { deadline: performance.now() + T.probeBudgetMs, maxTimeouts: T.probeTimeoutsPerSize, maxCodecTimeouts: T.probeTimeoutsPerCodec };
    }

    /** Default bitrate for a frame size: ~12 Mbps per megapixel @30 fps, 30-80 Mbps (as before). */
    static bitrateFor(width, height) {
        const megapixels = (width * height) / 1_000_000;
        return Math.max(30_000_000, Math.min(80_000_000, Math.round(megapixels * 12_000_000)));
    }

    /** Time limits (ms) that keep a silent encoder from hanging an export. */
    static TIMEOUTS = {
        configSupportedMs: 8000,   // isConfigSupported (normally < 0.5 s)
        probeMs: 20000,            // configure + encode 1 frame + flush (a 4K software probe on a slow PC: ~7 s)
        // After one probe has timed out, the next ones at the same size get this long: encoders that don't
        // answer one test frame at this size usually don't answer any (a 6-camera export on a Windows laptop,
        // 2026-11-19: every encoder timed out at 3840x1920, 7 x 20 s before the export gave up)
        probeAfterTimeoutMs: 6000,
        probeTimeoutsPerSize: 3,   // this many timeouts at one size: try the next smaller size
        probeTimeoutsPerCodec: 2,  // this many for one codec (H.264, VP9, AV1) at one size: skip its other entries
        probeBudgetMs: 60000,      // all probes together; then the export stops with a clear message
        stallMs: 30000,            // before the first output: no output for this long while frames are waiting = stalled
        // Once the encoder has produced output it has shown it works, so going silent is caught sooner: no output
        // for this long (or 4x the longest gap between outputs seen so far, if that is longer, up to stallMs) while
        // frames are waiting = stalled. A slow but working encoder keeps producing, so it is never cut off.
        stallAfterOutputMs: 8000,
        // The browser's software encoders (libvpx, OpenH264) don't hang: when one is silent it is slow (a 4K frame
        // on a laptop with a busy GPU took 3-20 s, 2026-11-20/21). So they get far longer before they count as
        // stalled: before the first output, and then this long (or 8x the longest gap seen, up to softwareStallMs)
        softwareStallMs: 180000,
        softwareStallAfterOutputMs: 60000
    };

    /** WebM: a software encoder slower than this (frames per second) at a size makes the export try the next
     *  smaller size, and the finish screen says the size was reduced. */
    static WEBM_MIN_SOFTWARE_FPS = 2;
    /** Speed probe: at most this many timed frames, and this long in all, after the probe's first frame */
    static SPEED_PROBE = { maxFrames: 6, maxMs: 9000 };

    /**
     * Encode frames 1, 2, ... one at a time (encode + flush each) and return each one's time in ms; stops once the last
     * 2 are both fast enough (WEBM_MIN_SOFTWARE_FPS) after at least 3, or at SPEED_PROBE limits. A timeout ends it too.
     */
    static async _timeFrames(enc, makeFrame, limitMs, what) {
        const P = VideoExportFast.SPEED_PROBE;
        const fastMs = 1000 / VideoExportFast.WEBM_MIN_SOFTWARE_FPS;
        const t0 = performance.now();
        const dts = [];
        for (let i = 1; i <= P.maxFrames; i++) {
            const s0 = performance.now();
            const f = makeFrame(i * 33333);
            try { enc.encode(f, { keyFrame: false }); } finally { f.close(); }
            try {
                await VideoExportFast.withTimeout(enc.flush(), Math.max(200, limitMs), `speed probe (${what})`);
            } catch {
                dts.push(Infinity);
                break;
            }
            dts.push(performance.now() - s0);
            const last2 = dts.slice(-2);
            if (dts.length >= 3 && last2.every(d => d < fastMs)) break;
            if (performance.now() - t0 > P.maxMs) break;
        }
        VideoExportFast.dbg('speed probe frames (ms)', { what, ms: dts.map(d => Math.round(d)) });
        return dts;
    }

    /** Frames per second from the last 2 timed frames (the first ones may carry the encoder's start-up) */
    static steadyFps(dts) {
        const last2 = (dts || []).slice(-2);
        if (!last2.length) return null;
        const avg = last2.reduce((a, b) => a + b, 0) / last2.length;
        return Number.isFinite(avg) ? 1000 / Math.max(1, avg) : 0;
    }

    /** Is this candidate the browser's own software encoder? (prefer-software; a 'no-preference' one may be too,
     *  but only the browser knows) */
    static isSoftware(c) {
        return !!c && c.hw === 'prefer-software';
    }

    /** localStorage key: the browser's-choice (usually GPU) H.264 encoder stalled or failed on this device. */
    static HW_H264_KEY = 'tcv.h264HardwareEncoder';
    /** The same for VP9 (WebM and MP4 (VP9)): on a test laptop the graphics card's VP9 encoder stopped answering
     *  after 59 frames, and every WebM export paid that stall (8 s), a software probe and a restart (2026.47.5.1). */
    static HW_VP9_KEY = 'tcv.vp9HardwareEncoder';
    /** Codec families whose browser's-choice encoder is remembered when it fails, and the name said for each. */
    static HW_FAMILIES = { avc: { key: 'tcv.h264HardwareEncoder', label: 'H.264', instead: 'MP4 (H.264) exports will use the software H.264 encoder' },
                           vp9: { key: 'tcv.vp9HardwareEncoder', label: 'VP9',
                                  instead: 'WebM exports will use the software VP8 encoder and MP4 (VP9) exports the software VP9 encoder' } };
    /** Forget a remembered failure after this long, so a driver update gets another chance. */
    static HW_H264_FORGET_DAYS = 60;

    /**
     * This browser + graphics card, for remembering a bad hardware H.264 encoder per device.
     * @returns {{browser: string, gpu: string}}
     */
    static deviceInfo() {
        if (VideoExportFast._deviceInfo) return VideoExportFast._deviceInfo;
        let browser = 'unknown';
        try {
            const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
            const m = ua.match(/(Edg|OPR|Firefox|Chrome|Version)\/(\d+)/g) || [];
            // Edge and Opera also say Chrome: the most specific brand wins
            const pick = m.find(x => /^(Edg|OPR)\//.test(x)) || m.find(x => /^Firefox\//.test(x)) || m.find(x => /^Chrome\//.test(x)) || m[0];
            if (pick) browser = pick.replace('Edg/', 'Edge ').replace('OPR/', 'Opera ').replace('/', ' ');
        } catch {}
        let gpu = 'unknown';
        try {
            const c = document.createElement('canvas');
            const gl = c.getContext && (c.getContext('webgl') || c.getContext('experimental-webgl'));
            if (gl) {
                const ext = gl.getExtension('WEBGL_debug_renderer_info');
                gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || 'unknown').slice(0, 200);
                const lose = gl.getExtension('WEBGL_lose_context');
                if (lose) lose.loseContext();
            }
        } catch {}
        VideoExportFast._deviceInfo = { browser, gpu };
        return VideoExportFast._deviceInfo;
    }

    /**
     * The remembered hardware H.264 failure on this device, or null. A record from another browser version or
     * graphics card (a browser or driver update), or an old one, doesn't count: the hardware encoder gets
     * tried again.
     * @returns {{browser: string, gpu: string, date: string, codec: string, reason: string}|null}
     */
    static hwH264Failure() {
        return VideoExportFast.hwFailure('avc');
    }

    /**
     * The remembered failure of the browser's-choice encoder for a codec family ('avc' or 'vp9') on this device,
     * or null (see hwH264Failure: another browser version or graphics card, or an old record, doesn't count).
     */
    static hwFailure(name) {
        const fam = VideoExportFast.HW_FAMILIES[name];
        if (!fam) return null;
        let rec = null;
        try { rec = JSON.parse(localStorage.getItem(fam.key) || 'null'); } catch { rec = null; }
        if (!rec || typeof rec !== 'object') return null;
        const dev = VideoExportFast.deviceInfo();
        const ageDays = (Date.now() - Date.parse(rec.date || '')) / 86400000;
        if (rec.browser !== dev.browser || rec.gpu !== dev.gpu || !(ageDays >= 0 && ageDays < VideoExportFast.HW_H264_FORGET_DAYS)) {
            console.log(`[VideoExportFast] The graphics card's ${fam.label} encoder failed here before (${rec.date}, ${rec.browser}), ` +
                `but the browser, graphics card or date changed (now ${dev.browser}): trying it again`);
            VideoExportFast.forgetHwFailure(name);
            return null;
        }
        return rec;
    }

    /** Remember that the browser's-choice H.264 encoder stalled or failed here (next time: straight to software). */
    static rememberHwH264Failure(cand, reason) {
        if (!cand || cand.name !== 'avc') return;
        VideoExportFast.rememberHwFailure(cand, reason);
    }

    /** Remember that the browser's-choice H.264 or VP9 encoder stalled or failed here (next time: straight to the
     *  software encoder of the same codec). Software encoders and other codecs (AV1) are never remembered. */
    static rememberHwFailure(cand, reason) {
        const fam = cand && VideoExportFast.HW_FAMILIES[cand.name];
        if (!fam || cand.hw === 'prefer-software') return;
        const dev = VideoExportFast.deviceInfo();
        const rec = { browser: dev.browser, gpu: dev.gpu, date: new Date().toISOString(), codec: cand.codec, reason: String(reason || '').slice(0, 200) };
        try { localStorage.setItem(fam.key, JSON.stringify(rec)); } catch {}
        console.warn(`[VideoExportFast] Remembering for this device: the graphics card's ${fam.label} encoder ${reason} ` +
            `(${dev.browser}, ${dev.gpu}). ${fam.instead} until the browser or graphics card changes.`);
    }

    static forgetHwH264Failure() {
        VideoExportFast.forgetHwFailure('avc');
    }

    static forgetHwFailure(name) {
        const fam = VideoExportFast.HW_FAMILIES[name];
        try { if (fam) localStorage.removeItem(fam.key); } catch {}
    }

    /** "codec|hw" keys of the browser's-choice H.264 candidates (the ones a remembered failure skips). */
    static hwH264Keys(width, height, fps) {
        return VideoExportFast.codecCandidates('compat', width, height, fps)
            .filter(x => x.name === 'avc' && x.hw !== 'prefer-software')
            .map(x => `${x.codec}|${x.hw}`);
    }

    /**
     * Settle with the promise, or reject after ms with err.code 'TIMEOUT'.
     * @template T
     * @param {Promise<T>} promise
     * @param {number} ms
     * @param {string} what
     * @returns {Promise<T>}
     */
    static withTimeout(promise, ms, what) {
        let timer;
        const t = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const e = new Error(`${what} did not finish within ${Math.round(ms / 1000)} s`);
                e.code = 'TIMEOUT';
                reject(e);
            }, ms);
        });
        return Promise.race([promise, t]).finally(() => clearTimeout(timer));
    }

    /**
     * An Error for an encoder that stopped answering; app.js shows
     * export.encoderStalled for it.
     */
    static stalledError(picked, framesEncoded, framesSubmitted, stage, limitMs = VideoExportFast.TIMEOUTS.stallMs, queued = null) {
        // queued: frames the browser still held in its own queue (encodeQueueSize). Frames waiting there mean the
        // encoder stopped taking them: it was stuck, not waiting for more input from us.
        const e = new Error(`Video encoder stopped responding (${picked?.muxName || 'unknown codec'}, ${stage}): ` +
            `${framesEncoded}/${framesSubmitted} frames encoded, no output for ${Math.round(limitMs / 1000)} s` +
            (Number.isFinite(queued) ? ` (${queued} still in the browser's queue)` : ''));
        e.code = 'ENCODER_STALLED';
        e.codec = picked || null;
        return e;
    }

    constructor() {
        this._muxerModule = null;
        this.pickedCodec = null;   // {codec, name, muxName, hw} of the last encode
        this.skippedCodecs = [];   // [{codec, hw, reason}] candidates that failed or hung on this device
    }

    /** Encoder config for a candidate (the probe uses the very same one). */
    static encoderConfig(cand, width, height, fps, bitrate) {
        const cfg = { codec: cand.codec, width, height, bitrate, framerate: fps, latencyMode: 'quality' };
        // Test switch for support sessions (no UI): localStorage 'tcv.h264Realtime' = '1' asks the browser's-choice
        // (GPU) H.264 encoder for low-latency mode, which turns off look-ahead and B-frames on hardware encoders.
        // A hardware encoder that waits for more frames than the browser hands it at once would never answer
        // otherwise; this checks that on a real PC. Off by default: realtime mode may also drop frames.
        if (cand.name === 'avc' && cand.hw !== 'prefer-software') {
            try { if (localStorage.getItem('tcv.h264Realtime') === '1') cfg.latencyMode = 'realtime'; } catch {}
        }
        // The same test switch for the graphics card's VP9 encoder (localStorage 'tcv.vp9Realtime' = '1'): the
        // browser's recorder, which recorded WebM on a test laptop at ~17 frames per second, drives that encoder in
        // low-latency mode; WebCodecs in 'quality' mode stalled after 59 frames there (2026-11-20). Off by default.
        if (cand.name === 'vp9' && cand.hw !== 'prefer-software') {
            try { if (localStorage.getItem('tcv.vp9Realtime') === '1') cfg.latencyMode = 'realtime'; } catch {}
        }
        if (cand.hw && cand.hw !== 'no-preference') cfg.hardwareAcceleration = cand.hw;
        if (cand.name === 'avc') cfg.avc = { format: 'avc' };   // mp4-muxer needs avcC, not Annex B
        return cfg;
    }

    /**
     * Pick the first candidate that really encodes here: isConfigSupported,
     * then a probe that encodes ONE frame with the real config and flushes.
     * Every step is time-limited, so a hardware encoder that never answers
     * costs at most TIMEOUTS.probeMs and the next candidate is tried. After a
     * browser-choice H.264 encoder hangs or fails, the other browser-choice
     * H.264 entries are skipped (they'd get the same GPU encoder) and the
     * software ones are tried.
     * @param {Array} candidates  from codecCandidates
     * @param {Function} makeFrame  (timestamp) => VideoFrame
     * @param {Array<string>} [avoid]  "codec|hw" keys to skip (a previous run stalled on them)
     */
    async _pickCodec(candidates, width, height, fps, bitrate, makeFrame, avoid = [], limits = {}) {
        const T = VideoExportFast.TIMEOUTS;
        // limits.deadline: performance.now() by which probing must end (the whole export's probe budget);
        // limits.maxTimeouts: give up on this size after this many probe timeouts (limits.timeouts counts them),
        // limits.maxCodecTimeouts: skip a codec's other entries after this many of its own;
        // limits.shortProbes: an earlier size already had a timeout, so every probe gets the short limit
        const deadline = limits.deadline || Infinity;
        limits.timeouts = 0;
        const codecTimeouts = {};
        limits.budgetOut = false;
        // gpuBad.avc / gpuBad.vp9: that codec's browser's-choice (graphics card) encoder failed here, so its other
        // browser's-choice entries are skipped (they'd get the same encoder) and the software ones are tried
        const gpuBad = {};
        const isGpu = (c) => !!VideoExportFast.HW_FAMILIES[c.name] && c.hw !== 'prefer-software';
        // The graphics card's H.264 or VP9 encoder already stalled or failed on this device: don't spend another
        // probe and stall timeout on it, go straight to the next encoder in this export's list (WebM: VP8 software)
        // the next candidate this export's list has after that codec's graphics-card ones, by name
        const insteadOf = (name) => {
            const next = candidates.find(c => !(c.name === name && isGpu(c)) && (c.hw === 'prefer-software' || c.name !== name));
            return next ? `the ${next.muxName.replace(/ L[\d.]+/, '')} encoder` : 'a software encoder';
        };
        for (const name of Object.keys(VideoExportFast.HW_FAMILIES)) {
            const known = candidates.some(c => c.name === name && isGpu(c)) ? VideoExportFast.hwFailure(name) : null;
            if (!known) continue;
            gpuBad[name] = true;
            if (name === 'avc') this.hwH264Remembered = known;
            (this.hwRemembered = this.hwRemembered || {})[name] = known;
            const label = VideoExportFast.HW_FAMILIES[name].label;
            console.log(`[VideoExportFast] Skipping the graphics card's ${label} encoder: it ${known.reason || 'failed'} on this device ` +
                `on ${String(known.date).slice(0, 10)} (${known.browser}). Using ${insteadOf(name)} instead. ` +
                `It is tried again after a browser or graphics driver update.`);
        }
        for (const cand of candidates) {
            const key = `${cand.codec}|${cand.hw}`;
            if (avoid.includes(key) || (gpuBad[cand.name] && isGpu(cand))) {
                this.skippedCodecs.push({ codec: cand.codec, hw: cand.hw, reason: 'skipped' });
                continue;
            }
            if ((limits.maxTimeouts && limits.timeouts >= limits.maxTimeouts)
                || (limits.maxCodecTimeouts && (codecTimeouts[cand.name] || 0) >= limits.maxCodecTimeouts)) {
                this.skippedCodecs.push({ codec: cand.codec, hw: cand.hw, reason: 'skipped (encoders not answering at this size)' });
                continue;
            }
            const left = deadline - performance.now();
            if (left < 500) {
                limits.budgetOut = true;
                this.skippedCodecs.push({ codec: cand.codec, hw: cand.hw, reason: 'skipped (time limit)' });
                continue;
            }
            const cfg = VideoExportFast.encoderConfig(cand, width, height, fps, bitrate);
            let supported = false;
            try {
                const res = await VideoExportFast.withTimeout(VideoEncoder.isConfigSupported(cfg), Math.min(T.configSupportedMs, left), 'isConfigSupported');
                supported = !!(res && res.supported);
            } catch (e) {
                console.warn(`[VideoExportFast] isConfigSupported(${cand.codec}, ${cand.hw}) failed: ${e?.message || e}`);
            }
            if (!supported) {
                this.skippedCodecs.push({ codec: cand.codec, hw: cand.hw, reason: 'unsupported' });
                continue;
            }
            const probeErrors = [];
            let outputs = 0;
            let probeEnc = null;
            const t0 = performance.now();
            cand.probeFps = null;
            try {
                probeEnc = new VideoEncoder({
                    output: () => { outputs++; },
                    error: (e) => { probeErrors.push(e); }
                });
                probeEnc.configure(cfg);
                VideoExportFast.dbg('probe start', { codec: cand.codec, muxName: cand.muxName, width, height, hw: cand.hw, latencyMode: cfg.latencyMode, bitrate });
                const vf = makeFrame(0);
                try { probeEnc.encode(vf, { keyFrame: true }); } finally { vf.close(); }
                // (a one-frame probe that doesn't answer in time moves the export to the next smaller size: the
                // 2026-11-19 laptop answered nothing at 3840x1920; a software encoder that slow is too slow there)
                const full = T.probeMs;
                const probeLimit = Math.max(Math.min(500, T.probeAfterTimeoutMs), Math.min((limits.timeouts || limits.shortProbes) ? T.probeAfterTimeoutMs : full,
                    deadline - performance.now()));
                await VideoExportFast.withTimeout(probeEnc.flush(), probeLimit, `probe encode (${cand.muxName})`);
                // limits.measureSpeed (WebM): the encoder's steady speed at this size, so prepare() can choose a smaller
                // size when it is too slow here. Only for the browser's software encoders: a graphics-card one is
                // fast, and the extra frames would only add to every export's start. The first frames of a page's
                // first encoder carry a one-time start-up (a test laptop, 2026-11-21: 0.5 frames per second at
                // 3840x1920 on the first WebM of the page, 24 on the next ones), so frames are timed one by one and
                // the speed is that of the last 2, once 2 in a row are fast enough or SPEED_PROBE limits are reached.
                if (limits.measureSpeed && VideoExportFast.isSoftware(cand) && !probeErrors.length && outputs > 0) {
                    cand.probeFps = VideoExportFast.steadyFps(await VideoExportFast._timeFrames(probeEnc, makeFrame,
                        Math.min(full, Math.max(500, deadline - performance.now())), cand.muxName));
                }
            } catch (e) {
                if (!probeErrors.length) probeErrors.push(e);
            } finally {
                try { probeEnc && probeEnc.state !== 'closed' && probeEnc.close(); } catch {}
            }
            const ms = Math.round(performance.now() - t0);
            VideoExportFast.dbg('probe end', { codec: cand.codec, hw: cand.hw, width, height, ms, outputs, errors: probeErrors.length, probeFps: cand.probeFps });
            if (probeErrors.length === 0 && outputs > 0) {
                console.log(`[VideoExportFast] Probe ${cand.muxName} (${cand.codec}, ${cand.hw}) ok in ${ms} ms` +
                    (cand.probeFps != null ? `, ${cand.probeFps.toFixed(1)} frames per second at ${width}x${height}` : ''));
                return cand;
            }
            const err = probeErrors[0];
            const reason = err?.code === 'TIMEOUT' ? 'timeout' : (outputs === 0 && !err ? 'no output' : `${err?.name || 'Error'}: ${err?.message || err}`);
            this.skippedCodecs.push({ codec: cand.codec, hw: cand.hw, reason, width, height });
            if (reason === 'timeout') {
                limits.timeouts++;
                codecTimeouts[cand.name] = (codecTimeouts[cand.name] || 0) + 1;
            }
            console.warn(`[VideoExportFast] Codec ${cand.codec} (${cand.hw}) failed its probe at ${width}x${height} after ${ms} ms: ${reason}; trying the next candidate`);
            if (isGpu(cand)) {
                gpuBad[cand.name] = true;
                VideoExportFast.rememberHwFailure(cand, reason === 'timeout' ? `did not answer its test frame within ${Math.round(ms / 1000)} s` : `failed its test frame (${reason})`);
            }
        }
        return null;
    }

    /** A small canvas of soft random noise (seeded, the same every time) for speed probes. */
    static _probeTexture() {
        if (VideoExportFast._tex) return VideoExportFast._tex;
        const t = document.createElement('canvas');
        t.width = 160; t.height = 80;
        const tc = t.getContext('2d');
        if (tc && tc.createImageData && tc.putImageData) {
            const img = tc.createImageData(160, 80);
            let seed = 1234;
            for (let p = 0; p < img.data.length; p += 4) {
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                const v = seed % 256;
                img.data[p] = v; img.data[p + 1] = (v * 3) % 256; img.data[p + 2] = (v * 7) % 256; img.data[p + 3] = 255;
            }
            tc.putImageData(img, 0, 0);
        }
        VideoExportFast._tex = t;
        return t;
    }

    /**
     * Find the export size and encoder before anything is rendered. For each
     * size of sizeLadder (the asked size first): the codecs with a level that
     * fits, then isConfigSupported with that real width and height, then a
     * one-frame probe encode at that size (_pickCodec). A size whose encoders
     * all refuse it, or that stop answering (TIMEOUTS.probeTimeoutsPerSize
     * timeouts), gives way to the next smaller size. All probes together get
     * TIMEOUTS.probeBudgetMs; then it throws err.code 'NO_ENCODER' (app.js says
     * what to do), instead of trying every codec for 20 s each.
     * @param {Object} o
     * @param {number} o.width   the asked export size
     * @param {number} o.height
     * @param {number} o.fps
     * @param {'quality'|'compat'} [o.codecPreference='quality']
     * @param {Array<string>} [o.avoid]  "codec|hw" keys not to use
     * @returns {Promise<{width: number, height: number, picked: Object, reduced: boolean, reason: string|null}>}
     */
    async prepare({ width, height, fps, codecPreference = 'quality', avoid = [] }) {
        if (!VideoExportFast.isSupported()) throw new Error('WebCodecs not supported in this browser');
        // WebM needs webm-muxer: a copy without it (an old offline package) must fail here, before rendering, so
        // the caller can use the browser's recorder instead
        if (codecPreference === 'webm') await this._loadMuxer('webm');
        const T = VideoExportFast.TIMEOUTS;
        const deadline = performance.now() + T.probeBudgetMs;
        const ladder = VideoExportFast.sizeLadder(width, height);
        const why = [];
        let hadTimeout = false;
        // WebM: the encoder's speed decides the size too. A software encoder slower than WEBM_MIN_SOFTWARE_FPS at a
        // size gives way to the next smaller one (a test laptop, 2026-11-21: software VP9 at 3840x1920 managed
        // 0.3 frames per second, and every WebM ended as "stopped responding"); the slow pick is kept in case no
        // smaller size does better.
        const measureSpeed = codecPreference === 'webm';
        let slowPick = null;
        for (let i = 0; i < ladder.length; i++) {
            const { width: w, height: h } = ladder[i];
            const candidates = VideoExportFast.codecCandidates(codecPreference, w, h, fps);
            if (!candidates.length) { why.push(`${w}x${h}: no codec level fits`); continue; }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const c2d = canvas.getContext('2d');
            // A speed probe needs picture detail (a black frame encodes far faster than camera video): soft noise,
            // moved a little each frame
            const tex = measureSpeed ? VideoExportFast._probeTexture() : null;
            const paint = (ts) => {
                if (!tex) { c2d.fillStyle = '#000'; c2d.fillRect(0, 0, w, h); return; }
                const dx = Math.round(ts / 33333) * Math.max(2, Math.round(w / 200));
                c2d.drawImage(tex, -dx, 0, w + dx * 2, h);
            };
            paint(0);
            const limits = { deadline, maxTimeouts: T.probeTimeoutsPerSize, maxCodecTimeouts: T.probeTimeoutsPerCodec, shortProbes: hadTimeout,
                             measureSpeed };
            const before = this.skippedCodecs.length;
            const picked = await this._pickCodec(candidates, w, h, fps, VideoExportFast.bitrateFor(w, h),
                (ts) => { if (tex) paint(ts); return new VideoFrame(canvas, { timestamp: ts, duration: 33333 }); }, avoid, limits);
            canvas.width = canvas.height = 0;   // free the probe canvas now (a 4K one is 30 MB)
            if (limits.timeouts) hadTimeout = true;
            if (picked && measureSpeed && picked.probeFps != null && picked.probeFps < VideoExportFast.WEBM_MIN_SOFTWARE_FPS
                && i < ladder.length - 1 && performance.now() < deadline - 2000) {
                const note = `${w}x${h}: ${picked.muxName} encodes ${picked.probeFps.toFixed(1)} frames per second`;
                console.warn(`[VideoExportFast] ${note}, too slow for WebM: trying a smaller size`);
                why.push(note);
                if (!slowPick) slowPick = { w, h, picked };
                continue;
            }
            if (picked) {
                // reduced: smaller than asked (not the 1 px of making an odd side even)
                const reduced = w * h < width * height * 0.99;
                const reason = reduced ? (why.join('; ') || `over the export limit (${VideoExportFast.MAX_EXPORT_SIDE} px a side, 4K worth of pixels)`) : null;
                if (reduced) console.warn(`[VideoExportFast] Export size ${width}x${height} reduced to ${w}x${h}: ${reason}`);
                this.pickedCodec = picked;
                this.plannedSize = { width: w, height: h, askedWidth: width, askedHeight: height, reduced, reason };
                return { width: w, height: h, picked, reduced, reason };
            }
            const tried = this.skippedCodecs.slice(before).filter(s => !String(s.reason).startsWith('skipped'));
            const timeouts = tried.filter(s => s.reason === 'timeout').length;
            why.push(`${w}x${h}: ` + (timeouts ? `${timeouts} encoder(s) did not answer` :
                tried.length ? 'every encoder refused this size' : 'no encoder takes this size'));
            if (limits.budgetOut || performance.now() > deadline - 500) break;
        }
        if (slowPick) {
            // every smaller size was no better: the first slow one, slow as it is
            const { w, h, picked } = slowPick;
            const reduced = w * h < width * height * 0.99;
            this.pickedCodec = picked;
            this.plannedSize = { width: w, height: h, askedWidth: width, askedHeight: height, reduced, reason: reduced ? why.join('; ') : null };
            return { width: w, height: h, picked, reduced, reason: this.plannedSize.reason };
        }
        const e = new Error(`No video encoder on this device took this export (asked ${width}x${height}; ${why.join('; ')})`);
        e.code = 'NO_ENCODER';
        e.width = width;
        e.height = height;
        e.detail = why.join('; ');
        console.warn(`[VideoExportFast] ${e.message}`);
        throw e;
    }

    /**
     * A VideoEncoder + muxer pair with a stall watchdog: waits for queue room
     * and the final flush give up with ENCODER_STALLED once no output has
     * arrived for TIMEOUTS.stallMs while frames are waiting, instead of
     * waiting forever.
     */
    _openEncoder(mod, picked, width, height, fps, bitrate, onOutput) {
        const T = VideoExportFast.TIMEOUTS;
        let muxer, sink = null;
        if (picked.container === 'webm') {
            // WebM streams out of the muxer as it is written (8 MB at a time) into an ExportFileSink, which keeps
            // at most ~32 MB in memory and hands the rest to the browser as Blob parts (paged to disk when large).
            // A 10-minute 4K export is several GB: one growing ArrayBuffer would have to hold it all, twice while
            // it grows.
            sink = new ExportFileSink();
            muxer = new mod.Muxer({
                target: new mod.StreamTarget({ onData: (data, position) => sink.write(data, position), chunked: true, chunkSize: 8 * 1024 * 1024 }),
                video: { codec: VideoExportFast.WEBM_CODEC_IDS[picked.name] || 'V_VP9', width, height, frameRate: fps },
                type: 'webm'
            });
        } else {
            muxer = new mod.Muxer({
                target: new mod.ArrayBufferTarget(),
                video: { codec: picked.name, width, height, frameRate: fps },
                fastStart: 'in-memory'
            });
        }
        // lastInputAt: when we last handed the encoder a frame. The watchdog measures the encoder's silence from the
        // later of its last output and our last input (#569): a look-ahead encoder answers only when it gets more
        // input, so with slow frames (plate blur) the time between its outputs is OUR time per frame, not its.
        const st = { framesEncoded: 0, framesSubmitted: 0, lastOutputAt: performance.now(), lastInputAt: performance.now(),
                     maxGapMs: 0, errors: [], startedAt: performance.now() };
        const quietSince = () => Math.max(st.lastOutputAt, st.lastInputAt);
        const encoder = new VideoEncoder({
            output: (chunk, meta) => {
                muxer.addVideoChunk(chunk, meta);
                const now = performance.now();
                // the encoder's own longest wait between answers (from its last output or our last input, whichever
                // is later; the first output's wait is the warm-up)
                if (st.framesEncoded > 0) st.maxGapMs = Math.max(st.maxGapMs, now - quietSince());
                st.framesEncoded++;
                st.lastOutputAt = now;
                if (onOutput) onOutput(st.framesEncoded);
            },
            error: (e) => {
                // Hardware encoder failures often look like "OperationError" or
                // "InvalidStateError" with vague messages; the codec + dims +
                // frames-encoded context is what makes the log diagnosable.
                const en = e?.name || 'unknown';
                const em = e?.message || String(e) || 'no message';
                console.error(`[VideoExportFast] Encoder error: ${en}: ${em} | codec=${picked.codec} hw=${picked.hw} ${width}x${height} @ ${fps}fps bitrate=${bitrate} framesEncoded=${st.framesEncoded}/${st.framesSubmitted}`);
                st.errors.push(e);
            }
        });
        const cfg = VideoExportFast.encoderConfig(picked, width, height, fps, bitrate);
        if (cfg.latencyMode === 'realtime') console.log(`[VideoExportFast] Test switch tcv.${picked.name === 'vp9' ? 'vp9' : 'h264'}Realtime is on: ${picked.muxName} in low-latency (realtime) mode`);
        encoder.configure(cfg);
        VideoExportFast.dbg('encoder configure', { codec: cfg.codec, muxName: picked.muxName, width, height, hw: cfg.hardwareAcceleration || 'no-preference',
            latencyMode: cfg.latencyMode, bitrate, container: picked.container || 'mp4' });
        // How long without output (while frames wait) counts as stalled: TIMEOUTS.stallMs until the first output,
        // then TIMEOUTS.stallAfterOutputMs, or 4x the longest gap seen so far if that is longer (never above stallMs).
        // The browser's software encoders get the software limits: they are slow, not stuck (a test laptop,
        // 2026-11-21: software H.264 and VP9 at 3840x1920 were cut off as "stopped responding" while working).
        const sw = VideoExportFast.isSoftware(picked);
        const stallLimit = () => sw
            ? (st.framesEncoded === 0 ? T.softwareStallMs
                : Math.min(T.softwareStallMs, Math.max(T.softwareStallAfterOutputMs, 8 * st.maxGapMs)))
            : (st.framesEncoded === 0 ? T.stallMs
                : Math.min(T.stallMs, Math.max(T.stallAfterOutputMs, 4 * st.maxGapMs)));
        // Debug log (tcv.exportDebug): every 2 s the counts, the browser's queue, the silence and the limit in force
        let dbgTimer = null;
        if (VideoExportFast._dbg) {
            dbgTimer = setInterval(() => {
                let q = null;
                try { q = encoder.encodeQueueSize; } catch {}
                const now = performance.now();
                VideoExportFast.dbg('encoder', { muxName: picked.muxName, submitted: st.framesSubmitted, encoded: st.framesEncoded, queue: q,
                    sinceOutputMs: Math.round(now - st.lastOutputAt), sinceInputMs: Math.round(now - st.lastInputAt),
                    maxGapMs: Math.round(st.maxGapMs), stallLimitMs: Math.round(stallLimit()), state: encoder.state });
            }, 2000);
        }
        const stalled = () => st.framesSubmitted > st.framesEncoded
            && performance.now() - quietSince() > stallLimit();
        const stallErr = (stage) => {
            let queued = null;
            try { queued = encoder.encodeQueueSize; } catch {}
            const e = VideoExportFast.stalledError(picked, st.framesEncoded, st.framesSubmitted, stage, stallLimit(), queued);
            console.warn(`[VideoExportFast] ${e.message}`);
            VideoExportFast.rememberHwFailure(picked, `stopped responding during an export (${st.framesEncoded}/${st.framesSubmitted} frames)`);
            return e;
        };
        const fail = (err) => {
            VideoExportFast.rememberHwFailure(picked, `failed during an export (${err?.name || 'Error'}: ${String(err?.message || err).slice(0, 120)})`);
            return err;
        };
        // stall: false = errors only. Before a frame is handed over the time since the last input is our own frame
        // production (blurring, decoding), never the encoder's silence; the stall test runs only while we wait on it.
        const check = (stage, stall = true) => {
            if (st.errors.length) throw fail(st.errors[0]);
            if (stall && stalled()) throw stallErr(stage);
        };
        return {
            encoder, muxer, st, check, sink,
            /** After flush(): the finished file. */
            finish() {
                muxer.finalize();
                if (sink) return sink.toBlob('video/webm');
                return new Blob([muxer.target.buffer], { type: 'video/mp4' });
            },
            submit(frame, keyFrame) {
                encoder.encode(frame, { keyFrame });
                st.framesSubmitted++;
                st.lastInputAt = performance.now();
            },
            /** Wait while the queue is deeper than max; throws once stalled. */
            async drain(max, isClosed = () => false) {
                while (encoder.encodeQueueSize > max && !isClosed()) {
                    check('encoding');
                    await new Promise(r => setTimeout(r, 10));
                }
                check('encoding');
            },
            /** Flush with the same watchdog (progress-based, so slow PCs are fine). */
            async flush() {
                let done = false, failed = null;
                encoder.flush().then(() => { done = true; }, (e) => { failed = e || new Error('flush failed'); });
                while (!done && !failed) {
                    if (st.errors.length) throw fail(st.errors[0]);
                    if (stalled()) throw stallErr('finishing');
                    await new Promise(r => setTimeout(r, 100));
                }
                if (failed) throw fail(st.errors[0] || failed);
                if (st.errors.length) throw fail(st.errors[0]);
            },
            close() {
                if (dbgTimer) { clearInterval(dbgTimer); dbgTimer = null; }
                VideoExportFast.dbg('encoder close', { muxName: picked.muxName, submitted: st.framesSubmitted, encoded: st.framesEncoded });
                try { if (encoder.state !== 'closed') encoder.close(); } catch {}
            }
        };
    }

    async _loadMuxer(container = 'mp4') {
        // Vendored ESM — loaded via dynamic import so non-Fast-Export users
        // don't pay the parse/eval cost at startup.
        if (container === 'webm') {
            if (!this._webmMuxerModule) this._webmMuxerModule = await import('../vendor/webm-muxer.min.mjs');
            return this._webmMuxerModule;
        }
        if (this._muxerModule) return this._muxerModule;
        this._muxerModule = await import('../vendor/mp4-muxer.min.mjs');
        return this._muxerModule;
    }

    /**
     * Encode a pre-rendered frame buffer into an MP4 blob, or a WebM one (container 'webm', codecPreference
     * 'webm': VP9, then AV1). Frames get exact timestamps, so the file has every frame at the right length
     * however long encoding takes (the browser's real-time recorder lost its encoder's backlog when stopped).
     *
     * @param {Object} params
     * @param {Array} params.frameBuffer - Array of CanvasImageSource (ImageBitmap or canvas)
     * @param {number} params.fps
     * @param {number} params.width
     * @param {number} params.height
     * @param {Function} [params.onProgress] - (framesDone, framesTotal) => void
     * @param {Function} [params.onSpeed] - (realtimeMultiplier) => void
     * @param {'quality'|'compat'|'webm'} [params.codecPreference='quality'] - see codecCandidates
     * @param {'mp4'|'webm'} [params.container='mp4']
     * @param {Array<string>} [params.avoid] - "codec|hw" keys not to use (they stalled on an earlier try)
     * @param {Function} [params.isCancelled] - () => true once the user cancelled: stops with 'Export cancelled by user'
     * @param {Function} [params.onPicked] - (picked) => void, once the encoder is chosen, before its first frame (the
     *        export screen names it and measures its frames per second from here)
     * @returns {Promise<Blob>} MP4 or WebM blob
     */
    async encodeFrames({ frameBuffer, fps, width, height, onProgress, onSpeed, codecPreference = 'quality', picked: prepared = null,
        container = 'mp4', avoid = [], isCancelled = null, onPicked = null }) {
        if (!VideoExportFast.isSupported()) {
            throw new Error('WebCodecs not supported in this browser');
        }
        if (!frameBuffer || frameBuffer.length === 0) {
            throw new Error('Unable to encode empty frame buffer');
        }

        // Codec preference order: VP9 first for QUALITY, H.264 first for
        // COMPATIBILITY ("MP4 (H.264)").
        //
        // Why VP9 first for MP4 (VP9): H.264 (any profile) was producing
        // visibly degraded mini-map detail on Windows Chrome (fine text and
        // labels washed out, dark areas crushed) even at 80Mbps. The same
        // canvas pixels encoded to VP9 look clean, and mp4-muxer happily
        // containers VP9 in MP4.
        //
        // Adaptive bitrate, as in createStreamingEncoder: H.264 needs ~50%
        // more bits than VP9 to keep the mini-map's road labels and text.
        const bitrate = VideoExportFast.bitrateFor(width, height);
        const candidates = VideoExportFast.codecCandidates(codecPreference, width, height, fps);

        // Probe each candidate by really encoding one frame (isConfigSupported
        // can say yes while the real encode fails with "Unexpected frame
        // format"), every step time-limited (a GPU encoder can also never
        // answer, which used to hang the export at its start). Skipped when
        // prepare() already probed this size.
        const picked = prepared || await this._pickCodec(candidates, width, height, fps, bitrate,
            (ts) => new VideoFrame(frameBuffer[0], { timestamp: ts, duration: 33333 }), avoid,
            VideoExportFast.probeLimits());
        if (!picked) {
            const e = new Error(`No video encoder on this device took this export (${width}x${height})`);
            e.code = 'NO_ENCODER';
            e.width = width;
            e.height = height;
            throw e;
        }
        this.pickedCodec = picked;
        console.log(`[VideoExportFast] Using codec: ${picked.muxName} (${picked.codec}, ${picked.hw})`);
        if (onPicked) onPicked(picked);

        const mod = await this._loadMuxer(picked.container);
        const enc = this._openEncoder(mod, picked, width, height, fps, bitrate,
            (n) => { if (onProgress) onProgress(n, frameBuffer.length); });

        const frameIntervalUs = Math.round(1_000_000 / fps);
        const wallStart = performance.now();
        const earlyWindow = fps * 5;  // first 5 seconds
        try {
            for (let idx = 0; idx < frameBuffer.length; idx++) {
                if (isCancelled && isCancelled()) throw new Error('Export cancelled by user');
                enc.check('encoding', false);
                const frame = new VideoFrame(frameBuffer[idx], {
                    timestamp: idx * frameIntervalUs,
                    duration: frameIntervalUs
                });
                // First 5s: keyframe every 10 frames so encoder rate control
                // stabilizes before the user notices. After: every ~1s (fps).
                const isKey = idx === 0
                    || (idx < earlyWindow && idx % 10 === 0)
                    || (idx % fps === 0);
                try { enc.submit(frame, isKey); } finally { frame.close(); }

                // Backpressure: don't let the encoder queue balloon (and give
                // up if the encoder stops answering)
                await enc.drain(17);

                if (onSpeed && idx > 0 && idx % fps === 0) {
                    const wallElapsed = (performance.now() - wallStart) / 1000;
                    onSpeed((idx / fps) / wallElapsed);
                }
            }
            await enc.flush();
        } catch (e) {
            enc.close();
            throw e;
        }
        enc.close();
        this.lastStats = { framesEncoded: enc.st.framesEncoded, framesSubmitted: enc.st.framesSubmitted };
        return enc.finish();
    }

    /**
     * Streaming variant: set up encoder + muxer once, encode frames as they
     * arrive, close VideoFrames immediately. Returns an object with:
     *   encode(source, frameIndex, { keyFrame }): submit one frame; source can be
     *     HTMLCanvasElement, OffscreenCanvas, ImageBitmap, or VideoFrame.
     *   finalize(): flush encoder, finalize muxer, return mp4 Blob.
     *   abort(): tear everything down on error.
     *
     * Used by the fast-decoder export path to keep memory bounded (previously
     * we accumulated every rendered bitmap into a frameBuffer before encoding
     * Phase 2, which OOM'd Chrome on long exports, ~50GB for a 60s 6:3 event).
     *
     * encode() and finalize() throw err.code 'ENCODER_STALLED' when the
     * encoder has produced nothing for TIMEOUTS.stallMs while frames wait,
     * so a wedged GPU encoder ends the export with a clear error instead of
     * a hang.
     *
     * @param {Object} opts
     * @param {number} opts.width
     * @param {number} opts.height
     * @param {number} opts.fps
     * @param {number} [opts.bitrate] (default scales with the frame size)
     * @param {Function} [opts.onProgress] (framesEncoded) => void
     * @param {'quality'|'compat'} [opts.codecPreference='quality'] see codecCandidates
     * @param {Array<string>} [opts.avoid] "codec|hw" keys not to use (they stalled on an earlier try)
     */
    async createStreamingEncoder({ width, height, fps, bitrate, onProgress, codecPreference = 'quality', avoid = [], picked = null }) {
        // Adaptive default bitrate: scale with pixel count so 4K exports
        // don't starve the first keyframe ("video looks slightly out of
        // focus for the first second or two"). ~12 Mbps per megapixel
        // @30fps, floor 30 / cap 80 Mbps; H.264 needs ~30-50% more bits
        // than VP9 for the same fine detail (mini-map labels).
        if (bitrate == null) bitrate = VideoExportFast.bitrateFor(width, height);
        if (!VideoExportFast.isSupported()) {
            throw new Error('WebCodecs not supported in this browser');
        }

        // `picked` comes from prepare() (already probed at exactly this size); otherwise the same ladder and
        // time-limited probe as encodeFrames above, with a black canvas of the export size as the probe frame.
        if (picked && avoid.includes(`${picked.codec}|${picked.hw}`)) picked = null;
        if (!picked) {
            const candidates = VideoExportFast.codecCandidates(codecPreference, width, height, fps);
            const probeCanvas = document.createElement('canvas');
            probeCanvas.width = width;
            probeCanvas.height = height;
            const probeCtx = probeCanvas.getContext('2d');
            probeCtx.fillStyle = '#000';
            probeCtx.fillRect(0, 0, width, height);
            picked = await this._pickCodec(candidates, width, height, fps, bitrate,
                (ts) => new VideoFrame(probeCanvas, { timestamp: ts, duration: 33333 }), avoid,
                VideoExportFast.probeLimits());
        }
        if (!picked) {
            const e = new Error(`No video encoder on this device took this export (${width}x${height})`);
            e.code = 'NO_ENCODER';
            e.width = width;
            e.height = height;
            throw e;
        }
        this.pickedCodec = picked;
        console.log(`[VideoExportFast] Streaming encode with codec: ${picked.muxName} (${picked.codec}, ${picked.hw})` +
            (picked.container === 'webm' ? ' into WebM' : ''));

        const mod = await this._loadMuxer(picked.container);
        const enc = this._openEncoder(mod, picked, width, height, fps, bitrate, onProgress);
        const frameIntervalUs = Math.round(1_000_000 / fps);
        let closed = false;

        return {
            picked,
            /** live counters: framesEncoded, framesSubmitted */
            stats: enc.st,
            /** WebM: the output collector (bytes, bytes held in memory), else null */
            sink: enc.sink,
            /**
             * @param {CanvasImageSource|VideoFrame} source
             * @param {number} frameIndex monotonic frame number starting at 0
             * @param {{ keyFrame?: boolean }} [opts]
             */
            async encode(source, frameIndex, opts = {}) {
                if (closed) throw new Error('encoder already closed');
                enc.check('encoding', false);

                // Keyframe policy, tuned for "crisp from frame 0" output:
                //   - Always at frame 0 (required by spec).
                //   - First 5 seconds: keyframe every 10 frames, so the rate
                //     controller settles before the user's attention drifts.
                //   - After 5s: every ~1s (fps frames).
                const earlyWindowFrames = fps * 5;
                const kfIntervalLate = Math.max(1, fps);
                const autoKeyframe = frameIndex === 0
                    || (frameIndex < earlyWindowFrames && frameIndex % 10 === 0)
                    || (frameIndex % kfIntervalLate === 0);

                const timestamp = frameIndex * frameIntervalUs;
                const isVideoFrame = (typeof VideoFrame !== 'undefined') && (source instanceof VideoFrame);

                // Normalize input through createImageBitmap before wrapping in
                // VideoFrame. Passing canvases directly caused intermittent
                // "Unexpected frame format" errors mid-stream: Chrome's
                // canvas-to-VideoFrame path can switch between GPU-texture and
                // CPU-readback backings under GPU pressure. ImageBitmap has a
                // stable, well-defined format.
                let frame;
                let bitmap = null;
                if (isVideoFrame) {
                    frame = source;
                } else {
                    bitmap = await createImageBitmap(source);
                    frame = new VideoFrame(bitmap, {
                        timestamp,
                        duration: frameIntervalUs,
                        alpha: 'discard'  // H.264 doesn't carry alpha; be explicit
                    });
                }

                try {
                    enc.submit(frame, opts.keyFrame || autoKeyframe);
                } finally {
                    frame.close();
                    if (bitmap) { try { bitmap.close(); } catch {} }
                }

                // Backpressure: drain loop rather than a single sleep (the
                // single sleep let the queue grow unbounded when decode was
                // faster than encode). Throws ENCODER_STALLED instead of
                // spinning forever when the encoder stops answering.
                await enc.drain(17, () => closed);
            },

            async finalize() {
                if (closed) throw new Error('already finalized');
                closed = true;
                try {
                    await enc.flush();
                } catch (e) {
                    enc.close();
                    throw e;
                }
                enc.close();
                return enc.finish();
            },

            abort() {
                if (closed) return;
                closed = true;
                enc.close();
                // muxer has no explicit abort; its ArrayBuffer is garbage
                // collected once we drop our reference.
            }
        };
    }
}

/**
 * Collects a muxer's output (StreamTarget onData(data, position)) for a WebM export with bounded memory.
 *
 * Writes at the end of the file are copied into a small in-memory run; every COMMIT_BYTES (32 MB) that run
 * becomes one Blob part, which the browser keeps outside the page's memory (Chrome pages large blobs to disk).
 * The muxer also writes back into earlier bytes: each cluster's size when the next cluster starts, and at the
 * end the segment size, duration, seek head and cues position near the start of the file. Those writes patch
 * the in-memory run in place, or are kept (a few bytes each) and applied to the committed parts in toBlob() by
 * slicing them, which copies nothing.
 */
class ExportFileSink {
    static COMMIT_BYTES = 32 * 1024 * 1024;

    constructor({ commitBytes = ExportFileSink.COMMIT_BYTES } = {}) {
        this.commitBytes = commitBytes;
        this.parts = [];          // committed: {start, end, blob}
        this.pending = [];        // Uint8Array copies, contiguous from pendingStart
        this.pendingStart = 0;
        this.pendingBytes = 0;
        this.size = 0;            // bytes written so far (end of the file)
        this.patches = [];        // {pos, bytes}: writes into committed parts, in write order
        this.peakPendingBytes = 0;
        this.commits = 0;
        this.committedPatches = 0;   // writes that landed in committed parts (for tests and the log)
    }

    /** Bytes of the file held in this page's memory right now. */
    get bytesInMemory() { return this.pendingBytes + this.patches.reduce((n, p) => n + p.bytes.byteLength, 0); }

    write(data, position) {
        let src = data instanceof Uint8Array ? data : new Uint8Array(data);
        let pos = position;
        if (pos > this.size) this._append(new Uint8Array(pos - this.size));   // a gap (webm-muxer never leaves one)
        if (pos < this.size) {
            const n = Math.min(src.byteLength, this.size - pos);
            this._overwrite(src.subarray(0, n), pos);
            src = src.subarray(n);
            pos += n;
        }
        if (src.byteLength) this._append(src.slice());   // a copy: the muxer reuses its chunk buffers
    }

    _append(bytes) {
        this.pending.push(bytes);
        this.pendingBytes += bytes.byteLength;
        this.size += bytes.byteLength;
        if (this.pendingBytes > this.peakPendingBytes) this.peakPendingBytes = this.pendingBytes;
        if (this.pendingBytes >= this.commitBytes) this._commit();
    }

    _commit() {
        if (!this.pendingBytes) return;
        this.parts.push({ start: this.pendingStart, end: this.pendingStart + this.pendingBytes, blob: new Blob(this.pending) });
        this.pendingStart += this.pendingBytes;
        this.pending = [];
        this.pendingBytes = 0;
        this.commits++;
    }

    _overwrite(bytes, pos) {
        const end = pos + bytes.byteLength;
        if (end > this.pendingStart) {
            // the in-memory run: patch in place
            let off = this.pendingStart;
            for (const p of this.pending) {
                const pEnd = off + p.byteLength;
                if (pEnd > pos && off < end) {
                    const a = Math.max(pos, off), b = Math.min(end, pEnd);
                    p.set(bytes.subarray(a - pos, b - pos), a - off);
                }
                off = pEnd;
                if (off >= end) break;
            }
        }
        if (pos < this.pendingStart) {
            this.patches.push({ pos, bytes: bytes.slice(0, Math.min(end, this.pendingStart) - pos) });
            this.committedPatches++;
        }
    }

    /** The whole file (call once, after the muxer's finalize()). */
    toBlob(type) {
        this._commit();
        let segs = this.parts.map(p => ({ start: p.start, end: p.end, src: p.blob, off: 0 }));
        for (const pt of this.patches) {
            const ps = pt.pos, pe = pt.pos + pt.bytes.byteLength;
            const out = [];
            for (const s of segs) {
                if (s.end <= ps || s.start >= pe) { out.push(s); continue; }
                if (s.start < ps) out.push({ start: s.start, end: ps, src: s.src, off: s.off });
                const a = Math.max(ps, s.start), b = Math.min(pe, s.end);
                out.push({ start: a, end: b, src: pt.bytes, off: a - ps });
                if (s.end > pe) out.push({ start: pe, end: s.end, src: s.src, off: s.off + (pe - s.start) });
            }
            segs = out;
        }
        const pieces = segs.map(s => {
            const len = s.end - s.start;
            if (s.src instanceof Uint8Array) return s.src.subarray(s.off, s.off + len);
            return (s.off === 0 && len === s.src.size) ? s.src : s.src.slice(s.off, s.off + len);
        });
        this.parts = [];
        this.patches = [];
        return new Blob(pieces, { type });
    }
}

VideoExportFast.FileSink = ExportFileSink;
window.VideoExportFast = VideoExportFast;
window.ExportFileSink = ExportFileSink;
