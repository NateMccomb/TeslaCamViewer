/**
 * VersionManager - Tracks app version, changelog, and "what's new" indicators
 * Shows blue dots on features that are new since the user's last visit
 *
 * Version Format: YYYY.W.D.R (Tesla-style)
 *   YYYY = Year
 *   W = ISO Week number (1-53, no leading zero)
 *   D = Day of week (1=Mon, 7=Sun)
 *   R = Release number for that day
 */
class VersionManager {
    constructor() {
        this.STORAGE_KEY = 'teslacamviewer_version_state';
        this.UPDATE_CHECK_KEY = 'teslacamviewer_last_update_check';
        this.UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours in ms

        // Remote version check URL
        this.remoteVersionUrl = 'https://teslacamviewer.com/version.json';

        // Current version - UPDATE THIS when releasing new features
        // Format: Year.Week.DayOfWeek.Release
        this.currentVersion = '2026.48.5.2';

        // Changelog with feature identifiers for "what's new" dots
        // Each entry has: version, date, title, and features array
        // Features have: id (for tracking seen state), text, elementSelector (optional)
        this.changelog = [
            {
                version: '2026.48.5.1',
                date: '2026-11-27',
                title: 'Fast Player, Translations & Fixes',
                features: [
                    {
                        id: 'fast-player-default',
                        text: 'The faster video player is now on for everyone. If your browser can\'t use it, the app switches to the Compatibility player by itself, and you can pick either one in Settings, Advanced.',
                        elementSelector: ['#settingsBtn', '.settings-nav-item[data-tab="advanced"]', '#setting-videoPlayer']
                    },
                    {
                        id: 'summary-2026-48-translations',
                        text: 'Much more of the app follows your language now: AI Search, the telemetry graphs, the weather line, the plate enhancer, Drive Sync and the map popups.',
                        elementSelector: null
                    },
                    {
                        id: 'summary-2026-48-drives',
                        text: 'Opening your TeslaCam drive no longer asks for permission to save changes to it, and Drive Sync tells you in plain words what went wrong and whether anything was deleted.',
                        elementSelector: null
                    },
                    {
                        id: 'summary-2026-48-clip-ends',
                        text: 'Every camera now plays and exports to its own end of each clip, and in an export a camera\'s label turns red only when that camera really ends.',
                        elementSelector: null
                    },
                    {
                        id: 'fix-2026-48-restore',
                        text: 'On phones and tablets, the page no longer gets stuck on "Restoring..." when a saved drive isn\'t plugged in; the drive is listed with a Reconnect button instead.',
                        elementSelector: null
                    },
                    {
                        id: 'summary-2026-48-more-fixes',
                        text: 'Plus smaller fixes: Pause works while the next clip is loading, the HUD and map you had on come back when an event\'s telemetry starts after its first clip, layouts with odd names (also from a shared layout file) now show safely, screenshots show the time of the frame and the street, dates follow your computer\'s format, and hover previews use less memory. The full list is in the release notes on GitHub.',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.47.6.1',
                date: '2026-11-21',
                title: 'H.264 Export, GPS in Exports, Encrypted Clips & Fixes',
                features: [
                    {
                        id: 'export-format-h264',
                        text: 'New export format: MP4 (H.264). It plays on iPhone, QuickTime and in video editors. MP4 (VP9) stays the default because it looks best. On some PCs H.264 is the slowest export, and the export screen tells you when that happens.',
                        elementSelector: ['#exportDropdownBtn', '#exportFormatSelect']
                    },
                    {
                        id: 'export-gps-text',
                        text: 'Exports can show the car\'s GPS position next to the time. Turn it on in Settings, Export (off by default, and privacy mode always removes it).',
                        elementSelector: ['#settingsBtn', '.settings-nav-item[data-tab="export"]', '#setting-gpsTextInExport']
                    },
                    {
                        id: 'export-speed-limit-sign',
                        text: 'Exports can show the speed limit sign, like the player does (Settings, Export). When the map data servers are too busy to look one up, the app now says so instead of showing nothing.',
                        elementSelector: ['#settingsBtn', '.settings-nav-item[data-tab="export"]', '#setting-speedLimitInExport']
                    },
                    {
                        id: 'encrypted-clips-detected',
                        text: 'Clips encrypted by Tesla (car software 2026.20 and newer) are recognised now. The event list tells you how many there are and how to view them.',
                        elementSelector: null
                    },
                    {
                        id: 'summary-2026-49-playback',
                        text: 'Smoother playback: clicking the timeline, Next Clip, frame stepping and 6-camera events all stay in sync now.',
                        elementSelector: null
                    },
                    {
                        id: 'summary-2026-49-drive-sync',
                        text: 'Drive Sync is safer: Move only deletes files it has copied and checked, and your notes and tags come along to the other drive.',
                        elementSelector: null
                    },
                    {
                        id: 'summary-2026-49-export-reliability',
                        text: 'Exports are more reliable on slower PCs. WebM keeps every frame and its full length, MP4 and WebM carry on with the software encoder when the graphics card\'s encoder gets stuck, and an export that goes wrong tells you instead of saving an empty file.',
                        elementSelector: null
                    },
                    {
                        id: 'summary-2026-49-more-fixes',
                        text: 'Plus a lot of smaller fixes: exports, the insurance report, dates in your own time zone, translations in every language and safer libraries. The full list is in the release notes on GitHub.',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.47.2.1',
                date: '2026-11-17',
                title: 'Maps Fixed & Security Fixes',
                features: [
                    {
                        id: 'fix-map-tiles-osm',
                        text: 'Maps load again. The event map and the mini-map now use OpenStreetMap tiles (dark mode darkens them), because the previous map providers started requiring an API key and showed blank tiles.',
                        elementSelector: null
                    },
                    {
                        id: 'fix-escape-drive-text',
                        text: 'Safer event details: place names, trigger reasons and folder names read from a drive are now always shown as plain text, so a modified event file can no longer change the page.',
                        elementSelector: null
                    },
                    {
                        id: 'fix-diagnostics-issue-link',
                        text: 'The "Open GitHub Issue" button in the diagnostic report now opens the right page.',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.21.1.1',
                date: '2026-05-18',
                title: 'AI Search, WebCodecs Player, Recording Health & Launch Highlights',
                features: [
                    {
                        id: 'ai-search-clip',
                        text: 'AI Search (BETA): semantic search across your event clips using a CLIP model that runs locally on your GPU. Type natural-language queries like "parking garage" or "night drive" — opt-in via Settings → AI Search.',
                        elementSelector: ['#settingsBtn', '.settings-nav-item[data-tab="ai-search"]', '#ai-search-enable-btn']
                    },
                    {
                        id: 'webcodecs-player',
                        text: 'New WebCodecs-backed video player runs in parallel with the standard player: noticeably faster seeks, smoother scrubbing, and less buffering on large events. Opt-in at first, under Settings → Advanced → Performance; now on for everyone (the Video player choice there).',
                        elementSelector: null
                    },
                    {
                        id: 'recording-health-badge',
                        text: 'Event cards now show a small amber or red badge when an event has missing cameras, very short clips, or interrupted recordings. Healthy events stay unbadged — clean cards by default.',
                        elementSelector: null
                    },
                    {
                        id: 'launch-highlights',
                        text: 'Auto-detected full-throttle launches: a 🏁 chip on event cards counts the number of launches, and the timeline gets a "🏁 Launch" bookmark at the start of each one. Click the bookmark to jump straight to it.',
                        elementSelector: null
                    },
                    {
                        id: 'autopilot-timeline-layer',
                        text: 'Timeline gains an Autopilot / FSD activity strip — see at a glance when each segment of an event was on AP, hands-off FSD, or human-driven. Fully zoom-aware.',
                        elementSelector: '#timeline'
                    },
                    {
                        id: 'intervention-severity',
                        text: 'Intervention Severity badges on event cards: a pill rating each event\'s hardest brake, sharpest lateral jolt, or impact (mild → moderate → severe → critical). Click the pill for a popover of each peak moment.',
                        elementSelector: null
                    },
                    {
                        id: 'insights-scanner',
                        text: 'Background Insights Scanner: pre-computes severity, recording health, and launches for every event in the library so the badges appear instantly when the app opens. Pauses automatically during playback.',
                        elementSelector: null
                    },
                    {
                        id: 'export-resolution-selector',
                        text: 'Export resolution selector: pick Native / 1080p / 720p before exporting. Lower resolutions run faster, finish quicker, and put much less load on the GPU encoder.',
                        elementSelector: ['#settingsBtn', '.settings-nav-item[data-tab="export"]', '#setting-exportResolution']
                    },
                    {
                        id: 'plate-blur-smoothness',
                        text: 'Plate-blur detection cadence rewrite: blurs track plates more smoothly across frames and re-acquire faster after camera changes, with less per-frame GPU pressure.',
                        elementSelector: null
                    },
                    {
                        id: 'gap-marker-zoom-fix',
                        text: 'Fixed: the yellow/black "missing clips" indicator on the timeline now correctly moves with the timeline when zoomed.',
                        elementSelector: null
                    },
                    {
                        id: 'sentry-minimap-export-fix',
                        text: 'Fixed: Sentry events without telemetry data now correctly render the mini-map in screenshots and exports (using event.json GPS as fallback).',
                        elementSelector: null
                    },
                    {
                        id: 'gpu-export-diagnostics',
                        text: 'Better diagnostics when an export fails due to GPU issues (Windows TDR, hardware encoder hang, context loss). The error dialog now suggests specific mitigations, and the diagnostics log captures codec / dimensions / frame count for support.',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.17.4.1',
                date: '2026-04-23',
                title: 'License Activation Fix',
                features: [
                    {
                        id: 'license-activation-double-click-fix',
                        text: 'Fixed license activation: a single click on the Activate button was firing two handlers at once, which caused a spurious "deactivate" confirm dialog and, in some cases, kicked fresh users back to Free Tier right after seeing "License Activated!". New users can now activate in one click.',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.17.1.1',
                date: '2026-04-20',
                title: 'Command Palette, Scrub Previews, Drive Auto-Refresh, Troubleshooting Panel',
                features: [
                    {
                        id: 'command-palette',
                        text: 'Press Ctrl+K (Cmd+K on Mac) to open a searchable command palette — ~25 common actions (playback, layouts, export, overlays, navigation) plus free-text search across loaded events.',
                        elementSelector: null
                    },
                    {
                        id: 'scrub-preview-thumbnails',
                        text: 'Hovering the timeline now shows a multi-camera thumbnail preview (2×2 grid, or 3×2 on pillar-cam vehicles). Generation runs in the background and won\'t slow down playback.',
                        elementSelector: '#timeline'
                    },
                    {
                        id: 'drive-auto-refresh',
                        text: 'Drives auto-refresh when new clips appear — native filesystem events where supported, plus a 30-second polling fallback. No more manually clicking refresh after Sentry saves a new event.',
                        elementSelector: '#refreshDrivesBtn'
                    },
                    {
                        id: 'troubleshooting-panel',
                        text: 'New Diagnostics → Troubleshooting section (in Settings) captures recent console logs and exposes debug flag toggles. Copy / Download / Preview buttons make it easy to share a sanitized report without opening DevTools.',
                        elementSelector: ['#settingsBtn', '.settings-nav-item[data-tab="diagnostics"]']
                    },
                    {
                        id: 'event-insights',
                        text: 'Event Insights: short, auto-generated observations about each event (derived from SEI telemetry) appear next to the event header.',
                        elementSelector: '#eventInsights'
                    },
                    {
                        id: 'fast-export-toggle',
                        text: 'Experimental Fast Export toggle in Settings → Export. Uses a streamlined render path for large exports — try it when standard export feels slow.',
                        elementSelector: null   // the toggle was removed when fast export became the default
                    },
                    {
                        id: 'sei-unknown-scanner',
                        text: 'SEI Unknown-Field Scanner: flags previously-unseen telemetry fields in your clips and offers a crowd-sourced report (review before sharing — all values are scrubbed of paths, GPS, and plate-shaped strings). Lives in Settings → Diagnostics (same place as Troubleshooting).',
                        elementSelector: null
                    },
                    {
                        id: 'export-eta-smoothing',
                        text: 'Video export ETA no longer jumps at the Phase 1 → Phase 2 transition — now uses an 8-second sliding window with a light EMA so the countdown climbs and descends smoothly.',
                        elementSelector: null
                    },
                    {
                        id: 'hover-buffer-fix',
                        text: 'Fixed playback stutter and multi-second backward jumps that happened when moving the mouse over the control panel during playback (main-thread contention was starving the video scheduler).',
                        elementSelector: null
                    },
                    {
                        id: 'camera-hide-fix',
                        text: 'Hiding a camera in the layout now correctly hides it from both live view and exports.',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.16.5.1',
                date: '2026-04-17',
                title: 'Export & Layout Overhaul, Drive Sync Reliability, 6-Camera Support',
                features: [
                    {
                        id: 'pro-branding-toggle',
                        text: 'Pro users: toggle the bottom banner on/off in Settings → Export. When off, exports use clean pill overlays for the timestamp and Sentry indicator instead of the full bar.',
                        elementSelector: null
                    },
                    {
                        id: 'six-camera-layouts',
                        text: 'New built-in layouts for 6-camera vehicles: Front + Pillars, Front + Left Pillar, Front + Right Pillar (auto-shown when pillar cams are detected). 4:3 Main and All 16:9 redesigned for 6 cameras.',
                        elementSelector: '#layoutSelect'
                    },
                    {
                        id: 'drag-swap-all-layouts',
                        text: 'Camera drag-swap now works across every layout (not just 2×2 Grid). A reset button appears after any swap to restore the layout defaults.',
                        elementSelector: '#resetLayoutBtn'
                    },
                    {
                        id: 'unified-export-pipeline',
                        text: 'Focus-mode and grid exports now share one render path — fixes black video on MP4 and stutter on WebM, and makes the bottom banner consistent across single-camera and multi-camera exports.',
                        elementSelector: null
                    },
                    {
                        id: 'mini-map-trail-fixes',
                        text: 'Mini-map trail in exports: distance-based pruning keeps the trail long in slow traffic, outlier GPS rejection stops the random-jump glitches, and the trail pixel math is corrected near tile boundaries.',
                        elementSelector: null
                    },
                    {
                        id: 'drive-sync-reliability',
                        text: 'Drive Sync: real drive sizes shown instead of "0 B", destination refreshes after each sync so re-comparing works, mid-file cancel, head+tail checksum for large files, and partial-copy cleanup on errors.',
                        elementSelector: null
                    },
                    {
                        id: 'ui-performance',
                        text: 'Fixed a RAF loop multiplication bug that made UI, HUD, and mini-map sluggish after multiple event switches.',
                        elementSelector: null
                    },
                    {
                        id: 'sidebar-scrollbar-fix',
                        text: 'Sidebar resize handle no longer fights with the event list scrollbar.',
                        elementSelector: null
                    },
                    {
                        id: 'saved-event-preview-fix',
                        text: 'Hover preview on Saved events now loops through the full tail footage instead of the ~1 second flash.',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.5.1.2',
                date: '2026-01-26',
                title: 'AI License Plate Detection & Incident Markers',
                features: [
                    {
                        id: 'ai-plate-detection',
                        text: 'AI-powered license plate detection - automatically finds plates across all cameras (press D)',
                        elementSelector: '#enhanceRegionBtn'
                    },
                    {
                        id: 'plate-size-warnings',
                        text: 'Real-time selection size indicator warns when plate region is too large for fast processing',
                        elementSelector: '#enhanceBtn'
                    },
                    {
                        id: 'incident-markers',
                        text: 'Incident Markers detect hard braking (>0.35g) and lateral g-force events in your telemetry',
                        elementSelector: '#statsBtn'
                    },
                    {
                        id: 'map-theme-sync',
                        text: 'Map now syncs with app theme and has improved styled controls',
                        elementSelector: '.tab-btn[data-tab="map"]'
                    },
                    {
                        id: 'region-tracking-improvements',
                        text: 'Improved plate tracking with Siamese network for better accuracy across frames',
                        elementSelector: null
                    },
                    {
                        id: 'incident-slowmo-fix',
                        text: 'Fixed Incident Slow-Mo detection and added time offset display in Incident Hotspot popup',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.4.6.1',
                date: '2026-01-25',
                title: 'Modern UI for Settings & Statistics',
                features: [
                    {
                        id: 'settings-sidebar-layout',
                        text: 'Settings modal redesigned with modern vertical sidebar navigation (like VS Code/Discord)',
                        elementSelector: null
                    },
                    {
                        id: 'statistics-sidebar-layout',
                        text: 'Statistics modal redesigned with sidebar navigation: Overview, Timeline, Locations, Sentry Analysis, Data Quality, Export tabs',
                        elementSelector: null
                    },
                    {
                        id: 'themed-scrollbars',
                        text: 'Themed scrollbars throughout the app for a consistent modern look',
                        elementSelector: null
                    },
                    {
                        id: 'privacy-mode-export-ui',
                        text: 'Added Privacy Mode Export toggle in Settings (strips metadata from exports)',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.4.1.2',
                date: '2026-01-19',
                title: 'Map Provider Options & Bug Reporting',
                features: [
                    {
                        id: 'map-tile-provider',
                        text: 'New map tile provider setting: switch between Carto, OpenStreetMap, or Stadia Maps (fixes maps not loading in China)',
                        elementSelector: null
                    },
                    {
                        id: 'bug-report-button',
                        text: 'Report Bug button in Help modal copies diagnostic info to clipboard for easier bug reports',
                        elementSelector: null
                    },
                    {
                        id: 'parse-diagnostics',
                        text: 'Enhanced diagnostic logging helps debug folder parsing issues (e.g., OneDrive)',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.4.1.1',
                date: '2026-01-19',
                title: 'Map & Mobile Fixes',
                features: [
                    {
                        id: 'map-light-tiles',
                        text: 'Fixed map light mode tiles not loading (switched to CARTO)',
                        elementSelector: null
                    },
                    {
                        id: 'heatmap-all-events',
                        text: 'Heatmap now shows all events (telemetry + metadata GPS combined)',
                        elementSelector: null
                    },
                    {
                        id: 'mobile-telemetry-panel',
                        text: 'Fixed mobile telemetry panel display and elevation graph alignment',
                        elementSelector: null
                    },
                    {
                        id: 'mobile-filter-panel',
                        text: 'Fixed mobile filter panel not loading correctly',
                        elementSelector: null
                    },
                    {
                        id: 'hard-brake-accel-fix',
                        text: 'Fixed hard brake/acceleration detection showing inverted values',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.3.6.1',
                date: '2026-01-18',
                title: 'Update Notifications & Loading Progress',
                features: [
                    {
                        id: 'update-notifications',
                        text: 'Automatic update notifications when a new version is available',
                        elementSelector: null
                    },
                    {
                        id: 'loading-progress',
                        text: 'Loading progress indicator shows which folders are being scanned',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.3.5.3',
                date: '2026-01-16',
                title: 'Advanced Analytics & Safety Features',
                features: [
                    {
                        id: 'hard-braking-detection',
                        text: 'Hard braking/acceleration detection with markers on G-Force graph',
                        elementSelector: null
                    },
                    {
                        id: 'driving-smoothness-score',
                        text: 'Driving smoothness score (0-100) based on steering, accel, lateral G',
                        elementSelector: null
                    },
                    {
                        id: 'clickable-anomalies',
                        text: 'Clickable anomaly markers on telemetry graphs - auto-detects spikes',
                        elementSelector: null
                    },
                    {
                        id: 'phantom-braking',
                        text: 'Phantom braking detection for Autopilot analysis',
                        elementSelector: null
                    },
                    {
                        id: 'ap-struggle-zones',
                        text: 'Autopilot struggle zones map - shows frequent disengagement locations',
                        elementSelector: null
                    },
                    {
                        id: 'near-miss-scoring',
                        text: 'Near-miss incident scoring with timeline markers',
                        elementSelector: null
                    },
                    {
                        id: 'insurance-report-pdf',
                        text: 'Insurance report PDF generator with frames, telemetry, and map',
                        elementSelector: null
                    },
                    {
                        id: 'auto-blur-plates',
                        text: 'Auto-blur license plates in export using AI detection',
                        elementSelector: null
                    },
                    {
                        id: 'privacy-mode-export',
                        text: 'Privacy mode export - strips timestamp, GPS, and location data',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.3.5.2',
                date: '2026-01-16',
                title: 'Trip Analytics & Export Enhancements',
                features: [
                    {
                        id: 'csv-telemetry-export',
                        text: 'Export telemetry data as CSV - download button in graphs panel',
                        elementSelector: null
                    },
                    {
                        id: 'trip-analytics-stats',
                        text: 'Trip statistics in graphs header - distance, avg/max speed, autopilot %',
                        elementSelector: null
                    },
                    {
                        id: 'minimap-in-export',
                        text: 'Option to include GPS mini-map in video exports',
                        elementSelector: null
                    },
                    {
                        id: 'driving-heatmap',
                        text: 'Driving heatmap on Map tab - shows your most frequent routes',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.3.5.1',
                date: '2026-01-16',
                title: 'Telemetry Graphs & Speed Limit Display',
                features: [
                    {
                        id: 'telemetry-graphs-panel',
                        text: 'Interactive telemetry graphs panel - Press G to toggle speed, G-force, and steering graphs',
                        elementSelector: '#telemetryHeader'
                    },
                    {
                        id: 'speed-limit-display',
                        text: 'Real-time speed limit display from OpenStreetMap - shows limit on HUD and graph',
                        elementSelector: null
                    },
                    {
                        id: 'speed-limit-graph-line',
                        text: 'Speed limit reference line on speed graph that varies along the route',
                        elementSelector: null
                    },
                    {
                        id: 'gps-minimap',
                        text: 'GPS mini-map overlay showing vehicle position in real-time',
                        elementSelector: null
                    },
                    {
                        id: 'speed-limit-styling',
                        text: 'Regional speed limit sign styling - rectangular (US) or circular (EU/metric)',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.1.2.1',
                date: '2025-12-30',
                title: 'Internationalization & Mobile Fixes',
                features: [
                    {
                        id: 'i18n-support',
                        text: 'Multi-language support - Switch languages in Settings or welcome screen',
                        elementSelector: '#settingsBtn'
                    },
                    {
                        id: 'mini-mode-controls',
                        text: 'Fixed mobile portrait mode controls - play, frame step, timeline scrubbing',
                        elementSelector: null
                    },
                    {
                        id: 'mobile-fullscreen-fixes',
                        text: 'Mobile fullscreen: Escape key exits, tap shows controls, bottom sheet hidden',
                        elementSelector: null
                    }
                ]
            },
            {
                version: '2026.1.1.2',
                date: '2025-12-29',
                title: 'Export Quality & Format Options',
                features: [
                    {
                        id: 'export-frame-timing-fix',
                        text: 'Fixed video export frame skipping - consistent 30fps timing',
                        elementSelector: '#exportBtn'
                    },
                    {
                        id: 'export-format-setting',
                        text: 'Choose export format: WebM (VP9) or MP4 (H.264) in Settings',
                        elementSelector: '#settingsBtn'
                    },
                    {
                        id: 'export-cancel-fix',
                        text: 'Cancel button now works reliably during export progress',
                        elementSelector: '#exportBtn'
                    }
                ]
            },
            {
                version: '2026.1.1.1',
                date: '2025-12-29',
                title: 'User Data Backup & Drive Sync UI',
                features: [
                    {
                        id: 'user-data-backup',
                        text: 'Notes, tags, and bookmarks now backed up to event folders - data travels with the drive',
                        elementSelector: '#notesBtn'
                    },
                    {
                        id: 'sync-horizontal-layout',
                        text: 'Drive Sync redesigned with horizontal split-panel layout',
                        elementSelector: '#syncDrivesBtn'
                    },
                    {
                        id: 'sync-stats-visible',
                        text: 'Comparison statistics now visible by default after comparing drives',
                        elementSelector: '#syncDrivesBtn'
                    },
                    {
                        id: 'sync-preset-chips',
                        text: 'Quick-load presets shown as chips for faster access',
                        elementSelector: '#syncDrivesBtn'
                    }
                ]
            },
            {
                version: '2025.52.7.6',
                date: '2025-12-28',
                title: 'Phase 7: Multi-Drive, Statistics & Mobile',
                features: [
                    {
                        id: 'multi-drive',
                        text: 'Multi-drive support - Add multiple TeslaCam folders and switch between them',
                        elementSelector: '#addDriveBtn'
                    },
                    {
                        id: 'drive-management',
                        text: 'Drive management modal - Change colors, edit labels, remove drives',
                        elementSelector: '#manageDrivesBtn'
                    },
                    {
                        id: 'location-heatmap',
                        text: 'Location heatmap - Toggle between markers and heatmap view on the map',
                        elementSelector: '.tab-btn[data-tab="map"]'
                    },
                    {
                        id: 'time-of-day-chart',
                        text: 'Sentry triggers by time-of-day chart in statistics',
                        elementSelector: '#statsBtn'
                    },
                    {
                        id: 'weekly-trends',
                        text: 'Weekly/monthly trends chart with toggle',
                        elementSelector: '#statsBtn'
                    },
                    {
                        id: 'stats-export',
                        text: 'Export statistics as JSON or CSV',
                        elementSelector: '#statsBtn'
                    },
                    {
                        id: 'mobile-fullscreen',
                        text: 'Mobile fullscreen video mode with swipe gestures'
                    },
                    {
                        id: 'orientation-lock',
                        text: 'Orientation lock setting - Lock landscape during playback',
                        elementSelector: '#settingsBtn'
                    }
                ]
            },
            {
                version: '2025.52.7.5',
                date: '2025-12-28',
                title: 'Export Improvements & UX Polish',
                features: [
                    {
                        id: 'export-layout-match',
                        text: 'Export now matches the exact layout shown in the preview',
                        elementSelector: '#exportDropdownBtn'
                    },
                    {
                        id: 'single-export-overlay',
                        text: 'Single camera export uses same overlay format as grid layouts'
                    },
                    {
                        id: 'snap-toggle',
                        text: 'Snap toggle in Layout Editor toolbar - works for dragging and resizing',
                        elementSelector: '#layoutSelect'
                    },
                    {
                        id: 'timeline-markers',
                        text: 'IN/OUT markers now extend past timeline edge for visibility'
                    }
                ]
            },
            {
                version: '2025.52.7.4',
                date: '2025-12-28',
                title: 'Layout Editor Snap Guides',
                features: [
                    {
                        id: 'snap-guides',
                        text: 'Visual snap guides when aligning cameras in the Layout Editor',
                        elementSelector: '#layoutSelect'
                    }
                ]
            },
            {
                version: '2025.52.7.3',
                date: '2025-12-28',
                title: 'Mobile Support & Statistics',
                features: [
                    {
                        id: 'mobile-support',
                        text: 'Mobile-friendly responsive design with sidebar drawer'
                    },
                    {
                        id: 'touch-optimization',
                        text: 'Touch-optimized controls with larger tap targets'
                    },
                    {
                        id: 'statistics-dashboard',
                        text: 'Statistics dashboard showing event breakdowns, recording time, and top locations',
                        elementSelector: '#statsBtn'
                    }
                ]
            },
            {
                version: '2025.52.7.2',
                date: '2025-12-28',
                title: 'Theme System & Single Camera Export',
                features: [
                    {
                        id: 'theme-system',
                        text: 'Theme options - Dark, Light, Midnight, and Tesla Red themes',
                        elementSelector: '#setting-theme'
                    },
                    {
                        id: 'single-camera-export',
                        text: 'Export individual camera angles - Front, Rear, Left, or Right only',
                        elementSelector: '#exportDropdownBtn'
                    }
                ]
            },
            {
                version: '2025.52.7.1',
                date: '2025-12-28',
                title: 'Custom Layout Editor & Version Tracking',
                features: [
                    {
                        id: 'layout-editor',
                        text: 'Visual Layout Editor - Design custom camera arrangements with drag & drop',
                        elementSelector: '#layoutSelect'
                    },
                    {
                        id: 'layout-import-export',
                        text: 'Import/Export layouts as JSON files to share with others',
                        elementSelector: '#layoutSelect'
                    },
                    {
                        id: 'layout-cropping',
                        text: 'Camera cropping - Mask edges without distorting aspect ratio',
                        elementSelector: '#layoutSelect'
                    },
                    {
                        id: 'version-tracking',
                        text: 'Version tracking with "What\'s New" indicators'
                    }
                ]
            },
            {
                version: '2025.52.6.1',
                date: '2025-12-27',
                title: 'Multi-Layout View System',
                features: [
                    { id: 'layouts-5-presets', text: '5 different camera viewing layouts' },
                    { id: 'layout-keyboard', text: 'Press L to cycle through layouts' }
                ]
            },
            {
                version: '2025.52.5.1',
                date: '2025-12-26',
                title: 'Export & Sharing',
                features: [
                    { id: 'screenshot-capture', text: 'Screenshot capture with composite view' },
                    { id: 'video-export', text: 'Video export with real-time rendering' },
                    { id: 'clip-marking', text: 'IN/OUT point marking for clip selection' }
                ]
            },
            {
                version: '2025.52.5.0',
                date: '2025-12-26',
                title: 'Event Analysis',
                features: [
                    { id: 'event-filtering', text: 'Filter events by type, date, and search' },
                    { id: 'interactive-map', text: 'Interactive map showing event locations' }
                ]
            }
        ];

        this.state = this.loadState();
        this.modal = null;
        // featureId -> { dots: HTMLElement[], cleanups: Function[] }
        this.indicators = new Map();
        // [{ featureId, selector, text, isLast }] — selectors whose element
        // isn't in the DOM yet (e.g. Settings modal nav items). Watched by a
        // MutationObserver and dotted as soon as they appear.
        this.pendingSelectors = [];
        // featureId + selector -> { featureId, selector, text, isLast } for every
        // dotted feature not seen yet: an anchor that is rendered again (the
        // Settings window rebuilds its tabs and controls each time it opens)
        // gets its dot back (#623)
        this._watched = new Map();
        this._mutationObserver = null;

        this.checkVersionUpgrade();
    }

    /**
     * Load state from localStorage
     */
    loadState() {
        const defaults = {
            lastSeenVersion: null,
            seenFeatures: [], // IDs of features user has interacted with
            showWhatsNew: true, // User preference
            firstVisit: true
        };

        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) {
                return { ...defaults, ...JSON.parse(stored) };
            }
        } catch (e) {
            console.warn('Failed to load version state:', e);
        }
        return defaults;
    }

    /**
     * Save state to localStorage
     */
    saveState() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.state));
        } catch (e) {
            console.warn('Failed to save version state:', e);
        }
    }

    /**
     * Check if this is a version upgrade
     */
    checkVersionUpgrade() {
        const lastVersion = this.state.lastSeenVersion;
        // The newest What's New entry. A fix-only release can ship without an entry of its own (its note goes in
        // the entry before it), so this is not always currentVersion's.
        const latest = this.changelog.length ? this.changelog[0].version : this.currentVersion;

        if (!lastVersion) {
            // First visit ever. Don't overwhelm with 10 years of changelog
            // history, but still highlight what's new in the CURRENT release so
            // new users can discover recent features. Mark features from older
            // versions as seen; leave current-version features unseen so they
            // get blue dots, the has-updates version tag, and the What's New
            // modal just like upgrading users do.
            this.state.firstVisit = true;
            this.state.lastSeenVersion = this.currentVersion;
            for (const entry of this.changelog) {
                if (entry.version === latest) continue;
                for (const feature of entry.features) {
                    if (!this.state.seenFeatures.includes(feature.id)) {
                        this.state.seenFeatures.push(feature.id);
                    }
                }
            }
            this.saveState();

            if (this.state.showWhatsNew) {
                setTimeout(() => this.showUpgradeNotification(), 1500);
            }
            return;
        }

        if (this.compareVersions(this.currentVersion, lastVersion) > 0) {
            // New version detected!
            console.log(`Version upgrade detected: ${lastVersion} -> ${this.currentVersion}`);
            this.state.firstVisit = false;
            this.state.lastSeenVersion = this.currentVersion;
            this.saveState();

            // Show changelog modal after a brief delay, when there is an entry newer than the last version seen. A
            // release without its own entry updates quietly: its note is in the entry the user was already shown.
            if (this.state.showWhatsNew && this.compareVersions(latest, lastVersion) > 0) {
                setTimeout(() => this.showUpgradeNotification(), 1500);
            }
        }
    }

    /**
     * Compare two version strings (returns 1 if a > b, -1 if a < b, 0 if equal)
     */
    compareVersions(a, b) {
        const partsA = a.split('.').map(Number);
        const partsB = b.split('.').map(Number);

        for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
            const numA = partsA[i] || 0;
            const numB = partsB[i] || 0;
            if (numA > numB) return 1;
            if (numA < numB) return -1;
        }
        return 0;
    }

    /**
     * Get new features since last seen version
     */
    getNewFeatures() {
        const lastVersion = this.state.lastSeenVersion;
        const newFeatures = [];

        for (const entry of this.changelog) {
            // Include features from versions newer than lastSeenVersion
            // or features that haven't been marked as seen
            for (const feature of entry.features) {
                if (!this.state.seenFeatures.includes(feature.id)) {
                    newFeatures.push({
                        ...feature,
                        version: entry.version,
                        versionTitle: entry.title
                    });
                }
            }
        }

        return newFeatures;
    }

    /**
     * Check if a specific feature is new (not yet seen)
     */
    isFeatureNew(featureId) {
        if (!this.state.showWhatsNew) return false;
        return !this.state.seenFeatures.includes(featureId);
    }

    /**
     * Mark a feature as seen
     */
    markFeatureSeen(featureId) {
        if (!this.state.seenFeatures.includes(featureId)) {
            this.state.seenFeatures.push(featureId);
            this.saveState();

            // Remove the indicator if it exists
            this.removeIndicator(featureId);
        }
    }

    /**
     * Mark all features as seen
     */
    markAllFeaturesSeen() {
        for (const entry of this.changelog) {
            for (const feature of entry.features) {
                if (!this.state.seenFeatures.includes(feature.id)) {
                    this.state.seenFeatures.push(feature.id);
                }
            }
        }
        this.saveState();
        this.removeAllIndicators();
    }

    /**
     * Set whether to show what's new indicators
     */
    setShowWhatsNew(show) {
        this.state.showWhatsNew = show;
        this.saveState();

        if (!show) {
            this.removeAllIndicators();
        } else {
            this.addIndicators();
        }
    }

    /**
     * Add blue dot indicator to an element
     * @param {HTMLElement} element - Element to add indicator to
     * @param {string} featureId - Feature ID for tracking
     * @param {string} featureText - Feature description for tooltip
     */
    addIndicator(element, featureId, featureText = 'New feature!', isLast = true) {
        if (!element || !this.isFeatureNew(featureId)) return;

        // Replaced/void elements can't hold arbitrary DOM children — browsers
        // silently drop them. Fall back to the parent container so the dot
        // actually renders. Applies to select, input, textarea, img, etc.
        const nonContainerTags = new Set(['SELECT', 'INPUT', 'TEXTAREA', 'IMG', 'VIDEO', 'AUDIO', 'IFRAME']);
        let anchor = element;
        if (nonContainerTags.has(element.tagName) && element.parentElement) {
            anchor = element.parentElement;
        }

        // One dot per feature on an anchor (#623). addIndicators runs at page
        // start twice and again on every settings change (app.js:
        // settingsManager.onChange -> setShowWhatsNew), and each run added
        // another dot and another click handler: 2 per anchor at load, then
        // 4, 8, 16 on the same spot. Dots on elements that are gone (a window
        // that rendered its content again) are dropped with their handlers.
        const entry = this.indicators.get(featureId) || { dots: [], cleanups: [] };
        entry.dots = entry.dots.filter(d => {
            if (d.isConnected) return true;
            if (d._cleanup) {
                d._cleanup();
                entry.cleanups = entry.cleanups.filter(c => c !== d._cleanup);
            }
            return false;
        });
        if (entry.dots.some(d => d.parentElement === anchor)) return;

        const dot = document.createElement('span');
        dot.className = 'whats-new-dot';
        dot.dataset.featureId = featureId;

        if (getComputedStyle(anchor).position === 'static') {
            anchor.style.position = 'relative';
        }
        anchor.appendChild(dot);

        // Tooltip renders on document.body to escape ancestor stacking contexts
        // and overflow:hidden clipping; position is clamped to the viewport.
        const showTip = () => {
            let tip = document.getElementById('whats-new-tooltip-instance');
            if (!tip) {
                tip = document.createElement('div');
                tip.id = 'whats-new-tooltip-instance';
                tip.className = 'whats-new-tooltip';
                document.body.appendChild(tip);
            }
            tip.textContent = featureText;
            tip.style.visibility = 'hidden';
            tip.style.left = '0px';
            tip.style.top = '0px';
            tip.style.display = 'block';

            const dotRect = dot.getBoundingClientRect();
            const tipRect = tip.getBoundingClientRect();
            const pad = 8;
            const vw = window.innerWidth;
            const vh = window.innerHeight;

            let top = dotRect.bottom + pad;
            if (top + tipRect.height > vh - pad) top = dotRect.top - tipRect.height - pad;
            if (top < pad) top = pad;

            let left = dotRect.left + dotRect.width / 2 - tipRect.width / 2;
            if (left + tipRect.width > vw - pad) left = vw - pad - tipRect.width;
            if (left < pad) left = pad;

            tip.style.top = top + 'px';
            tip.style.left = left + 'px';
            tip.style.visibility = 'visible';
        };
        const hideTip = () => {
            const tip = document.getElementById('whats-new-tooltip-instance');
            if (tip) tip.remove();
        };
        dot.addEventListener('mouseenter', showTip);
        dot.addEventListener('mouseleave', hideTip);
        dot._hideTip = hideTip;

        // Suppress the anchor's native browser tooltip while hovering the dot —
        // otherwise title="…" text renders on top of our custom tooltip.
        const titleSuppress = () => {
            const t = anchor.getAttribute('title');
            if (t != null) {
                anchor.dataset._savedTitle = t;
                anchor.removeAttribute('title');
            }
        };
        const titleRestore = () => {
            if (anchor.dataset._savedTitle != null) {
                anchor.setAttribute('title', anchor.dataset._savedTitle);
                delete anchor.dataset._savedTitle;
            }
        };
        dot.addEventListener('mouseenter', titleSuppress);
        dot.addEventListener('mouseleave', titleRestore);

        entry.dots.push(dot);

        // Only the INNERMOST dot's anchor clicks mark the feature seen — outer
        // breadcrumb clicks just navigate deeper without dismissing the trail.
        if (isLast) {
            const markSeen = () => {
                this.markFeatureSeen(featureId);
                element.removeEventListener('click', markSeen);
            };
            element.addEventListener('click', markSeen);
            dot._cleanup = () => element.removeEventListener('click', markSeen);
            entry.cleanups.push(dot._cleanup);
        }

        this.indicators.set(featureId, entry);
    }

    /**
     * Remove indicator for a feature (all dots in its breadcrumb chain)
     */
    removeIndicator(featureId) {
        const entry = this.indicators.get(featureId);
        if (entry) {
            for (const dot of entry.dots) {
                if (dot._hideTip) dot._hideTip();
                if (dot.parentElement) dot.parentElement.removeChild(dot);
            }
            for (const cleanup of entry.cleanups) cleanup();
        }
        this.indicators.delete(featureId);
        // Also drop any pending or watched selectors for this feature
        this.pendingSelectors = this.pendingSelectors.filter(p => p.featureId !== featureId);
        for (const [key, w] of this._watched) {
            if (w.featureId === featureId) this._watched.delete(key);
        }
        this._stopObserverIfDone();
    }

    /**
     * Remove all indicators
     */
    removeAllIndicators() {
        for (const featureId of Array.from(this.indicators.keys())) {
            this.removeIndicator(featureId);
        }
        this.pendingSelectors = [];
        this._watched.clear();
        if (this._mutationObserver) {
            this._mutationObserver.disconnect();
            this._mutationObserver = null;
        }
    }

    /**
     * Add indicators to elements with new features.
     *
     * `elementSelector` may be a string (single anchor) or an array (breadcrumb
     * chain from outer UI → inner feature). Dots for selectors whose element
     * isn't in the DOM yet (e.g. Settings modal internals) are queued and
     * attached by a MutationObserver when they appear.
     */
    addIndicators() {
        if (!this.state.showWhatsNew) return;

        const newFeatures = this.getNewFeatures();
        let placed = 0, pending = 0, noTarget = 0;

        for (const feature of newFeatures) {
            if (!feature.elementSelector) { noTarget++; continue; }

            const selectors = Array.isArray(feature.elementSelector)
                ? feature.elementSelector
                : [feature.elementSelector];

            selectors.forEach((selector, idx) => {
                const isLast = idx === selectors.length - 1;
                this._watched.set(feature.id + '\n' + selector, { featureId: feature.id, selector, text: feature.text, isLast });
                const element = document.querySelector(selector);
                if (element) {
                    this.addIndicator(element, feature.id, feature.text, isLast);
                    placed++;
                } else {
                    // queued once, however often this runs (#623)
                    if (!this.pendingSelectors.some(p => p.featureId === feature.id && p.selector === selector)) {
                        this.pendingSelectors.push({ featureId: feature.id, selector, text: feature.text, isLast, idx });
                    }
                    pending++;
                }
            });
        }

        if (pending > 0 || this._watched.size > 0) this._startPendingObserver();

        console.log(`[VersionManager] Blue dots: ${placed} placed, ${pending} pending (lazy DOM), ${noTarget} features without selector`);

        if (pending > 0) {
            setTimeout(() => {
                // Only a chain's first (outer) anchor has to be on the page by
                // now. Later steps (a Settings tab, a control inside it) only
                // exist once the user opens that modal, so they're expected to
                // wait and were reported here as false alarms.
                const stuck = this.pendingSelectors.filter(p => !p.idx);
                if (stuck.length > 0) {
                    console.warn(`[VersionManager] ${stuck.length} blue-dot selector(s) still unresolved after 10s:`,
                        stuck.map(p => `${p.featureId}: ${p.selector}`));
                }
            }, 10000);
        }
    }

    /**
     * Start watching document.body for pending selectors to appear.
     */
    _startPendingObserver() {
        if (this._mutationObserver) return;
        this._mutationObserver = new MutationObserver((records) => {
            this._processPendingSelectors();
            // Elements were added: an anchor may have been rendered again
            if (records.some(r => Array.from(r.addedNodes).some(n => n.nodeType === 1))) this._reattachWatched();
            this._stopObserverIfDone();
        });
        this._mutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    _processPendingSelectors() {
        if (this.pendingSelectors.length === 0) return;
        const stillPending = [];
        for (const p of this.pendingSelectors) {
            // Skip pending selectors for features that have been marked seen
            if (!this.isFeatureNew(p.featureId)) continue;
            const el = document.querySelector(p.selector);
            if (el) {
                this.addIndicator(el, p.featureId, p.text, p.isLast);
            } else {
                stillPending.push(p);
            }
        }
        this.pendingSelectors = stillPending;
        this._stopObserverIfDone();
    }

    /**
     * Give an anchor that was rendered again its dot back (#623). The
     * Settings window rebuilds its tabs and controls each time it opens: the
     * dots of a Settings chain were on the old elements, so from the second
     * time it opened the trail stopped at the gear and clicking the control
     * no longer cleared the feature. (A settings change used to put them back
     * by running addIndicators again, stacking a dot on every anchor.)
     */
    _reattachWatched() {
        for (const [key, w] of this._watched) {
            if (!this.isFeatureNew(w.featureId)) { this._watched.delete(key); continue; }
            const el = document.querySelector(w.selector);
            if (el) this.addIndicator(el, w.featureId, w.text, w.isLast);
        }
        this._stopObserverIfDone();
    }

    _stopObserverIfDone() {
        if (this.pendingSelectors.length === 0 && this._watched.size === 0 && this._mutationObserver) {
            this._mutationObserver.disconnect();
            this._mutationObserver = null;
        }
    }

    /**
     * Show upgrade notification modal
     */
    showUpgradeNotification() {
        const newFeatures = this.getNewFeatures();
        if (newFeatures.length === 0) return;

        // Get the latest version's features
        const latestEntry = this.changelog[0];
        this.showChangelogModal(latestEntry.version);
    }

    /**
     * Show changelog modal (can show specific version or all)
     */
    showChangelogModal(specificVersion = null) {
        // Remove existing modal
        if (this.modal) {
            this.modal.remove();
        }

        const entries = specificVersion
            ? this.changelog.filter(e => e.version === specificVersion)
            : this.changelog;

        const isUpgrade = specificVersion && this.changelog[0].version === specificVersion;

        this.modal = document.createElement('div');
        this.modal.className = 'changelog-modal';
        this.modal.innerHTML = `
            <div class="changelog-content">
                <div class="changelog-header">
                    <h2>${isUpgrade ? "What's New!" : 'Changelog'}</h2>
                    <button class="changelog-close" title="Close">&times;</button>
                </div>
                <div class="changelog-body">
                    ${entries.map(entry => `
                        <div class="changelog-version ${this.isVersionNew(entry.version) ? 'new' : ''}">
                            <div class="changelog-version-header">
                                <span class="version-number">v${entry.version}</span>
                                <span class="version-date">${entry.date}</span>
                                ${this.isVersionNew(entry.version) ? '<span class="new-badge">NEW</span>' : ''}
                            </div>
                            <h3 class="version-title">${entry.title}</h3>
                            <ul class="feature-list">
                                ${entry.features.map(f => `
                                    <li class="${this.isFeatureNew(f.id) ? 'new' : ''}">${f.text}</li>
                                `).join('')}
                            </ul>
                        </div>
                    `).join('')}
                </div>
                <div class="changelog-footer">
                    ${isUpgrade ? `
                        <label class="dont-show-again">
                            <input type="checkbox" id="dontShowWhatsNew">
                            <span>Don't show "What's New" notifications</span>
                        </label>
                    ` : ''}
                    <button class="changelog-dismiss">Got it!</button>
                </div>
            </div>
        `;

        document.body.appendChild(this.modal);

        // Event listeners
        const closeBtn = this.modal.querySelector('.changelog-close');
        const dismissBtn = this.modal.querySelector('.changelog-dismiss');
        const dontShowCheckbox = this.modal.querySelector('#dontShowWhatsNew');

        const closeModal = () => {
            if (dontShowCheckbox && dontShowCheckbox.checked) {
                this.setShowWhatsNew(false);
            }

            // Hybrid mark-seen policy on modal dismiss:
            //   * Features WITH elementSelector (dotted) stay unseen — dots persist
            //     as navigation aids until the user actually clicks the anchor.
            //   * Features WITHOUT elementSelector (bugfixes, perf wins, global
            //     shortcuts like Ctrl+K) get marked seen here, because they have
            //     no UI anchor to click — reading the changelog IS the
            //     acknowledgement. Otherwise they'd show as "new" forever.
            const entries = specificVersion
                ? this.changelog.filter(e => e.version === specificVersion)
                : this.changelog;
            for (const entry of entries) {
                for (const feature of entry.features) {
                    if (!feature.elementSelector) {
                        this.markFeatureSeen(feature.id);
                    }
                }
            }

            this.modal.remove();
            this.modal = null;
        };

        closeBtn.addEventListener('click', closeModal);
        dismissBtn.addEventListener('click', closeModal);
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) closeModal();
        });
    }

    /**
     * Check if a version is new (has unseen features)
     */
    isVersionNew(version) {
        const entry = this.changelog.find(e => e.version === version);
        if (!entry) return false;
        return entry.features.some(f => !this.state.seenFeatures.includes(f.id));
    }

    /**
     * Get the current version string
     */
    getVersion() {
        return this.currentVersion;
    }

    /**
     * Get version display string (e.g., "v0.8.0")
     */
    getVersionDisplay() {
        return `v${this.currentVersion}`;
    }

    /**
     * Initialize version display in header
     */
    initVersionDisplay() {
        const tagline = document.querySelector('.brand-tagline');
        if (tagline) {
            // Set version text immediately
            const versionText = this.getVersionDisplay();
            tagline.textContent = versionText;
            tagline.classList.add('version-tag');
            tagline.title = 'Click to view changelog';
            tagline.style.cursor = 'pointer';

            tagline.addEventListener('click', () => {
                this.showChangelogModal();
            });

            // Add new indicator if there are new features
            if (this.getNewFeatures().length > 0 && this.state.showWhatsNew) {
                tagline.classList.add('has-updates');
            }

            console.log('[VersionManager] Version display initialized:', versionText);
        } else {
            console.warn('[VersionManager] Could not find .brand-tagline element');
        }

        // Add indicators to other elements after DOM is ready
        setTimeout(() => this.addIndicators(), 500);

        // Check for remote updates (with cooldown)
        this.checkForRemoteUpdate();
    }

    /**
     * Check if enough time has passed since last update check
     */
    shouldCheckForUpdate() {
        try {
            const lastCheck = localStorage.getItem(this.UPDATE_CHECK_KEY);
            if (!lastCheck) return true;

            const elapsed = Date.now() - parseInt(lastCheck, 10);
            return elapsed > this.UPDATE_CHECK_INTERVAL;
        } catch (e) {
            return true;
        }
    }

    /**
     * Record that we just checked for updates
     */
    recordUpdateCheck() {
        try {
            localStorage.setItem(this.UPDATE_CHECK_KEY, Date.now().toString());
        } catch (e) {
            // Ignore storage errors
        }
    }

    /**
     * Check for updates from remote server
     * Works for both online users (stale cache) and offline/local users
     */
    async checkForRemoteUpdate() {
        // Skip if we checked recently
        if (!this.shouldCheckForUpdate()) {
            console.log('[VersionManager] Skipping update check (checked recently)');
            return;
        }

        try {
            // Add cache-busting timestamp to avoid cached response
            const url = `${this.remoteVersionUrl}?t=${Date.now()}`;

            // A plain GET: a custom request header (Cache-Control) made local copies and the offline
            // package send a CORS preflight, which GitHub Pages answers 405, so they never saw updates.
            // cache: 'no-store' plus the ?t= timestamp already bypass every cache.
            const response = await fetch(url, {
                method: 'GET',
                cache: 'no-store' // Force bypass cache
            });

            if (!response.ok) {
                console.log('[VersionManager] Could not reach update server');
                return;
            }

            const remoteVersion = await response.json();
            this.recordUpdateCheck();

            console.log(`[VersionManager] Local: ${this.currentVersion}, Remote: ${remoteVersion.version}`);

            // Compare versions
            if (this.compareVersions(remoteVersion.version, this.currentVersion) > 0) {
                // Remote version is newer
                console.log('[VersionManager] Update available!');
                this.showUpdateToast(remoteVersion);
            } else {
                console.log('[VersionManager] Already up to date');
            }
        } catch (error) {
            // Network error - user is offline or server unreachable
            console.log('[VersionManager] Update check failed (offline?):', error.message);
        }
    }

    /**
     * Show toast notification for available update
     */
    showUpdateToast(remoteVersion) {
        // Don't show duplicate toasts
        if (document.querySelector('.update-toast')) return;

        const toast = document.createElement('div');
        toast.className = 'update-toast';
        toast.innerHTML = `
            <div class="update-toast-content">
                <div class="update-toast-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                </div>
                <div class="update-toast-text">
                    <strong>Update Available</strong>
                    <span>Version ${FolderParser.escapeHtml(String(remoteVersion.version))} is ready</span>
                </div>
                <button class="update-toast-btn" title="Refresh to update">
                    Refresh
                </button>
                <button class="update-toast-close" title="Dismiss">&times;</button>
            </div>
        `;

        document.body.appendChild(toast);

        // Animate in
        requestAnimationFrame(() => {
            toast.classList.add('visible');
        });

        // Event listeners
        const refreshBtn = toast.querySelector('.update-toast-btn');
        const closeBtn = toast.querySelector('.update-toast-close');

        refreshBtn.addEventListener('click', () => {
            // Force hard reload to bypass cache
            window.location.reload(true);
        });

        closeBtn.addEventListener('click', () => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 300);
        });

        // Auto-dismiss after 30 seconds
        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.remove('visible');
                setTimeout(() => toast.remove(), 300);
            }
        }, 30000);
    }

    /**
     * Force an update check (for manual triggering from settings)
     */
    async forceUpdateCheck() {
        // Clear the cooldown
        localStorage.removeItem(this.UPDATE_CHECK_KEY);
        await this.checkForRemoteUpdate();
    }
}

// Export for use
window.VersionManager = VersionManager;
