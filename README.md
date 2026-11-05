# Carton Return Tracker

The website and API deploy together on Vercel. Google Sheets is the only
database used by the app. All dashboard records and settings are read from and
saved to Google Sheets.

## Prepare Google Sheets

1. Create a Google spreadsheet.
2. In Google Cloud Console, enable the Google Sheets API and create a service
   account.
3. Create a JSON key for the service account and keep it private.
4. Share the spreadsheet with the service account's `client_email`, giving it
   **Editor** access. Keep the spreadsheet private.
5. Copy the spreadsheet ID from its URL (between `/d/` and `/edit`).

The app automatically creates the `Dispatch`, `Shifts`, `Returns`, `Receipts`,
and `Settings` tabs with the required headers.

The column headings are descriptive and the app keeps the existing column
order: Dispatch uses Record ID, Factory, Truck Number, Waybill Number, Cartons
Sent, Dispatch Date/Time, and Estimated Arrival (ETA); Shifts uses Record ID,
Factory, Shift Date, Shift, Total Cartons Used, Good Cartons, Bad Cartons, and
Line. The app accepts shift numbers 1, 2, and 3, and converts existing A/B/C
shift values to 1/2/3. Line is appended to the existing Shifts columns so
current records remain aligned; older entries have a blank Line until updated.
Returns uses Record ID, Factory, Truck Number, Driver Name, Driver Phone,
Waybill Number, Cartons on Truck, Dispatch Date/Time, and Estimated Arrival
(ETA); Receipts uses Record ID, Return Record ID, Received Date/Time, Accepted
Cartons, and Rejected Cartons. Settings uses Setting and Value. Deploying this
change updates the heading row automatically without moving or deleting data.

## Deploy on Vercel

1. Import this repository into Vercel. Use the repository root as the project
   root and the **Other** framework preset. The checked-in `vercel.json` builds
   the static site into `public`; Vercel deploys `api/handler.js` as the
   `/api/handler` serverless function. No separate server is needed.
2. Add these environment variables to the Vercel project for Production. Add
   them to Preview only if you intend preview deployments to use the same
   production spreadsheet:

   - `GOOGLE_SHEETS_SPREADSHEET_ID`: the spreadsheet ID.
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: the full Google service-account JSON used
     for Sheets access.
   - `AUTH_SECRET`: a long, random signing key.
   - `AUTH_PASSWORD_ABA`, `AUTH_PASSWORD_KADUNA`, `AUTH_PASSWORD_OTA`,
     `AUTH_PASSWORD_PHC`, and `AUTH_PASSWORD_SEASONING`: separate, strong
     passwords for each plant. Keep them private and do not put them in the
     source code.

3. Use a new `AUTH_SECRET` to invalidate existing sessions, then redeploy.
   Sign in as Seasoning and choose **Check Google Sheets** to verify access.

Users select their plant and enter its password. Factory accounts can access
only their own shift and return-truck records. Seasoning can manage all
factories. OTA also has a simplified Carton dispatch page that records date,
time, and quantity without truck or waybill details. OTA's return tracking
similarly records only date, time, and returned carton quantity. Dashboard
cards show each factory's monthly and year-to-date return percentage, calculated
as returned cartons divided by cartons sent in that period; a period with no
cartons sent displays a dash. They also show carton acceptance MTD/YTD,
calculated as cartons accepted at Seasoning during the period divided by
cartons dispatched by Seasoning during the period; a period with no dispatches
displays a dash. Sessions expire after eight hours. To change a password,
update the matching `AUTH_PASSWORD_*` value in Vercel and redeploy.

## Import existing Upstash records

If existing records are still in Upstash, temporarily add these Vercel
environment variables:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Redeploy and, as Seasoning, choose **Import existing Upstash data**. This
one-time import preserves IDs, converts legacy `OA` factory values to `OTA`, and
merges matching IDs into Sheets. Confirm the imported records, then remove the
Upstash variables and redeploy.

Sheets is suitable for a small team and modest usage. It is not transactional,
so simultaneous edits or high traffic can cause conflicts or hit Google API
quotas.
