# casedesk-web

casedesk in the browser: single HTML files that Chrome opens from disk (`file://`). No install, no server, no process
of its own: a page makes no network request (its Content-Security-Policy forbids it), and its data come from a local
folder you pick in the browser. The logic is the Lua core of casedesk.nvim, run by a Lua VM compiled to WebAssembly
(wasmoon, Lua 5.4) inside the page; there is no second parser in JavaScript.

This repository holds the sources and the built pages with their sums. The pages are built here (`pnpm build`), never
edited by hand.

What is here now is the scaffolding: a probe and an engine check. The page with the reading copy of case logs (menu
bar, side bar with errors, warnings and known error messages) comes next.

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

## Security

- Every page carries a policy that forbids every request (`default-src 'none'`, `connect-src 'none'`), and the build
  refuses a page whose markup loads anything. The browser tests open each page and fail on any request, any violation
  of the policy and any write to an IndexedDB other than `casedesk-web`.
- The only exception is the probe's own test of that policy: it asks for `https://example.invalid/` and shows that
  the browser refused it.
- No page starts a program, installs anything or changes a setting of the machine. Nothing here is a script to run.
- Every local HTML file in Chrome shares the origin `file://`, and with it the browser's storage: open no other local
  page you do not trust in the same Chrome profile.
- Case data never go into the browser's storage. Only the handle of the picked folder and settings of the view are
  kept there.

Update with `git pull`, then check the sums again.

## Building and testing

Needs Node 22 or later, pnpm, git, and the checkouts of casedesk.nvim and lib.nvim (found through `CASEDESK_NVIM_DIR`
and `LIB_NVIM_DIR`, else `REPOS_DIR/casedesk.nvim` and `REPOS_DIR/lib.nvim`; the sources are read from the git
objects of the pinned commits, not from the working tree).

```
pnpm install
pnpm build                          # probe.html, engine-check.html, SHA256SUMS
node build/pack.mjs --check         # the files in the repository are the build of the sources
pnpm test                           # Node: the core in wasmoon, the same answer as in Neovim, the pages
CASEDESK_WEB_COMPARE=1 pnpm test    # the same, a missing nvim is an error instead of a skipped test
pnpm e2e                            # Playwright with the system's Chrome: both pages from disk
node build/bundle.mjs --report      # the bundled modules and the vim.* names they use
```

The `vim` the core sees in the browser is `src/vim-shim.lua`, taken from tasks-desktop; what differs from there is
listed in [docs/SHIM.md](docs/SHIM.md).

## License

MIT, see [LICENSE](LICENSE). The engine check bundles third-party code (Lua 5.4 via wasmoon, inspect.lua) under its own
license, listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
