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

1. Use the Firebase project and existing `(default)` Firestore database you
   already opened; do not create another database with the same ID.
2. In Firebase Console, open **Authentication → Sign-in method** and enable
   **Email/Password**.
3. In **Authentication → Users**, create one account per dashboard user using
   their email and the password you choose. Password changes and resets are
   managed here; passwords are not stored in the repository or Vercel settings.
4. For each account, copy its Firebase **UID**. In Firestore, create a
   `carton_tracker_users` collection and a document whose document ID is that
   UID. Set these fields:

   - OTA account: `username` = `ota`, `role` = `noodle`, `factory` = `OTA`
   - PHC account: `username` = `phc`, `role` = `noodle`, `factory` = `PHC`
   - KADUNA account: `username` = `kaduna`, `role` = `noodle`, `factory` = `KADUNA`
   - ABA account: `username` = `aba`, `role` = `noodle`, `factory` = `ABA`
   - Seasoning account: `username` = `seasoning`, `role` = `seasoning` (no
     `factory` field)

5. In the associated Google Cloud project, create a service account with the
   **Cloud Datastore User** role and create a JSON key. This server-side
   account reads the role profiles and writes the backup; do not make Firestore
   public.

You can use one Google Cloud service account for both services if it belongs to
the Firebase project's Google Cloud project: share the spreadsheet with that
account and use the same service-account key for Sheets and Firebase. If the
Sheets and Firebase projects are different, use the Sheets account JSON for
`GOOGLE_SERVICE_ACCOUNT_JSON` and credentials from the Firebase project's
service account for the three `FIREBASE_*` Admin variables.

## Deploy on Vercel

1. Import this repository into Vercel. Use the repository root as the project
   root and the **Other** framework preset. The checked-in `vercel.json` builds
   the static site into `public`; Vercel deploys `api/index.js` as the `/api`
   serverless function. No separate server is needed.
2. Add these environment variables to the Vercel project for Production. Add
   them to Preview only if you intend preview deployments to use the same
   production spreadsheet and Firebase backup:

   - `GOOGLE_SHEETS_SPREADSHEET_ID`: the spreadsheet ID.
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: the full Google service-account JSON used
     for Sheets access.
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`:
     Firebase service-account fields. Store the private key as a secret and
     preserve its newlines (or use literal `\n` sequences).
   - `FIREBASE_WEB_API_KEY`: the Firebase project's Web API key (used by the
     server to check email/password with Firebase Authentication).
   - `AUTH_SECRET`: a long, random signing key.

3. Use a new `AUTH_SECRET` when moving from the old password setup; this
   invalidates any existing sessions. Deploy. Sign in as Seasoning and choose
   **Check Google Sheets** to verify Sheets access, then **Sync Firebase backup**
   to populate and verify the initial backup.

Users sign in with the email and password created in Firebase Authentication.
Noodle accounts can access only their own factory's shift and return-truck
records. Seasoning can manage all factories. Sessions expire after eight hours.
For a password change or reset, update the user in Firebase Authentication;
do not add passwords to Vercel environment variables or source files.

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
