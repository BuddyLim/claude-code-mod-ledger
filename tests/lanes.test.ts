import { expect, mock, test } from 'claude-code/testing'

import { labelled, parsePlan, runFromDoc, statusLabels } from '../hooks/doc'
import type { PlanDoc } from '../hooks/doc'
import { allNeeds, fileNeeds, lanesFrom, needsFromAnswer, needsRequest, shapeText } from '../hooks/lanes'
import type { Needs } from '../hooks/lanes'
import { stagesOf } from '../hooks/pipe'
import { setTask } from '../hooks/run'

// A plan as superpowers writes one: every task after the last, each with the
// files it touches. Its tasks sit under one section, which is no unit.
const PLAN = [
  '# Transfers',
  '',
  '## File Map',
  '',
  '### Task 1: Schemas',
  '',
  '**Files:**',
  '- Modify: `backend/app/schemas/transfer.py`',
  '',
  '- [ ] **Step 1: Write the schema**',
  '',
  '### Task 2: Repository',
  '',
  '**Files:**',
  '- Modify: `backend/app/repositories/transfer.py:10-40`',
  '',
  '- [ ] **Step 1: Add create**',
  '',
  '### Task 3: Route',
  '',
  '**Files:**',
  '- Modify: `backend/app/routes/transfers.py`',
  '- Test: `backend/tests/test_transfers.py`',
  '',
  '- [ ] **Step 1: Add the route**',
  '',
  '### Task 4: API client',
  '',
  '**Files:**',
  '- Modify: `frontend/src/lib/api/transfers.ts`',
  '',
  '- [ ] **Step 1: Add the call**',
  '',
  '### Task 5: Transfer form',
  '',
  '**Files:**',
  '- Create: `frontend/src/pages/TransferForm.tsx`',
  '',
  '- [ ] **Step 1: Draw the form**',
  '',
  '### Task 6: Route tests for refunds',
  '',
  '**Files:**',
  '- Modify: `backend/tests/test_transfers.py`',
  '',
  '- [ ] **Step 1: Cover refunds**',
  '',
  '### Task 7: End to end',
  '',
  '- [ ] **Step 1: Run the flow**',
].join('\n')

const PATH = '/project/docs/superpowers/plans/2026-10-10-transfers.md'

// What a careful reader says each task needs: the backend builds on itself,
// the frontend on the schemas alone, and the last task checks everything.
const SAID: Needs = new Map([
  ['1', []],
  ['2', ['1']],
  ['3', ['2']],
  ['4', ['1']],
  ['5', ['4']],
  ['6', []],
  ['7', ['3', '5', '6']],
])

const read = (text: string): PlanDoc => {
  const doc = parsePlan(text)

  if (doc === undefined) {
    throw new Error('no plan')
  }

  return doc
}

test('a plan’s tasks are read with the files they touch, and one section over them all is no unit', () => {
  const doc = read(PLAN)

  expect(doc.tasks.map(one => one.files)).toEqual([
    ['backend/app/schemas/transfer.py'],
    ['backend/app/repositories/transfer.py'],
    ['backend/app/routes/transfers.py', 'backend/tests/test_transfers.py'],
    ['frontend/src/lib/api/transfers.ts'],
    ['frontend/src/pages/TransferForm.tsx'],
    ['backend/tests/test_transfers.py'],
    [],
  ])
  expect(doc.tasks.every(one => one.unit === '' && one.needs === undefined && one.lane === undefined)).toBe(true)
  // The run it makes has no unit to draw, and is a line: nothing says otherwise.
  const run = runFromDoc(doc, PATH, false, 0, 's1')
  expect(run.tasks.every(one => one.unit === 'main' && one.lane === undefined)).toBe(true)
  expect(stagesOf(run).every(one => one.kind === 'one')).toBe(true)
})

test('two tasks on one file are never in two lanes, whatever is said of them', () => {
  const doc = read(PLAN)

  // Task 6 touches the test file task 3 touches: it needs task 3.
  expect(fileNeeds(doc.tasks).get('6')).toEqual(['3'])
  expect(allNeeds(doc.tasks, SAID).get('6')).toEqual(['3'])
  // A task nobody spoke for needs the one before it; only earlier tasks count.
  expect(allNeeds(doc.tasks, new Map([['2', ['5', '1']]])).get('2')).toEqual(['1'])
  expect(allNeeds(doc.tasks, new Map()).get('4')).toEqual(['3'])
})

test('a sequential plan becomes a line, a fork of lanes named for their folders, and a line again', () => {
  const doc = read(PLAN)
  const needs = allNeeds(doc.tasks, SAID)
  const lanes = lanesFrom(doc.tasks, needs)

  expect([...lanes]).toEqual([
    ['2', 'backend'],
    ['3', 'backend'],
    ['6', 'backend'],
    ['4', 'frontend'],
    ['5', 'frontend'],
  ])
  expect(shapeText(doc.tasks, lanes)).toBe('1 → [backend: 2, 3, 6 ∥ frontend: 4, 5] → 7')

  // A plan where every task needs the one before it has no lanes.
  expect(lanesFrom(doc.tasks, allNeeds(doc.tasks, new Map())).size).toBe(0)
  // Nothing needing anything: every task that names a file is a lane of its
  // own, except the two that share one.
  const loose = lanesFrom(doc.tasks, allNeeds(doc.tasks, new Map(doc.tasks.map(one => [one.n, []]))))
  expect(new Set(loose.values()).size).toBe(6)
  expect(loose.get('3')).toBe(loose.get('6'))
})

test('the lanes are written into the same document, read back from it, and written the same again', () => {
  const doc = read(PLAN)
  const needs = allNeeds(doc.tasks, SAID)
  const lanes = lanesFrom(doc.tasks, needs)
  const labels = (of: PlanDoc) =>
    new Map(
      of.tasks.map(one => [
        one.n,
        {
          needs: (needs.get(one.n) ?? []).length === 0 ? 'none' : (needs.get(one.n) ?? []).map(n => `Task ${n}`).join(', '),
          lane: lanes.get(one.n) ?? null,
        },
      ]),
    )
  const written = labelled(PLAN, doc, labels(doc))

  // Under the heading, apart from what follows; nothing else has moved.
  expect(written.split("\n").slice(12, 20)).toEqual([
    '',
    '### Task 2: Repository',
    '',
    '**Needs:** Task 1',
    '**Lane:** backend',
    '',
    '**Files:**',
    '- Modify: `backend/app/repositories/transfer.py:10-40`',
  ])
  expect(written.split('\n').filter(line => !/^\*\*(Needs|Lane):\*\*/.test(line)).join('\n').replace(/\n\n\n/g, '\n\n')).toBe(PLAN)

  // Read back, the document says what was written: no model is asked again.
  const again = read(written)
  expect(again.tasks.map(one => [one.n, one.lane, one.needs])).toEqual([
    ['1', undefined, []],
    ['2', 'backend', ['1']],
    ['3', 'backend', ['2']],
    ['4', 'frontend', ['1']],
    ['5', 'frontend', ['4']],
    ['6', 'backend', ['3']],
    ['7', undefined, ['3', '5', '6']],
  ])
  expect(labelled(written, again, labels(again))).toBe(written)

  // The run it makes is drawn as a fork; a lane taken out puts a task back.
  const run = runFromDoc(again, PATH, false, 0, 's1')
  expect(stagesOf(run).map(one => (one.kind === 'one' ? one.task.id : one.lanes.map(lane => lane.name)))).toEqual([
    'T1',
    ['backend', 'frontend'],
    'T7',
  ])
  const flat = labelled(written, again, new Map(again.tasks.map(one => [one.n, { lane: null }])))
  expect(flat).not.toContain('**Lane:**')
  expect(runFromDoc(read(flat), PATH, false, 0, 's1', run).tasks.some(one => one.lane !== undefined)).toBe(false)
})

test('how a task stands is written under it, and a reader with no ledger takes it from there', () => {
  const doc = read(PLAN)
  let run = runFromDoc(doc, PATH, false, 0, 's1')

  for (const [id, status, note, outcome] of [
    ['T1', 'done', undefined, 'TransferCreate in schemas/transfer.py'],
    ['T2', 'gate-failed', 'create() drops the memo', undefined],
  ] as const) {
    const next = setTask(run, id, status, note, outcome)

    if (typeof next === 'string') {
      throw new Error(next)
    }

    run = next
  }

  const written = labelled(PLAN, doc, statusLabels(doc, run))
  expect(written).toContain('**Status:** done — TransferCreate in schemas/transfer.py')
  expect(written).toContain('**Status:** gate failed — create() drops the memo')
  expect(written.match(/\*\*Status:\*\*/g)?.length).toBe(2)

  // Another session, with no ledger of this plan, reads it as it stands.
  const fresh = runFromDoc(read(written), PATH, false, 0, 's2')
  expect(fresh.tasks.slice(0, 3).map(one => [one.status, one.outcome, one.note])).toEqual([
    ['done', 'TransferCreate in schemas/transfer.py', undefined],
    ['gate-failed', undefined, 'create() drops the memo'],
    ['todo', undefined, undefined],
  ])

  // The gate passes: its line says so, in place; a task set back loses its line.
  const passed = setTask(setTask(run, 'T2', 'done', undefined, 'memo kept') as typeof run, 'T1', 'running')

  if (typeof passed === 'string') {
    throw new Error(passed)
  }

  const after = labelled(written, read(written), statusLabels(read(written), passed))
  expect(after).toContain('**Status:** done — memo kept')
  expect(after).not.toContain('TransferCreate')
  expect(after.match(/\*\*Status:\*\*/g)?.length).toBe(1)
})

test('a model is asked what each task needs from the tasks alone, and its answer is kept only where it makes sense', () => {
  const doc = read(PLAN)
  const request = needsRequest(doc.tasks)

  expect(request).toContain('Task 3: Route')
  expect(request).toContain('files: backend/app/routes/transfers.py, backend/tests/test_transfers.py')
  expect(request).toContain('- Step 1: Add the route')
  expect(request).toContain('Answer with JSON only')

  const needs = needsFromAnswer(
    'Sure: [{"task": "2", "needs": ["1"]}, {"task": "Task 4", "needs": ["Task 1", "99"]}, {"task": "88", "needs": []}]',
    doc.tasks,
  )
  expect([...needs]).toEqual([
    ['2', ['1']],
    ['4', ['1']],
  ])
  expect(needsFromAnswer('I cannot tell.', doc.tasks).size).toBe(0)
})

test('/ledger lanes makes a followed plan parallel in place, and the run follows; a task done is written there too', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const files: Record<string, string> = { [PATH]: PLAN }
  const asked: string[] = []
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$, e) => {
    files[e.path] = e.text

    return { value: undefined }
  })
  on('model.complete', (_$, e) => {
    asked.push(String(e.prompt))

    return {
      value: {
        isAnswered: true as const,
        text: JSON.stringify([...SAID].map(([task, needs]) => ({ task, needs }))),
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })

  const typed = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as const

  await $.command.run({ command: 'ledger', args: `follow ${PATH}`, ...typed })
  expect(String((await $.tool.call({ tool: 'mcp__ledger__report' })).result)).not.toContain('Lane ')

  // What a model read is shown first, and nothing is written: asked to write
  // straight away, it still only proposes.
  const first = String((await $.command.run({ command: 'ledger', args: 'lanes --write', ...typed })).text)
  expect(first).toContain('Ledger proposes 2 lanes')
  expect(first).toContain('1 → [backend: 2, 3, 6 ∥ frontend: 4, 5] → 7')
  expect(first).toContain('Task 6 needs 3')
  expect(first).toContain('Nothing is written yet')
  expect(files[PATH]).toBe(PLAN)
  expect(asked.length).toBe(1)
  // Asked again without writing, the same proposal is shown; no model again.
  expect(String((await $.command.run({ command: 'ledger', args: 'lanes', ...typed })).text)).toContain('Ledger proposes 2 lanes')
  expect(asked.length).toBe(1)

  // Confirmed: what was shown is written, and the run is read from it.
  await $.command.run({ command: 'ledger', args: 'lanes --write', ...typed })
  expect(asked.length).toBe(1)
  expect(files[PATH]).toContain('**Lane:** frontend')
  expect(files[PATH]).toContain('**Needs:** Task 3, Task 5, Task 6')
  const report = String((await $.tool.call({ tool: 'mcp__ledger__report' })).result)
  expect(report).toContain('Lane backend (0/3 done)')
  expect(report).toContain('Lane frontend (0/2 done)')

  // Run again, the document speaks for every task: no model is asked.
  const calls = asked.length
  expect(String((await $.command.run({ command: 'ledger', args: 'lanes --write', ...typed })).text)).toContain(
    'The document already says so',
  )
  expect(asked.length).toBe(calls)

  // A task marked done: its box is ticked and its outcome written under it.
  await $.tool.call({
    tool: 'mcp__ledger__task',
    tasks: [{ id: 'T1', status: 'done', outcome: 'TransferCreate added' }],
  })
  expect(files[PATH]).toContain('**Status:** done — TransferCreate added')
  expect(files[PATH]).toContain('- [x] **Step 1: Write the schema**')
  expect(String((await $.tool.call({ tool: 'mcp__ledger__report' })).result)).toContain('[done] T1 Schemas')
})
