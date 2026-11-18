// casedesk.html: the reading copy of a case's logs in the browser. A menu bar on top (File / View / Filter / Catalog /
// Settings), the reading copy in the middle, a side bar on the right with the errors, warnings, exceptions, gaps,
// repeats and known messages of the log, each a jump. The keys are those of the reading copy in Neovim.
//
// Every log is parsed, folded, filtered and unfolded by the Lua core of casedesk.nvim in a worker (src/casedesk_web.lua
// is its door); this file only shows what it answers. Nothing of a case goes into the browser's storage: IndexedDB
// `casedesk-web` keeps the handles of the folders used and of the catalog file, localStorage the settings of the view.
//
// build/pack.mjs puts `const PAGE = {...}`, appkit-web's folder.js and folder-input.js, src/client.js and
// src/app/util.js in front of this script.
/* global PAGE */

const SETTINGS_KEY = 'casedesk-web.view';
const CATALOG_KEY = 'catalog';
const DEFAULT_SETTINGS = {
  time: 'original',
  repeats: true,
  mode: 'labelled',
  delta_ms: 250,
  gap_minutes: 5,
  sidebar: true,
  sidebarWidth: 340,
};
const TIME_MODES = [
  ['original', 'Original'],
  ['utc', 'UTC'],
  ['relative', 'Relativ'],
];
const PS_MODES = ['labelled', 'all', 'clickable'];
const FILTER_FIELDS = [
  ['text', 'Text'],
  ['level', 'Level'],
  ['source', 'Quelle'],
  ['corr', 'Korrelations-ID'],
  ['dir', 'Richtung (request/response)'],
];
const QUICK_FILTERS = [
  ['Nur Fehler (error, fatal)', { field: 'level', raw: '/^[ef][ra][rt]/' }],
  ['Fehler und Warnungen', { field: 'level', raw: '/^[efw][ra][rta]/' }],
];
const MAX_OPEN_ALL = 2000;

// ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────

const st = {
  engine: null,
  engineStart: null,
  extensions: null,
  kv: null,
  recent: null,
  settings: loadSettings(),
  folder: null, // { handle, name, caseName, logs: [{ path, handle }], dir }
  open: null, // { paths, summary, files: [{ path, handle }] }
  filters: [],
  timeOverride: null, // 'utc' while a merged view shows UTC without the setting saying so
  catalog: null, // { handle, name, text?, permission }
  rows: [], // top-level nodes of the view
  flat: [], // visible nodes in order
  byId: new Map(),
  cursor: 0,
  groups: null,
  status: null,
  message: '',
  busy: 0,
};

/** The time mode the view shows: the setting, or UTC for a merged view while the setting is the time as written. */
function viewTime() {
  return st.timeOverride ?? st.settings.time;
}

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    const s = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (typeof raw[k] === typeof DEFAULT_SETTINGS[k]) s[k] = raw[k];
    if (!TIME_MODES.some(([m]) => m === s.time)) s.time = DEFAULT_SETTINGS.time;
    if (!PS_MODES.includes(s.mode)) s.mode = DEFAULT_SETTINGS.mode;
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(st.settings));
  } catch {
    // a browser without storage keeps the settings for this visit only
  }
}

// ── DOM helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const $ = (id) => document.getElementById(id);
const errText = (e) => (e && e.name ? `${e.name}: ${e.message}` : String(e));

function say(text) {
  st.message = text;
  renderStatus();
}

/** Run `fn` with the busy marker on; an error becomes the status message. */
async function busy(fn) {
  st.busy++;
  document.body.dataset.busy = 'true';
  try {
    return await fn();
  } catch (e) {
    say('Fehler: ' + errText(e));
    console.warn(e);
    return undefined;
  } finally {
    st.busy--;
    if (st.busy === 0) delete document.body.dataset.busy;
  }
}

/** The extensions of logs (door `logfiles`), asked once the core runs: a folder chosen before that waits for it. */
async function logExtensions() {
  if (!st.extensions) {
    if (!st.engineStart) throw new Error('der Lua-Kern ist noch nicht gestartet');
    st.engine ??= await st.engineStart;
    st.extensions = list((await door('logfiles')).extensions);
  }
  return st.extensions;
}

/** One call of the door; an error answer throws. */
async function door(method, params, blobs) {
  if (!st.engine) throw new Error('der Lua-Kern ist noch nicht gestartet');
  const r = await st.engine.call(method, params, blobs);
  const doc = JSON.parse(r.text);
  if (r.code) throw new Error(`${r.code}: ${doc.message}`);
  return doc;
}

const list = (x) => (Array.isArray(x) ? x : []);

// ── layout ───────────────────────────────────────────────────────────────────────────────────────────────────────

function layout() {
  const app = $('app');
  app.replaceChildren(
    h(
      'header',
      { class: 'menubar', role: 'menubar', id: 'menubar' },
      menu('file', 'Datei', fileMenu),
      menu('view', 'Ansicht', viewMenu),
      menu('filter', 'Filter', filterMenu),
      menu('catalog', 'Katalog', catalogMenu),
      menu('settings', 'Einstellungen', settingsMenu),
      h('span', { class: 'where', id: 'where' }),
    ),
    h(
      'main',
      { class: 'workspace', id: 'workspace' },
      h('section', { id: 'log', class: 'log', tabindex: '0', role: 'tree', 'aria-label': 'Lesekopie' }),
      h('div', { id: 'splitter', class: 'splitter', role: 'separator', 'aria-orientation': 'vertical' }),
      h('aside', { id: 'sidebar', class: 'sidebar', 'aria-label': 'Treffer' }),
    ),
    h('footer', { id: 'status', class: 'status' }),
    h('dialog', { id: 'dialog', class: 'dialog' }),
  );
  applySidebar();
  splitter();
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.menu')) closeMenus();
  });
}

function applySidebar() {
  const side = $('sidebar');
  side.hidden = !st.settings.sidebar;
  $('splitter').hidden = !st.settings.sidebar;
  side.style.width = st.settings.sidebarWidth + 'px';
}

function splitter() {
  const bar = $('splitter');
  bar.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    bar.setPointerCapture(ev.pointerId);
    const move = (e) => {
      const w = Math.max(200, Math.min(window.innerWidth - 300, window.innerWidth - e.clientX));
      st.settings.sidebarWidth = Math.round(w);
      $('sidebar').style.width = w + 'px';
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      saveSettings();
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });
}

// ── menus ────────────────────────────────────────────────────────────────────────────────────────────────────────

function menu(id, title, build) {
  const panel = h('div', { class: 'menu-panel', role: 'menu', id: `menu-${id}`, hidden: true });
  const button = h(
    'button',
    {
      type: 'button',
      class: 'menu-button',
      id: `menubutton-${id}`,
      'aria-haspopup': 'true',
      'aria-expanded': 'false',
      onclick: (ev) => {
        ev.stopPropagation();
        const isOpen = !panel.hidden;
        closeMenus();
        if (!isOpen) openMenu(id, build);
      },
      onmouseenter: () => {
        if (document.querySelector('.menu-panel:not([hidden])') && panel.hidden) {
          closeMenus();
          openMenu(id, build);
        }
      },
    },
    title,
  );
  return h('div', { class: 'menu', 'data-menu': id }, button, panel);
}

function openMenu(id, build) {
  const panel = $(`menu-${id}`);
  panel.replaceChildren(...build());
  panel.hidden = false;
  $(`menubutton-${id}`).setAttribute('aria-expanded', 'true');
  panel.querySelector('button:not([disabled])')?.focus();
}

function closeMenus() {
  for (const p of document.querySelectorAll('.menu-panel')) p.hidden = true;
  for (const b of document.querySelectorAll('.menu-button')) b.setAttribute('aria-expanded', 'false');
}

/** A menu item: a label, the key beside it, what it does; `check` shows a mark (a radio or a check box). */
function item(label, run, opts = {}) {
  return h(
    'button',
    {
      type: 'button',
      class: 'menu-item' + (opts.check !== undefined ? ' checkable' : ''),
      role: opts.check !== undefined ? 'menuitemcheckbox' : 'menuitem',
      'aria-checked': opts.check !== undefined ? String(Boolean(opts.check)) : undefined,
      disabled: opts.disabled,
      title: opts.title,
      onclick: (ev) => {
        ev.stopPropagation();
        closeMenus();
        run();
      },
    },
    h('span', { class: 'mark' }, opts.check ? '✓' : ''),
    h('span', { class: 'label' }, label),
    h('span', { class: 'key' }, opts.key ?? ''),
  );
}

const sep = () => h('div', { class: 'menu-sep', role: 'separator' });
const note = (text) => h('div', { class: 'menu-note' }, text);

function fileMenu() {
  const out = [item('Fallordner wählen …', () => chooseFolder())];
  const recent = st.recentList ?? [];
  if (recent.length) {
    out.push(sep(), note('Zuletzt benutzt'));
    for (const r of recent) out.push(item(r.name, () => openRecent(r)));
  }
  out.push(
    sep(),
    item('Log wählen …', () => showLogPicker(), { disabled: !st.folder }),
    item('Neu laden', () => reload(), { disabled: !st.open }),
    item('Log schließen', () => closeLog(), { disabled: !st.open }),
    sep(),
    item('Export nach Research/ …', () => {}, {
      disabled: true,
      title: 'Schreiben in den Fallordner kommt mit einer eigenen Stufe',
    }),
  );
  return out;
}

function viewMenu() {
  const s = st.settings;
  return [
    note('Zeit'),
    ...TIME_MODES.map(([m, label]) => item(label, () => setTime(m), { check: viewTime() === m, key: m === viewTime() ? 'tz' : '' })),
    sep(),
    item('Wiederholungen falten', () => toggleRepeats(), { check: s.repeats, key: 'gr' }),
    sep(),
    note('Seitenquelltext'),
    ...PS_MODES.map((m) => item(m, () => setMode(m), { check: s.mode === m, key: m === s.mode ? 'gs' : '' })),
    sep(),
    item('Alles aufklappen', () => openAll(), { key: 'zR', disabled: !st.open }),
    item('Alles zuklappen', () => closeAll(), { key: 'zM', disabled: !st.open }),
    sep(),
    item('Seitenleiste', () => toggleSidebar(), { check: s.sidebar }),
    item('Original zeigen', () => showOriginal(), { key: 'gO', disabled: !st.open }),
    item('Tasten …', () => showHelp(), { key: 'g?' }),
  ];
}

function filterMenu() {
  const out = [item('Filter hinzufügen …', () => showFilterDialog(), { key: 'gf', disabled: !st.open })];
  for (const [label, clause] of QUICK_FILTERS) {
    out.push(item(label, () => addFilter(clause), { disabled: !st.open }));
  }
  out.push(
    sep(),
    item('Letzten Filter zurücknehmen', () => popFilter(), { key: 'gF', disabled: st.filters.length === 0 }),
    item('Alle Filter weg', () => clearFilters(), { key: 'g0', disabled: st.filters.length === 0 }),
  );
  if (st.filters.length) {
    out.push(sep(), note('Aktiv'));
    for (const f of st.filters) out.push(note(`${f.field}: ${f.raw}`));
  }
  return out;
}

function catalogMenu() {
  const c = st.catalog;
  const info = st.open?.summary.catalog;
  const out = [
    item('Katalog-Datei wählen …', () => chooseCatalog()),
    item('Katalog nicht mehr verwenden', () => forgetCatalog(), { disabled: !c }),
    sep(),
    item('Nächste bekannte Meldung', () => jump('next_known'), { key: ']k', disabled: !st.open }),
    item('Vorige bekannte Meldung', () => jump('prev_known'), { key: '[k', disabled: !st.open }),
  ];
  out.push(sep());
  if (!c) out.push(note('Kein Katalog gewählt (WKDBook-Tricentis/Workflow/log-patterns.conf)'));
  else {
    out.push(note(`Katalog: ${c.name}`));
    if (c.permission !== 'granted') out.push(note('Zugriff wird beim nächsten Öffnen eines Logs erfragt'));
    if (info) {
      out.push(note(`${info.size} Einträge, ${info.count} Treffer in diesem Log`));
      if (list(info.problems).length) {
        out.push(item(`${info.problems.length} Probleme im Katalog …`, () => showProblems(info.problems)));
      }
    }
  }
  out.push(item('Als bekannt markieren …', () => {}, { disabled: true, title: 'Katalogeinträge schreiben kommt mit einer eigenen Stufe' }));
  return out;
}

function settingsMenu() {
  return [
    item('Abstände und Lücken …', () => showSettingsDialog()),
    item('Zuletzt benutzte Ordner vergessen', () => forgetRecent(), { disabled: !(st.recentList ?? []).length }),
    item('Startzeile für Chrome …', () => showStartLine()),
    sep(),
    note(`casedesk-web ${PAGE.build} · ${PAGE.engine}`),
    note('Alle lokalen Seiten teilen sich den Ursprung file:// — keine fremden lokalen Seiten in diesem Chrome-Profil öffnen.'),
  ];
}

/**
 * The line that opens this page as its own window (`chrome --app`), for a shortcut made by hand: the page starts
 * nothing itself and writes no shortcut.
 */
function startLine() {
  const chrome = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
  return `"${chrome}" --app="${location.href.split('#')[0]}"`;
}

function showStartLine() {
  const line = h('input', { id: 'start-line', type: 'text', readonly: true, size: '90', value: startLine() });
  const copy = h('button', { type: 'button', class: 'primary', onclick: async () => {
    try {
      await navigator.clipboard.writeText(line.value);
      say('Startzeile kopiert');
    } catch {
      line.select();
      say('Bitte von Hand kopieren (Strg+C)');
    }
  } }, 'Kopieren');
  dialog(
    'Startzeile für Chrome',
    h('div', {},
      h('p', { class: 'hint' }, 'Als Ziel einer Verknüpfung öffnet diese Zeile die Seite in einem eigenen Fenster. Die Seite legt selbst keine Verknüpfung an.'),
      line,
      h('div', { class: 'buttons' }, copy),
    ),
  );
  line.select();
}

// ── folders and logs ─────────────────────────────────────────────────────────────────────────────────────────────

async function refreshRecent() {
  try {
    st.recentList = await st.recent.list();
  } catch {
    st.recentList = [];
  }
}

async function chooseFolder() {
  let handle;
  if (pickerSupport(window) === 'ok') {
    const r = await pickFolder(window, { id: 'casedesk-web', mode: 'read' });
    if (r.kind === 'cancelled') return;
    if (r.kind !== 'picked') return say(`Ordner nicht gewählt: ${r.message}`);
    handle = r.handle;
    await busy(async () => {
      await st.recent.remember(handle, Date.now());
      await refreshRecent();
    });
  } else {
    const r = await pickFolderByInput(document);
    if (r.kind === 'cancelled') return;
    if (r.kind !== 'picked') return say(`Ordner nicht gewählt (${r.kind})`);
    handle = r.folder;
  }
  await useFolder(handle);
}

async function openRecent(r) {
  const p = await grantAccess(r.handle, 'read');
  if (p === 'gone') return say(`${r.name}: der Ordner ist nicht mehr da`);
  if (p !== 'granted') return say(`${r.name}: kein Zugriff erlaubt`);
  await busy(async () => {
    await st.recent.remember(r.handle, Date.now());
    await refreshRecent();
  });
  await useFolder(r.handle);
}

async function forgetRecent() {
  await busy(async () => {
    for (const r of st.recentList ?? []) await st.recent.forget(r.id);
    await refreshRecent();
  });
  if (!st.folder) renderStart();
  say('Die Liste der zuletzt benutzten Ordner ist leer.');
}

/** The case number of a folder: `case` of its `.case.json`, else the folder's name. */
async function caseName(handle) {
  try {
    const f = await childFile(handle, '.case.json');
    if (f) {
      const meta = JSON.parse(new TextDecoder().decode(await (await f.getFile()).arrayBuffer()));
      if (typeof meta.case === 'string' || typeof meta.case === 'number') return String(meta.case);
    }
  } catch {
    // an unreadable sidecar names nothing
  }
  return displayName(handle.name);
}

async function useFolder(handle) {
  await busy(async () => {
    const assets = await childFolder(handle, ASSETS);
    const dir = assets ?? handle;
    const logs = await listLogs(dir, await logExtensions());
    st.folder = { handle, name: displayName(handle.name), caseName: await caseName(handle), logs, assets: Boolean(assets) };
    closeLog(true);
    renderWhere();
    showLogPicker();
  });
}

function showLogPicker() {
  const f = st.folder;
  if (!f) return renderStart();
  const log = $('log');
  const checks = [];
  const rows = f.logs.map((l, i) => {
    const box = h('input', { type: 'checkbox', 'aria-label': `${l.path} zusammenlegen`, dataset: { index: String(i) } });
    checks.push(box);
    return h(
      'tr',
      {},
      h('td', {}, box),
      h('td', {}, h('button', { type: 'button', class: 'link', onclick: () => openLogs([l]) }, l.path)),
      h('td', { class: 'size', dataset: { index: String(i) } }, ''),
    );
  });
  const mergeButton = h(
    'button',
    {
      type: 'button',
      id: 'merge',
      onclick: () => {
        const chosen = checks.filter((c) => c.checked).map((c) => f.logs[Number(c.dataset.index)]);
        if (chosen.length < 2) return say('Zum Zusammenlegen mindestens zwei Logs ankreuzen.');
        openLogs(chosen);
      },
    },
    'Angekreuzte zusammenlegen',
  );
  log.replaceChildren(
    h(
      'div',
      { class: 'picker' },
      h('h1', {}, `Fall ${f.caseName}`),
      h(
        'p',
        { class: 'hint' },
        f.assets
          ? `Logs unter ${ASSETS}/ (${f.logs.length}). Ein Klick öffnet die Lesekopie; mehrere ankreuzen legt sie nach Zeit zusammen.`
          : `Kein Ordner ${ASSETS}/ in ${f.name}: Logs im gewählten Ordner selbst (${f.logs.length}).`,
      ),
      f.logs.length
        ? h('table', { class: 'logs', id: 'logs' }, h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'Log'), h('th', {}, 'Größe'))), h('tbody', {}, rows))
        : h('p', { class: 'hint' }, 'Keine Logs gefunden (Endungen: ' + (st.extensions ?? []).join(', ') + ').'),
      f.logs.length > 1 ? mergeButton : null,
    ),
  );
  renderSidebar();
  // sizes after the list is there: a file's size needs a read of its metadata
  f.logs.forEach(async (l, i) => {
    try {
      const file = await l.handle.getFile();
      const cell = log.querySelector(`td.size[data-index="${i}"]`);
      if (cell) cell.textContent = formatSize(file.size);
    } catch {
      // a file that went away shows no size; opening it says why
    }
  });
}

/**
 * The catalog file's bytes (the core reads them as text), asking again for its permission when it lapsed (inside the
 * click that opens a log).
 */
async function catalogBytes() {
  const c = st.catalog;
  if (!c) return null;
  if (c.handle.queryPermission) {
    let p = await c.handle.queryPermission({ mode: 'read' }).catch(() => 'denied');
    if (p !== 'granted' && c.handle.requestPermission) p = await c.handle.requestPermission({ mode: 'read' }).catch(() => 'denied');
    c.permission = p;
    if (p !== 'granted') {
      say(`Katalog ${c.name}: kein Zugriff, das Log wird ohne Katalog gezeigt`);
      return null;
    }
  }
  try {
    return new Uint8Array(await (await c.handle.getFile()).arrayBuffer());
  } catch (e) {
    say(`Katalog ${c.name} nicht lesbar: ${errText(e)}`);
    return null;
  }
}

async function openLogs(chosen) {
  // the catalog's permission first: a request needs the click that is still running
  const catalog = await catalogBytes();
  await busy(async () => {
    // the bytes as they are: the core reads them as casedesk.nvim reads a log (UTF-16, Windows-1252)
    const files = [];
    for (const l of chosen) {
      const file = await l.handle.getFile();
      if (file.size > MAX_LOG_BYTES) throw new Error(`${l.path}: größer als ${formatSize(MAX_LOG_BYTES)}`);
      files.push(new Uint8Array(await file.arrayBuffer()));
    }
    const params = { logs: chosen.map((l, i) => ({ name: l.path.split('/').at(-1), blob: i + 1 })) };
    const blobs = [...files];
    if (catalog !== null) {
      blobs.push(catalog);
      params.catalog = { blob: blobs.length };
    }
    const t0 = performance.now();
    const summary = await door('open', params, blobs);
    // a merged view starts in UTC (as :Case log merge), without changing the setting
    st.timeOverride = summary.merged && st.settings.time === 'original' ? 'utc' : null;
    st.open = { paths: chosen.map((l) => l.path), files: chosen, summary };
    st.filters = [];
    await refreshView({ keep: false });
    renderWhere();
    say(`${chosen.map((l) => l.path).join(' + ')}: ${summary.entries} Einträge in ${Math.round(performance.now() - t0)} ms`);
    $('log').focus();
  });
}

async function reload() {
  if (st.open) await openLogs(st.open.files);
}

function closeLog(quiet) {
  if (st.open && st.engine) door('close').catch(() => {});
  st.open = null;
  st.rows = [];
  st.flat = [];
  st.byId = new Map();
  st.groups = null;
  st.status = null;
  st.filters = [];
  renderWhere();
  renderStatus();
  if (!quiet) showLogPicker();
}

// ── catalog ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function loadCatalogHandle() {
  try {
    const stored = await st.kv.get(CATALOG_KEY);
    const handle = stored?.handle;
    if (handle && handle.kind === 'file' && typeof handle.getFile === 'function') {
      const permission = handle.queryPermission ? await handle.queryPermission({ mode: 'read' }).catch(() => 'denied') : 'granted';
      st.catalog = { handle, name: displayName(handle.name), permission };
    }
  } catch {
    // no catalog kept
  }
}

async function chooseCatalog() {
  let handle;
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      [handle] = await window.showOpenFilePicker({ id: 'casedesk-web-catalog', multiple: false });
    } catch (e) {
      if (e?.name === 'AbortError') return;
      return say(`Katalog nicht gewählt: ${errText(e)}`);
    }
    await busy(() => st.kv.put(CATALOG_KEY, { handle }));
  } else {
    handle = await new Promise((resolve) => {
      const input = h('input', { type: 'file', hidden: true });
      input.addEventListener('change', () => resolve(input.files?.[0] ? { kind: 'file', name: input.files[0].name, getFile: async () => input.files[0] } : null), { once: true });
      input.addEventListener('cancel', () => resolve(null), { once: true });
      document.body.append(input);
      input.click();
    });
    if (!handle) return;
  }
  st.catalog = { handle, name: displayName(handle.name), permission: 'granted' };
  if (st.open) await openLogs(st.open.files);
  else say(`Katalog ${st.catalog.name} gewählt`);
}

async function forgetCatalog() {
  st.catalog = null;
  await busy(() => st.kv.put(CATALOG_KEY, null));
  if (st.open) await openLogs(st.open.files);
  else say('Kein Katalog mehr');
}

function showProblems(problems) {
  dialog('Probleme im Katalog', h('ul', { class: 'problems' }, problems.map((p) => h('li', {}, p))));
}

// ── the view ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** What is open and where the cursor is, to restore after a new view. */
function snapshot() {
  const open = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.open) {
        open.push(n.id);
        walk(n.children ?? []);
      }
    }
  };
  walk(st.rows);
  return { open, cursor: st.flat[st.cursor]?.id };
}

async function refreshView({ keep = true } = {}) {
  if (!st.open) return;
  const snap = keep ? snapshot() : { open: [], cursor: null };
  const s = st.settings;
  const v = await door('view', {
    time: viewTime(),
    repeats: s.repeats,
    filters: st.filters,
    delta_ms: s.delta_ms,
    gap_minutes: s.gap_minutes,
  });
  st.byId = new Map();
  st.rows = list(v.rows).map((r) => node(r, 0, null));
  st.groups = v.groups;
  st.status = v.status;
  st.flat = [...st.rows];
  // unfold again what was open, level by level
  let todo = snap.open.filter((id) => st.byId.has(id));
  const done = new Set();
  while (todo.length) {
    const nodes = todo.map((id) => st.byId.get(id)).filter((n) => n && n.expandable);
    if (!nodes.length) break;
    await loadChildren(nodes);
    for (const n of nodes) {
      n.open = true;
      done.add(n.id);
    }
    todo = snap.open.filter((id) => !done.has(id) && st.byId.has(id));
  }
  st.flat = flatten(st.rows);
  const at = snap.cursor ? st.flat.findIndex((n) => n.id === snap.cursor) : -1;
  st.cursor = at >= 0 ? at : 0;
  renderLog();
  renderSidebar();
  renderStatus();
}

function node(r, depth, parent) {
  const n = { ...r, depth, parent, open: false, children: null };
  st.byId.set(n.id, n);
  return n;
}

function flatten(nodes, out = []) {
  for (const n of nodes) {
    out.push(n);
    if (n.open && n.children) flatten(n.children, out);
  }
  return out;
}

/** Load the children of `nodes` that have none yet, in one call. */
async function loadChildren(nodes, force = false) {
  const need = nodes.filter((n) => n.expandable && (force || !n.children));
  if (!need.length) return;
  const r = await door('children', { ids: need.map((n) => n.id), mode: st.settings.mode });
  const byId = new Map(need.map((n) => [n.id, n]));
  for (const { id, children } of list(r.nodes)) {
    const n = byId.get(id);
    if (n) n.children = list(children).map((c) => node({ ...c, type: 'body' }, n.depth + 1, n));
  }
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────────────────────────

function renderWhere() {
  const parts = [];
  if (st.folder) parts.push(st.folder.caseName);
  if (st.open) parts.push(st.open.paths.map((p) => p.split('/').at(-1)).join(' + '));
  $('where').textContent = parts.join(' · ');
  document.title = parts.length ? `${parts.join(' · ')} — casedesk` : 'casedesk';
}

function renderStart() {
  const recent = st.recentList ?? [];
  $('log').replaceChildren(
    h(
      'div',
      { class: 'start' },
      h('h1', {}, 'casedesk — Lesekopie von Fall-Logs'),
      h(
        'p',
        { class: 'hint' },
        'Fallordner wählen, dann ein Log aus assets/. Die Seite liest nur den gewählten Ordner, schickt nichts ins Netz ' +
          'und speichert keine Inhalte im Browser (nur den Ordner-Verweis und Ansichtseinstellungen).',
      ),
      h('button', { type: 'button', id: 'pick', class: 'primary', onclick: () => chooseFolder() }, 'Fallordner wählen …'),
      recent.length
        ? h(
            'div',
            { class: 'recent' },
            h('h2', {}, 'Zuletzt benutzt'),
            h('ul', {}, recent.map((r) => h('li', {}, h('button', { type: 'button', class: 'link', onclick: () => openRecent(r) }, r.name)))),
          )
        : null,
      h('p', { class: 'hint small' }, `Build ${PAGE.build} · ${PAGE.engine}`),
    ),
  );
  renderSidebar();
  renderStatus();
}

function lnumWidth() {
  let max = 1;
  for (const r of st.rows) if (r.src > max) max = r.src;
  return String(max).length;
}

function rowEl(n, width) {
  const mark = n.expandable ? (n.open ? '▾' : '▸') : ' ';
  const attrs = { class: 'row', role: 'treeitem', dataset: { id: n.id }, 'aria-level': String(n.depth + 1) };
  if (n.expandable) attrs['aria-expanded'] = String(n.open);
  if (n.type === 'gap') {
    attrs.class += ' gap';
    return h('div', attrs, h('span', { class: 'lnum' }, ' '.repeat(width)), ' ', h('span', { class: 'gapline' }, n.label));
  }
  if (n.type === 'entry') {
    attrs.class += ' entry' + (n.class ? ` lvl-${n.class}` : '');
    const known = list(n.known);
    const items = st.open?.summary.catalog ? list(st.open.summary.catalog.items) : [];
    const first = known.length ? items.find((x) => x.index === known[0]) : null;
    return h(
      'div',
      attrs,
      h('span', { class: 'lnum' }, String(n.src).padStart(width)),
      ' ',
      h('span', { class: 'mark', onclick: (ev) => (ev.stopPropagation(), toggle(n)) }, mark),
      ' ',
      h('span', { class: 'time' }, n.time ?? ''),
      '  ',
      h('span', { class: 'kind' }, n.kind ?? ''),
      '  ',
      n.tag ? h('span', { class: 'tag' }, n.tag + '  ') : null,
      n.rep ? h('span', { class: 'rep' }, n.rep + '  ') : null,
      n.source ? h('span', { class: 'source' }, n.source + '  ') : null,
      h('span', { class: 'text' }, n.text),
      n.note ? h('span', { class: 'note' }, '  ⚠ ' + n.note) : null,
      n.delta ? h('span', { class: 'delta' }, '  ' + n.delta) : null,
      first ? h('span', { class: 'known', title: first.explain }, `  ⚑ known: ${first.title}${known.length > 1 ? ` +${known.length - 1}` : ''}`) : null,
    );
  }
  attrs.class += ' body';
  const label = h('span', { class: 'label' + (n.hl ? ' hl-' + n.hl : '') });
  for (const p of pieces(n.label, n.spans)) label.append(p.group ? h('span', { class: 'hl-' + p.group }, p.text) : p.text);
  return h(
    'div',
    attrs,
    h('span', { class: 'lnum' }, ' '.repeat(width)),
    ' '.repeat(1 + 2 * (n.depth - 1)) + ' ',
    h('span', { class: 'mark', onclick: (ev) => (ev.stopPropagation(), toggle(n)) }, mark),
    ' ',
    label,
  );
}

function renderLog() {
  const log = $('log');
  if (!st.open) return showLogPicker();
  const width = lnumWidth();
  const s = st.open.summary;
  const head = h(
    'div',
    { class: 'loghead' },
    h('span', { class: 'format' }, s.known || s.merged ? s.format.label : 'unknown format'),
    s.confidence && !s.merged ? h('span', { class: 'dim' }, ` (${s.confidence})`) : null,
    h('span', { class: 'dim' }, ` · ${s.lines} Zeilen · ${s.entries} ${s.report ? 'Abschnitte' : 'Einträge'}`),
    s.header ? h('span', { class: 'dim' }, ` · ${s.header}`) : null,
  );
  const rows = h('div', { class: 'rows', id: 'rows' });
  for (const n of st.flat) {
    n.el = rowEl(n, width);
    rows.append(n.el);
  }
  log.replaceChildren(head, rows);
  if (!st.flat.length) rows.append(h('div', { class: 'empty' }, 'Kein Eintrag (Filter?)'));
  rows.onclick = (ev) => {
    const el = ev.target.closest('.row');
    if (!el) return;
    const i = st.flat.findIndex((n) => n.id === el.dataset.id);
    if (i >= 0) setCursor(i);
  };
  rows.ondblclick = (ev) => {
    const el = ev.target.closest('.row');
    const n = el && st.byId.get(el.dataset.id);
    if (n) toggle(n);
  };
  setCursor(Math.min(st.cursor, Math.max(0, st.flat.length - 1)), false);
}

function setCursor(i, scroll = true) {
  if (!st.flat.length) return;
  i = Math.max(0, Math.min(st.flat.length - 1, i));
  st.flat[st.cursor]?.el?.classList.remove('cursor');
  st.cursor = i;
  const el = st.flat[i].el;
  if (el) {
    el.classList.add('cursor');
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }
}

/** Re-draw one node's row and its open subtree in place. */
function redraw(n) {
  const width = lnumWidth();
  const at = st.flat.indexOf(n);
  if (at < 0) return;
  // the rows below n that belong to it
  let end = at + 1;
  while (end < st.flat.length && isBelow(st.flat[end], n)) end++;
  for (let k = at + 1; k < end; k++) st.flat[k].el?.remove();
  const fresh = flatten([n]);
  const old = n.el;
  for (const m of fresh) m.el = rowEl(m, width);
  old.replaceWith(...fresh.map((m) => m.el));
  st.flat.splice(at, end - at, ...fresh);
  // the cursor stays on its row: below the subtree it moves by what the subtree grew, inside a folded one it goes to n
  const cur = st.cursor;
  if (cur >= end) st.cursor = cur + fresh.length - (end - at);
  else if (cur > at && cur >= at + fresh.length) st.cursor = at;
  for (const el of document.querySelectorAll('#rows .row.cursor')) el.classList.remove('cursor');
  st.flat[st.cursor]?.el?.classList.add('cursor');
}

function isBelow(m, n) {
  for (let p = m.parent; p; p = p.parent) if (p === n) return true;
  return false;
}

async function toggle(n, want) {
  if (!n?.expandable) return;
  const open = want ?? !n.open;
  if (open === n.open) return;
  if (open) {
    await busy(() => loadChildren([n]));
    // a failed load leaves the row folded (the status line says why)
    if (!n.children) return;
  }
  n.open = open;
  redraw(n);
}

/** The entry row a row belongs to (itself for an entry). */
function entryOf(n) {
  let e = n;
  while (e?.parent) e = e.parent;
  return e;
}

async function openAll() {
  if (!st.open) return;
  const nodes = st.rows.filter((n) => n.expandable);
  if (nodes.length > MAX_OPEN_ALL) return say(`Mehr als ${MAX_OPEN_ALL} Einträge: erst filtern, dann aufklappen`);
  await busy(async () => {
    await loadChildren(nodes);
    for (const n of nodes) n.open = true;
    const cur = st.flat[st.cursor];
    st.flat = flatten(st.rows);
    st.cursor = Math.max(0, st.flat.indexOf(cur));
    renderLog();
  });
}

function closeAll() {
  if (!st.open) return;
  const walk = (nodes) => {
    for (const n of nodes) {
      n.open = false;
      if (n.children) walk(n.children);
    }
  };
  const cur = entryOf(st.flat[st.cursor]);
  walk(st.rows);
  st.flat = flatten(st.rows);
  st.cursor = Math.max(0, st.flat.indexOf(cur));
  renderLog();
}

function renderSidebar() {
  const side = $('sidebar');
  if (!side) return;
  if (!st.open || !st.groups) {
    side.replaceChildren(h('div', { class: 'side-empty' }, h('h2', {}, 'Treffer'), h('p', { class: 'hint' }, 'Ein Log öffnen, dann stehen hier Fehler, Warnungen, Exceptions, Lücken, Wiederholungen und bekannte Meldungen.')));
    return;
  }
  const out = [h('h2', {}, 'Treffer')];
  for (const [key, title] of GROUPS) {
    const entries = list(st.groups[key]);
    if (key === 'known' && !st.open.summary.catalog) {
      out.push(h('details', { class: 'group', dataset: { group: key } }, h('summary', {}, `${title} (kein Katalog)`), h('p', { class: 'hint' }, 'Katalog → Katalog-Datei wählen …')));
      continue;
    }
    const count = key === 'known' ? entries.reduce((n, g) => n + list(g.rows).length, 0) : entries.length;
    const details = h('details', { class: 'group', dataset: { group: key }, open: count > 0 && key !== 'repeats' ? true : undefined }, h('summary', {}, `${title} (${count})`));
    if (key === 'known') {
      for (const g of entries) details.append(knownBlock(g));
    } else {
      const ul = h('ul', {});
      for (const r of entries) ul.append(h('li', {}, jumpButton(r.id, r.time ? `${r.time}  ${r.text ?? r.label}` : (r.text ?? r.label))));
      details.append(ul);
    }
    out.push(details);
  }
  side.replaceChildren(...out);
}

function jumpButton(id, label) {
  return h('button', { type: 'button', class: 'jump', title: label, onclick: () => jumpTo(id) }, label);
}

function knownBlock(g) {
  const links = list(g.links).map((l) => {
    const k = linkKind(l);
    if (k.kind === 'url') return h('a', { href: k.href, target: '_blank', rel: 'noopener noreferrer' }, k.text);
    return h('span', { class: k.kind }, k.kind === 'case' ? `Fall ${k.text}` : k.text);
  });
  const refs = knownRefs(g).map((r) =>
    h(
      'div',
      { class: 'ref' },
      `${r.label}: `,
      r.kind === 'url' ? h('a', { href: r.href, target: '_blank', rel: 'noopener noreferrer' }, r.text) : h('span', { class: r.kind }, r.text),
    ),
  );
  const block = h(
    'div',
    { class: `known-item sev-${g.severity}`, dataset: { known: g.id } },
    h('div', { class: 'known-title' }, `✱ ${g.title}`, h('span', { class: 'dim' }, ` · ${g.severity}`)),
    g.explain ? h('div', { class: 'explain' }, g.explain) : null,
    links.length ? h('div', { class: 'links' }, ...links.flatMap((a, i) => (i ? [' · ', a] : [a]))) : null,
    ...refs,
  );
  const ul = h('ul', {});
  for (const r of list(g.rows)) ul.append(h('li', {}, jumpButton(r.id, `${r.time}  ${r.text}`)));
  block.append(ul);
  return block;
}

function renderStatus() {
  const bar = $('status');
  if (!bar) return;
  const parts = [];
  const s = st.status;
  if (st.open && s) {
    parts.push(st.open.summary.format.label);
    parts.push(`${s.shown}/${s.total} Einträge`);
    if (s.filter) parts.push(`Filter: ${s.filter}`);
    const t = TIME_MODES.find(([m]) => m === s.time)?.[1] ?? s.time;
    parts.push(`Zeit: ${t}${s.unzoned ? ` (${s.unzoned} ohne Zone, wie geschrieben)` : ''}`);
    parts.push(`Seitenquelltext: ${st.settings.mode}`);
    if (!st.settings.repeats) parts.push('ungefaltet');
  }
  bar.replaceChildren(h('span', { class: 'facts' }, parts.join(' · ')), h('span', { class: 'message', id: 'message' }, st.message));
}

// ── actions ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function setTime(m) {
  st.timeOverride = null;
  st.settings.time = m;
  saveSettings();
  await busy(() => refreshView());
}

async function toggleRepeats() {
  st.settings.repeats = !st.settings.repeats;
  saveSettings();
  await busy(() => refreshView());
}

/** A new page source mode: every page source node loaded so far gets its rows again, the folded ones too. */
async function setMode(m) {
  st.settings.mode = m;
  saveSettings();
  if (!st.open) return renderStatus();
  await busy(async () => {
    const loaded = [...st.byId.values()].filter((n) => n.pagesource && n.children);
    if (loaded.length) {
      // drop what hangs below them, then load in the new mode
      for (const n of loaded) {
        for (const c of n.children) forget(c);
      }
      await loadChildren(loaded, true);
      for (const n of loaded) if (n.open && n.el?.isConnected) redraw(n);
    } else {
      await door('children', { ids: [], mode: m });
    }
    renderStatus();
  });
  say(`Seitenquelltext: ${m}`);
}

function forget(n) {
  st.byId.delete(n.id);
  for (const c of n.children ?? []) forget(c);
}

async function addFilter(clause) {
  const before = st.filters;
  st.filters = [...before, clause];
  const shown = await busy(async () => {
    await refreshView();
    return true;
  });
  // a filter the core refuses would make every later view fail: it goes again (the status line says why)
  if (!shown) st.filters = before;
}

async function popFilter() {
  if (!st.filters.length) return say('Kein Filter zum Zurücknehmen');
  st.filters = st.filters.slice(0, -1);
  await busy(() => refreshView());
}

async function clearFilters() {
  if (!st.filters.length) return say('Kein Filter aktiv');
  st.filters = [];
  await busy(() => refreshView());
}

function toggleSidebar() {
  st.settings.sidebar = !st.settings.sidebar;
  saveSettings();
  applySidebar();
}

/** Move to the row `id` (a side bar jump): its entry is a top-level row, always shown. */
function jumpTo(id) {
  const i = st.flat.findIndex((n) => n.id === id);
  if (i < 0) return say('Der Eintrag ist nicht zu sehen (Filter?)');
  setCursor(i, false);
  st.flat[i].el?.scrollIntoView({ block: 'center' });
  $('log').focus({ preventScroll: true });
}

const JUMPS = {
  next_error: [1, (n) => n.class === 'error' || n.class === 'fatal', 'Kein weiterer Fehler'],
  prev_error: [-1, (n) => n.class === 'error' || n.class === 'fatal', 'Kein früherer Fehler'],
  next_warn: [1, (n) => n.class === 'warn', 'Keine weitere Warnung'],
  prev_warn: [-1, (n) => n.class === 'warn', 'Keine frühere Warnung'],
  next_request: [1, (n) => n.request === true, 'Kein weiterer Request'],
  prev_request: [-1, (n) => n.request === true, 'Kein früherer Request'],
  next_known: [1, (n) => list(n.known).length > 0, 'Keine weitere bekannte Meldung'],
  prev_known: [-1, (n) => list(n.known).length > 0, 'Keine frühere bekannte Meldung'],
  next_gap: [1, (n) => n.type === 'gap', 'Keine weitere Lücke'],
  prev_gap: [-1, (n) => n.type === 'gap', 'Keine frühere Lücke'],
};

function jump(action) {
  if (!st.open) return;
  const [step, test, none] = JUMPS[action];
  for (let i = st.cursor + step; i >= 0 && i < st.flat.length; i += step) {
    const n = st.flat[i];
    if (n.depth === 0 && test(n)) {
      setCursor(i);
      if (action.endsWith('_known')) explainKnown(n);
      else say('');
      return;
    }
  }
  say(action.endsWith('_known') && !st.open.summary.catalog ? 'Kein Katalog gewählt (Katalog → Katalog-Datei wählen …)' : none);
}

function explainKnown(n) {
  const items = list(st.open?.summary.catalog?.items);
  const texts = list(n.known).map((k) => items.find((x) => x.index === k)).filter(Boolean);
  say(texts.map((x) => `known: ${x.title} [${x.severity}]`).join(' · '));
}

async function showOriginal() {
  const n = st.flat[st.cursor];
  if (!n || !st.open) return;
  const e = entryOf(n);
  const from = n.type === 'body' && typeof n.src === 'number' ? n.src : e.src;
  const to = n.type === 'body' ? from : (e.src_end ?? e.src);
  const r = await busy(() => door('original', { from, to, file: typeof e.file === 'number' ? e.file : 1 }));
  if (!r) return;
  const width = String(r.to).length;
  const text = list(r.lines).map((l, k) => `${String(r.from + k).padStart(width)}  ${l}`).join('\n');
  dialog(`${r.name}, Zeilen ${r.from}–${r.to}${r.to - r.from + 1 < to - from + 1 ? ` (von ${to - from + 1})` : ''}`, h('pre', { class: 'original' }, text));
}

function showHelp() {
  const names = {
    toggle: 'Eintrag/Knoten auf- oder zuklappen',
    open: 'aufklappen',
    close: 'zuklappen',
    close_all: 'alles zuklappen',
    open_all: 'jeden Eintrag eine Stufe aufklappen',
    original: 'Original-Zeilen des Eintrags zeigen',
    next_error: 'nächster Fehler',
    prev_error: 'voriger Fehler',
    next_warn: 'nächste Warnung',
    prev_warn: 'vorige Warnung',
    next_request: 'nächster Request',
    prev_request: 'voriger Request',
    next_known: 'nächste bekannte Meldung (Katalog)',
    prev_known: 'vorige bekannte Meldung',
    next_gap: 'nächste Lücke',
    prev_gap: 'vorige Lücke',
    filter: 'Filter hinzufügen',
    filter_pop: 'letzten Filter zurücknehmen',
    filter_clear: 'alle Filter weg',
    tz: 'Zeit: Original → UTC → relativ',
    repeats: 'Wiederholungen falten ↔ alle Einträge',
    mode: 'Seitenquelltext: labelled → all → clickable',
    help: 'diese Tasten',
    down: 'eine Zeile runter',
    up: 'eine Zeile hoch',
    first: 'erste Zeile',
    last: 'letzte Zeile',
    page_down: 'eine Seite runter',
    page_up: 'eine Seite hoch',
  };
  dialog(
    'Tasten (wie in Neovim)',
    h('table', { class: 'keys' }, Object.entries(KEYS).map(([a, seqs]) => h('tr', {}, h('td', {}, h('kbd', {}, seqs.join(' '))), h('td', {}, names[a] ?? a)))),
  );
}

function showFilterDialog() {
  if (!st.open) return;
  const field = h('select', { id: 'filter-field' }, FILTER_FIELDS.map(([v, l]) => h('option', { value: v }, l)));
  const input = h('input', { id: 'filter-raw', type: 'text', size: '40', autocomplete: 'off', spellcheck: 'false' });
  const form = h(
    'form',
    {
      method: 'dialog',
      class: 'filter-form',
      onsubmit: (ev) => {
        ev.preventDefault();
        const raw = input.value.trim();
        $('dialog').close();
        if (raw && raw !== '!') addFilter({ field: field.value, raw });
      },
    },
    h('label', {}, 'Feld ', field),
    h('label', {}, 'Wert ', input),
    h('p', { class: 'hint' }, 'Teilstring (Groß/klein egal); /…/ = Lua-Muster; ! vorne schließt aus.'),
    h('div', { class: 'buttons' }, h('button', { type: 'submit', class: 'primary' }, 'Hinzufügen'), h('button', { type: 'button', onclick: () => $('dialog').close() }, 'Abbrechen')),
  );
  dialog('Filter hinzufügen', form);
  input.focus();
}

function showSettingsDialog() {
  const s = st.settings;
  const delta = h('input', { id: 'set-delta', type: 'number', min: '-1', step: '50', value: String(s.delta_ms) });
  const gap = h('input', { id: 'set-gap', type: 'number', min: '0', step: '1', value: String(s.gap_minutes) });
  const form = h(
    'form',
    {
      method: 'dialog',
      class: 'settings-form',
      onsubmit: async (ev) => {
        ev.preventDefault();
        const d = Number(delta.value);
        const g = Number(gap.value);
        $('dialog').close();
        if (Number.isFinite(d)) s.delta_ms = Math.round(d);
        if (Number.isFinite(g) && g >= 0) s.gap_minutes = g;
        saveSettings();
        await busy(() => refreshView());
      },
    },
    h('label', {}, 'Abstand am Zeilenende ab (ms, −1 = nie) ', delta),
    h('label', {}, 'Lücke als eigene Zeile ab (Minuten, 0 = nie) ', gap),
    h('div', { class: 'buttons' }, h('button', { type: 'submit', class: 'primary' }, 'Übernehmen'), h('button', { type: 'button', onclick: () => $('dialog').close() }, 'Abbrechen')),
  );
  dialog('Abstände und Lücken', form);
}

function dialog(title, body) {
  const d = $('dialog');
  d.replaceChildren(
    h('div', { class: 'dialog-head' }, h('h2', {}, title), h('button', { type: 'button', class: 'close', 'aria-label': 'Schließen', onclick: () => d.close() }, '×')),
    body,
  );
  d.showModal();
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const keys = new KeyReader();
let keyTimer = null;

function onKey(ev) {
  if ($('dialog').open) return;
  if (ev.target.closest && ev.target.closest('input, select, textarea')) return;
  if (ev.key === 'Escape') {
    closeMenus();
    keys.reset();
    return;
  }
  // inside a menu the browser's own keys (Tab, Enter on a button) work
  if (ev.target.closest && ev.target.closest('.menu')) return;
  const name = keyName(ev);
  if (!name) return;
  const r = keys.feed(name);
  clearTimeout(keyTimer);
  if (r.kind === 'pending') {
    ev.preventDefault();
    keyTimer = setTimeout(() => keys.reset(), 1000);
    return;
  }
  if (r.kind !== 'action') return;
  // <CR> on a focused button is the button's
  if (name === '<CR>' && ev.target.closest && ev.target.closest('button, a')) return;
  ev.preventDefault();
  run(r.action);
}

function pageRows() {
  const row = st.flat[0]?.el;
  const h1 = row ? row.getBoundingClientRect().height || 18 : 18;
  return Math.max(1, Math.floor($('log').clientHeight / h1) - 2);
}

function run(action) {
  const n = st.flat[st.cursor];
  switch (action) {
    case 'toggle':
      return n && toggle(n);
    case 'open':
      return n && toggle(n, true);
    case 'close':
      if (!n) return;
      if (n.expandable && n.open) return toggle(n, false);
      if (n.parent) return toggle(entryOf(n), false).then(() => focusNode(entryOf(n)));
      return;
    case 'close_all':
      return closeAll();
    case 'open_all':
      return openAll();
    case 'original':
      return showOriginal();
    case 'filter':
      return showFilterDialog();
    case 'filter_pop':
      return popFilter();
    case 'filter_clear':
      return clearFilters();
    case 'tz': {
      const i = TIME_MODES.findIndex(([m]) => m === viewTime());
      const next = TIME_MODES[(i + 1) % TIME_MODES.length][0];
      return setTime(next).then(() => say(`Zeit: ${TIME_MODES.find(([m]) => m === next)[1]}`));
    }
    case 'repeats':
      return toggleRepeats().then(() => say(st.settings.repeats ? 'Wiederholungen gefaltet' : 'Alle Einträge'));
    case 'mode':
      return setMode(PS_MODES[(PS_MODES.indexOf(st.settings.mode) + 1) % PS_MODES.length]);
    case 'help':
      return showHelp();
    case 'down':
      return setCursor(st.cursor + 1);
    case 'up':
      return setCursor(st.cursor - 1);
    case 'first':
      return setCursor(0);
    case 'last':
      return setCursor(st.flat.length - 1);
    case 'page_down':
      return setCursor(st.cursor + pageRows());
    case 'page_up':
      return setCursor(st.cursor - pageRows());
    default:
      if (JUMPS[action]) return jump(action);
  }
}

function focusNode(n) {
  const i = st.flat.indexOf(n);
  if (i >= 0) setCursor(i);
}

// ── start ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  layout();
  document.body.dataset.state = 'starting';
  st.kv = idbKeyValue(indexedDB, 'casedesk-web');
  st.recent = new RecentFolders(st.kv);
  await refreshRecent();
  await loadCatalogHandle();
  renderStart();
  say('Lua-Kern startet …');
  try {
    const t0 = performance.now();
    st.engineStart = startEngine();
    st.engine = await st.engineStart;
    say(`Bereit (Lua-Kern in ${Math.round(performance.now() - t0)} ms gestartet)`);
    document.body.dataset.state = 'ready';
  } catch (e) {
    say('Der Lua-Kern startet nicht: ' + errText(e));
    document.body.dataset.state = 'fail';
  }
}

main();
