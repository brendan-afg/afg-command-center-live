import crypto from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { assertPublishableSnapshot, buildDecisionQueue, buildMoneyQueue, buildRequestEvidenceTotals, encryptPayload, filterDashboardDeals } from "../scripts/generate-dashboard";
import { buildDriveSnapshotFromPublicInputs, parseExactAmountValue } from "../server/driveSync";
import { buildBlueOceanOpportunities, buildCompanyStrategy, buildFileAdvice, buildTodayPlan } from "../scripts/advisory-engine";
// @ts-expect-error Browser policy is intentionally plain ESM copied directly to the static site.
import { evaluateSnapshot } from "../site/snapshot-policy.js";
// @ts-expect-error Browser URL policy is intentionally plain ESM copied directly to the static site.
import { safeDriveFolderUrl } from "../site/url-policy.js";

function decrypt(envelope: ReturnType<typeof encryptPayload>, privateJwk: crypto.JsonWebKey) {
  const privateKey = crypto.createPrivateKey({ key: privateJwk, format: "jwk" });
  const ephemeralPublicKey = crypto.createPublicKey({ key: envelope.ephemeralPublicKey, format: "jwk" });
  const secret = crypto.diffieHellman({ privateKey, publicKey: ephemeralPublicKey });
  const aesKey = Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.from(envelope.salt, "base64"), Buffer.from("AFG Dashboard Data v2"), 32));
  const packed = Buffer.from(envelope.ciphertext, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(packed.subarray(packed.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(packed.subarray(0, -16)), decipher.final()]).toString("utf8"));
}

function keyPair() {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { publicJwk: pair.publicKey.export({ format: "jwk" }), privateJwk: pair.privateKey.export({ format: "jwk" }) };
}

function folder(id: string, name: string, files: Array<{ id: string; name: string; mimeType: string; modifiedTime: string }>, evidenceTextByFileId: Record<string, string>) {
  const modifiedTime = files.map(file => file.modifiedTime).sort().at(-1) || "2026-09-19T00:00:00.000Z";
  return {
    folder: { id, name, mimeType: "application/vnd.google-apps.folder", modifiedTime },
    files,
    evidenceTextByFileId,
  };
}

function validBrowserSnapshot(generatedAt: string, businessDateEastern: string) {
  return {
    generatedAt,
    businessDateEastern,
    manifest: { sourceMode: "authenticated_service_account_drive_api", internalValidation: "passed", runId: "run-1", snapshotId: "snap-1" },
    source: { connection: "fresh_snapshot", totalFolders: 192, scannedFolders: 192, failedFolderCount: 0, evidenceReadErrorCount: 0, snapshotId: "snap-1" },
  };
}

describe("encrypted dashboard artifact", () => {
  it("round-trips with the recipient private key", () => {
    const { publicJwk, privateJwk } = keyPair();
    const payload = { folders: 192, disclosure: "client-stated—not approved" };
    expect(decrypt(encryptPayload(payload, publicJwk), privateJwk)).toEqual(payload);
  });

  it("cannot be opened with a different private key", () => {
    const recipient = keyPair();
    expect(() => decrypt(encryptPayload({ private: true }, recipient.publicJwk), keyPair().privateJwk)).toThrow();
  });

  it("publishes no recipient private scalar", () => {
    const recipient = keyPair();
    const encrypted = encryptPayload({ safe: true }, recipient.publicJwk);
    expect(encrypted.ephemeralPublicKey.d).toBeUndefined();
    expect(recipient.publicJwk.d).toBeUndefined();
  });

  it("rejects a tampered encrypted payload", () => {
    const recipient = keyPair();
    const encrypted = encryptPayload({ private: true }, recipient.publicJwk);
    const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` };
    expect(() => decrypt(tampered, recipient.privateJwk)).toThrow();
  });
});

describe("browser security policy", () => {
  it("allows only canonical Google Drive folder URLs", () => {
    expect(safeDriveFolderUrl("https://drive.google.com/drive/folders/abc_DEF-123")).toBe("https://drive.google.com/drive/folders/abc_DEF-123");
    for (const value of [
      "http://drive.google.com/drive/folders/abc",
      "https://docs.google.com/viewer?url=https://evil.example",
      "https://drive.google.com.evil.example/drive/folders/abc",
      "https://user:pass@drive.google.com/drive/folders/abc",
      "https://drive.google.com:444/drive/folders/abc",
      "https://drive.google.com/file/d/abc/view",
      "javascript:alert(1)",
    ]) expect(safeDriveFolderUrl(value)).toBe("#");
  });

  it("clears fragment and key fields and hides file views while locked", () => {
    const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
    expect(app).not.toMatch(/value\s*=\s*hashKey/);
    expect(app).toMatch(/history\.replaceState\(null, "", `\$\{location\.pathname\}\$\{location\.search\}`\); unlock\(hashKey\)/);
    expect(app).toMatch(/#access-key"\)\.value = ""/);
    expect(app).toMatch(/Files are hidden because the information is not current/);
    expect(app).toMatch(/if \(operatingState\.locked\) return/);
    expect(app).toMatch(/Shared-link access/);
  });
});

describe("authenticated fail-closed publication", () => {
  it("rejects folder, evidence, or partial-snapshot failures", () => {
    const base = { totalFolders: 192, scannedFolders: 192, snapshotId: "snap-1" };
    expect(() => assertPublishableSnapshot({ ...base, failedFolderCount: 1, evidenceReadErrorCount: 0, connection: "fresh_snapshot" })).toThrow(/Refusing to publish/);
    expect(() => assertPublishableSnapshot({ ...base, failedFolderCount: 0, evidenceReadErrorCount: 1, connection: "fresh_snapshot" })).toThrow(/Refusing to publish/);
    expect(() => assertPublishableSnapshot({ ...base, failedFolderCount: 0, evidenceReadErrorCount: 0, connection: "partial_snapshot" })).toThrow(/Refusing to publish/);
    expect(() => assertPublishableSnapshot({ ...base, scannedFolders: 191, failedFolderCount: 0, evidenceReadErrorCount: 0, connection: "fresh_snapshot" })).toThrow(/Refusing to publish/);
    expect(() => assertPublishableSnapshot({ ...base, failedFolderCount: 0, evidenceReadErrorCount: 0, connection: "fresh_snapshot" }, "anonymous_public_share")).toThrow(/Refusing to publish/);
  });

  it("accepts only an error-free authenticated parser result", () => {
    expect(() => assertPublishableSnapshot({ totalFolders: 192, scannedFolders: 192, snapshotId: "snap-1", failedFolderCount: 0, evidenceReadErrorCount: 0, connection: "fresh_snapshot" })).not.toThrow();
  });

  it("contains no anonymous Drive scraper or hard-coded root identifier", () => {
    const source = fs.readFileSync(new URL("../scripts/generate-dashboard.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/embeddedfolderview|ROOT_FOLDER_ID/);
    expect(source).toMatch(/syncDriveSnapshot/);
  });
});

describe("snapshot decision-use lock", () => {
  it("allows a current authenticated manifest before and after 5 a.m.", () => {
    const data = validBrowserSnapshot("2026-09-19T09:10:00.000Z", "2026-09-19");
    expect(evaluateSnapshot(data, new Date("2026-09-19T10:00:00.000Z")).locked).toBe(false);
  });

  it("locks a prior-Eastern-date artifact after 5 a.m.", () => {
    const data = validBrowserSnapshot("2026-09-19T02:46:00.000Z", "2026-09-18");
    const result = evaluateSnapshot(data, new Date("2026-09-19T12:00:00.000Z"));
    expect(result.locked).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/current Eastern business date/);
  });

  it("locks any artifact older than 20 hours or with a mismatched manifest", () => {
    const old = validBrowserSnapshot("2026-09-18T01:00:00.000Z", "2026-09-18");
    expect(evaluateSnapshot(old, new Date("2026-09-19T02:00:00.000Z")).reasons.join(" ")).toMatch(/20-hour/);
    const mismatch = validBrowserSnapshot("2026-09-19T09:10:00.000Z", "2026-09-19");
    mismatch.manifest.snapshotId = "different";
    expect(evaluateSnapshot(mismatch, new Date("2026-09-19T10:00:00.000Z")).locked).toBe(true);
  });

  it("locks future-dated artifacts and same-day artifacts generated before the 5 a.m. deadline", () => {
    const future = validBrowserSnapshot("2026-09-20T10:00:00.000Z", "2026-09-20");
    expect(evaluateSnapshot(future, new Date("2026-09-19T10:00:00.000Z")).reasons.join(" ")).toMatch(/future/);
    const beforeFive = validBrowserSnapshot("2026-09-19T08:45:00.000Z", "2026-09-19");
    expect(evaluateSnapshot(beforeFive, new Date("2026-09-19T12:00:00.000Z")).reasons.join(" ")).toMatch(/post-5:00/);
  });
});

describe("amount evidence semantics", () => {
  it("rejects estimates and unresolved multi-currency fields", () => {
    expect(parseExactAmountValue("estimated USD 1 million", "", "test")).toBeNull();
    expect(parseExactAmountValue("USD 1 million CAD", "", "test")).toBeNull();
    expect(parseExactAmountValue("USD 1 million", "", "test")?.amount).toBe(1_000_000);
  });

  it("does not let a newer medium-confidence summary override structured request evidence", () => {
    const snapshot = buildDriveSnapshotFromPublicInputs([folder("newer", "Newer Evidence", [
      { id: "q", name: "qualification-snapshot.json", mimeType: "application/json", modifiedTime: "2026-09-17T00:00:00.000Z" },
      { id: "s", name: "conversation-summary.txt", mimeType: "text/plain", modifiedTime: "2026-09-18T00:00:00.000Z" },
    ], {
      q: JSON.stringify({ qualificationDetails: { tr_capital_ask: "USD 2 million" } }),
      s: "Capital requested: USD 9 million.",
    })], 0, 1, "2026-09-19T00:00:00.000Z");
    expect(snapshot.deals[0]).toMatchObject({ status: "needs_review", amount: null, minimumScreen: "amount_unavailable" });
  });

  it("falls back to a summary when a structured snapshot has no exact value", () => {
    const snapshot = buildDriveSnapshotFromPublicInputs([folder("fallback", "Fallback", [
      { id: "q", name: "qualification-snapshot.json", mimeType: "application/json", modifiedTime: "2026-09-18T00:00:00.000Z" },
      { id: "s", name: "conversation-summary.txt", mimeType: "text/plain", modifiedTime: "2026-09-17T00:00:00.000Z" },
    ], { q: JSON.stringify({ qualificationDetails: {} }), s: "Capital requested: USD 4 million." })], 0, 1, "2026-09-19T00:00:00.000Z");
    expect(snapshot.deals[0].amount).toBe(4_000_000);
  });

  it("routes same-time conflicting exact values to human review and out of money screening", () => {
    const timestamp = "2026-09-18T00:00:00.000Z";
    const snapshot = buildDriveSnapshotFromPublicInputs([folder("conflict", "Conflict", [
      { id: "q", name: "qualification-snapshot.json", mimeType: "application/json", modifiedTime: timestamp },
      { id: "s", name: "conversation-summary.txt", mimeType: "text/plain", modifiedTime: timestamp },
    ], { q: JSON.stringify({ qualificationDetails: { tr_capital_ask: "USD 2 million" } }), s: "Capital requested: USD 9 million." })], 0, 1, "2026-09-19T00:00:00.000Z");
    expect(snapshot.deals[0]).toMatchObject({ status: "needs_review", amount: null, minimumScreen: "amount_unavailable" });
    expect(buildDecisionQueue(snapshot.deals).total).toBe(1);
    expect(buildMoneyQueue(snapshot.deals).total).toBe(0);
  });
});

describe("duplicate and queue integrity", () => {
  it("retains exactly one provisional primary and holds only the twin", () => {
    const timestamp = "2026-09-19T00:00:00.000Z";
    const input = (id: string, name: string, amount: string) => folder(id, `${name} - shared@example.com`, [
      { id: `${id}-q`, name: "qualification-snapshot.json", mimeType: "application/json", modifiedTime: timestamp },
      { id: `${id}-u`, name: "client-upload.pdf", mimeType: "application/pdf", modifiedTime: timestamp },
    ], { [`${id}-q`]: JSON.stringify({ qualificationDetails: { tr_capital_ask: amount } }) });
    const snapshot = buildDriveSnapshotFromPublicInputs([input("a", "Alpha Holdings", "USD 2 million"), input("b", "Beta Project", "USD 3 million")], 0, 2, timestamp);
    const primaries = snapshot.deals.filter(deal => deal.duplicateReviewReason && !deal.duplicateOf);
    const twins = snapshot.deals.filter(deal => deal.duplicateOf);
    expect(primaries).toHaveLength(1);
    expect(twins).toHaveLength(1);
    expect(snapshot.totalsByCurrency).toEqual([]);
    expect(snapshot.reviewQueueCount).toBe(0);
    expect(buildDecisionQueue(snapshot.deals).total).toBe(2);
  });

  it("puts needs-review cases in the Decision Queue and never generates recipient draft fields", () => {
    const timestamp = "2026-09-19T00:00:00.000Z";
    const snapshot = buildDriveSnapshotFromPublicInputs([folder("decision", "Decision", [
      { id: "status", name: "status - paused.txt", mimeType: "text/plain", modifiedTime: timestamp },
    ], { status: "paused" })], 0, 1, timestamp);
    const queue = buildDecisionQueue(snapshot.deals);
    expect(queue.items[0].authorizedAction).toMatch(/record the internal outcome/);
    expect(queue.items[0]).not.toHaveProperty("draft");
    expect(queue.items[0]).not.toHaveProperty("recipientPerspective");
    expect(queue.items).toHaveLength(queue.total);
    expect(queue.items[0]).toMatchObject({ owner: "Unassigned", due: "Not recorded" });
  });

  it("preserves decimal precision in retained audit arithmetic", () => {
    const timestamp = "2026-09-19T00:00:00.000Z";
    const snapshot = buildDriveSnapshotFromPublicInputs([folder("odd", "Odd Amount", [
      { id: "q", name: "qualification-snapshot.json", mimeType: "application/json", modifiedTime: timestamp },
    ], { q: JSON.stringify({ qualificationDetails: { tr_capital_ask: "USD 1,000,001" } }) })], 0, 1, timestamp);
    expect(snapshot.totalsByCurrency[0].mathematicalThreePercent).toBe(30_000.03);
  });

  it("places the mobile Decision Queue before summary metrics in the release source", () => {
    const html = fs.readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
    expect(html.indexOf('id="priority-list"')).toBeGreaterThan(0);
    expect(html.indexOf('id="priority-list"')).toBeLessThan(html.indexOf('id="metric-grid"'));
    expect(html).not.toMatch(/How to read these numbers/i);
    const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
    expect(app).toMatch(/Is this the same deal as another file, and is it still open\?/);
    expect(app).not.toMatch(/controlled status\/amount conflict/);
  });
});

describe("founder-approved dashboard exclusions", () => {
  it("removes all four exact folder IDs before records, decisions, or totals are built", () => {
    const timestamp = "2026-09-19T00:00:00.000Z";
    const excluded = [
      "1MLSHZDuu_9vUAOpJPvMBqaKqyiRhKeF1",
      "17ZsLveF7SvvtHGPU3mvFK3WGZIv9xSAG",
      "1ypsaKjDmRzRzkrgWXjdXTgGzj3oBKXqu",
      "1TqHBZLj3xFlWF_TCN9RpMtq4Z5k5bcuG",
    ];
    const inputs = [...excluded, "visible-folder"].map((id, index) => folder(id, index === 0 ? "Hidden - shared@example.com" : id === "visible-folder" ? "Visible - shared@example.com" : `Folder ${index + 1}`, [
      { id: `${id}-q`, name: "qualification-snapshot.json", mimeType: "application/json", modifiedTime: timestamp },
      { id: `${id}-u`, name: "client-upload.pdf", mimeType: "application/pdf", modifiedTime: timestamp },
    ], { [`${id}-q`]: JSON.stringify({ qualificationDetails: { tr_capital_ask: "USD 2 million" } }) }));
    const snapshot = buildDriveSnapshotFromPublicInputs(inputs, 0, inputs.length, timestamp, excluded);
    const visible = filterDashboardDeals(snapshot.deals);
    expect(visible.map(deal => deal.id)).toEqual(["visible-folder"]);
    expect(visible[0]).toMatchObject({ duplicateOf: null, duplicateReason: null, duplicateReviewReason: null });
    expect(snapshot.totalFolders).toBe(1);
    expect(snapshot.scannedFolders).toBe(1);
    expect(buildMoneyQueue(visible).total).toBe(1);
    expect(buildRequestEvidenceTotals(visible)).toEqual([expect.objectContaining({ amount: 2_000_000, dealCount: 1 })]);
    expect(buildDecisionQueue(visible).items.some(item => excluded.includes(item.dealId))).toBe(false);
  });
});

describe("actionable intelligence operating layer", () => {
  const timestamp = "2026-09-19T00:00:00.000Z";
  const adviceSnapshot = () => buildDriveSnapshotFromPublicInputs([
    folder("decision-action", "Hotel Decision", [
      { id: "decision-status", name: "status - paused.txt", mimeType: "text/plain", modifiedTime: timestamp },
    ], { "decision-status": "paused" }),
    folder("qualify-action", "PO Financing", [
      { id: "qualify-q", name: "qualification-snapshot.json", mimeType: "application/json", modifiedTime: timestamp },
      { id: "qualify-po", name: "purchase order.pdf", mimeType: "application/pdf", modifiedTime: timestamp },
    ], { "qualify-q": JSON.stringify({ qualificationDetails: { tr_capital_ask: "USD 2 million" } }) }),
    folder("closed-action", "Closed File", [
      { id: "closed-status", name: "STATUS - DEAD DEAL - DO NOT QUEUE.txt", mimeType: "text/plain", modifiedTime: timestamp },
    ], { "closed-status": "DEAD DEAL - DO NOT QUEUE" }),
    folder("stale-action", "Stale File - stale@example.com", [
      { id: "stale-upload", name: "client-upload.pdf", mimeType: "application/pdf", modifiedTime: "2026-08-01T00:00:00.000Z" },
    ], {}),
  ], 0, 4, timestamp);

  it("gives every included file an owner, due date, finish line, evidence limit, and three advisory lenses", () => {
    const advice = buildFileAdvice(adviceSnapshot().deals);
    expect(advice).toHaveLength(4);
    for (const item of advice) {
      expect(item.owner).toBeTruthy();
      expect(item.due).toBeTruthy();
      expect(item.finishLine).toBeTruthy();
      expect(item.evidence.limitation).toMatch(/not independently verified/i);
      expect(Object.keys(item.advisoryLenses)).toHaveLength(3);
    }
    expect(advice.find(item => item.dealId === "closed-action")).toMatchObject({ actionState: "DO_NOT_CONTACT", message: null });
    expect(advice.find(item => item.dealId === "stale-action")?.message?.followUps).toHaveLength(4);
  });

  it("builds a bounded daily plan without a composite score or fundability claim", () => {
    const plan = buildTodayPlan(buildFileAdvice(adviceSnapshot().deals));
    expect(plan.items.length).toBeLessThanOrEqual(7);
    expect(plan.selectionRule).toMatch(/No composite score and no fundability claim/);
    expect(plan.items.every(item => item.actionState !== "DO_NOT_CONTACT")).toBe(true);
  });

  it("produces five company priorities and labels every Blue Ocean idea as a test", () => {
    const deals = adviceSnapshot().deals;
    const advice = buildFileAdvice(deals);
    const strategy = buildCompanyStrategy(deals, advice, { activeCampaign: { joinedToDeals: false } });
    const blueOcean = buildBlueOceanOpportunities(advice);
    expect(strategy.priorities).toHaveLength(5);
    expect(strategy.priorities.every(item => item.owner && item.due && item.finishLine)).toBe(true);
    expect(blueOcean).toHaveLength(3);
    expect(blueOcean.every(item => item.status === "Test—not validated demand")).toBe(true);
    const html = fs.readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
    expect(html).toMatch(/File Advice/);
    expect(html).toMatch(/Company Strategy/);
    expect(html).toMatch(/Advisory Board/);
  });
});
