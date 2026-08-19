```toml agent-sandbox
[network]
allowed_hosts = [
    "cache.nixos.org:443",
    "channels.nixos.org:443",
    "codeload.github.com:443",
    "devenv.cachix.org:443",
    "files.pythonhosted.org:443",
    "github.com:443,22",
    "opencode.ai:443",
    "registry.npmjs.org:443",
    "releases.nixos.org:443",
]

[ports]
web = 8000

[[network.allowed_routes]]
host = "opencode.ai:443"
method = "POST"
path = "/zen/**"
secret = "OPENCODE_ZEN_API_KEY"
header = "Authorization"
prefix = "Bearer "
```

# Agent Guidelines & Project Insights

This document captures operational experience and technical details for AI agents working in this repository.

## 1. Serving the Project (`devenv`)
- **Start Process**: Use `devenv up -d` to launch background processes defined in `devenv.nix`.
- **Wait for Readiness**: Run `devenv processes wait` to block until readiness probes pass (`http://127.0.0.1:8000/health`).
- **Process Status**: Run `devenv processes list` to check process status (`api ready restarts: 0`).
- **Process Cleanup**: Use `devenv processes down` to terminate running process compose instances.

## 2. Local Pi Agent & Deterministic Demo
- **Executable Fallback**: `PI_EXECUTABLE` points to `${config.devenv.root}/scripts/pi-demo` by default when `PI_OFFLINE=1` or when no model API key is set.
- **Deterministic Showcase**: `scripts/pi-demo` provides a fast RPC-compatible mock agent without requiring external model credentials or network calls.

## 3. Host Browser CDP Automation
- **Host Browser Port**: The host browser runs CDP on port `9222` (`AGENT_SANDBOX_BROWSER_CDP_PORT=9222`).
- **Playwright Execution**: Always execute Playwright scripts via `playwright-python script.py` so Nix Playwright drivers and environment variables are properly wired.
- **Navigation Best Practice**: Use `wait_until="domcontentloaded"` for `page.goto("http://localhost:8000/", ...)` to prevent delays caused by background polling (`setTimeout(refresh, 500)`).
- **Form Fields Selector**: FormJS renders inputs with dynamic IDs ending in field names (e.g. `input[id$='decision']` and `input[id$='notes']`).

## 4. SpiffWorkflow & FastAPI Engine Details
- **Task State Synchronization**: When completing Pi tasks, update both `task.data` and `workflow.data` (`task.data.update(task_data)`) so SpiffWorkflow exclusive gateway expressions evaluate variables in task evaluation scope (`agent_status == 'success'`).
- **FormJS Schema Compatibility**: FormJS UMD bundle (`form-viewer.umd.js`) requires schemas formatted with `"type": "default"` and `"components": [...]` (mapping string fields to `"type": "textfield"`).
- **Static Assets Routing**: Specific static mounts (`/static/form-js`) must be mounted in FastAPI before general prefix mounts (`/static`) to ensure correct resolution.
