{
  description = "Pi coding agent driven by mutable Camunda-8-flavour BPMN graphs";

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
      overlays.default =
        final: prev:
        let
          inherit (final) lib importNpmLock;
          nodejs = final.nodejs_22;

          # `importNpmLock` resolves every dependency straight from package-lock.json
          # integrity hashes, so none of these derivations needs an `npmDepsHash`
          # that could only be produced by running Nix.
          mkNpm =
            args:
            final.buildNpmPackage (
              {
                inherit nodejs;
                npmDeps = importNpmLock { npmRoot = args.src; };
                inherit (importNpmLock) npmConfigHook;
                dontNpmInstall = true;
              }
              // args
            );
        in
        {
          graph-agent = mkNpm {
            pname = "graph-agent";
            version = "0.1.0";
            src = ./.;
            dontNpmInstall = false;
            nativeBuildInputs = [ final.makeWrapper ];

            postInstall = ''
              wrapProgram $out/bin/graph-agent \
                --prefix PATH : ${
                  lib.makeBinPath [
                    final.git
                    final.coreutils
                    final.jq
                    final.curl
                  ]
                }
            '';

            meta = {
              description = "Pi coding agent driven by mutable Camunda-8-flavour BPMN graphs";
              mainProgram = "graph-agent";
              license = lib.licenses.mit;
            };
          };
        };

      packages = forAllSystems (
        pkgs:
        let
          pkgs' = pkgs.extend self.overlays.default;
        in
        {
          inherit (pkgs') graph-agent;
          default = pkgs'.graph-agent;
        }
      );

      # `nix run .` starts the agent; `nix run . -- studio` opens the BPMN studio.
      # One CLI, studio is a subcommand.
      apps = forAllSystems (
        pkgs:
        let
          graph-agent = {
            type = "app";
            program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.graph-agent}/bin/graph-agent";
          };
        in
        {
          inherit graph-agent;
          default = graph-agent;
        }
      );

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
