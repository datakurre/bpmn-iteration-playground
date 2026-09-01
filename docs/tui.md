---
layout: default
title: TUI Development
---

# TUI Development

The TUI can be exercised without credentials or a live model. Its development
harness uses the faux provider and a recording implementation of Pi's
`Terminal` interface.

## Commands

```sh
make test-tui
make showcase-tui
make screenshot-tui
```

The showcase prints the reconstructed screen. Set `TUI_COLUMNS` and
`TUI_ROWS` to inspect responsive behavior:

```sh
TUI_COLUMNS=40 TUI_ROWS=16 make showcase-tui
```

The screenshot command writes these artifacts under `docs/tui/`:

- `showcase.txt` is the normalized visible screen.
- `showcase.ansi` is the raw terminal output.
- `showcase.png` is a browser screenshot for visual review.

The terminal recorder is deliberately small and deterministic. It validates
the output used by the TUI, but it is not a replacement for a real PTY. Cursor
restoration, alternate-screen behavior and platform-specific key decoding need
separate PTY coverage.

## Adding A Scenario

Use `runTuiScenario()` from `src/tui/scenario.ts`. Give it a temporary project,
a faux model, a small BPMN fixture and explicit actions. Prefer `waitFor` over
fixed delays. Use `submit` for application-level tests and `keys` for tests
that need to exercise terminal input decoding.

Keep semantic assertions in Vitest. Screenshots should be reserved for visual
properties such as spacing, wrapping, density, colors and cursor placement.
