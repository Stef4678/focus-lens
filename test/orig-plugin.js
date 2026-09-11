/* ============================================================================
 *  Focus Lens — an isolation / focus-view plugin for Eagle
 *  --------------------------------------------------------------------------
 *  Built exclusively on the official Eagle window-plugin API:
 *    - eagle.item.getSelected()   -> read what the user selected in Eagle
 *    - eagle.item.get({tags, keywords, ids, fields}) -> server-side library
 *      queries (fast: Eagle filters, we don't download everything)
 *    - eagle.item.count(...)      -> cheap totals for tag chips
 *    - eagle.item.select(ids)     -> drive Eagle's OWN selection, so the main
 *      grid visibly isolates the lens ("everything else fades away")
 *    - eagle.item.open(id)        -> reveal a single item in Eagle
 *    - eagle.tagGroup / eagle.smartFolder -> optionally materialize a lens as
 *      a real, clickable sidebar item inside Eagle
 *  Docs: https://developer.eagle.cool/plugin-api/
 * ==========================================================================*/

(function () {
    'use strict';

    /* ------------------------------------------------------- tunables */
    var MAX_CANDIDATE_TAGS = 40;    // most frequent tags of the selection that become chips
    var AUTO_LENS_TAGS = 8;         // chips auto-activated when nothing is shared
    var HYDRATE_PAGE = 300;         // grid items hydrated per page
    var SELECT_SYNC_MAX = 2000;     // ids pushed into Eagle's selection
    var KEYWORD_TOKENS_MAX = 4;
    // Every Eagle call is bounded by a timeout so a hung query can never leave
    // the plugin stuck; a timed-out call just contributes an empty set + a log.
    var TAG_QUERY_TIMEOUT = 8000;       // ms for eagle.item.get({tags})
    var KEYWORD_QUERY_TIMEOUT = 8000;   // ms for eagle.item.get({keywords})
    var PAGE_QUERY_TIMEOUT = 15000;     // ms for eagle.item.get({ids})
    var ENTITY_PREFIX = 'Focus Lens · ';  // names given to artifacts we create in Eagle

    var STORE_PREFIX = 'focus-lens:v1:';
    var PLUGIN_VERSION = '1.6.0';   // keep in sync with manifest.json

    // Client-side tag index, built lazily from eagle.item.getAll() ONCE and
    // reused across runs within the same library. This is now the PRIMARY
    // engine: the plugin never calls the filtered item.get({tags}) query,
    // which is the call that never settles on some Eagle builds.
    var indexCache = null;          // { tags: Map<tag,Set<id>>, byId: Map<id,Item>, size }
    var indexPromise = null;        // in-flight build, so concurrent callers share it

    /* ------------------------------------------------------- helpers */
    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function truncate(s, n) {
        s = String(s == null ? '' : s);
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }

    function fmt(n) {
        if (n == null || isNaN(n)) return '–';
        try { return Number(n).toLocaleString('en-US'); } catch (e) { return String(n); }
    }

    /* ---- multi-criteria filters: colour / rating / date / shape / folder ---- */
    var COLOR_BUCKETS = [
        { id: 'red', hex: '#e5484d' }, { id: 'orange', hex: '#f76b15' }, { id: 'brown', hex: '#8b5a2b' },
        { id: 'yellow', hex: '#e8c547' }, { id: 'green', hex: '#46a758' }, { id: 'aqua', hex: '#12a594' },
        { id: 'blue', hex: '#3e63dd' }, { id: 'purple', hex: '#8e4ec6' }, { id: 'pink', hex: '#e93d82' },
        { id: 'black', hex: '#15161a' }, { id: 'gray', hex: '#8b8d98' }, { id: 'white', hex: '#eceef3' }
    ];
    function defaultFilters() {
        return { colors: [], minStar: 0, dateRange: 'any', shape: 'any', folder: '' };
    }
    function hexToRgb(hex) {
        var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!m) return null;
        var n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        var mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0, s = 0, l = (mx + mn) / 2;
        if (mx !== mn) {
            var d = mx - mn;
            s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
            if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (mx === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
        }
        return { h: h, s: s, l: l };
    }
    function colorBucketFromRgb(r, g, b) {
        var hsl = rgbToHsl(r, g, b);
        if (hsl.l < 0.13) return 'black';
        if (hsl.l > 0.9) return 'white';
        if (hsl.s < 0.13) return 'gray';
        var h = hsl.h;
        if (h < 16 || h >= 345) return 'red';
        if (h < 45) return hsl.l < 0.42 ? 'brown' : 'orange';
        if (h < 70) return 'yellow';
        if (h < 165) return 'green';
        if (h < 200) return 'aqua';
        if (h < 255) return 'blue';
        if (h < 292) return 'purple';
        if (h < 345) return 'pink';
        return null;
    }
    /* best-effort dominant colour bucket from Eagle's `palettes` field */
    function dominantBucket(palettes) {
        if (!Array.isArray(palettes)) return null;
        for (var i = 0; i < palettes.length; i++) {
            var p = palettes[i], rgb = null;
            if (Array.isArray(p) && p.length >= 3 && typeof p[0] === 'number') rgb = [p[0], p[1], p[2]];
            else if (typeof p === 'string') rgb = hexToRgb(p);
            else if (p && typeof p === 'object') {
                var v = p.color || p.hex || p.value || p.rgb || p.colors;
                if (Array.isArray(v) && v.length >= 3 && typeof v[0] === 'number') rgb = [v[0], v[1], v[2]];
                else if (typeof v === 'string') rgb = hexToRgb(v);
                else if (typeof p.r === 'number') rgb = [p.r, p.g, p.b];
            }
            if (rgb) return colorBucketFromRgb(rgb[0], rgb[1], rgb[2]);
        }
        return null;
    }
    function shapeOf(w, h) {
        if (!w || !h) return 'unknown';
        var r = w / h;
        if (Math.abs(r - 1) < 0.08) return 'square';
        if (r >= 2) return 'panoramic-landscape';
        if (r <= 0.5) return 'panoramic-portrait';
        return r > 1 ? 'landscape' : 'portrait';
    }
    function filtersActive(f) {
        if (!f) return false;
        return (f.colors && f.colors.length > 0) || (f.minStar > 0) ||
            (f.dateRange && f.dateRange !== 'any') || (f.shape && f.shape !== 'any') || !!f.folder;
    }
    function passesFilters(d, f) {
        if (!filtersActive(f)) return true;
        if (f.colors && f.colors.length && (!d.color || f.colors.indexOf(d.color) === -1)) return false;
        if (f.minStar > 0 && (d.star || 0) < f.minStar) return false;
        if (f.dateRange && f.dateRange !== 'any') {
            var days = parseInt(f.dateRange, 10);
            if (days && (!d.importedAt || d.importedAt < Date.now() - days * 86400000)) return false;
        }
        if (f.shape && f.shape !== 'any' && shapeOf(d.w, d.h) !== f.shape) return false;
        if (f.folder && (!d.folders || d.folders.indexOf(f.folder) === -1)) return false;
        return true;
    }
    function describeFilters(f) {
        var bits = [];
        if (f.colors && f.colors.length) bits.push(f.colors.join('/'));
        if (f.minStar > 0) bits.push('★' + f.minStar + '+');
        if (f.dateRange && f.dateRange !== 'any') bits.push('last ' + f.dateRange + 'd');
        if (f.shape && f.shape !== 'any') bits.push(f.shape.replace('panoramic-', 'pano '));
        if (f.folder) bits.push('folder');
        return bits.join(' · ');
    }
    /* when a selection has no tags, derive a lens from folder / shape / colour */
    function fallbackFiltersFromSelection(sel) {
        if (!sel || !sel.length) return null;
        var folderCounts = new Map();
        sel.forEach(function (it) {
            (it.folders || []).forEach(function (fid) {
                folderCounts.set(fid, (folderCounts.get(fid) || 0) + 1);
            });
        });
        var commonFolder = null;
        folderCounts.forEach(function (cnt, fid) { if (cnt === sel.length && !commonFolder) commonFolder = fid; });
        if (commonFolder) {
            var f = defaultFilters(); f.folder = commonFolder;
            return { filters: f, by: 'folder' };
        }
        var shape = null, shapeOk = true;
        sel.forEach(function (it) {
            var s = shapeOf(it.width, it.height);
            if (shape === null) shape = s; else if (s !== shape) shapeOk = false;
        });
        if (shapeOk && shape && shape !== 'unknown') {
            var f2 = defaultFilters(); f2.shape = shape;
            return { filters: f2, by: shape };
        }
        var col = null, colOk = true;
        sel.forEach(function (it) {
            var c = dominantBucket(it.palettes);
            if (col === null) col = c; else if (c !== col) colOk = false;
        });
        if (colOk && col) {
            var f3 = defaultFilters(); f3.colors = [col];
            return { filters: f3, by: col + ' colour' };
        }
        return null;
    }

    /* run an async op over an array with limited concurrency */
    function mapLimit(items, limit, fn) {
        return new Promise(function (resolve, reject) {
            var i = 0, out = new Array(items.length), done = 0, failed = false;
            function worker() {
                if (failed) return;
                if (i >= items.length) { if (++done === limit) resolve(out); return; }
                var idx = i++;
                Promise.resolve()
                    .then(function () { return fn(items[idx], idx); })
                    .then(function (v) { out[idx] = v; worker(); },
                          function (err) { if (!failed) { failed = true; reject(err); } });
            }
            if (!items.length) return resolve(out);
            var n = Math.min(limit, items.length);
            for (var k = 0; k < n; k++) worker();
        });
    }

    /* reject a promise if it doesn't settle within `ms` */
    function withTimeout(p, ms, label) {
        return new Promise(function (resolve, reject) {
            var t = setTimeout(function () {
                reject(new Error((label || 'operation') + ' timed out after ' + ms + 'ms'));
            }, ms);
            Promise.resolve(p).then(function (v) { clearTimeout(t); resolve(v); },
                                  function (e) { clearTimeout(t); reject(e); });
        });
    }

    /* lightweight logging to the plugin console (and eagle.log if present) */
    function dbg(msg) {
        try { console.log('[FocusLens] ' + msg); } catch (e) { /* noop */ }
        try {
            if (window.eagle && eagle.log && typeof eagle.log.info === 'function') {
                eagle.log.info('[FocusLens] ' + msg);
            }
        } catch (e) { /* noop */ }
    }

    /* remember the FIRST query failure of a run so it can be shown on-screen
       (distinguishes "no matches" from "a query didn't respond") */
    function recordQueryError(kind, label, err) {
        if (!state.lastQueryError) {
            state.lastQueryError = {
                kind: kind,
                label: label,
                msg: (err && err.message) ? err.message : String(err)
            };
        }
        // surface the failing step on-screen (the pill is non-blocking), so the
        // user can read exactly where a stall happens without DevTools
        try { if (el && el.busyText) el.busyText.textContent = '…waiting on ' + kind + ' “' + label + '”'; } catch (e) { }
        dbg(kind + ' query failed for "' + label + '": ' +
            (err && err.message ? err.message : String(err)));
    }

    /* ------------------------------------------------------- state */
    var state = {
        ready: false,
        libKey: 'default',
        libName: '',
        runToken: 0,
        totalsNonce: 0,
        busyCount: 0,
        lastQueryError: null,
        candidates: new Map(),          // tag -> {tag,freq,shared,total}
        lens: { tags: [], mode: 'any', keywords: '', filters: defaultFilters(), exclude: [] },
        lensKind: 'tags',               // 'tags' | 'similar' | 'duplicates'
        similar: null,                  // { seeds:[], minScore, byId:Map, total }
        history: [],                    // lens snapshots for back/forward
        historyPos: -1,
        navGuard: false,                // true while navigating history (skip re-push)
        lensIds: [],                    // full ordered id list of the lens
        currentIds: [],                 // ids currently displayed (any mode)
        lensTotal: 0,
        loaded: 0,
        smartTagProp: null,             // 'tags' if smartFolder rule supports tags
        smartTagMethod: 'contain',
        hasSmart: false,
        untaggedSel: false,             // the last read selection had no tags
        restoreLast: false,             // user setting: re-apply last lens on open
        _extCount: 0,                   // items indexed from other libraries
        lastError: null
    };

    var store = { saved: [], pushed: [] };   // per-library persisted data
    var storeDirty = false;
    var extraLibs = { enabled: false, paths: [] };  // other .library folders to also search

    /* ------------------------------------------------------- elements */
    var el = {};

    /* ------------------------------------------------------- storage */
    function libKey() {
        try {
            if (window.eagle && eagle.library && eagle.library.path) return eagle.library.path;
        } catch (e) { /* noop */ }
        return state.libKey || 'default';
    }

    function readStore() {
        store = { saved: [], pushed: [] };
        try {
            var raw = localStorage.getItem(STORE_PREFIX + libKey());
            if (raw) {
                var obj = JSON.parse(raw);
                if (obj && Array.isArray(obj.saved)) store.saved = obj.saved;
                if (obj && Array.isArray(obj.pushed)) store.pushed = obj.pushed;
            }
        } catch (e) { /* storage may be unavailable; plugin still works */ }
        storeDirty = false;
    }

    function writeStore() {
        try {
            localStorage.setItem(STORE_PREFIX + libKey(), JSON.stringify(store));
            storeDirty = false;
        } catch (e) { storeDirty = true; }
    }

    function saveNow() {
        if (storeDirty) writeStore();
    }

    /* per-library UI settings (e.g. "reopen last lens on start") */
    function readSettings() {
        try {
            var raw = localStorage.getItem(STORE_PREFIX + libKey() + ':settings');
            if (raw) {
                var obj = JSON.parse(raw);
                state.restoreLast = !!(obj && obj.restoreLast);
            } else {
                state.restoreLast = false;
            }
        } catch (e) { state.restoreLast = false; }
    }
    function writeSettings() {
        try {
            localStorage.setItem(STORE_PREFIX + libKey() + ':settings', JSON.stringify({ restoreLast: !!state.restoreLast }));
        } catch (e) { /* noop */ }
    }

    /* other libraries to also search (stored globally, across the active library) */
    function readExtras() {
        try {
            var raw = localStorage.getItem(STORE_PREFIX + 'extras');
            var obj = raw ? JSON.parse(raw) : null;
            extraLibs.enabled = !!(obj && obj.enabled);
            extraLibs.paths = [];
            var list = (obj && Array.isArray(obj.paths)) ? obj.paths : [];
            list.forEach(function (p) {
                p = normPath(p);
                if (p && !hasPath(extraLibs.paths, p)) extraLibs.paths.push(p);
            });
        } catch (e) { extraLibs = { enabled: false, paths: [] }; }
    }
    function writeExtras() {
        try {
            localStorage.setItem(STORE_PREFIX + 'extras', JSON.stringify(extraLibs));
        } catch (e) { /* noop */ }
        indexCache = null;   // extra libraries changed -> rebuild the index next focus
    }

    /* ------------------------------------------------------- ui helpers */
    function busyOn(text) {
        state.busyCount++;
        el.busyText.textContent = text || 'Working…';
        el.busy.hidden = false;
    }
    function busyOff() {
        state.busyCount = Math.max(0, state.busyCount - 1);
        if (!state.busyCount) el.busy.hidden = true;
    }

    var toastTimer = null;
    function toast(msg, isErr, ms) {
        el.toast.textContent = msg;
        el.toast.classList.toggle('err', !!isErr);
        el.toast.hidden = false;
        requestAnimationFrame(function () { el.toast.classList.add('show'); });
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            el.toast.classList.remove('show');
            setTimeout(function () { el.toast.hidden = true; }, 220);
        }, ms || 2600);
    }

    /* ------------------------------------------------------- lens name */
    function lensTokens(str) {
        return String(str || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, KEYWORD_TOKENS_MAX);
    }

    function lensDefKey(lens) {
        var t = lens.tags.slice().sort().join('|');
        return t + '::' + lens.mode + '::' + lensTokens(lens.keywords).join(' ');
    }

    function defaultLensName() {
        var L = state.lens;
        var label = L.mode === 'all' ? 'All of ' : 'Any of ';
        var text = '';
        if (L.tags.length) {
            text = label + L.tags.join(', ');
            var kws = lensTokens(L.keywords);
            if (kws.length) text += ' · text: ' + kws.join(' ');
        } else {
            var k2 = lensTokens(L.keywords);
            if (k2.length) text = 'Contains “' + k2.join(' ') + '”';
        }
        if (filtersActive(L.filters)) {
            var fd = describeFilters(L.filters);
            text = text ? text + ' · ' + fd : 'Filtered: ' + fd;
        }
        if ((L.exclude || []).length) {
            text += (text ? ' · ' : '') + 'not ' + L.exclude.join(', ');
        }
        return truncate(text || 'Empty lens', 80);
    }

    /* ------------------------------------------------------- lens history */
    function snapshotLens() {
        var L = state.lens;
        return {
            tags: L.tags.slice(), mode: L.mode, keywords: L.keywords || '',
            filters: JSON.parse(JSON.stringify(L.filters || defaultFilters())),
            exclude: (L.exclude || []).slice()
        };
    }
    function sameSnapshot(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    function pushHistory() {
        if (state.navGuard) return;
        var snap = snapshotLens();
        var cur = state.history[state.historyPos];
        if (cur && sameSnapshot(cur, snap)) return;
        state.history = state.history.slice(0, state.historyPos + 1);
        state.history.push(snap);
        if (state.history.length > 50) state.history.shift();
        state.historyPos = state.history.length - 1;
        updateHistoryUI();
    }
    function updateHistoryUI() {
        if (el.btnBack) el.btnBack.disabled = state.historyPos <= 0;
        if (el.btnFwd) el.btnFwd.disabled = state.historyPos >= state.history.length - 1;
    }
    function applySnapshot(snap) {
        state.navGuard = true;
        state.lens = {
            tags: (snap.tags || []).slice(),
            mode: snap.mode === 'all' ? 'all' : 'any',
            keywords: snap.keywords || '',
            filters: snap.filters ? JSON.parse(JSON.stringify(snap.filters)) : defaultFilters(),
            exclude: (snap.exclude || []).slice()
        };
        state.candidates = new Map();
        state.lens.tags.concat(state.lens.exclude).forEach(function (t) {
            if (!state.candidates.has(t)) state.candidates.set(t, { tag: t, freq: null, shared: false, total: null });
        });
        state.hintShown = null;
        if (el.kwInput) el.kwInput.value = state.lens.keywords;
        if (el.btnKwClear) el.btnKwClear.hidden = !state.lens.keywords;
        renderChips();
        syncFilterControls();
        setLensKind('tags');
        loadTotals();
        Promise.resolve(runLens()).then(function () { state.navGuard = false; },
                                          function () { state.navGuard = false; });
    }
    function navHistory(delta) {
        var p = state.historyPos + delta;
        if (p < 0 || p >= state.history.length) return;
        state.historyPos = p;
        updateHistoryUI();
        applySnapshot(state.history[p]);
    }

    /* ------------------------------------------------------- theme */
    var THEME_DARK = { DARK: 1, BLUE: 1, PURPLE: 1, GRAY: 1 };
    function applyTheme(theme) {
        var dark = !theme || theme === 'Auto' ? true : !!THEME_DARK[String(theme).toUpperCase()];
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    }

    /* ------------------------------------------------------- selection read */
    function readSelection() {
        return withTimeout(eagle.item.getSelected(), 8000, 'getSelected').catch(function () { return []; });
    }

    function summarizeSelection(sel) {
        var tagged = 0;
        for (var i = 0; i < sel.length; i++) if ((sel[i].tags || []).length) tagged++;
        var s = sel.length + ' selected';
        if (sel.length) s += ' · ' + tagged + ' tagged · ' + (sel.length - tagged) + ' untagged';
        el.selSummary.innerHTML = sel.length
            ? s + ' — now isolating <b>' + esc(defaultLensName()) + '</b>'
            : 'Select items in Eagle, then press <b>Focus</b>.';
    }

    /* ------------------------------------------------------- candidates / chips */
    function buildCandidates(sel) {
        var freq = new Map();
        for (var i = 0; i < sel.length; i++) {
            var tags = sel[i].tags || [];
            for (var j = 0; j < tags.length; j++) {
                var t = tags[j];
                if (!t) continue;
                freq.set(t, (freq.get(t) || 0) + 1);
            }
        }
        var entries = Array.from(freq.entries())
            .sort(function (a, b) { return (b[1] - a[1]) || a[0].localeCompare(b[0]); })
            .slice(0, MAX_CANDIDATE_TAGS);
        var map = new Map();
        entries.forEach(function (e) {
            map.set(e[0], { tag: e[0], freq: e[1], shared: e[1] === sel.length, total: null });
        });
        return map;
    }

    function renderChips() {
        var host = el.tagChips;
        var parts = [];
        if (!state.candidates.size) {
            host.innerHTML = '<span class="hint">No tags found on the selection — type a text filter above instead.</span>';
            return;
        }
        state.candidates.forEach(function (c) {
            var active = state.lens.tags.indexOf(c.tag) !== -1;
            var excluded = (state.lens.exclude || []).indexOf(c.tag) !== -1;
            var meta = [];
            if (c.freq && state.selectedCount > 1) meta.push(c.freq + '/' + state.selectedCount);
            if (c.total != null) meta.push(fmt(c.total));
            var tooltip = 'Tag “' + c.tag + '”'
                + (c.freq != null ? ' · in ' + c.freq + ' of the ' + state.selectedCount + ' selected items' : '')
                + (c.total != null ? ' · ' + fmt(c.total) + ' items in this library' : '')
                + '\nClick: include/exclude · Shift+Click: exclude';
            parts.push(
                '<span class="chip' + (active ? ' active' : '') + (excluded ? ' excluded' : '') +
                    (c.shared ? ' shared' : '') + '" data-tag="' + esc(c.tag) + '" title="' + esc(tooltip) + '">' +
                    '<span class="t">' + esc(c.tag) + '</span>' +
                    (meta.length ? '<span class="meta">' + esc(meta.join(' · ')) + '</span>' : '') +
                    '<span class="x" aria-hidden="true">' + (excluded ? '⊘' : (active ? '✕' : '+')) + '</span>' +
                '</span>'
            );
        });
        host.innerHTML = parts.join('');
        if (state.candidates.size > 0 && state.hintShown) {
            host.innerHTML += '<span class="hint"> — ' + esc(state.hintShown) + '</span>';
        }
    }

    async function loadTotals() {
        var need = [];
        state.candidates.forEach(function (c) { if (c.total == null) need.push(c); });
        if (!need.length) return;
        var nonce = ++state.totalsNonce;
        // read counts from the client-side index (primary); fall back to a
        // bounded count() only if the index is unavailable
        var idx = await getIndex().catch(function () { return null; });
        if (nonce !== state.totalsNonce) return;
        if (idx) {
            var changed = false;
            need.forEach(function (c) {
                var s = idx.tags.get(c.tag);
                if (s && s.size != null) { c.total = s.size; changed = true; }
            });
            if (changed) renderChips();
            return;
        }
        await mapLimit(need, 6, async function (c) {
            try {
                c.total = await withTimeout(eagle.item.count({ tags: [c.tag] }), 5000, 'count')
                    .catch(function () { return null; });
            } catch (e) { c.total = null; }
        });
        if (nonce === state.totalsNonce) renderChips();
    }

    /* ------------------------------------------------------- filter UI */
    function renderColorSwatches() {
        if (!el.colorRow) return;
        var f = state.lens.filters || (state.lens.filters = defaultFilters());
        el.colorRow.innerHTML = '';
        COLOR_BUCKETS.forEach(function (b) {
            var btn = document.createElement('button');
            btn.className = 'swatch' + (f.colors.indexOf(b.id) !== -1 ? ' on' : '');
            btn.style.background = b.hex;
            btn.title = b.id;
            btn.dataset.color = b.id;
            btn.onclick = function () {
                var i = f.colors.indexOf(b.id);
                if (i === -1) f.colors.push(b.id); else f.colors.splice(i, 1);
                renderColorSwatches();
                updateFilterResetBtn();
                runLens();
            };
            el.colorRow.appendChild(btn);
        });
    }
    function updateFilterResetBtn() {
        if (el.btnClearFilters) el.btnClearFilters.hidden = !filtersActive(state.lens.filters);
    }
    function syncFilterControls() {
        var f = state.lens.filters || (state.lens.filters = defaultFilters());
        if (el.starSel) el.starSel.value = String(f.minStar || 0);
        if (el.dateSel) el.dateSel.value = f.dateRange || 'any';
        if (el.shapeSel) el.shapeSel.value = f.shape || 'any';
        if (el.folderSel) el.folderSel.value = f.folder || '';
        renderColorSwatches();
        updateFilterResetBtn();
    }
    function populateFolders(folders) {
        if (!el.folderSel && !el.bulkFolderSel) return;
        var sorted = (folders || []).slice().sort(function (a, b) {
            return String(a.name || '').localeCompare(String(b.name || ''));
        });
        if (el.folderSel) {
            var cur = (state.lens.filters && state.lens.filters.folder) || '';
            el.folderSel.innerHTML = '<option value="">Any</option>';
            sorted.forEach(function (fo) {
                var o = document.createElement('option');
                o.value = fo.id; o.textContent = fo.name || fo.id;
                el.folderSel.appendChild(o);
            });
            el.folderSel.value = cur;
        }
        if (el.bulkFolderSel) {
            var cur2 = el.bulkFolderSel.value || '';
            el.bulkFolderSel.innerHTML = '<option value="">folder…</option>';
            sorted.forEach(function (fo) {
                var o = document.createElement('option');
                o.value = fo.id; o.textContent = fo.name || fo.id;
                el.bulkFolderSel.appendChild(o);
            });
            el.bulkFolderSel.value = cur2;
        }
    }
    var foldersLoaded = false;
    async function loadFolders() {
        if (foldersLoaded || !el.folderSel) return;
        foldersLoaded = true;
        try {
            var folders = await withTimeout(eagle.folder.getAll(), 10000, 'folder.getAll');
            populateFolders(folders);
        } catch (e) { dbg('folder.getAll failed: ' + (e && e.message ? e.message : e)); foldersLoaded = false; }
    }
    function ensureFilterUI(idx) {
        if (el.colorRow) el.colorRow.hidden = !(idx && idx.hasColor);
        loadFolders();
    }

    function toggleTag(tag, exclude) {
        if (!state.lens.exclude) state.lens.exclude = [];
        var inInc = state.lens.tags.indexOf(tag);
        var inExc = state.lens.exclude.indexOf(tag);
        if (exclude) {
            if (inInc !== -1) state.lens.tags.splice(inInc, 1);
            if (inExc !== -1) state.lens.exclude.splice(inExc, 1); else state.lens.exclude.push(tag);
        } else {
            if (inExc !== -1) state.lens.exclude.splice(inExc, 1);
            if (inInc !== -1) state.lens.tags.splice(inInc, 1); else state.lens.tags.push(tag);
        }
        renderChips();
        runLens();
    }

    /* ===============================================================
     *  Core: run the lens against the whole library
     *  Semantics are implemented client-side over per-tag / per-word
     *  server queries, so "Any" (union) and "All" (intersection) are
     *  deterministic regardless of Eagle's own multi-value semantics.
     * ===============================================================*/
    /* ---- filesystem access (Node native API) — used to read OTHER libraries ---- */
    var fsMod = null, pathMod = null;
    try { fsMod = require('fs'); } catch (e) { fsMod = null; }
    try { pathMod = require('path'); } catch (e) { pathMod = null; }

    function toFileUrl(p) {
        var s = String(p).replace(/\\/g, '/');
        if (/^[a-zA-Z]:\//.test(s)) return 'file:///' + encodeURI(s);   // file:///C:/...
        if (s.charAt(0) !== '/') s = '/' + s;
        return 'file://' + encodeURI(s);                               // file:///abs
    }
    /* normalize a path so the SAME library isn't added twice under different
       spellings (backslashes vs slashes, trailing slash, case on Windows) */
    function normPath(p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, ''); }
    function normKey(p) { return normPath(p).toLowerCase(); }
    function hasPath(list, p) {
        var k = normKey(p);
        for (var i = 0; i < list.length; i++) if (normKey(list[i]) === k) return true;
        return false;
    }
    function parseTags(tf) {
        var out = [];
        if (Array.isArray(tf)) {
            tf.forEach(function (t) {
                if (typeof t === 'string') { if (t) out.push(t); }
                else if (t && typeof t === 'object') {
                    var n = t.name || t.value || t.text;
                    if (n) out.push(String(n));
                }
            });
        } else if (typeof tf === 'string' && tf) {
            out.push(tf);
        }
        return out;
    }
    function hashStr(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }
    async function readJsonFile(p) {
        var data = await fsMod.promises.readFile(p, 'utf8');
        return JSON.parse(data);
    }
    async function findMediaThumb(infoDir) {
        var fsp = fsMod.promises;
        var names = await fsp.readdir(infoDir).catch(function () { return []; });
        var thumb = null;
        if (names.indexOf('thumbnails') !== -1) {
            var ts = await fsp.readdir(infoDir + '/thumbnails').catch(function () { return []; });
            for (var i = 0; i < ts.length; i++) {
                if (/\.(png|jpe?g|webp|gif)$/i.test(ts[i])) { thumb = toFileUrl(infoDir + '/thumbnails/' + ts[i]); break; }
            }
        }
        var mediaName = '', mediaExt = '';
        var imgRe = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
        for (var j = 0; j < names.length; j++) {
            var f = names[j];
            if (f === 'metadata.json' || f === 'info.json' || f === 'thumbnails' || f.indexOf('.') === -1) continue;
            var ext = f.slice(f.lastIndexOf('.') + 1);
            if (/^(png|jpe?g|gif|webp|svg|bmp|mp4|mov|avi|mkv|webm|pdf)$/i.test(ext)) { mediaName = f; mediaExt = ext; break; }
        }
        if (!thumb && mediaName && imgRe.test('.' + mediaExt)) thumb = toFileUrl(infoDir + '/' + mediaName);
        return { name: mediaName, ext: mediaExt, thumb: thumb };
    }
    async function readItemInfo(infoDir) {
        var meta = await readJsonFile(infoDir + '/metadata.json').catch(function () { return null; });
        if (!meta || !meta.id) return null;
        var media = await findMediaThumb(infoDir).catch(function () { return { name: '', ext: '', thumb: null }; });
        return {
            id: meta.id,
            name: meta.name || (media.name ? media.name.replace(/\.[^.]+$/, '') : ''),
            ext: String(meta.ext || media.ext || '').toLowerCase(),
            tags: parseTags(meta.tags),
            importedAt: meta.btime || meta.mtime || 0,
            star: meta.star || 0,
            size: meta.size || 0,
            folders: Array.isArray(meta.folders) ? meta.folders : [],
            w: meta.width || 0, h: meta.height || 0,
            color: dominantBucket(meta.palettes),
            thumb: media.thumb
        };
    }
    async function scanExternalLibrary(libPath) {
        // Best-effort read of another .library directory: walk images/ for
        // <id>.info folders, parse each metadata.json, and build display items.
        var items = [], tags = new Map();
        var fsp = fsMod && fsMod.promises;
        if (!fsp) return { items: items, tags: tags, count: 0 };
        var imagesDir = libPath.replace(/[\\/]+$/, '') + '/images';
        var libName = String(libPath).split(/[\\/]/).pop().replace(/\.library$/i, '');
        var idPrefix = 'ext#' + hashStr(libPath) + '#';

        async function walk(dir, depth) {
            if (depth > 4) return;
            var names = await fsp.readdir(dir).catch(function () { return []; });
            for (var i = 0; i < names.length; i++) {
                var name = names[i];
                if (name.charAt(0) === '.') continue;
                var full = dir + '/' + name;
                var st = await fsp.stat(full).catch(function () { return null; });
                if (!st) continue;
                if (st.isDirectory()) {
                    if (/\.info$/i.test(name)) {
                        var it = await readItemInfo(full).catch(function () { return null; });
                        if (it && it.id) {
                            var key = idPrefix + it.id;
                            items.push({
                                id: key, realId: it.id, name: it.name || '', ext: it.ext || '',
                                tags: it.tags || [], importedAt: it.importedAt || 0,
                                star: it.star || 0, folders: it.folders || [], size: it.size || 0,
                                w: it.w || 0, h: it.h || 0, color: it.color || null,
                                thumb: it.thumb, external: true, libName: libName
                            });
                            (it.tags || []).forEach(function (t) {
                                var s = tags.get(t);
                                if (!s) { s = new Set(); tags.set(t, s); }
                                s.add(key);
                            });
                        }
                    } else if (name !== 'thumbnails') {
                        await walk(full, depth + 1);
                    }
                }
            }
        }
        await walk(imagesDir, 0).catch(function () { });
        return { items: items, tags: tags, count: items.length };
    }

    /* Build (once) a client-side index of the active library (and any extra
       libraries), giving tag -> Set<key> and key -> normalized display item.
       This is the PRIMARY data source — filtering, counting and rendering are
       done in memory, so no heavy per-tag query is issued. */
    async function getIndex() {
        if (indexCache) return indexCache;
        if (indexPromise) return indexPromise;
        indexPromise = (async function build() {
            try {
                state._extCount = 0;
                var all = await withTimeout(eagle.item.getAll(), 25000, 'getAll');
                var tags = new Map(), byId = new Map();
                var seenIds = new Set();   // real Eagle item ids already indexed (active + extras)
                var hasColor = false;
                if (Array.isArray(all)) {
                    all.forEach(function (it) {
                        var d = {
                            id: it.id, realId: it.id,
                            name: it.name || '', ext: String(it.ext || '').toLowerCase(),
                            tags: (it.tags || []).slice(),
                            importedAt: it.importedAt || it.modifiedAt || 0,
                            star: it.star || 0,
                            size: it.size || 0,
                            folders: (it.folders || []).slice(),
                            w: it.width || 0, h: it.height || 0,
                            color: dominantBucket(it.palettes),
                            thumb: it.thumbnailURL || (it.noThumbnail ? (it.fileURL || '') : ''),
                            external: false, libName: state.libName || 'Library'
                        };
                        seenIds.add(it.id);
                        byId.set(it.id, d);
                        if (d.color) hasColor = true;
                        (d.tags || []).forEach(function (t) {
                            var s = tags.get(t); if (!s) { s = new Set(); tags.set(t, s); }
                            s.add(it.id);
                        });
                    });
                }
                if (fsMod && extraLibs.enabled && extraLibs.paths.length) {
                    try { if (el.busyText) el.busyText.textContent = 'Scanning other libraries…'; } catch (e) { }
                    for (var i = 0; i < extraLibs.paths.length; i++) {
                        var ex = await scanExternalLibrary(extraLibs.paths[i]);
                        var added = 0;
                        ex.items.forEach(function (d) {
                            // skip any item already indexed (same Eagle id) so an
                            // image can never appear more than once across libraries
                            if (seenIds.has(d.realId)) return;
                            seenIds.add(d.realId);
                            byId.set(d.id, d);
                            if (d.color) hasColor = true;
                            (d.tags || []).forEach(function (t) {
                                var s = tags.get(t); if (!s) { s = new Set(); tags.set(t, s); }
                                s.add(d.id);
                            });
                            added++;
                        });
                        state._extCount += added;
                        if (added) dbg('extra library ' + extraLibs.paths[i] + ': ' + added + ' items');
                    }
                }
                indexCache = { tags: tags, byId: byId, size: byId.size, extCount: state._extCount, hasColor: hasColor };
                dbg('indexed ' + byId.size + ' items, ' + tags.size + ' tags (ext=' + state._extCount + ')');
                return indexCache;
            } catch (e) {
                state._indexErr = e;
                dbg('getAll() failed: ' + (e && e.message ? e.message : e));
                return null;
            } finally {
                indexPromise = null;
            }
        })();
        return indexPromise;
    }

    function indexSetForTag(idx, tag) {
        return (idx && idx.tags.get(tag)) || new Set();
    }
    function keywordSetFromIndex(idx, word) {
        var re = String(word).toLowerCase();
        var set = new Set();
        idx.byId.forEach(function (it, id) {
            var hay = ((it.name || '') + ' ' + (it.tags || []).join(' ')).toLowerCase();
            if (hay.indexOf(re) !== -1) set.add(id);
        });
        return set;
    }

    function combineSets(sets, mode) {
        if (!sets.length) return new Set();
        if (mode === 'all') {
            var acc = null;
            sets.forEach(function (s) {
                if (acc === null) acc = new Set(s);
                else {
                    var next = new Set();
                    acc.forEach(function (id) { if (s.has(id)) next.add(id); });
                    acc = next;
                }
            });
            return acc;
        }
        var union = new Set();
        sets.forEach(function (s) { s.forEach(function (id) { union.add(id); }); });
        return union;
    }

    /* If the lens matches exactly the items the user had selected (i.e. the
       library has nothing else sharing those tags), say so instead of silently
       showing the same thumbnails. */
    function updateLensNote(combined) {
        if (!el.lensNote) return;
        var sel = state.selected || [];
        var justSel = false;
        if (sel.length && combined && combined.size > 0) {
            var allIn = sel.every(function (it) { return combined.has(it.id); });
            justSel = allIn && combined.size <= sel.length;
        }
        if (justSel) {
            el.lensNote.innerHTML = 'Only these ' + fmt(combined.size) + ' selected item(s) match — tag more items this way (or switch to ' +
                '<b>Any tag</b>) to grow the isolated set.';
            el.lensNote.hidden = false;
        } else {
            el.lensNote.hidden = true;
        }
    }

    /* ===============================================================
     *  AI visual similarity lens (Eagle "AI Search" plugin)
     * ===============================================================*/
    function setLensKind(kind) {
        state.lensKind = kind;
        var tags = kind === 'tags';
        if (el.simPanel) el.simPanel.hidden = kind !== 'similar';
        if (el.modeSeg) el.modeSeg.hidden = !tags;
        if (el.kwRow) el.kwRow.hidden = !tags;
        if (el.tagChips) el.tagChips.hidden = !tags;
        if (el.filterBox) el.filterBox.hidden = !tags;
        if (el.pinRow) el.pinRow.hidden = !tags;
        if (el.pushArea && !tags) el.pushArea.hidden = true;
    }

    function aiSearchModule() {
        try { return (window.eagle && eagle.extraModule && eagle.extraModule.aiSearch) || null; }
        catch (e) { return null; }
    }

    async function doSimilar() {
        if (!state.ready) return;
        busyOn('Reading selection…');
        try {
            var sel = await readSelection();
            if (!sel.length) { toast('Select an image in Eagle first, then press Find Similar.', true); return; }

            var aiSearch = aiSearchModule();
            if (!aiSearch || typeof aiSearch.searchByItemId !== 'function') {
                toast('AI Search plugin not available — install “AI Search” from Eagle’s Plugin Center.', true, 7000);
                return;
            }
            // service status
            try {
                if (typeof aiSearch.isInstalled === 'function' &&
                    !(await withTimeout(aiSearch.isInstalled(), 8000, 'aiSearch.isInstalled'))) {
                    if (typeof aiSearch.open === 'function') aiSearch.open();
                    toast('“AI Search” is required — opening it so you can install it.', true, 7000);
                    return;
                }
                if (typeof aiSearch.isReady === 'function' &&
                    !(await withTimeout(aiSearch.isReady(), 8000, 'aiSearch.isReady'))) {
                    toast('AI Search is starting/syncing — try again in a moment.', true, 5000);
                    return;
                }
            } catch (e) { dbg('aiSearch status check failed: ' + (e && e.message ? e.message : e)); }

            var minScore = (state.similar && state.similar.minScore) || 0.45;
            pushHistory();
            state.similar = { seeds: sel.map(function (it) { return it.id; }), minScore: minScore, byId: new Map(), total: 0 };
            setLensKind('similar');
            if (el.simThreshold) el.simThreshold.value = String(Math.round(minScore * 100));
            if (el.simPct) el.simPct.textContent = Math.round(minScore * 100) + '%';

            busyOn('Searching similar images…');
            var merged = new Map();
            var perSeed = 120;
            for (var i = 0; i < sel.length; i++) {
                var res = await withTimeout(aiSearch.searchByItemId(sel[i].id, { limit: perSeed }), 90000, 'searchByItemId')
                    .catch(function (e) { dbg('searchByItemId failed: ' + (e && e.message ? e.message : e)); return null; });
                if (!res || !Array.isArray(res.results)) continue;
                res.results.forEach(function (r) {
                    if (!r || !r.item || !r.item.id) return;
                    var prev = merged.get(r.item.id);
                    if (!prev || (r.score || 0) > (prev.score || 0)) merged.set(r.item.id, r);
                });
            }
            if (!merged.size) {
                el.grid.innerHTML = '';
                el.grid.hidden = true;
                el.emptyHint.innerHTML = '<p><b>No similar images found.</b></p><p>AI Search may still be indexing this library, or the image has no close matches.</p>';
                el.emptyHint.hidden = false;
                el.lensCount.innerHTML = '0 items';
                toast('No similar images found.', true, 4000);
                return;
            }
            merged.forEach(function (r, id) {
                var it = r.item;
                state.similar.byId.set(id, {
                    id: id, realId: id,
                    name: it.name || '', ext: String(it.ext || '').toLowerCase(),
                    tags: (it.tags || []).slice(),
                    importedAt: it.importedAt || it.modifiedAt || 0,
                    thumb: it.thumbnailURL || (it.noThumbnail ? (it.fileURL || '') : ''),
                    external: false, libName: state.libName || 'Library',
                    score: r.score || 0
                });
            });
            state.similar.total = state.similar.byId.size;
            renderSimilar();
        } catch (err) {
            dbg('doSimilar error: ' + (err && err.message ? err.message : err));
            toast('Similar search failed: ' + (err && err.message ? err.message : err), true, 5000);
        } finally {
            busyOff();
        }
    }

    function renderSimilar() {
        var s = state.similar;
        if (!s) return;
        var min = s.minScore;
        var list = [];
        s.byId.forEach(function (d) { if (d.score >= min) list.push(d); });
        list.sort(function (a, b) { return b.score - a.score; });

        el.grid.innerHTML = '';
        el.grid.hidden = false;
        el.emptyHint.hidden = true;
        el.loadMoreRow.hidden = true;
        if (el.lensNote) el.lensNote.hidden = true;
        state.currentIds = list.map(function (d) { return d.id; });
        if (el.actionRow) el.actionRow.hidden = !list.length;
        if (el.simCount) el.simCount.textContent = fmt(list.length) + ' of ' + fmt(s.total);
        el.lensCount.innerHTML = fmt(list.length) + ' items <small>AI similarity ≥ ' + Math.round(min * 100) + '%</small>';

        if (!list.length) {
            el.grid.hidden = true;
            el.emptyHint.innerHTML = '<p><b>Nothing at that similarity threshold.</b></p><p>Drag the slider left to include looser matches.</p>';
            el.emptyHint.hidden = false;
            return;
        }
        appendCells(list.slice(0, 500));

        if (state.capSelect && el.syncSel.checked) {
            var ids = list.slice(0, SELECT_SYNC_MAX).map(function (d) { return d.realId; });
            if (ids.length) withTimeout(eagle.item.select(ids), 8000, 'select').catch(function () { /* noop */ });
        }
    }

    /* ===============================================================
     *  Bulk actions on the current result set
     * ===============================================================*/
    function currentItems() {
        var out = [];
        (state.currentIds || []).forEach(function (k) {
            var d = (indexCache && indexCache.byId.get(k)) || (state.similar && state.similar.byId.get(k));
            if (d) out.push(d);
        });
        return out;
    }
    function activeRealIds() {
        var out = [];
        currentItems().forEach(function (d) { if (!d.external && d.realId) out.push(d.realId); });
        return out;
    }
    function copyText(t) {
        try { if (eagle.clipboard && typeof eagle.clipboard.writeText === 'function') { eagle.clipboard.writeText(t); return true; } } catch (e) { }
        try { if (navigator.clipboard) { navigator.clipboard.writeText(t); return true; } } catch (e) { }
        return false;
    }
    async function bulkApplyTag() {
        var name = (el.bulkTagInput.value || '').trim();
        if (!name) { toast('Type a tag name first.', true); return; }
        var ids = activeRealIds();
        if (!ids.length) { toast('No active-library items in the result to tag.', true); return; }
        busyOn('Tagging ' + ids.length + ' item(s)…');
        try {
            var items = await withTimeout(eagle.item.getByIds(ids), 30000, 'getByIds');
            var n = 0;
            for (var i = 0; i < items.length; i++) {
                var it = items[i], tags = (it.tags || []).slice();
                if (tags.indexOf(name) === -1) { tags.push(name); it.tags = tags; await it.save(); n++; }
            }
            el.bulkTagInput.value = '';
            indexCache = null;   // tags changed -> rebuild index next run
            toast('Added tag “' + name + '” to ' + n + ' item' + (n === 1 ? '' : 's') + '.');
        } catch (e) { toast('Bulk tag failed: ' + (e && e.message ? e.message : e), true, 4000); }
        finally { busyOff(); }
    }
    async function bulkAddFolder() {
        var fid = el.bulkFolderSel ? el.bulkFolderSel.value : '';
        if (!fid) { toast('Pick a folder first.', true); return; }
        var ids = activeRealIds();
        if (!ids.length) { toast('No active-library items in the result.', true); return; }
        busyOn('Adding ' + ids.length + ' item(s) to folder…');
        try {
            var items = await withTimeout(eagle.item.getByIds(ids), 30000, 'getByIds');
            var n = 0;
            for (var i = 0; i < items.length; i++) {
                var it = items[i], fs = (it.folders || []).slice();
                if (fs.indexOf(fid) === -1) { fs.push(fid); it.folders = fs; await it.save(); n++; }
            }
            indexCache = null;
            toast('Added ' + n + ' item' + (n === 1 ? '' : 's') + ' to the folder.');
        } catch (e) { toast('Bulk folder failed: ' + (e && e.message ? e.message : e), true, 4000); }
        finally { busyOff(); }
    }
    function bulkCopyNames() {
        var items = currentItems();
        if (!items.length) { toast('Nothing to copy.', true); return; }
        var ok = copyText(items.map(function (d) { return d.name || d.realId || ''; }).join('\n'));
        toast(ok ? 'Copied ' + items.length + ' names.' : 'Clipboard unavailable.', !ok);
    }
    async function bulkExport() {
        if (!fsMod || !fsMod.promises) { toast('File access unavailable in this runtime.', true); return; }
        var items = currentItems();
        if (!items.length) { toast('Nothing to export.', true); return; }
        try {
            var res = await eagle.dialog.showSaveDialog({ title: 'Export Focus Lens list', defaultPath: 'focus-lens-export.txt' });
            if (!res || res.canceled || !res.filePath) return;
            var lines = items.map(function (d) {
                return [d.name || '', (d.tags || []).join(','), d.ext || '',
                    d.score != null ? Math.round(d.score * 100) + '%' : '',
                    d.external ? (d.libName || 'other') : 'active'].join('\t');
            });
            await fsMod.promises.writeFile(res.filePath, 'name\ttags\text\tsimilarity\tlibrary\n' + lines.join('\n'), 'utf8');
            toast('Exported ' + items.length + ' items.');
        } catch (e) { toast('Export failed: ' + (e && e.message ? e.message : e), true, 4000); }
    }

    /* ===============================================================
     *  Duplicate finder (whole index, incl. other libraries)
     * ===============================================================*/
    async function findDuplicates() {
        if (!state.ready) return;
        busyOn('Finding duplicates…');
        try {
            var idx = await getIndex();
            if (!idx) { toast('Library could not be loaded.', true); return; }
            var groups = new Map();
            idx.byId.forEach(function (d) {
                var key = String(d.name || '').toLowerCase().trim();
                if (!key) return;
                key += '|' + (d.size || 0) + '|' + (d.w || 0) + 'x' + (d.h || 0);
                var g = groups.get(key);
                if (!g) { g = []; groups.set(key, g); }
                g.push(d.id);
            });
            var dupIds = [], dupGroups = 0;
            groups.forEach(function (arr) {
                if (arr.length > 1) { dupGroups++; arr.forEach(function (id) { dupIds.push(id); }); }
            });
            pushHistory();
            setLensKind('duplicates');
            state.lensIds = dupIds;
            state.lensTotal = dupIds.length;
            state.currentIds = dupIds;
            state.loaded = 0;
            el.grid.innerHTML = '';
            el.loadMoreRow.hidden = true;
            if (!dupGroups) {
                el.grid.hidden = true;
                el.emptyHint.innerHTML = '<p><b>No duplicates found.</b></p><p>Matching by identical name + file size + dimensions across the indexed libraries.</p>';
                el.emptyHint.hidden = false;
                el.lensCount.innerHTML = '0 items';
                if (el.lensNote) el.lensNote.hidden = true;
                if (el.actionRow) el.actionRow.hidden = true;
                toast('No duplicates found.');
                return;
            }
            el.grid.hidden = false;
            el.emptyHint.hidden = true;
            el.lensCount.innerHTML = fmt(dupIds.length) + ' items <small>' + fmt(dupGroups) + ' duplicate groups</small>';
            if (el.lensNote) {
                el.lensNote.textContent = fmt(dupGroups) + ' groups · ' + fmt(dupIds.length) + ' items share name + size + dimensions';
                el.lensNote.hidden = false;
            }
            if (el.actionRow) el.actionRow.hidden = false;
            await loadMore();
            syncEagleSelection(dupIds);
            refreshPushUI();
        } catch (e) { toast('Duplicate scan failed: ' + (e && e.message ? e.message : e), true, 4000); }
        finally { busyOff(); }
    }

    async function runLens() {
        var L = state.lens;
        var tags = L.tags.slice();
        var kws = lensTokens(L.keywords);
        var F = L.filters || defaultFilters();
        var hasF = filtersActive(F);
        state.lastError = null;

        if (!tags.length && !kws.length && !hasF) {
            state.lensIds = [];
            state.lensTotal = 0;
            state.loaded = 0;
            el.lensCount.innerHTML = '0 items';
            el.emptyHint.innerHTML = emptyLensHint();
            el.emptyHint.hidden = false;
            el.grid.innerHTML = '';
            el.grid.hidden = true;
            el.loadMoreRow.hidden = true;
            if (el.lensNote) el.lensNote.hidden = true;
            state.currentIds = [];
            if (el.actionRow) el.actionRow.hidden = true;
            refreshPushUI();
            return;
        }

        pushHistory();
        var token = ++state.runToken;
        state.lastQueryError = null;
        busyOn('Isolating…');
        try {
            el.busyText.textContent = 'Indexing library… (first run only)';
            var idx = await getIndex();
            if (token !== state.runToken) return;
            if (!idx) {
                state.lastQueryError = state._indexErr
                    ? { kind: 'library', label: 'getAll', msg: state._indexErr.message }
                    : { kind: 'library', label: 'getAll', msg: 'no data' };
                el.busyText.textContent = 'Library could not be loaded.';
            }
            ensureFilterUI(idx);
            el.busyText.textContent = 'Filtering…';

            // Base set: tag union/intersection, or the whole indexed library
            // when the lens is defined purely by filters / text.
            var combined;
            if (tags.length) {
                var sets = [];
                for (var t = 0; t < tags.length; t++) sets.push(indexSetForTag(idx, tags[t]));
                combined = combineSets(sets, L.mode);
            } else {
                combined = new Set(idx ? idx.byId.keys() : []);
            }
            for (var i = 0; i < kws.length; i++) {
                var kwSet = idx ? keywordSetFromIndex(idx, kws[i]) : new Set();
                if (kwSet.size) {
                    var kf = new Set();
                    combined.forEach(function (id) { if (kwSet.has(id)) kf.add(id); });
                    combined = kf;
                } else if (kws.length) {
                    combined = new Set();   // keyword matched nothing -> empty
                }
            }
            // Multi-criteria filters (colour / rating / date / shape / folder)
            if (hasF && idx) {
                var ff = new Set();
                combined.forEach(function (id) {
                    var d = idx.byId.get(id);
                    if (d && passesFilters(d, F)) ff.add(id);
                });
                combined = ff;
            }
            // Excluded tags (shift-click a chip) -> subtract
            var exc = L.exclude || [];
            if (exc.length && idx) {
                var exSet = new Set();
                exc.forEach(function (t) {
                    var s = idx.tags.get(t);
                    if (s) s.forEach(function (id) { exSet.add(id); });
                });
                if (exSet.size) {
                    var nf = new Set();
                    combined.forEach(function (id) { if (!exSet.has(id)) nf.add(id); });
                    combined = nf;
                }
            }
            if (token !== state.runToken) return;
            dbg('combined set size = ' + combined.size + ' (tags=' + tags.length + ', keywords=' + kws.length + ', filters=' + hasF + ')');

            var ids = Array.from(combined);
            if (!ids.length) {
                if (token !== state.runToken) return;
                dbg('lens matched 0 items');
                state.lensIds = [];
                state.lensTotal = 0;
                state.loaded = 0;
                el.lensCount.innerHTML = '0 items';
                el.grid.innerHTML = '';
                el.grid.hidden = true;
                el.loadMoreRow.hidden = true;
                state.currentIds = [];
                if (el.actionRow) el.actionRow.hidden = true;
                el.emptyHint.innerHTML =
                    (state.lastQueryError
                        ? '<p><b>A query didn’t respond</b> (' + esc(state.lastQueryError.kind) +
                          ' “' + esc(state.lastQueryError.label) + '”, timed out) — so this is an Eagle API/version issue, not “no matches”.</p>'
                        : '<p><b>No items match this lens.</b></p>') +
                    '<p>Nothing in the library carries ' + esc(defaultLensName()) +
                    '. Try switching to <b>Any tag</b>, or drop a tag by clicking its chip off.</p>';
                el.emptyHint.hidden = false;
                refreshPushUI();
                if (el.lensNote) el.lensNote.hidden = true;
                if (state.lastQueryError) {
                    toast('A tag query timed out — ' + esc(state.lastQueryError.label) +
                        '. This looks like an Eagle API/version issue, not no-results.', true, 5000);
                }
                return;
            }
            state.lensTotal = ids.length;
            state.lensIds = ids;
            state.currentIds = ids;
            state.loaded = 0;
            if (el.actionRow) el.actionRow.hidden = false;
            // Ordering note: results appear in Eagle's library/query order, most
            // relevant first. (The former getIdsWithModifiedAt() whole-library
            // recency sort was removed — it could stall on large libraries.)

            if (token !== state.runToken) return;

            el.lensCount.innerHTML = fmt(state.lensTotal) + ' items <small>' +
                (state._extCount > 0
                    ? 'across all libraries (incl. ' + fmt(state._extCount) + ' from others)'
                    : 'across this library') + '</small>';
            updateLensNote(combined);
            if (state.lastQueryError) {
                toast('Some queries timed out (' + esc(state.lastQueryError.label) + ') — results may be partial.', true, 4500);
            }
            syncEagleSelection(ids);
            el.grid.innerHTML = '';
            el.grid.hidden = false;
            el.emptyHint.hidden = true;
            await loadMore();
            refreshPushUI();
        } catch (err) {
            state.lastError = err;
            dbg('runLens error: ' + (err && err.message ? err.message : err));
            state.lensIds = [];
            state.lensTotal = 0;
            state.loaded = 0;
            el.lensCount.innerHTML = '0 items';
            el.grid.innerHTML = '';
            el.grid.hidden = true;
            el.loadMoreRow.hidden = true;
            el.emptyHint.innerHTML = '<p><b>The query failed.</b></p><p>' + esc(err && err.message ? err.message : String(err)) + '</p>';
            el.emptyHint.hidden = false;
            if (el.lensNote) el.lensNote.hidden = true;
            toast('Lens query failed: ' + (err && err.message ? err.message : err), true, 4000);
        } finally {
            busyOff();
        }
    }

    function syncEagleSelection(ids) {
        if (!state.capSelect || !el.syncSel.checked) return;
        // only the ACTIVE library's items can be selected in Eagle — exclude
        // browse-only items from other libraries
        var active = [];
        for (var i = 0; i < ids.length; i++) {
            var d = indexCache && indexCache.byId.get(ids[i]);
            if (d && !d.external) active.push(d.realId);
        }
        var slice = active.slice(0, SELECT_SYNC_MAX);
        if (!slice.length) return;
        withTimeout(eagle.item.select(slice), 8000, 'select').catch(function () { /* older Eagle: ignore */ });
    }

    async function loadMore() {
        var ids = state.lensIds;
        var from = state.loaded;
        var to = Math.min(from + HYDRATE_PAGE, ids.length);
        if (from >= to) { el.loadMoreRow.hidden = true; return; }
        busyOn('Loading items…');
        try {
            var chunk = ids.slice(from, to);
            var items;
            if (indexCache && indexCache.byId) {
                // hydrate straight from the client-side index — avoids calling
                // get({ids}) on SVG files, which can stall on some builds
                items = chunk.map(function (id) { return indexCache.byId.get(id); }).filter(Boolean);
            } else {
                var pages = [];
                for (var i = 0; i < chunk.length; i += 200) pages.push(chunk.slice(i, i + 200));
                var results = await mapLimit(pages, 3, function (pageIds) {
                    return withTimeout(eagle.item.get({ ids: pageIds }), PAGE_QUERY_TIMEOUT, 'get(ids)')
                        .catch(function () { return []; });
                });
                items = [];
                results.forEach(function (r) { if (Array.isArray(r)) items = items.concat(r); });
            }
            items.sort(function (a, b) { return (b.importedAt || 0) - (a.importedAt || 0); });
            dbg('hydrated ' + items.length + ' items (page from ' + from + ')');
            appendCells(items);
            state.loaded = to;

            var rem = state.lensTotal - state.loaded;
            if (rem > 0 && state.loaded < 20000) {
                el.loadMoreRow.hidden = false;
                el.shownOf.textContent = 'showing ' + fmt(Math.min(state.loaded, ids.length)) + ' of ' + fmt(state.lensTotal);
            } else {
                el.loadMoreRow.hidden = true;
            }
        } finally {
            busyOff();
        }
    }

    function appendCells(items) {
        var frag = document.createDocumentFragment();
        items.forEach(function (it) {
            var btn = document.createElement('button');
            btn.className = 'cell';
            btn.dataset.id = it.id;
            var tip = (it.name || '') + (it.tags && it.tags.length ? '\n' + it.tags.join(' · ') : '') +
                (it.score != null ? '\nSimilarity: ' + Math.round(it.score * 100) + '%' : '') +
                (it.external ? '\nFrom: ' + (it.libName || 'other library') + ' (browse only)' : '\nClick: reveal in Eagle');
            btn.title = tip;

            var src = it.thumb || '';
            if (src) {
                var img = document.createElement('img');
                img.loading = 'lazy';
                img.alt = '';
                img.onerror = function () { img.remove(); if (!btn.querySelector('.ph')) addPh(btn, it); };
                img.src = src;
                btn.appendChild(img);
            } else {
                addPh(btn, it);
            }
            var cap = document.createElement('div');
            cap.className = 'cap';
            cap.textContent = it.name || '';
            btn.appendChild(cap);
            if (it.score != null) {
                var sc = document.createElement('span');
                sc.className = 'score';
                sc.textContent = Math.round(it.score * 100) + '%';
                btn.appendChild(sc);
            }
            if (it.external) {
                var srcb = document.createElement('span');
                srcb.className = 'src';
                srcb.textContent = truncate(it.libName || 'EXT', 12);
                srcb.title = 'From ' + (it.libName || 'another library') + ' — browse only';
                btn.appendChild(srcb);
            }
            if (it.ext && it.ext !== 'unknown') {
                var ex = document.createElement('span');
                ex.className = 'ext';
                ex.textContent = it.ext.replace('.', '').slice(0, 5).toUpperCase();
                btn.appendChild(ex);
            }
            frag.appendChild(btn);
        });
        el.grid.appendChild(frag);
    }

    function addPh(btn, it) {
        var ph = document.createElement('div');
        ph.className = 'ph';
        ph.textContent = (it.ext && it.ext !== 'unknown') ? it.ext.replace('.', '').slice(0, 4).toUpperCase() : '◎';
        btn.appendChild(ph);
    }

    function emptyLensHint() {
        if (state.untaggedSel) {
            return '<p><b>These items have no tags.</b></p>' +
                '<p>Tag them in Eagle, or type into the <b>“…and also contain text”</b> box to isolate by name / annotation instead.</p>';
        }
        return '<p><b>Lens is empty.</b></p><p>Add a tag chip, type a text filter, or set a <b>filter</b> below ' +
               '(colour / rating / date / shape / folder) — filters work even with nothing selected.</p>';
    }

    /* ===============================================================
     *  Entry action: Focus on Selection
     * ===============================================================*/
    async function doFocus(keepLens) {
        if (!state.ready) return;
        setLensKind('tags');
        dbg('focus: reading selection (keepLens=' + keepLens + ')');
        busyOn('Reading selection…');
        try {
            var sel = await readSelection();
            dbg('selection has ' + sel.length + ' item(s)');
            if (!sel.length) {
                state.selectedCount = 0;
                el.selSummary.textContent = 'Nothing is selected in Eagle. Select one or more items first.';
                el.lensCount.innerHTML = '0 items';
                toast('Select items in Eagle first, then press Focus.', true);
                return;
            }
            state.selectedCount = sel.length;
            state.selected = sel;
            state.candidates = buildCandidates(sel);
            state.untaggedSel = state.candidates.size === 0;

            // when refreshing (not re-focusing), keep the active lens visible:
            // merge its tags into the freshly computed candidate chips
            if (keepLens) {
                state.lens.tags.forEach(function (t) {
                    if (!state.candidates.has(t)) {
                        state.candidates.set(t, { tag: t, freq: null, shared: false, total: null });
                    }
                });
            } else {
                // one-click isolation: auto-build the lens from shared tags
                var shared = [];
                state.candidates.forEach(function (c) { if (c.shared) shared.push(c.tag); });
                var hint = null;
                var included;
                if (shared.length) {
                    included = shared;
                } else if (sel.length === 1) {
                    included = Array.from(state.candidates.keys()).slice(0, AUTO_LENS_TAGS);
                    hint = 'single item: using its most frequent tags';
                } else {
                    included = Array.from(state.candidates.keys()).slice(0, AUTO_LENS_TAGS);
                    hint = 'no tag is shared by every selection — using the most frequent ones';
                }
                state.lens.tags = included;
                state.lens.exclude = [];
                state.lens.filters = defaultFilters();
                // AUTO-LENS FALLBACK: nothing to isolate by tags -> derive a
                // lens from the selection's folder / shape / colour instead.
                if (!included.length) {
                    var fb = fallbackFiltersFromSelection(sel);
                    if (fb) {
                        state.lens.filters = fb.filters;
                        hint = 'no tags — isolating by ' + fb.by;
                    } else {
                        hint = 'no tags on the selection';
                    }
                }
                if (hint) { state.hintShown = hint; } else { state.hintShown = null; }
            }
            renderChips();
            syncFilterControls();
            summarizeSelection(sel);
            loadTotals();
            await runLens();
        } catch (err) {
            dbg('doFocus error: ' + (err && err.message ? err.message : err));
            toast('Failed: ' + (err && err.message ? err.message : err), true, 4000);
        } finally {
            busyOff();
        }
    }

    /* ===============================================================
     *  Pinned lenses (persisted per library)
     * ===============================================================*/
    function pinLens() {
        var L = state.lens;
        if (!L.tags.length && !lensTokens(L.keywords).length && !filtersActive(L.filters)) {
            toast('Nothing to pin — the lens is empty.', true);
            return;
        }
        var name = (el.pinName.value || '').trim() || defaultLensName();
        var rec = {
            id: 'p' + Date.now().toString(36),
            name: name,
            tags: L.tags.slice(),
            mode: L.mode,
            keywords: L.keywords || '',
            filters: JSON.parse(JSON.stringify(L.filters || defaultFilters())),
            exclude: (L.exclude || []).slice(),
            createdAt: Date.now()
        };
        store.saved.unshift(rec);
        store.saved = store.saved.slice(0, 200);
        writeStore();
        el.pinName.value = '';
        renderSaved();
        toast('Pinned “' + truncate(name, 40) + '”.');
    }

    function restoreLens(rec) {
        setLensKind('tags');
        state.lens = {
            tags: (rec.tags || []).slice(),
            mode: rec.mode === 'all' ? 'all' : 'any',
            keywords: rec.keywords || '',
            filters: rec.filters ? JSON.parse(JSON.stringify(rec.filters)) : defaultFilters(),
            exclude: (rec.exclude || []).slice()
        };
        // build candidate entries for these tags (totals loaded lazily)
        state.candidates = new Map();
        state.lens.tags.concat(state.lens.exclude).forEach(function (t) {
            if (!state.candidates.has(t)) state.candidates.set(t, { tag: t, freq: null, shared: false, total: null });
        });
        state.hintShown = null;
        renderChips();
        syncFilterControls();
        el.pinName.value = '';
        loadTotals();
        runLens();
        toast('Restored “' + truncate(rec.name, 40) + '”.');
    }

    function deletePinned(id) {
        store.saved = store.saved.filter(function (r) { return r.id !== id; });
        writeStore();
        renderSaved();
    }

    function renderSaved() {
        el.savedCount.textContent = store.saved.length ? String(store.saved.length) : '';
        var host = el.savedList;
        if (!store.saved.length) {
            host.innerHTML = '<span class="empty-tip">Nothing pinned yet. Run a lens, then press Pin to keep it for later.</span>';
            return;
        }
        host.innerHTML = '';
        store.saved.forEach(function (rec) {
            var row = document.createElement('div');
            row.className = 'srow';
            var info = document.createElement('div');
            info.className = 'info';
            var nm = document.createElement('div');
            nm.className = 'name';
            nm.textContent = rec.name;
            nm.title = rec.name;
            var meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = (rec.mode === 'all' ? 'All of ' : 'Any of ') + (rec.tags.length ? rec.tags.join(', ') : 'text: ' + rec.keywords);
            meta.title = meta.textContent;
            info.appendChild(nm); info.appendChild(meta);
            var k = document.createElement('span');
            k.className = 'kind';
            k.textContent = 'lens';
            var open = document.createElement('button');
            open.className = 'btn tiny';
            open.textContent = 'Open';
            open.title = 'Run this lens now';
            open.onclick = function () { restoreLens(rec); };
            var del = document.createElement('button');
            del.className = 'btn tiny danger';
            del.textContent = '✕';
            del.title = 'Delete pin';
            del.onclick = function () { deletePinned(rec.id); };
            row.appendChild(info); row.appendChild(k); row.appendChild(open); row.appendChild(del);
            host.appendChild(row);
        });
    }

    /* ===============================================================
     *  Materialize a lens as a real Eagle sidebar item
     * ===============================================================*/
    function uniqueEntityName(base) {
        var existing = {};
        var groups = store.pushed;
        groups.forEach(function (p) { existing[p.name] = 1; });
        var name = ENTITY_PREFIX + truncate(base, 60);
        var n = 2;
        while (existing[name]) { name = ENTITY_PREFIX + truncate(base, 56) + ' (' + n + ')'; n++; }
        return name;
    }

    async function createTagGroup() {
        var L = state.lens;
        if (L.mode !== 'any' || !L.tags.length) return;
        busyOn('Creating tag group…');
        try {
            var name = uniqueEntityName(defaultLensName());
            await eagle.tagGroup.create({ name: name, color: 'blue', tags: L.tags.slice() });
            store.pushed.unshift({ kind: 'taggroup', name: name, createdAt: Date.now() });
            writeStore();
            renderPushed();
            refreshPushUI();
            toast('Tag group “' + truncate(name, 40) + '” created — click it in Eagle’s Tags panel to apply this lens.');
        } catch (err) {
            toast('Could not create tag group: ' + (err && err.message ? err.message : err), true, 4000);
        } finally { busyOff(); }
    }

    async function createSmartFolder() {
        var L = state.lens;
        if (!state.smartTagProp || !L.tags.length) return;
        busyOn('Creating smart folder…');
        try {
            var name = uniqueEntityName(defaultLensName());
            var rules = L.tags.map(function (t) {
                return { property: state.smartTagProp, method: state.smartTagMethod, value: t };
            });
            await eagle.smartFolder.create({ name: name, conditions: [{ rules: rules, match: 'AND' }] });
            store.pushed.unshift({ kind: 'smart', name: name, createdAt: Date.now() });
            writeStore();
            renderPushed();
            refreshPushUI();
            toast('Smart folder “' + truncate(name, 40) + '” created — click it in Eagle’s sidebar.');
        } catch (err) {
            toast('Could not create smart folder: ' + (err && err.message ? err.message : err), true, 4000);
        } finally { busyOff(); }
    }

    async function removePushedItem(entry) {
        busyOn('Removing…');
        try {
            if (entry.kind === 'taggroup') {
                var groups = await eagle.tagGroup.get().catch(function () { return []; });
                var g = (groups || []).find(function (x) { return x.name === entry.name; });
                if (g && typeof g.remove === 'function') await g.remove();
            } else if (entry.kind === 'smart') {
                var sfs = await eagle.smartFolder.getAll().catch(function () { return []; });
                var sf = (sfs || []).find(function (x) { return x.name === entry.name; });
                if (sf) await eagle.smartFolder.remove(sf.id);
            }
        } catch (err) { /* entity may already be gone */ }
        store.pushed = store.pushed.filter(function (p) { return p !== entry; });
        writeStore();
        renderPushed();
        refreshPushUI();
        busyOff();
        toast('Removed “' + truncate(entry.name, 40) + '” from Eagle.');
    }

    function renderPushed() {
        var has = store.pushed.length > 0;
        el.pushedBox.hidden = !has;
        if (!has) return;
        el.pushedCount.textContent = String(store.pushed.length);
        var host = el.pushedList;
        host.innerHTML = '';
        store.pushed.forEach(function (entry) {
            var row = document.createElement('div');
            row.className = 'srow';
            var info = document.createElement('div');
            info.className = 'info';
            var nm = document.createElement('div');
            nm.className = 'name';
            nm.textContent = entry.name;
            var meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = entry.kind === 'taggroup'
                ? 'Tag group — shows items with any of the lens tags'
                : 'Smart folder — shows items with all of the lens tags';
            info.appendChild(nm); info.appendChild(meta);
            var k = document.createElement('span');
            k.className = 'kind';
            k.textContent = entry.kind;
            var del = document.createElement('button');
            del.className = 'btn tiny danger';
            del.textContent = 'Remove';
            del.title = 'Delete this item from Eagle';
            del.onclick = function () { removePushedItem(entry); };
            row.appendChild(info); row.appendChild(k); row.appendChild(del);
            host.appendChild(row);
        });
    }

    function refreshPushUI() {
        var L = state.lens;
        var tagsOk = L.tags.length >= 1;
        var hasContent = tagsOk || lensTokens(L.keywords).length;
        if (!hasContent) { el.pushArea.hidden = true; return; }

        var tgOk = tagsOk && L.mode === 'any' && typeof eagle.tagGroup !== 'undefined' && typeof eagle.tagGroup.create === 'function';
        var sfOk = tagsOk && state.hasSmart && state.smartTagProp;
        el.pushArea.hidden = !(tgOk || sfOk);
        el.btnTagGroup.hidden = !tgOk;
        el.btnSmart.hidden = !sfOk;
    }

    /* ===============================================================
     *  Other libraries (browse-only, read from disk)
     * ===============================================================*/
    function renderXlibs() {
        if (!el.xlibCount) return;
        el.xlibCount.textContent = extraLibs.paths.length ? String(extraLibs.paths.length) : '';
        if (el.xlibEnable) el.xlibEnable.checked = !!extraLibs.enabled;
        var host = el.xlibList;
        if (!host) return;
        host.innerHTML = '';
        if (!extraLibs.paths.length) {
            host.innerHTML = '<span class="empty-tip">No other libraries added. Use “＋ Add library…” to search across more .library folders.</span>';
            return;
        }
        extraLibs.paths.forEach(function (p, i) {
            var row = document.createElement('div');
            row.className = 'srow';
            var info = document.createElement('div');
            info.className = 'info';
            var nm = document.createElement('div');
            nm.className = 'name';
            nm.textContent = String(p).split(/[\\/]/).pop();
            nm.title = p;
            var meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = p;
            meta.title = p;
            info.appendChild(nm); info.appendChild(meta);
            var del = document.createElement('button');
            del.className = 'btn tiny danger';
            del.textContent = '✕';
            del.title = 'Remove this library';
            del.onclick = function () { removeXlib(i); };
            row.appendChild(info); row.appendChild(del);
            host.appendChild(row);
        });
        // hide add/find buttons if fs isn't available in this plugin runtime
        var hasFs = !!(fsMod && fsMod.promises);
        if (el.btnAddLib) el.btnAddLib.disabled = !hasFs;
        if (el.btnFindLibs) el.btnFindLibs.disabled = !hasFs;
    }

    async function addXlib() {
        if (!el.btnAddLib || el.btnAddLib.disabled) { toast('File-system access isn’t available in this runtime.', true); return; }
        try {
            var res = await eagle.dialog.showOpenDialog({ title: 'Select an Eagle library (.library folder)', properties: ['openDirectory'] });
            if (!res || res.canceled || !res.filePaths || !res.filePaths.length) return;
            var p = normPath(res.filePaths[0]);
            if (!p) return;
            var activePath = '';
            try { activePath = (eagle.library && eagle.library.path) || ''; } catch (e) { /* noop */ }
            if (activePath && normKey(p) === normKey(activePath)) {
                toast('That’s the currently open library — it’s already searched.');
                return;
            }
            if (!hasPath(extraLibs.paths, p)) {
                if (/\.library$/i.test(p) || /\.library[\\/]/.test(p) || (await pathLooksLikeLibrary(p))) {
                    extraLibs.paths.push(p);
                } else {
                    toast('That doesn’t look like an Eagle library folder (expected a .library folder).', true);
                    return;
                }
            } else {
                toast('That library is already added.');
            }
            writeExtras();
            renderXlibs();
        } catch (e) {
            toast('Could not add library: ' + (e && e.message ? e.message : e), true, 4000);
        }
    }

    function removeXlib(i) {
        extraLibs.paths.splice(i, 1);
        writeExtras();
        renderXlibs();
    }

    async function pathLooksLikeLibrary(p) {
        if (!fsMod || !fsMod.promises) return false;
        try {
            var entries = await fsMod.promises.readdir(p).catch(function () { return []; });
            return entries.indexOf('images') !== -1;
        } catch (e) { return false; }
    }

    /* auto-discover other .library folders in common locations */
    async function findLibraryFolders(baseDir, maxDepth) {
        var found = [];
        var fsp = fsMod && fsMod.promises;
        if (!fsp || !baseDir) return found;
        async function walk(dir, depth) {
            var names = await fsp.readdir(dir).catch(function () { return []; });
            for (var i = 0; i < names.length; i++) {
                var n = names[i];
                if (n.charAt(0) === '.') continue;
                if (/\.library$/i.test(n)) found.push(dir + '/' + n);
            }
            if (depth < maxDepth) {
                for (var j = 0; j < names.length; j++) {
                    var s = names[j];
                    if (s.charAt(0) === '.') continue;
                    var full = dir + '/' + s;
                    var st = await fsp.stat(full).catch(function () { return null; });
                    if (st && st.isDirectory() && !/\.library$/i.test(s)) await walk(full, depth + 1);
                }
            }
        }
        await walk(baseDir, 0).catch(function () { });
        return found;
    }

    async function autoDiscoverLibraries() {
        if (!fsMod || !fsMod.promises) {
            toast('File-system access isn’t available, so libraries can’t be auto-scanned.', true);
            return [];
        }
        var osMod = null; try { osMod = require('os'); } catch (e) { /* noop */ }
        var activePath = '';
        try { activePath = (eagle.library && eagle.library.path) || ''; } catch (e) { /* noop */ }

        var jobs = [];
        if (osMod && osMod.homedir) {
            var home = osMod.homedir();
            jobs.push({ dir: home + '/Pictures', depth: 1 });
            jobs.push({ dir: home, depth: 0 });
        }
        if (activePath) {
            var parent = activePath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
            if (parent && parent.toLowerCase() !== activePath.toLowerCase()) jobs.push({ dir: parent, depth: 0 });
        }

        var found = [];
        for (var i = 0; i < jobs.length; i++) {
            if (!jobs[i].dir) continue;
            var list = await findLibraryFolders(jobs[i].dir, jobs[i].depth);
            for (var j = 0; j < list.length; j++) {
                var p = normPath(list[j]);
                if (activePath && normKey(p) === normKey(activePath)) continue;  // skip active library
                if (!hasPath(found, p)) found.push(p);
            }
        }
        // drop any that no longer look like a library
        var kept = [];
        for (var k = 0; k < found.length && kept.length < 20; k++) {
            if (await pathLooksLikeLibrary(found[k])) kept.push(found[k]);
        }
        return kept;
    }

    async function runAutoDiscover() {
        var found = await autoDiscoverLibraries();
        var added = 0;
        found.forEach(function (p) {
            if (!hasPath(extraLibs.paths, p)) { extraLibs.paths.push(normPath(p)); added++; }
        });
        writeExtras();
        renderXlibs();
        if (added) toast('Auto-added ' + added + ' librar' + (added === 1 ? 'y' : 'ies') + '.');
        else if (found.length) toast('All discovered libraries are already added.');
        else toast('No other .library folders found in the usual locations.');
    }

    /* ===============================================================
     *  Capability probe + Eagle lifecycle
     * ===============================================================*/
    async function probeCapabilities() {
        state.capSelect = !!(eagle.item && typeof eagle.item.select === 'function');
        var smart = eagle.smartFolder;
        state.hasSmart = !!(smart && typeof smart.getRules === 'function' && typeof smart.create === 'function');
        if (state.hasSmart) {
            try {
                var rules = await withTimeout(smart.getRules(), 8000, 'getRules');
                var prop = rules && (rules.tags ? 'tags' : (rules.tag ? 'tag' : null));
                state.smartTagProp = prop || null;
                if (prop && rules[prop]) {
                    var methods = rules[prop].methods || [];
                    state.smartTagMethod = methods.indexOf('contain') !== -1 ? 'contain'
                        : (methods.indexOf('equal') !== -1 ? 'equal' : 'contain');
                }
            } catch (e) { state.hasSmart = false; state.smartTagProp = null; }
        }
        el.syncSel.disabled = !state.capSelect;
    }

    async function init() {
        // library identity / per-library storage
        try {
            var info = await withTimeout(eagle.library.info(), 8000, 'library.info');
            state.libKey = (info && (info.id || info.path)) || 'default';
            state.libName = (info && (info.name || '')) || '';
        } catch (e) {
            dbg('library.info() failed/timed out: ' + (e && e.message ? e.message : e));
            state.libKey = libKey();
        }
        if (state.libName) {
            el.libName.textContent = state.libName;
            el.libName.classList.add('ellipsis');
            el.libName.title = state.libName;
        }
        readStore();
        readSettings();
        readExtras();
        if (el.restoreChk) el.restoreChk.checked = !!state.restoreLast;
        renderSaved();
        renderPushed();
        renderXlibs();
        await probeCapabilities();
        refreshPushUI();
        state.ready = true;
        el.app.hidden = false;
        if (el.ver) el.ver.textContent = 'v' + PLUGIN_VERSION;
        syncFilterControls();
        loadFolders();
        updateHistoryUI();
        if (el.actionRow) el.actionRow.hidden = true;

        // By default the plugin opens fully idle — no query is run on launch
        // (this was the #1 cause of the earlier "frozen on open" bug). A user
        // can OPT IN to re-applying the last lens on start via the checkbox.
        if (state.restoreLast) {
            var last = null;
            try {
                var rawL = localStorage.getItem(STORE_PREFIX + libKey() + ':last');
                if (rawL) last = JSON.parse(rawL);
            } catch (e) { /* noop */ }
            if (last && ((last.tags && last.tags.length) || (last.keywords && lensTokens(last.keywords).length) || filtersActive(last.filters))) {
                restoreLens({
                    tags: last.tags || [],
                    mode: last.mode === 'all' ? 'all' : 'any',
                    keywords: last.keywords || '',
                    filters: last.filters,
                    exclude: last.exclude
                });
                return;
            }
        }

        // IMPORTANT: no query is ever run on launch. The plugin is fully idle
        // until the user presses "Focus on Selection" (or restores a pinned
        // lens). This keeps startup instant and avoids replaying a stale lens
        // behind a blocker — the #1 cause of a "frozen on open" plugin.
        el.emptyHint.hidden = false;
    }

    function rememberLast() {
        try {
            var L = state.lens;
            localStorage.setItem(STORE_PREFIX + libKey() + ':last', JSON.stringify({
                tags: L.tags, mode: L.mode, keywords: L.keywords, filters: L.filters, exclude: L.exclude, at: Date.now()
            }));
        } catch (e) { /* noop */ }
        if (storeDirty) writeStore();
    }

    function bindEvents() {
        el.btnFocus.addEventListener('click', function () { doFocus(false); });
        el.btnRefreshSel.addEventListener('click', function () { doFocus(true); });

        el.modeAny.addEventListener('change', function () {
            if (el.modeAny.checked) { state.lens.mode = 'any'; runLens(); }
        });
        el.modeAll.addEventListener('change', function () {
            if (el.modeAll.checked) { state.lens.mode = 'all'; runLens(); }
        });

        var kwTimer = null;
        el.kwInput.addEventListener('input', function () {
            el.btnKwClear.hidden = !el.kwInput.value;
            clearTimeout(kwTimer);
            kwTimer = setTimeout(function () {
                state.lens.keywords = el.kwInput.value;
                runLens();
            }, 350);
        });
        el.btnKwClear.addEventListener('click', function () {
            el.kwInput.value = '';
            el.btnKwClear.hidden = true;
            state.lens.keywords = '';
            runLens();
        });

        el.tagChips.addEventListener('click', function (ev) {
            var chip = ev.target.closest('.chip');
            if (!chip) return;
            toggleTag(chip.dataset.tag, ev.shiftKey);
        });

        el.btnClear.addEventListener('click', function () {
            setLensKind('tags');
            state.similar = null;
            state.lens = { tags: [], mode: state.lens.mode, keywords: '', filters: defaultFilters() };
            state.candidates = new Map();
            state.hintShown = null;
            el.kwInput.value = '';
            el.btnKwClear.hidden = true;
            el.pinName.value = '';
            el.selSummary.textContent = 'Select items in Eagle, then press <b>Focus</b>.';
            syncFilterControls();
            renderChips();
            runLens();
        });

        el.btnPin.addEventListener('click', pinLens);
        el.pinName.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') pinLens(); });

        el.btnLoadMore.addEventListener('click', function () { loadMore(); });
        el.grid.addEventListener('click', function (ev) {
            var cell = ev.target.closest('.cell');
            if (!cell || !cell.dataset.id) return;
            var d = indexCache && indexCache.byId.get(cell.dataset.id);
            if (d && d.external) {
                toast('“' + truncate(d.name || 'item', 32) + '” is from ' + (d.libName || 'another library') + ' — browse only here.');
                return;
            }
            withTimeout(eagle.item.open(cell.dataset.id), 8000, 'open')
                .catch(function () { /* noop */ });
        });

        el.btnTagGroup.addEventListener('click', createTagGroup);
        el.btnSmart.addEventListener('click', createSmartFolder);

        el.restoreChk.addEventListener('change', function () {
            state.restoreLast = !!el.restoreChk.checked;
            writeSettings();
            toast(state.restoreLast ? 'Will re-open your last lens on start.' : 'Will start idle on next open.');
        });

        el.xlibEnable.addEventListener('change', function () {
            extraLibs.enabled = !!el.xlibEnable.checked;
            writeExtras();
            if (extraLibs.enabled) {
                toast('Searching across other libraries — auto-discovering…');
                runAutoDiscover();
            } else {
                toast('Only the active library will be searched.');
            }
        });
        el.btnAddLib.addEventListener('click', addXlib);
        el.btnFindLibs.addEventListener('click', runAutoDiscover);

        el.btnSimilar.addEventListener('click', doSimilar);
        if (el.simThreshold) {
            el.simThreshold.addEventListener('input', function () {
                var pct = parseInt(el.simThreshold.value, 10) || 0;
                if (el.simPct) el.simPct.textContent = pct + '%';
                if (state.similar) { state.similar.minScore = pct / 100; renderSimilar(); }
            });
        }

        if (el.starSel) el.starSel.addEventListener('change', function () {
            state.lens.filters.minStar = parseInt(el.starSel.value, 10) || 0;
            updateFilterResetBtn(); runLens();
        });
        if (el.dateSel) el.dateSel.addEventListener('change', function () {
            state.lens.filters.dateRange = el.dateSel.value || 'any';
            updateFilterResetBtn(); runLens();
        });
        if (el.shapeSel) el.shapeSel.addEventListener('change', function () {
            state.lens.filters.shape = el.shapeSel.value || 'any';
            updateFilterResetBtn(); runLens();
        });
        if (el.folderSel) el.folderSel.addEventListener('change', function () {
            state.lens.filters.folder = el.folderSel.value || '';
            updateFilterResetBtn(); runLens();
        });
        if (el.btnClearFilters) el.btnClearFilters.addEventListener('click', function () {
            state.lens.filters = defaultFilters();
            syncFilterControls(); runLens();
        });

        // history navigation
        if (el.btnBack) el.btnBack.addEventListener('click', function () { navHistory(-1); });
        if (el.btnFwd) el.btnFwd.addEventListener('click', function () { navHistory(1); });

        // duplicates + bulk actions
        if (el.btnDuplicates) el.btnDuplicates.addEventListener('click', findDuplicates);
        if (el.btnBulkTag) el.btnBulkTag.addEventListener('click', bulkApplyTag);
        if (el.bulkTagInput) el.bulkTagInput.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') bulkApplyTag();
        });
        if (el.btnBulkFolder) el.btnBulkFolder.addEventListener('click', bulkAddFolder);
        if (el.btnCopyNames) el.btnCopyNames.addEventListener('click', bulkCopyNames);
        if (el.btnExport) el.btnExport.addEventListener('click', bulkExport);

        // keyboard shortcuts
        document.addEventListener('keydown', function (ev) {
            var mod = ev.ctrlKey || ev.metaKey;
            if (!mod) {
                if (ev.key === 'Escape') { if (el.kwInput) { el.kwInput.value = ''; el.btnKwClear.hidden = true; state.lens.keywords = ''; runLens(); } }
                return;
            }
            var k = (ev.key || '').toLowerCase();
            if (k === 'f' && ev.shiftKey) { ev.preventDefault(); doSimilar(); }
            else if (k === 'f') { ev.preventDefault(); doFocus(false); }
            else if (k === 'k') { ev.preventDefault(); if (el.kwInput) el.kwInput.focus(); }
            else if (k === 'd') { ev.preventDefault(); findDuplicates(); }
            else if (k === '[') { ev.preventDefault(); navHistory(-1); }
            else if (k === ']') { ev.preventDefault(); navHistory(1); }
        });
    }

    /* ------------------------------------------------------- boot */
    function boot() {
        var ids = ['app', 'libName', 'btnFocus', 'btnRefreshSel', 'selSummary',
            'lensPanel', 'lensCount', 'modeAny', 'modeAll', 'kwInput', 'btnKwClear',
            'tagChips', 'pushArea', 'btnTagGroup', 'btnSmart', 'pinName', 'btnPin',
            'btnClear', 'syncSel', 'emptyHint', 'grid', 'lensNote', 'loadMoreRow', 'btnLoadMore',
            'shownOf', 'savedBox', 'savedCount', 'savedList', 'pushedBox',
            'pushedCount', 'pushedList', 'busy', 'busyText', 'toast', 'noEagle', 'ver', 'restoreChk',
            'xlibBox', 'xlibEnable', 'btnAddLib', 'btnFindLibs', 'xlibList', 'xlibCount',
            'btnSimilar', 'simPanel', 'simThreshold', 'simPct', 'simCount', 'modeSeg', 'kwRow', 'pinRow',
            'filterBox', 'colorRow', 'starSel', 'dateSel', 'shapeSel', 'folderSel', 'btnClearFilters',
            'btnBack', 'btnFwd', 'btnDuplicates', 'actionRow', 'bulkTagInput', 'btnBulkTag',
            'bulkFolderSel', 'btnBulkFolder', 'btnCopyNames', 'btnExport'];
        ids.forEach(function (id) { el[id] = $(id); });

        if (!window.eagle || !eagle.item) {
            el.noEagle.hidden = false;
            document.body.style.padding = '14px';
            return;
        }

        applyTheme('Auto');
        try {
            eagle.onThemeChanged && eagle.onThemeChanged(applyTheme);
            eagle.onPluginCreate && eagle.onPluginCreate(function () { init(); });
            eagle.onPluginShow && eagle.onPluginShow(function () {
                if (state.ready) { loadTotals(); refreshPushUI(); }
            });
            eagle.onPluginHide && eagle.onPluginHide(function () { rememberLast(); });
            eagle.onPluginBeforeExit && eagle.onPluginBeforeExit(function () { rememberLast(); });
            eagle.onLibraryChanged && eagle.onLibraryChanged(function () {
                state.libKey = libKey();
                indexCache = null;          // new library: discard the old index
                readStore();
                renderSaved();
                renderPushed();
                init();
            });
            window.addEventListener('beforeunload', rememberLast);
        } catch (e) { /* older Eagle: run anyway */ }

        bindEvents();
        if (!state.ready && eagle.onPluginCreate) { /* init runs via lifecycle */ }
        else if (!eagle.onPluginCreate) { init(); }
    }

    // test hook (baseline copy)
    try {
        window.__FL = {
            state: state, el: el,
            get store() { return store; },
            get extraLibs() { return extraLibs; },
            boot: boot, doFocus: doFocus, runLens: runLens, findDuplicates: findDuplicates,
            doSimilar: doSimilar, toggleTag: toggleTag, pinLens: pinLens, restoreLens: restoreLens,
            applySnapshot: applySnapshot, rememberLast: rememberLast, loadMore: loadMore,
            getIndex: getIndex, syncEagleSelection: syncEagleSelection, init: init,
            indexCache: function () { return indexCache; },
            setIndexCache: function (v) { indexCache = v; },
            currentItems: currentItems, activeRealIds: activeRealIds,
            navHistory: navHistory, bulkApplyTag: bulkApplyTag, bulkExport: bulkExport,
            createTagGroup: createTagGroup, createSmartFolder: createSmartFolder,
            removePushedItem: removePushedItem, renderChips: renderChips,
            defaultLensName: defaultLensName, passesFilters: passesFilters,
            shapeOf: shapeOf, combineSets: combineSets, normPath: normPath, normKey: normKey,
            readExtras: readExtras, writeExtras: writeExtras, readStore: readStore, readSettings: readSettings,
            renderXlibs: renderXlibs, autoDiscoverLibraries: autoDiscoverLibraries, addXlib: addXlib
        };
    } catch (e) { /* ignore */ }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
