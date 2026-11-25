// The engine check page: starts the Lua core of casedesk.nvim in a worker and builds the reading copy of an invented
// BrowserStack device log that is part of the page. Reads no folder of this machine, makes no request (the CSP forbids
// every one). build/pack.mjs puts `const PAGE = {...}` (build, pins, sizes) in front of this script.
/* global PAGE */

const T0 = performance.now();
const results = new Map();
const app = document.getElementById('app');

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

const rows = el('tbody', { id: 'rows' });
const out = el('pre', { id: 'out' });
const copy = el('button', { id: 'copy', type: 'button' }, 'Copy result');
const entries = el('tbody', { id: 'entries' });
app.append(
  el('h1', {}, 'casedesk-web engine check'),
  el(
    'p',
    { class: 'note' },
    `Starts the Lua core of casedesk.nvim (${PAGE.engine}) in a Lua VM in a worker and builds the reading copy of an ` +
      'invented BrowserStack device log that is part of this file. Reads no folder of this machine and makes no network ' +
      `request (the CSP forbids it). Build: ${PAGE.build}.`,
  ),
  copy,
  el('table', { class: 'checks' }, rows),
  el('h2', {}, 'Result (paste into the task notes)'),
  out,
  el('h2', {}, 'Reading copy of the test log'),
  el(
    'table',
    { class: 'entries' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Line'), el('th', {}, 'Time'), el('th', {}, 'Kind'), el('th', {}, 'Level'), el('th', {}, 'Entry'))),
    entries,
  ),
);

function set(id, label, state, detail) {
  results.set(id, { label, state, detail: String(detail ?? '') });
  let row = document.getElementById('row-' + id);
  if (!row) {
    row = el('tr', { id: 'row-' + id }, el('td'), el('td'), el('td'));
    rows.append(row);
  }
  row.cells[0].className = 'state ' + state;
  row.cells[1].textContent = label;
  row.cells[2].textContent = String(detail ?? '');
  const lines = ['casedesk-web engine check ' + PAGE.build + ', ' + new Date().toISOString()];
  for (const r of results.values()) lines.push('- ' + r.state.toUpperCase() + ' ' + r.label + ': ' + r.detail);
  out.textContent = lines.join('\n');
  document.body.dataset.state = state === 'fail' ? 'fail' : (document.body.dataset.state ?? 'running');
}

const err = (e) => (e && e.name ? e.name + ': ' + e.message : String(e));
const ms = (t) => Math.round(performance.now() - t) + ' ms';
const withTimeout = (p, msec, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out after ' + msec + ' ms')), msec))]);

// base64Bytes, gunzip, unpackPart and startEngineWorker come from src/client.js, put in front of this script.

function showEntries(doc) {
  entries.replaceChildren(
    ...doc.entries.map((e) =>
      el(
        'tr',
        { class: 'level-' + (e.level ?? 'none') },
        el('td', {}, String(e.line)),
        el('td', {}, e.time ?? ''),
        el('td', {}, e.kind),
        el('td', {}, e.level ?? ''),
        el('td', {}, e.text + (e.note ? '  [' + e.note + ']' : '') + (e.unfolded ? '  (+' + e.unfolded + ' lines)' : '')),
      ),
    ),
  );
}

const LOG = 'device.log';

async function main() {
  set('env', 'Origin', location.protocol === 'file:' ? 'ok' : 'info', location.protocol + ' secureContext=' + window.isSecureContext);
  set('ua', 'Browser', 'info', navigator.userAgent);
  set('sizes', 'Embedded parts (bytes, unpacked)', 'info', JSON.stringify(PAGE.sizes));
  const names = ['worker', 'wasm', 'bundle', 'fixture'];
  let parts;
  try {
    const t = performance.now();
    const got = await Promise.all(names.map(unpackPart));
    parts = Object.fromEntries(names.map((n, i) => [n, got[i].data]));
    set('unpack', 'Unpack (gzip, DecompressionStream)', 'ok', ms(t) + ', gzip ' + got.map((g, i) => names[i] + '=' + g.gz).join(' '));
  } catch (e) {
    set('unpack', 'Unpack (gzip, DecompressionStream)', 'fail', err(e));
    return finish();
  }
  const dec = new TextDecoder();
  let w;
  try {
    const t = performance.now();
    w = startEngineWorker(dec.decode(parts.worker));
    const wasm = parts.wasm.buffer;
    const init = {
      type: 'init',
      wasm,
      bundle: JSON.parse(dec.decode(parts.bundle)),
    };
    w.worker.postMessage(init, [wasm]);
    const inWorker = await withTimeout(w.ready, 30000, 'engine start');
    set('start', 'Lua core started in a classic blob worker', 'ok', ms(t) + ' (in the worker ' + inWorker + ' ms)');
  } catch (e) {
    set('start', 'Lua core started in a classic blob worker', 'fail', err(e));
    return finish();
  }
  try {
    const r = await withTimeout(w.call('hello'), 30000, 'hello');
    const doc = JSON.parse(r.text);
    set('hello', 'call hello', r.code ? 'fail' : 'ok', (r.code ? r.code + ': ' + doc.message : doc.lua) + ', ' + r.ms + ' ms');
  } catch (e) {
    set('hello', 'call hello', 'fail', err(e));
  }
  try {
    const r = await withTimeout(w.call('reading_copy', { name: LOG, blob: 1 }, [dec.decode(parts.fixture)]), 30000, 'reading_copy');
    const doc = JSON.parse(r.text);
    if (r.code) {
      set('copy-doc', 'Reading copy of the test log', 'fail', r.code + ': ' + doc.message);
    } else {
      const unfolded = doc.entries.reduce((n, e) => n + e.unfolded, 0);
      const times = doc.entries.filter((e) => e.time).map((e) => e.time);
      set(
        'copy-doc',
        'Reading copy of the test log',
        doc.known && doc.entries.length > 0 ? 'ok' : 'fail',
        `format ${doc.format} (${doc.confidence}), ${doc.entries.length} entries, ${unfolded} unfolded lines, ` +
          `times ${times[0]} .. ${times.at(-1)}, ${r.ms} ms`,
      );
      showEntries(doc);
    }
  } catch (e) {
    set('copy-doc', 'Reading copy of the test log', 'fail', err(e));
  }
  finish();
}

function finish() {
  set('total', 'Time to all checks', 'info', ms(T0));
  if (document.body.dataset.state !== 'fail') document.body.dataset.state = 'done';
}

copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(out.textContent);
    set('copy', 'Copy result', 'ok', 'on the clipboard');
  } catch (e) {
    set('copy', 'Copy result', 'fail', err(e) + ' (select the text below by hand)');
  }
});

main();
