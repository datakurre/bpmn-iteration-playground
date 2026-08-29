---
title: Getting started
---

[← back](index.html)

# Getting started

## Build

```
make setup   # npm install
make build   # bundle the CLI, the studio's bpmn-js bundles, and Tailwind CSS
```

(Under Nix: `nix develop --command make build`.)

## Set up

```
make init
```

Copies the bundled graph library (`workflows/*.bpmn`) into
`$XDG_CONFIG_HOME/graph-agent/workflows`, and writes a starter
`config.toml`. The graph library is shared across every project on the
machine; sessions are recorded under `$XDG_STATE_HOME/graph-agent`, one
directory per session, each tagged with the project it ran in. `graph-agent
where` prints all three paths.

The generated `config.toml` advertises an `[agent] model` key, but nothing
reads it yet ([issue #20](https://github.com/datakurre/graph-agent/issues/20));
use `--model` instead.

## Run the Pi demo loop, without a model

`pi-default-loop` -- the default graph -- is a drawn transcription of Pi's own
`runLoop()`: an outer follow-up loop wrapped around an inner turn loop, with
every branch runLoop makes (steering injection, the truncated-tool-batch
path, the batch-terminate rule, `prepareNextTurn`, `shouldStopAfterTurn`)
visible as its own activity. `workflows/workflows.test.ts` pins every one of
those branches against the diagram, so it cannot silently drop one.

`--dry-run` walks a graph with a scripted model that answers once and stops --
no credentials, no network, the fastest way to see whether a graph does what
its author meant:

```
$ graph-agent run "say hello" --dry-run
graph  pi-default-loop
model  dry-run (no model called)

  inject_pending  agent:steer  nothing queued
  llm_turn  agent:turn  [dry run] no model was called.
  drain_followup  agent:follow-up  no follow-up

session 08c358d7  completed  1 turn(s)
```

## Run against a real model

Models come from Pi's `ModelRuntime`, so credentials are configured the way Pi
configures them and nothing is duplicated here: if `pi` can reach a provider,
so can `graph-agent`. There are two routes.

**An API key in the environment.** Pi maps a provider to a well-known variable
-- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
`OPENCODE_API_KEY`, and so on. Exporting one is enough; there is no login step:

```
export OPENCODE_API_KEY=sk-...
graph-agent run "say hello" --model opencode-go/gpt-5.6-luna
```

**Pi's own credential store.** Run `pi`, then `/login`, and pick a provider.
`graph-agent` reads the same store.

A single-turn run works end to end:

```
$ export ANTHROPIC_API_KEY=sk-ant-...
$ graph-agent run "Reply with exactly: hello from graph-agent" --model anthropic/claude-haiku-4-5
graph  pi-default-loop
model  anthropic/claude-haiku-4-5

  inject_pending  agent:steer  nothing queued
  llm_turn  agent:turn  hello from graph-agent
  drain_followup  agent:follow-up  no follow-up

session 497c0b40  completed  1 turn(s)
```

**A run that calls tools does not yet.** See [Tool calls](#tool-calls) before
pointing this at real work -- there are three open defects on that path, one of
which bills you for an unbounded number of turns.

### Naming a model

`--model` takes `provider/model`, or a bare provider (the first model that
provider offers), or can be omitted.

**Pass it explicitly.** Omitting `--model` today resolves against Pi's whole
static catalogue rather than the providers you actually hold credentials for,
so it will happily pick `amazon-bedrock/amazon.nova-2-lite-v1:0` when the only
key you exported was an OpenCode one -- and the run then fails on a provider
you never asked for. That is [issue #17](https://github.com/datakurre/graph-agent/issues/17);
until it is fixed, name the model.

One OpenCode key covers two providers, which are separate catalogues:
`opencode` is Zen (61 models, including the `claude-*` and `gemini-*` families)
and `opencode-go` is Go (23 models). So `opencode/gemini-3.7-flash` and
`opencode-go/gpt-5.6-luna` are both valid, and `--model opencode-go` picks Go's
first model. To see what a key actually unlocks:

```
node -e 'import("@earendil-works/pi-coding-agent").then(async ({ModelRuntime}) => {
  const rt = await ModelRuntime.create();
  for (const m of await rt.getAvailable()) console.log(m.provider + "/" + m.id);
})'
```

`--model` with a name nothing matches prints every id in the catalogue --
tens of thousands of characters ([issue #19](https://github.com/datakurre/graph-agent/issues/19)).
Pipe it to `head`.

### Network egress

Every real run is an outbound HTTPS call to the provider's host, so a sandbox
or CI runner has to allow it. For OpenCode that is `opencode.ai:443` (both
`https://opencode.ai/zen/...` and `https://opencode.ai/zen/go/...` live there).
`AGENTS.md`'s `agent-sandbox` block already lists it; other environments need
their own allowance. A blocked host surfaces as a turn that stops with
`error` -- see [Troubleshooting](#troubleshooting) for how to read the reason,
because the CLI does not print it.

## A deterministic step: `shell`

Every activity in a graph dispatches to a **harness** -- `agent:turn` for a
model call, `agent:tool` for one of the tools the model asked to run,
`graph:extend` for a self-splice, and so on (see the [harness
reference](harnesses.html)). `shell` is the deterministic one: no model call, just
a command and its exit status, for the parts of a graph that should not be
left to a model's self-report.

`workflows/shell-demo.bpmn` pairs the two: one Pi turn, then a shell step that
verifies something about the workspace, gated on the exit code.

```
$ graph-agent run "verify this workspace" --dry-run --graph shell-demo
graph  shell-demo
model  dry-run (no model called)

  turn  agent:turn  [dry run] no model was called.
  verify  shell  `git rev-parse --is-inside-work-tree` exited 0

session 257de4d0  completed  1 turn(s)
```

The command lives in a `zeebe:taskHeaders` `command` header on the activity
(`element_templates/shell_task.json` is the studio's property panel for it);
`fail_on_error` (default `true`) decides whether a non-zero exit fails the
activity outright or just publishes the exit code for a gateway to route on.
Swap the header for whatever the graph should actually confirm -- a test run,
a lint, a build -- rather than the placeholder `git rev-parse` check.

## The studio

```
graph-agent studio
```

serves a BPMN editor and a session viewer scoped to the project you run it
from: the graph library on one side, this project's sessions on the other.
Opening `/graph?id=shell-demo` shows the diagram above in the modeler, with
the Camunda 8 element templates (including "Shell Command") available from
the properties panel. See the [screenshots on the front page](index.html).

`scripts/screenshot-docs.mjs` produces the screenshots in this repo's own
`docs/` by driving the real CLI and a real Chromium against a throwaway
workspace -- run it after any studio change to refresh them.

## Tool calls

`--dry-run` answers once and stops, so it never exercises the half of
`pi-default-loop` that matters most: the tool batch, `agent:collect-tools`,
`agent:prepare-next-turn`, and the loop back for another turn. Driving that
path with a real model surfaces three defects, and until they are fixed a run
that uses tools will not do useful work.

**The prompt is re-sent on every turn**
([#25](https://github.com/datakurre/graph-agent/issues/25)). `llm_turn` maps
`=prompt` unconditionally and the variable is never cleared, so the transcript
grows as `user / assistant / toolResult / user / assistant / toolResult ...`
with the *same* user message each time. The model answers the tool call, is
handed its own original request again, and re-issues the call. One
`graph-agent run` observed here reached **110 turns** -- 110 billed API calls --
and still reported `completed` with exit code 0. Do not leave a tool-using run
unattended.

**The model is not told what arguments a tool takes**
([#26](https://github.com/datakurre/graph-agent/issues/26)).
`PiSession.parkingTool` advertises every tool as
`{type: "object", additionalProperties: true}` described only as "Deferred to
the process graph", discarding the real schema (`bash` requires `command`,
`read` requires `path`, and so on). The model guesses; when it guesses wrong
the call arrives with `arguments: {}` and the real tool fails with
`/bin/bash: line 1: undefined: command not found`.

**A batch of more than one tool call is broken**
([#27](https://github.com/datakurre/graph-agent/issues/27)). The multi-instance
`tool_call` element variable never reaches the harness, so `resolveToolCall`
falls back to the first call for every instance. With two calls in a message,
the first runs twice, the second never runs, and the session ends in `error`.
Parallel tool calls are normal for current models, so this is the main path.

None of the three is visible under `--dry-run`, and the test suite scripts tool
calls one at a time, so `make test` stays green through all of them.

## The bundled graphs

`make init` seeds four graphs. Two run from the CLI today, two do not:

| Graph | `graph-agent run --graph …` |
|---|---|
| `pi-default-loop` | yes -- the default |
| `shell-demo` | yes |
| `session-skeleton` | no -- parks on the `await_intent` user task |
| `craft-graph` | no -- called by `session-skeleton`, not run directly |

`session-skeleton` opens on a `zeebe:userTask`, and there is currently no way
to answer one: neither the CLI nor the studio wires the `onWait` hook
`runSession` provides for it. A run parks, prints nothing, and `resume` parks
again on the same gate ([issue #21](https://github.com/datakurre/graph-agent/issues/21)).

`craft-graph` is the sub-process `session-skeleton` calls. Its first activity
maps `=intent`, which the caller supplies from that form, so running it
standalone starts a turn with no prompt no matter what you type on the command
line ([issue #22](https://github.com/datakurre/graph-agent/issues/22)).

Both are worth reading in the studio -- they are the design for the
self-extending session -- but `pi-default-loop` and `shell-demo` are what you
can actually drive from a terminal right now.

## Troubleshooting

**A turn prints `stopped: error`.** The CLI does not print why, and the run
still ends `completed` with exit code 0
([issue #18](https://github.com/datakurre/graph-agent/issues/18)). The reason is
recorded, in two places you can read:

```
$ cat "$(graph-agent where | awk '/^sessions/{print $2}')"/<session-id>/meta.json
...
"stopReason": "error",
"error": "OpenAI API error (403): 403 Host not in allowlist: opencode.ai. ..."
```

or open the session in `graph-agent studio`, whose session view *does* render
the message under the failing turn. Until #18 is fixed, do not read
`completed` or a zero exit code as "the run worked" -- check the turn list.

**The run picked a provider you never configured.** See
[Naming a model](#naming-a-model): pass `--model` explicitly. The `[agent]
model` key that `init` writes into `config.toml` is not read by anything yet
([issue #20](https://github.com/datakurre/graph-agent/issues/20)), so it cannot
stand in for the flag.

**`graph-agent: not set up yet. Run graph-agent init first.`** Every command
except `init`, `where` and `--help` requires the user-level config directory to
exist. `make init` creates it.
