import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, DEFAULT_MIN_CHARS, GATE_TEXT, name } from '../shared/deliberation-gate.mjs'

function register(config) {
  const listeners = {}
  const ctx = {
    on(event, callback) {
      listeners[event] = callback
    },
  }
  apply(ctx, config)
  assert.equal(typeof listeners['tools/pre-execute'], 'function')
  return listeners
}

function makeAgent(id = 's', header = {}) {
  return { session: { id, events: [], header } }
}

function preexecute(listener, agent = makeAgent()) {
  return listener(
    { name: 'bash', arguments: {}, agent, callId: 'c1', signal: new AbortController().signal },
    async () => ({ kind: 'accept' }),
  )
}

test('exports a diagnostic plugin name, default floor, and gate text', () => {
  assert.equal(name, 'deliberation-gate')
  assert.equal(DEFAULT_MIN_CHARS, 400)
  assert.ok(GATE_TEXT.includes('We'))
})

test('a shallow turn with no streamed text is denied exactly once', async () => {
  const listeners = register()
  const first = await preexecute(listeners['tools/pre-execute'])
  assert.equal(first.kind, 'deny')
  assert.equal(first.reason, GATE_TEXT)
  const second = await preexecute(listeners['tools/pre-execute'])
  assert.deepEqual(second, { kind: 'accept' })
})

test('a turn that has streamed enough depth passes untouched', async () => {
  const listeners = register({ minChars: 5 })
  const agent = makeAgent()
  listeners['session/event'](agent.session, {
    type: 'assistant/chunk',
    data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'We need to reason about this long enough.' } },
  })
  const decision = await preexecute(listeners['tools/pre-execute'], agent)
  assert.deepEqual(decision, { kind: 'accept' })
})

test('a resumed session cold-scans its durable chunks for depth', async () => {
  const agent = { session: {
    id: 'resumed',
    header: {},
    events: [
      { type: 'assistant/chunk', data: { turn: 2, step: 0, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(12) } } },
    ],
  } }
  const listeners = register({ minChars: 10 })
  const decision = await preexecute(listeners['tools/pre-execute'], agent)
  assert.deepEqual(decision, { kind: 'accept' })
})

test('maxGatesPerTurn can allow more than one planning push-back', async () => {
  const listeners = register({ minChars: 100, maxGatesPerTurn: 2 })
  const first = await preexecute(listeners['tools/pre-execute'])
  const second = await preexecute(listeners['tools/pre-execute'])
  const third = await preexecute(listeners['tools/pre-execute'])
  assert.equal(first.kind, 'deny')
  assert.equal(second.kind, 'deny')
  assert.deepEqual(third, { kind: 'accept' })
})

test('subagents are ungated by default', async () => {
  const listeners = register()
  const agent = makeAgent('sub', { delegationDepth: 1 })
  const decision = await preexecute(listeners['tools/pre-execute'], agent)
  assert.deepEqual(decision, { kind: 'accept' })
})

test('includeSubagents: true gates subagent turns too', async () => {
  const listeners = register({ includeSubagents: true })
  const agent = makeAgent('sub2', { delegationDepth: 1 })
  const decision = await preexecute(listeners['tools/pre-execute'], agent)
  assert.equal(decision.kind, 'deny')
})

test('executions without an agent pass untouched', async () => {
  const listeners = register()
  const decision = await listeners['tools/pre-execute'](
    { name: 'bash', arguments: {}, signal: new AbortController().signal },
    async () => ({ kind: 'accept' }),
  )
  assert.deepEqual(decision, { kind: 'accept' })
})

test('a custom gate text is used for the planning prompt', async () => {
  const listeners = register({ gateText: 'Think first.' })
  const first = await preexecute(listeners['tools/pre-execute'])
  assert.equal(first.kind, 'deny')
  assert.equal(first.reason, 'Think first.')
})

test('invalid gate configuration values fail at apply time', () => {
  assert.throws(() => register({ minChars: -1 }), /minChars/)
  assert.throws(() => register({ maxGatesPerTurn: 0 }), /maxGatesPerTurn/)
})
