import ExcelJS from "exceljs";

const FACTORIES = ["OTA", "PHC", "KADUNA", "ABA"];
const GRAPH_API = "https://graph.microsoft.com/v1.0";
let cachedAccessToken;
let cachedAccessTokenExpiresAt = 0;

function normalizeFactory(factory) {
  return factory === "OA" ? "OTA" : factory;
}

function workbookFileName(factory) {
  return factory
    ? `Carton Return Tracker - ${factory}.xlsx`
    : "Carton Return Tracker - Seasoning.xlsx";
}

function buildWorkbook(data, factory) {
  const returns = data.returns.filter(record => !factory || normalizeFactory(record.f) === factory);
  const visibleReturnIds = new Set(returns.map(record => record.id));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Carton Return Tracker";

  const dispatch = workbook.addWorksheet("Dispatch");
  dispatch.addRow(["Date/time", "Factory", "Truck", "Waybill", "Cartons sent", "Record ID"]);
  for (const record of data.dispatch) {
    if (!factory || normalizeFactory(record.f) === factory) {
      dispatch.addRow([record.dt, normalizeFactory(record.f), record.truck, record.wb, record.qty, record.id]);
    }
  }

  const shifts = workbook.addWorksheet("Shifts");
  shifts.addRow(["Date", "Shift", "Factory", "Consumed", "Good", "Bad", "Record ID"]);
  for (const record of data.shifts) {
    if (!factory || normalizeFactory(record.f) === factory) {
      shifts.addRow([record.date, record.sh, normalizeFactory(record.f), record.used, record.good, record.bad, record.id]);
    }
  }

  const receiptsByReturnId = new Map(data.receipts.map(record => [record.rid, record]));
  const returnsById = new Map(returns.map(record => [record.id, record]));
  const returnsSheet = workbook.addWorksheet("Returns");
  returnsSheet.addRow(["Dispatched", "ETA", "Factory", "Truck", "Driver", "Phone", "Waybill", "Cartons", "Status", "Record ID"]);
  for (const record of returns) {
    returnsSheet.addRow([
      record.dt,
      record.eta,
      normalizeFactory(record.f),
      record.truck,
      record.driver,
      record.ph,
      record.wb,
      record.qty,
      receiptsByReturnId.has(record.id) ? "Received" : "In transit",
      record.id,
    ]);
  }

  const receipts = workbook.addWorksheet("Receipts");
  receipts.addRow(["Received", "Factory", "Truck", "Waybill", "Cartons sent", "Accepted", "Rejected", "Record ID"]);
  for (const record of data.receipts) {
    const returnRecord = returnsById.get(record.rid);
    if (returnRecord && (!factory || visibleReturnIds.has(returnRecord.id))) {
      receipts.addRow([
        record.dt,
        normalizeFactory(returnRecord.f),
        returnRecord.truck,
        returnRecord.wb,
        returnRecord.qty,
        record.acc,
        record.rej,
        record.id,
      ]);
    }
  }

  for (const sheet of workbook.worksheets) {
    const header = sheet.getRow(1);
    header.font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    header.eachCell((cell, columnNumber) => {
      sheet.getColumn(columnNumber).width = Math.min(Math.max(String(cell.value).length + 2, 14), 28);
    });
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: sheet.rowCount, column: header.cellCount },
    };
  }

  return workbook;
}

async function getAccessToken() {
  const { MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET } = process.env;
  if (!MICROSOFT_TENANT_ID || !MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) {
    throw new Error("Microsoft Graph credentials are not configured.");
  }

  if (cachedAccessToken && cachedAccessTokenExpiresAt > Date.now() + 60_000)
    return cachedAccessToken;

  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(MICROSOFT_TENANT_ID)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        client_secret: MICROSOFT_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );
  const result = await response.json();
  if (!response.ok || !result.access_token)
    throw new Error(`Microsoft sign-in failed (${response.status}): ${result.error_description || "Could not obtain an access token."}`);

  cachedAccessToken = result.access_token;
  cachedAccessTokenExpiresAt = Date.now() + Number(result.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

async function uploadWorkbook(token, fileName, workbook) {
  const onedriveUser = process.env.MICROSOFT_ONEDRIVE_USER;
  if (!onedriveUser) throw new Error("MICROSOFT_ONEDRIVE_USER is not configured.");

  const path = encodeURIComponent(fileName);
  const response = await fetch(
    `${GRAPH_API}/users/${encodeURIComponent(onedriveUser)}/drive/root:/${path}:/content`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      body: Buffer.from(await workbook.xlsx.writeBuffer()),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Could not update ${fileName} (${response.status}): ${detail}`);
  }
}

export async function syncExcelWorkbooks(data, factories = FACTORIES) {
  if (!process.env.MICROSOFT_TENANT_ID
    || !process.env.MICROSOFT_CLIENT_ID
    || !process.env.MICROSOFT_CLIENT_SECRET
    || !process.env.MICROSOFT_ONEDRIVE_USER) {
    return {
      status: "not_configured",
      message: "Excel sync is not configured; records are saved in the dashboard only.",
    };
  }

  const token = await getAccessToken();
  const targets = [...new Set(factories.map(normalizeFactory))]
    .filter(factory => FACTORIES.includes(factory));

  const uploads = [
    ...targets.map(factory => uploadWorkbook(token, workbookFileName(factory), buildWorkbook(data, factory))),
    uploadWorkbook(token, workbookFileName(null), buildWorkbook(data)),
  ];
  const results = await Promise.allSettled(uploads);
  const failures = results.filter(result => result.status === "rejected");
  if (failures.length) {
    throw new Error(failures.map(result =>
      result.reason instanceof Error ? result.reason.message : String(result.reason),
    ).join(" "));
  }

  return { status: "synced", message: "Excel workbooks updated." };
}
