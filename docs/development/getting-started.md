# Getting Started & Development Guide

This guide covers setting up your local environment, running the application, and configuring AI agent executables.

---

## 1. Prerequisites & Environment Setup

Pi Workflow Studio uses [devenv](https://devenv.sh/) and [Nix](https://nixos.org/) for hermetic, reproducible developer environments.

### Clone & Launch Environment
```bash
git clone https://github.com/datakurre/bpmn-ai-starter.git
cd bpmn-ai-starter

# Launch devenv background processes
devenv up -d
devenv processes wait
```

The application is now accessible at `http://127.0.0.1:8000/`.

---

## 2. Process Management (`devenv`)

| Command | Purpose |
| :--- | :--- |
| `devenv up -d` | Launch background processes (FastAPI backend on port 8000). |
| `devenv processes wait` | Block until health check passes (`http://127.0.0.1:8000/health`). |
| `devenv processes list` | Check running processes and restart counts. |
| `devenv processes restart api` | Restart the FastAPI API server after code changes. |
| `devenv processes down` | Terminate all background processes. |

---

## 3. Configuration & Environment Variables

Key environment variables configured in `devenv.nix`:

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `PI_EXECUTABLE` | `node_modules/.bin/pi` | Path to the local Pi coding agent binary. |
| `PI_MODEL` | `gpt-4o-mini` | Target LLM model for the agent. |
| `PI_OFFLINE` | `0` | Set to `1` to force fallback to deterministic `bpmn_agent/data/pi-demo`. |
| `OPENAI_BASE_URL` | `https://opencode.ai/go/v1` | OpenAI-compatible endpoint. |
| `OPENAI_API_KEY` | `"secret-injected-by-proxy"` | Token used for proxy secret injection. |

---

## 4. Deterministic Showcase Mode

To run a fast, offline demonstration without requiring external model credentials or network access:

```bash
# Run server with deterministic mock Pi demo runner
make demo
```
