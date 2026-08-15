import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildBootstrapRow,
  buildCompanionRows,
  buildWhoamiRows,
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
  bootstrapPersonaText: 'You are a helpful software engineer assistant. When working on a task, always open your reasoning with We need. If a tool you need is not in your current tool list, do not conclude it is unavailable: after your first tool call, call dev_tool_search with no query to list every unlockable tool, then unlock the exact names.',
  compactionTools: ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question'],
}

test('detectBootstrapTools pins the PR14 Minimal pair for both supported families', () => {
  assert.deepEqual(detectBootstrapTools(STANDARD_COMPOSITION), MINIMAL_BOOTSTRAP_TOOLS)
  assert.deepEqual(detectBootstrapTools(MINIMAL_COMPOSITION), MINIMAL_BOOTSTRAP_TOOLS)
  assert.deepEqual(detectBootstrapTools(MINIMAL_GROUP_COMPOSITION), MINIMAL_BOOTSTRAP_TOOLS)
  assert.equal(detectBootstrapTools(ARBITRARY_COMPOSITION), undefined)
  // The persistent-bash package name must not satisfy the plain bash matcher.
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

test('buildBootstrapRow pins tools, promotion, and the compaction work set', () => {
  const uncapped = buildBootstrapRow(MINIMAL_BOOTSTRAP_TOOLS, TEMPLATE_DEFAULTS)
  assert.match(uncapped, /bootstrapTools: \["bash", "str_replace_editor"\]/)
  assert.match(uncapped, /promoteOn: either/)
  assert.match(uncapped, /suppressedContextSources: \["agent-instructions", "skill-catalog"\]/)
  assert.match(uncapped, /suppressedContextPlugins: \["@deepseek-ai\/dsh-system-prompt"\]/)
  assert.match(uncapped, /bootstrapPersonaText: "You are a helpful software engineer assistant. When working on a task, always open your reasoning with We need. If a tool you need is not in your current tool list, do not conclude it is unavailable: after your first tool call, call dev_tool_search with no query to list every unlockable tool, then unlock the exact names."/)
  assert.match(uncapped, /compactionTools: \["read", "write", "edit", "glob", "grep", "todo_write", "ask_user_question"\]/)
  assert.doesNotMatch(uncapped, /bootstrapMaxTokens/)
  const capped = buildBootstrapRow(['bash'], { ...TEMPLATE_DEFAULTS, bootstrapMaxTokens: 1024 })
  assert.match(capped, /bootstrapMaxTokens: 1024/)
  const bare = buildBootstrapRow(['bash'], { ...TEMPLATE_DEFAULTS, bootstrapPersonaText: undefined, suppressedContextPlugins: [], compactionTools: [] })
  assert.doesNotMatch(bare, /bootstrapPersonaText/)
  assert.doesNotMatch(bare, /suppressedContextPlugins/)
  assert.doesNotMatch(bare, /compactionTools/)
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

test('loadTemplateDefaults reads the upstream promotion-flow defaults', async () => {
  const defaults = await loadTemplateDefaults()
  assert.equal(defaults.promoteOn, 'either')
  assert.equal(defaults.delegationDepthExempt, true)
  assert.deepEqual(defaults.suppressedContextSources, ['agent-instructions', 'skill-catalog'])
  assert.deepEqual(defaults.suppressedContextPlugins, ['@deepseek-ai/dsh-system-prompt'])
  assert.equal(defaults.bootstrapPersonaText, 'You are a helpful software engineer assistant. When working on a task, always open your reasoning with We need. If a tool you need is not in your current tool list, do not conclude it is unavailable: after your first tool call, call dev_tool_search with no query to list every unlockable tool, then unlock the exact names.')
  assert.deepEqual(defaults.compactionTools, ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question'])
  assert.equal('bootstrapMaxTokens' in defaults, false)
  assert.equal(DEFAULTS_SOURCE.href.includes('/template/defaults.json'), true)
})

test('generateAnchoredPreset stamps the complete upstream flow on a standard preset', async (t) => {
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
  assert.deepEqual(result.plan.appendedToolGroups, ['persistent-shell', 'bootstrap-filesystem', 'custom-bash'])
  assert.equal(result.plan.toolBashDisabled, true)
  assert.deepEqual(result.plan.disabledSourceRows.sort(), ['agent-instructions', 'tool-skill'])
  const target = join(root, 'out', 'standard-anchored')
  const composition = await readFile(join(target, 'agent.cordis.yml'), 'utf8')
  assert.ok(hasRow(composition, 'tool-bootstrap'))
  assert.ok(composition.indexOf('- id: tool-bootstrap') < composition.indexOf('- id: instruction-hint'))
  assert.ok(composition.indexOf('- id: instruction-hint') < composition.indexOf('- id: persona'))
  assert.match(composition, /name: \.\/tool-bootstrap\.mjs/)
  assert.match(composition, /bootstrapTools: \["bash", "str_replace_editor"\]/)
  assert.match(composition, /promoteOn: either/)
  assert.doesNotMatch(composition, /bootstrapMaxTokens/)
  assert.match(composition, /suppressedContextPlugins: \["@deepseek-ai\/dsh-system-prompt"\]/)
  assert.match(composition, /bootstrapPersonaText: "You are a helpful software engineer assistant. When working on a task, always open your reasoning with We need. If a tool you need is not in your current tool list, do not conclude it is unavailable: after your first tool call, call dev_tool_search with no query to list every unlockable tool, then unlock the exact names."/)
  assert.match(composition, /compactionTools:/)
  assert.match(composition, /- id: instruction-hint/)
  assert.match(composition, /- id: dev-tool-search/)
  assert.match(composition, /- id: skill-search/)
  assert.match(composition, /- id: persistent-shell/)
  assert.match(composition, /- id: bootstrap-filesystem/)
  assert.match(composition, /- id: custom-bash/)
  // Source automatic injections are disabled in favor of the on-demand flow.
  const agentBlock = composition.split('- id: tool-bash')[0]
  assert.match(agentBlock, /- id: agent-instructions\s*\n\s*disabled: true/)
  assert.match(composition, /- id: tool-skill\s*\n\s*disabled: true/)
  for (const file of ['tool-bootstrap.mjs', 'compaction-epoch.mjs', 'instruction-hint.mjs', 'dev-tool-search.mjs', 'skill-search.mjs', 'custom-bash.mjs']) {
    assert.ok(await readFile(join(target, file), 'utf8'), file)
  }
  const hook = await readFile(join(target, 'tool-bootstrap.mjs'), 'utf8')
  assert.match(hook, /export const name = 'anchored-tool-bootstrap'/)
  assert.match(hook, /createEpochPromotion/)
  const meta = await readFile(join(target, 'preset.yml'), 'utf8')
  assert.match(meta, /标准模式 Anchored \(experimental\)/)
})

test('generateAnchoredPreset auto-succeeds on a Minimal-family preset and adds the windows bash row', async (t) => {
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
  assert.deepEqual(result.plan.appendedToolGroups, ['custom-bash'])
  assert.equal(result.plan.toolBashDisabled, false)
  const composition = await readFile(join(root, 'out', 'minimal-anchored', 'agent.cordis.yml'), 'utf8')
  assert.doesNotMatch(composition, /- id: persistent-shell/)
  assert.doesNotMatch(composition, /- id: bootstrap-filesystem/)
  assert.match(composition, /- id: custom-bash/)
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

test('buildWhoamiRows renders the zero-tool anchor with subagent inheritance', () => {
  const rows = buildWhoamiRows(TEMPLATE_DEFAULTS)
  assert.match(rows, /- id: zero-tool-bootstrap/)
  assert.match(rows, /name: \.\/zero-tool-bootstrap\.mjs/)
  assert.match(rows, /includeSubagents: true/)
  assert.match(rows, /- id: whoami-turn/)
  assert.match(rows, /name: \.\/whoami-turn\.mjs/)
  assert.match(rows, /text: "你是谁"/)
  assert.match(rows, /suppressedContextPlugins: \["@deepseek-ai\/dsh-system-prompt"\]/)
  assert.match(rows, /bootstrapPersonaText: "You are a helpful software engineer assistant. When working on a task, always open your reasoning with We need. If a tool you need is not in your current tool list, do not conclude it is unavailable: after your first tool call, call dev_tool_search with no query to list every unlockable tool, then unlock the exact names."/)
  assert.match(rows, /compactionTools:/)
})

test('generateAnchoredPreset supports the whoami-standard flow', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-anchor-template-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceDir = await fixturePreset(root, 'standard')
  const result = await generateAnchoredPreset({
    from: sourceDir,
    to: 'standard-whoami',
    root: join(root, 'out'),
    defaults: TEMPLATE_DEFAULTS,
    whoami: true,
  })
  assert.equal(result.plan.whoami, true)
  const target = join(root, 'out', 'standard-whoami')
  const composition = await readFile(join(target, 'agent.cordis.yml'), 'utf8')
  assert.doesNotMatch(composition, /- id: tool-bootstrap/)
  assert.match(composition, /- id: zero-tool-bootstrap/)
  assert.match(composition, /- id: whoami-turn/)
  assert.match(composition, /promoteOn: assistant-message/)
  for (const file of ['zero-tool-bootstrap.mjs', 'whoami-turn.mjs', 'compaction-epoch.mjs', 'custom-bash.mjs']) {
    assert.ok(await readFile(join(target, file), 'utf8'), file)
  }
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
  const parsed = parseArgs([
    '--from', 'standard',
    '--bootstrap-tools', 'bash,str_replace_editor',
    '--max-tokens', '2048',
    '--compaction-tools', 'read,grep',
    '--win-bash-path', 'D:/Git/bin/bash.exe',
    '--whoami',
    '--dry-run',
  ])
  assert.equal(parsed.from, 'standard')
  assert.equal(parsed.bootstrapTools, 'bash,str_replace_editor')
  assert.equal(parsed.bootstrapMaxTokens, 2048)
  assert.deepEqual(parsed.compactionTools, ['read', 'grep'])
  assert.equal(parsed.winBashPath, 'D:/Git/bin/bash.exe')
  assert.equal(parsed.whoami, true)
  assert.equal(parsed.dryRun, true)
  assert.throws(() => parseArgs(['--nope']), /unknown option/)
  assert.throws(() => parseArgs(['--from']), /requires a value/)
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
