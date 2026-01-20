# TeslaCam Viewer

A powerful browser-based Tesla dashcam viewer with synchronized multi-angle playback, telemetry visualization, and comprehensive incident analysis tools. All processing happens locally - your video files never leave your computer.

**Live Site: [teslacamviewer.com](https://teslacamviewer.com)**

## Key Features

### Video Playback
- **Synchronized Multi-Camera Playback** - View front, back, left, right (and pillar cameras on newer vehicles) simultaneously
- **Multiple Layout Presets** - Grid, Picture-in-Picture, Focus views, and more
- **Custom Layout Editor** - Design your own camera arrangements with drag-and-drop
- **Playback Speed Control** - 0.25x to 2x speed with frame-by-frame stepping
- **Fullscreen Mode** - Double-click any camera for fullscreen view

### Event Management
- **Multi-Drive Support** - Add multiple TeslaCam folders and switch between them
- **Event Filtering** - Filter by type (Saved/Sentry/Recent), date range, location, or search
- **Interactive Map** - View all events on a map with location markers and heatmap
- **Bookmarks and Notes** - Add notes and tags to events, backed up to event folders
- **Statistics Dashboard** - Analytics on event types, locations, recording time, and trends

### Telemetry and Analysis
- **Live Telemetry Overlay** - Speed, G-force, turn signals, brake/throttle from embedded video data
- **Telemetry Graphs** - Interactive speed, G-force, and steering graphs with speed limit reference
- **GPS Mini-Map** - Real-time vehicle position overlay
- **Elevation Profile** - Route elevation visualization
- **Weather Display** - Historical weather conditions for each event
- **Street View Integration** - Compare dashcam view with Google Street View

### Incident Documentation
- **Insurance Report Generator** - PDF reports with frames, telemetry data, and maps
- **Near-Miss Detection** - Automatic incident scoring with timeline markers
- **Hard Braking Detection** - Identifies sudden acceleration/deceleration events
- **Driving Smoothness Score** - Safety scoring based on driving behavior
- **Autopilot Analysis** - Phantom braking detection and AP struggle zone mapping

### Export and Sharing
- **Screenshot Capture** - Save current frame from all cameras
- **Video Export** - Export clips as WebM or MP4 with overlays
- **Clip Marking** - Set IN/OUT points for precise export ranges
- **Privacy Mode** - Export with GPS and timestamp data stripped
- **License Plate Blur** - AI-powered automatic plate detection and blurring
- **Telemetry CSV Export** - Download telemetry data for external analysis

### Customization
- **Theme System** - Dark, Light, Midnight, and Tesla Red themes
- **Multi-Language Support** - Interface available in multiple languages
- **Offline Package** - Download for fully offline use
- **Automatic Updates** - Notifications when new versions are available

## Browser Requirements

**Chrome, Edge, or Chromium-based browser required** - This app uses the File System Access API which is only supported in Chromium browsers.

Firefox and Safari are not supported.

## Getting Started

### Option 1: Use the Live Site (Recommended)

Visit [teslacamviewer.com](https://teslacamviewer.com) - no installation required.

### Option 2: Run Locally

1. Clone or download this repository
2. Open `index.html` in Chrome or Edge, or run a local server:

```bash
# Using Python
python -m http.server 8000

# Using Node.js
npx http-server -p 8000
```

3. Open http://localhost:8000 in your browser

### Option 3: Offline Package

Use the "Download Offline Version" option in settings to create a portable copy that works without internet.

## Quick Start

1. Click "Select TeslaCam Folder" and choose your TeslaCam directory
2. Browse events in the sidebar - they load with thumbnails and metadata
3. Click an event to start playback
4. Use the timeline to scrub through footage
5. Press `L` to cycle through layout presets
6. Press `T` for telemetry overlay, `G` for graphs, `M` for mini-map

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play/Pause |
| `Left/Right Arrow` | Seek 5 seconds |
| `Shift + Left/Right` | Previous/Next clip |
| `Up/Down Arrow` | Previous/Next event |
| `L` | Cycle layouts |
| `T` | Toggle telemetry overlay |
| `G` | Toggle telemetry graphs |
| `M` | Toggle GPS mini-map |
| `F` | Toggle fullscreen |
| `S` | Take screenshot |
| `?` | Show all shortcuts |

## Tesla Dashcam Folder Structure

The app reads the standard Tesla TeslaCam folder structure:

```
TeslaCam/
├── SavedClips/
│   └── YYYY-MM-DD_HH-MM-SS/
│       ├── event.json
│       ├── thumb.png
│       └── *.mp4 (4-6 cameras x multiple clips)
├── SentryClips/
│   └── YYYY-MM-DD_HH-MM-SS/
│       ├── event.json
│       ├── thumb.png
│       └── *.mp4
└── RecentClips/
    └── *.mp4 (rolling buffer)
```

## Privacy and Security

- **No data uploads** - All video processing happens in your browser
- **No server backend** - The entire app runs client-side
- **No tracking** - No analytics or telemetry collection
- **Local storage only** - Settings and bookmarks stored in your browser

The only network request is an optional version check to notify you of updates.

## Troubleshooting

**"Browser not supported"**: Use Chrome or Edge browser.

**No events showing**: Ensure you selected the TeslaCam folder or its parent directory.

**Videos won't play**: Check that .mp4 files aren't corrupted. Try another event.

**Telemetry not showing**: Not all Tesla firmware versions embed telemetry data. Older recordings may not have this data.

**Buffering issues with multiple windows**: Use tabs in the same window rather than separate browser windows.

## Contributing

Contributions welcome! Feel free to open issues or pull requests on GitHub.

## Community

Have questions, ideas, or want to share how you use TeslaCam Viewer?

**[Join the Discussion](https://github.com/NateMccomb/TeslaCamViewer/discussions)**

- **Q&A** - Get help with setup or usage questions
- **Ideas** - Suggest new features or improvements
- **Show and Tell** - Share interesting clips or use cases
- **General** - Chat with other Tesla owners

## License

**Free for personal use.** Commercial use requires a separate license.

See LICENSE file for details, or contact License@TeslaCamViewer.com for commercial inquiries.

## Version

Current version: 2026.4.1.2

Click the version number in the app to view the full changelog.
