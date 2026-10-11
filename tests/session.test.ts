import { expect, mock, test } from 'claude-code/testing'

import type { LedgerRun } from '../types'
import { EMPTY, SESSIONS_KEPT, noteOf, noted, put, sessionsListed, splitOld, unnamedSession } from '../hooks/book'
import { plan } from '../hooks/run'

const fresh = (goal: string, sessionId?: string): LedgerRun => {
  const run = plan(goal, [{ id: 'T1', title: 'do it' }], 0, sessionId)

  if (typeof run === 'string') {
    throw new Error(run)
  }

  return run
}

// A command as the person types it at the prompt.
const typed = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as const

const pane = (columns: number) =>
  ({
    plugin: 'ledger',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'ledger',
    props: {
      title: 'Ledger',
      isFocused: true,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
    viewport: { columns, rows: 40 },
  }) as const

test('the list of sessions keeps a line a session, the latest first, and drops the oldest past the limit', () => {
  const book = { ...put(EMPTY, fresh('first'), 1), cwd: '/project' }
  let index = noted([], noteOf('s1', book, 5)).index

  expect(index).toEqual([
    { id: 's1', cwd: '/project', at: 5, goal: 'first', open: 1, runs: 1, size: JSON.stringify(book).length },
  ])
  index = noted(index, noteOf('s2', { ...book, cwd: '/other' }, 9)).index
  expect(index.map(one => one.id)).toEqual(['s2', 's1'])
  // This folder's sessions come before another's, whichever changed last.
  expect(sessionsListed(index, '/project').map(one => one.id)).toEqual(['s1', 's2'])
  // A session whose book has no run left leaves the list.
  expect(noted(index, noteOf('s2', EMPTY, 10)).index.map(one => one.id)).toEqual(['s1'])

  let many = index
  let dropped: string[] = []

  for (let at = 10; at < 10 + SESSIONS_KEPT; at++) {
    const kept = noted(many, noteOf(`n${at}`, book, at))
    many = kept.index
    dropped = [...dropped, ...kept.dropped]
  }

  expect(many.length).toBe(SESSIONS_KEPT)
  expect(dropped).toEqual(['s1', 's2'])
})

test('a book kept for a folder is filed by the session that planned each run', () => {
  const old = put(put(put(EMPTY, fresh('a', 's1'), 1), fresh('b', 's2'), 2), fresh('c'), 3)
  const books = splitOld(old, '/project')

  expect([...books.keys()]).toEqual(['s1', 's2', unnamedSession('/project')])
  expect(books.get('s1')?.runs.map(run => run.goal)).toEqual(['a'])
  expect(books.get('s1')?.cwd).toBe('/project')
  // The run that was current stays so in its session, and each other session
  // is on the run it planned last; a later run of any session gets a number
  // none of them has used.
  expect(books.get(unnamedSession('/project'))?.current).toBe(3)
  expect(books.get('s1')?.current).toBe(1)
  expect(books.get('s2')?.nextId).toBe(4)
})

test('each session keeps its own ledger: two in one folder never mix, and a session resumed finds its own', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  let session = 's1'
  const entries: (string | undefined)[] = []
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: session }))
  on('agent.spawn', () => ({ model: 'claude-sonnet', agentId: 'agent-1' }))
  on('ui.status', (_$, e) => {
    entries.push(e.text)

    return { value: undefined }
  })

  await $.tool.call({ tool: 'mcp__ledger__plan', goal: 'First session', tasks: [{ id: 'T1', title: 'one' }] })
  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'Do one.',
    description: '[T1] one',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus',
    background: true,
    fork: false,
  })
  expect(String((await $.tool.call({ tool: 'mcp__ledger__report' })).result)).toContain('Agents: 1 running')

  // Another session in the same folder: it has planned nothing, and may use
  // the ids the first one has, for they are not its tasks.
  session = 's2'
  expect((await $.tool.call({ tool: 'mcp__ledger__report' })).result).toBe('Nothing is planned.')
  expect(String((await $.command.run({ command: 'ledger', args: 'print', ...typed })).text)).toContain('nothing is planned')
  // The status line follows the session the process is in.
  expect(entries.at(-1)).toBeUndefined()
  expect(
    (await $.tool.call({ tool: 'mcp__ledger__plan', goal: 'Second session', tasks: [{ id: 'T1', title: 'other' }] })).result,
  ).toBe('Planned 1 task.')
  await $.tool.call({ tool: 'mcp__ledger__task', id: 'T1', status: 'done' })

  // The first session, resumed: its run as it left it, the second's untouched
  // by it. The subagent it showed running ended with the process that ran it.
  session = 's1'
  const back = String((await $.command.run({ command: 'ledger', args: 'print', ...typed })).text)
  expect(back).toContain('First session')
  expect(back).not.toContain('Second session')
  expect(back).toContain('Agents: 0 running, 1 finished')
  expect(entries.at(-1)).toContain('T1 one')

  // What it writes from here goes to its own book again.
  await $.tool.call({ tool: 'mcp__ledger__task', id: 'T1', status: 'gate-failed', note: 'still red' })
  session = 's2'
  expect(String((await $.command.run({ command: 'ledger', args: 'print', ...typed })).text)).toContain('Second session')
  expect(String((await $.command.run({ command: 'ledger', args: 'print', ...typed })).text)).not.toContain('still red')
})

test('the pane shows the ledgers of other sessions and folders, read only, and comes back to this one', async ($, on) => {
  const elsewhere = { ...put(EMPTY, fresh('Ship the importer'), 1), cwd: '/elsewhere/importer' }
  mock.store(on, {
    'book:far': elsewhere,
    sessions: [noteOf('far', elsewhere, 1)],
    'filed-by-session': true,
  })
  mock.clock(on)
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))

  // Nothing planned here: the pane opens on the sessions that have a ledger.
  expect(String((await $.command.run({ command: 'ledger', args: '', ...typed })).text)).toContain('other sessions')

  const ui = await $.ui.mount(pane(80))
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text })) !== undefined

  expect(await has(/Ledger sessions/)).toBe(true)
  expect(await has(/importer · 0\/1/)).toBe(true)
  await ui.press({ key: 'session-0' })

  // That session's runs, marked as another's: nothing here closes or clears them.
  expect(await has(/read only/)).toBe(true)
  expect(await has(/1 open · 0 done/)).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'done' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'clear' })).toBeUndefined()
  await ui.press({ key: 'run-1' })
  expect(await has(/Ship the importer/)).toBe(true)
  expect(await has(/do it/)).toBe(true)

  // A plan made here goes to this session's book, not the one being shown.
  await $.tool.call({ tool: 'mcp__ledger__plan', goal: 'Here', tasks: [{ id: 'H1', title: 'mine' }] })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'home' })
  expect(await has(/read only/)).toBe(false)
  await ui.press({ key: 'sessions' })
  // Both sessions are listed now: this folder's first.
  expect(await ui.find({ type: 'Button', key: 'session-1' })).toBeDefined()
  await ui.unmount()

  expect(String((await $.command.run({ command: 'ledger', args: 'print', ...typed })).text)).toContain('Here')
})

test('a narrow pane keeps every row inside it: a finding’s place is cut from its start, its summary goes under it', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))

  await $.tool.call({
    tool: 'mcp__ledger__plan',
    goal: 'A goal long enough that a narrow pane has to cut it somewhere',
    tasks: [
      { id: 'T1', title: 'first' },
      { id: 'A1', lane: 'API', title: 'route' },
      { id: 'W1', lane: 'Web', title: 'page' },
    ],
  })
  await $.tool.call({
    tool: 'mcp__ledger__finding',
    path: 'packages/server/src/queue/workers/retry-policy.ts',
    line: 128,
    severity: 'error',
    summary: 'the retry never backs off once the queue has been drained',
  })

  for (const columns of [44, 120]) {
    await $.command.run({ command: 'ledger', args: '', ...typed })

    const ui = await $.ui.mount(pane(columns))
    const body = columns - 4
    const texts = await ui.findAll({ type: 'Text' })
    const place = await ui.find({ type: 'Button', key: 'finding-1' })

    // The rule is the width of what is drawn, and no label is wider than it.
    expect(texts.some(one => one.text === '─'.repeat(body))).toBe(true)
    expect(String(place?.props.label).length).toBeLessThanOrEqual(body)
    expect(String(place?.props.label).endsWith('retry-policy.ts:128')).toBe(true)
    expect(String(place?.props.label).startsWith('…')).toBe(columns === 44)
    // A rule parts the pipeline from the findings: one under the heading, one
    // over the findings, one over the keys.
    expect(texts.filter(one => one.text === '─'.repeat(body)).length).toBe(3)
    // The pipeline is drawn across in the overview, and down in details, with
    // the fork and the join either way.
    expect((await ui.findAll({ type: 'Text', in: 'strip' })).some(one => /^◆ start ─○[ A-Z0-9─]+┬─+○[ A-Z0-9─]+┬─+◆ end$/.test(one.text))).toBe(true)
    expect(texts.some(one => /^├─+╮$/.test(one.text))).toBe(false)
    await ui.press({ key: 'details' })
    const down = await ui.findAll({ type: 'Text' })
    // Two lanes leave room for the widest gap in either pane.
    expect(down.some(one => /^├─+╮$/.test(one.text))).toBe(true)
    // The line runs on past the fork to its end.
    expect(down.find(one => /^├─+╯$/.test(one.text))?.text.length).toBe(7)
    expect(down.some(one => /^◆\s+start$/.test(one.text))).toBe(true)
    expect(down.some(one => /^◆\s+end$/.test(one.text))).toBe(true)
    await ui.press({ key: 'details' })
    await ui.unmount()
  }
})

test('runs kept for a folder before are filed by session at the start, once, and nothing stored is lost', async ($, on) => {
  const old = put(put(EMPTY, fresh('Mine before', 's1'), 1), fresh('Another session’s', 's0'), 2)
  // The store, held here so the test sees what is written to it.
  const held = new Map<string, unknown>([['runs:/project', old]])
  let writes: string[] = []
  mock.clock(on)
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('store.get', (_$, e) => ({ value: held.get(e.key) }))
  on('store.keys', () => ({ value: [...held.keys()] }))
  on('store.set', (_$, e) => {
    held.set(e.key, e.value)
    writes.push(e.key)

    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    held.delete(e.key)

    return { value: undefined }
  })

  await $.session.start({ cwd: '/project', surface: null, isInteractive: false })

  // This session finds the run it planned, and not the other session's.
  const mine = String((await $.command.run({ command: 'ledger', args: 'print', ...typed })).text)
  expect(mine).toContain('Mine before')
  expect(mine).not.toContain('Another session’s')
  // The other's is filed under its own session, both are listed, and what
  // was stored before is still there.
  expect([...held.keys()].sort()).toEqual(['book:s0', 'book:s1', 'filed-by-session', 'runs:/project', 'sessions'])
  expect((held.get('sessions') as { id: string }[]).map(one => one.id).sort()).toEqual(['s0', 's1'])

  // A second start files nothing again.
  writes = []
  await $.session.start({ cwd: '/project', surface: null, isInteractive: false })
  expect(writes).toEqual([])
})
