import type { NextApiRequest, NextApiResponse } from "next";
import { loadUsers } from "../../../lib/data";
import type { UsersFile } from "../../../lib/types";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const users = await loadUsers();
  if (!users) {
    res.status(404).json({ error: "users.json not found" });
    return;
  }

  res.status(200).json(users as UsersFile);
}

