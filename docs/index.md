---
title: graph-agent
---

# graph-agent

A Pi coding agent whose control flow is a mutable Camunda-8-flavour BPMN graph.

The loop that drives the agent -- when to call the model, when to run a tool,
when to stop -- is not code you have to read to change. It is a diagram,
executed by [`bpmn-engine`](https://github.com/paed01/bpmn-engine), that the
agent itself can extend mid-session by splicing in new elements. Every
activity in the diagram dispatches to a **harness**: a small piece of
TypeScript that actually does the work an activity names.

- [Getting started](getting-started.html) -- build the project, run the bundled
  Pi demo loop, pair it with a deterministic `shell` step, point it at a real
  model, and read a run that went wrong.
- [Harness reference](harnesses.html) -- every job type a graph can dispatch to,
  and what it expects on the activity.

The CLI can drive `pi-default-loop` and `shell-demo` end to end against a real
model, for a single turn. Runs that call **tools** hit three open defects --
including one that re-sends the prompt every iteration and bills you for an
unbounded number of turns; read [Tool
calls](getting-started.html#tool-calls) before pointing this at real work. The
other two bundled graphs -- `session-skeleton` and the `craft-graph` it calls --
open on a human gate that nothing can answer yet; see [the bundled
graphs](getting-started.html#the-bundled-graphs).

## Screenshots

The studio -- `graph-agent studio` -- is a BPMN editor and a session viewer for
whatever project you point it at.

![The graph library, with the shell-demo workflow visible](screenshots/project.png)

![Editing shell-demo.bpmn: a Pi turn feeding a deterministic shell check](screenshots/graph-shell-demo.png)

![A completed shell-demo session: one turn, one shell step, both recorded](screenshots/session.png)

These are not mockups -- `scripts/screenshot-docs.mjs` drives the real CLI and
a real Chromium against a throwaway workspace to produce them. Run
`node scripts/screenshot-docs.mjs` after any studio change to refresh them.
