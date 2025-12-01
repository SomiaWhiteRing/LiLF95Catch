import type { NextApiRequest, NextApiResponse } from "next";
import { loadAllPosts } from "../../../../lib/data";
import type { PagedPostsResponse, Post } from "../../../../lib/types";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { threadId } = req.query;
  if (typeof threadId !== "string") {
    res.status(400).json({ error: "Invalid threadId" });
    return;
  }

  const {
    page = "1",
    pageSize = "50",
    authorId,
    author,
    q,
    minIndex,
    maxIndex,
    minLikes,
    fromDate,
    toDate,
    minChars,
    maxChars,
  } = req.query;

  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const pageSizeNum = Math.min(200, Math.max(1, parseInt(String(pageSize), 10) || 50));

  const allPosts = await loadAllPosts(threadId);

  let filtered: Post[] = allPosts;

  if (authorId && typeof authorId === "string") {
    const id = parseInt(authorId, 10);
    if (!Number.isNaN(id)) {
      filtered = filtered.filter((p) => p.author_id === id);
    }
  }

  if (author && typeof author === "string" && author.trim() !== "") {
    const needle = author.trim().toLowerCase();
    filtered = filtered.filter((p) => p.author_name.toLowerCase().includes(needle));
  }

  if (minIndex && typeof minIndex === "string") {
    const min = parseInt(minIndex, 10);
    if (!Number.isNaN(min)) {
      filtered = filtered.filter((p) => p.post_index >= min);
    }
  }

  if (maxIndex && typeof maxIndex === "string") {
    const max = parseInt(maxIndex, 10);
    if (!Number.isNaN(max)) {
      filtered = filtered.filter((p) => p.post_index <= max);
    }
  }

  if (minLikes && typeof minLikes === "string") {
    const min = parseInt(minLikes, 10);
    if (!Number.isNaN(min)) {
      filtered = filtered.filter((p) => p.likes_count >= min);
    }
  }

  if (minChars && typeof minChars === "string") {
    const min = parseInt(minChars, 10);
    if (!Number.isNaN(min)) {
      filtered = filtered.filter((p) => {
        const len = (p as any).content_length ?? p.content_text_full.length;
        return len >= min;
      });
    }
  }

  if (maxChars && typeof maxChars === "string") {
    const max = parseInt(maxChars, 10);
    if (!Number.isNaN(max)) {
      filtered = filtered.filter((p) => {
        const len = (p as any).content_length ?? p.content_text_full.length;
        return len <= max;
      });
    }
  }

  if (q && typeof q === "string" && q.trim() !== "") {
    const needle = q.trim().toLowerCase();
    filtered = filtered.filter((p) => p.content_text_full.toLowerCase().includes(needle));
  }

  if (fromDate && typeof fromDate === "string" && fromDate.trim() !== "") {
    const from = new Date(fromDate);
    if (!Number.isNaN(from.getTime())) {
      filtered = filtered.filter((p) => {
        const d = new Date(p.created_at);
        return d >= from;
      });
    }
  }

  if (toDate && typeof toDate === "string" && toDate.trim() !== "") {
    const to = new Date(toDate);
    if (!Number.isNaN(to.getTime())) {
      filtered = filtered.filter((p) => {
        const d = new Date(p.created_at);
        return d <= to;
      });
    }
  }

  const total = filtered.length;
  const start = (pageNum - 1) * pageSizeNum;
  const items = filtered.slice(start, start + pageSizeNum);

  const resp: PagedPostsResponse = {
    thread_id: Number(threadId),
    page: pageNum,
    pageSize: pageSizeNum,
    total,
    items,
  };

  res.status(200).json(resp);
}
