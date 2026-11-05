# API source

The root-level `api/handler.js` exposes the Vercel function and forwards
requests to `carton-vercel/api/index.js`. Google Sheets is the primary store
and Firestore is the backup. Users select a plant and enter its password;
Vercel environment variables hold the passwords. See the repository
[README](../README.md) for setup.
