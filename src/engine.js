// The Lua core of casedesk.nvim in a Lua VM (wasmoon, Lua 5.4): the door of src/casedesk_web.lua, without Neovim and
// without a server. Ported from tasks-desktop ui/src/web/engine.ts (MIT, same author), plain JavaScript so that Node
// runs it without a build and the worker takes it as a classic script (build/pack.mjs drops `export`).
//
// Nothing here knows where it runs. The caller hands in the VM factory (in the browser one whose WASM comes from the
// page itself, see worker.js; in a Node test the stock one), the Lua sources (build/bundle.mjs) and the vim shim, and
// puts the files the core reads into the in-memory file system of the VM. A path is always a path inside the VM, never
// one of the machine.

const HOME = '/home/web';
const S_IFMT = 0o170000;

export const isDir = (mode) => (mode & S_IFMT) === 0o040000;
export const isFile = (mode) => (mode & S_IFMT) === 0o100000;

/** Make the folder `path` and its parents in the VM's file system. */
export function mkdirTree(fs, path) {
  let at = '';
  for (const part of path.split('/').filter(Boolean)) {
    at += `/${part}`;
    try {
      fs.mkdir(at);
    } catch {
      if (!isDir(fs.stat(at).mode)) throw new Error(`not a folder: ${at}`);
    }
  }
}

export function removeTree(fs, path) {
  for (const name of fs.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const child = `${path}/${name}`;
    if (isDir(fs.stat(child).mode)) removeTree(fs, child);
    else fs.unlink(child);
  }
  fs.rmdir(path);
}

export class WebEngine {
  /**
   * @param {{ factory: any, bundle: { engine: object, modules: Record<string, string> }, shim: string,
   *   env?: Record<string, string>, log?: (level: number, message: string) => void, now?: () => number }} opts
   */
  static async create(opts) {
    const wasm = await opts.factory.getLuaModule();
    const fs = wasm.module.FS;
    const lua = await opts.factory.createEngine({ openStandardLibs: true, injectObjects: false, enableProxy: false });
    const env = { HOME, ...(opts.env ?? {}) };
    const log = opts.log ?? (() => {});
    const now = opts.now ?? (() => Date.now());
    const names = Object.keys(opts.bundle.modules).sort().join('\n');
    // Every answer to Lua is a string, a boolean or undefined (nil), never null: wasmoon looks for a `.then` on every
    // object it gets back, and `typeof null` is 'object'.
    lua.global.set('__web', {
      module_names: () => names,
      source: (name) => opts.bundle.modules[name],
      env: (name) => env[name],
      set_env: (name, value) => {
        if (value === null || value === undefined) delete env[name];
        else env[name] = String(value);
      },
      home: () => HOME,
      now_ms: () => String(now()),
      log: (level, message) => log(Number(level), String(message)),
      stat: (path) => {
        try {
          const st = fs.stat(path);
          const kind = isDir(st.mode) ? 'directory' : isFile(st.mode) ? 'file' : 'other';
          const ms = st.mtime.getTime();
          return `${kind} ${st.size} ${Math.floor(ms / 1000)} ${(ms % 1000) * 1_000_000} ${st.mode}`;
        } catch {
          return undefined;
        }
      },
      // JSON, not a separated list: a name may hold a tab or a newline on the system the folder comes from.
      readdir: (path) => {
        try {
          return JSON.stringify(
            fs
              .readdir(path)
              .filter((n) => n !== '.' && n !== '..')
              .map((n) => [n, isDir(fs.stat(`${path}/${n}`).mode) ? 'directory' : 'file']),
          );
        } catch {
          return undefined;
        }
      },
      mkdir: (path, parents) => {
        try {
          if (parents) mkdirTree(fs, path);
          else fs.mkdir(path);
          return true;
        } catch {
          return false;
        }
      },
      rmdir: (path, recursive) => {
        try {
          if (recursive) removeTree(fs, path);
          else fs.rmdir(path);
          return true;
        } catch {
          return false;
        }
      },
    });
    lua.doStringSync(opts.shim);
    lua.doStringSync('__casedesk_door = require("casedesk_web").door');
    return new WebEngine(lua, fs, opts.bundle);
  }

  constructor(lua, fs, bundle) {
    this.lua = lua;
    // Taken once: every `global.get` makes a new JS wrapper with its own reference into the Lua registry.
    this.door = lua.global.get('__casedesk_door');
    this.fs = fs;
    this.bundle = bundle;
  }

  /** Put files into the VM's file system: path inside the VM -> content. Folders are made as needed. */
  mount(files) {
    for (const [path, content] of Object.entries(files)) {
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (dir) mkdirTree(this.fs, dir);
      this.fs.writeFile(path, content);
    }
  }

  /**
   * One method of the door. `request` is the JSON of the whole request (`{"params": {...}}`) or empty.
   * @returns {{ text: string, code: string | null }}
   */
  call(method, request) {
    const raw = String(this.door(method, request ?? ''));
    const nl = raw.indexOf('\n');
    const code = raw.slice(0, nl);
    return { text: raw.slice(nl + 1), code: code === '' ? null : code };
  }

  close() {
    this.lua.global.close();
  }
}
