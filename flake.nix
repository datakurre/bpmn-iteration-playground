{
  description = "Pi coding agent driven by mutable Camunda-7-flavour BPMN graphs";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # The bpmn-js element-templates stack, forked for Camunda 7 / Operaton.
    #
    # These are ALSO git submodules under vendor/ (see .gitmodules), which is how
    # non-Nix contributors get them. They are declared as flake inputs as well
    # because a plain `nix run .` does not fetch git submodules -- only
    # `nix run '.?submodules=1'` would, and requiring that flag defeats the point.
    #
    # The two pinnings must not drift: `make check-vendor-pins` asserts that the
    # gitlinks recorded in the index match the revs locked here.
    operaton-element-templates = {
      url = "git+https://gitlab.com/vasara-bpm/operaton-element-templates.git?rev=ed8d91e5a859dc1470426ce5e09ddf4b4666aecb";
      flake = false;
    };
    operaton-element-templates-validator = {
      url = "git+https://gitlab.com/vasara-bpm/operaton-element-templates-validator.git?rev=f2d40afdc14ae9e9b924ce99dbf7d056585e6860";
      flake = false;
    };
    operaton-element-templates-json-schema = {
      url = "git+https://gitlab.com/vasara-bpm/operaton-element-templates-json-schema.git?rev=8b96e08ce28f3717959e78ddd941033f983f893a";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      operaton-element-templates,
      operaton-element-templates-validator,
      operaton-element-templates-json-schema,
    }:
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

          # 1. lerna monorepo; the JSON schema package is what the validator consumes.
          jsonSchema = mkNpm {
            pname = "operaton-element-templates-json-schema";
            version = "0-unstable";
            src = operaton-element-templates-json-schema;
            installPhase = ''
              runHook preInstall
              mkdir -p $out
              cp -r packages/element-templates-json-schema $out/
              runHook postInstall
            '';
          };

          # 2. depends on the schema by relative `file:` path; repoint it at the store.
          validator = mkNpm {
            pname = "operaton-element-templates-validator";
            version = "2.21.0";
            src = operaton-element-templates-validator;
            postPatch = ''
              substituteInPlace package.json \
                --replace-fail \
                  'file:../operaton-element-templates-json-schema/packages/element-templates-json-schema' \
                  'file:${jsonSchema}/element-templates-json-schema'
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p $out
              cp -r dist package.json $out/
              runHook postInstall
            '';
          };

          # 3. depends on the validator by relative `file:` path; same treatment.
          elementTemplates = mkNpm {
            pname = "operaton-element-templates";
            version = "2.24.0";
            src = operaton-element-templates;
            postPatch = ''
              substituteInPlace package.json \
                --replace-fail \
                  'file:../operaton-element-templates-validator' \
                  'file:${validator}'
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p $out
              cp -r dist package.json $out/
              runHook postInstall
            '';
          };

          graph-agent = mkNpm {
            pname = "graph-agent";
            version = "0.1.0";
            src = ./.;
            dontNpmInstall = false;
            nativeBuildInputs = [ pkgs.makeWrapper ];

            # scripts/build-assets.mjs aliases `bpmn-js-element-templates` and
            # `@bpmn-io/element-templates-validator` to vendor/*/dist/**. Materialising
            # those exact paths keeps the build script identical between Nix and a
            # plain `make setup` checkout.
            preBuild = ''
              mkdir -p vendor/operaton-element-templates vendor/operaton-element-templates-validator
              cp -r ${elementTemplates}/dist vendor/operaton-element-templates/dist
              cp -r ${validator}/dist vendor/operaton-element-templates-validator/dist
            '';

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
          inherit
            graph-agent
            jsonSchema
            validator
            elementTemplates
            ;
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
