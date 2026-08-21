"""agent-sandbox network policy rendered into a workspace AGENTS.md.

Only the sandbox adapter runs agents under agent-sandbox, so policy generation lives
here rather than in the BPMN engine.
"""

from __future__ import annotations

import contextlib
import json
import re
import tomllib
from typing import Any


def parse_agents_md_toml(content: str) -> str:
    """Extract the toml agent-sandbox block content from markdown text."""
    match = re.search(r"```toml\s+agent-sandbox\s*\n(.*?)\n```", content, re.DOTALL)
    if match:
        return match.group(1).strip()
    return ""


def build_agents_md(task_config: dict[str, str], base_agents_md: str | None = None) -> str:  # noqa: C901, PLR0912, PLR0915 -- merges base+task-declared network policy across several optional sources; pre-existing complexity
    """Build or update an AGENTS.md document embedding task-specific agent-sandbox network policy."""

    raw_policy = task_config.get("sandbox_policy") or task_config.get("network_policy")
    if raw_policy and "```toml agent-sandbox" in raw_policy:
        return raw_policy.strip() + "\n"

    allowed_hosts: list[str] = []
    allowed_routes: list[dict[str, Any]] = []
    ports: dict[str, int] = {}

    base_text = base_agents_md or ""
    base_toml = parse_agents_md_toml(base_text)
    if base_toml:
        try:
            parsed_base = tomllib.loads(base_toml)
            net = parsed_base.get("network", {})
            if isinstance(net.get("allowed_hosts"), list):
                allowed_hosts.extend(str(h) for h in net["allowed_hosts"])
            if isinstance(net.get("allowed_routes"), list):
                allowed_routes.extend(net["allowed_routes"])
            if isinstance(parsed_base.get("ports"), dict):
                for k, v in parsed_base["ports"].items():
                    with contextlib.suppress(ValueError, TypeError):
                        ports[str(k)] = int(v)
        except Exception:
            pass

    raw_hosts = task_config.get("allowed_hosts")
    if raw_hosts:
        if raw_hosts.strip().startswith("["):
            try:
                parsed_h = json.loads(raw_hosts)
                if isinstance(parsed_h, list):
                    for h in parsed_h:
                        if str(h) not in allowed_hosts:
                            allowed_hosts.append(str(h))
            except Exception:
                pass
        else:
            for part in re.split(r"[,;\s]+", raw_hosts.strip()):
                part = part.strip()
                if part and part not in allowed_hosts:
                    allowed_hosts.append(part)

    raw_routes = task_config.get("allowed_routes")
    if raw_routes:
        try:
            parsed_r = json.loads(raw_routes)
            if isinstance(parsed_r, list):
                for r in parsed_r:
                    if isinstance(r, dict) and r not in allowed_routes:
                        allowed_routes.append(r)
            elif isinstance(parsed_r, dict) and parsed_r not in allowed_routes:
                allowed_routes.append(parsed_r)
        except Exception:
            pass

    raw_ports = task_config.get("ports")
    if raw_ports:
        try:
            parsed_p = json.loads(raw_ports)
            if isinstance(parsed_p, dict):
                for k, v in parsed_p.items():
                    ports[str(k)] = int(v)
        except Exception:
            pass

    if not allowed_hosts and not allowed_routes:
        allowed_hosts = [
            "cache.nixos.org:443",
            "channels.nixos.org:443",
            "files.pythonhosted.org:443",
            "github.com:443,22",
            "opencode.ai:443",
            "registry.npmjs.org:443",
        ]

    toml_lines = ["```toml agent-sandbox", "[network]"]
    if allowed_hosts:
        toml_lines.append("allowed_hosts = [")
        for h in sorted(set(allowed_hosts)):
            toml_lines.append(f'    "{h}",')
        toml_lines.append("]")

    if ports:
        toml_lines.append("\n[ports]")
        for k, v in sorted(ports.items()):
            toml_lines.append(f"{k} = {v}")

    if allowed_routes:
        for r in allowed_routes:
            toml_lines.append("\n[[network.allowed_routes]]")
            for rk, rv in sorted(r.items()):
                if isinstance(rv, (int, float, bool)):
                    toml_lines.append(f"{rk} = {str(rv).lower()}")
                else:
                    toml_lines.append(f'{rk} = "{rv}"')

    toml_lines.append("```")
    rendered_toml = "\n".join(toml_lines)

    if base_text and "```toml agent-sandbox" in base_text:
        return re.sub(
            r"```toml\s+agent-sandbox\s*\n.*?\n```",
            rendered_toml,
            base_text,
            flags=re.DOTALL,
        )
    elif base_text:
        return f"{rendered_toml}\n\n{base_text}"
    else:
        return f"{rendered_toml}\n\n# Agent Guidelines\n\nExecuted inside agent-sandbox.\n"
