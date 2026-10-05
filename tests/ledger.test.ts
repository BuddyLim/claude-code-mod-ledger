import { expect, mock, test } from 'claude-code/testing'

import type { LedgerRun } from '../types'
import {
  countsOf,
  ended,
  fixed,
  found,
  isDone,
  orphaned,
  plan,
  report,
  resumed,
  setTask,
  spawned,
  statusText,
  taskOf,
  tokensText,
  unitsOf,
} from '../hooks/run'

const TASKS = [
  { id: 'T1', unit: 'Schema', title: 'add the column', tier: 'haiku', check: 'migration runs' },
  { id: 'T2', unit: 'Schema', title: 'backfill', tier: 'sonnet' },
  { id: 'T3', unit: 'API', title: 'add the retry', tier: 'opus' },
]

const planned = (): LedgerRun => {
  const run = plan('Queue retries', TASKS, 0)

  if (typeof run === 'string') {
    throw new Error(run)
  }

  return run
}

const must = (run: LedgerRun | string): LedgerRun => {
  if (typeof run === 'string') {
    throw new Error(run)
  }

  return run
}

const bandText = (run: LedgerRun) => statusText(run) ?? ''

test('a plan keeps its units in order and refuses an id used twice', () => {
  const run = planned()

  expect(unitsOf(run).map(unit => [unit.name, unit.tasks.length])).toEqual([
    ['Schema', 2],
    ['API', 1],
  ])
  expect(run.tasks.every(one => one.status === 'todo')).toBe(true)
  expect(plan('x', [], 0)).toBe('A plan needs at least one task.')
  expect(plan('x', [TASKS[0], TASKS[0]].flatMap(one => (one === undefined ? [] : [one])), 0)).toBe(
    'Task id T1 is used twice.',
  )
  // A task that names no unit is in "main".
  expect(must(plan('x', [{ id: 'A', title: 'a' }], 0)).tasks[0]?.unit).toBe('main')
})

test('a spawn is recorded against the task its description names', () => {
  const run = planned()

  expect(taskOf(run, '[T3] add the retry')).toBe('T3')
  expect(taskOf(run, 'T2 backfill the rows')).toBe('T2')
  expect(taskOf(run, 'review the unit', 'Review what [T1] changed.')).toBe('T1')
  // T1 is not named by T10, nor by a word that only contains it.
  expect(taskOf(run, 'T10 something else')).toBeUndefined()
  // Punctuation after an id does not hide it, and the id named first wins.
  expect(taskOf(run, 'Implement T1.')).toBe('T1')
  expect(taskOf(run, 'T3-retry, after T1')).toBe('T3')
  // Of two ids starting at one place, the longer is the one meant.
  const dotted = must(plan('x', [{ id: '1', title: 'a' }, { id: '1.2', title: 'b' }], 0))
  expect(taskOf(dotted, 'do 1.2 now')).toBe('1.2')
  expect(taskOf(run, 'look around')).toBeUndefined()

  const started = spawned(run, {
    agentId: 'a1',
    task: 'T3',
    description: '[T3] add the retry',
    type: 'general-purpose',
    model: 'opus',
    startedAt: 5,
  })
  expect(started.tasks.find(one => one.id === 'T3')?.status).toBe('running')
  expect(countsOf(started).agents).toBe(1)

  const over = ended(ended(started, 'a1', 'answer', 1200, 9), 'unknown', 'answer', 50, 9)
  expect(over.spawns).toEqual([{ ...started.spawns[0], endedAt: 9, reason: 'answer', tokens: 1200 }])
  expect(countsOf(over).agents).toBe(0)
  expect(countsOf(over).tokens).toBe(1200)

  // Sent a message, it runs again; its second turn adds to what it had used.
  const again = resumed(over, 'a1')
  expect(countsOf(again).agents).toBe(1)
  expect(countsOf(ended(again, 'a1', 'answer', 300, 12)).tokens).toBe(1500)
  // Recorded a second time, it keeps its tokens.
  expect(countsOf(spawned(over, { ...started.spawns[0]!, startedAt: 20 })).tokens).toBe(1200)
  // Another session finds the agents this one left running ended.
  expect(orphaned(started, 30).spawns[0]).toEqual({ ...started.spawns[0], endedAt: 30, reason: 'session ended' })
})

test('the band follows the run: the unit work is on, failed gates, agents and findings', () => {
  let run = planned()
  expect(bandText(run)).toContain('unit 1/2 Schema · 0/3 tasks')

  run = must(setTask(run, 'T1', 'done'))
  run = must(setTask(run, 'T2', 'gate-failed', 'the backfill test fails'))
  run = found(run, { path: 'src/backfill.ts', line: 12, severity: 'error', summary: 'skips null rows', task: 'T2' }, 3)
  run = found(run, { path: 'README.md', severity: 'note', summary: 'mention the flag' }, 4)
  run = spawned(run, { agentId: 'a2', task: 'T2', description: '[T2] fix', type: 'general-purpose', model: 'sonnet', startedAt: 5 })

  const text = bandText(run)
  expect(text).toContain('unit 1/2 Schema · 1/3 tasks')
  expect(text).toContain('1 gate failed')
  expect(text).toContain('1 agent running')
  expect(text).toContain('2 findings (1 error)')

  // The unit moves on once its tasks are done, and a fixed finding leaves the band.
  run = must(setTask(run, 'T2', 'done', 'backfill passes'))
  run = must(fixed(run, [1]))
  expect(bandText(run)).toContain('unit 2/2 API · 2/3 tasks')
  expect(bandText(run)).toContain('1 finding')
  expect(bandText(run)).not.toContain('error')
  expect(fixed(run, [9])).toBe('No finding #9.')
  expect(setTask(run, 'T9', 'done')).toBe('No task T9. The tasks are T1, T2, T3.')

  run = must(setTask(run, 'T3', 'done'))
  expect(isDone(run)).toBe(true)
  // One finding is still open, so the entry stays; fixed, it has nothing to say.
  expect(bandText(run)).toContain('all 3 tasks done')
  expect(statusText(ended(must(fixed(run, [2])), 'a2', 'answer', 10, 9))).toBeUndefined()
})

test('the report lists every task under its unit, then the open findings', () => {
  let run = must(setTask(planned(), 'T2', 'gate-failed', 'the backfill test fails'))
  run = found(run, { path: 'src/backfill.ts', line: 12, severity: 'error', summary: 'skips null rows', task: 'T2' }, 3)

  expect(report(run, true).split('\n')).toEqual([
    'Ledger: Queue retries',
    'Schema (0/2 done)',
    '  [todo] T1 (haiku) add the column',
    '  [gate-failed] T2 (sonnet) backfill: the backfill test fails',
    'API (0/1 done)',
    '  [todo] T3 (opus) add the retry',
    'Findings: 1 open, 0 fixed',
    '  #1 error src/backfill.ts:12 skips null rows (T2)',
  ])
  // A unit and a task say what they are for; a finished task says what was
  // done instead, and keeps saying it when its state is set again without one.
  let told = must(
    plan(
      'Queue retries',
      TASKS.map(one => (one.id === 'T1' ? { ...one, about: 'Adds the attempts column.' } : one)),
      0,
      's1',
      [
        { name: 'Schema', about: 'Gives each job a place to count its attempts.' },
        { name: 'Nowhere', about: 'A unit the plan has no task in.' },
      ],
    ),
  )
  expect(told.units).toEqual([{ name: 'Schema', about: 'Gives each job a place to count its attempts.' }])
  expect(report(told, true).split('\n').slice(1, 4)).toEqual([
    'Schema (0/2 done)',
    '  Gives each job a place to count its attempts.',
    '  [todo] T1 (haiku) add the column',
  ])
  expect(report(told, true)).toContain('      What it does: Adds the attempts column.')

  told = must(setTask(told, 'T1', 'done', 'migration runs', 'Migration 0042 adds jobs.attempts.'))
  expect(report(told, true)).toContain('      Outcome: Migration 0042 adds jobs.attempts.')
  expect(report(told, true)).not.toContain('What it does: Adds the attempts column.')
  told = must(setTask(told, 'T1', 'done'))
  expect(told.tasks[0]?.outcome).toBe('Migration 0042 adds jobs.attempts.')

  expect(tokensText(950)).toBe('950')
  expect(tokensText(12_400)).toBe('12k')
  expect(tokensText(2_300_000)).toBe('2.3M')
  expect(tokensText(999_700)).toBe('1.0M')
})

test('the agent plans, a spawn and a reviewer’s finding are recorded', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('agent.spawn', () => ({ model: 'claude-opus', agentId: 'agent-1' }))

  expect(String((await $.tool.call({ tool: 'mcp__ledger__task', id: 'T1', status: 'done' })).deny)).toContain(
    'Nothing is planned',
  )

  const made = await $.tool.call({ tool: 'mcp__ledger__plan', goal: 'Queue retries', tasks: TASKS })
  expect(made.result).toBe('Planned 3 tasks.')

  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'Add the retry to the queue.',
    description: '[T3] add the retry',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus',
    background: true,
    fork: false,
  })

  // The subagent reports a finding without naming its task: it is T3's.
  const reported = await $.tool.call({
    tool: 'mcp__ledger__finding',
    path: 'src/queue.ts',
    line: 40,
    severity: 'warning',
    summary: 'no backoff',
    agentId: 'agent-1',
  })
  expect(reported.result).toBe('Recorded as finding #1.')

  // A subagent may not change the plan or a task.
  const refused = await $.tool.call({ tool: 'mcp__ledger__task', id: 'T3', status: 'done', agentId: 'agent-1' })
  expect(String(refused.deny)).toContain('Only the main agent')

  await $.tool.call({ tool: 'mcp__ledger__task', id: 'T1', status: 'gate-failed', note: 'migration fails' })

  const read = String((await $.tool.call({ tool: 'mcp__ledger__report' })).result)
  expect(read).toContain('[running] T3 (opus) add the retry')
  expect(read).toContain('[gate-failed] T1 (haiku) add the column: migration fails')
  expect(read).toContain('Agents: 1 running, 0 finished')
  expect(read).toContain('#1 warning src/queue.ts:40 no backoff (T3)')
})

test('the status line has an entry while a run has something to say, and none when hidden or cleared', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  // What the status line last held for the ledger; undefined is an empty entry.
  const entries: (string | undefined)[] = []
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('ui.status', (_$, e) => {
    entries.push(e.text)

    return { value: undefined }
  })

  // Nothing planned: the entry is empty from the start.
  await $.tool.call({ tool: 'mcp__ledger__report' })
  expect(entries.at(-1)).toBeUndefined()

  await $.tool.call({ tool: 'mcp__ledger__plan', goal: 'Queue retries', tasks: TASKS })
  expect(entries.at(-1)).toContain('unit 1/2 Schema · 0/3 tasks')

  // A command as the person types it at the prompt.
  const typed = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as const

  expect((await $.command.run({ command: 'ledger', args: 'hide', ...typed })).text).toBe(
    'Ledger: the status entry is hidden.',
  )
  expect(entries.at(-1)).toBeUndefined()
  await $.command.run({ command: 'ledger', args: 'show', ...typed })
  expect(entries.at(-1)).toContain('unit 1/2 Schema')

  // Every task done with nothing open: the entry empties by itself.
  for (const id of ['T1', 'T2', 'T3']) {
    await $.tool.call({ tool: 'mcp__ledger__task', id, status: 'done' })
  }

  expect(entries.at(-1)).toBeUndefined()
  expect(String((await $.command.run({ command: 'ledger', args: 'print', ...typed })).text)).toContain('API (1/1 done)')

  expect((await $.command.run({ command: 'ledger', args: 'clear', ...typed })).text).toBe('Ledger: the run is cleared.')
  expect((await $.tool.call({ tool: 'mcp__ledger__report' })).result).toBe('Nothing is planned.')
})

test('the pane lists tasks, agents and findings; a finding goes to the prompt, and fixed ones show when asked', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const filled: string[] = []
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('agent.spawn', () => ({ model: 'claude-opus', agentId: 'agent-1' }))
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })

  await $.tool.call({
    tool: 'mcp__ledger__plan',
    goal: 'Queue retries',
    units: [{ name: 'Schema', about: 'Gives each job a place to count its attempts.' }],
    tasks: TASKS.map(one => (one.id === 'T3' ? { ...one, about: 'Retries a failed job with backoff.' } : one)),
  })
  await $.tool.call({
    tool: 'mcp__ledger__task',
    id: 'T2',
    status: 'done',
    outcome: 'Backfilled attempts in migration 0043.',
  })
  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'Add the retry to the queue.',
    description: '[T3] add the retry',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus',
    background: true,
    fork: false,
  })
  await $.tool.call({ tool: 'mcp__ledger__task', id: 'T1', status: 'gate-failed', note: 'migration fails' })
  await $.tool.call({ tool: 'mcp__ledger__finding', path: 'src/queue.ts', line: 40, severity: 'error', summary: 'no backoff' })
  await $.tool.call({ tool: 'mcp__ledger__finding', path: 'README.md', severity: 'note', summary: 'mention the flag' })
  await $.tool.call({ tool: 'mcp__ledger__fixed', ids: [2] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'ledger',
      surface,
      component: 'Pane',
      requestId: 'ledger',
      props: {
        title: 'Ledger',
        isFocused: true,
        bodyColumns: 80,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
      viewport: { columns: 80, rows: 40 },
    })
    const has = async (text: RegExp) => (await ui.find({ type: 'Text', text })) !== undefined

    expect(await has(/Queue retries/)).toBe(true)
    expect(await has(/1\/3 tasks/)).toBe(true)
    expect(await has(/migration fails/)).toBe(true)
    // What a unit and a task are for, and what a finished task did.
    expect(await has(/Gives each job a place to count its attempts/)).toBe(true)
    expect(await has(/Retries a failed job with backoff/)).toBe(true)
    expect(await has(/Backfilled attempts in migration 0043/)).toBe(true)
    expect(await has(/\[T3\] add the retry/)).toBe(true)
    expect(await has(/1 running · 0 finished/)).toBe(true)
    expect(await has(/1 open · 1 fixed/)).toBe(true)
    expect(await has(/no backoff/)).toBe(true)
    // The fixed finding is listed only once all are asked for.
    expect(await has(/mention the flag/)).toBe(false)

    await ui.press({ key: 'finding-1' })
    expect(filled.at(-1)).toBe('Finding #1 (error) src/queue.ts:40: no backoff\n')

    await ui.press({ key: 'all' })
    expect(await has(/mention the flag/)).toBe(true)
    await ui.press({ key: 'all' })
    await ui.unmount()
  }
})
