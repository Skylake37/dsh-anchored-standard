import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizePatchProfile } from '../tools/patch-contract.mjs'
import { applyLayeredPatch } from '../tools/layered-patch.mjs'
import { buildLedger, sha256 } from '../tools/preservation-ledger.mjs'

const fixture = ['- id: persona', '  name: ./persona.mjs', '- id: mcp-cordis', '  name: ./mcp-cordis.mjs', '- id: permissions', '  name: ./permissions.mjs', '- id: tool-bash', '  name: ./tool-bash.mjs', '- id: platform-guard', '  name: ./platform-guard.mjs', ''].join('\n')
function profile() { return normalizePatchProfile({ from: 'fixture', backend: 'layered', mode: 'anchored' }) }

test('layered dry-run and apply share hashes and preserve undeclared rows', async () => {
  const target = await mkdtemp(join(tmpdir(), 'layered-ledger-'))
  try {
    await writeFile(join(target, 'agent.cordis.yml'), fixture)
    const p = profile()
    const dry = await applyLayeredPatch({ target, profile: p, dryRun: true })
    const applied = await applyLayeredPatch({ target, profile: p })
    assert.equal(dry.finalCompositionHash, applied.finalCompositionHash)
    assert.equal(dry.patchHash, applied.patchHash)
    const text = await readFile(join(target, 'agent.cordis.yml'), 'utf8')
    for (const id of ['persona', 'mcp-cordis', 'permissions', 'tool-bash', 'platform-guard']) assert.match(text, new RegExp('id: ' + id))
    const again = await applyLayeredPatch({ target, profile: p })
    assert.equal(again.verifiedNoOp, true)
  } finally { await rm(target, { recursive: true, force: true }) }
})

test('forbidden future mechanisms fail before writing', () => {
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { turnOpening: { enabled: true, kind: 'think' } } }), /think-phase/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { sessionSeed: { enabled: true } } }), /prefab/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { gateway: { enabled: true } } }), /gateway/)
})


test('ledger records disabled and replaced rows with per-row source/final hashes', () => {
  const sourceComposition = '- id: agent-instructions\n  name: ./agent-instructions.mjs\n- id: tool-bash\n  name: ./tool-bash.mjs\n'
  const finalComposition = '- id: agent-instructions\n  disabled: true\n  name: ./agent-instructions.mjs\n- id: tool-bash\n  name: ./custom-bash.mjs\n'
  const ledger = buildLedger({ sourceRows: ['agent-instructions', 'tool-bash'], targetRows: ['agent-instructions', 'tool-bash'], finalRows: ['agent-instructions', 'tool-bash'], sourceComposition, finalComposition, disabledRows: ['agent-instructions'], replacedRows: ['tool-bash'] })
  assert.equal(ledger.rows[0].category, 'disabled')
  assert.equal(ledger.rows[1].category, 'replaced')
  assert.equal(ledger.rows[0].sourceHash, sha256('- id: agent-instructions\n  name: ./agent-instructions.mjs\n'))
  assert.notEqual(ledger.rows[1].sourceHash, ledger.rows[1].finalHash)
})
