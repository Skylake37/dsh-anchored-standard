/**
 * Reusable anchored tool bootstrap — stamp this file into any preset and
 * register it as the FIRST row of the preset's agent.cordis.yml.
 *
 * Behavior per session (mirrors upstream preset/tool-bootstrap.mjs, with the
 * downstream template extensions listed below):
 *  - While the session is in the controlled phase, request #1 sees the pinned
 *    bootstrap tool surface (default upstream finding: the official Minimal
 *    preset's real pair — persistent `bash` + `str_replace_editor`) and no
 *    auto-injected workspace/skill context.
 *  - After the session records its first durable promotion signal (default:
 *    the first `tool/call` OR the first `assistant/message`, whichever comes
 *    first), later requests see the promoted RESIDENT catalog — the bootstrap
 *    pair PLUS the discovery tools (`dev_tool_search`, `skill_search`,
 *    `skill_load`) PLUS whatever the model explicitly unlocked through
 *    `dev_tool_search`. The full preset catalog is NOT dumped at once, because
 *    the 25-tool dump pulls the trajectory back to standard-like behavior;
 *    heavier tools stay one `dev_tool_search` call away.
 *  - Promotion is epoch-aware (upstream compaction-epoch): after
 *    `compaction/end` the session falls back to the controlled phase — the
 *    bootstrap pair plus `compactionTools` — until a NEW durable promotion
 *    signal exists past that boundary. The first post-compaction request is a
 *    "second first request".
 *  - Subagents are always promoted by default; set `delegationDepthExempt:
 *    false` to make them follow the same bootstrap phase.
 *
 * Downstream template extensions:
 *  - `bootstrapPersonaText`: while controlled, the `deployment:persona`
 *    section is replaced with this text AND every other section is dropped,
 *    so the request carries the same clean system prompt as the upstream
 *    anchored preset (persona section only). After promotion the preset's own
 *    sections return. NOTE: only takes effect for personas that are NOT
 *    `complete` — a complete persona is restored by the registry after this
 *    waterfall and cannot be swapped; for complete personas the sections are
 *    left untouched (their persona is already the only section the registry
 *    will keep).
 *  - `suppressedContextPlugins`: controlled-phase messages whose
 *    `source.plugin` is listed here are ALSO removed (defaults stamped by the
 *    generator: the runtime-context snapshot from
 *    `@deepseek-ai/dsh-system-prompt`).
 *
 * Ordering contract (keep this row FIRST in the composition):
 *  - This plugin deliberately has NO inject list. Registered before
 *    dsh-agent-instructions and dsh-tool-skill, its `agent/pre-step` strip is
 *    the final waterfall transform and actually removes what those plugins
 *    inject. An inject list here would let them re-inject after the strip.
 *  - Both listeners register with `prepend: true` (upstream PRs #10/#13), so
 *    the strip and the optional budget cap stay the outermost transforms even
 *    against host-plane listeners and future row reordering.
 *
 * Robustness:
 *  - A bootstrap tool missing from the assembled catalog degrades to the full
 *    catalog with a one-time warning, so composition drift can never brick a
 *    session.
 *  - The pre-step context filter degrades to "keep everything" on failure:
 *    a filter bug must never eat the user's context.
 *  - Invalid config — bad tool lists, unknown keys, unknown `promoteOn`,
 *    malformed suppressed lists, non-positive `bootstrapMaxTokens` — fails at
 *    apply time, i.e. at preset mount.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-tool-bootstrap'

/** Deliberately NO inject list — see the ordering contract above. */
export const inject = []

const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** The registry's persona section name (see @deepseek-ai/dsh-system-prompt). */
const PERSONA_SECTION = 'deployment:persona'

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Discovery tools always resident after promotion (the tool-search pattern). */
const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set([
  'bootstrapTools',
  'promoteOn',
  'bootstrapMaxTokens',
  'suppressedContextSources',
  'suppressedContextPlugins',
  'compactionTools',
  'delegationDepthExempt',
  'bootstrapPersonaText',
])

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  return stringList(value, field)
}

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/**
 * Validate the suppressed context sources. Unlike the bootstrap tool list,
 * an explicitly empty array is meaningful: it disables the context filter
 * while keeping the tool bootstrap.
 */
function sourceList(value, field, fallback) {
  if (value === undefined) return new Set(fallback)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

/**
 * Validate the optional first-request output cap. `undefined` means NO cap:
 * the Minimal tool schema anchors at the adapter-default maxTokens (upstream
 * issue #11), so the cap is opt-in rather than the default.
 */
function optionalPositiveInt(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

function optionalBool(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name}: ${field} must be a boolean`)
  }
  return value
}

/** Optional non-empty bootstrap persona text; `undefined` means no swap. */
function optionalString(value, field) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name}: ${field} must be a non-empty string`)
  }
  return value
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(
      `${name}: unknown config key(s) ${unknown.join(', ')} — allowed keys: ${[...ALLOWED_KEYS].sort().join(', ')}`,
    )
  }

  const bootstrapTools = stringList(source.bootstrapTools, 'bootstrapTools')
  const promoteEvents = parsePromoteOn(source.promoteOn)
  const bootstrapMaxTokens = optionalPositiveInt(source.bootstrapMaxTokens, 'bootstrapMaxTokens')
  const suppressedSources = sourceList(source.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  const suppressedPlugins = sourceList(source.suppressedContextPlugins, 'suppressedContextPlugins', [])
  // Core work set exposed after a compaction, before re-promotion. Empty
  // means "no compaction recovery catalog": the session stays on the
  // bootstrap pair until a new promotion signal.
  const compactionTools = stringListOrEmpty(source.compactionTools, 'compactionTools')
  const delegationDepthExempt = optionalBool(source.delegationDepthExempt, 'delegationDepthExempt', true)
  const bootstrapPersonaText = optionalString(source.bootstrapPersonaText, 'bootstrapPersonaText')

  const promotion = createEpochPromotion(promoteEvents, { includeSubagents: !delegationDepthExempt })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  /**
   * Tool names the model explicitly unlocked via `dev_tool_search` for one
   * session. Derived from durable `tool/call` events so resume/reload keeps
   * them. The event's `arguments` is the raw JSON string the model produced;
   * parse it defensively and read the `toolNames` array.
   */
  const unlockedFor = (session) => {
    const unlocked = new Set()
    if (session === undefined || !Array.isArray(session.events)) return unlocked
    for (const event of session.events) {
      if (event.type !== 'tool/call') continue
      if (event.data?.name !== 'dev_tool_search') continue
      let args
      try {
        args = JSON.parse(event.data.arguments)
      } catch {
        continue
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
      const names = args.toolNames
      if (Array.isArray(names)) for (const name of names) if (typeof name === 'string' && name.length > 0) unlocked.add(name)
    }
    return unlocked
  }

  /** Narrow the assembled catalog to a keep-set; validate required names. */
  const keepTools = (assembled, keep, missingAllowsFullCatalog) => {
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const missing = [...keep].filter((toolName) => !available.has(toolName))
    if (missing.length > 0) {
      warnOnce(
        `${name}: expected every phase tool; missing=${JSON.stringify(missing)} — `
        + (missingAllowsFullCatalog ? 'bootstrap disabled, full catalog exposed' : 'continuing with what is available'),
      )
      if (missingAllowsFullCatalog) return assembled
    }
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => keep.has(tool.name)),
    }
  }

  /**
   * Reduce the assembled prompt to the clean Minimal system prompt while
   * controlled: the persona section alone, carrying the bootstrap text, and
   * no runtime contexts. "Restore after promotion" is automatic: the swap
   * simply stops applying once the session promotes.
   */
  const applyBootstrapPrompt = (assembled) => {
    if (bootstrapPersonaText === undefined) return assembled
    const sections = assembled.sections
    if (!Array.isArray(sections)) return assembled
    const index = sections.findIndex((section) => section.name === PERSONA_SECTION)
    if (index === -1) return assembled
    const persona = { ...sections[index], text: bootstrapPersonaText }
    const next = { ...assembled, sections: [persona] }
    if (Array.isArray(assembled.contexts) && assembled.contexts.length > 0) next.contexts = []
    return next
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const status = promotion.status(context.agent)
      if (status.promoted) {
        // PROMOTED: keep the minimal resident set — the bootstrap pair + the
        // discovery tools + whatever the model explicitly unlocked via
        // dev_tool_search — instead of dumping the whole catalog at once.
        const keep = new Set([...bootstrapTools, ...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(context.agent?.session)])
        return keepTools(assembled, keep, false)
      }
      // Controlled phase: the bootstrap pair; after a compaction, plus the
      // compaction work set so mid-task work can continue.
      const keep = new Set(bootstrapTools)
      const { boundary } = status
      if (boundary >= 0) for (const toolName of compactionTools) keep.add(toolName)
      return applyBootstrapPrompt(keepTools(assembled, keep, true))
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Optionally cap the model request's output budget while the session is
  // controlled. Unset (`bootstrapMaxTokens` omitted) means the adapter default
  // flows — the Minimal tool schema anchors at 256000 without a cap (upstream
  // issue #11). After promotion (or after a compaction until re-promotion) the
  // cap is stripped explicitly, because the next request's seed proposal
  // carries the previous header's maxTokens forward.
  if (bootstrapMaxTokens !== undefined) {
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      const agent = payload.agent
      if (promotion.status(agent).promoted) {
        if (resolved.maxTokens === bootstrapMaxTokens) {
          const { maxTokens: _bootstrap, ...rest } = resolved
          return rest
        }
        return resolved
      }
      return {
        ...resolved,
        maxTokens: bootstrapMaxTokens,
      }
    }, { prepend: true })
  }

  // Strip auto-injected context while controlled. Registered first (ordering
  // contract) and prepended (upstream parity), this strip is the final
  // waterfall transform and removes what later listeners inject.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (promotion.status(agent).promoted || (suppressedSources.size === 0 && suppressedPlugins.size === 0)) return decision
      if (!Array.isArray(decision.messages)) return decision
      const kept = decision.messages.filter((message) => {
        const source = message?.source
        if (typeof source?.kind === 'string' && suppressedSources.has(source.kind)) return false
        if (typeof source?.plugin === 'string' && suppressedPlugins.has(source.plugin)) return false
        return true
      })
      return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
    } catch (error) {
      // A filter bug must never eat context: degrade to keeping every message.
      warnOnce(`${name}: pre-step context filter failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
