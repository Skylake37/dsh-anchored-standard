import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../hook/instruction-hint.mjs'

function register(config = { promoteOn: 'assistant-message' }) {
  let listener
  let sessionEvent
  const ctx = {
    on(event, callback) {
      if (event === 'session/event') sessionEvent = callback
      if (event === 'agent/pre-step') listener = callback
    },
    get(service) {
      if (service !== 'fs') return undefined
      // No instruction files anywhere: every probe throws.
      return {
        resolve: async () => { throw new Error('absent') },
        stat: async () => { throw new Error('absent') },
      }
    },
    logger: { warn() {} },
  }
  apply(ctx, config)
  assert.equal(typeof listener, 'function')
  listener.observe = (...args) => sessionEvent?.(...args)
  return listener
}

const agent = (events = [], depth = 0) => ({
  session: { id: `s-${depth}`, events, header: { cwd: 'C:\\nonexistent', delegationDepth: depth } },
})

test('exports the diagnostic plugin name', () => {
  assert.equal(name, 'instruction-hint')
})

test('post-promotion pre-step injects neutral tool guidance even without instruction files', async () => {
  const listener = register()
  const decision = await listener(
    { agent: agent([{ type: 'assistant/message' }]) },
    async () => ({ kind: 'enter', messages: [{ id: 'user', role: 'user', content: [] }] }),
  )
  const hint = decision.messages.find((message) => message.id?.startsWith('instruction-hint-'))
  assert.ok(hint, 'expected a hint message')
  const text = hint.content[0].text
  assert.match(text, /dev_tool_search/)
  assert.match(text, /The resident tool set is intentionally small/)
  assert.match(text, /preceding anchor or identity response/)
  assert.match(text, /Common unlockable families/)
  assert.doesNotMatch(text, /Do NOT assume their content/)
  assert.doesNotMatch(text, /read the relevant instruction files first and follow them/)
  assert.doesNotMatch(text, /before doing work with bash or str_replace_editor, check dev_tool_search/)
})


test('durable hint event prevents reinjection after a simulated restart', async () => {
  const session = { id: 'restart-session', events: [{ type: 'assistant/message' }], header: { cwd: 'C:\\nonexistent', delegationDepth: 0 } }
  const first = register()
  const firstDecision = await first(
    { agent: { session } },
    async () => ({ kind: 'enter', messages: [{ id: 'user', role: 'user', content: [] }] }),
  )
  const hint = firstDecision.messages.find((message) => message.id?.startsWith('instruction-hint-'))
  assert.ok(hint)
  session.events.push({ type: 'user/message', data: { source: { kind: 'instruction-hint' } } })
  first.observe(session, session.events.at(-1))

  const restarted = register()
  const restartedDecision = await restarted(
    { agent: { session } },
    async () => ({ kind: 'enter', messages: [{ id: 'user', role: 'user', content: [] }] }),
  )
  assert.equal(restartedDecision.messages.some((message) => message.id?.startsWith('instruction-hint-')), false)
})

test('pre-promotion pre-step injects nothing', async () => {
  const listener = register()
  const decision = await listener(
    { agent: agent([]) },
    async () => ({ kind: 'enter', messages: [{ id: 'user', role: 'user', content: [] }] }),
  )
  assert.equal(decision.messages.length, 1)
})

test('subagents are promoted by default and receive the hint on their first request', async () => {
  const listener = register()
  const decision = await listener(
    { agent: agent([], 1) },
    async () => ({ kind: 'enter', messages: [{ id: 'user', role: 'user', content: [] }] }),
  )
  assert.ok(decision.messages.some((message) => message.id?.startsWith('instruction-hint-')))
})

test('includeSubagents: true makes subagents wait for their own promotion signal', async () => {
  const listener = register({ promoteOn: 'assistant-message', includeSubagents: true })
  const controlled = await listener(
    { agent: agent([], 1) },
    async () => ({ kind: 'enter', messages: [{ id: 'user', role: 'user', content: [] }] }),
  )
  assert.equal(controlled.messages.length, 1)

  const promoted = await listener(
    { agent: agent([{ type: 'assistant/message' }], 2) },
    async () => ({ kind: 'enter', messages: [{ id: 'user', role: 'user', content: [] }] }),
  )
  assert.ok(promoted.messages.some((message) => message.id?.startsWith('instruction-hint-')))
})
