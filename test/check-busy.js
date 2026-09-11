/* Run the busy-balance check against both the fixed plugin and the pristine 1.6.0
 * baseline, without touching js/plugin.js. */
const fs = require('fs');
const path = require('path');

function analyse(src) {
    const lines = src.replace(/\r\n/g, '\n').split('\n');
    const depthDelta = s => { let d = 0; for (const ch of s) { if (ch === '{') d++; else if (ch === '}') d--; } return d; };
    const rows = [];
    let problems = 0;
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]);
        if (!m) continue;
        if (m[1] === 'busyOn' || m[1] === 'busyOff') continue;   // the definitions themselves
        let depth = 0, started = false, end = i;
        for (let j = i; j < lines.length; j++) {
            depth += depthDelta(lines[j]);
            if (!started && lines[j].includes('{')) started = true;
            if (started && depth <= 0) { end = j; break; }
        }
        const body = lines.slice(i, end + 1)
            .map(l => l.replace(/\/\/.*$/, ''))          // ignore line comments
            .join('\n')
            .replace(/\/\*[\s\S]*?\*\//g, '');           // ignore block comments
        const ons = (body.match(/\bbusyOn\(/g) || []).length;
        const offs = (body.match(/\bbusyOff\(\)/g) || []).length;
        if (ons || offs) {
            if (ons !== offs) problems++;
            rows.push(`${ons === offs ? 'ok      ' : 'MISMATCH'} ${m[1]}: busyOn=${ons} busyOff=${offs}`);
        }
    }
    return { rows, problems };
}

const fixed = fs.readFileSync(path.join(__dirname, '..', 'js', 'plugin.js'), 'utf8');
const origFull = fs.readFileSync(path.join(__dirname, 'orig-plugin.js'), 'utf8');
const orig = origFull.slice(0, origFull.indexOf('    // test hook'));

console.log('=== FIXED plugin.js ===');
analyse(fixed).rows.forEach(r => console.log('  ' + r));
console.log('  problems:', analyse(fixed).problems);

console.log('\n=== PRISTINE 1.6.0 ===');
analyse(orig).rows.forEach(r => console.log('  ' + r));
console.log('  problems:', analyse(orig).problems);
