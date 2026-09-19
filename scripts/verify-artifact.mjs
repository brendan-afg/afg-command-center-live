import crypto from "node:crypto";
import fs from "node:fs/promises";

const artifacts = ["index.html", "app.js", "snapshot-policy.js", "url-policy.js", "styles.css", "afg-logo.jpeg", "data.enc"];
for (const artifact of artifacts) {
  const [source, built] = await Promise.all([
    fs.readFile(`site/${artifact}`),
    fs.readFile(`dist/${artifact}`),
  ]);
  const hash = value => crypto.createHash("sha256").update(value).digest("hex");
  if (hash(source) !== hash(built)) throw new Error(`Source/artifact mismatch: ${artifact}`);
}
const actual = (await fs.readdir("dist")).sort();
const expected = [...artifacts, ".nojekyll"].sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Unexpected static artifact set: ${actual.join(", ")}`);
console.log("Static source/artifact parity passed.");
