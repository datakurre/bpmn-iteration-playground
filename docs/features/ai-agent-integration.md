# Local Pi AI Agent Integration

Pi Workflow Studio executes local AI agents through a stateless, non-interactive **JSON print mode** (`--mode json -p <prompt>`) via subprocesses. This architecture enables BPMN to act as the external state machine, chaining agent turns and human tasks while isolating execution environments.

---

## 1. Stateless Turn Protocol

The communication between the FastAPI backend and the Pi agent process is implemented in `graph_agent/pi_client.py`:

```
FastAPI (PiClient)                      Pi Subprocess (node_modules/.bin/pi)
        |                                              |
        |---- args: --mode json -p <prompt> ---------->|
        |     (optional: --session <id>)               | (Executes LLM / Tools)
        |<--- stdout: {"type":"session"} --------------|
        |<--- stdout: {"type":"agent_start"} ----------|
        |<--- stdout: {"type":"message_end", ...} -----| (JSON structured findings)
        |<--- stdout: {"type":"agent_settled"} --------|
        |                                              | (Process Exits)
```

### JSON Schema Output Contract
Pi agents return a structured JSON result validated against an expected contract:

```json
{
  "status": "success",
  "summary": "AI Agent drafted and quality-checked the document artifact.",
  "document_content": "# Next-Gen AI Workflow Automation\n...",
  "doc_preview": "# Next-Gen AI Workflow Automation\n...",
  "findings": [
    "Executive Summary complete",
    "BPMN orchestration verified",
    "Savepoints detailed"
  ],
  "artifacts": [
    "document.md"
  ],
  "next_action": "review"
}
```

---

## 2. Proxy Secret Injection & Provider Support (`opencode-go`)

The system defaults to the `opencode-go` provider (and optionally supports `opencode-zen`), routing requests to their respective endpoints (`https://opencode.ai/go/v1` or `https://opencode.ai/zen/v1`) through the proxy sidecar where the API key is injected:

```python
DEFAULT_PROVIDER = "opencode-go"
```

To prevent client libraries from aborting before initiating HTTP requests, `PiClient` passes a placeholder authorization key:

```python
env = {
    **os.environ,
    "OPENAI_API_KEY": os.environ.get("OPENCODE_API_KEY") or "secret-injected-by-proxy",
    "OPENAI_BASE_URL": os.environ.get("OPENAI_BASE_URL", "https://opencode.ai/go/v1"),
    "PI_DEFAULT_PROVIDER": os.environ.get("PI_DEFAULT_PROVIDER", "opencode-go"),
}
```

Both providers share the one `OPENCODE_API_KEY` secret — the sandbox's `/zen/**`
allowed route covers `opencode-go`'s nested `/zen/go/**` path too, so there is only
ever one credential for the proxy to inject.

---

## 3. Deterministic Mock Fallback (`graph_agent/data/pi-demo`)

For local testing, offline development, or environments without live model credentials, the system includes an automatic fallback to `graph_agent/data/pi-demo`:

```bash
# Force offline deterministic mode
export PI_OFFLINE=1
```

When offline or when the remote model is unavailable, `PiClient` automatically routes execution to `graph_agent/data/pi-demo`, returning a validated mock analysis instantly and allowing the BPMN workflow to continue seamlessly.

---

## 4. Error Handling & Retries

If an agent process encounters a timeout, network failure, or unrecoverable error:
- The task state is updated to `FAILED` with a recorded `failure_reason`.
- The instance UI renders a red **Retry** button directly on the affected task node.
- Clicking **Retry** re-invokes the AI harness without restarting the entire workflow.
