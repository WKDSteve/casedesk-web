# casedesk-web

casedesk in the browser: single HTML pages Chrome opens from disk (`file://`) on a work machine, with the Lua core of
casedesk.nvim running in wasmoon (Lua 5.4 in WebAssembly). See [README.md](README.md) for what the pages do.

## What an agent must know

- Sources live in `src/` (vanilla JS, CSS, the Lua door `src/casedesk_web.lua`); `build/` packs them.
  `casedesk.html`, `probe.html`, `engine-check.html` and `SHA256SUMS` are build output: never edit them by hand,
  run `pnpm build` and commit them with the sources.
- The pages make no network request: a meta Content-Security-Policy forbids every request and the build refuses a page
  whose markup loads anything. No CDN, no remote font, no `fetch` to a server; everything is inlined.
- No second parser in JavaScript: logic belongs in the Lua core (casedesk.nvim, pinned in `engine.lock`) or the door,
  not in the page.
- Never put a log, a line of it, a case file or the catalog's text into browser storage (IndexedDB holds handles,
  `localStorage` the view settings).
- Checks (see README, *Building and testing*): `pnpm build`, `node build/pack.mjs --check`, `pnpm test`, `pnpm e2e`;
  the CI (`.github/workflows/ci.yml`, on a push to `main`) runs all of them with the checkouts at `engine.lock`.
  The build needs the checkouts of casedesk.nvim and lib.nvim (`CASEDESK_NVIM_DIR`, `LIB_NVIM_DIR` or `REPOS_DIR`).
- Supply chain: `pnpm-workspace.yaml` holds the rules (release age, no install scripts); do not loosen them.

## Web platform
- Browser Support: Baseline Widely available (`.mwgrc`, `browserslist`). Newer features only behind feature detection with a fallback; polyfills where browsers still in use need them (rather one too many), run only after the check: dynamic `import()`, or bundled in a `file://` page.
- Before writing or changing HTML, CSS or client-side JS, use the `modern-web-guidance` skill (`search` → `retrieve` → verify). Not for Rust, backend, CI or build config.
- For open-ended modernisation: `npx -y modern-web-guidance@latest legacy-scan <ui-dir> --json`, check each finding against `keepWhen`/`dropWhen`.
- Rules: the maintainer's ruleset for the web platform (private, so not named or cited here by id).
- This page runs as one `file://` file with `default-src 'none'`: it loads nothing at run time, so a polyfill is
  bundled into the page and called only when the feature check fails (decided 2026-11-21).
- `modern-web-guidance` is an exact devDependency (`1.0.0`, under the release-age quarantine of
  `pnpm-workspace.yaml`); the CI (`.github/workflows/ci.yml`) runs
  `DISABLE_TELEMETRY=1 pnpm exec modern-web-guidance legacy-scan src --json` as an advisory step (`continue-on-error`),
  the same line works locally. `.claude/settings.json` turns the tool's telemetry off and allows only
  `npx -y modern-web-guidance@latest *` (the skill's `search`/`retrieve`).
