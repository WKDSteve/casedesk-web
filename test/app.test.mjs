// The parts of casedesk.html that do not need a browser (src/app/util.js). Which extensions are logs and how a
// file's bytes become text the Lua core answers; test/engine.test.mjs checks those through the door.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileKind, formatNumber, formatSize, isLogFile, listTree, pageLocale, KeyReader, keyName, knownRefs, linkKind, listLogs, pieces } from '../src/app/util.js';

/** Extensions as the door's `logfiles` answers them (the list itself is the core's, checked in engine.test.mjs). */
const EXT = ['csv', 'json', 'jsonl', 'log', 'ndjson', 'out', 'txt', 'xml'];

describe('which files are logs', () => {
  test('by extension, no redacted copy', () => {
    assert.ok(isLogFile('device.log', EXT));
    assert.ok(isLogFile('sub/Server.TXT', EXT));
    assert.ok(isLogFile('events.ndjson', EXT));
    assert.ok(!isLogFile('device.redacted.log', EXT));
    assert.ok(!isLogFile('screen.png', EXT));
    assert.ok(!isLogFile('notes.ocr.md', EXT));
    assert.ok(!isLogFile('noext', EXT));
    assert.ok(!isLogFile('device.log', ['txt']));
  });

  test('listLogs walks the folders, sorted by path', async () => {
    const file = (name) => ({ kind: 'file', name });
    const dir = (name, kids) => ({
      kind: 'directory',
      name,
      async *values() {
        yield* kids;
      },
    });
    const root = dir('assets', [file('b.log'), dir('sub', [file('a.txt'), file('x.png')]), file('a.redacted.log'), file('a.log')]);
    assert.deepEqual((await listLogs(root, EXT)).map((l) => l.path), ['a.log', 'b.log', 'sub/a.txt']);
    assert.deepEqual((await listLogs(root, EXT, 0)).map((l) => l.path), ['a.log', 'b.log']);
  });
});

describe('pieces', () => {
  test('byte spans over multi-byte text', () => {
    // "→" is three bytes: the span of "Scan" starts after it
    const label = '→ "Scan" #scan';
    assert.deepEqual(pieces(label, [[4, 10, 'CaselogText'], [11, 16, 'CaselogId']]), [
      { text: '→ ', group: null },
      { text: '"Scan"', group: 'CaselogText' },
      { text: ' ', group: null },
      { text: '#scan', group: 'CaselogId' },
    ]);
  });
  test('no spans, spans out of range, overlapping (the later wins)', () => {
    assert.deepEqual(pieces('abc', []), [{ text: 'abc', group: null }]);
    assert.deepEqual(pieces('abc', [[1, 99, 'X']]), [
      { text: 'a', group: null },
      { text: 'bc', group: 'X' },
    ]);
    assert.deepEqual(pieces('abcd', [[0, 4, 'A'], [1, 2, 'B']]), [
      { text: 'a', group: 'A' },
      { text: 'b', group: 'B' },
      { text: 'cd', group: 'A' },
    ]);
  });
  test('a span that cuts a character keeps the character whole', () => {
    assert.deepEqual(pieces('ä', [[0, 1, 'A']]), [{ text: 'ä', group: 'A' }]);
  });
});

describe('keys as Neovim reads them', () => {
  test('sequences, prefixes, a wrong second key starts over', () => {
    const k = new KeyReader();
    assert.deepEqual(k.feed(']'), { kind: 'pending' });
    assert.deepEqual(k.feed('e'), { kind: 'action', action: 'next_error' });
    assert.deepEqual(k.feed('z'), { kind: 'pending' });
    assert.deepEqual(k.feed('R'), { kind: 'action', action: 'open_all' });
    assert.deepEqual(k.feed('j'), { kind: 'action', action: 'down' });
    assert.deepEqual(k.feed('G'), { kind: 'action', action: 'last' });
    assert.deepEqual(k.feed('g'), { kind: 'pending' });
    assert.deepEqual(k.feed('g'), { kind: 'action', action: 'first' });
    assert.deepEqual(k.feed('<CR>'), { kind: 'action', action: 'toggle' });
    // `g` then `j`: no `gj`, so `j` alone counts
    k.feed('g');
    assert.deepEqual(k.feed('j'), { kind: 'action', action: 'down' });
    assert.deepEqual(k.feed('x'), { kind: 'none' });
    k.feed('t');
    k.reset();
    assert.deepEqual(k.feed('z'), { kind: 'pending' });
  });
  test('key names of keyboard events', () => {
    assert.equal(keyName({ key: 'Enter' }), '<CR>');
    assert.equal(keyName({ key: 'G', shiftKey: true }), 'G');
    assert.equal(keyName({ key: 'd', ctrlKey: true }), '<C-d>');
    assert.equal(keyName({ key: 'Shift' }), null);
    assert.equal(keyName({ key: 'e', altKey: true }), null);
    assert.equal(keyName({ key: 'F5' }), null);
  });
});

test('catalog links: URL, case, reference', () => {
  assert.deepEqual(linkKind('https://example.invalid/kb/1'), { kind: 'url', text: 'https://example.invalid/kb/1', href: 'https://example.invalid/kb/1' });
  assert.deepEqual(linkKind('case:4711'), { kind: 'case', text: '4711' });
  assert.deepEqual(linkKind('KB0012345'), { kind: 'ref', text: 'KB0012345' });
  assert.deepEqual(linkKind('javascript:alert(1)'), { kind: 'ref', text: 'javascript:alert(1)' });
});

test('catalog task and ticket: the task by its id, the ticket as a link or text', () => {
  assert.deepEqual(knownRefs({ task: 'casedesk.nvim/fix-x', ticket: 'TOSCA-00001' }), [
    { label: 'Task', kind: 'ref', text: 'casedesk.nvim/fix-x' },
    { label: 'Ticket', kind: 'ref', text: 'TOSCA-00001' },
  ]);
  assert.deepEqual(knownRefs({ ticket: 'https://example.invalid/browse/T-1' }), [
    { label: 'Ticket', kind: 'url', text: 'https://example.invalid/browse/T-1', href: 'https://example.invalid/browse/T-1' },
  ]);
  assert.deepEqual(knownRefs({ title: 'no refs' }), []);
});

describe('numbers and sizes', () => {
  test('are written as the language of the page writes them, not with a fixed point', () => {
    assert.equal(formatNumber(12345, 'de'), '12.345');
    assert.equal(formatNumber(12345, 'en'), '12,345');
    assert.equal(formatSize(1234567, 'de'), '1,2 MB');
    assert.equal(formatSize(1234567, 'en'), '1.2 MB');
    assert.equal(formatSize(1536, 'de'), '1,5 kB');
    assert.equal(formatSize(1023, 'de'), '1.023 B');
    assert.equal(formatSize(0, 'de'), '0 B');
  });
  test('the language is the one of the markup, German without one', () => {
    assert.equal(pageLocale({ documentElement: { lang: 'en' } }), 'en');
    assert.equal(pageLocale({ documentElement: { lang: '' } }), 'de');
    assert.equal(pageLocale(null), 'de');
  });
});

describe('the asset view', () => {
  test('fileKind: what is shown, what is only a copy', () => {
    assert.deepEqual(fileKind('screen.PNG'), { kind: 'image', mime: 'image/png', ext: 'png' });
    assert.equal(fileKind('01_architecture.svg').mime, 'image/svg+xml');
    assert.equal(fileKind('ToscaSupportInfo.txt').kind, 'text');
    assert.equal(fileKind('Error Details.docx').kind, 'office');
    assert.equal(fileKind('AnalysisReport(EditCase)_1.pdf').kind, 'pdf');
    assert.equal(fileKind('trace.zip').kind, 'archive');
    assert.equal(fileKind('noext').kind, 'other');
    // a name that is a key of Object.prototype is no type
    assert.equal(fileKind('x.constructor').kind, 'other');
  });

  test('listTree: folders before their files, numbers by value, no reading', async () => {
    const file = (name) => ({ kind: 'file', name });
    const dir = (name, kids) => ({
      kind: 'directory',
      name,
      async *values() {
        yield* kids;
      },
    });
    const root = dir('assets', [dir('10_x', [file('b.png')]), dir('2_x', [file('a.pdf'), dir('sub', [file('z.txt')])]), file('top.log')]);
    const tree = await listTree(root);
    assert.deepEqual(
      tree.map((e) => `${e.depth}:${e.path}`),
      ['0:2_x', '1:2_x/a.pdf', '1:2_x/sub', '2:2_x/sub/z.txt', '0:10_x', '1:10_x/b.png', '0:top.log'],
    );
    assert.equal(tree[0].kind, 'directory');
    assert.equal((await listTree(root, 0)).length, 3);
  });

  test('listTree: names that differ only by an accent keep their own files', async () => {
    const file = (name) => ({ kind: 'file', name });
    const dir = (name, kids) => ({
      kind: 'directory',
      name,
      async *values() {
        yield* kids;
      },
    });
    const tree = await listTree(dir('r', [dir('résumé', [file('y')]), dir('resume', [file('x')])]));
    const paths = tree.map((e) => e.path);
    // each folder is followed by its own file, never by the other's
    assert.equal(paths.indexOf('resume/x'), paths.indexOf('resume') + 1);
    assert.equal(paths.indexOf('résumé/y'), paths.indexOf('résumé') + 1);
  });
});
