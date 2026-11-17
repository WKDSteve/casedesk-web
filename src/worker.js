// The worker of the pages: the Lua core (engine.js) runs here, off the page's thread.
//
// A classic worker started from a blob, never `type: module`: a module worker from a blob does not start on a page
// opened from disk (`file://`, tasks-web probe 2026-10-28), a classic one does. The page hands in everything at `init`:
// the WASM of the VM, the Lua sources, the vim shim and the files to mount, so the worker never loads a file and never
// asks the network.
//
// The VM's loader asks `fetch` for its WASM. For the one address WASM_URL this worker answers from the bytes it got;
// every other request goes to the real `fetch`, which the page's CSP (`connect-src 'none'`) refuses.
//
// build/pack.mjs puts this file behind wasmoon's UMD bundle and engine.js, `export` and `import` dropped.

import { LuaFactory } from 'wasmoon';
import { WebEngine } from './engine.js';

export const WASM_URL = 'embedded:glue.wasm';

/** Let `fetch(WASM_URL)` answer with `bytes`, without a request. */
export function serveEmbeddedWasm(scope, bytes) {
  const real = scope.fetch.bind(scope);
  scope.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === WASM_URL) {
      return Promise.resolve(new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } }));
    }
    return real(input, init);
  };
}

/**
 * Messages in: `{ type: 'init', wasm, bundle, shim, files? }`, `{ type: 'call', id, method, request }`.
 * Messages out: `ready`, `result` (`id`, `text`, `code`, `ms`), `log`, `error` (with the `id` of a call, or none).
 * @param {{ fetch: typeof fetch, postMessage(m: object): void, onmessage: any }} scope
 * @param {{ factory?: () => any }} [options]  a test in Node passes the stock factory
 */
export function startWorker(scope, options = {}) {
  let engine = null;
  const post = (reply) => scope.postMessage(reply);

  scope.onmessage = async (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      // One engine per worker: a second init would wrap `fetch` again and start a second VM beside the first.
      if (engine) {
        post({ type: 'error', message: 'the engine is already started (one init per worker)' });
        return;
      }
      const t0 = performance.now();
      if (!options.factory) serveEmbeddedWasm(scope, msg.wasm);
      engine = WebEngine.create({
        factory: options.factory ? options.factory() : new LuaFactory(WASM_URL),
        bundle: msg.bundle,
        shim: msg.shim,
        log: (level, message) => post({ type: 'log', level, message }),
      }).then((e) => {
        if (msg.files) e.mount(msg.files);
        return e;
      });
      try {
        await engine;
        post({ type: 'ready', ms: Math.round(performance.now() - t0) });
      } catch (err) {
        post({ type: 'error', message: String(err) });
      }
      return;
    }
    if (msg.type === 'call') {
      if (!engine) {
        post({ type: 'error', id: msg.id, message: 'the engine is not started (init first)' });
        return;
      }
      try {
        const e = await engine;
        const t0 = performance.now();
        const r = e.call(msg.method, msg.request);
        post({ type: 'result', id: msg.id, text: r.text, code: r.code, ms: Math.round(performance.now() - t0) });
      } catch (err) {
        post({ type: 'error', id: msg.id, message: String(err) });
      }
      return;
    }
    post({ type: 'error', id: msg.id, message: `unknown message ${JSON.stringify(msg.type)}` });
  };
}
