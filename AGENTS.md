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
provider, so no credential and no egress. Reach for a real model only when the
thing under test is the model call itself.

When you do, credentials come from Pi's `ModelRuntime` -- export the provider's
key (`OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) or use
`pi` + `/login`. **Always pass `--model provider/model`.** The default resolver
reads Pi's entire static catalogue rather than the providers you hold
credentials for, so an unqualified `run` picks `amazon-bedrock/...` and fails
(issue #17). One OpenCode key covers two separate catalogues: `opencode` (Zen)
and `opencode-go` (Go).

A real run needs outbound HTTPS to the provider's host -- `opencode.ai:443` for
either OpenCode catalogue. The `agent-sandbox` block above declares that, but
it only governs the agent sandbox: a CI runner or a hosted session enforces its
own egress policy, and a blocked host shows up as a turn that stops with
`error`. Confirm reachability (`curl -sS -o /dev/null -w '%{http_code}'
https://opencode.ai/`) before concluding the code is at fault.

**A failed run looks like a successful one.** `graph-agent run` exits 0 and
records `status: completed` even when every turn errored, and neither `run` nor
`show` prints the reason (issue #18). Read the turn list, not the exit code;
the message is in the session's `meta.json` under `turns[].error`, and the
studio's session view renders it. The same silence covers a harness that
returns `failed()` -- it scrolls past as an ordinary progress line.

**`--dry-run` does not cover the tool path.** Its scripted provider answers
once and stops, so the tool batch, `agent:collect-tools`,
`agent:prepare-next-turn` and the loop-back are never exercised; the suite
scripts tool calls one at a time, so `make test` is green through all three of
the defects below. Verify anything touching that path against a real model, in
a throwaway workspace -- `createPiToolExecutor` gives the model real
`read`/`write`/`edit`/`bash` against the cwd, so do not run it in this
checkout.

- The prompt is re-sent every iteration (`llm_turn` maps `=prompt`
  unconditionally, nothing clears it), so a tool-using run never converges. One
  observed run reached 110 billed turns and still reported `completed` with
  exit 0 (issue #25). Cap or watch any real run.
- `PiSession.parkingTool` replaces each tool's real schema and description with
  an open object, so the model guesses argument names and often sends `{}`
  (issue #26).
- The multi-instance `tool_call` never reaches `agent:tool`; `resolveToolCall`
  silently falls back to `calls[0]`, so a two-call batch runs the first call
  twice and errors (issue #27). Reproduce with two `fauxToolCall`s in one
  `fauxAssistantMessage` -- note the signature is `fauxToolCall(name, args)`,
  two arguments, not three.

Of the four bundled graphs, only `pi-default-loop` and `shell-demo` are
drivable from the CLI. `session-skeleton` opens on a user task and nothing
wires `runSession`'s `onWait`, so it parks and `resume` re-parks (issue #21);
`craft-graph` is its callee and maps `=intent`, which only that form supplies,
so `--graph craft-graph` starts a turn with no prompt (issue #22). Don't spend
time debugging either as if it were broken locally.
