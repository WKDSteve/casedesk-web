# The `vim` the core sees in the browser

The Lua core of casedesk.nvim expects a few things of Neovim's `vim` (`vim.json`, `vim.NIL`, `vim.split`,
`vim.islist`, `vim.tbl_*`, ...). In the pages that is `casedesk.web.vim_shim` of casedesk.nvim itself, part of the
bundle at the pinned commit: `src/engine.js` loads the modules of the bundle as `package.preload`, calls
`require(bundle.shim).install()` and takes the door of `src/casedesk_web.lua`.

The shim of the core follows Neovim where it shows:

- JSON as lua-cjson reads and writes it (Neovim's `vim.json`): the grammar, the error messages (they become the note
  of a cut log line) and numbers as doubles (a large number in a JSON body reads `1.2345678901235e+17` as in Neovim);
- on Lua 5.4 what the core expects of LuaJIT: `unpack`, `table.unpack`, `tostring` of a float.

casedesk.nvim checks the shim against Neovim with all its fixtures (`scripts/web/check.sh`). This repository checks
the door the same way: `test/engine.test.mjs` runs every fixture through both VMs (open, every view, unfolded two
levels, a merge with a catalog) and compares each answer.

## Before 2026-11-17

Up to the scaffolding the pages carried a copy of tasks-desktop's `vim-shim.lua` (an in-memory file system, a clock,
the module loader). The reading copy gets its texts with each call and needs neither a file nor a clock, and the copy
read JSON numbers as Lua 5.4 integers, so an unfolded JSON body showed a large number other than Neovim does. It went
away with the reading copy; the module loader is the few lines of `PRELUDE` in `src/engine.js`.

## What the core uses

`node build/bundle.mjs --report` lists every bundled module with the `vim.*` names it uses outside comments;
`test/pack.test.mjs` checks that the shim has each of them and that no editor-only name (`vim.api`, `vim.ui`, ...) is
among them. One exception is allowed: `casedesk.logview.view.filter` names `vim.ui.input` in its prompt, which the page
never calls (it asks for a filter in its own dialog).

The core also asks for modules that are not in the bundle, each with `pcall`: `casedesk.config` (the formats of the
user's config; without it only the built-in formats count), `data.detect` / `data.format.xml` (without them the core
falls back to `lib.lua.xml`) and `pickers.refine` (without it the filter stack is the core's own, the same fields).
