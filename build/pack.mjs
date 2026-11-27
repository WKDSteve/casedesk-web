// Builds the pages of casedesk-web into the root of this repository, with their SHA256SUMS.
//
//   node build/pack.mjs            build casedesk.html, probe.html and engine-check.html, write SHA256SUMS
//   node build/pack.mjs --check    build in memory and compare with the files in the repository (exit 1 if they differ)
//
// casedesk.html: the reading copy of case logs (src/app/). One file like the engine check, with four parts (the
// worker's script, the WASM, the Lua sources) and the same policy; its script is appkit-web's folder.js and
// folder-input.js, src/client.js, src/app/util.js and src/app/main.js as one classic script.
//
// engine-check.html: one file, made by appkit-web's `assemble`: the script and the style inline, four parts
// gzip-compressed as base64 (the worker's script, the WASM of the Lua VM, the Lua sources with the core's vim shim, the
// test log),
// and the policy CSP_WASM_WORKER as a meta tag (no request of any kind, WASM from embedded bytes, a worker from a blob).
// `verifyShell` refuses a shell that loads anything; what the script does at run time is checked by the browser test
// (e2e/), which opens the file and counts the requests.
//
// probe.html: the page of probe/probe.src.html plus a filler the size of the Lua VM, checked with `verify` (it may name
// the one address of its test of a blocked request).
//
// The build label is the start of a hash of everything that goes into the page, so the same sources give the same file
// and the same sum, before and after a commit.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, CSP_WASM_WORKER, verify, verifyShell, writePage } from 'appkit-web/pack';
import { bundle, bundleJson, root } from './bundle.mjs';

export const PART_IDS = ['worker', 'wasm', 'bundle', 'fixture'];
export const APP_PART_IDS = ['worker', 'wasm', 'bundle'];
export const PAGES = ['casedesk.html', 'probe.html', 'engine-check.html'];

/** The scripts of casedesk.html, in order: appkit-web's folder modules, then this repository's. */
export const APP_SCRIPTS = [
  ['node_modules', 'appkit-web', 'src', 'folder.js'],
  ['node_modules', 'appkit-web', 'src', 'folder-input.js'],
  ['src', 'client.js'],
  ['src', 'app', 'util.js'],
  ['src', 'app', 'main.js'],
];

const PROBE_ALLOW = ['https://example.invalid/'];
const FILLER_BYTES = 384 * 1024; // about 512 KiB of base64, the size of the VM

const src = (...p) => readFileSync(join(root, ...p), 'utf8');
const wasmoonDir = join(root, 'node_modules', 'wasmoon', 'dist');

/** A module of src/ as a classic script: imports dropped, `export` removed. Refuses what it cannot turn into one. */
export function classic(js) {
  // a re-export needs a module system; a classic script has none
  if (/^\s*export\s*\*/m.test(js)) throw new Error('classic: an import or export is left (export * from)');
  const out = js
    .replace(/^[ \t]*import\b[\s\S]*?(['"])[^'"\n]+\1[ \t]*;?/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\}[^;\n]*;?/gm, '')
    .replace(/^([ \t]*)export\s+(?:default\s+)?/gm, '$1');
  if (/^\s*(?:import|export)\b/m.test(out)) throw new Error('classic: an import or export is left');
  return out;
}

/** The worker's script: the VM loader (wasmoon's UMD bundle sets `self.wasmoon`), engine.js, worker.js. */
export function workerSource() {
  return [
    readFileSync(join(wasmoonDir, 'index.js'), 'utf8'),
    'const { LuaFactory } = self.wasmoon;',
    classic(src('src', 'engine.js')),
    classic(src('src', 'worker.js')),
    'startWorker(self);',
  ].join('\n;\n');
}

const sha = (data) => createHash('sha256').update(data).digest('hex');

/** The parts every engine page carries. */
function engineParts(b) {
  return {
    worker: Buffer.from(workerSource(), 'utf8'),
    wasm: readFileSync(join(wasmoonDir, 'glue.wasm')),
    bundle: Buffer.from(bundleJson(b), 'utf8'),
  };
}

const engineLabel = (b) => `casedesk.nvim ${b.engine.casedesk_commit.slice(0, 7)}, lib.nvim ${b.engine.lib_commit.slice(0, 7)}`;

/** The reading copy page. */
export function app(b) {
  const parts = engineParts(b);
  const css = src('src', 'app', 'app.css');
  const script = APP_SCRIPTS.map((p) => classic(readFileSync(join(root, ...p), 'utf8'))).join('\n;\n');
  const build = sha([css, script, ...APP_PART_IDS.map((id) => sha(parts[id]))].join('\n')).slice(0, 12);
  const engine = engineLabel(b);
  const js = `const PAGE = ${JSON.stringify({ build, engine })};\n${script}`;
  // The text of this page is German: Intl, the translator and the screen reader go by the language of the page.
  const html = assemble({
    css,
    js,
    partIds: APP_PART_IDS,
    parts,
    csp: CSP_WASM_WORKER,
    title: 'casedesk',
    lang: 'de',
    comment:
      `casedesk-web, the reading copy of case logs, build ${build}, ${engine}. Third-party code inside: Lua 5.4 and ` +
      'wasmoon 1.16.0 (MIT); see THIRD-PARTY-NOTICES.md',
  });
  const problems = verifyShell(html, { partIds: APP_PART_IDS });
  if (problems.length) throw new Error('casedesk: ' + problems.join('; '));
  return html;
}

/** The engine check page. */
export function engineCheck(b) {
  const parts = { ...engineParts(b), fixture: Buffer.from(b.fixture, 'utf8') };
  const css = src('src', 'engine-check.css');
  const script = classic(src('src', 'client.js')) + '\n;\n' + src('src', 'engine-check.js');
  const build = sha([css, script, ...PART_IDS.map((id) => sha(parts[id]))].join('\n')).slice(0, 12);
  const engine = engineLabel(b);
  const sizes = Object.fromEntries(PART_IDS.map((id) => [id, parts[id].length]));
  const js = `const PAGE = ${JSON.stringify({ build, engine, sizes })};\n${script}`;
  const html = assemble({
    css,
    js,
    partIds: PART_IDS,
    parts,
    csp: CSP_WASM_WORKER,
    title: 'casedesk-web engine check',
    comment:
      `casedesk-web engine check, build ${build}, ${engine}. Third-party code inside: Lua 5.4 and wasmoon 1.16.0 ` +
      '(MIT); see THIRD-PARTY-NOTICES.md',
  });
  const problems = verifyShell(html, { partIds: PART_IDS });
  if (problems.length) throw new Error('engine-check: ' + problems.join('; '));
  return html;
}

// xorshift32 from a fixed seed: incompressible enough to look like a VM, the same on every run.
function filler(n) {
  const bytes = new Uint8Array(n);
  let x = 0x2545f491;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x & 0xff;
  }
  return Buffer.from(bytes).toString('base64').replace(/.{1,120}/g, '$&\n');
}

/** The probe page. */
export function probe() {
  const page = src('probe', 'probe.src.html');
  const build = sha(page).slice(0, 12);
  const html = page.replaceAll('__BUILD__', build).replace('__FILLER_B64__', () => filler(FILLER_BYTES));
  const problems = verify(html, { allowUrls: PROBE_ALLOW });
  const wasm = html.match(/const WASM = new Uint8Array\(\[([^\]]*)\]\)/);
  if (!wasm) problems.push('the WASM bytes are missing');
  else {
    const bytes = new Uint8Array(wasm[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number));
    if (!WebAssembly.validate(bytes)) problems.push('the WASM bytes are no valid module');
  }
  if (problems.length) throw new Error('probe: ' + problems.join('; '));
  return html;
}

/** Every page: name -> html. */
export async function pages() {
  const b = await bundle();
  return { 'casedesk.html': app(b), 'probe.html': probe(), 'engine-check.html': engineCheck(b) };
}

/** The text of SHA256SUMS for these pages, in the order of PAGES. */
export function sums(built) {
  return PAGES.map((name) => `${sha(built[name])}  ${name}\n`).join('');
}

async function main() {
  const built = await pages();
  if (process.argv.includes('--check')) {
    const stale = PAGES.filter((name) => {
      try {
        return readFileSync(join(root, name), 'utf8') !== built[name];
      } catch {
        return true;
      }
    });
    let sumsStale = false;
    try {
      sumsStale = readFileSync(join(root, 'SHA256SUMS'), 'utf8') !== sums(built);
    } catch {
      sumsStale = true;
    }
    if (stale.length || sumsStale) {
      console.error(`pack --check: out of date: ${[...stale, ...(sumsStale ? ['SHA256SUMS'] : [])].join(', ')} (run "pnpm build")`);
      process.exit(1);
    }
    console.log('pack --check: the pages and SHA256SUMS match the sources');
    return;
  }
  // writePage writes the page and a SHA256SUMS of that one page; the file of all pages is written after them.
  for (const name of PAGES) {
    const digest = writePage(root, name, built[name]);
    console.log(`${digest}  ${name} (${built[name].length} bytes)`);
  }
  writeFileSync(join(root, 'SHA256SUMS'), sums(built));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
