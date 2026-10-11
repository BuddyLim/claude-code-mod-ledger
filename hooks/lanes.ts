// A sequential plan turned into one that can be worked on in parallel, free of
// the engine: which earlier tasks each task needs, and from that the lanes,
// tracks of tasks that need nothing of one another and so can run at once.

import type { DocTask } from './doc'

// The earlier tasks each task needs done before it starts, by task number.
export type Needs = Map<string, string[]>

// What the files alone say: a task needs every earlier task that touches a
// file it touches, for two tasks on one file cannot be worked on at once.
export const fileNeeds = (tasks: readonly DocTask[]): Needs =>
  new Map(
    tasks.map((task, at) => [
      task.n,
      tasks
        .slice(0, at)
        .filter(earlier => earlier.files.some(file => task.files.includes(file)))
        .map(earlier => earlier.n),
    ]),
  )

// What a task needs in all: what was said of it (its `**Needs:**` line, or a
// model's reading of the plan) and what its files say. A task nobody has
// spoken for needs the task before it, as a plan read top to bottom implies.
// Only earlier tasks count, so the plan's order always holds.
export const allNeeds = (tasks: readonly DocTask[], said: Needs): Needs => {
  const files = fileNeeds(tasks)

  return new Map(
    tasks.map((task, at) => {
      const earlier = new Set(tasks.slice(0, at).map(one => one.n))
      const before = tasks[at - 1]?.n
      const told = said.get(task.n) ?? (before === undefined ? [] : [before])

      return [task.n, [...new Set([...told, ...(files.get(task.n) ?? [])])].filter(n => earlier.has(n))]
    }),
  )
}

// The folder most of a lane's files are under, as its name: `backend` for
// `backend/app/x.py`. '' when its tasks name no file.
const folderOf = (tasks: readonly DocTask[]): string => {
  const counts = new Map<string, number>()

  for (const file of tasks.flatMap(one => one.files)) {
    const top = file.replace(/^\.?\//, '').split('/')[0] ?? ''

    // A file at the root names no folder.
    if (top !== '' && file.includes('/')) {
      counts.set(top, (counts.get(top) ?? 0) + 1)
    }
  }

  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

// The lane of each task that is in one, by task number; a task not here is
// in the line, done by itself before what follows it.
//
// A task every other task comes before or after is in the line. The tasks
// between two such are a fork: those tied by a need, directly or through
// others, are one lane, worked in the plan's order, and the lanes need nothing
// of one another. A fork of one lane is no fork: its tasks are in the line.
export const lanesFrom = (tasks: readonly DocTask[], needs: Needs): Map<string, string> => {
  const at = new Map(tasks.map((one, index) => [one.n, index]))
  // Everything each task comes after, through the tasks it needs.
  const before: Set<number>[] = []

  tasks.forEach((task, index) => {
    const mine = new Set<number>()

    for (const n of needs.get(task.n) ?? []) {
      const need = at.get(n)

      if (need !== undefined && need < index) {
        mine.add(need)

        for (const further of before[need] ?? []) {
          mine.add(further)
        }
      }
    }

    before.push(mine)
  })

  const isOrdered = (a: number, b: number) => before[a]?.has(b) === true || before[b]?.has(a) === true
  const isInLine = tasks.map((_, index) => tasks.every((__, other) => other === index || isOrdered(index, other)))
  const lanes = new Map<string, string>()
  const taken = new Set<string>()
  let from = 0

  while (from < tasks.length) {
    if (isInLine[from] === true) {
      from += 1
      continue
    }

    let to = from

    while (to < tasks.length && isInLine[to] !== true) {
      to += 1
    }

    // The fork's tasks, grouped: each joins the group of the tasks it needs.
    const group = new Map<number, number>()

    for (let index = from; index < to; index++) {
      const tied = [...(before[index] ?? [])].filter(need => need >= from).map(need => group.get(need) ?? need)
      const home = tied.length === 0 ? index : Math.min(...tied)

      group.set(index, home)

      // A task that needs tasks of two groups makes them one.
      for (const [member, was] of group) {
        if (tied.includes(was)) {
          group.set(member, home)
        }
      }
    }

    const homes = [...new Set(group.values())].sort((a, b) => a - b)

    if (homes.length > 1) {
      homes.forEach(home => {
        const mine = [...group].filter(([, was]) => was === home).map(([index]) => tasks[index] as DocTask)
        // Named for its folder. A second lane of one folder, or one with no
        // folder, is named for its first task; failing that it is numbered.
        const folder = folderOf(mine)
        const first = (mine[0]?.title ?? '')
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, ' ')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .join(' ')
        let name = folder !== '' && !taken.has(folder) ? folder : first
        let count = 2

        while (name === '' || taken.has(name)) {
          name = `${first === '' ? 'lane' : first} ${count}`
          count += 1
        }

        taken.add(name)

        for (const task of mine) {
          lanes.set(task.n, name)
        }
      })
    }

    from = to
  }

  return lanes
}

// What a model is asked, to learn what each task needs: the plan's tasks with
// their files and steps, and nothing else of the document.
export const needsRequest = (tasks: readonly DocTask[]): string =>
  [
    'Below are the tasks of an implementation plan, in the order it was written, each with the files it touches and its steps.',
    'For each task, list the EARLIER tasks whose result it needs before it can start: it uses a type, function, schema, endpoint, component or file that the earlier task creates or changes.',
    'Two tasks that only belong to the same feature, but use nothing of one another, do not need each other: they can be worked on at the same time.',
    'A final task that verifies, integrates or documents the whole needs every task it checks.',
    'When you cannot tell, list the earlier task: a need too many only costs time, a need missed breaks the work.',
    'Answer with JSON only, no prose, one entry per task: [{"task": "3", "needs": ["1", "2"]}]. Use the task numbers given.',
    '',
    ...tasks.flatMap(task => [
      `Task ${task.n}: ${task.title}`,
      ...(task.files.length > 0 ? [`  files: ${task.files.slice(0, 12).join(', ')}`] : []),
      ...task.steps.slice(0, 10).map(step => `  - ${step.text.slice(0, 120)}`),
    ]),
  ].join('\n')

// What the model answered, kept for the tasks it names: the needs of each,
// among the plan's own task numbers. A task it left out is not here.
export const needsFromAnswer = (answer: string, tasks: readonly DocTask[]): Needs => {
  const known = new Set(tasks.map(one => one.n))
  const needs: Needs = new Map()
  let listed: unknown

  try {
    listed = JSON.parse(answer.slice(answer.indexOf('['), answer.lastIndexOf(']') + 1))
  } catch {
    return needs
  }

  for (const one of Array.isArray(listed) ? (listed as unknown[]) : []) {
    const entry = (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>
    const n = String(entry.task ?? '').replace(/^task\s*/i, '')

    if (known.has(n) && Array.isArray(entry.needs)) {
      needs.set(
        n,
        (entry.needs as unknown[]).map(need => String(need).replace(/^task\s*/i, '')).filter(need => known.has(need)),
      )
    }
  }

  return needs
}

// The plan's shape in a line, for the person who asked: the tasks in the
// line by number, and each fork's lanes with theirs.
export const shapeText = (tasks: readonly DocTask[], lanes: ReadonlyMap<string, string>): string => {
  const parts: string[] = []
  let fork: Map<string, string[]> | undefined

  const close = () => {
    if (fork !== undefined) {
      parts.push(`[${[...fork].map(([name, mine]) => `${name}: ${mine.join(', ')}`).join(' ∥ ')}]`)
      fork = undefined
    }
  }

  for (const task of tasks) {
    const lane = lanes.get(task.n)

    if (lane === undefined) {
      close()
      parts.push(task.n)
    } else {
      fork = fork ?? new Map()
      fork.set(lane, [...(fork.get(lane) ?? []), task.n])
    }
  }

  close()

  return parts.join(' → ')
}
