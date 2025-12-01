from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional
import json


@dataclass
class CookieConfig:
    raw_cookie_header: Optional[str] = None


@dataclass
class CrawlerConfig:
    base_url: str
    thread_id: int
    thread_url: str
    posts_per_shard: int
    request_interval_seconds: float
    long_retry_interval_seconds: float
    concurrent_pages: int
    cookies: CookieConfig
    user_agent: str

    @property
    def data_root(self) -> Path:
        # Default data root at repo-level "data" directory
        return Path("data")


def load_config(path: Path) -> CrawlerConfig:
    raw = _load_json(path)
    cookies_raw = raw.get("cookies", {}) or {}
    cookies = CookieConfig(
        raw_cookie_header=cookies_raw.get("raw_cookie_header") or None,
    )
    try:
        cfg = CrawlerConfig(
            base_url=raw["base_url"],
            thread_id=int(raw["thread_id"]),
            thread_url=raw["thread_url"],
            posts_per_shard=int(raw.get("posts_per_shard", 1000)),
            request_interval_seconds=float(raw.get("request_interval_seconds", 2.0)),
            long_retry_interval_seconds=float(raw.get("long_retry_interval_seconds", 600.0)),
            concurrent_pages=int(raw.get("concurrent_pages", 1)),
            cookies=cookies,
            user_agent=raw.get("user_agent", "LiLF95Catch/0.1"),
        )
    except KeyError as exc:
        missing = exc.args[0]
        raise ValueError(f"Missing required config key: {missing}") from exc
    return cfg


def _load_json(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"Config file not found: {path}")
    text = path.read_text(encoding="utf-8")
    return json.loads(text)
