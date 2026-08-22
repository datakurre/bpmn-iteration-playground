# Build targets for the generated Beamer deck.
#
# Every target is safe to run either inside `nix develop` or straight from a bare
# shell: when the TeX Live toolchain is not already on PATH, the recipe re-enters
# the flake's devShell. `path:.` is deliberate -- the workspace is usually not a
# git repository, and plain-path flake semantics avoid nix ignoring untracked files.

SLIDES  ?= slides
IMG_DIR ?= images
IMG_DPI ?= 110

ifeq ($(shell command -v latexmk 2>/dev/null),)
RUN := nix develop --quiet 'path:.' --command
else
RUN :=
endif

.PHONY: all pdf images clean distclean

all: pdf images

# -halt-on-error so a broken deck fails fast with the error at the end of the log,
# which is what gets fed back to the agent for the next iteration.
pdf: $(SLIDES).pdf

$(SLIDES).pdf: $(SLIDES).tex
	$(RUN) latexmk -xelatex -interaction=nonstopmode -halt-on-error -file-line-error $(SLIDES).tex

# One PNG per slide, so a human reviewer sees the rendered deck rather than a PDF link.
images: $(SLIDES).pdf
	mkdir -p $(IMG_DIR)
	$(RUN) pdftoppm -png -r $(IMG_DPI) $(SLIDES).pdf $(IMG_DIR)/slide

clean:
	$(RUN) latexmk -C $(SLIDES).tex || true
	rm -rf $(IMG_DIR)

distclean: clean
	rm -f $(SLIDES).pdf
