/**
 * Stamp the reusable anchored bootstrap hook onto an existing preset.
 *
 * Copies a source preset directory into the DSH user preset root under a new
 * id, drops the template hook beside it, inserts the hook as the FIRST row of
 * its agent.cordis.yml, and rewrites preset.yml metadata. The result is a
 * normal, per-preset deployment of the anchored pattern — no host edits, no
 * global rows.
 *
 * Anchor parameters come from `template/defaults.json` (downstream-owned) and
 * can be overridden per generation from the CLI. After merging upstream
 * changes into this fork, sync that one file with any parameter changes made
 * upstream in `preset/tool-bootstrap.mjs` / `preset/agent.cordis.yml`; no
 * upstream-owned file is edited by this tool.
 *
 * Usage:
 *   node tools/make-anchored-preset.mjs \
 *     --from <preset-id-or-directory> \
 *     [--to <new-id>] [--root <preset-root>] [--bootstrap-tools a,b,c]
 *
 * Auto-detection covers presets with bash/pwsh + read (Standard, Code, Cordis).
 * Presets with other tool names (e.g. Minimal) fail loud and require an
 * explicit --bootstrap-tools list, so a generated preset can never silently
 * ship without an anchor.
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

/** Same id grammar the harness roster enforces. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

const PROMOTE_ON_VALUES = new Set(['either', 'tool-call', 'assistant-message'])

/** Known tool-registration rows the auto-detect understands. */
const KNOWN_TOOL_ROWS = [
  ['bash', '@deepseek-ai/dsh-tool-bash'],
  ['pwsh', '@deepseek-ai/dsh-tool-pwsh'],
  ['read', '@deepseek-ai/dsh-tool-fs'],
  ['persistent-bash', '@deepseek-ai/dsh-tool-bash-persistent'],
  ['str_replace_editor', '@deepseek-ai/dsh-tool-str-replace-editor'],
]

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
function hasToolRow(composition, pkg) {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`name\\s*:\\s*['"]?${escaped}['"]?\\s*(?:#.*)?$`, 'm').test(composition)
}

/**
 * Pin a bootstrap filter for a composition.
 *
 * Returns the legacy `shellTools` + `commonTools` form when the composition
 * registers the standard shell-plus-read surface, and undefined when no safe
 * small surface can be derived — the caller must then ask for an explicit
 * `bootstrapTools` list rather than generate a preset that silently fail-opens.
 * @returns a filter row fragment, or undefined when nothing was detected.
 */
export function detectBootstrapFilter(composition) {
  const found = KNOWN_TOOL_ROWS
    .filter(([, pkg]) => hasToolRow(composition, pkg))
    .map(([tool]) => tool)
  if (found.includes('read') && (found.includes('bash') || found.includes('pwsh'))) {
    return { kind: 'legacy', shellTools: ['bash', 'pwsh'], commonTools: ['read'] }
  }
  return undefined
}

/** Whether the composition already mounts a row with this id. */
export function hasRow(composition, id) {
  return new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`, 'm').test(composition)
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
 * @param filter - `{ kind: 'exact', tools }` or `{ kind: 'legacy', shellTools, commonTools }`.
 */
export function buildBootstrapRow(
  filter,
  {
    promoteOn = 'either',
    bootstrapMaxTokens = 1024,
    delegationDepthExempt = true,
    suppressedContextSources = ['skill-catalog', 'agent-instructions'],
  } = {},
) {
  const config = []
  if (filter.kind === 'exact') {
    config.push(`    bootstrapTools: ${yamlList(filter.tools)}`)
  } else {
    config.push(`    shellTools: ${yamlList(filter.shellTools)}`)
    config.push(`    commonTools: ${yamlList(filter.commonTools)}`)
  }
  config.push(`    promoteOn: ${promoteOn}`)
  config.push(`    bootstrapMaxTokens: ${bootstrapMaxTokens}`)
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

/** Describe a bootstrap filter for generated metadata and messages. */
export function describeFilter(filter) {
  return filter.kind === 'exact'
    ? filter.tools.join(' + ')
    : `one platform shell (${filter.shellTools.join('/')}) + ${filter.commonTools.join(' + ')}`
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
  if (!Number.isSafeInteger(defaults.bootstrapMaxTokens) || defaults.bootstrapMaxTokens <= 0) {
    throw new TypeError('defaults.bootstrapMaxTokens must be a positive safe integer')
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
  const bootstrapMaxTokens = options.bootstrapMaxTokens ?? template.bootstrapMaxTokens
  if (!Number.isSafeInteger(bootstrapMaxTokens) || bootstrapMaxTokens <= 0) {
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

  const bootstrapTools = options.bootstrapTools === undefined
    ? undefined
    : options.bootstrapTools.split(',').map(item => item.trim()).filter(item => item.length > 0)
  if (options.bootstrapTools !== undefined && bootstrapTools.length === 0) {
    throw new Error('--bootstrap-tools must be a non-empty comma-separated tool list')
  }
  const filter = bootstrapTools === undefined
    ? detectBootstrapFilter(composition)
    : { kind: 'exact', tools: [...new Set(bootstrapTools)] }
  if (filter === undefined) {
    throw new Error(
      `cannot auto-pin a bootstrap surface for preset "${source.id}": its composition registers none of `
      + `${KNOWN_TOOL_ROWS.map(([tool]) => tool).join('/')} in the standard shell+read arrangement. `
      + 'Pass --bootstrap-tools with an explicit small first-request list, e.g. '
      + '--bootstrap-tools persistent-bash,str_replace_editor.',
    )
  }
  const template = options.defaults ?? await loadTemplateDefaults()
  const resolved = resolveOptions(options, template)
  const row = buildBootstrapRow(filter, {
    promoteOn: resolved.promoteOn,
    bootstrapMaxTokens: resolved.bootstrapMaxTokens,
    delegationDepthExempt: resolved.delegationDepthExempt,
    suppressedContextSources: resolved.suppressedContextSources,
  })
  const name = options.name ?? `${sourceName} Anchored (experimental)`
  const description = options.description
    ?? `Anchored copy of ${source.id}: request #1 on ${describeFilter(filter)}, then the full ${source.id} catalog.`
  const plan = {
    sourceId: source.id,
    sourceDir: source.dir,
    id,
    targetDir,
    presetRoot,
    filter,
    row,
    meta: { name, description, order: resolved.order },
  }
  if (options.dryRun === true) return { plan, written: false }

  await mkdir(presetRoot, { recursive: true })
  await cp(source.dir, targetDir, { recursive: true, filter: skipNodeArtefacts })
  await writeFile(join(targetDir, HOOK_FILE_NAME), await readFile(HOOK_SOURCE, 'utf8'))
  await writeFile(join(targetDir, COMPOSITION_FILE), insertBootstrapRow(composition, row))
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
  --bootstrap-tools <a,b>   Exact first-request tool list. Required when the
                            source has no shell+read arrangement (e.g. Minimal).
  --promote-on <mode>       either | tool-call | assistant-message.
  --max-tokens <n>          First-request maxTokens cap.
  --order <n>               Preset order. Default: 5.
  --suppress-sources <a,b>  First-step context kinds to strip; empty list disables.
  --bootstrap-subagents     Also bootstrap subagent sessions. Default: exempt.
  --dry-run                 Print the plan without writing anything.
  --help                    Show this help.

Promotion, token cap, and suppression defaults come from template/defaults.json.
Examples:
  node tools/make-anchored-preset.mjs --from "$DSH_HOME/.agent-presets/standard" --to standard-anchored
  node tools/make-anchored-preset.mjs --from standard --to standard-anchored
  node tools/make-anchored-preset.mjs --from minimal --to minimal-anchored --bootstrap-tools persistent-bash
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
      process.stdout.write(`bootstrap: ${describeFilter(plan.filter)} | promoteOn: ${options.promoteOn ?? '(template default)'}\n`)
      if (result.written) {
        process.stdout.write('Next: fully restart DeepSeek Harness, create a BLANK session, select the new preset, then verify the first request/header contains only the bootstrap tools.\n')
      }
    }
  } catch (error) {
    process.stderr.write(`error: ${String((error && error.message) || error)}\n`)
    process.exitCode = 1
  }
}
