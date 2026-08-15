import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildBootstrapRow,
  DEFAULTS_SOURCE,
  detectBootstrapFilter,
  generateAnchoredPreset,
  hasRow,
  insertBootstrapRow,
  loadTemplateDefaults,
  parseArgs,
  patchPresetMeta,
  readMetaField,
} from '../../tools/make-anchored-preset.mjs'

const STANDARD_COMPOSITION = `# leading comment block
# stays above the inserted row
- id: persona
  name: '@deepseek-ai/dsh-persona'

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`

const MINIMAL_COMPOSITION = `- id: pty
  name: '@deepseek-ai/dsh-terminal'

- id: persistent-bash
  name: '@deepseek-ai/dsh-tool-bash-persistent'

- id: str-replace-editor
  name: '@deepseek-ai/dsh-tool-str-replace-editor'
`

const META = `name: 标准模式
description: 功能完整。
order: 1
`

async function fixturePreset(parent, id, composition = STANDARD_COMPOSITION) {
  const dir = join(parent, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'agent.cordis.yml'), composition)
  await writeFile(join(dir, 'preset.yml'), META)
  return dir
}

const TEMPLATE_DEFAULTS = {
  promoteOn: 'either',
  bootstrapMaxTokens: 1024,
  delegationDepthExempt: true,
  suppressedContextSources: ['skill-catalog', 'agent-instructions'],
}

test('detectBootstrapFilter finds the shell+read arrangement only when all parts exist', () => {
  assert.deepEqual(detectBootstrapFilter(STANDARD_COMPOSITION), {
    kind: 'legacy',
    shellTools: ['bash', 'pwsh'],
    commonTools: ['read'],
  })
  assert.equal(detectBootstrapFilter(MINIMAL_COMPOSITION), undefined)
  // The persistent-bash package name must not satisfy the plain bash matcher.
  assert.equal(hasRow(STANDARD_COMPOSITION.replace('@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-bash-persistent'), 'tool-bash'), true)
  assert.equal(detectBootstrapFilter(`- id: x
  name: '@deepseek-ai/dsh-tool-bash-persistent'

- id: y
  name: '@deepseek-ai/dsh-tool-str-replace-editor'
`), undefined)
})

test('buildBootstrapRow renders exact and legacy filters', () => {
  const exact = buildBootstrapRow({ kind: 'exact', tools: ['persistent-bash'] }, TEMPLATE_DEFAULTS)
  assert.match(exact, /bootstrapTools: \["persistent-bash"\]/)
  assert.match(exact, /promoteOn: either/)
  assert.match(exact, /suppressedContextSources: \["skill-catalog", "agent-instructions"\]/)
  const legacy = buildBootstrapRow({ kind: 'legacy', shellTools: ['bash', 'pwsh'], commonTools: ['read'] }, TEMPLATE_DEFAULTS)
  assert.match(legacy, /shellTools: \["bash", "pwsh"\]/)
  assert.match(legacy, /commonTools: \["read"\]/)
})

test('insertBootstrapRow puts the hook row before every other entry and keeps leading comments', () => {
  const row = buildBootstrapRow({ kind: 'exact', tools: ['pwsh', 'read'] }, TEMPLATE_DEFAULTS)
  const patched = insertBootstrapRow(STANDARD_COMPOSITION, row)
  const lines = patched.split('\n')
  assert.equal(lines[0], '# leading comment block')
  const firstEntry = lines.findIndex(line => /^\s*-\s/.test(line))
  assert.match(lines[firstEntry], /- id: tool-bootstrap/)
  assert.ok(lines.indexOf('- id: persona') > firstEntry)
  assert.ok(patched.endsWith('\n'))
})

test('patchPresetMeta replaces known fields in place and appends missing ones', () => {
  const patched = patchPresetMeta(META, {
    name: '标准模式 Anchored (experimental)',
    description: 'Anchored copy of standard.',
    order: 5,
  })
  assert.match(patched, /^name: '标准模式 Anchored \(experimental\)'$/m)
  assert.match(patched, /^description: 'Anchored copy of standard\.'$/m)
  assert.match(patched, /^order: 5$/m)
  assert.equal(readMetaField(patched, 'name'), '标准模式 Anchored (experimental)')
})

test('loadTemplateDefaults reads the shipped template/defaults.json', async () => {
  const defaults = await loadTemplateDefaults()
  assert.equal(defaults.promoteOn, 'either')
  assert.equal(defaults.bootstrapMaxTokens, 1024)
  assert.equal(defaults.delegationDepthExempt, true)
  assert.deepEqual(defaults.suppressedContextSources, ['skill-catalog', 'agent-instructions'])
  assert.equal(DEFAULTS_SOURCE.href.includes('/template/defaults.json'), true)
})

test('generateAnchoredPreset stamps a working anchored copy end to end', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-anchor-template-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceDir = await fixturePreset(root, 'standard')

  const result = await generateAnchoredPreset({
    from: sourceDir,
    to: 'standard-anchored',
    root: join(root, 'out'),
    defaults: TEMPLATE_DEFAULTS,
  })

  assert.equal(result.written, true)
  assert.equal(result.plan.id, 'standard-anchored')
  assert.equal(result.plan.filter.kind, 'legacy')
  const target = join(root, 'out', 'standard-anchored')
  const composition = await readFile(join(target, 'agent.cordis.yml'), 'utf8')
  assert.ok(hasRow(composition, 'tool-bootstrap'))
  assert.ok(composition.indexOf('- id: tool-bootstrap') < composition.indexOf('- id: persona'))
  assert.match(composition, /name: \.\/tool-bootstrap\.mjs/)
  assert.match(composition, /suppressedContextSources: \["skill-catalog", "agent-instructions"\]/)
  const hook = await readFile(join(target, 'tool-bootstrap.mjs'), 'utf8')
  assert.match(hook, /export const name = 'anchored-tool-bootstrap'/)
  const meta = await readFile(join(target, 'preset.yml'), 'utf8')
  assert.match(meta, /标准模式 Anchored \(experimental\)/)
})

test('generateAnchoredPreset refuses sources without a detectable surface and refuses double stamping', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-anchor-template-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const minimalDir = await fixturePreset(root, 'minimal', MINIMAL_COMPOSITION)
  await assert.rejects(
    generateAnchoredPreset({ from: minimalDir, root: join(root, 'out'), defaults: TEMPLATE_DEFAULTS }),
    /--bootstrap-tools/,
  )
  const explicit = await generateAnchoredPreset({
    from: minimalDir,
    to: 'minimal-anchored',
    root: join(root, 'out'),
    bootstrapTools: 'persistent-bash',
    defaults: TEMPLATE_DEFAULTS,
  })
  assert.equal(explicit.plan.filter.kind, 'exact')
  assert.deepEqual(explicit.plan.filter.tools, ['persistent-bash'])
  await assert.rejects(
    generateAnchoredPreset({
      from: join(root, 'out', 'minimal-anchored'),
      to: 'twice',
      root: join(root, 'out'),
      defaults: TEMPLATE_DEFAULTS,
    }),
    /already mounts a tool-bootstrap row/,
  )
})

test('generateAnchoredPreset refuses to overwrite and supports dry-run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-anchor-template-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceDir = await fixturePreset(root, 'standard')
  const options = { from: sourceDir, to: 'demo-anchored', root: join(root, 'out'), defaults: TEMPLATE_DEFAULTS }
  const dry = await generateAnchoredPreset({ ...options, dryRun: true })
  assert.equal(dry.written, false)
  await generateAnchoredPreset(options)
  await assert.rejects(generateAnchoredPreset(options), /already exists/)
})

test('parseArgs maps CLI options and rejects unknown flags', () => {
  const parsed = parseArgs(['--from', 'standard', '--bootstrap-tools', 'pwsh,read', '--max-tokens', '2048', '--dry-run'])
  assert.equal(parsed.from, 'standard')
  assert.equal(parsed.bootstrapTools, 'pwsh,read')
  assert.equal(parsed.bootstrapMaxTokens, 2048)
  assert.equal(parsed.dryRun, true)
  assert.throws(() => parseArgs(['--nope']), /unknown option/)
  assert.throws(() => parseArgs(['--from']), /requires a value/)
})
