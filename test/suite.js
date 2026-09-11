/* ============================================================================
 *  Focus Lens — bug-hunting suite
 *  Each test drives the real plugin.js through the fake-Eagle harness.
 * ==========================================================================*/
'use strict';
const { makeWorld } = require('./harness');

let pass = 0, fail = 0;
const failures = [];
const TEST_TIMEOUT_MS = Number(process.env.FL_TEST_TIMEOUT_MS || 6000);

async function t(name, opts, fn) {
    if (typeof opts === 'function') { fn = opts; opts = {}; }
    try {
        const w = makeWorld(Object.assign({ selection: [] }, opts));
        if (w.calls.createFn) w.calls.createFn();
        await w.tick(30);
        // A hung await (e.g. a promise that can never settle) must be reported,
        // not left to block the whole run.
        let timer;
        const cap = opts.timeoutMs || TEST_TIMEOUT_MS;
        const timeout = new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error('TIMED OUT after ' + cap + 'ms (await never settled)')), cap);
        });
        try {
            await Promise.race([Promise.resolve(fn(w)), timeout]);
        } finally { clearTimeout(timer); }
        pass++;
        console.log('  ok   ' + name);
    } catch (e) {
        fail++;
        failures.push({ name, err: e });
        console.log('  FAIL ' + name + '\n         ' + (e && e.message ? e.message : e));
    }
}
function eq(actual, expected, msg) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error((msg || 'mismatch') + ': expected ' + b + ' but got ' + a);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy, got ' + JSON.stringify(v)); }

/* helper: click a chip element inside the chips container (real event path) */
function clickChip(w, tag, opts) {
    const chip = w.el.tagChips.querySelectorAll('.chip').find(c => c.dataset.tag === tag);
    if (!chip) throw new Error('no chip rendered for tag ' + JSON.stringify(tag));
    w.fire(chip, 'click', opts || {});
    return chip;
}

(async function main() {
    console.log('\n=== A. lens semantics ===');

    await t('A1 any/all tag lens matches library-wide', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        eq(w.state.lens.tags, ['poster'], 'shared tag chosen');
        eq(w.state.lensTotal, 4, 'poster items');
        eq(w.calls.select[0], ['a1', 'a2', 'a5', 'a6'], 'selected in Eagle');
    });

    await t('A2 exclude-only lens should show everything EXCEPT the tag', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        // shift-click "poster" -> excluded; lens now has exclude only
        clickChip(w, 'poster', { shiftKey: true });
        await w.tick(30);
        eq(w.state.lens.tags, [], 'no included tags');
        eq(w.state.lens.exclude, ['poster'], 'excluded tag');
        // library has 6 items, 4 carry "poster" -> 2 should remain (a3 logo, a4 untagged)
        eq(w.state.lensTotal, 2, 'items not carrying the excluded tag');
    });

    await t('A3 include + exclude subtracts correctly', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        // include 'red' (a1,a6) and 'poster' (a1,a2,a5,a6) with any, then exclude 'draft'
        clickChip(w, 'red');
        await w.tick(20);
        const before = w.state.lensTotal;
        clickChip(w, 'draft', { shiftKey: true });
        await w.tick(20);
        eq(before, 4, 'poster union red = a1,a2,a5,a6');
        eq(w.state.lensTotal, 3, 'minus draft (a2)');
    });

    await t('A4 All-tags intersection (mode switch)', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        clickChip(w, 'red');           // tags: poster, red (any) -> 4
        await w.tick(20);
        w.el.modeAll.checked = true; w.el.modeAny.checked = false;
        w.fire(w.el.modeAll, 'change');
        await w.tick(30);
        eq(w.state.lens.mode, 'all', 'mode all');
        eq(w.state.lensTotal, 2, 'poster AND red = a1,a6');
    });

    console.log('\n=== B. chip rendering / escaping ===');

    await t('B1 tag containing a double quote is still clickable', {
        items: [
            { id: 'q1', name: 'a', ext: 'jpg', tags: ['say "hi"'], width: 10, height: 10, size: 1, folders: [], importedAt: Date.now(), thumbnailURL: 't', async save() { } },
            { id: 'q2', name: 'b', ext: 'jpg', tags: ['say "hi"'], width: 10, height: 10, size: 2, folders: [], importedAt: Date.now(), thumbnailURL: 't', async save() { } }
        ]
    }, async w => {
        w.state.selectedCount = 2;
        w.state.candidates = new Map([['say "hi"', { tag: 'say "hi"', freq: 2, shared: true, total: null }]]);
        w.state.lens.tags = ['say "hi"'];
        w.fl.renderChips();
        const chip = w.el.tagChips.querySelectorAll('.chip').find(c => c.dataset.tag === 'say "hi"');
        ok(chip, 'chip node found for quoted tag');
        // A browser throws SyntaxError for .chip[data-tag="say "hi""] — the naive
        // selector a developer would write. The click handler must not depend on it.
        const sel = '.chip[data-tag="' + chip.dataset.tag + '"]';
        let threw = false;
        try { w.el.tagChips.querySelectorAll(sel); } catch (e) { threw = true; }
        ok(threw, 'naive attribute selector is invalid CSS');
        // the real handler must still toggle this tag
        w.fire(chip, 'click');
        await w.tick(30);
        ok(w.state.lens.tags.indexOf('say "hi"') === -1, 'tag toggled off via chip click');
    });

    await t('B2 shift-click exclude then normal click re-includes', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        clickChip(w, 'poster', { shiftKey: true });
        await w.tick(20);
        eq(w.state.lens.exclude, ['poster'], 'excluded');
        clickChip(w, 'poster');
        await w.tick(20);
        eq(w.state.lens.exclude, [], 'exclusion cleared');
        eq(w.state.lens.tags, ['poster'], 're-included');
    });

    console.log('\n=== C. pagination / race conditions ===');

    const bigLib = () => {
        const many = [];
        for (let i = 0; i < 650; i++) many.push({ id: 'm' + i, name: 'n' + i, ext: 'jpg', tags: ['big'], width: 10, height: 10, size: i, folders: [], importedAt: Date.now() - i, thumbnailURL: 't' + i, async save() { } });
        // a distinct second tag so a reshaped lens has its own non-empty result set
        for (let i = 0; i < 40; i++) many.push({ id: 'k' + i, name: 'k' + i, ext: 'jpg', tags: ['small'], width: 10, height: 10, size: 9000 + i, folders: [], importedAt: Date.now() - i, thumbnailURL: 'k' + i, async save() { } });
        return many;
    };

    await t('C1 Show more appends the next page without duplicating', { items: bigLib() }, async w => {
        w.state.lens.tags = ['big'];
        await w.fl.runLens();
        eq(w.el.grid.children.length, 300, 'first page');
        ok(!w.el.loadMoreRow.hidden, 'load more visible');
        await w.fl.loadMore();
        eq(w.el.grid.children.length, 600, 'second page');
        eq(w.state.loaded, 600, 'loaded counter');
        ok(!w.el.loadMoreRow.hidden, 'third (partial) page still offered');
        await w.fl.loadMore();
        eq(w.el.grid.children.length, 650, 'final partial page');
        eq(w.el.loadMoreRow.hidden, true, 'load more hidden once everything is shown');
    });

    await t('C2 stale page must not leak into a newer lens', { items: bigLib(), latencyMs: 250, realTimers: true }, async w => {
        w.state.lens.tags = ['big'];
        await w.fl.runLens();
        eq(w.el.grid.children.length, 300, 'lens A page 1');
        eq(w.state.loaded, 300, 'page 1 recorded');
        // invalidating the index (as a bulk tag/folder edit does) routes "Show more"
        // through the slow get({ids}) path, so it really does await
        w.fl.setIndexCache(null);
        const pageA = w.fl.loadMore();               // in flight (~250ms)
        // ...the user reshapes the lens while that page is still loading
        w.state.lens = { tags: ['small'], mode: 'any', keywords: '', filters: { colors: [], minStar: 0, dateRange: 'any', shape: 'any', folder: '' }, exclude: [] };
        await w.fl.runLens();
        const idsB = w.el.grid.children.map(c => c.dataset.id);
        const loadedB = w.state.loaded;
        ok(idsB.length > 0, 'lens B rendered');
        ok(idsB.every(id => !id.startsWith('m')), 'lens B has only its own items');
        await pageA;
        const after = w.el.grid.children.map(c => c.dataset.id);
        eq(after, idsB, 'grid replaced by the stale lens-A page');
        eq(w.state.loaded, loadedB, 'pagination counter corrupted by the stale page');
        ok(after.every(id => !id.startsWith('m')), 'lens-A items leaked into lens B');
    });

    await t('C3 overlapping loadMore must not duplicate or leak the page', { items: bigLib(), latencyMs: 250, realTimers: true }, async w => {
        w.state.lens.tags = ['big'];
        await w.fl.runLens();
        eq(w.el.grid.children.length, 300, 'page 1');
        w.fl.setIndexCache(null);
        const a = w.fl.loadMore();
        await w.tick(30);
        const b = w.fl.loadMore();   // second click while the first is hydrating
        await Promise.all([a, b]);
        const ids = w.el.grid.children.map(c => c.dataset.id);
        eq(ids.length, new Set(ids).size, 'duplicate cells rendered: ' + (ids.length - new Set(ids).size));
        eq(ids.length, 650, 'grid holds the whole big-tag result set (300+300+50)');
        eq(w.state.loaded, 650, 'loaded counter matches');
    });

    await t('C5 a timed-out page query is reported, not silently dropped',
        { items: bigLib(), latencyMs: 250, realTimers: true, timeoutMs: 40000 }, async w => {
        w.state.lens.tags = ['big'];
        await w.fl.runLens();
        eq(w.el.grid.children.length, 300, 'page 1');
        // make the next get({ids}) hang past the page timeout
        const realGet = w.eagle.item.get;
        w.eagle.item.get = async () => new Promise(() => { });      // never settles
        w.fl.setIndexCache(null);
        await Promise.race([w.fl.loadMore(), w.tick(16000)]);
        w.eagle.item.get = realGet;
        ok(!w.el.toast.hidden, 'a warning toast is shown');
        ok(/couldn’t be loaded|incomplete/.test(w.el.toast.textContent), 'toast explains it: ' + w.el.toast.textContent);
        eq(w.el.busy.hidden, true, 'busy pill released');
    });

    await t('C6 mapLimit settles when there are fewer items than the concurrency limit', async w => {
        // A 300-item page splits into two get() calls while the limit is 3. The
        // shipped 1.6.0 code started only 2 workers but waited for 3 of them to
        // finish, so the promise never settled and "Show more" hung forever.
        const seen = [];
        const res = await Promise.race([
            w.fl.mapLimit([1, 2], 3, async x => { seen.push(x); return x * 2; }),
            new Promise(r => setTimeout(() => r('TIMEOUT'), 500))
        ]);
        ok(res !== 'TIMEOUT', 'mapLimit settled (it must not time out)');
        eq(res, [2, 4], 'both items processed');
        eq(seen.slice().sort(), [1, 2], 'each item visited exactly once');
        eq(await w.fl.mapLimit([1, 2, 3, 4, 5], 3, async x => x * 2), [2, 4, 6, 8, 10], 'more items than limit');
        eq(await w.fl.mapLimit([], 3, async x => x), [], 'empty input');
        eq(await w.fl.mapLimit([7, 8], 0, async x => x + 1), [8, 9], 'zero limit still makes progress');
    });

    console.log('\n=== D. AI similar lens ===');

    await t('D1 similar lens renders scored results', {
        selection: ['a1'],
        aiResults: [{ id: 'a1', score: 0.99 }, { id: 'a3', score: 0.62 }, { id: 'a5', score: 0.2 }]
    }, async w => {
        await w.fl.doSimilar();
        eq(w.state.lensKind, 'similar', 'kind');
        eq(w.state.currentIds.length, 2, 'default 45% threshold keeps 2');
        const scores = w.el.grid.children.map(c => (c.querySelector('.score') || {}).textContent);
        eq(scores, ['99%', '62%'], 'score badges');
        eq(w.calls.select.length, 1, 'selection synced');
    });

    await t('D2 threshold change does not leave the busy pill stuck', {
        selection: ['a1'], aiResults: [{ id: 'a1', score: 0.9 }]
    }, async w => {
        await w.fl.doSimilar();
        for (const v of ['10', '30', '60', '80']) {
            w.el.simThreshold.value = v;
            w.fire(w.el.simThreshold, 'input');
            await w.tick(10);
        }
        eq(w.el.busy.hidden, true, 'busy pill hidden');
        eq(w.state.busyCount, 0, 'busy counter balanced');
    });

    await t('D3 AI failure surfaces an error, not a hang', { selection: ['a1'], aiFails: true }, async w => {
        await w.fl.doSimilar();
        eq(w.state.busyCount, 0, 'busy counter balanced');
        eq(w.el.busy.hidden, true, 'busy cleared');
        ok(!w.el.toast.hidden, 'an error toast is shown');
        ok(/didn\u2019t respond/.test(w.el.emptyHint.innerHTML), 'hint reports the failure: ' + w.el.emptyHint.innerHTML.slice(0, 90));
    });

    await t('D3b AI returning an empty result set is not reported as a failure', {
        selection: ['a1'], aiResults: []
    }, async w => {
        await w.fl.doSimilar();
        eq(w.state.busyCount, 0, 'busy counter balanced');
        eq(w.el.busy.hidden, true, 'busy cleared');
        ok(/No similar images found/.test(w.el.emptyHint.innerHTML), 'genuine no-results hint');
    });

    await t('D4 AI module missing is reported, not crashed', { selection: ['a1'], noAi: true }, async w => {
        await w.fl.doSimilar();
        eq(w.el.busy.hidden, true, 'busy cleared');
        ok(/AI Search/.test(w.el.toast.textContent), 'toast mentions AI Search: ' + w.el.toast.textContent);
    });

    console.log('\n=== E. duplicates ===');

    await t('E1 duplicates groups by name+size+dims', {
        items: [
            { id: 'd1', name: 'pic', ext: 'jpg', tags: [], width: 100, height: 100, size: 5, folders: [], importedAt: 1, thumbnailURL: 't', async save() { } },
            { id: 'd2', name: 'pic', ext: 'jpg', tags: [], width: 100, height: 100, size: 5, folders: [], importedAt: 1, thumbnailURL: 't', async save() { } },
            { id: 'd3', name: 'other', ext: 'jpg', tags: [], width: 1, height: 1, size: 5, folders: [], importedAt: 1, thumbnailURL: 't', async save() { } }
        ]
    }, async w => {
        await w.fl.findDuplicates();
        eq(w.state.lensTotal, 2, 'two duplicates found');
        eq(w.state.currentIds.slice().sort(), ['d1', 'd2'], 'ids');
    });

    await t('E2 no-duplicate path leaves grid hidden and count zeroed', async w => {
        await w.fl.findDuplicates();
        eq(w.state.lensTotal, 0, 'nothing');
        eq(w.el.grid.hidden, true, 'grid hidden');
        ok(/No duplicates found/.test(w.el.emptyHint.innerHTML), 'hint shown');
        eq(w.el.emptyHint.hidden, false, 'hint visible');
    });

    console.log('\n=== F. persistence (pin / restore / last lens) ===');

    await t('F1 pin then restore round-trips tags, mode, filters', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        w.el.pinName.value = 'my lens';
        w.state.lens.filters.minStar = 3;
        w.fl.pinLens();
        const saved = w.store.saved[0];
        eq(saved.name, 'my lens', 'name');
        eq(saved.filters.minStar, 3, 'filter saved');
        w.state.lens.tags = [];
        w.state.lens.filters.minStar = 0;
        w.fl.restoreLens(saved);
        await w.tick(30);
        eq(w.state.lens.tags, ['poster'], 'tags restored');
        eq(w.state.lens.filters.minStar, 3, 'filters restored');
    });

    await t('F2 rememberLast writes a reopenable snapshot', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        clickChip(w, 'red');
        await w.tick(20);
        w.fl.rememberLast();
        // rememberLast keys by the library PATH (libKey()), not the library id
        const raw = w.localStorage.getItem('focus-lens:v1:' + w.eagle.library.path + ':last');
        ok(raw, 'last-lens snapshot written; keys=' + JSON.stringify([...w.localStorage._map.keys()]));
        const snap = JSON.parse(raw);
        eq(snap.tags.slice().sort(), ['poster', 'red'], 'snapshot tags');
    });

    await t('F3 pins are scoped per library', { selection: ['a1', 'a2'], libId: 'lib-A' }, async w => {
        await w.fl.doFocus(false);
        w.fl.pinLens();
        eq(w.store.saved.length, 1, 'pin stored for lib A');
        // simulate Eagle switching to another library
        w.eagle.library.path = 'C:\\Other\\Second.library';
        w.eagle.library.info = async () => ({ id: 'lib-B', name: 'Second', path: 'C:\\Other\\Second.library' });
        w.calls.libChangedFn && w.calls.libChangedFn();
        await w.tick(80);
        eq(w.state.libKey, 'lib-B', 'library switched');
        eq(w.store.saved.length, 0, 'no pins leak into the other library');
    });

    console.log('\n=== G. filters ===');

    await t('G1 rating filter narrows the lens', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        w.el.starSel.value = '2';
        w.fire(w.el.starSel, 'change');
        await w.tick(30);
        eq(w.state.lensTotal, 0, 'no item has 2+ stars by default');
    });

    await t('G2 shape filter matches panoramic landscape', {
        items: [
            { id: 's1', name: 'wide', ext: 'jpg', tags: ['x'], width: 1600, height: 400, size: 1, folders: [], importedAt: 1, thumbnailURL: 't', async save() { } },
            { id: 's2', name: 'square', ext: 'jpg', tags: ['x'], width: 500, height: 500, size: 2, folders: [], importedAt: 1, thumbnailURL: 't', async save() { } },
            { id: 's3', name: 'tall', ext: 'jpg', tags: ['x'], width: 400, height: 1600, size: 3, folders: [], importedAt: 1, thumbnailURL: 't', async save() { } }
        ]
    }, async w => {
        w.state.lens.tags = ['x'];
        await w.fl.runLens();
        eq(w.state.lensTotal, 3, 'all three');
        w.el.shapeSel.value = 'panoramic-landscape';
        w.fire(w.el.shapeSel, 'change');
        await w.tick(30);
        eq(w.state.lensTotal, 1, 'only the wide one');
    });

    await t('G3 colour filter uses palette buckets', {
        items: [
            { id: 'c1', name: 'red', ext: 'jpg', tags: [], width: 1, height: 1, size: 1, folders: [], importedAt: 1, palettes: ['#e5484d'], thumbnailURL: 't', async save() { } },
            { id: 'c2', name: 'blue', ext: 'jpg', tags: [], width: 1, height: 1, size: 2, folders: [], importedAt: 1, palettes: ['#3e63dd'], thumbnailURL: 't', async save() { } }
        ]
    }, async w => {
        w.state.lens.filters.colors = ['blue'];
        await w.fl.runLens();
        eq(w.state.lensTotal, 1, 'only blue');
        eq(w.el.colorRow.hidden, false, 'colour row shown when palettes exist');
    });

    await t('G4 date filter excludes old items', async w => {
        const now = Date.now();
        const items = [
            { id: 'n1', name: 'new', ext: 'jpg', tags: ['x'], width: 1, height: 1, size: 1, folders: [], importedAt: now - 86400000, thumbnailURL: 't', async save() { } },
            { id: 'o1', name: 'old', ext: 'jpg', tags: ['x'], width: 1, height: 1, size: 2, folders: [], importedAt: now - 40 * 86400000, thumbnailURL: 't', async save() { } }
        ];
        // rebuild the world with these items
        const w2 = makeWorld({ items }); w2.calls.createFn(); await w2.tick(30);
        w2.state.lens.tags = ['x'];
        w2.el.dateSel.value = '7';
        w2.fire(w2.el.dateSel, 'change');
        await w2.tick(30);
        eq(w2.state.lensTotal, 1, 'only recent item');
        eq(w2.state.lensIds, ['n1'], 'correct id');
    });

    await t('G5 filter-only lens works with no tags at all', async w => {
        w.el.shapeSel.value = 'square';
        w.fire(w.el.shapeSel, 'change');
        await w.tick(30);
        eq(w.state.lensTotal, 6, 'all default items are square');
    });

    await t('G6 reset clears filters', async w => {
        w.el.starSel.value = '4'; w.fire(w.el.starSel, 'change'); await w.tick(20);
        eq(w.state.lens.filters.minStar, 4, 'set');
        w.fire(w.el.btnClearFilters, 'click');
        await w.tick(20);
        eq(w.state.lens.filters.minStar, 0, 'reset');
        eq(w.el.btnClearFilters.hidden, true, 'reset button hidden again');
    });

    console.log('\n=== H. text narrowing ===');

    await t('H1 text filter intersects and is case-insensitive', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        w.el.kwInput.value = 'THREE';
        w.fire(w.el.kwInput, 'input');
        await w.tick(600);
        eq(w.state.lens.keywords, 'THREE', 'keyword stored');
        eq(w.state.lensTotal, 1, 'only "poster three"');
    });

    await t('H2 text matching nothing yields empty lens (not an error)', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        w.el.kwInput.value = 'zzzznotfound';
        w.fire(w.el.kwInput, 'input');
        await w.tick(600);
        eq(w.state.lensTotal, 0, 'empty');
        eq(w.state.lastQueryError, null, 'not reported as a query failure');
        ok(/No items match this lens/.test(w.el.emptyHint.innerHTML), 'no-results hint');
    });

    console.log('\n=== I. resilience ===');

    await t('I1 getAll failure shows a clear error, no hang', { getAllFails: true }, async w => {
        w.state.lens.tags = ['poster'];
        await w.fl.runLens();
        eq(w.el.busy.hidden, true, 'busy cleared');
        eq(w.state.lensTotal, 0, 'no items');
        ok(/query didn’t respond|No items match/.test(w.el.emptyHint.innerHTML), 'error hint: ' + w.el.emptyHint.innerHTML.slice(0, 90));
    });

    await t('I2 focus with an empty selection warns and stays usable', async w => {
        await w.fl.doFocus(false);
        ok(/Nothing is selected|Select items/.test(w.el.selSummary.textContent), 'summary: ' + w.el.selSummary.textContent);
        eq(w.el.busy.hidden, true, 'busy cleared');
    });

    await t('I3 untagged selection falls back to a derived lens', {
        selection: ['a4'],
        items: [
            { id: 'a4', name: 'u', ext: 'jpg', tags: [], width: 800, height: 600, size: 1, folders: ['f1'], importedAt: 1, thumbnailURL: 't', async save() { } },
            { id: 'u2', name: 'u2', ext: 'jpg', tags: [], width: 800, height: 600, size: 2, folders: ['f1'], importedAt: 1, thumbnailURL: 't', async save() { } }
        ]
    }, async w => {
        await w.fl.doFocus(false);
        eq(w.state.lens.filters.folder, 'f1', 'derived from common folder');
        eq(w.state.lensTotal, 2, 'both folder items');
    });

    console.log('\n=== J. bulk actions & export ===');

    await t('J1 tag-all only touches active-library items', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        w.el.bulkTagInput.value = 'curated';
        await w.fl.bulkApplyTag();
        const byIds = w.calls._lastByIds || [];
        eq(byIds.length, 4, 'four active items fetched');
        ok(byIds.every(i => i._savedN === 1), 'each saved once');
        ok(byIds.every(i => i.tags.indexOf('curated') !== -1), 'tag added');
    });

    await t('J2 export writes a header + one row per item', {
        selection: ['a1', 'a2'],
        saveResult: { canceled: false, filePath: require('path').join(__dirname, 'tmp-export.txt') }
    }, async w => {
        await w.fl.doFocus(false);
        await w.fl.bulkExport();
        const fs = require('fs');
        const outPath = require('path').join(__dirname, 'tmp-export.txt');
        const body = fs.readFileSync(outPath, 'utf8');
        const lines = body.split('\n');
        eq(lines[0], 'name\ttags\text\tsimilarity\tlibrary', 'header');
        eq(lines.length, 5, 'header + 4 rows');
        fs.unlinkSync(outPath);   // don't leave test artefacts behind
    });

    console.log('\n=== K. creates-in-Eagle artifacts ===');

    await t('K1 tag group creation uses the lens tags', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        await w.fl.createTagGroup();
        ok(w.calls.tagGroup, 'tagGroup.create called');
        eq(w.calls.tagGroup.tags, ['poster'], 'tags');
        ok(/^Focus Lens · /.test(w.calls.tagGroup.name), 'prefix: ' + w.calls.tagGroup.name);
        eq(w.store.pushed.length, 1, 'recorded in Created-in-Eagle');
    });

    await t('K2 smart folder creation uses AND rules', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        await w.fl.createSmartFolder();
        ok(w.calls.smartFolder, 'smartFolder.create called');
        eq(w.calls.smartFolder.conditions[0].match, 'AND', 'match mode');
        eq(w.calls.smartFolder.conditions[0].rules.length, 1, 'one rule per tag');
    });

    console.log('\n=== L. other libraries ===');

    await t('L1 extras paths are normalized and deduped on read', async w => {
        w.localStorage.setItem('focus-lens:v1:extras', JSON.stringify({
            enabled: true, paths: ['C:\\A\\One.library\\', 'c:/a/one.library', 'C:\\B\\Two.library']
        }));
        w.fl.readExtras();
        eq(w.fl.extraLibs.paths.length, 2, 'duplicate spelling collapsed');
        eq(w.fl.extraLibs.enabled, true, 'enabled flag read');
    });

    await t('L2 enabling cross-library search rescans and keeps state consistent', async w => {
        w.el.xlibEnable.checked = true;
        w.fire(w.el.xlibEnable, 'change');
        await w.tick(50);
        eq(w.fl.extraLibs.enabled, true, 'enabled persisted');
        const raw = JSON.parse(w.localStorage.getItem('focus-lens:v1:extras'));
        eq(raw.enabled, true, 'written to storage');
    });

    await t('L3 real .library folder on disk is indexed, merged and browse-only', async w => {
        const fs = require('fs'), path = require('path'), os = require('os');
        const root = path.join(__dirname, 'tmp-libs');
        const ext = path.join(root, 'Extra.library');
        fs.rmSync(root, { recursive: true, force: true });
        // two items in the external library
        const mk = (id, name, tags) => {
            const dir = path.join(ext, 'images', id + '.info');
            fs.mkdirSync(path.join(dir, 'thumbnails'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
                id, name, ext: 'jpg', tags, width: 800, height: 600, size: 123, folders: [], btime: Date.now(), palettes: ['#e5484d']
            }));
            fs.writeFileSync(path.join(dir, 'thumbnails', id + '_thumbnail.png'), 'x');
        };
        mk('x1', 'external poster', ['poster']);
        mk('x2', 'external only', ['uniqueext']);
        try {
            w.fl.extraLibs.enabled = true;
            w.fl.extraLibs.paths = [ext];
            w.fl.setIndexCache(null);
            const idx = await w.fl.getIndex();
            ok(idx, 'index built');
            eq(w.state._extCount, 2, 'two external items indexed');
            const extItems = [...idx.byId.values()].filter(d => d.external);
            ok(extItems.every(d => d.libName === 'Extra'), 'library badge name');
            ok(extItems.every(d => /^file:\/\//.test(d.thumb)), 'thumbnail as file URL');
            // the shared tag lens must now span both libraries
            w.state.lens.tags = ['poster'];
            await w.fl.runLens();
            const ids = w.state.lensIds;
            ok(ids.indexOf('x1') !== -1 || ids.some(i => i.indexOf('ext#') === 0), 'external item matched the lens');
            eq(w.calls.select[0].indexOf(undefined), -1, 'no undefined ids pushed to Eagle');
            ok(!w.calls.select[0].some(id => String(id).indexOf('ext#') === 0), 'external ids excluded from Eagle selection');
            // clicking an external cell must not try to open it in Eagle
            const cell = w.el.grid.children.find(c => String(c.dataset.id).indexOf('ext#') === 0);
            if (cell) {
                w.fire(cell, 'click');
                eq(w.calls.open.length, 0, 'external item not opened in Eagle');
                ok(/browse only/.test(w.el.toast.textContent), 'toast explains browse-only: ' + w.el.toast.textContent);
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    console.log('\n=== M. pure helpers ===');

    await t('M1 shape classification thresholds', async w => {
        const f = w.fl.shapeOf;
        eq(f(100, 100), 'square'); eq(f(103, 100), 'square');
        eq(f(300, 100), 'panoramic-landscape');
        eq(f(100, 300), 'panoramic-portrait');
        eq(f(150, 100), 'landscape');
        eq(f(100, 150), 'portrait');
        eq(f(0, 100), 'unknown');
    });

    await t('M2 path normalisation dedupes spellings', async w => {
        eq(w.fl.normKey('C:\\A\\Lib.library\\'), w.fl.normKey('c:/a/lib.library'));
    });

    console.log('\n=== N. history ===');

    await t('N1 history steps back and forward', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        clickChip(w, 'red');
        await w.tick(30);
        eq(w.state.lens.tags.slice().sort(), ['poster', 'red'], 'two tags');
        w.fl.navHistory(-1);
        await w.tick(30);
        eq(w.state.lens.tags, ['poster'], 'stepped back');
        w.fl.navHistory(1);
        await w.tick(30);
        eq(w.state.lens.tags.slice().sort(), ['poster', 'red'], 'stepped forward');
    });

    console.log('\n=== O. clear ===');

    await t('O1 Clear resets tags, keywords and filters', { selection: ['a1', 'a2'] }, async w => {
        await w.fl.doFocus(false);
        w.el.kwInput.value = 'poster';
        w.fire(w.el.kwInput, 'input');
        await w.tick(600);
        w.el.starSel.value = '2'; w.fire(w.el.starSel, 'change'); await w.tick(20);
        w.fire(w.el.btnClear, 'click');
        await w.tick(30);
        eq(w.state.lens.tags, [], 'tags cleared');
        eq(w.state.lens.keywords, '', 'keywords cleared');
        eq(w.state.lens.filters.minStar, 0, 'filters cleared');
        eq(w.el.kwInput.value, '', 'textbox cleared');
    });

    console.log('\n' + '='.repeat(58));
    console.log('PASS ' + pass + '   FAIL ' + fail);
    if (failures.length) {
        console.log('\nFailures:');
        failures.forEach(f => console.log(' - ' + f.name + '\n   ' + (f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 3).join('\n   ') : f.err)));
    }
    process.exit(fail ? 1 : 0);
})();
