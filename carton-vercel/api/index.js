import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";
import {
  checkGoogleSheets,
  importUpstashToSheets,
  readSheetRecord,
  readSheetRecords,
  readSheetSettings,
  removeSheetRecord,
  writeSheetRecord,
  writeSheetSettings,
} from "./google-sheets-store.js";
import {
  deleteFirebaseBackupRecord,
  syncFirebaseBackup,
  writeFirebaseBackupRecord,
  writeFirebaseBackupSettings,
} from "./firebase-backup.js";

let redis;
const KINDS = ["dispatch", "shifts", "returns", "receipts"];
const FACTORIES = ["OTA", "PHC", "KADUNA", "ABA"];

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

function normalizeFactory(factory) {
  return factory === "OA" ? "OTA" : factory;
}

function normalizeFactoryRecord(record) {
  return record.f === "OA" ? { ...record, f: "OTA" } : record;
}

function hasNonNegativeIntegers(record, fields) {
  return fields.every(field => Number.isSafeInteger(record[field]) && record[field] >= 0);
}

function getUpstashRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Upstash credentials are not configured for data migration.");
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

async function checkSheets() {
  try {
    await checkGoogleSheets();
    return { status: "synced", message: "Google Sheets connection is working." };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Unknown Google Sheets error.",
    };
  }
}

async function readDashboardData() {
  const [dispatch, shifts, returns, receipts, settings] = await Promise.all([
    ...KINDS.map(kind => readSheetRecords(kind)),
    readSheetSettings(),
  ]);
  return {
    dispatch: dispatch.map(normalizeFactoryRecord),
    shifts: shifts.map(normalizeFactoryRecord),
    returns: returns.map(normalizeFactoryRecord),
    receipts,
    settings: settings || null,
  };
}

async function migrateUpstashToSheets() {
  try {
    const source = getUpstashRedis();
    const [dispatch, shifts, returns, receipts, settings] = await Promise.all([
      source.lrange("dispatch", 0, -1),
      source.lrange("shifts", 0, -1),
      source.lrange("returns", 0, -1),
      source.lrange("receipts", 0, -1),
      source.get("settings"),
    ]);
    return await importUpstashToSheets({
      dispatch: (dispatch || []).map(normalizeFactoryRecord),
      shifts: (shifts || []).map(normalizeFactoryRecord),
      returns: (returns || []).map(normalizeFactoryRecord),
      receipts: receipts || [],
      settings: settings || null,
    });
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Unknown Upstash import error.",
    };
  }
}

function storageResult() {
  return {
    storageSync: "synced",
    storageMessage: "Google Sheets saved.",
  };
}

async function backupResult(action) {
  try {
    await action();
    return { backupSync: "synced", backupMessage: "Firebase backup updated." };
  } catch (error) {
    return {
      backupSync: "failed",
      backupMessage: error instanceof Error ? error.message : "Firebase backup failed.",
    };
  }
}

async function syncBackupFromSheets() {
  try {
    const data = await readDashboardData();
    return await syncFirebaseBackup(data);
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Firebase backup sync failed.",
    };
  }
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

  if (req.method === "POST" && req.body?.action === "checkGoogleSheets") {
    if (!isSeasoning(user)) return res.status(403).send("Only seasoning can check the Google Sheets connection");
    const result = await checkSheets();
    return res.status(200).json({
      ok: result.status === "synced",
      sheetsSync: result.status,
      sheetsMessage: result.message,
    });
  }

  if (req.method === "POST" && req.body?.action === "syncFirebaseBackup") {
    if (!isSeasoning(user)) return res.status(403).send("Only seasoning can sync the Firebase backup");
    const result = await syncBackupFromSheets();
    return res.status(200).json({
      ok: result.status === "synced",
      backupSync: result.status,
      backupMessage: result.message,
    });
  }

  if (req.method === "POST" && req.body?.action === "migrateUpstash") {
    if (!isSeasoning(user)) return res.status(403).send("Only seasoning can import Upstash data");
    const result = await migrateUpstashToSheets();
    if (result.status !== "synced") {
      return res.status(200).json({
        ok: false,
        migrationStatus: result.status,
        migrationMessage: result.message,
      });
    }
    const backup = await syncBackupFromSheets();
    return res.status(200).json({
      ok: true,
      migrationStatus: result.status,
      migrationMessage: result.message,
      backupSync: backup.status,
      backupMessage: backup.message,
    });
  }

  if (req.method === "POST" && req.body?.action === "edit") {
    const { kind, id, rec } = req.body;
    if (!KINDS.includes(kind)) return res.status(400).send("Bad kind");
    if (typeof id !== "string" || !id) return res.status(400).send("Invalid record id");
    if (!rec || typeof rec !== "object" || Array.isArray(rec))
      return res.status(400).send("Invalid record");
    if (!isSeasoning(user) && !["shifts", "returns"].includes(kind))
      return res.status(403).send("This account cannot edit that data");

    const existing = await readSheetRecord(kind, id);
    if (!existing) return res.status(404).send("Record not found");
    if (!isSeasoning(user) && normalizeFactory(existing.f) !== user.factory)
      return res.status(403).send("This account cannot edit that record");
    const record = { ...rec, id };
    if (["dispatch", "shifts", "returns"].includes(kind)) {
      if (isSeasoning(user) && !FACTORIES.includes(record.f))
        return res.status(400).send("Invalid factory");
      if (!isSeasoning(user)) record.f = user.factory;
    }
    if (["dispatch", "returns"].includes(kind)) {
      if (typeof record.truck !== "string" || !/^[A-Za-z0-9]*$/.test(record.truck))
        return res.status(400).send("Truck number must contain only letters and numbers");
      record.truck = record.truck.toUpperCase();
      if (typeof record.wb !== "string" || !/^\d*$/.test(record.wb))
        return res.status(400).send("Waybill number must contain digits only");
    }
    if (kind === "shifts") {
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
      const returnRecord = await readSheetRecord("returns", record.rid);
      if (!returnRecord)
        return res.status(400).send("Return truck not found");
      if (!Number.isSafeInteger(returnRecord.qty) || returnRecord.qty < 0)
        return res.status(400).send("Return truck has an invalid carton total");
      if (record.rej > returnRecord.qty)
        return res.status(400).send("Rejected cartons cannot exceed the return truck total");
      record.acc = returnRecord.qty - record.rej;
    }

    await writeSheetRecord(kind, record);
    const backup = await backupResult(() => writeFirebaseBackupRecord(kind, record));
    return res.status(200).json({ ok: true, id, ...storageResult(), ...backup });
  }

  if (req.method === "POST" && req.body?.action === "delete") {
    const { kind, id } = req.body;
    if (!KINDS.includes(kind)) return res.status(400).send("Bad kind");
    if (typeof id !== "string" || !id) return res.status(400).send("Invalid record id");
    if (!isSeasoning(user) && !["shifts", "returns"].includes(kind))
      return res.status(403).send("This account cannot delete that data");

    const record = await readSheetRecord(kind, id);
    if (!record) return res.status(404).send("Record not found");
    if (!isSeasoning(user) && normalizeFactory(record.f) !== user.factory)
      return res.status(403).send("This account cannot delete that record");
    const receiptRecords = kind === "returns"
      ? (await readSheetRecords("receipts")).filter(receipt => receipt.rid === id)
      : [];
    if (kind === "returns") {
      await Promise.all(receiptRecords.map(receipt => removeSheetRecord("receipts", receipt.id)));
    }
    await removeSheetRecord(kind, id);
    const backup = await backupResult(async () => {
      await Promise.all([
        ...receiptRecords.map(receipt => deleteFirebaseBackupRecord("receipts", receipt.id)),
        deleteFirebaseBackupRecord(kind, id),
      ]);
    });
    return res.status(200).json({ ok: true, ...storageResult(), ...backup });
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
      await writeSheetSettings(settings);
      const backup = await backupResult(() => writeFirebaseBackupSettings(settings));
      return res.status(200).json({
        ok: true,
        storageSync: "synced",
        storageMessage: "Google Sheets saved.",
        ...backup,
      });
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
    if (["dispatch", "returns"].includes(kind)) {
      if (typeof record.truck !== "string" || !/^[A-Za-z0-9]*$/.test(record.truck))
        return res.status(400).send("Truck number must contain only letters and numbers");
      record.truck = record.truck.toUpperCase();
      if (typeof record.wb !== "string" || !/^\d*$/.test(record.wb))
        return res.status(400).send("Waybill number must contain digits only");
    }
    if (kind === "shifts") {
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
      const returnRecord = await readSheetRecord("returns", record.rid);
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
    await writeSheetRecord(kind, savedRecord);
    const backup = await backupResult(() => writeFirebaseBackupRecord(kind, savedRecord));
    return res.status(200).json({ ok: true, id, ...storageResult(), ...backup });
  }

  return res.status(405).send("Method not allowed");
}
