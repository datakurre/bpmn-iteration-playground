# Getting Started & Development Guide

This guide covers setting up your local development environment for contributing to **graph-agent**, running tests, and developing workflow templates.

---

## 1. Prerequisites & Environment Setup

`graph-agent` uses [nix](https://nix.sh/) and [Nix](https://nixos.org/) for hermetic, reproducible development environments (Python 3.14, Node 22, and toolchains).

### Clone & Launch Development Environment

```bash
git clone https://github.com/datakurre/graph-agent.git
cd graph-agent

# Enter hermetic development shell
nix develop
```

---

## 2. Running graph-agent Locally

### Initialize Workspace
In any project repository or workspace directory:

```bash
graph-agent init
```

### Launch Interactive TUI or Attach
```bash
# Start daemon and open TUI
graph-agent

# Or attach to an already running daemon
graph-agent attach
```

### Launch Headless Server for Web Studio
```bash
graph-agent serve --no-tui
```
Open `http://127.0.0.1:8000/` (or the dynamically assigned port displayed in the console) for the Web Studio interface.

---

## 3. Running Tests and Checks

Inside `nix develop`:

```bash
# Run full test suite (pytest with anyio)
pytest tests/

# Strict type checking (mypy)
mypy --strict graph_agent/

# Linter and formatting checks (ruff)
ruff check graph_agent/ tests/
```

---

## 4. Configuration & Environment Variables

Key settings configurable via environment variables or `config.toml`:

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `PI_EXECUTABLE` | `node_modules/.bin/pi` | Path to the Pi coding agent binary (falls back to `graph_agent/data/pi-demo`). |
| `PI_MODEL` | `gpt-5.6-luna` | Target LLM model for the agent. |
| `PI_OFFLINE` | `0` | Set to `1` to force fallback to deterministic mock runner. |
| `MAX_PARALLEL_TURNS`| `4` | Maximum concurrent active agent turns across all graphs. |
| `MERGE_ON_COMPLETE` | `true` | Auto-merge completed worktree runs into the base branch. |
| `TIMER_TICK_SECONDS`| `10` | Frequency of background BPMN timer event ticks (`0` disables). |

---

## 5. Deterministic Showcase Mode

To run a fast, offline test without requiring LLM credentials or network access:

```bash
PI_OFFLINE=1 graph-agent run plan_and_execute.bpmn --var goal="Test offline run"
```
