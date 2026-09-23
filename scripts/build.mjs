import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const source = path.join(root, "site");
const output = path.join(root, "dist");
const buildVersion = process.env.AFG_SOURCE_COMMIT || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(buildVersion)) throw new Error("Build version must be an exact source commit");
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
for (const name of ["snapshot-policy.js", "url-policy.js", "styles.css", "afg-logo.png", "data.json"]) {
  await fs.copyFile(path.join(source, name), path.join(output, name));
}
for (const name of ["index.html", "app.js"]) {
  const content = await fs.readFile(path.join(source, name), "utf8");
  await fs.writeFile(path.join(output, name), content.replaceAll("__BUILD_VERSION__", buildVersion));
}
await fs.writeFile(path.join(output, ".nojekyll"), "");
console.log(`Built link-only static dashboard in dist/ from ${buildVersion}.`);
