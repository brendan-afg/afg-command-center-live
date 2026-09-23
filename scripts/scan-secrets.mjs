import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const excluded = new Set([".git", "node_modules", "dist"]);
const excludedFiles = new Set(["pnpm-lock.yaml"]);
const rules = [
  ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["Google API key", /AIza[0-9A-Za-z_-]{30,}/],
  ["GitHub token", /gh[pousr]_[0-9A-Za-z]{30,}/],
  ["service-account private_key field", /["']private_key["']\s*:/],
  ["embedded Drive root identifier", /GOOGLE_DRIVE_FOLDER_ID\s*=\s*["'][A-Za-z0-9_-]{20,}/],
];

async function walk(directory, relative = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (excluded.has(entry.name)) continue;
    const rel = path.posix.join(relative, entry.name);
    if (excludedFiles.has(rel)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await walk(absolute, rel));
    else if (entry.isFile()) results.push({ rel, absolute });
  }
  return results;
}

const violations = [];
for (const file of await walk(root)) {
  const stat = await fs.stat(file.absolute);
  if (stat.size > 2_000_000) continue;
  const content = await fs.readFile(file.absolute, "utf8").catch(() => "");
  for (const [label, pattern] of rules) if (pattern.test(content)) violations.push(`${file.rel}: ${label}`);
}
if (violations.length) {
  console.error(`Secret scan failed:\n${violations.join("\n")}`);
  process.exit(1);
}
console.log("Secret scan passed.");
