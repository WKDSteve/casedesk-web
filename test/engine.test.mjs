// The Lua core in wasmoon (Lua 5.4), in Node: the same VM, shim and bundle as the pages, with the stock VM factory.
// Then the same door in Neovim (LuaJIT), the answers compared: CASEDESK_WEB_COMPARE=1 makes a missing nvim an error.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LuaFactory } from 'wasmoon';
import { bundle, root } from '../build/bundle.mjs';
import { WebEngine } from '../src/engine.js';

const LOG = '/case/assets/device.log';

let b;
let engine;

before(async () => {
  b = bundle();
  engine = await WebEngine.create({
    factory: new LuaFactory(),
    bundle: b,
    shim: readFileSync(join(root, 'src', 'vim-shim.lua'), 'utf8'),
  });
  engine.mount({ [LOG]: b.fixture });
});

after(() => engine?.close());

const call = (method, params) => {
  const r = engine.call(method, params === undefined ? null : JSON.stringify({ params }));
  return { code: r.code, doc: JSON.parse(r.text) };
};

describe('the door in wasmoon', () => {
  test('hello names Lua 5.4', () => {
    const { code, doc } = call('hello');
    assert.equal(code, null);
    assert.equal(doc.kind, 'casedesk-web.hello');
    assert.equal(doc.lua, 'Lua 5.4');
  });

  test('the reading copy of the fixture: format, entries, unfolded parts', () => {
    const { code, doc } = call('reading_copy', { path: LOG });
    assert.equal(code, null, JSON.stringify(doc));
    assert.equal(doc.kind, 'casedesk-web.reading_copy');
    assert.equal(doc.format, 'browserstack');
    assert.equal(doc.known, true);
    assert.equal(doc.bytes, Buffer.byteLength(b.fixture, 'utf8'));
    assert.ok(doc.entries.length > 5, `entries: ${doc.entries.length}`);
    // every entry has a head row; the requests carry a time
    for (const e of doc.entries) assert.equal(typeof e.text, 'string');
    assert.equal(doc.entries.length, 11);
    assert.equal(doc.entries[0].time, '07:58:30.904');
    assert.equal(doc.entries.at(-1).level, 'warn');
    // a page source unfolds through lib.lua.xml: "GET /source" unfolds to its ten nodes
    const source = doc.entries.find((e) => e.text.startsWith('GET /source → page source · 10 nodes'));
    assert.equal(source?.unfolded, 10);
    // the cut screenshot line: the note names the JSON error as Neovim's decoder does
    assert.match(doc.entries[9].note, /^invalid JSON: Expected value but found unexpected end of string/);
    // the diff-friendly form: one masked head per entry
    assert.equal(doc.normalized.length, doc.entries.length);
    assert.equal(doc.normalized[7], 'REQ    POST /element/<n>/click → null (<n> ms)');
  });

  test('errors are answers: unknown method, missing path, missing file', () => {
    assert.equal(call('nope').code, 'unknown_method');
    assert.equal(call('reading_copy', {}).code, 'bad_request');
    const missing = call('reading_copy', { path: '/case/none.log' });
    assert.equal(missing.code, 'internal');
    assert.match(missing.doc.message, /cannot read/);
  });
});

// The same door in Neovim: LuaJIT and the real `vim`. Both answers must be the same document.
function nvim() {
  try {
    execFileSync('nvim', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('wasmoon and Neovim give the same answer', () => {
  const compare = process.env.CASEDESK_WEB_COMPARE === '1';
  const have = nvim();
  test('reading copy of the fixture', { skip: !have && !compare && 'nvim is not on PATH' }, () => {
    assert.ok(have, 'CASEDESK_WEB_COMPARE=1 needs nvim on PATH');
    const dir = mkdtempSync(join(tmpdir(), 'casedesk-web-'));
    try {
      const lua = join(dir, 'lua');
      for (const [name, source] of Object.entries(b.modules)) {
        if (name === 'vim.inspect') continue; // Neovim brings its own
        const file = join(lua, ...name.split('.')) + '.lua';
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, source);
      }
      const log = join(dir, 'device.log');
      writeFileSync(log, b.fixture);
      const out = join(dir, 'out.txt');
      const script = join(dir, 'door.lua');
      writeFileSync(
        script,
        [
          'local dir = _G.arg[1]',
          'package.path = dir .. "/lua/?.lua;" .. dir .. "/lua/?/init.lua;" .. package.path',
          `local text = require("casedesk_web").door("reading_copy", vim.json.encode({ params = { path = ${JSON.stringify(LOG)} } }))`,
          'local f = assert(io.open(dir .. "/out.txt", "wb")); f:write(text); f:close()',
        ].join('\n'),
      );
      // the door reads the path inside the VM; in nvim the same path is the copy in the folder of this test
      const mapped = readFileSync(script, 'utf8').replace(JSON.stringify(LOG), JSON.stringify(log.replaceAll('\\', '/')));
      writeFileSync(script, mapped);
      execFileSync('nvim', ['--clean', '--headless', '-n', '-i', 'NONE', '-l', script, dir.replaceAll('\\', '/')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      const raw = readFileSync(out, 'utf8');
      const nl = raw.indexOf('\n');
      assert.equal(raw.slice(0, nl), '', raw);
      const fromNvim = JSON.parse(raw.slice(nl + 1));
      const fromWeb = call('reading_copy', { path: LOG }).doc;
      fromNvim.path = fromWeb.path;
      assert.deepEqual(fromWeb, fromNvim);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
