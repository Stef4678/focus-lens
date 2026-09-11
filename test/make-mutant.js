/* Mutant generator used to validate that each regression test fails for its OWN
 * reason. Derives mutants from js/plugin.js (the fixed build) by reverting one
 * fix at a time, then re-applying only the fix under test where needed.
 *
 * Usage: node test/make-mutant.js <name>
 *   pristine     - all six fixes reverted (should reproduce 1.6.0 behaviour)
 *   maponly      - pristine + mapLimit fix only (lets C2/C3 actually run)
 *   loadmoreonly - pristine + mapLimit + the two loadMore fixes
 */
const fs = require('fs');
const path = require('path');

const FIXED = fs.readFileSync(path.join(__dirname, '..', 'js', 'plugin.js'), 'utf8');

const REVERT = {
    mapLimit: [
        [`            var workers = Math.max(1, Math.min(limit, items.length));\n`, ``],
        [`if (++done === workers) resolve(out); return; }`, `if (++done === limit) resolve(out); return; }`],
        [`            for (var k = 0; k < workers; k++) worker();`,
         `            var n = Math.min(limit, items.length);\n            for (var k = 0; k < n; k++) worker();`]
    ],
    excludeOnly: [
        [`        var exc = L.exclude || [];\n        var F = L.filters || defaultFilters();`,
         `        var F = L.filters || defaultFilters();`],
        [`        if (!tags.length && !kws.length && !hasF && !exc.length) {`,
         `        if (!tags.length && !kws.length && !hasF) {`],
        [`            // Excluded tags (shift-click a chip) -> subtract\n            if (exc.length && idx) {`,
         `            // Excluded tags (shift-click a chip) -> subtract\n            var exc = L.exclude || [];\n            if (exc.length && idx) {`]
    ],
    busy: [
        [`            // NOTE: the busy pill is already on from the single busyOn() above and
            // is released by the single busyOff() in the finally block. Do NOT
            // call busyOn() again here: the counter is refcounted, and a second
            // increment without a matching decrement left the pill spinning
            // forever after every similar search.
            el.busyText.textContent = 'Searching similar images…';`,
         `            busyOn('Searching similar images…');`]
    ],
    loadMoreClaim: [
        [`        state.loaded = to;\n        busyOn('Loading items…');`, `        busyOn('Loading items…');`]
    ],
    loadMoreStale: [
        [`            if (token !== state.runToken || pageIds !== state.lensIds) {
                dbg('dropped stale page (lens changed while loading)');
                return;
            }\n`, ``]
    ]
};

function revert(name, src) {
    REVERT[name].forEach(([from, to]) => {
        if (!src.includes(from)) { console.error('anchor not found while reverting ' + name); process.exit(1); }
        src = src.replace(from, to);
    });
    return src;
}

const which = process.argv[2] || 'pristine';
let src = FIXED;
if (which === 'pristine') {
    Object.keys(REVERT).forEach(k => { src = revert(k, src); });
} else if (which === 'maponly') {
    Object.keys(REVERT).forEach(k => { if (k !== 'mapLimit') src = revert(k, src); });
} else if (which === 'loadmoreonly') {
    Object.keys(REVERT).forEach(k => {
        if (k !== 'mapLimit' && k !== 'loadMoreClaim' && k !== 'loadMoreStale') src = revert(k, src);
    });
} else { console.error('unknown mutant: ' + which); process.exit(1); }

const out = path.join(__dirname, 'tmp-' + which + '.js');
fs.writeFileSync(out, src);
console.log('wrote ' + path.basename(out) + ' (size ' + src.length + ')');
