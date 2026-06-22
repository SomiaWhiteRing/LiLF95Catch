import { useEffect, useMemo, useRef, useState } from "react";
import fs from "fs";
import path from "path";
import Link from "next/link";
import { useRouter } from "next/router";
import type { GetStaticPaths, GetStaticProps } from "next";
import {
  getInstalledVersion,
  installDataset,
  isDatasetInstalled,
  loadBodies,
  loadManifest,
  loadPostMeta,
  loadThreadMeta,
} from "../../lib/staticData";
import { DEFAULT_LANG, type Lang, text } from "../../lib/i18n";
import type { Post, StaticManifest, StaticPostMeta, StaticThreadEntry, ThreadMeta } from "../../lib/types";

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
  sort: SortMode;
}

type SortMode = "floor_asc" | "floor_desc" | "newest" | "oldest" | "likes" | "length" | "rank";

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
  sort: "floor_asc",
};

type WorkerResponse =
  | { type: "ready" }
  | { type: "result"; requestId: number; total: number; items: Array<StaticPostMeta & { rank?: number }> }
  | { type: "error"; requestId?: number; error: string };

export const getStaticPaths: GetStaticPaths = async () => {
  try {
    const manifestPath = path.join(process.cwd(), "public", "datasets", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as StaticManifest;
    return {
      paths: manifest.threads.map((thread) => ({ params: { threadId: String(thread.thread_id) } })),
      fallback: false,
    };
  } catch {
    return { paths: [], fallback: false };
  }
};

export const getStaticProps: GetStaticProps = () => ({ props: {} });

export default function ThreadPage() {
  const router = useRouter();
  const threadId = (router.query.threadId as string) || "";
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const paramsLoadedRef = useRef(false);

  const [lang, setLang] = useState<Lang>(DEFAULT_LANG);
  const t = text[lang];
  const [manifest, setManifest] = useState<StaticManifest | null>(null);
  const [thread, setThread] = useState<StaticThreadEntry | null>(null);
  const [meta, setMeta] = useState<ThreadMeta | null>(null);
  const [workerReady, setWorkerReady] = useState(false);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [appliedFilters, setAppliedFilters] = useState<Filters | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [pageInput, setPageInput] = useState("1");
  const [posts, setPosts] = useState<Post[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"text" | "html">("text");
  const [autoExpandSpoilers, setAutoExpandSpoilers] = useState(false);
  const [autoExpandQuotes, setAutoExpandQuotes] = useState(true);
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [initializingCache, setInitializingCache] = useState(false);
  const [showMoreFilters, setShowMoreFilters] = useState(false);

  useEffect(() => {
    if (!router.isReady || paramsLoadedRef.current) return;
    paramsLoadedRef.current = true;
    const nextFilters = filtersFromQuery(router.query);
    const nextPageSize = clampInt(queryValue(router.query.pageSize), 25, 1, 200);
    const nextPage = clampInt(queryValue(router.query.page), 1, 1, Number.MAX_SAFE_INTEGER);
    setFilters(nextFilters);
    setPageSize(nextPageSize);
    setPage(nextPage);
    setPageInput(String(nextPage));
    setShowMoreFilters(hasSecondaryFilters(router.query));
    if (hasSearchParams(router.query)) {
      setAppliedFilters(nextFilters);
      setHasSearched(true);
    }
  }, [router.isReady, router.query]);

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setWorkerReady(false);

    async function init() {
      try {
        const nextManifest = await loadManifest();
        const nextThread = nextManifest.threads.find((item) => String(item.thread_id) === threadId);
        if (!nextThread) throw new Error(t.threadNotFound);
        const nextInstalled = await getInstalledVersion();
        if (cancelled) return;
        setManifest(nextManifest);
        setThread(nextThread);
        setInstalledVersion(nextInstalled);
        setLoading(false);

        if (isDatasetInstalled(nextManifest, nextInstalled)) {
          await initializeFromCache(nextManifest, nextThread);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [threadId, t.threadNotFound]);

  const initializeFromCache = async (nextManifest: StaticManifest, nextThread: StaticThreadEntry) => {
    setInitializingCache(true);
    setError(null);
    setWorkerReady(false);
    let nextMeta: ThreadMeta;
    let nextPostsMeta: StaticPostMeta[];
    try {
      [nextMeta, nextPostsMeta] = await Promise.all([
        loadThreadMeta(nextManifest, nextThread, true),
        loadPostMeta(nextManifest, nextThread, true),
      ]);
    } catch {
      setInstalledVersion(null);
      setInitializingCache(false);
      return;
    }
    workerRef.current?.terminate();
    const worker = new Worker(new URL("../../lib/searchWorker.ts", import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        setWorkerReady(true);
        setInitializingCache(false);
        return;
      }
      if (message.type === "error") {
        setLoading(false);
        setInitializingCache(false);
        setError(message.error);
        return;
      }
      if (message.type === "result" && message.requestId === requestIdRef.current) {
        void hydratePosts(nextManifest, message.items)
          .then((hydrated) => {
            setPosts(hydrated);
            setTotal(message.total);
            setLoading(false);
          })
          .catch((err) => {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
          });
      }
    };
    worker.postMessage({ type: "init", manifest: nextManifest, thread: nextThread, posts: nextPostsMeta });
    setMeta(nextMeta);
  };

  useEffect(() => () => workerRef.current?.terminate(), []);

  useEffect(() => {
    if (!workerReady || !workerRef.current || !appliedFilters) return;
    setLoading(true);
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    workerRef.current.postMessage({ type: "query", requestId, filters: appliedFilters, page, pageSize });
  }, [workerReady, appliedFilters, page, pageSize]);

  useEffect(() => setPageInput(String(page)), [page]);

  useEffect(() => {
    if (!router.isReady || !appliedFilters) return;
    void router.replace(
      { pathname: router.pathname, query: queryFromState(threadId, appliedFilters, page, pageSize) },
      undefined,
      { shallow: true, scroll: false },
    );
  }, [router, threadId, appliedFilters, page, pageSize]);

  const processedHtmlByPostId = useMemo(() => {
    const map = new Map<number, string>();
    if (viewMode !== "html" || typeof window === "undefined") return map;
    for (const post of posts) {
      if (!post.content_html_raw) continue;
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(post.content_html_raw, "text/html");
        doc.querySelectorAll("img").forEach((img) => {
          const dataSrc = img.getAttribute("data-src");
          if (!img.getAttribute("src") && dataSrc) img.setAttribute("src", dataSrc);
          img.removeAttribute("data-src");
          img.classList.remove("lazyload");
        });
        doc.querySelectorAll(".bbCodeSpoiler").forEach((spoiler) => {
          const content = spoiler.querySelector(".bbCodeSpoiler-content");
          if (!content) return;
          const title = spoiler.querySelector(".bbCodeSpoiler-button-title")?.textContent?.trim() || "Spoiler";
          const details = doc.createElement("details");
          details.className = "bbCodeSpoiler";
          if (autoExpandSpoilers) details.setAttribute("open", "");
          const summary = doc.createElement("summary");
          summary.textContent = title;
          details.appendChild(summary);
          details.appendChild(content.cloneNode(true));
          spoiler.replaceWith(details);
        });
        doc.querySelectorAll(".bbCodeBlock.bbCodeBlock--expandable").forEach((block) => {
          const content = block.querySelector(".bbCodeBlock-expandContent") || block.querySelector(".bbCodeBlock-content");
          if (!content) return;
          const details = doc.createElement("details");
          details.className = Array.from(block.classList).join(" ");
          if (autoExpandQuotes) details.setAttribute("open", "");
          const summary = doc.createElement("summary");
          summary.innerHTML = block.querySelector(".bbCodeBlock-title")?.innerHTML || "Quote";
          details.appendChild(summary);
          const body = doc.createElement("div");
          body.innerHTML = content.innerHTML;
          details.appendChild(body);
          block.replaceWith(details);
        });
        map.set(post.post_id, doc.body.innerHTML);
      } catch {
        map.set(post.post_id, post.content_html_raw);
      }
    }
    return map;
  }, [posts, viewMode, autoExpandSpoilers, autoExpandQuotes]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize]);
  const cached = !!manifest && isDatasetInstalled(manifest, installedVersion);
  const generated = manifest ? new Date(manifest.generated_at).toLocaleString(lang === "zh" ? "zh-CN" : "en-US") : "...";

  const runSearch = () => {
    if (!cached) return;
    setHasSearched(true);
    setAppliedFilters({ ...filters });
    setPage(1);
  };

  const clearFilters = () => {
    setFilters(defaultFilters);
    setAppliedFilters(null);
    setHasSearched(false);
    setPosts([]);
    setTotal(0);
    setPage(1);
    if (router.isReady) {
      void router.replace(
        { pathname: router.pathname, query: { threadId } },
        undefined,
        { shallow: true, scroll: false },
      );
    }
  };

  const handleInstall = async () => {
    if (!manifest || !thread) return;
    setInstallProgress("0%");
    try {
      await installDataset(manifest, thread, (done, totalItems) => setInstallProgress(`${done}/${totalItems}`));
      setInstalledVersion(manifest.version);
      setInstallProgress(null);
      await initializeFromCache(manifest, thread);
    } catch (err) {
      setInstallProgress(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePageJump = () => {
    const value = parseInt(pageInput, 10);
    if (!Number.isNaN(value)) setPage(Math.min(Math.max(1, value), totalPages));
  };

  return (
    <main className="md-app">
      <header className="md-top-app-bar">
        <Link className="md-icon-button" href="/" aria-label="Home">‹</Link>
        <div className="md-title-block">
          <div className="md-overline">Lessons in Love</div>
          <h1>{meta?.title ?? thread?.title ?? `Thread ${threadId}`}</h1>
        </div>
        <LanguageSwitch lang={lang} setLang={setLang} />
      </header>

      {error && <div className="md-banner error"><strong>{t.error}</strong><span>{error}</span></div>}

      <section className="md-thread-shell">
        <aside className="md-card md-filter-card">
          <div className="md-card-title">
            <h2>{t.searchPanel}</h2>
            <p>{t.searchHint}</p>
          </div>
          <div className="md-search-primary">
            <TextField label={t.query} value={filters.q} onChange={(value) => setFilters((prev) => ({ ...prev, q: value }))} />
          </div>
          <div className="md-form-grid">
            <TextField label={t.author} value={filters.author} onChange={(value) => setFilters((prev) => ({ ...prev, author: value }))} />
            <TextField label={t.minFloor} value={filters.minIndex} onChange={(value) => setFilters((prev) => ({ ...prev, minIndex: value }))} />
            <TextField label={t.maxFloor} value={filters.maxIndex} onChange={(value) => setFilters((prev) => ({ ...prev, maxIndex: value }))} />
            <TextField label={t.minLikes} value={filters.minLikes} onChange={(value) => setFilters((prev) => ({ ...prev, minLikes: value }))} />
            <SelectField label={t.sort} value={filters.sort} onChange={(value) => setFilters((prev) => ({ ...prev, sort: value as SortMode }))} options={[
              ["floor_asc", t.sortFloorAsc],
              ["floor_desc", t.sortFloorDesc],
              ["newest", t.sortNewest],
              ["oldest", t.sortOldest],
              ["likes", t.sortLikes],
              ["length", t.sortLength],
              ["rank", t.sortRank],
            ]} />
          </div>
          <button className="md-button md-button-text md-more-filters" type="button" onClick={() => setShowMoreFilters((value) => !value)}>
            {showMoreFilters ? t.lessFilters : t.moreFilters}
          </button>
          {showMoreFilters && (
            <div className="md-form-grid md-secondary-filters">
              <TextField label={t.authorId} value={filters.authorId} onChange={(value) => setFilters((prev) => ({ ...prev, authorId: value }))} />
              <TextField label={t.pageSize} value={String(pageSize)} onChange={(value) => {
                const next = parseInt(value, 10);
                if (!Number.isNaN(next)) setPageSize(Math.min(200, Math.max(1, next)));
              }} />
            <TextField type="date" label={t.fromDate} value={filters.fromDate} onChange={(value) => setFilters((prev) => ({ ...prev, fromDate: value }))} />
            <TextField type="date" label={t.toDate} value={filters.toDate} onChange={(value) => setFilters((prev) => ({ ...prev, toDate: value }))} />
            <TextField label={t.minChars} value={filters.minChars} onChange={(value) => setFilters((prev) => ({ ...prev, minChars: value }))} />
            <TextField label={t.maxChars} value={filters.maxChars} onChange={(value) => setFilters((prev) => ({ ...prev, maxChars: value }))} />
            </div>
          )}

          <div className="md-control-row">
            <div className="md-segmented" aria-label="view mode">
              <button className={viewMode === "text" ? "active" : ""} onClick={() => setViewMode("text")} type="button">{t.textView}</button>
              <button className={viewMode === "html" ? "active" : ""} onClick={() => setViewMode("html")} type="button">{t.htmlView}</button>
            </div>
            <Switch label={t.expandQuotes} checked={autoExpandQuotes} onChange={setAutoExpandQuotes} />
            <Switch label={t.expandSpoilers} checked={autoExpandSpoilers} onChange={setAutoExpandSpoilers} />
          </div>

          <div className="md-actions sticky">
            <button className="md-button md-button-text" type="button" onClick={clearFilters}>{t.clear}</button>
            <button className="md-button md-button-outlined" type="button" onClick={handleInstall} disabled={!manifest || !thread || !!installProgress}>
              {installProgress ? `${t.installing} ${installProgress}` : installedVersion ? t.updateCache : t.installData}
            </button>
            <button className="md-button md-button-contained" type="button" onClick={runSearch} disabled={!workerReady || loading}>
              {loading || initializingCache ? t.loading : t.showResults}
            </button>
          </div>
        </aside>

        <section className="md-results">
          <div className="md-card md-summary-card">
            <div className="md-metrics">
              <Metric label={t.dataset} value={manifest?.version ?? "..."} />
              <Metric label={t.posts} value={String(thread?.total_posts ?? 0)} />
              <Metric label={t.generated} value={generated} />
              <Metric label={cached ? t.cached : t.notCached} value={cached ? "OK" : "-"} />
            </div>
          </div>

          {hasSearched && renderPagination(t, page, totalPages, total, loading, pageInput, setPageInput, setPage, handlePageJump)}

          <div className="md-post-list">
            {!cached && (
              <div className="md-card md-empty-state">
                <h2>{installedVersion ? t.cacheOutdatedTitle : t.cacheRequiredTitle}</h2>
                <p>{installedVersion ? t.cacheOutdatedBody : t.cacheRequiredBody}</p>
              </div>
            )}
            {cached && !hasSearched && (
              <div className="md-card md-empty-state">
                <h2>{t.readyTitle}</h2>
                <p>{t.readyBody}</p>
              </div>
            )}
            {cached && hasSearched && !loading && posts.length === 0 && (
              <div className="md-card md-empty-state">
                <h2>{t.emptyTitle}</h2>
                <p>{t.emptyBody}</p>
              </div>
            )}
            {cached && posts.map((post) => (
              <article key={post.post_id} className="md-card post" id={`post-${post.post_id}`}>
                <div className="post-header">
                  <div className="post-header-left">
                    <div className="post-avatar-fallback">{post.author_name.charAt(0).toUpperCase()}</div>
                    <div>
                      <span className="post-author">{post.author_name}</span>
                      <span className="post-meta">#{post.post_index} · {new Date(post.created_at).toLocaleString(lang === "zh" ? "zh-CN" : "en-US")}</span>
                    </div>
                  </div>
                  <div className="md-chip-row">
                    <span className="md-chip">{t.likes}: {post.likes_count}</span>
                    {post.rank != null && <span className="md-chip">{t.rank}: {post.rank}</span>}
                  </div>
                </div>
                <div className="post-body">
                  {viewMode === "text" ? (
                    <pre>{post.content_text_full}</pre>
                  ) : (
                    <div dangerouslySetInnerHTML={{ __html: processedHtmlByPostId.get(post.post_id) ?? post.content_html_raw }} />
                  )}
                </div>
              </article>
            ))}
            {(loading || initializingCache) && <div className="md-card md-empty-state"><p>{t.loading}...</p></div>}
          </div>

          {hasSearched && renderPagination(t, page, totalPages, total, loading, pageInput, setPageInput, setPage, handlePageJump)}
        </section>
      </section>
    </main>
  );
}

function LanguageSwitch({ lang, setLang }: { lang: Lang; setLang: (lang: Lang) => void }) {
  return (
    <div className="md-segmented" aria-label={text[lang].language}>
      <button className={lang === "zh" ? "active" : ""} onClick={() => setLang("zh")} type="button">中文</button>
      <button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")} type="button">EN</button>
    </div>
  );
}

function TextField({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="md-text-field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return (
    <label className="md-text-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </label>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="md-switch">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="track"><span className="thumb" /></span>
      <span>{label}</span>
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="md-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function renderPagination(
  t: typeof text[Lang],
  page: number,
  totalPages: number,
  total: number,
  loading: boolean,
  pageInput: string,
  setPageInput: (value: string) => void,
  setPage: (value: number | ((value: number) => number)) => void,
  handlePageJump: () => void,
) {
  return (
    <div className="md-pagination">
      <span>{t.page} {page} / {totalPages} · {t.total} {total}</span>
      <div>
        <button className="md-button md-button-text" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={loading || page <= 1}>{t.previous}</button>
        <button className="md-button md-button-text" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={loading || page >= totalPages}>{t.next}</button>
        <input className="md-page-input" type="number" min={1} max={totalPages} value={pageInput} onChange={(event) => setPageInput(event.target.value)} />
        <button className="md-button md-button-outlined" type="button" onClick={handlePageJump} disabled={loading}>{t.go}</button>
      </div>
    </div>
  );
}

async function hydratePosts(manifest: StaticManifest, metas: Array<StaticPostMeta & { rank?: number }>): Promise<Post[]> {
  const bodyMap = await loadBodies(manifest, metas.map((post) => post.body_path), true);
  return metas.map((post) => {
    const body = bodyMap.get(post.post_id);
    return {
      ...post,
      content_html_raw: body?.content_html_raw ?? "",
      content_text_full: body?.content_text_full ?? "",
      spoilers: body?.spoilers ?? [],
      attachments: body?.attachments ?? [],
      capture: null,
    };
  });
}

function filtersFromQuery(query: Record<string, string | string[] | undefined>): Filters {
  return {
    author: queryValue(query.author),
    authorId: queryValue(query.authorId),
    q: queryValue(query.q),
    minIndex: queryValue(query.minIndex),
    maxIndex: queryValue(query.maxIndex),
    minLikes: queryValue(query.minLikes),
    fromDate: queryValue(query.fromDate),
    toDate: queryValue(query.toDate),
    minChars: queryValue(query.minChars),
    maxChars: queryValue(query.maxChars),
    sort: parseSortMode(queryValue(query.sort)),
  };
}

function queryFromState(threadId: string, filters: Filters, page: number, pageSize: number): Record<string, string> {
  const query: Record<string, string> = { threadId };
  for (const key of ["q", "author", "authorId", "minIndex", "maxIndex", "minLikes", "fromDate", "toDate", "minChars", "maxChars"] as const) {
    if (filters[key]) query[key] = filters[key];
  }
  if (filters.sort !== defaultFilters.sort) query.sort = filters.sort;
  if (page > 1) query.page = String(page);
  if (pageSize !== 25) query.pageSize = String(pageSize);
  return query;
}

function hasSearchParams(query: Record<string, string | string[] | undefined>): boolean {
  return ["q", "author", "authorId", "minIndex", "maxIndex", "minLikes", "fromDate", "toDate", "minChars", "maxChars", "sort", "page", "pageSize"]
    .some((key) => queryValue(query[key]).trim() !== "");
}

function hasSecondaryFilters(query: Record<string, string | string[] | undefined>): boolean {
  return ["authorId", "fromDate", "toDate", "minChars", "maxChars", "pageSize"]
    .some((key) => queryValue(query[key]).trim() !== "");
}

function queryValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function parseSortMode(value: string): SortMode {
  return ["floor_asc", "floor_desc", "newest", "oldest", "likes", "length", "rank"].includes(value)
    ? value as SortMode
    : defaultFilters.sort;
}

function clampInt(raw: string, fallback: number, min: number, max: number): number {
  const value = parseInt(raw, 10);
  if (Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
