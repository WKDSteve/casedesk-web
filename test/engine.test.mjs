// The Lua core in wasmoon (Lua 5.4), in Node: the same VM, shim and bundle as the pages, with the stock VM factory.
// Then the same door in Neovim (LuaJIT), the answers compared: CASEDESK_WEB_COMPARE=1 makes a missing nvim an error.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LuaFactory } from 'wasmoon';
import { bundle, fixtures, root } from '../build/bundle.mjs';
import { WebEngine } from '../src/engine.js';

const CATALOG = readFileSync(join(root, 'e2e', 'fixtures', 'log-patterns.conf'), 'utf8');

let b;
let fx;
let engine;

before(async () => {
  b = await bundle();
  fx = fixtures();
  engine = await WebEngine.create({ factory: new LuaFactory(), bundle: b });
});

after(() => engine?.close());

const call = (method, params, blobs) => {
  const r = engine.call(method, params === undefined ? null : JSON.stringify({ params }), blobs);
  return { code: r.code, doc: JSON.parse(r.text) };
};
const ok = (method, params, blobs) => {
  const { code, doc } = call(method, params, blobs);
  assert.equal(code, null, JSON.stringify(doc));
  return doc;
};
const list = (x) => (Array.isArray(x) ? x : []);

describe('the door in wasmoon', () => {
  test('hello names Lua 5.4 and the version of casedesk.web.api', () => {
    const doc = ok('hello');
    assert.equal(doc.kind, 'casedesk-web.hello');
    assert.equal(doc.lua, 'Lua 5.4');
    assert.equal(doc.api, 1);
  });

  test('the reading copy of the fixture in one piece (the engine check)', () => {
    const doc = ok('reading_copy', { name: 'device.log', blob: 1 }, [b.fixture]);
    assert.equal(doc.kind, 'casedesk-web.reading_copy');
    assert.equal(doc.format, 'browserstack');
    assert.equal(doc.known, true);
    assert.equal(doc.bytes, Buffer.byteLength(b.fixture, 'utf8'));
    assert.equal(doc.entries.length, 11);
    assert.equal(doc.entries[0].time, '07:58:30.904');
    assert.equal(doc.entries.at(-1).level, 'warn');
    const source = doc.entries.find((e) => e.text.startsWith('GET /source → page source · 10 nodes'));
    assert.equal(source?.unfolded, 10);
    assert.match(doc.entries[9].note, /^invalid JSON: Expected value but found unexpected end of string/);
    assert.equal(doc.normalized.length, doc.entries.length);
    assert.equal(doc.normalized[7], 'REQ    POST /element/<n>/click → null (<n> ms)');
  });

  test('open, view, unfold: rows, side bar groups, the page source in each mode', () => {
    const open = ok('open', { logs: [{ name: 'assets/browserstack-device.log', blob: 1 }] }, [fx['browserstack-device.log']]);
    assert.equal(open.format.id, 'browserstack');
    assert.equal(open.entries, 11);
    assert.equal(open.merged, false);
    assert.equal(open.files[0].name, 'browserstack-device.log', 'a path is cut to its name');
    const v = ok('view', {});
    assert.equal(v.rows.length, 11);
    assert.deepEqual(v.status, { shown: 11, total: 11, filter: '', time: 'original', unzoned: 0, mode: 'labelled' });
    assert.deepEqual(v.groups.errors.map((r) => r.id), ['e6']);
    assert.deepEqual(v.groups.warnings.map((r) => r.id), ['e11']);
    const e7 = v.rows.find((r) => r.id === 'e7');
    assert.equal(e7.request, true);
    assert.equal(e7.pagesource, true);
    assert.equal(e7.delta, '+32,9 s');
    const labelled = ok('children', { ids: ['e7'] }).nodes[0].children;
    assert.equal(labelled[0].label, '10 nodes, 5 with text/id/description · showing 5 (labelled; gs switches)');
    assert.equal(labelled.length, 6);
    // spans are byte ranges of the label with casedesk.nvim's groups
    assert.ok(labelled[2].spans.some((s) => s[2] === 'CaselogClass'));
    const all = ok('children', { ids: ['e7'], mode: 'all' });
    assert.equal(all.mode, 'all');
    assert.match(all.nodes[0].children[0].label, /showing \d+ \(all; gs switches\)/);
    // a later view keeps the mode
    assert.equal(ok('view', {}).status.mode, 'all');
    ok('children', { ids: [], mode: 'labelled' });
    // a nested node: the request part of e6 unfolds to its JSON
    const e6 = ok('children', { ids: ['e6'] }).nodes[0].children;
    assert.deepEqual(e6.map((n) => n.label), ['request', 'response']);
    const req = ok('children', { ids: ['e6/p1'] }).nodes[0].children;
    assert.ok(req.length > 0);
  });

  test('time modes, filters of the core, repeats folded or not', () => {
    ok('open', { logs: [{ name: 'tbox-agent.log', blob: 1 }] }, [fx['tbox-agent.log']]);
    const folded = ok('view', {});
    assert.equal(folded.rows.length, 6);
    assert.equal(folded.rows[1].rep, '×3 (08:00:02 – 08:02:02)');
    assert.deepEqual(folded.groups.repeats.map((r) => r.id), ['e2']);
    assert.deepEqual(folded.groups.exceptions.map((r) => r.text), ['OpenQA.Selenium.WebDriverException']);
    assert.equal(ok('view', { repeats: false }).rows.length, 8);
    assert.equal(ok('view', { time: 'relative' }).rows[0].time, '+00:00:00.000');
    const errorsOnly = ok('view', { filters: [{ field: 'level', raw: '/^[ef][ra][rt]/' }] });
    assert.deepEqual(errorsOnly.rows.map((r) => r.id), ['e7']);
    assert.equal(errorsOnly.status.filter, 'level=~^[ef][ra][rt]');
    const notHeartbeat = ok('view', { filters: [{ field: 'text', raw: '!heartbeat' }] });
    assert.ok(notHeartbeat.rows.every((r) => !/heartbeat/i.test(r.text)));
    assert.equal(notHeartbeat.status.filter, '¬text~heartbeat');
    // a stack trace unfolds as a tree, the foreign frames folded
    const stack = ok('children', { ids: ['e7'] }).nodes[0].children;
    assert.ok(stack.some((n) => n.label === '… 3 foreign frames (OpenQA.Selenium)' && n.expandable));
  });

  test('merged logs: one view by time, a file tag per row, gaps, the original lines of each file', () => {
    const open = ok(
      'open',
      { logs: [{ name: 'merge-fileservice.log', blob: 1 }, { name: 'merge-gateway.log', blob: 2 }] },
      [fx['merge-fileservice.log'], fx['merge-gateway.log']],
    );
    assert.equal(open.merged, true);
    assert.equal(open.format.id, 'merge');
    assert.deepEqual(open.files.map((f) => f.tag), ['merge-fileservice', 'merge-gateway']);
    const v = ok('view', { time: 'utc' });
    assert.deepEqual([...new Set(v.rows.filter((r) => r.type === 'entry').map((r) => r.tag))].sort(), ['merge-fileservice', 'merge-gateway']);
    assert.ok(v.rows.some((r) => r.type === 'gap'));
    const row = v.rows.find((r) => r.type === 'entry' && r.file === 2);
    const orig = ok('original', { from: row.src, to: row.src_end, file: 2 });
    assert.equal(orig.name, 'merge-gateway.log');
    assert.equal(orig.lines.length, row.src_end - row.src + 1);
    assert.equal(orig.lines[0], fx['merge-gateway.log'].split(/\r?\n/)[row.src - 1]);
  });

  test('the catalog: items, problems, the rows it names, grouped for the side bar', () => {
    const open = ok('open', { logs: [{ name: 'tbox-agent.log', blob: 1 }], catalog: { blob: 2 } }, [fx['tbox-agent.log'], CATALOG]);
    assert.equal(open.catalog.size, 2);
    assert.equal(open.catalog.problems.length, 1);
    assert.match(open.catalog.problems[0], /example-broken/);
    const v = ok('view', {});
    const e7 = v.rows.find((r) => r.id === 'e7');
    const lost = open.catalog.items.find((i) => i.id === 'example-webdriver');
    assert.deepEqual(e7.known, [lost.index]);
    assert.equal(v.groups.known.length, 1);
    assert.equal(v.groups.known[0].title, 'Invented lost session');
    assert.deepEqual(v.groups.known[0].links, ['SWAT-0001']);
    assert.deepEqual(v.groups.known[0].rows.map((r) => r.id), ['e7']);
  });

  test('errors are answers', () => {
    assert.equal(call('nope').code, 'unknown_method');
    assert.equal(call('open', {}).code, 'bad_request');
    assert.equal(call('open', { logs: [{ name: 'x.log', blob: 3 }] }, ['a']).code, 'bad_request');
    assert.equal(call('reading_copy', {}).code, 'bad_request');
    ok('close');
    assert.equal(call('view', {}).code, 'not_open');
    ok('open', { logs: [{ name: 'x.log', blob: 1 }] }, ['one line']);
    assert.equal(call('view', { time: 'local' }).code, 'bad_request');
    assert.equal(call('view', { filters: [{ field: 'nope', raw: 'x' }] }).code, 'bad_request');
    assert.equal(call('children', { ids: ['e999'] }).code, 'bad_request');
    assert.equal(call('children', { ids: [], mode: 'some' }).code, 'bad_request');
  });
});

// ── the same calls in Neovim ──────────────────────────────────────────────────────────────────────────────────────

/** The calls both VMs answer: every fixture opened, viewed in each time mode, unfolded two levels; a merge with a catalog. */
function scenario() {
  const calls = [{ method: 'reading_copy', params: { name: 'device.log', blob: 1 }, blobs: [b.fixture] }];
  for (const [name, text] of Object.entries(fx).sort()) {
    calls.push({ method: 'open', params: { logs: [{ name, blob: 1 }], catalog: { blob: 2 } }, blobs: [text, CATALOG] });
    calls.push({ method: 'view', params: {}, unfold: 2 });
    calls.push({ method: 'view', params: { time: 'utc', repeats: false } });
    calls.push({ method: 'view', params: { time: 'relative', filters: [{ field: 'text', raw: '!/^%s*$/' }] } });
    calls.push({ method: 'children', params: { ids: [], mode: 'all' } });
    calls.push({ method: 'view', params: {}, unfold: 1 });
    calls.push({ method: 'children', params: { ids: [], mode: 'labelled' } });
  }
  calls.push({
    method: 'open',
    params: { logs: [{ name: 'merge-fileservice.log', blob: 1 }, { name: 'merge-gateway.log', blob: 2 }] },
    blobs: [fx['merge-fileservice.log'], fx['merge-gateway.log']],
  });
  calls.push({ method: 'view', params: { time: 'utc' }, unfold: 1 });
  calls.push({ method: 'original', params: { from: 1, to: 3, file: 2 } });
  return calls;
}

/**
 * Run the scenario with `door(method, request, blobs) -> raw answer`: a `view` with `unfold` asks for the children of
 * its expandable rows, `unfold` levels deep. Answers in order, decoded.
 */
function runScenario(door) {
  const out = [];
  for (const c of scenario()) {
    const ans = JSON.parse(door(c.method, JSON.stringify({ params: c.params }), c.blobs ?? []));
    out.push(ans);
    let ids = c.unfold ? list(ans.rows).filter((r) => r.expandable).map((r) => r.id) : [];
    for (let level = 0; level < (c.unfold ?? 0) && ids.length; level++) {
      const kids = JSON.parse(door('children', JSON.stringify({ params: { ids } }), []));
      out.push(kids);
      ids = list(kids.nodes).flatMap((n) => list(n.children).filter((k) => k.expandable).map((k) => k.id));
    }
  }
  return out;
}

/** An empty JSON object and an empty array are the same table in Lua: the encoders of the VMs may write either. */
function plain(v) {
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0) return [];
    return Object.fromEntries(keys.map((k) => [k, plain(v[k])]));
  }
  return v;
}

function nvim() {
  try {
    execFileSync('nvim', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('wasmoon and Neovim give the same answers', () => {
  const compare = process.env.CASEDESK_WEB_COMPARE === '1';
  const have = nvim();
  test('every fixture, each view, unfolded, the catalog, a merge', { skip: !have && !compare && 'nvim is not on PATH' }, () => {
    assert.ok(have, 'CASEDESK_WEB_COMPARE=1 needs nvim on PATH');
    // the calls of the web side, recorded: Neovim answers the same ones in the same order (which children are asked
    // for depends on the answers before)
    const asked = [];
    const fromWeb = [];
    runScenario((m, req, blobs) => {
      const r = engine.call(m, req, blobs);
      assert.equal(r.code, null, r.text);
      asked.push({ m, req, blobs });
      fromWeb.push(r.text);
      return r.text;
    });
    const dir = mkdtempSync(join(tmpdir(), 'casedesk-web-'));
    try {
      const lua = join(dir, 'lua');
      for (const [name, source] of Object.entries(b.modules)) {
        const file = join(lua, ...name.split('.')) + '.lua';
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, source);
      }
      const blobFiles = [];
      const calls = asked.map(({ m, req, blobs }) => ({
        m,
        req,
        blobs: blobs.map((text) => {
          const f = join(dir, `blob${blobFiles.length + 1}.txt`);
          writeFileSync(f, text);
          blobFiles.push(f);
          return f.replaceAll('\\', '/');
        }),
      }));
      writeFileSync(join(dir, 'calls.json'), JSON.stringify(calls));
      const script = join(dir, 'door.lua');
      writeFileSync(
        script,
        [
          'local dir = _G.arg[1]',
          'package.path = dir .. "/lua/?.lua;" .. dir .. "/lua/?/init.lua;" .. package.path',
          'require("casedesk.web.vim_shim").install()',
          'local door = require("casedesk_web").door',
          'local function read(p) local f = assert(io.open(p, "rb")); local t = f:read("*a"); f:close(); return t end',
          'local calls = vim.json.decode(read(dir .. "/calls.json"))',
          'local out = {}',
          'for i, c in ipairs(calls) do',
          '  local blobs = {}',
          '  for k, p in ipairs(c.blobs) do blobs[k] = read(p) end',
          '  local raw = door(c.m, c.req, unpack(blobs))',
          '  out[i] = raw',
          'end',
          'local f = assert(io.open(dir .. "/out.json", "wb")); f:write(vim.json.encode(out)); f:close()',
        ].join('\n'),
      );
      execFileSync('nvim', ['--clean', '--headless', '-n', '-i', 'NONE', '-l', script, dir.replaceAll('\\', '/')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      const raw = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
      assert.equal(raw.length, fromWeb.length);
      for (let i = 0; i < raw.length; i++) {
        const nl = raw[i].indexOf('\n');
        assert.equal(raw[i].slice(0, nl), '', `call ${i} (${asked[i].m}) failed in Neovim: ${raw[i]}`);
        const web = JSON.parse(fromWeb[i].slice(fromWeb[i].indexOf('\n') + 1));
        assert.deepEqual(plain(JSON.parse(raw[i].slice(nl + 1))), plain(web), `call ${i}: ${asked[i].m} ${asked[i].req}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
