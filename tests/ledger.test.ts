import { expect, mock, test } from 'claude-code/testing'

import type { LedgerRun } from '../types'
import { GAP_MOST, LINK_MOST, gapFor, railsWide, rowsOf, stagesOf, stripOf, stripText, wrapped } from '../hooks/pipe'
import {
  STATUS_MOST,
  countsOf,
  ended,
  fixed,
  focusOf,
  found,
  isDone,
  leftOpen,
  orphaned,
  plan,
  report,
  resumed,
  setTask,
  spawned,
  statusText,
  tail,
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

test('the status line names the task work is on and counts the rest, however long the plan', () => {
  let run = planned()
  // Nothing started: the next task to do, and the two after it.
  expect(bandText(run)).toMatch(/T1 add the column · 2 more$/)

  run = must(setTask(run, 'T1', 'done'))
  run = must(setTask(run, 'T2', 'gate-failed', 'the backfill test fails'))
  // A failed gate is what work is on until something else runs.
  expect(bandText(run)).toMatch(/T2 backfill · 1 more$/)

  run = found(run, { path: 'src/backfill.ts', line: 12, severity: 'error', summary: 'skips null rows', task: 'T2' }, 3)
  run = found(run, { path: 'README.md', severity: 'note', summary: 'mention the flag' }, 4)
  run = spawned(run, { agentId: 'a3', task: 'T3', description: '[T3] retry', type: 'general-purpose', model: 'sonnet', startedAt: 5 })
  // The task a subagent is running for comes before one that waits.
  expect(focusOf(run)?.id).toBe('T3')
  expect(bandText(run)).toMatch(/T3 add the retry · 1 more$/)
  // Findings, agents and lanes add nothing to it: one task and one count.
  expect(bandText(run).split(' · ').length).toBe(2)

  run = must(setTask(run, 'T2', 'done', 'backfill passes'))
  run = must(fixed(run, [1]))
  expect(bandText(run)).toMatch(/T3 add the retry$/)
  expect(fixed(run, [9])).toBe('No finding #9.')
  expect(setTask(run, 'T9', 'done')).toBe('No task T9. The tasks are T1, T2, T3.')

  // A long title is cut, and a plan of many tasks in lanes is still one entry.
  const wide = must(
    plan(
      'x',
      Array.from({ length: 24 }, (_, at) => ({
        id: `L${at}`,
        lane: `lane ${at % 6}`,
        title: 'a title that goes on for a good deal longer than the status line has room for',
      })),
      0,
    ),
  )
  expect(bandText(wide)).toContain('· 23 more')
  expect(bandText(wide).length).toBeLessThan(STATUS_MOST + 24)

  run = must(setTask(run, 'T3', 'done'))
  expect(isDone(run)).toBe(true)
  // One finding is still open, so the entry stays; fixed, it has nothing to say.
  expect(bandText(run)).toContain('all 3 tasks done · 1 finding open')
  expect(statusText(ended(must(fixed(run, [2])), 'a3', 'answer', 10, 9))).toBeUndefined()
})

test('a write that leaves findings open says which, so they are closed as the work goes', () => {
  let run = planned()
  run = found(run, { path: 'src/a.ts', severity: 'error', summary: 'wrong', task: 'T1' }, 1)
  run = found(run, { path: 'src/b.ts', severity: 'note', summary: 'loose' }, 2)
  run = must(setTask(run, 'T1', 'done'))

  // The finding of the task marked done is named; one of no task is not yet.
  expect(leftOpen(run, ['T1'])).toContain('1 finding still open on the tasks marked done (#1)')
  expect(leftOpen(must(fixed(run, [1])), ['T1'])).toBe('')

  run = must(setTask(must(setTask(run, 'T2', 'done')), 'T3', 'done'))
  // Every task done: all that is open is named, whichever task it is on.
  expect(leftOpen(run, ['T3'])).toContain('Every task is done, but 2 findings still open (#1, #2)')
  expect(leftOpen(must(fixed(run, [1, 2])), ['T3'])).toBe('')
})

test('a run is laid out as a pipeline: stages in order, lanes forking and joining', () => {
  const run = must(
    plan(
      'Checkout',
      [
        { id: 'S1', title: 'schema' },
        { id: 'A1', lane: 'API', title: 'route' },
        { id: 'A2', lane: 'API', title: 'tests' },
        { id: 'W1', lane: 'Web', title: 'page' },
        { id: 'M1', lane: 'Mobile', title: 'screen' },
        { id: 'E1', title: 'end to end' },
      ],
      0,
    ),
  )

  expect(stagesOf(run).map(one => (one.kind === 'one' ? one.task.id : one.lanes.map(lane => lane.tasks.length)))).toEqual([
    'S1',
    [2, 1, 1],
    'E1',
  ])

  // Down the pane: a node a task, the lanes as rails that fork and join.
  expect(
    rowsOf(run).map(row =>
      row.kind === 'task'
        ? `${row.lead}o${row.trail} ${row.task.id}`
        : row.kind === 'lane'
          ? `${row.lead}v${row.trail} ${row.name}`
          : row.rail,
    ),
  ).toEqual([
    'o S1',
    '├─┬─╮',
    'v │ │ API',
    'o │ │ A1',
    'o │ │ A2',
    '│ v │ Web',
    '│ o │ W1',
    '│ │ v Mobile',
    '│ │ o M1',
    '├─┴─╯',
    'o E1',
  ])
  // A wide pane draws the rails further apart; a narrow one keeps them close
  // so the words beside them have at least two thirds of it.
  expect(gapFor(run, 120)).toBe(GAP_MOST)
  expect(gapFor(run, 30)).toBe(3)
  expect(gapFor(run, 12)).toBe(1)
  expect(railsWide(run, 3)).toBe(9)
  expect(rowsOf(run, 3).flatMap(row => (row.kind === 'link' ? [row.rail] : []))).toEqual(['├───┬───╮', '├───┴───╯'])
  expect(rowsOf(run, 3).flatMap(row => (row.kind === 'task' ? [`${row.lead}o${row.trail}|${row.task.id}`] : []))).toEqual([
    // A task in the line stands beside its own node, not out past the fork.
    'o|S1',
    'o   │   │|A1',
    'o   │   │|A2',
    '│   o   │|W1',
    '│   │   o|M1',
    'o|E1',
  ])
  // A long text is broken at its spaces to fit beside the rails.
  expect(wrapped('ExpensesPage: typed NL handling + Add modal toggle', 20)).toEqual([
    'ExpensesPage: typed',
    'NL handling + Add',
    'modal toggle',
  ])
  expect(wrapped('averyveryverylongword short', 10)).toEqual(['averyveryv', 'erylongwor', 'd short'])
  expect(wrapped('', 10)).toEqual([''])

  // With something drawn after the last task the line runs on past it, and a
  // fork that ends the run joins the line again.
  expect(stripOf(run, 13, true)?.map(line => stripText(line).trimEnd())).toEqual(['○─┬─○─○─┬─○─', '  ├─○───┤', '  ╰─○───╯'])
  const forked = must(plan('x', [{ id: 'A', lane: 'a', title: 'a' }, { id: 'B', lane: 'b', title: 'b' }], 0))
  expect(stripOf(forked, 5)?.map(line => stripText(line).trimEnd())).toEqual(['┬─○─╮', '╰─○─╯'])
  expect(stripOf(forked, 6, true)?.map(line => stripText(line).trimEnd())).toEqual(['┬─○─┬─', '╰─○─╯'])
  // Drawn down between what is before and after it, a fork at either end of
  // the run opens from the line and closes back onto it.
  expect(rowsOf(forked, 1, true).flatMap(row => (row.kind === 'link' ? [row.rail] : []))).toEqual(['├─╮', '├─╯'])
  expect(rowsOf(forked, 1).flatMap(row => (row.kind === 'link' ? [row.rail] : []))).toEqual(['┌─╮', '└─╯'])
  // Across the top, as a CI run is drawn: the line splits, and joins again.
  const strip = stripOf(must(setTask(run, "S1", "done")), 11)?.map(line => stripText(line).trimEnd())
  expect(strip).toEqual(['●─┬─○─○─┬─○', '  ├─○───┤', '  ╰─○───╯'])
  // Too narrow for it, the strip is left out and the rows stand alone.
  expect(stripOf(run, 10)).toBeUndefined()
  // Given more room, the lines between nodes grow to take it, up to a limit.
  expect(stripOf(run, 26)?.map(line => stripText(line).trimEnd())).toEqual([
    "○────┬────○────○────┬────○",
    "     ├────○─────────┤",
    "     ╰────○─────────╯",
  ])
  expect(stripText(stripOf(run, 500)?.[0] ?? []).length).toBe(6 + 5 * LINK_MOST)
  // A run with units names each where it starts; one with none has no such row.
  expect(rowsOf(planned()).filter(row => row.kind === 'unit').map(row => row.kind === 'unit' && row.name)).toEqual([
    'Schema',
    'API',
  ])
  expect(rowsOf(run).some(row => row.kind === 'unit')).toBe(false)
  expect(tail('src/deep/down/the/tree/file.ts:12', 14)).toBe('…ee/file.ts:12')
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
  expect(entries.at(-1)).toContain('T1 add the column · 2 more')

  // A command as the person types it at the prompt.
  const typed = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as const

  expect((await $.command.run({ command: 'ledger', args: 'hide', ...typed })).text).toBe(
    'Ledger: the status entry is hidden.',
  )
  expect(entries.at(-1)).toBeUndefined()
  await $.command.run({ command: 'ledger', args: 'show', ...typed })
  expect(entries.at(-1)).toContain('T1 add the column')

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

    // The list: one run, not done.
    expect(await has(/1 open · 0 done/)).toBe(true)
    expect(await has(/1\/3 · .* 1 · .* 1/)).toBe(true)
    await ui.press({ key: 'run-1' })

    // The run, in few words: a line a task, the failed gate's note beside it,
    // the running subagent's model beside its task, each open finding a line.
    expect(await has(/Queue retries/)).toBe(true)
    expect(await has(/1\/3/)).toBe(true)
    expect(await has(/migration fails/)).toBe(true)
    expect(await has(/claude-opus/)).toBe(true)
    expect(await has(/1 open/)).toBe(true)
    expect(await has(/no backoff/)).toBe(true)
    // What each part is for, what was done and what is fixed wait for details.
    expect(await has(/Gives each job a place to count its attempts/)).toBe(false)
    expect(await has(/Backfilled attempts in migration 0043/)).toBe(false)
    expect(await has(/mention the flag/)).toBe(false)

    await ui.press({ key: 'finding-1' })
    expect(filled.at(-1)).toBe('Finding #1 (error) src/queue.ts:40: no backoff\n')

    await ui.press({ key: 'details' })
    expect(await has(/Gives each job a place to count its attempts/)).toBe(true)
    expect(await has(/Retries a failed job with backoff/)).toBe(true)
    expect(await has(/Backfilled attempts in migration 0043/)).toBe(true)
    expect(await has(/mention the flag/)).toBe(true)
    await ui.press({ key: 'details' })

    // Back on the list, the run is closed by hand, shown among the done ones,
    // and opened again.
    await ui.press({ key: 'back' })
    await ui.press({ key: 'done' })
    expect(await has(/0 open · 1 done/)).toBe(true)
    expect(await has(/Every run is done/)).toBe(true)
    await ui.press({ key: 'all' })
    await ui.press({ key: 'done' })
    expect(await has(/1 open · 0 done/)).toBe(true)
    await ui.press({ key: 'all' })
    await ui.unmount()
  }
})

test('several tasks and several findings each go in one call, and one bad entry refuses the call', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))

  await $.tool.call({ tool: 'mcp__ledger__plan', goal: 'Queue retries', tasks: TASKS })

  const updated = await $.tool.call({
    tool: 'mcp__ledger__task',
    tasks: [
      { id: 'T1', status: 'done', outcome: 'Migration 0042 adds jobs.attempts.' },
      { id: 'T2', status: 'gate-failed', note: 'the   backfill\ntest fails' },
    ],
  })
  expect(updated.result).toBe('T1 done, T2 gate-failed')

  // One unknown id: nothing of the call is kept.
  const refused = await $.tool.call({
    tool: 'mcp__ledger__task',
    tasks: [
      { id: 'T3', status: 'done' },
      { id: 'T9', status: 'done' },
    ],
  })
  expect(String(refused.deny)).toContain('No task T9')

  const found = await $.tool.call({
    tool: 'mcp__ledger__finding',
    findings: [
      { path: 'src/a.ts', line: 3, severity: 'error', summary: 'drops jobs', task: 'T2' },
      { path: 'src/b.ts', severity: 'note', summary: 'x'.repeat(400) },
    ],
  })
  expect(found.result).toBe('Recorded as findings #1 to #2.')
  expect(String((await $.tool.call({ tool: 'mcp__ledger__finding', findings: [{ path: 'a.ts' }] })).deny)).toContain(
    'Each finding needs',
  )

  const read = String((await $.tool.call({ tool: 'mcp__ledger__report' })).result)
  expect(read).toContain('[done] T1 (haiku) add the column')
  expect(read).toContain('      Outcome: Migration 0042 adds jobs.attempts.')
  // A note is kept as one line.
  expect(read).toContain('[gate-failed] T2 (sonnet) backfill: the backfill test fails')
  expect(read).toContain('[todo] T3 (opus) add the retry')
  expect(read).toContain('#1 error src/a.ts:3 drops jobs (T2)')
  // What is written is cut to a line's length.
  expect(read).not.toContain('x'.repeat(201))
})

test('each write finds its own run; a run closes by itself, and clearing asks first', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const entries: (string | undefined)[] = []
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('agent.spawn', () => ({ model: 'claude-haiku', agentId: 'agent-a' }))
  on('ui.status', (_$, e) => {
    entries.push(e.text)

    return { value: undefined }
  })

  await $.tool.call({ tool: 'mcp__ledger__plan', goal: 'First feature', tasks: [{ id: 'A1', title: 'a' }] })
  await $.tool.call({ tool: 'mcp__ledger__plan', goal: 'Second feature', tasks: [{ id: 'B1', title: 'b' }] })

  // An id a run under way already uses is refused: it is how writes are routed.
  const taken = await $.tool.call({ tool: 'mcp__ledger__plan', goal: 'Third', tasks: [{ id: 'A1', title: 'again' }] })
  expect(String(taken.deny)).toContain('Task id A1 is in use by a run still under way')

  // Both runs are under way: the report and the status line cover both.
  const both = String((await $.tool.call({ tool: 'mcp__ledger__report' })).result)
  expect(both).toContain('Ledger: Second feature')
  expect(both).toContain('Ledger: First feature')
  // The newest run's next task, and the one task of the other run still to do.
  expect(entries.at(-1)).toContain('B1 b · 1 more')

  // A spawn, a finding and a task update for the older run land in it, with no
  // run picked by hand.
  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'Do a.',
    description: '[A1] do a',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus',
    background: true,
    fork: false,
  })
  await $.tool.call({
    tool: 'mcp__ledger__finding',
    findings: [{ path: 'a.ts', severity: 'note', summary: 'from the first run' }],
    agentId: 'agent-a',
  })
  await $.tool.call({
    tool: 'mcp__ledger__finding',
    findings: [{ path: 'b.ts', severity: 'note', summary: 'from the second run', task: 'B1' }],
  })

  const routed = String((await $.tool.call({ tool: 'mcp__ledger__report' })).result)
  const [second = '', first = ''] = routed.split('\n\n')
  expect(first).toContain('[running] A1 a')
  // Findings are numbered across the runs, so a number names one.
  expect(first).toContain('#1 note a.ts from the first run (A1)')
  expect(second).toContain('#2 note b.ts from the second run (B1)')
  expect((await $.tool.call({ tool: 'mcp__ledger__fixed', ids: [1, 2] })).result).toBe('Marked 2 fixed.')

  const ui = await $.ui.mount({
    plugin: 'ledger',
    surface: 'terminal',
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
  const row = async (key: string) => (await ui.find({ key })) !== undefined

  expect(await has(/2 open · 0 done/)).toBe(true)
  expect(await row('run-1')).toBe(true)
  expect(await row('run-2')).toBe(true)
  // There is no run to pick: nothing switches which run is written to.
  expect(await row('use')).toBe(false)

  // Its one task done with nothing open: the second run is done by itself.
  expect((await $.tool.call({ tool: 'mcp__ledger__task', tasks: [{ id: 'B1', status: 'done' }] })).result).toBe(
    'B1 done',
  )
  expect(await has(/1 open · 1 done/)).toBe(true)
  expect(await row('run-2')).toBe(false)

  // Clearing the first asks, and no keeps it.
  await ui.press({ key: 'clear' })
  expect(await has(/Clear run 1 for good\?/)).toBe(true)
  await ui.press({ key: 'no' })
  expect(await row('run-1')).toBe(true)
  await ui.press({ key: 'clear' })
  await ui.press({ key: 'yes' })
  expect(await row('run-1')).toBe(false)
  expect(await has(/0 open · 1 done/)).toBe(true)
})

test('a plan in lanes shows each lane’s progress, in the status line, the report and the pane', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const entries: (string | undefined)[] = []
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('agent.spawn', () => ({ model: 'claude-sonnet', agentId: 'agent-w' }))
  on('ui.status', (_$, e) => {
    entries.push(e.text)

    return { value: undefined }
  })

  await $.tool.call({
    tool: 'mcp__ledger__plan',
    goal: 'Checkout redesign',
    tasks: [
      { id: 'A1', lane: 'API', unit: 'Schema', title: 'add the table' },
      { id: 'A2', lane: 'API', unit: 'Endpoints', title: 'add the route' },
      { id: 'W1', lane: 'Web', unit: 'Cart page', title: 'draw the cart' },
      { id: 'M1', lane: 'Mobile', unit: 'Cart screen', title: 'draw the screen' },
    ],
  })
  await $.tool.call({
    tool: 'mcp__ledger__task',
    tasks: [
      { id: 'A1', status: 'done' },
      { id: 'M1', status: 'gate-failed', note: 'tests fail' },
    ],
  })
  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'Draw the cart.',
    description: '[W1] draw the cart',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus',
    background: true,
    fork: false,
  })

  // The status line: the task a subagent is on, and how many more are not done.
  expect(entries.at(-1)).toMatch(/W1 draw the cart · 2 more$/)

  const read = String((await $.tool.call({ tool: 'mcp__ledger__report' })).result)
  expect(read).toContain('Lane API (1/2 done)')
  expect(read).toContain('Lane Mobile (0/1 done)')

  const ui = await $.ui.mount({
    plugin: 'ledger',
    surface: 'terminal',
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

  await ui.press({ key: 'run-1' })
  // The overview: the pipeline across, and words only for what is running or
  // has failed. No lane or unit is named, and no task that waits or is done.
  // The pipeline is a region of its own, which takes the pointer.
  const texts = (await ui.findAll({ type: 'Text', in: 'strip' })).map(one => one.text)
  // Each node's id is written on the line after it.
  // The fork that ends the run joins the line again, which runs on to its
  // end: nothing comes after this run.
  // Nothing was planned before it either: the line has a start.
  expect(texts.some(text => /^◆ start ─┬─+● A1 ─+○ A2 ─+┬─+◆ end$/.test(text))).toBe(true)
  expect(texts.some(text => /^ +╰─+✗ M1 ─+╯/.test(text))).toBe(true)
  // The task work is on is shown in full: where it sits and what it cost.
  expect(await has(/^Current task$/)).toBe(true)
  expect(await has(/W1 draw the cart/)).toBe(true)
  expect(await has(/running · lane Web · Cart page/)).toBe(true)
  expect(await has(/claude-sonnet · 1 agent/)).toBe(true)
  // The failed gate keeps a line; a task that waits or is done has none.
  expect(await has(/tests fail/)).toBe(true)
  expect(await has(/^API/)).toBe(false)
  expect(await has(/add the route/)).toBe(false)

  // The keys walk the nodes: the next task is shown in its place, and the
  // one work is on comes back when asked.
  await ui.press({ key: 'next' })
  expect(await has(/^Task$/)).toBe(true)
  expect(await has(/M1 draw the screen/)).toBe(true)
  expect(await has(/gate failed: tests fail/)).toBe(true)
  await ui.press({ key: 'prev' })
  await ui.press({ key: 'prev' })
  expect(await has(/A2 add the route/)).toBe(true)
  expect(await has(/to do · lane API · Endpoints/)).toBe(true)
  await ui.press({ key: 'current' })
  expect(await has(/^Current task$/)).toBe(true)
  expect(await has(/add the route/)).toBe(false)

  // A click on a node picks its task, as the keys do: on the node itself,
  // or on the id beside it.
  // The region's lines, each found by how it begins (its pieces are texts too).
  const drawn = (await ui.findAll({ type: 'Text', in: 'strip' })).map(one => one.text)
  const top = drawn.find(text => /^◆ start ─┬─/.test(text)) ?? ''
  const last = drawn.find(text => /^ +╰─/.test(text)) ?? ''
  const click = async (x: number, y: number) => {
    await ui.pointer({ type: 'down', x, y, button: 'left', in: 'strip' })
    await ui.pointer({ type: 'up', x, y, button: 'left', in: 'strip' })
  }

  // On the id beside the node, in the first lane.
  await click(top.indexOf('A2'), 0)
  expect(await has(/to do · lane API · Endpoints/)).toBe(true)
  // On the node itself, two lanes down: the cell before " M1 ".
  await click(last.indexOf(' M1 ') - 1, 2)
  expect(await has(/gate failed: tests fail/)).toBe(true)
  expect(await has(/to do · lane API · Endpoints/)).toBe(false)
  // A click on a line between nodes picks nothing: the same task is shown.
  await click(top.indexOf('┬') + 1, 0)
  expect(await has(/gate failed: tests fail/)).toBe(true)
  await ui.press({ key: 'current' })

  // Details: the pipeline down, every lane, unit and task on a line.
  await ui.press({ key: 'details' })
  expect(await has(/add the route/)).toBe(true)
  expect(await has(/^API/)).toBe(true)
  expect(await has(/^Web/)).toBe(true)
  expect(await has(/^Mobile/)).toBe(true)
  expect(await has(/Cart page/)).toBe(true)
  expect(await has(/tests fail/)).toBe(true)
})
