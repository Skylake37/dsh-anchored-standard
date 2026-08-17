/**
 * instruction-hint — replace `dsh-agent-instructions`' full AGENTS.md/CLAUDE.md
 * injection with a minimal "these reference documents exist" note.
 *
 * WHY: the full workspace-instruction digest is a large injected block. After
 * the anchored bootstrap promotes, we want the model to KNOW the reference
 * files exist without dumping their content into every request. The model
 * reads the files itself via the filesystem tools when it needs them.
 *
 * Wording contract (measured, upstream issue #49): this injected user-role
 * message must stay a NEUTRAL/SUGGESTIVE reference note. Imperative wording
 * ("Do NOT assume… read first and follow them") coincided with the reasoning
 * style flipping from collaborative "we" to first-person "let me" exactly on
 * the promoted request. Keep it declarative: state existence, state purpose,
 * recommend softly, never command.
 *
 * Behavior:
 *  - After the session records its first durable promotion signal
 *    (`promoteOn`, default `either`), ONE hint message is injected (once per
 *    session — durable event scan, resume-safe), listing which reference
 *    files were found:
 *      - user-global: `$DSH_HOME/AGENTS.md`
 *      - project chain: AGENTS.md / CLAUDE.md / AGENTS.local.md / CLAUDE.local.md
 *        walking up from the session cwd to the project root (a directory
 *        containing `.git`, or the cwd itself).
 *  - Files are probed via `ctx.fs` (the host filesystem seam); a missing fs
 *    service or an unreadable probe degrades to no hint (never throws).
 *  - Pre-promotion requests get NO hint (matches the anchored bootstrap).
 *  - `includeSubagents: true` makes subagents follow the same promotion clock
 *    as top-level sessions. Anchor modes that anchor subagents MUST set it,
 *    otherwise a child receives the post-promotion hint on its anchor request.
 *
 * ROW ORDER: this plugin registers its `agent/pre-step` handler with
 * `prepend: true` and after `anchor-bootstrap`, so it runs inside the
 * bootstrap's outermost strip — but it emits AFTER promotion, when the strip
 * is inactive. The hint source kind is `instruction-hint`, which is NOT in
 * `suppressedContextSources`, so it is never stripped.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'instruction-hint'

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Candidate file names, in probe order, for the project chain and user-global. */
const PROJECT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
const USER_GLOBAL_CANDIDATE = 'AGENTS.md'

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/** Find the project root: first ancestor containing any root marker (e.g. .git). */
async function findProjectRoot(fs, cwd, signal) {
  let current = cwd
  for (;;) {
    for (const marker of ['.git', '.hg', '.svn']) {
      try {
        const target = await fs.resolve(joinPath(current, marker), { cwd, signal })
        const info = await fs.stat(target, signal)
        if (info !== undefined) return current
      } catch {
        // Probe failure = marker absent; continue.
      }
    }
    const parent = parentPath(current)
    if (parent === current || parent.length === 0) return cwd
    current = parent
  }
}

/** List instruction files present in one directory (project candidates). */
async function presentInDir(fs, dir, candidates, signal) {
  const found = []
  for (const candidate of candidates) {
    try {
      const target = await fs.resolve(joinPath(dir, candidate), { cwd: dir, signal })
      const info = await fs.stat(target, signal)
      if (info !== undefined && info.type === 'file') found.push(candidate)
    } catch {
      // Absent or unreadable — skip.
    }
  }
  return found
}

/** Join one path segment onto a directory (platform-agnostic string join). */
function joinPath(dir, segment) {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + segment
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir + sep + segment
}

/** Parent of an absolute Windows or POSIX path. */
function parentPath(path) {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx <= 0) return path
  const parent = path.slice(0, idx)
  return parent.length === 0 ? path : parent
}

/** Neutral/suggestive post-promotion hint body. */
function renderHint(projectPaths, userGlobalPath) {
  const sections = []
  if (projectPaths.length > 0) {
    sections.push(`Reference documents exist in the project: ${projectPaths.join(', ')}.`)
  }
  if (userGlobalPath !== undefined) {
    sections.push(`A user reference document exists: ${userGlobalPath} (topic index; topic files AGENTS-*.md and env-* skills).`)
  }
  if (sections.length > 0) {
    sections.push(
      'They are reference documents about the user environment (paths, network rules, tooling notes), not task instructions.',
      'Reading them before workspace tasks is recommended — they are short — but consult them only when you need environment details; the task itself never depends on them.',
    )
  }
  sections.push(
    'The resident tool set is intentionally small; most other capabilities are unlockable through dev_tool_search.',
    'The preceding anchor or identity response only established the phase; the next user message is the first normal task phase, so the same discovery pattern applies there.',
    'Common unlockable families: read / write / edit / glob / grep / todo_write / ask_user_question, web_search, subagent / subagent_fork / workflow, and mcp__* servers.',
    'That pattern remains useful even when bash or str_replace_editor can perform the task: the purpose-built unlocked tool is usually the more direct path.',
  )
  return sections.join(' ')
}

/** Register the post-promotion instruction-hint injector. */
export function apply(ctx, config) {
  const promoteEvents = parsePromoteOn(config.promoteOn)
  const includeSubagents = config?.includeSubagents === true
  const promotion = createEpochPromotion(promoteEvents, { includeSubagents })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  /** Sessions that already received the hint. */
  const hinted = new Set()
  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    try {
      if (promotion.status(agent).promoted !== true) return decision
      const session = agent.session
      if (session === undefined || hinted.has(session.id)) return decision
      hinted.add(session.id)

      const fs = ctx.get('fs')
      if (fs === undefined) return decision
      const cwd = session.header.cwd ?? process.cwd()

      const projectFiles = []
      const root = await findProjectRoot(fs, cwd, signal)
      projectFiles.push(...await presentInDir(fs, root, PROJECT_CANDIDATES, signal))

      const dshHome = process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : undefined)
      let userGlobalPath
      if (dshHome !== undefined) {
        const userGlobalFiles = await presentInDir(fs, dshHome, [USER_GLOBAL_CANDIDATE], signal)
        if (userGlobalFiles.length > 0) userGlobalPath = joinPath(dshHome, USER_GLOBAL_CANDIDATE)
      }

      const text = renderHint(projectFiles.map((file) => joinPath(root, file)), userGlobalPath)

      return {
        ...decision,
        messages: [...decision.messages, {
          id: `instruction-hint-${session.id}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'instruction-hint', form: 'hint' },
        }],
      }
    } catch (error) {
      // A hint bug must never hurt the session: skip the hint.
      warnOnce(`${name}: hint injection failed, skipping: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
