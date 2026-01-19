/**
 * SidebarResize - Handles resizable sidebar functionality
 * Allows users to drag the sidebar edge to resize
 */

class SidebarResize {
    constructor() {
        this.sidebar = document.getElementById('sidebar');
        this.handle = document.getElementById('sidebarResizeHandle');
        this.STORAGE_KEY = 'teslacam_sidebar_width';
        this.MIN_WIDTH = 200;
        this.MAX_WIDTH = 600;
        this.DEFAULT_WIDTH = 320;

        this.isResizing = false;
        this.startX = 0;
        this.startWidth = 0;

        this.init();
    }

    init() {
        if (!this.sidebar || !this.handle) {
            console.warn('[SidebarResize] Sidebar or handle not found');
            return;
        }

        // Restore saved width
        this.restoreWidth();

        // Bind event handlers
        this.handle.addEventListener('mousedown', this.onMouseDown.bind(this));
        document.addEventListener('mousemove', this.onMouseMove.bind(this));
        document.addEventListener('mouseup', this.onMouseUp.bind(this));

        // Touch support for mobile/tablet
        this.handle.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: false });
        document.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: false });
        document.addEventListener('touchend', this.onTouchEnd.bind(this));

        // Double-click to reset
        this.handle.addEventListener('dblclick', this.resetWidth.bind(this));

        console.log('[SidebarResize] Initialized');
    }

    /**
     * Restore saved sidebar width from localStorage
     */
    restoreWidth() {
        try {
            const savedWidth = localStorage.getItem(this.STORAGE_KEY);
            if (savedWidth) {
                const width = parseInt(savedWidth, 10);
                if (width >= this.MIN_WIDTH && width <= this.MAX_WIDTH) {
                    this.sidebar.style.width = `${width}px`;
                    console.log(`[SidebarResize] Restored width: ${width}px`);
                }
            }
        } catch (e) {
            console.warn('[SidebarResize] Failed to restore width:', e);
        }
    }

    /**
     * Save current sidebar width to localStorage
     */
    saveWidth() {
        try {
            const width = this.sidebar.offsetWidth;
            localStorage.setItem(this.STORAGE_KEY, width.toString());
        } catch (e) {
            console.warn('[SidebarResize] Failed to save width:', e);
        }
    }

    /**
     * Reset sidebar to default width
     */
    resetWidth() {
        this.sidebar.style.width = `${this.DEFAULT_WIDTH}px`;
        this.saveWidth();

        // Trigger resize event for map to recalculate
        window.dispatchEvent(new Event('resize'));

        // Also invalidate Leaflet map size
        setTimeout(() => {
            if (window.app?.mapView?.map) {
                window.app.mapView.map.invalidateSize();
            }
        }, 100);
    }

    /**
     * Mouse down handler - start resizing
     */
    onMouseDown(e) {
        e.preventDefault();
        this.startResize(e.clientX);
    }

    /**
     * Mouse move handler - resize in progress
     */
    onMouseMove(e) {
        if (!this.isResizing) return;
        this.doResize(e.clientX);
    }

    /**
     * Mouse up handler - end resizing
     */
    onMouseUp() {
        if (this.isResizing) {
            this.endResize();
        }
    }

    /**
     * Touch start handler
     */
    onTouchStart(e) {
        if (e.touches.length === 1) {
            e.preventDefault();
            this.startResize(e.touches[0].clientX);
        }
    }

    /**
     * Touch move handler
     */
    onTouchMove(e) {
        if (!this.isResizing || e.touches.length !== 1) return;
        e.preventDefault();
        this.doResize(e.touches[0].clientX);
    }

    /**
     * Touch end handler
     */
    onTouchEnd() {
        if (this.isResizing) {
            this.endResize();
        }
    }

    /**
     * Start resize operation
     */
    startResize(clientX) {
        this.isResizing = true;
        this.startX = clientX;
        this.startWidth = this.sidebar.offsetWidth;

        // Add resizing class for visual feedback
        this.handle.classList.add('resizing');
        document.body.classList.add('sidebar-resizing');

        // Disable transitions during resize for smooth dragging
        this.sidebar.style.transition = 'none';
    }

    /**
     * Perform resize
     */
    doResize(clientX) {
        const deltaX = clientX - this.startX;
        let newWidth = this.startWidth + deltaX;

        // Clamp to min/max
        newWidth = Math.max(this.MIN_WIDTH, Math.min(this.MAX_WIDTH, newWidth));

        this.sidebar.style.width = `${newWidth}px`;
    }

    /**
     * End resize operation
     */
    endResize() {
        this.isResizing = false;

        // Remove resizing classes
        this.handle.classList.remove('resizing');
        document.body.classList.remove('sidebar-resizing');

        // Re-enable transitions
        this.sidebar.style.transition = '';

        // Save the new width
        this.saveWidth();

        // Trigger resize event for map to recalculate
        window.dispatchEvent(new Event('resize'));

        // Also invalidate Leaflet map size after a short delay
        setTimeout(() => {
            if (window.app?.mapView?.map) {
                window.app.mapView.map.invalidateSize();
            }
        }, 100);

        console.log(`[SidebarResize] Resized to ${this.sidebar.offsetWidth}px`);
    }

    /**
     * Get current sidebar width
     */
    getWidth() {
        return this.sidebar ? this.sidebar.offsetWidth : this.DEFAULT_WIDTH;
    }

    /**
     * Set sidebar width programmatically
     */
    setWidth(width) {
        if (!this.sidebar) return;

        width = Math.max(this.MIN_WIDTH, Math.min(this.MAX_WIDTH, width));
        this.sidebar.style.width = `${width}px`;
        this.saveWidth();
        window.dispatchEvent(new Event('resize'));

        // Also invalidate Leaflet map size
        setTimeout(() => {
            if (window.app?.mapView?.map) {
                window.app.mapView.map.invalidateSize();
            }
        }, 100);
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.sidebarResize = new SidebarResize();
});
