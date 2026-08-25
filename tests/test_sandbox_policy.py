import json

from graph_agent.adapters.sandbox_policy import build_agents_md, parse_agents_md_toml


def test_parse_agents_md_toml_extracts_block() -> None:
    content = """# Doc

```toml agent-sandbox
[network]
allowed_hosts = ["example.com:443"]
```

more text
"""
    extracted = parse_agents_md_toml(content)
    assert 'allowed_hosts = ["example.com:443"]' in extracted


def test_parse_agents_md_toml_returns_empty_when_absent() -> None:
    assert parse_agents_md_toml("just plain markdown, no toml block") == ""


def test_build_agents_md_merges_hosts_and_routes_from_base_toml() -> None:
    base_agents_md = """```toml agent-sandbox
[network]
allowed_hosts = ["base.example.com:443"]

[[network.allowed_routes]]
host = "base.example.com:443"
method = "GET"
path = "/**"

[ports]
web = 3000
```
"""
    md = build_agents_md({}, base_agents_md=base_agents_md)
    assert "base.example.com:443" in md
    assert "[[network.allowed_routes]]" in md
    assert "web = 3000" in md


def test_build_agents_md_ignores_malformed_base_toml() -> None:
    base_agents_md = """```toml agent-sandbox
this is not valid toml [[[
```
"""
    md = build_agents_md({}, base_agents_md=base_agents_md)
    # falls back to the default host list since the base toml couldn't be parsed
    assert "opencode.ai:443" in md


def test_build_agents_md_ignores_non_integer_base_ports() -> None:
    base_agents_md = """```toml agent-sandbox
[network]
allowed_hosts = ["example.com:443"]

[ports]
web = "not-a-number"
```
"""
    md = build_agents_md({}, base_agents_md=base_agents_md)
    assert "[ports]" not in md


def test_build_agents_md_allowed_hosts_as_json_list() -> None:
    config = {"allowed_hosts": json.dumps(["json-a.example.com:443", "json-b.example.com:443"])}
    md = build_agents_md(config)
    assert "json-a.example.com:443" in md
    assert "json-b.example.com:443" in md


def test_build_agents_md_allowed_hosts_json_list_malformed_falls_back_to_split() -> None:
    config = {"allowed_hosts": "[not valid json"}
    md = build_agents_md(config)
    # malformed JSON is silently ignored; no hosts survive, so defaults apply
    assert "opencode.ai:443" in md


def test_build_agents_md_allowed_routes_as_single_dict() -> None:
    config = {"allowed_routes": json.dumps({"host": "single.example.com:443", "method": "POST", "path": "/x"})}
    md = build_agents_md(config)
    assert "[[network.allowed_routes]]" in md
    assert 'host = "single.example.com:443"' in md


def test_build_agents_md_allowed_routes_malformed_json_is_ignored() -> None:
    config = {"allowed_hosts": "example.com:443", "allowed_routes": "{not json"}
    md = build_agents_md(config)
    assert "[[network.allowed_routes]]" not in md


def test_build_agents_md_ports_malformed_json_is_ignored() -> None:
    config = {"allowed_hosts": "example.com:443", "ports": "{not json"}
    md = build_agents_md(config)
    assert "[ports]" not in md


def test_build_agents_md_ports_non_dict_json_is_ignored() -> None:
    config = {"allowed_hosts": "example.com:443", "ports": json.dumps(["web", 3000])}
    md = build_agents_md(config)
    assert "[ports]" not in md


def test_build_agents_md_route_with_numeric_and_boolean_values() -> None:
    config = {
        "allowed_routes": json.dumps([{"host": "svc.example.com:443", "port": 8080, "strict": True}]),
    }
    md = build_agents_md(config)
    assert "port = 8080" in md
    assert "strict = true" in md


def test_build_agents_md_replaces_existing_toml_block_in_base_text() -> None:
    base_agents_md = """```toml agent-sandbox
[network]
allowed_hosts = ["old.example.com:443"]
```

# Agent Guidelines
Some existing prose that must survive.
"""
    md = build_agents_md({"allowed_hosts": "new.example.com:443"}, base_agents_md=base_agents_md)
    assert "new.example.com:443" in md
    assert "Some existing prose that must survive." in md


def test_build_agents_md_prepends_toml_block_when_base_text_has_none() -> None:
    base_agents_md = "# Existing Agent Guidelines\n\nNo policy block here.\n"
    md = build_agents_md({"allowed_hosts": "example.com:443"}, base_agents_md=base_agents_md)
    assert md.startswith("```toml agent-sandbox")
    assert "No policy block here." in md
