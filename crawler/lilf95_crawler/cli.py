from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict

from .config import CrawlerConfig, load_config
from .http_client import HttpClient
from .images import download_images_for_posts
from .models import Post, ShardMetadata
from .page_parser import parse_thread_page_html
from .storage import (
    update_shards_for_posts,
    update_thread_meta,
    load_thread_state,
    save_thread_state,
)
from .users import update_users_from_posts, download_user_avatars


logger = logging.getLogger("lilf95_crawler.cli")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="LiLF95Catch crawler utilities",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    parse_local = subparsers.add_parser(
        "parse-local",
        help="Parse a local HTML file (single thread page) and emit a JSON shard",
    )
    parse_local.add_argument(
        "html_path",
        type=Path,
        help="Path to the local HTML file (e.g. f95_page_3030.html)",
    )
    parse_local.add_argument(
        "--output",
        "-o",
        type=Path,
        required=True,
        help="Output JSON file path for the parsed shard",
    )
    parse_local.add_argument(
        "--schema-version",
        type=int,
        default=1,
        help="Schema version to embed in the shard JSON",
    )

    crawl_remote = subparsers.add_parser(
        "crawl-remote",
        help="Fetch remote thread pages and update shard JSONs (per 1000 floors)",
    )
    crawl_remote.add_argument(
        "--config",
        type=Path,
        default=Path("crawler/config/config.json"),
        help="Path to crawler config JSON (default: crawler/config/config.json)",
    )
    crawl_remote.add_argument(
        "--from-page",
        type=int,
        default=None,
        help="First page number to fetch (1-based). Defaults to 1 when omitted.",
    )
    crawl_remote.add_argument(
        "--to-page",
        type=int,
        default=None,
        help="Last page number to fetch (inclusive). Defaults to last page when omitted.",
    )
    crawl_remote.add_argument(
        "--schema-version",
        type=int,
        default=1,
        help="Schema version to embed in shard JSONs",
    )

    crawl_incr = subparsers.add_parser(
        "crawl-incremental",
        help="Incrementally crawl from last known page to the current last page.",
    )
    crawl_incr.add_argument(
        "--config",
        type=Path,
        default=Path("crawler/config/config.json"),
        help="Path to crawler config JSON (default: crawler/config/config.json)",
    )
    crawl_incr.add_argument(
        "--schema-version",
        type=int,
        default=1,
        help="Schema version to embed in shard JSONs",
    )
    crawl_incr.add_argument(
        "--max-pages",
        type=int,
        default=None,
        help="Optional maximum number of pages to crawl in one run",
    )

    args = parser.parse_args()

    # Configure logging: console + per-run logfile with timestamped filename.
    log_dir = Path("logs")
    log_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = log_dir / f"crawl_{timestamp}.log"

    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    root_logger.handlers.clear()

    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    )

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    root_logger.addHandler(console_handler)

    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setFormatter(formatter)
    root_logger.addHandler(file_handler)

    logger.info("Logging to %s", log_file)

    if args.command == "parse-local":
        _cmd_parse_local(
            html_path=args.html_path,
            output_path=args.output,
            schema_version=args.schema_version,
        )
    elif args.command == "crawl-remote":
        _cmd_crawl_remote(
            config_path=args.config,
            from_page=args.from_page,
            to_page=args.to_page,
            schema_version=args.schema_version,
        )
    elif args.command == "crawl-incremental":
        _cmd_crawl_incremental(
            config_path=args.config,
            schema_version=args.schema_version,
            max_pages=args.max_pages,
        )
    else:
        parser.error(f"Unknown command: {args.command}")


def _cmd_parse_local(html_path: Path, output_path: Path, schema_version: int) -> None:
    if not html_path.is_file():
        raise SystemExit(f"HTML file not found: {html_path}")

    logger.info("Reading HTML from %s", html_path)
    html = html_path.read_text(encoding="utf-8", errors="ignore")

    logger.info("Parsing thread page HTML")
    page_result = parse_thread_page_html(html, base_url=None)

    if not page_result.posts:
        logger.warning("No posts parsed from the page")

    logger.info("Parsed %d posts for thread %d", len(page_result.posts), page_result.thread_id)

    # Build a minimal shard containing just this page's posts.
    posts_sorted = sorted(page_result.posts, key=lambda p: p.post_index)

    if posts_sorted:
        from_post_index = posts_sorted[0].post_index
        to_post_index = posts_sorted[-1].post_index
    else:
        from_post_index = 0
        to_post_index = 0

    # For now, shard_index is 0 when parsing a single page.
    shard_meta = ShardMetadata(
        thread_id=page_result.thread_id,
        shard_index=0,
        from_post_index=from_post_index,
        to_post_index=to_post_index,
        schema_version=schema_version,
        generated_at=datetime.now(timezone.utc),
    )

    shard_dict: Dict[str, Any] = shard_meta.to_json_dict()
    shard_dict["posts"] = [p.to_json_dict() for p in posts_sorted]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    logger.info("Writing shard JSON to %s", output_path)
    output_path.write_text(json.dumps(shard_dict, ensure_ascii=False, indent=2), encoding="utf-8")


def _cmd_crawl_remote(
    config_path: Path,
    from_page: int | None,
    to_page: int | None,
    schema_version: int,
) -> None:
    config = load_config(config_path)
    client = HttpClient(config)

    # If either bound is missing, detect the overall last page from page 1.
    if from_page is None or to_page is None:
        logger.info("Range not fully specified, probing first page to detect bounds")
        html0 = client.fetch_thread_page_html(1)
        first_result = parse_thread_page_html(html0, base_url=config.base_url)
        last_page_overall = first_result.last_page or 1
        if from_page is None:
            from_page = 1
        if to_page is None:
            to_page = last_page_overall

    assert from_page is not None and to_page is not None

    if from_page <= 0 or to_page < from_page:
        raise SystemExit("Invalid page range")

    logger.info(
        "Crawling remote thread %s pages %s-%s",
        config.thread_id,
        from_page,
        to_page,
    )

    first_page_title: str | None = None
    total_posts = 0
    last_post_index = 0
    last_post_id = 0

    pages = list(range(from_page, to_page + 1))

    def fetch_and_parse(page: int):
        html = client.fetch_thread_page_html(page)
        result = parse_thread_page_html(html, base_url=config.base_url)
        return page, result

    page_results: dict[int, Any] = {}

    max_workers = max(1, config.concurrent_pages)
    logger.info("Using up to %s concurrent page workers", max_workers)

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_page = {executor.submit(fetch_and_parse, p): p for p in pages}
        for future in as_completed(future_to_page):
            page = future_to_page[future]
            try:
                page_num, page_result = future.result()
            except Exception as exc:  # pragma: no cover - defensive
                logger.error("Failed to fetch/parse page %s: %s", page, exc)
                continue

            if page_result.thread_id != config.thread_id:
                logger.warning(
                    "Parsed thread_id %s does not match config.thread_id %s",
                    page_result.thread_id,
                    config.thread_id,
                )

            logger.info("Fetched+parsed page %s -> %s posts", page_num, len(page_result.posts))
            page_results[page_num] = page_result

            if first_page_title is None and page_result.thread_title:
                first_page_title = page_result.thread_title

    if not page_results:
        logger.warning("No pages fetched from remote range")
        return

    for page in sorted(page_results.keys()):
        page_result = page_results[page]
        posts = page_result.posts

        if not posts:
            update_thread_meta(config, thread_title=first_page_title, last_page_known=page)
            continue

        download_images_for_posts(config=config, client=client, posts=posts)
        update_users_from_posts(config=config, posts=posts)
        download_user_avatars(config=config, client=client)
        update_shards_for_posts(config=config, schema_version=schema_version, posts=posts)

        total_posts += len(posts)
        last_post = max(posts, key=lambda p: (p.post_index, p.post_id))
        last_post_index = last_post.post_index
        last_post_id = last_post.post_id

        state = {
            "last_page_crawled": page,
            "last_post_index": last_post_index,
            "last_post_id": last_post_id,
            "schema_version": schema_version,
        }
        save_thread_state(config, state)
        update_thread_meta(config, thread_title=first_page_title, last_page_known=page)

    logger.info(
        "Remote crawl updated shard JSONs for %d posts across pages %s-%s",
        total_posts,
        from_page,
        to_page,
    )


def _cmd_crawl_incremental(
    config_path: Path,
    schema_version: int,
    max_pages: int | None,
) -> None:
    config = load_config(config_path)
    client = HttpClient(config)

    state = load_thread_state(config)
    last_page_crawled = int(state.get("last_page_crawled", 0) or 0)
    # Start from last_page_crawled (re-scan it) or from 1 if no state
    current_page = max(1, last_page_crawled) if last_page_crawled > 0 else 1

    logger.info(
        "Incremental crawl for thread %s starting from page %s",
        config.thread_id,
        current_page,
    )

    pages_crawled = 0
    first_page_title: str | None = None
    total_posts = 0

    while True:
        html = client.fetch_thread_page_html(current_page)
        page_result = parse_thread_page_html(html, base_url=config.base_url)

        if page_result.thread_id != config.thread_id:
            logger.warning(
                "Parsed thread_id %s does not match config.thread_id %s",
                page_result.thread_id,
                config.thread_id,
            )

        posts = page_result.posts
        logger.info("Page %s -> %s posts", current_page, len(posts))

        if first_page_title is None and page_result.thread_title:
            first_page_title = page_result.thread_title

        if posts:
            download_images_for_posts(config=config, client=client, posts=posts)
            update_users_from_posts(config=config, posts=posts)
            download_user_avatars(config=config, client=client)
            update_shards_for_posts(config=config, schema_version=schema_version, posts=posts)

            total_posts += len(posts)
            last_post = max(posts, key=lambda p: (p.post_index, p.post_id))
            new_state = {
                "last_page_crawled": current_page,
                "last_post_index": last_post.post_index,
                "last_post_id": last_post.post_id,
                "schema_version": schema_version,
            }
            save_thread_state(config, new_state)
            update_thread_meta(
                config,
                thread_title=first_page_title,
                last_page_known=current_page,
            )

        pages_crawled += 1

        if max_pages is not None and pages_crawled >= max_pages:
            logger.info("Reached max-pages limit (%s), stopping crawl", max_pages)
            break

        if not page_result.has_next_page:
            logger.info("No further pages detected after page %s", current_page)
            break

        current_page += 1

    if total_posts == 0:
        logger.warning("No posts fetched in incremental crawl")
    else:
        logger.info(
            "Incremental crawl updated shard JSONs for %d posts across %s pages",
            total_posts,
            pages_crawled,
        )


if __name__ == "__main__":  # pragma: no cover
    main()
