import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../hook/dev-tool-search.mjs'

const CATALOG = [
  { name: 'bash', description: 'Run commands in a bash shell' },
  { name: 'str_replace_editor', description: 'Custom editing tool for viewing, creating and editing files' },
  { name: 'dev_tool_search', description: 'Discover and unlock tools' },
  { name: 'skill_search', description: 'Search the available skills by keyword' },
  { name: 'skill_load', description: 'Load one skill' },
  { name: 'web_search', description: 'internet search and web retrieval' },
  { name: 'subagent', description: 'delegate work to sub-agents' },
  { name: 'subagent_fork', description: 'delegate work to sub-agents (fork)' },
  { name: 'workflow', description: 'run multi-agent workflow scripts' },
  { name: 'todo_write', description: 'task tracking' },
]

function register() {
  let registered
  const ctx = {
    tools: {
      register(definition) {
        registered = definition
      },
      schemas() {
        return CATALOG
      },
    },
  }
  apply(ctx)
  return { ctx, tool: registered }
}

function run(tool, args, exec = {}) {
  return tool.execute(args, { ...exec })
}

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'dev-tool-search')
})

test('no query lists every unlockable tool name', async () => {
  const { tool } = register()
  const text = (await run(tool, {})).text
  for (const schema of CATALOG) {
    assert.ok(text.includes(`- ${schema.name}:`), schema.name)
  }
})

test('query "*" lists every unlockable tool name', async () => {
  const { tool } = register()
  const text = (await run(tool, { query: '*' })).text
  assert.match(text, /All unlockable tools \(10\):/)
  assert.ok(text.includes('- subagent:'))
})

test('multi-keyword queries use OR scoring instead of returning empty', async () => {
  const { tool } = register()
  const text = (await run(tool, { query: 'subagent fork workflow' })).text
  assert.ok(text.includes('- subagent:') || text.includes('- subagent_fork:') || text.includes('- workflow:'))
  assert.doesNotMatch(text, /No tools match/)
})

test('unlock validates exact names and reports unknown names', async () => {
  const { tool } = register()
  const text = (await run(tool, { toolNames: ['subagent', 'bogus_tool'] })).text
  assert.match(text, /Unlocked for the next request: subagent/)
  assert.match(text, /Unknown names \(NOT unlocked\): bogus_tool/)
})

test('a missing keyword suggests listing instead of claiming the tool does not exist', async () => {
  const { tool } = register()
  const text = (await run(tool, { query: 'notfound' })).text
  assert.match(text, /No tools match "notfound"/)
  assert.match(text, /list every unlockable tool/)
})
