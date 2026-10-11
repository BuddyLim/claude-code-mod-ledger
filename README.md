# ledger

A Claude Code mod that keeps the record of an orchestrated run: its units and
tasks, the subagents spawned for them, each gate's verdict, and the findings
reviewers report.

It draws no band. While a run has something to say, the status line carries
one short entry: the task work is on and how many more are not done, such as
`T3 add the retry · 4 more`, however many tasks, lanes or findings the run
has. Once every task is done with no agent running and no finding open, the
entry is empty. `/ledger` opens a pane with the whole run, drawn as a pipeline.

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
/ledger sessions open the pane on the ledgers of other sessions
/ledger print    print the run in the transcript
/ledger hide     empty the status entry (show brings it back)
/ledger clear    forget the run
```

## Runs

Each plan is a run, and a session keeps its runs: planning again adds one.
Nothing picks which run is written to: a task update goes to the run that has
the task, a spawn to the run whose task its description names, and a finding
to the run of the task it names or of the subagent that reported it. So a task
id may not be reused while a run of the session that has it is under way. The
status line names the task work is on in the newest run under way, and counts
the tasks not done across them all.

A plan may split a run into lanes: parallel tracks of one feature that can be
worked on at once. Tasks are read in the plan's order: those with no lane run
one after another, and tasks in lanes that follow one another are a fork, each
lane a branch that joins the line again where the lanes end.

A run is done by itself once every task is done with no agent running and no
finding open, and opens again if work comes back to it. The agent is told to
settle as it goes: a task is marked done when its gate passes and a finding
closed when its fix lands, and a `task` call that leaves findings open on what
it marked done is answered with which ones. The last 40 runs of a session are
kept; past that the oldest done ones are dropped.

## Sessions

The ledger belongs to the session, not the folder. Its runs are stored under
the session's id on every change, so two sessions at work in one project never
write each other's ledger, and a session brought back with `/resume` or
`claude --resume` finds its own as it left it; the subagents it showed running
ended with the process that ran them, and one that is sent a message and works
again counts as running again. After a `/clear` or an in-app resume the
ledger follows the session the process is then in, from its next prompt.

The ledgers of other sessions, of this project and of others, can be read from
the pane (`s`, or `/ledger sessions`): this folder's sessions first, the latest
changed first. Another session's ledger is shown as it was read and is read
only. The last 60 sessions that have a ledger are kept.

Runs kept a folder each by an earlier version are filed by the session that
planned them the first time this version starts; what was stored stays.

## Keeping it true

- **Cancelled.** A task that will not be done is marked `cancelled`, with why.
  It holds its run open no more than a done one.
- **Stalled.** A task marked running that no subagent is on, in a run nothing
  has touched for an hour, is drawn as stalled (`◌`) and turns no mark; so is a
  session in the list that was at work when its ledger last changed.
- **Out of turn.** When a subagent starts on a task before the tasks it needs
  are done, or one lane of a fork is started and the lanes beside it are left
  waiting, the agent is told, once, in a note it reads.
- **Reports.** What a subagent said as its turn ended is kept, cut short, and
  shown with its task in the overview: the nearest thing to its log.
- **Room.** The ledgers keep to 3 MB of the plugin's store. Over that, the
  sessions changed longest ago give up their finished runs first, then go
  whole; the session at work is never touched, and a toast says when it
  happened.

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

### Making a plan parallel

A superpowers plan is written as one task after another. `/ledger lanes`
reads such a plan and writes it back, in the same file, as one that can be
worked on in parallel where its tasks allow:

```
/ledger lanes docs/superpowers/plans/my-plan.md   work out the lanes and write them
/ledger lanes --dry                               say what it would write, for the followed plan
```

It learns what each task needs, from the task's `**Needs:**` line where it
has one, else from one model call that is shown only the tasks, their files
and their steps; and always from the files themselves, since two tasks that
touch one file are never put in two lanes. From that it finds the forks: a
task every other comes before or after stays in the line, and the tasks
between two such are lanes, each a chain of tasks that need one another. It
writes two lines under each task heading and changes nothing else:

```markdown
### Task 4: API client

**Needs:** Task 1
**Lane:** frontend
```

A wrong `**Needs:**` line is yours to edit; run the command again and the
lanes follow, with no model asked. A plan in which every task needs the one
before it stays a line. The agent is told to start one subagent per lane at
once, and the task after a fork only when every lane is done.

The other lines a task may carry are read the same way: `**Unit:**`,
`**Tier:**` and `**Gate:**`. A `##` section counts as a unit only where the
tasks sit under more than one, so a plan whose tasks all follow a "File Map"
section has no units. As tasks change, the ledger writes how each stands
under it (`**Status:** done — what was done`, or `gate failed — why`), so the
document says where the work is to a session that has no ledger of it.

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
open findings, tokens and age.

| Key | Does |
| --- | --- |
| `1`–`9`, `Enter` | open that run |
| `d` | close the focused run by hand, or reopen one closed that way |
| `x` | clear the focused run for good, after asking |
| `a` | list done runs too |
| `s` | the sessions that have a ledger; `h` comes back to this one |

**A run** is a pipeline, in two views. The overview draws it across, as a CI
run is drawn, a node a task (`●` done, `✗` gate failed, `○` to do, and a mark
that turns for one running):

```
●─┬─●─⠹─┬─○
  ├─✗───┤
  ╰─○───╯
```

with words only for what is running or has failed, or with neither, the task
that comes next. `e` turns to details: the same line running down, a line a
task, a fork's lanes as rails side by side, each lane's tasks under its name
and a unit's name where it starts, with what each is for, what was done, and
what its gate cost: the models its subagents ran on, how many, how long they
worked and their tokens. A pipeline too wide to draw across is drawn down in
both. Under a rule, open findings follow, a line each; in a narrow pane a
finding's place keeps its end, the file and line, and its summary goes under
it.

| Key | Does |
| --- | --- |
| `e` | details and back: every task on a line, what each unit and task is for, what was done, models, agents, time and tokens, and fixed findings |
| click | in the overview, a click on a node or on the id beside it shows that task in full |
| `n`, `p` | in the overview, walk the pipeline's nodes: the task under the mark is shown in full (how it stands, its lane and unit, what it is for or what was done, its gate, what it cost, its open findings); `c` goes back to the task work is on |
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
`LedgerFinding`). Only the ledger writes it. `run` and `runs` are the
session's own; `home` is the session they are read from.

## Development

```bash
claude plugin validate .
claude plugin test .
```

- `hooks/register.tsx`: the tools, the spawn and turn hooks, the command.
- `hooks/run.ts`: the run's logic, free of the engine.
- `hooks/book.ts`: a session's runs kept together, and the list of sessions.
- `hooks/pipe.ts`: a run laid out as a pipeline.
- `hooks/doc.ts`: a plan document read into a run, and written back to.
- `hooks/lanes.ts`: a sequential plan's tasks put in lanes.
- `hooks/kit/`: a copy of the shared mod-kit; edit the source and sync.
- `types/index.d.ts`: the state contract.
