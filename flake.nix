{
  description = "Pi coding agent driven by mutable Camunda-7-flavour BPMN graphs";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          inherit (pkgs) lib importNpmLock;
          nodejs = pkgs.nodejs_22;

          # `importNpmLock` resolves every dependency straight from package-lock.json
          # integrity hashes, so none of these derivations needs an `npmDepsHash`
          # that could only be produced by running Nix.
          mkNpm =
            args:
            pkgs.buildNpmPackage (
              {
                inherit nodejs;
                npmDeps = importNpmLock { npmRoot = args.src; };
                inherit (importNpmLock) npmConfigHook;
                dontNpmInstall = true;
              }
              // args
            );

          graph-agent = mkNpm {
            pname = "graph-agent";
            version = "0.1.0";
            src = ./.;
            dontNpmInstall = false;
            nativeBuildInputs = [ pkgs.makeWrapper ];

            postInstall = ''
              wrapProgram $out/bin/graph-agent \
                --prefix PATH : ${
                  lib.makeBinPath [
                    pkgs.git
                    pkgs.coreutils
                    pkgs.jq
                    pkgs.curl
                  ]
                }
            '';

            meta = {
              description = "Pi coding agent driven by mutable Camunda-7-flavour BPMN graphs";
              mainProgram = "graph-agent";
              license = lib.licenses.mit;
            };
          };
        in
        {
          inherit graph-agent;
          default = graph-agent;
        }
      );

      # `nix run .` starts the agent; `nix run . -- studio` opens the BPMN studio.
      # One CLI, studio is a subcommand.
      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.graph-agent}/bin/graph-agent";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.gnumake
            pkgs.git
            pkgs.jq
            pkgs.curl
            pkgs.coreutils
          ];
          env = {
            LOG_LEVEL = "debug";
            PI_TIMEOUT_SECONDS = "1800";
          };
          shellHook = ''
            export PATH="''${PWD}/node_modules/.bin:''${PATH}"
            echo "graph-agent dev shell -- run 'make help' for the dev targets"
          '';
        };
      });

      checks = forAllSystems (pkgs: {
        graph-agent = self.packages.${pkgs.stdenv.hostPlatform.system}.graph-agent;
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
