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

test('buildLayeredRows composes think and tool-execution layers independently', () => {
  const profile = normalizePatchProfile({
    apiVersion: 'dsh-anchored/v2',
    backend: 'layered',
    from: 'standard',
    mode: 'anchored',
    hooks: {
      turnOpening: { enabled: true, kind: 'think', mode: 'first-turn' },
      toolExecution: {
        deliberationGate: { enabled: true, minChars: 500, maxGatesPerTurn: 1 },
        cotDrip: { enabled: true, every: 4, maxPerTurn: 1 },
      },
    },
  })
  const rows = buildLayeredRows(profile, ['bash', 'str_replace_editor'])
  assert.match(rows, /- id: think-phase/)
  assert.match(rows, /- id: deliberation-gate/)
  assert.match(rows, /- id: cot-drip/)
  assert.ok(rows.indexOf('- id: think-phase') < rows.indexOf('- id: deliberation-gate'))
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
