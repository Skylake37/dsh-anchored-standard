import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { applyLayeredPatch, buildLayeredRows } from '../../tools/layered-patch.mjs'
import { normalizePatchProfile } from '../../tools/patch-contract.mjs'

const COMPOSITION = `# source preset\n- id: persona\n  name: '@deepseek-ai/dsh-persona'\n\n- id: agent-instructions\n  name: '@deepseek-ai/dsh-agent-instructions'\n\n- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n\n- id: tool-skill\n  name: '@deepseek-ai/dsh-tool-skill'\n`

const PROFILE = normalizePatchProfile({
  apiVersion: 'dsh-anchored/v2',
  backend: 'layered',
  from: 'standard',
  mode: 'zero',
  hooks: {
    sessionPhase: { promoteOn: 'assistant-message', includeSubagents: true },
    contextGate: { enabled: true },
    toolBootstrap: { firstTurnTools: 'empty', promotedFallbackTools: ['bash', 'str_replace_editor'] },
    anchor: { kind: 'test-notice' },
    instructionHint: { enabled: true, oncePerSession: true, includeSubagents: true },
  },
})

test('buildLayeredRows renders independent context, zero-tool, anchor, and companion rows', () => {
  const rows = buildLayeredRows(PROFILE, ['bash', 'str_replace_editor'])
  assert.match(rows, /- id: context-gate/)
  assert.match(rows, /- id: zero-tool-bootstrap/)
  assert.match(rows, /- id: anchor-turn/)
  assert.match(rows, /- id: instruction-hint/)
  assert.doesNotMatch(rows, /anchor-bootstrap/)
  assert.ok(rows.indexOf('- id: context-gate') < rows.indexOf('- id: zero-tool-bootstrap'))
})
test('buildLayeredRows keeps think and wire-think mutually exclusive with toolchoice-adapter before wire-think', () => {
  const base = { apiVersion: 'dsh-anchored/v2', backend: 'layered', from: 'standard', mode: 'anchored' }
  const think = normalizePatchProfile({ ...base, hooks: { turnOpening: { enabled: true, kind: 'think' } } })
  const thinkRows = buildLayeredRows(think, ['bash', 'str_replace_editor'])
  assert.match(thinkRows, /- id: think-phase/)
  assert.doesNotMatch(thinkRows, /- id: wire-think/)
  assert.doesNotMatch(thinkRows, /- id: toolchoice-adapter/)

  const wire = normalizePatchProfile({ ...base, hooks: { turnOpening: { enabled: true, kind: 'wire-think', provider: 'deepseek-wire-think', defaultProvider: 'deepseek-official' } } })
  const wireRows = buildLayeredRows(wire, ['bash', 'str_replace_editor'])
  assert.match(wireRows, /- id: toolchoice-adapter/)
  assert.match(wireRows, /- id: wire-think/)
  assert.doesNotMatch(wireRows, /- id: think-phase/)
  assert.ok(wireRows.indexOf('- id: toolchoice-adapter') < wireRows.indexOf('- id: wire-think'))
})

test('layered turnOpening accepts think and wire-think while other future mechanisms are rejected', () => {
  const base = { apiVersion: 'dsh-anchored/v2', backend: 'layered', from: 'standard', mode: 'anchored' }
  assert.doesNotThrow(() => normalizePatchProfile({ ...base, hooks: { turnOpening: { enabled: true, kind: 'think' } } }))
  assert.doesNotThrow(() => normalizePatchProfile({ ...base, hooks: { turnOpening: { enabled: true, kind: 'wire-think', provider: 'deepseek-wire-think', defaultProvider: 'deepseek-official' } } }))
  assert.throws(() => normalizePatchProfile({ ...base, hooks: { turnOpening: { enabled: true, kind: 'wire-think', provider: 'same', defaultProvider: 'same' } } }), /must differ/)
  assert.throws(() => normalizePatchProfile({ ...base, hooks: { sessionSeed: { enabled: true } } }), /prefab/)
  assert.throws(() => normalizePatchProfile({ ...base, hooks: { gateway: { enabled: true } } }), /gateway/)
})

test('applyLayeredPatch dry-run preserves source text except declared injection rows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-layered-patch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'preset')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'agent.cordis.yml'), COMPOSITION)
  const result = await applyLayeredPatch({ target, profile: PROFILE, dryRun: true })
  assert.equal(result.written, false)
  assert.deepEqual(result.plan.filesToCopy, [
    'context-gate.mjs', 'compaction-epoch.mjs', 'instruction-hint.mjs',
    'dev-tool-search.mjs', 'skill-search.mjs', 'zero-tool-bootstrap.mjs', 'anchor-turn.mjs',
  ])
  assert.match(result.composition, /disabled: true/)
  assert.match(result.composition, /- id: context-gate/)
  assert.doesNotMatch(await readFile(join(target, 'agent.cordis.yml'), 'utf8'), /context-gate/)
})
