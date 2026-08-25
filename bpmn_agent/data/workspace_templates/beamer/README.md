# Beamer deck workspace

Scaffold laid down by the `beamer_slides` BPMN workflow's `template="beamer"` shell task.

| File | Owner | Purpose |
| --- | --- | --- |
| `outline.md` | planning agent | Deck structure agreed with the human before any LaTeX is written |
| `slides.tex` | slide agent | The deck itself, Metropolis theme |
| `Makefile` | template | `make pdf` (build), `make images` (PNG previews), `make clean` |
| `flake.nix` | template | Pinned TeX Live (`texliveBasic.withPackages`) + `poppler_utils` |

Nothing here is overwritten on later turns: the shell adapter's `template` property
copies missing files only, so agent edits survive re-running the scaffold task.

```bash
make pdf      # slides.pdf
make images   # images/slide-01.png ...
```
