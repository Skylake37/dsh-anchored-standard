import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { duplicatePatchRows, normalizePatchProfile } from '../tools/patch-contract.mjs'
import { applyLayeredPatch } from '../tools/layered-patch.mjs'
import { buildLedger, sha256 } from '../tools/preservation-ledger.mjs'

const fixture = ['- id: agent-instructions', '  name: ./agent-instructions.mjs', '- id: persona', '  name: ./persona.mjs', '- id: mcp-cordis', '  name: ./mcp-cordis.mjs', '- id: permissions', '  name: ./permissions.mjs', '- id: tool-bash', "  name: '@deepseek-ai/dsh-tool-bash'", '- id: platform-guard', '  name: ./platform-guard.mjs', ''].join('\n')
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
    assert.equal(applied.ledger.rows.find((row) => row.id === 'agent-instructions').category, 'disabled')
    assert.equal(applied.ledger.rows.find((row) => row.id === 'tool-bash').category, 'replaced')
    const text = await readFile(join(target, 'agent.cordis.yml'), 'utf8')
    for (const id of ['persona', 'mcp-cordis', 'permissions', 'tool-bash', 'platform-guard']) assert.match(text, new RegExp('id: ' + id))
    const again = await applyLayeredPatch({ target, profile: p })
    assert.equal(again.verifiedNoOp, true)
  } finally { await rm(target, { recursive: true, force: true }) }
})

test('layered turnOpening and toolExecution are accepted while other future mechanisms still fail', () => {
  assert.doesNotThrow(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { turnOpening: { enabled: true, kind: 'think' } } }))
  assert.doesNotThrow(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { turnOpening: { enabled: true, kind: 'wire-think', provider: 'deepseek-wire-think', defaultProvider: 'deepseek-official' } } }))
  assert.doesNotThrow(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { toolExecution: { deliberationGate: { enabled: true } } } }))
  assert.doesNotThrow(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { toolExecution: { cotDrip: { enabled: true } } } }))
  assert.doesNotThrow(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { toolExecution: { deliberationGate: { enabled: true, minChars: 200 }, cotDrip: { enabled: true, every: 2, maxPerTurn: 1 } } } }))
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'legacy', hooks: { turnOpening: { enabled: true, kind: 'think' } } }), /think-phase/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'legacy', hooks: { toolExecution: { deliberationGate: { enabled: true } } } }), /legacy patch backend/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'legacy', hooks: { toolExecution: { cotDrip: { enabled: true } } } }), /legacy patch backend/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'layered', mode: 'zero', hooks: { turnOpening: { enabled: true, kind: 'think' } } }), /requires anchored mode/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'layered', mode: 'whoami', hooks: { turnOpening: { enabled: true, kind: 'think' } } }), /requires anchored mode/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { turnOpening: { enabled: true, kind: 'wire-think', provider: 'same', defaultProvider: 'same' } } }), /must differ/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { turnOpening: { enabled: true, kind: 'through' } } }), /kind is invalid/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { turnOpening: { enabled: true, kind: 'wire-think', provider: 42, defaultProvider: 'deepseek-official' } } }), /provider/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { turnOpening: { enabled: true, kind: 'think', steerText: '' } } }), /steerText/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { toolExecution: { deliberationGate: { enabled: true, gateText: '' } } } }), /gateText/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { toolExecution: { cotDrip: { enabled: true, text: 42 } } } }), /text/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { sessionSeed: { enabled: true } } }), /prefab/)
  assert.throws(() => normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { gateway: { enabled: true } } }), /gateway/)
})

test('think-phase and wire-think are competing turn-opening rows in existing sources', () => {
  const source = '- id: anchor-turn\n  name: ./anchor-turn.mjs\n- id: think-phase\n  name: ./think-phase.mjs\n- id: toolchoice-adapter\n  name: ./toolchoice-adapter.mjs\n- id: wire-think\n  name: ./wire-think.mjs\n'
  const think = normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { turnOpening: { enabled: true, kind: 'think' } } })
  const wire = normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { turnOpening: { enabled: true, kind: 'wire-think', provider: 'deepseek-wire-think', defaultProvider: 'deepseek-official' } } })
  assert.deepEqual(duplicatePatchRows(source, think).sort(), ['anchor-turn', 'think-phase', 'wire-think'])
  assert.deepEqual(duplicatePatchRows(source, wire).sort(), ['anchor-turn', 'think-phase', 'toolchoice-adapter', 'wire-think'])
})

test('deliberation-gate and cot-drip are competing tool-execution rows in existing sources', () => {
  const source = '- id: deliberation-gate\n  name: ./deliberation-gate.mjs\n- id: cot-drip\n  name: ./cot-drip.mjs\n'
  const exec = normalizePatchProfile({ from: 'x', backend: 'layered', hooks: { toolExecution: { deliberationGate: { enabled: true }, cotDrip: { enabled: true } } } })
  assert.deepEqual(duplicatePatchRows(source, exec).sort(), ['cot-drip', 'deliberation-gate'])
})


test('layered think and wire patches render/copy independent rows and files', async () => {
  const target = await mkdtemp(join(tmpdir(), 'layered-turn-'))
  try {
    await writeFile(join(target, 'agent.cordis.yml'), fixture)
    const think = normalizePatchProfile({ from: 'fixture', backend: 'layered', mode: 'anchored', hooks: { turnOpening: { enabled: true, kind: 'think' } } })
    const thinkDry = await applyLayeredPatch({ target, profile: think, dryRun: true })
    assert.ok(thinkDry.plan.filesToCopy.includes('think-phase.mjs'))
    assert.ok(!thinkDry.plan.filesToCopy.includes('wire-think.mjs'))
    assert.deepEqual([...thinkDry.composition.matchAll(/- id: (think-phase|wire-think|toolchoice-adapter)/g)].map((match) => match[1]), ['think-phase'])

    const wire = normalizePatchProfile({ from: 'fixture', backend: 'layered', mode: 'anchored', hooks: { turnOpening: { enabled: true, kind: 'wire-think', provider: 'ptc-wire-think', defaultProvider: 'deepseek-official' } } })
    const wireDry = await applyLayeredPatch({ target, profile: wire, dryRun: true })
    assert.ok(wireDry.plan.filesToCopy.includes('toolchoice-adapter.mjs'))
    assert.ok(wireDry.plan.filesToCopy.includes('wire-think.mjs'))
    assert.ok(!wireDry.plan.filesToCopy.includes('think-phase.mjs'))
    const ids = [...wireDry.composition.matchAll(/- id: (toolchoice-adapter|wire-think|think-phase)/g)].map((match) => match[1])
    assert.deepEqual(ids, ['toolchoice-adapter', 'wire-think'])
    const adapterBlock = wireDry.composition.slice(wireDry.composition.indexOf('- id: toolchoice-adapter'), wireDry.composition.indexOf('- id: wire-think'))
    const wireBlock = wireDry.composition.slice(wireDry.composition.indexOf('- id: wire-think'))
    assert.match(adapterBlock, /provider: "ptc-wire-think"/)
    assert.match(wireBlock, /provider: "ptc-wire-think"/)
    assert.match(wireBlock, /defaultProvider: "deepseek-official"/)

    const wireWritten = await applyLayeredPatch({ target, profile: wire })
    assert.equal(wireWritten.written, true)
    const writtenText = await readFile(join(target, 'agent.cordis.yml'), 'utf8')
    assert.match(writtenText, /- id: toolchoice-adapter/)
    assert.match(writtenText, /- id: wire-think/)
    assert.doesNotMatch(writtenText, /- id: think-phase/)
    for (const file of ['toolchoice-adapter.mjs', 'wire-think.mjs', 'think-phase.mjs']) {
      assert.equal(await stat(join(target, file)).then(() => true).catch(() => false), file !== 'think-phase.mjs')
    }
  } finally { await rm(target, { recursive: true, force: true }) }
})

test('layered deliberation and cot patches render/copy independent rows and ledger rows', async () => {
  const target = await mkdtemp(join(tmpdir(), 'layered-exec-'))
  try {
    await writeFile(join(target, 'agent.cordis.yml'), fixture)
    const exec = normalizePatchProfile({
      from: 'fixture',
      backend: 'layered',
      mode: 'anchored',
      hooks: {
        toolExecution: {
          deliberationGate: { enabled: true, minChars: 200, maxGatesPerTurn: 2, gateText: 'Plan before retry.' },
          cotDrip: { enabled: true, every: 2, maxPerTurn: 1, text: 'Stay on plan.' },
        },
      },
    })
    const dry = await applyLayeredPatch({ target, profile: exec, dryRun: true })
    assert.ok(dry.plan.filesToCopy.includes('deliberation-gate.mjs'))
    assert.ok(dry.plan.filesToCopy.includes('cot-drip.mjs'))
    const ids = [...dry.composition.matchAll(/- id: (deliberation-gate|cot-drip)/g)].map((match) => match[1])
    assert.deepEqual(ids, ['deliberation-gate', 'cot-drip'])
    const gateBlock = dry.composition.slice(dry.composition.indexOf('- id: deliberation-gate'), dry.composition.indexOf('- id: cot-drip'))
    const dripBlock = dry.composition.slice(dry.composition.indexOf('- id: cot-drip'))
    assert.match(gateBlock, /minChars: 200/)
    assert.match(gateBlock, /maxGatesPerTurn: 2/)
    assert.match(gateBlock, /gateText: "Plan before retry."/)
    assert.match(dripBlock, /every: 2/)
    assert.match(dripBlock, /maxPerTurn: 1/)
    assert.match(dripBlock, /text: "Stay on plan."/)
    const added = dry.ledger.rows.filter((row) => row.id === 'deliberation-gate' || row.id === 'cot-drip')
    assert.equal(added.length, 2)
    assert.ok(added.every((row) => row.category === 'added'))
    assert.ok(added.every((row) => row.sourceHash === null))

    const written = await applyLayeredPatch({ target, profile: exec })
    assert.equal(written.written, true)
    const writtenText = await readFile(join(target, 'agent.cordis.yml'), 'utf8')
    assert.match(writtenText, /- id: deliberation-gate/)
    assert.match(writtenText, /- id: cot-drip/)
    for (const id of ['persona', 'mcp-cordis', 'permissions', 'tool-bash', 'platform-guard']) assert.match(writtenText, new RegExp('id: ' + id))
    for (const file of ['deliberation-gate.mjs', 'cot-drip.mjs']) {
      assert.equal(await stat(join(target, file)).then(() => true).catch(() => false), true)
    }
    const ledgerPath = join(target, '.layered-preservation-ledger.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
    assert.equal(ledger.rows.find((row) => row.id === 'deliberation-gate').category, 'added')
    assert.equal(ledger.rows.find((row) => row.id === 'cot-drip').category, 'added')
    assert.equal(ledger.rows.find((row) => row.id === 'persona').category, 'claimed')
    const again = await applyLayeredPatch({ target, profile: exec })
    assert.equal(again.verifiedNoOp, true)
  } finally { await rm(target, { recursive: true, force: true }) }
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

