import type { StaticManifest, StaticPostMeta, StaticThreadEntry } from "./types";

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

type WorkerRequest =
  | {
      type: "init";
      manifest: StaticManifest;
      thread: StaticThreadEntry;
      posts: StaticPostMeta[];
    }
  | {
      type: "query";
      requestId: number;
      filters: Filters;
      page: number;
      pageSize: number;
    };

type WorkerResponse =
  | { type: "ready" }
  | {
      type: "result";
      requestId: number;
      total: number;
      items: Array<StaticPostMeta & { rank?: number }>;
    }
  | { type: "error"; requestId?: number; error: string };

const TOKEN_RE = /[a-z0-9]{2,}/gi;
const DATASET_ROOT = "/datasets";

let manifest: StaticManifest | null = null;
let thread: StaticThreadEntry | null = null;
let posts: StaticPostMeta[] = [];
let postById = new Map<number, StaticPostMeta>();
let bucketCache = new Map<string, Record<string, Array<[number, number]>>>();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data);
};

async function handle(message: WorkerRequest): Promise<void> {
  try {
    if (message.type === "init") {
      manifest = message.manifest;
      thread = message.thread;
      posts = message.posts;
      postById = new Map(posts.map((post) => [post.post_id, post]));
      bucketCache = new Map();
      send({ type: "ready" });
      return;
    }

    if (!manifest || !thread) {
      throw new Error("Search worker is not initialized.");
    }

    const result = await query(message.filters, message.page, message.pageSize);
    send({ type: "result", requestId: message.requestId, ...result });
  } catch (error) {
    send({
      type: "error",
      requestId: message.type === "query" ? message.requestId : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function query(filters: Filters, page: number, pageSize: number) {
  const terms = tokens(filters.q);
  const rankedIds = terms.length > 0 ? await searchIds(terms) : null;
  const start = (Math.max(1, page) - 1) * pageSize;
  const source = rankedIds
    ? rankedIds.map(([postId, rank]) => ({ post: postById.get(postId), rank }))
    : posts.map((post) => ({ post, rank: undefined as number | undefined }));

  const matched: Array<StaticPostMeta & { rank?: number }> = [];
  for (const item of source) {
    if (!item.post || !matches(item.post, filters)) continue;
    matched.push(item.rank == null ? item.post : { ...item.post, rank: item.rank });
  }
  matched.sort((a, b) => comparePosts(a, b, filters.sort, rankedIds != null));

  return {
    total: matched.length,
    items: matched.slice(start, start + pageSize),
  };
}

function comparePosts(a: StaticPostMeta & { rank?: number }, b: StaticPostMeta & { rank?: number }, sort: SortMode, hasQuery: boolean): number {
  const mode = sort === "rank" && !hasQuery ? "floor_asc" : sort || (hasQuery ? "rank" : "floor_asc");
  if (mode === "rank") return (b.rank ?? 0) - (a.rank ?? 0) || a.post_index - b.post_index;
  if (mode === "floor_desc") return b.post_index - a.post_index;
  if (mode === "newest") return Date.parse(b.created_at) - Date.parse(a.created_at);
  if (mode === "oldest") return Date.parse(a.created_at) - Date.parse(b.created_at);
  if (mode === "likes") return b.likes_count - a.likes_count || a.post_index - b.post_index;
  if (mode === "length") return b.content_length - a.content_length || a.post_index - b.post_index;
  return a.post_index - b.post_index;
}

async function searchIds(terms: string[]): Promise<Array<[number, number]>> {
  const scoreById = new Map<number, number>();
  let allowed: Set<number> | null = null;
  for (const term of terms) {
    const postings = await loadPostings(term);
    if (postings.length === 0) return [];
    const current: Set<number> = new Set(postings.map(([postId]) => postId));
    if (allowed) {
      const nextAllowed = new Set<number>();
      allowed.forEach((postId) => {
        if (current.has(postId)) nextAllowed.add(postId);
      });
      allowed = nextAllowed;
    } else {
      allowed = current;
    }
    if (allowed.size === 0) return [];
    for (const [postId, count] of postings) {
      scoreById.set(postId, (scoreById.get(postId) ?? 0) + count);
    }
  }
  return Array.from(scoreById.entries())
    .filter(([postId]) => allowed?.has(postId))
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

async function loadPostings(term: string): Promise<Array<[number, number]>> {
  if (!manifest || !thread) return [];
  const prefix = term.slice(0, 2);
  if (!bucketCache.has(prefix)) {
    const paths = thread.search_buckets[prefix] ?? [];
    const chunks = await Promise.all(paths.map((path) => fetchJson<{ tokens: Record<string, Array<[number, number]>> }>(path)));
    const tokensByBucket: Record<string, Array<[number, number]>> = {};
    for (const chunk of chunks) {
      Object.assign(tokensByBucket, chunk.tokens);
    }
    bucketCache.set(prefix, tokensByBucket);
  }
  return bucketCache.get(prefix)?.[term] ?? [];
}

function matches(post: StaticPostMeta, filters: Filters): boolean {
  if (filters.authorId) {
    const id = parseInt(filters.authorId, 10);
    if (!Number.isNaN(id) && post.author_id !== id) return false;
  }
  if (filters.author && !post.author_name.toLowerCase().includes(filters.author.trim().toLowerCase())) return false;
  if (!numberMin(post.post_index, filters.minIndex)) return false;
  if (!numberMax(post.post_index, filters.maxIndex)) return false;
  if (!numberMin(post.likes_count, filters.minLikes)) return false;
  if (!numberMin(post.content_length, filters.minChars)) return false;
  if (!numberMax(post.content_length, filters.maxChars)) return false;
  if (filters.fromDate) {
    const from = Date.parse(filters.fromDate);
    if (!Number.isNaN(from) && Date.parse(post.created_at) < from) return false;
  }
  if (filters.toDate) {
    const to = Date.parse(filters.toDate);
    if (!Number.isNaN(to) && Date.parse(post.created_at) > to + 24 * 60 * 60 * 1000 - 1) return false;
  }
  return true;
}

function numberMin(value: number, raw: string): boolean {
  const min = parseInt(raw, 10);
  return Number.isNaN(min) || value >= min;
}

function numberMax(value: number, raw: string): boolean {
  const max = parseInt(raw, 10);
  return Number.isNaN(max) || value <= max;
}

function tokens(value: string): string[] {
  return Array.from(new Set((value.toLowerCase().match(TOKEN_RE) ?? []).filter((token) => token.length <= 48)));
}

async function fetchJson<T>(relPath: string): Promise<T> {
  if (!manifest) throw new Error("Manifest is missing.");
  const url = `${DATASET_ROOT}/${manifest.version}/${relPath}`;
  const res = await caches.match(url);
  if (!res || !res.ok) {
    throw new Error(`Cache miss: ${relPath}`);
  }
  return (await res.json()) as T;
}

function send(message: WorkerResponse): void {
  self.postMessage(message);
}

export {};
