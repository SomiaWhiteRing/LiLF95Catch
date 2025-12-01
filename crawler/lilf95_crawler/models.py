from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class Spoiler:
    title: str
    html: str
    text: str


@dataclass
class Attachment:
    type: str
    remote_url: str
    filename: Optional[str] = None
    thumb_url: Optional[str] = None
    local_path: Optional[Path] = None


@dataclass
class CaptureInfo:
    first_seen_at: datetime
    last_checked_at: datetime


@dataclass
class Post:
    thread_id: int
    post_id: int
    post_index: int
    author_id: int
    author_name: str
    author_avatar_url: Optional[str]
    created_at: datetime
    likes_count: int
    content_html_raw: str
    content_text_full: str
    content_length: int
    spoilers: List[Spoiler] = field(default_factory=list)
    attachments: List[Attachment] = field(default_factory=list)
    capture: Optional[CaptureInfo] = None

    def to_json_dict(self) -> Dict[str, Any]:
        """Convert to a JSON-serialisable dict according to PLAN.md."""
        return {
            "thread_id": self.thread_id,
            "post_id": self.post_id,
            "post_index": self.post_index,
            "author_id": self.author_id,
            "author_name": self.author_name,
            "created_at": self.created_at.isoformat(),
            "likes_count": self.likes_count,
            "content_html_raw": self.content_html_raw,
            "content_text_full": self.content_text_full,
            "content_length": self.content_length,
            "spoilers": [
                {
                    "title": s.title,
                    "html": s.html,
                    "text": s.text,
                }
                for s in self.spoilers
            ],
            "attachments": [
                {
                    "type": a.type,
                    "remote_url": a.remote_url,
                    "filename": a.filename,
                    "thumb_url": a.thumb_url,
                    "local_path": str(a.local_path) if a.local_path is not None else None,
                }
                for a in self.attachments
            ],
            "capture": {
                "first_seen_at": self.capture.first_seen_at.isoformat(),
                "last_checked_at": self.capture.last_checked_at.isoformat(),
            }
            if self.capture is not None
            else None,
        }


@dataclass
class ShardMetadata:
    thread_id: int
    shard_index: int
    from_post_index: int
    to_post_index: int
    schema_version: int
    generated_at: datetime

    def to_json_dict(self) -> Dict[str, Any]:
        return {
            "thread_id": self.thread_id,
            "shard_index": self.shard_index,
            "range": {
                "from_post_index": self.from_post_index,
                "to_post_index": self.to_post_index,
            },
            "schema_version": self.schema_version,
            "generated_at": self.generated_at.isoformat(),
        }
