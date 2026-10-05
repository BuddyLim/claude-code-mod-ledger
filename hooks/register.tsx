import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LedgerRun } from '../types'
import { ICON, refIcon } from './kit/icons'
import { PAD } from './kit/layout'
import {
  SEVERITIES,
  STATUSES,
  countsOf,
  ended,
  findingText,
  placeOf,
  spawnMeta,
  tokensText,
  unitsOf,
  fixed,
  found,
  isRun,
  orphaned,
  plan,
  report,
  resumed,
  setTask,
  spawned,
  statusText,
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

const PANE = 'ledger'
// How many finished agents the pane lists before "show all".
const FEW = 5

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

This session keeps a ledger of orchestrated work, which the user follows in the status line and with /ledger. Keep it true with the ${PLAN}, ${TASK}, ${FINDING}, ${FIXED} and ${REPORT} tools.

When a plan of several tasks is settled and you are about to delegate it, call ${PLAN} once with the goal and every task: an id (T1, T2, ...), the unit it belongs to (tasks reviewed together share one), a title, one line on what it is for ("about": what it changes for the user, or which part of the code it touches), the tier it is meant for (haiku, sonnet or opus) and the check its gate applies. Give "units" too: one line on what each unit adds up to for the user. Planning again replaces the run.
Start each subagent's description with its task id in brackets, as in "[T3] add the retry": the ledger records the spawn against that task and marks it running.
After a task's gate, call ${TASK} with status "done" and an "outcome" (what was done: what changed and in which files), or "gate-failed" and a one-line note of what failed; call it again once a failed task is fixed.
Tell every reviewing subagent to report each problem with ${FINDING} (path, line, severity, a one-line summary) as well as in its answer, and report your own the same way. Call ${FIXED} with a finding's id once it is dealt with.
Call ${REPORT} when resuming work, when unsure where the run stands, and when the user asks for a status update: answer from it. Skip the ledger for work you do yourself without delegating.`

const SUBAGENT_REFUSAL =
  'Only the main agent changes the plan and its tasks. Report findings with the finding tool, and the rest in your final answer.'

const keyOf = async ($: EngineInterface) => `run:${await $.session.cwd()}`

const load = async ($: EngineInterface): Promise<LedgerRun | null> => {
  const stored = await $.store.get(await keyOf($))

  return isRun(stored) ? stored : null
}

// Keeps the state other mods read and the status line's entry in step with
// the run. The entry is empty while hidden or with nothing to say.
const show = async ($: EngineInterface, now: LedgerRun | null) => {
  await update($, run, () => now)
  $.ui.status(now === null || (await read($, isHidden)) ? undefined : statusText(now))
}

// One change at a time: two hooks recording at once would otherwise both read
// the run before either wrote it, and the second write would drop the first.
let changes: Promise<unknown> = Promise.resolve()

// Reads the stored run, applies the change and writes it back; answers the
// reason when the change was refused, there is no run, or the store failed.
const changeNow = async (
  $: EngineInterface,
  apply: (now: LedgerRun | null) => LedgerRun | string | null,
): Promise<{ run: LedgerRun | null } | { error: string }> => {
  try {
    const after = apply(await load($))

    if (typeof after === 'string') {
      return { error: after }
    }

    if (after === null) {
      await $.store.delete(await keyOf($))
    } else {
      await $.store.set(await keyOf($), after)
    }

    await show($, after)

    return { run: after }
  } catch (error) {
    return { error: `The ledger could not be saved: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const change = (
  $: EngineInterface,
  apply: (now: LedgerRun | null) => LedgerRun | string | null,
): Promise<{ run: LedgerRun | null } | { error: string }> => {
  const next = changes.then(() => changeNow($, apply))
  changes = next.catch(() => undefined)

  return next
}

// The subagents whose last turn has ended, so a tool call from one is seen as
// it resuming; and the ends that arrived before their spawn was recorded.
const over = new Set<string>()
const earlyEnds = new Map<string, { reason: string; tokens: number | undefined; at: number }>()

const NO_RUN =`Nothing is planned. Call ${PLAN} first.`

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

// What a plan call says each unit is for; an entry that names no unit or says
// nothing of it is left out.
const unitNotes = (value: unknown): { name: string; about: string }[] =>
  (Array.isArray(value) ? (value as unknown[]) : []).flatMap(one => {
    const entry = (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>
    const name = text(entry.name)
    const about = text(entry.about)

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

    if (id === undefined || title === undefined) {
      return 'Every task needs an id and a title.'
    }

    const unit = text(entry.unit)
    const tier = text(entry.tier)
    const check = text(entry.check)
    const about = text(entry.about)

    tasks.push({
      id,
      title,
      ...(unit !== undefined ? { unit } : {}),
      ...(tier !== undefined ? { tier } : {}),
      ...(check !== undefined ? { check } : {}),
      ...(about !== undefined ? { about } : {}),
    })
  }

  return tasks
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ledger',
      description: 'Show the run: /ledger [hide | show | clear]',
    })
    await $.tool.register({
      name: 'plan',
      description:
        'Record the settled plan of an orchestrated run: its goal and every task. Replaces the run in progress.',
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
      description: "Record a task's state after its gate: done, or gate-failed with a note of what failed.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: [...STATUSES] },
          note: { type: 'string', description: "One line: the gate's verdict, or how the task ended" },
          outcome: {
            type: 'string',
            description: 'With "done": what was done, in a line or two: what changed and in which files',
          },
        },
        required: ['id', 'status'],
      },
    })
    await $.tool.register({
      name: 'finding',
      description:
        'Report one problem a review found, at the place it is. Subagents call this too; the user sees it with the run.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The file, relative to the project root' },
          line: { type: 'integer', description: 'The line, counted from 1' },
          severity: { type: 'string', enum: [...SEVERITIES] },
          summary: { type: 'string', description: 'One line: what is wrong and what it causes' },
          task: { type: 'string', description: 'The id of the task the change belongs to, when known' },
        },
        required: ['path', 'severity', 'summary'],
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
      const at = await $.clock.now()
      await change($, now =>
        now !== null && now.sessionId !== sessionId ? { ...orphaned(now, at), sessionId } : now,
      )
      await show($, await load($))
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

    const now = await $.clock.now()
    const sessionId = await $.session.id()
    const changed = await change($, () => plan(text(e.goal) ?? '', tasks, now, sessionId, unitNotes(e.units)))

    if ('error' in changed) {
      return { deny: changed.error }
    }

    await update($, isHidden, () => false)
    await show($, changed.run)

    return { result: `Planned ${tasks.length} task${tasks.length === 1 ? '' : 's'}.` }
  })

  on('tool.call', { tool: TASK }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: SUBAGENT_REFUSAL }
    }

    const id = text(e.id)
    const status = STATUSES.find(one => one === e.status)

    if (id === undefined || status === undefined) {
      return { deny: `task needs an id and a status, one of ${STATUSES.join(', ')}.` }
    }

    const changed = await change($, now => (now === null ? NO_RUN : setTask(now, id, status, text(e.note), text(e.outcome))))

    return 'error' in changed ? { deny: changed.error } : { result: `Task ${id} is ${status}.` }
  })

  on('tool.call', { tool: FINDING }, async ($, e) => {
    const path = text(e.path)
    const summary = text(e.summary)
    const severity = SEVERITIES.find(one => one === e.severity)
    const line = typeof e.line === 'number' && Number.isInteger(e.line) && e.line > 0 ? e.line : undefined

    if (path === undefined || summary === undefined || severity === undefined) {
      return { deny: `finding needs a path, a summary and a severity, one of ${SEVERITIES.join(', ')}.` }
    }

    const agentId = e.agentId
    const named = text(e.task)
    const at = await $.clock.now()
    const changed = await change($, now => {
      if (now === null) {
        return NO_RUN
      }

      // A subagent that names no task reports for the one it was spawned for.
      const task = named ?? now.spawns.find(one => one.agentId === agentId)?.task

      return found(
        now,
        {
          path,
          severity,
          summary,
          ...(line !== undefined ? { line } : {}),
          ...(task !== undefined ? { task } : {}),
          ...(agentId !== undefined ? { agentId } : {}),
        },
        at,
      )
    })

    return 'error' in changed
      ? { deny: changed.error }
      : { result: `Recorded as finding #${(changed.run?.nextFinding ?? 1) - 1}.` }
  })

  on('tool.call', { tool: FIXED }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: SUBAGENT_REFUSAL }
    }

    const ids = Array.isArray(e.ids) ? (e.ids as unknown[]).filter(one => typeof one === 'number') : []

    if (ids.length === 0) {
      return { deny: 'fixed needs ids: the numbers of the findings dealt with.' }
    }

    const changed = await change($, now => (now === null ? NO_RUN : fixed(now, ids)))

    return 'error' in changed ? { deny: changed.error } : { result: `Marked ${ids.length} fixed.` }
  })

  on('tool.call', { tool: REPORT }, async $ => {
    const now = await load($)

    return { result: now === null ? 'Nothing is planned.' : report(now, true) }
  })

  // A subagent started: recorded against the task its description names. A
  // session with no run planned records nothing.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId

    if (agentId !== undefined) {
      const model = started.model
      const startedAt = await $.clock.now()
      await change($, now => {
        if (now === null) {
          return null
        }

        const task = taskOf(now, e.description, e.prompt)
        const record = spawned(now, {
          agentId,
          description: e.description,
          type: e.subagentType,
          model,
          startedAt,
          ...(task !== undefined ? { task } : {}),
        })
        // Its turn may have ended before this record was made.
        const early = earlyEnds.get(agentId)
        earlyEnds.delete(agentId)

        return early === undefined ? record : ended(record, agentId, early.reason, early.tokens, early.at)
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
      const at = await $.clock.now()
      await change($, now => {
        if (now === null) {
          return now
        }

        if (!now.spawns.some(one => one.agentId === agentId)) {
          earlyEnds.set(agentId, { reason, tokens, at })

          return now
        }

        over.add(agentId)

        return ended(now, agentId, reason, tokens, at)
      })
    }

    return next(e)
  })

  // A subagent whose turn had ended calls a tool: it was sent a message and is
  // at work again.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId

    if (agentId !== undefined && over.has(agentId)) {
      over.delete(agentId)
      await change($, now => (now === null ? now : resumed(now, agentId)))
    }

    return next(e)
  })

  on('command.run', { command: 'ledger' }, async ($, e) => {
    const word = e.args.trim()

    if (word === 'hide' || word === 'show') {
      await update($, isHidden, () => word === 'hide')
      await show($, await load($))

      return { text: `Ledger: the status entry is ${word === 'hide' ? 'hidden' : 'shown'}.` }
    }

    if (word === 'clear') {
      const changed = await change($, () => null)

      return { text: 'error' in changed ? changed.error : 'Ledger: the run is cleared.' }
    }

    const now = await load($)

    if (now === null) {
      return { text: 'Ledger: nothing is planned. The agent records a plan when it delegates one.' }
    }

    if (word === 'print') {
      return { text: report(now) }
    }

    await show($, now)
    await $.ui.open({ id: PANE, title: 'Ledger', focus: true, closeOnEscape: true })

    return { text: 'Ledger pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, run)
    // What is drawn is narrower than the pane by the padding at each side.
    const columns = Math.max(30, (e.props.bodyColumns ?? e.viewport?.columns ?? 60) - 2 * PAD)
    const rule = '─'.repeat(columns)

    if (now === null) {
      return (
        <Box flexDirection="column" paddingX={PAD}>
          <Text bold>Ledger</Text>
          <Text dimColor>Nothing is planned. The agent records a plan when it delegates one.</Text>
        </Box>
      )
    }

    const all = await read($, isAll)
    const at = await $.clock.now()
    const counts = countsOf(now)
    const running = now.spawns.filter(one => one.endedAt === undefined)
    const finished = now.spawns.filter(one => one.endedAt !== undefined).reverse()
    const open = now.findings.filter(one => one.status === 'open')
    const closed = now.findings.filter(one => one.status === 'fixed')
    const agents = [...running, ...(all ? finished : finished.slice(0, FEW))]
    const findings = [...open, ...(all ? closed : [])]
    const hiddenAgents = running.length + finished.length - agents.length

    return (
      <Box flexDirection="column" paddingX={PAD}>
        <Box justifyContent="space-between">
          <Text bold wrap="truncate-end">
            <Text color="cyan">{ICON.tasks} </Text>
            {now.goal === '' ? 'Ledger' : now.goal}
          </Text>
          <Text dimColor>
            {' '}
            {counts.done}/{counts.tasks} tasks
          </Text>
        </Box>
        <Text dimColor>{rule}</Text>
        {unitsOf(now).map(unit => (
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              <Text bold wrap="truncate-end">
                {unit.name}
              </Text>
              <Text dimColor>
                {' '}
                {unit.tasks.filter(one => one.status === 'done').length}/{unit.tasks.length}
              </Text>
            </Box>
            {unit.about === undefined ? null : (
              <Box paddingLeft={2}>
                <Text wrap="wrap">{unit.about}</Text>
              </Box>
            )}
            {unit.tasks.map(one => (
              <Box flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color={TASK_TONES[one.status]} dimColor={one.status === 'todo'}>
                    {'  '}
                    {TASK_ICONS[one.status]}{' '}
                  </Text>
                  <Text bold>{one.id}</Text>
                  {one.tier === undefined ? '' : <Text dimColor> {one.tier}</Text>} {one.title}
                </Text>
                {/* Once it is done, what was done says more than what it was for. */}
                {one.outcome !== undefined ? (
                  <Box paddingLeft={6}>
                    <Text wrap="wrap">
                      <Text color="success">Outcome </Text>
                      {one.outcome}
                    </Text>
                  </Box>
                ) : one.about !== undefined ? (
                  <Box paddingLeft={6}>
                    <Text wrap="wrap" dimColor>
                      {one.about}
                    </Text>
                  </Box>
                ) : null}
                {one.note === undefined ? null : (
                  <Text dimColor wrap="truncate-end">
                    {'      '}
                    {one.note}
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        ))}
        <Box marginTop={1} justifyContent="space-between">
          <Text bold>
            <Text color="cyan">{ICON.agents} </Text>Agents
          </Text>
          <Text dimColor>
            {running.length} running · {finished.length} finished · {tokensText(counts.tokens)} tokens
          </Text>
        </Box>
        {agents.length === 0 && <Text dimColor>{'  '}None spawned yet.</Text>}
        {agents.map(one => (
          <Box justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color={one.endedAt === undefined ? 'cyan' : 'success'} dimColor={one.endedAt !== undefined}>
                {'  '}
                {one.endedAt === undefined ? ICON.running : ICON.done}{' '}
              </Text>
              {one.description}
            </Text>
            <Text dimColor> {spawnMeta(one, at)}</Text>
          </Box>
        ))}
        {hiddenAgents > 0 && (
          <Text dimColor>
            {'  '}… and {hiddenAgents} more finished
          </Text>
        )}
        <Box marginTop={1} justifyContent="space-between">
          <Text bold>
            <Text color={counts.errors > 0 ? 'error' : 'warning'}>{ICON.finding} </Text>Findings
          </Text>
          <Text dimColor>
            {open.length} open · {closed.length} fixed
          </Text>
        </Box>
        {findings.length === 0 && <Text dimColor>{'  '}None open.</Text>}
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
                {one.task === undefined ? null : <Text dimColor> {one.task}</Text>}
              </Box>
              <Text wrap="wrap" dimColor={!isOpen}>
                {'      '}
                {one.summary}
              </Text>
            </Box>
          )
        })}
        <Text dimColor>{rule}</Text>
        <Box columnGap={2}>
          <Text dimColor wrap="truncate-end">
            1-9 add a finding to the prompt
          </Text>
          <Button
            key="all"
            plain
            dimColor
            hotkey="a"
            label={all ? 'open and recent only' : 'show all'}
            onPress={() => update($, isAll, value => !value)}
          />
          <Text dimColor>esc close</Text>
        </Box>
      </Box>
    )
  })

}
