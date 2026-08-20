# OpenCode API Secrets

This project runs inside `agent-sandbox`. Keep the OpenCode credential out
of the repository, `.env`, process arguments, and logs. `secretspec.toml`
declares the credential name; its value must come from the host-side provider.

## Endpoint

OpenCode exposes an OpenAI-compatible endpoint for Go and Zen at:

```text
https://opencode.ai/go/v1
https://opencode.ai/zen/v1
```

Use `OPENAI_BASE_URL=https://opencode.ai/go/v1` and select an OpenAI-compatible
model such as `opencode/gpt-5.6-luna` in the OpenCode configuration. Pi can use
the same endpoint through the OpenAI-compatible provider configuration.
You can switch between Go and Zen by changing `PI_PROVIDER=opencode-go` or `PI_PROVIDER=opencode-zen`.

## secretspec

The manifest requires `OPENCODE_GO_API_KEY` and `OPENCODE_ZEN_API_KEY` for the `opencode` scope. Do
not run `secretspec get` or `secretspec export`; those commands print secret
material. Check availability without values:

```bash
secretspec check --provider env --scope opencode --reason "verify OpenCode credentials for local Pi"
```

Run Pi with the secret injected only into its child process:

```bash
secretspec run \
  --provider env \
  --scope opencode \
  --reason "run the BPMN Pi agent against OpenCode Go" \
  -- sh -c '
    export OPENAI_API_KEY="$OPENCODE_GO_API_KEY"
    export OPENAI_BASE_URL="https://opencode.ai/go/v1"
    export PI_PROVIDER="opencode-go"
    export PI_MODEL="gpt-5.6-luna"
    exec "${PI_EXECUTABLE:-pi}" "$@"
  ' -- --mode rpc --no-session
```

The shell expands the keys after secretspec injects them. Do not
expand it in the parent shell before `secretspec run` starts.

## agent-sandbox route

The repository policy must explicitly bind the secret to the OpenCode routes.
The committed `AGENTS.md` contains the route declarations. On the host, copy the
same route block verbatim into `~/.config/agent-sandbox/trusted.toml`; do not
invent or edit fields. Editing `AGENTS.md` requires an agent-sandbox relaunch.

```toml
[[network.allowed_routes]]
host = "opencode.ai:443"
method = "POST"
path = "/zen/**"
secret = "OPENCODE_ZEN_API_KEY"
header = "Authorization"
prefix = "Bearer "

[[network.allowed_routes]]
host = "opencode.ai:443"
method = "POST"
path = "/go/**"
secret = "OPENCODE_GO_API_KEY"
header = "Authorization"
prefix = "Bearer "
```

The secret is injected by the sandbox proxy only for matching HTTPS requests;
it is not placed in the sandbox filesystem or environment. If the host has not
authorized this exact route, agent-sandbox refuses the launch and prints the
block that must be copied to `trusted.toml`.

## Pi Configuration for OpenCode Zen / Go

Pi uses `@earendil-works/pi-coding-agent` with OpenCode Go provider configuration. For seamless operation inside `agent-sandbox`:

### 1. `~/.pi/agent/models.json` (and `.pi/models.json`)
```json
{
  "providers": {
    "openai": {
      "baseUrl": "https://opencode.ai/go/v1"
    },
    "opencode-zen": {
      "baseUrl": "https://opencode.ai/zen/v1",
      "api": "openai-completions",
      "apiKey": "secret-injected-by-proxy",
      "models": [
        {
          "id": "gpt-5.6-luna",
          "name": "GPT-5.6 Luna"
        }
      ]
    },
    "opencode-go": {
      "baseUrl": "https://opencode.ai/go/v1",
      "api": "openai-completions",
      "apiKey": "secret-injected-by-proxy",
      "models": [
        {
          "id": "gpt-5.6-luna",
          "name": "GPT-5.6 Luna"
        }
      ]
    }
  }
}
```

### 2. `~/.pi/agent/auth.json`
```json
{
  "openai": {
    "type": "api_key",
    "key": "secret-injected-by-proxy"
  },
  "opencode": {
    "type": "api_key",
    "key": "secret-injected-by-proxy"
  },
  "opencode-go": {
    "type": "api_key",
    "key": "secret-injected-by-proxy"
  },
  "opencode-zen": {
    "type": "api_key",
    "key": "secret-injected-by-proxy"
  }
}
```

### 3. Node & Proxy Environment Variables
When invoking `node_modules/.bin/pi` inside the sandbox:
- `PI_PROVIDER=opencode-go`: Uses OpenCode Go provider. Switch to `opencode-zen` to use Zen.
- `PI_MODEL=gpt-5.6-luna`: Selects GPT-5.6 Luna.
- `NODE_USE_ENV_PROXY=1`: Instructs Node.js (`undici` / `fetch`) to route outbound HTTPS requests through the local proxy sidecar (`$HTTP_PROXY`).
- `NODE_EXTRA_CA_CERTS=/run/agent-sandbox-proxy-ca.pem`: Configures Node to trust the sandbox proxy session CA certificate.
- `OPENAI_BASE_URL=https://opencode.ai/go/v1`: Points requests to the OpenCode Go API by default.
- `OPENCODE_API_KEY=secret-injected-by-proxy`: Placeholder token substituted with `OPENCODE_GO_API_KEY` or `OPENCODE_ZEN_API_KEY` on the wire by the proxy.
