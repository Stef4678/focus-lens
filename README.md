# Focus Lens — isolation & focus view for Eagle

**Focus Lens** turns Eagle's powerful (but buried) filtering into a *dynamic lens*:
select a few related items in Eagle, press one button, and the plugin finds the tags
they share, then shows you **every item in the library** that belongs to that
"family" — and highlights that family in Eagle's own grid, so everything else simply
drops out of view.

No static folders, no manual tag-group clicking. It's a temporary, reshapeable
"focus state" you apply to the library, and you can pin any state to come back later.
You can even search **across multiple Eagle libraries** at once.

**Current version:** 1.6.1 · requires **Eagle 4.x** (some extras need 4.0 build12+ / build22+ —
the plugin auto-detects and hides what your build doesn't support).

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

## 📦 Install (local development plugin)

1. Copy this folder (the one containing `manifest.json`) into Eagle's plugin folder.
   To find it: Eagle → **Plugin panel** (puzzle icon) → **⋯ / settings** → **Open Plugin Folder**.
   Recommended sub-folder name: `focus-lens`.
   (Alternatively, unzip the packaged `FocusLens-1.6.1.zip` — its contents are ready to drop in.
   The same archive is attached to the [v1.6.1 release](https://github.com/Stef4678/focus-lens/releases/latest).)
2. In the Plugin panel, refresh /**+** so Eagle re-scans local plugins.
3. Click **Focus Lens** in the plugin list — the window opens as a child window of Eagle.
4. That's it. No build step, no npm, no network access — pure HTML/CSS/JS.

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

## 🗂 Files

```
focus-lens/
├─ manifest.json           # plugin manifest (window type)
├─ logo.png                # 128×128 plugin icon
├─ index.html              # UI shell
├─ css/style.css           # dark/light theme via [data-theme]
└─ js/plugin.js            # all logic (vanilla JS, no dependencies)
```

Published distributions are also built as `FocusLens-<version>.zip`.

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

## ⚠️ Notes & limits

- Version detection is conservative: `select()`/`open({window})` need Eagle 4.0 **build12+**,
  smart folders need **build22+**. Unavailable options are hidden, never shown broken.
- Item "open" reveals the item in Eagle's full list; it doesn't force-scroll a folder.
  Combined with the synced selection this usually lands where you're looking.
- `getAll()` snapshot is the only heavy call (bounded by a timeout); filtering, counts and
  thumbnails are all in memory afterwards. A very large library may take a few seconds to
  index on first focus.
- Switching libraries re-keys all pins/artifacts and rebuilds the index automatically
  (`onLibraryChanged`).
- **Cross-library mode is best-effort/experimental.** It reads the `.library` on-disk layout
  directly (each item = `<id>.info/` with a `metadata.json`; thumbnails under `thumbnails/`),
  so it can silently index fewer items if the layout differs — and it never crashes, only
  degrades. Other-library items are browse-only.

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

## 📝 Changelog

### 1.6.1

Bug-fix release; found by the headless harness in `test/` (each fix has a regression test).

- **"Show more" could hang forever.** `mapLimit()` only started `min(limit, items.length)`
  workers but resolved when `limit` of them had finished, so any batch smaller than the
  concurrency limit produced a promise that could never settle. This is the code path used
  when paging a large lens after the index has been invalidated (e.g. right after a bulk
  tag/folder edit), and it also affected the bulk-tag/folder actions.
- **Busy pill never went away after "Find Similar".** `doSimilar()` called `busyOn()` twice
  but released the refcount only once, so the "Reading selection…/Searching…" pill stayed on
  screen and the next action's indicator stopped working.
- **"Find Similar" reported a failure as "no matches".** If every AI Search call failed
  (not installed / still indexing), the plugin claimed *"No similar images found."* It now
  distinguishes a failed query from a genuine empty result.
- **Excluding the only active tag emptied the lens.** Shift-clicking a chip to make a
  `not tag` lens hit the "lens is empty" early return, so the exclude was never applied —
  even though the README documents `includes − excludes`. An exclude-only lens now works.
- **Two quick "Show more" clicks rendered the page twice.** The pagination cursor advanced
  only *after* hydration, so a second click re-hydrated and re-appended the same items.
  The page is now claimed up front.
- **A page in flight could land in a reshaped lens.** `loadMore()` now drops its result if
  the lens changed while it was hydrating, instead of appending stale items to the new grid.
- **Items could vanish silently.** If a page's `get({ids})` query timed out while hydrating,
  the total still counted those items but the grid quietly showed fewer, with no warning.
  A timed-out page is now reported.
- Minor: the cross-library count line no longer implies other-library items are included in
  the synced Eagle selection (they are browse-only); the folder filter is labelled
  `Folder: any` and named folders appear in lens names; the empty-state hint distinguishes
  "library could not be loaded" from "no items match".

> The packaged `FocusLens-1.6.1.zip` matches the current folder contents — both are the fixed
> 1.6.1 build. The archive is also attached to the v1.6.1 release on GitHub.
