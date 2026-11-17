---@module 'casedesk_web'
--- The door of casedesk-web: what the page asks of the Lua core of casedesk.nvim, one JSON document per answer.
---
--- Runs in two VMs: in the browser (wasmoon, Lua 5.4, with src/vim-shim.lua as `vim`) and in Neovim (LuaJIT,
--- `nvim -l`), so that a test can compare both answers. Uses only the pure core of the reading copy
--- (`casedesk.logview.core.*`, `casedesk.logview.formats.*`, `casedesk.web.api`) and the pure parts of its view
--- (`view.clock`: time column and gaps, `view.filter`: the filter stack, `view.nodes`: what an entry unfolds to).
---
--- The texts (a log, a catalog) come as extra arguments of `door`, not inside the JSON request: decoding megabytes of
--- JSON in Lua is slow, and the page has the text as a string already. A request names them by number (`blob = 1`).
---
--- The log the page shows stays in this VM (`S`) between calls: `open` parses it, `view` gives the rows for the
--- settings of the page, `children` unfolds a row. Nothing of it leaves the page's memory.

local M = {}

M.SCHEMA = 2

--- Lines that carry the failure, strongest first: a copy of `TIERS` of casedesk.nvim's `lua/casedesk/logs.lua`,
--- which is not part of the pure core (it lists files). test/door.test.mjs checks that it equals the pinned one.
-- stylua: ignore start
local TIERS = {
  { "error", "exception", "fatal", "crash", "unhandled", "fail", "panic", "traceback" },
  { "warn", "timeout", "timed out", "denied", "refused", "invalid", "cannot ", "could not" },
}
-- stylua: ignore end

--- `logs.tier_of` of casedesk.nvim: 1 (error words), 2 (warning words, an HRESULT-like `0x…`) or nil.
---@param line string
---@return integer|nil
function M.tier_of(line)
  local lower = line:lower()
  for tier, words in ipairs(TIERS) do
    for _, word in ipairs(words) do
      if lower:find(word, 1, true) then
        return tier
      end
    end
  end
  if lower:find("0x%x%x%x%x%x%x%x%x") then
    return 2
  end
  return nil
end

--- Widest source shown on a row (`view.render.SOURCE_WIDTH`).
M.SOURCE_WIDTH = 40

--- Code points of a UTF-8 string, without `utf8` (LuaJIT has none).
---@param s string
---@return string[]
local function chars(s)
  local out = {}
  for ch in s:gmatch("[%z\1-\127\194-\244][\128-\191]*") do
    out[#out + 1] = ch
  end
  return out
end

--- `view.render.short_source`: the last two dotted parts, cut to `SOURCE_WIDTH` characters.
---@param source string
---@return string
function M.short_source(source)
  local last2 = source:match("([^%.]+%.[^%.]+)$") or source
  local cs = chars(last2)
  if #cs > M.SOURCE_WIDTH then
    last2 = table.concat(cs, "", 1, M.SOURCE_WIDTH - 1) .. "…"
  end
  return last2
end

--- Defaults of the view (casedesk.nvim's `log_view.delta_ms`, `log_view.gap_minutes`).
M.DELTA_MS = 250
M.GAP_MINUTES = 5

--- Most lines `original` gives at once.
M.MAX_ORIGINAL = 400

--- The open log: nil until `open`.
---@class CasedeskWeb.State
---@field doc Casedesk.Logview.Doc
---@field texts string[]  the text of each file (a merged view has several)
---@field lines table<integer, string[]>  the lines of a file, split on the first `original`
---@field tags string[]|nil  the file tag of each file (merged view)
---@field catalog table|nil  `{ items, problems, by_entry }`
---@field mode string  the page source mode
---@field nodes table<string, table>  the tree nodes handed out, by id
---@type CasedeskWeb.State|nil
local S = nil

local function bad(message)
  error({ code = "bad_request", message = message })
end

local function need_open()
  if not S then
    error({ code = "not_open", message = "no log is open (open first)" })
  end
  return S
end

--- A text argument named by `blob` in a request.
---@param blobs string[]
---@param n any
---@param what string
---@return string
local function blob(blobs, n, what)
  local text = type(n) == "number" and blobs[n] or nil
  if type(text) ~= "string" then
    bad(what .. ": blob " .. tostring(n) .. " is not there")
  end
  return text
end

--- The level an entry counts as for `]e`/`]w` and the side bar (`view.init`'s `level_of`): its own, or -- in a format
--- that writes none -- the tier of its text.
---@param doc Casedesk.Logview.Doc
---@param e Casedesk.Logview.Entry
---@return string|nil
local function level_of(doc, e)
  if e.level or doc.format.has_levels then
    return e.level
  end
  local tier = M.tier_of(e.text)
  return tier == 1 and "error" or tier == 2 and "warn" or nil
end

local function is_error(level)
  return level == "error" or level == "fatal"
end

--- The exception an entry carries: the type of its stack trace or of its text, nil without one.
---@param e Casedesk.Logview.Entry
---@return string|nil
local function exception_of(e)
  local stack = require("casedesk.logview.core.stack")
  local _, t = stack.find_type(e.text)
  if t then
    return t
  end
  for _, part in ipairs(e.body or {}) do
    if part.kind == "stack" and type(part.value) == "table" then
      for i, line in ipairs(part.value.lines or {}) do
        if i > stack.MAX_SCAN then
          break
        end
        local _, ty = stack.find_type(line)
        if ty then
          return ty
        end
      end
      return "stack trace"
    end
  end
  return nil
end

--- One catalog item as the side bar shows it.
---@param item Casedesk.Logview.CatalogItem
---@param index integer
---@return table
local function catalog_item(item, index)
  return {
    index = index,
    id = item.id,
    title = item.title,
    explain = item.explain or "",
    severity = item.severity,
    links = item.links or {},
  }
end

--- The settings of `view`, checked.
---@param p table|nil
---@return table
local function view_settings(p)
  p = p or {}
  local clock = require("casedesk.logview.view.clock")
  local tz = p.time or "original"
  if not clock.valid(tz) then
    bad("time must be one of original, utc, relative")
  end
  local delta = p.delta_ms == nil and M.DELTA_MS or p.delta_ms
  local gap = p.gap_minutes == nil and M.GAP_MINUTES or p.gap_minutes
  if type(delta) ~= "number" or type(gap) ~= "number" then
    bad("delta_ms and gap_minutes must be numbers")
  end
  local filters = p.filters or {}
  if type(filters) ~= "table" then
    bad("filters must be a list")
  end
  return {
    tz = tz,
    repeats = p.repeats ~= false,
    delta_ms = math.floor(delta),
    gap_ms = math.floor(gap * 60000),
    filters = filters,
  }
end

--- The filter stack of `view.filter` for the clauses of the page: `{ field, raw }`, `raw` as typed (`/…/` a Lua
--- pattern, `!` in front excludes), parsed by the core's `parse_text`.
---@param doc Casedesk.Logview.Doc
---@param tags string[]|nil
---@param list table[]
---@return Casedesk.Logview.Filter
local function make_filter(doc, tags, list)
  local filter = require("casedesk.logview.view.filter")
  local fields = filter.fields(function(e)
    return level_of(doc, e)
  end, function(e)
    return tags and e.file and tags[e.file] or nil
  end)
  local h = filter.new(fields)
  for i, c in ipairs(list) do
    if type(c) ~= "table" or type(c.field) ~= "string" or type(c.raw) ~= "string" then
      bad(("filter %d must be { field, raw }"):format(i))
    end
    if not fields[c.field] then
      bad(("filter %d: no field %s"):format(i, c.field))
    end
    local clause = filter.parse_text(c.raw)
    if not clause then
      bad(("filter %d is empty"):format(i))
    end
    clause.field = c.field
    h.stack[#h.stack + 1] = clause
  end
  return h
end

--- The view's tree-node context for `view.nodes`.
local function node_ctx()
  return {
    mode = function()
      return S and S.mode or "labelled"
    end,
    on_pagesource = function() end,
  }
end

--- A node as the page gets it.
---@param n table
---@return table
local function node_out(n)
  return {
    id = n.id,
    label = n.label,
    spans = n.spans or {},
    hl = n.hl or vim.NIL,
    expandable = n.expandable == true,
    pagesource = (n.data and n.data.pagesource) and true or false,
    src = n.data and n.data.src or vim.NIL,
  }
end

--- Parse the logs (one, or several merged by time) and keep them as the open log.
---@param p table  `{ logs = { { name, blob } ... }, catalog? = { blob } }`
---@param blobs string[]
---@return table
local function open(p, blobs)
  if type(p) ~= "table" or type(p.logs) ~= "table" or #p.logs == 0 then
    bad("params.logs (a list) is needed")
  end
  local doc_mod = require("casedesk.logview.core.doc")
  local docs, texts = {}, {}
  for i, l in ipairs(p.logs) do
    if type(l) ~= "table" or type(l.name) ~= "string" or l.name == "" then
      bad(("logs[%d].name is needed"):format(i))
    end
    local name = l.name:match("[^/\\]+$") or l.name
    texts[i] = blob(blobs, l.blob, "logs[" .. i .. "]")
    docs[i] = doc_mod.build(texts[i], name)
  end
  local merge = require("casedesk.logview.core.merge")
  local doc = #docs == 1 and docs[1] or merge.build(docs)
  local tags
  if #docs > 1 then
    tags = {}
    for i, f in ipairs(doc.files) do
      tags[i] = f.tag
    end
  end

  local catalog
  if p.catalog ~= nil then
    local core_catalog = require("casedesk.logview.core.catalog")
    local text = blob(blobs, type(p.catalog) == "table" and p.catalog.blob or nil, "catalog")
    local items, problems = core_catalog.parse(text, "log-patterns.conf")
    local match = core_catalog.match(doc, items)
    catalog = { items = items, problems = problems, by_entry = match.by_entry, count = match.count }
  end

  local prev_mode = S and S.mode or "labelled"
  S = {
    doc = doc,
    texts = texts,
    lines = {},
    tags = tags,
    catalog = catalog,
    mode = prev_mode,
    nodes = {},
  }

  local header = require("casedesk.logview.core.header")
  local files = {}
  for i, d in ipairs(docs) do
    files[i] = {
      name = d.path,
      tag = tags and tags[i] or vim.NIL,
      format = d.format.id,
      label = d.known and d.format.label or "unknown format",
      known = d.known,
      lines = d.lines,
      entries = #d.entries,
    }
  end
  local items = {}
  for k, item in ipairs(catalog and catalog.items or {}) do
    items[k] = catalog_item(item, k)
  end
  return {
    kind = "casedesk-web.open",
    schema = M.SCHEMA,
    format = { id = doc.format.id, label = doc.format.label },
    known = doc.known,
    confidence = doc.confidence and string.format("%.3f", doc.confidence) or vim.NIL,
    report = doc.report == true,
    has_levels = doc.format.has_levels == true,
    lines = doc.lines,
    bytes = doc.bytes,
    entries = #doc.entries,
    header = header.summary(doc.header),
    files = files,
    merged = #docs > 1,
    catalog = catalog and {
      items = items,
      problems = catalog.problems,
      count = catalog.count,
      size = #catalog.items,
    } or vim.NIL,
  }
end

--- The catalog items a row matches: of its entry, or of every member of a folded run.
---@param pos integer
---@param e Casedesk.Logview.Entry
---@return integer[]|nil
local function known_of(pos, e)
  local c = S and S.catalog
  if not c then
    return nil
  end
  local n = e.rep and e.rep.n or 1
  local seen, out = {}, {}
  for p = pos, pos + n - 1 do
    for _, k in ipairs(c.by_entry[p] or {}) do
      if not seen[k] then
        seen[k] = true
        out[#out + 1] = k
      end
    end
  end
  table.sort(out)
  return #out > 0 and out or nil
end

--- The rows of the open log for the page's settings, and the groups of the side bar.
---@param p table|nil  `{ time, repeats, filters, delta_ms, gap_minutes }`
---@return table
local function view(p)
  local s = need_open()
  local set = view_settings(p)
  local doc = s.doc
  local clock = require("casedesk.logview.view.clock")
  local collapse = require("casedesk.logview.core.collapse")
  local nodes = require("casedesk.logview.view.nodes")

  -- Fold -> filter -> rows with a gap row where the log was quiet (`view.init`'s order).
  local list = set.repeats and collapse.run(doc.entries) or doc.entries
  local items, pos = {}, 1
  for k, e in ipairs(list) do
    items[k] = { pos = pos, e = e }
    pos = pos + (e.rep and e.rep.n or 1)
  end
  local h = make_filter(doc, s.tags, set.filters)
  items = h:apply(items)
  local shown = {}
  for k, it in ipairs(items) do
    shown[k] = it.e
  end
  local steps = clock.steps(shown, set.delta_ms, set.gap_ms)
  local base = clock.base(doc.entries)

  s.nodes = {}
  local ctx = node_ctx()
  local rows = {}
  local groups =
    { errors = {}, warnings = {}, exceptions = {}, gaps = {}, repeats = {}, known = {} }
  local known_rows = {}
  local unzoned = 0
  for k, it in ipairs(items) do
    local e = it.e
    local step = steps[k]
    if step and step.gap then
      local id = "g" .. it.pos
      local label = ("── %s without an entry ──"):format(clock.gap_text(step.gap))
      rows[#rows + 1] = { type = "gap", id = id, label = label, ms = step.gap, src = e.src }
      groups.gaps[#groups.gaps + 1] =
        { id = id, label = clock.gap_text(step.gap), time = clock.text(e, set.tz, base) }
    end
    local node = nodes.entry(it.pos, e, ctx)
    s.nodes[node.id] = node
    local level = level_of(doc, e)
    local time = clock.text(e, set.tz, base)
    if set.tz == "utc" and e.t_ms and not e.offset_min then
      unzoned = unzoned + 1
    end
    local known = known_of(it.pos, e)
    local row = {
      type = "entry",
      id = node.id,
      pos = it.pos,
      src = e.src,
      src_end = e.src_end,
      file = e.file or vim.NIL,
      tag = (s.tags and e.file) and s.tags[e.file] or vim.NIL,
      time = time,
      kind = e.kind or "",
      level = e.level or vim.NIL,
      class = level or vim.NIL,
      source = (e.source and e.source ~= "") and M.short_source(e.source) or vim.NIL,
      text = e.text,
      note = e.note or vim.NIL,
      rep = e.rep and collapse.label(e.rep) or vim.NIL,
      delta = step and step.delta or vim.NIL,
      known = known or vim.NIL,
      expandable = node.expandable == true,
      pagesource = node.data.pagesource and true or false,
      request = (e.dir ~= nil or e.kind == "REQ" or e.kind == "RESP"),
    }
    rows[#rows + 1] = row
    local ref = { id = node.id, time = time, text = e.text }
    if is_error(level) then
      groups.errors[#groups.errors + 1] = ref
    end
    if level == "warn" then
      groups.warnings[#groups.warnings + 1] = ref
    end
    local ex = exception_of(e)
    if ex then
      groups.exceptions[#groups.exceptions + 1] = { id = node.id, time = time, text = ex }
    end
    if e.rep then
      groups.repeats[#groups.repeats + 1] =
        { id = node.id, time = time, text = row.rep .. "  " .. e.text }
    end
    for _, ki in ipairs(known or {}) do
      local list_k = known_rows[ki]
      if not list_k then
        list_k = {}
        known_rows[ki] = list_k
      end
      list_k[#list_k + 1] = ref
    end
  end
  if s.catalog then
    for ki, item in ipairs(s.catalog.items) do
      if known_rows[ki] then
        local g = catalog_item(item, ki)
        g.rows = known_rows[ki]
        groups.known[#groups.known + 1] = g
      end
    end
  end
  local filter = require("casedesk.logview.view.filter")
  return {
    kind = "casedesk-web.view",
    schema = M.SCHEMA,
    rows = rows,
    groups = groups,
    status = {
      shown = #items,
      total = #doc.entries,
      filter = filter.summary(h.stack),
      time = set.tz,
      unzoned = unzoned,
      mode = s.mode,
    },
  }
end

--- What a node of the view unfolds to, in the page source mode `mode`.
---@param p table  `{ ids = { ... }, mode? }`
---@return table
local function children(p)
  local s = need_open()
  if type(p) ~= "table" or type(p.ids) ~= "table" then
    bad("params.ids (a list) is needed")
  end
  if p.mode ~= nil then
    local pagesource = require("casedesk.logview.core.pagesource")
    local ok = false
    for _, m in ipairs(pagesource.MODES) do
      ok = ok or m == p.mode
    end
    if not ok then
      bad("mode must be one of labelled, all, clickable")
    end
    s.mode = p.mode
  end
  local out = {}
  for _, id in ipairs(p.ids) do
    local node = s.nodes[id]
    if not node then
      bad("no node " .. tostring(id) .. " (view first)")
    end
    local kids = {}
    if type(node.children) == "function" then
      node.children(node, function(list)
        kids = list
      end)
    elseif type(node.children) == "table" then
      kids = node.children
    end
    local list = {}
    for k, n in ipairs(kids) do
      s.nodes[n.id] = n
      list[k] = node_out(n)
    end
    out[#out + 1] = { id = id, children = list }
  end
  return { kind = "casedesk-web.children", schema = M.SCHEMA, mode = s.mode, nodes = out }
end

--- The original lines `from` .. `to` of file `file` (1 without one), at most `MAX_ORIGINAL`.
---@param p table  `{ from, to, file? }`
---@return table
local function original(p)
  local s = need_open()
  if type(p) ~= "table" or type(p.from) ~= "number" or type(p.to) ~= "number" then
    bad("params.from and params.to are needed")
  end
  local f = p.file or 1
  local text = s.texts[f]
  if not text then
    bad("no file " .. tostring(f))
  end
  local lines = s.lines[f]
  if not lines then
    lines = require("casedesk.logview.core.entries").lines(text)
    s.lines[f] = lines
  end
  local from = math.max(1, math.floor(p.from))
  local to = math.min(#lines, math.floor(p.to), from + M.MAX_ORIGINAL - 1)
  local out = {}
  for i = from, to do
    out[#out + 1] = lines[i]
  end
  return {
    kind = "casedesk-web.original",
    schema = M.SCHEMA,
    file = f,
    name = s.doc.files and s.doc.files[f] and s.doc.files[f].path or s.doc.path,
    from = from,
    to = to,
    total = #lines,
    lines = out,
  }
end

--- One entry for the engine check: its head row and how many lines it unfolds to.
---@param e Casedesk.Logview.Entry
---@param normalize table
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

--- The reading copy of one log text in one piece (the engine check).
---@param text string
---@param name string
---@return table
function M.reading_copy(text, name)
  local doc = require("casedesk.logview.core.doc").build(text, name)
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

--- The methods of the door. `params` is the decoded `params` of the request, `blobs` the texts handed in beside it.
local METHODS = {
  hello = function()
    local api = vim.json.decode(require("casedesk.web.api").call('{"op":"version"}'))
    return {
      kind = "casedesk-web.hello",
      schema = M.SCHEMA,
      lua = _VERSION,
      jit = type(jit) == "table" and jit.version or vim.NIL,
      api = api.ok and api.result.version or vim.NIL,
    }
  end,
  reading_copy = function(params, blobs)
    if type(params) ~= "table" or type(params.name) ~= "string" or params.name == "" then
      bad("params.name (a string) is needed")
    end
    return M.reading_copy(blob(blobs, params.blob, "reading_copy"), params.name)
  end,
  open = open,
  view = view,
  children = children,
  original = original,
  close = function()
    S = nil
    return { kind = "casedesk-web.closed", schema = M.SCHEMA }
  end,
}

--- One call: the answer as "<code>\n<json>", code empty for an answer. Never throws: an error is an answer too
--- (`casedesk-web.error`), so the page always reads one JSON document.
---@param method string
---@param request string  JSON of `{ "params": {...} }`, or empty
---@param ... string  texts the request names by number (`blob = 1`)
---@return string
function M.door(method, request, ...)
  local blobs = { ... }
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
    return fn(params, blobs)
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
