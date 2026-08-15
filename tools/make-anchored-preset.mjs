/**
 * Stamp the reusable anchored bootstrap hook onto an existing preset.
 *
 * Copies a source preset directory into the DSH user preset root under a new
 * id, drops the template hook beside it, inserts the hook as the FIRST row of
 * its agent.cordis.yml, and rewrites preset.yml metadata. The result is a
 * normal, per-preset deployment of the anchored pattern — no host edits, no
 * global rows.
 *
 * Upstream PR #14 (issue #11): the anchor is the OFFICIAL Minimal preset's
 * real tool pair — persistent `bash` + `str_replace_editor` — at the
 * adapter-default maxTokens. For presets that do not already mount that pair
 * (Standard/Code/Cordis), the generator stamps the same Minimal groups the
 * upstream anchored preset uses, disabling the standard `tool-bash` row so the
 * `bash` tool name is not registered twice. `bootstrapMaxTokens` is opt-in:
 * omit it (default) and the adapter default flows.
 *
 * Anchor parameters come from `template/defaults.json` (downstream-owned) and
 * can be overridden per generation from the CLI. After merging upstream
 * changes into this fork, sync that one file (and, only when the hook
 * algorithm changed, `template/hook/tool-bootstrap.mjs`); no upstream-owned
 * file is edited by this tool.
 *
 * Usage:
 *   node tools/make-anchored-preset.mjs \
 *     --from <preset-id-or-directory> \
 *     [--to <new-id>] [--root <preset-root>] [--bootstrap-tools a,b,c]
 *
 * Auto-detection covers the standard family (bash/pwsh/read rows) and the
 * Minimal family (persistent bash + str_replace_editor). Presets matching
 * neither fail loud and require an explicit --bootstrap-tools list, so a
 * generated preset can never silently ship without an anchor.
 *
 * @module tools/make-anchored-preset
 */

import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const COMPOSITION_FILE = 'agent.cordis.yml'
export const PRESET_META_FILE = 'preset.yml'
export const HOOK_FILE_NAME = 'tool-bootstrap.mjs'

/** The template hook this generator stamps into every target preset. */
export const HOOK_SOURCE = new URL('../template/hook/tool-bootstrap.mjs', import.meta.url)

/** Downstream-owned anchor parameters, separate from upstream files. */
export const DEFAULTS_SOURCE = new URL('../template/defaults.json', import.meta.url)

/** Upstream PR #14 anchor pair (official Minimal preset's real tools). */
export const MINIMAL_BOOTSTRAP_TOOLS = ['bash', 'str_replace_editor']

/** Same id grammar the harness roster enforces. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

const PROMOTE_ON_VALUES = new Set(['either', 'tool-call', 'assistant-message'])

const PKG_TOOL_BASH = '@deepseek-ai/dsh-tool-bash'
const PKG_TOOL_PWSH = '@deepseek-ai/dsh-tool-pwsh'
const PKG_TOOL_FS = '@deepseek-ai/dsh-tool-fs'
const PKG_PERSISTENT_BASH = '@deepseek-ai/dsh-tool-bash-persistent'
const PKG_STR_REPLACE_EDITOR = '@deepseek-ai/dsh-tool-str-replace-editor'

/** Resolve the harness home: `$DSH_HOME`, else `~/.dsh`. */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** The user preset root the harness roster appends by default. */
export function defaultPresetRoot() {
  return join(dshHome(), '.agent-presets')
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve `from` to an existing preset directory.
 * @param from - a directory path, or a preset id searched in `presetRoot`
 *   first and then `sourceRoot`.
 * @returns the preset's id and directory.
 */
export async function resolveSourceDir(from, { presetRoot, sourceRoot } = {}) {
  if (typeof from !== 'string' || from.length === 0) {
    throw new Error('--from is required (preset id or directory path)')
  }
  const direct = resolve(from)
  if (await isDirectory(direct)) return { id: basename(direct), dir: direct }
  if (from.includes('/') || from.includes('\\')) {
    throw new Error(`source preset directory not found: ${direct}`)
  }
  const searched = []
  for (const root of [presetRoot, sourceRoot]) {
    if (root === undefined) continue
    const dir = join(root, from)
    searched.push(dir)
    if (await isDirectory(dir)) return { id: from, dir }
  }
  throw new Error(
    `preset ${JSON.stringify(from)} not found; searched: ${searched.map(path => JSON.stringify(path)).join(', ') || 'nothing'}`
    + ' — pass the preset directory as --from, or --root/--source-root to extend the search',
  )
}

/** Whether one composition mounts a row whose `name` is exactly `pkg`. */
export function hasToolRow(composition, pkg) {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`name\\s*:\\s*['"]?${escaped}['"]?\\s*(?:#.*)?$`, 'm').test(composition)
}

/** Whether the composition already mounts a row with this id. */
export function hasRow(composition, id) {
  return new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`, 'm').test(composition)
}

/**
 * Pin a bootstrap tool list for a composition.
 *
 * Returns the PR #14 Minimal pair when the composition belongs to the standard
 * family (bash/pwsh/read rows) or already mounts the Minimal family
 * (persistent bash / str_replace_editor), and undefined when neither is found —
 * the caller must then ask for an explicit `bootstrapTools` list.
 * @returns the exact bootstrap tool list, or undefined when nothing was detected.
 */
export function detectBootstrapTools(composition) {
  const standardFamily = [PKG_TOOL_BASH, PKG_TOOL_PWSH, PKG_TOOL_FS].some(pkg => hasToolRow(composition, pkg))
  const minimalFamily = [PKG_PERSISTENT_BASH, PKG_STR_REPLACE_EDITOR].some(pkg => hasToolRow(composition, pkg))
  return standardFamily || minimalFamily ? [...MINIMAL_BOOTSTRAP_TOOLS] : undefined
}

/**
 * What the Minimal tool pair needs from a target composition.
 * @param composition - the source agent.cordis.yml text.
 * @param bootstrapTools - the exact bootstrap tool list.
 */
export function minimalToolNeeds(composition, bootstrapTools) {
  const needBash = bootstrapTools.includes('bash')
    && !hasToolRow(composition, PKG_PERSISTENT_BASH)
    && !hasRow(composition, 'persistent-shell')
  const needEditor = bootstrapTools.includes('str_replace_editor')
    && !hasToolRow(composition, PKG_STR_REPLACE_EDITOR)
    && !hasRow(composition, 'bootstrap-filesystem')
  return {
    needBash,
    needEditor,
    hasStandardBash: hasToolRow(composition, PKG_TOOL_BASH),
  }
}

/** Render one string as a double-quoted YAML scalar (JSON string syntax). */
function yamlDouble(value) {
  return JSON.stringify(value)
}

/** Render a YAML flow list of strings. */
function yamlList(items) {
  return `[${items.map(yamlDouble).join(', ')}]`
}

/**
 * Render the agent.cordis.yml row for the reusable hook.
 * @param bootstrapTools - the exact first-request tool list.
 */
export function buildBootstrapRow(
  bootstrapTools,
  {
    promoteOn = 'either',
    bootstrapMaxTokens = undefined,
    delegationDepthExempt = true,
    suppressedContextSources = ['agent-instructions', 'skill-catalog'],
  } = {},
) {
  const config = [`    bootstrapTools: ${yamlList(bootstrapTools)}`]
  config.push(`    promoteOn: ${promoteOn}`)
  if (bootstrapMaxTokens !== undefined) config.push(`    bootstrapMaxTokens: ${bootstrapMaxTokens}`)
  config.push(`    delegationDepthExempt: ${delegationDepthExempt}`)
  config.push(`    suppressedContextSources: ${yamlList(suppressedContextSources)}`)
  return [
    '# ── anchored bootstrap (generated by dsh-anchored-standard; keep this row FIRST) ──',
    '# Registered before every other row, this plugin\'s pre-step strip is the final',
    '# waterfall transform. Do not add an inject list, and do not move this row.',
    '- id: tool-bootstrap',
    `  name: ./${HOOK_FILE_NAME}`,
    '  config:',
    ...config,
  ].join('\n')
}

/**
 * Insert a row block as the FIRST list entry of a composition, preserving the
 * file's leading comment block above it.
 */
export function insertBootstrapRow(composition, row) {
  const lines = composition.replace(/\r\n/g, '\n').split('\n')
  const firstEntry = lines.findIndex(line => /^\s*-\s/.test(line))
  const block = row.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  if (firstEntry === -1) {
    lines.push(...block)
  } else {
    lines.splice(firstEntry, 0, ...block, '')
  }
  const joined = lines.join('\n')
  return joined.endsWith('\n') ? joined : `${joined}\n`
}

/**
 * Disable one top-level composition row by id: remove any existing `disabled`
 * lines inside the row, then insert `disabled: true` right after its id line.
 */
export function disableRow(composition, id) {
  const lines = composition.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(line => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`).test(line))
  if (start === -1) return { composition, disabled: false }
  const indent = '  '
  let end = start + 1
  while (end < lines.length && !/^\s*-\s*id:/.test(lines[end])) {
    if (/^\s*disabled\s*:/.test(lines[end])) lines.splice(end, 1)
    else end++
  }
  lines.splice(start + 1, 0, `${indent}disabled: true`)
  return { composition: lines.join('\n'), disabled: true }
}

/** The Minimal preset's persistent bash group, byte-identical configuration. */
export const MINIMAL_PERSISTENT_SHELL_GROUP = [
  '# The Minimal preset\'s shell: a PTY-backed persistent bash so the first',
  '# request exposes exactly Minimal\'s real `bash` schema. Mounted by the',
  '# generator for presets that do not already register it.',
  '- id: persistent-shell',
  '  name: cordis:group',
  '  group: true',
  '  isolate:',
  '    terminals: true',
  '  config:',
  '    - id: pty',
  '      name: \'@deepseek-ai/dsh-terminal\'',
  '',
  '    - id: terminal-bash',
  '      name: \'@deepseek-ai/dsh-terminal-bash\'',
  '      config:',
  '        timeoutMs: 300000',
  '',
  '    - id: persistent-bash',
  '      name: \'@deepseek-ai/dsh-tool-bash-persistent\'',
  '      config:',
  '        timeoutMs: 300000',
  '        description: |-',
  '          Run commands in a bash shell',
  '          * When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
  '          * You don\'t have access to the internet via this tool.',
  '          * You do have access to a mirror of common linux and python packages via apt and pip.',
  '          * State is persistent across command calls and discussions with the user.',
  '          * To inspect a particular line range of a file, e.g. lines 10-25, try \'sed -n 10,25p /path/to/the/file\'.',
  '          * Please avoid commands that may produce a very large amount of output.',
  '          * Please run long lived commands in the background, e.g. \'sleep 10 &\' or start a server in the background.',
].join('\n')

/** The Minimal preset's str_replace_editor group over a bare local filesystem. */
export const MINIMAL_BOOTSTRAP_FILESYSTEM_GROUP = [
  '# The Minimal preset\'s second tool: `str_replace_editor` over a bare local',
  '# filesystem, byte-identical configuration. Mounted by the generator for',
  '# presets that do not already register it.',
  '- id: bootstrap-filesystem',
  '  name: cordis:group',
  '  group: true',
  '  isolate:',
  '    fs: true',
  '  config:',
  '    - id: fs-local',
  '      name: \'@deepseek-ai/dsh-fs-local\'',
  '      config:',
  '        cwd: !!js process.env.DSH_CWD ?? process.cwd()',
  '',
  '    - id: str-replace-editor',
  '      name: \'@deepseek-ai/dsh-tool-str-replace-editor\'',
  '      config:',
  '        maxOutputChars: 16000',
].join('\n')

/**
 * Ensure a composition registers the tools in `bootstrapTools`' Minimal pair.
 *
 * Appends the persistent-shell and/or bootstrap-filesystem groups when the
 * composition lacks them, and disables a standard `tool-bash` row so its
 * `bash` tool name does not collide with the persistent bash (same fix the
 * upstream anchored preset applies).
 * @returns the stamped composition and a report of what changed.
 */
export function stampMinimalToolRows(composition, bootstrapTools) {
  const needs = minimalToolNeeds(composition, bootstrapTools)
  let result = composition
  let toolBashDisabled = false
  if (needs.needBash && needs.hasStandardBash) {
    const disabled = disableRow(result, 'tool-bash')
    result = disabled.composition
    toolBashDisabled = disabled.disabled
  }
  const appended = []
  if (needs.needBash) {
    result = `${result.trimEnd()}\n\n${MINIMAL_PERSISTENT_SHELL_GROUP}\n`
    appended.push('persistent-shell')
  }
  if (needs.needEditor) {
    result = `${result.trimEnd()}\n\n${MINIMAL_BOOTSTRAP_FILESYSTEM_GROUP}\n`
    appended.push('bootstrap-filesystem')
  }
  return { composition: result, appended, toolBashDisabled }
}

/** Read one scalar field from a simple `key: value` meta file. */
export function readMetaField(text, key) {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'm').exec(text)
  if (match === null || match[1] === '') return undefined
  const value = match[1].trim()
  if (/^'(.*)'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'")
  if (/^"(.*)"$/.test(value)) return value.slice(1, -1)
  return value
}

/** Render one meta scalar; strings are single-quoted YAML. */
function yamlMetaValue(key, value) {
  if (key === 'order') return String(value)
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Patch a preset.yml, replacing known fields in place and appending any that
 * are absent.
 */
export function patchPresetMeta(text, { name, description, order }) {
  const values = { name, description, order }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const present = new Set()
  const known = new Set(Object.keys(values))
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[index])
    if (match === null || !known.has(match[2])) continue
    const key = match[2]
    lines[index] = `${match[1]}${key}: ${yamlMetaValue(key, values[key])}`
    present.add(key)
  }
  for (const key of Object.keys(values)) {
    if (!present.has(key)) lines.push(`${key}: ${yamlMetaValue(key, values[key])}`)
  }
  const joined = lines.join('\n')
  return joined.endsWith('\n') ? joined : `${joined}\n`
}

async function readUtf8(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${path}: ${String((error && error.message) || error)}`, { cause: error })
  }
}

/** Exclude VCS and dependency directories when copying a preset. */
function skipNodeArtefacts(src) {
  const name = basename(src)
  return name !== '.git' && name !== 'node_modules'
}

/** Describe a bootstrap tool list for generated metadata and messages. */
export function describeFilter(bootstrapTools) {
  return bootstrapTools.join(' + ')
}

function assertStringList(value, field, allowEmpty = false) {
  if (!Array.isArray(value)
    || value.some(item => typeof item !== 'string' || item.length === 0)
    || (!allowEmpty && value.length === 0)) {
    throw new TypeError(
      `${field} must be ${allowEmpty ? 'an array of non-empty strings' : 'a non-empty array of non-empty strings'}`,
    )
  }
  return [...new Set(value)]
}

/** Validate one template defaults object (template/defaults.json shape). */
export function validateTemplateDefaults(defaults) {
  if (defaults === null || typeof defaults !== 'object') {
    throw new TypeError('template defaults must be an object')
  }
  if (!PROMOTE_ON_VALUES.has(defaults.promoteOn)) {
    throw new TypeError(`defaults.promoteOn must be one of ${[...PROMOTE_ON_VALUES].join(', ')}`)
  }
  if (typeof defaults.delegationDepthExempt !== 'boolean') {
    throw new TypeError('defaults.delegationDepthExempt must be a boolean')
  }
  assertStringList(defaults.suppressedContextSources, 'defaults.suppressedContextSources', true)
  return defaults
}

/** Read and validate template/defaults.json. */
export async function loadTemplateDefaults(source = DEFAULTS_SOURCE) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(source, 'utf8'))
  } catch (error) {
    throw new Error(`cannot load template defaults ${source}: ${String((error && error.message) || error)}`, { cause: error })
  }
  return validateTemplateDefaults(parsed)
}

/** Merge CLI options over template defaults and validate the result once. */
export function resolveOptions(options, template) {
  const promoteOn = options.promoteOn ?? template.promoteOn
  if (!PROMOTE_ON_VALUES.has(promoteOn)) {
    throw new Error(`--promote-on must be one of ${[...PROMOTE_ON_VALUES].join(', ')}`)
  }
  const bootstrapMaxTokens = options.bootstrapMaxTokens
  if (bootstrapMaxTokens !== undefined && (!Number.isSafeInteger(bootstrapMaxTokens) || bootstrapMaxTokens <= 0)) {
    throw new Error('--max-tokens must be a positive safe integer')
  }
  const order = options.order ?? 5
  if (!Number.isSafeInteger(order) || order < 0) {
    throw new Error('--order must be a non-negative safe integer')
  }
  const delegationDepthExempt = options.bootstrapSubagents === true
    ? false
    : template.delegationDepthExempt
  const suppressedContextSources = options.suppressedContextSources ?? template.suppressedContextSources
  assertStringList(suppressedContextSources, '--suppress-sources', true)
  return { promoteOn, bootstrapMaxTokens, delegationDepthExempt, suppressedContextSources, order }
}

/**
 * Generate one anchored preset from `options.from`.
 * @param options - CLI options plus optional `defaults` (used by tests).
 * @returns the applied plan and whether files were written.
 */
export async function generateAnchoredPreset(options) {
  const presetRoot = options.root ?? defaultPresetRoot()
  const source = await resolveSourceDir(options.from, {
    presetRoot,
    sourceRoot: options.sourceRoot,
  })
  const id = options.to ?? `${source.id}-anchored`
  if (!PRESET_ID.test(id)) {
    throw new Error(`preset id ${JSON.stringify(id)} must match ${String(PRESET_ID)}`)
  }
  const targetDir = join(presetRoot, id)
  if (await pathExists(targetDir)) {
    throw new Error(`target preset already exists: ${targetDir} — remove it or pass --to`)
  }
  const compositionPath = join(source.dir, COMPOSITION_FILE)
  const composition = await readUtf8(compositionPath)
  if (hasRow(composition, 'tool-bootstrap')) {
    throw new Error(`source already mounts a tool-bootstrap row: ${compositionPath}`)
  }
  const metaPath = join(source.dir, PRESET_META_FILE)
  const meta = await pathExists(metaPath) ? await readUtf8(metaPath) : ''
  const sourceName = readMetaField(meta, 'name') ?? source.id

  const explicitTools = options.bootstrapTools === undefined
    ? undefined
    : options.bootstrapTools.split(',').map(item => item.trim()).filter(item => item.length > 0)
  if (options.bootstrapTools !== undefined && explicitTools.length === 0) {
    throw new Error('--bootstrap-tools must be a non-empty comma-separated tool list')
  }
  const detected = detectBootstrapTools(composition)
  const bootstrapTools = [...new Set(explicitTools ?? detected ?? [])]
  if (bootstrapTools.length === 0) {
    throw new Error(
      `cannot auto-pin a bootstrap surface for preset "${source.id}": its composition registers neither `
      + 'the standard family (bash/pwsh/read) nor the Minimal family (persistent bash, str_replace_editor). '
      + 'Pass --bootstrap-tools with an explicit small first-request list, e.g. '
      + '--bootstrap-tools bash,str_replace_editor.',
    )
  }
  const stamped = stampMinimalToolRows(composition, bootstrapTools)
  const template = options.defaults ?? await loadTemplateDefaults()
  const resolved = resolveOptions(options, template)
  const row = buildBootstrapRow(bootstrapTools, {
    promoteOn: resolved.promoteOn,
    bootstrapMaxTokens: resolved.bootstrapMaxTokens,
    delegationDepthExempt: resolved.delegationDepthExempt,
    suppressedContextSources: resolved.suppressedContextSources,
  })
  const name = options.name ?? `${sourceName} Anchored (experimental)`
  const description = options.description
    ?? `Anchored copy of ${source.id}: request #1 on ${describeFilter(bootstrapTools)}, then the full ${source.id} catalog.`
  const plan = {
    sourceId: source.id,
    sourceDir: source.dir,
    id,
    targetDir,
    presetRoot,
    bootstrapTools,
    appendedToolGroups: stamped.appended,
    toolBashDisabled: stamped.toolBashDisabled,
    row,
    meta: { name, description, order: resolved.order },
  }
  if (options.dryRun === true) return { plan, written: false }

  await mkdir(presetRoot, { recursive: true })
  await cp(source.dir, targetDir, { recursive: true, filter: skipNodeArtefacts })
  await writeFile(join(targetDir, HOOK_FILE_NAME), await readFile(HOOK_SOURCE, 'utf8'))
  await writeFile(join(targetDir, COMPOSITION_FILE), insertBootstrapRow(stamped.composition, row))
  await writeFile(join(targetDir, PRESET_META_FILE), patchPresetMeta(meta, plan.meta))
  return { plan, written: true }
}

/** Split one comma-separated CLI value into a trimmed list. */
export function splitList(value) {
  return value.split(',').map(item => item.trim()).filter(item => item.length > 0)
}

const VALUE_KEYS = new Map([
  ['from', 'from'],
  ['to', 'to'],
  ['name', 'name'],
  ['description', 'description'],
  ['root', 'root'],
  ['source-root', 'sourceRoot'],
  ['bootstrap-tools', 'bootstrapTools'],
  ['promote-on', 'promoteOn'],
  ['max-tokens', 'bootstrapMaxTokens'],
  ['order', 'order'],
  ['suppress-sources', 'suppressedContextSources'],
])

/** Parse the generator CLI. */
export function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--bootstrap-subagents') {
      options.bootstrapSubagents = true
      continue
    }
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}; expected --key value`)
    }
    const key = arg.slice(2)
    const field = VALUE_KEYS.get(key)
    if (field === undefined) {
      throw new Error(`unknown option ${JSON.stringify(arg)}; run with --help for usage`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`)
    }
    index++
    options[field] = value
  }
  if (options.bootstrapMaxTokens !== undefined) options.bootstrapMaxTokens = Number(options.bootstrapMaxTokens)
  if (options.order !== undefined) options.order = Number(options.order)
  if (options.suppressedContextSources !== undefined) {
    options.suppressedContextSources = splitList(options.suppressedContextSources)
  }
  return options
}

export const USAGE = `Usage:
  node tools/make-anchored-preset.mjs --from <preset-id-or-directory> [options]

Options:
  --from <source>           Preset id (searched in --root, then --source-root)
                            or a preset directory path. Required.
  --to <id>                 New preset id/directory name. Default: <source>-anchored.
  --name <text>             Display name. Default: "<source name> Anchored (experimental)".
  --description <text>      Display description. Default: generated summary.
  --root <dir>              Target preset root. Default: $DSH_HOME/.agent-presets
                            (falls back to ~/.dsh/.agent-presets).
  --source-root <dir>       Extra search root for shipped presets, e.g. the
                            harness install's apps/cli/config/agent-presets.
  --bootstrap-tools <a,b>   Exact first-request tool list. Default: the Minimal
                            pair bash,str_replace_editor (upstream PR #14); the
                            generator stamps the Minimal tool groups when the
                            source preset lacks them.
  --promote-on <mode>       either | tool-call | assistant-message.
  --max-tokens <n>          OPT-IN first-request maxTokens cap. Omit to run at
                            the adapter default (upstream issue #11).
  --order <n>               Preset order. Default: 5.
  --suppress-sources <a,b>  First-step context kinds to strip; empty list disables.
  --bootstrap-subagents     Also bootstrap subagent sessions. Default: exempt.
  --dry-run                 Print the plan without writing anything.
  --help                    Show this help.

Promotion and suppression defaults come from template/defaults.json.
Examples:
  node tools/make-anchored-preset.mjs --from "$DSH_HOME/.agent-presets/standard" --to standard-anchored
  node tools/make-anchored-preset.mjs --from standard --to standard-anchored
  node tools/make-anchored-preset.mjs --from minimal --to minimal-anchored
`

const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help === true) {
      process.stdout.write(USAGE)
    } else {
      const result = await generateAnchoredPreset(options)
      const { plan } = result
      process.stdout.write(`${result.written ? 'created' : 'would create'} preset "${plan.id}" in ${plan.targetDir}\n`)
      process.stdout.write(`bootstrap tools: ${plan.bootstrapTools.join(', ')}\n`)
      if (plan.appendedToolGroups.length > 0) process.stdout.write(`appended groups: ${plan.appendedToolGroups.join(', ')}\n`)
      if (plan.toolBashDisabled) process.stdout.write('disabled standard tool-bash (persistent bash owns the bash name)\n')
      if (result.written) {
        process.stdout.write('Next: fully restart DeepSeek Harness, create a BLANK session, select the new preset, then verify the first request/header contains only the bootstrap tools.\n')
      }
    }
  } catch (error) {
    process.stderr.write(`error: ${String((error && error.message) || error)}\n`)
    process.exitCode = 1
  }
}
