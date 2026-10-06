// A run's logic, free of the engine: every change takes a run and answers the
// next one, or a string saying why it was refused.

import type {
  LedgerFinding,
  LedgerRun,
  LedgerSeverity,
  LedgerSpawn,
  LedgerTask,
  LedgerTaskStatus,
  LedgerUnitNote,
} from '../types'
import { ICON } from './kit/icons'
import { cut } from './kit/layout'

export type NewTask = {
  id: string
  lane?: string
  unit?: string
  title: string
  about?: string
  tier?: string
  check?: string
}

export type NewFinding = {
  path: string
  line?: number
  severity: LedgerSeverity
  summary: string
  task?: string
  agentId?: string
}

export const SEVERITIES: readonly LedgerSeverity[] = ['error', 'warning', 'note']
export const STATUSES: readonly LedgerTaskStatus[] = ['todo', 'running', 'gate-failed', 'done']

export const isRun = (value: unknown): value is LedgerRun =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as LedgerRun).goal === 'string' &&
  Array.isArray((value as LedgerRun).tasks) &&
  Array.isArray((value as LedgerRun).spawns) &&
  Array.isArray((value as LedgerRun).findings)

// A new run from the settled plan. A task with no unit is in the unit "main".
export const plan = (
  goal: string,
  tasks: readonly NewTask[],
  now: number,
  sessionId?: string,
  units: readonly LedgerUnitNote[] = [],
): LedgerRun | string => {
  if (tasks.length === 0) {
    return 'A plan needs at least one task.'
  }

  const ids = tasks.map(one => one.id.trim())
  const twice = ids.find((id, at) => id === '' || ids.indexOf(id) !== at)

  if (twice !== undefined) {
    return twice === '' ? 'Every task needs an id.' : `Task id ${twice} is used twice.`
  }

  // What each unit is for, for the units the plan has tasks in.
  const planned = new Set(tasks.map(one => one.unit?.trim() || 'main'))
  const described = units
    .map(one => ({ name: one.name.trim(), about: one.about.trim() }))
    .filter(one => planned.has(one.name) && one.about !== '')

  return {
    id: 0,
    goal: goal.trim(),
    startedAt: now,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(described.length > 0 ? { units: described } : {}),
    tasks: tasks.map(one => ({
      id: one.id.trim(),
      ...(one.lane?.trim() ? { lane: one.lane.trim() } : {}),
      unit: one.unit?.trim() || 'main',
      title: one.title.trim(),
      ...(one.tier ? { tier: one.tier.trim() } : {}),
      ...(one.about?.trim() ? { about: one.about.trim() } : {}),
      ...(one.check ? { check: one.check.trim() } : {}),
      status: 'todo' as const,
    })),
    spawns: [],
    findings: [],
    nextFinding: 1,
  }
}

export const setTask = (
  run: LedgerRun,
  id: string,
  status: LedgerTaskStatus,
  note?: string,
  outcome?: string,
): LedgerRun | string =>
  run.tasks.some(one => one.id === id)
    ? {
        ...run,
        tasks: run.tasks.map(one => {
          if (one.id !== id) {
            return one
          }

          const { note: _n, ...rest } = one

          return {
            ...rest,
            status,
            ...(note?.trim() ? { note: note.trim() } : {}),
            // What was done stands until it is said again.
            ...(outcome?.trim() ? { outcome: outcome.trim() } : {}),
          }
        }),
      }
    : `No task ${id}. The tasks are ${run.tasks.map(one => one.id).join(', ')}.`

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The task a subagent was spawned for: the one its description names in
// brackets ("[T3] add the retry"), else the one named there as a word of its
// own, else the one its prompt names in brackets.
//
// Where several are named, the one named first in the text wins, and of two
// starting at one place the longer id (T10 over T1, 1.2 over 1).
export const taskOf = (run: LedgerRun, description: string, prompt = ''): string | undefined => {
  const named = (text: string, isBare: boolean) =>
    run.tasks
      .flatMap(one => {
        const hit = new RegExp(
          isBare ? `(?<![A-Za-z0-9_])${escaped(one.id)}(?![A-Za-z0-9_])` : `\\[${escaped(one.id)}\\]`,
        ).exec(text)

        return hit === null ? [] : [{ id: one.id, at: hit.index }]
      })
      .sort((a, b) => a.at - b.at || b.id.length - a.id.length)[0]?.id

  // A run read from a plan document numbers its tasks T1, T2, ...: there a
  // description that says "Task 3", as the document does, names T3.
  const spoken =
    run.doc === undefined
      ? undefined
      : run.tasks.find(one =>
          new RegExp(`(?<![A-Za-z0-9_])Task\\s+${escaped(one.id.replace(/^T/, ''))}(?![A-Za-z0-9_.-])`, 'i').test(
            description,
          ),
        )?.id

  return named(description, false) ?? named(description, true) ?? spoken ?? named(prompt, false)
}

// Records a subagent as started. Its task, when still to do, is now running.
// One recorded before keeps the tokens it had used.
export const spawned = (run: LedgerRun, spawn: LedgerSpawn): LedgerRun => {
  const before = run.spawns.find(one => one.agentId === spawn.agentId)?.tokens

  return {
    ...run,
    tasks: run.tasks.map(one =>
      one.id === spawn.task && one.status === 'todo' ? { ...one, status: 'running' as const } : one,
    ),
    spawns: [
      ...run.spawns.filter(one => one.agentId !== spawn.agentId),
      { ...spawn, ...(before !== undefined ? { tokens: before + (spawn.tokens ?? 0) } : {}) },
    ],
  }
}

// A subagent that had ended is at work again (it was sent a message): it
// counts as running until its next turn ends.
export const resumed = (run: LedgerRun, agentId: string): LedgerRun => ({
  ...run,
  spawns: run.spawns.map(one => {
    if (one.agentId !== agentId) {
      return one
    }

    const { endedAt: _e, reason: _r, ...rest } = one

    return rest
  }),
})

// A run another session left: the subagents it still shows running ended with
// that session.
export const orphaned = (run: LedgerRun, now: number): LedgerRun => ({
  ...run,
  spawns: run.spawns.map(one =>
    one.endedAt === undefined ? { ...one, endedAt: now, reason: 'session ended' } : one,
  ),
})

// Records a subagent's turn as over; a run that never saw it start is unchanged.
export const ended = (
  run: LedgerRun,
  agentId: string,
  reason: string,
  tokens: number | undefined,
  now: number,
): LedgerRun => ({
  ...run,
  spawns: run.spawns.map(one =>
    one.agentId === agentId
      ? { ...one, endedAt: now, reason, ...(tokens !== undefined ? { tokens: (one.tokens ?? 0) + tokens } : {}) }
      : one,
  ),
})

export const found = (run: LedgerRun, finding: NewFinding, now: number): LedgerRun => ({
  ...run,
  nextFinding: run.nextFinding + 1,
  findings: [
    ...run.findings,
    {
      id: run.nextFinding,
      path: finding.path.trim(),
      ...(finding.line !== undefined ? { line: finding.line } : {}),
      severity: finding.severity,
      summary: finding.summary.trim(),
      ...(finding.task !== undefined ? { task: finding.task } : {}),
      ...(finding.agentId !== undefined ? { agentId: finding.agentId } : {}),
      at: now,
      status: 'open',
    },
  ],
})

export const fixed = (run: LedgerRun, ids: readonly number[]): LedgerRun | string => {
  const missing = ids.find(id => !run.findings.some(one => one.id === id))

  return missing !== undefined
    ? `No finding #${missing}.`
    : {
        ...run,
        findings: run.findings.map(one => (ids.includes(one.id) ? { ...one, status: 'fixed' as const } : one)),
      }
}

export type LedgerUnit = { name: string; lane?: string; about?: string; tasks: LedgerTask[] }

// The units in the order the plan first names them. Two lanes may each have a
// unit of one name: they are two units.
export const unitsOf = (run: LedgerRun): LedgerUnit[] =>
  [...new Set(run.tasks.map(one => `${one.lane ?? ''}\n${one.unit}`))].map(key => {
    const [lane = '', name = ''] = key.split('\n')
    const about = run.units?.find(one => one.name === name)?.about

    return {
      name,
      ...(lane !== '' ? { lane } : {}),
      ...(about !== undefined ? { about } : {}),
      tasks: run.tasks.filter(one => (one.lane ?? '') === lane && one.unit === name),
    }
  })

export type LedgerLane = {
  // '' for the tasks of a run that names no lane for them.
  name: string
  units: LedgerUnit[]
  tasks: number
  done: number
  failed: number
  // The subagents running on this lane's tasks.
  agents: number
}

// Whether the plan split the run into lanes: parallel tracks of one feature.
export const hasLanes = (run: LedgerRun): boolean => run.tasks.some(one => one.lane !== undefined)

// The run's lanes in the order the plan first names them. A run with no lanes
// is one lane with no name.
export const lanesOf = (run: LedgerRun): LedgerLane[] => {
  const units = unitsOf(run)

  return [...new Set(units.map(one => one.lane ?? ''))].map(name => {
    const mine = units.filter(one => (one.lane ?? '') === name)
    const tasks = mine.flatMap(one => one.tasks)
    const ids = new Set(tasks.map(one => one.id))

    return {
      name,
      units: mine,
      tasks: tasks.length,
      done: tasks.filter(one => one.status === 'done').length,
      failed: tasks.filter(one => one.status === 'gate-failed').length,
      agents: run.spawns.filter(
        one => one.endedAt === undefined && one.task !== undefined && ids.has(one.task),
      ).length,
    }
  })
}

export type LedgerCounts = {
  units: number
  // The unit work is on, counted from 1: the first with a task not done; the
  // last unit once every task is done.
  unitAt: number
  unitName: string
  tasks: number
  done: number
  failed: number
  running: number
  agents: number
  openFindings: number
  errors: number
  tokens: number
}

export const countsOf = (run: LedgerRun): LedgerCounts => {
  const units = unitsOf(run)
  const at = units.findIndex(unit => unit.tasks.some(one => one.status !== 'done'))
  const here = at === -1 ? units.length - 1 : at
  const open = run.findings.filter(one => one.status === 'open')

  return {
    units: units.length,
    unitAt: here + 1,
    unitName: units[here]?.name ?? '',
    tasks: run.tasks.length,
    done: run.tasks.filter(one => one.status === 'done').length,
    failed: run.tasks.filter(one => one.status === 'gate-failed').length,
    running: run.tasks.filter(one => one.status === 'running').length,
    agents: run.spawns.filter(one => one.endedAt === undefined).length,
    openFindings: open.length,
    errors: open.filter(one => one.severity === 'error').length,
    tokens: run.spawns.reduce((sum, one) => sum + (one.tokens ?? 0), 0),
  }
}

export const isDone = (run: LedgerRun): boolean => run.tasks.every(one => one.status === 'done')

const few = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

export const tokensText = (tokens: number): string =>
  tokens >= 999_500
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k`
      : String(tokens)

// The status line's entry. Undefined once the run has nothing left to say:
// every task done, no agent running and no finding open.
export const statusText = (run: LedgerRun): string | undefined => {
  const counts = countsOf(run)

  if (isDone(run) && counts.agents === 0 && counts.openFindings === 0) {
    return undefined
  }

  // A run in lanes says how each lane stands, a failed gate marked on its lane.
  if (hasLanes(run) && !isDone(run)) {
    return [
      `${ICON.tasks} ${lanesOf(run)
        .map(
          lane =>
            `${lane.name === '' ? 'other' : lane.name} ${lane.failed > 0 ? `${ICON.failed} ` : ''}${lane.done}/${lane.tasks}`,
        )
        .join(' · ')}`,
      counts.agents > 0 ? `${ICON.agents} ${counts.agents}` : '',
      counts.openFindings > 0 ? `${ICON.finding} ${counts.openFindings}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }

  return [
    `${ICON.tasks} ${
      isDone(run)
        ? `all ${few(counts.tasks, 'task')} done`
        : `unit ${counts.unitAt}/${counts.units} ${counts.unitName} · ${counts.done}/${counts.tasks} tasks`
    }`,
    counts.failed > 0 ? `${ICON.failed} ${few(counts.failed, 'gate')} failed` : '',
    counts.agents > 0 ? `${ICON.agents} ${few(counts.agents, 'agent')} running` : '',
    counts.openFindings > 0
      ? `${ICON.finding} ${few(counts.openFindings, 'finding')}${counts.errors > 0 ? ` (${few(counts.errors, 'error')})` : ''}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

const MARKS: Record<LedgerTaskStatus, string> = {
  todo: ICON.todo,
  running: ICON.running,
  'gate-failed': ICON.failed,
  done: ICON.done,
}

export const placeOf = (finding: LedgerFinding): string =>
  finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`

// A finding as the prompt takes it: where it is, then what is wrong.
export const findingText = (finding: LedgerFinding): string =>
  `Finding #${finding.id} (${finding.severity}) ${placeOf(finding)}: ${finding.summary}`

const spanText = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

// What the pane shows beside a subagent: its model, how long it ran (or has
// been running), and the tokens it used.
export const spawnMeta = (spawn: LedgerSpawn, now: number): string =>
  [
    spawn.model,
    spanText((spawn.endedAt ?? now) - spawn.startedAt),
    spawn.tokens !== undefined ? tokensText(spawn.tokens) : '',
  ]
    .filter(Boolean)
    .join(' · ')

// The run as text: what /ledger print shows and what the model reads back.
// A task's steps done of all, where its run is read from a plan document: ''
// for a task with no steps.
export const stepsText = (task: LedgerTask): string =>
  task.steps === undefined || task.steps.length === 0
    ? ''
    : `${task.steps.filter(one => one.isDone).length}/${task.steps.length}`

const laneDone = (run: LedgerRun, name: string): string => {
  const lane = lanesOf(run).find(one => one.name === name)

  return `${lane?.done ?? 0}/${lane?.tasks ?? 0} done`
}

export const report = (run: LedgerRun, isPlain = false): string => {
  const counts = countsOf(run)
  const open = run.findings.filter(one => one.status === 'open')
  const mark = (status: LedgerTaskStatus) => (isPlain ? `[${status}]` : MARKS[status])

  return [
    `Ledger: ${run.goal === '' ? '(no goal given)' : run.goal}`,
    ...(run.doc !== undefined ? [`Plan: ${run.doc.path}`] : []),
    ...unitsOf(run).flatMap((unit, at, units) => [
      // A lane's heading comes before its first unit.
      ...(unit.lane !== undefined && units[at - 1]?.lane !== unit.lane
        ? [`Lane ${unit.lane} (${laneDone(run, unit.lane)})`]
        : []),
      `${unit.name} (${unit.tasks.filter(one => one.status === 'done').length}/${unit.tasks.length} done)`,
      ...(unit.about !== undefined ? [`  ${unit.about}`] : []),
      ...unit.tasks.flatMap(one => [
        `  ${mark(one.status)} ${one.id}${one.tier ? ` (${one.tier})` : ''} ${one.title}${stepsText(one) === '' ? '' : ` [${stepsText(one)}]`}${one.note ? `: ${cut(one.note, 160)}` : ''}`,
        // Once it is done, what was done says more than what it was for.
        ...(one.outcome !== undefined
          ? [`      Outcome: ${cut(one.outcome, 300)}`]
          : one.about !== undefined
            ? [`      What it does: ${cut(one.about, 300)}`]
            : []),
      ]),
    ]),
    run.spawns.length > 0
      ? `Agents: ${counts.agents} running, ${run.spawns.length - counts.agents} finished, ${tokensText(counts.tokens)} tokens`
      : '',
    open.length > 0 ? `Findings: ${open.length} open, ${run.findings.length - open.length} fixed` : '',
    ...open.map(
      one =>
        `  #${one.id} ${one.severity} ${placeOf(one)} ${cut(one.summary, 200)}${one.task ? ` (${one.task})` : ''}`,
    ),
  ]
    .filter(Boolean)
    .join('\n')
}
