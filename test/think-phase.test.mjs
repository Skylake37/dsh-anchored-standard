import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name, STEER_TEXT } from '../shared/think-phase.mjs'

function register(config) {
  const listeners = {}
  const hookOptions = {}
  const warns = []
  const ctx = {
    on(event, callback, opts) {
      listeners[event] = callback
      hookOptions[event] = opts
    },
    logger: {
      warn(message) {
        warns.push(message)
      },
    },
  }
  apply(ctx, config)
  assert.equal(typeof listeners['agent/pre-step'], 'function')
  assert.equal(typeof listeners['system-prompt/assemble'], 'function')
  assert.equal(typeof listeners['agent/turn-stopping'], 'function')
  return { listeners, hookOptions, warns }
}

/** A minimal agent with a steerable inbox. */
function makeAgent(id = 's', events = [], header = {}) {
  const steered = []
  return {
    session: { id, events, header },
    steer(message) {
      steered.push(message)
    },
    steered,
  }
}

async function prestep(listener, agent, turn, step, messages = []) {
  return listener({ agent, turn, step, messages, signal: undefined }, async () => ({ kind: 'enter', messages }))
}

async function assemble(listener, agent, tools) {
  return listener(undefined, { agent }, async () => ({ system: 'minimal persona', tools }))
}

const userMessage = { id: 'u', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }

const FULL_CATALOG = () => [
  { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'dev_tool_search' },
  { name: 'skill_search' }, { name: 'skill_load' }, { name: 'read' }, { name: 'web_search' },
]

const RESIDENT = ['bash', 'dev_tool_search', 'skill_load', 'skill_search', 'str_replace_editor']

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'think-phase')
})

test('every turn opens with one zero-tool think step, then steering opens the resident catalog', async () => {
  const { listeners } = register({})
  const agent = makeAgent()
  await prestep(listeners['agent/pre-step'], agent, 1, 0, [userMessage])

  const thinkAssembled = await assemble(listeners['system-prompt/assemble'], agent, FULL_CATALOG())
  assert.deepEqual(thinkAssembled.tools, [])

  listeners['agent/turn-stopping']({ agent, turn: 1, signal: undefined })
  assert.equal(agent.steered.length, 1)

  await prestep(listeners['agent/pre-step'], agent, 1, 1, [agent.steered[0]])
  const executeAssembled = await assemble(listeners['system-prompt/assemble'], agent, FULL_CATALOG())
  assert.deepEqual(executeAssembled.tools.map((tool) => tool.name).sort(), RESIDENT)
})

test('mode: first-turn limits the think phase to the first user turn', async () => {
  const { listeners } = register({ mode: 'first-turn' })
  const later = makeAgent('later', [{ type: 'user/message', data: {} }])
  await prestep(listeners['agent/pre-step'], later, 2, 0, [userMessage])
  const assembled = await assemble(listeners['system-prompt/assemble'], later, FULL_CATALOG())
  assert.deepEqual(assembled.tools.map((tool) => tool.name).sort(), RESIDENT)
})

test('subagents default to always-execute', async () => {
  const { listeners } = register({})
  const subagent = makeAgent('sub', [], { delegationDepth: 1 })
  await prestep(listeners['agent/pre-step'], subagent, 1, 0, [userMessage])
  const assembled = await assemble(listeners['system-prompt/assemble'], subagent, FULL_CATALOG())
  assert.deepEqual(assembled.tools.map((tool) => tool.name).sort(), RESIDENT)
})

test('the think phase strips auto-injected context; execute keeps it', async () => {
  const { listeners } = register({})
  const instruction = { id: 'i', content: [], source: { kind: 'agent-instructions' } }
  const catalog = { id: 'c', content: [], source: { kind: 'skill-catalog' } }
  const thinkDecision = await prestep(listeners['agent/pre-step'], makeAgent(), 1, 0, [userMessage, instruction, catalog])
  assert.deepEqual(thinkDecision.messages.map((message) => message.id), ['u'])
  const executeDecision = await prestep(listeners['agent/pre-step'], makeAgent(), 1, 1, [userMessage, instruction, catalog])
  assert.equal(executeDecision.messages.length, 3)
})

test('steering happens exactly once per turn with the notice shape', async () => {
  const { listeners } = register({})
  const agent = makeAgent()
  await prestep(listeners['agent/pre-step'], agent, 1, 0, [userMessage])
  listeners['agent/turn-stopping']({ agent, turn: 1, signal: undefined })
  listeners['agent/turn-stopping']({ agent, turn: 1, signal: undefined })
  assert.equal(agent.steered.length, 1)
  const message = agent.steered[0]
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].text, STEER_TEXT)
  assert.equal(message.source.plugin, 'think-phase')
})

test('a durable think-phase steering event prevents a post-restart double steer', async () => {
  const events = [
    { type: 'steering/message', seq: 2, data: { turn: 1, content: [], source: { kind: 'plugin', plugin: 'think-phase' } } },
  ]
  const { listeners } = register({})
  const agent = makeAgent('restart', events)
  await prestep(listeners['agent/pre-step'], agent, 1, 0, [userMessage])
  listeners['agent/turn-stopping']({ agent, turn: 1, signal: undefined })
  assert.equal(agent.steered.length, 0)
})

test('invalid config values fail at apply time', () => {
  assert.throws(() => register({ mode: 'sometimes' }), /mode/)
  assert.throws(() => register({ suppressedContextSources: [1] }), /suppressedContextSources/)
})