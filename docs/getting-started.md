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

The generated `config.toml` carries an `[agent] model` key that the resolver
reads, so you can pin a default instead of repeating `--model`. An explicit
`--model` still wins.

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

**If your Anthropic key is identity-linked, the variable alone is not enough.**
Anthropic issues two shapes of `sk-ant-api03-...` key. An ordinary one works
with nothing but the variable. An *identity-linked* one additionally requires
an `anthropic-workspace-id` header on every request, and Pi does not send one
from any environment variable, so the run fails on its first turn:

```
$ graph-agent run "hi" --model anthropic/claude-haiku-4-5
  llm_turn  agent:turn  error: 400 {"type":"error","error":{"type":"invalid_request_error",
  "message":"anthropic-workspace-id is required when authenticating with an
  identity-linked API key; send the id of the workspace this request acts in."}}
```

Check which kind you have in one call, before blaming the graph:

```
curl -sS https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
```

To use an identity-linked key, put the workspace id in Pi's own provider
config at `~/.pi/agent/models.json` (the directory is `$PI_CODING_AGENT_DIR`
if you set it). `graph-agent` inherits it, because it builds its models from
Pi's `ModelRuntime`:

```json
{
  "providers": {
    "anthropic": {
      "headers": { "anthropic-workspace-id": "wrkspc_YOUR_WORKSPACE_ID" }
    }
  }
}
```

The workspace id is on the key's page in the Anthropic console; the Admin API
(`/v1/organizations/workspaces`) can also list them, but only for an admin key
(`sk-ant-admin...`), not for the identity-linked key itself. A wrong or absent
id is easy to tell apart from a wrong key: *"...is required..."* means no
header was sent, *"...must be a valid workspace ID."* means the header arrived
but the value is wrong.

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

Runs that call tools work too -- see [Tool calls](#tool-calls) for what that
path exercises and how it was verified.

### Naming a model

`--model` takes `provider/model`, or a bare provider (the first model that
provider offers), or can be omitted.

**Pass it explicitly.** The resolver now considers only providers with
credentials, but "has credentials" is Pi's judgement and the first match wins:
on a machine with ambient `AWS_*` variables, `amazon-bedrock` is considered
configured and sorts first, so an unqualified `run` still picks
`amazon-bedrock/amazon.nova-2-lite-v1:0` even when the key you exported was an
Anthropic one. Name the model, or pin it in `config.toml`'s `[agent] model`,
which the resolver does now read.

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

`--model` with a name nothing matches now prints a short, provider-scoped
hint rather than the whole catalogue.

### Network egress

Every real run is an outbound HTTPS call to the provider's host, so a sandbox
or CI runner has to allow it. For OpenCode that is `opencode.ai:443` (both
`https://opencode.ai/zen/...` and `https://opencode.ai/zen/go/...` live there).
`AGENTS.md`'s `agent-sandbox` block already lists it; other environments need
their own allowance. For Anthropic it is `api.anthropic.com:443`. A blocked
host surfaces as a failed turn whose message names the host, and the run now
exits non-zero -- see [Troubleshooting](#troubleshooting).

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
`agent:prepare-next-turn`, and the loop back for another turn. That path is
where three defects lived, all of them found by pointing a real model at it and
all now fixed:

- the initial prompt was re-sent on every iteration, so a tool-using run never
  converged -- one observed run reached 110 billed turns
  ([#25](https://github.com/datakurre/graph-agent/issues/25));
- the model was never told what arguments a tool takes, so it guessed
  ([#26](https://github.com/datakurre/graph-agent/issues/26));
- a batch of more than one tool call ran the first call twice and never ran the
  second ([#27](https://github.com/datakurre/graph-agent/issues/27)).

The lesson worth keeping: **`make test` was green through all three**, because
the suite scripted tool calls one at a time and `--dry-run` stops before the
loop ever iterates. `src/agent/runner.test.ts` now covers a two-call batch and
a multi-turn tool run, but anything new on this path still deserves a real
model against a throwaway workspace before you trust it. `createPiToolExecutor`
hands the model real `read`/`write`/`edit`/`bash` rooted at the working
directory, so run those checks somewhere disposable, never in your own
checkout.

## The bundled graphs

`make init` seeds four graphs. All four run:

| Graph | What it is |
|---|---|
| `pi-default-loop` | the default -- Pi's loop drawn, tool calls included |
| `shell-demo` | one Pi turn paired with a deterministic `shell` step |
| `craft-graph` | drafts a BPMN fragment and splices it into the running session |
| `session-skeleton` | asks for an intent, then calls `craft-graph` |

### Extending a graph from inside a session

This is the thing the project is for, and it works end to end against a real
model. `craft-graph` drafts a fragment, lays it out, checks the splice, and
parks for a human to approve:

```
$ graph-agent run "Add a service task that runs 'npm test' after the LLM turn" \
    --graph craft-graph --model anthropic/claude-haiku-4-5
  draft_fragment  agent:turn  ```xml <?xml version="1.0" ...
  layout_fragment  graph:layout  laid out
  lint_fragment  graph:lint  adds 2 element(s)

session 61801712  stopped  1 turn(s)
waiting on lint_fragment, gw_lint, review_fragment
resume with: graph-agent resume 61801712 --answer key=value
```

Approve it and the session's own control flow changes:

```
$ graph-agent resume 61801712 --answer approval=apply --model anthropic/claude-haiku-4-5
  apply_extension  graph:extend  spliced in 2 element(s)

session 61801712  completed  1 turn(s)
```

`graph-agent show` then reports `graph revisions: 2`, and revision `001.bpmn`
really does contain the new element. `--answer approval=reject` leaves the
graph at one revision, as it should.

### Review an approved fragment yourself

`graph:lint` verifies that a fragment is valid BPMN and an *additive* splice.
It does **not** check that each new activity's `zeebe:taskDefinition type`
names a harness that exists
([#40](https://github.com/datakurre/graph-agent/issues/40)). In the run above
the model wrote:

```xml
<zeebe:taskDefinition type="shell:exec" />
<zeebe:input source="=&quot;npm test&quot;" target="command" />
<zeebe:output source="=exitCode" target="test_exit_code" />
```

The registry has `shell`, not `shell:exec`; `shell` takes its command from
`zeebe:taskHeaders`, not `ioMapping`; and its output is `exit_code`, not
`exitCode`. Lint reported `adds 2 element(s)` and the splice was applied. It
surfaces only when something runs the extended graph:

```
error: no harness registered for 'shell:exec' (activity run_npm_test)
```

The drafting model is not given the list of real job types, so it invents
plausible-looking ones. Read [the harness reference](harnesses.html) and check
the fragment at the `review_fragment` gate before approving.

## Keeping the graph library current

`graph-agent init` seeds `$XDG_CONFIG_HOME/graph-agent/workflows` but **never
overwrites**, by design: the library is yours and shared across projects. The
cost is that a bundled graph fixed upstream never reaches a library seeded
before the fix, and nothing warns you
([#35](https://github.com/datakurre/graph-agent/issues/35)). A graph that
"still" misbehaves after a fix landed is worth checking first:

```
for f in workflows/*.bpmn; do
  diff -q "$f" "$(graph-agent where | awk '/^graphs/{print $2}')/$(basename "$f")"
done
```

Copy the bundled file over your library copy to take the fix (back up first if
you have edited it). This is not hypothetical: it made a fixed defect look open
here, and it left the default graph running without a fix that had stopped it
billing 110 turns.

## Troubleshooting

**A turn fails and you want to know why.** The message is on the progress line
and repeated on stderr, and the run exits non-zero:

```
$ graph-agent run "hi" --model anthropic/claude-haiku-4-5
  llm_turn  agent:turn  error: 400 {"type":"error",...}

session 9969f280  error  1 turn(s)
error: 400 {"type":"error",...}
$ echo $?
1
```

For the full record -- usage, tool calls, the graph revision -- read the
session's `meta.json`, or open it in `graph-agent studio`, whose session view
renders the error under the failing turn:

```
cat "$(graph-agent where | awk '/^sessions/{print $2}')"/<session-id>/meta.json
```

**`anthropic-workspace-id is required ...`** Your key is identity-linked; see
[Run against a real model](#run-against-a-real-model). This is a property of
the key, not a bug in the graph, and no environment variable fixes it.

**The run picked a provider you never configured.** Pass `--model` explicitly,
or set `[agent] model` in `config.toml` -- see [Naming a model](#naming-a-model).

**`graph-agent: not set up yet. Run graph-agent init first.`** Every command
except `init`, `where` and `--help` requires the user-level config directory to
exist. `make init` creates it.
