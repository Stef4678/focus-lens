# Focus Lens — isolation & focus view for Eagle

**Focus Lens** turns Eagle's powerful (but buried) filtering into a *dynamic lens*:
select a few related items in Eagle, press one button, and the plugin finds the tags
they share, then shows you **every item in the library** that belongs to that
"family" — and highlights that family in Eagle's own grid, so everything else simply
drops out of view.

No static folders, no manual tag-group clicking. It's a temporary, reshapeable
"focus state" you apply to the library, and you can pin any state to come back later.
You can even search **across multiple Eagle libraries** at once.

**Current version:** 1.6.1 · requires **Eagle 4.x**.

---

## ✨ Features

| Feature | What it does |
| --- | --- |
| **One-click isolation** | Select 1+ items → **Focus on Selection**. The plugin computes the tags shared by your selection and immediately isolates the matching library-wide item set. |
| **AI visual similarity** | Select an image → **≈ Find Similar (AI)** isolates everything that *looks like* it, ranked by similarity, with a threshold slider. Powered by Eagle's **AI Search** plugin (must be installed + indexed). |
| **Reshape the lens live** | Every tag of the selection becomes a clickable chip (with its real library-wide item count). Click chips to add/remove them; switch between **Any tag** (∪) and **All tags** (∩) to go broad → narrow. |
| **Multi-criteria filters** | Combine the tag lens with **dominant colour**, **rating (★)**, **date added**, **shape/aspect** and **folder** — or use those filters *on their own* to isolate **untagged** items (e.g. "5★ wide images added this month in the Posters folder"). |
| **Text narrowing** | Optional "…and contain text" box intersects the lens with keyword matches over each item's name + tags (multiple words = AND). |
| **Live count** | The lens panel shows exactly **how many items** the lens matches (e.g. "426 items across all libraries, incl. 31 from others") — updated every time you reshape the lens. |
| **Drives Eagle itself** | After each query the lens's active-library items are selected in Eagle's main window (`eagle.item.select`) so you see the isolated set light up there. Click a thumbnail to reveal/open it in Eagle (`eagle.item.open`). |
| **Pin lenses** | Save a lens (name, tags, mode, text) and restore it later. Pins are stored **per library**. The plugin opens **idle** (no query runs on launch) — restore from *Pinned lenses*, or tick **"Reopen last lens on start"** to auto-restore the previous lens. |
| **Become a real sidebar item** | Materialize the current lens inside Eagle: a **tag group** (Any-mode) or a **smart folder** (All-mode, Eagle 4.0 build22+). Everything created is prefixed `Focus Lens ·` and listed in **Created in Eagle**, removable in one click. |
| **Search across libraries** | Optional **Other libraries** mode merges more `.library` folders into the same tag index, so a lens can return matches from **several libraries at once**. See the "Other libraries" section below. |
| **Performance-first** | Reads the library once via `eagle.item.getAll()` into a cached, per-library client-side **tag index**, then filters/counts/renders **entirely in memory** — no slow server-side per-tag query, so focus is instant and can't hang. |
| **Resilient & observable** | Every Eagle call is time-bounded, the busy indicator is **non-blocking**, the live step is shown on-screen, and "no matches" is clearly distinguished from "a query didn't respond". |
| **Bulk actions** | Act on the isolated set: **add a tag to all**, **add all to a folder**, **copy names**, or **export a list** (name / tags / ext / similarity / library). |
| **Duplicate finder** | One click scans the whole index — **including other libraries** — for images with identical **name + size + dimensions**, grouped and isolated. |
| **Exclude tags + auto fallback** | **Shift-click** a chip to *exclude* it (`not draft`); if a selection has **no tags**, the lens auto-derives from the selection's **folder / shape / colour**. |
| **History + shortcuts** | **◀ ▶** step through recent lenses; **Ctrl/Cmd+F** focus, **+Shift+F** find similar, **+K** text box, **+D** duplicates, **+[ / +]** history, **Esc** clears text. |

---

## ✅ Requirements

- **Eagle 4.x** — Focus Lens is a window plugin and only runs inside Eagle (macOS or Windows).
- **Eagle 4.0 build 12+** — needed for the synced selection in Eagle's grid and click-to-reveal
  (`eagle.item.select()`, `eagle.item.open({ window })`).
- **Eagle 4.0 build 22+** — needed to push a lens into Eagle as a **smart folder**.
  On older builds the plugin hides controls your build doesn't support rather than showing
  them broken; **tag groups** work from build 12+.
- **Eagle's AI Search plugin** *(optional — only for ≈ Find Similar)* — install it from Eagle's
  plugin panel and let it finish indexing.
- **File-system access** *(optional — only for cross-library scanning)* — supplied by Eagle via
  Node's `fs`. If it isn't available, **Find automatically** / **＋ Add library…** stay disabled.
- **Nothing else.** No npm, no build step, no network access — plain HTML/CSS/JS.
  (Node is needed *only* to run the test harness in `test/`.)

---

## 📦 Install

**Option A — the packaged plugin (recommended)**

1. Download **`FocusLens-1.6.1.eagleplugin`** from the
   [latest release](https://github.com/Stef4678/focus-lens/releases/latest).
2. **Double-click the downloaded file.** Eagle opens an install confirmation — accept it.
3. If Focus Lens doesn't show up straight away, restart Eagle.

The same file is committed in this repository at
[`dist/FocusLens-1.6.1.eagleplugin`](dist/FocusLens-1.6.1.eagleplugin) if you'd rather
take it from there.

**Option B — run from source (development)**

1. In Eagle: **Plugin panel** (puzzle icon) → **⋯ / settings** → **Open Plugin Folder**.
2. Copy this folder — the one containing `manifest.json` — into it, using the recommended
   sub-folder name `focus-lens`, so that `manifest.json` sits directly inside `focus-lens/`.
3. In the Plugin panel, refresh (**+**) so Eagle re-scans local plugins, then click
   **Focus Lens** in the plugin list — the window opens as a child window of Eagle.

> On first run Eagle may ask to trust/run the local plugin; accept it. Local
> development plugins don't go through the Plugin Center review.

---

## 🎯 Usage (30 seconds)

1. In Eagle, **select a few items** that represent what you're focusing on (e.g. three poster designs).
2. In Focus Lens press **◎ Focus on Selection**.
3. The lens panel shows the tags those items share as chips, plus a **live count**.
   The results grid (and Eagle's own selection) now contains only items matching the lens.
4. Tune it:
   - *narrow* → switch **Any tag → All tags**, or click extra chips off;
   - *widen* → click chips on, switch back to Any;
   - *filter by text* → type into **"…and also contain text"**.
5. Keep it: type a name and press **Pin** — it appears under *Pinned lenses*.
   Or push it into Eagle via **Tag group / Smart folder**.
6. Click any thumbnail to reveal that item in Eagle; **Show more** pages deeper into large lenses;
   **Clear** drops the lens (Eagle's selection stays as it is).

### Match logic notes

- **Any tag** (union): item appears if it carries *at least one* of the selected tags.
  Mirrors Eagle tag-group behavior, so Any-mode lenses map 1:1 onto a tag group.
- **All tags** (intersection): item appears only if it carries *every* selected tag.
- Union/intersection are computed **in memory over the client-side tag index**, so they're
  deterministic and independent of Eagle's own multi-tag search semantics.
- If the lens matches exactly the items you had selected (nothing else in the library shares
  those tags), a hint says so instead of silently repeating your selection.
- If the selected items are **untagged**, a hint points you to tag them or use the text filter.

---

## 🎛 Filters (colour / rating / date / shape / folder)

Below the tag chips is a **Filters** block. Filters are ANDed with whatever the tag/text
lens produces — and they also work **on their own**, so you can isolate items that have no
tags at all:

- **Colour** — click colour swatches to match an item's dominant colour (12 buckets).
  (Uses Eagle's `palettes` data; the row is hidden if the library exposes no colour info.)
- **Rating** — ★ 1+ … ★ 5.
- **Added** — last 7 / 30 / 90 days / year.
- **Shape** — square / landscape / portrait / panoramic.
- **Folder** — pick any Eagle folder (populated from `eagle.folder.getAll()`).

Press **reset** to clear all filters. Filters are saved with **Pin** and restored with the
lens, and included in the "reopen last lens" snapshot.

---

## ⚙ Bulk actions, duplicates, history & shortcuts

**Bulk actions** (appear under the lens once there are results) apply to the **active-library**
items in the current result set (other-library items are browse-only, so they're skipped):

- **Tag all** — type a tag name → adds it to every result item.
- **Add to folder** — pick a folder → adds every result item to it.
- **Copy names** — copies the list of file names to the clipboard.
- **Export…** — writes a tab-separated list (`name, tags, ext, similarity, library`) to a file you choose.

**Find duplicates** (button under the AI button, or **Ctrl/Cmd+D**) scans the whole index and
isolates items that share **identical name + file size + dimensions** — across all indexed
libraries. The count line shows how many groups and items matched.

**Exclude / negative filters** — **Shift-click** any tag chip to exclude it (shown struck-through,
red). The lens becomes `includes − excludes`, e.g. *"posters, but not `draft`"*.

**Auto-lens fallback** — if the selected items share **no tags**, the plugin automatically builds
a lens from what they *do* share: their common **folder**, else common **shape**, else common
**dominant colour**. So even fully untagged screenshots isolate something meaningful.

**History & shortcuts** — **◀ ▶** (or **Ctrl/Cmd+[** / **]**) step back/forward through the lenses
you've built. Shortcuts: **Ctrl/Cmd+F** Focus, **Ctrl/Cmd+Shift+F** Find Similar,
**Ctrl/Cmd+K** jump to the text filter, **Ctrl/Cmd+D** duplicates, **Esc** clear the text filter.

---

## 🔮 Find similar (AI visual similarity)

When your items aren't tagged (or you just want "more like this"), use the AI lens:

1. Select an image in Eagle (several at once also works — results are merged).
2. Press **≈ Find Similar (AI)**.
3. The grid shows everything that *looks like* the selection, **sorted by similarity**,
   each with a **% badge**. Drag the **Similarity ≥** slider to tighten/loosen the set
   (default 45%); the count updates live and the matching items are selected in Eagle.

Notes:

- Requires Eagle's **AI Search** plugin installed and finished indexing. If it isn't, the
  plugin tells you and opens it so you can install/start it; if it's still syncing, try
  again in a moment.
- AI Search indexes the **active library**, so similar-search is active-library only
  (cross-library browse still applies to tag lenses).
- Uses `eagle.extraModule.aiSearch.searchByItemId(id, { limit })`; scores are 0–1 and the
  seed image itself typically appears near 100%.

---

## 🔗 Other libraries (search across multiple libraries)

The plugin normally searches the **active** Eagle library. To search across several:

1. Open **Other libraries** (bottom of the panel).
2. Tick **Search across other libraries** — it will **auto-discover** `.library` folders in:
   - your **Pictures** folder,
   - your **home** folder,
   - the **folder the active library lives in** (libraries are usually colocated).
3. Or add one specifically with **＋ Add library…** (folder picker), or re-scan with **⌕ Find automatically**.
4. Removing an entry (✕) stops it being searched. Duplicates are **deduped automatically**
   (case- and slash-normalized paths), so no library appears twice.

**Note:** Items found in a *non-active* library are **browse-only** — they appear in the grid
with a blue **library-name** badge, but they can't be opened/selected in Eagle's main window
(Eagle can only operate on its active library). The count line shows the total and how many
came from other libraries ("incl. N from others").

### Auto-discovery locations

- `~/Pictures` (scans one level deep for `*.library`)
- `~` / home (direct children)
- parent of the active library path
- Capped at 20 libraries; requires Eagle's file-system access (`require('fs')`); if the
  "Find automatically" / "Add library…" buttons are disabled, fs access isn't available.

*If your other libraries live somewhere unusual (e.g. an external drive), auto-discovery
won't find them — use **＋ Add library…** to point at the folder.*

---

## 🔧 Troubleshooting

| Symptom | What's going on |
| --- | --- |
| Focus Lens isn't listed in the Plugin panel | Eagle scans the folder that contains `manifest.json` **directly** — not a folder wrapped around it. Check the path, hit refresh, or restart Eagle. |
| Double-clicking the `.eagleplugin` does nothing | Make sure Eagle is installed and running first. If your system still won't hand the file over to Eagle, use **Option B** under Install and copy the folder in by hand. |
| A notice says the plugin only runs inside Eagle | Expected: window plugins need Eagle's runtime. Opening `index.html` in a browser always shows this. |
| **≈ Find Similar** says AI Search isn't available | Install/enable Eagle's **AI Search** plugin and let it finish indexing; if it's still syncing, retry in a moment. AI Search indexes the **active library** only. |
| The **Smart folder** option is missing | It needs Eagle 4.0 **build 22+**. The plugin hides controls your build doesn't support instead of showing them broken — use **Tag group** instead. |
| **Find automatically** / **＋ Add library…** are disabled | Eagle's file-system access (`require('fs')`) isn't available. Search the active library only, or add the library by path if the picker still works. |
| The first focus takes a few seconds | The initial `eagle.item.getAll()` snapshot is the only heavy call (it's time-bounded). Filtering, counts and thumbnails are computed in memory from then on. |
| Other-library items won't open in Eagle | They're **browse-only** by design — shown with a blue library badge. Eagle can only select/open items in its active library. |
| Clicking a thumbnail didn't scroll to that folder | **Open** reveals the item in Eagle's full list; it doesn't force-scroll a folder. The synced selection usually lands you next to it. |
| Pins or created artifacts seem to reset | They're stored **per library**. Switching libraries re-keys them and rebuilds the index automatically. |
| Cross-library search misses items | That mode reads the `.library` layout on disk directly, so it's best-effort: if the layout differs it indexes fewer items rather than failing. |
| The lens counts more items than it renders | A page's hydration query timed out. Since 1.6.1 a timed-out page is reported instead of failing silently — retry, or focus a smaller set. |

---

## 🗂 Files

```
focus-lens/
├─ manifest.json                     # plugin manifest (window type)
├─ logo.png                          # 128×128 plugin icon
├─ index.html                        # UI shell
├─ css/style.css                     # dark/light theme via [data-theme]
├─ js/plugin.js                      # all logic (vanilla JS, no dependencies)
└─ dist/
   └─ FocusLens-1.6.1.eagleplugin    # packaged plugin, ready to double-click
```

Also in the repository: `test/` (the headless harness) and `assets/` (screenshots).

`dist/FocusLens-1.6.1.eagleplugin` is the same file attached to the release. It's a ZIP
archive whose root holds exactly `manifest.json`, `index.html`, `logo.png`, `css/style.css`
and `js/plugin.js` — no `test/`, no repository files.

---

## 🛠 Development

- Run inside Eagle only (window plugins run in Eagle's runtime; a plain browser shows a
  "run inside Eagle" notice).
- To debug: set `"devTools": true` in `manifest.json`, reopen the plugin, then inspect
  the plugin window. `[FocusLens]` log lines go to the console (and `eagle.log`).
- Eagle calls used (official Plugin API): [`item`](https://developer.eagle.cool/plugin-api/api/item.md),
  [`count`/`get`/`getAll`](https://developer.eagle.cool/plugin-api/api/item.md),
  [`smartFolder`](https://developer.eagle.cool/plugin-api/api/smart-folder.md),
  [`tagGroup`](https://developer.eagle.cool/plugin-api/api/tag-group.md),
  [`event`](https://developer.eagle.cool/plugin-api/api/event.md),
  [`library`](https://developer.eagle.cool/plugin-api/api/library.md),
  [`dialog`](https://developer.eagle.cool/plugin-api/api/dialog.md); plus Node `fs`/`os`
  for reading other libraries and `npm`-free plain JS.
- Persisted state in `localStorage` under `focus-lens:v1:*` keys:
  - `<library-path>` → pinned lenses + created-in-Eagle artifacts
  - `<library-path>:settings` → "reopen last lens" preference
  - `<library-path>:last` → last lens snapshot
  - `extras` → other libraries list + enabled flag (global)

---

## 🧪 Tests

The plugin is developed against a **headless harness** that runs the real `js/plugin.js`
in Node with a DOM shim and a fake Eagle API — 42 behaviour/regression checks covering
lens semantics, filters, pagination, AI similar, duplicates, persistence, cross-library
scanning and bulk actions. See [`test/README.md`](test/README.md).

```bash
node test/suite.js        # all checks, exits non-zero on failure
node test/check-busy.js   # static busyOn/busyOff refcount audit
```

---

## Contact

Questions, bug reports and feature requests are welcome:

- **GitHub:** [Stef4678/focus-lens](https://github.com/Stef4678/focus-lens)
- **Email:** stefaninfp@gmail.com

---

## License

Released under the MIT License.

MIT © 2026 Kerekes Stefan
