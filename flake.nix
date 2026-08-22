{
  description = "Preconfigured Pi agents for BPMN workflow tasks";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      packages = forAllSystems (pkgs: let
        mkPiVariant = { name, description, tools, prompt }:
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
      in {
        pi-bpmn-json-form-builder = mkPiVariant {
          name = "pi-bpmn-json-form-builder";
          description = "Pi configured for BPMN and bpmn-io JSON form work";
          tools = "read,write,edit,grep,find,ls,bash";
          prompt = ''You are a bpmn-io and form-js implementation specialist. Work on BPMN XML, Camunda extensions, and JSON form schemas. Preserve valid BPMN structure, validate JSON, and test the result.'';
        };
        pi-text-analysis = mkPiVariant {
          name = "pi-text-analysis";
          description = "Read-only Pi variant for structured text analysis";
          tools = "read,grep,find,ls";
          prompt = ''You are a text analysis specialist. Do not modify files. Return concise, evidence-based findings and preserve the requested JSON result contract.'';
        };
        pi-contract-review = mkPiVariant {
          name = "pi-contract-review";
          description = "Pi configured for contract review workflows";
          tools = "read,grep,find,ls";
          prompt = ''You are a contract review agent. Identify clauses, obligations, risks, and compliance gaps. Do not modify repository files. Return structured findings.'';
        };
        pi-beamer-author = mkPiVariant {
          name = "pi-beamer-author";
          description = "Pi configured to author LaTeX Beamer decks with the Metropolis theme";
          tools = "read,write,edit,grep,find,ls,bash";
          prompt = ''You are a LaTeX Beamer specialist working in a workspace scaffolded with a pinned TeX Live toolchain. Realise outline.md as slides.tex using the metropolis theme; keep the preamble XeLaTeX-compatible (Metropolis needs Fira via fontspec) and never swap the theme to work around an error. One point per frame, no walls of bullets. Build with 'make pdf' before reporting, and when a build fails read the error in the log rather than guessing. Report the files you changed as artifacts.'';
        };
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-bpmn-json-form-builder;
      });

      apps = forAllSystems (pkgs: {
        pi-bpmn-json-form-builder = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.pi-bpmn-json-form-builder}/bin/pi-bpmn-json-form-builder";
        };
        pi-text-analysis = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.pi-text-analysis}/bin/pi-text-analysis";
        };
        pi-contract-review = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.pi-contract-review}/bin/pi-contract-review";
        };
        pi-beamer-author = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.pi-beamer-author}/bin/pi-beamer-author";
        };
      });

      checks = forAllSystems (pkgs: {
        pi-bpmn-json-form-builder = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-bpmn-json-form-builder;
        pi-text-analysis = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-text-analysis;
        pi-contract-review = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-contract-review;
        pi-beamer-author = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-beamer-author;
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
