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

test('unsupported future layered mechanisms are rejected', () => {
  assert.throws(() => normalizePatchProfile({ apiVersion: 'dsh-anchored/v2', backend: 'layered', from: 'standard', mode: 'anchored', hooks: { turnOpening: { enabled: true, kind: 'think' } } }), /think-phase/)
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
