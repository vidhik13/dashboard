import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});
const KINDS = ["dispatch", "shifts", "returns", "receipts"];
const FACTORIES = ["OTA", "PHC", "KADUNA", "ABA"];
const ACCOUNTS = {
  ota: { role: "noodle", factory: "OTA", password: process.env.NOODLE_PASSWORD_OTA },
  phc: { role: "noodle", factory: "PHC", password: process.env.NOODLE_PASSWORD_PHC },
  kaduna: { role: "noodle", factory: "KADUNA", password: process.env.NOODLE_PASSWORD_KADUNA },
  aba: { role: "noodle", factory: "ABA", password: process.env.NOODLE_PASSWORD_ABA },
  seasoning: { role: "seasoning", password: process.env.SEASONING_PASSWORD },
};

function safeEqual(a, b) {
  return timingSafeEqual(
    createHash("sha256").update(String(a)).digest(),
    createHash("sha256").update(String(b)).digest(),
  );
}

function createToken(user) {
  const payload = Buffer.from(JSON.stringify({
    username: user.username,
    role: user.role,
    factory: user.factory,
    exp: Date.now() + 8 * 60 * 60 * 1000,
  })).toString("base64url");
  const signature = createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readToken(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !process.env.AUTH_SECRET) return null;

  const expected = createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("base64url");
  if (!safeEqual(signature, expected)) return null;

  try {
    const user = JSON.parse(Buffer.from(payload, "base64url").toString());
    const account = ACCOUNTS[user.username];
    if (!account || !Number.isFinite(user.exp) || user.exp <= Date.now()) return null;
    if (user.role !== account.role || user.factory !== account.factory) return null;
    return { username: user.username, role: user.role, factory: user.factory };
  } catch {
    return null;
  }
}

function isSeasoning(user) {
  return user.role === "seasoning";
}

function normalizeFactory(factory) {
  return factory === "OA" ? "OTA" : factory;
}

function normalizeFactoryRecord(record) {
  return record.f === "OA" ? { ...record, f: "OTA" } : record;
}

export default async function handler(req, res) {
  if (req.method === "POST" && req.body?.action === "login") {
    if (!process.env.AUTH_SECRET)
      return res.status(500).send("AUTH_SECRET is not configured");

    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const account = ACCOUNTS[username];
    if (!account?.password || !safeEqual(password, account.password))
      return res.status(401).send("Invalid username or password");

    const user = { username, role: account.role, factory: account.factory };
    return res.status(200).json({ token: createToken(user), user });
  }

  const user = readToken(req);
  if (!user) return res.status(401).send("Unauthorized");

  if (req.method === "POST" && req.body?.action === "edit") {
    const { kind, id, rec } = req.body;
    if (!KINDS.includes(kind)) return res.status(400).send("Bad kind");
    if (typeof id !== "string" || !id) return res.status(400).send("Invalid record id");
    if (!rec || typeof rec !== "object" || Array.isArray(rec))
      return res.status(400).send("Invalid record");
    if (!isSeasoning(user) && !["shifts", "returns"].includes(kind))
      return res.status(403).send("This account cannot edit that data");

    const records = await redis.lrange(kind, 0, -1);
    const index = (records || []).findIndex(item => item.id === id);
    if (index < 0) return res.status(404).send("Record not found");
    const existing = records[index];
    if (!isSeasoning(user) && normalizeFactory(existing.f) !== user.factory)
      return res.status(403).send("This account cannot edit that record");

    const record = { ...rec, id };
    if (["dispatch", "shifts", "returns"].includes(kind)) {
      if (isSeasoning(user) && !FACTORIES.includes(record.f))
        return res.status(400).send("Invalid factory");
      if (!isSeasoning(user)) record.f = user.factory;
    }
    if (kind === "receipts") {
      if (typeof record.rid !== "string" || !record.rid)
        return res.status(400).send("Invalid return truck");
      const returnRecords = await redis.lrange("returns", 0, -1);
      if (!(returnRecords || []).some(item => item.id === record.rid))
        return res.status(400).send("Return truck not found");
    }

    await redis.lset(kind, index, record);
    return res.status(200).json({ ok: true, id });
  }

  if (req.method === "POST" && req.body?.action === "delete") {
    const { kind, id } = req.body;
    if (!KINDS.includes(kind)) return res.status(400).send("Bad kind");
    if (typeof id !== "string" || !id) return res.status(400).send("Invalid record id");
    if (!isSeasoning(user) && !["shifts", "returns"].includes(kind))
      return res.status(403).send("This account cannot delete that data");

    const records = await redis.lrange(kind, 0, -1);
    const record = (records || []).find(item => item.id === id);
    if (!record) return res.status(404).send("Record not found");
    if (!isSeasoning(user) && normalizeFactory(record.f) !== user.factory)
      return res.status(403).send("This account cannot delete that record");

    const removed = await redis.lrem(kind, 1, record);
    if (!removed) return res.status(409).send("Record changed; refresh and try again");

    if (kind === "returns") {
      const receipts = await redis.lrange("receipts", 0, -1);
      for (const receipt of receipts || []) {
        if (receipt.rid === id) await redis.lrem("receipts", 1, receipt);
      }
    }

    return res.status(200).json({ ok: true });
  }

  if (req.method === "GET") {
    const [dispatch, shifts, returns, receipts, settings] = await Promise.all([
      redis.lrange("dispatch", 0, -1),
      redis.lrange("shifts", 0, -1),
      redis.lrange("returns", 0, -1),
      redis.lrange("receipts", 0, -1),
      redis.get("settings"),
    ]);
    const normalizedDispatch = (dispatch || []).map(normalizeFactoryRecord);
    const normalizedShifts = (shifts || []).map(normalizeFactoryRecord);
    const normalizedReturns = (returns || []).map(normalizeFactoryRecord);
    const visibleReturns = isSeasoning(user)
      ? normalizedReturns
      : normalizedReturns.filter(record => record.f === user.factory);
    const visibleReturnIds = new Set(visibleReturns.map(record => record.id));

    return res.status(200).json({
      dispatch: normalizedDispatch.filter(record => isSeasoning(user) || record.f === user.factory),
      shifts: normalizedShifts.filter(record => isSeasoning(user) || record.f === user.factory),
      returns: visibleReturns,
      receipts: (receipts || []).filter(record =>
        isSeasoning(user) || visibleReturnIds.has(record.rid),
      ),
      settings: isSeasoning(user) ? settings || {} : {},
      user: { username: user.username, role: user.role, factory: user.factory },
    });
  }

  if (req.method === "POST") {
    const { kind, rec } = req.body || {};
    if (kind === "settings") {
      if (!isSeasoning(user)) return res.status(403).send("Only seasoning can update settings");
      const threshold = Number(rec?.thr);
      if (!Number.isFinite(threshold) || threshold < 0)
        return res.status(400).send("Invalid threshold");
      await redis.set("settings", { thr: threshold });
      return res.status(200).json({ ok: true });
    }

    if (!KINDS.includes(kind)) return res.status(400).send("Bad kind");
    if (!rec || typeof rec !== "object" || Array.isArray(rec))
      return res.status(400).send("Invalid record");
    if (!isSeasoning(user) && !["shifts", "returns"].includes(kind))
      return res.status(403).send("This account cannot update that data");

    const record = { ...rec };
    if (["dispatch", "shifts", "returns"].includes(kind)) {
      if (isSeasoning(user) && !FACTORIES.includes(record.f))
        return res.status(400).send("Invalid factory");
      if (!isSeasoning(user)) record.f = user.factory;
    }
    if (kind === "receipts") {
      if (typeof record.rid !== "string" || !record.rid)
        return res.status(400).send("Invalid return truck");
      const returnRecords = await redis.lrange("returns", 0, -1);
      if (!(returnRecords || []).some(item => item.id === record.rid))
        return res.status(400).send("Return truck not found");
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await redis.rpush(kind, { ...record, id });
    return res.status(200).json({ ok: true, id });
  }

  return res.status(405).send("Method not allowed");
}
