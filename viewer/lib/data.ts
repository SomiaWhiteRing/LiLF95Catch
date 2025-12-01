import fs from "fs";
import path from "path";
import type { Post, ThreadMeta, UsersFile } from "./types";

export const DATA_ROOT = path.resolve(process.cwd(), "..", "data");

function getThreadDir(threadId: string): string {
  return path.join(DATA_ROOT, "threads", threadId);
}

export function getThreadsRoot(): string {
  return path.join(DATA_ROOT, "threads");
}

export async function listThreadIds(): Promise<string[]> {
  try {
    const root = getThreadsRoot();
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function loadThreadMeta(threadId: string): Promise<ThreadMeta | null> {
  const metaPath = path.join(getThreadDir(threadId), "meta.json");
  try {
    const text = await fs.promises.readFile(metaPath, "utf-8");
    return JSON.parse(text) as ThreadMeta;
  } catch {
    return null;
  }
}

export async function loadAllPosts(threadId: string): Promise<Post[]> {
  const shardsDir = path.join(getThreadDir(threadId), "shards");
  let files: string[];
  try {
    files = await fs.promises.readdir(shardsDir);
  } catch {
    return [];
  }

  // Choose highest schema_version per shard prefix: {threadId}_{range}_vX.json
  const bestByPrefix = new Map<string, string>();

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const match = file.match(/^(\d+_\d{6}-\d{6})_v(\d+)\.json$/);
    if (!match) continue;
    const [, prefix, versionStr] = match;
    const version = parseInt(versionStr, 10);
    const existing = bestByPrefix.get(prefix);
    if (!existing) {
      bestByPrefix.set(prefix, file);
    } else {
      const existingMatch = existing.match(/^(\d+_\d{6}-\d{6})_v(\d+)\.json$/);
      const existingVersion = existingMatch ? parseInt(existingMatch[2], 10) : 0;
      if (version > existingVersion) {
        bestByPrefix.set(prefix, file);
      }
    }
  }

  const posts: Post[] = [];
  for (const file of bestByPrefix.values()) {
    const p = path.join(shardsDir, file);
    try {
      const text = await fs.promises.readFile(p, "utf-8");
      const json = JSON.parse(text) as { posts?: Post[] };
      if (Array.isArray(json.posts)) {
        for (const post of json.posts) {
          posts.push(post);
        }
      }
    } catch {
      // ignore shard read errors for now
    }
  }

  posts.sort((a, b) => {
    if (a.post_index === b.post_index) {
      return a.post_id - b.post_id;
    }
    return a.post_index - b.post_index;
  });

  return posts;
}

export async function loadUsers(): Promise<UsersFile | null> {
  const usersPath = path.join(DATA_ROOT, "users", "users.json");
  try {
    const text = await fs.promises.readFile(usersPath, "utf-8");
    return JSON.parse(text) as UsersFile;
  } catch {
    return null;
  }
}
