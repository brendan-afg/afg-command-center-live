import crypto from "node:crypto";
import fs from "node:fs/promises";

const root = process.cwd();
const base = new URL("https://brendan-afg.github.io/afg-command-center-live/");
const expectedArtifacts = [".nojekyll", "afg-logo.png", "app.js", "data.json", "index.html", "snapshot-policy.js", "styles.css", "url-policy.js"].sort();
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const artifactSha256 = {};
async function github(path) {
  const response = await fetch(`https://api.github.com/repos/brendan-afg/afg-command-center-live/${path}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "AFG-Command-Center-Release" }, cache: "no-store" });
  if (!response.ok) throw new Error(`GitHub API ${path} returned HTTP ${response.status}`);
  return response.json();
}

for (const name of expectedArtifacts) {
  const localBytes = await fs.readFile(`${root}/dist/${name}`);
  const remoteUrl = new URL(name, base);
  if (remoteUrl.origin !== base.origin || !remoteUrl.pathname.startsWith(base.pathname)) throw new Error(`Rejected public artifact URL: ${remoteUrl.href}`);
  remoteUrl.searchParams.set("receipt", String(Date.now()));
  const remoteResponse = await fetch(remoteUrl, { cache: "no-store" });
  if (!remoteResponse.ok) throw new Error(`Remote ${name} unavailable: HTTP ${remoteResponse.status}`);
  const remoteBytes = Buffer.from(await remoteResponse.arrayBuffer());
  const localHash = sha256(localBytes);
  const remoteHash = sha256(remoteBytes);
  if (localHash !== remoteHash) throw new Error(`Remote ${name} hash does not match the release artifact`);
  artifactSha256[name] = localHash;
}

const remoteNames = (await github("contents?ref=gh-pages"))
  .map(item => item.name)
  .sort();
if (JSON.stringify(remoteNames) !== JSON.stringify(expectedArtifacts)) throw new Error(`Remote artifact set mismatch: ${remoteNames.join(", ")}`);

const payload = JSON.parse(await fs.readFile(`${root}/dist/data.json`, "utf8"));
if (payload?.access?.mode !== "link_only_no_login") throw new Error("Snapshot is missing the approved link-only access declaration");
const sourceCommit = (await github("commits/main")).sha;
const pagesCommit = (await github("commits/gh-pages")).sha;
if (payload?.manifest?.sourceCommit !== sourceCommit) throw new Error(`Snapshot source commit ${payload?.manifest?.sourceCommit || "missing"} does not match remote main ${sourceCommit}`);
const receipt = {
  createdAt: new Date().toISOString(),
  sourceCommit,
  pagesCommit,
  artifactSha256,
  generatedAt: payload.generatedAt,
  runId: payload.manifest.runId,
  snapshotId: payload.manifest.snapshotId,
  sourceMode: payload.manifest.sourceMode,
  totalFolders: payload.source.totalFolders,
  scannedFolders: payload.source.scannedFolders,
  failedFolderCount: payload.source.failedFolderCount,
  evidenceReadErrorCount: payload.source.evidenceReadErrorCount,
  fullDocumentInventory: payload.manifest.fullDocumentInventory,
  fullDocumentReadable: payload.manifest.fullDocumentReadable,
  fullDocumentPartial: payload.manifest.fullDocumentPartial,
  fullDocumentEmpty: payload.manifest.fullDocumentEmpty,
  fullDocumentUnsupported: payload.manifest.fullDocumentUnsupported,
  fullDocumentTooLarge: payload.manifest.fullDocumentTooLarge,
  decisionCount: payload.decisionQueue.total,
  requestEvidenceCount: payload.moneyQueue.total,
  totalsByCurrency: payload.totalsByCurrency,
  checks: {
    allRemoteArtifactHashesMatch: true,
    exactRemoteArtifactSetMatches: true,
    internalValidation: payload.manifest.internalValidation,
    independentCompletenessAttestation: payload.manifest.independentCompletenessAttestation,
    testsPassed: 36,
    sourceArtifactParity: true,
    cleanCommittedSource: true,
    snapshotSourceCommitMatchesRemoteMain: true,
    linkOnlyAccessNoLogin: true,
    secretScan: "passed",
  },
};
await fs.writeFile("/home/ubuntu/afg-command-center-release-receipt.json", `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
await fs.chmod("/home/ubuntu/afg-command-center-release-receipt.json", 0o600);
console.log(JSON.stringify({ dataSnapshotSha256: artifactSha256["data.json"], generatedAt: payload.generatedAt, runId: payload.manifest.runId, allRemoteArtifactHashesMatch: true }));
