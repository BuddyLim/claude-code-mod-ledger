import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LedgerRun } from '../types'
import { PLAN_PATH, outlineOf, outlineRequest, parsePlan, planFromOutline, runFromDoc, ticked } from './doc'
import type { PlanDoc } from './doc'
import { ICON, refIcon } from './kit/icons'
import type { Book } from './book'
import {
  bookOf,
  busyOf,
  clash,
  cleared,
  closed,
  currentOf,
  isBook,
  listed,
  nextFinding,
  ownerOf,
  put,
  runMarks,
  runOfAgent,
  bookStatus,
  runOfFinding,
  settled,
  underWay,
} from './book'
import { PAD, ageOf, cut } from './kit/layout'
import {
  SEVERITIES,
  STATUSES,
  countsOf,
  lanesOf,
  ended,
  findingText,
  placeOf,
  spawnMeta,
  stepsText,
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
// Every run kept for the project, for the pane's list.
const runs = atom({ plugin: 'ledger', key: 'runs' } as const, [])
// The pane: the run it shows in full (0 for the list), the list's row the
// focus is on, whether a run shows its details, and the run a clear is waiting
// to be confirmed for (0 for none).
const shown = atom({ plugin: 'ledger', key: 'shown' } as const, 0)
const cursor = atom({ plugin: 'ledger', key: 'cursor' } as const, 0)
const isDetailed = atom({ plugin: 'ledger', key: 'isDetailed' } as const, false)
const confirming = atom({ plugin: 'ledger', key: 'confirming' } as const, 0)
// The frame of the mark that turns beside a running subagent.
const spin = atom({ plugin: 'ledger', key: 'spin' } as const, 0)
// The finding the focus ring is on in a run's view, and the place last asked
// to be shown: the lens mod, where loaded, opens it.
const pointed = atom({ plugin: 'ledger', key: 'pointed' } as const, 0)
const jump = atom({ plugin: 'ledger', key: 'jump' } as const, null)

const PANE = 'ledger'
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const SPIN_MS = 150

const TASK_ICONS = {
  todo: ICON.todo,
  running: ICON.running,
  'gate-failed': ICON.failed,
  done: ICON.done,
} as const
const TASK_TONES = { todo: 'gray', running: 'cyan', 'gate-failed': 'error', done: 'success' } as const
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

- Before delegating a settled plan, call ${PLAN} once: the goal, each task (id, lane where the plan has parallel lanes, unit, title, a one-line "about", tier, gate check) and a one-line "about" per unit. It starts a new run and keeps earlier ones, so give its tasks ids no run under way uses.
- Where a run is already read from a plan document (its report says "Plan:"), do not plan it again: its tasks are T1, T2, ... as the document numbers them.
- Begin each subagent's description with its task id in brackets: "[T3] add the retry".
- After gates, call ${TASK} once with every task that changed: "done" with a one-line outcome (what changed, in which files), or "gate-failed" with a one-line note.
- Tell reviewers to record all their findings in one ${FINDING} call and to answer with the count only, not the findings again. Close findings with ${FIXED}.
- Make ledger calls in the same step as your other tool calls, never as a step of their own.
- For a status update, or when resuming, read ${REPORT} and answer from it.`

const SUBAGENT_REFUSAL =
  'Only the main agent changes the plan and its tasks. Report findings with the finding tool, and the rest in your final answer.'

const keyOf = async ($: EngineInterface) => `runs:${await $.session.cwd()}`
// Where the one run of a project was kept before runs were kept together.
const oldKeyOf = async ($: EngineInterface) => `run:${await $.session.cwd()}`

const loadBook = async ($: EngineInterface): Promise<Book> => {
  const stored = await $.store.get(await keyOf($))

  return isBook(stored) ? stored : bookOf(stored, await $.store.get(await oldKeyOf($)))
}

// The current run: the one the tools record against.
const load = async ($: EngineInterface): Promise<LedgerRun | null> => currentOf(await loadBook($))

// The mark that turns beside a running subagent: a timer moves its frame
// while any subagent runs, and stops when none does.
let spinTimer: { cancel: () => void } | undefined

const spinWhile = ($: EngineInterface, isBusy: boolean) => {
  if (isBusy && spinTimer === undefined) {
    spinTimer = $.clock.every(SPIN_MS, () => {
      void update($, spin, frame => (frame + 1) % SPINNER.length)
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
  spinWhile($, busyOf(book) > 0)
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
    const after = apply(await loadBook($), await $.clock.now())

    if (typeof after === 'string') {
      return { error: after }
    }

    await $.store.set(await keyOf($), after)
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

// Ticks, in a run's plan document, the open boxes under each task the run has
// as done; `isDry` only counts them. Answers how many.
const tickDoc = async ($: EngineInterface, path: string, isDry: boolean): Promise<number> => {
  const plan = await readPlan($, path)
  const owner = (await loadBook($)).runs.find(one => one.doc?.path === path)

  if (plan === undefined || owner === undefined) {
    return 0
  }

  const after = ticked(plan.text, plan.doc, owner)

  if (after.count > 0 && !isDry) {
    await $.fs.write(path, after.text)
    await followDoc($, path)
  }

  return after.count
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

// The subagents whose last turn has ended, so a tool call from one is seen as
// it resuming; and the ends that arrived before their spawn was recorded.
const over = new Set<string>()
const earlyEnds = new Map<string, { reason: string; tokens: number | undefined; at: number }>()

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

    tasks.push({
      id,
      title,
      ...(lane !== undefined ? { lane } : {}),
      ...(unit !== undefined ? { unit } : {}),
      ...(tier !== undefined ? { tier } : {}),
      ...(check !== undefined ? { check } : {}),
      ...(about !== undefined ? { about } : {}),
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
      description: 'Show the run: /ledger [hide | show | clear]',
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
      description: 'Record the state of every task that changed, in one call: done, or gate-failed.',
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
                note: { type: 'string', description: 'With gate-failed: one line on what failed' },
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
      // A run another session planned is kept, but its agents ended with it.
      const sessionId = await $.session.id()
      await changeBook($, (book, at) => ({
        ...book,
        runs: book.runs.map(one =>
          one.sessionId !== sessionId ? settled({ ...orphaned(one, at), sessionId }, at) : one,
        ),
      }))
      await refresh($)

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

    // A task done in a run read from a plan document: the boxes under it that
    // were missed are ticked there.
    if (ticks && updates.some(one => one.status === 'done')) {
      for (const one of changed.book.runs) {
        if (one.doc !== undefined && updates.some(update => one.tasks.some(task => task.id === update.id))) {
          await tickDoc($, one.doc.path, false).catch(() => 0)
        }
      }
    }

    return { result: updates.map(one => `${one.id} ${one.status}`).join(', ') }
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
      await changeBook($, (book, at) => {
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
          early === undefined ? record : ended(record, agentId, early.reason, early.tokens, early.at),
          at,
        )
      })
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
      await changeBook($, (book, at) => {
        const home = runOfAgent(book, agentId)

        if (home === undefined) {
          // Its spawn is not recorded yet, or no run was under way.
          if (underWay(book).length > 0) {
            earlyEnds.set(agentId, { reason, tokens, at })
          }

          return book
        }

        over.add(agentId)

        return put(book, ended(home, agentId, reason, tokens, at), at)
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

    const book = await loadBook($)
    const now = currentOf(book)

    if (word === 'print') {
      return { text: now === null ? NOTHING : report(now) }
    }

    if (book.runs.length === 0) {
      return { text: NOTHING }
    }

    await show($, book)
    // On the current run while it is under way; else on the list of runs.
    await update($, shown, () => (now !== null && now.doneAt === undefined ? now.id : 0))
    await update($, confirming, () => 0)
    await $.ui.open({ id: PANE, title: 'Ledger', focus: true, closeOnEscape: true })

    return { text: 'Ledger pane opened.' }
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    // What is drawn is narrower than the pane by the padding at each side.
    const columns = Math.max(30, (e.props.bodyColumns ?? e.viewport?.columns ?? 60) - 2 * PAD)
    const rule = '─'.repeat(columns)
    const all = await read($, runs)
    const openId = await read($, shown)
    const now = all.find(one => one.id === openId)
    const at = await $.clock.now()
    const current = (await read($, run))?.id ?? 0
    const isLive = (one: LedgerRun) =>
      one.doneAt === undefined && one.spawns.some(spawn => spawn.endedAt === undefined)
    // Reading the frame subscribes the drawing only while a subagent runs, so
    // an idle pane stays still.
    const mark = all.some(isLive) ? ([...SPINNER][(await read($, spin)) % SPINNER.length] ?? '') : ''

    // The list: every run of the project, those not done first.
    if (now === undefined) {
      const withDone = await read($, isAll)
      const rows = listed({ nextId: 0, current, runs: all }, withDone)
      const doneCount = all.filter(one => one.doneAt !== undefined).length
      const focused = await read($, cursor)
      const here = rows.some(one => one.id === focused) ? focused : (rows[0]?.id ?? 0)
      const picked = rows.find(one => one.id === here)
      const asking = await read($, confirming)

      return (
        <Box flexDirection="column" paddingX={PAD}>
          <Box justifyContent="space-between">
            <Text bold>
              <Text color="cyan">{ICON.tasks} </Text>Ledger
            </Text>
            <Text dimColor>
              {all.length - doneCount} open · {doneCount} done
            </Text>
          </Box>
          <Text dimColor>{rule}</Text>
          {rows.length === 0 && (
            <Text dimColor>{all.length === 0 ? 'Nothing planned yet.' : 'Every run is done.'}</Text>
          )}
          {rows.map((one, index) => {
            const isOver = one.doneAt !== undefined
            const failed = countsOf(one).failed
            const tone = isOver ? 'success' : failed > 0 ? 'error' : 'cyan'
            const glyph = isOver ? ICON.done : isLive(one) ? mark : failed > 0 ? ICON.failed : ICON.todo

            return (
              <Box justifyContent="space-between">
                <Box>
                  <Text color="cyan">{one.id === here ? '▸' : ' '}</Text>
                  <Text color={tone} dimColor={isOver}>
                    {glyph}{' '}
                  </Text>
                  <Button
                    key={`run-${one.id}`}
                    plain
                    {...(index < 9 ? { hotkey: String(index + 1) } : {})}
                    {...(one.id === here ? { autoFocus: true as const } : {})}
                    dimColor={isOver}
                    label={cut(one.goal === '' ? `Run ${one.id}` : one.goal, Math.max(10, columns - 34))}
                    onPress={async () => {
                      await update($, confirming, () => 0)
                      await update($, shown, () => one.id)
                    }}
                  />
                  {one.id === current ? <Text color="cyan"> ●</Text> : null}
                </Box>
                <Text dimColor>
                  {' '}
                  {runMarks(one)} · {ageOf(one.doneAt ?? one.startedAt, at)}
                </Text>
              </Box>
            )
          })}
          <Text dimColor>{rule}</Text>
          {asking !== 0 ? (
            <Box columnGap={2}>
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
          ) : picked === undefined ? (
            <Button
              key="all"
              plain
              dimColor
              hotkey="a"
              label={withDone ? 'open only' : 'all'}
              onPress={() => update($, isAll, value => !value)}
            />
          ) : (
            <Box columnGap={2}>
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
              <Button key="clear" plain dimColor hotkey="x" label="clear" onPress={() => update($, confirming, () => picked.id)} />
              <Button
                key="all"
                plain
                dimColor
                hotkey="a"
                label={withDone ? 'open only' : 'all'}
                onPress={() => update($, isAll, value => !value)}
              />
            </Box>
          )}
        </Box>
      )
    }

    // One run. Each task is a line: marks and numbers say how it stands, and
    // words are kept for what is wrong. Details add what each part is for,
    // what was done, and what is finished or fixed.
    const detailed = await read($, isDetailed)
    const counts = countsOf(now)
    const openFindings = now.findings.filter(one => one.status === 'open')
    const fixedFindings = now.findings.filter(one => one.status === 'fixed')
    const findings = [...openFindings, ...(detailed ? fixedFindings : [])]
    const lanes = lanesOf(now)
    // The finding "open" shows in lens: the one the focus is on, else the first.
    const focusedFinding = await read($, pointed)
    const target = findings.find(one => one.id === focusedFinding) ?? findings[0]
    const loose = now.spawns.filter(one => one.task === undefined && (detailed || one.endedAt === undefined))

    return (
      <Box flexDirection="column" paddingX={PAD}>
        <Box justifyContent="space-between">
          <Text bold wrap="truncate-end">
            <Text color="cyan">{ICON.tasks} </Text>
            {now.goal === '' ? `Run ${now.id}` : now.goal}
          </Text>
          <Text dimColor>
            {' '}
            {counts.done}/{counts.tasks}
            {counts.tokens > 0 ? ` · ${tokensText(counts.tokens)}` : ''}
          </Text>
        </Box>
        {now.doc === undefined ? null : (
          <Text dimColor wrap="truncate-start">
            {now.doc.path}
          </Text>
        )}
        <Text dimColor>{rule}</Text>
        {unitsOf(now).map((unit, index, units) => (
          <Box flexDirection="column" paddingLeft={unit.lane === undefined ? 0 : 2}>
            {/* A lane's line comes before its first unit: how the lane stands,
                with the mark that turns while one of its subagents runs. */}
            {unit.lane !== undefined && units[index - 1]?.lane !== unit.lane
              ? lanes
                  .filter(lane => lane.name === unit.lane)
                  .map(lane => (
                    <Box justifyContent="space-between" marginLeft={-2}>
                      <Text bold color="cyan" wrap="truncate-end">
                        {lane.name}
                        {lane.agents > 0 ? ` ${mark}` : ''}
                        {lane.failed > 0 ? <Text color="error"> {ICON.failed}</Text> : null}
                      </Text>
                      <Text dimColor>
                        {' '}
                        {lane.done}/{lane.tasks}
                      </Text>
                    </Box>
                  ))
              : null}
            <Box justifyContent="space-between">
              <Text bold wrap="truncate-end">
                {unit.name}
              </Text>
              <Text dimColor>
                {' '}
                {unit.tasks.filter(one => one.status === 'done').length}/{unit.tasks.length}
              </Text>
            </Box>
            {detailed && unit.about !== undefined ? (
              <Box paddingLeft={2}>
                <Text wrap="wrap" dimColor>
                  {unit.about}
                </Text>
              </Box>
            ) : null}
            {unit.tasks.map(one => {
              const spawns = now.spawns.filter(spawn => spawn.task === one.id)
              const live = spawns.find(spawn => spawn.endedAt === undefined)
              const used = spawns.reduce((sum, spawn) => sum + (spawn.tokens ?? 0), 0)

              return (
                <Box flexDirection="column">
                  <Box justifyContent="space-between">
                    <Text wrap="truncate-end">
                      <Text
                        color={live !== undefined ? 'cyan' : TASK_TONES[one.status]}
                        dimColor={live === undefined && one.status === 'todo'}
                      >
                        {'  '}
                        {live !== undefined ? mark : TASK_ICONS[one.status]}{' '}
                      </Text>
                      <Text bold>{one.id}</Text> {one.title}
                      {one.status === 'gate-failed' && one.note !== undefined ? (
                        <Text color="error">
                          {'  '}
                          {one.note}
                        </Text>
                      ) : null}
                    </Text>
                    {live !== undefined ? (
                      <Text dimColor> {spawnMeta(live, at)}</Text>
                    ) : stepsText(one) !== '' && one.status !== 'done' ? (
                      <Text dimColor> {stepsText(one)}</Text>
                    ) : null}
                  </Box>
                  {detailed ? (
                    <Box flexDirection="column" paddingLeft={6}>
                      {(one.steps ?? []).map(step => (
                        <Text wrap="truncate-end" dimColor={step.isDone}>
                          <Text color={step.isDone ? 'success' : 'gray'}>{step.isDone ? ICON.done : ICON.todo} </Text>
                          {step.text}
                        </Text>
                      ))}
                      {one.outcome !== undefined ? (
                        <Text wrap="wrap">{one.outcome}</Text>
                      ) : one.about !== undefined ? (
                        <Text wrap="wrap" dimColor>
                          {one.about}
                        </Text>
                      ) : null}
                      {one.status !== 'gate-failed' && one.note !== undefined ? (
                        <Text wrap="wrap" dimColor>
                          gate: {one.note}
                        </Text>
                      ) : null}
                      <Text dimColor wrap="truncate-end">
                        {[
                          one.tier ?? '',
                          spawns.length > 0 ? `${spawns.length} agent${spawns.length === 1 ? '' : 's'}` : '',
                          used > 0 ? tokensText(used) : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </Box>
                  ) : null}
                </Box>
              )
            })}
          </Box>
        ))}
        {loose.length > 0 ? <Text dimColor>other agents</Text> : null}
        {loose.map(one => (
          <Box justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color={one.endedAt === undefined ? 'cyan' : 'success'} dimColor={one.endedAt !== undefined}>
                {'  '}
                {one.endedAt === undefined ? mark : ICON.done}{' '}
              </Text>
              {one.description}
            </Text>
            <Text dimColor> {spawnMeta(one, at)}</Text>
          </Box>
        ))}
        {findings.length > 0 ? (
          <Box marginTop={1}>
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

          return (
            <Box flexDirection="column">
              <Box>
                <Text color={isOpen ? SEVERITY_TONES[one.severity] : 'success'} dimColor={!isOpen}>
                  {'  '}
                  {isOpen ? ICON.finding : ICON.done}{' '}
                </Text>
                <Text color={icon.color}>{icon.glyph} </Text>
                <Button
                  key={`finding-${one.id}`}
                  plain
                  {...(index < 9 && isOpen ? { hotkey: String(index + 1) } : {})}
                  {...(index === 0 ? { autoFocus: true as const } : {})}
                  dimColor={!isOpen}
                  label={placeOf(one)}
                  onPress={() => toPrompt($, findingText(one))}
                />
                {detailed ? null : (
                  <Text wrap="truncate-end" dimColor={!isOpen}>
                    {'  '}
                    {one.summary}
                  </Text>
                )}
              </Box>
              {detailed ? (
                <Box paddingLeft={6}>
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
        <Box columnGap={2}>
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
            label={detailed ? 'less' : 'details'}
            onPress={() => update($, isDetailed, value => !value)}
          />
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
          {openFindings.length > 0 ? <Text dimColor>1-9 to prompt</Text> : null}
        </Box>
      </Box>
    )
  })
}
