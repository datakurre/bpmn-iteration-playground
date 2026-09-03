---
title: Vision
---

[← back](index.html)

# Vision

**An agent's control flow should be an artifact you can look at, edit,
version and hand to someone else -- not a loop buried in the code that runs
it.**

That is the whole premise. Everything below is what follows from taking it
seriously, and every part of it is something the repository already does; the
file exists so that the reasoning is written down in one place instead of
being spread across `README.md`, six diagrams and a dozen issue threads.

## Why a diagram at all

A coding agent is a loop: call the model, run the tools it asked for, decide
whether to go round again. Every agent has one, and in every agent it is
code -- a function you read top to bottom, whose branches you discover by
reading it, and whose behaviour you change by editing a source file and
shipping a new version.

Making that loop a BPMN diagram changes four things at once:

- **It becomes visible.** `workflows/pi-default-loop.bpmn` is a drawn
  transcription of Pi's own `runLoop()`: steering injection, the truncated
  tool batch, the "terminate only if *every* result says so" rule,
  `prepareNextTurn`, `shouldStopAfterTurn` -- each one its own activity, each
  one a box you can point at. Nothing about the loop is implicit any more.
- **It becomes editable by a non-author.** Changing when the agent stops is
  moving an edge, not understanding a file.
- **It becomes data.** A diagram can be stored per session, versioned per
  edit, diffed, validated, and -- the point of the whole exercise -- written
  by the agent itself.
- **It becomes shareable.** A loop that works well on one codebase is a file
  you can copy to the next one.

The cost is honest and worth stating: BPMN is verbose, and `bpmn-engine` is
not Zeebe, so a graph written here does not run on Camunda and vice versa
(see [Camunda 8 style](https://github.com/datakurre/graph-agent/blob/main/docs/research/04-camunda-8-style.md)).
Camunda 8 flavour was chosen as a *modelling convention*, to inherit
`bpmn-js`, its element templates and `bpmnlint`, not for engine portability.

## The five commitments

### 1. The loop is a diagram, not code

The engine is [`bpmn-engine`](https://github.com/paed01/bpmn-engine); the
diagram is the control flow, in full. This is possible because Pi exposes
every step of its loop as a mutable callback, so control flow can be taken
away from the library without forking it -- the reasoning is in
[Pi's loops, as a graph](https://github.com/datakurre/graph-agent/blob/main/docs/research/05-pi-loops-and-token-cache.md).

There is deliberately no bypass. `session-default`, what `run` uses when
`--graph` is omitted, is a start event, one `callActivity` into
`pi_default_loop`, and an end event -- so out-of-the-box behaviour matches
plain Pi *and* is still a diagram
([#47](https://github.com/datakurre/graph-agent/issues/47)). "Plain Pi" is
not a special case in the code; it is the simplest graph in the library.

### 2. Behaviour lives in harnesses; the diagram only sequences them

An activity names a **harness** with `zeebe:taskDefinition type="..."` and
the registry in `src/agent/harnesses.ts` supplies it: `agent:turn`,
`agent:tool`, `agent:collect-tools`, `agent:steer`, `agent:follow-up`,
`agent:prepare-next-turn`, `graph:lint`, `graph:layout`, `graph:extend`,
`shell`. Every one returns the same five-key result. See the
[harness reference](harnesses.html).

That registry is a *vocabulary*: it is what a diagram may say, what the
editor's palette offers, and what a model drafting a new fragment is told it
may use. Keeping it small and typed is what makes the next commitment
enforceable.

### 3. The agent extends its own control flow, mid-session

`graph:extend` is the self-mutation primitive. `craft-graph` drafts a small
ops list, `graph:lint` merges and checks it, `graph:layout` places it, a
human approves it, and the running engine is stopped and resumed against the
new graph so that what was just spliced in runs in the *same* invocation
([#45](https://github.com/datakurre/graph-agent/issues/45)).

Three properties keep this from being reckless rather than merely impressive:

- **Every splice is a revision, never an overwrite.** A session's graph
  directory is an append-only history, so "what did it change, and when" is
  answerable after the fact.
- **Ids are stable.** `bpmn-engine` replays recovered state by element id, so
  a splice may add but never rename or remove a live element -- which is also
  why the machine's rule is stricter than a human's (see below).
- **The splice stays in the session's own process.** Recovery cannot replay a
  `callActivity`'s linked process once its definition has changed underneath
  it, so a target inside one is rejected rather than left to brick the
  session later ([#86](https://github.com/datakurre/graph-agent/issues/86),
  [#94](https://github.com/datakurre/graph-agent/issues/94)). In practice
  this means "the agent extends its own control flow" is scoped to whatever
  structure the session's *own* process carries -- `session-default`'s is
  just a three-element wrapper around a `callActivity` into
  `pi-default-loop`, so it can gain or lose steps around that loop but not
  edit inside it; `session-craft`'s own process carries the interesting
  structure directly, so it fares better.

### 4. Mechanical correctness is checked, so review can be about judgement

This is the part most easily mistaken for bureaucracy, and it is the opposite:
every check that can be made mechanical is one less thing a human reviewer has
to hold in their head at the approval gate.

`checkSplice` rejects a fragment that is not additive, that names a job type
no harness implements ([#40](https://github.com/datakurre/graph-agent/issues/40)),
that wires a *real* job type to inputs, headers or outputs its harness never
reads or publishes -- naming the exact wrong spelling used, so the redraft
loop has something concrete to fix
([#65](https://github.com/datakurre/graph-agent/issues/65)) -- or that uses a
BPMN element type the runtime does not support, the same allowlist the
editor's palette is restricted to.

So a fragment that reaches the approval gate is *plumbed correctly or it never
got there*. What review is still for is whether the splice does the **right
thing**: a correctly wired `shell` step running the wrong command passes every
check and is still wrong.

### 5. A round trip, so good graphs survive the session that found them

The library is user-level and shared across projects; sessions are per-project
state. A session that spends real turns converging on a good graph should not
leave it buried under `$XDG_STATE_HOME`, so `graph-agent promote` writes it
back into the library as its own callable graph
([#55](https://github.com/datakurre/graph-agent/issues/55)).

    library → session → mutate → promote → library

The premise is to start simple, reproduce the default loop, and iterate
towards a dedicated, re-usable definition -- and the round trip is what makes
"iterate" mean something that accumulates.
`workflows/session-craft.bpmn` is that sentence as a single graph: start with
a prompt, hand it to `craft_graph` to build the steps that follow, run those
steps, and fall back to Pi's own loop when nothing was crafted.

## Supporting values

**Humans and the agent edit the same object.** Not "the agent has a graph and
you have a picture of it". `graph-agent ui` edits the live session graph, and
a human edit is allowed to be *looser* than a splice -- it may delete an
element the token has never reached, because the only real constraint is that
what is currently executing survives
([#46](https://github.com/datakurre/graph-agent/issues/46)). Concurrent edits
are guarded rather than merged blindly: `If-Match`/`ETag` on the write path
([#76](https://github.com/datakurre/graph-agent/issues/76)), and an edit that
lands mid-run is picked up by the running engine instead of being clobbered
by it ([#75](https://github.com/datakurre/graph-agent/issues/75)).

**One session, three altitudes.** `run` is non-interactive, one line per
activity, what CI uses. `tui` is the same machinery with a live transcript, an
activity trail, a status strip and in-terminal answers for human gates.
`ui` is the diagram, the token where it stands, and the turn history beside
it. None of the three is a reimplementation of the others.

**Determinism where it is cheap, a real model where it is not.**
`--dry-run` walks any graph with a scripted provider -- no credential, no
egress -- and the TUI has an equivalent in a recording terminal. Neither
covers the tool path or a real splice, and the project says so loudly:
three defects lived behind a green test suite there, one of them billing 110
turns for a single run. Verification claims are scoped to what was actually
exercised.

**The graph is the documentation.** Rationale lives in `<bpmn:documentation>`
on the element it explains, invariants are pinned by tests that read the
`.bpmn` files themselves (`workflows/workflows.test.ts`), and layout is
generated rather than hand-placed, so authoring a graph is authoring
semantics.

## What this is not

- **Not a workflow product.** There is no server to operate, no deployment
  model, no multi-tenant runtime. The studio is launched from a project
  directory and scoped to it.
- **Not Camunda-compatible.** See above; the namespace is a convention.
- **Not an autonomy story.** The agent extends its own control flow behind a
  lint gate and a human approval gate, and the interesting engineering is in
  the gates.
- **Not a prompt framework.** Nothing here tries to own what you say to the
  model. It owns what happens *around* the model call.

## How to tell whether the vision is being served

A change belongs here if it makes the graph more of a real artifact: more
visible, more editable, more verifiable, more reusable. A change that moves
behaviour *out* of the diagram and back into TypeScript -- a special case in
the runner, a hard-coded branch, an activity whose real meaning is "and then
some code decides" -- is moving against it, whatever else it fixes.
