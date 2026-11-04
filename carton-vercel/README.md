# API source

The root-level `api/index.js` exposes the Vercel function and forwards requests
to `carton-vercel/api/index.js`. Google Sheets is the primary store and
Firestore is the backup. See the repository [README](../README.md) for Vercel,
Google Sheets, Firebase, and optional Upstash import setup.
