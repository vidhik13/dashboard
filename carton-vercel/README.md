# API source

The root-level `api/handler.js` exposes the Vercel function and forwards
requests to `carton-vercel/api/index.js`. Supabase stores application records.
Users select a plant and enter its password; Vercel environment variables hold
the Supabase service key and plant passwords. See the repository
[README](../README.md) for setup, including the token-protected read-only Excel
export endpoint at `/api/export`.
