// A run laid out as a pipeline, free of the engine: its tasks in the plan's
// order are stages one after another, and tasks in lanes are a fork, each lane
// a branch of its own that joins the line again where the lanes end.

import type { LedgerRun, LedgerTask, LedgerTaskStatus } from '../types'
import { isOver } from './run'

export type PipeLane = { name: string; tasks: LedgerTask[] }

export type Stage = { kind: 'one'; task: LedgerTask } | { kind: 'fork'; lanes: PipeLane[] }

// The node drawn for a task, by how it stands. Plain marks one cell wide in
// any font, so the lines between rows meet.
export const NODES: Record<LedgerTaskStatus, string> = {
  todo: '○',
  running: '◉',
  'gate-failed': '✗',
  done: '●',
  cancelled: '⊘',
}

// The stages in the plan's order. Tasks in lanes that follow one another are
// one fork, its lanes in the order the plan first names them.
export const stagesOf = (run: LedgerRun): Stage[] => {
  const stages: Stage[] = []

  for (const task of run.tasks) {
    const last = stages.at(-1)

    if (task.lane === undefined) {
      stages.push({ kind: 'one', task })
    } else if (last?.kind === 'fork') {
      const lane = last.lanes.find(one => one.name === task.lane)

      if (lane === undefined) {
        last.lanes.push({ name: task.lane, tasks: [task] })
      } else {
        lane.tasks.push(task)
      }
    } else {
      stages.push({ kind: 'fork', lanes: [{ name: task.lane, tasks: [task] }] })
    }
  }

  return stages
}

// A row of the pipeline drawn downwards. `rail` is the lines that pass
// through the row; under a task it is what its details are drawn beside.
export type PipeRow =
  | { kind: 'task'; lead: string; trail: string; rail: string; task: LedgerTask }
  | { kind: 'lane'; lead: string; trail: string; name: string }
  | { kind: 'unit'; rail: string; name: string; lane?: string }
  | { kind: 'link'; rail: string }

// The pipeline top to bottom: a node a task, a fork's lanes side by side as
// rails, each lane's tasks under its name, and a unit's name where it starts.
//
// `gap` is the cells between two rails: the wider, the more the fork reads as
// a graph. A row's lines are as wide as the fork it is in, and one cell wide
// for a task in the line, so its words stand beside its node.
//
// `isOpenEnded` is for a pipeline with something drawn before its first task
// and after its last (what is beside it, or its start and end): the line then
// comes in above the first and runs on past the last.
export const rowsOf = (run: LedgerRun, gap = 1, isOpenEnded = false): PipeRow[] => {
  const stages = stagesOf(run)
  // A run whose tasks name no unit is all "main": its name says nothing.
  const hasUnits = run.tasks.some(one => one.unit !== 'main')
  const rows: PipeRow[] = []
  const space = ' '.repeat(gap)
  const dash = '─'.repeat(gap)
  let unit: string | undefined

  stages.forEach((stage, at) => {
    const isLast = !isOpenEnded && at === stages.length - 1

    if (stage.kind === 'one') {
      if (hasUnits && stage.task.unit !== unit) {
        rows.push({ kind: 'unit', rail: rows.length === 0 && !isOpenEnded ? ' ' : '│', name: stage.task.unit })
      }

      unit = stage.task.unit
      rows.push({ kind: 'task', lead: '', trail: '', rail: isLast ? ' ' : '│', task: stage.task })

      return
    }

    unit = undefined
    const count = stage.lanes.length
    const rail = stage.lanes.map(() => '│').join(space)

    if (count > 1) {
      rows.push({ kind: 'link', rail: `${at === 0 && !isOpenEnded ? '┌' : '├'}${`${dash}┬`.repeat(count - 2)}${dash}╮` })
    }

    stage.lanes.forEach((lane, index) => {
      const lead = `│${space}`.repeat(index)
      const trail = `${space}│`.repeat(count - 1 - index)
      let laneUnit: string | undefined

      rows.push({ kind: 'lane', lead, trail, name: lane.name })

      for (const task of lane.tasks) {
        if (hasUnits && task.unit !== laneUnit) {
          rows.push({ kind: 'unit', rail, name: task.unit, lane: lane.name })
        }

        laneUnit = task.unit
        rows.push({ kind: 'task', lead, trail, rail, task })
      }
    })

    if (count > 1) {
      rows.push({ kind: 'link', rail: `${isLast ? '└' : '├'}${`${dash}┴`.repeat(count - 2)}${dash}╯` })
    }
  })

  return rows
}

// How many cells the rails of a run's widest fork take, `gap` cells apart.
export const railsWide = (run: LedgerRun, gap = 1): number =>
  Math.max(1, ...stagesOf(run).map(one => (one.kind === 'fork' ? (one.lanes.length - 1) * (gap + 1) + 1 : 1)))

// The widest gap between rails, up to `GAP_MOST`, that leaves the words
// beside them at least two thirds of `columns`: a wide pane draws the fork
// wide, and a narrow one keeps the room for the titles.
export const gapFor = (run: LedgerRun, columns: number): number => {
  let gap = GAP_MOST

  while (gap > 1 && railsWide(run, gap) > columns / 3) {
    gap -= 1
  }

  return gap
}

export const GAP_MOST = 5

// A text broken into lines no longer than `width`, at its spaces; a word
// longer than a line is cut. One empty line for an empty text.
export const wrapped = (text: string, width: number): string[] => {
  const most = Math.max(4, width)
  const lines: string[] = []
  let line = ''

  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word

    if (line !== '' && line.length + 1 + rest.length > most) {
      lines.push(line)
      line = ''
    }

    while (rest.length > most) {
      lines.push(rest.slice(0, most))
      rest = rest.slice(most)
    }

    line = line === '' ? rest : `${line} ${rest}`
  }

  return line === '' && lines.length > 0 ? lines : [...lines, line]
}

// A piece of the pipeline drawn across: a line, or the node of a task.
export type PipeCell = { text: string; task?: LedgerTask }

// The pipeline left to right, as a CI run is drawn: a node a task, a line
// from each to the next, a fork's lanes one under another between the two
// points where the line splits and joins. The lines between nodes are as long
// as `columns` lets them be, up to `LINK_MOST`, so the pipeline takes the
// width it is given. Undefined when it is wider than `columns` with the
// shortest lines, or is one node alone.
//
// `hasTail` keeps the line running past the last node, for what is drawn
// after it (what comes next, or the pipeline's end): a fork that ends the
// run then joins the line again, as one in its middle does.
export const stripOf = (run: LedgerRun, columns: number, hasTail = false): PipeCell[][] | undefined => {
  const stages = stagesOf(run)
  const shapes = stages.map(stage => {
    const lanes = stage.kind === 'fork' ? stage.lanes : [{ name: '', tasks: [stage.task] }]

    return { lanes, isSplit: lanes.length > 1, most: Math.max(...lanes.map(one => one.tasks.length)) }
  })
  // Every node, split and join is one place on the line, a link after each
  // but the last: `places` of them are `places * (1 + link) - link` wide.
  const places = shapes.reduce((sum, one) => sum + one.most + (one.isSplit ? 2 : 0), 0)
  // With a tail there is a link after the last place too.
  const link = Math.min(LINK_MOST, places > 1 ? Math.floor((columns - places) / (hasTail ? places : places - 1)) : 0)

  if (link < 1 || run.tasks.length < 2) {
    return undefined
  }

  const height = Math.max(1, ...shapes.map(one => one.lanes.length))
  const lines: PipeCell[][] = Array.from({ length: height }, () => [])
  const add = (row: number, text: string, task?: LedgerTask) =>
    lines[row]?.push({ text, ...(task !== undefined ? { task } : {}) })
  const line = '─'.repeat(link)
  const gap = ' '.repeat(link)

  shapes.forEach(({ lanes, isSplit, most }, at) => {
    const isLast = !hasTail && at === shapes.length - 1

    for (let row = 0; row < height; row++) {
      const lane = lanes[row]

      if (lane === undefined) {
        add(row, ' '.repeat((most + (isSplit ? 2 : 0)) * (1 + link)))
        continue
      }

      const isEnd = row === lanes.length - 1

      if (isSplit) {
        add(row, `${row === 0 ? '┬' : isEnd ? '╰' : '├'}${line}`)
      }

      for (const task of lane.tasks) {
        add(row, '', task)
        add(row, line)
      }

      if (lane.tasks.length < most) {
        add(row, `─${line}`.repeat(most - lane.tasks.length))
      }

      if (isSplit) {
        add(row, row === 0 ? (isLast ? `╮${gap}` : `┬${line}`) : `${isEnd ? '╯' : '┤'}${gap}`)
      }
    }
  })

  // The line stops at the last node: nothing follows it.
  const first = lines[0]
  const tail = first?.at(-1)

  if (!hasTail && first !== undefined && tail !== undefined && tail.task === undefined && /^─+$/.test(tail.text)) {
    first.pop()
  }

  return lines
}

// The longest a line between two nodes is drawn.
export const LINK_MOST = 8

// A strip's line as plain text, each node the mark of its task's state.
export const stripText = (line: readonly PipeCell[]): string =>
  line.map(one => (one.task === undefined ? one.text : NODES[one.task.status])).join('')

// The tasks that should be over before a task starts and are not: the ones
// its plan says it needs, every task of the stages before its own, and the
// tasks before it in its lane. By id, in the plan's order.
export const unmetOf = (run: LedgerRun, id: string): string[] => {
  const before = new Set<string>(run.tasks.find(one => one.id === id)?.needs ?? [])

  for (const stage of stagesOf(run)) {
    const mine =
      stage.kind === 'one'
        ? stage.task.id === id
          ? []
          : undefined
        : stage.lanes.find(lane => lane.tasks.some(one => one.id === id))?.tasks

    if (mine !== undefined) {
      for (const one of mine.slice(0, Math.max(0, mine.findIndex(task => task.id === id)))) {
        before.add(one.id)
      }

      break
    }

    for (const one of stage.kind === 'one' ? [stage.task] : stage.lanes.flatMap(lane => lane.tasks)) {
      before.add(one.id)
    }
  }

  return run.tasks.filter(one => before.has(one.id) && !isOver(one)).map(one => one.id)
}

// The other lanes of a task's fork that nothing has started on: every task
// still to do, and no subagent ever spawned for one. They could be worked on
// at the same time as the task's own lane.
export const idleLanes = (run: LedgerRun, id: string): string[] => {
  const fork = stagesOf(run).find(
    stage => stage.kind === 'fork' && stage.lanes.some(lane => lane.tasks.some(one => one.id === id)),
  )

  return fork === undefined || fork.kind !== 'fork'
    ? []
    : fork.lanes
        .filter(
          lane =>
            !lane.tasks.some(one => one.id === id) &&
            lane.tasks.every(one => one.status === 'todo') &&
            !run.spawns.some(spawn => lane.tasks.some(one => one.id === spawn.task)),
        )
        .map(lane => lane.name)
}
