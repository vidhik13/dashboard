import { copyFile, mkdir } from "node:fs/promises";

await mkdir("public", { recursive: true });
await Promise.all([
  copyFile("index.html", "public/index.html"),
  copyFile("dufil-company-logo.png", "public/dufil-company-logo.png"),
]);
