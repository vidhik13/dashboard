# Carton Return Tracker

## Login setup

Configure these environment variables in the Vercel project before deployment:

- `AUTH_SECRET`: a long, random signing secret used for eight-hour login sessions.
- `NOODLE_PASSWORD_OTA`
- `NOODLE_PASSWORD_PHC`
- `NOODLE_PASSWORD_KADUNA`
- `NOODLE_PASSWORD_ABA`
- `SEASONING_PASSWORD`

The login names are `ota`, `phc`, `kaduna`, `aba`, and `seasoning`. Give each account a unique password. Keep the passwords and signing secret private and rotate them by changing the corresponding environment variable.

The app also requires the existing Upstash Redis environment variables: `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (or Vercel KV equivalents `KV_REST_API_URL` and `KV_REST_API_TOKEN`).

## Access

- Each noodle login can see its own factory's dashboard, dispatches, shifts, returns, and receipts. It can submit shift logs and return-truck records only for its own factory; dispatches and receipts are read-only for noodle accounts.
- Seasoning can see all factories and can create dispatches, shift logs, return-truck records, receipts, and update the alert threshold.

Factory filtering and write permissions are enforced by the API, not only by the browser interface.
