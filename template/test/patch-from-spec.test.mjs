import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { applyPatchSpec } from '../../tools/patch-from-spec.mjs'

const COMPOSITION = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
`

test('patch-from-spec dry-run compiles a session-phase patch without writing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patch-spec-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'preset')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'agent.cordis.yml'), COMPOSITION)
  await writeFile(join(target, 'preset.yml'), 'name: Test Preset\norder: 1\n')
  const patch = join(root, 'zero.json')
  await writeFile(patch, JSON.stringify({
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
  }))

  const result = await applyPatchSpec({ target, patch, dryRun: true })
  assert.equal(result.result.written, false)
  assert.equal(result.compiled.mode, 'zero')
})
