import { expect, mock, test } from 'claude-code/testing'

import type { LedgerRun, LedgerSessionNote } from '../types'
import { EMPTY, STORE_BUDGET, currentOf, isTurning, noteOf, overBudget, put, trimmed } from '../hooks/book'
import { idleLanes, unmetOf } from '../hooks/pipe'
import { STALE_MS, countsOf, ended, found, isDone, isStalled, plan, setTask, spawned, statusText } from '../hooks/run'

const must = (run: LedgerRun | string): LedgerRun => {
  if (typeof run === 'string') {
    throw new Error(run)
  }

  return run
}

const FORK = [
  { id: 'S1', title: 'schema' },
  { id: 'A1', lane: 'api', title: 'route' },
  { id: 'A2', lane: 'api', title: 'tests' },
  { id: 'W1', lane: 'web', title: 'page' },
  { id: 'M1', lane: 'mobile', title: 'screen' },
  { id: 'E1', title: 'end to end', needs: ['S1'] },
]

const typed = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as const

test('a cancelled task holds a run open no more than a done one', () => {
  let run = must(plan('x', [{ id: 'T1', title: 'a' }, { id: 'T2', title: 'b' }], 0))

  run = must(setTask(must(setTask(run, 'T1', 'done')), 'T2', 'cancelled', 'not needed after all'))
  expect(isDone(run)).toBe(true)
  expect(countsOf(run)).toMatchObject({ done: 1, cancelled: 1 })
  expect(run.tasks[1]?.note).toBe('not needed after all')
  // Nothing left to say; kept, it closes by itself.
  expect(statusText(run)).toBeUndefined()
  expect(currentOf(put(EMPTY, run, 5))?.doneAt).toBe(5)
  // With a finding still open the entry says what was done and what was not.
  expect(statusText(found(run, { path: 'a.ts', severity: 'note', summary: 's' }, 1))).toContain(
    'all 1 task done, 1 cancelled · 1 finding open',
  )
  // A cancelled task is not counted among those still to do.
  const left = must(setTask(must(plan('x', [{ id: 'T1', title: 'a' }, { id: 'T2', title: 'b' }, { id: 'T3', title: 'c' }], 0)), 'T2', 'cancelled'))
  expect(statusText(left)).toMatch(/T1 a · 1 more$/)
})

test('a task marked running that nothing touches for an hour has stalled, unless a subagent is on it', () => {
  const run = currentOf(put(EMPTY, must(setTask(must(plan('x', [{ id: 'T1', title: 'a' }], 0)), 'T1', 'running')), 1000)) as LedgerRun
  const task = run.tasks[0] as LedgerRun['tasks'][number]

  expect(run.changedAt).toBe(1000)
  expect(isStalled(run, task, 1000 + STALE_MS)).toBe(false)
  expect(isStalled(run, task, 1001 + STALE_MS)).toBe(true)
  // The turning mark stops for it, and its session is no longer at work.
  const book = { ...EMPTY, nextId: 2, current: 1, runs: [run] }
  expect(isTurning(book, 2000)).toBe(true)
  expect(isTurning(book, 1001 + STALE_MS)).toBe(false)
  expect(noteOf('s1', book, 2000).busy).toBe(true)
  expect(noteOf('s1', book, 1001 + STALE_MS).busy).toBeUndefined()

  // A subagent still running for it: it is working, however long it takes.
  const busy = spawned(run, { agentId: 'a1', task: 'T1', description: '[T1]', type: 'x', model: 'm', startedAt: 1 })
  expect(isStalled(busy, task, 10 * STALE_MS)).toBe(false)
  // Its turn over, with what it said kept as its report.
  expect(ended(busy, 'a1', 'answer', 5, 9, 'Added the column; tests pass.').spawns[0]?.report).toBe(
    'Added the column; tests pass.',
  )
})

test('over the budget, room is made from the oldest sessions first, their finished runs before anything else', () => {
  const note = (id: string, at: number, size: number): LedgerSessionNote => ({ id, cwd: '/p', at, goal: '', open: 0, runs: 1, size })
  const index = [note('new', 30, 400), note('mid', 20, 400), note('old', 10, 400), note('here', 5, 400)]

  expect(overBudget(index, 'here', 2000)).toEqual([])
  // Oldest first, and never the session at work, however old its ledger.
  expect(overBudget(index, 'here', 1000)).toEqual(['old', 'mid'])
  expect(overBudget(index, 'here', 0)).toEqual(['old', 'mid', 'new'])
  expect(STORE_BUDGET).toBeLessThan(4 * 1024 * 1024)

  // A session gives up its finished runs and keeps the ones not done.
  const done = must(setTask(must(plan('finished', [{ id: 'T1', title: 'a' }], 0)), 'T1', 'done'))
  const book = put(put(EMPTY, done, 1), must(plan('open', [{ id: 'U1', title: 'b' }], 0)), 2)
  expect(trimmed(book)?.runs.map(run => run.goal)).toEqual(['open'])
  expect(trimmed(book)?.current).toBe(2)
  expect(trimmed(put(EMPTY, done, 1))).toBeNull()
  expect(noteOf('s', book, 3).size).toBe(JSON.stringify(book).length)
})

test('what a task waits on, and the lanes beside it that nothing has started', () => {
  let run = must(plan('x', FORK, 0))

  // The line before a fork, the tasks before it in its lane, and what it names.
  expect(unmetOf(run, 'S1')).toEqual([])
  expect(unmetOf(run, 'A2')).toEqual(['S1', 'A1'])
  expect(unmetOf(run, 'W1')).toEqual(['S1'])
  expect(unmetOf(run, 'E1')).toEqual(['S1', 'A1', 'A2', 'W1', 'M1'])
  expect(run.tasks.at(-1)?.needs).toEqual(['S1'])

  run = must(setTask(run, 'S1', 'done'))
  expect(unmetOf(run, 'A1')).toEqual([])
  // A cancelled task is not waited on.
  expect(unmetOf(must(setTask(run, 'A1', 'cancelled')), 'A2')).toEqual([])

  // One lane started, the other two are waiting; a lane with a subagent is not.
  run = spawned(run, { agentId: 'a1', task: 'A1', description: '[A1]', type: 'x', model: 'm', startedAt: 1 })
  expect(idleLanes(run, 'A1')).toEqual(['web', 'mobile'])
  run = spawned(run, { agentId: 'w1', task: 'W1', description: '[W1]', type: 'x', model: 'm', startedAt: 1 })
  expect(idleLanes(run, 'A1')).toEqual(['mobile'])
  expect(idleLanes(run, 'S1')).toEqual([])
})

test('the agent is told when a task starts before what it needs, and when lanes beside it are left waiting', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  const notes: string[] = []
  let agent = 0
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  // What the agent is told is what the person is shown in a toast, word for
  // word, so the toast is what is read here: the test host of this version
  // cannot answer a plugin's `$.session.append` (fixed in 2.1.293, which adds
  // `mock.session` to read the appended rows back).
  on('ui.toast', (_$, e) => {
    notes.push(e.text)

    return { value: undefined }
  })
  on('agent.spawn', () => ({ model: 'claude-sonnet', agentId: `agent-${++agent}` }))

  const spawn = (description: string) =>
    $.agent.spawn({
      tool_use_id: `toolu_${description}`,
      prompt: 'Do it.',
      description,
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus',
      background: true,
      fork: false,
    })

  await $.tool.call({ tool: 'mcp__ledger__plan', goal: 'Checkout', tasks: FORK })

  // A lane is started while the task before the fork is still to do.
  await spawn('[A1] route')
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('A1 was started, but S1 is not done')

  // The other lanes get a little while to start; left waiting, it is said, once.
  await clock.advance(25000)
  expect(notes.length).toBe(2)
  expect(notes[1]).toContain('the lanes web, mobile beside it have not been started')
  await spawn('[A1] route, again')
  await clock.advance(25000)
  expect(notes.length).toBe(2)

  // Lanes started together draw no note.
  await $.tool.call({ tool: 'mcp__ledger__plan', goal: 'Again', tasks: FORK.map(one => ({ ...one, id: `x${one.id}`, needs: [] })) })
  await $.tool.call({ tool: 'mcp__ledger__task', tasks: [{ id: 'xS1', status: 'done' }] })
  await Promise.all([spawn('[xA1] route'), spawn('[xW1] page'), spawn('[xM1] screen')])
  await clock.advance(25000)
  expect(notes.length).toBe(2)
})

test('a cancelled task and a subagent’s report show in the pane, and the report tool says cancelled', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('agent.spawn', () => ({ model: 'claude-sonnet', agentId: 'agent-1' }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.tool.call({
    tool: 'mcp__ledger__plan',
    goal: 'Two things',
    tasks: [
      { id: 'T1', title: 'do the first' },
      { id: 'T2', title: 'do the second' },
      { id: 'T3', title: 'do the third' },
    ],
  })
  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'Do it.',
    description: '[T1] do the first',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus',
    background: true,
    fork: false,
  })
  await $.turn.complete({
    reason: 'answer',
    answer: 'Added the column in migration 0051 and ran the suite: 41 passed.',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    agentId: 'agent-1',
  })
  expect((await $.tool.call({ tool: 'mcp__ledger__task', tasks: [{ id: 'T2', status: 'cancelled', note: 'dropped from scope' }] })).result).toContain(
    'T2 cancelled',
  )
  expect(String((await $.tool.call({ tool: 'mcp__ledger__report' })).result)).toContain('[cancelled] T2 do the second: dropped from scope')

  await $.command.run({ command: 'ledger', args: '', ...typed })

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

  // The task work is on shows what its subagent said as it ended.
  expect(await has(/T1 do the first/)).toBe(true)
  expect(await has(/said Added the column in migration 0051/)).toBe(true)
  // The cancelled task has its own node, and says so when picked.
  expect((await ui.findAll({ type: 'Text', in: 'strip' })).some(one => /⊘ T2 ─+○/.test(one.text))).toBe(true)
  await ui.press({ key: 'next' })
  expect(await has(/^cancelled$/)).toBe(true)
  await ui.unmount()
})

test('a pipeline begins and ends in what is beside it: the run before and the run after, or its start and its end', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))

  for (const [goal, id] of [['First', 'A'], ['Second', 'B'], ['Third', 'C']] as const) {
    await $.tool.call({ tool: 'mcp__ledger__plan', goal, tasks: [{ id: `${id}1`, title: 'a' }, { id: `${id}2`, title: 'b' }] })
  }

  await $.command.run({ command: 'ledger', args: '', ...typed })

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
  const line = async () => (await ui.findAll({ type: 'Text', in: 'strip' })).map(one => one.text).find(text => /[○●].*[▷◆]/.test(text)) ?? ''
  const click = async (mark: string) => {
    const x = (await line()).indexOf(mark)

    await ui.pointer({ type: 'down', x, y: 0, button: 'left', in: 'strip' })
    await ui.pointer({ type: 'up', x, y: 0, button: 'left', in: 'strip' })
  }
  const label = async (key: string) => (await ui.find({ type: 'Button', key }))?.props.label

  // The run planned last is open: the one before it at its start, and after
  // it nothing, so its end.
  expect(await line()).toMatch(/^◁ Second ─○ C1 ─+○ C2 ─+◆ end$/)
  // A click on the run before opens it: it has a run on either side.
  await click('◁')
  expect(await line()).toMatch(/^◁ First ─○ B1 ─+○ B2 ─+▷ Third$/)
  await click('◁')
  // The first has nothing before it: its line has a start.
  expect(await line()).toMatch(/^◆ start ─○ A1 ─+○ A2 ─+▷ Second$/)
  await click('▷')
  expect(await line()).toMatch(/B1/)

  // Drawn down, the two ends are buttons, and lead to runs drawn down too.
  await ui.press({ key: 'details' })
  expect(await label('prev-run')).toBe('previous: First')
  expect(await label('next-run')).toBe('next: Third')
  // A line joins each to the run's own: one under the run before, one over
  // the run after.
  expect((await ui.findAll({ type: 'Text' })).filter(one => one.text === '│').length).toBe(2)
  await ui.press({ key: 'next-run' })
  expect(await label('prev-run')).toBe('previous: Second')
  expect(await label('next-run')).toBeUndefined()
  expect((await ui.findAll({ type: 'Text' })).some(one => /^◆\s+end$/.test(one.text))).toBe(true)
  await ui.press({ key: 'prev-run' })
  await ui.press({ key: 'prev-run' })
  expect(await label('prev-run')).toBeUndefined()
  expect((await ui.findAll({ type: 'Text' })).some(one => /^◆\s+start$/.test(one.text))).toBe(true)
  await ui.press({ key: 'details' })

  // A run that is done is no longer beside the others: the line closes up.
  await $.tool.call({ tool: 'mcp__ledger__task', tasks: [{ id: 'B1', status: 'done' }, { id: 'B2', status: 'done' }] })
  expect(await line()).toMatch(/^◆ start ─○ A1 ─+○ A2 ─+▷ Third$/)

  // With no room for the words, the marks stand alone before the pipeline goes.
  await ui.unmount()

  const small = await $.ui.mount({
    plugin: 'ledger',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'ledger',
    props: {
      title: 'Ledger',
      isFocused: true,
      bodyColumns: 20,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
    viewport: { columns: 20, rows: 40 },
  })

  expect((await small.findAll({ type: 'Text', in: 'strip' })).some(one => /^◆─○ A1 ─+○ A2 ─+▷$/.test(one.text))).toBe(true)
  await small.unmount()
})
