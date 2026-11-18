import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  readRecord,
  readRecords,
  readSettings,
  removeRecord,
  writeRecord,
  writeSettings,
} from "./supabase-store.js";
const KINDS = ["dispatch", "shifts", "returns", "receipts"];
const FACTORIES = ["OTA", "PHC", "KADUNA"];
const FACTORY_LINES = {
  OTA: [1, 2, 3, 4, 5, 6],
  PHC: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  KADUNA: [1, 2, 3, 4, 5, 6],
};
const SORTER_NAMES = {
  PHC: ["Jollof", "Chicken", "Onion"],
  KADUNA: ["Innocent", "Anthony"],
};

class InputError extends Error {}

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
    if (user.role === "sorting" && FACTORIES.includes(user.factory))
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
    || (user.role === "noodle" && ["shifts", "returns"].includes(kind))
    || (user.role === "sorting" && kind === "shifts");
}

function isValidShiftDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function validateShiftIdentity(record) {
  if (!isValidShiftDate(record.date))
    throw new InputError("Shift date must be a valid calendar date");
  if (!Number.isSafeInteger(record.line) || !isValidFactoryLine(record.f, record.line))
    throw new InputError(`Invalid line for ${record.f}`);
  if (!["1", "2", "3"].includes(String(record.sh)))
    throw new InputError("Shift must be 1, 2, or 3");
  record.sh = String(record.sh);
}

function validateShiftValues(record) {
  const hasUsed = Number.isSafeInteger(record.used) && record.used >= 0;
  const hasGood = Number.isSafeInteger(record.good) && record.good >= 0;
  const hasBad = Number.isSafeInteger(record.bad) && record.bad >= 0;
  if (record.used !== undefined && !hasUsed)
    throw new InputError("Total cartons consumed must be a whole number greater than or equal to zero");
  if (record.good !== undefined && !hasGood)
    throw new InputError("Good cartons must be a whole number greater than or equal to zero");
  if (record.bad !== undefined && !hasBad)
    throw new InputError("Bad cartons must be a whole number greater than or equal to zero");
  if (hasUsed && hasGood && hasBad && record.good + record.bad !== record.used)
    throw new InputError("Good and bad cartons do not match the total consumed for this shift");
}

async function buildShiftRecord(user, input, existing = null) {
  const factory = isSeasoning(user) ? normalizeFactory(input.f) : user.factory;
  if (!FACTORIES.includes(factory)) throw new InputError("Invalid factory");

  const identity = {
    f: factory,
    date: isSeasoning(user) || !existing ? input.date : existing.date,
    line: isSeasoning(user) || !existing ? input.line : existing.line,
    sh: isSeasoning(user) || !existing ? input.sh : existing.sh,
  };
  const records = existing ? [] : await readRecords("shifts");
  const matchingRecord = existing || records.find(record =>
    normalizeFactory(record.f) === factory
    && record.date === identity.date
    && record.line === identity.line
    && String(record.sh) === String(identity.sh),
  );
  if (user.role === "noodle"
    && (!matchingRecord || !hasNonNegativeIntegers(matchingRecord, ["good", "bad"])))
    throw new InputError("Sorting Team must enter Good and Bad cartons before a total is added");
  const record = {
    ...(matchingRecord || {}),
    ...identity,
    id: matchingRecord?.id
      || `${factory}-${identity.date}-L${identity.line}-S${identity.sh}`,
  };

  if (user.role === "sorting") {
    record.good = input.good;
    record.bad = input.bad;
    record.sorter = typeof input.sorter === "string" ? input.sorter.trim() : "";
    if (!record.sorter || record.sorter.length > 100)
      throw new InputError("Enter the sorting team member's name (up to 100 characters)");
    const allowedSorters = SORTER_NAMES[factory];
    if (allowedSorters && !allowedSorters.includes(record.sorter)
      && (!existing || record.sorter !== existing.sorter))
      throw new InputError(`Select a valid sorting team member for ${factory}`);
  } else if (user.role === "noodle") {
    record.used = input.used;
  } else {
    record.used = input.used;
    record.good = input.good;
    record.bad = input.bad;
  }

  validateShiftIdentity(record);
  const requiredValues = user.role === "sorting"
    ? ["good", "bad"]
    : user.role === "noodle" ? ["used"] : ["used", "good", "bad"];
  if (!hasNonNegativeIntegers(record, requiredValues)) {
    const labels = requiredValues.map(field =>
      field === "used" ? "total consumed" : `${field} cartons`,
    );
    throw new InputError(`${labels.join(", ")} must be whole numbers greater than or equal to zero`);
  }
  validateShiftValues(record);
  return record;
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
  if (typeof factory !== "string") return factory;
  const normalized = factory.replace(/\s+/g, "").toUpperCase();
  return normalized === "OA" ? "OTA" : normalized;
}

function normalizeFactoryRecord(record) {
  const factory = normalizeFactory(record.f);
  return factory === record.f ? record : { ...record, f: factory };
}

function activeFactoryRecords(records) {
  return records
    .map(normalizeFactoryRecord)
    .filter(record => FACTORIES.includes(record.f));
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
  const activeDispatch = activeFactoryRecords(dispatch);
  const activeShifts = activeFactoryRecords(shifts);
  const activeReturns = activeFactoryRecords(returns);
  const activeReturnIds = new Set(activeReturns.map(record => record.id));
  return {
    dispatch: activeDispatch,
    shifts: activeShifts,
    returns: activeReturns,
    receipts: receipts.filter(record => activeReturnIds.has(record.rid)),
    settings: settings || null,
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
  const records = await readRecords(kind);
  if (["dispatch", "shifts", "returns"].includes(kind))
    return res.status(200).json(activeFactoryRecords(records));
  const activeReturnIds = new Set(activeFactoryRecords(await readRecords("returns")).map(record => record.id));
  return res.status(200).json(records.filter(record => activeReturnIds.has(record.rid)));
}

export default async function handler(req, res) {
  if (req.method === "POST" && req.body?.action === "login") {
    if (!process.env.AUTH_SECRET)
      return res.status(500).send("AUTH_SECRET is not configured");

    const plant = String(req.body.plant || "");
    const team = String(req.body.team || "warehouse");
    const password = String(req.body.password || "");
    if (!password) return res.status(400).send("Select a plant and enter its password.");
    if (plant !== "SEASONING" && !FACTORIES.includes(plant))
      return res.status(400).send("Select a valid plant.");
    if (!["warehouse", "sorting"].includes(team) || (plant === "SEASONING" && team !== "warehouse"))
      return res.status(400).send("Select a valid team for this plant.");
    const passwordVariable = team === "sorting"
      ? `AUTH_PASSWORD_SORTING_${plant}`
      : plant === "SEASONING" ? "AUTH_PASSWORD_SEASONING" : `AUTH_PASSWORD_${plant}`;
    const expectedPassword = process.env[passwordVariable];
    if (!expectedPassword)
      return res.status(500).send(`Login is not configured for ${plant} ${team.toUpperCase()}.`);
    if (!safeEqual(password, expectedPassword))
      return res.status(401).send("Incorrect plant or password.");
    const user = plant === "SEASONING"
      ? { username: "seasoning", role: "seasoning" }
      : team === "sorting"
        ? { username: `${plant.toLowerCase()}-sorting`, role: "sorting", factory: plant }
        : { username: plant.toLowerCase(), role: "noodle", factory: plant };
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
    if (!canManageKind(user, kind))
      return res.status(403).send("This account cannot edit that data");

    const existing = await readRecord(kind, id);
    if (!existing) return res.status(404).send("Record not found");
    if (!isSeasoning(user) && normalizeFactory(existing.f) !== user.factory)
      return res.status(403).send("This account cannot edit that record");
    if (kind === "shifts") {
      try {
        const record = await buildShiftRecord(user, rec, existing);
        await writeRecord(kind, record);
        return res.status(200).json({ ok: true, id });
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        return res.status(400).send(error.message);
      }
    }
    const record = { ...rec, id };
    if (["dispatch", "shifts", "returns"].includes(kind)) {
      if (isSeasoning(user) && !FACTORIES.includes(record.f))
        return res.status(400).send("Invalid factory");
      if (!isSeasoning(user)) record.f = user.factory;
    }
    if (kind === "dispatch" && isSeasoning(user)) {
      if (typeof record.dt !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(record.dt))
        return res.status(400).send("Dispatch month must use YYYY-MM format");
      if (!hasNonNegativeIntegers(record, ["qty"]))
        return res.status(400).send("Monthly cartons sent must be a whole number greater than or equal to zero");
      record.truck = "";
      record.wb = "";
      record.eta = "";
    }
    const otaTransport = isOtaSimpleTransport(user, kind, record.f);
    if (otaTransport) clearOtaTransportDetails(record, kind);
    if (["dispatch", "returns"].includes(kind) && !otaTransport) {
      if (typeof record.truck !== "string" || !/^[A-Za-z0-9]*$/.test(record.truck))
        return res.status(400).send("Truck number must contain only letters and numbers");
      record.truck = record.truck.toUpperCase();
      if (typeof record.wb !== "string" || !/^\d*$/.test(record.wb))
        return res.status(400).send("Waybill number must contain digits only");
      if (kind === "returns" && (typeof record.ph !== "string" || !/^\d*$/.test(record.ph)))
        return res.status(400).send("Driver phone must contain digits only");
      if (kind === "returns" && (typeof record.driver !== "string" || /[0-9]/.test(record.driver)))
        return res.status(400).send("Driver name must not contain numbers");
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
    return res.status(200).json({ ok: true, id });
  }

  if (req.method === "POST" && req.body?.action === "delete") {
    const { kind, id } = req.body;
    if (!KINDS.includes(kind)) return res.status(400).send("Bad kind");
    if (typeof id !== "string" || !id) return res.status(400).send("Invalid record id");
    if (!canManageKind(user, kind))
      return res.status(403).send("This account cannot delete that data");
    if (kind === "shifts" && !isSeasoning(user))
      return res.status(403).send("Only Seasoning can delete shift records");

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
    return res.status(200).json({ ok: true });
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

    const sortingShifts = normalizedShifts
      .filter(record => record.f === user.factory)
      .map(({ used, ...record }) => record);
    return res.status(200).json({
      dispatch: user.role === "sorting" ? [] : normalizedDispatch.filter(record => isSeasoning(user) || record.f === user.factory),
      shifts: user.role === "sorting"
        ? sortingShifts
        : normalizedShifts.filter(record => isSeasoning(user) || record.f === user.factory),
      returns: user.role === "sorting" ? [] : visibleReturns,
      receipts: user.role === "sorting" ? [] : receipts.filter(record =>
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
      return res.status(200).json({ ok: true });
    }

    if (!KINDS.includes(kind)) return res.status(400).send("Bad kind");
    if (!rec || typeof rec !== "object" || Array.isArray(rec))
      return res.status(400).send("Invalid record");
    if (!canManageKind(user, kind))
      return res.status(403).send("This account cannot update that data");

    if (kind === "shifts") {
      try {
        const record = await buildShiftRecord(user, rec);
        await writeRecord(kind, record);
        return res.status(200).json({ ok: true, id: record.id });
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        return res.status(400).send(error.message);
      }
    }

    const record = { ...rec };
    if (["dispatch", "shifts", "returns"].includes(kind)) {
      if (isSeasoning(user) && !FACTORIES.includes(record.f))
        return res.status(400).send("Invalid factory");
      if (!isSeasoning(user)) record.f = user.factory;
    }
    if (kind === "dispatch" && isSeasoning(user)) {
      if (typeof record.dt !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(record.dt))
        return res.status(400).send("Dispatch month must use YYYY-MM format");
      if (!hasNonNegativeIntegers(record, ["qty"]))
        return res.status(400).send("Monthly cartons sent must be a whole number greater than or equal to zero");
      record.truck = "";
      record.wb = "";
      record.eta = "";
    }
    const otaTransport = isOtaSimpleTransport(user, kind, record.f);
    if (otaTransport) clearOtaTransportDetails(record, kind);
    if (["dispatch", "returns"].includes(kind) && !otaTransport) {
      if (typeof record.truck !== "string" || !/^[A-Za-z0-9]*$/.test(record.truck))
        return res.status(400).send("Truck number must contain only letters and numbers");
      record.truck = record.truck.toUpperCase();
      if (typeof record.wb !== "string" || !/^\d*$/.test(record.wb))
        return res.status(400).send("Waybill number must contain digits only");
      if (kind === "returns" && (typeof record.ph !== "string" || !/^\d*$/.test(record.ph)))
        return res.status(400).send("Driver phone must contain digits only");
      if (kind === "returns" && (typeof record.driver !== "string" || /[0-9]/.test(record.driver)))
        return res.status(400).send("Driver name must not contain numbers");
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
    return res.status(200).json({ ok: true, id });
  }

  return res.status(405).send("Method not allowed");
}
