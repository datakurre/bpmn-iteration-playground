"""`bpmn` console-script entry point.

Phase 0 of the meta-agent refactor (docs/meta-agent-refactor-plan.md): this only makes the
package installable and gives it a real command, wrapping the same `create_app()`/uvicorn
startup `bpmn_agent/main.py` already did. It intentionally does not yet do what later phases
add -- `.agents/` state discovery, a free loopback port, subcommands, or a TUI. Those are
phases 1-5; this is the entry point they attach to.
"""

from __future__ import annotations

import argparse

import uvicorn


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="bpmn", description="Run the BPMN agent web server.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Bind port (default: 8000)")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
    args = parser.parse_args(argv)

    uvicorn.run("bpmn_agent.api.server:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
