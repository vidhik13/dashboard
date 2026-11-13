import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  checkSupabase,
  readRecord,
  readRecords,
  readSettings,
  removeRecord,
  writeRecord,
  writeSettings,
} from "./supabase-store.js";
const KINDS = ["dispatch", "shifts", "returns", "receipts"];
const FACTORIES = ["OTA", "PHC", "KADUNA", "ABA"];
const FACTORY_LINES = {
  OTA: [1, 2, 3, 4, 5, 6],
  PHC: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  KADUNA: [1, 2, 3, 4, 5, 6],
  ABA: [1, 2],
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
    if (typeof user.username !== "string" || !Number.isFinite(user.exp) || user.exp <= Date.now())
      return null;
    if (user.role === "seasoning" && user.factory === undefined)
      return { username: user.username, role: user.role };
    if (user.role === "noodle" && FACTORIES.includes(user.factory))
      return { username: user.username, role: user.role, factory: user.factory };
    return null;
  } catch {
    return null;
  }
}

function isSeasoning(user) {
  return user.role === "seasoning";
}

function canManageKind(user, kind) {
  return isSeasoning(user)
    || ["shifts", "returns"].includes(kind);
}

function isOtaSimpleTransport(user, kind, factory = user.factory) {
  return ["dispatch", "returns"].includes(kind)
    && (isSeasoning(user) ? factory === "OTA" : user.factory === "OTA");
}

function clearOtaTransportDetails(record, kind) {
  record.truck = "";
  record.wb = "";
  record.eta = "";
  if (kind === "returns") {
    record.driver = "";
    record.ph = "";
  }
}

function normalizeFactory(factory) {
  return factory === "OA" ? "OTA" : factory;
}

function normalizeFactoryRecord(record) {
  return record.f === "OA" ? { ...record, f: "OTA" } : record;
}

function hasNonNegativeIntegers(record, fields) {
  return fields.every(field => Number.isSafeInteger(record[field]) && record[field] >= 0);
}

function isValidFactoryLine(factory, line) {
  return FACTORY_LINES[factory]?.includes(line) || false;
}

async function readDashboardData() {
  const [dispatch, shifts, returns, receipts, settings] = await Promise.all([
    ...KINDS.map(kind => readRecords(kind)),
    readSettings(),
  ]);
  return {
    dispatch: dispatch.map(normalizeFactoryRecord),
    shifts: shifts.map(normalizeFactoryRecord),
    returns: returns.map(normalizeFactoryRecord),
    receipts,
    settings: settings || null,
  };
}

function storageResult() {
  return {
    storageSync: "synced",
    storageMessage: "Supabase saved.",
  };
}

export async function excelExportHandler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  const exportToken = process.env.EXCEL_EXPORT_TOKEN;
  if (!exportToken || exportToken.length < 32)
    return res.status(503).send("Excel export requires an EXCEL_EXPORT_TOKEN of at least 32 characters.");
  if (!safeEqual(req.headers["x-export-token"] || "", exportToken))
    return res.status(401).send("Unauthorized");

  const url = new URL(req.url, "http://localhost");
  const kind = url.searchParams.get("kind");
  if (!KINDS.includes(kind)) return res.status(400).send("Select a valid export kind.");

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(await readRecords(kind));
}

export default async function handler(req, res) {
  if (req.method === "POST" && req.body?.action === "login") {
    if (!process.env.AUTH_SECRET)
      return res.status(500).send("AUTH_SECRET is not configured");

    const plant = String(req.body.plant || "");
    const password = String(req.body.password || "");
    if (!password) return res.status(400).send("Select a plant and enter its password.");
    if (plant !== "SEASONING" && !FACTORIES.includes(plant))
      return res.status(400).send("Select a valid plant.");
    const passwordVariable = plant === "SEASONING"
      ? "AUTH_PASSWORD_SEASONING"
      : `AUTH_PASSWORD_${plant}`;
    const expectedPassword = process.env[passwordVariable];
    if (!expectedPassword)
      return res.status(500).send(`Login is not configured for ${plant}.`);
    if (!safeEqual(password, expectedPassword))
      return res.status(401).send("Incorrect plant or password.");
    const user = plant === "SEASONING"
      ? { username: "seasoning", role: "seasoning" }
      : { username: plant.toLowerCase(), role: "noodle", factory: plant };
    return res.status(200).json({ token: createToken(user), user });
  }

  const user = readToken(req);
  if (!user) return res.status(401).send("Unauthorized");

  if (req.method === "POST" && req.body?.action === "checkSupabase") {
    if (!isSeasoning(user)) return res.status(403).send("Only Seasoning can check the database connection.");
    await checkSupabase();
    return res.status(200).json({ ok: true, message: "Supabase connection is working." });
  }

  if (req.method === "POST" && req.body?.action === "edit") {
    const { kind, id, rec } = req.body;
    if (!KINDS.includes(kind)) return res.status(400).send("Bad kind");
    if (typeof id !== "string" || !id) return res.status(400).send("Invalid record id");
    if (!rec || typeof rec !== "object" || Array.isArray(rec))
      return res.status(400).send("Invalid record");
    if (!canManageKind(user, kind))
      return res.status(403).send("This account cannot edit that data");

    const existing = await readRecord(kind, id);
    if (!existing) return res.status(404).send("Record not found");
    if (!isSeasoning(user) && normalizeFactory(existing.f) !== user.factory)
      return res.status(403).send("This account cannot edit that record");
    const record = { ...rec, id };
    if (["dispatch", "shifts", "returns"].includes(kind)) {
      if (isSeasoning(user) && !FACTORIES.includes(record.f))
        return res.status(400).send("Invalid factory");
      if (!isSeasoning(user)) record.f = user.factory;
    }
    const otaTransport = isOtaSimpleTransport(user, kind, record.f);
    if (otaTransport) clearOtaTransportDetails(record, kind);
    if (["dispatch", "returns"].includes(kind) && !otaTransport) {
      if (typeof record.truck !== "string" || !/^[A-Za-z0-9]*$/.test(record.truck))
        return res.status(400).send("Truck number must contain only letters and numbers");
      record.truck = record.truck.toUpperCase();
      if (typeof record.wb !== "string" || !/^\d*$/.test(record.wb))
        return res.status(400).send("Waybill number must contain digits only");
    }
    if (kind === "shifts") {
      if (!Number.isSafeInteger(record.line) || !isValidFactoryLine(record.f, record.line))
        return res.status(400).send(`Invalid line for ${record.f}`);
      if (!["1", "2", "3"].includes(String(record.sh)))
        return res.status(400).send("Shift must be 1, 2, or 3");
      record.sh = String(record.sh);
      if (!hasNonNegativeIntegers(record, ["used", "good", "bad"]))
        return res.status(400).send("Total, good, and bad cartons must be whole numbers greater than or equal to zero");
      if (record.good + record.bad !== record.used)
        return res.status(400).send("Good cartons plus bad cartons must equal total cartons consumed");
    }
    if (kind === "returns" && !hasNonNegativeIntegers(record, ["qty"]))
      return res.status(400).send("Return truck cartons must be a whole number greater than or equal to zero");
    if (kind === "receipts" && !hasNonNegativeIntegers(record, ["rej"]))
      return res.status(400).send("Rejected cartons must be a whole number greater than or equal to zero");
    if (kind === "receipts") {
      if (typeof record.rid !== "string" || !record.rid)
        return res.status(400).send("Invalid return truck");
      const returnRecord = await readRecord("returns", record.rid);
      if (!returnRecord)
        return res.status(400).send("Return truck not found");
      if (!Number.isSafeInteger(returnRecord.qty) || returnRecord.qty < 0)
        return res.status(400).send("Return truck has an invalid carton total");
      if (record.rej > returnRecord.qty)
        return res.status(400).send("Rejected cartons cannot exceed the return truck total");
      record.acc = returnRecord.qty - record.rej;
    }

    await writeRecord(kind, record);
    return res.status(200).json({ ok: true, id, ...storageResult() });
  }

  if (req.method === "POST" && req.body?.action === "delete") {
    const { kind, id } = req.body;
    if (!KINDS.includes(kind)) return res.status(400).send("Bad kind");
    if (typeof id !== "string" || !id) return res.status(400).send("Invalid record id");
    if (!canManageKind(user, kind))
      return res.status(403).send("This account cannot delete that data");

    const record = await readRecord(kind, id);
    if (!record) return res.status(404).send("Record not found");
    if (!isSeasoning(user) && normalizeFactory(record.f) !== user.factory)
      return res.status(403).send("This account cannot delete that record");
    const receiptRecords = kind === "returns"
      ? (await readRecords("receipts")).filter(receipt => receipt.rid === id)
      : [];
    if (kind === "returns") {
      await Promise.all(receiptRecords.map(receipt => removeRecord("receipts", receipt.id)));
    }
    await removeRecord(kind, id);
    return res.status(200).json({ ok: true, ...storageResult() });
  }

  if (req.method === "GET") {
    const { dispatch, shifts, returns, receipts, settings } = await readDashboardData();
    const normalizedDispatch = dispatch;
    const normalizedShifts = shifts;
    const normalizedReturns = returns;
    const visibleReturns = isSeasoning(user)
      ? normalizedReturns
      : normalizedReturns.filter(record => record.f === user.factory);
    const visibleReturnIds = new Set(visibleReturns.map(record => record.id));

    return res.status(200).json({
      dispatch: normalizedDispatch.filter(record => isSeasoning(user) || record.f === user.factory),
      shifts: normalizedShifts.filter(record => isSeasoning(user) || record.f === user.factory),
      returns: visibleReturns,
      receipts: receipts.filter(record =>
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
      const settings = { thr: threshold };
      await writeSettings(settings);
      return res.status(200).json({
        ok: true,
        storageSync: "synced",
        storageMessage: "Supabase saved.",
      });
    }

    if (!KINDS.includes(kind)) return res.status(400).send("Bad kind");
    if (!rec || typeof rec !== "object" || Array.isArray(rec))
      return res.status(400).send("Invalid record");
    if (!canManageKind(user, kind))
      return res.status(403).send("This account cannot update that data");

    const record = { ...rec };
    if (["dispatch", "shifts", "returns"].includes(kind)) {
      if (isSeasoning(user) && !FACTORIES.includes(record.f))
        return res.status(400).send("Invalid factory");
      if (!isSeasoning(user)) record.f = user.factory;
    }
    const otaTransport = isOtaSimpleTransport(user, kind, record.f);
    if (otaTransport) clearOtaTransportDetails(record, kind);
    if (["dispatch", "returns"].includes(kind) && !otaTransport) {
      if (typeof record.truck !== "string" || !/^[A-Za-z0-9]*$/.test(record.truck))
        return res.status(400).send("Truck number must contain only letters and numbers");
      record.truck = record.truck.toUpperCase();
      if (typeof record.wb !== "string" || !/^\d*$/.test(record.wb))
        return res.status(400).send("Waybill number must contain digits only");
    }
    if (kind === "shifts") {
      if (!Number.isSafeInteger(record.line) || !isValidFactoryLine(record.f, record.line))
        return res.status(400).send(`Invalid line for ${record.f}`);
      if (!["1", "2", "3"].includes(String(record.sh)))
        return res.status(400).send("Shift must be 1, 2, or 3");
      record.sh = String(record.sh);
      if (!hasNonNegativeIntegers(record, ["used", "good", "bad"]))
        return res.status(400).send("Total, good, and bad cartons must be whole numbers greater than or equal to zero");
      if (record.good + record.bad !== record.used)
        return res.status(400).send("Good cartons plus bad cartons must equal total cartons consumed");
    }
    if (kind === "returns" && !hasNonNegativeIntegers(record, ["qty"]))
      return res.status(400).send("Return truck cartons must be a whole number greater than or equal to zero");
    if (kind === "receipts" && !hasNonNegativeIntegers(record, ["rej"]))
      return res.status(400).send("Rejected cartons must be a whole number greater than or equal to zero");
    if (kind === "receipts") {
      if (typeof record.rid !== "string" || !record.rid)
        return res.status(400).send("Invalid return truck");
      const returnRecord = await readRecord("returns", record.rid);
      if (!returnRecord)
        return res.status(400).send("Return truck not found");
      if (!Number.isSafeInteger(returnRecord.qty) || returnRecord.qty < 0)
        return res.status(400).send("Return truck has an invalid carton total");
      if (record.rej > returnRecord.qty)
        return res.status(400).send("Rejected cartons cannot exceed the return truck total");
      record.acc = returnRecord.qty - record.rej;
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const savedRecord = { ...record, id };
    await writeRecord(kind, savedRecord);
    return res.status(200).json({ ok: true, id, ...storageResult() });
  }

  return res.status(405).send("Method not allowed");
}
