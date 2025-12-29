/**
 * Help Modal - Displays keyboard shortcuts and help information
 */
class HelpModal {
    constructor() {
        this.modal = null;
    }

    /**
     * Create and show the help modal
     */
    show() {
        if (this.modal) {
            this.modal.classList.remove('hidden');
            return;
        }

        this.modal = document.createElement('div');
        this.modal.className = 'help-modal';
        this.modal.innerHTML = `
            <div class="help-overlay"></div>
            <div class="help-panel">
                <div class="help-header">
                    <h2>Keyboard Shortcuts</h2>
                    <button class="help-close-btn" title="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
                <div class="help-content">
                    <!-- Playback Shortcuts -->
                    <div class="help-section">
                        <h3>Playback</h3>
                        <div class="shortcut-grid">
                            <div class="shortcut-row">
                                <kbd>Space</kbd>
                                <span>Play / Pause</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>Left Arrow</kbd>
                                <span>Previous frame</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>Right Arrow</kbd>
                                <span>Next frame</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>Hold Left/Right</kbd>
                                <span>Slow motion playback</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>Shift + Left</kbd>
                                <span>Previous clip</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>Shift + Right</kbd>
                                <span>Next clip</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>Home</kbd>
                                <span>Go to start</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>End</kbd>
                                <span>Go to end</span>
                            </div>
                        </div>
                    </div>

                    <!-- Navigation Shortcuts -->
                    <div class="help-section">
                        <h3>Navigation</h3>
                        <div class="shortcut-grid">
                            <div class="shortcut-row">
                                <kbd>Page Up</kbd>
                                <span>Previous event</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>Page Down</kbd>
                                <span>Next event</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>Up Arrow</kbd>
                                <span>Select previous event</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>Down Arrow</kbd>
                                <span>Select next event</span>
                            </div>
                        </div>
                    </div>

                    <!-- View Shortcuts -->
                    <div class="help-section">
                        <h3>View & Layout</h3>
                        <div class="shortcut-grid">
                            <div class="shortcut-row">
                                <kbd>L</kbd>
                                <span>Cycle layouts</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>1-4</kbd>
                                <span>Focus camera (1=Front, 2=Back, 3=Left, 4=Right)</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>F</kbd>
                                <span>Toggle fullscreen</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>Double-click video</kbd>
                                <span>Focus camera fullscreen</span>
                            </div>
                        </div>
                    </div>

                    <!-- Marking & Export -->
                    <div class="help-section">
                        <h3>Marking & Export</h3>
                        <div class="shortcut-grid">
                            <div class="shortcut-row">
                                <kbd>I</kbd>
                                <span>Mark in point</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>O</kbd>
                                <span>Mark out point</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>Esc</kbd>
                                <span>Clear marks</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>S</kbd>
                                <span>Take screenshot</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>E</kbd>
                                <span>Export video</span>
                            </div>
                        </div>
                    </div>

                    <!-- Bookmarks -->
                    <div class="help-section">
                        <h3>Bookmarks</h3>
                        <div class="shortcut-grid">
                            <div class="shortcut-row">
                                <kbd>B</kbd>
                                <span>Add bookmark at current position</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>[</kbd>
                                <span>Jump to previous bookmark</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>]</kbd>
                                <span>Jump to next bookmark</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>Scroll on timeline</kbd>
                                <span>Zoom in/out (if enabled in settings)</span>
                            </div>
                        </div>
                    </div>

                    <!-- Speed Control -->
                    <div class="help-section">
                        <h3>Speed Control</h3>
                        <div class="shortcut-grid">
                            <div class="shortcut-row">
                                <kbd>+</kbd> or <kbd>=</kbd>
                                <span>Increase speed</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>-</kbd>
                                <span>Decrease speed</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>0</kbd>
                                <span>Reset to 1x speed</span>
                            </div>
                        </div>
                    </div>

                    <!-- General -->
                    <div class="help-section">
                        <h3>General</h3>
                        <div class="shortcut-grid">
                            <div class="shortcut-row">
                                <kbd>?</kbd> or <kbd>H</kbd>
                                <span>Show this help</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>,</kbd>
                                <span>Open settings</span>
                            </div>
                            <div class="shortcut-row">
                                <kbd>Esc</kbd>
                                <span>Close modal / Clear marks</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="help-footer">
                    <span class="help-tip">Tip: Most keyboard shortcuts only work when not typing in a text field</span>
                </div>
            </div>
        `;

        document.body.appendChild(this.modal);
        this.bindEvents();
    }

    /**
     * Bind modal events
     */
    bindEvents() {
        const closeBtn = this.modal.querySelector('.help-close-btn');
        const overlay = this.modal.querySelector('.help-overlay');

        const close = () => this.hide();

        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', close);

        // ESC to close
        const escHandler = (e) => {
            if (e.key === 'Escape' && this.modal && !this.modal.classList.contains('hidden')) {
                close();
            }
        };
        document.addEventListener('keydown', escHandler);
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
