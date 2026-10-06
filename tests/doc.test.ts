import { expect, mock, test } from 'claude-code/testing'

import {
  PLAN_PATH,
  outlineOf,
  outlineRequest,
  parsePlan,
  planFromOutline,
  runFromDoc,
  ticked,
} from '../hooks/doc'
import { setTask, taskOf } from '../hooks/run'

const PLAN = [
  '# Queue retries',
  '',
  '> **For agentic workers:** use the plan below.',
  '',
  '## Schema',
  '',
  '### Task 1: Add the attempts column',
  '',
  '- [x] **Step 1: Write the failing test**',
  '',
  '```python',
  '# - [ ] not a step: this is inside a code fence',
  '### Task 9: nor is this a task',
  '```',
  '',
  '- [x] **Step 2: Run it**',
  '',
  '### Task 2: Backfill',
  '',
  '- [x] **Step 1: Write the failing test**',
  '- [ ] **Step 2: Implement**',
  '',
  '## API',
  '',
  '### Task 3: Retry with backoff',
  '',
  '- [ ] **Step 1: Write the failing test**',
  '- [ ] **Step 2: Implement `retry`**',
].join('\n')

const PATH = '/project/docs/superpowers/plans/2026-10-05-queue-retries.md'

test('a superpowers plan is read into tasks and steps, with nothing from inside a code fence', () => {
  const doc = parsePlan(PLAN)

  expect(doc?.title).toBe('Queue retries')
  expect(doc?.tasks.map(one => [one.n, one.title, one.unit, one.steps.length])).toEqual([
    ['1', 'Add the attempts column', 'Schema', 2],
    ['2', 'Backfill', 'Schema', 2],
    ['3', 'Retry with backoff', 'API', 2],
  ])
  expect(doc?.tasks[2]?.steps.map(one => one.text)).toEqual(['Step 1: Write the failing test', 'Step 2: Implement retry'])
  // A document with no task heading is laid out some other way.
  expect(parsePlan('# Roadmap\n\n- [ ] ship it\n')).toBeUndefined()
  expect(PLAN_PATH.test(PATH)).toBe(true)
  expect(PLAN_PATH.test('/project/docs/notes.md')).toBe(false)
})

test('the run a plan makes takes its state from the boxes, and keeps what the ledger added when read again', () => {
  const doc = parsePlan(PLAN)

  if (doc === undefined) {
    throw new Error('no plan')
  }

  const run = runFromDoc(doc, PATH, false, 1, 's1')

  expect(run.goal).toBe('Queue retries')
  expect(run.doc).toEqual({ path: PATH })
  expect(run.tasks.map(one => [one.id, one.unit, one.status])).toEqual([
    ['T1', 'Schema', 'done'],
    ['T2', 'Schema', 'running'],
    ['T3', 'API', 'todo'],
  ])
  // A subagent described as the document names a task is that task's.
  expect(taskOf(run, 'Task 3: Retry with backoff')).toBe('T3')
  expect(taskOf(run, 'Implement task 2 (backfill)')).toBe('T2')
  expect(taskOf(run, 'Task 30: something else')).toBeUndefined()

  // The agent marks T3 done with an outcome and fails T2's gate; the document
  // is read again with nothing ticked since.
  const noted = setTask(setTask(run, 'T3', 'done', undefined, 'retry() in src/jobs.py') as typeof run, 'T2', 'gate-failed', 'tests fail')

  if (typeof noted === 'string') {
    throw new Error(noted)
  }

  const again = runFromDoc(doc, PATH, false, 2, 's1', { ...noted, id: 4 })
  expect(again.id).toBe(4)
  expect(again.tasks.map(one => one.status)).toEqual(['done', 'gate-failed', 'done'])
  expect(again.tasks[2]?.outcome).toBe('retry() in src/jobs.py')
  expect(again.tasks[1]?.note).toBe('tests fail')

  // Its missed boxes are ticked: T3's two, and nothing of T2, which is not done.
  const after = ticked(PLAN, doc, again)
  expect(after.count).toBe(2)
  expect(after.text.split('\n').slice(-2)).toEqual([
    '- [x] **Step 1: Write the failing test**',
    '- [x] **Step 2: Implement `retry`**',
  ])
  expect(after.text).toContain('- [ ] **Step 2: Implement**')
  expect(after.text).toContain('# - [ ] not a step')
  // Ticked already, nothing changes.
  expect(ticked(after.text, parsePlan(after.text) ?? doc, again)).toEqual({ text: after.text, count: 0 })
})

const ROADMAP = ['# Roadmap', '', '## Q4', '', '**Billing**', '- [x] invoices', '- [ ] refunds', '', '**Search**', '- [ ] index'].join(
  '\n',
)

test('a document laid out another way is grouped by a small model from its headings and boxes alone', () => {
  const outline = outlineOf(ROADMAP)

  // Only headings and checkboxes are sent, each with its line number.
  expect(outline.split('\n')).toEqual(['0: # Roadmap', '2: ## Q4', '5: - [x] invoices', '6: - [ ] refunds', '9: - [ ] index'])
  expect(outlineRequest(outline)).toContain('Answer with JSON only')

  const doc = planFromOutline(
    ROADMAP,
    'Here you go: [{"title": "Billing", "head": 4, "steps": [5, 6]}, {"title": "Search", "head": 8, "steps": [9, 77]}]',
  )

  // The words and ticks are the document's own; a line that is no checkbox is dropped.
  expect(doc?.tasks.map(one => [one.n, one.title, one.steps.map(step => [step.text, step.isDone])])).toEqual([
    ['1', 'Billing', [['invoices', true], ['refunds', false]]],
    ['2', 'Search', [['index', false]]],
  ])
  expect(planFromOutline(ROADMAP, 'I could not do that.')).toBeUndefined()
})

test('a plan saved where superpowers saves them becomes a run, follows its edits, and has missed boxes ticked', { options: { followPlans: true } }, async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const files: Record<string, string> = { [PATH]: PLAN }
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$, e) => {
    files[e.path] = e.text

    return { value: undefined }
  })
  on('tool.call', { tool: 'Write' }, () => ({ result: 'written' }))

  // The plan is written: with no call from the agent, there is a run.
  await $.tool.call({ tool: 'Write', file_path: PATH, content: PLAN })
  const read = String((await $.tool.call({ tool: 'mcp__ledger__report' })).result)
  expect(read).toContain('Ledger: Queue retries')
  expect(read).toContain(`Plan: ${PATH}`)
  expect(read).toContain('[done] T1 Add the attempts column [2/2]')
  expect(read).toContain('[running] T2 Backfill [1/2]')
  expect(read).toContain('[todo] T3 Retry with backoff [0/2]')

  // The agent marks T3 done, its boxes never ticked: the ledger ticks them.
  await $.tool.call({ tool: 'mcp__ledger__task', tasks: [{ id: 'T3', status: 'done' }] })
  expect(files[PATH]?.split('\n').slice(-2)).toEqual([
    '- [x] **Step 1: Write the failing test**',
    '- [x] **Step 2: Implement `retry`**',
  ])
  expect(String((await $.tool.call({ tool: 'mcp__ledger__report' })).result)).toContain(
    '[done] T3 Retry with backoff [2/2]',
  )

  // Nothing left to tick, said without touching the file.
  const typed = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as const
  expect((await $.command.run({ command: 'ledger', args: 'tick --dry', ...typed })).text).toBe(
    `Ledger: would tick 0 in ${PATH}.`,
  )
})

test('with the setting off a plan document starts no run, until it is followed by name', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const prompts: string[] = []
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('roadmap.md') ? ROADMAP : PLAN }))
  on('tool.call', { tool: 'Write' }, () => ({ result: 'written' }))
  on('model.complete', (_$, e) => {
    prompts.push(e.prompt)

    return {
      value: {
        isAnswered: true,
        text: '[{"title": "Billing", "head": 4, "steps": [5, 6]}, {"title": "Search", "head": 8, "steps": [9]}]',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })

  await $.tool.call({ tool: 'Write', file_path: PATH, content: PLAN })
  expect((await $.tool.call({ tool: 'mcp__ledger__report' })).result).toBe('Nothing is planned.')

  // A free-form roadmap, followed by name: a small model groups it, once.
  const typed = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as const
  const said = String((await $.command.run({ command: 'ledger', args: 'follow docs/roadmap.md', ...typed })).text)
  expect(said).toContain('following /project/docs/roadmap.md, 2 tasks (laid out by a small model')
  expect(prompts.length).toBe(1)
  expect(prompts[0]).not.toContain('**Billing**')

  const read = String((await $.tool.call({ tool: 'mcp__ledger__report' })).result)
  expect(read).toContain('[running] T1 Billing [1/2]')
  expect(read).toContain('[todo] T2 Search [0/1]')

  // Followed again, the model is not asked a second time.
  await $.command.run({ command: 'ledger', args: 'follow docs/roadmap.md', ...typed })
  expect(prompts.length).toBe(1)
})
