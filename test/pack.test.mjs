// The pages as the build makes them: the committed files are the build of these sources, the shell loads nothing, the
// policy forbids every request, every part is there; the bundle holds what the core needs and the shim knows every
// `vim.*` name the bundled modules use.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { LuaFactory } from 'wasmoon';
import { CSP_WASM_WORKER, verify, verifyShell } from 'appkit-web/pack';
import { bundle, moduleName, root, vimNames } from '../build/bundle.mjs';
import { APP_PART_IDS, APP_SCRIPTS, classic, PAGES, PART_IDS, pages, sums, iconLinks } from '../build/pack.mjs';
import { WebEngine } from '../src/engine.js';

const built = await pages();

describe('the pages', () => {
  test('the files in the repository are the build of these sources (run "pnpm build")', () => {
    for (const name of PAGES) assert.ok(readFileSync(join(root, name), 'utf8') === built[name], `${name} is out of date`);
    assert.equal(readFileSync(join(root, 'SHA256SUMS'), 'utf8'), sums(built));
  });

  test('the same sources give the same file', async () => {
    const again = await pages();
    for (const name of PAGES) assert.ok(again[name] === built[name], name);
  });

  test('engine-check.html: a shell that loads nothing, the policy of an engine page, every part once', () => {
    const html = built['engine-check.html'];
    assert.deepEqual(verifyShell(html, { partIds: PART_IDS }), []);
    assert.ok(html.includes(`content="${CSP_WASM_WORKER}"`));
    assert.match(CSP_WASM_WORKER, /connect-src 'none'/);
    for (const id of PART_IDS) {
      assert.equal(html.split(`<script id="${id}" type="application/octet-stream">`).length, 2, id);
    }
  });

  test('casedesk.html carries its icon for main.js: the SVG for the tab, the PNG for a page installed from the browser', () => {
    const html = built['casedesk.html'];
    const page = JSON.parse(html.match(/const PAGE = (\{.*?\});\n/)[1]);
    const [svg, png] = page.icons;
    assert.equal(svg.type, 'image/svg+xml');
    assert.equal(decodeURIComponent(svg.href.replace('data:image/svg+xml,', '')), readFileSync(join(root, 'src', 'app', 'favicon.svg'), 'utf8').trim());
    assert.deepEqual([png.type, png.sizes], ['image/png', '192x192']);
    assert.deepEqual(Buffer.from(png.href.replace('data:image/png;base64,', ''), 'base64'), readFileSync(join(root, 'src', 'app', 'icon-192.png')));
    // The kit lets no href into the markup: the links come from the script, the shell still loads nothing.
    assert.deepEqual(verifyShell(html, { partIds: APP_PART_IDS }), []);
  });

  test('iconLinks makes data: URLs only, and the namespace of the SVG is no URL in the page', () => {
    const links = iconLinks('<svg xmlns="http://www.w3.org/2000/svg"/>\n', Buffer.from([1, 2]));
    assert.ok(links.every((l) => l.href.startsWith('data:')));
    assert.doesNotMatch(links[0].href, /http:\/\//);
    assert.equal(links[1].href, 'data:image/png;base64,AQI=');
  });

  test('casedesk.html: a shell that loads nothing, the policy of an engine page, the three engine parts', () => {
    const html = built['casedesk.html'];
    assert.deepEqual(verifyShell(html, { partIds: APP_PART_IDS }), []);
    assert.ok(html.includes(`content="${CSP_WASM_WORKER}"`));
    for (const id of APP_PART_IDS) {
      assert.equal(html.split(`<script id="${id}" type="application/octet-stream">`).length, 2, id);
    }
    // no test log in the page: its logs come from the folder picked
    assert.ok(!html.includes('<script id="fixture"'));
    // the page keeps its handles in the one database of casedesk-web
    assert.match(html, /idbKeyValue\(indexedDB, 'casedesk-web'\)/);
  });

  test('probe.html: no URL but the one of its CSP test, a policy that forbids requests', () => {
    const html = built['probe.html'];
    assert.deepEqual(verify(html, { allowUrls: ['https://example.invalid/'] }), []);
    assert.notDeepEqual(verify(html), [], 'without the allowance its CSP test address is refused');
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /indexedDB\.open\("casedesk-web", 1\)/);
  });

  test('every source that goes into a page is checked out with LF on every machine', () => {
    const inputs = [
      'probe/probe.src.html',
      'src/engine-check.css',
      'src/engine-check.js',
      'src/engine.js',
      'src/client.js',
      'src/app/util.js',
      'src/app/main.js',
      'src/app/app.css',
      'src/worker.js',
      'src/casedesk_web.lua',
      'engine.lock',
    ];
    const out = execFileSync('git', ['-C', root, 'check-attr', 'eol', 'text', '--', ...inputs], { encoding: 'utf8' });
    for (const file of inputs) {
      assert.match(out, new RegExp(`^${file.replace(/[.]/g, '\\.')}: eol: lf$`, 'm'), file);
    }
    // and the pages themselves are never converted
    const pagesOut = execFileSync('git', ['-C', root, 'check-attr', 'text', '--', ...PAGES, 'SHA256SUMS'], { encoding: 'utf8' });
    for (const file of [...PAGES, 'SHA256SUMS']) assert.match(pagesOut, new RegExp(`^${file.replace(/[.]/g, '\\.')}: text: unset$`, 'm'));
  });

  test('a page shell that loads a file is refused', () => {
    const bad = built['engine-check.html'].replace('<div id="app"></div>', '<div id="app"></div><img src="x.png">');
    assert.notDeepEqual(verifyShell(bad, { partIds: PART_IDS }), []);
  });
});

describe('classic', () => {
  test('drops imports and export keywords', () => {
    const out = classic("import { a } from './a.js';\nimport {\n  b,\n} from 'b';\nexport const x = 1;\nexport function f() {}\n");
    assert.equal(out.trim(), 'const x = 1;\nfunction f() {}');
  });
  test('refuses what is left', () => {
    assert.throws(() => classic('export * from "x";\n'), /import or export is left/);
  });
});

describe('the bundle', () => {
  let b;
  before(async () => {
    b = await bundle();
  });

  test('the entry and the shim of the core, the view modules and the door', () => {
    assert.equal(b.entry, 'casedesk.web.api');
    assert.equal(b.shim, 'casedesk.web.vim_shim');
    for (const name of [b.entry, b.shim, 'casedesk_web', 'casedesk.logview.view.clock', 'casedesk.logview.view.filter', 'casedesk.logview.view.nodes']) {
      assert.ok(b.modules[name], name);
    }
  });

  test('everything the view modules require is in the bundle', () => {
    for (const [mod, requires] of Object.entries(b.viewRequires)) {
      for (const r of requires) assert.ok(b.modules[r], `${mod} requires ${r}`);
    }
  });

  test('the scripts of casedesk.html are there and become one classic script', () => {
    for (const p of APP_SCRIPTS) assert.doesNotThrow(() => classic(readFileSync(join(root, ...p), 'utf8')), p.join('/'));
  });

  test('module names', () => {
    assert.equal(moduleName('lua/lib/lua/xml/init.lua'), 'lib.lua.xml');
    assert.equal(moduleName('lua/casedesk/logview/core/doc.lua'), 'casedesk.logview.core.doc');
    assert.equal(moduleName('README.md'), null);
  });

  test('holds the built-in formats the register requires by name', () => {
    const registry = b.modules['casedesk.logview.core.registry'];
    const named = [...registry.matchAll(/"(casedesk\.logview\.formats\.[a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(named.length >= 5);
    for (const name of named) assert.ok(b.modules[name], name);
  });

  test('every vim.* name the modules use is in the shim', async () => {
    const used = new Set();
    // the core's own shim defines its names, it does not use them; the filter's prompt (vim.ui.input) is never called
    // here, the page asks for a filter itself
    const allowed = new Set(['casedesk.logview.view.filter vim.ui.input']);
    for (const [mod, source] of Object.entries(b.modules)) {
      if (mod === b.shim) continue;
      for (const n of vimNames(source)) if (!allowed.has(`${mod} ${n}`)) used.add(n);
    }
    const engine = await WebEngine.create({ factory: new LuaFactory(), bundle: b });
    try {
      const missing = [];
      for (const name of used) {
        // vim.api and the other editor tables are there and raise when called: the core may not use them
        if (/^vim\.(api|ui|keymap|cmd|system)\b/.test(name)) {
          missing.push(name + ' (editor only)');
          continue;
        }
        engine.lua.doStringSync(`__probe = ${name} ~= nil`);
        if (!engine.lua.global.get('__probe')) missing.push(name);
      }
      assert.deepEqual(missing, []);
    } finally {
      engine.close();
    }
  });
});
