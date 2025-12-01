from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable, List, Tuple
from urllib.parse import urlparse

from .config import CrawlerConfig
from .http_client import HttpClient
from .models import Attachment, Post
from .storage import get_thread_dir


logger = logging.getLogger("lilf95_crawler.images")


def download_images_for_posts(
    config: CrawlerConfig,
    client: HttpClient,
    posts: Iterable[Post],
    *,
    overwrite: bool = False,
) -> None:
    """
    Download image attachments for the given posts and update their local_path.

    Images are stored under data/threads/{thread_id}/images/{post_id}/{filename}.
    local_path in the Attachment is set to a path relative to the data root,
    e.g. "threads/48158/images/18745049/image.gif".
    """
    thread_dir = get_thread_dir(config)
    images_root = thread_dir / "images"
    images_root.mkdir(parents=True, exist_ok=True)

    # Collect all download tasks first, so we can run them with a thread pool.
    tasks: List[Tuple[Attachment, str, Path]] = []

    for post in posts:
        for attachment in post.attachments:
            if attachment.type != "image":
                continue
            if attachment.local_path is not None and not overwrite:
                continue

            url = attachment.remote_url or attachment.thumb_url
            if not url:
                continue

            # Skip non-HTTP(S) URLs such as data: URIs; these are typically
            # inline placeholders or tiny tracking pixels and not worth caching.
            if not (url.startswith("http://") or url.startswith("https://")):
                logger.debug("Skipping non-HTTP image URL: %s", url)
                continue

            filename = _choose_filename(attachment, url, post.post_id)
            target_dir = images_root / str(post.post_id)
            target_dir.mkdir(parents=True, exist_ok=True)
            target_path = target_dir / filename

            tasks.append((attachment, url, target_path))

    if not tasks:
        return

    max_workers = max(1, getattr(config, "concurrent_downloads", 4))
    logger.info("Downloading %s images with up to %s workers", len(tasks), max_workers)

    def worker(att: Attachment, url: str, target_path: Path) -> None:
        if target_path.is_file() and not overwrite:
            logger.debug("Image already exists, skipping download: %s", target_path)
        else:
            try:
                data = client.fetch_binary(url)
            except Exception as exc:  # pragma: no cover - network/remote errors
                logger.warning("Failed to download image %s: %s", url, exc)
                return

            try:
                target_path.write_bytes(data)
            except Exception as exc:  # pragma: no cover - filesystem errors
                logger.warning("Failed to write image %s: %s", target_path, exc)
                return

        try:
            rel_path = target_path.relative_to(config.data_root)
        except ValueError:
            rel_path = target_path

        att.local_path = rel_path

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(worker, att, url, path) for att, url, path in tasks]
        for _ in as_completed(futures):
            # We handle logging inside worker; nothing else to do here.
            pass


def _choose_filename(attachment: Attachment, url: str, post_id: int) -> str:
    if attachment.filename:
        return attachment.filename

    parsed = urlparse(url)
    name = Path(parsed.path).name
    if name:
        return name

    return f"post-{post_id}-image.bin"
