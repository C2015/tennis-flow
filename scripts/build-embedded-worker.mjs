import fs from "node:fs/promises";

const worker = await fs.readFile("src/worker.js", "utf8");
const files = {
  "/": { type: "text/html; charset=utf-8", body: await fs.readFile("public/index.html", "utf8") },
  "/index.html": { type: "text/html; charset=utf-8", body: await fs.readFile("public/index.html", "utf8") },
  "/styles.css": { type: "text/css; charset=utf-8", body: await fs.readFile("public/styles.css", "utf8") },
  "/app.js": { type: "text/javascript; charset=utf-8", body: await fs.readFile("public/app.js", "utf8") }
};
const marker = "return env.ASSETS.fetch(request);";
if (!worker.includes(marker)) throw new Error("Static asset marker missing from Worker");
const generated = worker.replace(marker, "return serveEmbeddedAsset(request);") + `\n\nconst EMBEDDED_ASSETS = ${JSON.stringify(files)};\nfunction serveEmbeddedAsset(request) {\n  const path = new URL(request.url).pathname;\n  const asset = EMBEDDED_ASSETS[path] || EMBEDDED_ASSETS[\"/\"];\n  return new Response(request.method === \"HEAD\" ? null : asset.body, { headers: { \"content-type\": asset.type, \"cache-control\": path === \"/\" || path.endsWith(\".html\") ? \"no-cache\" : \"public, max-age=3600\" } });\n}\n`;
await fs.mkdir("dist", { recursive: true });
await fs.writeFile("dist/worker.js", generated);
console.log(`Built dist/worker.js (${Buffer.byteLength(generated)} bytes)`);
