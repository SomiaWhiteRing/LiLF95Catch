from __future__ import annotations

import logging
import time
from typing import Optional

import requests

from .config import CrawlerConfig


logger = logging.getLogger("lilf95_crawler.http_client")


class HttpClient:
    def __init__(self, config: CrawlerConfig) -> None:
        self._config = config
        self._session = requests.Session()
        self._session.headers.update(
            {
                "User-Agent": self._config.user_agent,
            }
        )
        if self._config.cookies.raw_cookie_header:
            # Use a raw Cookie header as provided by the user.
            self._session.headers["Cookie"] = self._config.cookies.raw_cookie_header

    def _request_with_retries(
        self,
        method: str,
        url: str,
        *,
        timeout: int,
        stream: bool = False,
        max_retries: int = 3,
    ) -> requests.Response:
        last_exc: Optional[Exception] = None
        for attempt in range(1, max_retries + 1):
            try:
                response = self._session.request(
                    method,
                    url,
                    timeout=timeout,
                    stream=stream,
                )
                response.raise_for_status()
                return response
            except (requests.RequestException, OSError) as exc:  # pragma: no cover - network
                last_exc = exc
                logger.warning(
                    "HTTP %s failed for %s (attempt %s/%s): %s",
                    method,
                    url,
                    attempt,
                    max_retries,
                    exc,
                )
                if attempt < max_retries:
                    time.sleep(self._config.request_interval_seconds or 1.0)
        assert last_exc is not None
        raise last_exc

    def fetch_thread_page_html(self, page: int, *, delay: bool = True) -> str:
        """
        Fetch a single thread page HTML.

        Page 1 uses the bare thread_url; subsequent pages append `/page-{n}`.
        """
        if page <= 1:
            url = self._config.thread_url
        else:
            url = f"{self._config.thread_url}/page-{page}"

        while True:
            logger.info("Fetching page %s: %s", page, url)
            try:
                response = self._request_with_retries("GET", url, timeout=30, stream=False)
            except (requests.RequestException, OSError) as exc:  # pragma: no cover - network
                logger.warning(
                    "Failed to fetch page %s after retries, sleeping %.0fs before retrying: %s",
                    page,
                    self._config.long_retry_interval_seconds,
                    exc,
                )
                time.sleep(self._config.long_retry_interval_seconds)
                continue

            if delay and self._config.request_interval_seconds > 0:
                time.sleep(self._config.request_interval_seconds)

            return response.text

    def fetch_binary(self, url: str, *, delay: bool = False) -> bytes:
        """
        Fetch binary content from the given URL.

        This reuses the same session (and cookies) as HTML fetches.
        """
        logger.info("Fetching binary content: %s", url)
        response = self._request_with_retries("GET", url, timeout=60, stream=True)
        content = response.content

        if delay and self._config.request_interval_seconds > 0:
            time.sleep(self._config.request_interval_seconds)

        return content
