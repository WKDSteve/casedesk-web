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
__casedesk_door = require("casedesk_web").door
`;

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
    this.door = lua.global.get('__casedesk_door');
  }

  /**
   * One method of the door. `request` is the JSON of the whole request (`{"params": {...}}`) or empty; `blobs` are
   * texts the request names by number (`blob: 1` is the first), handed to Lua as strings beside the JSON.
   * @param {string} method
   * @param {string | null} [request]
   * @param {string[]} [blobs]
   * @returns {{ text: string, code: string | null }}
   */
  call(method, request, blobs = []) {
    const raw = String(this.door(method, request ?? '', ...blobs));
    const nl = raw.indexOf('\n');
    const code = raw.slice(0, nl);
    return { text: raw.slice(nl + 1), code: code === '' ? null : code };
  }

  close() {
    this.lua.global.close();
  }
}
