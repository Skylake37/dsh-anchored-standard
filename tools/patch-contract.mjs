/**
 * Patch-oriented preset contract.
 *
 * This module is deliberately pure: it validates a layer composition and
 * compiles the supported session-phase patch into the legacy anchor-bootstrap
 * options. It does not write preset files and does not silently ignore future
 * layers; unsupported mechanisms fail loudly.
 */

export const PATCH_API_VERSION = 'dsh-anchored/v2'

export const PATCH_LAYERS = Object.freeze([
  'sessionPhase',
  'contextGate',
  'toolBootstrap',
  'anchor',
  'instructionHint',
  'turnOpening',
  'toolExecution',
  'sessionSeed',
  'gateway',
])

export const SUPPORTED_PATCH_LAYERS = Object.freeze([
  'sessionPhase',
  'contextGate',
  'toolBootstrap',
  'anchor',
  'instructionHint',
])

export const CANONICAL_ROW_ORDER = Object.freeze([
  'context-gate',
  'session-seed',
  'tool-bootstrap',
  'zero-tool-bootstrap',
  'anchor-turn',
  'anchor-bootstrap',
  'persona',
  'instruction-hint',
  'dev-tool-search',
  'skill-search',
  'turn-opening',
  'tool-execution',
  'compaction',
  'gateway',
])

const MODES = new Set(['anchored', 'zero', 'whoami'])
const PROMOTE_ON = new Set(['either', 'tool-call', 'assistant-message'])
const PRESERVE = new Set(['persona', 'tools', 'mcp', 'cordis', 'permissions', 'compaction'])
const ANCHOR_FOR_MODE = Object.freeze({
  anchored: 'none',
  zero: 'test-notice',
  whoami: 'whoami',
})
const FIRST_TOOLS_FOR_MODE = Object.freeze({ anchored: 'minimal', zero: 'empty', whoami: 'empty' })
const DEFAULT_DISCOVERY = Object.freeze(['dev_tool_search', 'skill_search', 'skill_load'])
const DEFAULT_COMPACTION_TOOLS = Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question'])

function object(value, field) {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`)
  }
  return value
}

function string(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`)
  return value
}

function stringList(value, field, fallback = []) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${field} must be an array of non-empty strings`)
  }
  return [...value]
}

function boolean(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean`)
  return value
}

function positiveInteger(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive integer`)
  return value
}

function rejectUnknown(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new TypeError(`${field} has unknown key(s): ${unknown.join(', ')}`)
}

function enabled(value, field) {
  return boolean(value?.enabled, `${field}.enabled`, false)
}

/** Normalize and validate the public patch document. */
export function normalizePatchProfile(input) {
  const root = object(input, 'patch')
  const source = root.patch === undefined ? root : object(root.patch, 'patch.patch')
  rejectUnknown(source, new Set(['apiVersion', 'backend', 'from', 'to', 'name', 'description', 'mode', 'preserve', 'hooks']), 'patch')

  const apiVersion = source.apiVersion ?? PATCH_API_VERSION
  const backend = source.backend ?? 'legacy'
  if (!new Set(['legacy', 'layered']).has(backend)) throw new TypeError('patch.backend must be legacy or layered')
  if (apiVersion !== PATCH_API_VERSION) throw new TypeError(`patch.apiVersion must be ${PATCH_API_VERSION}`)
  const from = string(source.from, 'patch.from')
  const mode = source.mode ?? 'anchored'
  if (!MODES.has(mode)) throw new TypeError(`patch.mode must be one of ${[...MODES].join(', ')}`)

  const preserve = source.preserve === undefined
    ? [...PRESERVE]
    : stringList(source.preserve, 'patch.preserve')
  for (const item of preserve) if (!PRESERVE.has(item)) throw new TypeError(`patch.preserve contains unsupported layer ${item}`)

  const hooks = object(source.hooks, 'patch.hooks')
  rejectUnknown(hooks, new Set(PATCH_LAYERS), 'patch.hooks')
  const sessionPhase = object(hooks.sessionPhase, 'patch.hooks.sessionPhase')
  rejectUnknown(sessionPhase, new Set(['promoteOn', 'includeSubagents', 'compactionReset']), 'patch.hooks.sessionPhase')
  const promoteOn = sessionPhase.promoteOn ?? (mode === 'anchored' ? 'either' : 'assistant-message')
  if (!PROMOTE_ON.has(promoteOn)) throw new TypeError(`patch.hooks.sessionPhase.promoteOn is invalid`)
  if (mode !== 'anchored' && promoteOn !== 'assistant-message') {
    throw new TypeError(`${mode} requires sessionPhase.promoteOn assistant-message`)
  }

  const contextGate = object(hooks.contextGate, 'patch.hooks.contextGate')
  rejectUnknown(contextGate, new Set(['enabled', 'runtimeContexts', 'messagePolicy', 'allowKinds', 'suppressedContextSources', 'suppressedContextPlugins']), 'patch.hooks.contextGate')
  const contextGateEnabled = boolean(contextGate.enabled, 'patch.hooks.contextGate.enabled', true)
  const runtimeContexts = contextGate.runtimeContexts ?? 'deny-before-promotion'
  if (!new Set(['deny-before-promotion', 'pass']).has(runtimeContexts)) throw new TypeError('patch.hooks.contextGate.runtimeContexts is invalid')
  const messagePolicy = contextGate.messagePolicy ?? 'claimed-baseline'
  if (!new Set(['claimed-baseline', 'pass']).has(messagePolicy)) throw new TypeError('patch.hooks.contextGate.messagePolicy is invalid')

  const toolBootstrap = object(hooks.toolBootstrap, 'patch.hooks.toolBootstrap')
  rejectUnknown(toolBootstrap, new Set(['firstTurnTools', 'bootstrapTools', 'promotedTools', 'promotedFallbackTools', 'unlockPolicy', 'compactionTools', 'bootstrapMaxTokens']), 'patch.hooks.toolBootstrap')
  const firstTurnTools = toolBootstrap.firstTurnTools ?? FIRST_TOOLS_FOR_MODE[mode]
  if (firstTurnTools !== FIRST_TOOLS_FOR_MODE[mode]) throw new TypeError(`${mode} requires firstTurnTools ${FIRST_TOOLS_FOR_MODE[mode]}`)
  const unlockPolicy = toolBootstrap.unlockPolicy ?? 'explicit'
  if (!new Set(['explicit', 'seeded']).has(unlockPolicy)) throw new TypeError('patch.hooks.toolBootstrap.unlockPolicy is invalid')
  const bootstrapTools = stringList(toolBootstrap.bootstrapTools, 'patch.hooks.toolBootstrap.bootstrapTools', ['bash', 'str_replace_editor'])
  const promotedTools = stringList(toolBootstrap.promotedTools, 'patch.hooks.toolBootstrap.promotedTools', DEFAULT_DISCOVERY)
  const promotedFallbackTools = stringList(toolBootstrap.promotedFallbackTools, 'patch.hooks.toolBootstrap.promotedFallbackTools', mode === 'whoami' ? [] : ['bash', 'str_replace_editor'])
  const compactionTools = stringList(toolBootstrap.compactionTools, 'patch.hooks.toolBootstrap.compactionTools', DEFAULT_COMPACTION_TOOLS)
  const bootstrapMaxTokens = positiveInteger(toolBootstrap.bootstrapMaxTokens, 'patch.hooks.toolBootstrap.bootstrapMaxTokens')
  if (firstTurnTools === 'minimal' && bootstrapTools.length === 0) throw new TypeError('minimal requires bootstrapTools')

  const anchor = object(hooks.anchor, 'patch.hooks.anchor')
  rejectUnknown(anchor, new Set(['kind', 'text', 'scope', 'includeSubagents']), 'patch.hooks.anchor')
  const anchorKind = anchor.kind ?? ANCHOR_FOR_MODE[mode]
  if (anchorKind !== ANCHOR_FOR_MODE[mode]) throw new TypeError(`${mode} requires anchor.kind ${ANCHOR_FOR_MODE[mode]}`)
  const anchorScope = anchor.scope ?? 'first-turn'
  if (anchorScope !== 'first-turn') throw new TypeError('only first-turn anchors are currently supported')

  const instructionHint = object(hooks.instructionHint, 'patch.hooks.instructionHint')
  rejectUnknown(instructionHint, new Set(['enabled', 'oncePerSession', 'includeSubagents', 'mode']), 'patch.hooks.instructionHint')
  const instructionHintEnabled = boolean(instructionHint.enabled, 'patch.hooks.instructionHint.enabled', true)
  const instructionHintOnce = boolean(instructionHint.oncePerSession, 'patch.hooks.instructionHint.oncePerSession', true)
  const instructionHintSubagents = boolean(instructionHint.includeSubagents, 'patch.hooks.instructionHint.includeSubagents', sessionPhase.includeSubagents === true)
  const hintMode = instructionHint.mode ?? 'neutral'
  if (hintMode !== 'neutral') throw new TypeError('only neutral instructionHint.mode is currently supported')
  if (contextGateEnabled !== true) throw new Error('contextGate.enabled must be true for the current compiler')
  if (instructionHintEnabled !== true || instructionHintOnce !== true) throw new Error('instructionHint must be enabled once per session for the current compiler')
  if (unlockPolicy !== 'explicit') throw new Error('toolBootstrap.unlockPolicy seeded is not implemented yet')
  const expectedDiscovery = DEFAULT_DISCOVERY
  if (promotedTools.length !== expectedDiscovery.length || promotedTools.some((tool, index) => tool !== expectedDiscovery[index])) {
    throw new Error('toolBootstrap.promotedTools must be the current discovery tools')
  }
  const expectedFallbacks = mode === 'whoami' ? [] : ['bash', 'str_replace_editor']
  if (promotedFallbackTools.length !== expectedFallbacks.length || promotedFallbackTools.some((tool, index) => tool !== expectedFallbacks[index])) {
    throw new Error(`${mode} promotedFallbackTools are not supported by the current compiler`)
  }
  const turnOpening = object(hooks.turnOpening, 'patch.hooks.turnOpening')
  rejectUnknown(turnOpening, new Set(['enabled', 'kind', 'mode', 'steerText', 'provider', 'defaultProvider', 'includeSubagents', 'suppressedContextSources']), 'patch.hooks.turnOpening')
  const turnKind = turnOpening.kind ?? 'none'
  if (!new Set(['none', 'think', 'wire-think']).has(turnKind)) throw new TypeError('patch.hooks.turnOpening.kind is invalid')
  if (turnOpening.enabled === true && turnKind === 'none') throw new TypeError('turnOpening.enabled requires kind think or wire-think')
  const turnEnabled = turnKind !== 'none' && boolean(turnOpening.enabled, 'patch.hooks.turnOpening.enabled', true)
  const turnMode = turnOpening.mode ?? 'every-turn'
  if (!new Set(['every-turn', 'first-turn']).has(turnMode)) throw new TypeError('patch.hooks.turnOpening.mode is invalid')
  const turnIncludeSubagents = boolean(turnOpening.includeSubagents, 'patch.hooks.turnOpening.includeSubagents', sessionPhase.includeSubagents === true)
  const turnSuppressedSources = stringList(turnOpening.suppressedContextSources, 'patch.hooks.turnOpening.suppressedContextSources', ['skill-catalog', 'agent-instructions'])
  const turnProvider = turnOpening.provider ?? 'deepseek-wire-think'
  const turnDefaultProvider = turnOpening.defaultProvider ?? 'deepseek-official'
  if (turnKind === 'wire-think' && turnProvider === turnDefaultProvider) throw new TypeError('wire-think provider and defaultProvider must differ')
  const turnSteerText = turnOpening.steerText

  const toolExecution = object(hooks.toolExecution, 'patch.hooks.toolExecution')
  rejectUnknown(toolExecution, new Set(['enabled', 'deliberationGate', 'cotDrip']), 'patch.hooks.toolExecution')
  const deliberationGate = object(toolExecution.deliberationGate, 'patch.hooks.toolExecution.deliberationGate')
  rejectUnknown(deliberationGate, new Set(['enabled', 'minChars', 'maxGatesPerTurn', 'includeSubagents', 'gateText']), 'patch.hooks.toolExecution.deliberationGate')
  const deliberationEnabled = boolean(deliberationGate.enabled, 'patch.hooks.toolExecution.deliberationGate.enabled', false)
  const deliberationMinChars = deliberationGate.minChars ?? 400
  if (!Number.isSafeInteger(deliberationMinChars) || deliberationMinChars < 0) throw new TypeError('deliberationGate.minChars must be a non-negative integer')
  const deliberationMaxGates = positiveInteger(deliberationGate.maxGatesPerTurn ?? 1, 'deliberationGate.maxGatesPerTurn')
  const deliberationSubagents = boolean(deliberationGate.includeSubagents, 'patch.hooks.toolExecution.deliberationGate.includeSubagents', sessionPhase.includeSubagents === true)
  const deliberationText = deliberationGate.gateText
  const cotDrip = object(toolExecution.cotDrip, 'patch.hooks.toolExecution.cotDrip')
  rejectUnknown(cotDrip, new Set(['enabled', 'every', 'maxPerTurn', 'includeSubagents', 'text']), 'patch.hooks.toolExecution.cotDrip')
  const cotEnabled = boolean(cotDrip.enabled, 'patch.hooks.toolExecution.cotDrip.enabled', false)
  const cotEvery = cotDrip.every ?? 4
  if (!Number.isSafeInteger(cotEvery) || cotEvery < 0) throw new TypeError('cotDrip.every must be a non-negative integer')
  const cotMaxPerTurn = positiveInteger(cotDrip.maxPerTurn ?? 1, 'cotDrip.maxPerTurn')
  const cotSubagents = boolean(cotDrip.includeSubagents, 'patch.hooks.toolExecution.cotDrip.includeSubagents', sessionPhase.includeSubagents === true)
  const cotText = cotDrip.text

  const sessionSeed = object(hooks.sessionSeed, 'patch.hooks.sessionSeed')
  const gateway = object(hooks.gateway, 'patch.hooks.gateway')
  const unsupported = {
    sessionSeed: enabled(sessionSeed, 'patch.hooks.sessionSeed'),
    gateway: enabled(gateway, 'patch.hooks.gateway'),
  }
  if (unsupported.sessionSeed && anchorKind !== 'none') throw new TypeError('sessionSeed cannot combine with a live zero/whoami anchor')

  return Object.freeze({
    apiVersion,
    backend,
    from,
    to: source.to,
    name: source.name,
    description: source.description,
    mode,
    preserve: Object.freeze(preserve),
    hooks: Object.freeze({
      sessionPhase: Object.freeze({
        promoteOn,
        includeSubagents: sessionPhase.includeSubagents === true,
        compactionReset: boolean(sessionPhase.compactionReset, 'patch.hooks.sessionPhase.compactionReset', true),
      }),
      contextGate: Object.freeze({
        enabled: contextGateEnabled,
        runtimeContexts,
        messagePolicy,
        allowKinds: Object.freeze(stringList(contextGate.allowKinds, 'patch.hooks.contextGate.allowKinds', ['skill-invocation'])),
        suppressedContextSources: Object.freeze(stringList(contextGate.suppressedContextSources, 'patch.hooks.contextGate.suppressedContextSources', ['agent-instructions', 'skill-catalog'])),
        suppressedContextPlugins: Object.freeze(stringList(contextGate.suppressedContextPlugins, 'patch.hooks.contextGate.suppressedContextPlugins')),
      }),
      toolBootstrap: Object.freeze({ firstTurnTools, bootstrapTools: Object.freeze(bootstrapTools), promotedTools: Object.freeze(promotedTools), promotedFallbackTools: Object.freeze(promotedFallbackTools), unlockPolicy, compactionTools: Object.freeze(compactionTools), bootstrapMaxTokens }),
      anchor: Object.freeze({ kind: anchorKind, text: anchor.text, scope: anchorScope, includeSubagents: anchor.includeSubagents === true }),
      instructionHint: Object.freeze({ enabled: instructionHintEnabled, oncePerSession: instructionHintOnce, includeSubagents: instructionHintSubagents, mode: hintMode }),
      turnOpening: Object.freeze({ enabled: turnEnabled, kind: turnKind, mode: turnMode, steerText: turnSteerText, provider: turnProvider, defaultProvider: turnDefaultProvider, includeSubagents: turnIncludeSubagents, suppressedContextSources: Object.freeze(turnSuppressedSources) }),
      toolExecution: Object.freeze({
        deliberationGate: Object.freeze({ enabled: deliberationEnabled, minChars: deliberationMinChars, maxGatesPerTurn: deliberationMaxGates, includeSubagents: deliberationSubagents, gateText: deliberationText }),
        cotDrip: Object.freeze({ enabled: cotEnabled, every: cotEvery, maxPerTurn: cotMaxPerTurn, includeSubagents: cotSubagents, text: cotText }),
      }),
      unsupported: Object.freeze(unsupported),
    }),
  })
}

/** Compile the supported patch into the current anchor-bootstrap option shape. */
export function compileSupportedPatch(profile) {
  const normalized = profile?.hooks?.unsupported !== undefined
    ? profile
    : normalizePatchProfile(profile)
  const activeFuture = [
    ...(normalized.hooks.turnOpening.enabled ? ['turnOpening'] : []),
    ...(normalized.hooks.toolExecution.deliberationGate.enabled || normalized.hooks.toolExecution.cotDrip.enabled ? ['toolExecution'] : []),
  ]
  if (normalized.backend === 'legacy' && activeFuture.length > 0) throw new Error(`patch layers are not implemented yet: ${activeFuture.join(', ')}`)
  const { sessionPhase, contextGate, toolBootstrap, instructionHint } = normalized.hooks
  return Object.freeze({
    backend: normalized.backend,
    from: normalized.from,
    to: normalized.to,
    name: normalized.name,
    description: normalized.description,
    mode: normalized.mode,
    promoteOn: sessionPhase.promoteOn,
    subagents: normalized.mode === 'whoami' ? 'anchor' : (sessionPhase.includeSubagents ? 'anchor' : 'resident'),
    bootstrapTools: toolBootstrap.bootstrapTools,
    bootstrapMaxTokens: toolBootstrap.bootstrapMaxTokens,
    compactionTools: toolBootstrap.compactionTools,
    suppressedContextSources: contextGate.suppressedContextSources,
    suppressedContextPlugins: contextGate.suppressedContextPlugins,
    instructionHintEnabled: instructionHint.enabled,
    instructionHintIncludeSubagents: instructionHint.includeSubagents,
    promotedTools: toolBootstrap.promotedTools,
    promotedFallbackTools: toolBootstrap.promotedFallbackTools,
  })
}

/** Return the canonical hook row order for static composition checks. */
export function canonicalRowOrder(rows = CANONICAL_ROW_ORDER) {
  const rank = new Map(CANONICAL_ROW_ORDER.map((id, index) => [id, index]))
  return [...rows].sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER))
}

/** Detect duplicate/competing hook rows in a source composition. */
export function duplicatePatchRows(composition, profile) {
  const normalized = profile?.hooks?.unsupported !== undefined
    ? profile
    : normalizePatchProfile(profile)
  const claims = new Set(['anchor-bootstrap'])
  if (normalized.hooks.contextGate.enabled) claims.add('context-gate')
  if (normalized.hooks.toolBootstrap.firstTurnTools !== undefined) claims.add('tool-bootstrap')
  if (normalized.hooks.anchor.kind !== 'none') claims.add('anchor-turn')
  if (normalized.hooks.turnOpening.enabled) {
    claims.add(normalized.hooks.turnOpening.kind)
    if (normalized.hooks.turnOpening.kind === 'wire-think') claims.add('toolchoice-adapter')
  }
  if (normalized.hooks.toolExecution.deliberationGate.enabled) claims.add('deliberation-gate')
  if (normalized.hooks.toolExecution.cotDrip.enabled) claims.add('cot-drip')
  return [...claims].filter((id) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`, 'm').test(composition))
}
