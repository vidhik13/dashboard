# Carton Return Tracker

The website and API deploy together on Vercel. Google Sheets is the primary
database, and Firebase Firestore is a separate backup. Dashboard data is always
saved to Sheets first; successful creates, edits, deletes, and settings changes
are then copied to Firestore. A Seasoning-only **Sync Firebase backup** action
reconciles the backup with the current Sheets data.

The Firebase backup uses the `carton_tracker_backup_dispatch`,
`carton_tracker_backup_shifts`, `carton_tracker_backup_returns`,
`carton_tracker_backup_receipts`, and `carton_tracker_backup_settings`
collections. A full backup sync replaces records only within these dedicated
collections; it does not touch other Firestore collections.

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

## Prepare Firebase backup

Firebase Authentication is not used for login. Firestore is only a data backup.
In the associated Google Cloud project, create a service account with the
**Cloud Datastore User** role and create a JSON key. Do not make Firestore
public.

You can use one Google Cloud service account for both services if it belongs to
the Firebase project's Google Cloud project: share the spreadsheet with that
account and use the same service-account key for Sheets and Firebase. If the
projects are different, use the Sheets account JSON for
`GOOGLE_SERVICE_ACCOUNT_JSON` and credentials from the Firebase project's
service account for the three `FIREBASE_*` Admin variables.

## Deploy on Vercel

1. Import this repository into Vercel. Use the repository root as the project
   root and the **Other** framework preset. The checked-in `vercel.json` builds
   the static site into `public`; Vercel deploys `api/handler.js` as the
   `/api/handler` serverless function. No separate server is needed.
2. Add these environment variables to the Vercel project for Production. Add
   them to Preview only if you intend preview deployments to use the same
   production spreadsheet and Firebase backup:

   - `GOOGLE_SHEETS_SPREADSHEET_ID`: the spreadsheet ID.
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: the full Google service-account JSON used
     for Sheets access.
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`:
     Firebase service-account fields. Store the private key as a secret and
     preserve its newlines (or use literal `\n` sequences).
   - `AUTH_SECRET`: a long, random signing key.
   - `AUTH_PASSWORD_ABA`, `AUTH_PASSWORD_KADUNA`, `AUTH_PASSWORD_OTA`,
     `AUTH_PASSWORD_PHC`, and `AUTH_PASSWORD_SEASONING`: separate, strong
     passwords for each plant. Keep them private and do not put them in the
     source code.

3. Use a new `AUTH_SECRET` to invalidate existing sessions, then redeploy.
   Sign in as Seasoning and choose **Check Google Sheets** to verify Sheets
   access, then **Sync Firebase backup** to populate the initial backup.

Users select their plant and enter its password. Factory accounts can access
only their own shift and return-truck records. Seasoning can manage all
factories. Sessions expire after eight hours. To change a password, update the
matching `AUTH_PASSWORD_*` value in Vercel and redeploy.

## Import existing Upstash records

If existing records are still in Upstash, temporarily add these Vercel
environment variables:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Redeploy and, as Seasoning, choose **Import existing Upstash data**. This
one-time import preserves IDs, converts legacy `OA` factory values to `OTA`, and
merges matching IDs into Sheets. It then syncs the current Sheets data to the
Firebase backup. Confirm both stores before removing the Upstash variables and
redeploying.

## Backup behavior

Google Sheets is the live source of truth; Firebase is a recovery copy, not a
second live database. If a Sheets write succeeds but its Firebase backup write
fails, the dashboard reports the backup warning and keeps the primary record.
Seasoning can use **Sync Firebase backup** to reconcile it later. The dashboard
does not read from the backup automatically; do not edit the backup collections
directly.

Sheets is suitable for a small team and modest usage. It is not transactional,
so simultaneous edits or high traffic can cause conflicts or hit Google API
quotas.
