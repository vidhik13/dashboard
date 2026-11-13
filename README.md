# Carton Return Tracker

The website and API deploy together on Vercel. Supabase is the live database
for dispatches, shifts, returns, receipts, and settings.

## Set up Supabase

1. Create a Supabase project.
2. In the Supabase SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql)
   to create the app tables and lock them to server-side access.
3. In **Project Settings → API**, copy the project URL and the `service_role`
   key. Keep the service key private; never put it in browser code or share it.
4. In Vercel **Settings → Environment Variables**, add:
   - `SUPABASE_URL`: the Supabase project URL.
   - `SUPABASE_SERVICE_ROLE_KEY`: the project’s `service_role` key.
5. Keep `AUTH_SECRET` and the separate `AUTH_PASSWORD_ABA`,
   `AUTH_PASSWORD_KADUNA`, `AUTH_PASSWORD_OTA`, `AUTH_PASSWORD_PHC`, and
   `AUTH_PASSWORD_SEASONING` variables configured in Vercel.
6. Apply variables to Production (and Preview if needed), redeploy, then sign
   in as Seasoning and choose **Check Supabase**.

This uses a fresh Supabase database. Existing Google Sheets and legacy Upstash
records are not copied automatically; keep the Google Sheet as a backup until
the new app has been verified.

## Connect Excel with Power Query

The read-only endpoint at `/api/export?kind=...` returns JSON for `dispatch`,
`shifts`, `returns`, or `receipts`. It requires the `x-export-token` header and
does not expose the Supabase service-role key. To enable it, create a separate
random token and add it to Vercel as `EXCEL_EXPORT_TOKEN`; do not reuse an app
login password or a Supabase key. In PowerShell, generate a random token with:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

Copy the output directly to the Vercel variable; do not send it in chat or
commit it to the repository. Redeploy after adding the variable.

In Excel Desktop, create a blank query using **Data → Get Data → From Other
Sources → Blank Query → Advanced Editor**. Replace the example domain and
token, then use this Power Query M query (change `kind` for each table):

```powerquery
let
    Data = Json.Document(
        Web.Contents(
            "https://YOUR-VERCEL-DOMAIN/api/export?kind=dispatch",
            [Headers = [#"x-export-token" = "YOUR_EXCEL_EXPORT_TOKEN"]]
        )
    ),
    Rows = Table.FromRecords(Data)
in
    Rows
```

Name the query, choose **Close & Load**, and repeat for the other three kinds.
Use **Data → Refresh All** to fetch current rows. This is a refreshable snapshot,
not an instant live connection. Excel Desktop supports Power Query refresh;
Excel for the web support depends on the tenant and connector capabilities.
Test refresh in the client your team will use. The query contains the export
token, so only share the workbook with trusted users; the response includes
dispatch, return, and receipt details such as driver names and phone numbers.
Rotate the token in Vercel if the workbook is shared beyond its intended
audience.

## Data and access

The database stores records in `carton_records` and the alert threshold in
`carton_settings`. Shift lines are limited by factory: OTA 1–6, PHC 1–9,
KADUNA 1–6, and ABA 1–2. Shift numbers are 1, 2, and 3.

Factory accounts can access their own records. Seasoning can manage all
factories. OTA dispatch and return forms omit truck, driver, and waybill
details; OTA can view dispatch entries, while Seasoning manages dispatches.
The dashboard shows return totals and rates and carton acceptance MTD/YTD.
Sessions expire after eight hours. To change a password, update the matching
`AUTH_PASSWORD_*` value in Vercel and redeploy.

## Deploy on Vercel

Use the repository root as the project root and the **Other** framework preset.
The checked-in `vercel.json` builds the static site into `public`; Vercel
deploys `api/handler.js` as the `/api/handler` serverless function. No separate
server is needed.
