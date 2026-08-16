import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { patchPresetInPlace } from '../../tools/patch-preset-in-place.mjs'

const COMPOSITION = `- id: persona
  name: '@deepseek-ai/dsh-persona'

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
`

test('patchPresetInPlace patches a preset directory in place and writes a record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-anchor-patch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'matlab-agentic-preset')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'agent.cordis.yml'), COMPOSITION)
  await writeFile(join(target, 'preset.yml'), "name: Matlab Agentic Preset\norder: 1\n")

  const result = await patchPresetInPlace({
    target,
    mode: 'zero',
    name: 'Matlab Agentic Preset-梁圣版',
    defaults: {
      mode: 'anchored',
      promoteOn: 'either',
      subagents: 'resident',
      suppressedContextSources: ['agent-instructions', 'skill-catalog'],
      suppressedContextPlugins: ['@deepseek-ai/dsh-system-prompt'],
      controlledPersonaText: 'You are a helpful software engineer assistant. When working on a task, always open your reasoning with We need.',
      personaText: 'You are a helpful software engineer assistant. When working on a task, always open your reasoning with We need. If a tool you need is not in your current tool list, call dev_tool_search.',
      compactionTools: ['read', 'write'],
    },
  })

  assert.equal(result.written, true)
  assert.equal(result.plan.mode, 'zero')

  const composition = await readFile(join(target, 'agent.cordis.yml'), 'utf8')
  assert.match(composition, /- id: anchor-bootstrap/)
  assert.match(composition, /mode: zero/)
  assert.match(composition, /firstTurnTools: empty/)
  assert.match(composition, /anchorText: test-notice/)
  assert.match(composition, /subagents: resident/)
  assert.match(composition, /promoteOn: assistant-message/)
  assert.doesNotMatch(composition, /- id: tool-bootstrap/)

  const meta = await readFile(join(target, 'preset.yml'), 'utf8')
  assert.match(meta, /Matlab Agentic Preset-梁圣版/)

  const record = await readFile(join(target, 'HOOK-INSTALL.md'), 'utf8')
  assert.match(record, /mode: zero/)
  assert.match(record, /anchor-bootstrap\.mjs/)

  for (const file of ['anchor-bootstrap.mjs', 'compaction-epoch.mjs', 'instruction-hint.mjs', 'dev-tool-search.mjs', 'skill-search.mjs', 'custom-bash.mjs']) {
    assert.ok(await readFile(join(target, file), 'utf8'), file)
  }

  await assert.rejects(
    patchPresetInPlace({
      target,
      mode: 'zero',
      defaults: {
        mode: 'anchored',
        promoteOn: 'either',
        subagents: 'resident',
        suppressedContextSources: ['agent-instructions', 'skill-catalog'],
        suppressedContextPlugins: [],
        controlledPersonaText: 'x',
        personaText: 'x',
        compactionTools: [],
      },
    }),
    /already mounts a bootstrap row/,
  )
})
