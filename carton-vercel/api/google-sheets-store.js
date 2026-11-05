import { google } from "googleapis";

const TABLES = {
  dispatch: [
    ["id", "Record ID"],
    ["f", "Factory"],
    ["truck", "Truck Number"],
    ["wb", "Waybill Number"],
    ["qty", "Cartons Sent"],
    ["dt", "Dispatch Date/Time"],
    ["eta", "Estimated Arrival (ETA)"],
  ],
  shifts: [
    ["id", "Record ID"],
    ["f", "Factory"],
    ["date", "Shift Date"],
    ["sh", "Shift"],
    ["used", "Total Cartons Used"],
    ["good", "Good Cartons"],
    ["bad", "Bad Cartons"],
    ["line", "Line"],
  ],
  returns: [
    ["id", "Record ID"],
    ["f", "Factory"],
    ["truck", "Truck Number"],
    ["driver", "Driver Name"],
    ["ph", "Driver Phone"],
    ["wb", "Waybill Number"],
    ["qty", "Cartons on Truck"],
    ["dt", "Dispatch Date/Time"],
    ["eta", "Estimated Arrival (ETA)"],
  ],
  receipts: [
    ["id", "Record ID"],
    ["rid", "Return Record ID"],
    ["dt", "Received Date/Time"],
    ["acc", "Accepted Cartons"],
    ["rej", "Rejected Cartons"],
  ],
};
const SETTINGS_TAB = "Settings";
const NUMBER_FIELDS = new Set(["qty", "used", "good", "bad", "acc", "rej", "thr", "line"]);

const fieldsFor = kind => TABLES[kind].map(([field]) => field);
const headersFor = kind => TABLES[kind].map(([, header]) => header);
let sheetsClient;
let initialization;

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const rawCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!rawCredentials) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not configured.");

  let credentials;
  try {
    credentials = JSON.parse(rawCredentials);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON.");
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

function getSpreadsheetId() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is not configured.");
  return spreadsheetId;
}

function columnName(number) {
  let result = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

async function ensureTabs() {
  if (!initialization) {
    initialization = (async () => {
      const sheets = getSheetsClient();
      const spreadsheetId = getSpreadsheetId();
      const expected = [...Object.keys(TABLES), SETTINGS_TAB];
      let metadata = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets.properties.title",
      });
      let titles = new Set((metadata.data.sheets || []).map(sheet => sheet.properties.title));
      const missing = expected.filter(title => !titles.has(title));

      if (missing.length) {
        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: missing.map(title => ({ addSheet: { properties: { title } } })),
            },
          });
        } catch (error) {
          metadata = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: "sheets.properties.title",
          });
          titles = new Set((metadata.data.sheets || []).map(sheet => sheet.properties.title));
          if (missing.some(title => !titles.has(title))) throw error;
        }
      }

      const headers = [
        ...Object.keys(TABLES).map(kind => ({
          range: `${kind}!A1:${columnName(TABLES[kind].length)}1`,
          values: [headersFor(kind)],
        })),
        { range: `${SETTINGS_TAB}!A1:B1`, values: [["Setting", "Value"]] },
      ];
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "RAW", data: headers },
      });

      const shiftRows = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Shifts!D2:D",
      });
      const values = shiftRows.data.values || [];
      const normalizedShifts = values.map(([shift = ""]) => [
        ({ A: "1", B: "2", C: "3" })[shift] || shift,
      ]);
      if (values.some(([shift = ""], index) => normalizedShifts[index][0] !== shift)) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `Shifts!D2:D${values.length + 1}`,
          valueInputOption: "RAW",
          requestBody: { values: normalizedShifts },
        });
      }
    })();
  }

  try {
    await initialization;
  } catch (error) {
    initialization = undefined;
    throw error;
  }
}

async function readRows(tab, range) {
  await ensureTabs();
  const response = await getSheetsClient().spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `${tab}!${range}`,
  });
  return response.data.values || [];
}

async function writeRows(tab, range, values) {
  await ensureTabs();
  await getSheetsClient().spreadsheets.values.update({
    spreadsheetId: getSpreadsheetId(),
    range: `${tab}!${range}`,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

function toRow(kind, record) {
  return fieldsFor(kind).map(field => {
    if (kind === "shifts" && field === "sh")
      return ({ A: "1", B: "2", C: "3" })[record.sh] || record.sh || "";
    return record[field] ?? "";
  });
}

function fromRow(kind, row) {
  return Object.fromEntries(fieldsFor(kind).map((field, index) => {
    const value = row[index] ?? "";
    return [field, NUMBER_FIELDS.has(field) && value !== "" ? Number(value) : value];
  }));
}

export async function readSheetRecords(kind) {
  const columns = TABLES[kind];
  if (!columns) throw new Error("Invalid Google Sheets collection.");
  const rows = await readRows(kind, `A2:${columnName(columns.length)}`);
  return rows.map(row => fromRow(kind, row)).filter(record => record.id !== "");
}

export async function readSheetRecord(kind, id) {
  return (await readSheetRecords(kind)).find(record => record.id === id) || null;
}

export async function writeSheetRecord(kind, record) {
  const columns = TABLES[kind];
  if (!columns) throw new Error("Invalid Google Sheets collection.");
  if (typeof record.id !== "string" || !record.id)
    throw new Error("A Google Sheets record must have an ID.");

  const rows = await readRows(kind, `A2:${columnName(columns.length)}`);
  const index = rows.findIndex(row => row[0] === record.id);
  if (index >= 0) {
    const rowNumber = index + 2;
    await writeRows(kind, `A${rowNumber}:${columnName(columns.length)}${rowNumber}`, [toRow(kind, record)]);
    return;
  }

  await ensureTabs();
  await getSheetsClient().spreadsheets.values.append({
    spreadsheetId: getSpreadsheetId(),
    range: `${kind}!A:${columnName(columns.length)}`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [toRow(kind, record)] },
  });
}

export async function removeSheetRecord(kind, id) {
  const columns = TABLES[kind];
  if (!columns) throw new Error("Invalid Google Sheets collection.");
  const rows = await readRows(kind, `A2:${columnName(columns.length)}`);
  const index = rows.findIndex(row => row[0] === id);
  if (index < 0) return false;

  const metadata = await getSheetsClient().spreadsheets.get({
    spreadsheetId: getSpreadsheetId(),
    fields: "sheets.properties",
  });
  const sheet = metadata.data.sheets.find(item => item.properties.title === kind);
  if (!sheet) throw new Error(`Google Sheets tab "${kind}" was not found.`);
  await getSheetsClient().spreadsheets.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheet.properties.sheetId,
            dimension: "ROWS",
            startIndex: index + 1,
            endIndex: index + 2,
          },
        },
      }],
    },
  });
  return true;
}

async function readSettingsEntries() {
  const rows = await readRows(SETTINGS_TAB, "A2:B");
  return rows.filter(row => row[0]).map(([key, value]) => [key, value ?? ""]);
}

async function setSheetSetting(key, value) {
  const entries = await readSettingsEntries();
  const index = entries.findIndex(entry => entry[0] === key);
  if (index >= 0) {
    const rowNumber = index + 2;
    await writeRows(SETTINGS_TAB, `A${rowNumber}:B${rowNumber}`, [[key, value]]);
    return;
  }

  await ensureTabs();
  await getSheetsClient().spreadsheets.values.append({
    spreadsheetId: getSpreadsheetId(),
    range: `${SETTINGS_TAB}!A:B`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[key, value]] },
  });
}

export async function readSheetSettings() {
  const entries = await readSettingsEntries();
  const threshold = entries.find(([key]) => key === "thr")?.[1];
  return threshold === undefined ? null : { thr: Number(threshold) };
}

export async function writeSheetSettings(settings) {
  await setSheetSetting("thr", settings.thr);
}

export async function importUpstashToSheets(data) {
  const settings = await readSettingsEntries();
  if (settings.some(([key]) => key === "upstash_imported_at"))
    throw new Error("Upstash data has already been imported into this spreadsheet.");

  for (const kind of Object.keys(TABLES)) {
    const existing = await readSheetRecords(kind);
    const merged = new Map(existing.map(record => [record.id, record]));
    const incomingIds = new Set();
    for (const record of data[kind] || []) {
      if (typeof record.id !== "string" || !record.id)
        throw new Error(`An Upstash ${kind} record has an invalid ID.`);
      if (incomingIds.has(record.id))
        throw new Error(`Upstash contains duplicate IDs in the ${kind} records.`);
      incomingIds.add(record.id);
      merged.set(record.id, record);
    }

    const lastColumn = columnName(TABLES[kind].length);
    await getSheetsClient().spreadsheets.values.clear({
      spreadsheetId: getSpreadsheetId(),
      range: `${kind}!A2:${lastColumn}`,
    });
    const records = [...merged.values()];
    if (records.length) {
      await writeRows(kind, `A2:${lastColumn}${records.length + 1}`, records.map(record => toRow(kind, record)));
    }
  }

  if (data.settings) await writeSheetSettings(data.settings);
  await setSheetSetting("upstash_imported_at", new Date().toISOString());
  return { status: "synced", message: "Existing Upstash records imported into Google Sheets." };
}

export async function checkGoogleSheets() {
  await Promise.all([
    ...Object.keys(TABLES).map(kind => readSheetRecords(kind)),
    readSheetSettings(),
  ]);
}
