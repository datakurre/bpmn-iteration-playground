{ pkgs, lib, config, inputs, ... }:

{
  packages = with pkgs; [
    curl
    jq
    git
    nodejs_22
  ];

  languages.python = {
    enable = true;
    package = pkgs.python314;
    venv.enable = true;
    uv = {
      enable = true;
      sync = {
        enable = true;
        allGroups = true;
      };
    };
  };

  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    npm.enable = true;
    npm.install.enable = true;
  };

  env = {
    # make watch tees its console output to WATCH_LOG (see Makefile); unbuffered stdout
    # keeps that mirror live instead of arriving in delayed block-sized chunks once
    # stdout is a pipe rather than a tty.
    PYTHONUNBUFFERED = "1";
    PI_EXECUTABLE = "${config.devenv.root}/node_modules/.bin/pi";
    PI_TIMEOUT_SECONDS = "1800";
    # PI_WORKDIR is a *seed* copied into each instance workspace, not the agent's cwd.
    # Left unset by default so instances start from an empty, isolated workspace.
    LOG_LEVEL = "debug";
    PI_OFFLINE = "0";
    PI_PROVIDER = "opencode-go";
    PI_MODEL = "gpt-5.6-luna";
    OPENAI_BASE_URL = "https://opencode.ai/go/v1";
    OPENAI_API_KEY = "secret-injected-by-proxy";
    # Route the default pi_agent harness through SandboxPiAdapter (agent-sandbox
    # --workspace --proxy --secrets) instead of the bare-subprocess PiAdapter, so every
    # BPMN-driven Pi turn is isolated the same way the coding agent itself is.
    PI_SANDBOX_ENABLED = "1";
  };

  processes.api = {
    exec = "PI_EXECUTABLE=${config.devenv.root}/node_modules/.bin/pi PI_OFFLINE=0 uvicorn app.api.server:app --host 0.0.0.0 --port 8000";
    process-compose.readiness_probe = {
      http_get = {
        host = "127.0.0.1";
        port = 8000;
        path = "/health";
      };
    };
  };

  scripts.test.exec = "uv run ruff check . && uv run pytest -q --cov=app --cov-report=term-missing --cov-report=html && uv run mypy app/ && npm run typecheck && npm test";
  scripts.lint.exec = "uv run ruff check . && uv run mypy app/ && npm run typecheck";
  scripts.lint-fix.exec = "uv run ruff check --fix .";
  scripts.demo.exec = ''
    PI_EXECUTABLE="${config.devenv.root}/scripts/pi-demo" \
      uvicorn app.api.server:app --host 0.0.0.0 --port 8000
  '';

  enterTest = ''
    pytest -q
  '';
}
