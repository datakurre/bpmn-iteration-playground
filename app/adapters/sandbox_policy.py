"""agent-sandbox network policy rendered into a workspace AGENTS.md.

Only the sandbox adapters run things under agent-sandbox, so policy generation and the
other per-workspace setup they share (executable resolution, secretspec) lives here
rather than in the BPMN engine.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import tomllib
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE_ROOT = REPO_ROOT / "workspace_templates"
DEFAULT_SANDBOX_TEMPLATE = "agent_sandbox"
# A shell task's default posture is "no secrets": see workspace_templates/sandbox_shell.
DEFAULT_SHELL_SANDBOX_TEMPLATE = "sandbox_shell"


def resolve_sandbox_command_prefix(explicit: str | None = None) -> list[str]:
    """Resolve the argv prefix that invokes agent-sandbox.

    Priority: an explicit override (adapter constructor arg or `AGENT_SANDBOX_EXECUTABLE`)
    > the vendored release build > `nix run` against the vendored flake > a bare
    `agent-sandbox` resolved from `$PATH`.

    `nix run` ranks above `$PATH` deliberately: a system-wide `agent-sandbox` install can
    predate the vendored submodule (no `--programmatic` support, for example) and fails in
    a way that looks like a flag typo rather than a version mismatch, while `nix run`
    always builds from the checked-out submodule.
    """
    if explicit:
        return [explicit]
    env_override = os.getenv("AGENT_SANDBOX_EXECUTABLE")
    if env_override:
        return [env_override]
    vendor_dir = REPO_ROOT / "vendor" / "agent-sandbox"
    vendor_bin = vendor_dir / "cli" / "target" / "release" / "agent-sandbox"
    if vendor_bin.is_file():
        return [str(vendor_bin)]
    if (vendor_dir / "flake.nix").is_file():
        return ["nix", "run", str(vendor_dir), "--"]
    on_path = shutil.which("agent-sandbox")
    if on_path:
        return [on_path]
    return ["agent-sandbox"]


def prepare_sandbox_workspace(
    workdir: str, task_config: dict[str, str], default_template: str = DEFAULT_SANDBOX_TEMPLATE
) -> None:
    """Render this task's network policy into the workspace AGENTS.md, and make a
    secretspec.toml resolvable from the workspace.

    `--secrets` resolves `secretspec.toml` from agent-sandbox's own cwd, which for a
    sandboxed adapter is the per-instance workspace `--workspace` mounts -- not the repo
    checkout -- so without a copy here every sandboxed turn fails secretspec resolution
    outright once a task's policy actually requests a secret-bearing route.

    Both files are seeded from `workspace_templates/<sandbox_template>/`, `default_template`
    unless the task's own `sandbox_template` property names another one -- this is
    deliberately the *task's own* base, not this repo's own root AGENTS.md/secretspec.toml,
    which describe the coding agent's dev sandbox and would otherwise leak that unrelated
    policy into every task's workspace by default. `default_template` lets each sandboxed
    adapter pick its own starting posture (`SandboxPiAdapter` needs a model route by
    default, `SandboxShellAdapter` needs none) without every task declaring one.
    """
    target = Path(workdir)
    template_name = (task_config.get("sandbox_template") or default_template).strip()
    template_dir = TEMPLATE_ROOT / template_name

    agents_md = target / "AGENTS.md"
    base_md = agents_md.read_text("utf-8") if agents_md.is_file() else None
    if not base_md:
        template_agents_md = template_dir / "AGENTS.md"
        if template_agents_md.is_file():
            base_md = template_agents_md.read_text("utf-8")
    agents_md.write_text(build_agents_md(task_config, base_agents_md=base_md), encoding="utf-8")

    secretspec = target / "secretspec.toml"
    template_secretspec = template_dir / "secretspec.toml"
    if not secretspec.is_file() and template_secretspec.is_file():
        shutil.copy2(template_secretspec, secretspec)


def workspace_policy_declares_routes(workdir: str) -> bool:
    """Whether the workspace AGENTS.md (already rendered by `prepare_sandbox_workspace`)
    declares any `[[network.allowed_routes]]`.

    `--secrets` resolves *every* declared route eagerly at launch and refuses to start at
    all if any of them can't be satisfied (see `cli/src/secrets.rs`'s
    `missing required secret`) -- so passing `--secrets` unconditionally would make a
    shell task that needs no secrets at all (a compiler, a slicer) fail to launch just
    because the default policy happens to declare an unrelated route nobody configured a
    key for. A caller should only add `--secrets` when this returns true.
    """
    agents_md = Path(workdir) / "AGENTS.md"
    if not agents_md.is_file():
        return False
    toml_text = parse_agents_md_toml(agents_md.read_text("utf-8"))
    if not toml_text:
        return False
    try:
        parsed = tomllib.loads(toml_text)
    except Exception:
        return False
    routes = parsed.get("network", {}).get("allowed_routes")
    return bool(routes)


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
