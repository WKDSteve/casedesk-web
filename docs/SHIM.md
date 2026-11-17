# The `vim` shim

`src/vim-shim.lua` is the `vim` the Lua core of casedesk.nvim sees in the browser (wasmoon, Lua 5.4). It is a copy of
tasks-desktop `ui/src/web/vim-shim.lua` at commit `4a3220d`, without its door `__web_call` (the one of tasks.nvim):
casedesk-web's door is `src/casedesk_web.lua`, set up by `src/engine.js`.

Fixes of tasks-desktop are taken over by hand. What differs from that copy:

| Where | What | Why |
| --- | --- | --- |
| `json.decode`, a string cut by the end of the text | The error says `Expected value but found unexpected end of string at character N`, as Neovim's decoder does (was `Expected closing quote at character N`). | The reading copy shows the message as the note of a cut log line (the screenshot line of the test log); `test/engine.test.mjs` compares the answer of the door in wasmoon with the one in Neovim. |

## What the core uses

`node build/bundle.mjs --report` lists every bundled module with the `vim.*` names it uses outside comments, and
`test/pack.test.mjs` checks that the shim has each of them and that no editor-only name (`vim.api`, `vim.ui`, ...) is
among them. For the pinned core of casedesk.nvim these are: `vim.NIL`, `vim.islist`, `vim.json.decode`,
`vim.json.encode`, `vim.list_extend`, `vim.list_slice`, `vim.split`, `vim.tbl_keys`.

The core also asks for two modules that are not in the bundle, both with `pcall`: `casedesk.config` (the formats of
the user's config; without it only the built-in formats count) and the optional `data.detect` / `data.format.xml`
(without them the core falls back to `lib.lua.xml`). Both fallbacks are what the page wants for now.
