// The parts of casedesk.html that do not need a browser (src/app/util.js), and the two copies this repository holds of
// casedesk.nvim's lua/casedesk/logs.lua (not part of the pure core): the words of the levels and the log extensions.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { checkout, readLock, root, tiersSource } from '../build/bundle.mjs';
import { decodeLog, isLogFile, KeyReader, keyName, knownRefs, linkKind, listLogs, LOG_EXTENSIONS, pieces } from '../src/app/util.js';

const squash = (s) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, '');

describe('copies of casedesk.nvim at the pinned commit', () => {
  test('TIERS of the door equals logs.TIERS', () => {
    const door = readFileSync(join(root, 'src', 'casedesk_web.lua'), 'utf8');
    const own = door.match(/\nlocal TIERS = (\{[\s\S]*?\n\})/);
    assert.ok(own, 'the door has no "local TIERS = {...}"');
    assert.equal(squash(own[1]), squash(tiersSource()));
  });

  test('LOG_EXTENSIONS equals logs.EXTENSIONS', () => {
    const lock = readLock();
    const text = execFileSync('git', ['-C', checkout('CASEDESK_NVIM_DIR', 'casedesk.nvim'), 'show', `${lock.casedesk_commit}:lua/casedesk/logs.lua`], { encoding: 'utf8' });
    const block = text.match(/\nM\.EXTENSIONS = \{([\s\S]*?)\n\}/);
    assert.ok(block);
    const exts = [...block[1].matchAll(/^\s*([a-z0-9]+)\s*=\s*true/gm)].map((m) => m[1]);
    assert.deepEqual([...LOG_EXTENSIONS].sort(), exts.sort());
  });
});

describe('which files are logs', () => {
  test('by extension, no redacted copy', () => {
    assert.ok(isLogFile('device.log'));
    assert.ok(isLogFile('sub/Server.TXT'));
    assert.ok(isLogFile('events.ndjson'));
    assert.ok(!isLogFile('device.redacted.log'));
    assert.ok(!isLogFile('screen.png'));
    assert.ok(!isLogFile('notes.ocr.md'));
    assert.ok(!isLogFile('noext'));
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
    assert.deepEqual((await listLogs(root)).map((l) => l.path), ['a.log', 'b.log', 'sub/a.txt']);
    assert.deepEqual((await listLogs(root, 0)).map((l) => l.path), ['a.log', 'b.log']);
  });
});

describe('decodeLog', () => {
  const enc = (s) => new TextEncoder().encode(s);
  test('UTF-8, with and without BOM', () => {
    assert.deepEqual(decodeLog(enc('Grüße')), { text: 'Grüße', encoding: 'utf-8' });
    assert.deepEqual(decodeLog(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('ä')])), { text: 'ä', encoding: 'utf-8' });
  });
  test('UTF-16 by BOM and by its zero bytes', () => {
    const le = Buffer.from('ab\r\nc', 'utf16le');
    assert.equal(decodeLog(new Uint8Array([0xff, 0xfe, ...le])).text, 'ab\r\nc');
    assert.deepEqual(decodeLog(new Uint8Array(Buffer.from('2026-11-17 line one\n', 'utf16le'))), { text: '2026-11-17 line one\n', encoding: 'utf-16le' });
    const be = Buffer.from('xy', 'utf16le').swap16();
    assert.equal(decodeLog(new Uint8Array([0xfe, 0xff, ...be])).text, 'xy');
  });
  test('not UTF-8: Windows-1252', () => {
    assert.deepEqual(decodeLog(new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65, 0x80])), { text: 'Grüße€', encoding: 'windows-1252' });
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
