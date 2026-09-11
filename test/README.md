# Focus Lens — headless test harness

Eagle window plugins normally can only be run inside Eagle. This folder lets the
**real** `js/plugin.js` be driven headlessly in Node, so behaviour can be asserted
instead of eyeballed.

## How it works

- `harness.js` loads `../js/plugin.js` into a `vm` sandbox with:
  - a small DOM shim (parses the real `index.html` for element ids, supports
    `innerHTML`, `querySelector(All)`, `closest`, class/attribute selectors,
    event bubbling and `hidden`/`checked`/`disabled` reflection),
  - a fake `eagle` API (`item`, `library`, `folder`, `tagGroup`, `smartFolder`,
    `dialog`, `extraModule.aiSearch`, `clipboard`, lifecycle callbacks),
  - `localStorage`, `require`, timers.
- The plugin's `window.__FL` introspection hook is **injected by the harness**,
  not present in the shipped file.
- `FL_PLUGIN=<path>` points the harness at a different build — used to run the
  same suite against the pristine 1.6.0 source (`orig-plugin.js`) to prove which
  tests catch real regressions.

## Running

```bash
node test/suite.js        # 43 checks, exits non-zero on failure
node test/check-busy.js   # static check: busyOn/busyOff refcount balance per function
```

Each test is raced against a 6s timeout (`FL_TEST_TIMEOUT_MS`), so a promise that
can never settle is reported as a failure instead of hanging the run. A test can
override it with `{ timeoutMs: ... }` in its options.

## Proving a test actually catches its bug

A suite that passes on the fixed build proves little on its own. `make-mutant.js`
derives mutants from the fixed build by reverting one fix at a time, and the
suite is then run against each:

```bash
node test/make-mutant.js pristine       # all fixes reverted
FL_PLUGIN=$PWD/test/tmp-pristine.js node test/suite.js
node test/make-mutant.js maponly        # mapLimit fix only
FL_PLUGIN=$PWD/test/tmp-maponly.js node test/suite.js
```

Expected: pristine fails 8 (A2, C2, C3, C5, C6, D2, D3, D3b) and passes 35;
`maponly` clears C6 but *still* fails C2/C3/C5, which shows those three test the
`loadMore` fixes rather than being blocked by the `mapLimit` hang.

## Layout

| File | Purpose |
| --- | --- |
| `harness.js` | DOM shim + fake Eagle API + `__FL` injection |
| `suite.js` | the 43 behaviour/regression checks (A–O sections) |
| `orig-plugin.js` | pristine 1.6.0 source, for baseline comparison |
| `make-mutant.js` | build revert-one-fix mutants to validate the tests |
| `check-busy.js` | static busy-refcount audit |
| `diff.js` | quick diff of the fix set vs pristine |
| `results-*.txt` | captured runs (fixed build, pristine, mutants) |

`orig-plugin.js` and this README are development aids; they are not part of the
plugin and are not needed to run Focus Lens.
