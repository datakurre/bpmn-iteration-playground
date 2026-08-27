import json
import os
import sys
import urllib.request


def main() -> None:
    port = os.getenv("PORT", "8080")
    url = f"http://127.0.0.1:{port}/api/history/pack"
    try:
        req = urllib.request.Request(url, data=b"", method="POST")
        with urllib.request.urlopen(req, timeout=3) as res:
            data = json.loads(res.read())
            print(
                f"ZODB storage packed (via API): reclaimed {data['reclaimed_human']} (current size: {data['size_after_human']})"
            )
            return
    except Exception:
        pass

    try:
        from graph_agent.persistence import WorkflowStore

        store = WorkflowStore()
        data = store.pack()
        print(
            f"ZODB storage packed (direct): reclaimed {data['reclaimed_human']} (current size: {data['size_after_human']})"
        )
        store.close()
    except Exception as exc:
        print(f"Failed to pack ZODB database: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
