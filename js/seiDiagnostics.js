/**
 * SeiDiagnostics - Persistence, surfacing, and crowd-sourced reporting
 * of unknown SEI fields discovered during playback.
 *
 * Collaborates with SeiExtractor (which tracks per-session unknown fields)
 * by snapshotting session state into localStorage, aggregating globally
 * across drives, and surfacing discoveries to the user via a toast +
 * a Settings > Diagnostics panel.
 *
 * Privacy: nothing leaves the user's machine without explicit action.
 * Report payloads exclude GPS-suspicious values, filenames, timestamps,
 * and any per-frame data that could reconstruct a trip. tcv.0x534549
 */
class SeiDiagnostics {
    constructor(extractor) {
        this.extractor = extractor;
        this.STORAGE_KEY = 'teslacamviewer_sei_diagnostics';
        this.SCHEMA_VERSION = 1;

        // In-memory aggregate. Shape:
        // {
        //   schemaVersion, unknownFields: { [fieldNumber]: { ...stats, nagUntil } },
        //   hwOverride: { model, hardware, confidence, setBy },
        //   userFirmware: string | null
        // }
        this.state = this._defaultState();

        this._activeToast = null;
        this._repoIssueUrl = 'https://github.com/NateMccomb/TeslaCamViewer/issues/new';
        this._supportEmail = 'support@teslacamviewer.com';
    }

    _defaultState() {
        return {
            schemaVersion: this.SCHEMA_VERSION,
            unknownFields: {},
            hwOverride: null,
            userFirmware: null
        };
    }

    init() {
        this._loadFromStorage();
    }

    _loadFromStorage() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed && parsed.schemaVersion === this.SCHEMA_VERSION) {
                this.state = parsed;
            }
        } catch (e) {
            console.warn('[SeiDiagnostics] Unable to load state:', e);
        }
    }

    _saveToStorage() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.state));
        } catch (e) {
            console.warn('[SeiDiagnostics] Unable to persist state:', e);
        }
    }

    /**
     * Pull the extractor's session-level unknown-field stats into persistent
     * state, triggering a toast if any fields qualify for surfacing.
     * Should be called after event/video load completes.
     */
    syncFromExtractor() {
        if (!this.extractor || typeof this.extractor.getUnknownFieldStats !== 'function') return;

        const sessionStats = this.extractor.getUnknownFieldStats();
        if (sessionStats.length === 0) return;

        const now = Date.now();
        const pendingNag = [];

        for (const fresh of sessionStats) {
            const key = String(fresh.fieldNumber);
            const existing = this.state.unknownFields[key];

            if (!existing) {
                this.state.unknownFields[key] = {
                    fieldNumber: fresh.fieldNumber,
                    wireType: fresh.wireType,
                    wireTypeName: fresh.wireTypeName,
                    count: fresh.count,
                    samples: fresh.samples.slice(),
                    min: fresh.min,
                    max: fresh.max,
                    mean: fresh.mean,
                    stddev: fresh.stddev,
                    firstSeenAt: fresh.firstSeenAt,
                    lastSeenAt: fresh.lastSeenAt,
                    gps_suspicion: fresh.gps_suspicion,
                    nagUntil: 0
                };
                pendingNag.push(this.state.unknownFields[key]);
            } else {
                existing.count = (existing.count || 0) + fresh.count;
                existing.samples = fresh.samples.slice();
                existing.min = Math.min(existing.min ?? fresh.min, fresh.min);
                existing.max = Math.max(existing.max ?? fresh.max, fresh.max);
                existing.mean = fresh.mean;
                existing.stddev = fresh.stddev;
                existing.lastSeenAt = fresh.lastSeenAt;
                existing.gps_suspicion = existing.gps_suspicion || fresh.gps_suspicion;
                if (now > (existing.nagUntil || 0)) {
                    pendingNag.push(existing);
                }
            }
        }

        this._saveToStorage();

        if (pendingNag.length > 0 && !this._activeToast) {
            this._showDiscoveryToast(pendingNag);
        }
    }

    getTotalUnknownFieldCount() {
        return Object.keys(this.state.unknownFields).length;
    }

    getAllFields() {
        return Object.values(this.state.unknownFields);
    }

    // ---------- Hardware detection ----------

    /**
     * Best-effort hardware detection from observable video signals.
     * Heuristic only — user is expected to verify in the report modal.
     * @param {Object} videoPlayer - The VideoPlayer instance
     * @returns {Object} { hardware, confidence, signals }
     */
    detectHardware(videoPlayer) {
        const signals = [];
        let hardware = 'Unknown';
        let confidence = 'none';

        const hasPillars = !!(videoPlayer && videoPlayer.hasPillarCameras);
        if (hasPillars) signals.push('pillar-cameras-present');

        const video = document.querySelector('video, canvas.video-player');
        const vw = video ? video.videoWidth : 0;
        if (vw >= 1920) signals.push('resolution>=1920');
        else if (vw >= 1280) signals.push('resolution>=1280');

        if (hasPillars && vw >= 1920) {
            hardware = 'HW4/AI4';
            confidence = 'high';
        } else if (hasPillars) {
            hardware = 'HW4/AI4';
            confidence = 'medium';
        } else if (vw >= 1280) {
            hardware = 'HW3 or HW4';
            confidence = 'low';
        }

        return { hardware, confidence, signals };
    }

    setHardwareOverride(model, hardware) {
        this.state.hwOverride = { model, hardware, setBy: 'user', setAt: Date.now() };
        this._saveToStorage();
    }

    setUserFirmware(firmwareString) {
        this.state.userFirmware = firmwareString || null;
        this._saveToStorage();
    }

    // ---------- Report generation ----------

    /**
     * Build a privacy-scrubbed report payload for manual submission.
     * @returns {Object}
     */
    generateSanitizedReport(videoPlayer = null) {
        const fields = this.getAllFields().map(f => {
            const entry = {
                field_number: f.fieldNumber,
                wire_type: f.wireType,
                wire_type_name: f.wireTypeName,
                observations: f.count,
                value_stats: {
                    min: f.min,
                    max: f.max,
                    mean: f.mean,
                    stddev: f.stddev
                },
                gps_suspicion: !!f.gps_suspicion
            };
            // Only include raw samples when they aren't GPS-suspicious.
            if (!f.gps_suspicion) {
                entry.samples = (f.samples || []).slice(0, 17);
            } else {
                entry.samples_redacted_reason = 'values look like GPS coordinates';
            }
            return entry;
        });

        const hwDetected = videoPlayer ? this.detectHardware(videoPlayer) : null;

        return {
            tcv_version: (window.app?.versionManager && window.app.versionManager.currentVersion) || 'unknown',
            proto_version_observed: 1,
            browser: this._describeBrowser(),
            os: navigator.userAgent,
            tesla_firmware_user_reported: this.state.userFirmware || null,
            hardware_user_selected: this.state.hwOverride || null,
            hardware_detected_hint: hwDetected,
            unknown_fields: fields
        };
    }

    _describeBrowser() {
        const ua = navigator.userAgent;
        const match = ua.match(/(Chrome|Edg|Firefox|Safari)\/(\d+)/);
        return match ? `${match[1]} ${match[2]}` : 'Unknown';
    }

    buildGithubIssueUrl(report) {
        const title = `Unknown SEI field(s) detected: ${report.unknown_fields.map(f => f.field_number).join(', ')}`;
        const body = this._buildIssueBody(report);
        const url = new URL(this._repoIssueUrl);
        url.searchParams.set('title', title);
        url.searchParams.set('body', body);
        url.searchParams.set('labels', 'sei-unknown-field');
        return url.toString();
    }

    buildMailtoUrl(report) {
        const subject = `TeslaCamViewer — Unknown SEI field report`;
        const body = this._buildIssueBody(report);
        return `mailto:${this._supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    }

    _buildIssueBody(report) {
        const lines = [
            '## Unknown SEI Field Report',
            '',
            'Automatically generated by TeslaCamViewer SEI Diagnostics.',
            '',
            '### Environment',
            `- TCV version: \`${report.tcv_version}\``,
            `- Browser: \`${report.browser}\``,
            `- Tesla firmware (user-reported): \`${report.tesla_firmware_user_reported || 'not provided'}\``,
            `- Hardware (user-selected): \`${report.hardware_user_selected ? JSON.stringify(report.hardware_user_selected) : 'not provided'}\``,
            `- Hardware (auto-detected hint): \`${report.hardware_detected_hint ? JSON.stringify(report.hardware_detected_hint) : 'unknown'}\``,
            '',
            '### Observed Unknown Fields',
            '',
            '```json',
            JSON.stringify(report.unknown_fields, null, 2),
            '```',
            '',
            '### Notes',
            '',
            '*Describe anything you think is relevant — recent firmware update, vehicle model, conditions when recording, etc.*',
            ''
        ];
        return lines.join('\n');
    }

    // ---------- Toast / nag logic ----------

    _showDiscoveryToast(fields) {
        if (this._activeToast) return;

        const count = fields.length;
        const fieldsList = fields.map(f => `#${f.fieldNumber}`).join(', ');
        const subtitle = count === 1
            ? `Field ${fieldsList} — help us decode it?`
            : `Fields ${fieldsList} — help us decode them?`;

        const toast = document.createElement('div');
        toast.className = 'update-toast sei-diagnostics-toast';
        toast.innerHTML = `
            <div class="update-toast-content">
                <div class="update-toast-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                </div>
                <div class="update-toast-text">
                    <strong>New Tesla telemetry detected</strong>
                    <span>${subtitle}</span>
                </div>
                <button class="update-toast-btn" data-sei-action="view">View</button>
                <button class="update-toast-btn update-toast-btn-alt" data-sei-action="snooze-1w" title="Remind me in 1 week">1w</button>
                <button class="update-toast-btn update-toast-btn-alt" data-sei-action="snooze-2w" title="Remind me in 2 weeks">2w</button>
                <button class="update-toast-close" data-sei-action="dismiss" title="Dismiss">&times;</button>
            </div>
        `;

        document.body.appendChild(toast);
        this._activeToast = toast;
        requestAnimationFrame(() => toast.classList.add('visible'));

        toast.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-sei-action]');
            if (!btn) return;
            const action = btn.dataset.seiAction;
            this._handleToastAction(action, fields);
        });

        setTimeout(() => {
            if (this._activeToast === toast) {
                this._dismissToast();
            }
        }, 47000);
    }

    _handleToastAction(action, fields) {
        const now = Date.now();
        const WEEK = 7 * 24 * 60 * 60 * 1000;

        switch (action) {
            case 'view':
                this._dismissToast();
                this.openDiagnosticsSettings();
                break;
            case 'snooze-1w':
                fields.forEach(f => { f.nagUntil = now + WEEK; });
                this._saveToStorage();
                this._dismissToast();
                break;
            case 'snooze-2w':
                fields.forEach(f => { f.nagUntil = now + 2 * WEEK; });
                this._saveToStorage();
                this._dismissToast();
                break;
            case 'dismiss':
                fields.forEach(f => { f.nagUntil = Number.MAX_SAFE_INTEGER; });
                this._saveToStorage();
                this._dismissToast();
                break;
        }
    }

    _dismissToast() {
        if (!this._activeToast) return;
        const toast = this._activeToast;
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
        this._activeToast = null;
    }

    openDiagnosticsSettings() {
        const sm = window.app?.settingsManager;
        if (sm && typeof sm.showSettingsModal === 'function') {
            sm._activeTab = 'diagnostics';
            sm.showSettingsModal();
        }
    }

    // ---------- Settings tab rendering ----------

    /**
     * Produce the HTML for the Diagnostics tab in Settings.
     * Consumed by SettingsManager's renderModalContent when _activeTab === 'diagnostics'.
     * @returns {string}
     */
    renderDiagnosticsTab() {
        const fields = this.getAllFields();
        const totalCount = fields.length;

        let fieldsHtml;
        if (totalCount === 0) {
            fieldsHtml = `
                <div class="settings-empty-state" style="padding:1rem;opacity:0.7;">
                    No unknown SEI fields detected. Your Tesla emits only the published schema (fields 1–16).
                </div>
            `;
        } else {
            fieldsHtml = `
                <table style="width:100%;border-collapse:collapse;font-size:0.9em;">
                    <thead>
                        <tr style="text-align:left;border-bottom:1px solid var(--border);">
                            <th style="padding:0.4rem;">Field #</th>
                            <th style="padding:0.4rem;">Wire Type</th>
                            <th style="padding:0.4rem;">Observations</th>
                            <th style="padding:0.4rem;">Value Range</th>
                            <th style="padding:0.4rem;">GPS?</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${fields.map(f => `
                            <tr style="border-bottom:1px solid var(--border);">
                                <td style="padding:0.4rem;">${f.fieldNumber}</td>
                                <td style="padding:0.4rem;">${f.wireTypeName || '?'}</td>
                                <td style="padding:0.4rem;">${f.count}</td>
                                <td style="padding:0.4rem;">${f.min != null ? f.min.toFixed(3) : '—'} &ndash; ${f.max != null ? f.max.toFixed(3) : '—'}</td>
                                <td style="padding:0.4rem;">${f.gps_suspicion ? '⚠️ suspected' : '—'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;
        }

        const hwOverride = this.state.hwOverride;
        const hwOverrideHtml = hwOverride
            ? `<div>Current: <code>${hwOverride.model} / ${hwOverride.hardware}</code></div>`
            : '<div style="opacity:0.7;">Not set.</div>';

        return `
            <div class="settings-section">
                <h4>SEI Unknown-Field Scanner</h4>
                <p style="opacity:0.8;font-size:0.9em;">
                    Tesla's published telemetry schema has 16 documented fields. If your vehicle's
                    firmware emits any fields beyond that, TCV tracks them here so we can
                    (with your help) figure out what they mean.
                </p>
                <div style="margin-top:0.5rem;font-weight:bold;">
                    Detected: ${totalCount} unknown field${totalCount === 1 ? '' : 's'}
                </div>
            </div>

            <div class="settings-section">
                <h4>Discovered Fields</h4>
                ${fieldsHtml}
            </div>

            <div class="settings-section">
                <h4>Vehicle (optional)</h4>
                <p style="opacity:0.8;font-size:0.9em;">
                    Helps us correlate unknown fields to specific Tesla hardware.
                    Everything here stays on your machine unless you submit a report.
                </p>
                <label style="display:block;margin-top:0.5rem;">
                    Model:
                    <select id="seiDiagModel" style="margin-left:0.5rem;">
                        <option value="">-- select --</option>
                        <option value="Model 3">Model 3</option>
                        <option value="Model Y">Model Y</option>
                        <option value="Model S">Model S</option>
                        <option value="Model X">Model X</option>
                        <option value="Cybertruck">Cybertruck</option>
                        <option value="Other">Other</option>
                    </select>
                </label>
                <label style="display:block;margin-top:0.5rem;">
                    Hardware:
                    <select id="seiDiagHW" style="margin-left:0.5rem;">
                        <option value="">-- select --</option>
                        <option value="HW3">HW3</option>
                        <option value="HW4">HW4</option>
                        <option value="AI4">AI4</option>
                        <option value="Unknown">Unknown</option>
                    </select>
                </label>
                <label style="display:block;margin-top:0.5rem;">
                    Tesla firmware (e.g. 2026.4.5):
                    <input type="text" id="seiDiagFirmware" placeholder="optional" style="margin-left:0.5rem;" value="${this.state.userFirmware || ''}">
                </label>
                <div style="margin-top:0.5rem;">${hwOverrideHtml}</div>
                <button id="seiDiagSaveVehicle" class="btn-primary" style="margin-top:0.5rem;">Save</button>
            </div>

            <div class="settings-section">
                <h4>Report to Developers</h4>
                <p style="opacity:0.8;font-size:0.9em;">
                    Generate a privacy-scrubbed report you can share via GitHub or email.
                    Review the full payload before submitting — no data leaves your machine automatically.
                </p>
                <button id="seiDiagGenerate" class="btn-primary" ${totalCount === 0 ? 'disabled' : ''}>
                    Generate Report
                </button>
                <button id="seiDiagReset" class="btn-secondary" style="margin-left:0.5rem;">
                    Reset All Stats
                </button>
            </div>

            ${this._renderTroubleshootingSection()}

            <div class="settings-section">
                <h4>Video State Recorder</h4>
                <p style="opacity:0.8;font-size:0.9em;">
                    Capture detailed playback events (play, pause, waiting, seeks, buffering)
                    for all cameras. Use this if you hit stuck buffering, stuttering, or
                    desync bugs we haven't tracked down — reproduce the issue while
                    recording, then export the log and attach it to your bug report.
                </p>
                <div id="vsrDiagStatus" style="margin-top:0.5rem;font-family:ui-monospace,monospace;font-size:0.85em;opacity:0.8;">
                    Idle · 0 events captured
                </div>
                <div style="margin-top:0.5rem;">
                    <button id="vsrDiagStart" class="btn-primary">Start recording</button>
                    <button id="vsrDiagStop" class="btn-secondary" style="margin-left:0.5rem;display:none;">Stop</button>
                    <button id="vsrDiagExport" class="btn-secondary" style="margin-left:0.5rem;">Export log</button>
                    <button id="vsrDiagClear" class="btn-secondary" style="margin-left:0.5rem;">Clear</button>
                </div>
                <p style="opacity:0.6;font-size:0.8em;margin-top:0.5rem;">
                    Floating control panel appears at bottom-left while recording is active.
                    Close it with × or reopen with <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>.
                </p>
            </div>
        `;
    }

    /**
     * Render the general-purpose Troubleshooting section: debug-flag toggles
     * and console-log capture controls. Independent of the SEI scanner.
     * @private
     */
    _renderTroubleshootingSection() {
        const logger = window.diagnosticsLogger;
        const flags = logger ? logger.flagDefinitions : [];
        const lineCount = logger ? logger.getLineCount() : 0;

        const flagsHtml = flags.map(f => {
            const checked = logger && logger.getDebugFlag(f.flag) ? 'checked' : '';
            return `
                <label style="display:block;margin-top:0.5rem;">
                    <input type="checkbox" data-debug-flag="${f.flag}" ${checked}>
                    <strong>${f.label}</strong>
                    <div style="opacity:0.7;font-size:0.85em;margin-left:1.5rem;">${f.description}</div>
                </label>
            `;
        }).join('');

        return `
            <div class="settings-section">
                <h4>Troubleshooting</h4>
                <p style="opacity:0.8;font-size:0.9em;">
                    Toggle diagnostic flags to capture extra detail when reporting issues.
                    Logs stay on your machine until you choose to copy or download them.
                </p>

                <h5 style="margin-top:0.75rem;">Debug Flags</h5>
                ${flagsHtml || '<div style="opacity:0.7;">No debug flags registered.</div>'}

                <h5 style="margin-top:1rem;">Console Log Capture</h5>
                <div style="opacity:0.85;font-size:0.9em;margin-bottom:0.5rem;">
                    <span id="diagLogCount">${lineCount}</span> line${lineCount === 1 ? '' : 's'} captured
                    <span style="opacity:0.7;">(paths, coords, plates, and emails are redacted before sharing)</span>
                </div>
                <button id="diagLogCopy" class="btn-primary">Copy Logs</button>
                <button id="diagLogDownload" class="btn-primary" style="margin-left:0.5rem;">Download .txt</button>
                <button id="diagLogPreview" class="btn-secondary" style="margin-left:0.5rem;">Preview</button>
                <button id="diagLogClear" class="btn-secondary" style="margin-left:0.5rem;">Clear</button>
            </div>
        `;
    }

    /**
     * Bind events for the Diagnostics tab. Called by SettingsManager after rendering.
     */
    bindDiagnosticsTabEvents(rootEl) {
        const modelSel = rootEl.querySelector('#seiDiagModel');
        const hwSel = rootEl.querySelector('#seiDiagHW');
        const fwInput = rootEl.querySelector('#seiDiagFirmware');
        const saveBtn = rootEl.querySelector('#seiDiagSaveVehicle');
        const genBtn = rootEl.querySelector('#seiDiagGenerate');
        const resetBtn = rootEl.querySelector('#seiDiagReset');

        if (this.state.hwOverride) {
            if (modelSel) modelSel.value = this.state.hwOverride.model || '';
            if (hwSel) hwSel.value = this.state.hwOverride.hardware || '';
        }

        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const model = modelSel ? modelSel.value : '';
                const hw = hwSel ? hwSel.value : '';
                if (model && hw) this.setHardwareOverride(model, hw);
                if (fwInput) this.setUserFirmware(fwInput.value.trim());
                saveBtn.textContent = 'Saved ✓';
                setTimeout(() => { saveBtn.textContent = 'Save'; }, 1847);
            });
        }

        if (genBtn) {
            genBtn.addEventListener('click', () => {
                const vp = window.app?.videoPlayer || null;
                const report = this.generateSanitizedReport(vp);
                this.showReportModal(report);
            });
        }

        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (!confirm('Reset all unknown-field stats? This clears discovery history.')) return;
                this.state.unknownFields = {};
                this._saveToStorage();
                if (this.extractor && typeof this.extractor.resetUnknownFieldStats === 'function') {
                    this.extractor.resetUnknownFieldStats();
                }
                if (window.app?.settingsManager) {
                    window.app.settingsManager.renderModalContent();
                }
            });
        }

        this._bindTroubleshootingEvents(rootEl);
        this._bindVideoStateRecorderEvents(rootEl);
    }

    /**
     * Wire up the Video State Recorder section.
     */
    _bindVideoStateRecorderEvents(rootEl) {
        const rec = window.videoStateRecorder;
        if (!rec) return;

        const statusEl = rootEl.querySelector('#vsrDiagStatus');
        const startBtn = rootEl.querySelector('#vsrDiagStart');
        const stopBtn  = rootEl.querySelector('#vsrDiagStop');
        const expBtn   = rootEl.querySelector('#vsrDiagExport');
        const clrBtn   = rootEl.querySelector('#vsrDiagClear');
        if (!statusEl || !startBtn) return;

        const refreshStatus = () => {
            if (rec.enabled) {
                statusEl.textContent = `● Recording · ${rec.events.length} events captured`;
                statusEl.style.color = '#f87171';
                startBtn.style.display = 'none';
                stopBtn.style.display = '';
            } else {
                statusEl.textContent = rec.events.length > 0
                    ? `Stopped · ${rec.events.length} events captured`
                    : 'Idle · 0 events captured';
                statusEl.style.color = '';
                startBtn.style.display = '';
                stopBtn.style.display = 'none';
            }
        };
        refreshStatus();
        // Keep the status fresh while recording
        const tick = setInterval(() => {
            if (!rootEl.isConnected) { clearInterval(tick); return; }
            if (rec.enabled) refreshStatus();
        }, 500);

        startBtn.addEventListener('click', () => {
            rec.start();
            if (typeof rec.showPanel === 'function') rec.showPanel();
            refreshStatus();
        });
        stopBtn.addEventListener('click', () => { rec.stop(); refreshStatus(); });
        expBtn.addEventListener('click', () => { rec.export(); });
        clrBtn.addEventListener('click', () => { rec.clear(); refreshStatus(); });
    }

    /**
     * Wire up the Troubleshooting section (debug flag toggles + log buttons).
     * @private
     */
    _bindTroubleshootingEvents(rootEl) {
        const logger = window.diagnosticsLogger;
        if (!logger) return;

        // Debug flag checkboxes
        rootEl.querySelectorAll('[data-debug-flag]').forEach(cb => {
            cb.addEventListener('change', (e) => {
                logger.setDebugFlag(e.target.dataset.debugFlag, e.target.checked);
            });
        });

        const copyBtn = rootEl.querySelector('#diagLogCopy');
        const downloadBtn = rootEl.querySelector('#diagLogDownload');
        const previewBtn = rootEl.querySelector('#diagLogPreview');
        const clearBtn = rootEl.querySelector('#diagLogClear');
        const countEl = rootEl.querySelector('#diagLogCount');

        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                try {
                    await logger.copyToClipboard();
                    const orig = copyBtn.textContent;
                    copyBtn.textContent = 'Copied ✓';
                    setTimeout(() => { copyBtn.textContent = orig; }, 1847);
                } catch (err) {
                    console.warn('[Diagnostics] Unable to copy logs:', err);
                    alert('Unable to copy to clipboard — try the Download button instead.');
                }
            });
        }

        if (downloadBtn) {
            downloadBtn.addEventListener('click', () => logger.downloadAsFile());
        }

        if (previewBtn) {
            previewBtn.addEventListener('click', () => {
                this._showLogPreviewModal(logger.getFormattedLogs());
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (!confirm('Clear captured log buffer?')) return;
                logger.clearLogs();
                if (countEl) countEl.textContent = '0';
            });
        }
    }

    /**
     * Show a read-only preview modal of the sanitized log dump so users can
     * review what they're about to share before hitting Copy / Download.
     * @private
     */
    _showLogPreviewModal(text) {
        const existing = document.querySelector('.diag-log-preview-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.className = 'diag-log-preview-modal settings-modal';
        modal.innerHTML = `
            <div class="settings-overlay"></div>
            <div class="settings-panel" style="max-width:900px;">
                <div style="padding:1.5rem;">
                    <h3>Captured Console Logs (sanitized)</h3>
                    <p style="opacity:0.8;font-size:0.9em;">
                        Review before sharing. Paths, coordinates, plates, and emails have been redacted.
                    </p>
                    <pre style="max-height:400px;overflow:auto;background:var(--bg-secondary,#222);padding:1rem;border-radius:4px;font-size:0.78em;white-space:pre-wrap;">${FolderParser.escapeHtml(text || '(buffer empty)')}</pre>
                    <div style="margin-top:1rem;display:flex;justify-content:flex-end;">
                        <button id="diagPreviewClose" class="btn-secondary">Close</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const close = () => modal.remove();
        modal.querySelector('#diagPreviewClose').addEventListener('click', close);
        modal.querySelector('.settings-overlay').addEventListener('click', close);
    }

    // ---------- Report modal ----------

    showReportModal(report) {
        const existing = document.querySelector('.sei-report-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.className = 'sei-report-modal settings-modal';
        modal.innerHTML = `
            <div class="settings-overlay"></div>
            <div class="settings-panel" style="max-width:800px;">
                <div style="padding:1.5rem;">
                    <h3>SEI Unknown-Field Report</h3>
                    <p style="opacity:0.8;font-size:0.9em;">
                        Review the full payload below. Nothing is sent until you click a delivery option.
                    </p>
                    <pre id="seiReportPayload" style="max-height:300px;overflow:auto;background:var(--bg-secondary,#222);padding:1rem;border-radius:4px;font-size:0.8em;">${FolderParser.escapeHtml(JSON.stringify(report, null, 2))}</pre>
                    <div style="margin-top:1rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
                        <button id="seiReportCopy" class="btn-primary">Copy to Clipboard</button>
                        <button id="seiReportGithub" class="btn-primary">Open GitHub Issue</button>
                        <button id="seiReportEmail" class="btn-primary">Email Support</button>
                        <button id="seiReportClose" class="btn-secondary" style="margin-left:auto;">Close</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const copyBtn = modal.querySelector('#seiReportCopy');
        const githubBtn = modal.querySelector('#seiReportGithub');
        const emailBtn = modal.querySelector('#seiReportEmail');
        const closeBtn = modal.querySelector('#seiReportClose');
        const overlay = modal.querySelector('.settings-overlay');

        copyBtn.addEventListener('click', async () => {
            const txt = JSON.stringify(report, null, 2);
            try {
                await navigator.clipboard.writeText(txt);
                copyBtn.textContent = 'Copied ✓';
                setTimeout(() => { copyBtn.textContent = 'Copy to Clipboard'; }, 1847);
            } catch (e) {
                console.warn('[SeiDiagnostics] Unable to write to clipboard:', e);
            }
        });

        githubBtn.addEventListener('click', () => {
            window.open(this.buildGithubIssueUrl(report), '_blank', 'noopener');
        });

        emailBtn.addEventListener('click', () => {
            window.location.href = this.buildMailtoUrl(report);
        });

        const close = () => modal.remove();
        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', close);
    }
}

window.SeiDiagnostics = SeiDiagnostics;
