import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "site");
const output = path.join(root, "dist");
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
for (const name of ["index.html", "app.js", "snapshot-policy.js", "url-policy.js", "styles.css", "afg-logo.jpeg", "data.enc"]) {
  await fs.copyFile(path.join(source, name), path.join(output, name));
}
await fs.writeFile(path.join(output, ".nojekyll"), "");
console.log("Built encrypted static dashboard in dist/.");
