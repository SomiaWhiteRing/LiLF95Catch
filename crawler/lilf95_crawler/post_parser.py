from __future__ import annotations

from datetime import datetime, timezone
import re
from typing import List, Optional, Tuple

from bs4 import BeautifulSoup, NavigableString, Tag

from .models import Attachment, Post, Spoiler


def parse_post_element(article: Tag, thread_id: int, base_url: Optional[str] = None) -> Post:
    """
    Parse a single `article.message--post` element into a Post model.

    This follows the real DOM structure observed in f95_page_3030.html.
    """
    post_id = _extract_post_id(article)
    post_index = _extract_post_index(article)
    author_id, author_name = _extract_author(article)
    author_avatar_url = _extract_avatar_url(article, base_url=base_url)
    created_at = _extract_created_at(article)
    likes_count = _extract_likes_count(article)

    bb_wrapper = _find_bb_wrapper(article)
    content_html_raw = bb_wrapper.decode_contents()
    content_text_full = _extract_text_from_bbwrapper(bb_wrapper)
    content_length = len(content_text_full)
    spoilers = _extract_spoilers(bb_wrapper)
    attachments = _extract_attachments(bb_wrapper)

    # Capture timestamps default to created_at for now; will be updated on re-scan.
    capture_time = datetime.now(timezone.utc)

    return Post(
        thread_id=thread_id,
        post_id=post_id,
        post_index=post_index,
        author_id=author_id,
        author_name=author_name,
        author_avatar_url=author_avatar_url,
        created_at=created_at,
        likes_count=likes_count,
        content_html_raw=content_html_raw,
        content_text_full=content_text_full,
        content_length=content_length,
        spoilers=spoilers,
        attachments=attachments,
        capture=None,  # capture info can be filled by caller when writing to disk
    )


def _extract_post_id(article: Tag) -> int:
    data_content = article.get("data-content", "")
    # Expected: "post-18745049"
    if data_content.startswith("post-"):
        return int(data_content.split("-", 1)[1])
    # Fallback: look for span id="post-..."
    anchor = article.find("span", id=lambda v: isinstance(v, str) and v.startswith("post-"))
    if anchor and anchor.get("id", "").startswith("post-"):
        return int(anchor["id"].split("-", 1)[1])
    raise ValueError("Unable to determine post_id from article element")


def _extract_post_index(article: Tag) -> int:
    # header.message-attribution ul.message-attribution-opposite li a -> "...", one of them "#60,581"
    header = article.find("header", class_="message-attribution")
    if not header:
        raise ValueError("message-attribution header not found")
    opposite = header.find("ul", class_="message-attribution-opposite")
    if not opposite:
        raise ValueError("message-attribution-opposite not found")
    # There may be multiple links (share icon + index link). Prefer one whose text starts with "#".
    candidate_text: Optional[str] = None
    for link in opposite.find_all("a"):
        text = (link.text or "").strip()
        if text.startswith("#"):
            candidate_text = text
            break
    if not candidate_text:
        # Fallback: use last <a> with non-empty text
        links = [l for l in opposite.find_all("a") if (l.text or "").strip()]
        if not links:
            raise ValueError("post index link not found")
        candidate_text = links[-1].text.strip()

    text = candidate_text
    if text.startswith("#"):
        text = text[1:]
    text = text.replace(",", "")
    return int(text)


def _extract_author(article: Tag) -> Tuple[int, str]:
    user_section = article.find("section", class_="message-user")
    if not user_section:
        raise ValueError("message-user section not found")

    # In most cases the username is an <a class="username">, but for some
    # deleted accounts it can be a <span class="username" data-user-id="0">.
    username_el = user_section.find("a", class_="username")
    if username_el is None:
        username_el = user_section.find(class_="username")
    if username_el is None:
        # Fallback: use data-author on the article, with user_id = 0.
        data_author = article.get("data-author") or "Unknown"
        return 0, data_author

    user_id_str = username_el.get("data-user-id") or "0"
    try:
        author_id = int(user_id_str)
    except ValueError:
        author_id = 0
    author_name = username_el.get_text(strip=True)
    return author_id, author_name


def _extract_avatar_url(article: Tag, base_url: Optional[str]) -> Optional[str]:
    """
    Extract the author's avatar URL for this post, if present.

    For normal users this is an <img> inside .message-avatar-wrapper.
    Deleted/default avatars may not have an <img>; in that case we return None.
    """
    user_section = article.find("section", class_="message-user")
    if not user_section:
        return None
    avatar_wrapper = user_section.find("div", class_="message-avatar-wrapper")
    if not avatar_wrapper:
        return None
    img = avatar_wrapper.find("img")
    if not img:
        return None
    src = img.get("src")
    if not src:
        return None

    # If already absolute, return as-is.
    if src.startswith("http://") or src.startswith("https://"):
        return src

    # Construct absolute URL from base_url if available.
    if base_url:
        return base_url.rstrip("/") + src

    return src


def _extract_created_at(article: Tag) -> datetime:
    header = article.find("header", class_="message-attribution")
    if not header:
        raise ValueError("message-attribution header not found")
    time_tag = header.find("time")
    if not time_tag:
        raise ValueError("time tag not found in message-attribution")
    datetime_str = time_tag.get("datetime")
    if not datetime_str:
        raise ValueError("datetime attribute missing on time tag")
    # Example: "2025-11-27T12:42:27+0000"
    # Python fromisoformat does not like "+0000" (needs "+00:00"), so normalise.
    if datetime_str.endswith("+0000"):
        datetime_str = datetime_str[:-5] + "+00:00"
    return datetime.fromisoformat(datetime_str)


def _extract_likes_count(article: Tag) -> int:
    """
    Extract total reactions/likes for a post.

    We prefer to use the textual summary, e.g.:
        "Reactions: tullebukk, InvisibIeWoman, EraAsylum and 1,542 others"
    which implies total = number of listed <bdi> names + "others".
    """
    reactions_bar = article.find("div", class_="reactionsBar")
    if not reactions_bar:
        return 0

    link = reactions_bar.find("a", class_="reactionsBar-link")
    if link:
        text = link.get_text(" ", strip=True)
        # Count explicitly listed names (each inside <bdi>)
        names = link.find_all("bdi")
        names_count = len(names)

        # Look for "1,542 others" pattern
        others_count = 0
        m = re.search(r"(\d[\d,]*)\s+others", text)
        if m:
            try:
                others_count = int(m.group(1).replace(",", ""))
            except ValueError:
                others_count = 0

        total = names_count + others_count
        if total > 0:
            return total

    # Fallback: approximate by number of reaction types shown
    reaction_summary = reactions_bar.find("ul", class_="reactionSummary")
    if not reaction_summary:
        return 0
    items = reaction_summary.find_all("li")
    return len(items)


def _find_bb_wrapper(article: Tag) -> Tag:
    message_content = article.find("div", class_="message-content")
    if not message_content:
        raise ValueError("message-content not found")
    container = message_content.find("div", class_="message-userContent")
    if not container:
        raise ValueError("message-userContent not found inside message-content")
    body = container.find("article", class_="message-body")
    if not body:
        raise ValueError("message-body not found inside message-userContent")
    bb_wrapper = body.find("div", class_="bbWrapper")
    if not bb_wrapper:
        raise ValueError("bbWrapper not found inside message-body")
    return bb_wrapper


def _extract_text_from_bbwrapper(bb_wrapper: Tag) -> str:
    # Use a new soup to leverage get_text with separators
    soup = BeautifulSoup(str(bb_wrapper), "lxml")
    text = soup.get_text(separator="\n", strip=True)
    # Collapse multiple blank lines
    lines = [line for line in (t.strip() for t in text.splitlines()) if line]
    return "\n".join(lines)


def _extract_spoilers(bb_wrapper: Tag) -> List[Spoiler]:
    spoilers: List[Spoiler] = []
    for spoiler_div in bb_wrapper.find_all("div", class_="bbCodeSpoiler"):
        title = ""
        button = spoiler_div.find("button", class_="bbCodeSpoiler-button")
        if button:
            title_span = button.find("span", class_="bbCodeSpoiler-button-title")
            if title_span and title_span.text:
                title = title_span.get_text(strip=True)
        content_block = spoiler_div.find("div", class_="bbCodeBlock--spoiler")
        if not content_block:
            continue
        content_container = content_block.find("div", class_="bbCodeBlock-content")
        if not content_container:
            continue
        html = content_container.decode_contents()
        # Extract plain text from spoiler content only
        text = BeautifulSoup(html, "lxml").get_text(separator="\n", strip=True)
        spoilers.append(Spoiler(title=title, html=html, text=text))
    return spoilers


def _extract_attachments(bb_wrapper: Tag) -> List[Attachment]:
    attachments: List[Attachment] = []

    # Image attachments via <img class="bbImage">, often lazy-loaded with data-src
    # and sometimes wrapped in <a href="https://attachments.f95zone.to/...">.
    for img in bb_wrapper.find_all("img", class_="bbImage"):
        src = img.get("src") or ""
        data_src = img.get("data-src") or ""
        data_url = img.get("data-url") or ""
        filename = img.get("alt") or img.get("title")

        parent_link = img.find_parent("a", href=True)

        def first_http(*candidates: str) -> Optional[str]:
            for value in candidates:
                if not value:
                    continue
                if value.startswith("http://") or value.startswith("https://"):
                    return value
            return None

        remote_url: Optional[str] = None
        if parent_link:
            href = parent_link.get("href") or ""
            if href:
                remote_url = href

        if not remote_url:
            remote_url = first_http(data_src, data_url, src)

        # thumb_url is primarily for matching, prefer an HTTP URL if available.
        thumb_url: Optional[str]
        if src and (src.startswith("http://") or src.startswith("https://")):
            thumb_url = src
        elif data_src:
            thumb_url = data_src
        else:
            thumb_url = src or None

        if not remote_url and not thumb_url:
            continue

        attachments.append(
            Attachment(
                type="image",
                remote_url=remote_url or thumb_url,
                thumb_url=thumb_url,
                filename=filename,
            )
        )

    # Non-image attachments as links to /attachments/{id}/
    for link in bb_wrapper.find_all("a", href=True):
        href = link["href"]
        if "/attachments/" in href and not href.startswith("https://attachments.f95zone.to/"):
            # Likely something like "https://f95zone.to/attachments/5476024/"
            filename = link.get_text(strip=True) or None
            attachments.append(
                Attachment(
                    type="file",
                    remote_url=href,
                    filename=filename,
                )
            )

    return attachments
