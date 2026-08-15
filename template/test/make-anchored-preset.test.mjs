import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildBootstrapRow,
  DEFAULTS_SOURCE,
  detectBootstrapTools,
  generateAnchoredPreset,
  hasRow,
  insertBootstrapRow,
  loadTemplateDefaults,
  MINIMAL_BOOTSTRAP_TOOLS,
  parseArgs,
  patchGuardedBundle,
  patchPresetMeta,
  readMetaField,
  stampMinimalToolRows,
  swapToolCordisRow,
} from '../../tools/make-anchored-preset.mjs'

const STANDARD_COMPOSITION = `# leading comment block
# stays above the inserted row
- id: persona
  name: '@deepseek-ai/dsh-persona'

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

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

const ARBITRARY_COMPOSITION = `- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
`

const CORDIS_COMPOSITION = `${STANDARD_COMPOSITION}
- id: tool-cordis
  name: '@deepseek-ai/dsh-tool-cordis'
`

/** The two exact markers the guard patch matches in the deployed bundle. */
const CORDIS_BUNDLE = 'const name = "tool-cordis";\n\tfor (const provider of hostInspectProviders(ctx)) ctx.effect(() => ctx.cordisInspect.register(provider), `tool-cordis: inspect ${provider.manifest.id}`);\n'

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
  delegationDepthExempt: true,
  suppressedContextSources: ['agent-instructions', 'skill-catalog'],
  suppressedContextPlugins: ['@deepseek-ai/dsh-system-prompt'],
  bootstrapPersonaText: 'You are a helpful software engineer assistant.',
}

test('detectBootstrapTools pins the PR14 Minimal pair for both supported families', () => {
  assert.deepEqual(detectBootstrapTools(STANDARD_COMPOSITION), MINIMAL_BOOTSTRAP_TOOLS)
  assert.deepEqual(detectBootstrapTools(MINIMAL_COMPOSITION), MINIMAL_BOOTSTRAP_TOOLS)
  assert.equal(detectBootstrapTools(ARBITRARY_COMPOSITION), undefined)
  // The persistent-bash package name must not satisfy the plain bash matcher.
  assert.deepEqual(
    detectBootstrapTools(`- id: x
  name: '@deepseek-ai/dsh-tool-bash-persistent'
`),
    MINIMAL_BOOTSTRAP_TOOLS,
  )
})

test('stampMinimalToolRows adds both Minimal groups and disables standard tool-bash', () => {
  const stamped = stampMinimalToolRows(STANDARD_COMPOSITION, MINIMAL_BOOTSTRAP_TOOLS)
  assert.deepEqual(stamped.appended, ['persistent-shell', 'bootstrap-filesystem'])
  assert.equal(stamped.toolBashDisabled, true)
  assert.match(stamped.composition, /- id: persistent-shell/)
  assert.match(stamped.composition, /@deepseek-ai\/dsh-tool-bash-persistent/)
  assert.match(stamped.composition, /- id: bootstrap-filesystem/)
  assert.match(stamped.composition, /@deepseek-ai\/dsh-tool-str-replace-editor/)
  const toolBashBlock = stamped.composition.split('- id: tool-pwsh')[0]
  assert.match(toolBashBlock, /- id: tool-bash\s*\n\s*disabled: true/)
})

test('stampMinimalToolRows is a no-op for a composition already mounting the pair', () => {
  const stamped = stampMinimalToolRows(MINIMAL_COMPOSITION, MINIMAL_BOOTSTRAP_TOOLS)
  assert.deepEqual(stamped.appended, [])
  assert.equal(stamped.toolBashDisabled, false)
  assert.doesNotMatch(stamped.composition, /- id: persistent-shell/)
  assert.doesNotMatch(stamped.composition, /- id: bootstrap-filesystem/)
})

test('buildBootstrapRow pins tools and omits the cap unless asked', () => {
  const uncapped = buildBootstrapRow(MINIMAL_BOOTSTRAP_TOOLS, TEMPLATE_DEFAULTS)
  assert.match(uncapped, /bootstrapTools: \["bash", "str_replace_editor"\]/)
  assert.match(uncapped, /promoteOn: either/)
  assert.match(uncapped, /suppressedContextSources: \["agent-instructions", "skill-catalog"\]/)
  assert.match(uncapped, /suppressedContextPlugins: \["@deepseek-ai\/dsh-system-prompt"\]/)
  assert.match(uncapped, /bootstrapPersonaText: "You are a helpful software engineer assistant\."/)
  assert.doesNotMatch(uncapped, /bootstrapMaxTokens/)
  const capped = buildBootstrapRow(['bash'], { ...TEMPLATE_DEFAULTS, bootstrapMaxTokens: 1024 })
  assert.match(capped, /bootstrapMaxTokens: 1024/)
  const bare = buildBootstrapRow(['bash'], { ...TEMPLATE_DEFAULTS, bootstrapPersonaText: undefined, suppressedContextPlugins: [] })
  assert.doesNotMatch(bare, /bootstrapPersonaText/)
  assert.doesNotMatch(bare, /suppressedContextPlugins/)
})

test('insertBootstrapRow puts the hook row before every other entry and keeps leading comments', () => {
  const row = buildBootstrapRow(MINIMAL_BOOTSTRAP_TOOLS, TEMPLATE_DEFAULTS)
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

test('loadTemplateDefaults reads the PR14 defaults and carries no maxTokens default', async () => {
  const defaults = await loadTemplateDefaults()
  assert.equal(defaults.promoteOn, 'either')
  assert.equal(defaults.delegationDepthExempt, true)
  assert.deepEqual(defaults.suppressedContextSources, ['agent-instructions', 'skill-catalog'])
  assert.deepEqual(defaults.suppressedContextPlugins, ['@deepseek-ai/dsh-system-prompt'])
  assert.equal(defaults.bootstrapPersonaText, 'You are a helpful software engineer assistant.')
  assert.equal('bootstrapMaxTokens' in defaults, false)
  assert.equal(DEFAULTS_SOURCE.href.includes('/template/defaults.json'), true)
})

test('generateAnchoredPreset stamps a working anchored copy of a standard preset', async (t) => {
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
  assert.deepEqual(result.plan.bootstrapTools, MINIMAL_BOOTSTRAP_TOOLS)
  assert.deepEqual(result.plan.appendedToolGroups, ['persistent-shell', 'bootstrap-filesystem'])
  assert.equal(result.plan.toolBashDisabled, true)
  const target = join(root, 'out', 'standard-anchored')
  const composition = await readFile(join(target, 'agent.cordis.yml'), 'utf8')
  assert.ok(hasRow(composition, 'tool-bootstrap'))
  assert.ok(composition.indexOf('- id: tool-bootstrap') < composition.indexOf('- id: persona'))
  assert.match(composition, /name: \.\/tool-bootstrap\.mjs/)
  assert.match(composition, /bootstrapTools: \["bash", "str_replace_editor"\]/)
  assert.doesNotMatch(composition, /bootstrapMaxTokens/)
  assert.match(composition, /suppressedContextPlugins: \["@deepseek-ai\/dsh-system-prompt"\]/)
  assert.match(composition, /bootstrapPersonaText: "You are a helpful software engineer assistant\."/)
  assert.match(composition, /- id: persistent-shell/)
  assert.match(composition, /- id: bootstrap-filesystem/)
  const hook = await readFile(join(target, 'tool-bootstrap.mjs'), 'utf8')
  assert.match(hook, /export const name = 'anchored-tool-bootstrap'/)
  const meta = await readFile(join(target, 'preset.yml'), 'utf8')
  assert.match(meta, /标准模式 Anchored \(experimental\)/)
})

test('generateAnchoredPreset auto-succeeds on a Minimal-family preset without adding groups', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-anchor-template-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const minimalDir = await fixturePreset(root, 'minimal', MINIMAL_COMPOSITION)
  const result = await generateAnchoredPreset({
    from: minimalDir,
    to: 'minimal-anchored',
    root: join(root, 'out'),
    defaults: TEMPLATE_DEFAULTS,
  })
  assert.deepEqual(result.plan.bootstrapTools, MINIMAL_BOOTSTRAP_TOOLS)
  assert.deepEqual(result.plan.appendedToolGroups, [])
  assert.equal(result.plan.toolBashDisabled, false)
  const composition = await readFile(join(root, 'out', 'minimal-anchored', 'agent.cordis.yml'), 'utf8')
  assert.doesNotMatch(composition, /- id: persistent-shell/)
  assert.doesNotMatch(composition, /- id: bootstrap-filesystem/)
})

test('generateAnchoredPreset fails loud for unknown families and refuses double stamping', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-anchor-template-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const arbitraryDir = await fixturePreset(root, 'arbitrary', ARBITRARY_COMPOSITION)
  await assert.rejects(
    generateAnchoredPreset({ from: arbitraryDir, root: join(root, 'out'), defaults: TEMPLATE_DEFAULTS }),
    /--bootstrap-tools/,
  )
  const explicit = await generateAnchoredPreset({
    from: arbitraryDir,
    to: 'arbitrary-anchored',
    root: join(root, 'out'),
    bootstrapTools: 'pwsh',
    defaults: TEMPLATE_DEFAULTS,
  })
  assert.deepEqual(explicit.plan.bootstrapTools, ['pwsh'])
  await assert.rejects(
    generateAnchoredPreset({
      from: join(root, 'out', 'arbitrary-anchored'),
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
  const parsed = parseArgs(['--from', 'standard', '--bootstrap-tools', 'bash,str_replace_editor', '--max-tokens', '2048', '--dry-run'])
  assert.equal(parsed.from, 'standard')
  assert.equal(parsed.bootstrapTools, 'bash,str_replace_editor')
  assert.equal(parsed.bootstrapMaxTokens, 2048)
  assert.equal(parsed.dryRun, true)
  assert.throws(() => parseArgs(['--nope']), /unknown option/)
  assert.throws(() => parseArgs(['--from']), /requires a value/)
})

test('patchGuardedBundle guards the registration and renames the plugin', () => {
  const patched = patchGuardedBundle(CORDIS_BUNDLE)
  assert.match(patched, /const name = "tool-cordis-guarded";/)
  assert.match(patched, /already registered/)
  assert.doesNotMatch(patched, /const name = "tool-cordis";/)
  assert.throws(() => patchGuardedBundle('const name = "tool-cordis";'), /registration loop marker/)
  assert.throws(() => patchGuardedBundle('no markers at all'), /plugin name marker/)
})

test('swapToolCordisRow swaps to the local guarded bundle', () => {
  const swapped = swapToolCordisRow(CORDIS_COMPOSITION)
  assert.match(swapped, /- id: tool-cordis\n  name: \.\/tool-cordis-guarded\.mjs/)
  assert.doesNotMatch(swapped, /name: '@deepseek-ai\/dsh-tool-cordis'/)
  assert.throws(() => swapToolCordisRow(STANDARD_COMPOSITION), /row text was not found/)
})

test('generateAnchoredPreset requires the guard bundle for tool-cordis sources and stamps it when given', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-anchor-template-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cordisDir = await fixturePreset(root, 'cordis', CORDIS_COMPOSITION)
  await assert.rejects(
    generateAnchoredPreset({ from: cordisDir, to: 'cordis-anchored', root: join(root, 'out'), defaults: TEMPLATE_DEFAULTS }),
    /--guard-cordis-tools/,
  )
  const bundlePath = join(root, 'deployed-index.js')
  await writeFile(bundlePath, CORDIS_BUNDLE)
  const result = await generateAnchoredPreset({
    from: cordisDir,
    to: 'cordis-anchored',
    root: join(root, 'out'),
    guardCordisTools: bundlePath,
    defaults: TEMPLATE_DEFAULTS,
  })
  assert.equal(result.plan.guardedCordisTools, true)
  const composition = await readFile(join(root, 'out', 'cordis-anchored', 'agent.cordis.yml'), 'utf8')
  assert.match(composition, /name: \.\/tool-cordis-guarded\.mjs/)
  assert.doesNotMatch(composition, /name: '@deepseek-ai\/dsh-tool-cordis'/)
  const guarded = await readFile(join(root, 'out', 'cordis-anchored', 'tool-cordis-guarded.mjs'), 'utf8')
  assert.match(guarded, /already registered/)
  assert.match(guarded, /tool-cordis-guarded/)
})
