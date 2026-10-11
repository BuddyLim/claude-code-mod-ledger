import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LedgerRun, LedgerSessionNote, LedgerTask } from '../types'
import {
  PLAN_PATH,
  labelled,
  outlineOf,
  outlineRequest,
  parsePlan,
  planFromOutline,
  runFromDoc,
  statusLabels,
  ticked,
} from './doc'
import type { PlanDoc } from './doc'
import { ICON, refIcon } from './kit/icons'
import type { Book } from './book'
import {
  EMPTY,
  bookOf,
  STORE_BUDGET,
  isTurning,
  overBudget,
  trimmed,
  changedAt,
  clash,
  cleared,
  closed,
  currentOf,
  isBook,
  isIndex,
  listed,
  nextFinding,
  noteOf,
  noted,
  ownerOf,
  put,
  runMarks,
  runOfAgent,
  bookStatus,
  runOfFinding,
  sessionsListed,
  settled,
  splitOld,
  underWay,
} from './book'
import { PAD, ageOf, cut } from './kit/layout'
import { allNeeds, lanesFrom, needsFromAnswer, needsRequest, shapeText } from './lanes'
import type { Needs } from './lanes'
import { NODES, gapFor, idleLanes, rowsOf, stripOf, unmetOf, wrapped } from './pipe'
import type { StripPiece } from './strip'
import {
  SEVERITIES,
  STALE_MS,
  isStalled,
  STATUSES,
  countsOf,
  lanesOf,
  ended,
  findingText,
  focusOf,
  leftOpen,
  placeOf,
  spanText,
  spawnMeta,
  stepsText,
  tail,
  tokensText,
  unitsOf,
  fixed,
  found,
  orphaned,
  plan,
  report,
  resumed,
  setTask,
  spawned,
  taskOf,
} from './run'
import type { NewTask } from './run'

const PLAN = 'mcp__ledger__plan'
const TASK = 'mcp__ledger__task'
const FINDING = 'mcp__ledger__finding'
const FIXED = 'mcp__ledger__fixed'
const REPORT = 'mcp__ledger__report'

// The run other mods read; null while nothing is planned.
const run = atom({ plugin: 'ledger', key: 'run' } as const, null)
const isHidden = atom({ plugin: 'ledger', key: 'isHidden' } as const, false)
// Whether the pane lists fixed findings and every finished agent too.
const isAll = atom({ plugin: 'ledger', key: 'isAll' } as const, false)
// Every run kept for the session, for the pane's list.
const runs = atom({ plugin: 'ledger', key: 'runs' } as const, [])
// The session those are read from; another one means the process went on
// under a new session (a /clear, a resume) or started afresh.
const home = atom({ plugin: 'ledger', key: 'home' } as const, '')
// Another session's ledger the pane shows, read only; and the sessions that
// have one, as last listed.
const peek = atom({ plugin: 'ledger', key: 'peek' } as const, null)
const others = atom({ plugin: 'ledger', key: 'others' } as const, [])
// The pane: the run it shows in full (0 for the list of runs, -1 for the list
// of sessions), the list's row the focus is on, whether a run shows its
// details, and the run a clear is waiting to be confirmed for (0 for none).
const shown = atom({ plugin: 'ledger', key: 'shown' } as const, 0)
const cursor = atom({ plugin: 'ledger', key: 'cursor' } as const, 0)
const isDetailed = atom({ plugin: 'ledger', key: 'isDetailed' } as const, false)
const confirming = atom({ plugin: 'ledger', key: 'confirming' } as const, 0)
// The frame of the mark that turns beside a running subagent.
const spin = atom({ plugin: 'ledger', key: 'spin' } as const, 0)
// The finding the focus ring is on in a run's view, and the place last asked
// to be shown: the lens mod, where loaded, opens it.
const pointed = atom({ plugin: 'ledger', key: 'pointed' } as const, 0)
// The task the overview shows in full, picked with the keys: '' for the one
// work is on.
const picked = atom({ plugin: 'ledger', key: 'picked' } as const, '')

const STATUS_WORDS = {
  todo: 'to do',
  running: 'running',
  'gate-failed': 'gate failed',
  done: 'done',
  cancelled: 'cancelled',
} as const
const jump = atom({ plugin: 'ledger', key: 'jump' } as const, null)

const PANE = 'ledger'
// The key of the region the pipeline is drawn in, where it takes the pointer.
const STRIP = 'strip'
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const SPIN_MS = 150
// In the pipeline drawn down: the space between a row's lines and its words,
// so a node does not sit against its task; and the space before a line of a
// task's details, which stand a little in from its title.
// The node of a task marked running that nothing has touched for long.
const STALLED = '◌'
// Drawn down, the run before is above and the run after below: the marks
// that lead to them point that way.
const UP = '△'
const DOWN = '▽'
const APART = '   '
// What a row naming the run before or after takes besides the run's name:
// its mark, the space after it, the hotkey a button shows ("p: "), and a
// little room at the pane's edge, so the name is cut before it is clipped.
const NEIGHBOUR_TAKEN = 1 + 3 + 3 + 3
const BESIDE = '     '
// The most sessions their list shows: the latest changed.
const SESSIONS_SHOWN = 30

// A folder's own name, for a line that has no room for its path.
const folderOf = (cwd: string): string => cwd.split('/').filter(Boolean).at(-1) ?? cwd

const TASK_ICONS = {
  todo: ICON.todo,
  running: ICON.running,
  'gate-failed': ICON.failed,
  done: ICON.done,
  cancelled: NODES.cancelled,
} as const
const TASK_TONES = { todo: 'gray', running: 'cyan', 'gate-failed': 'error', done: 'success', cancelled: 'gray' } as const
const SEVERITY_TONES = { error: 'error', warning: 'warning', note: 'cyan' } as const

// Adds text to the end of the person's draft, on its own line, and never
// submits it: sending stays theirs.
const toPrompt = async ($: EngineInterface, text: string) => {
  const draft = await $.prompt.read().then(
    box => box.text,
    () => '',
  )
  const lead = draft === '' || draft.endsWith('\n') ? '' : '\n'
  const filled = await $.prompt.fill({ text: `${lead}${text}\n`, mode: 'append' }).then(
    answer => answer.isFilled,
    () => false,
  )

  $.ui.toast(filled ? 'Ledger: added to the prompt.' : 'Ledger: the prompt could not take it.')
}

const GUIDE = `# Ledger

The user follows delegated work in a ledger. Keep it true, in few words, with ${PLAN}, ${TASK}, ${FINDING}, ${FIXED} and ${REPORT}.

- Before delegating a settled plan, call ${PLAN} once: the goal, each task (id, lane where the plan has parallel lanes, unit, title, a one-line "about", tier, gate check) and a one-line "about" per unit. List the tasks in the order they run: tasks with no lane run one after another, and tasks in lanes that follow one another run side by side. It starts a new run and keeps earlier ones, so give its tasks ids no run under way uses.
- Where a run is already read from a plan document (its report says "Plan:"), do not plan it again: its tasks are T1, T2, ... as the document numbers them. The document may carry a line or two under a task heading: "**Lane:** api" puts it in a lane, "**Needs:** Task 1, Task 2" names the tasks it needs first, "**Unit:**", "**Tier:**" and "**Gate:**" say the rest. Leave the "**Status:**" lines alone: the ledger writes them.
- Lanes are worked at once. Where the report shows lanes, start one subagent per lane in a single step, each working its lane's tasks in order, and start the task after the lanes only when every lane is done. Tasks with no lane are done one at a time, in order.
- Begin each subagent's description with its task id in brackets: "[T3] add the retry".
- Settle as you go, never in one sweep at the end. The moment a task's gate passes, call ${TASK} with every task that changed: "done" with a one-line outcome (what changed, in which files), "gate-failed" with a one-line note, or "cancelled" with a one-line note for a task that will not be done (it then holds the run open no longer). When a unit's review passes, mark every task of that unit done in that same step.
- Tell reviewers to record all their findings in one ${FINDING} call and to answer with the count only, not the findings again. The moment a finding's fix lands, or you decide it needs none, close it with ${FIXED}, in the step that settles it; do not move to the next unit with a finding of this one open and unmentioned.
- A run closes only once every task is done and no finding is open. Before telling the user the work is finished, read ${REPORT}: mark done what is done, close what is fixed, and name whatever you leave open and why.
- Make ledger calls in the same step as your other tool calls, never as a step of their own.
- For a status update, or when resuming, read ${REPORT} and answer from it.`

const SUBAGENT_REFUSAL =
  'Only the main agent changes the plan and its tasks. Report findings with the finding tool, and the rest in your final answer.'

// A session's book is kept under its id, so a session resumed finds its own
// and two sessions in one folder never write each other's.
const bookKey = (sessionId: string) => `book:${sessionId}`
const keyOf = async ($: EngineInterface) => bookKey(await $.session.id())
// The sessions that have a book, each in a line; and the mark that the books
// kept a folder each, as they were before, have been filed by session.
const INDEX = 'sessions'
const FILED = 'filed-by-session'
// Where a folder's runs were kept together, and before that its one run.
const OLD_BOOK = 'runs:'
const OLD_RUN = 'run:'

const loadBook = async ($: EngineInterface): Promise<Book> => {
  const stored = await $.store.get(await keyOf($))

  return isBook(stored) ? stored : EMPTY
}

const loadIndex = async ($: EngineInterface): Promise<LedgerSessionNote[]> => {
  const stored = await $.store.get(INDEX)

  return isIndex(stored) ? stored : []
}

// Writes the index with a session's line as it now stands, and forgets the
// books of the sessions that fell past the limit.
const noteSession = async ($: EngineInterface, index: readonly LedgerSessionNote[], note: LedgerSessionNote) => {
  const kept = noted(index, note)

  await $.store.set(INDEX, kept.index)

  for (const gone of kept.dropped) {
    await $.store.delete(bookKey(gone))
  }

  return kept.index
}

// Keeps the ledgers within `budget` of the store, giving up the least to do
// it: from the sessions changed longest ago, and never the one at work, first
// their finished runs, and only if that is not enough, the sessions whole. A
// run not done is the last thing dropped. Says so once when it had to.
const makeRoom = async ($: EngineInterface, keep: string, budget: number) => {
  let index = await loadIndex($)

  // A line written before sizes were kept is measured once.
  for (const one of index.filter(note => note.size === undefined)) {
    const stored = await $.store.get(bookKey(one.id))

    index = index.map(note => (note.id === one.id ? { ...note, size: JSON.stringify(stored ?? null).length } : note))
  }

  const crowded = overBudget(index, keep, budget)

  if (crowded.length === 0) {
    return
  }

  for (const id of crowded) {
    const stored = await $.store.get(bookKey(id))
    const kept = isBook(stored) ? trimmed(stored) : null
    const was = index.find(note => note.id === id)

    if (kept === null) {
      await $.store.delete(bookKey(id))
      index = index.filter(note => note.id !== id)
    } else {
      await $.store.set(bookKey(id), kept)
      index = index.map(note => (note.id === id ? noteOf(id, kept, was?.at ?? 0) : note))
    }
  }

  // Runs not done are all that is left of those sessions; still over, the
  // oldest of them go whole.
  for (const id of overBudget(index, keep, budget)) {
    await $.store.delete(bookKey(id))
    index = index.filter(note => note.id !== id)
  }

  await $.store.set(INDEX, index)
  $.ui.toast(
    `Ledger: its store was nearly full, so the finished runs of ${crowded.length} older session${crowded.length === 1 ? '' : 's'} were dropped.`,
  )
}

// Files the books kept a folder each by the session that planned each run,
// once. What was stored stays where it was; a session's book already there is
// left alone.
const fileBySession = async ($: EngineInterface) => {
  if ((await $.store.get(FILED)) === true) {
    return
  }

  const keys = await $.store.keys()
  let index = await loadIndex($)

  for (const key of keys) {
    const isOldBook = key.startsWith(OLD_BOOK)
    const cwd = key.slice(isOldBook ? OLD_BOOK.length : OLD_RUN.length)

    // A folder's one run was already taken into its book of runs.
    if (!isOldBook && (!key.startsWith(OLD_RUN) || keys.includes(`${OLD_BOOK}${cwd}`))) {
      continue
    }

    const stored = await $.store.get(key)

    for (const [id, book] of splitOld(isOldBook ? bookOf(stored, undefined) : bookOf(undefined, stored), cwd)) {
      if ((await $.store.get(bookKey(id))) === undefined) {
        await $.store.set(bookKey(id), book)
        index = await noteSession($, index, noteOf(id, book, changedAt(book)))
      }
    }
  }

  await $.store.set(FILED, true)
}

// The current run: the one the tools record against.
const load = async ($: EngineInterface): Promise<LedgerRun | null> => currentOf(await loadBook($))

// The mark that turns beside a running subagent: a timer moves its frame
// while any subagent runs, and stops when none does.
let spinTimer: { cancel: () => void } | undefined
let spinTicks = 0

const spinWhile = ($: EngineInterface, isBusy: boolean) => {
  if (isBusy && spinTimer === undefined) {
    spinTimer = $.clock.every(SPIN_MS, () => {
      spinTicks += 1
      void update($, spin, frame => (frame + 1) % SPINNER.length)

      // About once a minute the book is looked at again: a task that has
      // stalled meanwhile stops the mark, with no write to say so.
      if (spinTicks % 400 === 0) {
        void refresh($).catch(() => undefined)
      }
    })
  } else if (!isBusy && spinTimer !== undefined) {
    spinTimer.cancel()
    spinTimer = undefined
  }
}

// Keeps the state other mods and the pane read, the status line's entry and
// the spinner's timer in step with the book. The entry is the current run's,
// and is empty while hidden, once that run is done, or with nothing to say.
const show = async ($: EngineInterface, book: Book) => {
  const now = currentOf(book)

  await update($, run, () => now)
  await update($, runs, () => book.runs)
  $.ui.status((await read($, isHidden)) ? undefined : bookStatus(book))
  // The mark turns for a running subagent and for a task marked running, and
  // in the list of sessions for one that was at work when it last changed.
  const at = await $.clock.now()

  spinWhile(
    $,
    isTurning(book, at) ||
      ((await read($, shown)) === -1 &&
        (await read($, others)).some(one => one.busy === true && at - one.at < STALE_MS)),
  )
}

const refresh = async ($: EngineInterface) => show($, await loadBook($))

// One change at a time: two hooks recording at once would otherwise both read
// the book before either wrote it, and the second write would drop the first.
let changes: Promise<unknown> = Promise.resolve()

// Reads the stored book, applies the change and writes it back; answers the
// reason when the change was refused or the store failed.
const changeBookNow = async (
  $: EngineInterface,
  apply: (book: Book, now: number) => Book | string,
): Promise<{ book: Book } | { error: string }> => {
  try {
    const before = await loadBook($)
    const at = await $.clock.now()
    const made = apply(before, at)

    if (typeof made === 'string') {
      return { error: made }
    }

    // Nothing changed: nothing is written, so a session with no run keeps none.
    if (made === before) {
      await show($, made)

      return { book: made }
    }

    const sessionId = await $.session.id()
    const after = made.cwd === undefined ? { ...made, cwd: await $.session.cwd() } : made

    // A book with no run left is forgotten, and its session leaves the list.
    const write = async () => {
      await (after.runs.length === 0 ? $.store.delete(bookKey(sessionId)) : $.store.set(bookKey(sessionId), after))
      await noteSession($, await loadIndex($), noteOf(sessionId, after, at))
    }

    // A store that is full refuses the write: room is made from the oldest
    // sessions' finished runs, well under the budget, and it is written again.
    await write().catch(async () => {
      await makeRoom($, sessionId, STORE_BUDGET / 2)
      await write()
    })
    await makeRoom($, sessionId, STORE_BUDGET).catch(() => undefined)
    await show($, after)

    return { book: after }
  } catch (error) {
    return { error: `The ledger could not be saved: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const changeBook = (
  $: EngineInterface,
  apply: (book: Book, now: number) => Book | string,
): Promise<{ book: Book } | { error: string }> => {
  const next = changes.then(() => changeBookNow($, apply))
  changes = next.catch(() => undefined)

  return next
}

// Changes the current run: `apply` answers the run as it should be (a new one
// to plan it, the same one for no change), a refusal, or null to forget it.
const change = async (
  $: EngineInterface,
  apply: (now: LedgerRun | null) => LedgerRun | string | null,
): Promise<{ run: LedgerRun | null } | { error: string }> => {
  const changed = await changeBook($, (book, at) => {
    const before = currentOf(book)
    const after = apply(before)

    return typeof after === 'string'
      ? after
      : after === null
        ? before === null
          ? book
          : cleared(book, before.id)
        : put(book, after, at)
  })

  return 'error' in changed ? changed : { run: currentOf(changed.book) }
}

// The session the hooks last ran in. A hot reload forgets it; `home`, which
// the host keeps, then says the session is the same one.
let seen: string | undefined

// Brings what is shown in step with the session the process is now in: a
// /clear or a resume goes on under another id with no `session.start`, and a
// session resumed in a new process starts with nothing shown. The subagents
// its book still shows running ended with the process that ran them; one that
// is sent a message and works again is seen at its next tool call.
const sync = async ($: EngineInterface) => {
  const sessionId = await $.session.id()

  if (seen === sessionId) {
    return
  }

  seen = sessionId

  if ((await read($, home)) !== sessionId) {
    await changeBook($, (book, at) => {
      const left = book.runs.flatMap(one => one.spawns.filter(spawn => spawn.endedAt === undefined))

      for (const one of left) {
        over.add(one.agentId)
      }

      return left.length === 0
        ? book
        : { ...book, runs: book.runs.map(one => settled(orphaned(one, at), at)) }
    })
    await update($, home, () => sessionId)
    await update($, peek, () => null)
    await update($, shown, value => (value === -1 ? 0 : value))
  }

  await refresh($)
}

// What a small model answered when asked to lay out a document the parser
// could not read, by the document's outline with its ticks taken out: one
// call a document, however often its boxes change.
const laidOut = new Map<string, string>()
// The plan documents runs are read from: an edit of one reads it again.
const followed = new Set<string>()

type PlanRead = { text: string; doc: PlanDoc; isLaidOutByModel: boolean }

// Reads a plan document: by its layout where that is the superpowers one, at
// no cost; else as a small model groups its headings and checkboxes, from a
// request of those lines alone. Undefined when it has no checkbox to follow.
const readPlan = async ($: EngineInterface, path: string): Promise<PlanRead | undefined> => {
  const text = await $.fs.read(path).catch(() => undefined)

  if (text === undefined) {
    return undefined
  }

  const direct = parsePlan(text)

  if (direct !== undefined) {
    return { text, doc: direct, isLaidOutByModel: false }
  }

  const outline = outlineOf(text)

  if (!/\[( |x|X)\]/.test(outline)) {
    return undefined
  }

  const key = outline.replace(/\[(x|X)\]/g, '[ ]')
  let answer = laidOut.get(key)

  if (answer === undefined) {
    // A call that fails is no answer: the document is then not followed.
    answer = await $.model
      .complete({ model: 'haiku', prompt: outlineRequest(outline), maxTokens: 1500, timeoutMs: 30000 })
      .then(
        said => (said.isAnswered ? said.text : ''),
        () => '',
      )

    if (answer !== '') {
      laidOut.set(key, answer)
    }
  }

  const doc = planFromOutline(text, answer)

  return doc === undefined ? undefined : { text, doc, isLaidOutByModel: true }
}

// Makes a run of a plan document, or brings the run it made in step with it.
// Answers what happened, in a line.
const followDoc = async ($: EngineInterface, path: string): Promise<string> => {
  const plan = await readPlan($, path)

  if (plan === undefined) {
    return `Ledger: ${path} has no tasks with checkboxes to follow.`
  }

  const sessionId = await $.session.id()
  const changed = await changeBook($, (book, at) =>
    put(
      book,
      runFromDoc(
        plan.doc,
        path,
        plan.isLaidOutByModel,
        at,
        sessionId,
        book.runs.find(one => one.doc?.path === path),
      ),
      at,
    ),
  )

  if ('error' in changed) {
    return changed.error
  }

  followed.add(path)

  return `Ledger: following ${path}, ${plan.doc.tasks.length} task${plan.doc.tasks.length === 1 ? '' : 's'}${plan.isLaidOutByModel ? ' (laid out by a small model: its layout is not the superpowers one)' : ''}.`
}

// Writes a run's state into its plan document: the open boxes under each task
// the run has as done are ticked (where `withTicks`), and each task's
// `**Status:**` line says how it stands. `isDry` only counts the boxes.
// Answers how many boxes.
const tickDoc = async ($: EngineInterface, path: string, isDry: boolean, withTicks = true): Promise<number> => {
  const plan = await readPlan($, path)
  const owner = (await loadBook($)).runs.find(one => one.doc?.path === path)

  if (plan === undefined || owner === undefined) {
    return 0
  }

  const after = withTicks ? ticked(plan.text, plan.doc, owner) : { text: plan.text, count: 0 }

  if (isDry) {
    return after.count
  }

  // A tick moves no line, so the document as read still says where each is.
  // A document a small model laid out has no task headings to write under.
  const written = plan.isLaidOutByModel ? after.text : labelled(after.text, plan.doc, statusLabels(plan.doc, owner))

  if (written !== plan.text) {
    await $.fs.write(path, written)
    await followDoc($, path)
  }

  return after.count
}

// What `/ledger lanes` last proposed for a document, and the document as it
// was then: writing it asks no model again, and writes what was shown.
const proposals = new Map<string, { text: string; said: Needs }>()

// Makes a sequential plan one that can be worked on in parallel, in the same
// document: learns what each task needs (from its `**Needs:**` line, else from
// a model's reading of the tasks; and always from the files two tasks share),
// works out the lanes, and writes a `**Needs:**` and a `**Lane:**` line under
// each task.
//
// What a model read is shown before it is written: the first ask proposes,
// and `shouldWrite` writes what was proposed while the document is unchanged.
// A document that already says what every task needs is written at once,
// since nothing in it is a guess. Answers what it found or did.
const laneDoc = async ($: EngineInterface, path: string, shouldWrite: boolean): Promise<string> => {
  const text = await $.fs.read(path).catch(() => undefined)
  const doc = text === undefined ? undefined : parsePlan(text)

  if (text === undefined || doc === undefined) {
    return `Ledger: ${path} is not laid out in "Task N" headings, so it has no tasks to put in lanes.`
  }

  const said: Needs = new Map(doc.tasks.flatMap(one => (one.needs === undefined ? [] : [[one.n, one.needs]])))
  const unsaid = doc.tasks.filter(one => one.needs === undefined)
  const proposed = proposals.get(path)
  const isGuessed = unsaid.length > 0 && doc.tasks.length > 1
  // What was shown stands while the document it was read from is the same.
  const isShown = isGuessed && proposed !== undefined && proposed.text === text

  if (isShown) {
    for (const [n, needs] of proposed.said) {
      said.set(n, needs)
    }
  } else if (isGuessed) {
    // One call, for the tasks the document does not speak for. A task the
    // answer leaves out needs the one before it, as the plan was written.
    const answer = await $.model
      .complete({ model: 'sonnet', prompt: needsRequest(doc.tasks), maxTokens: 2000, timeoutMs: 60000 })
      .then(
        told => (told.isAnswered ? told.text : ''),
        () => '',
      )
    const read = needsFromAnswer(answer, doc.tasks)

    if (read.size === 0) {
      return 'Ledger: the plan could not be read for what each task needs (the model gave no answer). Nothing was written.'
    }

    for (const one of unsaid) {
      const told = read.get(one.n)

      if (told !== undefined) {
        said.set(one.n, told)
      }
    }

    proposals.set(path, { text, said: new Map(said) })
  }

  const needs = allNeeds(doc.tasks, said)
  const lanes = lanesFrom(doc.tasks, needs)
  const count = new Set(lanes.values()).size
  const found =
    count === 0
      ? `no two tasks of ${path} can be worked on at once: each needs one before it`
      : `${count} lanes in ${path}: ${shapeText(doc.tasks, lanes)}`
  const each = doc.tasks
    .map(one => `  Task ${one.n} needs ${(needs.get(one.n) ?? []).join(', ') || 'none'}`)
    .join('\n')

  // A guess not yet shown is shown, whatever was asked: it is the person who
  // says it is right.
  if (isGuessed && !(shouldWrite && isShown)) {
    return `Ledger proposes ${found}.\n${each}\nNothing is written yet. If that is right, run /ledger lanes --write; if a task needs something else, add a **Needs:** line under it in the document and run /ledger lanes again.`
  }

  if (!shouldWrite && !isGuessed) {
    return `Ledger: ${found}, from the **Needs:** lines in the document.\n${each}\nRun /ledger lanes --write to write the lanes.`
  }

  const after = labelled(
    text,
    doc,
    new Map(
      doc.tasks.map(one => {
        const mine = needs.get(one.n) ?? []

        return [
          one.n,
          {
            needs: mine.length === 0 ? 'none' : mine.map(n => `Task ${n}`).join(', '),
            lane: lanes.get(one.n) ?? null,
          },
        ]
      }),
    ),
  )

  proposals.delete(path)

  if (after !== text) {
    await $.fs.write(path, after)

    // A run read from the document follows it; a document no run is read
    // from is only written.
    if ((await loadBook($)).runs.some(one => one.doc?.path === path)) {
      await followDoc($, path)
    }
  }

  return `Ledger: ${found}. ${after === text ? 'The document already says so.' : 'Written under each task; edit a **Needs:** line and run /ledger lanes --write again if one is wrong.'}`
}

// A file was written: when it is a plan document a run is read from, or a new
// plan where superpowers saves them and those are followed, the run follows.
const noteDoc = async ($: EngineInterface, path: string, follows: boolean): Promise<void> => {
  const isNew = !followed.has(path)

  if (!isNew || (follows && PLAN_PATH.test(path))) {
    const said = await followDoc($, path).catch(() => '')

    if (isNew && said !== '') {
      $.ui.toast(said)
    }
  }
}

// A path as typed, made absolute from the session's folder.
const fullPath = async ($: EngineInterface, typed: string): Promise<string> =>
  typed.startsWith('/') ? typed : `${await $.session.cwd()}/${typed.replace(/^\.\//, '')}`

// What the agent has already been told about, so each thing is said once.
const told = new Set<string>()
// How long after a lane's first subagent starts the other lanes of its fork
// are looked at: long enough for subagents started in one step to all arrive.
const LANES_WAIT_MS = 20000

// Tells the agent something of its own run, as a note it reads and the person
// does not see as typed; and the person, in a toast.
const tell = async ($: EngineInterface, key: string, words: string) => {
  if (told.has(key)) {
    return
  }

  told.add(key)
  $.ui.toast(words)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: words }] } }).catch(() => undefined)
}

// A subagent started on a task: the agent is told when the task was started
// before what it needs is done, and, a little later, when the other lanes of
// its fork are still waiting though they could run beside it.
const watchSpawn = async ($: EngineInterface, book: Book, agentId: string) => {
  const home = runOfAgent(book, agentId)
  const task = home?.spawns.find(one => one.agentId === agentId)?.task

  if (home === undefined || task === undefined) {
    return
  }

  const unmet = unmetOf(home, task)

  if (unmet.length > 0) {
    await tell(
      $,
      `needs:${home.id}:${task}`,
      `Ledger: ${task} was started, but ${unmet.join(', ')} ${unmet.length === 1 ? 'is' : 'are'} not done and the plan puts ${unmet.length === 1 ? 'it' : 'them'} before ${task}. Finish ${unmet.length === 1 ? 'it' : 'them'} first, or say why the order does not matter here.`,
    )
  }

  if (idleLanes(home, task).length > 0) {
    $.clock.after(LANES_WAIT_MS, () => {
      void (async () => {
        const now = (await loadBook($)).runs.find(one => one.id === home.id)
        const idle = now === undefined ? [] : idleLanes(now, task)

        if (idle.length > 0) {
          await tell(
            $,
            `lanes:${home.id}:${idle.join('|')}`,
            `Ledger: ${task} is under way, but the lane${idle.length === 1 ? '' : 's'} ${idle.join(', ')} beside it ${idle.length === 1 ? 'has' : 'have'} not been started. Lanes of one fork need nothing of one another: start a subagent for each now, in one step, so they run at the same time.`,
          )
        }
      })().catch(() => undefined)
    })
  }
}

// The subagents whose last turn has ended, so a tool call from one is seen as
// it resuming; and the ends that arrived before their spawn was recorded.
const over = new Set<string>()
const earlyEnds = new Map<string, { reason: string; tokens: number | undefined; at: number; report?: string }>()

const NO_RUN =`Nothing is planned. Call ${PLAN} first.`
const NOTHING = 'Ledger: nothing is planned. The agent records a plan when it delegates one.'

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

// The most characters kept of what the agent writes: a line each, so the
// ledger stays cheap to write and quick to read.
const ABOUT_MOST = 160
const NOTE_MOST = 160
const OUTCOME_MOST = 240
const SUMMARY_MOST = 200
const REPORT_MOST = 600
// The most lines of a subagent's report the overview shows.
const REPORT_LINES = 5

// A line of text: its spaces folded, cut at `most`; undefined when empty.
const brief = (value: unknown, most: number): string | undefined => {
  const said = text(value)

  return said === undefined ? undefined : cut(said.replace(/\s+/g, ' '), most)
}

// What a plan call says each unit is for; an entry that names no unit or says
// nothing of it is left out.
const unitNotes = (value: unknown): { name: string; about: string }[] =>
  (Array.isArray(value) ? (value as unknown[]) : []).flatMap(one => {
    const entry = (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>
    const name = text(entry.name)
    const about = brief(entry.about, ABOUT_MOST)

    return name === undefined || about === undefined ? [] : [{ name, about }]
  })

// The tasks of a plan call, or the reason they were refused.
const tasksOf = (value: unknown): NewTask[] | string => {
  if (!Array.isArray(value)) {
    return 'plan needs tasks: a list of { id, unit, title, tier, check }.'
  }

  const tasks: NewTask[] = []

  for (const one of value as unknown[]) {
    const entry = (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>
    const id = text(entry.id)
    const title = text(entry.title)
    const lane = text(entry.lane)

    if (id === undefined || title === undefined) {
      return 'Every task needs an id and a title.'
    }

    const unit = text(entry.unit)
    const tier = text(entry.tier)
    const check = brief(entry.check, NOTE_MOST)
    const about = brief(entry.about, ABOUT_MOST)
    const needs = (Array.isArray(entry.needs) ? (entry.needs as unknown[]) : []).flatMap(need => text(need) ?? [])

    tasks.push({
      id,
      title,
      ...(lane !== undefined ? { lane } : {}),
      ...(unit !== undefined ? { unit } : {}),
      ...(tier !== undefined ? { tier } : {}),
      ...(check !== undefined ? { check } : {}),
      ...(about !== undefined ? { about } : {}),
      ...(needs.length > 0 ? { needs } : {}),
    })
  }

  return tasks
}

export const register: Register = (on, options) => {
  // Whether a superpowers plan document is read as a run by itself, and
  // whether finishing a task ticks the boxes under it that were missed.
  const follows = options.followPlans === true
  const ticks = options.tickPlans !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ledger',
      description: 'Show the run: /ledger [sessions | lanes <plan> | hide | show | clear]',
    })
    await $.tool.register({
      name: 'plan',
      description:
        'Record the settled plan of an orchestrated run: its goal and every task. It becomes the current run; earlier runs are kept.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'One line naming what the run is for' },
          units: {
            type: 'array',
            description: 'What each unit is for: one line on what its tasks add up to for the user',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, about: { type: 'string' } },
              required: ['name', 'about'],
            },
          },
          tasks: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'A short id, as in T1' },
                lane: {
                  type: 'string',
                  description: 'Where the plan has parallel lanes (tracks that can be worked on at once): the lane this task is in',
                },
                unit: { type: 'string', description: 'The unit the task belongs to; tasks reviewed together share one' },
                title: { type: 'string' },
                tier: { type: 'string', description: 'The model the task is meant for: haiku, sonnet or opus' },
                check: { type: 'string', description: 'What the gate checks to call the task done' },
                needs: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'The ids of the tasks that must be done before this one starts, where that is not plain from the order',
                },
                about: {
                  type: 'string',
                  description:
                    'One line on what the task is for: what it changes for the user, or which part of the code it touches',
                },
              },
              required: ['id', 'title'],
            },
          },
        },
        required: ['goal', 'tasks'],
      },
    })
    await $.tool.register({
      name: 'task',
      description:
        'Record the state of every task that changed, in one call: done, gate-failed, or cancelled for one that will not be done.',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                status: { type: 'string', enum: [...STATUSES] },
                note: { type: 'string', description: 'With gate-failed: one line on what failed. With cancelled: why' },
                outcome: { type: 'string', description: 'With done: one line on what changed, and in which files' },
              },
              required: ['id', 'status'],
            },
          },
        },
        required: ['tasks'],
      },
    })
    await $.tool.register({
      name: 'finding',
      description: 'Report every problem a review found, in one call. Subagents call this too.',
      inputSchema: {
        type: 'object',
        properties: {
          findings: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'The file, from the project root' },
                line: { type: 'integer' },
                severity: { type: 'string', enum: [...SEVERITIES] },
                summary: { type: 'string', description: 'One line: what is wrong and what it causes' },
                task: { type: 'string', description: 'The task id, when known' },
              },
              required: ['path', 'severity', 'summary'],
            },
          },
        },
        required: ['findings'],
      },
    })
    await $.tool.register({
      name: 'fixed',
      description: 'Mark findings dealt with, by id.',
      inputSchema: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'integer' }, minItems: 1 } },
        required: ['ids'],
      },
    })
    await $.tool.register({
      name: 'report',
      description: 'Read the run: every task and its state, the agents spawned, and the open findings.',
      inputSchema: { type: 'object', properties: {} },
    })

    try {
      await fileBySession($)
      seen = undefined
      await sync($)

      // A plan document may have changed while no session was watching it.
      for (const one of (await loadBook($)).runs) {
        if (one.doc !== undefined) {
          followed.add(one.doc.path)

          if (one.doneAt === undefined) {
            await followDoc($, one.doc.path).catch(() => '')
          }
        }
      }
    } catch {
      $.ui.toast('The ledger could not be loaded.')
    }

    return next(e)
  })

  // The session ends, and after a /clear or a resume the process goes on under
  // another: its entry leaves the status line, and the next prompt brings the
  // ledger of the session it is then in.
  on('session.end', async ($, e, next) => {
    const result = await next(e)

    seen = undefined
    $.ui.status(undefined)

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    await sync($).catch(() => undefined)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return {
      sections: [...composed.sections, { id: 'ledger:guide', text: GUIDE, scope: 'session' }],
    }
  })

  on('tool.call', { tool: PLAN }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: SUBAGENT_REFUSAL }
    }

    const tasks = tasksOf(e.tasks)

    if (typeof tasks === 'string') {
      return { deny: tasks }
    }

    const sessionId = await $.session.id()
    const goal = text(e.goal) ?? ''
    const notes = unitNotes(e.units)
    // A task id names one task among the runs under way: that is how every
    // later write finds its run.
    const changed = await changeBook($, (book, at) => {
      const taken = clash(
        book,
        tasks.map(one => one.id),
      )
      const made = taken ?? plan(goal, tasks, at, sessionId, notes)

      return typeof made === 'string' ? made : put(book, made, at)
    })

    if ('error' in changed) {
      return { deny: changed.error }
    }

    await update($, isHidden, () => false)
    await refresh($)

    return { result: `Planned ${tasks.length} task${tasks.length === 1 ? '' : 's'}.` }
  })

  on('tool.call', { tool: TASK }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: SUBAGENT_REFUSAL }
    }

    // Every task that changed, in one call; one task's fields alone are taken too.
    const entries = (Array.isArray(e.tasks) ? (e.tasks as unknown[]) : [e]).map(
      one => (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>,
    )
    const updates = entries.flatMap(entry => {
      const id = text(entry.id)
      const status = STATUSES.find(one => one === entry.status)

      return id === undefined || status === undefined
        ? []
        : [{ id, status, note: brief(entry.note, NOTE_MOST), outcome: brief(entry.outcome, OUTCOME_MOST) }]
    })

    if (updates.length === 0 || updates.length < entries.length) {
      return { deny: `Each task needs an id and a status, one of ${STATUSES.join(', ')}.` }
    }

    // Each goes to the run its task is in. All of them or none: one id no run
    // has refuses the call, and says which.
    const changed = await changeBook($, (book, at) => {
      if (book.runs.length === 0) {
        return NO_RUN
      }

      let after = book

      for (const one of updates) {
        const owner = ownerOf(after, one.id)
        const next: LedgerRun | string =
          owner === undefined
            ? `No task ${one.id}. The tasks under way are ${underWay(after)
                .flatMap(run => run.tasks.map(task => task.id))
                .join(', ')}.`
            : setTask(owner, one.id, one.status, one.note, one.outcome)

        if (typeof next === 'string') {
          return next
        }

        after = put(after, next, at)
      }

      return after
    })

    if ('error' in changed) {
      return { deny: changed.error }
    }

    // A task of a run read from a plan document changed: how it stands is
    // written under it there, and the boxes under a done task that were missed
    // are ticked, where the setting asks for that.
    for (const one of changed.book.runs) {
      if (one.doc !== undefined && updates.some(update => one.tasks.some(task => task.id === update.id))) {
        await tickDoc($, one.doc.path, false, ticks).catch(() => 0)
      }
    }

    // What the write leaves to settle is said with it: findings still open on
    // a task marked done, or on a run whose tasks are now all done.
    const doneIds = updates.flatMap(one => (one.status === 'done' ? [one.id] : []))
    const left = changed.book.runs.flatMap(one =>
      one.tasks.some(task => doneIds.includes(task.id)) && leftOpen(one, doneIds) !== '' ? [leftOpen(one, doneIds)] : [],
    )

    return { result: [updates.map(one => `${one.id} ${one.status}`).join(', '), ...left].join('\n') }
  })

  on('tool.call', { tool: FINDING }, async ($, e) => {
    // Every finding of a review, in one call; one finding's fields alone too.
    const entries = (Array.isArray(e.findings) ? (e.findings as unknown[]) : [e]).map(
      one => (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>,
    )
    const reported = entries.flatMap(entry => {
      const path = text(entry.path)
      const summary = brief(entry.summary, SUMMARY_MOST)
      const severity = SEVERITIES.find(one => one === entry.severity)
      const line =
        typeof entry.line === 'number' && Number.isInteger(entry.line) && entry.line > 0 ? entry.line : undefined
      const task = text(entry.task)

      return path === undefined || summary === undefined || severity === undefined
        ? []
        : [
            {
              path,
              severity,
              summary,
              ...(line !== undefined ? { line } : {}),
              ...(task !== undefined ? { task } : {}),
            },
          ]
    })

    if (reported.length === 0 || reported.length < entries.length) {
      return { deny: `Each finding needs a path, a summary and a severity, one of ${SEVERITIES.join(', ')}.` }
    }

    const agentId = e.agentId
    let first = 0
    // Each goes to the run of the task it names, else to the run the
    // reporting subagent was spawned in (and to that subagent's task), else to
    // the current run.
    const changed = await changeBook($, (book, at) => {
      let after = book
      first = nextFinding(book)

      for (const one of reported) {
        const home =
          (one.task !== undefined ? ownerOf(after, one.task) : undefined) ??
          runOfAgent(after, agentId) ??
          currentOf(after)

        if (home === null || home === undefined) {
          return NO_RUN
        }

        const own = home.spawns.find(spawn => spawn.agentId === agentId)?.task

        after = put(
          after,
          found(
            // Findings are numbered across the book, so a number names one.
            { ...home, nextFinding: nextFinding(after) },
            {
              ...one,
              ...(one.task === undefined && own !== undefined ? { task: own } : {}),
              ...(agentId !== undefined ? { agentId } : {}),
            },
            at,
          ),
          at,
        )
      }

      return after
    })

    if ('error' in changed) {
      return { deny: changed.error }
    }

    return {
      result:
        reported.length === 1
          ? `Recorded as finding #${first}.`
          : `Recorded as findings #${first} to #${first + reported.length - 1}.`,
    }
  })

  on('tool.call', { tool: FIXED }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: SUBAGENT_REFUSAL }
    }

    const ids = Array.isArray(e.ids)
      ? (e.ids as unknown[]).filter((one): one is number => typeof one === 'number')
      : []

    if (ids.length === 0) {
      return { deny: 'fixed needs ids: the numbers of the findings dealt with.' }
    }

    // Each finding is closed in the run it is in.
    const changed = await changeBook($, (book, at) => {
      if (book.runs.length === 0) {
        return NO_RUN
      }

      let after = book

      for (const id of ids) {
        const home = runOfFinding(after, id)
        const next = home === undefined ? `No finding #${id}.` : fixed(home, [id])

        if (typeof next === 'string') {
          return next
        }

        after = put(after, next, at)
      }

      return after
    })

    return 'error' in changed ? { deny: changed.error } : { result: `Marked ${ids.length} fixed.` }
  })

  // Every run under way, the newest first; with none, the current run as it
  // ended.
  on('tool.call', { tool: REPORT }, async $ => {
    const book = await loadBook($)
    const live = underWay(book)
    const last = currentOf(book)

    return {
      result:
        live.length > 0
          ? live.map(one => report(one, true)).join('\n\n')
          : last === null
            ? 'Nothing is planned.'
            : report(last, true),
    }
  })

  // A subagent started: recorded in the run whose task its description names,
  // else in the current run while that is under way. With no run under way
  // nothing is recorded.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId

    if (agentId !== undefined) {
      const model = started.model
      const recorded = await changeBook($, (book, at) => {
        const live = underWay(book)
        const named = live.find(one => taskOf(one, e.description, e.prompt) !== undefined)
        const last = currentOf(book)
        const home = named ?? (last !== null && last.doneAt === undefined ? last : undefined)

        if (home === undefined) {
          return book
        }

        const task = taskOf(home, e.description, e.prompt)
        const record = spawned(home, {
          agentId,
          description: e.description,
          type: e.subagentType,
          model,
          startedAt: at,
          ...(task !== undefined ? { task } : {}),
        })
        // Its turn may have ended before this record was made.
        const early = earlyEnds.get(agentId)
        earlyEnds.delete(agentId)

        return put(
          book,
          early === undefined ? record : ended(record, agentId, early.reason, early.tokens, early.at, early.report),
          at,
        )
      })

      if (!('error' in recorded)) {
        await watchSpawn($, recorded.book, agentId).catch(() => undefined)
      }
    }

    return started
  })

  // A subagent's turn is over: when, why, and what it used, cached tokens
  // included.
  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId

    if (agentId !== undefined) {
      const usage = e.usage
      const tokens =
        usage === undefined
          ? undefined
          : usage.input_tokens +
            usage.output_tokens +
            usage.cache_read_input_tokens +
            usage.cache_creation_input_tokens
      const reason = e.reason
      // What it said as it ended: its report, kept short.
      const said = brief(e.answer, REPORT_MOST)
      await changeBook($, (book, at) => {
        const home = runOfAgent(book, agentId)

        if (home === undefined) {
          // Its spawn is not recorded yet, or no run was under way.
          if (underWay(book).length > 0) {
            earlyEnds.set(agentId, { reason, tokens, at, ...(said !== undefined ? { report: said } : {}) })
          }

          return book
        }

        over.add(agentId)

        return put(book, ended(home, agentId, reason, tokens, at, said), at)
      })
    }

    return next(e)
  })

  // A plan document was written or edited: the run read from it follows. A
  // plan saved where superpowers saves them starts a run by itself, where the
  // setting asks for that.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    await noteDoc($, e.file_path, follows)

    return ran
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    await noteDoc($, e.file_path, follows)

    return ran
  })

  // A subagent whose turn had ended calls a tool: it was sent a message and is
  // at work again.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId

    if (agentId !== undefined && over.has(agentId)) {
      over.delete(agentId)
      await changeBook($, (book, at) => {
        const home = runOfAgent(book, agentId)

        return home === undefined ? book : put(book, resumed(home, agentId), at)
      })
    }

    return next(e)
  })

  on('command.run', { command: 'ledger' }, async ($, e) => {
    const word = e.args.trim()

    if (word === 'hide' || word === 'show') {
      await update($, isHidden, () => word === 'hide')
      await refresh($)

      return { text: `Ledger: the status entry is ${word === 'hide' ? 'hidden' : 'shown'}.` }
    }

    // A plan document read as a run: any document laid out in tasks with
    // checkboxes, wherever it is saved.
    if (word.startsWith('follow')) {
      const typed = word.slice('follow'.length).trim()

      return {
        text: typed === '' ? 'Ledger: name the plan document: /ledger follow docs/plan.md' : await followDoc($, await fullPath($, typed)),
      }
    }

    // A sequential plan made parallel where it can be, in the same document:
    // the one named, else the one the current run is read from.
    if (word === 'lanes' || word.startsWith('lanes ')) {
      const rest = word.slice('lanes'.length).trim()
      const shouldWrite = /(^|\s)--write$/.test(rest)
      const typed = rest.replace(/(^|\s)--(write|dry)$/, '').trim()
      const runs = (await loadBook($)).runs
      const path =
        typed !== ''
          ? await fullPath($, typed)
          : (currentOf(await loadBook($))?.doc?.path ?? [...runs].reverse().find(one => one.doc !== undefined)?.doc?.path)

      return {
        text:
          path === undefined
            ? 'Ledger: name the plan document: /ledger lanes docs/superpowers/plans/my-plan.md'
            : await laneDoc($, path, shouldWrite),
      }
    }

    if (word === 'tick' || word === 'tick --dry') {
      const isDry = word.endsWith('--dry')
      const docs = (await loadBook($)).runs.flatMap(one => (one.doc === undefined ? [] : [one.doc.path]))

      if (docs.length === 0) {
        return { text: 'Ledger: no run is read from a plan document.' }
      }

      const counts: string[] = []

      for (const path of docs) {
        counts.push(`${await tickDoc($, path, isDry).catch(() => 0)} in ${path}`)
      }

      return { text: `Ledger: ${isDry ? 'would tick' : 'ticked'} ${counts.join(', ')}.` }
    }

    if (word === 'clear') {
      const changed = await change($, () => null)

      return { text: 'error' in changed ? changed.error : 'Ledger: the run is cleared.' }
    }

    await sync($)

    const book = await loadBook($)
    const now = currentOf(book)

    if (word === 'print') {
      return { text: now === null ? NOTHING : report(now) }
    }

    // The ledgers of other sessions, of this folder and of others: asked for
    // by name, and what there is to show when this session has planned nothing.
    const index = await loadIndex($)
    const asksSessions = word === 'sessions' || word === 'session'

    if (book.runs.length === 0 && index.length === 0) {
      return { text: NOTHING }
    }

    await update($, others, () => index)
    await update($, peek, () => null)
    // On the current run while it is under way; else on the list of runs.
    await update($, shown, () =>
      asksSessions || book.runs.length === 0 ? -1 : now !== null && now.doneAt === undefined ? now.id : 0,
    )
    await update($, confirming, () => 0)
    await show($, book)
    await $.ui.open({ id: PANE, title: 'Ledger', focus: true, closeOnEscape: true })

    return {
      text:
        book.runs.length === 0 && !asksSessions
          ? 'Ledger: nothing is planned in this session. The pane lists the ledgers of other sessions.'
          : 'Ledger pane opened.',
    }
  })

  // The list's done, clear and use act on the row the focus ring is on.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    const id = /^run-(\d+)$/.exec(e.element ?? '')?.[1]

    if (id !== undefined) {
      await update($, cursor, () => Number(id))
    }

    const finding = /^finding-(\d+)$/.exec(e.element ?? '')?.[1]

    if (finding !== undefined) {
      await update($, pointed, () => Number(finding))
    }

    return moved
  })

  // A node of the pipeline was clicked: its task is the one shown. What a
  // region posts is code's word, so the id is taken only where a run under
  // the pane has that task.
  on('ui.message', async ($, e, next) => {
    const heard = await next(e)

    if (e.requestId === PANE && e.element === STRIP) {
      const id = (typeof e.data === 'object' && e.data !== null ? (e.data as Record<string, unknown>).pick : undefined) ?? ''
      const shownRuns = (await read($, peek))?.runs ?? (await read($, runs))

      const to = typeof e.data === 'object' && e.data !== null ? (e.data as Record<string, unknown>).open : undefined

      if (typeof id === 'string' && shownRuns.some(one => one.tasks.some(task => task.id === id))) {
        await update($, picked, () => id)
      } else if (typeof to === 'number' && shownRuns.some(one => one.id === to)) {
        // The run that comes next was clicked: it is the one shown.
        await update($, picked, () => '')
        await update($, shown, () => to)
      }
    }

    return heard
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // A region drawn by a module of its own, which takes the pointer: only
    // some surfaces have such.
    const Client = 'Client' in elements ? elements.Client : undefined
    // What is drawn is narrower than the pane by the padding at each side, and
    // never wider than it, however narrow the pane is.
    const columns = Math.max(12, (e.props.bodyColumns ?? e.viewport?.columns ?? 60) - 2 * PAD)
    const isNarrow = columns < 56
    const rule = '─'.repeat(columns)
    // Another session's ledger is shown as it was read: nothing in it changes.
    const peeked = await read($, peek)
    const all = peeked?.runs ?? (await read($, runs))
    const openId = await read($, shown)
    const now = all.find(one => one.id === openId)
    const at = await $.clock.now()
    const current = peeked === null ? ((await read($, run))?.id ?? 0) : 0
    const isLive = (one: LedgerRun) =>
      one.doneAt === undefined &&
      (one.spawns.some(spawn => spawn.endedAt === undefined) ||
        one.tasks.some(task => task.status === 'running' && !isStalled(one, task, at)))
    // Reading the frame subscribes the drawing only while a subagent runs, so
    // an idle pane stays still.
    const mark =
      peeked === null && all.some(isLive)
        ? ([...SPINNER][(await read($, spin)) % SPINNER.length] ?? NODES.running)
        : NODES.running
    const toSessions = async () => {
      const index = await loadIndex($)

      await update($, others, () => index)
      await update($, confirming, () => 0)
      await update($, shown, () => -1)
      await refresh($)
    }
    const toHome = async () => {
      await update($, peek, () => null)
      await update($, shown, () => 0)
      await refresh($)
    }
    const whose =
      peeked === null ? null : (
        <Box justifyContent="space-between">
          <Text dimColor wrap="truncate-start">
            {folderOf(peeked.cwd)} · {peeked.id.slice(0, 8)}
          </Text>
          <Text color="warning"> read only</Text>
        </Box>
      )

    // The sessions that have a ledger: those of this folder first.
    if (openId === -1) {
      const here = await read($, home)
      const cwd = await $.session.cwd()
      const rows = sessionsListed(await read($, others), cwd).slice(0, SESSIONS_SHOWN)
      // Reading the frame subscribes the list only while a session is at work.
      const turning = rows.some(one => one.busy === true && at - one.at < STALE_MS)
        ? ([...SPINNER][(await read($, spin)) % SPINNER.length] ?? NODES.running)
        : NODES.running

      return (
        <Box flexDirection="column" paddingX={PAD} paddingTop={1}>
          <Box justifyContent="space-between">
            <Text bold wrap="truncate-end">
              <Text color="cyan">{ICON.tasks} </Text>Ledger sessions
            </Text>
            <Text dimColor> {rows.length}</Text>
          </Box>
          <Text dimColor>{rule}</Text>
          {rows.length === 0 ? <Text dimColor>No session has a ledger yet.</Text> : null}
          {rows.map((one, index) => {
            const isHere = one.id === here
            const meta = `${one.cwd === cwd || isNarrow ? '' : `${cut(folderOf(one.cwd), 16)} · `}${one.runs - one.open}/${one.runs} · ${ageOf(one.at, at)}`

            return (
              <Box justifyContent="space-between">
                <Box>
                  {/* At work when it last changed: the turning mark. Runs
                      open with nothing running: a ring. Every run done: a dot. */}
                  <Text color={one.busy === true && at - one.at >= STALE_MS ? 'warning' : one.open > 0 ? 'cyan' : 'success'}>
                    {one.busy !== true
                      ? one.open > 0
                        ? NODES.todo
                        : NODES.done
                      : at - one.at >= STALE_MS
                        ? STALLED
                        : turning}{' '}
                  </Text>
                  <Button
                    key={`session-${index}`}
                    plain
                    {...(index < 9 ? { hotkey: String(index + 1) } : {})}
                    {...(index === 0 ? { autoFocus: true as const } : {})}
                    dimColor={one.open === 0}
                    label={cut(
                      one.goal === '' ? `session ${one.id.slice(0, 8)}` : one.goal,
                      Math.max(6, columns - meta.length - 9),
                    )}
                    onPress={async () => {
                      if (isHere) {
                        await toHome()

                        return
                      }

                      const stored = await $.store.get(bookKey(one.id))

                      if (!isBook(stored)) {
                        $.ui.toast('Ledger: that session’s ledger is gone.')

                        return
                      }

                      await update($, peek, () => ({ id: one.id, cwd: one.cwd, runs: stored.runs }))
                      // A session with every run done would list nothing.
                      await update($, isAll, value => value || stored.runs.every(kept => kept.doneAt !== undefined))
                      await update($, cursor, () => 0)
                      await update($, shown, () => 0)
                      await refresh($)
                    }}
                  />
                  {isHere ? <Text color="cyan"> ●</Text> : null}
                </Box>
                <Text dimColor> {meta}</Text>
              </Box>
            )
          })}
          <Text dimColor>{rule}</Text>
          <Button key="home" plain dimColor hotkey="h" label="this session" onPress={toHome} />
        </Box>
      )
    }

    // The list: every run of the session, those not done first.
    if (now === undefined) {
      const withDone = await read($, isAll)
      const rows = listed({ nextId: 0, current, runs: all }, withDone)
      const doneCount = all.filter(one => one.doneAt !== undefined).length
      const focused = await read($, cursor)
      const here = rows.some(one => one.id === focused) ? focused : (rows[0]?.id ?? 0)
      const picked = peeked === null ? rows.find(one => one.id === here) : undefined
      const asking = peeked === null ? await read($, confirming) : 0

      return (
        <Box flexDirection="column" paddingX={PAD} paddingTop={1}>
          <Box justifyContent="space-between">
            <Text bold>
              <Text color="cyan">{ICON.tasks} </Text>Ledger
            </Text>
            <Text dimColor>
              {all.length - doneCount} open · {doneCount} done
            </Text>
          </Box>
          {whose}
          <Text dimColor>{rule}</Text>
          {rows.length === 0 && (
            <Text dimColor>{all.length === 0 ? 'Nothing planned yet.' : 'Every run is done.'}</Text>
          )}
          {rows.map((one, index) => {
            const isOver = one.doneAt !== undefined
            const tally = countsOf(one)
            const tone = isOver ? 'success' : tally.failed > 0 ? 'error' : 'cyan'
            const glyph = isOver ? ICON.done : isLive(one) ? mark : tally.failed > 0 ? ICON.failed : ICON.todo
            // A narrow pane keeps the count alone beside the goal.
            const marks = isNarrow
              ? `${tally.done}/${tally.tasks}`
              : `${runMarks(one)} · ${ageOf(one.doneAt ?? one.startedAt, at)}`

            return (
              <Box justifyContent="space-between">
                <Box>
                  <Text color="cyan">{one.id === here ? '▸' : ' '}</Text>
                  <Text color={tone}>
                    {glyph}{' '}
                  </Text>
                  <Button
                    key={`run-${one.id}`}
                    plain
                    {...(index < 9 ? { hotkey: String(index + 1) } : {})}
                    {...(one.id === here ? { autoFocus: true as const } : {})}
                    dimColor={isOver}
                    label={cut(one.goal === '' ? `Run ${one.id}` : one.goal, Math.max(6, columns - marks.length - 10))}
                    onPress={async () => {
                      await update($, confirming, () => 0)
                      await update($, shown, () => one.id)
                    }}
                  />
                </Box>
                <Text dimColor> {marks}</Text>
              </Box>
            )
          })}
          <Text dimColor>{rule}</Text>
          {asking !== 0 ? (
            <Box columnGap={2} flexWrap="wrap">
              <Text color="warning">Clear run {asking} for good?</Text>
              <Button
                key="yes"
                plain
                hotkey="y"
                label="yes"
                onPress={async () => {
                  await changeBook($, book => cleared(book, asking))
                  await update($, confirming, () => 0)
                }}
              />
              <Button key="no" plain hotkey="n" label="no" onPress={() => update($, confirming, () => 0)} />
            </Box>
          ) : (
            <Box columnGap={2} flexWrap="wrap">
              {picked === undefined ? null : (
                <Button
                  key="done"
                  plain
                  dimColor
                  hotkey="d"
                  label={picked.isClosed === true ? 'reopen' : 'done'}
                  onPress={async () => {
                    await changeBook($, (book, when) => closed(book, picked.id, picked.isClosed !== true, when))
                  }}
                />
              )}
              {picked === undefined ? null : (
                <Button key="clear" plain dimColor hotkey="x" label="clear" onPress={() => update($, confirming, () => picked.id)} />
              )}
              <Button
                key="all"
                plain
                dimColor
                hotkey="a"
                label={withDone ? 'open only' : 'all'}
                onPress={() => update($, isAll, value => !value)}
              />
              <Button key="sessions" plain dimColor hotkey="s" label="sessions" onPress={toSessions} />
              {peeked === null ? null : (
                <Button key="home" plain dimColor hotkey="h" label="this session" onPress={toHome} />
              )}
            </Box>
          )}
        </Box>
      )
    }

    // One run, drawn as a pipeline: across the top its stages as nodes on a
    // line, where that fits; under it the same line running down, a node a
    // task, a fork's lanes side by side. Marks and numbers say how each task
    // stands, and words are kept for what is wrong. Details add what each part
    // is for, what was done, and what is finished or fixed.
    const detailed = await read($, isDetailed)
    const counts = countsOf(now)
    const openFindings = now.findings.filter(one => one.status === 'open')
    const fixedFindings = now.findings.filter(one => one.status === 'fixed')
    const findings = [...openFindings, ...(detailed ? fixedFindings : [])]
    const lanes = lanesOf(now)
    const units = unitsOf(now)
    // What stands at the two ends of the run's line: the run before it and the
    // run after it among those not done, in the order they were planned; and
    // where there is none, the line's start and its end.
    const waiting = all.filter(one => one.doneAt === undefined && one.id !== now.id).sort((a, b) => a.id - b.id)
    const prevRun = waiting.filter(one => one.id < now.id).at(-1)
    const nextRun = waiting.find(one => one.id > now.id)
    const nameOfRun = (one: LedgerRun) => (one.goal === '' ? `Run ${one.id}` : one.goal)
    const headMark = prevRun === undefined ? '◆' : '◁'
    const tailMark = nextRun === undefined ? '◆' : '▷'
    // Their words give way to the pipeline: cut shorter, then left out, before
    // the pipeline itself is given up for being too wide to draw across.
    const ends = [isNarrow ? 10 : 20, 8, 0].map(most => {
      const head = most === 0 ? '' : prevRun === undefined ? 'start' : cut(nameOfRun(prevRun), most)
      const tail = most === 0 ? '' : nextRun === undefined ? 'end' : cut(nameOfRun(nextRun), most)
      // A mark, its words between two spaces, and a cell of line; and after
      // the last task, a mark and its words.
      const room = columns - (head === '' ? 2 : head.length + 4) - (tail === '' ? 1 : tail.length + 2)

      return { head, tail, strip: stripOf(now, room, true) }
    })
    const { head: headWords, tail: tailWords, strip } = ends.find(one => one.strip !== undefined) ?? { head: '', tail: '', strip: undefined }
    // The finding "open" shows in lens: the one the focus is on, else the first.
    const focusedFinding = await read($, pointed)
    const target = peeked === null ? (findings.find(one => one.id === focusedFinding) ?? findings[0]) : undefined
    const loose = now.spawns.filter(one => one.task === undefined && (detailed || one.endedAt === undefined))
    const liveOf = (task: LedgerTask) =>
      now.spawns.find(spawn => spawn.task === task.id && spawn.endedAt === undefined)
    // A task's node: the mark of its state, turning while a subagent works on it.
    const nodeOf = (task: LedgerTask) =>
      isStalled(now, task, at)
        ? // Marked running, and nothing has touched it for an hour.
          { glyph: STALLED, color: 'warning' as const, isDim: false }
        : liveOf(task) !== undefined || task.status === 'running'
          ? { glyph: mark, color: 'cyan' as const, isDim: false }
        : { glyph: NODES[task.status], color: TASK_TONES[task.status], isDim: task.status === 'todo' }
    // A line of a task's details, beside the lines that run past it.
    const beside = (rail: string, line: JSX.Element) => (
      <Box>
        <Box flexShrink={0}>
          <Text dimColor>
            {rail}
            {BESIDE}
          </Text>
        </Box>
        {line}
      </Box>
    )
    // The pipeline drawn down takes more of a wide pane: its rails stand
    // further apart, and the words beside them keep at least two thirds.
    const gap = gapFor(now, columns)
    // A text beside the rails, broken into lines here so that the rails run
    // past every one of them; a wrapped line would leave them behind.
    const lines = (rail: string, text: string, isDim: boolean) =>
      wrapped(text, columns - rail.length - BESIDE.length).map(line =>
        beside(rail, <Text dimColor={isDim}>{line}</Text>),
      )
    // A finding's summary goes under its place where the two do not fit a line.
    const isStacked = detailed || isNarrow
    // Two views of one run. The overview is the pipeline across, as a CI run
    // is drawn, with words only for what is running or has failed (or, with
    // neither, what comes next). Details is the pipeline down, a line a task.
    // A pipeline too wide to draw across is drawn down in both.
    const isDown = detailed || strip === undefined
    const stirring = now.tasks.filter(
      one => liveOf(one) !== undefined || one.status === 'running' || one.status === 'gate-failed',
    )
    // What a task cost so far: the models its subagents ran on (the tier it
    // was meant for, with none yet), how many there were, how long they worked
    // in all, and the tokens they used.
    const costOf = (task: LedgerTask): string => {
      const spawns = now.spawns.filter(spawn => spawn.task === task.id)
      const models = [...new Set(spawns.map(spawn => spawn.model).filter(Boolean))]
      const worked = spawns.reduce((sum, spawn) => sum + ((spawn.endedAt ?? at) - spawn.startedAt), 0)
      const used = spawns.reduce((sum, spawn) => sum + (spawn.tokens ?? 0), 0)

      return [
        models.length > 0 ? models.join(', ') : (task.tier ?? ''),
        spawns.length > 0 ? `${spawns.length} agent${spawns.length === 1 ? '' : 's'}` : '',
        spawns.length > 0 ? spanText(worked) : '',
        used > 0 ? tokensText(used) : '',
      ]
        .filter(Boolean)
        .join(' · ')
    }
    // The overview shows one task in full under the pipeline, its node marked
    // there: the one picked with the keys, else the one work is on (or, with
    // nothing started, the one that comes next). The other tasks running or
    // failed keep a line each.
    const pickedId = await read($, picked)
    const isPicked = now.tasks.some(one => one.id === pickedId)
    const chosen = isDown ? undefined : (now.tasks.find(one => one.id === pickedId) ?? focusOf(now))
    const worded = isDown ? [] : stirring.filter(one => one.id !== chosen?.id)
    const chosenFindings = openFindings.filter(one => chosen !== undefined && one.task === chosen.id)
    // What the last subagent on the task said as it ended: the nearest thing
    // the ledger has to its log.
    const chosenReport = now.spawns.filter(one => chosen !== undefined && one.task === chosen.id && one.report !== undefined).at(-1)
      ?.report
    // The pipeline across, piece by piece as it is drawn: a node in the colour
    // of its task's state, the one shown marked; its id on the line after it,
    // where the line is long enough to carry it; and the lines between, dim.
    const pieces: StripPiece[][] = (isDown ? [] : (strip ?? [])).map(line =>
      line.flatMap((cell, index): StripPiece[] => {
        const before = line[index - 1]?.task

        if (cell.task === undefined) {
          const label = before === undefined ? '' : ` ${before.id} `

          return label !== '' && /^─+$/.test(cell.text) && cell.text.length > label.length
            ? [
                {
                  text: label,
                  id: before?.id ?? '',
                  isBold: before?.id === chosen?.id,
                  isDim: before?.id !== chosen?.id,
                },
                { text: cell.text.slice(label.length), isDim: true },
              ]
            : [{ text: cell.text, isDim: true }]
        }

        const node = nodeOf(cell.task)
        const isChosen = cell.task.id === chosen?.id

        return [
          { text: node.glyph, id: cell.task.id, color: node.color, isDim: node.isDim && !isChosen, isInverse: isChosen },
          // The last node has no line after it for its id.
          ...(index === line.length - 1 && columns > 40 ? [{ text: ` ${cell.task.id}`, id: cell.task.id, isDim: true }] : []),
        ]
      }),
    )
    // Before the first task and after the last, on the line they are on: the
    // mark of what is there and its words. A run there is pointed at as a node
    // is, and opens. The lines under the first are moved over to stay in step.
    const endPieces = (mark: string, words: string, to: LedgerRun | undefined): StripPiece[] => [
      { text: mark, ...(to === undefined ? { isDim: true } : { color: 'cyan', run: to.id }) },
      ...(words === '' ? [] : [{ text: ` ${words}`, isDim: true, ...(to === undefined ? {} : { run: to.id }) }]),
    ]
    const headPieces: StripPiece[] = [
      ...endPieces(headMark, headWords, prevRun),
      { text: headWords === '' ? '─' : ' ─', isDim: true },
    ]
    const headWide = headPieces.reduce((sum, one) => sum + one.text.length, 0)

    pieces.forEach((line, index) => {
      if (index === 0) {
        line.unshift(...headPieces)
        line.push(...endPieces(tailMark, tailWords, nextRun))
      } else {
        line.unshift({ text: ' '.repeat(headWide) })
      }
    })

    const pick = (by: number) => async () => {
      const from = chosen === undefined ? -1 : now.tasks.findIndex(one => one.id === chosen.id)
      const to = now.tasks[(from + by + now.tasks.length) % now.tasks.length]

      if (to !== undefined) {
        await update($, picked, () => to.id)
      }
    }

    return (
      <Box flexDirection="column" paddingX={PAD} paddingTop={1}>
        <Box justifyContent="space-between">
          <Text bold wrap="truncate-end">
            <Text color="cyan">{ICON.tasks} </Text>
            {now.goal === '' ? `Run ${now.id}` : now.goal}
          </Text>
          <Text dimColor>
            {' '}
            {counts.done}/{counts.tasks}
            {counts.tokens > 0 && !isNarrow ? ` · ${tokensText(counts.tokens)}` : ''}
          </Text>
        </Box>
        {whose}
        {now.doc === undefined ? null : (
          <Text dimColor wrap="truncate-start">
            {now.doc.path}
          </Text>
        )}
        <Text dimColor>{rule}</Text>
        {/* The pipeline across. Where the surface has regions that take the
            pointer it is one, so a click on a node picks its task; elsewhere
            it is drawn as text, and the keys walk it. */}
        {isDown || strip === undefined ? null : Client !== undefined ? (
          <Box marginBottom={worded.length > 0 ? 1 : 0}>
            <Client key={STRIP} module="./strip.tsx" props={{ lines: pieces }} height={pieces.length} width="100%" />
          </Box>
        ) : (
          <Box flexDirection="column" marginBottom={worded.length > 0 ? 1 : 0}>
            {pieces.map(line => (
              <Text wrap="truncate-end">
                {line.map(piece => (
                  <Text
                    {...(piece.color !== undefined ? { color: piece.color } : {})}
                    dimColor={piece.isDim === true}
                    bold={piece.isBold === true}
                    inverse={piece.isInverse === true}
                  >
                    {piece.text}
                  </Text>
                ))}
              </Text>
            ))}
          </Box>
        )}
        {/* The task shown in full, as a CI run shows the job picked in its
            graph: how it stands and where it sits, what it is for or what was
            done, its gate, its steps, what it cost and its open findings. */}
        {chosen === undefined ? null : (
          <Box flexDirection="column" marginBottom={worded.length > 0 ? 1 : 0}>
            <Box justifyContent="space-between">
              <Text bold dimColor>
                {isPicked ? 'Task' : stirring.length === 0 ? 'Next task' : 'Current task'}
              </Text>
              <Text dimColor>
                {' '}
                {now.tasks.findIndex(one => one.id === chosen.id) + 1}/{now.tasks.length}
              </Text>
            </Box>
            <Box justifyContent="space-between">
              <Text wrap="wrap">
                <Text color={nodeOf(chosen).color} dimColor={nodeOf(chosen).isDim}>
                  {nodeOf(chosen).glyph}
                </Text>{' '}
                <Text bold>{chosen.id}</Text> {chosen.title}
              </Text>
              {liveOf(chosen) === undefined ? null : (
                <Text dimColor> {spanText(at - (liveOf(chosen)?.startedAt ?? at))}</Text>
              )}
            </Box>
            <Box paddingLeft={2} flexDirection="column">
              <Text dimColor wrap="truncate-end">
                {[
                  isStalled(now, chosen, at)
                    ? `stalled, no change for ${ageOf(now.changedAt ?? now.startedAt, at)}`
                    : STATUS_WORDS[liveOf(chosen) !== undefined ? 'running' : chosen.status],
                  chosen.lane === undefined ? '' : `lane ${chosen.lane}`,
                  chosen.unit === 'main' ? '' : chosen.unit,
                  stepsText(chosen) === '' ? '' : `steps ${stepsText(chosen)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {chosen.outcome !== undefined ? (
                <Text wrap="wrap">{chosen.outcome}</Text>
              ) : chosen.about !== undefined ? (
                <Text wrap="wrap">{chosen.about}</Text>
              ) : null}
              {chosen.status === 'gate-failed' && chosen.note !== undefined ? (
                <Text wrap="wrap" color="error">
                  gate failed: {chosen.note}
                </Text>
              ) : chosen.check !== undefined ? (
                <Text wrap="wrap" dimColor>
                  gate: {chosen.check}
                </Text>
              ) : null}
              {costOf(chosen) === '' ? null : (
                <Text dimColor wrap="truncate-end">
                  {costOf(chosen)}
                </Text>
              )}
              {chosenReport === undefined
                ? null
                : wrapped(chosenReport, columns - 2)
                    .slice(0, REPORT_LINES)
                    .map((line, index, all) => (
                      <Text dimColor wrap="truncate-end">
                        {index === 0 ? <Text bold>said </Text> : '     '}
                        {line}
                        {index === REPORT_LINES - 1 && all.length === REPORT_LINES ? '…' : ''}
                      </Text>
                    ))}
              {chosenFindings.length === 0 ? null : (
                <Text color={chosenFindings.some(one => one.severity === 'error') ? 'error' : 'warning'} wrap="truncate-end">
                  {ICON.finding} {chosenFindings.length} open:{' '}
                  {chosenFindings.map(one => `#${one.id}`).join(', ')}
                </Text>
              )}
            </Box>
          </Box>
        )}
        {worded.length === 0 ? null : (
          <Text bold dimColor>
            Also under way
          </Text>
        )}
        {worded.map(one => {
          const node = nodeOf(one)
          const live = liveOf(one)

          return (
            <Box justifyContent="space-between">
              <Text wrap="truncate-end">
                <Text color={node.color} dimColor={node.isDim}>
                  {node.glyph}
                </Text>{' '}
                <Text bold>{one.id}</Text> {one.title}
                {one.status === 'gate-failed' && one.note !== undefined ? (
                  <Text color="error">
                    {'  '}
                    {one.note}
                  </Text>
                ) : null}
              </Text>
              {live === undefined ? null : (
                <Text dimColor> {spawnMeta(isNarrow ? { ...live, model: '' } : live, at)}</Text>
              )}
            </Box>
          )
        })}
        {/* Drawn down, the line begins as it does across: with its start, or
            with the run before it, a button that opens that run drawn down too. */}
        {isDown && prevRun === undefined ? (
          <Text wrap="truncate-end">
            <Text dimColor>{headMark}</Text>
            {APART}
            <Text dimColor>start</Text>
          </Text>
        ) : null}
        {isDown && prevRun !== undefined ? (
          <Box>
            <Box flexShrink={0}>
              <Text color="cyan">{UP}</Text>
              <Text>{APART}</Text>
            </Box>
            <Button
              key="prev-run"
              plain
              dimColor
              hotkey="p"
              label={cut(`previous: ${nameOfRun(prevRun)}`, Math.max(6, columns - NEIGHBOUR_TAKEN))}
              onPress={async () => {
                await update($, picked, () => '')
                await update($, shown, () => prevRun.id)
              }}
            />
          </Box>
        ) : null}
        {/* The line from what is before the run down to its first task. */}
        {isDown ? <Text dimColor>│</Text> : null}
        {(isDown ? rowsOf(now, gap, true) : []).map(row => {
          if (row.kind === 'link') {
            return <Text dimColor>{row.rail}</Text>
          }

          // A lane's line comes before its tasks: how the lane stands, with
          // the mark that turns while one of its subagents runs.
          if (row.kind === 'lane') {
            const lane = lanes.find(one => one.name === row.name)

            return (
              <Box justifyContent="space-between">
                <Text wrap="truncate-end">
                  <Text dimColor>{row.lead}</Text>
                  <Text color="cyan">▾</Text>
                  <Text dimColor>{row.trail}</Text>
                  {APART}
                  <Text bold color="cyan">
                    {row.name}
                  </Text>
                  {(lane?.agents ?? 0) > 0 ? ` ${mark}` : ''}
                  {(lane?.failed ?? 0) > 0 ? <Text color="error"> {NODES['gate-failed']}</Text> : null}
                </Text>
                <Text dimColor>
                  {' '}
                  {lane?.done ?? 0}/{lane?.tasks ?? 0}
                </Text>
              </Box>
            )
          }

          if (row.kind === 'unit') {
            const unit = units.find(one => one.name === row.name && one.lane === row.lane)

            return (
              <Box flexDirection="column">
                <Box justifyContent="space-between">
                  <Text wrap="truncate-end">
                    <Text dimColor>{row.rail}</Text>
                    {APART}
                    <Text bold>{row.name}</Text>
                  </Text>
                  <Text dimColor>
                    {' '}
                    {unit?.tasks.filter(one => one.status === 'done').length ?? 0}/{unit?.tasks.length ?? 0}
                  </Text>
                </Box>
                {detailed && unit?.about !== undefined ? lines(row.rail, unit.about, true) : null}
              </Box>
            )
          }

          const one = row.task
          const live = liveOf(one)
          const node = nodeOf(one)
          const tally = costOf(one)
          // What stands at the row's end: a running subagent's model and time
          // (a narrow pane drops the model), else the steps done of all.
          const meta =
            live !== undefined
              ? spawnMeta(isNarrow ? { ...live, model: '' } : live, at)
              : stepsText(one) !== '' && one.status !== 'done'
                ? stepsText(one)
                : ''
          // In details a long title runs on under itself, beside the rails;
          // elsewhere it is cut at the row's end.
          const [head = '', ...more] = detailed
            ? wrapped(
                one.title,
                columns - row.rail.length - APART.length - one.id.length - 1 - (meta === '' ? 0 : meta.length + 1),
              )
            : [one.title]

          return (
            <Box flexDirection="column">
              <Box justifyContent="space-between">
                <Text wrap="truncate-end">
                  <Text dimColor>{row.lead}</Text>
                  <Text color={node.color} dimColor={node.isDim}>
                    {node.glyph}
                  </Text>
                  <Text dimColor>{row.trail}</Text>
                  {APART}
                  <Text bold>{one.id}</Text> {head}
                  {!detailed && one.status === 'gate-failed' && one.note !== undefined ? (
                    <Text color="error">
                      {'  '}
                      {one.note}
                    </Text>
                  ) : null}
                </Text>
                {meta === '' ? null : <Text dimColor> {meta}</Text>}
              </Box>
              {more.map(line => (
                <Text>
                  <Text dimColor>{row.rail}</Text>
                  {APART}
                  {' '.repeat(one.id.length + 1)}
                  {line}
                </Text>
              ))}
              {detailed && one.status === 'gate-failed' && one.note !== undefined
                ? wrapped(`gate failed: ${one.note}`, columns - row.rail.length - BESIDE.length).map(line =>
                    beside(row.rail, <Text color="error">{line}</Text>),
                  )
                : null}
              {detailed
                ? (one.steps ?? []).map(step =>
                    beside(
                      row.rail,
                      <Text wrap="truncate-end" dimColor={step.isDone}>
                        <Text color={step.isDone ? 'success' : 'gray'}>{step.isDone ? ICON.done : ICON.todo} </Text>
                        {step.text}
                      </Text>,
                    ),
                  )
                : null}
              {detailed && one.outcome !== undefined
                ? lines(row.rail, one.outcome, false)
                : detailed && one.about !== undefined
                  ? lines(row.rail, one.about, true)
                  : null}
              {detailed && one.status !== 'gate-failed' && one.note !== undefined
                ? lines(row.rail, `gate: ${one.note}`, true)
                : null}
              {detailed && tally !== ''
                ? beside(
                    row.rail,
                    <Text dimColor wrap="truncate-end">
                      {tally}
                    </Text>,
                  )
                : null}
            </Box>
          )
        })}
        {/* Drawn down, the line ends the same way: what comes next, or its end. */}
        {/* And from its last task down to what is after it. */}
        {isDown ? <Text dimColor>│</Text> : null}
        {isDown && nextRun === undefined ? (
          <Text wrap="truncate-end">
            <Text dimColor>{tailMark}</Text>
            {APART}
            <Text dimColor>end</Text>
          </Text>
        ) : null}
        {/* The run that comes next is a button: pressed, it is the one shown,
            drawn down as this one is. */}
        {isDown && nextRun !== undefined ? (
          <Box>
            <Box flexShrink={0}>
              <Text color="cyan">{DOWN}</Text>
              <Text>{APART}</Text>
            </Box>
            <Button
              key="next-run"
              plain
              dimColor
              hotkey="n"
              label={cut(`next: ${nameOfRun(nextRun)}`, Math.max(6, columns - NEIGHBOUR_TAKEN))}
              onPress={async () => {
                await update($, picked, () => '')
                await update($, shown, () => nextRun.id)
              }}
            />
          </Box>
        ) : null}
        {loose.length > 0 ? <Text dimColor>other agents</Text> : null}
        {loose.map(one => (
          <Box justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color={one.endedAt === undefined ? 'cyan' : 'success'}>
                {one.endedAt === undefined ? mark : NODES.done}{' '}
              </Text>
              {one.description}
            </Text>
            <Text dimColor> {spawnMeta(isNarrow ? { ...one, model: '' } : one, at)}</Text>
          </Box>
        ))}
        {/* A rule parts the pipeline from the findings under it. */}
        {findings.length > 0 ? <Text dimColor>{rule}</Text> : null}
        {findings.length > 0 ? (
          <Box>
            <Text bold>
              <Text color={counts.errors > 0 ? 'error' : 'warning'}>{ICON.finding} </Text>
              {openFindings.length} open
            </Text>
            {detailed && fixedFindings.length > 0 ? <Text dimColor> · {fixedFindings.length} fixed</Text> : null}
          </Box>
        ) : null}
        {findings.map((one, index) => {
          const icon = refIcon(one.path)
          const isOpen = one.status === 'open'
          const hasHotkey = index < 9 && isOpen
          // What the row's marks and the hotkey take before the place starts.
          const taken = 4 + (hasHotkey ? 3 : 0)
          const room = Math.max(6, columns - taken)

          return (
            <Box flexDirection="column">
              <Box>
                <Box flexShrink={0}>
                  <Text color={isOpen ? SEVERITY_TONES[one.severity] : 'success'}>
                    {isOpen ? ICON.finding : ICON.done}{' '}
                  </Text>
                  <Text color={icon.color}>{icon.glyph} </Text>
                  {/* The place keeps its end, the file's name and line, and
                      leaves the summary half the line where both share one. */}
                  <Button
                    key={`finding-${one.id}`}
                    plain
                    {...(hasHotkey ? { hotkey: String(index + 1) } : {})}
                    {...(index === 0 ? { autoFocus: true as const } : {})}
                    dimColor={!isOpen}
                    label={tail(placeOf(one), isStacked ? room : Math.max(6, Math.floor(room / 2)))}
                    onPress={() => toPrompt($, findingText(one))}
                  />
                </Box>
                {isStacked ? null : (
                  <Text wrap="truncate-end" dimColor={!isOpen}>
                    {'  '}
                    {one.summary}
                  </Text>
                )}
              </Box>
              {isStacked ? (
                <Box paddingLeft={isNarrow ? 2 : 4}>
                  <Text wrap="wrap" dimColor={!isOpen}>
                    {one.summary}
                    {one.task === undefined ? '' : ` (${one.task})`}
                  </Text>
                </Box>
              ) : null}
            </Box>
          )
        })}
        <Text dimColor>{rule}</Text>
        <Box columnGap={2} flexWrap="wrap">
          <Button
            key="back"
            plain
            dimColor
            hotkey="b"
            label="list"
            onPress={async () => {
              await update($, cursor, () => now.id)
              await update($, shown, () => 0)
            }}
          />
          <Button
            key="details"
            plain
            dimColor
            hotkey="e"
            label={detailed ? 'overview' : 'details'}
            onPress={() => update($, isDetailed, value => !value)}
          />
          {/* Walks the pipeline's nodes: the task under the mark is shown. */}
          {chosen === undefined ? null : (
            <Button key="prev" plain dimColor hotkey="p" label="prev" onPress={pick(-1)} />
          )}
          {chosen === undefined ? null : (
            <Button key="next" plain dimColor hotkey="n" label="next" onPress={pick(1)} />
          )}
          {isPicked && chosen !== undefined ? (
            <Button key="current" plain dimColor hotkey="c" label="current" onPress={() => update($, picked, () => '')} />
          ) : null}
          {target === undefined ? null : (
            <Button
              key="go"
              plain
              dimColor
              hotkey="g"
              label="open"
              onPress={async () => {
                await update($, jump, last => ({
                  path: target.path,
                  line: target.line ?? 0,
                  n: (last?.n ?? 0) + 1,
                }))
                $.ui.toast(`Ledger: ${placeOf(target)} asked of lens`)
              }}
            />
          )}
          {openFindings.length > 0 && !isNarrow ? <Text dimColor>1-9 to prompt</Text> : null}
        </Box>
      </Box>
    )
  })
}
