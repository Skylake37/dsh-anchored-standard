import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildAnchorBootstrapRow,
  buildCompanionRows,
  DEFAULTS_SOURCE,
  detectBootstrapTools,
  generateAnchoredPreset,
  hasRow,
  insertBootstrapRow,
  loadTemplateDefaults,
  MINIMAL_BOOTSTRAP_TOOLS,
  MODE_PROFILES,
  parseArgs,
  patchGuardedBundle,
  patchPresetMeta,
  readMetaField,
  renderCustomBashRow,
  stampMinimalToolRows,
  swapToolCordisRow,
} from '../../tools/make-anchored-preset.mjs'

const STANDARD_COMPOSITION = `# leading comment block
# stays above the inserted row
- id: persona
  name: '@deepseek-ai/dsh-persona'

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
`

const MINIMAL_COMPOSITION = `- id: pty
  name: '@deepseek-ai/dsh-terminal'

- id: persistent-bash
  name: '@deepseek-ai/dsh-tool-bash-persistent'

- id: str-replace-editor
  name: '@deepseek-ai/dsh-tool-str-replace-editor'
`

const MINIMAL_GROUP_COMPOSITION = `- id: persistent-shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'

    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'

- id: filesystem
  name: cordis:group
  isolate:
    fs: true
  config:
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

/** The three exact markers the guard patch matches in the deployed bundle. */
const CORDIS_BUNDLE = 'const name = "tool-cordis";\n'
  + '/** Register the Cordis tools and explicit `@pluginId` context injection. */\n'
  + 'function apply(ctx) {\n'
  + '\tfor (const provider of hostInspectProviders(ctx)) ctx.effect(() => ctx.cordisInspect.register(provider), `tool-cordis: inspect ${provider.manifest.id}`);\n'

const META = `name: 标准模式
description: 功能完整。
order: 1
`

const CONTROLLED_PERSONA = 'You are a helpful software engineer assistant. When working on a task, always open your reasoning with We need.'
const FULL_PERSONA = CONTROLLED_PERSONA

const TEMPLATE_DEFAULTS = {
  mode: 'anchored',
  promoteOn: 'either',
  subagents: 'resident',
  suppressedContextSources: ['agent-instructions', 'skill-catalog'],
  suppressedContextPlugins: ['@deepseek-ai/dsh-system-prompt'],
  controlledPersonaText: CONTROLLED_PERSONA,
  personaText: FULL_PERSONA,
  compactionTools: ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question'],
}

async function fixturePreset(parent, id, composition = STANDARD_COMPOSITION) {
  const dir = join(parent, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'agent.cordis.yml'), composition)
  await writeFile(join(dir, 'preset.yml'), META)
  return dir
}

test('detectBootstrapTools pins the PR14 Minimal pair for both supported families', () => {
  assert.deepEqual(detectBootstrapTools(STANDARD_COMPOSITION), MINIMAL_BOOTSTRAP_TOOLS)
  assert.deepEqual(detectBootstrapTools(MINIMAL_COMPOSITION), MINIMAL_BOOTSTRAP_TOOLS)
  assert.deepEqual(detectBootstrapTools(MINIMAL_GROUP_COMPOSITION), MINIMAL_BOOTSTRAP_TOOLS)
  assert.equal(detectBootstrapTools(ARBITRARY_COMPOSITION), undefined)
  assert.deepEqual(
    detectBootstrapTools(`- id: x
  name: '@deepseek-ai/dsh-tool-bash-persistent'
`),
    MINIMAL_BOOTSTRAP_TOOLS,
  )
})

test('stampMinimalToolRows adds both Minimal groups, windows custom-bash, and disables standard tool-bash', () => {
  const stamped = stampMinimalToolRows(STANDARD_COMPOSITION, MINIMAL_BOOTSTRAP_TOOLS)
  assert.deepEqual(stamped.appended, ['persistent-shell', 'bootstrap-filesystem', 'custom-bash'])
  assert.equal(stamped.toolBashDisabled, true)
  assert.match(stamped.composition, /- id: persistent-shell/)
  assert.match(stamped.composition, /@deepseek-ai\/dsh-tool-bash-persistent/)
  assert.match(stamped.composition, /disabled: !!js process\.platform === 'win32'/)
  assert.match(stamped.composition, /- id: bootstrap-filesystem/)
  assert.match(stamped.composition, /@deepseek-ai\/dsh-tool-str-replace-editor/)
  assert.match(stamped.composition, /- id: custom-bash/)
  assert.match(stamped.composition, /name: \.\/custom-bash\.mjs/)
  const toolBashBlock = stamped.composition.split('- id: tool-pwsh')[0]
  assert.match(toolBashBlock, /- id: tool-bash\s*\n\s*disabled: true/)
})

test('stampMinimalToolRows disables an existing Minimal-family persistent-shell on win32 and adds custom-bash', () => {
  const stamped = stampMinimalToolRows(MINIMAL_GROUP_COMPOSITION, MINIMAL_BOOTSTRAP_TOOLS)
  assert.deepEqual(stamped.appended, ['custom-bash'])
  assert.equal(stamped.toolBashDisabled, false)
  assert.equal(stamped.sourcePersistentShellWindowsGuarded, true)
  assert.match(stamped.composition, /- id: persistent-shell\s*\n\s*disabled: !!js process\.platform === 'win32'/)
  assert.match(stamped.composition, /- id: custom-bash/)
})

test('stampMinimalToolRows adds custom-bash when bash is pinned, without touching the rest', () => {
  const stamped = stampMinimalToolRows(MINIMAL_COMPOSITION, MINIMAL_BOOTSTRAP_TOOLS)
  assert.deepEqual(stamped.appended, ['custom-bash'])
  assert.equal(stamped.toolBashDisabled, false)
  assert.match(stamped.composition, /- id: custom-bash/)
  assert.doesNotMatch(stamped.composition, /- id: bootstrap-filesystem/)
})

test('buildAnchorBootstrapRow renders the anchored profile row', () => {
  const row = buildAnchorBootstrapRow({ ...TEMPLATE_DEFAULTS, bootstrapTools: MINIMAL_BOOTSTRAP_TOOLS })
  assert.match(row, /- id: anchor-bootstrap/)
  assert.match(row, /name: \.\/anchor-bootstrap\.mjs/)
  assert.match(row, /mode: anchored/)
  assert.match(row, /firstTurnTools: minimal/)
  assert.match(row, /anchorText: none/)
  assert.match(row, /subagents: resident/)
  assert.match(row, /bootstrapTools: \["bash", "str_replace_editor"\]/)
  assert.match(row, /promoteOn: either/)
  assert.match(row, /controlledPersonaText: "You are a helpful software engineer assistant\. When working on a task, always open your reasoning with We need\."/)
  assert.match(row, /personaText: "You are a helpful software engineer assistant\. When working on a task, always open your reasoning with We need\."/)
  assert.match(row, /compactionTools:/)
  assert.doesNotMatch(row, /bootstrapMaxTokens/)
})

test('buildAnchorBootstrapRow renders the zero and whoami profile rows', () => {
  const zero = buildAnchorBootstrapRow({ ...TEMPLATE_DEFAULTS, mode: 'zero', promoteOn: undefined })
  assert.match(zero, /mode: zero/)
  assert.match(zero, /firstTurnTools: empty/)
  assert.match(zero, /anchorText: test-notice/)
  assert.match(zero, /subagents: resident/)
  assert.match(zero, /promoteOn: assistant-message/)
  assert.doesNotMatch(zero, /bootstrapTools:/)

  const whoami = buildAnchorBootstrapRow({ ...TEMPLATE_DEFAULTS, mode: 'whoami', promoteOn: undefined })
  assert.match(whoami, /mode: whoami/)
  assert.match(whoami, /firstTurnTools: empty/)
  assert.match(whoami, /anchorText: whoami/)
  assert.match(whoami, /subagents: anchor/)
  assert.match(whoami, /promoteOn: assistant-message/)
  assert.doesNotMatch(whoami, /bootstrapTools:/)
})

test('buildAnchorBootstrapRow applies the optional cap and rejects incompatible promoteOn', () => {
  const capped = buildAnchorBootstrapRow({ ...TEMPLATE_DEFAULTS, bootstrapMaxTokens: 1024 })
  assert.match(capped, /bootstrapMaxTokens: 1024/)
  assert.throws(() => buildAnchorBootstrapRow({ ...TEMPLATE_DEFAULTS, mode: 'zero', promoteOn: 'either' }), /assistant-message/)
  assert.throws(() => buildAnchorBootstrapRow({ mode: 'nope' }), /mode/)
})

test('buildCompanionRows renders the instruction hint and discovery tools', () => {
  const rows = buildCompanionRows({ promoteOn: 'tool-call' })
  assert.match(rows, /- id: instruction-hint/)
  assert.match(rows, /name: \.\/instruction-hint\.mjs/)
  assert.match(rows, /promoteOn: tool-call/)
  assert.match(rows, /- id: dev-tool-search/)
  assert.match(rows, /- id: skill-search/)
})

test('insertBootstrapRow puts the hook row before every other entry and keeps leading comments', () => {
  const row = buildAnchorBootstrapRow({ ...TEMPLATE_DEFAULTS, bootstrapTools: MINIMAL_BOOTSTRAP_TOOLS })
  const patched = insertBootstrapRow(STANDARD_COMPOSITION, row)
  const lines = patched.split('\n')
  assert.equal(lines[0], '# leading comment block')
  const firstEntry = lines.findIndex(line => /^\s*-\s/.test(line))
  assert.match(lines[firstEntry], /- id: anchor-bootstrap/)
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

test('loadTemplateDefaults reads the unified mode defaults', async () => {
  const defaults = await loadTemplateDefaults()
  assert.equal(defaults.mode, 'anchored')
  assert.equal(defaults.promoteOn, 'either')
  assert.equal(defaults.subagents, 'resident')
  assert.deepEqual(defaults.suppressedContextSources, ['agent-instructions', 'skill-catalog'])
  assert.deepEqual(defaults.suppressedContextPlugins, ['@deepseek-ai/dsh-system-prompt'])
  assert.equal(defaults.controlledPersonaText, CONTROLLED_PERSONA)
  assert.equal(defaults.personaText, FULL_PERSONA)
  assert.deepEqual(defaults.compactionTools, ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question'])
  assert.equal('bootstrapMaxTokens' in defaults, false)
  assert.equal(DEFAULTS_SOURCE.href.includes('/template/defaults.json'), true)
})

test('generateAnchoredPreset stamps the unified hook on a standard preset', async (t) => {
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
  assert.equal(result.plan.mode, 'anchored')
  assert.equal(result.plan.firstTurnTools, 'minimal')
  assert.equal(result.plan.anchorText, 'none')
  assert.equal(result.plan.subagents, 'resident')
  assert.deepEqual(result.plan.bootstrapTools, MINIMAL_BOOTSTRAP_TOOLS)
  assert.deepEqual(result.plan.appendedToolGroups, ['persistent-shell', 'bootstrap-filesystem', 'custom-bash'])
  assert.equal(result.plan.toolBashDisabled, true)
  assert.deepEqual(result.plan.disabledSourceRows.sort(), ['agent-instructions', 'tool-skill'])
  const target = join(root, 'out', 'standard-anchored')
  const composition = await readFile(join(target, 'agent.cordis.yml'), 'utf8')
  assert.ok(hasRow(composition, 'anchor-bootstrap'))
  assert.ok(composition.indexOf('- id: anchor-bootstrap') < composition.indexOf('- id: instruction-hint'))
  assert.ok(composition.indexOf('- id: instruction-hint') < composition.indexOf('- id: persona'))
  assert.match(composition, /name: \.\/anchor-bootstrap\.mjs/)
  assert.match(composition, /mode: anchored/)
  assert.match(composition, /firstTurnTools: minimal/)
  assert.match(composition, /anchorText: none/)
  assert.match(composition, /subagents: resident/)
  assert.match(composition, /bootstrapTools: \["bash", "str_replace_editor"\]/)
  assert.match(composition, /promoteOn: either/)
  assert.doesNotMatch(composition, /bootstrapMaxTokens/)
  assert.match(composition, /controlledPersonaText:/)
  assert.match(composition, /personaText:/)
  assert.match(composition, /suppressedContextPlugins: \["@deepseek-ai\/dsh-system-prompt"\]/)
  assert.match(composition, /compactionTools:/)
  assert.match(composition, /- id: instruction-hint/)
  assert.match(composition, /- id: dev-tool-search/)
  assert.match(composition, /- id: skill-search/)
  assert.match(composition, /- id: persistent-shell/)
  assert.match(composition, /- id: bootstrap-filesystem/)
  assert.match(composition, /- id: custom-bash/)
  const agentBlock = composition.split('- id: tool-bash')[0]
  assert.match(agentBlock, /- id: agent-instructions\s*\n\s*disabled: true/)
  assert.match(composition, /- id: tool-skill\s*\n\s*disabled: true/)
  for (const file of ['anchor-bootstrap.mjs', 'compaction-epoch.mjs', 'instruction-hint.mjs', 'dev-tool-search.mjs', 'skill-search.mjs', 'custom-bash.mjs']) {
    assert.ok(await readFile(join(target, file), 'utf8'), file)
  }
  for (const stale of ['tool-bootstrap.mjs', 'zero-tool-bootstrap.mjs', 'anchor-turn.mjs']) {
    await assert.rejects(readFile(join(target, stale), 'utf8'))
  }
  const hook = await readFile(join(target, 'anchor-bootstrap.mjs'), 'utf8')
  assert.match(hook, /export const name = 'anchor-bootstrap'/)
  assert.match(hook, /createEpochPromotion/)
  const meta = await readFile(join(target, 'preset.yml'), 'utf8')
  assert.match(meta, /标准模式 Anchored \(experimental\)/)
})

test('generateAnchoredPreset generates zero and whoami profiles with the single hook', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-anchor-template-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceDir = await fixturePreset(root, 'standard')

  const zero = await generateAnchoredPreset({
    from: sourceDir,
    to: 'standard-zero',
    root: join(root, 'out'),
    defaults: TEMPLATE_DEFAULTS,
    mode: 'zero',
  })
  assert.equal(zero.plan.mode, 'zero')
  assert.equal(zero.plan.firstTurnTools, 'empty')
  assert.equal(zero.plan.anchorText, 'test-notice')
  const zeroComposition = await readFile(join(root, 'out', 'standard-zero', 'agent.cordis.yml'), 'utf8')
  assert.match(zeroComposition, /- id: anchor-bootstrap/)
  assert.match(zeroComposition, /mode: zero/)
  assert.match(zeroComposition, /firstTurnTools: empty/)
  assert.match(zeroComposition, /anchorText: test-notice/)
  assert.match(zeroComposition, /promoteOn: assistant-message/)
  assert.doesNotMatch(zeroComposition, /bootstrapTools:/)

  const whoami = await generateAnchoredPreset({
    from: sourceDir,
    to: 'standard-whoami',
    root: join(root, 'out'),
    defaults: TEMPLATE_DEFAULTS,
    whoami: true,
  })
  assert.equal(whoami.plan.mode, 'whoami')
  assert.equal(whoami.plan.firstTurnTools, 'empty')
  assert.equal(whoami.plan.anchorText, 'whoami')
  assert.equal(whoami.plan.subagents, 'anchor')
  const whoamiComposition = await readFile(join(root, 'out', 'standard-whoami', 'agent.cordis.yml'), 'utf8')
  assert.match(whoamiComposition, /mode: whoami/)
  assert.match(whoamiComposition, /anchorText: whoami/)
  assert.match(whoamiComposition, /subagents: anchor/)
  assert.match(whoamiComposition, /promoteOn: assistant-message/)
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
    /already mounts a bootstrap row/,
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

test('parseArgs maps mode, persona flags, and the --whoami alias', () => {
  const parsed = parseArgs([
    '--from', 'standard',
    '--mode', 'whoami',
    '--bootstrap-tools', 'bash,str_replace_editor',
    '--max-tokens', '2048',
    '--compaction-tools', 'read,grep',
    '--win-bash-path', 'D:/Git/bin/bash.exe',
    '--persona-text', 'full persona',
    '--controlled-persona-text', 'controlled persona',
    '--dry-run',
  ])
  assert.equal(parsed.from, 'standard')
  assert.equal(parsed.mode, 'whoami')
  assert.equal(parsed.bootstrapTools, 'bash,str_replace_editor')
  assert.equal(parsed.bootstrapMaxTokens, 2048)
  assert.deepEqual(parsed.compactionTools, ['read', 'grep'])
  assert.equal(parsed.winBashPath, 'D:/Git/bin/bash.exe')
  assert.equal(parsed.personaText, 'full persona')
  assert.equal(parsed.controlledPersonaText, 'controlled persona')
  assert.equal(parsed.dryRun, true)
  assert.throws(() => parseArgs(['--nope']), /unknown option/)
  assert.throws(() => parseArgs(['--from']), /requires a value/)

  const legacy = parseArgs(['--from', 'standard', '--whoami'])
  assert.equal(legacy.whoami, true)
})

test('patchGuardedBundle guards the registration, tolerates duplicates on the shared registry, and renames the plugin', () => {
  const patched = patchGuardedBundle(CORDIS_BUNDLE)
  assert.match(patched, /const name = "tool-cordis-guarded";/)
  assert.match(patched, /already registered/)
  assert.match(patched, /installSharedRegisterGuard\(ctx\);/)
  assert.match(patched, /function installSharedRegisterGuard\(ctx\)/)
  assert.match(patched, /registry\.register = tolerant;/)
  assert.match(patched, /sharedNoopDisposer/)
  assert.doesNotMatch(patched, /const name = "tool-cordis";/)
  assert.throws(() => patchGuardedBundle('const name = "tool-cordis";'), /apply-function marker/)
  assert.throws(
    () => patchGuardedBundle('const name = "tool-cordis";\n/** Register the Cordis tools and explicit `@pluginId` context injection. */\nfunction apply(ctx) {'),
    /registration loop marker/,
  )
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

test('MODE_PROFILES exports the three validated profiles', () => {
  assert.deepEqual(MODE_PROFILES.anchored, { firstTurnTools: 'minimal', anchorText: 'none', subagents: 'resident', promoteOn: 'either' })
  assert.deepEqual(MODE_PROFILES.zero, { firstTurnTools: 'empty', anchorText: 'test-notice', subagents: 'resident', promoteOn: 'assistant-message' })
  assert.deepEqual(MODE_PROFILES.whoami, { firstTurnTools: 'empty', anchorText: 'whoami', subagents: 'anchor', promoteOn: 'assistant-message' })
})

test('renderCustomBashRow points at Git Bash', () => {
  assert.match(renderCustomBashRow(), /bashPath: 'C:\\Program Files\\Git\\bin\\bash\.exe'/)
})
