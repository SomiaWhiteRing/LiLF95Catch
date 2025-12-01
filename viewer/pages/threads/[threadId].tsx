import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import type { ThreadMeta, Post, PagedPostsResponse, UsersFile } from "../../lib/types";

interface ThreadPageProps {
  initialThreadId: string;
}

interface Filters {
  author: string;
  authorId: string;
  q: string;
  minIndex: string;
  maxIndex: string;
  minLikes: string;
  fromDate: string;
  toDate: string;
  minChars: string;
  maxChars: string;
}

const defaultFilters: Filters = {
  author: "",
  authorId: "",
  q: "",
  minIndex: "",
  maxIndex: "",
  minLikes: "",
  fromDate: "",
  toDate: "",
  minChars: "",
  maxChars: "",
};

export default function ThreadPage({ initialThreadId }: ThreadPageProps) {
  const router = useRouter();
  const threadId = (router.query.threadId as string) || initialThreadId;

  const [meta, setMeta] = useState<ThreadMeta | null>(null);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [posts, setPosts] = useState<Post[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"text" | "html">("html");
  const [autoExpandSpoilers, setAutoExpandSpoilers] = useState(false);
  const [autoExpandQuotes, setAutoExpandQuotes] = useState(true);
  const [avatarMap, setAvatarMap] = useState<Record<number, string>>({});
  const [debouncedFilters, setDebouncedFilters] = useState<Filters>(defaultFilters);
  const [scrollTargetPostId, setScrollTargetPostId] = useState<number | null>(null);
  const [pageInput, setPageInput] = useState<string>("1");
  const [initialisedFromUrl, setInitialisedFromUrl] = useState(false);

  useEffect(() => {
    async function fetchMeta() {
      try {
        const res = await fetch(`/api/threads/${threadId}/meta`);
        if (res.ok) {
          const data: ThreadMeta = await res.json();
          setMeta(data);
        } else {
          setMeta(null);
        }
      } catch {
        setMeta(null);
      }
    }
    if (threadId) {
      fetchMeta();
    }
  }, [threadId]);

  useEffect(() => {
    if (!router.isReady || initialisedFromUrl) return;
    const q = router.query;
    const nextFilters: Filters = { ...defaultFilters };

    if (typeof q.author === "string") nextFilters.author = q.author;
    if (typeof q.authorId === "string") nextFilters.authorId = q.authorId;
    if (typeof q.q === "string") nextFilters.q = q.q;
    if (typeof q.minIndex === "string") nextFilters.minIndex = q.minIndex;
    if (typeof q.maxIndex === "string") nextFilters.maxIndex = q.maxIndex;
    if (typeof q.minLikes === "string") nextFilters.minLikes = q.minLikes;
    if (typeof q.fromDate === "string") nextFilters.fromDate = q.fromDate;
    if (typeof q.toDate === "string") nextFilters.toDate = q.toDate;
    if (typeof q.minChars === "string") nextFilters.minChars = q.minChars;
    if (typeof q.maxChars === "string") nextFilters.maxChars = q.maxChars;

    let nextPage = 1;
    if (typeof q.page === "string") {
      const p = parseInt(q.page, 10);
      if (!Number.isNaN(p) && p > 0) nextPage = p;
    }

    let nextPageSize = 50;
    if (typeof q.pageSize === "string") {
      const ps = parseInt(q.pageSize, 10);
      if (!Number.isNaN(ps) && ps > 0) nextPageSize = Math.min(200, ps);
    }

    setFilters(nextFilters);
    setDebouncedFilters(nextFilters);
    setPage(nextPage);
    setPageSize(nextPageSize);
    setPageInput(String(nextPage));
    setInitialisedFromUrl(true);
  }, [router.isReady, router.query, initialisedFromUrl]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedFilters(filters);
      setPage(1);
      setPageInput("1");
    }, 400);
    return () => window.clearTimeout(handle);
  }, [filters]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    if (debouncedFilters.author) params.set("author", debouncedFilters.author);
    if (debouncedFilters.authorId) params.set("authorId", debouncedFilters.authorId);
    if (debouncedFilters.q) params.set("q", debouncedFilters.q);
    if (debouncedFilters.minIndex) params.set("minIndex", debouncedFilters.minIndex);
    if (debouncedFilters.maxIndex) params.set("maxIndex", debouncedFilters.maxIndex);
    if (debouncedFilters.minLikes) params.set("minLikes", debouncedFilters.minLikes);
    if (debouncedFilters.fromDate) params.set("fromDate", debouncedFilters.fromDate);
    if (debouncedFilters.toDate) params.set("toDate", debouncedFilters.toDate);
    if (debouncedFilters.minChars) params.set("minChars", debouncedFilters.minChars);
    if (debouncedFilters.maxChars) params.set("maxChars", debouncedFilters.maxChars);
    return params.toString();
  }, [debouncedFilters, page, pageSize]);

  useEffect(() => {
    async function fetchPosts() {
      if (!threadId) return;
      setLoading(true);
      try {
        const res = await fetch(`/api/threads/${threadId}/posts?${queryString}`);
        if (!res.ok) {
          setPosts([]);
          setTotal(0);
          return;
        }
        const data: PagedPostsResponse = await res.json();
        setPosts(data.items);
        setTotal(data.total);
      } catch {
        setPosts([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    }
    fetchPosts();
  }, [threadId, queryString]);

  useEffect(() => {
    if (!router.isReady) return;
    const query: Record<string, string> = {
      threadId: threadId,
      page: String(page),
      pageSize: String(pageSize),
    };

    const f = debouncedFilters;
    if (f.author) query.author = f.author;
    if (f.authorId) query.authorId = f.authorId;
    if (f.q) query.q = f.q;
    if (f.minIndex) query.minIndex = f.minIndex;
    if (f.maxIndex) query.maxIndex = f.maxIndex;
    if (f.minLikes) query.minLikes = f.minLikes;
    if (f.fromDate) query.fromDate = f.fromDate;
    if (f.toDate) query.toDate = f.toDate;
    if (f.minChars) query.minChars = f.minChars;
    if (f.maxChars) query.maxChars = f.maxChars;

    router.replace(
      { pathname: router.pathname, query },
      undefined,
      { shallow: true },
    );
  }, [router, threadId, debouncedFilters, page, pageSize]);

  useEffect(() => {
    async function fetchUsers() {
      try {
        const res = await fetch("/api/users");
        if (!res.ok) return;
        const data: UsersFile = await res.json();
        const map: Record<number, string> = {};
        for (const key of Object.keys(data.users)) {
          const u = data.users[key];
          if (u && typeof u.user_id === "number" && u.avatar_local_path) {
            map[u.user_id] = `/api/users/${u.user_id}/avatar`;
          }
        }
        setAvatarMap(map);
      } catch {
        // ignore
      }
    }
    fetchUsers();
  }, []);

  const processedHtmlByPostId = useMemo(() => {
    const map = new Map<number, string>();
    if (viewMode !== "html") {
      return map;
    }

    if (typeof window === "undefined") {
      return map;
    }

    for (const post of posts) {
      if (!post.content_html_raw) continue;
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(post.content_html_raw, "text/html");
        const imgs = Array.from(doc.querySelectorAll("img"));

        // Rewrite bbImage <img> tags to point to local cached attachments if available,
        // otherwise fall back to the remote URL so that images still render.
        imgs.forEach((img) => {
          const src = img.getAttribute("src") || "";
          const dataSrc = img.getAttribute("data-src") || "";
          const alt = img.getAttribute("alt") || "";

          const attachment =
            post.attachments?.find((att) => {
              if (att.type !== "image") {
                return false;
              }
              const remote = att.remote_url || "";
              const thumb = att.thumb_url || "";
              if (
                remote === src ||
                remote === dataSrc ||
                thumb === src ||
                thumb === dataSrc
              ) {
                return true;
              }
              if (alt && att.filename && att.filename === alt) {
                return true;
              }
              return false;
            }) ?? null;

          if (attachment) {
            let finalSrc: string | null = null;
            if (attachment.local_path) {
              finalSrc = `/api/threads/${threadId}/image?path=${encodeURIComponent(
                attachment.local_path,
              )}`;
            } else if (attachment.remote_url) {
              finalSrc = attachment.remote_url;
            } else if (attachment.thumb_url) {
              finalSrc = attachment.thumb_url;
            } else if (dataSrc) {
              finalSrc = dataSrc;
            }

            if (finalSrc) {
              img.setAttribute("src", finalSrc);
              img.removeAttribute("data-src");
              img.classList.remove("lazyload");
            }
          }
        });

        // Transform XenForo spoilers into <details> blocks with summary.
        const spoilers = Array.from(doc.querySelectorAll(".bbCodeSpoiler"));
        spoilers.forEach((spoiler) => {
          const content = spoiler.querySelector(".bbCodeSpoiler-content");
          if (!content) return;
          const titleSpan = spoiler.querySelector(
            ".bbCodeSpoiler-button-title",
          );
          const button = spoiler.querySelector(".bbCodeSpoiler-button");
          const titleText =
            titleSpan?.textContent?.trim() ||
            button?.textContent?.trim() ||
            "Spoiler";

          const details = doc.createElement("details");
          details.className = "bbCodeSpoiler";
          if (autoExpandSpoilers) {
            details.setAttribute("open", "");
          }
          const summary = doc.createElement("summary");
          summary.textContent = titleText;
          details.appendChild(summary);

          const body = content.cloneNode(true) as HTMLElement;
          details.appendChild(body);

          spoiler.replaceWith(details);
        });

        // Transform expandable quote blocks into <details> blocks.
        const expandables = Array.from(
          doc.querySelectorAll(".bbCodeBlock.bbCodeBlock--expandable"),
        );
        expandables.forEach((block) => {
          const titleDiv = block.querySelector(".bbCodeBlock-title");
          const expandContent =
            block.querySelector(".bbCodeBlock-expandContent") ||
            block.querySelector(".bbCodeBlock-content");
          if (!expandContent) return;

          const details = doc.createElement("details");
          details.className = Array.from(block.classList).join(" ");
          if (autoExpandQuotes) {
            details.setAttribute("open", "");
          }

          const summary = doc.createElement("summary");
          summary.innerHTML = titleDiv ? titleDiv.innerHTML : "Quote";
          details.appendChild(summary);

          const body = doc.createElement("div");
          body.innerHTML = expandContent.innerHTML;
          details.appendChild(body);

          block.replaceWith(details);
        });

        const html = doc.body.innerHTML;
        map.set(post.post_id, html);
      } catch {
        map.set(post.post_id, post.content_html_raw);
      }
    }

    return map;
  }, [posts, threadId, viewMode, autoExpandSpoilers, autoExpandQuotes]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize]);

  const handleFilterChange = (field: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [field]: value }));
  };

  const handleApplyFilters = (e: React.FormEvent) => {
    e.preventDefault();
    setDebouncedFilters(filters);
    setPage(1);
    setPageInput("1");
  };

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const handlePageJump = () => {
    const v = parseInt(pageInput, 10);
    if (Number.isNaN(v)) return;
    const target = Math.min(Math.max(1, v), totalPages);
    setPage(target);
  };

  const handleJumpToPost = (post: Post) => {
    const targetPage = Math.max(1, Math.ceil(post.post_index / pageSize));
    setFilters(defaultFilters);
    setDebouncedFilters(defaultFilters);
    setPage(targetPage);
    setScrollTargetPostId(post.post_id);
  };

  useEffect(() => {
    if (scrollTargetPostId == null) return;
    if (typeof window === "undefined") return;
    const el = document.getElementById(`post-${scrollTargetPostId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setScrollTargetPostId(null);
    }
  }, [posts, scrollTargetPostId]);

  const renderPagination = () => (
    <div className="pagination">
      <div>
        Page {page} / {totalPages} · {total} posts
      </div>
      <div>
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={loading || page <= 1}
        >
          Prev
        </button>{" "}
        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={loading || page >= totalPages}
        >
          Next
        </button>{" "}
        <input
          type="number"
          min={1}
          max={totalPages}
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value)}
          style={{ width: "4rem", marginLeft: "0.5rem" }}
        />{" "}
        <button type="button" onClick={handlePageJump} disabled={loading}>
          Go
        </button>
      </div>
    </div>
  );

  return (
    <div className="layout">
      <header className="layout-header">
        <h1>{meta?.title ?? `Thread ${threadId}`}</h1>
        {meta && (
          <p>
            ID {meta.thread_id} · Last page known:{" "}
            {meta.last_page_known ?? "unknown"} · Last checked at:{" "}
            {new Date(meta.last_checked_at).toLocaleString()}
          </p>
        )}
      </header>

      <div style={{ marginBottom: "0.75rem", display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() =>
            setViewMode((m) => (m === "text" ? "html" : "text"))
          }
        >
          View mode: {viewMode === "text" ? "Plain text" : "HTML"}
        </button>
        <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.85rem" }}>
          <input
            type="checkbox"
            checked={autoExpandQuotes}
            onChange={(e) => setAutoExpandQuotes(e.target.checked)}
          />
          Auto-expand quotes
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.85rem" }}>
          <input
            type="checkbox"
            checked={autoExpandSpoilers}
            onChange={(e) => setAutoExpandSpoilers(e.target.checked)}
          />
          Auto-expand spoilers
        </label>
      </div>

      <form className="filters" onSubmit={handleApplyFilters}>
        <div className="field">
          <label htmlFor="author">Author (name contains)</label>
          <input
            id="author"
            value={filters.author}
            onChange={(e) => handleFilterChange("author", e.target.value)}
            placeholder="e.g. Selebus"
          />
        </div>
        <div className="field">
          <label htmlFor="authorId">Author ID</label>
          <input
            id="authorId"
            value={filters.authorId}
            onChange={(e) => handleFilterChange("authorId", e.target.value)}
            placeholder="numeric user id"
          />
        </div>
        <div className="field">
          <label htmlFor="q">Text contains</label>
          <input
            id="q"
            value={filters.q}
            onChange={(e) => handleFilterChange("q", e.target.value)}
            placeholder="keyword in post"
          />
        </div>
        <div className="field">
          <label htmlFor="minIndex">Min floor #</label>
          <input
            id="minIndex"
            value={filters.minIndex}
            onChange={(e) => handleFilterChange("minIndex", e.target.value)}
            placeholder="e.g. 60000"
          />
        </div>
        <div className="field">
          <label htmlFor="maxIndex">Max floor #</label>
          <input
            id="maxIndex"
            value={filters.maxIndex}
            onChange={(e) => handleFilterChange("maxIndex", e.target.value)}
            placeholder="e.g. 61000"
          />
        </div>
        <div className="field">
          <label htmlFor="minLikes">Min likes/reactions</label>
          <input
            id="minLikes"
            value={filters.minLikes}
            onChange={(e) => handleFilterChange("minLikes", e.target.value)}
            placeholder="e.g. 5"
          />
        </div>
        <div className="field">
          <label htmlFor="fromDate">From date</label>
          <input
            id="fromDate"
            type="date"
            value={filters.fromDate}
            onChange={(e) => handleFilterChange("fromDate", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="toDate">To date</label>
          <input
            id="toDate"
            type="date"
            value={filters.toDate}
            onChange={(e) => handleFilterChange("toDate", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="minChars">Min chars</label>
          <input
            id="minChars"
            value={filters.minChars}
            onChange={(e) => handleFilterChange("minChars", e.target.value)}
            placeholder="e.g. 100"
          />
        </div>
        <div className="field">
          <label htmlFor="maxChars">Max chars</label>
          <input
            id="maxChars"
            value={filters.maxChars}
            onChange={(e) => handleFilterChange("maxChars", e.target.value)}
            placeholder="e.g. 2000"
          />
        </div>
        <div className="field">
          <label htmlFor="pageSize">Page size</label>
          <input
            id="pageSize"
            value={pageSize}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!Number.isNaN(v)) {
                setPageSize(Math.min(200, Math.max(1, v)));
                setPage(1);
              }
            }}
          />
        </div>
        <div className="field" style={{ alignSelf: "flex-end" }}>
          <button type="submit" disabled={loading}>
            {loading ? "Loading..." : "Apply filters"}
          </button>
        </div>
      </form>

      {renderPagination()}

      <div className="posts">
        {posts.map((post) => (
          <article key={post.post_id} className="post" id={`post-${post.post_id}`}>
            <div className="post-header">
              <div className="post-header-left">
                <div className="post-avatar">
                  {avatarMap[post.author_id] ? (
                    <img src={avatarMap[post.author_id]} alt={post.author_name} />
                  ) : (
                    <div className="post-avatar-fallback">
                      {post.author_name.charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                <div>
                  <span className="post-author">{post.author_name}</span>{" "}
                  <span className="post-meta">
                    <span
                      style={{ cursor: "pointer" }}
                      onClick={() => handleJumpToPost(post)}
                    >
                      #{post.post_index}
                    </span>{" "}
                    · {new Date(post.created_at).toLocaleString()}
                  </span>
                </div>
              </div>
              <div>
                <span className="badge">likes: {post.likes_count}</span>
              </div>
            </div>
            <div className="post-body">
              {viewMode === "text" ? (
                <pre>{post.content_text_full}</pre>
              ) : (
                <div
                  dangerouslySetInnerHTML={{
                    __html:
                      processedHtmlByPostId.get(post.post_id) ??
                      post.content_html_raw,
                  }}
                />
              )}

              {post.attachments &&
                post.attachments.filter((att) => att.type !== "image")
                  .length > 0 && (
                  <details style={{ marginTop: "0.5rem" }}>
                    <summary>
                      Attachments (
                      {
                        post.attachments.filter(
                          (att) => att.type !== "image",
                        ).length
                      }
                      )
                    </summary>
                    <div style={{ marginTop: "0.35rem" }}>
                      {post.attachments
                        .filter((att) => att.type !== "image")
                        .map((att, idx) => (
                          <div key={idx} style={{ marginTop: "0.25rem" }}>
                            <a
                              href={att.remote_url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {att.filename || att.remote_url}
                            </a>
                          </div>
                        ))}
                    </div>
                  </details>
                )}
            </div>
          </article>
        ))}
        {!loading && posts.length === 0 && (
          <p>No posts match current filters.</p>
        )}
      </div>

      {renderPagination()}
    </div>
  );
}
