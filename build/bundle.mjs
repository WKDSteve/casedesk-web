// Bundles the Lua sources the pages run: the pure core of casedesk.nvim (its own bundler, scripts/web/bundle.mjs, at
// the pinned commit), three pure modules of its view (time column, filter stack, tree nodes), the door of this
// repository (src/casedesk_web.lua). `vim` is the core's own shim (casedesk.web.vim_shim), part of the bundle.
//
//   node build/bundle.mjs [--report]
//
// The sources come from the git objects of the commits of engine.lock, never from a working tree, so a local change in
// a checkout cannot slip into the page. The bundler of casedesk.nvim is read from the pinned commit as well
// (`git show <pin>:scripts/web/bundle.mjs`), written to a file of the system's temp folder and imported: what goes into
// the page is decided by the manifest of that commit, not by a copy here. The checkouts: CASEDESK_NVIM_DIR and
// LIB_NVIM_DIR, else REPOS_DIR/casedesk.nvim and REPOS_DIR/lib.nvim.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, '..');

/**
 * Modules of casedesk.nvim's view that are pure (no `vim.api`, no file, no clock) and that the page needs besides the
 * core: the time column and gaps (`clock`), the filter stack (`filter`, its prompt is never called here) and the tree
 * nodes the reading copy unfolds to (`nodes`: JSON tree, condensed page source, stack trace tree). test/pack.test.mjs
 * checks that everything they require is in the bundle.
 */
export const VIEW_MODULES = [
  'lua/casedesk/logview/view/clock.lua',
  'lua/casedesk/logview/view/filter.lua',
  'lua/casedesk/logview/view/nodes.lua',
];

/** The file the levels of formats without one come from (`logs.TIERS`); the door holds a copy, test/door checks it. */
export const TIERS_SOURCE = 'lua/casedesk/logs.lua';

/** The fixture of the engine check: an invented BrowserStack device log of casedesk.nvim's tests. */
export const FIXTURE = 'TESTS/fixtures/logview/browserstack-device.log';

/** The invented logs of casedesk.nvim's tests (the browser tests and the comparison of both VMs read them). */
export const FIXTURE_DIR = 'TESTS/fixtures/logview/';

/** Modules of this repository: module name -> file. */
const OWN = {
  casedesk_web: join(root, 'src', 'casedesk_web.lua'),
};

/** @returns {{ casedesk_commit: string, lib_commit: string }} */
export function readLock(file = join(root, 'engine.lock')) {
  const lock = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([a-z_]+)\s*=\s*(\S+)\s*$/);
    if (m) lock[m[1]] = m[2];
  }
  for (const key of ['casedesk_commit', 'lib_commit']) {
    if (!/^[0-9a-f]{40}$/.test(lock[key] ?? '')) throw new Error(`engine.lock: ${key} must be a full commit hash`);
  }
  return { casedesk_commit: lock.casedesk_commit, lib_commit: lock.lib_commit };
}

export function checkout(envName, name) {
  if (process.env[envName]) return process.env[envName];
  if (process.env.REPOS_DIR) return join(process.env.REPOS_DIR, name);
  throw new Error(`${envName} or REPOS_DIR must name the ${name} checkout`);
}

/** The files of one commit under `prefixes`: path -> content (Buffer), read in one `git cat-file --batch`. */
export function gitFiles(dir, commit, prefixes) {
  // -z: without it git quotes a path outside ASCII, and cat-file would not find it
  const paths = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '-z', '--name-only', commit, '--', ...prefixes], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  if (paths.length === 0) throw new Error(`${dir} at ${commit} has no file under ${prefixes.join(', ')}`);
  const out = execFileSync('git', ['-C', dir, 'cat-file', '--batch'], {
    input: paths.map((p) => `${commit}:${p}\n`).join(''),
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = new Map();
  let at = 0;
  for (const path of paths) {
    const eol = out.indexOf(0x0a, at);
    const header = out.subarray(at, eol).toString('utf8');
    if (!/^[0-9a-f]+ blob \d+$/.test(header)) throw new Error(`git cat-file: ${header} (${path})`);
    const size = Number(header.split(' ')[2]);
    files.set(path, out.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  return files;
}

/** `lua/a/b/init.lua` -> `a.b`, `lua/a/b.lua` -> `a.b`; null for anything else. */
export function moduleName(path) {
  const m = path.match(/^lua\/(.+)\.lua$/);
  if (!m) return null;
  return m[1].replace(/\/init$/, '').replaceAll('/', '.');
}

/**
 * casedesk.nvim's bundler as it is at `commit`: written once per content to the temp folder (it imports only node:*,
 * so it runs from anywhere) and imported from there.
 */
export async function coreBundler(casedeskDir, commit) {
  const source = execFileSync('git', ['-C', casedeskDir, 'show', `${commit}:scripts/web/bundle.mjs`]);
  const file = join(tmpdir(), `casedesk-web-core-bundle-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.mjs`);
  if (!existsSync(file) || !readFileSync(file).equals(source)) writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

/**
 * The bundle: `{ engine: { casedesk_commit, lib_commit }, entry, shim, modules: { name: source }, report }`, the
 * fixture's text and the view modules' requires (for the test that they are all in; one under `pcall` may be missing).
 * @param {{ casedesk_commit: string, lib_commit: string }} [lock]
 */
export async function bundle(lock = readLock()) {
  const casedeskDir = checkout('CASEDESK_NVIM_DIR', 'casedesk.nvim');
  const libDir = checkout('LIB_NVIM_DIR', 'lib.nvim');
  const core = await coreBundler(casedeskDir, lock.casedesk_commit);
  const b = core.bundle({ casedeskDir, casedeskCommit: lock.casedesk_commit, libDir, libCommit: lock.lib_commit });
  const modules = { ...b.modules };
  const viewRequires = {};
  for (const [path, bytes] of gitFiles(casedeskDir, lock.casedesk_commit, VIEW_MODULES)) {
    const name = moduleName(path);
    const text = bytes.toString('utf8');
    if (modules[name]) throw new Error(`bundle: ${name} is in the core already`);
    const { tokens, comments } = core.lex(text);
    modules[name] = core.stripComments(text, comments);
    viewRequires[name] = core.requiresOf(tokens).filter((r) => !r.soft).map((r) => r.name);
  }
  for (const [name, file] of Object.entries(OWN)) {
    if (modules[name]) throw new Error(`bundle: ${name} comes from a pinned repository and from this one`);
    modules[name] = readFileSync(file, 'utf8');
  }
  const fixture = gitFiles(casedeskDir, lock.casedesk_commit, [FIXTURE]).get(FIXTURE).toString('utf8');
  return { engine: { ...lock }, entry: b.entry, shim: b.shim, modules, report: b.report, viewRequires, fixture };
}

/** The invented logs of casedesk.nvim's tests at the pinned commit: file name -> text. */
export function fixtures(lock = readLock()) {
  const casedeskDir = checkout('CASEDESK_NVIM_DIR', 'casedesk.nvim');
  const out = {};
  for (const [path, bytes] of gitFiles(casedeskDir, lock.casedesk_commit, [FIXTURE_DIR])) {
    out[path.slice(FIXTURE_DIR.length)] = bytes.toString('utf8');
  }
  return out;
}

/** `TIERS` of casedesk.nvim's logs.lua at the pinned commit, as written there (the door's copy must equal it). */
export function tiersSource(lock = readLock()) {
  const casedeskDir = checkout('CASEDESK_NVIM_DIR', 'casedesk.nvim');
  const text = gitFiles(casedeskDir, lock.casedesk_commit, [TIERS_SOURCE]).get(TIERS_SOURCE).toString('utf8');
  const m = text.match(/\nlocal TIERS = (\{[\s\S]*?\n\})/);
  if (!m) throw new Error(`${TIERS_SOURCE}: no "local TIERS = {...}"`);
  return m[1];
}

/** The part of a bundle the page carries: the pins, the entry and shim of the core, the sources. */
export function bundleJson(b) {
  return JSON.stringify({ engine: b.engine, entry: b.entry, shim: b.shim, modules: b.modules });
}

/** The `vim.*` names a source uses outside its comments (`vim.json.decode`, `vim.NIL`, ...). */
export function vimNames(source) {
  const names = new Set();
  for (const line of source.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '').split('\n')) {
    const code = line.replace(/--.*$/, '');
    for (const m of code.matchAll(/\bvim((?:\.[A-Za-z_][A-Za-z0-9_]*)+)/g)) names.add('vim' + m[1]);
  }
  return names;
}

async function main() {
  const b = await bundle();
  if (process.argv.includes('--report')) {
    for (const [name, source] of Object.entries(b.modules).sort()) {
      const used = [...vimNames(source)].sort();
      console.log(`${name.padEnd(44)} ${String(source.length).padStart(6)}  ${used.join(' ')}`);
    }
  }
  console.log(`bundle: ${Object.keys(b.modules).length} modules, ${bundleJson(b).length} bytes; fixture ${b.fixture.length} bytes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
