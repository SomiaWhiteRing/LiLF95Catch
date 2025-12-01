import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";
import { DATA_ROOT, loadUsers } from "../../../../lib/data";

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
  const { userId } = req.query;
  if (typeof userId !== "string") {
    res.status(400).json({ error: "Invalid userId" });
    return;
  }

  const usersFile = await loadUsers();
  if (!usersFile) {
    res.status(404).json({ error: "users.json not found" });
    return;
  }

  const record = usersFile.users[userId];
  if (!record || !record.avatar_local_path) {
    res.status(404).json({ error: "Avatar not found" });
    return;
  }

  const normalized = record.avatar_local_path.replace(/\\/g, "/");
  if (!normalized.startsWith("users/avatars/")) {
    res.status(400).json({ error: "Invalid avatar path" });
    return;
  }

  const absPath = path.join(DATA_ROOT, normalized);

  try {
    await fs.promises.access(absPath, fs.constants.R_OK);
  } catch {
    res.status(404).json({ error: "Avatar file not found" });
    return;
  }

  const stat = await fs.promises.stat(absPath);
  res.setHeader("Content-Type", guessContentType(absPath));
  res.setHeader("Content-Length", stat.size.toString());

  const stream = fs.createReadStream(absPath);
  stream.on("error", () => {
    res.status(500).end("Failed to read avatar");
  });
  stream.pipe(res);
}

