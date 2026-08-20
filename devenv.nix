{ pkgs, lib, config, inputs, ... }:

{
  packages = with pkgs; [
    curl
    jq
    git
    nodejs_22
    mypy
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
    PI_EXECUTABLE = "${config.devenv.root}/node_modules/.bin/pi";
    PI_TIMEOUT_SECONDS = "1800";
    PI_WORKDIR = "${config.devenv.root}";
    PI_OFFLINE = "0";
    PI_PROVIDER = "opencode-go";
    PI_MODEL = "gpt-5.6-luna";
    OPENAI_BASE_URL = "https://opencode.ai/go/v1";
    OPENAI_API_KEY = "secret-injected-by-proxy";
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

  scripts.test.exec = "pytest -q && mypy app/";
  scripts.lint.exec = "mypy app/";
  scripts.demo.exec = ''
    PI_EXECUTABLE="${config.devenv.root}/scripts/pi-demo" \
      uvicorn app.api.server:app --host 0.0.0.0 --port 8000
  '';

  enterTest = ''
    pytest -q
  '';
}
