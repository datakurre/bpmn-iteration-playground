{
  description = "Preconfigured Pi agents for BPMN workflow tasks";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          spiffworkflow = pkgs.python3Packages.buildPythonPackage {
            pname = "spiffworkflow";
            version = "3.2.0";
            format = "wheel";
            src = pkgs.fetchurl {
              url = "https://files.pythonhosted.org/packages/4f/cc/710605b7208629dbd7ecef72905c0a6b79708192815822ed18b12007437c/spiffworkflow-3.2.0-py3-none-any.whl";
              sha256 = "fd2c4d3c2674e9e6b15c4db262b1a09f0ca11ce6638f8cceef0997f42aa5cb96";
            };
            propagatedBuildInputs = [
              pkgs.python3Packages.lxml
            ];
            doCheck = false;
          };
          mkPiVariant =
            {
              name,
              description,
              tools,
              prompt,
            }:
            pkgs.writeShellApplication {
              inherit name;
              runtimeInputs = [ pkgs.coreutils ];
              text = ''
                exec "''${PI_EXECUTABLE:-pi}" \
                  --tools ${pkgs.lib.escapeShellArg tools} \
                  --append-system-prompt ${pkgs.lib.escapeShellArg prompt} \
                  "$@"
              '';
              meta = {
                inherit description;
                mainProgram = name;
              };
            };
        in
        {
          graph-agent = pkgs.python3Packages.buildPythonApplication {
            pname = "graph-agent";
            version = "0.1.0";
            pyproject = true;
            src = ./.;
            build-system = [
              pkgs.python3Packages.hatchling
            ];
            dependencies = [
              spiffworkflow
              pkgs.python3Packages.fastapi
              pkgs.python3Packages.uvicorn
              pkgs.python3Packages.zodb
              pkgs.python3Packages.transaction
              pkgs.python3Packages.python-dotenv
              pkgs.python3Packages.pydantic
              pkgs.python3Packages.jinja2
              pkgs.python3Packages.httpx
              pkgs.python3Packages.defusedxml
              pkgs.python3Packages.textual
            ];
            nativeBuildInputs = [
              pkgs.makeWrapper
            ];
            postFixup = ''
              for bin in $out/bin/graph-agent $out/bin/bpmn; do
                if [ -f "$bin" ]; then
                  wrapProgram "$bin" \
                    --prefix PATH : ${
                      pkgs.lib.makeBinPath [
                        pkgs.git
                        pkgs.gnutar
                        pkgs.zstd
                        pkgs.coreutils
                        pkgs.curl
                        pkgs.jq
                      ]
                    }
                fi
              done
            '';
            doCheck = false;
          };

          pi-bpmn-json-form-builder = mkPiVariant {
            name = "pi-bpmn-json-form-builder";
            description = "Pi configured for BPMN and bpmn-io JSON form work";
            tools = "read,write,edit,grep,find,ls,bash";
            prompt = "You are a bpmn-io and form-js implementation specialist. Work on BPMN XML, Camunda extensions, and JSON form schemas. Preserve valid BPMN structure, validate JSON, and test the result.";
          };
          default = self.packages.${pkgs.stdenv.hostPlatform.system}.graph-agent;
        }
      );

      apps = forAllSystems (pkgs: {
        graph-agent = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.graph-agent}/bin/graph-agent";
        };
        bpmn = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.graph-agent}/bin/bpmn";
        };
        pi-bpmn-json-form-builder = {
          type = "app";
          program = "${
            self.packages.${pkgs.stdenv.hostPlatform.system}.pi-bpmn-json-form-builder
          }/bin/pi-bpmn-json-form-builder";
        };
        default = self.apps.${pkgs.stdenv.hostPlatform.system}.graph-agent;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.python314
            pkgs.uv
            pkgs.nodejs_22
            pkgs.curl
            pkgs.jq
            pkgs.git
            pkgs.zstd
            pkgs.coreutils
          ];
          env = {
            PYTHONUNBUFFERED = "1";
            LOG_LEVEL = "debug";
            PI_TIMEOUT_SECONDS = "1800";
            PI_OFFLINE = "0";
            PI_PROVIDER = "opencode-go";
            PI_MODEL = "gpt-5.6-luna";
            OPENAI_BASE_URL = "https://opencode.ai/go/v1";
            OPENAI_API_KEY = "secret-injected-by-proxy";
          };
          shellHook = ''
            export PI_EXECUTABLE="''${PWD}/node_modules/.bin/pi"
          '';
        };
      });

      checks = forAllSystems (pkgs: {
        graph-agent = self.packages.${pkgs.stdenv.hostPlatform.system}.graph-agent;
        pi-bpmn-json-form-builder =
          self.packages.${pkgs.stdenv.hostPlatform.system}.pi-bpmn-json-form-builder;
        pi-text-analysis = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-text-analysis;
        pi-contract-review = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-contract-review;
        pi-beamer-author = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-beamer-author;
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
