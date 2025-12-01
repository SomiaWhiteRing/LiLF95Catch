from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List
from urllib.parse import urlparse

from .config import CrawlerConfig
from .http_client import HttpClient
from .models import Post


logger = logging.getLogger("lilf95_crawler.users")


def _get_users_path(config: CrawlerConfig) -> Path:
    return config.data_root / "users" / "users.json"


def load_users(config: CrawlerConfig) -> Dict[str, Any]:
    path = _get_users_path(config)
    if not path.is_file():
        return {"schema_version": 1, "users": {}}
    try:
        text = path.read_text(encoding="utf-8")
        data = json.loads(text)
        if "schema_version" not in data:
            data["schema_version"] = 1
        if "users" not in data or not isinstance(data["users"], dict):
            data["users"] = {}
        return data
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Failed to read users.json %s: %s; recreating", path, exc)
        return {"schema_version": 1, "users": {}}


def save_users(config: CrawlerConfig, data: Dict[str, Any]) -> None:
    path = _get_users_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def update_users_from_posts(config: CrawlerConfig, posts: Iterable[Post]) -> None:
    """
    Update global users.json using the author information from the given posts.

    Tracks for each user:
    - user_id
    - names: list of {name, first_seen_post_id, last_seen_post_id}
    - first_seen_at / last_seen_at (ISO timestamps)
    """
    posts_list: List[Post] = sorted(
        list(posts),
        key=lambda p: (p.created_at, p.post_id),
    )
    if not posts_list:
        return

    data = load_users(config)
    users: Dict[str, Any] = data.get("users", {})

    for post in posts_list:
        uid_str = str(post.author_id)
        name = post.author_name
        created_iso = post.created_at.isoformat()
        avatar_url = post.author_avatar_url

        record = users.get(uid_str)
        if record is None:
            record = {
                "user_id": post.author_id,
                "names": [
                    {
                        "name": name,
                        "first_seen_post_id": post.post_id,
                        "last_seen_post_id": post.post_id,
                    }
                ],
                "first_seen_at": created_iso,
                "last_seen_at": created_iso,
            }
            if avatar_url:
                record["avatar_url"] = avatar_url
            users[uid_str] = record
        else:
            names: List[Dict[str, Any]] = record.get("names") or []
            if not names:
                names.append(
                    {
                        "name": name,
                        "first_seen_post_id": post.post_id,
                        "last_seen_post_id": post.post_id,
                    }
                )
            else:
                last = names[-1]
                if last.get("name") == name:
                    last["last_seen_post_id"] = post.post_id
                else:
                    names.append(
                        {
                            "name": name,
                            "first_seen_post_id": post.post_id,
                            "last_seen_post_id": post.post_id,
                        }
                    )
            record["names"] = names

            # Update first/last seen timestamps
            first_seen_at = record.get("first_seen_at")
            if not first_seen_at:
                record["first_seen_at"] = created_iso
            else:
                try:
                    if datetime.fromisoformat(created_iso) < datetime.fromisoformat(first_seen_at):
                        record["first_seen_at"] = created_iso
                except Exception:
                    record["first_seen_at"] = created_iso

            record["last_seen_at"] = created_iso

            # Only set avatar_url if we do not have one yet and this post carries one.
            if avatar_url and not record.get("avatar_url"):
                record["avatar_url"] = avatar_url

    data["users"] = users
    save_users(config, data)


def download_user_avatars(config: CrawlerConfig, client: HttpClient) -> None:
    """
    Download avatar images for users that have an avatar_url but no avatar_local_path.

    Avatars are stored under data/users/avatars/{user_id}.{ext} and the relative path
    is written back to users.json as `avatar_local_path`.
    """
    data = load_users(config)
    users: Dict[str, Any] = data.get("users", {})

    avatars_dir = config.data_root / "users" / "avatars"
    avatars_dir.mkdir(parents=True, exist_ok=True)

    changed = False

    for uid_str, record in users.items():
        avatar_url = record.get("avatar_url")
        if not avatar_url:
            continue
        if record.get("avatar_local_path"):
            continue

        try:
            user_id = int(uid_str)
        except ValueError:
            continue

        parsed = urlparse(avatar_url)
        name = parsed.path.split("/")[-1] if parsed.path else ""
        ext = ""
        if "." in name:
            ext = name.split(".")[-1]
        if not ext:
            ext = "jpg"

        target = avatars_dir / f"{user_id}.{ext}"

        if not target.is_file():
            try:
                data_bytes = client.fetch_binary(avatar_url)
                target.write_bytes(data_bytes)
                logger.info("Downloaded avatar for user %s -> %s", uid_str, target)
            except Exception as exc:  # pragma: no cover - network/fs errors
                logger.warning("Failed to download avatar %s: %s", avatar_url, exc)
                continue

        try:
            rel_path = target.relative_to(config.data_root)
        except ValueError:
            rel_path = target

        record["avatar_local_path"] = str(rel_path)
        changed = True

    if changed:
        data["users"] = users
        save_users(config, data)
