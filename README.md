# graph-agent

A [Pi](https://github.com/earendil-works/pi) coding agent whose control flow
is a mutable BPMN graph.

The loop that drives the agent -- when to call the model, when to run a tool,
when to stop -- is not code you have to read to change. It is a diagram,
executed by [`bpmn-engine`](https://github.com/paed01/bpmn-engine), that the
agent itself can extend mid-session by splicing in new elements. Every
activity in the diagram dispatches to a **harness**: a small piece of
TypeScript that does the work an activity names -- `agent:turn` for a model
call, `agent:tool` for a tool call, `shell` for a deterministic command, and
so on.

**Docs:** https://datakurre.github.io/graph-agent/ (source in
[`docs/`](docs/), with [screenshots](docs/screenshots/) driven from a real
run of the studio). [`docs/vision.md`](docs/vision.md) is why the loop is a
diagram at all, and what that commits the project to.

## Quickstart

```
make setup   # npm install
make build   # bundle the CLI, the studio's bpmn-js bundles, and Tailwind CSS
make init    # seed $XDG_CONFIG_HOME/graph-agent with the bundled graph library
             # (`graph-agent where` prints the config, library and state paths)
```

Walk the bundled Pi agent loop with no credentials and no network:

```
graph-agent run "say hello" --dry-run
```

or pair one Pi turn with a deterministic `shell` step:

```
graph-agent run "verify this workspace" --dry-run --graph shell-demo
```

To run against a real model, give Pi a credential -- either export the
provider's API key, or authenticate once with `pi` and `/login` -- and drop
`--dry-run`:

```
export OPENCODE_API_KEY=sk-...
graph-agent run "say hello" --model opencode-go/gpt-5.6-luna
```

Name the model: `--model` takes `provider/model`, or a bare provider. A turn
that fails prints its reason and exits non-zero; the full record is in the
session's `meta.json`, or in the studio's session view.

If your Anthropic key is **identity-linked**, the variable alone is not enough:
those keys need an `anthropic-workspace-id` header that no environment variable
supplies, and the first turn fails with `anthropic-workspace-id is required`.
Put the id in Pi's `~/.pi/agent/models.json` under
`providers.anthropic.headers` -- see
[Run against a real model](docs/getting-started.md#run-against-a-real-model).

See [`docs/getting-started.md`](docs/getting-started.md) for the full
walkthrough and its troubleshooting notes, and
[`docs/harnesses.md`](docs/harnesses.md) for every job type a graph can
dispatch to.

All six bundled graphs run. `session-default` -- the one `run` uses when
`--graph` is not given -- is a callActivity into `pi-default-loop`, so
out-of-the-box behaviour matches plain Pi while still being a diagram. Both
graphs, and `shell-demo`, drive tool calls, parallel ones included.
`craft-graph` drafts a BPMN fragment and splices it into the running session --
verified end to end against real Haiku, approval gate and all -- so the agent
really does rewrite its own control flow mid-session. `session-skeleton` asks
for an intent before handing it to `craft-graph`, and `session-craft` (opt-in
via `--graph session-craft`) goes straight from a prompt into `craft-graph`
and runs whatever it builds in the same invocation -- see [the bundled
graphs](docs/getting-started.md#the-bundled-graphs) for what each one is.

One thing to know: plain `graph-agent init` auto-upgrades any library graph
that is unchanged from what it was bundled as -- no `.bak`, since the hash
proves you never touched it -- but leaves a graph you *have* modified alone
and just reports it as stale. Only a modified copy needs `--refresh` (which
backs it up as `.bak` first) to pick up a fix upstream
([#35](https://github.com/datakurre/graph-agent/issues/35)) -- run
`graph-agent init --refresh`, or diff `workflows/` against `graph-agent
where`'s graphs directory, before concluding a graph is still broken.

`graph:lint` checks that a fragment is valid and additive, that every new
activity's `zeebe:taskDefinition type` names a real harness, *and* that its
`zeebe:input`/`zeebe:taskHeaders`/`zeebe:output` bindings match what that
harness actually reads and publishes
([#65](https://github.com/datakurre/graph-agent/issues/65)) -- an approved
splice is wired correctly or it is rejected with a redraftable reason before
it ever applies. What review at the approval gate is still for: whether the
splice does the *right thing*, not whether it is plumbed correctly.

(Under Nix: `nix develop --command make <target>`.)

## TUI

```
graph-agent tui "say hello" --dry-run
```

drives the same `run`/`resume` machinery from an interactive terminal instead
of one printed line per activity: a live transcript (Pi's own message and
tool-call rendering), a trail of the last few activities, a status strip with
the live token ids, and -- the thing `run` cannot do at all -- a prompt for
any human gate the graph parks on, right there in the terminal.
`session-skeleton`'s intent gate and `craft-graph`'s approval gate both answer
this way; type an answer per form field and press enter. Bare text queues as
a steering message once a turn is under way; `/follow <text>` queues a
follow-up instead. `run` stays exactly as it is -- non-interactive, scriptable,
what CI uses.

A session that parked -- on a gate it declined, on a Ctrl-C, on anything else
that stopped it -- reattaches with `graph-agent tui --resume <session-id>`,
no `--graph`/prompt needed: it opens straight onto the prior transcript and
whatever it is still waiting on ([#67](https://github.com/datakurre/graph-agent/issues/67)).

## UI

```
graph-agent ui
```

serves a BPMN editor and a session viewer scoped to the project you run it
from -- the graph library (shared across projects) on one side, this
project's sessions on the other, with the Camunda 8 element templates under
[`element_templates/`](element_templates/) available from the properties
panel.

## Development

```
make lint             # typecheck + template lint + bpmnlint over workflows/
make test              # vitest
make verify-editor    # drive the studio in a real browser
```

`make help` lists every dev target. See [`AGENTS.md`](AGENTS.md) for the
project's conventions.

## License

MIT
