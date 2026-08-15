import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../hook/zero-tool-bootstrap.mjs'

const MINIMAL_LINE = 'You are a helpful software engineer assistant.'
const CONFIG = {
  suppressedContextSources: ['agent-instructions', 'skill-catalog'],
  suppressedContextPlugins: ['@deepseek-ai/dsh-system-prompt'],
  bootstrapPersonaText: MINIMAL_LINE,
  compactionTools: ['read', 'todo_write'],
  includeSubagents: true,
}

function register(config = CONFIG) {
  const listeners = {}
  const warns = []
  const ctx = {
    on(event, callback, options) {
      listeners[event] = callback
      listeners[`${event}#opts`] = options ?? null
    },
    logger: { warn(message) { warns.push(message) } },
  }
  apply(ctx, config)
  return { listeners, warns }
}

const agent = (events, header = {}, id = 's') => ({ session: { id, events, header } })

const assembly = (tools) => ({
  sections: [
    { name: 'harness:identity', text: 'harness identity' },
    { name: 'deployment:persona', text: 'You are a coding agent powered by deepseek-v4-pro...' },
  ],
  contexts: [{ name: 'sandbox:policy', text: 'x' }],
  tools,
})

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'zero-tool-bootstrap')
})

test('the first request carries ZERO tools with the clean Minimal prompt', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'pwsh' }, { name: 'str_replace_editor' }, { name: 'read' }]
  const result = await listeners['system-prompt/assemble'](undefined, { agent: agent([], {}, 'w1') }, async () => assembly(tools))
  assert.deepEqual(result.tools, [])
  assert.deepEqual(result.sections, [{ name: 'deployment:persona', text: MINIMAL_LINE }])
  assert.deepEqual(result.contexts, [])
})

test('the anchor reply promotes to the resident catalog and KEEPS the clean prompt', async () => {
  const { listeners } = register()
  const tools = [
    { name: 'bash' }, { name: 'pwsh' }, { name: 'str_replace_editor' },
    { name: 'dev_tool_search' }, { name: 'skill_search' }, { name: 'skill_load' }, { name: 'read' },
  ]
  const events = [{ type: 'assistant/message', seq: 1 }]
  const result = await listeners['system-prompt/assemble'](undefined, { agent: agent(events, {}, 'w2') }, async () => assembly(tools))
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
    'bash', 'dev_tool_search', 'pwsh', 'skill_load', 'skill_search', 'str_replace_editor',
  ])
  assert.deepEqual(result.sections, [{ name: 'deployment:persona', text: MINIMAL_LINE }])
  assert.deepEqual(result.contexts, [])
})

test('post-compaction falls back to shells + compactionTools (not zero tools)', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'pwsh' }, { name: 'str_replace_editor' }, { name: 'read' }, { name: 'todo_write' }]
  const events = [
    { type: 'assistant/message', seq: 1 },
    { type: 'compaction/end', seq: 2 },
  ]
  const result = await listeners['system-prompt/assemble'](undefined, { agent: agent(events, {}, 'w3') }, async () => assembly(tools))
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'pwsh', 'read', 'todo_write'])
})

test('subagents follow the same zero-tool anchor phase when includeSubagents is true', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }]
  const result = await listeners['system-prompt/assemble'](undefined, { agent: agent([], { delegationDepth: 1 }, 'w4') }, async () => assembly(tools))
  assert.deepEqual(result.tools, [])
})

test('without includeSubagents, subagents start promoted', async () => {
  const { listeners } = register({ ...CONFIG, includeSubagents: false })
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }]
  const result = await listeners['system-prompt/assemble'](undefined, { agent: agent([], { delegationDepth: 1 }, 'w5') }, async () => assembly(tools))
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'str_replace_editor'])
})

test('plugin-suppressed messages are stripped even after promotion', async () => {
  const { listeners } = register()
  const messages = [
    { id: 'user', content: [], source: { kind: 'user' } },
    { id: 'skills', content: [], source: { kind: 'skill-catalog' } },
    { id: 'snap', content: [], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } },
  ]
  const decision = await listeners['agent/pre-step'](
    { agent: agent([{ type: 'assistant/message', seq: 1 }], {}, 'w6'), turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages }),
  )
  assert.deepEqual(decision.messages.map((message) => message.id), ['user', 'skills'])
})
