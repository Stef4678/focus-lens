/* Print a line-level diff between the pristine 1.6.0 source and the current
 * plugin.js, so the fix set can be reviewed at a glance. */
const fs = require('fs');
const path = require('path');
const a = fs.readFileSync(path.join(__dirname, 'orig-plugin.js'), 'utf8').replace(/\r\n/g, '\n').split('\n');
const b = fs.readFileSync(path.join(__dirname, '..', 'js', 'plugin.js'), 'utf8').replace(/\r\n/g, '\n').split('\n');

// crude LCS-free diff: index both files and walk with lookahead
let i = 0, j = 0;
const out = [];
function findAhead(arr, start, target, max) {
    for (let k = start; k < Math.min(arr.length, start + max); k++) if (arr[k] === target) return k;
    return -1;
}
while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue; }
    // try to resync: deletion?
    const ia = i < a.length ? findAhead(b, j, a[i], 12) : -1;
    const jb = j < b.length ? findAhead(a, i, b[j], 12) : -1;
    if (jb !== -1 && (ia === -1 || jb - i <= ia - j)) {
        for (let k = i; k < jb; k++) out.push('- ' + a[k]);
        i = jb;
    } else if (ia !== -1) {
        for (let k = j; k < ia; k++) out.push('+ ' + b[k]);
        j = ia;
    } else {
        if (i < a.length) out.push('- ' + a[i++]);
        if (j < b.length) out.push('+ ' + b[j++]);
    }
}
console.log('=== plugin.js vs pristine 1.6.0 ===');
console.log(out.join('\n'));
console.log('\nlines changed:', out.length);
