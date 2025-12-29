# TeslaCam Viewer

A browser-based Tesla dashcam viewer that plays synchronized multi-angle video footage from your local files without uploading data anywhere.

## Features

- **4-Panel Synchronized Playback** - View front, back, left, and right cameras simultaneously
- **Auto-play** - Events start playing automatically when selected
- **No File Uploads** - All processing happens locally in your browser
- **Timeline Scrubbing** - Smoothly navigate through clips with visual timeline
- **Playback Speed Control** - Slow down (0.25x) or speed up (2x) for detailed review
- **Frame Stepping** - Step forward/backward one frame at a time, hold for slow-motion
- **Event Navigation** - Previous/Next buttons to quickly browse between events
- **Event Filtering** - Filter by type, date range, location, or search terms
- **Interactive Map** - See events plotted on a map with GPS coordinates
- **Tab Navigation** - Switch between event list and map view
- **Screenshot Capture** - Save current frame from all 4 cameras as PNG
- **Clip Marking** - Mark in/out points on timeline for export
- **Video Export** - Export clips or marked sections as WebM video
- **Fullscreen Mode** - Double-click any camera to view in fullscreen
- **Loop Mode** - Toggle to continuously loop current event
- **Sentry Event Features** - Auto-seek to trigger point (1:04 from end) with visual timeline marker
- **Event Browser** - Browse SavedClips, SentryClips, and RecentClips with thumbnails
- **Dark Theme** - Easy on the eyes during long review sessions
- **Keyboard Shortcuts** - Quick navigation and playback control

## Browser Requirements

**Chrome, Edge, or Chromium-based browser required** - This app uses the File System Access API which is currently only supported in Chromium browsers.

Firefox and Safari do not yet support this API.

## Getting Started

### Option 1: Open Directly (Simple)

1. Simply open `index.html` in Chrome or Edge
2. Click "Select TeslaCam Folder"
3. Navigate to and select your TeslaCam folder (or its parent directory)
4. Browse and play events!

### Option 2: Local Web Server (Recommended)

For better performance, run a local web server:

```bash
# Using Python
python -m http.server 8000

# Or using Node.js
npx http-server -p 8000
```

Then open http://localhost:8000 in your browser.

## Using the App

1. **Select Folder**: Click "Select TeslaCam Folder" and choose your TeslaCam directory
2. **Browse Events**: Events appear in the left sidebar with thumbnails and metadata
3. **Filter Events**: Use the filter panel to narrow down events by type, date, or location
4. **View Map**: Switch to the Map tab to see all events plotted on an interactive map
5. **Select Event**: Click an event to auto-play its videos
6. **Playback Controls**:
   - Play/Pause buttons or **Spacebar**
   - Timeline click or drag to seek
   - **Frame Forward/Backward** buttons - click to step one frame, hold for slow-motion
   - Previous/Next clip buttons or **Shift + Arrow Keys**
   - Previous/Next event buttons to navigate between events
   - Speed dropdown to adjust playback (0.25x - 2x)
   - Loop checkbox to repeat current event
7. **Export & Capture**:
   - **Screenshot** - Click camera button to save current frame (all 4 cameras)
   - **Mark IN/OUT** - Set start/end points for export (green/red buttons)
   - **Export** - Download marked section or current clip as WebM video
   - **Clear Marks** - Remove IN/OUT markers
8. **Fullscreen**: Double-click any camera view to enter fullscreen mode
9. **Sync Status**: Hover over the green/yellow indicator to see video sync status

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play/Pause |
| `←` | Seek back 5 seconds |
| `→` | Seek forward 5 seconds |
| `Shift + ←` | Previous clip |
| `Shift + →` | Next clip |

## Tesla Dashcam Folder Structure

The app expects the standard Tesla TeslaCam folder structure:

```
TeslaCam/
├── SavedClips/
│   └── YYYY-MM-DD_HH-MM-SS/
│       ├── event.json
│       ├── thumb.png
│       └── *.mp4 (4 cameras × multiple clips)
├── SentryClips/
│   └── YYYY-MM-DD_HH-MM-SS/
│       ├── event.json
│       ├── thumb.png
│       └── *.mp4 (4 cameras × multiple clips)
└── RecentClips/
    └── *.mp4 (rolling buffer)
```

## Known Limitations

- Only works in Chrome/Edge (File System Access API limitation)
- Large folders with 100+ events may take time to parse
- Video sync can drift slightly on long clips (auto-corrects)
- RecentClips support is limited (no metadata available)

## Privacy & Security

- **No data ever leaves your computer**
- Videos are read directly from your local filesystem
- No network requests are made
- No tracking or analytics

## Contributing

Contributions welcome! Feel free to open issues or pull requests.

## License

MIT License - see LICENSE file for details

## Troubleshooting

**"Browser not supported" error**: You must use Chrome or Edge browser.

**No events showing**: Make sure you selected the TeslaCam folder (or its parent).

**Videos won't play**: Check that the .mp4 files aren't corrupted. Try another event.

**Sync issues**: Videos automatically resync when drift is detected. If issues persist, reload the event.
