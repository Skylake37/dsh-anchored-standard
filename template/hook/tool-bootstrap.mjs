/**
 * Reusable anchored tool bootstrap hook — stamp this file into any preset and
 * register it as the FIRST row of the preset's agent.cordis.yml.
 *
 * Behavior per session:
 *  - Request #1 sees a pinned bootstrap tool surface, a capped output budget,
 *    and no auto-injected workspace/skill context.
 *  - After the session records its first durable promotion signal (default:
 *    the first `tool/call` OR the first `assistant/message`, whichever comes
 *    first), every later request sees the preset's own full catalog, the
 *    normal output budget, and context injections again.
 *  - The phase is derived from durable session events, so resume and reload
 *    preserve it; promotion decisions are memoized per session id per process.
 *
 * Config (all values come from the row that mounts this file):
 *  - `bootstrapTools: string[]` — exact first-request tool list. Use this for
 *    arbitrary presets (e.g. Minimal: `[persistent-bash]`).
 *  - `shellTools` + `commonTools` — legacy mode: exactly one available shell
 *    plus every common tool. The two modes are mutually exclusive.
 *  - `promoteOn: either | tool-call | assistant-message` (default `either`).
 *  - `bootstrapMaxTokens: positive int` (default 1024).
 *  - `suppressedContextSources: string[]` (default `skill-catalog`,
 *    `agent-instructions`) — first-step message kinds removed while
 *    bootstrapping. An explicitly empty array disables the context filter
 *    while keeping the tool bootstrap and the output cap. Config name follows
 *    upstream `preset/tool-bootstrap.mjs`.
 *  - `delegationDepthExempt: boolean` (default true) — subagents always see
 *    the full catalog; set false to bootstrap child sessions too.
 *
 * Ordering contract (keep this row FIRST in the composition):
 *  - This plugin deliberately has NO inject list. Registered before
 *    dsh-agent-instructions and dsh-tool-skill, its `agent/pre-step` strip is
 *    the final waterfall transform and actually removes what those plugins
 *    inject. An inject list here would let them re-inject after the strip.
 *  - The pre-step listener additionally registers with `prepend: true` (same
 *    as upstream), so the strip stays the outermost transform even against
 *    host-plane listeners and future row reordering.
 *
 * Robustness:
 *  - A bootstrap tool missing from the assembled catalog degrades to the full
 *    catalog with a one-time warning, so composition drift can never brick a
 *    session.
 *  - The pre-step context filter degrades to "keep everything" on failure:
 *    a filter bug must never eat the user's context.
 *  - Invalid config fails at apply time, i.e. at preset mount.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-tool-bootstrap'

/** Deliberately NO inject list — see the ordering contract above. */
export const inject = []

const DEFAULT_BOOTSTRAP_MAX_TOKENS = 1024
const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/**
 * Validate the suppressed context sources. Unlike the bootstrap tool lists,
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

function positiveInt(value, field, fallback) {
  if (value === undefined) return fallback
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

/** Which filter mode this mount uses, validated once at apply time. */
function parseBootstrapFilter(config) {
  const hasExact = config.bootstrapTools !== undefined
  const hasLegacy = config.shellTools !== undefined || config.commonTools !== undefined
  if (hasExact && hasLegacy) {
    throw new TypeError(`${name}: use either bootstrapTools or shellTools+commonTools, not both`)
  }
  if (hasExact) {
    return { kind: 'exact', tools: stringList(config.bootstrapTools, 'bootstrapTools') }
  }
  if (config.shellTools !== undefined && config.commonTools !== undefined) {
    return {
      kind: 'legacy',
      shellTools: stringList(config.shellTools, 'shellTools'),
      commonTools: stringList(config.commonTools, 'commonTools'),
    }
  }
  if (hasLegacy) {
    throw new TypeError(`${name}: shellTools and commonTools must be provided together`)
  }
  throw new TypeError(`${name}: bootstrapTools (or shellTools+commonTools) is required`)
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  const filter = parseBootstrapFilter(config)
  const promoteEvents = parsePromoteOn(config.promoteOn)
  const bootstrapMaxTokens = positiveInt(config.bootstrapMaxTokens, 'bootstrapMaxTokens', DEFAULT_BOOTSTRAP_MAX_TOKENS)
  const suppressedSources = sourceList(config.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  const delegationDepthExempt = optionalBool(config.delegationDepthExempt, 'delegationDepthExempt', true)

  /** Sessions already promoted in this process. Promotion is append-only, so a Set is sound. */
  const promoted = new Set()
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
   * Whether the session has reached the promoted phase.
   * @param agent - the assembly context's agent, or undefined outside an agent.
   */
  const isPromoted = (agent) => {
    if (agent === undefined) return true
    const session = agent.session
    if (session === undefined) return true
    if (delegationDepthExempt && (session.header.delegationDepth ?? 0) > 0) return true
    if (promoted.has(session.id)) return true
    const hit = session.events.some((event) => promoteEvents.includes(event.type))
    if (hit) promoted.add(session.id)
    return hit
  }

  /** Narrow the assembled catalog to the pinned bootstrap surface. */
  const applyBootstrap = (assembled) => {
    if (filter.kind === 'exact') {
      const available = new Set(assembled.tools.map((tool) => tool.name))
      const missing = filter.tools.filter((toolName) => !available.has(toolName))
      if (missing.length > 0) {
        warnOnce(
          `${name}: bootstrap tools missing from the assembled catalog; `
          + `missing=${JSON.stringify(missing)} — bootstrap disabled, full catalog exposed`,
        )
        return assembled
      }
      const bootstrap = new Set(filter.tools)
      return {
        ...assembled,
        tools: assembled.tools.filter((tool) => bootstrap.has(tool.name)),
      }
    }
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const selectedShells = filter.shellTools.filter((toolName) => available.has(toolName))
    const missingCommon = filter.commonTools.filter((toolName) => !available.has(toolName))
    if (selectedShells.length !== 1 || missingCommon.length > 0) {
      warnOnce(
        `${name}: expected exactly one bootstrap shell and every common tool; `
        + `shells=${JSON.stringify(selectedShells)}, missing=${JSON.stringify(missingCommon)} — `
        + 'bootstrap disabled, full catalog exposed',
      )
      return assembled
    }
    const bootstrap = new Set([...selectedShells, ...filter.commonTools])
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => bootstrap.has(tool.name)),
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      if (isPromoted(context.agent)) return assembled
      return applyBootstrap(assembled)
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Cap the first model request's output budget while bootstrapping.
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const agent = payload.agent
    if (isPromoted(agent)) {
      // The next request's seed proposal carries the previous header's
      // maxTokens forward, so the injected cap must be stripped explicitly —
      // otherwise it would persist for the whole session.
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
  })

  // Strip auto-injected first-step context during bootstrap. Registered first
  // (ordering contract) and prepended (same as upstream), this strip is the
  // final waterfall transform and removes what later listeners inject.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (isPromoted(agent) || suppressedSources.size === 0) return decision
      if (!Array.isArray(decision.messages)) return decision
      const kept = decision.messages.filter((message) => {
        const kind = message?.source?.kind
        return typeof kind !== 'string' || !suppressedSources.has(kind)
      })
      return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
    } catch (error) {
      // A filter bug must never eat context: degrade to keeping every message.
      warnOnce(`${name}: pre-step context filter failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
