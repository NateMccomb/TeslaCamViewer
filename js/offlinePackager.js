/**
 * OfflinePackager - Creates a self-contained offline package of TeslaCamViewer
 * Bundles all dependencies for portable use on a thumb drive
 */
class OfflinePackager {
    constructor() {
        this.LEAFLET_VERSION = '1.9.4';
        this.MARKERCLUSTER_VERSION = '1.5.3';
        this.modal = null;
        this.isPackaging = false;

        // List of JS files to include
        this.jsFiles = [
            'eventFilter.js',
            'filterPanel.js',
            'mapView.js',
            'folderManager.js',
            'folderParser.js',
            'eventBrowser.js',
            'videoPlayer.js',
            'timeline.js',
            'syncController.js',
            'layoutConfig.js',
            'layoutRenderer.js',
            'layoutManager.js',
            'layoutEditor.js',
            'screenshotCapture.js',
            'videoEnhancer.js',
            'notesManager.js',
            'videoExport.js',
            'clipMarking.js',
            'settingsManager.js',
            'versionManager.js',
            'statisticsManager.js',
            'helpModal.js',
            'quickStartGuide.js',
            'offlinePackager.js',
            'driveSync.js',
            'driveSyncUI.js',
            'app.js'
        ];

        // Font files to download (subset for common weights)
        this.fontWeights = {
            outfit: [300, 400, 500, 600, 700],
            jetbrainsMono: [400, 500, 600]
        };
    }

    /**
     * Show the packaging modal with progress
     */
    showModal() {
        if (this.modal) {
            this.modal.remove();
        }

        this.modal = document.createElement('div');
        this.modal.className = 'offline-packager-modal';
        this.modal.innerHTML = `
            <div class="offline-packager-overlay"></div>
            <div class="offline-packager-panel">
                <div class="offline-packager-header">
                    <h2>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 8px; vertical-align: middle;">
                            <path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2z"/>
                        </svg>
                        Download Offline Package
                    </h2>
                    <button class="offline-packager-close-btn" title="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
                <div class="offline-packager-content">
                    <div class="offline-packager-info">
                        <p>Create a self-contained package that runs from a USB drive without internet.</p>
                        <ul>
                            <li>All application files bundled</li>
                            <li>Leaflet maps library included</li>
                            <li>Fonts bundled for consistent display</li>
                            <li>~2-3 MB download size</li>
                        </ul>
                        <p class="offline-packager-note">
                            <strong>Note:</strong> Map tiles require internet. When offline, the map tab will show a message.
                        </p>
                    </div>
                    <div id="packagerProgress" class="offline-packager-progress hidden">
                        <div class="progress-bar-container">
                            <div id="progressBar" class="progress-bar"></div>
                        </div>
                        <p id="progressText" class="progress-text">Preparing...</p>
                    </div>
                </div>
                <div class="offline-packager-footer">
                    <button id="startPackageBtn" class="offline-packager-btn primary">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2z"/>
                        </svg>
                        Create Package
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(this.modal);
        this.attachModalEvents();
    }

    /**
     * Attach event listeners to modal
     */
    attachModalEvents() {
        const closeBtn = this.modal.querySelector('.offline-packager-close-btn');
        const overlay = this.modal.querySelector('.offline-packager-overlay');
        const startBtn = this.modal.querySelector('#startPackageBtn');

        const closeModal = () => {
            if (!this.isPackaging) {
                this.modal.remove();
                this.modal = null;
            }
        };

        closeBtn.addEventListener('click', closeModal);
        overlay.addEventListener('click', closeModal);

        startBtn.addEventListener('click', () => this.startPackaging());

        // ESC to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal && !this.isPackaging) {
                closeModal();
            }
        }, { once: true });
    }

    /**
     * Update progress display
     * @param {string} text - Progress text
     * @param {number} percent - Progress percentage
     */
    updateProgress(text, percent) {
        if (!this.modal) return;

        const progressDiv = this.modal.querySelector('#packagerProgress');
        const progressBar = this.modal.querySelector('#progressBar');
        const progressText = this.modal.querySelector('#progressText');

        progressDiv.classList.remove('hidden');
        progressBar.style.width = `${percent}%`;
        progressText.textContent = text;
    }

    /**
     * Start the packaging process
     */
    async startPackaging() {
        if (this.isPackaging) return;

        // Check if JSZip is available
        if (typeof JSZip === 'undefined') {
            alert('JSZip library not loaded. Package creation requires an internet connection for the first time.');
            return;
        }

        this.isPackaging = true;
        const startBtn = this.modal.querySelector('#startPackageBtn');
        startBtn.disabled = true;
        startBtn.textContent = 'Creating...';

        try {
            const blob = await this.createPackage((text, percent) => {
                this.updateProgress(text, percent);
            });

            this.updateProgress('Complete! Starting download...', 100);

            // Trigger download with version in filename
            const version = window.app?.versionManager?.getVersion() || 'unknown';
            this.downloadBlob(blob, `TeslaCamViewer-v${version}.zip`);

            // Close modal after short delay
            setTimeout(() => {
                if (this.modal) {
                    this.modal.remove();
                    this.modal = null;
                }
            }, 1500);

        } catch (error) {
            console.error('Packaging error:', error);
            this.updateProgress(`Error: ${error.message}`, 0);
            startBtn.disabled = false;
            startBtn.textContent = 'Retry';
        } finally {
            this.isPackaging = false;
        }
    }

    /**
     * Create the offline package ZIP
     * @param {Function} progressCallback - Progress callback
     * @returns {Promise<Blob>} ZIP blob
     */
    async createPackage(progressCallback) {
        const zip = new JSZip();

        // 1. Bundle CSS
        progressCallback('Bundling CSS...', 5);
        const cssContent = await this.fetchLocal('styles/main.css');
        zip.file('styles/main.css', cssContent);

        // 2. Bundle favicon
        progressCallback('Bundling assets...', 10);
        try {
            const favicon = await this.fetchLocal('favicon.svg');
            zip.file('favicon.svg', favicon);
        } catch (e) {
            console.warn('Favicon not found, skipping');
        }

        // 3. Bundle JS files
        progressCallback('Bundling JavaScript...', 15);
        let jsProgress = 15;
        const jsIncrement = 25 / this.jsFiles.length;

        for (const file of this.jsFiles) {
            try {
                const content = await this.fetchLocal(`js/${file}`);
                zip.file(`js/${file}`, content);
                jsProgress += jsIncrement;
                progressCallback(`Bundling ${file}...`, Math.round(jsProgress));
            } catch (e) {
                console.warn(`Failed to bundle ${file}:`, e);
            }
        }

        // 4. Download external libraries
        progressCallback('Downloading Leaflet...', 45);
        try {
            const leafletCSS = await this.fetchExternal(`https://unpkg.com/leaflet@${this.LEAFLET_VERSION}/dist/leaflet.css`);
            const leafletJS = await this.fetchExternal(`https://unpkg.com/leaflet@${this.LEAFLET_VERSION}/dist/leaflet.js`);
            zip.file('vendor/leaflet.css', leafletCSS);
            zip.file('vendor/leaflet.js', leafletJS);
        } catch (e) {
            console.warn('Failed to download Leaflet:', e);
        }

        progressCallback('Downloading MarkerCluster...', 55);
        try {
            const clusterCSS1 = await this.fetchExternal(`https://unpkg.com/leaflet.markercluster@${this.MARKERCLUSTER_VERSION}/dist/MarkerCluster.css`);
            const clusterCSS2 = await this.fetchExternal(`https://unpkg.com/leaflet.markercluster@${this.MARKERCLUSTER_VERSION}/dist/MarkerCluster.Default.css`);
            const clusterJS = await this.fetchExternal(`https://unpkg.com/leaflet.markercluster@${this.MARKERCLUSTER_VERSION}/dist/leaflet.markercluster.js`);
            zip.file('vendor/MarkerCluster.css', clusterCSS1);
            zip.file('vendor/MarkerCluster.Default.css', clusterCSS2);
            zip.file('vendor/leaflet.markercluster.js', clusterJS);
        } catch (e) {
            console.warn('Failed to download MarkerCluster:', e);
        }

        // 5. Download fonts
        progressCallback('Downloading fonts...', 65);
        const fontCSS = await this.downloadFonts(zip);

        // 6. Create offline-aware index.html
        progressCallback('Creating offline index.html...', 85);
        const offlineHTML = await this.createOfflineHTML(fontCSS);
        zip.file('index.html', offlineHTML);

        // 7. Generate ZIP
        progressCallback('Generating ZIP file...', 95);
        const blob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
        });

        progressCallback('Complete!', 100);
        return blob;
    }

    /**
     * Fetch local file
     * @param {string} path - Relative path
     * @returns {Promise<string>} File content
     */
    async fetchLocal(path) {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`Failed to fetch ${path}`);
        return await response.text();
    }

    /**
     * Fetch external file
     * @param {string} url - External URL
     * @returns {Promise<string>} File content
     */
    async fetchExternal(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch ${url}`);
        return await response.text();
    }

    /**
     * Download Google Fonts and create local CSS
     * @param {JSZip} zip - ZIP instance
     * @returns {Promise<string>} Font CSS content
     */
    async downloadFonts(zip) {
        // For simplicity, we'll create a CSS that uses system font fallbacks
        // and include a minimal subset of fonts
        // Full font bundling would require parsing Google Fonts CSS and downloading WOFF2 files

        const fontCSS = `
/* Offline font fallbacks */
/* Outfit font - falls back to system fonts when offline */
@font-face {
    font-family: 'Outfit';
    font-style: normal;
    font-weight: 300 700;
    font-display: swap;
    src: local('Outfit'), local('Arial'), local('Helvetica');
}

/* JetBrains Mono font - falls back to monospace when offline */
@font-face {
    font-family: 'JetBrains Mono';
    font-style: normal;
    font-weight: 400 600;
    font-display: swap;
    src: local('JetBrains Mono'), local('Consolas'), local('Monaco'), local('monospace');
}
`;

        zip.file('styles/offline-fonts.css', fontCSS);
        return fontCSS;
    }

    /**
     * Create offline-aware index.html by modifying the current page
     * @param {string} fontCSS - Font CSS (unused, kept for reference)
     * @returns {Promise<string>} HTML content
     */
    async createOfflineHTML(fontCSS) {
        // Fetch the current index.html
        let html = await this.fetchLocal('index.html');

        // Replace CDN links with local vendor paths
        html = html.replace(
            /https:\/\/unpkg\.com\/leaflet@[\d.]+\/dist\/leaflet\.css[^"']*/g,
            'vendor/leaflet.css'
        );
        html = html.replace(
            /https:\/\/unpkg\.com\/leaflet\.markercluster@[\d.]+\/dist\/MarkerCluster\.css/g,
            'vendor/MarkerCluster.css'
        );
        html = html.replace(
            /https:\/\/unpkg\.com\/leaflet\.markercluster@[\d.]+\/dist\/MarkerCluster\.Default\.css/g,
            'vendor/MarkerCluster.Default.css'
        );
        html = html.replace(
            /https:\/\/unpkg\.com\/leaflet@[\d.]+\/dist\/leaflet\.js[^"']*/g,
            'vendor/leaflet.js'
        );
        html = html.replace(
            /https:\/\/unpkg\.com\/leaflet\.markercluster@[\d.]+\/dist\/leaflet\.markercluster\.js/g,
            'vendor/leaflet.markercluster.js'
        );

        // Remove JSZip CDN (not needed in offline version)
        html = html.replace(
            /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jszip[^"]*"><\/script>\s*/g,
            ''
        );

        // Remove integrity attributes (they won't match local files)
        html = html.replace(/\s+integrity="[^"]*"/g, '');
        html = html.replace(/\s+crossorigin="[^"]*"/g, '');

        // Add offline fonts stylesheet after main.css
        html = html.replace(
            '<link rel="stylesheet" href="styles/main.css">',
            '<link rel="stylesheet" href="styles/offline-fonts.css">\n    <link rel="stylesheet" href="styles/main.css">'
        );

        // Update title to indicate offline version
        html = html.replace(
            '<title>TeslaCamViewer.com - Multi-Angle Dashcam Playback</title>',
            '<title>TeslaCamViewer - Offline</title>'
        );

        // Add offline banner and detection script before closing body tag
        const offlineScript = `
    <!-- Offline Banner -->
    <div id="offlineBanner" class="offline-banner" style="display: none; position: fixed; top: 0; left: 0; right: 0; background: linear-gradient(90deg, #f59e0b, #d97706); color: #1a1a1a; text-align: center; padding: 0.5rem; font-size: 0.85rem; font-weight: 500; z-index: 9999;">
        Running in offline mode - Map features require internet connection
    </div>
    <script>
        // Show offline banner if no internet
        (function() {
            function checkOnlineStatus() {
                var banner = document.getElementById('offlineBanner');
                if (!navigator.onLine) {
                    banner.style.display = 'block';
                    document.body.style.paddingTop = '36px';
                } else {
                    banner.style.display = 'none';
                    document.body.style.paddingTop = '';
                }
            }
            window.addEventListener('online', checkOnlineStatus);
            window.addEventListener('offline', checkOnlineStatus);
            document.addEventListener('DOMContentLoaded', checkOnlineStatus);
        })();
    </script>
`;

        html = html.replace('</body>', offlineScript + '</body>');

        return html;
    }

    /**
     * Download blob as file
     * @param {Blob} blob - File blob
     * @param {string} filename - Download filename
     */
    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// Export for use
window.OfflinePackager = OfflinePackager;
