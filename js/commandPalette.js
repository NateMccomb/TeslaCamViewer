/**
 * CommandPalette - Ctrl+K / Cmd+K searchable action launcher.
 *
 * Registers a flat list of commands (actions, layouts, overlays, navigation)
 * plus dynamic event search against the loaded event list. Filter is simple
 * case-insensitive substring match across title + keywords + category —
 * deliberately forgiving. Fuzzy matching is a future enhancement if needed.
 * build:cmd47
 */
class CommandPalette {
    constructor(app) {
        this.app = app;
        this.commands = [];
        this.modal = null;
        this.backdrop = null;
        this.input = null;
        this.list = null;
        this.filtered = [];
        this.selectedIndex = 0;
        this.MAX_EVENT_RESULTS = 17;
        this._isOpen = false;
    }

    register(command) {
        this.commands.push(command);
    }

    registerMany(commands) {
        for (const c of commands) this.register(c);
    }

    setupGlobalShortcut() {
        document.addEventListener('keydown', (e) => {
            // Ctrl+K or Cmd+K toggles palette. Don't trigger while typing in a
            // text input unless the input is our own palette input.
            if (!(e.key === 'k' || e.key === 'K')) return;
            if (!(e.ctrlKey || e.metaKey)) return;

            const tgt = e.target;
            const isTextInput = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable);
            const isPaletteInput = tgt === this.input;
            if (isTextInput && !isPaletteInput) return;

            e.preventDefault();
            this.toggle();
        });
    }

    toggle() {
        if (this._isOpen) this.close();
        else this.open();
    }

    open() {
        if (this._isOpen) return;
        this._ensureModal();
        this._isOpen = true;
        this.modal.classList.add('visible');
        this.input.value = '';
        this._applyFilter('');
        // Focus on next frame so the visibility transition starts first
        requestAnimationFrame(() => this.input.focus());
    }

    close() {
        if (!this._isOpen || !this.modal) return;
        this._isOpen = false;
        this.modal.classList.remove('visible');
        // Blur input so keystrokes don't still go here
        if (this.input) this.input.blur();
    }

    _ensureModal() {
        if (this.modal) return;
        this.modal = document.createElement('div');
        this.modal.className = 'command-palette';
        this.modal.innerHTML = `
            <div class="command-palette-backdrop"></div>
            <div class="command-palette-panel">
                <div class="command-palette-input-row">
                    <svg class="command-palette-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"/>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input type="text" class="command-palette-input" placeholder="Type a command or search events…" spellcheck="false" autocomplete="off">
                    <span class="command-palette-hint">Esc</span>
                </div>
                <div class="command-palette-list" role="listbox"></div>
                <div class="command-palette-footer">
                    <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                    <span><kbd>Enter</kbd> execute</span>
                    <span><kbd>Esc</kbd> close</span>
                </div>
            </div>
        `;
        document.body.appendChild(this.modal);

        this.backdrop = this.modal.querySelector('.command-palette-backdrop');
        this.input = this.modal.querySelector('.command-palette-input');
        this.list = this.modal.querySelector('.command-palette-list');

        this.backdrop.addEventListener('click', () => this.close());
        this.input.addEventListener('input', () => this._applyFilter(this.input.value));
        this.input.addEventListener('keydown', (e) => this._onInputKey(e));
    }

    _onInputKey(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            this.close();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this._moveSelection(1);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            this._moveSelection(-1);
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            this._executeSelected();
            return;
        }
        if (e.key === 'Home') {
            e.preventDefault();
            this._setSelection(0);
            return;
        }
        if (e.key === 'End') {
            e.preventDefault();
            this._setSelection(this.filtered.length - 1);
            return;
        }
    }

    _applyFilter(queryRaw) {
        const query = (queryRaw || '').trim().toLowerCase();
        const results = [];

        for (const cmd of this.commands) {
            if (cmd.enabled && !cmd.enabled(this.app)) continue;
            if (query === '') {
                results.push({ kind: 'cmd', cmd });
                continue;
            }
            const hay = [
                cmd.title,
                cmd.category || '',
                Array.isArray(cmd.keywords) ? cmd.keywords.join(' ') : (cmd.keywords || '')
            ].join(' ').toLowerCase();
            if (hay.includes(query)) {
                results.push({ kind: 'cmd', cmd });
            }
        }

        // Event search — only if user typed at least 2 characters
        if (query.length >= 2) {
            const events = this._getSearchableEvents();
            let added = 0;
            for (const ev of events) {
                if (added >= this.MAX_EVENT_RESULTS) break;
                const label = this._eventLabel(ev);
                if (label.toLowerCase().includes(query)) {
                    results.push({ kind: 'event', event: ev, label });
                    added++;
                }
            }
        }

        this.filtered = results;
        this.selectedIndex = 0;
        this._renderList();
    }

    _getSearchableEvents() {
        // allEvents is the flat list the sidebar uses
        return (this.app && Array.isArray(this.app.allEvents)) ? this.app.allEvents : [];
    }

    _eventLabel(ev) {
        const date = ev.timestamp ? new Date(ev.timestamp).toLocaleString() : '';
        const loc = ev.metadata?.city || ev.metadata?.street || '';
        const type = ev.type || '';
        return [date, loc, type].filter(Boolean).join(' — ');
    }

    _renderList() {
        if (!this.list) return;
        if (this.filtered.length === 0) {
            this.list.innerHTML = '<div class="command-palette-empty">No matches</div>';
            return;
        }
        const html = this.filtered.map((item, idx) => {
            const sel = idx === this.selectedIndex ? ' selected' : '';
            if (item.kind === 'cmd') {
                const cat = item.cmd.category ? `<span class="command-palette-cat">${FolderParser.escapeHtml(item.cmd.category)}</span>` : '';
                const hint = item.cmd.shortcut ? `<span class="command-palette-shortcut">${FolderParser.escapeHtml(item.cmd.shortcut)}</span>` : '';
                return `<div class="command-palette-item${sel}" data-idx="${idx}">
                    ${cat}
                    <span class="command-palette-title">${FolderParser.escapeHtml(item.cmd.title)}</span>
                    ${hint}
                </div>`;
            } else {
                return `<div class="command-palette-item command-palette-event${sel}" data-idx="${idx}">
                    <span class="command-palette-cat">Event</span>
                    <span class="command-palette-title">${FolderParser.escapeHtml(item.label)}</span>
                </div>`;
            }
        }).join('');
        this.list.innerHTML = html;

        // Bind clicks
        this.list.querySelectorAll('.command-palette-item').forEach(el => {
            el.addEventListener('click', () => {
                this.selectedIndex = parseInt(el.dataset.idx, 10);
                this._executeSelected();
            });
        });

        // Scroll selected into view
        const sel = this.list.querySelector('.command-palette-item.selected');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
    }

    _moveSelection(delta) {
        if (this.filtered.length === 0) return;
        this._setSelection((this.selectedIndex + delta + this.filtered.length) % this.filtered.length);
    }

    _setSelection(idx) {
        this.selectedIndex = Math.max(0, Math.min(idx, this.filtered.length - 1));
        this._renderList();
    }

    _executeSelected() {
        const item = this.filtered[this.selectedIndex];
        if (!item) return;
        this.close();
        try {
            if (item.kind === 'cmd') {
                item.cmd.action(this.app);
            } else if (item.kind === 'event') {
                if (typeof this.app.loadEvent === 'function') {
                    this.app.loadEvent(item.event);
                } else if (typeof this.app.onEventClick === 'function') {
                    this.app.onEventClick(item.event);
                }
            }
        } catch (err) {
            console.warn('[CommandPalette] Command failed:', err);
        }
    }
}

window.CommandPalette = CommandPalette;
