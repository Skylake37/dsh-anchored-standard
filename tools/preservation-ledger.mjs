import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const LEDGER_VERSION = 'dsh-preservation-ledger/v1'
export const ROW_CATEGORIES = Object.freeze(['claimed', 'added', 'disabled', 'replaced'])

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
export function hashJson(value) { return sha256(JSON.stringify(value, Object.keys(value ?? {}).sort())) }
export function rowIds(composition) {
  return [...composition.matchAll(/^\s*- id:\s*([^\s#]+).*$/gm)].map((m) => m[1])
}
export function canonicalizeComposition(composition) { return composition.replace(/\r\n/g, '\n').trimEnd() + '\n' }
export async function fileHash(path) { try { return sha256(await readFile(path)) } catch { return null } }
export async function targetPreconditionHash(target, compositionFile, hookFiles = []) {
  const names = [compositionFile, ...hookFiles].sort()
  const parts = []
  for (const name of names) parts.push(name + ':' + (await fileHash(join(target, name)) ?? '<missing>'))
  return sha256(parts.join('\n'))
}
export function buildLedger({ sourceRows, targetRows, finalRows, addedFiles = [], disabledRows = [], replacedRows = [] }) {
  const source = new Set(sourceRows), target = new Set(targetRows), final = new Set(finalRows)
  const rows = []
  for (const id of sourceRows) rows.push({ id, category: disabledRows.includes(id) ? 'disabled' : replacedRows.includes(id) ? 'replaced' : 'claimed', source: true, target: target.has(id), final: final.has(id) })
  for (const id of finalRows) if (!source.has(id)) rows.push({ id, category: 'added', source: false, target: target.has(id), final: true })
  return Object.freeze({ version: LEDGER_VERSION, rows, files: addedFiles.map((path) => ({ path, category: 'added' })) })
}
export function assertCanonicalRowOrder(composition, order) {
  const rank = new Map(order.map((id, i) => [id, i]))
  const ids = rowIds(composition).filter((id) => rank.has(id))
  for (let i = 1; i < ids.length; i++) if (rank.get(ids[i - 1]) > rank.get(ids[i])) throw new Error('composition rows are not in canonical order: ' + ids[i - 1] + ' before ' + ids[i])
  return ids
}
