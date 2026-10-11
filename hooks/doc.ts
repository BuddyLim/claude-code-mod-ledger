// A plan document as the ledger's input: a superpowers plan (or any document
// laid out like one) read into tasks and their steps, a run made from it, and
// its checkboxes ticked. Free of the engine, as run.ts is.

import type { LedgerRun, LedgerStep, LedgerTask } from '../types'

// One task of the document: where its heading is, and where each of its
// checkbox steps is. Lines are counted from 0.
export type DocTask = {
  // The number its heading gives it ("3" of "### Task 3: ..."), or its place.
  n: string
  title: string
  unit: string
  line: number
  steps: { line: number; text: string; isDone: boolean }[]
  // What its labelled lines say (`**Lane:** API`), where it has them: the lane
  // it is in, the model it is meant for, what its gate checks, and the earlier
  // tasks it needs done first, by number (none is an empty list; with no such
  // line, undefined: nobody has said).
  lane?: string
  tier?: string
  check?: string
  needs?: string[]
  // How the ledger last wrote it stood, for a reader with no ledger of it.
  said?: { status: 'done' | 'gate-failed' | 'cancelled'; text: string }
  // The files its `**Files:**` list names, without line ranges.
  files: string[]
  // Where each line the ledger writes is, for the ones the task has.
  labels: { needs?: number; lane?: number; status?: number }
}

export type PlanDoc = { title: string; tasks: DocTask[] }

// Where the superpowers skills save their plans.
export const PLAN_PATH = /(^|\/)docs\/superpowers\/plans\/[^/]+\.md$/

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const TASK = /^Task\s+([\w.-]+?)\s*[:.)-]?\s+(.+)$/i
const BARE_TASK = /^Task\s+([\w.-]+)\s*[:.)-]?$/i
const BOX = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/
// A labelled line under a task (`**Lane:** API`), and a file its list names
// (`- Modify: src/queue.ts:10-40`, the path in backticks or bare).
const LABEL = /^\s*\*\*([A-Za-z]+):\*\*\s*(.*?)\s*$/
const FILE = /^\s*[-*+]\s+(?:Create|Modify|Test|Delete|Update|Move|Rename)\s*:\s*`?([^`\s]+)`?/i

// The task numbers a `**Needs:**` line names: "Task 1, Task 2", "1 and 2",
// or "none".
const numbersOf = (value: string): string[] =>
  /^(none|nothing|-|—)?$/i.test(value.trim())
    ? []
    : value
        .replace(/\b(tasks?|and)\b/gi, ' ')
        .split(/[\s,;]+/)
        .filter(Boolean)

// A step's words without the marks around them.
const plain = (text: string): string => text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`/g, '').trim()

// The lines of a document with those inside a code fence blanked: a fenced
// example may hold headings and checkboxes that are not the plan's.
const unfenced = (text: string): string[] => {
  let isFenced = false

  return text.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) {
      isFenced = !isFenced

      return ''
    }

    return isFenced ? '' : line
  })
}

// Reads a document laid out as the superpowers plans are: a `### Task N: name`
// heading per task, checkbox steps beneath it, and under the heading the
// labelled lines the ledger's recipe adds (`**Unit:**`, `**Lane:**`,
// `**Tier:**`, `**Gate:**`, `**Needs:**`, `**Status:**`) and the task's
// `**Files:**` list. Undefined when it has no such task: it is laid out some
// other way.
//
// A task's unit is what its `**Unit:**` line says. With no such line it is
// the `##` section the task is under, but only where the tasks are under more
// than one: a plan whose tasks all follow one section ("File Map") has no
// units, that section not being one.
export const parsePlan = (text: string): PlanDoc | undefined => {
  const lines = unfenced(text)
  const tasks: DocTask[] = []
  const named = new Set<DocTask>()
  let title = ''
  let section = ''
  let task: DocTask | undefined

  lines.forEach((line, at) => {
    const heading = HEADING.exec(line)

    if (heading !== null) {
      const words = plain(heading[2] ?? '')
      const head = TASK.exec(words) ?? BARE_TASK.exec(words)

      if (head !== null) {
        task = { n: head[1] ?? '', title: head[2] ?? words, unit: section, line: at, steps: [], files: [], labels: {} }
        tasks.push(task)
      } else {
        // Any other heading ends the task before it; a `##` one is a section.
        task = undefined

        if ((heading[1] ?? '').length === 1 && title === '') {
          title = words
        } else if ((heading[1] ?? '').length === 2) {
          section = words
        }
      }

      return
    }

    if (task === undefined) {
      return
    }

    const box = BOX.exec(line)

    if (box !== null) {
      task.steps.push({ line: at, text: plain(box[2] ?? ''), isDone: box[1] !== ' ' })

      return
    }

    const file = FILE.exec(line)

    if (file !== null) {
      task.files.push((file[1] ?? '').replace(/:\d+(-\d+)?$/, ''))

      return
    }

    const label = LABEL.exec(line)
    const key = (label?.[1] ?? '').toLowerCase()
    const value = plain(label?.[2] ?? '')

    if (key === 'unit' && value !== '') {
      task.unit = value
      named.add(task)
    } else if (key === 'lane') {
      task.labels.lane = at

      if (value !== '') {
        task.lane = value
      }
    } else if (key === 'tier' && value !== '') {
      task.tier = value
    } else if ((key === 'gate' || key === 'check') && value !== '') {
      task.check = value
    } else if (key === 'needs' || key === 'after') {
      task.labels.needs = at
      task.needs = numbersOf(value)
    } else if (key === 'status') {
      const said = /^(done|gate failed|cancelled)\s*(?:[—:-]\s*)?(.*)$/i.exec(value)
      const word = (said?.[1] ?? '').toLowerCase()

      task.labels.status = at

      if (said !== null) {
        task.said = {
          status: word === 'done' ? 'done' : word === 'cancelled' ? 'cancelled' : 'gate-failed',
          text: said[2] ?? '',
        }
      }
    }
  })

  // One section over every task is not a unit; a unit a task names stands.
  const sections = new Set(tasks.filter(one => !named.has(one)).map(one => one.unit))

  if (sections.size < 2) {
    for (const one of tasks) {
      if (!named.has(one)) {
        one.unit = ''
      }
    }
  }

  return tasks.length === 0 ? undefined : { title, tasks }
}

// What a small model is given to lay out a document the parser could not
// read: only its headings and checkboxes, each with its line number, so the
// request and the answer are both a few lines.
export const outlineOf = (text: string): string =>
  unfenced(text)
    .flatMap((line, at) => (HEADING.test(line) || BOX.test(line) ? [`${at}: ${line.trim().slice(0, 120)}`] : []))
    .join('\n')

export const outlineRequest = (outline: string): string =>
  [
    'Below are the headings and checkboxes of a plan document, each line led by its line number.',
    'Group them into tasks: a task is a piece of work with checkbox steps under it.',
    'Answer with JSON only, no prose: [{"title": "short name", "head": <line of its heading or first line>, "steps": [<line of each checkbox>]}].',
    'Use only line numbers that appear below. Leave out headings that hold no checkbox.',
    '',
    outline,
  ].join('\n')

// The document as a small model laid it out: its answer names lines, and the
// words and ticks are read from the document itself, so the model cannot
// misreport them. Undefined when the answer names no usable task.
export const planFromOutline = (text: string, answer: string): PlanDoc | undefined => {
  const lines = unfenced(text)
  let listed: unknown

  try {
    listed = JSON.parse(answer.slice(answer.indexOf('['), answer.lastIndexOf(']') + 1))
  } catch {
    return undefined
  }

  const tasks = (Array.isArray(listed) ? (listed as unknown[]) : []).flatMap((one, at): DocTask[] => {
    const entry = (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>
    const steps = (Array.isArray(entry.steps) ? (entry.steps as unknown[]) : []).flatMap(line => {
      const box = typeof line === 'number' ? BOX.exec(lines[line] ?? '') : null

      return box === null ? [] : [{ line: line as number, text: plain(box[2] ?? ''), isDone: box[1] !== ' ' }]
    })
    const head = typeof entry.head === 'number' ? entry.head : (steps[0]?.line ?? -1)
    const said = typeof entry.title === 'string' ? entry.title.trim() : ''

    return steps.length === 0
      ? []
      : [
          {
            n: String(at + 1),
            title: said === '' ? `Task ${at + 1}` : said.slice(0, 120),
            unit: '',
            line: head,
            steps,
            files: [],
            labels: {},
          },
        ]
  })
  const title = plain(HEADING.exec(lines.find(line => /^#\s/.test(line)) ?? '')?.[2] ?? '')

  return tasks.length === 0 ? undefined : { title, tasks }
}

export const taskIdOf = (task: DocTask): string => `T${task.n}`

const stateOf = (task: DocTask, before: LedgerTask | undefined): LedgerTask['status'] => {
  const ticked = task.steps.filter(one => one.isDone).length

  // Every box ticked is done. Short of that the ledger's own word stands
  // where it has one: a task marked done whose boxes were missed stays done
  // (and its boxes are ticked), and a failed gate stays failed.
  // A reader with no ledger of the task takes the document's `**Status:**`
  // line for it: what another session's ledger wrote there.
  return task.steps.length > 0 && ticked === task.steps.length
    ? 'done'
    : before?.status === 'done' || before?.status === 'gate-failed' || before?.status === 'cancelled'
      ? before.status
      : before === undefined && task.said !== undefined
        ? task.said.status
        : ticked > 0 || before?.status === 'running'
          ? 'running'
          : 'todo'
}

// The run a document makes, or the run it already made brought in step with
// it: tasks and steps are the document's, and what the ledger added (notes,
// outcomes, tiers, agents, findings) is kept.
export const runFromDoc = (
  doc: PlanDoc,
  path: string,
  isLaidOutByModel: boolean,
  now: number,
  sessionId: string,
  before?: LedgerRun,
): LedgerRun => {
  const fallback = doc.title === '' ? (path.split('/').pop() ?? 'Plan').replace(/\.md$/, '') : doc.title
  const tasks = doc.tasks.map((task): LedgerTask => {
    const was = before?.tasks.find(one => one.id === taskIdOf(task))
    const steps: LedgerStep[] = task.steps.map(one => ({ text: one.text, isDone: one.isDone }))

    // The lane, tier and gate are the document's while it names them; a lane
    // it no longer names is gone, so the task is back in the line.
    const { lane: _lane, needs: _needs, ...kept } = was ?? ({} as Partial<LedgerTask>)
    const status = stateOf(task, was)
    const tier = task.tier ?? was?.tier
    const check = task.check ?? was?.check
    // What the document says of a task this ledger never saw: its outcome, or
    // why its gate failed.
    const told = was === undefined && task.said !== undefined && task.said.text !== '' ? task.said : undefined

    return {
      ...kept,
      id: taskIdOf(task),
      ...(task.lane !== undefined ? { lane: task.lane } : {}),
      // A plan with no units has every task in "main", which draws no unit.
      unit: task.unit === '' ? 'main' : task.unit,
      title: task.title,
      ...(tier !== undefined ? { tier } : {}),
      ...(check !== undefined ? { check } : {}),
      status,
      ...(told?.status === 'done' ? { outcome: told.text } : {}),
      ...(told?.status === 'gate-failed' || told?.status === 'cancelled' ? { note: told.text } : {}),
      // What it needs, as the document numbers its tasks.
      ...(task.needs !== undefined && task.needs.length > 0 ? { needs: task.needs.map(n => `T${n}`) } : {}),
      steps,
    }
  })

  return {
    ...(before ?? { id: 0, startedAt: now, spawns: [], findings: [], nextFinding: 1 }),
    goal: fallback,
    sessionId,
    doc: { path, ...(isLaidOutByModel ? { isLaidOutByModel: true as const } : {}) },
    tasks,
  }
}

// The document with the open boxes ticked under each task the run has as
// done, and how many that was. Only `[ ]` becomes `[x]`, only on a line that
// is still an open checkbox, and nothing else is changed.
export const ticked = (text: string, doc: PlanDoc, run: LedgerRun): { text: string; count: number } => {
  const done = new Set(run.tasks.filter(one => one.status === 'done').map(one => one.id))
  const lines = text.split('\n')
  let count = 0

  for (const task of doc.tasks.filter(one => done.has(taskIdOf(one)))) {
    for (const step of task.steps.filter(one => !one.isDone)) {
      const line = lines[step.line] ?? ''

      if (/^\s*[-*+]\s+\[ \]\s/.test(line)) {
        lines[step.line] = line.replace('[ ]', '[x]')
        count += 1
      }
    }
  }

  return { text: count === 0 ? text : lines.join('\n'), count }
}

// The lines the ledger writes under a task's heading, in the order it writes
// them. Everything else in a document is the author's.
const WRITTEN = [
  ['needs', 'Needs'],
  ['lane', 'Lane'],
  ['status', 'Status'],
] as const

export type DocLabels = { needs?: string | null; lane?: string | null; status?: string | null }

// The document with the ledger's own lines set under each task named in
// `labels` (by its number): a value replaces the line or adds it under the
// heading, null takes the line out, and a label left out is left alone.
// Nothing else is changed.
export const labelled = (text: string, doc: PlanDoc, labels: ReadonlyMap<string, DocLabels>): string => {
  const lines = text.split('\n')
  let isChanged = false

  // From the last task up, so a line added or taken out moves no task above.
  for (const task of [...doc.tasks].reverse()) {
    const wanted = labels.get(task.n)

    if (wanted === undefined) {
      continue
    }

    const added: string[] = []

    // The lines the task has, the lowest first for the same reason.
    for (const [key, word] of [...WRITTEN].sort((a, b) => (task.labels[b[0]] ?? -1) - (task.labels[a[0]] ?? -1))) {
      const value = wanted[key]
      const at = task.labels[key]

      if (value === undefined || at === undefined) {
        continue
      }

      const line = `**${word}:** ${value}`

      if (value === null) {
        lines.splice(at, 1)
        isChanged = true
      } else if (lines[at] !== line) {
        lines[at] = line
        isChanged = true
      }
    }

    for (const [key, word] of WRITTEN) {
      const value = wanted[key]

      if (typeof value === 'string' && task.labels[key] === undefined) {
        added.push(`**${word}:** ${value}`)
      }
    }

    if (added.length > 0) {
      // Under the heading, a blank line apart from it and from what follows.
      const isSpaced = (lines[task.line + 1] ?? '').trim() === ''

      lines.splice(task.line + 1, 0, '', ...added, ...(isSpaced ? [] : ['']))
      isChanged = true
    }
  }

  return isChanged ? lines.join('\n') : text
}

// How each task of a run stands, as the ledger writes it into the run's
// document: done with what was done, a failed gate with why, and no line for
// a task that is neither.
export const statusLabels = (doc: PlanDoc, run: LedgerRun): Map<string, DocLabels> =>
  new Map(
    doc.tasks.map(task => {
      const now = run.tasks.find(one => one.id === taskIdOf(task))
      const words =
        now?.status === 'done'
          ? `done${now.outcome === undefined ? '' : ` — ${now.outcome}`}`
          : now?.status === 'gate-failed'
            ? `gate failed${now.note === undefined ? '' : ` — ${now.note}`}`
            : now?.status === 'cancelled'
              ? `cancelled${now.note === undefined ? '' : ` — ${now.note}`}`
              : null

      return [task.n, { status: words }]
    }),
  )
