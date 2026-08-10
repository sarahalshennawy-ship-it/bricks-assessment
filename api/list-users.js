// GET /api/list-users
// Admin-only. Returns every tracked user - free visitors and paying
// customers alike - with their business data and purchase status.

const { listAllUsers } = require("./_lib/store.js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const adminKey = req.headers["x-admin-key"];
  if (!adminKey || adminKey !== process.env.ASSESSMENT_ADMIN_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const users = await listAllUsers();
    res.status(200).json({ users });
  } catch (err) {
    console.error("list-users error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
