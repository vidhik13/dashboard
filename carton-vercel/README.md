# Dashboard API

The API source in this folder is deployed as a Netlify Function through `netlify/functions/api.js`.

For Netlify deployment, required passwords, Redis setup, and SharePoint live-workbook configuration, see the repository [README](../README.md).

The API uses Redis as the source of truth and synchronizes dashboard log records to the five uploaded SharePoint workbooks when Microsoft Graph is configured.
