const COLLECTIONS = new Set(["dispatch", "shifts", "returns", "receipts"]);
let supabaseUrl;
let serviceRoleKey;

function getConfig() {
  if (supabaseUrl && serviceRoleKey) return { supabaseUrl, serviceRoleKey };
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured.");
  supabaseUrl = url.replace(/\/+$/, "");
  serviceRoleKey = key;
  return { supabaseUrl, serviceRoleKey };
}

async function request(path, options = {}) {
  const { supabaseUrl: url, serviceRoleKey: key } = getConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase request failed (${response.status}): ${detail || response.statusText}`);
  }
  if (response.status === 204) return null;
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

function collection(kind) {
  if (!COLLECTIONS.has(kind)) throw new Error("Invalid record collection.");
  return kind;
}

export async function readRecords(kind) {
  const query = new URLSearchParams({ select: "data", kind: `eq.${collection(kind)}` });
  const pageSize = 1000;
  const records = [];
  for (let offset = 0; ; offset += pageSize) {
    const rows = await request(`carton_records?${query}`, {
      headers: {
        "range-unit": "items",
        range: `${offset}-${offset + pageSize - 1}`,
      },
    });
    records.push(...(rows || []).map(row => row.data).filter(record => record?.id));
    if (!rows || rows.length < pageSize) return records;
  }
}

export async function readRecord(kind, id) {
  const query = new URLSearchParams({
    select: "data",
    kind: `eq.${collection(kind)}`,
    id: `eq.${id}`,
    limit: "1",
  });
  const rows = await request(`carton_records?${query}`);
  return rows?.[0]?.data || null;
}

export async function writeRecord(kind, record) {
  if (typeof record.id !== "string" || !record.id)
    throw new Error("A Supabase record must have an ID.");
  await request("carton_records?on_conflict=kind%2Cid", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      kind: collection(kind),
      id: record.id,
      factory: record.f || null,
      data: record,
    }]),
  });
}

export async function removeRecord(kind, id) {
  const query = new URLSearchParams({
    kind: `eq.${collection(kind)}`,
    id: `eq.${id}`,
  });
  const rows = await request(`carton_records?${query}`, {
    method: "DELETE",
    headers: { prefer: "return=representation" },
  });
  return Array.isArray(rows) && rows.length > 0;
}

export async function readSettings() {
  const rows = await request("carton_settings?select=data&id=eq.1&limit=1");
  return rows?.[0]?.data || null;
}

export async function writeSettings(settings) {
  await request("carton_settings?on_conflict=id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ id: 1, data: settings }]),
  });
}

export async function checkSupabase() {
  const query = new URLSearchParams({ select: "id", limit: "1" });
  await request(`carton_records?${query}`);
  await request("carton_settings?select=id&limit=1");
}
