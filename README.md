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

Name the model. Omitting `--model` currently resolves against Pi's whole
static catalogue rather than the providers you hold credentials for, so it
can pick one you never configured ([#17](https://github.com/datakurre/graph-agent/issues/17)),
and a turn that fails still reports `completed` with exit code 0
([#18](https://github.com/datakurre/graph-agent/issues/18)) -- the reason is in
the session's `meta.json`, or in the studio's session view. See
[`docs/getting-started.md`](docs/getting-started.md) for the full walkthrough
and its troubleshooting notes, and [`docs/harnesses.md`](docs/harnesses.md) for
every job type a graph can dispatch to.

Of the four bundled graphs, `pi-default-loop` and `shell-demo` run from the
CLI; `session-skeleton` and the `craft-graph` it calls open on a human gate
that nothing can answer yet ([#21](https://github.com/datakurre/graph-agent/issues/21)).

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
