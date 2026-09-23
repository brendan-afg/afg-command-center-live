import crypto from "node:crypto";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

const artifacts = ["index.html", "app.js", "snapshot-policy.js", "url-policy.js", "styles.css", "afg-logo.png", "data.json"];
const buildVersion = process.env.AFG_SOURCE_COMMIT || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
for (const artifact of artifacts) {
  const [sourceBytes, built] = await Promise.all([
    fs.readFile(`site/${artifact}`),
    fs.readFile(`dist/${artifact}`),
  ]);
  const source = ["index.html", "app.js"].includes(artifact)
    ? Buffer.from(sourceBytes.toString("utf8").replaceAll("__BUILD_VERSION__", buildVersion))
    : sourceBytes;
  const hash = value => crypto.createHash("sha256").update(value).digest("hex");
  if (hash(source) !== hash(built)) throw new Error(`Source/artifact mismatch: ${artifact}`);
}
const actual = (await fs.readdir("dist")).sort();
const expected = [...artifacts, ".nojekyll"].sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Unexpected static artifact set: ${actual.join(", ")}`);
const snapshotText = await fs.readFile("dist/data.json", "utf8");
for (const [label, pattern] of [
  ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["service-account private_key field", /["']private_key["']\s*:/],
  ["service-account private_key_id field", /["']private_key_id["']\s*:/],
  ["OAuth client secret", /["']client_secret["']\s*:/],
  ["OAuth access token", /["']access_token["']\s*:/],
  ["OAuth refresh token", /["']refresh_token["']\s*:/],
  ["Google OAuth bearer token", /ya29\.[0-9A-Za-z_-]{20,}/],
  ["authorization bearer value", /authorization["']?\s*[:=]\s*["']?bearer\s+[0-9A-Za-z._-]{20,}/i],
  ["Google API key", /AIza[0-9A-Za-z_-]{30,}/],
  ["GitHub token", /gh[pousr]_[0-9A-Za-z]{30,}/],
]) if (pattern.test(snapshotText)) throw new Error(`Public snapshot contains ${label}`);
console.log("Static source/artifact parity passed.");
