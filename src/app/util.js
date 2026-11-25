// What the reading copy page needs that has nothing to do with the screen: which files of a case are logs, a label's
// byte spans as pieces of text, the keys as Neovim reads them. Plain functions, so that Node tests them
// (test/app.test.mjs) and build/pack.mjs puts them into the page as they are (`export` dropped). Which extensions
// are logs, and how a file's bytes become text, the Lua core answers (door `logfiles`, and `open` reads the bytes).

/** The folder of a case the logs are in (`config.assets_dirname`). */
export const ASSETS = 'assets';

/** The folder of a case's drawings, below `Research/` (casedesk.nvim: `Research/Diagrams/Diagrams.md`). */
export const DIAGRAMS_DIR = 'Diagrams';

/** Largest file the page reads (`casedesk.web.api.MAX_TEXT`). */
export const MAX_LOG_BYTES = 64 * 1024 * 1024;

/**
 * Whether `path` (`/`-separated, below `assets/`) is offered as a log: one of `extensions` (door `logfiles`), no
 * redacted copy.
 * @param {string} path
 * @param {string[]} extensions
 */
export function isLogFile(path, extensions) {
  const name = String(path).split('/').at(-1) ?? '';
  if (/\.redacted\.\w+$/i.test(name)) return false;
  const ext = (name.match(/\.(\w+)$/)?.[1] ?? '').toLowerCase();
  return extensions.includes(ext);
}

/**
 * The log files under a folder handle (`values()` of the File System Access API), path relative to it, sorted like
 * `logs.candidates` (by path). Folders deeper than `maxDepth` are not walked.
 * @param {{ values(): AsyncIterable<any> }} dir
 * @param {string[]} extensions  door `logfiles`
 * @returns {Promise<{ path: string, handle: any }[]>}
 */
export async function listLogs(dir, extensions, maxDepth = 8) {
  const out = [];
  const walk = async (d, prefix, depth) => {
    for await (const h of d.values()) {
      const path = prefix ? `${prefix}/${h.name}` : h.name;
      if (h.kind === 'directory') {
        if (depth < maxDepth) await walk(h, path, depth + 1);
      } else if (isLogFile(path, extensions)) {
        out.push({ path, handle: h });
      }
    }
  };
  await walk(dir, '', 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Biggest picture the asset view decodes. */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** How much of a text file the asset view shows (the first bytes; a log has its own reading copy). */
export const MAX_PREVIEW_TEXT = 512 * 1024;

const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};
const TEXT_TYPES = new Set(['txt', 'md', 'log', 'out', 'json', 'jsonl', 'ndjson', 'xml', 'csv', 'tsv', 'conf', 'ini', 'yaml', 'yml', 'lua', 'ps1', 'bat', 'sql', 'html', 'htm']);
const OFFICE_TYPES = new Set(['doc', 'docx', 'dot', 'dotx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'msg', 'eml']);
const ARCHIVE_TYPES = new Set(['zip', 'gz', '7z', 'tar', 'tgz', 'rar', 'cab']);

/**
 * What the asset view does with a file, by its name: `image` (shown as a picture, an SVG too, always through an
 * `<img>` so that it can run no script), `text` (its first bytes), `pdf`, `office`, `archive` (only a copy to open
 * with the system app) or `other`. `mime` is the type a picture is shown with.
 * @param {string} name
 * @returns {{ kind: 'image' | 'text' | 'pdf' | 'office' | 'archive' | 'other', mime: string | null, ext: string }}
 */
export function fileKind(name) {
  const ext = (String(name).match(/\.(\w+)$/)?.[1] ?? '').toLowerCase();
  if (Object.hasOwn(IMAGE_TYPES, ext)) return { kind: 'image', mime: IMAGE_TYPES[ext], ext };
  if (TEXT_TYPES.has(ext)) return { kind: 'text', mime: null, ext };
  if (ext === 'pdf') return { kind: 'pdf', mime: 'application/pdf', ext };
  if (OFFICE_TYPES.has(ext)) return { kind: 'office', mime: null, ext };
  if (ARCHIVE_TYPES.has(ext)) return { kind: 'archive', mime: null, ext };
  return { kind: 'other', mime: null, ext };
}

const pathCollator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/**
 * Every folder and file under a folder handle, as flat entries sorted by path (numbers by value, so `2_x` comes
 * before `10_x`); a folder comes before what is in it. Only handles: nothing is read. Folders deeper than `maxDepth`
 * are not walked.
 * @param {{ values(): AsyncIterable<any> }} dir
 * @returns {Promise<{ path: string, name: string, kind: 'file' | 'directory', depth: number, handle: any }[]>}
 */
export async function listTree(dir, maxDepth = 8) {
  const out = [];
  const walk = async (d, prefix, depth) => {
    for await (const h of d.values()) {
      const path = prefix ? `${prefix}/${h.name}` : h.name;
      out.push({ path, name: h.name, kind: h.kind === 'directory' ? 'directory' : 'file', depth, handle: h });
      if (h.kind === 'directory' && depth < maxDepth) await walk(h, path, depth + 1);
    }
  };
  await walk(dir, '', 0);
  // segment by segment: `a/b` follows `a`, and `a b` does not slip in between
  return out.sort((x, y) => {
    const a = x.path.split('/');
    const b = y.path.split('/');
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = pathCollator.compare(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  });
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

/** The language of the page: what its markup says, German (the language of the text) when it says nothing. */
export function pageLocale(doc = globalThis.document) {
  return doc?.documentElement?.lang || 'de';
}

const numberFormats = new Map();

/** A number as people of `locale` write it: `12345` -> `12.345` in German. */
export function formatNumber(n, locale = 'de', options) {
  const key = locale + JSON.stringify(options ?? {});
  let f = numberFormats.get(key);
  if (!f) numberFormats.set(key, (f = new Intl.NumberFormat(locale, options)));
  return f.format(n);
}

/** `1234567` -> `1,2 MB` (German), `1.2 MB` (English). */
export function formatSize(n, locale = 'de') {
  const one = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  if (n < 1024) return `${formatNumber(n, locale)} B`;
  if (n < 1024 * 1024) return `${formatNumber(n / 1024, locale, one)} kB`;
  return `${formatNumber(n / 1024 / 1024, locale, one)} MB`;
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
