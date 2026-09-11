/* ============================================================================
 *  Focus Lens — headless test harness
 *  ---------------------------------------------------------------------------
 *  Loads the REAL js/plugin.js inside a vm sandbox with:
 *    - a minimal DOM shim (getElementById, innerHTML, closest, events)
 *    - a fake `eagle` API (item / library / folder / tagGroup / smartFolder /
 *      dialog / aiSearch / log / clipboard)
 *    - localStorage, require(), setTimeout
 *  so the plugin's real logic can be driven and asserted without Eagle.
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PLUGIN_PATH = path.join(__dirname, '..', 'js', 'plugin.js');
const HTML_PATH = path.join(__dirname, '..', 'index.html');

/* Test-only introspection hook, injected just before the plugin's IIFE closes. */
const TEST_HOOK = `
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
            mapLimit: mapLimit,
            readExtras: readExtras, writeExtras: writeExtras, readStore: readStore, readSettings: readSettings,
            renderXlibs: renderXlibs, autoDiscoverLibraries: autoDiscoverLibraries, addXlib: addXlib
        };
    } catch (e) { /* ignore */ }
`;

/* --------------------------------------------------------------- DOM shim */
function decodeEnt(s) {
    return String(s)
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function parseAttrs(tag) {
    const attrs = {};
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(tag))) attrs[m[1]] = decodeEnt(m[2]);
    // boolean attrs (hidden, checked, disabled, ...)
    const bare = tag.replace(re, ' ').match(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?=[\s>]|$)/g) || [];
    bare.forEach(b => { const n = b.trim(); if (n && !/^(span|div|label|input|button|select|option|p|b|small|ol|li|code)$/.test(n)) attrs[n] = ''; });
    return attrs;
}

/* Parse the simple HTML subset the plugin generates into a child-node list. */
function parseHTML(html) {
    const nodes = [];
    const stack = [{ children: nodes }];
    const re = /<\/?([a-zA-Z][-a-zA-Z0-9]*)((?:"[^"]*"|[^>"])*)>/g;
    let last = 0, m;
    while ((m = re.exec(html))) {
        const text = html.slice(last, m.index);
        if (text.trim()) stack[stack.length - 1].children.push({ __text: decodeEnt(text) });
        last = re.lastIndex;
        const whole = m[0];
        const name = m[1].toLowerCase();
        if (whole.charAt(1) === '/') {
            if (stack.length > 1) stack.pop();
            continue;
        }
        const selfClosing = /\/>$/.test(whole);
        const node = makeEl(name);
        const attrs = parseAttrs(whole);
        Object.keys(attrs).forEach(k => {
            if (k === 'class') node.className = attrs[k];
            else if (k === 'checked') node.checked = true;
            else node.setAttribute(k, attrs[k]);
        });
        stack[stack.length - 1].children.push(node);
        if (!selfClosing) stack.push(node);
    }
    const tail = html.slice(last);
    if (tail.trim()) stack[stack.length - 1].children.push({ __text: decodeEnt(tail) });
    return nodes;
}

function matchesSimple(node, sel) {
    sel = String(sel).trim();
    // support: "tag", ".class", "tag.class", "[attr]", "[attr=value]", "tag[attr=value]"
    const m = /^([a-zA-Z][-a-zA-Z0-9]*)?(?:\.([-a-zA-Z0-9_]+))?(?:\[([^\]=]+)(?:="([^"]*)")?\])?$/.exec(sel);
    if (!m) throw new Error('SyntaxError: not a valid selector: ' + sel);
    const [, tag, cls, an, av] = m;
    if (!tag && !cls && !an) throw new Error('SyntaxError: not a valid selector: ' + sel);
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    if (cls && !node.classList.contains(cls)) return false;
    if (an) {
        let v = node.attributes[an];
        if (an === 'class') v = node.className;
        if (v == null) return false;
        if (av !== undefined && v !== av) return false;
    }
    return true;
}

function collect(root, out) {
    (root.children || []).forEach(c => {
        if (c.__text !== undefined) return;
        out.push(c);
        collect(c, out);
    });
    return out;
}

function makeEl(tagName) {
    const node = {
        tagName: String(tagName).toUpperCase(),
        children: [], parentNode: null,
        attributes: {}, dataset: {}, style: {},
        className: '', value: '', textContent: '', title: '',
        onclick: null,
        _listeners: {},
        _html: '',
        _bool: { hidden: false, checked: false, disabled: false }
    };
    // boolean properties reflect their attribute, like real DOM
    ['hidden', 'checked', 'disabled'].forEach(prop => {
        Object.defineProperty(node, prop, {
            get() { return node._bool[prop]; },
            set(v) { node._bool[prop] = !!v; if (v) node.attributes[prop] = ''; else delete node.attributes[prop]; }
        });
    });
    node.classList = {
        add(c) { const s = new Set(node.className.split(/\s+/).filter(Boolean)); s.add(c); node.className = [...s].join(' '); },
        remove(c) { node.className = node.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
        contains(c) { return node.className.split(/\s+/).indexOf(c) !== -1; },
        toggle(c, on) { if (on === undefined) on = !node.classList.contains(c); on ? node.classList.add(c) : node.classList.remove(c); }
    };
    Object.defineProperty(node, 'innerHTML', {
        get() { return node._html; },
        set(v) {
            node._html = String(v);
            node.children = parseHTML(node._html);
            node.children.forEach(c => { if (c && c.__text === undefined) c.parentNode = node; });
        }
    });
    node.setAttribute = function (k, v) {
        node.attributes[k] = String(v);
        if (k === 'class') node.className = String(v);
        if (k.indexOf('data-') === 0) node.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
        if (k === 'hidden') node._bool.hidden = true;
        if (k === 'checked') node._bool.checked = true;
        if (k === 'disabled') node._bool.disabled = true;
        if (k === 'value') node.value = String(v);
        if (k === 'id') node.id = String(v);
    };
    node.appendChild = function (c) {
        if (c && c.tagName === '#FRAGMENT') { c.children.slice().forEach(g => { g.parentNode = node; node.children.push(g); }); c.children = []; return c; }
        c.parentNode = node; node.children.push(c); return c;
    };
    node.removeChild = function (c) { const i = node.children.indexOf(c); if (i === -1) throw new Error('NotFoundError'); node.children.splice(i, 1); c.parentNode = null; return c; };
    node.remove = function () { if (node.parentNode) node.parentNode.removeChild(node); };
    node.querySelector = function (sel) { return collect(node, []).find(n => matchesSimple(n, sel)) || null; };
    node.querySelectorAll = function (sel) { return collect(node, []).filter(n => matchesSimple(n, sel)); };
    node.closest = function (sel) { let n = node; while (n) { if (n.tagName !== '#TEXT' && matchesSimple(n, sel)) return n; n = n.parentNode; } return null; };
    node.addEventListener = function (type, fn) { (node._listeners[type] = node._listeners[type] || []).push(fn); };
    node.removeEventListener = function (type, fn) { node._listeners[type] = (node._listeners[type] || []).filter(f => f !== fn); };
    node.focus = function () { };
    node.dispatchEvent = function (ev) {
        ev.target = ev.target || node;
        let n = node;
        while (n) {
            const ls = (n._listeners && n._listeners[ev.type]) || [];
            for (const fn of ls) { fn.call(n, ev); if (ev._stopped) break; }
            if (ev._stopped) break;
            n = n.parentNode;
        }
        return !ev.defaultPrevented;
    };
    return node;
}

function makeDocument(html) {
    const doc = {
        readyState: 'complete',
        documentElement: makeEl('html'),
        body: makeEl('body'),
        _byId: {},
        _listeners: {},
        createElement: makeEl,
        createDocumentFragment() { const f = makeEl('#fragment'); f.tagName = '#FRAGMENT'; return f; },
        getElementById: id => doc._byId[id] || null,
        addEventListener: (t, fn) => { (doc._listeners[t] = doc._listeners[t] || []).push(fn); },
        querySelector: sel => { const all = collect(doc.body, []); return all.find(n => matchesSimple(n, sel)) || null; },
        dispatchEvent(ev) { (doc._listeners[ev.type] || []).forEach(fn => fn(ev)); return true; }
    };
    // Extract #app (and the sibling overlays) from the real index.html so IDs exist.
    const idRe = /<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g;
    let m;
    while ((m = idRe.exec(html))) {
        const el = makeEl(m[1]);
        const attrs = parseAttrs(m[0]);
        Object.keys(attrs).forEach(k => { if (k === 'class') el.className = attrs[k]; else el.setAttribute(k, attrs[k]); });
        el.id = m[3];
        doc._byId[m[3]] = el;
        // nest under #app so descendant handlers (e.g. .chips click) reach chips
        if (m[3] !== 'app' && doc._byId['app'] && /<div id="app"[\s\S]*$/i.test(html.slice(0, m.index))) doc._byId['app'].appendChild(el);
        else if (m[3] !== 'app') doc.body.appendChild(el);
    }
    doc._byId['app'].id = 'app';
    doc._byId['app'].hidden = true;
    doc.body.appendChild(doc._byId['app']);
    return doc;
}

function fire(node, type, extra) {
    const ev = Object.assign({ type, target: node, _stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stopped = true; } }, extra || {});
    return node.dispatchEvent(ev);
}

/* ------------------------------------------------------- fake Eagle world */
function makeWorld(opts) {
    opts = opts || {};
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const document = makeDocument(html);
    const logs = [];

    const storage = new Map();
    const localStorage = {
        getItem: k => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: k => storage.delete(k),
        _map: storage
    };

    // ---- library data -----------------------------------------------------
    const mk = (id, name, tags, extra) => Object.assign({
        id, name, ext: 'jpg', tags: tags.slice(), width: 1000, height: 1000,
        size: 1000 + id.length, importedAt: Date.now() - 86400000,
        folders: [], star: 0, palettes: [], thumbnailURL: 'thumb://' + id,
        noThumbnail: false, fileURL: 'file:///' + id + '.jpg',
        async save() { this._savedN = (this._savedN || 0) + 1; return true; }
    }, extra || {});

    const items = opts.items || [
        mk('a1', 'poster one', ['poster', 'red'], { palettes: ['#e5484d'] }),
        mk('a2', 'poster two', ['poster', 'draft'], { palettes: ['#e5484d'] }),
        mk('a3', 'logo mark', ['logo'], { palettes: ['#3e63dd'] }),
        mk('a4', 'untagged shot', []),
        mk('a5', 'another', ['poster']),
        mk('a6', 'poster three', ['poster', 'red']),
    ];
    const libPath = opts.libPath || 'C:\\Users\\x\\Pictures\\Main.library';

    const calls = { select: [], open: [], save: [], count: [], get: [], getAll: 0, dialog: [] };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const delay = (ms) => (opts.latencyMs ? sleep(opts.latencyMs) : Promise.resolve());

    const eagle = {
        log: { info: m => logs.push(m) },
        library: {
            path: libPath,
            info: async () => ({ id: opts.libId || 'lib-1', name: opts.libName || 'Main', path: libPath })
        },
        item: {
            getSelected: async () => (opts.selection || []).map(id => items.find(i => i.id === id)).filter(Boolean),
            getAll: async () => { calls.getAll++; if (opts.getAllFails) throw new Error('getAll boom'); if (opts.indexDelayMs) await sleep(opts.indexDelayMs); await delay(); return items.slice(); },
            count: async q => { calls.count.push(q); return items.filter(i => (i.tags || []).some(t => q.tags.includes(t))).length; },
            get: async q => { calls.get.push(q); await delay(); return items.filter(i => q.ids.includes(i.id)); },            getByIds: async ids => { const out = items.filter(i => ids.includes(i.id)); calls._lastByIds = out; return out; },
            select: async ids => { calls.select.push(ids); return true; },
            open: async id => { calls.open.push(id); return true; }
        },
        folder: { getAll: async () => (opts.folders || [{ id: 'f1', name: 'Posters' }]) },
        tagGroup: {
            create: async arg => { calls.tagGroup = arg; return true; },
            get: async () => [{ name: opts.createdTagGroupName || '', remove: async () => { calls.tagGroupRemoved = true; } }]
        },
        smartFolder: {
            getRules: async () => (opts.smartRules || { tags: { methods: ['contain', 'equal'] } }),
            create: async arg => { calls.smartFolder = arg; return true; },
            getAll: async () => [{ id: 'sf1', name: opts.createdSmartName || '' }],
            remove: async id => { calls.smartRemoved = id; }
        },
        dialog: {
            showSaveDialog: async o => { calls.dialog.push(['save', o]); return opts.saveResult || { canceled: false, filePath: 'C:\\tmp\\out.txt' }; },
            showOpenDialog: async o => { calls.dialog.push(['open', o]); return opts.openResult || { canceled: false, filePaths: ['C:\\Users\\x\\Pictures\\Other.library'] }; }
        },
        extraModule: opts.noAi ? {} : {
            aiSearch: {
                isInstalled: async () => opts.aiInstalled !== false,
                isReady: async () => opts.aiReady !== false,
                open: () => { calls.aiOpened = true; },
                searchByItemId: async (id, o) => {
                    if (opts.aiFails) throw new Error('ai search boom');
                    return { results: (opts.aiResults || []).map(r => ({ item: items.find(i => i.id === r.id) || items[0], score: r.score })) };
                }
            }
        },
        clipboard: { writeText: t => { calls.clipboard = t; return true; } },
        onThemeChanged: fn => { calls.themeFn = fn; },
        onPluginCreate: fn => { calls.createFn = fn; },
        onPluginShow: fn => { calls.showFn = fn; },
        onPluginHide: fn => { calls.hideFn = fn; },
        onPluginBeforeExit: fn => { calls.exitFn = fn; },
        onLibraryChanged: fn => { calls.libChangedFn = fn; }
    };

    const sandbox = {
        console: { log: m => logs.push(String(m)), warn: m => logs.push(String(m)), error: m => logs.push('ERR ' + m) },
        localStorage,
        navigator: { clipboard: { writeText: async t => { calls.clipboard = t; } } },
        requestAnimationFrame: fn => { fn(); return 1; },
        setTimeout: (fn, ms) => setTimeout(fn, opts.realTimers ? ms : 0),
        clearTimeout,
        require: (name) => {
            if (opts.noRequire) throw new Error('require unavailable');
            return require(name);
        },
        eagle
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.window.document = document;
    sandbox.window.eagle = eagle;

    const sourcePath = process.env.FL_PLUGIN || PLUGIN_PATH;
    let code = fs.readFileSync(sourcePath, 'utf8');
    // Inject the test hook INSIDE the plugin IIFE (so it closes over the real
    // functions). The shipped plugin.js is left completely untouched.
    code = code.replace(/\}\)\(\);\s*$/, TEST_HOOK + '\n})();\n');
    const ctx = vm.createContext(sandbox);
    // Simulate script-parsing-time DOM: the plugin registers a DOMContentLoaded
    // listener, then we dispatch it — exactly the browser load order.
    document.readyState = 'loading';
    vm.runInContext(code, ctx, { filename: 'plugin.js' });
    document.readyState = 'complete';
    if (sandbox.window.__FL && sandbox.window.__FL.boot) {
        document.dispatchEvent({ type: 'DOMContentLoaded', target: document, preventDefault() { }, stopPropagation() { } });
    }

    const api = {
        document, eagle, items, calls, logs, localStorage, sandbox,
        win: sandbox.window,
        get state() { return sandbox.window.__FL && sandbox.window.__FL.state; },
        get el() { return sandbox.window.__FL && sandbox.window.__FL.el; },
        get store() { return sandbox.window.__FL && sandbox.window.__FL.store; },
        get fl() { return sandbox.window.__FL; },
        get busyTrace() { return sandbox.__busyTrace; },
        get markers() { return sandbox.__markers; },
        fire,
        tick: (ms) => new Promise(r => setTimeout(r, opts.realTimers ? (ms || 0) : 0)),
        text: (node) => textOf(node)
    };
    return api;
}

function textOf(node) {
    if (!node) return '';
    if (node.__text !== undefined) return node.__text;
    let s = node.textContent || '';
    (node.children || []).forEach(c => { s += textOf(c); });
    return s;
}

module.exports = { makeWorld, makeEl, parseHTML, fire, textOf };
