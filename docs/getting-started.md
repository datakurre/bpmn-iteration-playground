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

`session-default` -- run by default when `--graph` is not given -- is a
callActivity into `pi-default-loop`, a drawn transcription of Pi's own
`runLoop()`: an outer follow-up loop wrapped around an inner turn loop, with
every branch runLoop makes (steering injection, the truncated-tool-batch
path, the batch-terminate rule, `prepareNextTurn`, `shouldStopAfterTurn`)
visible as its own activity. `workflows/workflows.test.ts` pins every one of
those branches against the diagram, so it cannot silently drop one. The
callActivity is what makes out-of-the-box behaviour a diagram rather than a
special case: point `session-default`'s `calledElement` at a graph of your
own, or run `pi-default-loop` itself directly, and either still gets those
same invariants for free.

`--dry-run` walks a graph with a scripted model that answers once and stops --
no credentials, no network, the fastest way to see whether a graph does what
its author meant:

```
$ graph-agent run "say hello" --dry-run
graph  session-default
model  dry-run (no model called)

  inject_pending  agent:steer  nothing queued
  llm_turn  agent:turn  [dry run] no model was called.
  drain_followup  agent:follow-up  no follow-up

session 08c358d7  completed  1 turn(s)
```

The progress log names the harness-backed activities that actually ran --
`inject_pending`, `llm_turn`, `drain_followup` all live inside
`pi-default-loop`, reached through `session-default`'s callActivity -- so this
is identical to what `graph-agent run "say hello" --graph pi-default-loop
--dry-run` prints, aside from the `graph` line itself.

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
graph  session-default
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

A session's own graph opens read-only, but "Edit" swaps the viewer for the
same modeler and properties panel the library editor uses
([#46](https://github.com/datakurre/graph-agent/issues/46)). An element the
token has visited or currently stands on is outlined in red -- deleting or
renaming it is rejected when you save, since recovery replays that element's
state by id; deleting one the token has never reached is fine. Saving
appends a new revision the same way `graph:extend` does, tagged `studio
edit`, and a running session picks it up the next time it stops and resumes
(see ["a spliced-in step" above](#extending-a-graph-from-inside-a-session)
for what "the next time" means for a run already in flight).

A parked human gate -- `session-skeleton`'s `await_intent`, `craft-graph`'s
`review_fragment` approval -- shows up on the session page as a real form-js
form, built from the same `zeebe:userTaskForm` schema the graph itself
carries ([#51](https://github.com/datakurre/graph-agent/issues/51)).
Submitting it does not run a model from the browser: it queues the answer in
the session's own state, and `graph-agent resume <session>` (no `--answer`
needed) picks it up the next time it starts. A gate with no form defined
still tells you how to answer it from a terminal instead.

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

## Steering and follow-up

`pi-default-loop` draws two seams from Pi's own `runLoop()` that used to be
permanently dead: `agent:steer` injects a message before the next turn,
`agent:follow-up` decides whether the outer loop takes another lap once the
agent would otherwise stop. Both are queued from outside the graph
([#48](https://github.com/datakurre/graph-agent/issues/48)), two ways:

- **Before the run starts:** `--steer <text>` / `--follow-up <text>` on
  `run`/`resume` (repeatable).
- **Into a run already in flight, from another terminal:**
  `graph-agent steer <session> <text>` / `graph-agent follow-up <session>
  <text>`. These append to the session's own `inbox.jsonl` -- the graph drains
  it the next time it reaches `agent:steer`/`agent:follow-up`, so a message
  queued this way has no effect on a session that has already completed.

```
$ graph-agent run "Say hello in one word." \
    --follow-up "Now say goodbye in one word." --model anthropic/claude-haiku-4-5
  inject_pending  agent:steer  nothing queued
  llm_turn  agent:turn  Hello!
  drain_followup  agent:follow-up  queued 1 follow-up(s)
  inject_pending  agent:steer  nothing queued
  llm_turn  agent:turn  Goodbye!
  drain_followup  agent:follow-up  no follow-up

session ce90951b  completed  2 turn(s)
```

## The TUI

`run` prints one line per activity and exits; it has no way to answer a
parked human gate interactively, and steering/follow-up only ever queue from
outside the process. `graph-agent tui [prompt]`
([#50](https://github.com/datakurre/graph-agent/issues/50)) is the same
`runSession`/`resumeSession` machinery from an interactive terminal instead:

```
graph-agent tui --graph session-skeleton --model anthropic/claude-haiku-4-5
```

The screen is the same shape `run`'s output implies, made live: a transcript
of the session (Pi's own `AssistantMessageComponent`/`ToolExecutionComponent`,
fed straight from `PiSession.agent`'s events -- nothing is re-implemented),
a trail of the last few harness-backed activities, and a status strip with
the graph, turn count, token cache usage, the graph revision, and the live
token ids (`meta.tokens`).

The one thing `run` genuinely cannot do: when the graph parks on a
`bpmn:UserTask`, the TUI renders a prompt for it right there --
`session-skeleton`'s `await_intent` and `craft-graph`'s `review_fragment`
both stop the terminal with `waiting on <activity> — <field label>
(<field key>):`, one line per field in the task's `zeebe:userTaskForm`
schema (falling back to a single generic field if the task has no form at
all). Type an answer and press enter; once every field is answered the
session continues without leaving the process. Typed text answers a gate
when one is parked; otherwise it queues -- bare text as a steering message,
`/follow <text>` as a follow-up -- exactly like `graph-agent steer`/`follow-up`
would from another terminal, since it goes through the same
`SessionStore.queueInbox`.

`graph-agent run` is unchanged: non-interactive, scriptable, what CI uses.
The TUI is a new command, not a flag on `run`.

## The bundled graphs

`make init` seeds five graphs. All five run:

| Graph | What it is |
|---|---|
| `session-default` | the default -- a callActivity into `pi-default-loop`, so OOTB behaviour matches plain Pi while still being a diagram you can re-wire ([#47](https://github.com/datakurre/graph-agent/issues/47)) |
| `pi-default-loop` | Pi's loop drawn, tool calls included -- what `session-default` calls |
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
resume with: graph-agent resume 61801712 --answer review_fragment:key=value
```

Approve it and the session's own control flow changes:

```
$ graph-agent resume 61801712 --answer review_fragment:approval=apply --model anthropic/claude-haiku-4-5
  apply_extension  graph:extend  spliced in 2 element(s)

session 61801712  completed  1 turn(s)
```

`graph-agent show` then reports `graph revisions: 2`, and revision `001.bpmn`
really does contain the new element. `--answer review_fragment:approval=reject`
leaves the graph at one revision, as it should.

A splice takes effect immediately, in the same `run`/`resume` invocation: the
engine driving the session stops and resumes against the new graph the moment
`graph:extend` applies it, so an element the splice adds downstream of the
token's current position runs right away rather than waiting for a separate
`resume` ([#45](https://github.com/datakurre/graph-agent/issues/45)). Nothing
here reaches such an element -- `craft-graph` run on its own ends at
`apply_extension` -- but `session-skeleton`'s own splices do, since its
`craft` callActivity sits well before the session's end:

```
$ graph-agent run --graph session-skeleton \
    --answer "await_intent:intent=Add a shell step that runs 'ls -la' after the craft activity" \
    --answer await_intent:done=true --answer review_fragment:approval=apply \
    --model anthropic/claude-haiku-4-5
  ...
  apply_extension  graph:extend  spliced in 2 element(s)
    note: graph revision 1 applied, resuming
  shell_ls  shell  `ls -la` exited 0

session 1a9e3cfc  completed  1 turn(s)
```

`--answer` accepts a bare `key=value` too, which answers *any* gate that asks
for that key -- convenient for a graph with one gate, like `craft-graph`
above, but scope it to one activity (`activity:key=value`, as above) once a
graph has more than one: an unscoped answer is replayed at every gate that
parks, which is how an unrelated payload (say, the intent that started the
session) used to get fed to an approval gate it was never meant to answer
([#44](https://github.com/datakurre/graph-agent/issues/44)).

### What lint checks, and what review is still for

`graph:lint` verifies that a fragment is valid BPMN, an *additive* splice, and
that every new activity's `zeebe:taskDefinition type` names a harness that
exists. The drafting model is also given the real job-type vocabulary up
front, so a run like the one above no longer invents a plausible-looking type
such as `shell:exec` -- lint rejects it and the redraft loop gets a chance to
correct it ([#40](https://github.com/datakurre/graph-agent/issues/40)).

Lint now also checks a *real* job type wired to the wrong inputs, outputs or
headers ([#65](https://github.com/datakurre/graph-agent/issues/65)). A model
that writes

```xml
<zeebe:taskDefinition type="shell" />
<zeebe:input source="=&quot;npm test&quot;" target="command" />
<zeebe:output source="=exitCode" target="test_exit_code" />
```

is rejected before it ever applies: `shell` is a real, registered job type,
but it takes its command from `zeebe:taskHeaders`, not `ioMapping`, and its
output is `exit_code`, not `exitCode` -- lint's rejection names both mistakes,
by the exact wrong spelling used, so the redraft loop's `lint_feedback` has
something concrete to fix. Read [the harness reference](harnesses.html) for
each job type's real inputs, outputs and headers.

What lint still cannot check -- and what review at the `review_fragment` gate
is for -- is whether the splice does the *right thing*: a correctly wired
`shell` step running the wrong command is plumbed perfectly and still wrong.
"Additive, a registered job type, and correctly wired" is not the same as
"does what was asked".

## Promoting a session's graph back to the library

The premise is to start simple, reproduce the default loop, and iterate
towards a dedicated, re-usable graph definition -- and `graph-agent promote`
is the last step of that round trip. A session that spent real turns
converging on a good extension leaves that graph buried under
`$XDG_STATE_HOME`, tagged with a revision number and carrying whatever the
session happened to link in; `promote` writes it into the shared library as
its own, callable graph instead
([#55](https://github.com/datakurre/graph-agent/issues/55)):

```
$ graph-agent promote <session> --as my-graph
promoted revision 3 of <session> to /.../graph-agent/workflows/my-graph.bpmn, callable as calledElement="my_graph"
unlinked (still callable via calledElement): craft_graph
```

`--as <name>` is required -- there is no good default name for what is, after
all, a naming decision. `--revision <n>` picks a revision other than the
latest. Three things happen before the file is written:

- **Unlinking.** Every process `linkGraph` inlined at session start (the
  non-executable ones) is dropped; a `callActivity` pointing at one, like
  `craft_graph`, is left exactly as it was, ready to be linked again the next
  time a session starts from this graph. The promoted file ends up with
  exactly one executable process, not a copy of everything the session ever
  called.
- **A fresh `<bpmn:definitions id>`.** A session pins its id for recovery, so
  reusing it verbatim risks a future session colliding with this one's.
- **A fresh `<bpmn:process id>`, normalised from `--as`.** `calledElement`
  names a *process*, not a file, and the library resolves a shared process id
  with last-write-wins -- so a graph promoted under its source session's own
  (unchanged) process id used to collide with every other graph promoted from
  a session with the same shape, silently deciding which one a `callActivity`
  actually reached by directory order rather than by name
  ([#64](https://github.com/datakurre/graph-agent/issues/64)). The line above
  reports the id to write into a `calledElement`; promoting into one already
  used by a *different* library file is refused the same way an existing
  filename is, with the same `--force`-and-back-up affordance.

The result is validated with the same bpmnlint check `make lint-bpmn` runs;
a graph that would fail it is not written, and the error names why.
Promoting over an existing library graph fails without `--force`; with it,
the previous copy is backed up as `<name>.bpmn.bak` first, the same
convention `graph-agent init --refresh` uses.

```
$ graph-agent run --graph my-graph "..."
```

starts a fresh session from the promoted graph, re-linking whatever it calls
on its own -- the round trip (library → session → mutate → promote → library)
is complete.

## Keeping the graph library current

`graph-agent init` seeds `$XDG_CONFIG_HOME/graph-agent/workflows` but **never
overwrites without being asked**, by design: the library is yours and shared
across projects. Running plain `graph-agent init` again reports any bundled
graph whose content now differs from your library copy as stale, but leaves
it alone; `graph-agent init --refresh` takes the bundled version of each one
(backing up your copy as `.bak` first). A graph that "still" misbehaves after
a fix landed is worth refreshing (or diffing) first
([#35](https://github.com/datakurre/graph-agent/issues/35)):

```
$ graph-agent init --refresh
refreshed from the bundled version (old copy backed up as .bak): pi-default-loop
```

This is not hypothetical: a stale library copy made a fixed defect look open
here, and it once left the default graph running without a fix that had
stopped it billing 110 turns.

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

**A session says `error` with no useful message, or `graph-agent ls` shows one
stuck `running` forever.** `GRAPH_AGENT_DEBUG=1 graph-agent resume <id> ...`
dumps the raw, un-walked engine error to stderr -- useful when the reported
message is still unhelpful after the causes below are ruled out
([#52](https://github.com/datakurre/graph-agent/issues/52)):

- `graph-agent ls`/`show` report `stale`, not `running`, once the process that
  was driving a session is confirmed gone -- a `running` you actually see is a
  session some other process is (or very recently was) driving, not a stuck
  one.
- Resuming a session whose snapshot bpmn-elements cannot actually recover
  (rather than erroring) used to hang the whole CLI process indefinitely; it
  now stops itself after a few seconds and reports why on the session's error
  line instead.
