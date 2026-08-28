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
