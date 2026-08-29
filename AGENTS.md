## Agent Sandbox

```toml agent-sandbox
[network]
allowed_hosts = [
    "*.nixos.org:443",
    "*.github.com:443",
    "*.cachix.org:443",
    "files.pythonhosted.org:443",
    "github.com:22",
    "pypi.org:443",
    "registry.npmjs.org:443",
#
    "models.opencode.ai:443",
    "opencode.ai:443",
]

[ports]
web = 8080

[[network.allowed_routes]]
header = "Authorization"
host = "opencode.ai:443"
method = "POST"
path = "/zen/**"
prefix = "Bearer "
secret = "OPENCODE_API_KEY"
```

## Working in this repo

`make setup && make build` before anything else; `make help` lists every dev
target. `make lint` (typecheck + template lint + `bpmnlint` over
`workflows/`) and `make test` (vitest) are the fast local checks; run them
before committing. `make verify-editor` and `node scripts/screenshot-docs.mjs`
both drive a real Chromium against `graph-agent studio` -- slower, but the
only way anything touching the studio's properties panel or a workflow
diagram is actually exercised.

Every BPMN activity dispatches to a **harness** looked up by
`zeebe:taskDefinition type="..."` in `src/agent/harnesses.ts`
(`createHarnesses()`); see [`docs/harnesses.md`](docs/harnesses.md) for the
full registry. A graph under `workflows/*.bpmn` is the shared library bundled
with the package (`make init` copies it into a user's config directory) --
`workflows/workflows.test.ts` auto-discovers every file there and checks it
against the diagram-level invariants (Camunda 8 FEEL syntax, no stranded
gateway, every gateway variable actually produced, and so on), so a new graph
gets those checks for free. Author semantics by hand and regenerate the
`<bpmndi:>` layout with `make layout` (`scripts/bpmn-tools.mjs`) rather than
hand-writing coordinates.

`docs/` is a small Jekyll site (`.github/workflows/docs.yml` builds and
deploys it to GitHub Pages on push to `main`). Its screenshots
(`docs/screenshots/*.png`) come from `scripts/screenshot-docs.mjs`, which
drives the real CLI and studio the same way `scripts/verify-editor.mjs`
does -- regenerate them with that script rather than editing the PNGs by
hand, and after any change to the studio's pages.

`npm install` rewrites `package-lock.json` under some npm versions (the
`integrity` key moves within each entry) without changing a single resolved
version. That churn is noise -- `git checkout -- package-lock.json` before
committing unless a dependency actually changed. `scripts/screenshot-docs.mjs`
likewise rewrites all four PNGs on every run; keep them only when the studio
changed.

## Running against a real model

`--dry-run` covers most of what you need: it walks a graph with a scripted
provider, so no credential and no egress. Reach for a real model when the thing
under test is the model call itself, or anything on the tool path (see below).

### Credentials

Credentials come from Pi's `ModelRuntime`; `graph-agent` adds no store of its
own. Export the provider's key (`ANTHROPIC_API_KEY`, `OPENCODE_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, ...) or use `pi` + `/login`.

**Always pass `--model provider/model`.** The default resolver reads the
credentialed subset now, but naming the model still saves a wrong guess.
One OpenCode key covers two separate catalogues: `opencode` (Zen) and
`opencode-go` (Go).

**An identity-linked `sk-ant-api03-...` key needs a header, and no environment
variable supplies it.** Anthropic issues two shapes of key. The ordinary one
works from `ANTHROPIC_API_KEY` alone. The identity-linked one additionally
requires `anthropic-workspace-id` on every request and fails the first turn
with:

```
400 ... "anthropic-workspace-id is required when authenticating with an
identity-linked API key; send the id of the workspace this request acts in."
```

This is a property of the key, not a defect in the graph -- do not go looking
for one. Diagnose it in a single call before running anything:

```
curl -sS https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
```

To use such a key you need the workspace id, which only its owner can give you
(the Admin API that lists workspaces refuses an identity-linked key). Put it in
Pi's provider config at `~/.pi/agent/models.json` -- `$PI_CODING_AGENT_DIR`
overrides the directory -- and `graph-agent` inherits it:

```json
{"providers": {"anthropic": {"headers": {"anthropic-workspace-id": "wrkspc_..."}}}}
```

Verified: with the header present the error changes from *"...is required..."*
to *"...must be a valid workspace ID."*, which is how you tell a missing header
apart from a wrong id. If you have the key but not the id, **ask** -- there is
nothing to work around. Three of the four keys handed to this project so far
were identity-linked, so run the curl above **first**, every time; it costs one
call and saves a debugging session chasing a graph bug that is not there.

### Egress

A real run needs outbound HTTPS to the provider's host: `api.anthropic.com:443`
for Anthropic, `opencode.ai:443` for either OpenCode catalogue. The
`agent-sandbox` block above declares those, but it only governs the agent
sandbox -- a CI runner or hosted session enforces its own policy. Confirm
reachability (`curl -sS -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/models`;
a 401 means reachable, a 000/403 means blocked at the proxy) before concluding
the code is at fault.

### The tool path

`--dry-run` does not cover it. Its scripted provider answers once and stops, so
the tool batch, `agent:collect-tools`, `agent:prepare-next-turn` and the
loop-back never run. Three real defects lived there behind a green `make test`
(#25 prompt re-sent every iteration, 110 billed turns; #26 tool schemas hidden
from the model; #27 a two-call batch running the first call twice). All three
are fixed and confirmed against live Haiku: the 110-turn prompt now converges
in 2 turns, and a parallel two-call batch runs each call with its own
arguments. The lesson stands: verify anything touching this path against a real
model, and do it in a **throwaway workspace** -- `createPiToolExecutor` gives
the model real `read`/`write`/`edit`/`bash` rooted at the cwd, so never run it
in this checkout.

Still live: `agent:turn` offers every session tool regardless of whether the
graph has an `agent:tool` to run them, so a graph without one wedges the moment
the model tries a call -- and it surfaces two activities later as `a turn is
already in flight with unanswered tool calls` (#36). `craft-graph` hits this on
the most natural prompt there is, "change this graph", because the model reads
before editing.

### The self-extension path does not yet land a splice

`craft-graph` runs, bounds itself at three attempts and reports honestly, but
every draft is rejected for reasons unrelated to the model's BPMN (#37):
`agent_role: graph_architect` is parsed and never consumed, so the drafting
turn gets no format instruction at all; and nothing strips the markdown fence
models wrap XML in. "Fragment" also means a bare element in the prompt and a
complete `<bpmn:definitions>` to `graph:layout`/`checkSplice`. Don't read a
`craft_rejected` outcome as the model being bad at BPMN.

Scripting tool calls with the faux provider: `fauxToolCall(name, args)` takes
**two** arguments, not an id first. Getting that wrong parks nothing and the
run hangs rather than failing, which reads like a deadlock in the engine.

### The bundled graphs

`pi-default-loop`, `shell-demo` and `craft-graph` are drivable from the CLI.
`session-skeleton` parks on a user task and `resume --answer key=value` answers
it, but the `craft-graph` redraft loop it then enters does not terminate: 1671
iterations in 45s, no result line, and **neither Ctrl-C nor SIGTERM stops it**
-- only `kill -9` (issue #34). Never point that path at a real model; it is
~37 billed calls a second from a command that reports nothing. The same
scenario is bounded when driven in-process through `runSession`'s `onWait`,
which is why the suite stays green -- **a test that only calls `onWait` cannot
cover the `run` -> park -> `resume --answer` route the CLI actually takes**,
and that gap has now hidden two separate bugs.

### The graph library goes stale, silently

`graph-agent init` seeds `$XDG_CONFIG_HOME/graph-agent/workflows` and never
overwrites (issue #35). A library seeded before a fix keeps running the old
graph, `init` says nothing, and `run` names the graph but not its provenance.
**Before concluding a bundled graph is still broken, diff your library copy
against `workflows/`.** That trap made #22 look open here when it was fixed,
and left `pi-default-loop` running without the #25 fix that had stopped it
billing 110 turns:

```
for f in workflows/*.bpmn; do
  diff -q "$f" "$(graph-agent where | awk '/^graphs/{print $2}')/$(basename "$f")"
done
```
