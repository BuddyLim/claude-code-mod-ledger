# ledger

A Claude Code mod that keeps the record of an orchestrated run: its units and
tasks, the subagents spawned for them, each gate's verdict, and the findings
reviewers report.

It draws no band. While a run has something to say, the status line carries
one entry, such as `unit 1/2 Schema · 1/3 tasks · 1 gate failed · 2 findings (1
error)`; once every task is done with no agent running and no finding open, the
entry is empty. `/ledger` opens a pane with the whole run.

## Install

This mod uses Claude Code's function-hooks plugin API.

Clone it into your personal skills folder, where Claude Code loads it in every
session:

```bash
git clone https://github.com/BuddyLim/claude-code-mod-ledger ~/.claude/skills/ledger
```

Or clone it anywhere and load it for one session:

```bash
claude --plugin-dir /path/to/claude-code-mod-ledger
```

It works alone. With the [parked](https://github.com/BuddyLim/claude-code-mod-parked)
mod, a failed gate and each unit's open findings are parked for you; with the
[lens](https://github.com/BuddyLim/claude-code-mod-lens) mod, findings show on
their lines and open there.

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

## Runs

Each plan is a run, and a project keeps its runs: planning again adds one.
Nothing picks which run is written to: a task update goes to the run that has
the task, a spawn to the run whose task its description names, and a finding
to the run of the task it names or of the subagent that reported it. So a task
id may not be reused while a run that has it is under way. The status line
covers every run under way.

A plan may split a run into lanes: parallel tracks of one feature that can be
worked on at once. Each lane then has its own line, with its tasks done of
all, a mark for a failed gate, and the turning mark while one of its
subagents runs; the status line counts each lane.

A run is done by itself once every task is done with no agent running and no
finding open, and opens again if work comes back to it. The last 40 runs are
kept; past that the oldest done ones are dropped.

## Following a plan document

A run can be read from a plan document instead of being recorded by the
agent, so the plan costs no tokens to enter and the document stays the word
on it.

- **Tasks and steps.** Each `### Task N: name` heading is task `TN`; the
  checkboxes under it are its steps; a `##` section is a unit. A task with
  every box ticked is done, with some ticked it is under way.
- **In step.** The document is read again each time it is written or edited,
  and when a session starts.
- **Subagents.** One described as the document names a task ("Task 3: …") is
  recorded against it.
- **Ticking.** When a task is marked done, the open boxes under it are
  ticked. Only `[ ]` becomes `[x]`, only under a done task.
- **Another layout.** A document with no such headings is grouped by a small
  model, from its headings and checkboxes alone and once per document; the
  words and ticks are still read from the document itself.

Two settings in `/config`, the first off by default:

| Setting | Does |
| --- | --- |
| Follow superpowers plans | a plan saved under `docs/superpowers/plans` starts a run by itself |
| Tick finished tasks in the plan | marking a task done ticks its missed boxes |

```
/ledger follow docs/roadmap.md   read this document as a run, wherever it is
/ledger tick                     tick the missed boxes of done tasks now
/ledger tick --dry               say how many it would tick
```

With no plan document, nothing here applies and the agent records the plan.

## The pane

`/ledger` opens it; nothing opens it unasked. It opens on the current run
while that is under way, and on the list of runs otherwise.

**The list** has a row per run: its goal, tasks done of all, failed gates,
open findings, tokens and age. A dot marks the run planned last.

| Key | Does |
| --- | --- |
| `1`–`9`, `Enter` | open that run |
| `d` | close the focused run by hand, or reopen one closed that way |
| `x` | clear the focused run for good, after asking |
| `a` | list done runs too |

**A run** is a line per task: a mark for its state, a failed gate's note
beside it, and a running subagent's model and time beside its task, with a
mark that turns while it runs. Open findings follow, a line each.

| Key | Does |
| --- | --- |
| `e` | details: what each unit and task is for, what was done, tier, agents and tokens, and fixed findings |
| `1`–`9` | add that finding to the prompt, never sending it |
| `b` | back to the list |
| `Esc` | close |

A timer runs only while a subagent does, to turn that mark.

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
