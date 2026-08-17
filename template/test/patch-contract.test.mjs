import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CANONICAL_ROW_ORDER,
  canonicalRowOrder,
  compileSupportedPatch,
  duplicatePatchRows,
  normalizePatchProfile,
} from '../../tools/patch-contract.mjs'

const zero = {
  apiVersion: 'dsh-anchored/v2',
  from: 'standard',
  mode: 'zero',
  hooks: {
    sessionPhase: { promoteOn: 'assistant-message', includeSubagents: true },
    contextGate: { enabled: true },
    toolBootstrap: { firstTurnTools: 'empty', promotedFallbackTools: ['bash', 'str_replace_editor'] },
    anchor: { kind: 'test-notice' },
    instructionHint: { enabled: true, oncePerSession: true, includeSubagents: true },
  },
}

test('normalizePatchProfile validates and supplies safe defaults', () => {
  const profile = normalizePatchProfile(zero)
  assert.equal(profile.apiVersion, 'dsh-anchored/v2')
  assert.equal(profile.mode, 'zero')
  assert.deepEqual(profile.hooks.toolBootstrap.promotedTools, ['dev_tool_search', 'skill_search', 'skill_load'])
  assert.deepEqual(profile.hooks.toolBootstrap.promotedFallbackTools, ['bash', 'str_replace_editor'])
})

test('compileSupportedPatch maps the supported session layers to legacy options', () => {
  const compiled = compileSupportedPatch(zero)
  assert.equal(compiled.mode, 'zero')
  assert.equal(compiled.promoteOn, 'assistant-message')
  assert.equal(compiled.subagents, 'anchor')
  assert.deepEqual(compiled.compactionTools, ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question'])
})

test('anchor/profile combinations fail loudly', () => {
  assert.throws(() => normalizePatchProfile({ ...zero, mode: 'whoami' }), /whoami requires anchor.kind whoami/)
  assert.throws(() => normalizePatchProfile({ ...zero, hooks: { ...zero.hooks, sessionPhase: { promoteOn: 'either' } } }), /requires sessionPhase.promoteOn assistant-message/)
  const whoami = {
    ...zero,
    mode: 'whoami',
    hooks: {
      ...zero.hooks,
      anchor: { kind: 'whoami' },
      toolBootstrap: { firstTurnTools: 'empty', promotedFallbackTools: ['bash'] },
    },
  }
  assert.throws(() => normalizePatchProfile(whoami), /whoami promotedFallbackTools are not supported/)
})

test('unsupported future layers fail at compile time instead of being ignored', () => {
  const profile = { ...zero, hooks: { ...zero.hooks, turnOpening: { enabled: true } } }
  assert.throws(() => compileSupportedPatch(profile), /turnOpening/)
})

test('session seed cannot silently combine with a live anchor', () => {
  const profile = { ...zero, hooks: { ...zero.hooks, sessionSeed: { enabled: true } } }
  assert.throws(() => normalizePatchProfile(profile), /sessionSeed cannot combine/)
})

test('canonicalRowOrder keeps context gate outermost', () => {
  const order = canonicalRowOrder(['instruction-hint', 'tool-bootstrap', 'context-gate', 'anchor-turn'])
  assert.deepEqual(order, ['context-gate', 'tool-bootstrap', 'anchor-turn', 'instruction-hint'])
  assert.equal(CANONICAL_ROW_ORDER[0], 'context-gate')
})

test('duplicatePatchRows detects source hook collisions', () => {
  const composition = '- id: context-gate\n- id: anchor-bootstrap\n- id: persona\n'
  assert.deepEqual(duplicatePatchRows(composition, zero), ['anchor-bootstrap', 'context-gate'])
})
