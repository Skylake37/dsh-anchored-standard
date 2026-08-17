/** Compile/apply the independent upstream-style hook rows. */

import { readFile, stat, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COMPOSITION_FILE,
  HOOK_SOURCE,
  detectBootstrapTools,
  disableRow,
  insertBootstrapRow,
  stampMinimalToolRows,
} from './make-anchored-preset.mjs'
import { duplicatePatchRows } from './patch-contract.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const COMPOSITION = COMPOSITION_FILE
const SOURCE_FILES = Object.freeze({
  'context-gate.mjs': 'shared/context-gate.mjs',
  'compaction-epoch.mjs': 'shared/compaction-epoch.mjs',
  'instruction-hint.mjs': 'shared/instruction-hint.mjs',
  'dev-tool-search.mjs': 'shared/dev-tool-search.mjs',
  'skill-search.mjs': 'shared/skill-search.mjs',
  'tool-bootstrap.mjs': 'shared/tool-bootstrap.mjs',
  'zero-tool-bootstrap.mjs': 'shared/zero-tool-bootstrap.mjs',
  'anchor-turn.mjs': 'shared/anchor-turn.mjs',
})

function yamlList(items) {
  return `[${items.map((item) => JSON.stringify(item)).join(', ')}]`
}

function yamlString(value) {
  return JSON.stringify(value)
}

function anchorText(profile) {
  if (profile.hooks.anchor.text !== undefined) return profile.hooks.anchor.text
  return profile.mode === 'whoami'
    ? '你是谁'
    : 'This round is a test. Tools are not open yet; all tools will open next round.'
}

/** Render independent rows in canonical patch order. */
export function buildLayeredRows(profile, bootstrapTools) {
  const { sessionPhase, contextGate, toolBootstrap, anchor, instructionHint } = profile.hooks
  const rows = []
  rows.push([
    '# ── context-gate (layered patch; must remain FIRST) ──',
    '- id: context-gate',
    '  name: ./context-gate.mjs',
    '  config:',
    `    promoteOn: ${sessionPhase.promoteOn}`,
    `    includeSubagents: ${sessionPhase.includeSubagents}`,
    `    allowKinds: ${yamlList(contextGate.allowKinds)}`,
  ].join('\n'))

  if (profile.mode === 'anchored') {
    rows.push([
      '- id: tool-bootstrap',
      '  name: ./tool-bootstrap.mjs',
      '  config:',
      `    bootstrapTools: ${yamlList(bootstrapTools)}`,
      `    promoteOn: ${sessionPhase.promoteOn}`,
      `    includeSubagents: ${sessionPhase.includeSubagents}`,
      `    compactionTools: ${yamlList(toolBootstrap.compactionTools)}`,
      ...(toolBootstrap.bootstrapMaxTokens === undefined ? [] : [`    bootstrapMaxTokens: ${toolBootstrap.bootstrapMaxTokens}`]),
    ].join('\n'))
  } else {
    rows.push([
      '- id: zero-tool-bootstrap',
      '  name: ./zero-tool-bootstrap.mjs',
      '  config:',
      `    compactionTools: ${yamlList(toolBootstrap.compactionTools)}`,
      `    includeSubagents: ${sessionPhase.includeSubagents}`,
    ].join('\n'))
    rows.push([
      '- id: anchor-turn',
      '  name: ./anchor-turn.mjs',
      '  config:',
      `    text: ${yamlString(anchorText(profile))}`,
      `    includeSubagents: ${anchor.includeSubagents || sessionPhase.includeSubagents}`,
    ].join('\n'))
  }

  rows.push([
    '- id: instruction-hint',
    '  name: ./instruction-hint.mjs',
    '  config:',
    `    promoteOn: ${sessionPhase.promoteOn}`,
    `    includeSubagents: ${instructionHint.includeSubagents}`,
  ].join('\n'))
  rows.push([
    '- id: dev-tool-search',
    '  name: ./dev-tool-search.mjs',
    '',
    '- id: skill-search',
    '  name: ./skill-search.mjs',
  ].join('\n'))
  return rows.join('\n\n')
}

async function copyLayerFiles(target, profile) {
  const names = ['context-gate.mjs', 'compaction-epoch.mjs', 'instruction-hint.mjs', 'dev-tool-search.mjs', 'skill-search.mjs']
  names.push(profile.mode === 'anchored' ? 'tool-bootstrap.mjs' : 'zero-tool-bootstrap.mjs')
  if (profile.mode !== 'anchored') names.push('anchor-turn.mjs')
  for (const name of names) {
    await copyFile(join(ROOT, SOURCE_FILES[name]), join(target, name))
  }
  return names
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

/** Apply a layered patch to an existing preset without replacing source rows. */
export async function applyLayeredPatch({ target: rawTarget, profile, winBashPath, dryRun = false }) {
  const target = resolve(rawTarget)
  if (!(await isDirectory(target))) throw new Error(`target preset directory not found: ${target}`)
  const compositionPath = join(target, COMPOSITION)
  const composition = await readFile(compositionPath, 'utf8')
  const duplicates = duplicatePatchRows(composition, profile)
  if (duplicates.length > 0) throw new Error(`target already mounts conflicting hook row(s): ${duplicates.join(', ')}`)

  const bootstrapTools = detectBootstrapTools(composition) ?? ['bash', 'str_replace_editor']
  const stamped = stampMinimalToolRows(composition, bootstrapTools, { winBashPath })
  let finalComposition = stamped.composition
  const disabledSourceRows = []
  for (const sourceRow of ['agent-instructions', 'tool-skill']) {
    const disabled = disableRow(finalComposition, sourceRow)
    if (disabled.disabled) {
      finalComposition = disabled.composition
      disabledSourceRows.push(sourceRow)
    }
  }
  const rows = buildLayeredRows(profile, bootstrapTools)
  finalComposition = insertBootstrapRow(finalComposition, rows)

  const plan = {
    target,
    backend: 'layered',
    mode: profile.mode,
    bootstrapTools,
    disabledSourceRows,
    appendedToolGroups: stamped.appended,
    filesToCopy: Object.keys(SOURCE_FILES).filter((name) => name === 'context-gate.mjs' || name === 'compaction-epoch.mjs' || name === 'instruction-hint.mjs' || name === 'dev-tool-search.mjs' || name === 'skill-search.mjs' || (profile.mode === 'anchored' ? name === 'tool-bootstrap.mjs' : name === 'zero-tool-bootstrap.mjs') || (profile.mode !== 'anchored' && name === 'anchor-turn.mjs')),
  }
  if (dryRun) return { plan, written: false, composition: finalComposition }

  await writeFile(compositionPath, finalComposition)
  const copied = await copyLayerFiles(target, profile)
  const recordPath = join(target, 'HOOK-INSTALL-LAYERED.md')
  await writeFile(recordPath, [
    '# Layered hook patch record',
    '',
    `- backend: layered`,
    `- mode: ${profile.mode}`,
    `- source: ${profile.from}`,
    `- files copied: ${copied.join(', ')}`,
    `- disabled source rows: ${disabledSourceRows.length > 0 ? disabledSourceRows.join(', ') : 'none'}`,
    `- appended tool groups: ${stamped.appended.length > 0 ? stamped.appended.join(', ') : 'none'}`,
    '',
    'This patch preserves source rows except the explicitly claimed instruction/tool-skill',
    'injection layer and the bootstrap tool rows required to expose the declared surface.',
    '',
  ].join('\n'))
  return { plan, written: true, recordPath, composition: finalComposition }
}
