from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path
from typing import Any

from ZODB.blob import Blob


async def unpack_workspace(blob_or_bytes: Blob | bytes | None, prefix: str = "bpmn-ws-") -> str:
    """Unpack a tar.zst (or tar) archive blob/bytes into a temporary directory. Returns workdir path."""
    workdir = tempfile.mkdtemp(prefix=prefix)
    if not blob_or_bytes:
        return workdir

    archive_file = None
    if isinstance(blob_or_bytes, bytes):
        archive_file = Path(workdir) / "__workspace.tar.zst"
        archive_file.write_bytes(blob_or_bytes)
        source_path = str(archive_file)
    else:
        try:
            with blob_or_bytes.open("r") as f:
                content = f.read()
            if content:
                archive_file = Path(workdir) / "__workspace.tar.zst"
                archive_file.write_bytes(content if isinstance(content, bytes) else content.encode())
                source_path = str(archive_file)
            else:
                return workdir
        except Exception:
            return workdir

    if source_path is None or not Path(source_path).exists() or Path(source_path).stat().st_size == 0:
        return workdir

    try:
        content_bytes = Path(source_path).read_bytes()
        if content_bytes.startswith(b"\x28\xb5\x2f\xfd"):
            proc = await asyncio.create_subprocess_exec(
                "tar",
                "--zstd",
                "-xf",
                str(source_path),
                "-C",
                workdir,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.communicate()
        elif content_bytes.startswith(b"\x1f\x8b"):
            import io
            import tarfile

            def _extract_gz() -> None:
                with tarfile.open(fileobj=io.BytesIO(content_bytes), mode="r:gz") as tar:
                    tar.extractall(workdir)

            await asyncio.to_thread(_extract_gz)
        else:
            import io
            import tarfile

            def _extract_tar() -> None:
                try:
                    with tarfile.open(fileobj=io.BytesIO(content_bytes), mode="r:*") as tar:
                        tar.extractall(workdir)
                except Exception:
                    pass

            await asyncio.to_thread(_extract_tar)
    except Exception:
        pass
    finally:
        if archive_file and archive_file.exists():
            archive_file.unlink()

    return workdir


async def pack_workspace(workdir: str) -> Blob:
    """Pack a directory into a tar.zst blob."""
    blob = Blob()

    try:
        proc = await asyncio.create_subprocess_exec(
            "tar",
            "--zstd",
            "-cf",
            "-",
            "-C",
            workdir,
            ".",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0 and stdout:
            with blob.open("w") as f:
                f.write(stdout)
            return blob
    except Exception:
        pass

    # Fallback
    import io
    import tarfile

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        tar.add(workdir, arcname=".")

    with blob.open("w") as f:
        f.write(buf.getvalue())

    return blob


async def pack_workspace_to_bytes(workdir: str) -> bytes:
    """Pack a directory into a tar.zst bytes archive."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "tar",
            "--zstd",
            "-cf",
            "-",
            "-C",
            workdir,
            ".",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0 and stdout:
            return stdout
    except Exception:
        pass

    import io
    import tarfile

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        tar.add(workdir, arcname=".")
    return buf.getvalue()


def get_workspace_metadata(workdir: str, artifacts: list[str] | None = None) -> dict[str, Any]:
    """Inspect workspace directory and return a manifest of files without unpacking blobs later."""
    files: list[dict[str, Any]] = []
    total_size = 0
    workdir_path = Path(workdir)
    if workdir_path.exists():
        for p in sorted(workdir_path.rglob("*")):
            if p.is_file() and not p.name.startswith("__workspace"):
                try:
                    rel_path = str(p.relative_to(workdir_path))
                    size = p.stat().st_size
                    mtime = p.stat().st_mtime
                    files.append({
                        "name": p.name,
                        "path": rel_path,
                        "size": size,
                        "mtime": mtime,
                    })
                    total_size += size
                except Exception:
                    pass
    return {
        "file_count": len(files),
        "total_size": total_size,
        "files": files,
        "artifacts": artifacts or [],
    }


async def extract_workspace_file(blob_or_bytes: Blob | bytes | None, relative_path: str) -> bytes | None:
    """Extract a single file on-demand from the packed workspace blob without retaining the workdir."""
    workdir = await unpack_workspace(blob_or_bytes, prefix="bpmn-extract-")
    try:
        clean_rel = relative_path.lstrip("/\\").strip()
        target = (Path(workdir) / clean_rel).resolve()
        workdir_resolved = Path(workdir).resolve()
        # Security: prevent path traversal out of workdir
        if not str(target).startswith(str(workdir_resolved)):
            return None
        if target.is_file():
            return target.read_bytes()
        return None
    finally:
        cleanup_workspace(workdir)


def duplicate_blob(blob: Blob | None) -> Blob | None:
    if blob is None:
        return None
    new_blob = Blob()
    path = blob.committed()
    if path and Path(path).exists():
        with new_blob.open("w") as f_out, open(path, "rb") as f_in:
            shutil.copyfileobj(f_in, f_out)
    return new_blob


def cleanup_workspace(workdir: str) -> None:
    """Remove a temporary workspace directory."""
    if workdir and Path(workdir).exists() and "bpmn-" in str(workdir):
        shutil.rmtree(workdir, ignore_errors=True)

