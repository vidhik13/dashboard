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

The login names are `ota`, `phc`, `kaduna`, `aba`, and `seasoning`. Noodle accounts are restricted to their own factory; the seasoning account can manage all factories. Login sessions expire after eight hours.