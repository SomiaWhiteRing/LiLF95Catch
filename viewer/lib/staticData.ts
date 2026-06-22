import type { StaticManifest, StaticPostBody, StaticPostMeta, StaticThreadEntry, ThreadMeta } from "./types";

export const DATASET_ROOT = "/datasets";
const DB_NAME = "lilf95-static-viewer";
const STORE = "versions";
const INSTALL_CONCURRENCY = 6;

async function fetchJson<T>(path: string, cacheOnly = false): Promise<T> {
  const res = cacheOnly ? await caches.match(path) : await fetch(path);
  if (!res || !res.ok) {
    throw new Error(`Failed to fetch ${path}: ${res?.status ?? "cache miss"}`);
  }
  return (await res.json()) as T;
}

export function datasetUrl(manifest: StaticManifest, relPath: string): string {
  return `${DATASET_ROOT}/${manifest.version}/${relPath}`;
}

export async function loadManifest(): Promise<StaticManifest> {
  const path = `${DATASET_ROOT}/manifest.json`;
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${path}: ${res.status}`);
  }
  return (await res.json()) as StaticManifest;
}

export async function loadThreadMeta(manifest: StaticManifest, thread: StaticThreadEntry, cacheOnly = false): Promise<ThreadMeta> {
  return fetchJson<ThreadMeta>(datasetUrl(manifest, thread.meta), cacheOnly);
}

export async function loadPostMeta(manifest: StaticManifest, thread: StaticThreadEntry, cacheOnly = false): Promise<StaticPostMeta[]> {
  const chunks = await Promise.all(
    thread.posts_meta.map((path) => fetchJson<{ items: StaticPostMeta[] }>(datasetUrl(manifest, path), cacheOnly)),
  );
  return chunks.flatMap((chunk) => chunk.items);
}

export async function loadBodies(
  manifest: StaticManifest,
  paths: string[],
  cacheOnly = false,
): Promise<Map<number, StaticPostBody>> {
  const unique = Array.from(new Set(paths));
  const chunks = await Promise.all(
    unique.map((path) => fetchJson<{ items: StaticPostBody[] }>(datasetUrl(manifest, path), cacheOnly)),
  );
  const map = new Map<number, StaticPostBody>();
  for (const chunk of chunks) {
    for (const body of chunk.items) {
      map.set(body.post_id, body);
    }
  }
  return map;
}

export async function installDataset(
  manifest: StaticManifest,
  thread: StaticThreadEntry,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  if (!("caches" in window)) {
    throw new Error("Cache API is not available in this browser.");
  }
  const cache = await caches.open(`lilf95-${manifest.version}`);
  const paths = Array.from(new Set([
    `${DATASET_ROOT}/manifest.json`,
    datasetUrl(manifest, thread.meta),
    ...thread.posts_meta.map((path) => datasetUrl(manifest, path)),
    ...thread.bodies.map((path) => datasetUrl(manifest, path)),
    ...Object.values(thread.search_buckets).flat().map((path) => datasetUrl(manifest, path)),
  ]));
  let done = 0;
  await runLimited(paths, INSTALL_CONCURRENCY, async (path) => {
    await cachePath(cache, manifest, path);
    done += 1;
    onProgress(done, paths.length);
  });
  await markInstalled(manifest.version);
  await deleteOldCaches(manifest.version);
}

export function isDatasetInstalled(manifest: StaticManifest, installedVersion: string | null): boolean {
  return installedVersion === manifest.version;
}

async function findCachedResponse(path: string, hash?: string): Promise<Response | null> {
  if (!("caches" in window)) return null;
  for (const name of await caches.keys()) {
    if (!name.startsWith("lilf95-")) continue;
    const cache = await caches.open(name);
    const hit = await cache.match(path);
    if (hit) return hit;
    if (!hash) continue;
    const oldVersion = name.slice("lilf95-".length);
    const oldManifest = await cache.match(`${DATASET_ROOT}/manifest.json`) ?? await cache.match(`${DATASET_ROOT}/${oldVersion}/manifest.json`);
    if (!oldManifest) continue;
    try {
      const parsed = (await oldManifest.clone().json()) as StaticManifest;
      const relPath = Object.entries(parsed.files ?? {}).find(([, oldHash]) => oldHash === hash)?.[0];
      if (relPath) {
        const reused = await cache.match(`${DATASET_ROOT}/${oldVersion}/${relPath}`);
        if (reused) return reused;
      }
    } catch {
      // ignore invalid old manifests
    }
  }
  return null;
}

async function cachePath(cache: Cache, manifest: StaticManifest, path: string): Promise<void> {
  if (await cache.match(path)) return;
  if (path === `${DATASET_ROOT}/manifest.json`) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
    await cache.put(path, res);
    return;
  }

  const relPath = path.replace(`${DATASET_ROOT}/${manifest.version}/`, "");
  const prior = await findCachedResponse(path, manifest.files?.[relPath]);
  if (prior) {
    await cache.put(path, prior.clone());
    return;
  }
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  await cache.put(path, res);
}

async function runLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await task(item);
    }
  });
  await Promise.all(workers);
}

async function deleteOldCaches(currentVersion: string): Promise<void> {
  if (!("caches" in window)) return;
  await Promise.all(
    (await caches.keys())
      .filter((name) => name.startsWith("lilf95-") && name !== `lilf95-${currentVersion}`)
      .map((name) => caches.delete(name)),
  );
}

export async function getInstalledVersion(): Promise<string | null> {
  if (!("indexedDB" in window)) return null;
  const db = await openDb();
  return new Promise((resolve) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get("current");
    req.onsuccess = () => {
      const result = (req.result as string | undefined) ?? null;
      db.close();
      resolve(result);
    };
    req.onerror = () => {
      db.close();
      resolve(null);
    };
  });
}

async function markInstalled(version: string): Promise<void> {
  if (!("indexedDB" in window)) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(version, "current");
    req.onsuccess = () => {
      db.close();
      resolve();
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
