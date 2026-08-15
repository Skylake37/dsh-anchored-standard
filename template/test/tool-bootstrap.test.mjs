import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../hook/tool-bootstrap.mjs'

const EXACT_CONFIG = {
  bootstrapTools: ['pwsh', 'read'],
}

function register(config = EXACT_CONFIG) {
  const listeners = {}
  const options = {}
  const warns = []
  const ctx = {
    on(event, callback, registerOptions) {
      listeners[event] = callback
      options[event] = registerOptions ?? null
    },
    logger: {
      warn(message) {
        warns.push(message)
      },
    },
  }
  apply(ctx, config)
  return { listeners, options, warns }
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

test('exports a diagnostic plugin name and an empty inject list', () => {
  assert.equal(name, 'anchored-tool-bootstrap')
  assert.deepEqual(inject, [])
})

test('bootstrapTools pins the first request to exactly that list', async () => {
  const { listeners } = register({ bootstrapTools: ['pwsh', 'read'] })
  const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'edit' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools)
  assert.deepEqual(result.tools.map(tool => tool.name), ['pwsh', 'read'])
  assert.equal(result.system, 'minimal persona')
})

test('bootstrapTools preserves the assembled catalog order', async () => {
  const { listeners } = register({ bootstrapTools: ['edit', 'pwsh'] })
  const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'edit' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools)
  assert.deepEqual(result.tools.map(tool => tool.name), ['pwsh', 'edit'])
})

test('a missing bootstrap tool degrades to the full catalog with a warning', async () => {
  const { listeners, warns } = register({ bootstrapTools: ['bash', 'missing'] })
  const tools = [{ name: 'bash' }, { name: 'read' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools)
  assert.deepEqual(result.tools, tools)
  assert.ok(warns.length >= 1)
})

test('a durable tool call promotes the complete catalog', async () => {
  const { listeners } = register()
  const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'edit' }]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools)
  assert.deepEqual(result.tools, tools)
})

test('a first assistant message promotes the complete catalog (either default)', async () => {
  const { listeners } = register()
  const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'write' }]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools)
  assert.deepEqual(result.tools, tools)
})

test('promoteOn tool-call requires a tool call, not just a reply', async () => {
  const { listeners } = register({ bootstrapTools: ['pwsh', 'read'], promoteOn: 'tool-call' })
  const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'write' }]
  const replyOnly = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools, {}, 'a')
  assert.deepEqual(replyOnly.tools.map(tool => tool.name), ['pwsh', 'read'])
  const withCall = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools, {}, 'b')
  assert.deepEqual(withCall.tools, tools)
})

test('subagents see the full catalog by default', async () => {
  const { listeners } = register()
  const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'write' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools, { delegationDepth: 1 })
  assert.deepEqual(result.tools, tools)
})

test('delegationDepthExempt false bootstraps subagents too', async () => {
  const { listeners } = register({ bootstrapTools: ['pwsh', 'read'], delegationDepthExempt: false })
  const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'write' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools, { delegationDepth: 1 })
  assert.deepEqual(result.tools.map(tool => tool.name), ['pwsh', 'read'])
})

test('default suppressedContextSources strips skill-catalog and agent-instructions only', async () => {
  const { listeners } = register()
  const messages = [
    { id: 'user', content: [{ type: 'text', text: 'user message' }] },
    { id: 'skills', content: [], source: { kind: 'skill-catalog' } },
    { id: 'agents', content: [], source: { kind: 'agent-instructions' } },
    { id: 'gesture', content: [], source: { kind: 'skill-invocation' } },
  ]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  assert.deepEqual(decision.messages.map(message => message.id), ['user', 'gesture'])
})

test('explicit empty suppressedContextSources disables the context filter', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, suppressedContextSources: [] })
  const messages = [
    { id: 'user', content: [] },
    { id: 'skills', content: [], source: { kind: 'skill-catalog' } },
  ]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  assert.deepEqual(decision.messages.map(message => message.id), ['user', 'skills'])
})

test('suppressedContextSources is configurable per preset', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, suppressedContextSources: ['custom-inject'] })
  const messages = [
    { id: 'keep', content: [], source: { kind: 'skill-catalog' } },
    { id: 'strip', content: [], source: { kind: 'custom-inject' } },
  ]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  assert.deepEqual(decision.messages.map(message => message.id), ['keep'])
})

test('without bootstrapMaxTokens no budget-cap listener is registered (adapter default flows)', () => {
  const { listeners } = register({ ...EXACT_CONFIG })
  assert.equal(listeners['agent/request'], undefined)
})

test('the pre-step strip and the optional budget cap register with prepend (upstream parity)', () => {
  const { options } = register({ ...EXACT_CONFIG, bootstrapMaxTokens: 2048 })
  assert.deepEqual(options['agent/pre-step'], { prepend: true })
  assert.deepEqual(options['agent/request'], { prepend: true })
})

test('an opt-in bootstrapMaxTokens caps request #1 and is released after promotion', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, bootstrapMaxTokens: 2048 })
  const capped = await request(listeners['agent/request'], [], { provider: 'x', model: 'y' })
  assert.equal(capped.maxTokens, 2048)
  const released = await request(listeners['agent/request'], [{ type: 'tool/call' }], { provider: 'x', model: 'y', maxTokens: 2048 })
  assert.equal(released.maxTokens, undefined)
})

test('with promoteOn never the cap is released after the FIRST request of the session', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, promoteOn: 'never', bootstrapMaxTokens: 2048 })
  const first = await request(listeners['agent/request'], [], { provider: 'x', model: 'y' }, {}, 'cap-session')
  assert.equal(first.maxTokens, 2048)
  // No promotion events: the second request of the same session must NOT stay capped.
  const second = await request(listeners['agent/request'], [], { provider: 'x', model: 'y', maxTokens: 2048 }, {}, 'cap-session')
  assert.equal(second.maxTokens, undefined)
  const other = await request(listeners['agent/request'], [], { provider: 'x', model: 'y' }, {}, 'other-session')
  assert.equal(other.maxTokens, 2048)
})

test('non-array pre-step messages pass through untouched', async () => {
  const { listeners } = register()
  const decision = await prestep(listeners['agent/pre-step'], [], 'not-an-array')
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages, 'not-an-array')
})

test('reject decisions pass through untouched', async () => {
  const { listeners } = register()
  const decision = await listeners['agent/pre-step']({ agent: agent([]), turn: 1, step: 1 }, async () => ({ kind: 'reject' }))
  assert.equal(decision.kind, 'reject')
})

test('promotion is memoized per session id within one process', async () => {
  const { listeners } = register()
  const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'write' }]
  const promoted = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools, {}, 'memo')
  assert.deepEqual(promoted.tools, tools)
  const again = await assemble(listeners['system-prompt/assemble'], [], tools, {}, 'memo')
  assert.deepEqual(again.tools, tools)
})

test('invalid configs fail at apply time', () => {
  assert.throws(() => register({}), /bootstrapTools/)
  assert.throws(() => register({ bootstrapTools: [] }), /bootstrapTools/)
  assert.throws(() => register({ ...EXACT_CONFIG, suppressedContextSources: [''] }), /suppressedContextSources/)
  assert.throws(() => register({ ...EXACT_CONFIG, suppressedContextPlugins: [''] }), /suppressedContextPlugins/)
  assert.throws(() => register({ ...EXACT_CONFIG, bootstrapPersonaText: '' }), /bootstrapPersonaText/)
  assert.throws(() => register({ ...EXACT_CONFIG, bootstrapPersonaText: 42 }), /bootstrapPersonaText/)
  assert.throws(() => register({ ...EXACT_CONFIG, promoteOn: 'bogus' }), /promoteOn/)
  assert.throws(() => register({ ...EXACT_CONFIG, bootstrapMaxTokens: 0 }), /bootstrapMaxTokens/)
  assert.throws(() => register({ ...EXACT_CONFIG, delegationDepthExempt: 'yes' }), /delegationDepthExempt/)
})

test('bootstrapPersonaText reduces the prompt to the sole Minimal persona section while bootstrapping', async () => {
  const MINIMAL_LINE = 'You are a helpful software engineer assistant.'
  const { listeners } = register({ ...EXACT_CONFIG, bootstrapPersonaText: MINIMAL_LINE })
  const assembly = {
    system: 'x',
    sections: [
      { name: 'harness:identity', text: 'harness identity' },
      { name: 'deployment:persona', text: 'You are a coding agent powered by deepseek-v4-pro...' },
      { name: 'tool:cordis', text: 'dynamic plugin guidance' },
    ],
    contexts: [{ name: 'sandbox:policy', text: 'file policy' }],
    tools: [{ name: 'pwsh' }, { name: 'read' }, { name: 'write' }],
  }
  const bootstrapped = await listeners['system-prompt/assemble'](undefined, { agent: agent([], {}, 'p1') }, async () => assembly)
  // The clean Minimal prompt: the persona section alone (harness identity,
  // orientation, and tool guidance are dropped), no runtime contexts, and the
  // bootstrap tool pair only.
  assert.deepEqual(bootstrapped.sections, [{ name: 'deployment:persona', text: MINIMAL_LINE }])
  assert.deepEqual(bootstrapped.contexts, [])
  assert.deepEqual(bootstrapped.tools.map(tool => tool.name), ['pwsh', 'read'])
  const promoted = await listeners['system-prompt/assemble'](undefined, { agent: agent([{ type: 'tool/call' }], {}, 'p1') }, async () => assembly)
  assert.deepEqual(promoted.sections, assembly.sections)
  assert.deepEqual(promoted.contexts, assembly.contexts)
  assert.deepEqual(promoted.tools.map(tool => tool.name), ['pwsh', 'read', 'write'])
})

test('bootstrapPersonaText is a graceful no-op when no persona section exists', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, bootstrapPersonaText: 'minimal' })
  const assembly = { sections: [{ name: 'tool:cordis', text: 'x' }], tools: [{ name: 'pwsh' }, { name: 'read' }] }
  const result = await listeners['system-prompt/assemble'](undefined, { agent: agent([], {}, 'p2') }, async () => assembly)
  assert.deepEqual(result.sections, assembly.sections)
  assert.deepEqual(result.tools.map(tool => tool.name), ['pwsh', 'read'])
})

test('promoteOn never keeps the bootstrap conditions for the WHOLE session', async () => {
  const MINIMAL_LINE = 'You are a helpful software engineer assistant.'
  const { listeners } = register({ ...EXACT_CONFIG, promoteOn: 'never', bootstrapPersonaText: MINIMAL_LINE })
  const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'write' }]
  const assembly = {
    sections: [{ name: 'harness:identity', text: 'id' }, { name: 'deployment:persona', text: 'full persona' }],
    contexts: [{ name: 'x', text: 'y' }],
    tools,
  }
  // Durable events that would promote in every other mode must NOT promote here.
  for (const events of [[], [{ type: 'tool/call' }], [{ type: 'assistant/message' }], [{ type: 'tool/call' }, { type: 'assistant/message' }]]) {
    const result = await listeners['system-prompt/assemble'](undefined, { agent: agent(events, {}, 'never-session') }, async () => assembly)
    assert.deepEqual(result.sections, [{ name: 'deployment:persona', text: MINIMAL_LINE }])
    assert.deepEqual(result.contexts, [])
    assert.deepEqual(result.tools.map(tool => tool.name), ['pwsh', 'read'])
  }
  // The pre-step context strip also never promotes away.
  const messages = [
    { id: 'user', content: [] },
    { id: 'skills', content: [], source: { kind: 'skill-catalog' } },
  ]
  const decision = await prestep(listeners['agent/pre-step'], [{ type: 'tool/call' }, { type: 'assistant/message' }], messages)
  assert.deepEqual(decision.messages.map(message => message.id), ['user'])
})

test('promoteOn never still exempts subagents by default', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, promoteOn: 'never' })
  const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'write' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools, { delegationDepth: 1 })
  assert.deepEqual(result.tools, tools)
})

test('suppressedContextPlugins strips those plugins while bootstrapping and restores after promotion', async () => {
  const { listeners } = register({ ...EXACT_CONFIG, suppressedContextPlugins: ['@deepseek-ai/dsh-system-prompt'] })
  const messages = [
    { id: 'user', content: [] },
    { id: 'snap', content: [], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' } },
    { id: 'mnem', content: [], source: { kind: 'plugin', plugin: 'dsh-mnemon' } },
  ]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  assert.deepEqual(decision.messages.map(message => message.id), ['user', 'mnem'])
  const promoted = await prestep(listeners['agent/pre-step'], [{ type: 'assistant/message' }], messages)
  assert.deepEqual(promoted.messages.map(message => message.id), ['user', 'snap', 'mnem'])
})
