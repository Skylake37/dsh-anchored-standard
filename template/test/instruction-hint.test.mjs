import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../hook/instruction-hint.mjs'

function register() {
  let listener
  const ctx = {
    on(event, callback) {
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
  apply(ctx, { promoteOn: 'assistant-message' })
  assert.equal(typeof listener, 'function')
  return listener
}

const agent = (events = []) => ({
  session: { id: 's', events, header: { cwd: 'C:\\nonexistent' } },
})

test('exports the diagnostic plugin name', () => {
  assert.equal(name, 'instruction-hint')
})

test('post-promotion pre-step injects the tool guidance even without instruction files', async () => {
  const listener = register()
  const decision = await listener(
    { agent: agent([{ type: 'assistant/message' }]) },
    async () => ({ kind: 'enter', messages: [{ id: 'user', role: 'user', content: [] }] }),
  )
  const hint = decision.messages.find((message) => message.id?.startsWith('instruction-hint-'))
  assert.ok(hint, 'expected a hint message')
  const text = hint.content[0].text
  assert.match(text, /Tool guidance:/)
  assert.match(text, /dev_tool_search/)
  assert.match(text, /purpose-built tool/)
})

test('pre-promotion pre-step injects nothing', async () => {
  const listener = register()
  const decision = await listener(
    { agent: agent([]) },
    async () => ({ kind: 'enter', messages: [{ id: 'user', role: 'user', content: [] }] }),
  )
  assert.equal(decision.messages.length, 1)
})
