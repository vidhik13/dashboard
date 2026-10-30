# Carton Return Tracker

## Deploying with Netlify

Connect this GitHub repository to Netlify and use the repository root as the base directory. The included `netlify.toml` builds the dashboard into `dist`, publishes only that folder, and routes `/api` requests to the Netlify Function. The spreadsheets and source files in the repository are not published as website files.

In the Netlify site, open **Site configuration → Environment variables** and add these variables. Select the **Production** deploy context. If your plan shows variable scopes, include **Functions** so the API can read them:

- `AUTH_SECRET`: a long, random signing key. Generate one in Windows PowerShell:

  ```powershell
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
  ```
- `NOODLE_PASSWORD_OTA`
- `NOODLE_PASSWORD_PHC`
- `NOODLE_PASSWORD_KADUNA`
- `NOODLE_PASSWORD_ABA`
- `SEASONING_PASSWORD`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Give each account a unique password. Keep the passwords, signing key, and Redis token private; do not put them in the HTML or commit them to Git. After saving the variables, trigger a new deploy so the function receives them.

The login names are `ota`, `phc`, `kaduna`, `aba`, and `seasoning`. Noodle accounts are restricted to their own factory and can edit or delete their own shift and return-truck logs. The seasoning account can manage, edit, and delete logs for all factories. Deleting a return-truck log also deletes its associated sorting receipt, if it has one. Login sessions expire after eight hours.

## SharePoint live Excel workbooks

Redis remains the dashboard's live database. The app updates five Excel workbooks that you upload to the default **Documents** library of a SharePoint site: one workbook per factory plus one all-factory Seasoning workbook. Each workbook has `Dispatch`, `Shifts`, `Returns`, and `Receipts` tabs. Factory workbooks contain only that factory's records; the Seasoning workbook contains all factories. Old `OA` entries are exported as `OTA`.

### Prepare the workbooks

Create and upload five `.xlsx` files into the SharePoint site's default Documents library (or one folder within it). Use these exact filenames:

- `Carton Return Tracker - OTA.xlsx`
- `Carton Return Tracker - PHC.xlsx`
- `Carton Return Tracker - KADUNA.xlsx`
- `Carton Return Tracker - ABA.xlsx`
- `Carton Return Tracker - Seasoning.xlsx`

They can be blank workbooks; the app creates or replaces the four log tabs and fills them from Redis. Keep any unrelated tabs separate—the app only changes those four named tabs. Changes to dashboard records update the corresponding workbook automatically. Edits replace the matching data and deletions remove it; the workbooks are live mirrors, not immutable audit archives. Share each factory workbook only with its intended factory users and the Seasoning workbook only with Seasoning users.

### Connect Netlify to the SharePoint site

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), register an app for **this organizational directory only**. Save the **Directory (tenant) ID** and **Application (client) ID** from the app's Overview.
2. Under **Certificates & secrets**, create a client secret and copy its **Value** immediately. Store it only as a Netlify environment variable.
3. Under **API permissions**, add Microsoft Graph **Application** permission `Sites.Selected` and grant admin consent.
4. Have a Microsoft 365 administrator explicitly grant this app the **write** role on the specific SharePoint site containing the workbooks. `Sites.Selected` does not grant access to any site until the site-level permission is assigned. This is narrower than tenant-wide `Files.ReadWrite.All`.
5. In Netlify, add the following variables for **Production** and the **Functions** scope (if scopes are shown):
   - `MICROSOFT_TENANT_ID`: Entra Directory (tenant) ID.
   - `MICROSOFT_CLIENT_ID`: Application (client) ID.
   - `MICROSOFT_CLIENT_SECRET`: client-secret **Value**.
   - `SHAREPOINT_SITE_URL`: full site URL, e.g. `https://contoso.sharepoint.com/sites/CartonReturns`.
   - `SHAREPOINT_FOLDER_PATH`: optional folder path inside the site's default Documents library; leave blank if the five files are in the library root.
6. Redeploy. Sign in as Seasoning and click **Sync Excel workbooks** once to populate the uploaded files with existing records. After that, new, edited, and deleted dashboard records update the relevant SharePoint workbooks.

If an Excel update fails, the dashboard reports that the record was still saved in Redis and shows a sync error. Seasoning can retry the full sync from the dashboard. The implementation uses Microsoft Graph to download each existing workbook, update the four log tabs, and upload the workbook back to SharePoint. Avoid editing these same tabs in Excel at the same time as a dashboard sync.
