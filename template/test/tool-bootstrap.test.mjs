import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../hook/tool-bootstrap.mjs'

const MINIMAL_LINE = 'You are a helpful software engineer assistant.'
const EXACT_CONFIG = {
  bootstrapTools: ['bash', 'str_replace_editor'],
}

function register(config = EXACT_CONFIG) {
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

const agent = (events, header = {}, id = 's') => ({ session: { id, events, header } })

function assemble(listener, events, tools, header = {}, id = 's') {
  return listener(undefined, { agent: agent(events, header, id) }, async () => ({ system: 'minimal persona', tools }))
}

function request(listener, events, resolved, header = {}, id = 's') {
  return listener({ agent: agent(events, header, id), turn: 1, step: 1 }, async () => resolved)
}

function prestep(listener, events, messages, header = {}, id = 's') {
  return listener({ agent: agent(events, header, id), turn: 1, step: 1 }, async () => ({ kind: 'enter', messages }))
}

const fullAssembly = (tools) => ({
  system: 'x',
  sections: [
    { name: 'harness:identity', text: 'harness identity' },
    { name: 'deployment:persona', text: 'You are a coding agent powered by deepseek-v4-pro...' },
    { name: 'tool:cordis', text: 'dynamic plugin guidance' },
  ],
  contexts: [{ name: 'sandbox:policy', text: 'file policy' }],
  tools,
})

test('exports a diagnostic plugin name and an empty inject list', () => {
  assert.equal(name, 'anchored-tool-bootstrap')
  assert.deepEqual(inject, [])
})

test('first request exposes exactly the Minimal tool pair', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'pwsh' }, { name: 'read' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools)
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})

test('a durable tool call promotes the resident catalog', async () => {
  const { listeners } = register()
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'edit' }, { name: 'grep' },
    { name: 'dev_tool_search' }, { name: 'skill_search' }, { name: 'skill_load' },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call', data: { name: 'bash' } }], tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
    'bash', 'dev_tool_search', 'skill_load', 'skill_search', 'str_replace_editor',
  ])
})

test('a first assistant message promotes the resident catalog (either default)', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'write' }, { name: 'dev_tool_search' }]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message', data: {} }], tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'dev_tool_search', 'str_replace_editor'])
})

test('sessions derive promotion independently from their own events', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'write' }]
  const promoted = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools, {}, 'a')
  const fresh = await assemble(listeners['system-prompt/assemble'], [], tools, {}, 'b')
  assert.deepEqual(promoted.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
  assert.deepEqual(fresh.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})

test('promotion is memoized per session id within one process', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'write' }]
  const first = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools, {}, 'memo')
  assert.deepEqual(first.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
  const second = await assemble(listeners['system-prompt/assemble'], [], tools, {}, 'memo')
  assert.deepEqual(second.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})

test('promoteOn tool-call requires a tool call, not just a reply', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, promoteOn: 'tool-call' })
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'write' }]
  const replyOnly = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools, {}, 'a')
  assert.deepEqual(replyOnly.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
  const withCall = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools, {}, 'b')
  assert.deepEqual(withCall.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})

test('the promoted resident set includes the discovery tools when available', async () => {
  const { listeners } = register()
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }, { name: 'edit' },
    { name: 'dev_tool_search' }, { name: 'skill_search' }, { name: 'skill_load' }, { name: 'web_search' },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
    'bash', 'dev_tool_search', 'skill_load', 'skill_search', 'str_replace_editor',
  ])
})

test('dev_tool_search unlocks tools durably (resume-safe from tool/call events)', async () => {
  const { listeners } = register()
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'dev_tool_search' },
    { name: 'skill_search' }, { name: 'skill_load' }, { name: 'web_search' }, { name: 'subagent' },
  ]
  const events = [
    { type: 'assistant/message', data: {} },
    { type: 'tool/call', data: { name: 'dev_tool_search', arguments: '{"toolNames":["web_search","subagent"]}' } },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], events, tools)
  const names = result.tools.map((tool) => tool.name)
  assert.ok(names.includes('web_search'))
  assert.ok(names.includes('subagent'))
})

test('malformed dev_tool_search arguments are ignored, not fatal', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'dev_tool_search' }]
  const events = [
    { type: 'assistant/message', data: {} },
    { type: 'tool/call', data: { name: 'dev_tool_search', arguments: 'not json' } },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'dev_tool_search', 'str_replace_editor'])
})

test('post-compaction falls back to the bootstrap pair plus compactionTools', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, compactionTools: ['read', 'todo_write'] })
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }, { name: 'todo_write' }, { name: 'web_search' },
  ]
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'read', 'str_replace_editor', 'todo_write'])
})

test('post-compaction without compactionTools stays on the bootstrap pair', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }]
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'str_replace_editor'])
})

test('a compaction resets promotion; a new signal after the boundary re-promotes', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }, { name: 'dev_tool_search' }]
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ]
  const postCompaction = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.deepEqual(postCompaction.tools.map((tool) => tool.name).sort(), ['bash', 'str_replace_editor'])
  listeners['session/event']({ id: 's', events }, { type: 'tool/call', seq: 3, data: { name: 'bash' } })
  const rePromoted = await assemble(listeners['system-prompt/assemble'], events, tools)
  assert.deepEqual(rePromoted.tools.map((tool) => tool.name).sort(), ['bash', 'dev_tool_search', 'str_replace_editor'])
})

test('pre-compaction promotion signals do not re-promote after a compaction', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }]
  const result = await assemble(listeners['system-prompt/assemble'], [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ], tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'str_replace_editor'])
})

test('a missing bootstrap tool degrades gracefully to the full catalog', async () => {
  const { listeners, warns } = register()
  const tools = [{ name: 'str_replace_editor' }, { name: 'edit' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools)
  assert.deepEqual(result.tools, tools)
  assert.ok(warns.length >= 1)
})

test('invalid configs fail at apply time', () => {
  assert.throws(() => register({}), /bootstrapTools/)
  assert.throws(() => register({ ...EXACT_CONFIG, bootstrapTools: [] }), /bootstrapTools/)
  assert.throws(() => register({ ...EXACT_CONFIG, promoteOn: 'never' }), /promoteOn/)
  assert.throws(() => register({ ...EXACT_CONFIG, promoteOn: 'bogus' }), /promoteOn/)
  assert.throws(() => register({ ...EXACT_CONFIG, suppressedContextSources: 'agent-instructions' }), /suppressedContextSources/)
  assert.throws(() => register({ ...EXACT_CONFIG, suppressedContextPlugins: [''] }), /suppressedContextPlugins/)
  assert.throws(() => register({ ...EXACT_CONFIG, bootstrapPersonaText: '' }), /bootstrapPersonaText/)
  assert.throws(() => register({ ...EXACT_CONFIG, bootstrapMaxTokens: 0 }), /bootstrapMaxTokens/)
  assert.throws(() => register({ ...EXACT_CONFIG, delegationDepthExempt: 'yes' }), /delegationDepthExempt/)
  assert.throws(() => register({ ...EXACT_CONFIG, compactionTools: [] }), /compactionTools/)
  assert.throws(() => register({ ...EXACT_CONFIG, promoteOnn: 'either' }), /unknown config key/)
  assert.throws(() => register(null), /config must be an object/)
  assert.throws(() => register([]), /config must be an object/)
})

test('without bootstrapMaxTokens no budget-cap listener is registered', () => {
  const { listeners } = register()
  assert.equal(listeners['agent/request'], undefined)
})

test('the pre-step strip and the optional budget cap register with prepend', () => {
  const { hookOptions } = register({ ...EXACT_CONFIG, bootstrapMaxTokens: 2048 })
  assert.deepEqual(hookOptions['agent/pre-step'], { prepend: true })
  assert.deepEqual(hookOptions['agent/request'], { prepend: true })
})

test('bootstrapMaxTokens caps the controlled phase and is released after promotion', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, bootstrapMaxTokens: 2048 })
  const capped = await request(listeners['agent/request'], [], { provider: 'x', model: 'y' }, {}, 'a')
  assert.equal(capped.maxTokens, 2048)
  const released = await request(listeners['agent/request'], [{ type: 'tool/call' }], { provider: 'x', model: 'y', maxTokens: 2048 }, {}, 'b')
  assert.equal(released.maxTokens, undefined)
})

test('bootstrapMaxTokens re-applies after a compaction reset', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, bootstrapMaxTokens: 2048 })
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ]
  const recapped = await request(listeners['agent/request'], events, { provider: 'x', model: 'y' })
  assert.equal(recapped.maxTokens, 2048)
})

test('controlled pre-step strips default and plugin-suppressed context sources', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, suppressedContextPlugins: ['@deepseek-ai/dsh-system-prompt'] })
  const messages = [
    { id: 'user', content: [], source: { kind: 'user' } },
    { id: 'skills', content: [], source: { kind: 'skill-catalog' } },
    { id: 'agents', content: [], source: { kind: 'agent-instructions' } },
    { id: 'snap', content: [], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' } },
    { id: 'mnem', content: [], source: { kind: 'plugin', plugin: 'dsh-mnemon' } },
    { id: 'gesture', content: [], source: { kind: 'skill-invocation' } },
  ]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  assert.deepEqual(decision.messages.map((message) => message.id), ['user', 'mnem', 'gesture'])
})

test('promoted pre-step keeps every injected context message', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, suppressedContextPlugins: ['@deepseek-ai/dsh-system-prompt'] })
  const messages = [
    { id: 'user', content: [], source: { kind: 'user' } },
    { id: 'skills', content: [], source: { kind: 'skill-catalog' } },
    { id: 'snap', content: [], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } },
  ]
  const decision = await prestep(listeners['agent/pre-step'], [{ type: 'tool/call' }], messages)
  assert.deepEqual(decision.messages, messages)
})

test('explicit empty suppression lists disable the context filter', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, suppressedContextSources: [], suppressedContextPlugins: [] })
  const messages = [
    { id: 'user', content: [], source: { kind: 'user' } },
    { id: 'skills', content: [], source: { kind: 'skill-catalog' } },
  ]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  assert.equal(decision.messages, messages)
})

test('reject decisions pass through untouched', async () => {
  const { listeners } = register()
  const decision = { kind: 'reject', messages: [{ id: 'x', source: { kind: 'skill-catalog' } }] }
  const result = await listeners['agent/pre-step']({ agent: agent([]), turn: 1, step: 1 }, async () => decision)
  assert.equal(result, decision)
})

test('subagents are always promoted by default', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }, { name: 'dev_tool_search' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools, { delegationDepth: 1 })
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'dev_tool_search', 'str_replace_editor'])
})

test('delegationDepthExempt false bootstraps subagents too', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, delegationDepthExempt: false })
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools, { delegationDepth: 1 })
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})

test('bootstrapPersonaText reduces the controlled prompt to the sole Minimal persona section', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, bootstrapPersonaText: MINIMAL_LINE })
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'write' }]
  const bootstrapped = await listeners['system-prompt/assemble'](undefined, { agent: agent([], {}, 'p1') }, async () => fullAssembly(tools))
  assert.deepEqual(bootstrapped.sections, [{ name: 'deployment:persona', text: MINIMAL_LINE }])
  assert.deepEqual(bootstrapped.contexts, [])
  assert.deepEqual(bootstrapped.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
  const promoted = await listeners['system-prompt/assemble'](undefined, { agent: agent([{ type: 'tool/call' }], {}, 'p1-promoted') }, async () => fullAssembly(tools))
  assert.deepEqual(promoted.sections, fullAssembly(tools).sections)
  assert.deepEqual(promoted.contexts, fullAssembly(tools).contexts)
})

test('bootstrapPersonaText is a graceful no-op when no persona section exists', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, bootstrapPersonaText: MINIMAL_LINE })
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }]
  const assembly = { sections: [{ name: 'tool:cordis', text: 'x' }], tools }
  const result = await listeners['system-prompt/assemble'](undefined, { agent: agent([], {}, 'p2') }, async () => assembly)
  assert.deepEqual(result.sections, assembly.sections)
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})
