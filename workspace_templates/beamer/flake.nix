{
  description = "Pinned LaTeX Beamer (Metropolis) toolchain for a generated slide deck";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # scheme-basic plus exactly what Metropolis needs. Keeping the closure small
      # matters: this is fetched inside the agent workspace on every cold build.
      texlive = pkgs: pkgs.texliveBasic.withPackages (ps: with ps; [
        latexmk
        beamer
        beamertheme-metropolis   # the theme itself
        pgfopts             # metropolis option parsing
        etoolbox
        translator          # beamer localisation
        pgf
        pgfplots
        xcolor
        appendixnumberbeamer
        fira                # Metropolis' default sans; needs xelatex/lualatex
        fontspec
        xetex
        microtype
        booktabs
        caption
        ulem
      ]);
    in {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            (texlive pkgs)
            pkgs.poppler-utils   # pdftoppm, for rendering slides to PNG previews
            pkgs.gnumake
          ];
        };
      });

      packages = forAllSystems (pkgs: {
        # `nix build` produces the deck as a derivation, for reproducible CI output.
        slides = pkgs.stdenvNoCC.mkDerivation {
          name = "slides";
          src = ./.;
          nativeBuildInputs = [ (texlive pkgs) ];
          buildPhase = ''
            export TEXMFHOME=$PWD/.texmf
            export TEXMFVAR=$PWD/.texmf-var
            latexmk -xelatex -interaction=nonstopmode -halt-on-error slides.tex
          '';
          installPhase = "install -Dm444 slides.pdf $out/slides.pdf";
        };
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.slides;
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
