/**
 * dev-tool-search — on-demand tool discovery and unlock, the tool-search
 * pattern for the anchored preset.
 *
 * The promoted phase keeps only a minimal resident set (shell +
 * str_replace_editor + the discovery tools) instead of dumping the whole
 * Standard catalog at once. This plugin registers ONE small tool:
 *
 *  - `dev_tool_search` — list or search the FULL assembled catalog (the
 *    executing agent's scope, so every preset-provided tool is visible) and
 *    optionally unlock tools by exact name (array `toolNames`). Unlocked
 *    names are recorded as durable `tool/call` arguments, and
 *    tool-bootstrap.mjs's assemble filter exposes them from the next request
 *    on (resume-safe).
 *
 * Usage design (user-measured): the model must be able to answer "what is
 *  - call with NO query (or `query: "*"`) to list EVERY unlockable tool name;
 *  - call with ONE keyword to search;
 *  - unlock only exact names from that list via `toolNames`.
 * Unknown unlock names are reported back explicitly instead of being
 * silently ignored, so the model can correct its spelling instead of
 * concluding the tool does not exist.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dev-tool-search'

/** The tools registry must exist before this tool can register. */
export const inject = ['tools']

const MAX_RESULTS = 40
const MAX_LIST_RESULTS = 80

/** Minimal JSON schema compiler for tool parameters (zero dependencies). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * The capability index: resident minimal tools (bash / str_replace_editor /
 * skill_search / skill_load) cannot cover these, so the model must search
 * and unlock them on demand. Kept in the description so the model KNOWS what
 * exists without a full catalog dump.
 */
const UNLOCKABLE_INDEX = [
  'web_search — internet search and web retrieval',
  'subagent / subagent_fork — delegate work to sub-agents',
  'workflow — run multi-agent workflow scripts',
  'ralph — fresh-agent iterative loop',
  'create_goal / get_goal / update_goal — long-running goals',
  'read_image — read image files',
  'job_list / job_output / job_kill — background jobs',
  'interrupt_agent / send_message / list_agents — multi-agent control',
  'todo_write — task tracking',
  'ask_user_question — ask the user',
]

/** First description line for one catalog entry. */
function firstLine(text) {
  return (text || '').split('\n')[0].slice(0, 90)
}

/**
 * Keyword search over the full catalog. OR semantics with a match-score:
 * every token that appears in the name/description contributes one point, so
 * multi-word queries no longer collapse to "no matches"; the best partial
 * matches come first.
 */
function searchSchemas(schemas, query, limit) {
  const wanted = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
  const scored = schemas.map((schema) => {
    const name = schema.name.toLowerCase()
    const haystack = `${name} ${(schema.description ?? '').toLowerCase()}`
    let score = 0
    for (const token of wanted) {
      if (name.includes(token)) score += 2
      else if (haystack.includes(token)) score += 1
    }
    return { schema, score }
  })
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.schema.name.localeCompare(b.schema.name))
    .slice(0, limit)
    .map((entry) => entry.schema)
}

/** Register the model-facing `dev_tool_search` tool. */
export function apply(ctx) {
  ctx.tools.register({
    name: 'dev_tool_search',
    description: [
      'Discover and unlock tools that are NOT currently available.',
      '',
      'This session starts with a minimal resident set: bash, str_replace_editor, skill_search, skill_load. Every other tool exists but is LOCKED; it becomes available only after you unlock it here.',
      '',
      'If the current task needs any of the following, call dev_tool_search FIRST — do not try to work around them with bash:',
      ...UNLOCKABLE_INDEX.map((line) => `- ${line}`),
      '',
      'Usage: call with NO query (or query "*") to list EVERY unlockable tool name; call with ONE keyword (e.g. "subagent") to search; then unlock exact names with toolNames. Do NOT search several names at once and do NOT assume a tool is unavailable just because a search returned nothing — list first.',
    ].join('\n'),
    parameters: toJsonSchema({
      query: { type: 'string', required: false, description: 'ONE search keyword (e.g. "subagent", "web"); omit or use "*" to list every unlockable tool' },
      toolNames: { type: 'array', required: false, description: 'exact tool names to unlock, taken from the list above', items: { type: 'string' } },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const unlock = Array.isArray(args.toolNames) ? args.toolNames.filter((name) => typeof name === 'string' && name.length > 0) : []
      const lines = []

      // The executing agent IS the viewing scope: preset tools register into
      // the agent-scope layer of the tools registry, and schemas() with no
      // scope only sees the global layer — every preset-provided tool would
      // be invisible to keyword search (issue #24). Same pattern as the
      // harness's own code mode (`registry.schemas(exec.agent)`).
      const schemas = ctx.tools.schemas(exec?.agent)
      const known = new Set(schemas.map((schema) => schema.name))

      if (unlock.length > 0) {
        const valid = unlock.filter((name) => known.has(name))
        const unknown = unlock.filter((name) => !known.has(name))
        if (valid.length > 0) lines.push(`Unlocked for the next request: ${valid.join(', ')}`)
        if (unknown.length > 0) {
          lines.push(`Unknown names (NOT unlocked): ${unknown.join(', ')} — call without query to list every unlockable name.`)
        }
      }

      if (query.length === 0 && unlock.length === 0) {
        const listed = [...schemas].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_LIST_RESULTS)
        lines.push(`All unlockable tools (${listed.length}):`)
        for (const schema of listed) lines.push(`- ${schema.name}: ${firstLine(schema.description)}`)
        lines.push('Unlock with dev_tool_search({"toolNames": ["<exact name>"]}).')
        return { text: lines.join('\n') }
      }
      if (query.length === 0) {
        return { text: lines.join('\n') || 'Nothing to do.' }
      }

      try {
        if (query === '*') {
          const listed = [...schemas].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_LIST_RESULTS)
          lines.push(`All unlockable tools (${listed.length}):`)
          for (const schema of listed) lines.push(`- ${schema.name}: ${firstLine(schema.description)}`)
          lines.push('Unlock with dev_tool_search({"toolNames": ["<exact name>"]}).')
        } else {
          const matches = searchSchemas(schemas, query, MAX_RESULTS)
          if (matches.length === 0) {
            lines.push(`No tools match "${query}" — call dev_tool_search with NO query to list every unlockable tool.`)
          } else {
            lines.push(`Matching tools (${matches.length}):`)
            for (const schema of matches) lines.push(`- ${schema.name}: ${firstLine(schema.description)}`)
            lines.push('Unlock with dev_tool_search({"toolNames": ["<exact name>"]}).')
          }
        }
      } catch (error) {
        lines.push(`catalog search unavailable: ${String((error && error.message) || error)}`)
      }
      return { text: lines.join('\n') }
    },
  })
}
