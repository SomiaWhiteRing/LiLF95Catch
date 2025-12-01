from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional

from bs4 import BeautifulSoup, Tag

from .post_parser import parse_post_element
from .models import Post


@dataclass
class PageParseResult:
    thread_id: int
    posts: List[Post]
    thread_title: Optional[str]
    has_next_page: bool
    last_page: Optional[int]


def parse_thread_page_html(html: str, base_url: str | None = None) -> PageParseResult:
    """
    Parse a full thread page HTML and extract all posts.

    This expects a XenForo 2 `thread_view` template as seen in F95Zone.
    """
    soup = BeautifulSoup(html, "lxml")

    html_tag = soup.find("html")
    if html_tag is None:
        raise ValueError("No <html> tag found")

    data_content_key = html_tag.get("data-content-key", "")
    # Expected form: "thread-48158"
    thread_id = _extract_thread_id(data_content_key)

    thread_title = _extract_thread_title(soup)
    has_next_page = _detect_has_next_page(soup)
    last_page = _detect_last_page(soup)

    post_articles: Iterable[Tag] = soup.find_all(
        "article", class_="message--post"
    )

    posts: List[Post] = []
    for article in post_articles:
        post = parse_post_element(article, thread_id=thread_id, base_url=base_url)
        posts.append(post)

    return PageParseResult(
        thread_id=thread_id,
        posts=posts,
        thread_title=thread_title,
        has_next_page=has_next_page,
        last_page=last_page,
    )


def _extract_thread_id(data_content_key: str) -> int:
    if data_content_key.startswith("thread-"):
        try:
            return int(data_content_key.split("-", 1)[1])
        except ValueError as exc:
            raise ValueError(f"Invalid data-content-key: {data_content_key}") from exc
    raise ValueError(f"Unexpected data-content-key format: {data_content_key}")


def _extract_thread_title(soup: BeautifulSoup) -> Optional[str]:
    og_title = soup.find("meta", attrs={"property": "og:title"})
    if og_title and og_title.get("content"):
        return og_title["content"].strip()
    title_tag = soup.find("title")
    if title_tag and title_tag.text:
        return title_tag.text.strip()
    return None


def _detect_has_next_page(soup: BeautifulSoup) -> bool:
    nav_wrapper = soup.find("nav", class_="pageNavWrapper")
    if nav_wrapper and nav_wrapper.find("a", class_="pageNav-jump--next"):
        return True
    simple_next = soup.find("a", class_="pageNavSimple-el--next")
    return bool(simple_next)


def _detect_last_page(soup: BeautifulSoup) -> Optional[int]:
    # Try the simple pager first: <a class="pageNavSimple-el--last" href=".../page-3031">
    simple_last = soup.find("a", class_="pageNavSimple-el--last")
    if simple_last and simple_last.get("href"):
        href = simple_last["href"]
        parts = href.rstrip("/").split("-")
        if parts and parts[-1].isdigit():
            return int(parts[-1])

    # Fallback: look for a last page link in the full pager.
    nav_wrapper = soup.find("nav", class_="pageNavWrapper")
    if nav_wrapper:
        last_link = nav_wrapper.select_one("li.pageNav-page--last a")
        if last_link and last_link.get("href"):
            href = last_link["href"]
            parts = href.rstrip("/").split("-")
            if parts and parts[-1].isdigit():
                return int(parts[-1])

    return None
