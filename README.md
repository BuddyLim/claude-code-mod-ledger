# ledger

A Claude Code mod that keeps the record of an orchestrated run: its units and
tasks, the subagents spawned for them, each gate's verdict, and the findings
reviewers report.

It draws no band. While a run has something to say, the status line carries
one entry, such as `unit 1/2 Schema · 1/3 tasks · 1 gate failed · 2 findings (1
error)`; once every task is done with no agent running and no finding open, the
entry is empty. `/ledger` opens a pane with the whole run.

## What it records

- **The plan.** The agent calls `plan` once with the goal and every task: an
  id, its unit, a title, the tier it is meant for and what its gate checks.
- **What each part is for, and what was done.** The plan can say in a line
  what each unit adds up to and what each task is for; a task marked done can
  carry its outcome: what changed and where. These are the agent's own
  account, where gate verdicts and findings are the checked part.
- **Spawns, by themselves.** Each subagent the session starts is recorded with
  its type, model, start, end and tokens. One whose description begins with a
  task id in brackets (`[T3] add the retry`) is recorded against that task,
  which is marked running.
- **Gate verdicts.** The agent calls `task` with `done`, or `gate-failed` and a
  note.
- **Findings.** Any agent, a reviewing subagent included, calls `finding` with
  a path, a line, a severity and a one-line summary. `fixed` closes them.

## Commands

```
/ledger          open the pane
/ledger print    print the run in the transcript
/ledger hide     empty the status entry (show brings it back)
/ledger clear    forget the run
```

## The pane

`/ledger` opens it; nothing opens it unasked. It lists the tasks under their
units with each gate's note, the agents (running first, then the five most
recent) with their model, time and tokens, and the open findings with the file
each is in.

| Key | Does |
| --- | --- |
| `1`–`9` | add that finding to the prompt, never sending it |
| `a` | show fixed findings and every finished agent too |
| `Esc` | close |

Times are as of the last redraw: the pane runs no timer.

## For other mods

The run is readable state:

```ts
const { value: run } = await $.state.get({ plugin: 'ledger', key: 'run' } as const)
```

`types/index.d.ts` is the contract (`LedgerRun`, `LedgerTask`, `LedgerSpawn`,
`LedgerFinding`). Only the ledger writes it. One run is kept per project, keyed
by the working directory, across sessions.

## Development

```bash
claude plugin validate .
claude plugin test .
```

- `hooks/register.tsx`: the tools, the spawn and turn hooks, the command.
- `hooks/run.ts`: the run's logic, free of the engine.
- `hooks/kit/`: a copy of the shared mod-kit; edit the source and sync.
- `types/index.d.ts`: the state contract.
