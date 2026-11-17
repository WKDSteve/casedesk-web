// What the reading copy page needs that has nothing to do with the screen: which files of a case are logs, how a file's
// bytes become text, a label's byte spans as pieces of text, the keys as Neovim reads them. Plain functions, so that
// Node tests them (test/app.test.mjs) and build/pack.mjs puts them into the page as they are (`export` dropped).

/**
 * File extensions offered as logs: a copy of `M.EXTENSIONS` of casedesk.nvim's `lua/casedesk/logs.lua` (not part of the
 * pure core, it lists files); test/app.test.mjs checks it against the pinned commit.
 */
export const LOG_EXTENSIONS = ['log', 'txt', 'out', 'ndjson', 'jsonl', 'json', 'xml', 'csv'];

/** The folder of a case the logs are in (`config.assets_dirname`). */
export const ASSETS = 'assets';

/** Largest file the page reads (`casedesk.web.api.MAX_TEXT`). */
export const MAX_LOG_BYTES = 64 * 1024 * 1024;

/** Whether `path` (`/`-separated, below `assets/`) is offered as a log: a log extension, no redacted copy. */
export function isLogFile(path) {
  const name = String(path).split('/').at(-1) ?? '';
  if (/\.redacted\.\w+$/i.test(name)) return false;
  const ext = (name.match(/\.(\w+)$/)?.[1] ?? '').toLowerCase();
  return LOG_EXTENSIONS.includes(ext);
}

/**
 * The log files under a folder handle (`values()` of the File System Access API), path relative to it, sorted like
 * `logs.candidates` (by path). Folders deeper than `maxDepth` are not walked.
 * @param {{ values(): AsyncIterable<any> }} dir
 * @returns {Promise<{ path: string, handle: any }[]>}
 */
export async function listLogs(dir, maxDepth = 8) {
  const out = [];
  const walk = async (d, prefix, depth) => {
    for await (const h of d.values()) {
      const path = prefix ? `${prefix}/${h.name}` : h.name;
      if (h.kind === 'directory') {
        if (depth < maxDepth) await walk(h, path, depth + 1);
      } else if (isLogFile(path)) {
        out.push({ path, handle: h });
      }
    }
  };
  await walk(dir, '', 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The child folder `name` of a folder handle, or null. */
export async function childFolder(dir, name) {
  for await (const h of dir.values()) if (h.kind === 'directory' && h.name === name) return h;
  return null;
}

/** The child file `name` of a folder handle, or null. */
export async function childFile(dir, name) {
  for await (const h of dir.values()) if (h.kind === 'file' && h.name === name) return h;
  return null;
}

/** Which byte order a text without a BOM in UTF-16 has, from the zero bytes of its start; null when it is not UTF-16. */
function utf16Order(bytes) {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 4) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) even++;
    if (bytes[i + 1] === 0) odd++;
  }
  const half = n / 2;
  if (odd > half * 0.3 && even < half * 0.05) return 'utf-16le';
  if (even > half * 0.3 && odd < half * 0.05) return 'utf-16be';
  return null;
}

/**
 * A file's bytes as text, as casedesk.nvim's `logs.to_utf8` reads a log: UTF-8 (BOM dropped), UTF-16 by its BOM or by
 * its zero bytes, else Windows-1252 (logs of Windows tools that are not UTF-8).
 * @param {Uint8Array} bytes
 * @returns {{ text: string, encoding: string }}
 */
export function decodeLog(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  const order = utf16Order(bytes);
  if (order) return { text: new TextDecoder(order).decode(bytes), encoding: order };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/**
 * A label and its spans (byte ranges of its UTF-8 form, 0-based, end exclusive, with a group name, as casedesk.nvim's
 * view writes them) as pieces of text with the group of each: `[{ text, group }]`, `group` null where no span is. A
 * later span wins where two overlap; a span outside the label is cut to it.
 * @param {string} label
 * @param {[number, number, string][]} spans
 * @returns {{ text: string, group: string | null }[]}
 */
export function pieces(label, spans) {
  if (!spans || spans.length === 0) return [{ text: label, group: null }];
  const bytes = new TextEncoder().encode(label);
  const group = new Array(bytes.length).fill(null);
  for (const [from, to, name] of spans) {
    for (let i = Math.max(0, from); i < Math.min(bytes.length, to); i++) group[i] = name;
  }
  const dec = new TextDecoder();
  const out = [];
  let start = 0;
  for (let i = 1; i <= bytes.length; i++) {
    // never cut inside a character: a continuation byte joins the piece before it
    if (i < bytes.length && (group[i] === group[start] || (bytes[i] & 0xc0) === 0x80)) continue;
    out.push({ text: dec.decode(bytes.subarray(start, i)), group: group[start] });
    start = i;
  }
  return out;
}

/** `1234567` -> `1.2 MB`. */
export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The keys of the reading copy, as in casedesk.nvim (`log_view.keys`): action -> key sequences. `j`/`k`/`gg`/`G` move
 * as in Neovim; `<CR>` is Enter.
 */
export const KEYS = {
  toggle: ['<CR>', 'za'],
  open: ['zo'],
  close: ['zc'],
  close_all: ['zM'],
  open_all: ['zR'],
  original: ['gO'],
  next_error: [']e'],
  prev_error: ['[e'],
  next_warn: [']w'],
  prev_warn: ['[w'],
  next_request: [']r'],
  prev_request: ['[r'],
  next_known: [']k'],
  prev_known: ['[k'],
  next_gap: [']g'],
  prev_gap: ['[g'],
  filter: ['gf'],
  filter_pop: ['gF'],
  filter_clear: ['g0'],
  tz: ['tz'],
  repeats: ['gr'],
  mode: ['gs'],
  help: ['g?'],
  down: ['j', '<Down>'],
  up: ['k', '<Up>'],
  first: ['gg', '<Home>'],
  last: ['G', '<End>'],
  page_down: ['<C-d>', '<PageDown>'],
  page_up: ['<C-u>', '<PageUp>'],
};

/** A `KeyboardEvent` as one key of a sequence (`j`, `G`, `<CR>`, `<C-d>`); null for a key that is none (Shift alone). */
export function keyName(ev) {
  const k = ev.key;
  if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return null;
  const special = { Enter: '<CR>', ArrowDown: '<Down>', ArrowUp: '<Up>', Home: '<Home>', End: '<End>', PageDown: '<PageDown>', PageUp: '<PageUp>', Escape: '<Esc>' };
  let name = special[k] ?? (k.length === 1 ? k : null);
  if (name === null) return null;
  if (ev.ctrlKey && k.length === 1) name = `<C-${k.toLowerCase()}>`;
  else if (ev.altKey || ev.metaKey) return null;
  return name;
}

/**
 * Reads key sequences: `feed(key)` answers the action of a complete sequence, `pending` while a prefix of one is typed,
 * `none` for a key that starts no sequence (the prefix typed before is dropped, as Neovim does).
 */
export class KeyReader {
  constructor(keys = KEYS) {
    this.map = new Map();
    for (const [action, seqs] of Object.entries(keys)) for (const s of seqs) this.map.set(s, action);
    this.prefixes = new Set();
    for (const s of this.map.keys()) {
      const parts = splitKeys(s);
      for (let i = 1; i < parts.length; i++) this.prefixes.add(parts.slice(0, i).join(''));
    }
    this.typed = '';
  }

  /** @returns {{ kind: 'action', action: string } | { kind: 'pending' } | { kind: 'none' }} */
  feed(key) {
    const seq = this.typed + key;
    if (this.map.has(seq) && !this.prefixes.has(seq)) {
      this.typed = '';
      return { kind: 'action', action: this.map.get(seq) };
    }
    if (this.prefixes.has(seq)) {
      this.typed = seq;
      return { kind: 'pending' };
    }
    this.typed = '';
    // the key alone may start or be a sequence of its own
    if (seq !== key) return this.feed(key);
    return { kind: 'none' };
  }

  reset() {
    this.typed = '';
  }
}

/** `g<CR>` -> ['g', '<CR>']. */
function splitKeys(s) {
  return s.match(/<[^>]+>|./g) ?? [];
}

/** The groups of the side bar, in their order: key of `view.groups`, title. */
export const GROUPS = [
  ['errors', 'Fehler'],
  ['warnings', 'Warnungen'],
  ['exceptions', 'Exceptions'],
  ['gaps', 'Lücken'],
  ['repeats', 'Wiederholungen'],
  ['known', 'Bekannt'],
];

/** A catalog link as the side bar shows it: a URL opens in a new tab, `case:<nr>` is a case, the rest is text. */
export function linkKind(link) {
  const s = String(link);
  if (/^https?:\/\/[^\s]+$/i.test(s)) return { kind: 'url', text: s, href: s };
  const c = s.match(/^case:(.+)$/i);
  if (c) return { kind: 'case', text: c[1] };
  return { kind: 'ref', text: s };
}

/**
 * The task and the ticket a catalog item names (`task`, `ticket` of log-patterns.md), as the side bar shows them:
 * the task as its id (the browser has no task vault, so no status), the ticket as a link (`linkKind`).
 */
export function knownRefs(item) {
  const out = [];
  if (typeof item?.task === 'string' && item.task) out.push({ label: 'Task', kind: 'ref', text: item.task });
  if (typeof item?.ticket === 'string' && item.ticket) out.push({ label: 'Ticket', ...linkKind(item.ticket) });
  return out;
}
