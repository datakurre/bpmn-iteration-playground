from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from typing import Any

from graph_agent.adapters.base import AdapterCapabilities, AgentResult, BaseAdapter
from graph_agent.adapters.sandbox_policy import prepare_sandbox_workspace, resolve_sandbox_command_prefix
from graph_agent.pi_client import (
    _dispatch_event,
    _final_text,
    _kill_process_group,
    _outcome_status,
    _parse_json,
    _session_id_from_events,
)

logger = logging.getLogger("bpmn.sandbox_adapter")

# Pi's own local "is a key configured" precondition check runs before it ever makes a
# request, and reads a fixed per-provider env var (see the built package's
# docs/providers.md API Keys table) -- unrelated to whichever secretspec.toml key name
# this project's own AGENTS.md network policy declares for the proxy-injected route.
# `--secrets` deliberately keeps the real credential out of the container env (only the
# proxy injects it, into the Authorization header of a matching request, replacing
# whatever value the client sent -- see agent-sandbox's proxy/src/inject.rs), so without
# a placeholder value here Pi fails "No API key found" locally before any request is
# even attempted. Only providers this project actually drives (PI_PROVIDER=opencode-go
# in flake.nix) are listed; add a line here when a new one is wired up.
_PI_LOCAL_API_KEY_ENV_VAR = {
    "opencode-go": "OPENCODE_API_KEY",
    "opencode-zen": "OPENCODE_API_KEY",
}
_SANDBOX_API_KEY_PLACEHOLDER = "secret-injected-by-proxy"

# Mirrors PI_SANDBOX_ENABLED's "=1" convention. Default on, matching the adapter's
# original unconditional behavior: --secrets resolves every declared route eagerly and
# fails the whole launch if one can't be satisfied, which is right when the sandbox's
# own placeholder-keyed provider needs the proxy to inject a real credential. Set to "0"
# for a host where Pi already has a real credential from its own `/login` (persisted in
# the mounted `.pi` state, resolved before the placeholder env var and outside the proxy
# entirely) -- there --secrets has nothing to do and would only add a route the host
# hasn't necessarily configured a key for.
_SECRETS_ENABLED_ENV_VAR = "PI_SANDBOX_SECRETS_ENABLED"


class SandboxPiAdapter(BaseAdapter):
    """Adapter executing Pi agents inside isolated Podman containers via agent-sandbox --json --prompt -."""

    def __init__(
        self,
        executable: str | None = None,
        timeout_seconds: float = 1800,
        max_events: int = 10000,
    ) -> None:
        self.command_prefix = resolve_sandbox_command_prefix(executable)
        self.timeout_seconds = timeout_seconds
        self.max_events = max_events

    @property
    def adapter_type(self) -> str:
        return "sandbox_pi"

    @property
    def capabilities(self) -> AdapterCapabilities:
        return AdapterCapabilities(
            display_name="Pi Agent (sandboxed)",
            supports_sessions=True,
            timeout_env_var="PI_TIMEOUT_SECONDS",
            default_timeout_seconds=1800.0,
            no_output_hint=(
                "This usually means no authenticated provider/model is configured; check PI_PROVIDER, "
                "PI_MODEL, and that the workspace's sandbox policy declares a secret-injecting route for "
                "the provider (see app/adapters/sandbox_policy.py, § 4b Agent Sandbox Integration)."
            ),
            view="agent",
        )

    async def prepare_workspace(self, workdir: str, config: dict[str, str]) -> None:
        """Render this BPMN task's network policy into the workspace AGENTS.md, plus secretspec.toml."""
        prepare_sandbox_workspace(workdir, config)

    async def run(  # noqa: C901, PLR0912, PLR0915 -- subprocess lifecycle (spawn/stream/timeout/cancel/parse) isn't naturally splittable without threading state through several helpers; left as pre-existing complexity
        self,
        prompt: str,
        config: dict[str, str],
        cwd: str,
        on_event: Any = None,
    ) -> AgentResult:
        provider = config.get("provider") or config.get("pi_provider") or os.getenv("PI_PROVIDER")
        model = config.get("model") or config.get("pi_model") or os.getenv("PI_MODEL")
        timeout_raw = config.get("timeout") or config.get("timeout_seconds")
        timeout_seconds = int(timeout_raw) if timeout_raw and timeout_raw.isdigit() else self.timeout_seconds

        session_id = config.get("session_id")
        fork = config.get("fork", "").lower() in ("true", "1", "yes")

        # Build the agent-sandbox command: --json (structured stdout, buffered until
        # the turn exits) + --prompt - (feed `prompt` to pi over stdin) replace the
        # old combined --programmatic flag.
        secrets_enabled = os.getenv(_SECRETS_ENABLED_ENV_VAR, "1") == "1"
        command = [
            *self.command_prefix,
            "--workspace",
            "--proxy",
        ]
        if secrets_enabled:
            command.append("--secrets")
            local_key_var = _PI_LOCAL_API_KEY_ENV_VAR.get(provider or "")
            if local_key_var:
                command.extend(["-e", f"{local_key_var}={_SANDBOX_API_KEY_PLACEHOLDER}"])
        command.extend(["--json", "--prompt", "-", "pi"])
        if model:
            command.extend(["--model", model])
        if provider:
            command.extend(["--provider", provider])
        if session_id:
            if fork:
                command.extend(["--fork", session_id])
            else:
                command.extend(["--session", session_id])

        logger.info(f"Executing agent-sandbox: {' '.join(command)} (cwd: {cwd})")

        env = dict(os.environ)
        # Ensure proxy CA and secrets are forwarded
        if "NODE_USE_ENV_PROXY" not in env:
            env["NODE_USE_ENV_PROXY"] = "1"

        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                cwd=cwd,
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                # Matches PiClient: agent-sandbox spawns Podman/Pi children of its own, so a
                # plain process.kill() on timeout/cancel would leave them running. Its own
                # session (not the caller's) is what gets killed below.
                start_new_session=True,
            )
        except Exception as exc:
            logger.error(f"Failed to spawn agent-sandbox: {exc}")
            return AgentResult(
                status="failed",
                output=None,
                text="",
                messages=[],
                stderr=f"Failed to spawn agent-sandbox: {exc}",
                exit_code=1,
                policy_error=str(exc),
            )

        events: list[dict[str, Any]] = []
        raw_stdout = b""
        raw_stderr = b""
        exit_code = 1
        status = "failed"
        network_data: dict[str, Any] | None = None
        policy_error: str | None = None

        try:
            # Write prompt to stdin and close stdin so agent-sandbox/pi reaches EOF
            assert process.stdin is not None
            process.stdin.write(prompt.encode("utf-8"))
            await process.stdin.drain()
            process.stdin.close()
            with contextlib.suppress(Exception):
                await process.stdin.wait_closed()

            raw_stdout, raw_stderr = await asyncio.wait_for(
                process.communicate(), timeout=float(timeout_seconds)
            )
            exit_code = process.returncode if process.returncode is not None else 0
        except TimeoutError:
            await _kill_process_group(process)
            return AgentResult(
                status="timeout",
                output=None,
                text="",
                messages=[],
                stderr="agent-sandbox execution timed out",
                exit_code=1,
            )
        except asyncio.CancelledError:
            await _kill_process_group(process)
            return AgentResult(
                status="cancelled",
                output=None,
                text="",
                messages=[],
                stderr="agent-sandbox execution was cancelled",
                exit_code=1,
            )
        except Exception as exc:
            return AgentResult(
                status="failed",
                output=None,
                text="",
                messages=[],
                stderr=f"agent-sandbox error: {exc}",
                exit_code=1,
            )

        decoded_stdout = raw_stdout.decode("utf-8", errors="replace").strip()
        decoded_stderr = raw_stderr.decode("utf-8", errors="replace").strip()
        logger.debug(f"agent-sandbox raw stdout ({len(decoded_stdout)} chars): {decoded_stdout[:4000]}")
        if decoded_stderr:
            logger.debug(f"agent-sandbox raw stderr ({len(decoded_stderr)} chars): {decoded_stderr[:4000]}")

        # Parse the outer JSON envelope from agent-sandbox --json (type: "exit")
        inner_stdout = decoded_stdout
        inner_stderr = decoded_stderr
        container_exit_code = exit_code

        try:
            envelope = json.loads(decoded_stdout)
            if isinstance(envelope, dict) and "status" in envelope and "stdout" in envelope:
                container_exit_code = envelope.get("status", exit_code)
                inner_stdout = envelope.get("stdout", "")
                inner_stderr = envelope.get("stderr", "")
                network_data = envelope.get("network")
                policy_error = envelope.get("policy_error")
        except (json.JSONDecodeError, TypeError):
            # stdout was not an envelope; treat decoded_stdout as inner stdout
            pass

        # Parse inner stdout lines for Pi JSON events
        for line in inner_stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
                if isinstance(ev, dict):
                    events.append(ev)
                    await _dispatch_event(on_event, ev)
            except json.JSONDecodeError:
                pass

        branch_session_id = _session_id_from_events(events)

        text = _final_text(events)
        if not text and inner_stdout and not events:
            text = inner_stdout

        output = _parse_json(text)

        # Attach network summary to output dictionary if available
        if output is not None and network_data:
            output["network"] = network_data

        status = _outcome_status(output, container_exit_code, events)

        stderr_final = inner_stderr or decoded_stderr
        if policy_error and not stderr_final:
            stderr_final = f"Sandbox policy error: {policy_error}"

        logger.debug(
            f"agent-sandbox outcome: status={status} exit_code={container_exit_code} "
            f"events={len(events)} policy_error={policy_error!r} text={text[:2000]!r}"
        )

        return AgentResult(
            status=status,
            output=output,
            text=text,
            messages=events,
            stderr=stderr_final,
            exit_code=container_exit_code,
            session_id=branch_session_id,
            network=network_data,
            policy_error=policy_error,
        )
