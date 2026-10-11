// A session's runs, kept together: every run planned in it, the newest last,
// and which one is current. A session resumed finds its book as it left it.
// Free of the engine, as run.ts is.

import type { LedgerRun, LedgerSessionNote } from '../types'
import { ICON } from './kit/icons'
import { countsOf, isDone, isOver, isRun, isStalled, statusText, tokensText } from './run'

// `current` is the id of the run the tools record against (0 for none): the
// one planned last, or the one the user picked. `cwd` is the folder the
// session ran in, for the list of sessions.
export type Book = { nextId: number; current: number; runs: LedgerRun[]; cwd?: string }

export const EMPTY: Book = { nextId: 1, current: 0, runs: [] }

// How many runs a session keeps. Past it the oldest done ones are dropped; a
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
        ...book,
        nextId: book.nextId + 1,
        current: book.nextId,
        runs: [...book.runs, settled({ ...run, id: book.nextId, changedAt: now }, now)],
      })
    : { ...book, runs: book.runs.map(one => (one.id === run.id ? settled({ ...run, changedAt: now }, now) : one)) }

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

// Whether work is under way in a run not done: a subagent running, or a task
// marked running that has not stalled. It is what the turning mark stands for.
export const isTurning = (book: Book, now: number): boolean =>
  busyOf(book) > 0 ||
  book.runs.some(
    one => one.doneAt === undefined && one.tasks.some(task => task.status === 'running' && !isStalled(one, task, now)),
  )

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

// The status line's entry for the whole book: the task work is on in the
// newest run under way, and how many more tasks are not done across them all.
// Nothing with no run under way.
export const bookStatus = (book: Book): string | undefined => {
  const [newest, ...rest] = underWay(book)

  return newest === undefined
    ? undefined
    : statusText(
        newest,
        rest.reduce((sum, one) => sum + one.tasks.filter(task => !isOver(task)).length, 0),
      )
}

// The sessions that have a ledger, each in a line, the latest changed first:
// what the list of sessions reads, so no book is opened to draw it.
export const isIndex = (value: unknown): value is LedgerSessionNote[] =>
  Array.isArray(value) &&
  value.every(
    one =>
      typeof one === 'object' &&
      one !== null &&
      typeof (one as LedgerSessionNote).id === 'string' &&
      typeof (one as LedgerSessionNote).cwd === 'string' &&
      typeof (one as LedgerSessionNote).at === 'number',
  )

// How many sessions' ledgers are kept. Past it the ones changed longest ago
// are dropped.
export const SESSIONS_KEPT = 60

// A session's book in a line, as it stood at `at`.
export const noteOf = (id: string, book: Book, at: number): LedgerSessionNote => ({
  id,
  cwd: book.cwd ?? '',
  at,
  goal: (currentOf(book) ?? book.runs.at(-1))?.goal ?? '',
  open: underWay(book).length,
  ...(isTurning(book, at) ? { busy: true as const } : {}),
  size: JSON.stringify(book).length,
  runs: book.runs.length,
})

// The index with a session's line put first, or taken out when its book has
// no run left; and the sessions dropped for being past the limit.
export const noted = (
  index: readonly LedgerSessionNote[],
  note: LedgerSessionNote,
): { index: LedgerSessionNote[]; dropped: string[] } => {
  const all = [...(note.runs > 0 ? [note] : []), ...index.filter(one => one.id !== note.id)].sort(
    (a, b) => b.at - a.at,
  )

  return { index: all.slice(0, SESSIONS_KEPT), dropped: all.slice(SESSIONS_KEPT).map(one => one.id) }
}

// The sessions as their list shows them: those of this folder first, each
// group the latest changed first.
export const sessionsListed = (index: readonly LedgerSessionNote[], cwd: string): LedgerSessionNote[] => [
  ...index.filter(one => one.cwd === cwd),
  ...index.filter(one => one.cwd !== cwd),
]

// The session a run with no session recorded is filed under: one a folder.
export const unnamedSession = (cwd: string): string => `before:${cwd}`

// A book kept for a whole folder, as it was before each session kept its own,
// as one book a session: each run goes to the session that planned it.
export const splitOld = (old: Book, cwd: string): Map<string, Book> => {
  const books = new Map<string, Book>()

  for (const run of old.runs) {
    const id = run.sessionId ?? unnamedSession(cwd)
    const book = books.get(id) ?? { nextId: old.nextId, current: 0, runs: [], cwd }

    books.set(id, { ...book, runs: [...book.runs, run] })
  }

  // A session's current run is the folder's where that was its own, else the
  // one it planned last.
  for (const [id, book] of books) {
    books.set(id, {
      ...book,
      current: book.runs.some(one => one.id === old.current) ? old.current : (book.runs.at(-1)?.id ?? 0),
    })
  }

  return books
}

// When a book last changed, as far as its runs say.
export const changedAt = (book: Book): number =>
  Math.max(0, ...book.runs.map(one => one.doneAt ?? one.startedAt))

// How much of the store the ledgers may take in all, in characters of JSON:
// under the 4 MiB the engine gives a plugin's store, with room to spare.
export const STORE_BUDGET = 3_000_000

// A session's book with only the runs not done, to make room: null when it
// has none, so nothing of it is worth keeping.
export const trimmed = (book: Book): Book | null => {
  const open = book.runs.filter(one => one.doneAt === undefined)

  return open.length === 0
    ? null
    : { ...book, current: open.some(one => one.id === book.current) ? book.current : 0, runs: open }
}

// The sessions to make room from when the ledgers are over `budget`, the one
// changed longest ago first, and never `keep`, the session at work. Enough of
// them that, were each emptied, the rest would fit.
export const overBudget = (index: readonly LedgerSessionNote[], keep: string, budget = STORE_BUDGET): string[] => {
  let total = index.reduce((sum, one) => sum + (one.size ?? 0), 0)
  const ids: string[] = []

  for (const one of [...index].sort((a, b) => a.at - b.at)) {
    if (total <= budget) {
      break
    }

    if (one.id !== keep) {
      ids.push(one.id)
      total -= one.size ?? 0
    }
  }

  return ids
}
