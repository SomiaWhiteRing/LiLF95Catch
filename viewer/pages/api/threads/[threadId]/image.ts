import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";

const DATA_ROOT = path.resolve(process.cwd(), "..", "data");

function guessContentType(filePath: string): string {
  const ext = filePath.toLowerCase();
  if (ext.endsWith(".jpg") || ext.endsWith(".jpeg")) return "image/jpeg";
  if (ext.endsWith(".png")) return "image/png";
  if (ext.endsWith(".gif")) return "image/gif";
  if (ext.endsWith(".webp")) return "image/webp";
  if (ext.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { threadId, path: relPath } = req.query;

  if (typeof threadId !== "string") {
    res.status(400).json({ error: "Invalid threadId" });
    return;
  }
  if (typeof relPath !== "string") {
    res.status(400).json({ error: "Missing path parameter" });
    return;
  }

  const normalized = relPath.replace(/\\/g, "/");

  // Basic safety: ensure the path stays under data/threads/{threadId}/images
  const expectedPrefix = `threads/${threadId}/images/`;
  if (!normalized.startsWith(expectedPrefix)) {
    res.status(400).json({ error: "Invalid image path" });
    return;
  }

  const absPath = path.join(DATA_ROOT, normalized);

  try {
    await fs.promises.access(absPath, fs.constants.R_OK);
  } catch {
    res.status(404).json({ error: "Image not found" });
    return;
  }

  const stat = await fs.promises.stat(absPath);
  res.setHeader("Content-Type", guessContentType(absPath));
  res.setHeader("Content-Length", stat.size.toString());

  const stream = fs.createReadStream(absPath);
  stream.on("error", () => {
    res.status(500).end("Failed to read image");
  });
  stream.pipe(res);
}

