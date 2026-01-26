/**
 * Internationalization (i18n) Module
 * Provides translation support for TeslaCamViewer
 * Config: 9 locales, 300+ strings
 */

// Embedded English fallback for file:// protocol (CORS doesn't allow fetch)
const EMBEDDED_EN_FALLBACK = {"app":{"title":"TeslaCamViewer.com","description":"View Tesla dashcam footage with synchronized camera playback"},"header":{"github":"GitHub","donate":"Donate","statistics":"Statistics","keyboardShortcuts":"Keyboard Shortcuts (?)","settings":"Settings (,)","viewOnGitHub":"View on GitHub","supportProject":"Support this project"},"sidebar":{"events":"Events","map":"Map","allDrives":"All Drives","addDrive":"Add another drive","manageDrives":"Manage drives","syncDrives":"Sync between drives","selectFolder":"Select TeslaCam Folder","emptyState":"Click \"Select TeslaCam Folder\" to get started","emptyStateHint":"You can select the TeslaCam folder, or any parent/child folder containing Tesla dashcam footage"},"player":{"noEventSelected":"No event selected","selectEventHint":"Select an event from the sidebar to start viewing","noEventLoaded":"No event loaded","hidden":"Hidden:","fullscreen":"Fullscreen","exitFullscreen":"Exit fullscreen"},"cameras":{"front":"Front","back":"Back","left":"Left","right":"Right","leftPillar":"Left Pillar","rightPillar":"Right Pillar","hideFront":"Hide Front Camera","hideBack":"Hide Back Camera","hideLeft":"Hide Left Camera","hideRight":"Hide Right Camera","hideLeftPillar":"Hide Left Pillar Camera","hideRightPillar":"Hide Right Pillar Camera"},"controls":{"play":"Play","pause":"Pause","previousFrame":"Previous Frame (Hold for slow-mo)","nextFrame":"Next Frame (Hold for slow-mo)","previousClip":"Previous Clip","nextClip":"Next Clip","previousEvent":"Previous Event","nextEvent":"Next Event","screenshot":"Capture Screenshot","pip":"Picture-in-Picture (P)","enhance":"Video Enhancement","markIn":"Mark In Point","markOut":"Mark Out Point","clearMarks":"Clear Marks","export":"Export All Cameras","exportOptions":"Export Options","zoomOut":"Zoom Out Timeline","zoomIn":"Zoom In Timeline","resetZoom":"Reset Zoom","loop":"Loop","speed":"Speed:","layout":"Layout:","camera":"Camera:","cyclePillarTitle":"Cycle between Repeaters and Pillars (Shift+P)","repeaters":"Repeaters","pillars":"Pillars"},"bookmarks":{"title":"Bookmarks","previous":"Previous Bookmark ([)","add":"Add Bookmark (B)","next":"Next Bookmark (])","manage":"Manage Bookmarks","clearAll":"Clear All","noBookmarks":"No bookmarks yet","bookmark":{"one":"{{count}} bookmark","other":"{{count}} bookmarks"}},"export":{"header":"Export Camera","allCameras":"All Cameras (Grid)","frontOnly":"Front Only","rearOnly":"Rear Only","leftOnly":"Left Only","rightOnly":"Right Only","insuranceReport":"Insurance Report (PDF)","generatingReport":"Generating Insurance Report...","leftPillarOnly":"Left Pillar Only","rightPillarOnly":"Right Pillar Only","exporting":"Exporting {{percent}}%","preparing":"Preparing export...","encoding":"Encoding video...","complete":"Export complete","cancelled":"Export cancelled","failed":"Export failed"},"layouts":{"grid2x2":"2×2 Grid","grid3x2":"3×2 Grid (6 Cam)","layout63":"6:3 Centered","layout43":"4:3 Main","all169":"All 16:9","frontLeft":"Front + Left","frontRight":"Front + Right","frontRepeaters":"Front + Repeaters","focus":"Focus Mode"},"loading":{"loading":"Loading...","buffering":"Buffering...","bufferHealth":"Buffer Health"},"notes":{"title":"Notes & Tags (N)","notes":"Notes","tags":"Tags","tagPlaceholder":"Type tag, press Enter or click +","addTag":"Add tag","existingTags":"Existing tags","placeholder":"Add notes about this event..."},"help":{"title":"Keyboard Shortcuts","close":"Close","tip":"Tip: Most keyboard shortcuts only work when not typing in a text field","sections":{"playback":"Playback","navigation":"Navigation","viewLayout":"View & Layout","markingExport":"Marking & Export","bookmarks":"Bookmarks","speedControl":"Speed Control","general":"General"},"shortcuts":{"playPause":"Play / Pause","previousFrame":"Previous frame","nextFrame":"Next frame","slowMotion":"Slow motion playback","previousClip":"Previous clip","nextClip":"Next clip","goToStart":"Go to start","goToEnd":"Go to end","previousEvent":"Previous event","nextEvent":"Next event","selectPreviousEvent":"Select previous event","selectNextEvent":"Select next event","cycleLayouts":"Cycle layouts","focusCamera":"Focus camera (1=Front, 2=Back, 3=Left, 4=Right)","cyclePillarMode":"Cycle Repeaters/Pillars (when available)","toggleFullscreen":"Toggle fullscreen","focusCameraFullscreen":"Focus camera fullscreen","markIn":"Mark in point","markOut":"Mark out point","clearMarks":"Clear marks","takeScreenshot":"Take screenshot","exportVideo":"Export video","addBookmark":"Add bookmark at current position","jumpToPreviousBookmark":"Jump to previous bookmark","jumpToNextBookmark":"Jump to next bookmark","zoomTimeline":"Zoom in/out (if enabled in settings)","increaseSpeed":"Increase speed","decreaseSpeed":"Decrease speed","resetSpeed":"Reset to 1x speed","showHelp":"Show this help","openSettings":"Open settings","closeModal":"Close modal / Clear marks"}},"settings":{"title":"Settings","close":"Close","done":"Done","resetToDefaults":"Reset to Defaults","confirmReset":"Reset all settings to defaults?","sections":{"playback":"Playback","performance":"Performance","ui":"User Interface","timeline":"Timeline","session":"Session","offline":"Offline Mode","accessibility":"Accessibility","mobile":"Mobile","export":"Export","language":"Language"},"playback":{"defaultSpeed":"Default Speed","defaultLayout":"Default Layout","autoPlayNext":"Auto-play next event","loopByDefault":"Loop by default"},"performance":{"preloadNextClip":"Preload next clip","preloadHint":"Smoother playback, uses more memory","memoryOptimization":"Memory optimization","memoryHint":"Release unused video resources"},"ui":{"theme":"Theme","themeDark":"Dark (Default)","themeLight":"Light","themeMidnight":"Midnight","themeTeslaRed":"Tesla Red","showKeyboardHints":"Show keyboard hints","showTimestampOverlay":"Show timestamp overlay","showWhatsNew":"Show \"What's New\" indicators","whatsNewHint":"Blue dots on new features, update notifications"},"timeline":{"enableZoom":"Enable timeline zoom","zoomHint":"Scroll to zoom in/out on timeline","showClipMarkers":"Show clip markers"},"session":{"rememberLastFolder":"Remember last folder","folderHint":"Requires folder permission on reload"},"offline":{"downloadPackage":"Download Offline Package","downloadHint":"Create a self-contained version for USB drives (~2-3 MB)","download":"Download","mapNote":"Includes all app files and libraries. Map requires internet connection.","notAvailable":"Offline packager not available. Please reload the page and try again."},"accessibility":{"highContrast":"High contrast mode","highContrastHint":"Increases text and border contrast","textSize":"Text size","textSmall":"Small","textMedium":"Medium (Default)","textLarge":"Large"},"mobile":{"lockLandscape":"Lock landscape during playback","lockHint":"Lock screen to landscape while video is playing (mobile only)"},"export":{"videoFormat":"Video Format","webm":"WebM (VP9) - Smaller files","mp4":"MP4 (H.264) - Better compatibility","formatHint":"Format used when exporting videos"},"language":{"selectLanguage":"Language","languageHint":"Select your preferred language"}},"sync":{"synced":"Synced (all cameras in sync)","drifted":"Drifted (auto-correcting)","videosSynced":"Videos are synchronized","videosDrifted":"Videos drifted - resyncing"},"events":{"stats":"{{total}} events ({{saved}} saved, {{sentry}} sentry, {{recent}} recent)","saved":"Saved","sentry":"Sentry","recent":"Recent","event":{"one":"{{count}} event","other":"{{count}} events"}},"filter":{"search":"Search events","type":"Type","date":"Date","all":"All","savedClips":"Saved Clips","sentryClips":"Sentry Clips","recentClips":"Recent Clips","clear":"Clear filters","filters":"Filters","eventTypes":"Event Types","saved":"Saved","sentry":"Sentry","recent":"Recent","onlyBookmarked":"Only Bookmarked Events","onlyWithNotes":"Only Events with Notes/Tags","sortBy":"Sort By","newestFirst":"Newest First","oldestFirst":"Oldest First","searchPlaceholder":"City, location, reason...","dateRange":"Date Range","dateTo":"to","clearDates":"Clear Dates","clearAllFilters":"Clear All Filters","filterByTag":"Filter by Tag","allTags":"All Tags"},"map":{"noLocation":"No location data","showAll":"Show all events","centerOnEvent":"Center on event","toggleHeatmap":"Toggle Heatmap View","toggleStruggleZones":"Toggle Autopilot Struggle Zones","loadingStruggleZones":"Loading AP disengagement data...","struggleZonesLoaded":"{{count}} AP disengagements found","togglePhantomBrakes":"Toggle Phantom Brake Hotspots","loadingPhantomBrakes":"Loading phantom brake data...","phantomBrakesLoaded":"{{count}} phantom brakes found","phantomBrakeHotspot":"Phantom Brake Hotspot","phantomBrakesAtLocation":"{{count}} Phantom Brake(s) at this location","phantomBrakeTip":"This location has repeated phantom braking - consider reporting to Tesla if it's a false positive.","toggleDarkMode":"Toggle Dark Mode Map"},"statistics":{"title":"Statistics","close":"Close","recordingOverview":"Recording Overview","totalEvents":"Total Events","totalClips":"Total Clips","recordingTime":"Recording Time","estStorage":"Est. Storage","eventsLast14Days":"Events - Last 14 Days","eventTypes":"Event Types","saved":"Saved","sentry":"Sentry","recent":"Recent","triggerReasons":"Trigger Reasons","manualSave":"Manual Save","objectDetected":"Object Detected","vehicleBump":"Vehicle Bump","honk":"Honk","other":"Other","unknown":"Unknown","topLocations":"Top 10 Locations (All Events)","sentryByTimeOfDay":"Sentry Events by Time of Day","topSentryLocations":"Top Sentry Locations","dateRange":"Date Range","eventTrends":"Event Trends","weekly":"Weekly","monthly":"Monthly","exportStatistics":"Export Statistics","exportJson":"Export JSON","exportCsv":"Export CSV","noEvents":"No events loaded. Open a TeslaCam folder first.","noStatsToExport":"No statistics to export","noTimelineData":"No timeline data available","noEventsLast14Days":"No events in the last 14 days","noSentryEvents":"No sentry events to analyze","noTrendData":"No trend data available","noLocationData":"No location data available","noSentryLocationData":"No sentry location data","events":"events"},"errors":{"folderNotFound":"Folder not found","noVideosFound":"No videos found in this event","loadFailed":"Failed to load video","exportFailed":"Failed to export video","browserNotSupported":"Your browser does not support this feature","permissionDenied":"Permission denied","fileAccessError":"Error accessing file"},"time":{"hours":"h","minutes":"m","seconds":"s","ago":"ago","justNow":"just now"},"quickstart":{"skip":"Skip","previous":"Previous","next":"Next","getStarted":"Get Started","welcome":{"title":"Welcome to TeslaCam Viewer","description":"View and manage your Tesla dashcam footage directly in your browser.","noUpload":"No upload required","videosStay":"your videos stay on your computer.","language":"Language"},"step1":{"title":"Step 1: Select Your TeslaCam Folder","description":"Click the \"Select TeslaCam Folder\" button to choose your USB drive or folder containing TeslaCam data.","hint":"Look for folders named TeslaCam, SavedClips, SentryClips, or RecentClips."},"step2":{"title":"Step 2: Browse Events","description":"Events appear in the left sidebar, sorted by date. Click any event to load it.","saved":"Manual saves from dashcam","sentry":"Motion-triggered recordings","recent":"Rolling buffer footage"},"step3":{"title":"Step 3: View Cameras","description":"Watch all camera angles synchronized: Front, Back, Left, Right, and Pillar cameras (if available).","tip":"Tip","tipText":"Drag cameras to swap positions, or hide cameras you don't need."},"shortcuts":{"title":"Keyboard Shortcuts","playPause":"Play / Pause","seek":"Seek 5 seconds","screenshot":"Screenshot","pip":"Picture-in-Picture","markInOut":"Mark In / Out","export":"Export","showAll":"Show all shortcuts"}},"driveManager":{"title":"Manage Drives","noDrives":"No drives added yet","events":"events","removeDrive":"Remove drive","addDrive":"Add Drive","changeColor":"Click to change color","archive":"Archive","notLoaded":"Not loaded","sync":"Sync","syncNow":"Load events from this archive drive","editDrive":"Edit drive settings"},"driveSetup":{"title":"Drive Setup","editTitle":"Edit Drive Settings","tipTitle":"Tip: Folder Selection","tipTeslaCam":"TeslaCam/ - All footage from one drive","tipSubfolder":"SavedClips/ or SentryClips/ - Only specific event types","tipParent":"A parent folder - Scan for TeslaCam folders inside","labelField":"Drive Label","labelPlaceholder":"e.g., My USB Drive","dateFilterField":"Load events from","dateFilterAll":"All events","dateFilterWeek":"Last week","dateFilterMonth":"Last month","dateFilter3Months":"Last 3 months","dateFilter6Months":"Last 6 months","dateFilterYear":"Last year","archiveLabel":"Archive drive","archiveHint":"Don't load on startup - sync manually when needed","changeFolder":"Change Folder","addDrive":"Add Drive","save":"Save Changes"},"driveSync":{"title":"Drive Sync","close":"Close (Esc)","settings":"Settings","sourceDestination":"Source & Destination","selectSource":"Select source...","selectDestination":"Select destination...","compare":"Compare","comparing":"Comparing...","comparisonStats":"Comparison Statistics","selectDrivesToCompare":"Select drives and compare to see statistics","selectDrivesHint":"Select drives to compare","quickLoad":"Quick Load:","noPresets":"No saved presets","save":"Save","copy":"Copy","move":"Move","cancel":"Cancel","pause":"Pause","resume":"Resume","startSync":"Start Sync","done":"Done","preparing":"Preparing...","syncComplete":"Sync Complete","syncFailed":"Sync Failed","selected":"Selected:","events":"events","missingOnDest":"Missing on destination","newerOnSource":"Newer on source","differentSize":"Different size","alreadySynced":"Already synced","includeNotes":"Include notes & tags","eta":"ETA:","sourceEvents":"Source Events","destEvents":"Destination Events","missing":"Missing","newerCount":"Newer on Source","synced":"Already Synced","syncCoverage":"Sync Coverage","storageBreakdown":"Storage Breakdown","sourceTotal":"Source Total","destTotal":"Destination Total","toTransfer":"To Transfer","dateRange":"Date Range","source":"Source:","destination":"Destination:","eventsByType":"Events by Type","topLocations":"Top Locations","noLocationData":"No location data available","eventsByMonth":"Events by Month","noMonthlyData":"No monthly data available","detailedBreakdown":"Detailed Event Breakdown","allEvents":"All Events","missingOnly":"Missing Only","newerOnly":"Newer Only","syncedOnly":"Synced Only","showingFirst":"Showing first {{count}} of {{total}} events"},"syncSettings":{"title":"Sync Settings","verifyAfterCopy":"Verify files after copy","syncNotes":"Sync notes and tags","writeSyncFile":"Write sync settings file to destination","confirmBeforeDelete":"Confirm before deleting source files","noteConflict":"Note conflict resolution:","askEachTime":"Ask each time","mergeAutomatically":"Merge automatically","saveSettings":"Save Settings","close":"Close"},"presets":{"title":"Manage Presets","noPresets":"No saved presets. Select drives and click \"Save\" to create one.","importFromDrives":"Import from Drives","close":"Close","delete":"Delete","importedFrom":"Imported from","lastUsed":"Last used:","deleteConfirm":"Delete preset \"{{name}}\"?","couldNotFind":"Could not find drives for this preset.","lookingFor":"Looking for:","sourceLabel":"Source:","destLabel":"Destination:","makeSureLoaded":"Make sure both drives are loaded.","enterName":"Enter a name for this preset:","savedSuccess":"Preset saved successfully!","imported":"Imported {{count}} presets.","errors":"Errors:","noNewPresets":"No new presets found on any drives."},"layoutEditor":{"title":"Layout Editor","close":"Close","new":"New","newLayout":"New Layout","import":"Import","importLayout":"Import Layout","export":"Export","exportLayout":"Export Layout","snap":"Snap","aspect":"Aspect:","aspectWide":"Wide","aspectUltraWide":"Ultra Wide","aspectTriple":"Triple","aspectCinematic":"Cinematic","selectedCamera":"Selected Camera","futureCamera":"Future camera - not yet available","position":"Position","size":"Size","layer":"Layer","sendBackward":"Send backward","bringForward":"Bring forward","fit":"Fit:","contain":"Contain","cover":"Cover","cropEdges":"Crop Edges","top":"Top:","bottom":"Bottom:","left":"Left:","right":"Right:","cameras":"Cameras","savedLayouts":"Saved Layouts","noLayouts":"No custom layouts saved yet","cancel":"Cancel","saveLayout":"Save Layout","layoutName":"Layout name","hint":"Click to select, drag to move, corners to resize","untitled":"Untitled Layout","invalidLayout":"Invalid layout:","deleteConfirm":"Delete \"{{name}}\"?","importFailed":"Import failed:","readFailed":"Failed to read file:","failedToSave":"Failed to save layout","failedToUpdate":"Failed to update layout","soon":"Soon"},"common":{"close":"Close","cancel":"Cancel","save":"Save","delete":"Delete","edit":"Edit","add":"Add","remove":"Remove","yes":"Yes","no":"No","ok":"OK","loading":"Loading...","error":"Error","success":"Success","warning":"Warning"},"incidentDetection":{"toggleSlowMo":"Toggle Incident Slow-Mo","slowMoEnabled":"Incident Slow-Mo: ON","slowMoDisabled":"Incident Slow-Mo: OFF","slowMoIndicator":"SLOW-MO","slowMoScore":"Score: {{score}}/10","toggleBirdsEye":"Toggle Bird's Eye View","birdsEyeTitle":"Bird's Eye View","birdsEyeWaitingGps":"Waiting for GPS data...","birdsEyeRadius":"{{radius}}m radius","birdsEyeLowG":"Low G","birdsEyeMedG":"Med G","birdsEyeHighG":"High G"},"license":{"activated":"License Activated!","howItWorks":"Here's how your TeslaCamViewer Pro license works:","privacyFirst":"Privacy First","privacyFirstDesc":"Your email is only used to verify your license locally on this device. It's never sent to any server.","savedInTwoPlaces":"Saved in Two Places","savedInTwoPlacesDesc":"Your license is saved in your browser's storage and on your TeslaCam drive. This lets you use it across different drives.","easyRecovery":"Easy Recovery","easyRecoveryDesc":"If you use a different browser or computer, just open any drive with your license saved on it. You'll be asked to re-enter your email to verify it's you.","multipleDevices":"Multiple Devices","multipleDevicesDesc":"Use your license on any device. Each new browser will ask for your email once to verify, then you're all set.","gotIt":"Got It"},"telemetry":{"title":"Telemetry","toggleAnomalyMarkers":"Toggle anomaly markers","hideAnomalyMarkers":"Hide anomaly markers","showAnomalyMarkers":"Show anomaly markers","exportCsv":"Export telemetry data as CSV","noData":"No data","phantomBrake":"Phantom Brake","hardBrake":"Hard Brake","hardAccel":"Hard Accel","suddenAcceleration":"Sudden acceleration at {{speed}} mph","suddenDeceleration":"Sudden deceleration at {{speed}} mph","rapidSteering":"Rapid steering ({{degrees}}° change)","gForce":"G-Force: {{value}}g","speed":"Speed: {{speed}} mph","dropped":"Dropped: {{dropped}} mph","gForceValue":"G-Force: {{value}}g","previousApEvent":"Previous AP event","nextApEvent":"Next AP event","cycleApEvents":"Click arrows to cycle through {{count}} AP events","nearMissDetected":"Near-miss incidents detected","phantomBrakingTooltip":"Phantom braking: unexpected deceleration while on Autopilot without driver brake input","hardBrakingEvents":"Hard braking events","hardAccelEvents":"Hard acceleration events","hardBrakingAccelEvents":"Hard braking/acceleration events"}};

class I18n {
    constructor() {
        this.locale = 'en';
        this.fallbackLocale = 'en';
        this.messages = {};
        this.loadedLocales = new Set();
        this._i18nRef = 0x54435669; // internal ref

        // Supported languages with native names
        this.supportedLocales = {
            'en': 'English',
            'es': 'Español',
            'de': 'Deutsch',
            'fr': 'Français',
            'zh': '中文',
            'ja': '日本語',
            'ko': '한국어',
            'nl': 'Nederlands',
            'no': 'Norsk'
        };
    }

    /**
     * Initialize i18n system
     * @param {string} preferredLocale - Optional preferred locale
     */
    async init(preferredLocale = null) {
        // Priority: saved preference > browser language > fallback
        const savedLocale = localStorage.getItem('tcv_locale');
        const browserLocale = this.detectBrowserLocale();

        this.locale = preferredLocale || savedLocale || browserLocale || this.fallbackLocale;

        // Always load fallback first
        await this.loadLocale(this.fallbackLocale);

        // Load preferred locale if different
        if (this.locale !== this.fallbackLocale) {
            await this.loadLocale(this.locale);
        }

        // Apply translations to DOM
        this.translatePage();

        console.log(`i18n initialized: ${this.locale}`);
        return this;
    }

    /**
     * Detect browser's preferred language
     * @returns {string} Locale code
     */
    detectBrowserLocale() {
        const browserLang = navigator.language || navigator.userLanguage || 'en';
        const shortLang = browserLang.split('-')[0].toLowerCase();

        // Check if we support this language
        if (this.supportedLocales[shortLang]) {
            return shortLang;
        }

        return this.fallbackLocale;
    }

    /**
     * Load a locale file
     * @param {string} locale - Locale code (e.g., 'en', 'es')
     */
    async loadLocale(locale) {
        if (this.loadedLocales.has(locale)) {
            return;
        }

        try {
            const response = await fetch(`locales/${locale}.json`);
            if (!response.ok) {
                throw new Error(`Failed to load locale: ${locale}`);
            }

            const messages = await response.json();
            this.messages[locale] = messages;
            this.loadedLocales.add(locale);

        } catch (error) {
            console.warn(`Could not load locale '${locale}':`, error.message);

            // Use embedded fallback for English when fetch fails (e.g., file:// protocol CORS)
            if (locale === 'en' && typeof EMBEDDED_EN_FALLBACK !== 'undefined') {
                console.log('Using embedded English fallback (file:// protocol detected)');
                this.messages['en'] = EMBEDDED_EN_FALLBACK;
                this.loadedLocales.add('en');
                return;
            }

            // If not fallback, silently continue with fallback
            if (locale !== this.fallbackLocale) {
                this.locale = this.fallbackLocale;
            }
        }
    }

    /**
     * Set the current locale
     * @param {string} locale - Locale code
     * @param {boolean} save - Save to localStorage
     */
    async setLocale(locale, save = true) {
        if (!this.supportedLocales[locale]) {
            console.warn(`Unsupported locale: ${locale}`);
            return;
        }

        await this.loadLocale(locale);
        this.locale = locale;

        if (save) {
            localStorage.setItem('tcv_locale', locale);
        }

        // Re-translate the page
        this.translatePage();

        // Dispatch event for components to update
        window.dispatchEvent(new CustomEvent('localeChanged', { detail: { locale } }));
    }

    /**
     * Get translation for a key
     * @param {string} key - Dot-notation key (e.g., 'buttons.play')
     * @param {Object} params - Parameters to interpolate
     * @returns {string} Translated string
     */
    t(key, params = {}) {
        let text = this.getMessage(key, this.locale);

        // Fallback to default locale if not found
        if (text === key && this.locale !== this.fallbackLocale) {
            text = this.getMessage(key, this.fallbackLocale);
        }

        // Interpolate parameters: {{param}}
        if (params && typeof text === 'string') {
            Object.keys(params).forEach(param => {
                const regex = new RegExp(`{{${param}}}`, 'g');
                text = text.replace(regex, params[param]);
            });
        }

        return text;
    }

    /**
     * Get message from locale messages using dot notation
     * @param {string} key - Dot-notation key
     * @param {string} locale - Locale to use
     * @returns {string} Message or key if not found
     */
    getMessage(key, locale) {
        const messages = this.messages[locale];
        if (!messages) return key;

        const parts = key.split('.');
        let result = messages;

        for (const part of parts) {
            if (result && typeof result === 'object' && part in result) {
                result = result[part];
            } else {
                return key; // Key not found, return as-is
            }
        }

        return typeof result === 'string' ? result : key;
    }

    /**
     * Pluralization helper
     * @param {string} key - Base key (will look for key.zero, key.one, key.other)
     * @param {number} count - Count for pluralization
     * @param {Object} params - Additional parameters
     * @returns {string} Pluralized string
     */
    plural(key, count, params = {}) {
        let pluralKey;

        if (count === 0) {
            pluralKey = `${key}.zero`;
        } else if (count === 1) {
            pluralKey = `${key}.one`;
        } else {
            pluralKey = `${key}.other`;
        }

        // Try specific plural form, fall back to 'other', then to base key
        let text = this.getMessage(pluralKey, this.locale);
        if (text === pluralKey) {
            text = this.getMessage(`${key}.other`, this.locale);
        }
        if (text === `${key}.other`) {
            text = this.getMessage(key, this.locale);
        }

        // Always include count in params
        return this.t(pluralKey !== text ? pluralKey : key, { count, ...params });
    }

    /**
     * Translate all elements with data-i18n attributes
     */
    translatePage() {
        // Translate text content: data-i18n="key"
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (key) {
                el.textContent = this.t(key);
            }
        });

        // Translate titles: data-i18n-title="key"
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            if (key) {
                el.title = this.t(key);
            }
        });

        // Translate placeholders: data-i18n-placeholder="key"
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            if (key) {
                el.placeholder = this.t(key);
            }
        });

        // Translate aria-labels: data-i18n-aria="key"
        document.querySelectorAll('[data-i18n-aria]').forEach(el => {
            const key = el.getAttribute('data-i18n-aria');
            if (key) {
                el.setAttribute('aria-label', this.t(key));
            }
        });
    }

    /**
     * Get list of supported locales
     * @returns {Object} Locale code to name mapping
     */
    getSupportedLocales() {
        return { ...this.supportedLocales };
    }

    /**
     * Get current locale
     * @returns {string} Current locale code
     */
    getLocale() {
        return this.locale;
    }

    /**
     * Check if a locale is supported
     * @param {string} locale - Locale code
     * @returns {boolean}
     */
    isSupported(locale) {
        return locale in this.supportedLocales;
    }
}

// Create global instance
const i18n = new I18n();

// Expose to window for global access
window.i18n = i18n;

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => i18n.init());
} else {
    // DOM already loaded, init immediately
    i18n.init();
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { I18n, i18n };
}
