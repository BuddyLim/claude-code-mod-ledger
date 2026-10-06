import { expect, test } from 'claude-code/testing'

import type { LedgerRun } from '../types'
import {
  EMPTY,
  KEPT,
  bookOf,
  bookStatus,
  busyOf,
  clash,
  cleared,
  closed,
  currentOf,
  listed,
  nextFinding,
  ownerOf,
  put,
  settled,
} from '../hooks/book'
import { found, plan, setTask, spawned } from '../hooks/run'

const fresh = (goal: string): LedgerRun => {
  const run = plan(goal, [{ id: 'T1', title: 'do it' }], 0)

  if (typeof run === 'string') {
    throw new Error(run)
  }

  return run
}

const done = (run: LedgerRun): LedgerRun => {
  const after = setTask(run, 'T1', 'done')

  if (typeof after === 'string') {
    throw new Error(after)
  }

  return after
}

test('a planned run is numbered, kept and made current; the one before it stays', () => {
  const one = put(EMPTY, fresh('first'), 1)
  const two = put(one, fresh('second'), 2)

  expect(two.runs.map(run => [run.id, run.goal])).toEqual([
    [1, 'first'],
    [2, 'second'],
  ])
  expect(currentOf(two)?.goal).toBe('second')
  // A task's run is found by its id; an id a run under way has may not be
  // planned again; findings are numbered across the runs.
  expect(ownerOf(two, 'T1')?.id).toBe(2)
  expect(ownerOf(two, 'T9')).toBeUndefined()
  expect(clash(two, ['T1', 'T7'])).toContain('Task id T1 is in use')
  expect(clash(two, ['T7'])).toBeUndefined()
  expect(nextFinding(two)).toBe(1)
  expect(bookStatus(two)).toContain('second 0/1 · first 0/1')
  expect(bookStatus(EMPTY)).toBeUndefined()
  // The newest first in the list.
  expect(listed(two, false).map(run => run.id)).toEqual([2, 1])
})

test('a run is done by itself once nothing is left, and open again when work comes back', () => {
  const run = { ...fresh('g'), id: 1 }

  expect(settled(run, 5).doneAt).toBeUndefined()
  const over = settled(done(run), 5)
  expect(over.doneAt).toBe(5)
  // Unchanged while it stays done.
  expect(settled(over, 9)).toBe(over)

  // A finding reopens it; so does a subagent still running.
  const again = settled(found(over, { path: 'a.ts', severity: 'note', summary: 's' }, 6), 6)
  expect(again.doneAt).toBeUndefined()
  const busy = spawned(over, { agentId: 'a', description: 'd', type: 't', model: 'm', startedAt: 7 })
  expect(settled(busy, 7).doneAt).toBeUndefined()
  expect(busyOf({ nextId: 2, current: 1, runs: [settled(busy, 7)] })).toBe(1)
})

test('closing by hand holds whatever is open; reopening lets the run settle on its own again', () => {
  const book = put(EMPTY, fresh('g'), 1)
  const shut = closed(book, 1, true, 3)

  if (typeof shut === 'string') {
    throw new Error(shut)
  }

  expect(shut.runs[0]?.doneAt).toBe(3)
  expect(listed(shut, false)).toEqual([])
  expect(listed(shut, true).map(run => run.id)).toEqual([1])

  const open = closed(shut, 1, false, 4)
  expect(typeof open === 'string' ? open : open.runs[0]?.doneAt).toBeUndefined()
  expect(closed(book, 9, true, 3)).toBe('No run 9.')
})

test('clearing forgets a run, and past the limit the oldest done runs are dropped', () => {
  const two = put(put(EMPTY, fresh('first'), 1), fresh('second'), 2)

  expect(currentOf(cleared(two, 2))).toBeNull()
  expect(cleared(two, 1).runs.map(run => run.id)).toEqual([2])

  // One run never finished, then more done runs than are kept.
  let book = put(EMPTY, fresh('unfinished'), 0)

  for (let at = 1; at <= KEPT + 3; at++) {
    book = put(book, fresh(`run ${at}`), at)
    book = put(book, done(currentOf(book) as LedgerRun), at)
  }

  expect(book.runs.length).toBe(KEPT)
  expect(book.runs[0]?.goal).toBe('unfinished')
  expect(book.runs.at(-1)?.goal).toBe(`run ${KEPT + 3}`)
})

test('the one run a project kept before the list becomes its first run', () => {
  const old = fresh('before')

  expect(bookOf(undefined, undefined)).toBe(EMPTY)
  expect(bookOf(undefined, old).runs.map(run => [run.id, run.goal])).toEqual([[1, 'before']])
  expect(bookOf(undefined, old).current).toBe(1)
})
