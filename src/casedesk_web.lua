---@module 'casedesk_web'
--- The door of casedesk-web: what the page asks of the Lua core of casedesk.nvim, one JSON document per answer.
---
--- Runs in two VMs: in the browser (wasmoon, Lua 5.4, with src/vim-shim.lua as `vim`) and in Neovim (LuaJIT,
--- `nvim -l test/door.lua`), so that a test can compare both answers. Uses only the pure core of the reading copy
--- (`casedesk.logview.core.*`, `casedesk.logview.formats.*`) and `vim.json`; nothing of the editor.

local M = {}

M.SCHEMA = 1

--- One entry as the page shows it: the head row and what it unfolds to (the diff-friendly lines of
--- `core.normalize`, which decode every JSON and page source part).
---@param e Casedesk.Logview.Entry
---@param normalize table  casedesk.logview.core.normalize
---@return table
local function entry_view(e, normalize)
  local unfolded = 0
  for _, part in ipairs(e.body or {}) do
    unfolded = unfolded + #normalize.part_lines(part, nil, "")
  end
  return {
    line = e.src,
    line_end = e.src_end,
    time = e.time or vim.NIL,
    t_ms = e.t_ms or vim.NIL,
    kind = e.kind,
    level = e.level or vim.NIL,
    source = e.source or vim.NIL,
    text = e.text,
    note = e.note or vim.NIL,
    parts = #(e.body or {}),
    unfolded = unfolded,
  }
end

--- The reading copy of one log text.
---@param text string  the file's text (UTF-8)
---@param path string  the file's path (its name decides the format among others)
---@return table
function M.reading_copy(text, path)
  local doc = require("casedesk.logview.core.doc").build(text, path)
  local normalize = require("casedesk.logview.core.normalize")
  local entries = {}
  for i, e in ipairs(doc.entries) do
    entries[i] = entry_view(e, normalize)
  end
  return {
    kind = "casedesk-web.reading_copy",
    schema = M.SCHEMA,
    path = doc.path,
    format = doc.format.id,
    label = doc.format.label,
    known = doc.known,
    -- three decimals: a float's last digits differ between LuaJIT and Lua 5.4 in text
    confidence = doc.confidence and string.format("%.3f", doc.confidence) or vim.NIL,
    lines = doc.lines,
    bytes = doc.bytes,
    entries = entries,
    normalized = normalize.doc_lines(doc),
  }
end

local function read_file(path)
  local f, err = io.open(path, "rb")
  if not f then
    error("cannot read " .. path .. ": " .. tostring(err), 0)
  end
  local text = f:read("a")
  f:close()
  return text
end

--- The methods of the door. `params` is the decoded `params` of the request.
local METHODS = {
  hello = function()
    return {
      kind = "casedesk-web.hello",
      schema = M.SCHEMA,
      lua = _VERSION,
      jit = type(jit) == "table" and jit.version or vim.NIL,
    }
  end,
  reading_copy = function(params)
    if type(params) ~= "table" or type(params.path) ~= "string" or params.path == "" then
      error({ code = "bad_request", message = "params.path (a string) is needed" })
    end
    return M.reading_copy(read_file(params.path), params.path)
  end,
}

--- One call: the answer as "<code>\n<json>", code empty for an answer. Never throws: an error is an answer too
--- (`casedesk-web.error`), so the page always reads one JSON document.
---@param method string
---@param request string  JSON of `{ "params": {...} }`, or empty
---@return string
function M.door(method, request)
  local ok, result = pcall(function()
    local fn = METHODS[method]
    if not fn then
      error({ code = "unknown_method", message = "no method " .. tostring(method) })
    end
    local params
    if request and request ~= "" then
      local decoded = vim.json.decode(request)
      params = type(decoded) == "table" and decoded.params or nil
    end
    return fn(params)
  end)
  if ok then
    return "\n" .. vim.json.encode(result)
  end
  local code, message = "internal", tostring(result)
  if type(result) == "table" then
    code, message = tostring(result.code or code), tostring(result.message or message)
  end
  return code
    .. "\n"
    .. vim.json.encode({
      kind = "casedesk-web.error",
      schema = M.SCHEMA,
      code = code,
      message = message,
    })
end

return M
