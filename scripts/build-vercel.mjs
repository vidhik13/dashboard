import { copyFile, mkdir } from "node:fs/promises";

await mkdir("public", { recursive: true });
await Promise.all([
  copyFile("index.html", "public/index.html"),
  copyFile("dufil-logo.png", "public/dufil-logo.png"),
]);
