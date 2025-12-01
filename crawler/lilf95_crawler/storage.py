from __future__ import annotations

import json
import logging
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .config import CrawlerConfig
from .models import Post, ShardMetadata


logger = logging.getLogger("lilf95_crawler.storage")


def get_thread_dir(config: CrawlerConfig) -> Path:
    return config.data_root / "threads" / str(config.thread_id)


def get_shards_dir(config: CrawlerConfig) -> Path:
    return get_thread_dir(config) / "shards"


def get_meta_path(config: CrawlerConfig) -> Path:
    return get_thread_dir(config) / "meta.json"


def get_state_path(config: CrawlerConfig) -> Path:
    return get_thread_dir(config) / "state.json"


def load_thread_state(config: CrawlerConfig) -> Dict[str, Any]:
    path = get_state_path(config)
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Failed to read thread state %s: %s; treating as empty", path, exc)
        return {}


def save_thread_state(config: CrawlerConfig, state: Dict[str, Any]) -> None:
    path = get_state_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def update_thread_meta(
    config: CrawlerConfig,
    *,
    thread_title: Optional[str],
    last_page_known: Optional[int] = None,
) -> None:
    """
    Create or update meta.json for this thread.
    """
    path = get_meta_path(config)
    now = datetime.now(timezone.utc).isoformat()

    if path.is_file():
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Failed to read meta %s: %s; recreating", path, exc)
            meta = {}
    else:
        meta = {}

    if "thread_id" not in meta:
        meta["thread_id"] = config.thread_id
    if "thread_url" not in meta:
        meta["thread_url"] = config.thread_url
    if "schema_version" not in meta:
        meta["schema_version"] = 1
    if "created_at" not in meta:
        meta["created_at"] = now

    if thread_title:
        meta["title"] = thread_title
    if last_page_known is not None:
        meta["last_page_known"] = last_page_known

    meta["last_checked_at"] = now

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _shard_index_for_post(post_index: int, posts_per_shard: int) -> int:
    if post_index <= 0:
        return 0
    return (post_index - 1) // posts_per_shard


def _shard_filename(thread_id: int, shard_index: int, posts_per_shard: int, schema_version: int) -> str:
    start = shard_index * posts_per_shard + 1
    end = (shard_index + 1) * posts_per_shard
    return f"{thread_id}_{start:06d}-{end:06d}_v{schema_version}.json"


def update_shards_for_posts(
    config: CrawlerConfig,
    schema_version: int,
    posts: Iterable[Post],
) -> None:
    """
    Merge the given posts into per-1000-floor shard JSON files.

    Existing shard files are updated in-place; posts are keyed by post_id.
    """
    posts_by_shard: Dict[int, List[Post]] = {}
    for post in posts:
        shard_index = _shard_index_for_post(post.post_index, config.posts_per_shard)
        posts_by_shard.setdefault(shard_index, []).append(post)

    shards_dir = get_shards_dir(config)
    shards_dir.mkdir(parents=True, exist_ok=True)

    for shard_index, shard_posts in posts_by_shard.items():
        filename = _shard_filename(
            thread_id=config.thread_id,
            shard_index=shard_index,
            posts_per_shard=config.posts_per_shard,
            schema_version=schema_version,
        )
        path = shards_dir / filename
        _merge_into_shard_file(
            path=path,
            thread_id=config.thread_id,
            shard_index=shard_index,
            schema_version=schema_version,
            posts_per_shard=config.posts_per_shard,
            new_posts=list(shard_posts),
        )


def _merge_into_shard_file(
    path: Path,
    thread_id: int,
    shard_index: int,
    schema_version: int,
    posts_per_shard: int,
    new_posts: List[Post],
) -> None:
    existing: Dict[str, Any]
    if path.is_file():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Failed to read existing shard %s: %s; recreating", path, exc)
            existing = {}
    else:
        existing = {}

    posts_list: List[Dict[str, Any]] = existing.get("posts") or []
    posts_by_id: Dict[int, Dict[str, Any]] = {}
    for p in posts_list:
        try:
            posts_by_id[int(p["post_id"])] = p
        except (KeyError, ValueError):
            continue

    for post in new_posts:
        posts_by_id[post.post_id] = post.to_json_dict()

    merged_posts = sorted(
        posts_by_id.values(),
        key=lambda p: (int(p.get("post_index", 0)), int(p.get("post_id", 0))),
    )

    if merged_posts:
        from_post_index = int(merged_posts[0].get("post_index", 0))
        to_post_index = int(merged_posts[-1].get("post_index", 0))
    else:
        start = shard_index * posts_per_shard + 1
        end = (shard_index + 1) * posts_per_shard
        from_post_index = start
        to_post_index = end

    meta = ShardMetadata(
        thread_id=thread_id,
        shard_index=shard_index,
        from_post_index=from_post_index,
        to_post_index=to_post_index,
        schema_version=schema_version,
        generated_at=datetime.now(timezone.utc),
    )

    shard_dict: Dict[str, Any] = meta.to_json_dict()
    shard_dict["posts"] = merged_posts

    path.write_text(json.dumps(shard_dict, ensure_ascii=False, indent=2), encoding="utf-8")
