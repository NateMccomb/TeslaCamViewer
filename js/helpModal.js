/**
 * Help Modal - Displays keyboard shortcuts and help information
 */
class HelpModal {
    constructor() {
        this.modal = null;

        // Listen for locale changes to re-render modal
        window.addEventListener('localeChanged', () => {
            if (this.modal && !this.modal.classList.contains('hidden')) {
                this.renderContent();
            }
        });
    }

    /**
     * Get translation helper
     */
    t(key) {
        return window.i18n ? window.i18n.t(key) : key.split('.').pop();
    }

    /**
     * Create and show the help modal
     */
    show() {
        if (this.modal) {
            this.modal.classList.remove('hidden');
            this.renderContent();
            return;
        }

        this.modal = document.createElement('div');
        this.modal.className = 'help-modal';
        this.modal.innerHTML = `
            <div class="help-overlay"></div>
            <div class="help-panel"></div>
        `;

        document.body.appendChild(this.modal);
        this.renderContent();
        this.bindEvents();
    }

    /**
     * Render the help modal content with translations
     */
    renderContent() {
        const panel = this.modal.querySelector('.help-panel');
        panel.innerHTML = `
            <div class="help-header">
                <h2>${this.t('help.title')}</h2>
                <button class="help-close-btn" title="${this.t('common.close')}">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                    </svg>
                </button>
            </div>
            <div class="help-content">
                <!-- Playback Shortcuts -->
                <div class="help-section">
                    <h3>${this.t('help.sections.playback')}</h3>
                    <div class="shortcut-grid">
                        <div class="shortcut-row">
                            <kbd>Space</kbd>
                            <span>${this.t('help.shortcuts.playPause')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>Left Arrow</kbd>
                            <span>${this.t('help.shortcuts.previousFrame')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>Right Arrow</kbd>
                            <span>${this.t('help.shortcuts.nextFrame')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>Hold Left/Right</kbd>
                            <span>${this.t('help.shortcuts.slowMotion')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>Shift + Left</kbd>
                            <span>${this.t('help.shortcuts.previousClip')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>Shift + Right</kbd>
                            <span>${this.t('help.shortcuts.nextClip')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>Home</kbd>
                            <span>${this.t('help.shortcuts.goToStart')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>End</kbd>
                            <span>${this.t('help.shortcuts.goToEnd')}</span>
                        </div>
                    </div>
                </div>

                <!-- Navigation Shortcuts -->
                <div class="help-section">
                    <h3>${this.t('help.sections.navigation')}</h3>
                    <div class="shortcut-grid">
                        <div class="shortcut-row">
                            <kbd>Page Up</kbd>
                            <span>${this.t('help.shortcuts.previousEvent')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>Page Down</kbd>
                            <span>${this.t('help.shortcuts.nextEvent')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>Up Arrow</kbd>
                            <span>${this.t('help.shortcuts.selectPreviousEvent')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>Down Arrow</kbd>
                            <span>${this.t('help.shortcuts.selectNextEvent')}</span>
                        </div>
                    </div>
                </div>

                <!-- View Shortcuts -->
                <div class="help-section">
                    <h3>${this.t('help.sections.viewLayout')}</h3>
                    <div class="shortcut-grid">
                        <div class="shortcut-row">
                            <kbd>L</kbd>
                            <span>${this.t('help.shortcuts.cycleLayouts')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>1-4</kbd>
                            <span>${this.t('help.shortcuts.focusCamera')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>F</kbd>
                            <span>${this.t('help.shortcuts.toggleFullscreen')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>Double-click video</kbd>
                            <span>${this.t('help.shortcuts.focusCameraFullscreen')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>T</kbd>
                            <span>Toggle Telemetry Overlay</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>M</kbd>
                            <span>Toggle Mini-Map</span>
                        </div>
                    </div>
                </div>

                <!-- Marking & Export -->
                <div class="help-section">
                    <h3>${this.t('help.sections.markingExport')}</h3>
                    <div class="shortcut-grid">
                        <div class="shortcut-row">
                            <kbd>I</kbd>
                            <span>${this.t('help.shortcuts.markIn')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>O</kbd>
                            <span>${this.t('help.shortcuts.markOut')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>Esc</kbd>
                            <span>${this.t('help.shortcuts.clearMarks')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>S</kbd>
                            <span>${this.t('help.shortcuts.takeScreenshot')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>E</kbd>
                            <span>${this.t('help.shortcuts.exportVideo')}</span>
                        </div>
                    </div>
                </div>

                <!-- Bookmarks -->
                <div class="help-section">
                    <h3>${this.t('help.sections.bookmarks')}</h3>
                    <div class="shortcut-grid">
                        <div class="shortcut-row">
                            <kbd>B</kbd>
                            <span>${this.t('help.shortcuts.addBookmark')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>[</kbd>
                            <span>${this.t('help.shortcuts.jumpToPreviousBookmark')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>]</kbd>
                            <span>${this.t('help.shortcuts.jumpToNextBookmark')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>Scroll on timeline</kbd>
                            <span>${this.t('help.shortcuts.zoomTimeline')}</span>
                        </div>
                    </div>
                </div>

                <!-- Speed Control -->
                <div class="help-section">
                    <h3>${this.t('help.sections.speedControl')}</h3>
                    <div class="shortcut-grid">
                        <div class="shortcut-row">
                            <kbd>+</kbd> or <kbd>=</kbd>
                            <span>${this.t('help.shortcuts.increaseSpeed')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>-</kbd>
                            <span>${this.t('help.shortcuts.decreaseSpeed')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>0</kbd>
                            <span>${this.t('help.shortcuts.resetSpeed')}</span>
                        </div>
                    </div>
                </div>

                <!-- General -->
                <div class="help-section">
                    <h3>${this.t('help.sections.general')}</h3>
                    <div class="shortcut-grid">
                        <div class="shortcut-row">
                            <kbd>?</kbd> or <kbd>H</kbd>
                            <span>${this.t('help.shortcuts.showHelp')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>,</kbd>
                            <span>${this.t('help.shortcuts.openSettings')}</span>
                        </div>
                        <div class="shortcut-row">
                            <kbd>Esc</kbd>
                            <span>${this.t('help.shortcuts.closeModal')}</span>
                        </div>
                    </div>
                </div>

                <!-- Telemetry Info -->
                <div class="help-section">
                    <h3>HUD Telemetry Info</h3>
                    <div class="shortcut-grid" style="font-size: 0.85em;">
                        <div class="shortcut-row">
                            <span style="color: #69f0ae;">●</span>
                            <span>Throttle position (from accelerator pedal)</span>
                        </div>
                        <div class="shortcut-row">
                            <span style="color: #ff1744;">●</span>
                            <span>Physical brake pedal applied</span>
                        </div>
                        <div class="shortcut-row">
                            <span style="color: #ff9100;">●</span>
                            <span>Regenerative braking (calculated from G-force deceleration sensor)</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="help-footer">
                <span class="help-tip">${this.t('help.tip')}</span>
                <div class="help-footer-actions">
                    <button class="help-report-btn" title="Copy diagnostic info for bug reports">
                        🐛 Report Bug
                    </button>
                </div>
            </div>
        `;
    }

    /**
     * Bind modal events
     */
    bindEvents() {
        const overlay = this.modal.querySelector('.help-overlay');
        overlay.addEventListener('click', () => this.hide());

        // ESC to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal && !this.modal.classList.contains('hidden')) {
                this.hide();
            }
        });

        // Use event delegation for close button since content is re-rendered
        this.modal.addEventListener('click', (e) => {
            if (e.target.closest('.help-close-btn')) {
                this.hide();
            }
            if (e.target.closest('.help-report-btn')) {
                this.copyDiagnostics();
            }
        });
    }

    /**
     * Copy diagnostic report for bug reporting
     */
    async copyDiagnostics() {
        if (window.app?.copyDiagnosticReport) {
            await window.app.copyDiagnosticReport();
        } else {
            // Fallback if app method not available
            const info = {
                version: window.app?.versionManager?.currentVersion || 'Unknown',
                userAgent: navigator.userAgent,
                platform: navigator.platform,
                timestamp: new Date().toISOString()
            };
            const report = `TeslaCamViewer Bug Report\n${JSON.stringify(info, null, 2)}`;
            try {
                await navigator.clipboard.writeText(report);
                alert('Basic diagnostic info copied to clipboard!');
            } catch (err) {
                console.error('Failed to copy:', err);
                alert('Could not copy to clipboard. Please manually describe your issue.');
            }
        }
    }

    /**
     * Hide the help modal
     */
    hide() {
        if (this.modal) {
            this.modal.classList.add('hidden');
        }
    }

    /**
     * Toggle the help modal
     */
    toggle() {
        if (this.modal && !this.modal.classList.contains('hidden')) {
            this.hide();
        } else {
            this.show();
        }
    }
}

// Export for use in app.js
window.HelpModal = HelpModal;
