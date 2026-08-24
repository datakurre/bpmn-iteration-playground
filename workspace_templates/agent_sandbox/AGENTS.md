# AGENTS.md – sandboxed BPMN task workspace

Default `agent-sandbox` policy seeded into a task's instance workspace by
`prepare_sandbox_workspace()` (`app/adapters/sandbox_policy.py`), used by both
`SandboxPiAdapter` and `SandboxShellAdapter`. Deliberately minimal: just enough for a
default `pi_agent` turn to reach its model provider. A task extends or replaces this via
its own `camunda:properties` (`sandbox_policy` / `network_policy` / `allowed_hosts` /
`allowed_routes` / `ports`), or opts into a different base entirely with a
`sandbox_template` property naming another `workspace_templates/<name>/` directory.

One route covers both providers this project drives (`opencode-go` and `opencode-zen`,
matching `devenv.nix`'s default `PI_PROVIDER=opencode-go`), sharing one secret,
`OPENCODE_API_KEY` -- pi's own client resolves *both* providers' credentials from that
same environment variable (see `_PI_LOCAL_API_KEY_ENV_VAR` in
`app/adapters/sandbox_adapter.py`), so the proxy only ever needs to inject one value.
`--secrets` resolves every declared route eagerly and refuses to launch at all if any
of them can't be satisfied, so splitting this into a per-provider secret again would
mean a key nobody configured for one provider breaks sandboxed turns for the other too.

The path is `/zen/**`, not `/go/**` -- pi's `opencode-go` provider client calls
`opencode.ai/zen/go/v1/responses`, nested under `/zen/` regardless of the "go" tier
(confirmed by the proxy's own L7-denied log entry, not guessed from
`devenv.nix`'s unrelated `OPENAI_BASE_URL=.../go/v1`, which is a different string
entirely) -- and `/zen/**` already matches that nested `/zen/go/**` path, so one route
covers `opencode-zen`'s own `/zen/v1` calls too.

```toml agent-sandbox
[network]
allowed_hosts = [
    "opencode.ai:443",
]

[[network.allowed_routes]]
header = "Authorization"
host = "opencode.ai:443"
method = "POST"
path = "/zen/**"
prefix = "Bearer "
secret = "OPENCODE_API_KEY"
```
