from __future__ import annotations

import hashlib
import json
import re
import shutil
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Tuple


MAX_FILE_BYTES = 20 * 1024 * 1024
TARGET_CHUNK_BYTES = 8 * 1024 * 1024
TOKEN_RE = re.compile(r"[a-z0-9]{2,}", re.IGNORECASE)


def build_static_viewer_data(data_root: Path, out_dir: Path) -> Dict[str, Any]:
    data_root = data_root.resolve()
    out_dir = out_dir.resolve()
    threads_root = data_root / "threads"
    if not threads_root.is_dir():
        raise FileNotFoundError(f"Thread data directory not found: {threads_root}")

    version = _hash_inputs(data_root)
    out_dir.mkdir(parents=True, exist_ok=True)
    for child in out_dir.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
    version_dir = out_dir / version
    version_dir.mkdir(parents=True, exist_ok=True)

    manifest_threads: List[Dict[str, Any]] = []
    file_hashes: Dict[str, str] = {}
    total_posts = 0

    for thread_dir in sorted(p for p in threads_root.iterdir() if p.is_dir()):
        thread_export = _export_thread(thread_dir, version_dir, file_hashes)
        manifest_threads.append(thread_export)
        total_posts += int(thread_export["total_posts"])

    manifest = {
        "schema_version": 1,
        "version": version,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_posts": total_posts,
        "max_file_size_bytes": MAX_FILE_BYTES,
        "threads": manifest_threads,
        "files": file_hashes,
    }

    (out_dir / "manifest.json").write_text(_json(manifest), encoding="utf-8")
    _assert_file_sizes(out_dir)
    _assert_export_counts(version_dir, manifest)
    return manifest


def _export_thread(thread_dir: Path, version_dir: Path, file_hashes: Dict[str, str]) -> Dict[str, Any]:
    thread_id = thread_dir.name
    export_thread_dir = version_dir / "threads" / thread_id
    export_thread_dir.mkdir(parents=True, exist_ok=True)

    meta = _read_json(thread_dir / "meta.json", default={})
    meta_path = f"threads/{thread_id}/meta.json"
    _write_json_file(version_dir, meta_path, meta, file_hashes)

    meta_writer = _JsonChunkWriter(
        version_dir=version_dir,
        rel_dir=f"threads/{thread_id}",
        prefix="posts-meta",
        file_hashes=file_hashes,
    )
    body_writer = _JsonChunkWriter(
        version_dir=version_dir,
        rel_dir=f"threads/{thread_id}",
        prefix="bodies",
        file_hashes=file_hashes,
    )
    search: Dict[str, Dict[str, Dict[int, int]]] = defaultdict(lambda: defaultdict(dict))

    total_posts = 0
    min_post_index: int | None = None
    max_post_index: int | None = None

    for post in _iter_posts(thread_dir):
        post_id = int(post["post_id"])
        post_index = int(post["post_index"])
        text = post.get("content_text_full") or ""

        body_path = body_writer.add(
            {
                "post_id": post_id,
                "content_html_raw": post.get("content_html_raw") or "",
                "content_text_full": text,
                "spoilers": post.get("spoilers") or [],
                "attachments": post.get("attachments") or [],
            }
        )
        meta_writer.add(
            {
                "thread_id": int(post.get("thread_id") or thread_id),
                "post_id": post_id,
                "post_index": post_index,
                "author_id": int(post.get("author_id") or 0),
                "author_name": post.get("author_name") or "Unknown",
                "created_at": post.get("created_at") or "",
                "likes_count": int(post.get("likes_count") or 0),
                "content_length": int(post.get("content_length") or len(text)),
                "body_path": body_path,
            }
        )

        for token, count in Counter(_tokens(text)).items():
            search[token[:2]][token][post_id] = count

        total_posts += 1
        min_post_index = post_index if min_post_index is None else min(min_post_index, post_index)
        max_post_index = post_index if max_post_index is None else max(max_post_index, post_index)

    posts_meta = meta_writer.close()
    bodies = body_writer.close()
    search_buckets = _write_search(search, version_dir, thread_id, file_hashes)

    return {
        "thread_id": int(thread_id),
        "title": meta.get("title") or f"Thread {thread_id}",
        "total_posts": total_posts,
        "min_post_index": min_post_index,
        "max_post_index": max_post_index,
        "meta": meta_path,
        "posts_meta": posts_meta,
        "bodies": bodies,
        "search_buckets": search_buckets,
    }


class _JsonChunkWriter:
    def __init__(self, *, version_dir: Path, rel_dir: str, prefix: str, file_hashes: Dict[str, str]) -> None:
        self.version_dir = version_dir
        self.rel_dir = rel_dir
        self.prefix = prefix
        self.file_hashes = file_hashes
        self.index = 0
        self.items: List[Dict[str, Any]] = []
        self.bytes = 0
        self.paths: List[str] = []

    def add(self, item: Dict[str, Any]) -> str:
        encoded_size = len(_json(item).encode("utf-8")) + 2
        if self.items and self.bytes + encoded_size > TARGET_CHUNK_BYTES:
            self._flush()
        rel_path = self._current_rel_path()
        self.items.append(item)
        self.bytes += encoded_size
        return rel_path

    def close(self) -> List[str]:
        self._flush()
        return self.paths

    def _current_rel_path(self) -> str:
        return f"{self.rel_dir}/{self.prefix}-{self.index:04d}.json"

    def _flush(self) -> None:
        if not self.items:
            return
        rel_path = self._current_rel_path()
        _write_json_file(self.version_dir, rel_path, {"items": self.items}, self.file_hashes)
        self.paths.append(rel_path)
        self.index += 1
        self.items = []
        self.bytes = 0


def _iter_posts(thread_dir: Path) -> Iterator[Dict[str, Any]]:
    for shard_path in _best_shards(thread_dir / "shards"):
        shard = _read_json(shard_path, default={})
        posts = shard.get("posts") or []
        for post in sorted(posts, key=lambda p: (int(p.get("post_index", 0)), int(p.get("post_id", 0)))):
            yield post


def _best_shards(shards_dir: Path) -> List[Path]:
    best: Dict[str, Tuple[int, Path]] = {}
    for path in shards_dir.glob("*.json"):
        match = re.match(r"^(\d+_\d{6}-\d{6})_v(\d+)\.json$", path.name)
        if not match:
            continue
        prefix, version = match.group(1), int(match.group(2))
        if prefix not in best or version > best[prefix][0]:
            best[prefix] = (version, path)
    return [item[1] for item in sorted(best.values(), key=lambda item: item[1].name)]


def _write_search(
    search: Dict[str, Dict[str, Dict[int, int]]],
    version_dir: Path,
    thread_id: str,
    file_hashes: Dict[str, str],
) -> Dict[str, List[str]]:
    result: Dict[str, List[str]] = {}
    chunk: Dict[str, List[List[int]]] = {}
    chunk_prefixes: set[str] = set()
    chunk_size = 0
    chunk_index = 0

    def flush() -> None:
        nonlocal chunk, chunk_prefixes, chunk_size, chunk_index
        if not chunk:
            return
        rel_path = _write_search_chunk(version_dir, thread_id, chunk_index, chunk, file_hashes)
        for item_prefix in sorted(chunk_prefixes):
            result.setdefault(item_prefix, []).append(rel_path)
        chunk = {}
        chunk_prefixes = set()
        chunk_size = 0
        chunk_index += 1

    for prefix, token_map in sorted(search.items()):
        for token, postings in sorted(token_map.items()):
            item = [[post_id, count] for post_id, count in sorted(postings.items())]
            encoded_size = len(_json({token: item}).encode("utf-8")) + 2
            if chunk and chunk_size + encoded_size > TARGET_CHUNK_BYTES:
                flush()
            chunk[token] = item
            chunk_prefixes.add(prefix)
            chunk_size += encoded_size

    flush()
    missing = sorted(prefix for prefix, tokens in search.items() if tokens and prefix not in result)
    if missing:
        raise AssertionError(f"Search prefixes missing from export: {missing[:5]}")

    return result


def _write_search_chunk(
    version_dir: Path,
    thread_id: str,
    chunk_index: int,
    tokens: Dict[str, List[List[int]]],
    file_hashes: Dict[str, str],
) -> str:
    rel_path = f"threads/{thread_id}/search/search-{chunk_index:04d}.json"
    _write_json_file(version_dir, rel_path, {"tokens": tokens}, file_hashes)
    return rel_path


def _tokens(text: str) -> Iterable[str]:
    for token in TOKEN_RE.findall(text.lower()):
        if len(token) <= 48:
            yield token


def _hash_inputs(data_root: Path) -> str:
    hasher = hashlib.sha256()
    hasher.update(b"lilf95-static-viewer-v2\n")
    files = sorted(
        path
        for path in data_root.rglob("*.json")
        if path.is_file() and "avatars" not in path.parts
    )
    for path in files:
        hasher.update(str(path.relative_to(data_root)).replace("\\", "/").encode("utf-8"))
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                hasher.update(block)
    return hasher.hexdigest()[:16]


def _read_json(path: Path, *, default: Any) -> Any:
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _write_json_file(version_dir: Path, rel_path: str, value: Any, file_hashes: Dict[str, str]) -> None:
    encoded = _json(value).encode("utf-8")
    path = version_dir / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encoded)
    file_hashes[rel_path] = hashlib.sha256(encoded).hexdigest()


def _assert_file_sizes(out_dir: Path) -> None:
    too_large = [
        path
        for path in out_dir.rglob("*.json")
        if path.is_file() and path.stat().st_size > MAX_FILE_BYTES
    ]
    if too_large:
        sample = ", ".join(str(path) for path in too_large[:3])
        raise ValueError(f"Static data files exceed {MAX_FILE_BYTES} bytes: {sample}")


def _assert_export_counts(version_dir: Path, manifest: Dict[str, Any]) -> None:
    counted = 0
    for thread in manifest["threads"]:
        thread_count = 0
        for rel_path in thread["posts_meta"]:
            data = _read_json(version_dir / rel_path, default={"items": []})
            thread_count += len(data.get("items") or [])
        if thread_count != thread["total_posts"]:
            raise AssertionError(
                f"Thread {thread['thread_id']} exported {thread_count} posts, "
                f"expected {thread['total_posts']}"
            )
        counted += thread_count
    if counted != manifest["total_posts"]:
        raise AssertionError(f"Exported {counted} posts, expected {manifest['total_posts']}")
