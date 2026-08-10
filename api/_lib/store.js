// Shared Redis connection + user-record helpers for tracking everyone who
// goes through the assessment - whether they ever pay or not.
//
// Requires a Redis database connected to THIS project (separate from the
// content generator's Redis) with REDIS_URL set in Vercel.

const { createClient } = require("redis");

let client;
async function getRedis() {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on("error", (err) => console.error("Redis client error", err));
  }
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}

function userKey(email) {
  return `user:${email.trim().toLowerCase()}`;
}

async function getUser(email) {
  const redis = await getRedis();
  const raw = await redis.get(userKey(email));
  return raw ? JSON.parse(raw) : null;
}

async function saveUser(email, record) {
  const redis = await getRedis();
  await redis.set(userKey(email), JSON.stringify(record));
}

// Merges new fields into an existing record (if any), never downgrading
// `status` (e.g. a real customer revisiting the free assessment again
// should not get overwritten back down to "free_only").
const STATUS_RANK = { free_only: 0, purchased_blueprint: 1, purchased_upgrade: 2, purchased_consultation: 3 };

async function upsertUser(email, updates) {
  const existing = await getUser(email);
  const merged = { ...(existing || {}), ...updates };

  if (existing && existing.status && updates.status) {
    const existingRank = STATUS_RANK[existing.status] ?? 0;
    const newRank = STATUS_RANK[updates.status] ?? 0;
    if (existingRank > newRank) {
      merged.status = existing.status; // keep the higher-value status
    }
  }

  merged.firstSeenAt = (existing && existing.firstSeenAt) || new Date().toISOString();
  merged.lastUpdatedAt = new Date().toISOString();

  await saveUser(email, merged);
  return merged;
}

async function listAllUsers() {
  const redis = await getRedis();
  const keys = [];
  for await (const key of redis.scanIterator({ MATCH: "user:*", COUNT: 100 })) {
    keys.push(key);
  }
  const users = [];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (raw) users.push(JSON.parse(raw));
  }
  users.sort((a, b) => new Date(b.lastUpdatedAt || 0) - new Date(a.lastUpdatedAt || 0));
  return users;
}

// Pending-purchase records bridge the gap between create-payment.js (which
// knows the coupon code and computed amount) and the Ziina webhook (which
// only learns of success later, with no access to that context). Keyed by
// email, short-lived, deleted once consumed.
function pendingKey(email) {
  return `pending_purchase:${email.trim().toLowerCase()}`;
}

async function savePendingPurchase(email, data) {
  const redis = await getRedis();
  await redis.set(pendingKey(email), JSON.stringify(data), { EX: 3600 }); // expires in 1hr as a safety net
}

async function consumePendingPurchase(email) {
  const redis = await getRedis();
  const key = pendingKey(email);
  const raw = await redis.get(key);
  if (raw) await redis.del(key);
  return raw ? JSON.parse(raw) : null;
}

module.exports = {
  getUser, saveUser, upsertUser, listAllUsers,
  savePendingPurchase, consumePendingPurchase
};
