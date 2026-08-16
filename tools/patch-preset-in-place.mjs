/**
 * Patch an EXISTING preset directory in place with the unified
 * `anchor-bootstrap` hook. Unlike `make-anchored-preset.mjs` (copy to a new
 * id), this tool edits the target directory itself and writes a
 * `HOOK-INSTALL.md` record next to its agent.cordis.yml.
 *
 * Intended for presets the user owns and wants to keep under their current id
 * (e.g. `matlab-agentic-preset`). It refuses to double-stamp a preset that
 * already mounts `anchor-bootstrap`.
 *
 * Usage:
 *   node tools/patch-preset-in-place.mjs --target <dir> [options]
 *
 * Options:
 *   --target <dir>         Preset directory to patch in place. Required.
 *   --mode <mode>          anchored | zero | whoami. Default: zero.
 *   --name <text>          Display name for preset.yml. Default: keep the
 *                          existing name with " (zero)" appended.
 *   --description <text>   Display description. Default: generated summary.
 *   --order <n>            Preset order. Default: 5.
 *   --win-bash-path <path> Windows custom-bash path.
 *   --dry-run              Print the plan without writing anything.
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  COMPANION_HOOK_FILES,
  COMPANION_HOOK_SOURCES,
  COMPOSITION_FILE,
  HOOK_FILE_NAME,
  HOOK_SOURCE,
  MINIMAL_BOOTSTRAP_TOOLS,
  PRESET_META_FILE,
  buildAnchorBootstrapRow,
  buildCompanionRows,
  detectBootstrapTools,
  disableRow,
  hasRow,
  insertBootstrapRow,
  loadTemplateDefaults,
  patchPresetMeta,
  readMetaField,
  resolveOptions,
  stampMinimalToolRows,
} from './make-anchored-preset.mjs'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}; expected --key value`)
    }
    const key = arg.slice(2)
    const field = {
      target: 'target',
      mode: 'mode',
      name: 'name',
      description: 'description',
      order: 'order',
      'win-bash-path': 'winBashPath',
    }[key]
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
  if (options.order !== undefined) options.order = Number(options.order)
  return options
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function patchPresetInPlace(options) {
  const target = resolve(options.target)
  if (!(await isDirectory(target))) {
    throw new Error(`target preset directory not found: ${target}`)
  }
  const compositionPath = join(target, COMPOSITION_FILE)
  const metaPath = join(target, PRESET_META_FILE)
  const composition = await readFile(compositionPath, 'utf8')
  if (hasRow(composition, 'anchor-bootstrap') || hasRow(composition, 'tool-bootstrap') || hasRow(composition, 'zero-tool-bootstrap')) {
    throw new Error(`target already mounts a bootstrap row: ${compositionPath}`)
  }
  const meta = await readFile(metaPath, 'utf8').catch(() => '')
  const sourceName = readMetaField(meta, 'name') ?? target.split(/[\\/]/).pop()

  const template = options.defaults ?? await loadTemplateDefaults()
  const resolved = resolveOptions({ ...options, mode: options.mode ?? 'zero' }, template)

  const bootstrapTools = detectBootstrapTools(composition) ?? MINIMAL_BOOTSTRAP_TOOLS
  const stamped = stampMinimalToolRows(composition, bootstrapTools, { winBashPath: resolved.winBashPath })
  let finalComposition = stamped.composition
  const disabledSourceRows = []
  for (const sourceRow of ['agent-instructions', 'tool-skill']) {
    const disabled = disableRow(finalComposition, sourceRow)
    if (disabled.disabled) {
      finalComposition = disabled.composition
      disabledSourceRows.push(sourceRow)
    }
  }

  const row = buildAnchorBootstrapRow({
    mode: resolved.mode,
    bootstrapTools,
    promoteOn: resolved.promoteOn,
    bootstrapMaxTokens: resolved.bootstrapMaxTokens,
    suppressedContextSources: resolved.suppressedContextSources,
    suppressedContextPlugins: resolved.suppressedContextPlugins,
    personaText: resolved.personaText,
    controlledPersonaText: resolved.controlledPersonaText,
    compactionTools: resolved.compactionTools,
  })
  const companionRows = buildCompanionRows({ promoteOn: resolved.promoteOn })
  finalComposition = insertBootstrapRow(finalComposition, `${row}\n\n${companionRows}`)

  const displayName = options.name ?? `${sourceName} (zero)`
  const description = options.description ?? `Zero-anchored in-place patch of ${sourceName}.`
  const patchedMeta = patchPresetMeta(meta, {
    name: displayName,
    description,
    order: resolved.order,
  })

  const plan = {
    target,
    mode: resolved.mode,
    bootstrapTools,
    appendedToolGroups: stamped.appended,
    toolBashDisabled: stamped.toolBashDisabled,
    disabledSourceRows,
    filesToCopy: [HOOK_FILE_NAME, ...COMPANION_HOOK_FILES],
    meta: { name: displayName, description, order: resolved.order },
  }
  if (options.dryRun === true) return { plan, written: false }

  await writeFile(compositionPath, finalComposition)
  await writeFile(metaPath, patchedMeta)
  const copied = []
  await writeFile(join(target, HOOK_FILE_NAME), await readFile(HOOK_SOURCE, 'utf8'))
  copied.push(HOOK_FILE_NAME)
  for (const file of COMPANION_HOOK_FILES) {
    await writeFile(join(target, file), await readFile(COMPANION_HOOK_SOURCES[file], 'utf8'))
    copied.push(file)
  }
  const record = [
    '# Hook in-place install record',
    '',
    `- target: ${target}`,
    `- mode: ${resolved.mode}`,
    `- hook: ${HOOK_FILE_NAME}`,
    `- files copied: ${copied.join(', ')}`,
    `- disabled source rows: ${disabledSourceRows.length > 0 ? disabledSourceRows.join(', ') : 'none'}`,
    `- appended tool groups: ${stamped.appended.length > 0 ? stamped.appended.join(', ') : 'none'}`,
    `- tool-bash disabled: ${stamped.toolBashDisabled}`,
    '',
    'This preset was patched in place by tools/patch-preset-in-place.mjs. To',
    'remove the hook, reverse the insertion and delete the copied hook files;',
    'then fully restart DeepSeek Harness.',
    '',
  ].join('\n')
  await writeFile(join(target, 'HOOK-INSTALL.md'), record)
  return { plan, written: true, recordPath: join(target, 'HOOK-INSTALL.md') }
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help === true) {
      process.stdout.write('Usage:\n  node tools/patch-preset-in-place.mjs --target <dir> [--mode zero|anchored|whoami] [--name <text>] [--description <text>] [--order n] [--win-bash-path <path>] [--dry-run]\n')
    } else {
      const result = await patchPresetInPlace(options)
      const { plan } = result
      process.stdout.write(`${result.written ? 'patched' : 'would patch'} preset in ${plan.target}\n`)
      process.stdout.write(`mode: ${plan.mode}\n`)
      process.stdout.write(`bootstrap tools: ${plan.bootstrapTools.join(', ')}\n`)
      if (plan.appendedToolGroups.length > 0) process.stdout.write(`appended groups: ${plan.appendedToolGroups.join(', ')}\n`)
      if (plan.toolBashDisabled) process.stdout.write('disabled standard tool-bash (persistent bash owns the bash name)\n')
      if (plan.disabledSourceRows.length > 0) process.stdout.write(`disabled source rows: ${plan.disabledSourceRows.join(', ')}\n`)
      if (result.written) process.stdout.write(`record: ${result.recordPath}\n`)
    }
  } catch (error) {
    process.stderr.write(`error: ${String((error && error.message) || error)}\n`)
    process.exitCode = 1
  }
}
