// The project's runs, kept together: every run planned here, the newest last,
// and which one is current. Free of the engine, as run.ts is.

import type { LedgerRun } from '../types'
import { ICON } from './kit/icons'
import { cut } from './kit/layout'
import { countsOf, isDone, isRun, statusText, tokensText } from './run'

// `current` is the id of the run the tools record against (0 for none): the
// one planned last, or the one the user picked.
export type Book = { nextId: number; current: number; runs: LedgerRun[] }

export const EMPTY: Book = { nextId: 1, current: 0, runs: [] }

// How many runs a project keeps. Past it the oldest done ones are dropped; a
// run not done is never dropped.
export const KEPT = 40

export const isBook = (value: unknown): value is Book =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Book).nextId === 'number' &&
  Array.isArray((value as Book).runs) &&
  (value as Book).runs.every(isRun)

// What the store held before runs were kept together: one run, or nothing.
export const bookOf = (stored: unknown, old: unknown): Book =>
  isBook(stored) ? stored : isRun(old) ? { nextId: 2, current: 1, runs: [{ ...old, id: 1 }] } : EMPTY

export const currentOf = (book: Book): LedgerRun | null =>
  book.runs.find(one => one.id === book.current) ?? null

// Whether a run has nothing left: every task done, no agent running and no
// finding open.
export const isSettled = (run: LedgerRun): boolean =>
  isDone(run) &&
  run.spawns.every(one => one.endedAt !== undefined) &&
  run.findings.every(one => one.status === 'fixed')

// A run with its `doneAt` as it should stand: set when it settles or the user
// closed it, kept while it stays so, and gone when work reopens a run that
// had only settled.
export const settled = (run: LedgerRun, now: number): LedgerRun => {
  const isOver = run.isClosed === true || isSettled(run)

  if (isOver === (run.doneAt !== undefined)) {
    return run
  }

  if (isOver) {
    return { ...run, doneAt: now }
  }

  const { doneAt: _d, ...rest } = run

  return rest
}

const pruned = (book: Book): Book => {
  const extra = book.runs.length - KEPT
  const drop = new Set(
    book.runs
      .filter(one => one.doneAt !== undefined && one.id !== book.current)
      .slice(0, Math.max(0, extra))
      .map(one => one.id),
  )

  return drop.size === 0 ? book : { ...book, runs: book.runs.filter(one => !drop.has(one.id)) }
}

// Keeps a run: a new one (id 0) is numbered, added and made current; one the
// book has is replaced. Either way it is settled first.
export const put = (book: Book, run: LedgerRun, now: number): Book =>
  run.id === 0
    ? pruned({
        nextId: book.nextId + 1,
        current: book.nextId,
        runs: [...book.runs, settled({ ...run, id: book.nextId }, now)],
      })
    : { ...book, runs: book.runs.map(one => (one.id === run.id ? settled(run, now) : one)) }

// Forgets a run for good. Clearing the current one leaves none current.
export const cleared = (book: Book, id: number): Book => ({
  ...book,
  current: book.current === id ? 0 : book.current,
  runs: book.runs.filter(one => one.id !== id),
})

// The user closes a run by hand, or opens it again.
export const closed = (book: Book, id: number, isClosed: boolean, now: number): Book | string => {
  const run = book.runs.find(one => one.id === id)

  if (run === undefined) {
    return `No run ${id}.`
  }

  const { isClosed: _c, ...rest } = run

  return put(book, isClosed ? { ...rest, isClosed: true } : rest, now)
}

// The runs as the list shows them: those not done, the newest first, then
// (when asked) the done ones, the latest done first.
export const listed = (book: Book, isAll: boolean): LedgerRun[] => [
  ...book.runs.filter(one => one.doneAt === undefined).reverse(),
  ...(isAll
    ? book.runs
        .filter(one => one.doneAt !== undefined)
        .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    : []),
]

// A run in a few marks, for its row in the list: tasks done of all, then
// only what is wrong or under way.
export const runMarks = (run: LedgerRun): string => {
  const counts = countsOf(run)

  return [
    `${counts.done}/${counts.tasks}`,
    counts.failed > 0 ? `${ICON.failed} ${counts.failed}` : '',
    counts.openFindings > 0 ? `${ICON.finding} ${counts.openFindings}` : '',
    counts.tokens > 0 ? tokensText(counts.tokens) : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

// How many subagents are running across every run not done.
export const busyOf = (book: Book): number =>
  book.runs
    .filter(one => one.doneAt === undefined)
    .reduce((sum, one) => sum + one.spawns.filter(spawn => spawn.endedAt === undefined).length, 0)

// The runs still under way, the newest first: where a write looks for its run.
export const underWay = (book: Book): LedgerRun[] =>
  book.runs.filter(one => one.doneAt === undefined).reverse()

// The run a task belongs to: one under way before one that is done, and of
// two the newer.
export const ownerOf = (book: Book, taskId: string): LedgerRun | undefined =>
  [...underWay(book), ...book.runs.filter(one => one.doneAt !== undefined).reverse()].find(one =>
    one.tasks.some(task => task.id === taskId),
  )

// The run a subagent was recorded in.
export const runOfAgent = (book: Book, agentId: string | undefined): LedgerRun | undefined =>
  agentId === undefined ? undefined : book.runs.find(one => one.spawns.some(spawn => spawn.agentId === agentId))

// The run a finding is in.
export const runOfFinding = (book: Book, id: number): LedgerRun | undefined =>
  book.runs.find(one => one.findings.some(finding => finding.id === id))

// The ids a new plan may not use: a task id must name one task among the runs
// under way, since that is how a write finds its run. The answer names them.
export const clash = (book: Book, ids: readonly string[]): string | undefined => {
  const taken = ids.filter(id => underWay(book).some(one => one.tasks.some(task => task.id === id)))

  return taken.length === 0
    ? undefined
    : `Task ${taken.length === 1 ? 'id' : 'ids'} ${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} in use by a run still under way. Give this plan's tasks ids of their own, for example with a prefix.`
}

// The number the next finding takes: one count for the whole book, so a
// finding's number names it whichever run it is in.
export const nextFinding = (book: Book): number =>
  Math.max(1, ...book.runs.map(one => one.nextFinding))

// The status line's entry for the whole book: the one run under way in full,
// several as a count of tasks each, and nothing with none under way.
export const bookStatus = (book: Book): string | undefined => {
  const live = underWay(book)
  const only = live[0]

  if (only === undefined) {
    return undefined
  }

  if (live.length === 1) {
    return statusText(only)
  }

  return `${ICON.tasks} ${live
    .map(one => {
      const counts = countsOf(one)

      return `${cut(one.goal === '' ? `run ${one.id}` : one.goal, 16)} ${counts.failed > 0 ? `${ICON.failed} ` : ''}${counts.done}/${counts.tasks}`
    })
    .join(' · ')}`
}
