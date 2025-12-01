import type { NextApiRequest, NextApiResponse } from "next";
import { loadThreadMeta } from "../../../../lib/data";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { threadId } = req.query;
  if (typeof threadId !== "string") {
    res.status(400).json({ error: "Invalid threadId" });
    return;
  }

  const meta = await loadThreadMeta(threadId);
  if (!meta) {
    res.status(404).json({ error: "Thread meta not found" });
    return;
  }

  res.status(200).json(meta);
}

