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

Runs that call tools work too, including parallel calls in one response -- see
[Tool calls](#tool-calls).

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
`agent:prepare-next-turn`, and the loop back for another turn. Against a real
model that path converges:

```
$ graph-agent run "Use the bash tool to count the lines in notes.txt, then tell me the number." \
    --model anthropic/claude-haiku-4-5
  inject_pending  agent:steer  nothing queued
  llm_turn  agent:turn  I'll count the lines in notes.txt for you.
  run_tool  agent:tool  bash: ok
  collect_batch  agent:collect-tools  tool results recorded
  prepare_next_turn  agent:prepare-next-turn  another turn
  inject_pending  agent:steer  nothing queued
  llm_turn  agent:turn  The file **notes.txt** contains **3 lines**.
  drain_followup  agent:follow-up  no follow-up

session 43e3f970  completed  2 turn(s)
```

That exact prompt used to run **110 turns** without ever answering, because the
initial prompt was re-sent on every iteration. A batch of parallel calls works
too -- each instance now runs with its own arguments rather than repeating the
first:

```
$ graph-agent run "Read both a.txt and b.txt using the read tool, in parallel ..." \
    --model anthropic/claude-haiku-4-5
  llm_turn  agent:turn  I'll read both files in parallel for you.
  run_tool  agent:tool  read: ok
  run_tool  agent:tool  read: ok
  collect_batch  agent:collect-tools  tool results recorded
  ...
  llm_turn  agent:turn  - **a.txt** has **2 lines** ... - **b.txt** has **4 lines**

session c369b71f  completed  2 turn(s)
```

Three defects lived on this path
([#25](https://github.com/datakurre/graph-agent/issues/25),
[#26](https://github.com/datakurre/graph-agent/issues/26),
[#27](https://github.com/datakurre/graph-agent/issues/27)) and **`make test`
was green through all of them**, because the suite scripted tool calls one at a
time and `--dry-run` stops before the loop iterates. Anything new on this path
still deserves a real model, run against a throwaway workspace:
`createPiToolExecutor` hands the model real `read`/`write`/`edit`/`bash` rooted
at the working directory, so never run those checks in your own checkout.

### One trap that is still live

`agent:turn` offers the model every tool in the session, whether or not the
graph has an `agent:tool` activity to run them. A graph without one wedges as
soon as the model tries a tool call -- and the error surfaces two activities
later as `a turn is already in flight with unanswered tool calls`, naming
neither the tool nor the activity that should have answered it
([#36](https://github.com/datakurre/graph-agent/issues/36)).

## The bundled graphs

`make init` seeds four graphs. Three run from the CLI; the fourth starts but
cannot finish:

| Graph | `graph-agent run --graph …` |
|---|---|
| `pi-default-loop` | yes -- the default, tool calls included |
| `shell-demo` | yes |
| `craft-graph` | yes -- falls back to the seeded prompt when there is no session `intent` |
| `session-skeleton` | parks on a gate; answering it runs away (see below) |

A run that reaches a `zeebe:userTask` says so and tells you how to continue:

```
$ graph-agent run "hi" --dry-run --graph session-skeleton
session eacee704  stopped  0 turn(s)
waiting on await_intent
resume with: graph-agent resume eacee704 --answer key=value
```

**Do not answer that gate against a real model.** `resume --answer intent=...`
now reaches `craft-graph`, but its redraft loop does not terminate: 1671
iterations in 45 seconds, no result line, and neither Ctrl-C nor `SIGTERM`
stops it -- only `kill -9`
([#34](https://github.com/datakurre/graph-agent/issues/34)). That is one billed
call per iteration, roughly 37 a second, from a command that never reports
anything. The same path is bounded when driven in-process through
`runSession`'s `onWait`, which is why the regression suite does not catch it.

`craft-graph` on its own runs and stays bounded -- its first activity falls
back to the prompt you type when no `intent` is in scope, and `gw_lint`'s
three-attempt cap holds. It does not yet *succeed*, though: with a real model
every draft is rejected, for two reasons that have nothing to do with the
model's BPMN skills
([#37](https://github.com/datakurre/graph-agent/issues/37)).

The drafting turn is told nothing about the format it must produce -- the
`agent_role: graph_architect` header on `draft_fragment` is parsed but never
consumed by anything, so the model sees only the generic session prompt. And
nothing strips a markdown code fence, which is how models emit XML by default:

```
  draft_fragment  agent:turn  ```xml
<bpmn:serviceTask id="run_tests" name="Run tests"/>
```
  layout_fragment  graph:layout  auto-layout failed: failed to parse document as <bpmn:Definitions>
  lint_fragment  graph:lint  nothing to lint
  ... three attempts, then craft_rejected
```

The element drafted there is exactly what was asked for. It fails on the fence,
and then on "fragment" meaning a bare element to the prompt but a complete
`<bpmn:definitions>` document to `graph:layout` and `checkSplice`.

Ask it to modify an existing graph and it fails earlier still: the model tries
to *read* the graph first, and `craft-graph` has no `agent:tool` activity to
answer with ([#36](https://github.com/datakurre/graph-agent/issues/36)).

So the self-extension loop runs, bounds itself and reports honestly -- but a
splice has not yet landed from a real model.

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
