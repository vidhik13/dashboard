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

## Automatic Excel workbooks

The app keeps Redis as its live database and mirrors records to five `.xlsx` files in a designated OneDrive for Business account: one workbook for each factory and one all-factory workbook for Seasoning. Each workbook has `Dispatch`, `Shifts`, `Returns`, and `Receipts` tabs. Factory workbooks include only that factory's records; the Seasoning workbook includes all factories. Old `OA` records are labeled `OTA` in the exports.

Before enabling automatic sync, a Microsoft 365 administrator must register an app in Microsoft Entra ID, add the Microsoft Graph **Application** permission `Files.ReadWrite.All`, and grant admin consent. This permission is broad across the tenant; configuring a dedicated OneDrive destination does not narrow the permission itself. Have your administrator review and approve this access before proceeding.

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), go to **Identity → Applications → App registrations → New registration**. Name the app (for example, `Carton Return Tracker`) and choose **Accounts in this organizational directory only**.
2. Open the registration's **Overview** and note the **Directory (tenant) ID** and **Application (client) ID**.
3. Go to **Certificates & secrets → Client secrets → New client secret**. Create a secret and copy its **Value** immediately; it is not shown again.
4. Go to **API permissions → Add a permission → Microsoft Graph → Application permissions**. Add `Files.ReadWrite.All`, then select **Grant admin consent**. The Microsoft 365 administrator must approve this.
5. In Netlify, open the site's **Environment variables** and add these values for the **Production** context. If Netlify shows scopes, include **Functions**. Never put the client secret in Git or the dashboard HTML.
   - `MICROSOFT_TENANT_ID`: the Entra Directory (tenant) ID.
   - `MICROSOFT_CLIENT_ID`: the app's Application (client) ID.
   - `MICROSOFT_CLIENT_SECRET`: the client-secret **Value** created for the app.
   - `MICROSOFT_ONEDRIVE_USER`: the dedicated OneDrive account's user principal name (email address). Its OneDrive must already be provisioned.
6. Redeploy. Log in as Seasoning and select **Sync Excel workbooks** once to create/populate the five workbooks from existing records. New entries, edits, and deletions then update the relevant factory workbook and the all-factory Seasoning workbook.

If a record is saved but the Excel update fails, the dashboard reports the sync error; Seasoning can retry with **Sync Excel workbooks**. The workbooks mirror the current dashboard records: edits update the matching row and deleted records are removed from the workbook. They are not an immutable audit archive. The workbooks are created in the OneDrive account's root. Share each factory workbook only with that factory's intended users, and share the Seasoning workbook only with Seasoning users. Excel file sharing controls access; the dashboard login does not automatically grant OneDrive permissions.
