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

function replaceSheet(workbook, name, headers, rows) {
  const sheet = workbook.getWorksheet(name) || workbook.addWorksheet(name);
  if (sheet.rowCount) sheet.spliceRows(1, sheet.rowCount);
  const header = sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  header.font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  header.eachCell((cell, columnNumber) => {
    sheet.getColumn(columnNumber).width = Math.min(Math.max(String(cell.value).length + 2, 14), 28);
  });
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: sheet.rowCount, column: headers.length },
  };
}

function updateWorkbook(workbook, data, factory) {
  const returns = data.returns.filter(record => !factory || normalizeFactory(record.f) === factory);
  const visibleReturnIds = new Set(returns.map(record => record.id));

  const receiptsByReturnId = new Map(data.receipts.map(record => [record.rid, record]));
  const returnsById = new Map(returns.map(record => [record.id, record]));

  replaceSheet(workbook, "Dispatch",
    ["Date/time", "Factory", "Truck", "Waybill", "Cartons sent", "Record ID"],
    data.dispatch
      .filter(record => !factory || normalizeFactory(record.f) === factory)
      .map(record => [record.dt, normalizeFactory(record.f), record.truck, record.wb, record.qty, record.id]));
  replaceSheet(workbook, "Shifts",
    ["Date", "Shift", "Factory", "Consumed", "Good", "Bad", "Record ID"],
    data.shifts
      .filter(record => !factory || normalizeFactory(record.f) === factory)
      .map(record => [record.date, record.sh, normalizeFactory(record.f), record.used, record.good, record.bad, record.id]));
  replaceSheet(workbook, "Returns",
    ["Dispatched", "ETA", "Factory", "Truck", "Driver", "Phone", "Waybill", "Cartons", "Status", "Record ID"],
    returns.map(record => [
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
    ]));
  replaceSheet(workbook, "Receipts",
    ["Received", "Factory", "Truck", "Waybill", "Cartons sent", "Accepted", "Rejected", "Record ID"],
    data.receipts.flatMap(record => {
      const returnRecord = returnsById.get(record.rid);
      return returnRecord && (!factory || visibleReturnIds.has(returnRecord.id))
        ? [[
        record.dt,
        normalizeFactory(returnRecord.f),
        returnRecord.truck,
        returnRecord.wb,
        returnRecord.qty,
        record.acc,
        record.rej,
        record.id,
        ]]
        : [];
    }));
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

function encodeGraphPath(path) {
  const segments = path.split("/").filter(Boolean);
  const decodedSegments = segments.map(segment => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new Error("SharePoint path contains invalid URL encoding.");
    }
  });
  if (decodedSegments.some(segment => segment === "." || segment === ".."))
    throw new Error("SharePoint folder path must not contain . or .. segments.");
  return decodedSegments.map(segment => encodeURIComponent(segment)).join("/");
}

async function graphRequest(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...options.headers },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`SharePoint request failed (${response.status}): ${detail}`);
  }
  return response;
}

async function getSharePointDrive(token) {
  const value = process.env.SHAREPOINT_SITE_URL;
  if (!value) throw new Error("SHAREPOINT_SITE_URL is not configured.");

  let siteUrl;
  try {
    siteUrl = new URL(value);
  } catch {
    throw new Error("SHAREPOINT_SITE_URL must be a valid SharePoint site URL.");
  }
  if (siteUrl.protocol !== "https:" || !siteUrl.hostname.endsWith(".sharepoint.com"))
    throw new Error("SHAREPOINT_SITE_URL must be an HTTPS SharePoint Online site URL.");
  if (siteUrl.pathname === "/" || siteUrl.search || siteUrl.hash)
    throw new Error("SHAREPOINT_SITE_URL must point to a specific SharePoint site, without a query or fragment.");

  const sitePath = encodeGraphPath(siteUrl.pathname);
  const siteResponse = await graphRequest(
    token,
    `${GRAPH_API}/sites/${encodeURIComponent(siteUrl.hostname)}:/${sitePath}`,
  );
  const site = await siteResponse.json();
  const driveResponse = await graphRequest(token, `${GRAPH_API}/sites/${encodeURIComponent(site.id)}/drive`);
  const drive = await driveResponse.json();
  const folder = encodeGraphPath(process.env.SHAREPOINT_FOLDER_PATH || "");
  return { driveId: drive.id, folder };
}

async function syncWorkbook(token, driveId, folder, data, factory) {
  const fileName = workbookFileName(factory);
  const filePath = [folder, encodeURIComponent(fileName)].filter(Boolean).join("/");
  const itemUrl = `${GRAPH_API}/drives/${encodeURIComponent(driveId)}/root:/${filePath}`;
  const fileResponse = await graphRequest(token, `${itemUrl}:/content`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await fileResponse.arrayBuffer()));
  updateWorkbook(workbook, data, factory);

  await graphRequest(token, `${itemUrl}:/content`, {
    method: "PUT",
    headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    body: Buffer.from(await workbook.xlsx.writeBuffer()),
  });
}

export async function syncExcelWorkbooks(data, factories = FACTORIES) {
  if (!process.env.MICROSOFT_TENANT_ID
    || !process.env.MICROSOFT_CLIENT_ID
    || !process.env.MICROSOFT_CLIENT_SECRET
    || !process.env.SHAREPOINT_SITE_URL) {
    return {
      status: "not_configured",
      message: "Excel sync is not configured; records are saved in the dashboard only.",
    };
  }

  const token = await getAccessToken();
  const { driveId, folder } = await getSharePointDrive(token);
  const targets = [...new Set(factories.map(normalizeFactory))]
    .filter(factory => FACTORIES.includes(factory));

  const uploads = [
    ...targets.map(factory => syncWorkbook(token, driveId, folder, data, factory)),
    syncWorkbook(token, driveId, folder, data, null),
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
