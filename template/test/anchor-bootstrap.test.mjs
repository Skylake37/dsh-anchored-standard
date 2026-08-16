import assert from 'node:assert/strict'
import test from 'node:test'

import { ANCHOR_TEXTS, MODE_PROFILES, apply, inject, name } from '../hook/anchor-bootstrap.mjs'

const ANCHORED = { mode: 'anchored', bootstrapTools: ['bash', 'str_replace_editor'] }
const ZERO = { mode: 'zero' }
const WHOAMI = { mode: 'whoami' }

function register(config) {
  const listeners = {}
  const hookOptions = {}
  const warns = []
  const ctx = {
    on(event, callback, options) {
      listeners[event] = callback
      hookOptions[event] = options ?? null
    },
    logger: {
      warn(message) {
        warns.push(message)
      },
    },
  }
  apply(ctx, config)
  return { listeners, hookOptions, warns }
}

const agent = (events = [], header = {}, id = 's') => ({ session: { id, events, header } })

function assemble(listener, events = [], tools, header = {}, id = 's') {
  return listener(undefined, { agent: agent(events, header, id) }, async () => ({ system: 'minimal persona', tools }))
}

function request(listener, events, resolved, header = {}, id = 's') {
  return listener({ agent: agent(events, header, id), turn: 1, step: 1 }, async () => resolved)
}

function prestep(listener, events, messages, header = {}, id = 's') {
  return listener({ agent: agent(events, header, id), turn: 1, step: 1 }, async () => ({ kind: 'enter', messages }))
}

function anchorMessage(listener, { depth = 0, events = [] } = {}) {
  const prepends = []
  const subject = {
    session: { header: { delegationDepth: depth }, events },
    inbox: {
      prepend(target, message) {
        prepends.push({ target, message })
      },
    },
  }
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  return prepends
}

const fullAssembly = (tools, personaText = 'source persona') => ({
  system: 'x',
  sections: [
    { name: 'harness:identity', text: 'harness identity' },
    { name: 'deployment:persona', text: personaText },
    { name: 'tool:cordis', text: 'dynamic plugin guidance' },
  ],
  contexts: [{ name: 'sandbox:policy', text: 'file policy' }],
  tools,
})

const names = (result) => result.tools.map((tool) => tool.name)

test('exports the unified plugin identity and profile metadata', () => {
  assert.equal(name, 'anchor-bootstrap')
  assert.deepEqual(inject, [])
  assert.equal(ANCHOR_TEXTS['test-notice'], 'This round is a test. Tools are not open yet; all tools will open next round.')
  assert.equal(ANCHOR_TEXTS.whoami, '你是谁')
  assert.equal(MODE_PROFILES.anchored.firstTurnTools, 'minimal')
  assert.equal(MODE_PROFILES.zero.firstTurnTools, 'empty')
})

test('anchored profile: first request is the Minimal pair and promotion is event-driven', async () => {
  const { listeners } = register(ANCHORED)
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'pwsh' }, { name: 'read' },
    { name: 'dev_tool_search' }, { name: 'skill_search' }, { name: 'skill_load' }, { name: 'web_search' },
  ]
  const first = await assemble(listeners['system-prompt/assemble'], [], tools)
  assert.deepEqual(names(first), ['bash', 'str_replace_editor'])

  const promotedByCall = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools, {}, 'a')
  assert.deepEqual(names(promotedByCall).sort(), ['bash', 'dev_tool_search', 'skill_load', 'skill_search', 'str_replace_editor'])

  const promotedByReply = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools, {}, 'b')
  assert.deepEqual(names(promotedByReply).sort(), ['bash', 'dev_tool_search', 'skill_load', 'skill_search', 'str_replace_editor'])
})

test('anchored profile: compaction falls back and a new signal re-promotes', async () => {
  const { listeners } = register({ ...ANCHORED, compactionTools: ['read'] })
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }, { name: 'web_search' },
    { name: 'dev_tool_search' },
  ]
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ]
  const controlled = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.deepEqual(names(controlled).sort(), ['bash', 'read', 'str_replace_editor'])
  listeners['session/event']({ id: 's', events }, { type: 'tool/call', seq: 3, data: {} })
  const rePromoted = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.ok(names(rePromoted).includes('dev_tool_search'))
})

test('zero profile: anchor request is empty and the real message is promoted', async () => {
  const { listeners } = register(ZERO)
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'dev_tool_search' }, { name: 'skill_search' }, { name: 'skill_load' },
  ]
  const anchorRequest = await assemble(listeners['system-prompt/assemble'], [], tools, {}, 'z-anchor')
  assert.deepEqual(names(anchorRequest), [])
  const realRequest = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools, {}, 'z-real')
  assert.deepEqual(names(realRequest).sort(), ['bash', 'dev_tool_search', 'skill_load', 'skill_search', 'str_replace_editor'])
})

test('zero profile seeds the fixed test notice and skips subagents by default', () => {
  const { listeners } = register(ZERO)
  assert.deepEqual(anchorMessage(listeners['agent/inbox/inserted']).map((entry) => entry.message.content[0].text), [
    ANCHOR_TEXTS['test-notice'],
  ])
  assert.deepEqual(anchorMessage(listeners['agent/inbox/inserted'], { depth: 1 }), [])
})

test('whoami profile seeds 你是谁 and subagents inherit the anchor', () => {
  const { listeners } = register(WHOAMI)
  const top = anchorMessage(listeners['agent/inbox/inserted'])
  assert.equal(top.length, 1)
  assert.equal(top[0].target, 'next-turn')
  assert.equal(top[0].message.content[0].text, '你是谁')
  const sub = anchorMessage(listeners['agent/inbox/inserted'], { depth: 1 })
  assert.equal(sub.length, 1)
  assert.equal(sub[0].message.content[0].text, '你是谁')
})

test('whoami subagents follow the empty anchor phase before promotion', async () => {
  const { listeners } = register(WHOAMI)
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'dev_tool_search' }]
  const controlled = await assemble(listeners['system-prompt/assemble'], [], tools, { delegationDepth: 1 }, 'w-controlled')
  assert.deepEqual(names(controlled), [])
  const promoted = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools, { delegationDepth: 1 }, 'w-promoted')
  assert.ok(names(promoted).includes('bash'))
})

test('subagents bootstrap profile follows the minimal controlled phase', async () => {
  const { listeners } = register({ ...ANCHORED, subagents: 'bootstrap' })
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }]
  const controlled = await assemble(listeners['system-prompt/assemble'], [], tools, { delegationDepth: 1 }, 'b-controlled')
  assert.deepEqual(names(controlled), ['bash', 'str_replace_editor'])
  const promoted = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools, { delegationDepth: 1 }, 'b-promoted')
  assert.deepEqual(names(promoted), ['bash', 'str_replace_editor'])
})

test('dev_tool_search unlocks tools durably for all profiles', async () => {
  const { listeners } = register(ANCHORED)
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'dev_tool_search' }, { name: 'web_search' }, { name: 'subagent' },
  ]
  const events = [
    { type: 'assistant/message', data: {} },
    { type: 'tool/call', data: { name: 'dev_tool_search', arguments: '{"toolNames":["web_search","subagent"]}' } },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.ok(names(result).includes('web_search'))
  assert.ok(names(result).includes('subagent'))
})

test('bootstrapMaxTokens caps every controlled profile and is stripped after promotion', async () => {
  const { listeners } = register({ ...ZERO, bootstrapMaxTokens: 1024 })
  const capped = await request(listeners['agent/request'], [], { provider: 'x', model: 'y' }, {}, 'a')
  assert.equal(capped.maxTokens, 1024)
  const released = await request(
    listeners['agent/request'],
    [{ type: 'assistant/message' }],
    { provider: 'x', model: 'y', maxTokens: 1024 },
    {},
    'b',
  )
  assert.equal(released.maxTokens, undefined)
})

test('phase-aware persona: controlled is base+opener, promoted is full persona', async () => {
  const controlled = 'You are a helpful software engineer assistant. When working on a task, always open your reasoning with We need.'
  const full = `${controlled}. If a tool you need is not in your current tool list, call dev_tool_search.`
  const { listeners } = register({ ...ANCHORED, controlledPersonaText: controlled, personaText: full })
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'write' }]

  const bootstrapped = await listeners['system-prompt/assemble'](undefined, { agent: agent([], {}, 'p1') }, async () => fullAssembly(tools))
  assert.deepEqual(bootstrapped.sections, [{ name: 'deployment:persona', text: controlled }])
  assert.deepEqual(bootstrapped.contexts, [])

  const promoted = await listeners['system-prompt/assemble'](undefined, { agent: agent([{ type: 'tool/call' }], {}, 'p2') }, async () => fullAssembly(tools))
  assert.deepEqual(promoted.sections, [{ name: 'deployment:persona', text: full }])
})

test('controlled persona falls back to the full persona when only one is configured', async () => {
  const full = 'You are a helpful software engineer assistant. When working on a task, always open your reasoning with We need.'
  const { listeners } = register({ ...ANCHORED, personaText: full })
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }]
  const result = await listeners['system-prompt/assemble'](undefined, { agent: agent([], {}, 'p3') }, async () => fullAssembly(tools))
  assert.deepEqual(result.sections, [{ name: 'deployment:persona', text: full }])
})

test('pre-step strips source kinds while controlled and plugin messages permanently', async () => {
  const { listeners } = register({ ...ANCHORED, suppressedContextPlugins: ['@deepseek-ai/dsh-system-prompt'] })
  const messages = [
    { id: 'user', content: [], source: { kind: 'user' } },
    { id: 'skills', content: [], source: { kind: 'skill-catalog' } },
    { id: 'snap', content: [], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } },
    { id: 'mnem', content: [], source: { kind: 'plugin', plugin: 'dsh-mnemon' } },
  ]
  const controlled = await prestep(listeners['agent/pre-step'], [], messages, {}, 'c-controlled')
  assert.deepEqual(controlled.messages.map((message) => message.id), ['user', 'mnem'])
  const promoted = await prestep(listeners['agent/pre-step'], [{ type: 'tool/call' }], messages, {}, 'c-promoted')
  assert.deepEqual(promoted.messages.map((message) => message.id), ['user', 'skills', 'mnem'])
})

test('invalid configs fail at apply time', () => {
  assert.throws(() => register({ mode: 'nope' }), /mode/)
  assert.throws(() => register({ mode: 'anchored' }), /bootstrapTools/)
  assert.throws(() => register({ ...ANCHORED, firstTurnTools: 'empty' }), /conflicts with mode/)
  assert.throws(() => register({ ...ZERO, anchorText: 'none' }), /conflicts with mode/)
  assert.throws(() => register({ ...WHOAMI, subagents: 'resident' }), /not valid for mode/)
  assert.throws(() => register({ ...ZERO, promoteOn: 'either' }), /promoteOn/)
  assert.throws(() => register({ ...ANCHORED, unknownKey: true }), /unknown config key/)
  assert.throws(() => register({ ...ANCHORED, bootstrapMaxTokens: 0 }), /bootstrapMaxTokens/)
  assert.throws(() => register({ ...ANCHORED, personaText: '' }), /personaText/)
  assert.throws(() => register(null), /config must be an object/)
})

test('no anchor listener is registered for the anchored profile', () => {
  const { listeners } = register(ANCHORED)
  assert.equal(listeners['agent/inbox/inserted'], undefined)
})
