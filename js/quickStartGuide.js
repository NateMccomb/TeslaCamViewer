/**
 * QuickStartGuide - First-run tutorial overlay
 */

class QuickStartGuide {
    constructor() {
        this.STORAGE_KEY = 'teslacamviewer_quickstart_shown';
        this.modal = null;
        this.currentStep = 0;
        this.steps = [
            {
                title: 'Welcome to TeslaCam Viewer',
                content: `
                    <p>View and manage your Tesla dashcam footage directly in your browser.</p>
                    <p style="color: var(--accent); margin-top: 1rem;">
                        <strong>No upload required</strong> - your videos stay on your computer.
                    </p>
                `,
                icon: '🚗'
            },
            {
                title: 'Step 1: Select Your TeslaCam Folder',
                content: `
                    <p>Click the <strong>"Select TeslaCam Folder"</strong> button to choose your USB drive or folder containing TeslaCam data.</p>
                    <p style="margin-top: 0.5rem; color: var(--text-secondary);">
                        Look for folders named <code>TeslaCam</code>, <code>SavedClips</code>, <code>SentryClips</code>, or <code>RecentClips</code>.
                    </p>
                `,
                icon: '📁'
            },
            {
                title: 'Step 2: Browse Events',
                content: `
                    <p>Events appear in the left sidebar, sorted by date. Click any event to load it.</p>
                    <ul style="margin-top: 0.5rem; text-align: left; padding-left: 1.5rem;">
                        <li><strong>SavedClips</strong> - Manual saves from dashcam</li>
                        <li><strong>SentryClips</strong> - Motion-triggered recordings</li>
                        <li><strong>RecentClips</strong> - Rolling buffer footage</li>
                    </ul>
                `,
                icon: '📋'
            },
            {
                title: 'Step 3: View 4 Cameras',
                content: `
                    <p>Watch all 4 camera angles synchronized: Front, Back, Left, and Right.</p>
                    <p style="margin-top: 0.5rem; color: var(--text-secondary);">
                        <strong>Tip:</strong> Drag cameras to swap positions, or hide cameras you don't need.
                    </p>
                `,
                icon: '📹'
            },
            {
                title: 'Keyboard Shortcuts',
                content: `
                    <div style="display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem; text-align: left; max-width: 280px; margin: 0 auto;">
                        <kbd>Space</kbd><span>Play / Pause</span>
                        <kbd>← / →</kbd><span>Seek 5 seconds</span>
                        <kbd>S</kbd><span>Screenshot</span>
                        <kbd>P</kbd><span>Picture-in-Picture</span>
                        <kbd>I / O</kbd><span>Mark In / Out</span>
                        <kbd>E</kbd><span>Export</span>
                        <kbd>?</kbd><span>Show all shortcuts</span>
                    </div>
                `,
                icon: '⌨️'
            }
        ];
    }

    /**
     * Check if guide should be shown (first run)
     */
    shouldShow() {
        return !localStorage.getItem(this.STORAGE_KEY);
    }

    /**
     * Mark guide as shown
     */
    markAsShown() {
        localStorage.setItem(this.STORAGE_KEY, 'true');
    }

    /**
     * Show the guide if first run
     */
    showIfFirstRun() {
        if (this.shouldShow()) {
            this.show();
        }
    }

    /**
     * Show the guide
     */
    show() {
        this.currentStep = 0;
        this.createModal();
        this.renderStep();
    }

    /**
     * Hide the guide
     */
    hide() {
        if (this.modal) {
            this.modal.classList.add('hidden');
            setTimeout(() => {
                this.modal.remove();
                this.modal = null;
            }, 300);
        }
        this.markAsShown();
    }

    /**
     * Create the modal element
     */
    createModal() {
        if (this.modal) {
            this.modal.remove();
        }

        this.modal = document.createElement('div');
        this.modal.className = 'quickstart-modal';
        this.modal.innerHTML = `
            <div class="quickstart-overlay"></div>
            <div class="quickstart-panel">
                <button class="quickstart-skip" title="Skip tutorial">Skip</button>
                <div class="quickstart-icon"></div>
                <h2 class="quickstart-title"></h2>
                <div class="quickstart-content"></div>
                <div class="quickstart-progress">
                    ${this.steps.map((_, i) => `<div class="quickstart-dot" data-step="${i}"></div>`).join('')}
                </div>
                <div class="quickstart-buttons">
                    <button class="quickstart-btn secondary" id="quickstartPrev">Previous</button>
                    <button class="quickstart-btn primary" id="quickstartNext">Next</button>
                </div>
            </div>
        `;

        document.body.appendChild(this.modal);

        // Bind events
        this.modal.querySelector('.quickstart-overlay').addEventListener('click', () => this.hide());
        this.modal.querySelector('.quickstart-skip').addEventListener('click', () => this.hide());
        this.modal.querySelector('#quickstartPrev').addEventListener('click', () => this.prevStep());
        this.modal.querySelector('#quickstartNext').addEventListener('click', () => this.nextStep());

        // Dot navigation
        this.modal.querySelectorAll('.quickstart-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                this.currentStep = parseInt(dot.dataset.step);
                this.renderStep();
            });
        });

        // Fade in
        requestAnimationFrame(() => {
            this.modal.classList.add('visible');
        });
    }

    /**
     * Render current step
     */
    renderStep() {
        const step = this.steps[this.currentStep];
        const panel = this.modal.querySelector('.quickstart-panel');

        panel.querySelector('.quickstart-icon').textContent = step.icon;
        panel.querySelector('.quickstart-title').textContent = step.title;
        panel.querySelector('.quickstart-content').innerHTML = step.content;

        // Update progress dots
        this.modal.querySelectorAll('.quickstart-dot').forEach((dot, i) => {
            dot.classList.toggle('active', i === this.currentStep);
        });

        // Update buttons
        const prevBtn = this.modal.querySelector('#quickstartPrev');
        const nextBtn = this.modal.querySelector('#quickstartNext');

        prevBtn.style.visibility = this.currentStep === 0 ? 'hidden' : 'visible';
        nextBtn.textContent = this.currentStep === this.steps.length - 1 ? 'Get Started' : 'Next';
    }

    /**
     * Go to previous step
     */
    prevStep() {
        if (this.currentStep > 0) {
            this.currentStep--;
            this.renderStep();
        }
    }

    /**
     * Go to next step
     */
    nextStep() {
        if (this.currentStep < this.steps.length - 1) {
            this.currentStep++;
            this.renderStep();
        } else {
            this.hide();
        }
    }

    /**
     * Reset guide (for testing)
     */
    reset() {
        localStorage.removeItem(this.STORAGE_KEY);
    }
}
