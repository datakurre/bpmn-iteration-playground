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
