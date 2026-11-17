// Bundles the Lua sources the pages run: the pure core of casedesk.nvim's reading copy and lib.nvim's XML parser, at
// the commits of engine.lock, plus the door of this repository (src/casedesk_web.lua) and Neovim's inspect.lua.
//
//   node build/bundle.mjs [--report]
//
// The sources come from the git objects of the pinned commits, never from a working tree, so a local change in a
// checkout cannot slip into the page. The checkouts: CASEDESK_NVIM_DIR and LIB_NVIM_DIR, else REPOS_DIR/casedesk.nvim
// and REPOS_DIR/lib.nvim.
//
// Whole folders go in (FOLDERS), not the closure of the requires: the register of formats requires its built-in formats
// by a name it holds in a list, which no scan of literal requires finds. `--report` prints the modules, their size and
// the `vim.*` names they use outside comments; test/bundle.test.mjs checks that the shim knows each of them.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, '..');

/** The folders of each repository that go into the bundle (`lua/<module path>`). */
export const FOLDERS = {
  casedesk: ['lua/casedesk/logview/core', 'lua/casedesk/logview/formats', 'lua/casedesk/logview/@types'],
  lib: ['lua/lib/lua/xml'],
};

/** The fixture of the engine check: an invented BrowserStack device log of casedesk.nvim's tests. */
export const FIXTURE = 'TESTS/fixtures/logview/browserstack-device.log';

/** Modules of this repository: module name -> file. */
const OWN = {
  casedesk_web: join(root, 'src', 'casedesk_web.lua'),
  'vim.inspect': join(root, 'src', 'vendor', 'inspect.lua'),
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

function luaModules(dir, commit, prefixes) {
  const modules = {};
  for (const [path, bytes] of gitFiles(dir, commit, prefixes)) {
    const name = moduleName(path);
    if (name) modules[name] = bytes.toString('utf8');
  }
  return modules;
}

/**
 * The bundle: `{ engine: { casedesk_commit, lib_commit }, modules: { name: source } }`, and the fixture's text.
 * @param {{ casedesk_commit: string, lib_commit: string }} [lock]
 */
export function bundle(lock = readLock()) {
  const casedeskDir = checkout('CASEDESK_NVIM_DIR', 'casedesk.nvim');
  const libDir = checkout('LIB_NVIM_DIR', 'lib.nvim');
  const modules = {
    ...luaModules(casedeskDir, lock.casedesk_commit, FOLDERS.casedesk),
    ...luaModules(libDir, lock.lib_commit, FOLDERS.lib),
  };
  for (const [name, file] of Object.entries(OWN)) {
    if (modules[name]) throw new Error(`bundle: ${name} comes from a pinned repository and from this one`);
    modules[name] = readFileSync(file, 'utf8');
  }
  const fixture = gitFiles(casedeskDir, lock.casedesk_commit, [FIXTURE]).get(FIXTURE).toString('utf8');
  return { engine: { ...lock }, modules, fixture };
}

/** The part of a bundle the page carries: the pins and the sources. */
export function bundleJson(b) {
  return JSON.stringify({ engine: b.engine, modules: b.modules });
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

function main() {
  const b = bundle();
  if (process.argv.includes('--report')) {
    for (const [name, source] of Object.entries(b.modules).sort()) {
      const used = [...vimNames(source)].sort();
      console.log(`${name.padEnd(44)} ${String(source.length).padStart(6)}  ${used.join(' ')}`);
    }
  }
  console.log(`bundle: ${Object.keys(b.modules).length} modules, ${bundleJson(b).length} bytes; fixture ${b.fixture.length} bytes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
