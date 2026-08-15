/**
 * Reusable anchored tool bootstrap hook — stamp this file into any preset and
 * register it as the FIRST row of the preset's agent.cordis.yml.
 *
 * Behavior per session:
 *  - Request #1 sees the pinned bootstrap tool surface (default upstream
 *    finding: the official Minimal preset's real pair — persistent `bash` +
 *    `str_replace_editor`) and no auto-injected workspace/skill context.
 *  - After the session records its first durable promotion signal (default:
 *    the first `tool/call` OR the first `assistant/message`, whichever comes
 *    first), every later request sees the preset's own full catalog and the
 *    normal context injections again.
 *  - The phase is derived from durable session events, so resume and reload
 *    preserve it; promotion decisions are memoized per session id per process.
 *
 * Config (all values come from the row that mounts this file):
 *  - `bootstrapTools: string[]` — required exact first-request tool list.
 *  - `promoteOn: either | tool-call | assistant-message` (default `either`).
 *  - `bootstrapMaxTokens: positive int` — OPT-IN first-request output cap.
 *    Omit it to let the adapter default flow: the Minimal tool schema anchors
 *    at the adapter-default maxTokens without a cap (upstream issue #11).
 *    When set, the cap is registered with `prepend` and stripped after
 *    promotion.
 *  - `suppressedContextSources: string[]` (default `skill-catalog`,
 *    `agent-instructions`) — first-step message kinds removed while
 *    bootstrapping. An explicitly empty array disables the context filter
 *    while keeping the tool bootstrap. Config name follows upstream
 *    `preset/tool-bootstrap.mjs`.
 *  - `suppressedContextPlugins: string[]` (default []) — first-step messages
 *    whose `source.plugin` is listed here are ALSO removed while
 *    bootstrapping (defaults stamped by the generator: the runtime-context
 *    snapshot from `@deepseek-ai/dsh-system-prompt`). Restored from request
 *    #2 on.
 *  - `bootstrapPersonaText: string` (default unset) — while bootstrapping,
 *    the `deployment:persona` section is replaced with this text; after
 *    promotion the preset's own persona returns. Stamped by the generator
 *    as the Minimal persona line so request #1 carries the same system
 *    prompt as the upstream anchored preset. NOTE: only takes effect for
 *    personas that are NOT `complete` — a complete persona is restored by
 *    the registry after this waterfall and cannot be swapped.
 *  - `delegationDepthExempt: boolean` (default true) — subagents always see
 *    the full catalog; set false to bootstrap child sessions too.
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
 *  - Invalid config fails at apply time, i.e. at preset mount.
 */

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
  const bootstrapTools = stringList(config.bootstrapTools, 'bootstrapTools')
  const promoteEvents = parsePromoteOn(config.promoteOn)
  const bootstrapMaxTokens = optionalPositiveInt(config.bootstrapMaxTokens, 'bootstrapMaxTokens')
  const suppressedSources = sourceList(config.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  const suppressedPlugins = sourceList(config.suppressedContextPlugins, 'suppressedContextPlugins', [])
  const bootstrapPersonaText = optionalString(config.bootstrapPersonaText, 'bootstrapPersonaText')
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

  /** Narrow the assembled catalog to the pinned bootstrap tool set. */
  const applyBootstrap = (assembled) => {
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const missing = bootstrapTools.filter((toolName) => !available.has(toolName))
    if (missing.length > 0) {
      warnOnce(
        `${name}: expected every bootstrap tool; missing=${JSON.stringify(missing)} — `
        + 'bootstrap disabled, full catalog exposed',
      )
      return assembled
    }
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => bootstrapTools.includes(tool.name)),
    }
  }

  /**
   * Swap the persona section to the bootstrap persona while unpromoted, so
   * request #1 carries the same system prompt as the upstream anchored
   * preset. The registry reassembles every request from its own sections, so
   * "restore after promotion" is automatic: the swap simply stops applying.
   */
  const applyBootstrapPersona = (assembled) => {
    if (bootstrapPersonaText === undefined) return assembled
    const index = assembled.sections.findIndex((section) => section.name === PERSONA_SECTION)
    if (index === -1 || assembled.sections[index].text === bootstrapPersonaText) return assembled
    const sections = assembled.sections.slice()
    sections[index] = { ...sections[index], text: bootstrapPersonaText }
    return { ...assembled, sections }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      if (isPromoted(context.agent)) return assembled
      return applyBootstrapPersona(applyBootstrap(assembled))
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Optionally cap the first model request's output budget while bootstrapping.
  // Omitted (`undefined`) means the adapter default flows — the Minimal tool
  // schema anchors at 256000 without a cap (upstream issue #11).
  if (bootstrapMaxTokens !== undefined) {
    // prepend: true keeps this listener the OUTERMOST transform of the
    // agent/request waterfall (upstream PR #13), so a later listener can
    // never override the first-round budget after we set it.
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
    }, { prepend: true })
  }

  // Strip auto-injected first-step context during bootstrap. Registered first
  // (ordering contract) and prepended (upstream parity), this strip is the
  // final waterfall transform and removes what later listeners inject.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (isPromoted(agent) || (suppressedSources.size === 0 && suppressedPlugins.size === 0)) return decision
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
