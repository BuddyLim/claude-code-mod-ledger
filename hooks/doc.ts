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
}

export type PlanDoc = { title: string; tasks: DocTask[] }

// Where the superpowers skills save their plans.
export const PLAN_PATH = /(^|\/)docs\/superpowers\/plans\/[^/]+\.md$/

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const TASK = /^Task\s+([\w.-]+?)\s*[:.)-]?\s+(.+)$/i
const BARE_TASK = /^Task\s+([\w.-]+)\s*[:.)-]?$/i
const BOX = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/

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
// heading per task, checkbox steps beneath it, `##` sections as units.
// Undefined when it has no such task: it is laid out some other way.
export const parsePlan = (text: string): PlanDoc | undefined => {
  const lines = unfenced(text)
  const tasks: DocTask[] = []
  let title = ''
  let unit = ''
  let task: DocTask | undefined

  lines.forEach((line, at) => {
    const heading = HEADING.exec(line)

    if (heading !== null) {
      const words = plain(heading[2] ?? '')
      const named = TASK.exec(words) ?? BARE_TASK.exec(words)

      if (named !== null) {
        task = { n: named[1] ?? '', title: named[2] ?? words, unit, line: at, steps: [] }
        tasks.push(task)
      } else {
        // Any other heading ends the task before it; a `##` one names a unit.
        task = undefined

        if ((heading[1] ?? '').length === 1 && title === '') {
          title = words
        } else if ((heading[1] ?? '').length === 2) {
          unit = words
        }
      }

      return
    }

    const box = BOX.exec(line)

    if (box !== null && task !== undefined) {
      task.steps.push({ line: at, text: plain(box[2] ?? ''), isDone: box[1] !== ' ' })
    }
  })

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
      : [{ n: String(at + 1), title: said === '' ? `Task ${at + 1}` : said.slice(0, 120), unit: '', line: head, steps }]
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
  return task.steps.length > 0 && ticked === task.steps.length
    ? 'done'
    : before?.status === 'done' || before?.status === 'gate-failed'
      ? before.status
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

    return {
      ...(was ?? {}),
      id: taskIdOf(task),
      unit: task.unit === '' ? fallback : task.unit,
      title: task.title,
      status: stateOf(task, was),
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
