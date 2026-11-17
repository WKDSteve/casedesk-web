# Third-party notices

The pages that run the Lua core (`casedesk.html`, `engine-check.html`) bundle the code below; their heads name the same
in a comment. Versions as in `pnpm-lock.yaml`.

| Component | Version | License | In |
| --- | --- | --- | --- |
| Lua (compiled to WebAssembly by wasmoon) | 5.4 | MIT | casedesk.html, engine-check.html |
| wasmoon | 1.16.0 | MIT | casedesk.html, engine-check.html |
| Emscripten runtime (JavaScript glue inside wasmoon) | as built by wasmoon | MIT | casedesk.html, engine-check.html |

First-party code in the pages, all MIT, Copyright (c) 2026 Stefan Bartl: casedesk-web (pages, worker, door),
appkit-web (folder choice, the folders used before), and the Lua of casedesk.nvim and lib.nvim (with its `vim` shim).
`probe.html` contains no third-party code.

## Copyright notices

- Lua (compiled to WebAssembly by wasmoon): Copyright (C) 1994-2024 Lua.org, PUC-Rio.
- wasmoon: Copyright (c) 2023 Gabriel Francisco.
- Emscripten runtime (JavaScript glue inside wasmoon): Copyright (c) 2010-2014 Emscripten authors, see the AUTHORS file
  of Emscripten.

## MIT License (all components above)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
