# casedesk-web

casedesk in the browser: single HTML files that Chrome opens from disk (`file://`). No install, no server, no process
of its own: a page makes no network request (its Content-Security-Policy forbids it), and its data come from a local
folder you pick in the browser. The logic is the Lua core of casedesk.nvim, run by a Lua VM compiled to WebAssembly
(wasmoon, Lua 5.4) inside the page; there is no second parser in JavaScript.

This repository holds the sources and the built pages with their sums. The pages are built here (`pnpm build`), never
edited by hand.

Three pages:

- `casedesk.html`: the **reading copy of case logs**, with a menu bar and a side bar of errors, warnings, exceptions,
  gaps, repeats and known error messages.
- `probe.html`: whether pages like these work on a machine at all.
- `engine-check.html`: whether the Lua core starts in the browser.

## The reading copy (`casedesk.html`)

The same reading copy as `:Case log view` in Neovim: one row per entry (original line, time, kind, summary), a request
and its answer in one row, JSON and page sources unfolded on demand, stack traces as a tree, repeats folded. It reads
the case folder you pick and nothing else, and writes nothing.

1. Check the file against `SHA256SUMS` (as for the probe below) and open it in Chrome:
   `file:///C:/repos/casedesk-web/casedesk.html` (adjust the path). *Settings → Startzeile für Chrome* gives the line
   for a shortcut that opens it as its own window (the page makes no shortcut itself).
2. *Fallordner wählen …* and pick a case folder. The page lists the logs under `assets/` (extensions of casedesk.nvim's core:
   `log`, `txt`, `out`, `ndjson`, `jsonl`, `json`, `xml`, `csv`; no `*.redacted.*` copies); a folder without
   `assets/` lists its own logs. The folders used before come first next time (*Datei → Zuletzt benutzt*, and on the
   start page); Chrome asks once per visit for the permission to read them.
3. Click a log. Tick several and press *Angekreuzte zusammenlegen* to read them as one, merged by time (UTC, a column
   names the log of each row).

| Menu | What |
| --- | --- |
| Datei | pick a case folder, the folders used before, pick a log, reload, close |
| Ansicht | time as written / UTC / relative to the first entry; repeats folded; page source labelled / all / clickable; unfold or fold all; side bar; the original lines of a row; the keys |
| Filter | add a filter (text, level, source, correlation id, direction: a substring, `/…/` a Lua pattern, `!` in front excludes), *only errors*, *errors and warnings*, drop the last, drop all |
| Katalog | pick the catalog of known messages (`WKDBook-Tricentis/Workflow/log-patterns.conf`, format: casedesk.nvim `docs/log-patterns.md`), stop using it, next/previous known message, its problems |
| Einstellungen | from when a distance between rows shows (`250 ms`) and a gap gets its own row (`5 min`), forget the folders used, the start line |

The side bar on the right groups the rows of the view (after filters): **Fehler**, **Warnungen**, **Exceptions**,
**Lücken**, **Wiederholungen** and, with a catalog, **Bekannt**, each known message with its explanation, its links
(a URL opens in a new tab, `case:` names a case), its task and ticket when the catalog names them (the task by
its id: the browser has no task vault) and the rows it matches. A click jumps to the row. Drag the edge to
widen it; the page keeps the width.

Keys as in Neovim (`g?` lists them):

| Keys | What |
| --- | --- |
| `j` `k` `gg` `G` `Ctrl-d` `Ctrl-u` | move |
| `Enter` `za` / `zo` / `zc` | unfold or fold the row / unfold / fold (on a body row: its entry) |
| `zR` / `zM` | unfold every entry one level / fold everything |
| `]e` `[e` · `]w` `[w` · `]r` `[r` · `]k` `[k` · `]g` `[g` | next / previous error · warning · request · known message · gap |
| `gs` | page source: labelled → all → clickable |
| `tz` | time: as written → UTC → relative |
| `gr` | repeats folded ↔ every entry |
| `gf` `gF` `g0` | add a filter, drop the last, drop all |
| `gO` | the original lines of the row |

What is kept in the browser: in IndexedDB `casedesk-web` the handles of the folders used (with their names) and of the
catalog file; in `localStorage` the settings of the view (time mode, repeats, page source mode, distances, side bar).
Never a log, a line of it, a case file or the catalog's text. Exporting to `Research/` and writing catalog entries
from the page come with a stage of their own.

## The probe

`probe.html` checks whether pages like these work on a machine at all. It reads nothing but the folder you pick.

1. Check the file (PowerShell): `(Get-FileHash probe.html).Hash.ToLower()` must match the line of `probe.html` in
   `SHA256SUMS`.
2. Open `file:///C:/repos/casedesk-web/probe.html` in Chrome (adjust the path).
3. Create an **empty** test folder. Never pick a real case folder.
4. Press button 1 and pick the test folder. The page writes, reads back, renames and deletes one file in it, called
   `casedesk-web-probe.txt`, and keeps the folder in the browser's storage (IndexedDB `casedesk-web`, the database the
   real page will use).
5. Reload the page, then close and reopen Chrome, and each time press button 2. After the restart, the line "Marker of
   the previous visit" shows whether Chrome kept the page's storage (a time in both places) or wiped it (`none`).
6. Press "Copy result" and keep the text.
7. Open `chrome://policy`, filter for `FileSystem`, `File` and `URL`, and add what is set to the text.

## The engine check

`engine-check.html` starts the Lua core of casedesk.nvim in a worker and builds the reading copy of a small invented
BrowserStack device log that is part of the file (it reads no folder of this machine). Check it like the probe, open
it, wait until every line is there (the table of entries below shows the reading copy), press "Copy result" and keep
the text.

The Lua sources come from casedesk.nvim and lib.nvim at the commits of `engine.lock`; the head of each page names them.

## How it works

- The page runs the Lua core of casedesk.nvim (its pure reading-copy modules, `casedesk.web.api` and three pure modules
  of its view: time column and gaps, filter stack, tree nodes) in wasmoon, in a worker. The door is
  `src/casedesk_web.lua`: `open` parses the logs (and the catalog), `view` gives the rows for the settings of the page
  and the groups of the side bar, `children` unfolds a row, `original` gives original lines, `logfiles` names the log
  extensions and the words of the levels. The files go to the VM as they are, byte for byte, beside the request (not
  inside its JSON), and the core reads them as casedesk.nvim reads a log (`core.encoding.to_utf8`): UTF-8, UTF-16 (by
  BOM or zero bytes), else Windows-1252; a file of NUL bytes (UTF-32, binary) is refused.
- The JavaScript (`src/app/`) only shows what the door answers: no parser, no decoding, no filter and no list of
  extensions of its own; everything of that comes from the pure core at the pinned commit.

## Security

- Every page carries a policy that forbids every request (`default-src 'none'`, `connect-src 'none'`), and the build
  refuses a page whose markup loads anything. The browser tests open each page and fail on any request, any violation
  of the policy and any write to an IndexedDB other than `casedesk-web`.
- The only exception is the probe's own test of that policy: it asks for `https://example.invalid/` and shows that
  the browser refused it.
- No page starts a program, installs anything or changes a setting of the machine. Nothing here is a script to run.
- Every local HTML file in Chrome shares the origin `file://`, and with it the browser's storage: open no other local
  page you do not trust in the same Chrome profile.
- Case data never go into the browser's storage. Only the handles of the folders used and of the catalog file, and
  settings of the view, are kept there; the browser tests check every write for the text of the logs and the catalog.
- A link of the catalog to a web page opens in a new tab when you click it; the page itself loads nothing.

Update with `git pull`, then check the sums again.

## Building and testing

Needs Node 22 or later, pnpm, git, and the checkouts of casedesk.nvim and lib.nvim (found through `CASEDESK_NVIM_DIR`
and `LIB_NVIM_DIR`, else `REPOS_DIR/casedesk.nvim` and `REPOS_DIR/lib.nvim`; the sources are read from the git
objects of the pinned commits, not from the working tree).

```
pnpm install
pnpm build                          # casedesk.html, probe.html, engine-check.html, SHA256SUMS
node build/pack.mjs --check         # the files in the repository are the build of the sources
pnpm test                           # Node: the door in wasmoon, the same answers as in Neovim, the pages
CASEDESK_WEB_COMPARE=1 pnpm test    # the same, a missing nvim is an error instead of a skipped test
pnpm e2e                            # Playwright with the system's Chrome: every page from disk
node build/bundle.mjs --report      # the bundled modules and the vim.* names they use
```

The CI (`.github/workflows/ci.yml`) runs these on every push to `main`: casedesk.nvim and lib.nvim checked out at the
commits of `engine.lock`, `--check` before the build, the build must leave the tree unchanged, then the tests in Node
and in Chrome, and an advisory `modern-web-guidance legacy-scan src`. Without nvim on the runner the comparison with
Neovim is skipped.

The bundle is made by casedesk.nvim's own `scripts/web/bundle.mjs`, read from the pinned commit (`git show`), plus the
three view modules and the door. The `vim` the core sees in the browser is the core's own shim, see
[docs/SHIM.md](docs/SHIM.md). The browser tests use the invented logs of casedesk.nvim's tests (at the pinned commit)
in an invented case folder, and an invented catalog (`e2e/fixtures/log-patterns.conf`).

## License

MIT, see [LICENSE](LICENSE). The reading copy and the engine check bundle third-party code (Lua 5.4 via wasmoon) under
its own license, listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
