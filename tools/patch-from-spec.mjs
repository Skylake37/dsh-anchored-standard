/**
 * Apply a validated patch contract to an existing preset.
 *
 * This is the first patch-oriented CLI. It intentionally supports only the
 * session-phase layers compiled by the current anchor-bootstrap transition;
 * future layers fail loudly instead of being silently ignored.
 */

import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadTemplateDefaults } from './make-anchored-preset.mjs'
import { compileSupportedPatch, normalizePatchProfile } from './patch-contract.mjs'
import { applyLayeredPatch } from './layered-patch.mjs'
import { patchPresetInPlace } from './patch-preset-in-place.mjs'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(arg)}`)
    const key = arg.slice(2)
    if (!new Set(['target', 'patch', 'name', 'description']).has(key)) throw new Error(`unknown option ${arg}`)
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    options[key] = value
  }
  if (options.target === undefined) throw new Error('--target is required')
  if (options.patch === undefined) throw new Error('--patch is required')
  return options
}

export async function applyPatchSpec(options) {
  const raw = JSON.parse(await readFile(resolve(options.patch), 'utf8'))
  const profile = normalizePatchProfile(raw)
  const compiled = compileSupportedPatch(profile)
  if (profile.backend === 'layered') {
    const result = await applyLayeredPatch({ target: options.target, profile, dryRun: options.dryRun === true })
    return { profile, compiled, result }
  }
  const defaults = await loadTemplateDefaults()
  const result = await patchPresetInPlace({
    target: options.target,
    mode: compiled.mode,
    promoteOn: compiled.promoteOn,
    bootstrapTools: compiled.bootstrapTools,
    bootstrapMaxTokens: compiled.bootstrapMaxTokens,
    suppressedContextSources: compiled.suppressedContextSources,
    suppressedContextPlugins: compiled.suppressedContextPlugins,
    compactionTools: compiled.compactionTools,
    name: options.name ?? compiled.name,
    description: options.description ?? compiled.description,
    defaults,
    dryRun: options.dryRun === true,
  })
  if (result.written) {
    await appendFile(result.recordPath, [
      `- patch apiVersion: ${profile.apiVersion}`,
      `- patch source: ${profile.from}`,
      `- patch layers: ${Object.entries(profile.hooks).filter(([, value]) => value?.enabled !== false && value?.enabled !== undefined).map(([key]) => key).join(', ') || 'session-phase, contextGate, toolBootstrap, anchor, instructionHint'}`,
      `- patch preserve: ${profile.preserve.join(', ')}`,
      '',
    ].join('\n'))
  }
  return { profile, compiled, result }
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const { profile, compiled, result } = await applyPatchSpec(options)
    process.stdout.write(`${result.written ? 'patched' : 'would patch'} preset\n`)
    process.stdout.write(`source: ${profile.from}\n`)
    process.stdout.write(`backend: ${profile.backend}\n`)
    process.stdout.write(`mode: ${compiled.mode}\n`)
    const activeLayers = Object.keys(profile.hooks).filter((key) => key !== 'unsupported' && (profile.hooks[key]?.enabled !== false))
    process.stdout.write(`layers: ${activeLayers.join(', ')}\n`)
    if (result.recordPath !== undefined) process.stdout.write(`record: ${result.recordPath}\n`)
  } catch (error) {
    process.stderr.write(`error: ${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  }
}
