# AGENTS.md – sandboxed shell task workspace

Default `agent-sandbox` policy for `SandboxShellAdapter` (`harness_type: sandbox_shell`),
seeded by `prepare_sandbox_workspace()`. Deliberately declares **no
`[[network.allowed_routes]]`** and nothing secret-bearing: a deterministic build step
(compiler, slicer, CAM tool) usually needs package registries at most, never an
authenticated API call, and `--secrets` resolves every declared route eagerly at launch
-- a route nobody configured a key for would fail the whole task before the command even
runs (see `SandboxShellAdapter`'s docstring). A task that genuinely needs an
authenticated route declares its own `allowed_routes` property, or points a
`sandbox_template` property at a template (like `agent_sandbox`) that does.

```toml agent-sandbox
[network]
allowed_hosts = [
    "cache.nixos.org:443",
    "channels.nixos.org:443",
    "files.pythonhosted.org:443",
    "github.com:443,22",
    "registry.npmjs.org:443",
    "releases.nixos.org:443",
]
```
