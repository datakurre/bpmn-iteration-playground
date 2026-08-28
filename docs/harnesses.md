---
title: Harness reference
---

[← back](index.html)

# Harness reference

A **harness** is whatever actually performs a BPMN activity: one Pi turn, one
Pi tool call, a graph splice, a shell command. A diagram selects one per
activity with `zeebe:taskDefinition type="..."` (`src/agent/harnesses.ts` is
the registry; `src/agent/harness.ts` defines the five-key result shape every
harness returns: `status`, `summary`, `findings`, `artifacts`, `next_action`).

| Job type | What it does | Notable input / output |
|---|---|---|
| `agent:turn` | Runs exactly one streamed Pi assistant response. | in: `prompt` (only needed on the first turn, or after the transcript is otherwise empty); out: `stop_reason`, `tool_calls`, `usage` |
| `agent:tool` | Runs one tool call the last turn asked for. | in: `tool_call` (a call object, an index into the turn's batch, or omitted for the first unanswered one) |
| `agent:collect-tools` | Lets Pi finish the turn once every tool call in the batch has been answered. | out: `batch_terminate`, `tool_results` |
| `agent:fail-truncated-tools` | Settles a turn whose response was cut off by the output token limit -- Pi has already failed every tool call unexecuted. | out: `batch_terminate`, `tool_results` |
| `agent:steer` | Drains steering messages queued from outside the graph and injects them before the next turn. | out: `injected` (count) |
| `agent:follow-up` | Drains follow-up messages queued from outside the graph. | out: `has_followup` |
| `agent:prepare-next-turn` | Pi's `prepareNextTurn` seam: decides whether the inner loop should stop. Deliberately does not touch the system prompt or tool list -- both sit in front of every message in the prompt cache, so changing them here discards it on every iteration (see `docs/research/05-pi-loops-and-token-cache.md`). | in: `stop_reason`; out: `should_stop` |
| `graph:layout` | Runs `bpmn-auto-layout` over a fragment (or the current session graph). | in: `fragment` (optional); out: `fragment` (laid out) |
| `graph:lint` | Checks that a proposed fragment is a valid, additive splice into the current session graph, before anything applies it. | in: `fragment`; out: `added`, `attempt` |
| `graph:extend` | The self-mutation primitive: replaces the session graph with the fragment spliced in. Additive with stable ids only -- `bpmn-engine` replays recovered child state by element id, so a fragment that renames or removes a live element cannot be recovered. | in: `fragment`; out: `added` |
| `shell` | A deterministic step: runs a command and reports its exit status. No model call. | headers: `command` (required), `fail_on_error` (default `true`); out: `exit_code`, `stdout`, `stderr` |

`shell` is configured entirely from `zeebe:taskHeaders` rather than
`zeebe:ioMapping` input, because the command is a fixed part of what the
activity *is* -- a property of the node, not something a previous activity
computes. Route on the result with a gateway and `zeebe:output source="=exit_code"`,
the way `workflows/shell-demo.bpmn` does; see the [element
template](../element_templates/shell_task.json) for the studio's property
panel binding.

Adding a new job type means adding an entry to the `HarnessRegistry` returned
by `createHarnesses()` in `src/agent/harnesses.ts`, and -- if the studio should
offer it from the properties panel -- an element template under
`element_templates/`.

## User tasks

A `zeebe:userTask`'s answered form also has its `zeebe:ioMapping` output
applied -- `session-skeleton.bpmn`'s `await_intent` publishes `intent`,
`context`, and `session_done` this way -- even though a user task has no
harness (`activity.end`'s content carries the signaled answer, which
`engine.ts` maps the same way a harness result would be). A user task has no
job type, so it is never routed through `createHarnesses()`.

## Retries

`zeebe:taskDefinition retries="n"` sets how many times an activity's harness
call may be attempted before the run fails: no attribute (or `retries="0"`)
is one attempt, `retries="3"` is up to three. This only ever retries a
harness call that **throws or rejects** -- a job failure, in C8 terms. A
harness that *returns* `{ status: "failed", ... }` (via the `failed()`
helper in `src/agent/harness.ts`) is a business error the graph is expected
to route on with a gateway, and is never retried regardless of `retries`.
