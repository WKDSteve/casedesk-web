// The Lua core of casedesk.nvim in a Lua VM (wasmoon, Lua 5.4): the door of src/casedesk_web.lua, without Neovim and
// without a server. After tasks-desktop ui/src/web/engine.ts (MIT, same author), plain JavaScript so that Node runs it
// without a build and the worker takes it as a classic script (build/pack.mjs drops `export`).
//
// Nothing here knows where it runs. The caller hands in the VM factory (in the browser one whose WASM comes from the
// page itself, see worker.js; in a Node test the stock one) and the bundle (build/bundle.mjs). The modules load from the
// bundle, never from a file; `vim` is the core's own shim (`bundle.shim`, casedesk.web.vim_shim: JSON as lua-cjson
// writes and reads it, what LuaJIT does on Lua 5.4). The texts the core reads come with each call, so the VM needs no
// file and no clock.

/**
 * What runs once in a new VM: the bundle as `package.preload`, the core's shim installed, the door taken. `os.exit`
 * would end the VM itself (Emscripten's exit), so it raises instead.
 */
const PRELUDE = `
package.path = ""
package.cpath = ""
for name in __web.module_names():gmatch("[^\\n]+") do
  package.preload[name] = function(...)
    local chunk, err = load(__web.source(name), "@" .. name, "t")
    if not chunk then
      error(err, 0)
    end
    return chunk(...)
  end
end
os.exit = function()
  error("os.exit is not available in the browser", 2)
end
require(__web.shim()).install()
local door = require("casedesk_web").door
-- the files of a call, put here as Lua strings by WebEngine.call (lua_pushlstring: every byte as it is, NUL too)
__casedesk_staged = {}
__casedesk_call = function(method, request, n)
  local blobs = {}
  for i = 1, n do
    blobs[i] = __casedesk_staged[i]
  end
  -- a fresh table each call: what a failed staging left behind goes with the old one
  __casedesk_staged = {}
  return door(method, request, table.unpack(blobs, 1, n))
end
`;

const utf8 = new TextEncoder();

export class WebEngine {
  /**
   * @param {{ factory: any, bundle: { engine: object, shim: string, modules: Record<string, string> } }} opts
   */
  static async create(opts) {
    const lua = await opts.factory.createEngine({ openStandardLibs: true, injectObjects: false, enableProxy: false });
    const names = Object.keys(opts.bundle.modules).sort().join('\n');
    if (!opts.bundle.shim || !opts.bundle.modules[opts.bundle.shim]) throw new Error('the bundle has no shim');
    // Every answer to Lua is a string or undefined (nil), never null: wasmoon looks for a `.then` on every object it
    // gets back, and `typeof null` is 'object'.
    lua.global.set('__web', {
      module_names: () => names,
      source: (name) => opts.bundle.modules[name],
      shim: () => opts.bundle.shim,
    });
    lua.doStringSync(PRELUDE);
    return new WebEngine(lua);
  }

  constructor(lua) {
    this.lua = lua;
    // Taken once: every `global.get` makes a new JS wrapper with its own reference into the Lua registry.
    this.door = lua.global.get('__casedesk_call');
  }

  /**
   * Put the files of a call into `__casedesk_staged[1..n]` as Lua strings, byte for byte. wasmoon hands a JS string
   * to Lua with `lua_pushstring`: as UTF-8 (a byte over 0x7F of a file would become two) and cut at the first NUL (a
   * UTF-16 log is half NUL bytes). So the bytes go through the VM's memory and `lua_pushlstring` instead; a string
   * blob (a test, the engine check) goes as its UTF-8.
   * @param {(string | Uint8Array)[]} blobs
   */
  stage(blobs) {
    const g = this.lua.global;
    const api = g.lua;
    const mod = api.module;
    const L = g.address;
    const top = api.lua_gettop(L);
    try {
      api.lua_getglobal(L, '__casedesk_staged');
      blobs.forEach((b, i) => {
        const bytes = typeof b === 'string' ? utf8.encode(b) : b;
        if (!(bytes instanceof Uint8Array)) throw new Error(`blob ${i + 1} is neither text nor bytes`);
        const ptr = mod._malloc(bytes.length || 1);
        if (!ptr) throw new Error(`blob ${i + 1}: no memory for ${bytes.length} bytes`);
        try {
          // HEAPU8 is taken after malloc: a malloc that grows the memory replaces the buffer behind it
          mod.HEAPU8.set(bytes, ptr);
          // the raw export, not the cwrap: that one reads the returned pointer back as a JS string
          mod._lua_pushlstring(L, ptr, bytes.length);
        } finally {
          mod._free(ptr);
        }
        api.lua_rawseti(L, -2, BigInt(i + 1)); // a lua_Integer: 64 bits, a BigInt in JS
      });
    } finally {
      api.lua_settop(L, top);
    }
  }

  /**
   * One method of the door. `request` is the JSON of the whole request (`{"params": {...}}`) or empty; `blobs` are the
   * files the request names by number (`blob: 1` is the first): their bytes (a `Uint8Array`), or a text, handed to Lua
   * as strings beside the JSON; the door reads each as casedesk.nvim reads a log (`core.encoding.to_utf8`).
   * @param {string} method
   * @param {string | null} [request]
   * @param {(string | Uint8Array)[]} [blobs]
   * @returns {{ text: string, code: string | null }}
   */
  call(method, request, blobs = []) {
    this.stage(blobs);
    const raw = String(this.door(method, request ?? '', blobs.length));
    const nl = raw.indexOf('\n');
    const code = raw.slice(0, nl);
    return { text: raw.slice(nl + 1), code: code === '' ? null : code };
  }

  close() {
    this.lua.global.close();
  }
}
