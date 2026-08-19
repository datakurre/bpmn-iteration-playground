# Local Pi AI Agent Integration

Pi Workflow Studio executes local AI agents through a lightweight, streaming **JSONL RPC protocol** via subprocesses. This architecture enables language-agnostic integration with agent frameworks while isolating execution environments.

---

## 1. JSONL RPC Protocol

The communication between the FastAPI backend and the Pi agent process is implemented in [`app/pi_rpc.py`](../../app/pi_rpc.py):

```
FastAPI (PiRpcClient)                Pi Subprocess (node_modules/.bin/pi)
        |                                              |
        |---- stdin: {"jsonrpc":"2.0", ...} ---------->|
        |                                              | (Executes LLM / Tools)
        |<--- stdout: {"type":"session"} --------------|
        |<--- stdout: {"type":"agent_start"} ----------|
        |<--- stdout: {"type":"message_end", ...} -----| (JSON structured findings)
        |<--- stdout: {"type":"agent_settled"} --------|
        |                                              |
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

The system defaults to the `opencode-go` provider, routing requests to `https://opencode.ai/zen/v1` through the proxy sidecar where `OPENCODE_ZEN_API_KEY` is injected:

```python
DEFAULT_PROVIDER = "opencode-go"
```

To prevent client libraries from aborting before initiating HTTP requests, `PiRpcClient` passes a placeholder authorization key:

```python
env = {
    **os.environ,
    "OPENAI_API_KEY": os.environ.get("OPENCODE_ZEN_API_KEY") or "secret-injected-by-proxy",
    "OPENAI_BASE_URL": os.environ.get("OPENAI_BASE_URL", "https://opencode.ai/zen/v1"),
    "PI_DEFAULT_PROVIDER": os.environ.get("PI_DEFAULT_PROVIDER", "opencode-go"),
}
```

---

## 3. Deterministic Mock Fallback (`scripts/pi-demo`)

For local testing, offline development, or environments without live model credentials, the system includes an automatic fallback to `scripts/pi-demo`:

```bash
# Force offline deterministic mode
export PI_OFFLINE=1
```

When offline or when the remote model is unavailable, `PiRpcClient` automatically routes execution to `scripts/pi-demo`, returning a validated mock analysis instantly and allowing the BPMN workflow to continue seamlessly.

---

## 4. Error Handling & Retries

If an agent process encounters a timeout, network failure, or unrecoverable error:
- The task state is updated to `FAILED` with a recorded `failure_reason`.
- The instance UI renders a red **Retry** button directly on the affected task node.
- Clicking **Retry** re-invokes the AI harness without restarting the entire workflow.
