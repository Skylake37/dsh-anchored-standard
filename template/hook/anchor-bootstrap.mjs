/**
 * anchor-bootstrap — one configurable gate for every anchored mode.
 *
 * Register this file as the FIRST row of a preset's agent.cordis.yml. It
 * replaces the previous three downstream hooks (`tool-bootstrap`,
 * `zero-tool-bootstrap`, `anchor-turn`) with a single plugin whose config
 * selects a validated mode profile:
 *
 *   anchored = firstTurnTools minimal + no anchor turn + subagents resident
 *   zero     = firstTurnTools empty   + test-notice anchor + subagents anchor
 *   whoami   = firstTurnTools empty   + whoami anchor + subagents anchor
 *
 * Behavior per session:
 *  - CONTROLLED PHASE (unpromoted): the first model request sees
 *    `bootstrapTools` when `firstTurnTools: minimal`, or ZERO tools when
 *    `firstTurnTools: empty` (the anchor-turn modes). Auto-injected
 *    workspace/skill context is stripped. If `anchorText != none`, this
 *    plugin prepends one synthetic user message ahead of the user's first
 *    real message; the anchor reply is the promotion signal.
 *  - PROMOTED PHASE: the catalog narrows to the RESIDENT set — the phase base
 *    (bootstrap tools, or shells + str_replace_editor) plus
 *    dev_tool_search / skill_search / skill_load plus every tool the model
 *    explicitly unlocked via dev_tool_search. The full preset catalog is NOT
 *    dumped at once (the 25-tool dump pulls the trajectory back to
 *    standard-like behavior).
 *  - COMPACTION: promotion is epoch-aware (compaction-epoch.mjs). After
 *    `compaction/end` the session falls back to the controlled phase until a
 *    NEW durable promotion signal exists past that boundary.
 *
 * Persona is phase-aware (downstream A' decision): while controlled the
 * persona carries `controlledPersonaText` (base + We-need opener only); after
 * promotion it carries `personaText` (base + opener + tool-unlock guidance).
 * The persona section is the ONLY assembled section and runtime contexts are
 * cleared for the WHOLE session.
 *
 * Optional output cap: `bootstrapMaxTokens` applies to every controlled
 * request (including a zero/whoami anchor request). After promotion the cap
 * is stripped explicitly, because the next request's seed proposal carries
 * the previous header's maxTokens forward.
 *
 * Ordering contract (keep this row FIRST in the composition):
 *  - Deliberately NO inject list: registered before dsh-agent-instructions
 *    and dsh-tool-skill, this plugin's `agent/pre-step` strip is the final
 *    waterfall transform and actually removes what those plugins inject.
 *  - Listeners register with `prepend: true` so the strip and the optional
 *    cap stay the outermost transforms even against host-plane listeners.
 *
 * Robustness:
 *  - A missing phase tool degrades to the full catalog with a one-time
 *    warning, so composition drift can never brick a session.
 *  - The pre-step context filter degrades to "keep everything" on failure.
 *  - Invalid config (unknown keys, bad enums, conflicting mode fields,
 *    malformed lists, non-positive cap) fails at apply time.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchor-bootstrap'

/** Deliberately NO inject list — see the ordering contract above. */
export const inject = []

/** The registry's persona section name (see @deepseek-ai/dsh-system-prompt). */
const PERSONA_SECTION = 'deployment:persona'

/** Discovery tools always resident after promotion (the tool-search pattern). */
const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']

/** Shell candidates for the zero-tool anchor modes (bash is custom-bash on Windows). */
const SHELLS = ['bash', 'pwsh']

/** Default synthetic anchor texts, by anchor flavor. */
export const ANCHOR_TEXTS = {
  'test-notice': 'This round is a test. Tools are not open yet; all tools will open next round.',
  whoami: '你是谁',
}

/** Named mode profiles; explicit atomic fields must agree with their mode. */
export const MODE_PROFILES = {
  anchored: { firstTurnTools: 'minimal', anchorText: 'none', subagents: 'resident', promoteOn: 'either' },
  zero: { firstTurnTools: 'empty', anchorText: 'test-notice', subagents: 'anchor', promoteOn: 'assistant-message' },
  whoami: { firstTurnTools: 'empty', anchorText: 'whoami', subagents: 'anchor', promoteOn: 'assistant-message' },
}

const FIRST_TURN_TOOLS = new Set(['empty', 'minimal'])
const ANCHOR_TEXTS_KEYS = new Set(Object.keys(ANCHOR_TEXTS))
const SUBAGENT_MODES = new Set(['resident', 'bootstrap', 'anchor'])

/** Whitelisted subagent policies per mode (the mode profile is the default). */
const MODE_SUBAGENT_WHITELIST = {
  anchored: new Set(['resident', 'bootstrap']),
  zero: new Set(['resident', 'anchor']),
  whoami: new Set(['anchor']),
}
const PROMOTE_ON_VALUES = new Set(['either', 'tool-call', 'assistant-message'])

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set([
  'mode',
  'firstTurnTools',
  'anchorText',
  'subagents',
  'bootstrapTools',
  'promoteOn',
  'bootstrapMaxTokens',
  'suppressedContextSources',
  'suppressedContextPlugins',
  'compactionTools',
  'personaText',
  'controlledPersonaText',
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

function enumValue(value, field, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new TypeError(`${name}: ${field} must be one of ${[...allowed].join(', ')}; got ${JSON.stringify(value)}`)
  }
  return value
}

function optionalEnum(value, field, allowed, fallback) {
  if (value === undefined) return fallback
  return enumValue(value, field, allowed)
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

/** Optional non-empty persona text; `undefined` means no swap. */
function optionalString(value, field) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name}: ${field} must be a non-empty string`)
  }
  return value
}

/** Optional positive output cap; `undefined` means no cap. */
function optionalPositiveInt(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

/**
 * Resolve the mode profile and its atomic fields. `mode` supplies defaults
 * (and defaults to `anchored`); explicitly supplied atomic fields must agree
 * with the selected profile, otherwise the mount fails loudly.
 */
function resolveProfile(config) {
  const mode = config.mode === undefined ? 'anchored' : enumValue(config.mode, 'mode', new Set(Object.keys(MODE_PROFILES)))
  const profile = MODE_PROFILES[mode]
  const firstTurnTools = optionalEnum(config.firstTurnTools, 'firstTurnTools', FIRST_TURN_TOOLS, profile.firstTurnTools)
  const anchorText = config.anchorText === undefined
    ? profile.anchorText
    : config.anchorText === 'none'
      ? 'none'
      : enumValue(config.anchorText, 'anchorText', ANCHOR_TEXTS_KEYS)
  const subagents = optionalEnum(config.subagents, 'subagents', SUBAGENT_MODES, profile.subagents)

  if (firstTurnTools !== profile.firstTurnTools) {
    throw new TypeError(`${name}: firstTurnTools ${JSON.stringify(firstTurnTools)} conflicts with mode ${JSON.stringify(mode)}`)
  }
  if (anchorText !== profile.anchorText) {
    throw new TypeError(`${name}: anchorText ${JSON.stringify(anchorText)} conflicts with mode ${JSON.stringify(mode)}`)
  }
  if (!MODE_SUBAGENT_WHITELIST[mode].has(subagents)) {
    throw new TypeError(`${name}: subagents ${JSON.stringify(subagents)} is not valid for mode ${JSON.stringify(mode)}`)
  }

  // Validated combination whitelist (unvalidated free combinations fail).
  if (anchorText === 'none') {
    if (firstTurnTools !== 'minimal') {
      throw new TypeError(`${name}: anchorText "none" requires firstTurnTools "minimal"`)
    }
    if (subagents === 'anchor') {
      throw new TypeError(`${name}: subagents "anchor" requires an anchorText mode (whoami)`)
    }
  } else {
    if (firstTurnTools !== 'empty') {
      throw new TypeError(`${name}: anchorText ${JSON.stringify(anchorText)} requires firstTurnTools "empty"`)
    }
    if (subagents === 'bootstrap') {
      throw new TypeError(`${name}: subagents "bootstrap" is only valid with anchorText "none"`)
    }
  }

  return { mode, firstTurnTools, anchorText, subagents, fixedPromoteOn: profile.promoteOn }
}

/** Register the per-session bootstrap filters and the optional anchor turn. */
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

  const profile = resolveProfile(source)
  const bootstrapTools = profile.firstTurnTools === 'minimal'
    ? stringList(source.bootstrapTools, 'bootstrapTools')
    : []
  const promoteOn = source.promoteOn === undefined ? profile.fixedPromoteOn : enumValue(source.promoteOn, 'promoteOn', PROMOTE_ON_VALUES)
  if (profile.anchorText !== 'none' && promoteOn !== 'assistant-message') {
    throw new TypeError(`${name}: promoteOn must be "assistant-message" when anchorText is ${JSON.stringify(profile.anchorText)}`)
  }
  const promoteEvents = PROMOTE_EVENTS[promoteOn]
  const bootstrapMaxTokens = optionalPositiveInt(source.bootstrapMaxTokens, 'bootstrapMaxTokens')
  const suppressedSources = sourceList(source.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  const suppressedPlugins = sourceList(source.suppressedContextPlugins, 'suppressedContextPlugins', [])
  const compactionTools = stringListOrEmpty(source.compactionTools, 'compactionTools')
  const personaText = optionalString(source.personaText, 'personaText')
  const controlledPersonaText = optionalString(source.controlledPersonaText, 'controlledPersonaText')

  const includeSubagents = profile.subagents !== 'resident'
  const promotion = createEpochPromotion(promoteEvents, { includeSubagents })
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
   * Replace the assembled system prompt with the persona section alone,
   * carrying the phase-appropriate text, and clear runtime contexts.
   */
  const applyPersona = (assembled, text) => {
    if (text === undefined) return assembled
    const sections = assembled.sections
    if (!Array.isArray(sections)) return assembled
    const index = sections.findIndex((section) => section.name === PERSONA_SECTION)
    // Some custom presets never register a persona row. Inserting the section
    // here keeps the phase-appropriate persona effective for them too; DSH
    // only restores a REGISTERED `complete` section after this waterfall, so a
    // missing section is safe to synthesize (the generator also strips
    // `complete: true` from a source persona row for the registered case).
    const persona = index === -1 ? { name: PERSONA_SECTION } : sections[index]
    const next = { ...assembled, sections: [{ ...persona, text }] }
    if (Array.isArray(assembled.contexts) && assembled.contexts.length > 0) next.contexts = []
    return next
  }

  /** Persona for one phase: controlled uses base+opener; promoted uses the full text. */
  const personaFor = (assembled, promoted) => {
    if (promoted) return applyPersona(assembled, personaText)
    return applyPersona(assembled, controlledPersonaText === undefined ? personaText : controlledPersonaText)
  }

  /** Make resident fallbacks visibly secondary after promotion, without changing the anchor surface. */
  const annotateResidentFallbacks = (tools) => tools.map((tool) => {
    if (!['bash', 'pwsh', 'str_replace_editor'].includes(tool.name)) return tool
    return {
      ...tool,
      description: `${tool.description}\n\nThis is a resident fallback; task-specific purpose-built tools are often unlockable through dev_tool_search and are usually the more direct path.`,
    }
  })

  /** Select the promoted resident set for the phase base. */
  const residentCatalog = (assembled, session) => {
    if (profile.mode === 'whoami') {
      const keep = new Set([...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(session)])
      const resident = keepTools(assembled, keep, false)
      return { ...resident, tools: annotateResidentFallbacks(resident.tools) }
    }

    const available = new Set(assembled.tools.map((tool) => tool.name))
    if (profile.firstTurnTools === 'minimal') {
      const keep = new Set([...bootstrapTools, ...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(session)])
      const resident = keepTools(assembled, keep, false)
      return { ...resident, tools: annotateResidentFallbacks(resident.tools) }
    }
    const selectedShells = SHELLS.filter((toolName) => available.has(toolName))
    if (selectedShells.length === 0) {
      warnOnce(`${name}: expected at least one resident shell; bootstrap disabled, full catalog exposed`)
      return assembled
    }
    const keep = new Set([...selectedShells, 'str_replace_editor', ...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(session)])
    return {
      ...assembled,
      tools: annotateResidentFallbacks(assembled.tools.filter((tool) => keep.has(tool.name))),
    }
  }

  /** Select the controlled catalog; the first request is the anchor surface. */
  const controlledCatalog = (assembled, boundary) => {
    if (profile.firstTurnTools === 'minimal') {
      const keep = new Set(bootstrapTools)
      if (boundary >= 0) for (const toolName of compactionTools) keep.add(toolName)
      return keepTools(assembled, keep, true)
    }
    // Zero-tool anchor: the very first request is empty. After a compaction
    // the model is mid-task and keeps shells + compactionTools.
    if (boundary < 0) return { ...assembled, tools: [] }
    if (compactionTools.length === 0) return { ...assembled, tools: [] }
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const selectedShells = SHELLS.filter((toolName) => available.has(toolName))
    const missing = compactionTools.filter((toolName) => !available.has(toolName))
    if (selectedShells.length === 0 || missing.length > 0) {
      warnOnce(
        `${name}: expected at least one phase shell and every phase tool; `
        + `shells=${JSON.stringify(selectedShells)}, missing=${JSON.stringify(missing)} — `
        + 'bootstrap disabled, full catalog exposed',
      )
      return assembled
    }
    const keep = new Set([...selectedShells, ...compactionTools])
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => keep.has(tool.name)),
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const status = promotion.status(context.agent)
      if (status.promoted) {
        return personaFor(residentCatalog(assembled, context.agent?.session), true)
      }
      return personaFor(controlledCatalog(assembled, status.boundary), false)
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Optional output cap for every controlled request. After promotion the cap
  // is stripped explicitly, because the next request's seed proposal carries
  // the previous header's maxTokens forward.
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

  // Seed the synthetic anchor turn for zero/whoami modes.
  if (profile.anchorText !== 'none') {
    const text = ANCHOR_TEXTS[profile.anchorText]
    const anchorSubagents = profile.subagents === 'anchor'
    const isFreshSession = (agent) => {
      if (!anchorSubagents && (agent.session.header?.delegationDepth ?? 0) > 0) return false
      return !agent.session.events.some((event) => event.type === 'user/message')
    }
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (!isFreshSession(agent)) return
      // Never re-anchor on plugin-sourced messages (including our own anchor).
      if (message.source?.kind === 'plugin') return
      agent.inbox.prepend('next-turn', {
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: 'zero-tool anchor turn',
        },
      })
    })
  }

  // Strip auto-injected context. The source kinds (skill-catalog,
  // agent-instructions) are stripped while controlled only; the plugin list
  // (default: the runtime-context snapshot) is stripped on EVERY request.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (suppressedSources.size === 0 && suppressedPlugins.size === 0) return decision
      if (!Array.isArray(decision.messages)) return decision
      const promoted = promotion.status(agent).promoted
      const kept = decision.messages.filter((message) => {
        const source = message?.source
        if (!promoted && typeof source?.kind === 'string' && suppressedSources.has(source.kind)) return false
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
