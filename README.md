# graph-agent

A [Pi](https://github.com/earendil-works/pi) coding agent whose control flow
is a mutable Camunda-8-flavour BPMN graph.

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
run of the studio).

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

All four bundled graphs run. `pi-default-loop` and `shell-demo` drive tool
calls, parallel ones included. `craft-graph` drafts a BPMN fragment and splices
it into the running session -- verified end to end against real Haiku, approval
gate and all -- so the agent really does rewrite its own control flow
mid-session.

Two things to know. `graph:lint` checks that a fragment is valid and additive,
but not that its `zeebe:taskDefinition type` names a harness that exists, so an
approved splice can be inert until something runs it
([#40](https://github.com/datakurre/graph-agent/issues/40)) -- review the
fragment at the approval gate. And `init` never overwrites your graph library,
so a bundled graph fixed upstream keeps running its old copy with no warning
([#35](https://github.com/datakurre/graph-agent/issues/35)) -- diff
`workflows/` against `graph-agent where`'s graphs directory before concluding a
graph is still broken.

(Under Nix: `nix develop --command make <target>`.)

## Studio

```
graph-agent studio
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
