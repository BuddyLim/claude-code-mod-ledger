// The ledger's contract. Another mod reads a run with
// `$.state.get({ plugin: 'ledger', key: 'run' })`; only the ledger writes it.

export type LedgerTaskStatus = 'todo' | 'running' | 'gate-failed' | 'done'

export type LedgerTask = {
  id: string
  // The lane the task is in, where the plan has parallel lanes: tracks of one
  // feature that can be worked on at once.
  lane?: string
  // The unit of work the task belongs to; tasks of one unit are reviewed together.
  unit: string
  title: string
  // The model the task is meant for: haiku, sonnet or opus.
  tier?: string
  // What the task is for, in a line: what it changes for the user, or which
  // part of the code it touches. Written when the run is planned.
  about?: string
  // How the task is known to be done: what its gate checks.
  check?: string
  status: LedgerTaskStatus
  // The last gate's verdict, or how the task ended.
  note?: string
  // What was done, once it is: what changed and where. The agent's own
  // account, not a checked one.
  outcome?: string
  // The checkbox steps of a task read from a plan document, in its order.
  steps?: LedgerStep[]
}

export type LedgerStep = { text: string; isDone: boolean }

// A unit of the plan, where the plan describes it: what its tasks add up to.
export type LedgerUnitNote = { name: string; about: string }

export type LedgerSpawn = {
  agentId: string
  // The task the subagent was spawned for, when its description names one.
  task?: string
  description: string
  // The agent type, and the model it ran on.
  type: string
  model: string
  startedAt: number
  // Set once its turn completed: when, why it ended, and the tokens it used.
  endedAt?: number
  reason?: string
  tokens?: number
}

export type LedgerSeverity = 'error' | 'warning' | 'note'

export type LedgerFinding = {
  id: number
  path: string
  line?: number
  severity: LedgerSeverity
  summary: string
  task?: string
  // The subagent that reported it; absent when the main agent did.
  agentId?: string
  at: number
  status: 'open' | 'fixed'
}

export type LedgerRun = {
  // Its number among the project's runs; 0 until the ledger has kept it.
  id: number
  goal: string
  startedAt: number
  // The session that planned the run; another session finds its agents ended.
  sessionId?: string
  // When the run was done: by itself once every task is done with no agent
  // running and no finding open, or when the user closed it (`isClosed`).
  doneAt?: number
  isClosed?: true
  // The plan document the run is read from, where it is: the document is then
  // the word on its tasks and steps. `isLaidOutByModel` says a small model
  // grouped its lines, the document not being laid out as superpowers plans are.
  doc?: { path: string; isLaidOutByModel?: true }
  tasks: LedgerTask[]
  // What each unit is for, for the units the plan described.
  units?: LedgerUnitNote[]
  spawns: LedgerSpawn[]
  findings: LedgerFinding[]
  nextFinding: number
}

declare module 'claude-code' {
  interface PluginState {
    ledger: {
      run: LedgerRun | null
      // Every run kept for the project, the newest last; `run` is the current
      // one, which the tools record against.
      runs: LedgerRun[]
      isHidden: boolean
      // The pane: the run it shows in full (0 for the list), the list's row the
      // focus is on, whether done runs are listed, whether a run shows its
      // details, the run a clear is waiting to be confirmed for, and the frame
      // of the mark that turns while a subagent runs.
      shown: number
      cursor: number
      isAll: boolean
      isDetailed: boolean
      confirming: number
      spin: number
      // The finding the focus is on in a run's view, and the place last asked
      // to be shown, which the lens mod opens where it is loaded: a path from
      // the session's folder, a line (0 for the file), and a count of the asks.
      pointed: number
      jump: { path: string; line: number; n: number } | null
    }
  }
}
