// The ledger's contract. Another mod reads a run with
// `$.state.get({ plugin: 'ledger', key: 'run' })`; only the ledger writes it.

export type LedgerTaskStatus = 'todo' | 'running' | 'gate-failed' | 'done'

export type LedgerTask = {
  id: string
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
}

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
  goal: string
  startedAt: number
  // The session that planned the run; another session finds its agents ended.
  sessionId?: string
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
      isHidden: boolean
      isAll: boolean
    }
  }
}
