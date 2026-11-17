// The page side of the engine, shared by the pages that run the Lua core: the parts the page carries (base64 of gzip,
// see appkit-web's `assemble`) and the worker the core runs in. build/pack.mjs puts this file into each such page as a
// classic script (`export` dropped).

/** base64 -> bytes: `Uint8Array.fromBase64` where the browser has it, else `atob`. Both skip the line breaks. */
export function base64Bytes(text) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text.replace(/\s+/g, ''));
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function gunzip(bytes) {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

/** One part of the page: `{ gz, data }`, the size packed and the bytes. */
export async function unpackPart(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`the page lacks its part "${id}"`);
  const bytes = base64Bytes(node.textContent);
  return { gz: bytes.length, data: await gunzip(bytes) };
}

/**
 * A classic worker from a blob: a module worker from a blob does not start on a page opened from disk. `call` answers
 * `{ text, code, ms }`; `blobs` are texts the request names by number (`blob: 1` is the first).
 */
export function startEngineWorker(source) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url, { type: 'classic' });
  const pending = new Map();
  let next = 1;
  let ready;
  const readyP = new Promise((resolve, reject) => {
    ready = { resolve, reject };
  });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') ready.resolve(m.ms);
    else if (m.type === 'result') {
      pending.get(m.id)?.resolve(m);
      pending.delete(m.id);
    } else if (m.type === 'error') {
      if (m.id && pending.has(m.id)) {
        pending.get(m.id).reject(new Error(m.message));
        pending.delete(m.id);
      } else ready.reject(new Error(m.message));
    } else if (m.type === 'log') console.log('engine:', m.level, m.message);
  };
  worker.onerror = (e) => ready.reject(new Error(e.message || 'worker failed to start (event ' + e.type + ')'));
  return {
    worker,
    ready: readyP,
    call(method, params, blobs) {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({
          type: 'call',
          id,
          method,
          request: params === undefined ? null : JSON.stringify({ params }),
          blobs: blobs ?? [],
        });
      });
    },
  };
}

/** Unpack the engine parts of the page and start the core: the worker, ready for `call`. */
export async function startEngine() {
  const names = ['worker', 'wasm', 'bundle'];
  const got = await Promise.all(names.map(unpackPart));
  const parts = Object.fromEntries(names.map((n, i) => [n, got[i].data]));
  const dec = new TextDecoder();
  const w = startEngineWorker(dec.decode(parts.worker));
  const wasm = parts.wasm.buffer;
  w.worker.postMessage(
    { type: 'init', wasm, bundle: JSON.parse(dec.decode(parts.bundle)) },
    [wasm],
  );
  await w.ready;
  return w;
}
