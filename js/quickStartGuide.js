/**
 * QuickStartGuide - First-run tutorial overlay with i18n support
 */

class QuickStartGuide {
    constructor() {
        this.STORAGE_KEY = 'teslacamviewer_quickstart_shown';
        this.modal = null;
        this.currentStep = 0;

        // Listen for locale changes to re-render
        window.addEventListener('localeChanged', () => {
            if (this.modal) {
                this.renderStep();
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
     * Get steps with translated content
     */
    getSteps() {
        return [
            {
                title: this.t('quickstart.welcome.title'),
                content: `
                    <p>${this.t('quickstart.welcome.description')}</p>
                    <p style="color: var(--accent); margin-top: 1rem;">
                        <strong>${this.t('quickstart.welcome.noUpload')}</strong> - ${this.t('quickstart.welcome.videosStay')}
                    </p>
                    <div class="quickstart-language-selector" style="margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--border);">
                        <label for="quickstartLanguage" style="color: var(--text-secondary); font-size: 0.9rem; margin-right: 0.5rem;">${this.t('quickstart.welcome.language')}:</label>
                        <select id="quickstartLanguage" class="quickstart-language-select" style="background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 6px; padding: 0.4rem 0.6rem; font-size: 0.9rem; cursor: pointer;">
                            <option value="en">English</option>
                            <option value="es">Español</option>
                            <option value="de">Deutsch</option>
                            <option value="fr">Français</option>
                            <option value="zh">中文</option>
                            <option value="ja">日本語</option>
                            <option value="ko">한국어</option>
                            <option value="nl">Nederlands</option>
                            <option value="no">Norsk</option>
                        </select>
                    </div>
                `,
                icon: '🚗'
            },
            {
                title: this.t('quickstart.step1.title'),
                content: `
                    <p>${this.t('quickstart.step1.description')}</p>
                    <p style="margin-top: 0.5rem; color: var(--text-secondary);">
                        ${this.t('quickstart.step1.hint')}
                    </p>
                `,
                icon: '📁'
            },
            {
                title: this.t('quickstart.step2.title'),
                content: `
                    <p>${this.t('quickstart.step2.description')}</p>
                    <ul style="margin-top: 0.5rem; text-align: left; padding-left: 1.5rem;">
                        <li><strong>SavedClips</strong> - ${this.t('quickstart.step2.saved')}</li>
                        <li><strong>SentryClips</strong> - ${this.t('quickstart.step2.sentry')}</li>
                        <li><strong>RecentClips</strong> - ${this.t('quickstart.step2.recent')}</li>
                    </ul>
                `,
                icon: '📋'
            },
            {
                title: this.t('quickstart.step3.title'),
                content: `
                    <p>${this.t('quickstart.step3.description')}</p>
                    <p style="margin-top: 0.5rem; color: var(--text-secondary);">
                        <strong>${this.t('quickstart.step3.tip')}:</strong> ${this.t('quickstart.step3.tipText')}
                    </p>
                `,
                icon: '📹'
            },
            {
                title: this.t('quickstart.shortcuts.title'),
                content: `
                    <div style="display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem; text-align: left; max-width: 280px; margin: 0 auto;">
                        <kbd>Space</kbd><span>${this.t('quickstart.shortcuts.playPause')}</span>
                        <kbd>← / →</kbd><span>${this.t('quickstart.shortcuts.seek')}</span>
                        <kbd>S</kbd><span>${this.t('quickstart.shortcuts.screenshot')}</span>
                        <kbd>I / O</kbd><span>${this.t('quickstart.shortcuts.markInOut')}</span>
                        <kbd>E</kbd><span>${this.t('quickstart.shortcuts.export')}</span>
                        <kbd>?</kbd><span>${this.t('quickstart.shortcuts.showAll')}</span>
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

        const steps = this.getSteps();

        this.modal = document.createElement('div');
        this.modal.className = 'quickstart-modal';
        this.modal.innerHTML = `
            <div class="quickstart-overlay"></div>
            <div class="quickstart-panel">
                <button class="quickstart-skip" title="${this.t('quickstart.skip')}">${this.t('quickstart.skip')}</button>
                <div class="quickstart-icon"></div>
                <h2 class="quickstart-title"></h2>
                <div class="quickstart-content"></div>
                <div class="quickstart-progress">
                    ${steps.map((_, i) => `<div class="quickstart-dot" data-step="${i}"></div>`).join('')}
                </div>
                <div class="quickstart-buttons">
                    <button class="quickstart-btn secondary" id="quickstartPrev">${this.t('quickstart.previous')}</button>
                    <button class="quickstart-btn primary" id="quickstartNext">${this.t('quickstart.next')}</button>
                </div>
            </div>
        `;

        document.body.appendChild(this.modal);

        // Bind events
        // Only close if click started AND ended on overlay (prevents close during text selection)
        const overlay = this.modal.querySelector('.quickstart-overlay');
        let mouseDownOnOverlay = false;
        overlay.addEventListener('mousedown', (e) => {
            mouseDownOnOverlay = e.target === overlay;
        });
        overlay.addEventListener('click', (e) => {
            if (mouseDownOnOverlay && e.target === overlay) {
                this.hide();
            }
        });
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

        // Language selector - use event delegation on panel
        const panel = this.modal.querySelector('.quickstart-panel');
        panel.addEventListener('change', async (e) => {
            if (e.target.id === 'quickstartLanguage' && window.i18n) {
                await window.i18n.setLocale(e.target.value);
            }
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
        const steps = this.getSteps();
        const step = steps[this.currentStep];
        const panel = this.modal.querySelector('.quickstart-panel');

        panel.querySelector('.quickstart-icon').textContent = step.icon;
        panel.querySelector('.quickstart-title').textContent = step.title;
        panel.querySelector('.quickstart-content').innerHTML = step.content;

        // Update skip button text
        panel.querySelector('.quickstart-skip').textContent = this.t('quickstart.skip');
        panel.querySelector('.quickstart-skip').title = this.t('quickstart.skip');

        // Update progress dots
        this.modal.querySelectorAll('.quickstart-dot').forEach((dot, i) => {
            dot.classList.toggle('active', i === this.currentStep);
        });

        // Update buttons
        const prevBtn = this.modal.querySelector('#quickstartPrev');
        const nextBtn = this.modal.querySelector('#quickstartNext');

        prevBtn.textContent = this.t('quickstart.previous');
        prevBtn.style.visibility = this.currentStep === 0 ? 'hidden' : 'visible';
        nextBtn.textContent = this.currentStep === steps.length - 1 ? this.t('quickstart.getStarted') : this.t('quickstart.next');

        // Set language selector value on first step
        if (this.currentStep === 0) {
            const langSelect = panel.querySelector('#quickstartLanguage');
            if (langSelect && window.i18n) {
                langSelect.value = window.i18n.getLocale();
            }
        }
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
        const steps = this.getSteps();
        if (this.currentStep < steps.length - 1) {
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
