import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { syncDriveSnapshot, type DriveDealSnapshot } from "../server/driveSync";
import { buildAdvisoryBoard, buildBlueOceanOpportunities, buildCompanyStrategy, buildFileAdvice, buildTodayPlan, type ActionState } from "./advisory-engine";
import { readEveryClientFile } from "./full-file-reader";
import { analyzeEveryDeal } from "./full-deal-analysis";

const SITE_DIR = path.resolve("site");
const PUBLIC_KEY_PATH = path.resolve("recipient-public-key.json");
const FETCH_TIMEOUT_MS = 25_000;
// Founder-approved dashboard exclusions. IDs are used so spelling changes cannot reintroduce a file.
const DASHBOARD_EXCLUDED_FOLDER_IDS = new Set([
  "1MLSHZDuu_9vUAOpJPvMBqaKqyiRhKeF1",
  "17ZsLveF7SvvtHGPU3mvFK3WGZIv9xSAG",
  "1ypsaKjDmRzRzkrgWXjdXTgGzj3oBKXqu",
  "1TqHBZLj3xFlWF_TCN9RpMtq4Z5k5bcuG",
]);

export function filterDashboardDeals(deals: DriveDealSnapshot[]) {
  return deals.filter(deal => !DASHBOARD_EXCLUDED_FOLDER_IDS.has(deal.id));
}

type EnvelopeV2 = {
  version: 2;
  algorithm: "ECDH-P256+HKDF-SHA256+AES-256-GCM";
  generatedAt: string;
  ephemeralPublicKey: crypto.JsonWebKey;
  salt: string;
  iv: string;
  ciphertext: string;
};

function easternBusinessDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const mapped = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${mapped.year}-${mapped.month}-${mapped.day}`;
}

async function fetchJson(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  return response.json();
}

async function activeCampaign() {
  const token = process.env.ACTIVECAMPAIGN_API_KEY?.trim();
  const base = process.env.ACTIVECAMPAIGN_BASE_URL?.trim();
  if (!token || !base) return { connected: false, ingested: false, joinedToDeals: false, reason: "Not configured" };
  try {
    const tenant = new URL(base);
    if (tenant.protocol !== "https:" || tenant.hostname !== "altfundsglobal.api-us1.com") throw new Error("Unapproved tenant URL");
    const headers = { "Api-Token": token };
    const [contacts, campaigns] = await Promise.all([
      fetchJson(`${tenant.origin}/api/3/contacts?limit=1`, { headers }),
      fetchJson(`${tenant.origin}/api/3/campaigns?limit=1`, { headers }),
    ]);
    const contactsTotal = Number(contacts?.meta?.total);
    const campaignsTotal = Number(campaigns?.meta?.total);
    if (!Number.isFinite(contactsTotal) || !Number.isFinite(campaignsTotal)) throw new Error("Invalid response counts");
    return {
      connected: true,
      metadataFetched: true,
      ingested: false,
      joinedToDeals: false,
      contactsTotal,
      campaignsTotal,
      checkedAt: new Date().toISOString(),
      limitation: "Availability and aggregate counts only; no deal-level identity join is used for decisions.",
    };
  } catch (error) {
    return { connected: false, ingested: false, joinedToDeals: false, reason: error instanceof Error ? error.message : "Unavailable" };
  }
}

async function calendly() {
  const token = process.env.CALENDLY_API_KEY?.trim();
  if (!token) return { connected: false, ingested: false, joinedToDeals: false, reason: "Not configured" };
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const me = await fetchJson("https://api.calendly.com/users/me", { headers });
    const userUri = me?.resource?.uri;
    if (typeof userUri !== "string") throw new Error("Invalid identity response");
    const params = new URLSearchParams({ user: userUri, status: "active", count: "100", sort: "start_time:asc" });
    const events = await fetchJson(`https://api.calendly.com/scheduled_events?${params}`, { headers });
    if (!Array.isArray(events?.collection)) throw new Error("Invalid events response");
    return {
      connected: true,
      metadataFetched: true,
      ingested: false,
      joinedToDeals: false,
      upcomingEvents: events.collection.length,
      checkedAt: new Date().toISOString(),
      limitation: "Aggregate availability only; events are not identity-matched to Drive files.",
    };
  } catch (error) {
    return { connected: false, ingested: false, joinedToDeals: false, reason: error instanceof Error ? error.message : "Unavailable" };
  }
}

async function meetAlfred() {
  const key = process.env.MEETALFRED_WEBHOOK_KEY?.trim();
  if (!key) return { connected: false, ingested: false, joinedToDeals: false, reason: "Not configured" };
  try {
    const url = new URL("https://meetalfred.com/api/integrations/webhook/campaigns");
    url.searchParams.set("webhook_key", key);
    url.searchParams.set("type", "all");
    const payload = await fetchJson(url.toString());
    const campaigns = Array.isArray(payload) ? payload : Array.isArray(payload?.campaigns) ? payload.campaigns : null;
    if (!campaigns) throw new Error("Invalid campaigns response");
    return {
      connected: true,
      metadataFetched: true,
      ingested: false,
      joinedToDeals: false,
      campaignsTotal: campaigns.length,
      checkedAt: new Date().toISOString(),
      limitation: "Campaign availability only; outreach and replies are not joined to Drive files.",
    };
  } catch (error) {
    return { connected: false, ingested: false, joinedToDeals: false, reason: error instanceof Error ? error.message : "Unavailable" };
  }
}

function evidenceFor(deal: DriveDealSnapshot) {
  const item = deal.statusEvidence || deal.amountEvidence;
  if (!item) return null;
  return {
    fileId: item.fileId,
    fileName: item.fileName,
    fileModifiedTime: item.fileModifiedTime,
    fieldPath: item.fieldPath,
    excerpt: item.excerpt,
    confidence: item.confidence,
    classification: item.classification,
    sourceKind: "Drive document; client attribution unverified",
  };
}

export function buildDecisionQueue(deals: DriveDealSnapshot[]) {
  const decisions = deals.flatMap(deal => {
    const duplicateSignal = deal.duplicateReason || deal.duplicateReviewReason;
    if (deal.status === "needs_review") {
      const blockers = duplicateSignal ? ["status_or_amount", "duplicate_resolution"] : ["status_or_amount"];
      return [{
        type: duplicateSignal ? "COMPOSITE_DECISION" : "STATUS_OR_AMOUNT_DECISION",
        severity: "critical",
        dealId: deal.id,
        name: deal.name,
        blockers,
        decision: duplicateSignal ? "Resolve both the controlled status/amount conflict and the duplicate relationship before any outreach or underwriting step." : "Resolve the conflicting or controlled status/amount evidence before any outreach or underwriting step.",
        why: duplicateSignal ? `${deal.statusReason}; ${duplicateSignal}` : deal.statusReason,
        options: duplicateSignal ? ["Confirm lifecycle/status", "Resolve amount conflict", "Merge with linked record", "Keep as separate engagement", "Escalate for senior review"] : ["Confirm current active review", "Confirm terminal / do not contact", "Keep parked pending evidence", "Escalate for senior review"],
        owner: "Unassigned",
        due: "Not recorded",
        blocker: "No authoritative lifecycle decision is recorded in the dashboard data.",
        authorizedAction: "Open the Drive evidence, then record the internal outcome, owner, and due date in an authoritative workflow. Recipient drafting remains blocked.",
        evidence: evidenceFor(deal),
        driveUrl: deal.driveUrl,
        lastModified: deal.latestDocumentModifiedTime,
      }];
    }
    if (duplicateSignal) {
      return [{
        type: "DUPLICATE_MERGE_DECISION",
        severity: deal.duplicateOf ? "high" : "medium",
        dealId: deal.id,
        name: deal.name,
        blockers: ["duplicate_resolution"],
        decision: deal.duplicateOf ? "Confirm whether this held twin should be merged with the provisional primary or kept as a separate engagement." : "Confirm that this provisional primary is the correct record for the potential duplicate group.",
        why: duplicateSignal,
        options: ["Keep as provisional primary", "Merge with linked record", "Keep as separate engagement", "Escalate identity review"],
        owner: "Unassigned",
        due: "Not recorded",
        blocker: "No human merge-or-separate decision is recorded.",
        authorizedAction: "Open the Drive records, then record the merge-or-separate outcome, owner, and due date in an authoritative workflow. Recipient drafting remains blocked.",
        evidence: null,
        driveUrl: deal.driveUrl,
        lastModified: deal.latestDocumentModifiedTime,
      }];
    }
    return [];
  });
  decisions.sort((a, b) => {
    const severity = { critical: 0, high: 1, medium: 2 } as const;
    return severity[a.severity as keyof typeof severity] - severity[b.severity as keyof typeof severity] || b.lastModified.localeCompare(a.lastModified) || a.dealId.localeCompare(b.dealId);
  });
  return {
    total: decisions.length,
    categories: {
      statusOrAmount: decisions.filter(item => item.blockers.includes("status_or_amount")).length,
      duplicateResolution: decisions.filter(item => item.blockers.includes("duplicate_resolution")).length,
    },
    sortRule: "Critical status/amount conflicts first; duplicate decisions second; newest evidence then stable file ID. This is queue order, not fundability rank.",
    items: decisions,
  };
}

function eligibleRequestEvidence(deals: DriveDealSnapshot[]) {
  return deals
    .filter(deal => ["active", "intake_only"].includes(deal.status))
    .filter(deal => !deal.duplicateOf && !deal.duplicateReason && !deal.duplicateReviewReason && deal.evidenceReadErrorCount === 0)
    .filter(deal => deal.amountClassification === "client_stated_exact" && deal.minimumScreen === "passes_usd_1m" && deal.currency === "USD" && deal.amount != null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function buildMoneyQueue(deals: DriveDealSnapshot[]) {
  const eligible = eligibleRequestEvidence(deals);
  const items = eligible
    .slice(0, 7)
    .map(deal => ({
      dealId: deal.id,
      name: deal.name,
      amount: deal.amount,
      currency: deal.currency,
      amountDisplay: deal.amountDisplay,
      evidence: evidenceFor(deal),
      screeningState: "Unconfirmed exact USD request evidence; alphabetical inventory only—not a priority, pipeline, approval, fundability, fee base, or revenue.",
      missingGates: ["Human-confirmed product", "Human-confirmed lifecycle stage", "Assigned owner", "Recorded due date", "Product-specific hard-gate review"],
      driveUrl: deal.driveUrl,
      lastModified: deal.latestDocumentModifiedTime,
    }));
  return { total: eligible.length, items };
}

export function buildRequestEvidenceTotals(deals: DriveDealSnapshot[]) {
  const eligible = eligibleRequestEvidence(deals);
  return eligible.length ? [{
    currency: "USD",
    amount: eligible.reduce((sum, deal) => sum + (deal.amount || 0), 0),
    dealCount: eligible.length,
    basis: "exact_usd_request_evidence_unconfirmed_lifecycle",
  }] : [];
}

export function gateFileAdviceWithFullAnalysis(fileAdvice: ReturnType<typeof buildFileAdvice>, fullItems: Awaited<ReturnType<typeof analyzeEveryDeal>>["items"]) {
  const byId = new Map(fullItems.map(item => [item.dealId, item]));
  return fileAdvice.map(item => {
    const full = byId.get(item.dealId);
    if (!full) return { ...item, actionState: "VERIFY_FIRST" as const, owner: "Taimour", due: "Today", action: "Open the Drive file and complete the full-document analysis before any external action.", why: "No complete full-document analysis is attached.", finishLine: "A reconciled extraction ledger and reviewed product decision are recorded.", message: null };
    const actionState: ActionState = full.readiness === "do_not_contact" ? "DO_NOT_CONTACT" : full.readiness === "needs_verification" ? "VERIFY_FIRST" : full.readiness === "advisory_first" ? "QUALIFY" : "SCREEN";
    const incomplete = full.readCoverage.partialCount + full.readCoverage.emptyCount + full.readCoverage.unsupportedCount + full.readCoverage.tooLargeCount + full.readCoverage.failedCount;
    return {
      ...item,
      actionState,
      owner: actionState === "DO_NOT_CONTACT" ? "No action" : "Taimour",
      due: actionState === "DO_NOT_CONTACT" ? "Do not contact" : "Today",
      instrument: full.recommendedProduct,
      action: full.bestNextAction,
      why: actionState === "DO_NOT_CONTACT"
        ? "The lifecycle state is terminal and is monotonic across the dashboard."
        : incomplete
          ? `${incomplete} document(s) are not completely readable; absence claims and external outreach are blocked.`
          : full.whyThisProduct,
      finishLine: actionState === "DO_NOT_CONTACT"
        ? "No client or provider outreach unless a new authoritative lifecycle decision is recorded."
        : full.readiness === "provider_ready"
          ? "Taimour reviews the exact evidence and manually authorizes or rejects one provider fit-check."
          : full.readiness === "advisory_first"
            ? "A defined advisory scope and client-approved missing-item plan are recorded."
            : "The extraction, status, duplicate, and evidence gates are resolved in the source file.",
      steps: [full.bestNextAction, "Open the document ledger and exact source quotes.", "Record the human decision before any external communication."],
      evidence: {
        ...item.evidence,
        exactAmount: full.exactAmount,
        currency: full.currency,
        limitation: incomplete ? "At least one document is partial, empty, unsupported, oversized, or unreadable; no absence conclusion or external recommendation is authorized." : "All inventoried documents reached a complete readable state; provided claims still require exact source quotes.",
      },
      message: null,
    };
  });
}

export async function buildDashboardData() {
  const startedAt = new Date().toISOString();
  const [drive, ac, cal, alfred] = await Promise.all([syncDriveSnapshot({ persist: false, excludeFolderIds: DASHBOARD_EXCLUDED_FOLDER_IDS }), activeCampaign(), calendly(), meetAlfred()]);
  assertPublishableSnapshot(drive);
  const generatedAt = new Date().toISOString();
  const runId = crypto.createHash("sha256").update(`${generatedAt}:${drive.snapshotId}`).digest("hex").slice(0, 20);
  const sourceCommit = process.env.AFG_SOURCE_COMMIT || null;
  const visibleDriveDeals = filterDashboardDeals(drive.deals);
  const decisions = buildDecisionQueue(visibleDriveDeals);
  const money = buildMoneyQueue(visibleDriveDeals);
  const requestEvidenceTotals = buildRequestEvidenceTotals(visibleDriveDeals);
  const fullRead = await readEveryClientFile(visibleDriveDeals);
  const accountedDocuments = fullRead.readableCount + fullRead.partialCount + fullRead.emptyCount + fullRead.unsupportedCount + fullRead.tooLargeCount + fullRead.failedCount;
  if (fullRead.folderCount !== visibleDriveDeals.length || fullRead.failedCount > 0 || accountedDocuments !== fullRead.inventoryCount) {
    throw new Error(`Refusing to publish incomplete full-document analysis: ${fullRead.folderCount}/${visibleDriveDeals.length} folders, ${fullRead.failedCount} failed file read(s)`);
  }
  const fullAnalysis = await analyzeEveryDeal(visibleDriveDeals, fullRead);
  const fileAdvice = gateFileAdviceWithFullAnalysis(buildFileAdvice(visibleDriveDeals), fullAnalysis.items);
  const todayPlan = buildTodayPlan(fileAdvice);
  const sourceHealth = {
    googleDrive: {
      connected: true,
      ingested: true,
      joinedToDeals: true,
      accessMode: "authenticated_service_account_drive_api",
      checkedAt: generatedAt,
      fetched: drive.scannedFolders,
      failed: drive.failedFolderCount,
      evidenceFailures: drive.evidenceReadErrorCount,
      fullDocumentInventory: fullRead.inventoryCount,
      fullDocumentReadable: fullRead.readableCount,
      fullDocumentPartial: fullRead.partialCount,
      fullDocumentEmpty: fullRead.emptyCount,
      fullDocumentUnsupported: fullRead.unsupportedCount,
      fullDocumentTooLarge: fullRead.tooLargeCount,
      fullDocumentFailed: fullRead.failedCount,
      decisionUse: "Authenticated inventory, conservative status/amount evidence, and full-document extraction with per-file coverage",
      limitation: `${fullRead.partialCount} partial, ${fullRead.emptyCount} empty, ${fullRead.unsupportedCount} unsupported, and ${fullRead.tooLargeCount} oversized file(s) are disclosed and routed to verification; only complete exact-quote evidence may support a provided-item claim.`,
      accessRisk: "An anonymous root permission remains from the last access audit. The read-only service account cannot revoke it; owner-level Drive permission is required.",
    },
    activeCampaign: ac,
    calendly: cal,
    meetAlfred: alfred,
  };
  const companyStrategy = buildCompanyStrategy(visibleDriveDeals, fileAdvice, sourceHealth);
  const blueOcean = buildBlueOceanOpportunities(fileAdvice);
  const advisoryBoard = await buildAdvisoryBoard({
    businessDateEastern: easternBusinessDate(new Date(generatedAt)),
    companyFacts: companyStrategy.facts,
    todayActions: todayPlan.items.map(item => ({ actionState: item.actionState, owner: item.owner, due: item.due, instrument: item.instrument })),
    strategicPriorities: companyStrategy.priorities.map(item => ({ title: item.title, metric: item.metric, owner: item.owner, due: item.due })),
    blueOceanTests: blueOcean.map(item => ({ title: item.title, evidence: item.evidence, status: item.status })),
    sourceLimits: {
      activeCampaignJoinedToDeals: Boolean(ac?.joinedToDeals),
      calendlyJoinedToDeals: Boolean(cal?.joinedToDeals),
      meetAlfredJoinedToDeals: Boolean(alfred?.joinedToDeals),
      documentContentsParsed: true,
    },
  });
  const visibleBuckets = {
    active: visibleDriveDeals.filter(deal => deal.status === "active").length,
    intakeOnly: visibleDriveDeals.filter(deal => deal.status === "intake_only").length,
    funded: visibleDriveDeals.filter(deal => deal.status === "funded").length,
    closed: visibleDriveDeals.filter(deal => deal.status === "closed").length,
    needsReview: visibleDriveDeals.filter(deal => deal.status === "needs_review").length,
  };
  const deals = visibleDriveDeals.map(deal => ({
    id: deal.id,
    name: deal.name,
    email: deal.email,
    driveUrl: deal.driveUrl,
    status: deal.status,
    statusReason: deal.statusReason,
    statusConfidence: deal.statusConfidence,
    statusEvidence: deal.statusEvidence,
    latestDocumentModifiedTime: deal.latestDocumentModifiedTime,
    lastModified: deal.latestDocumentModifiedTime,
    daysSinceUpdate: deal.daysSinceUpdate,
    documentCount: deal.documentCount,
    uploadCount: deal.uploadCount,
    documentChecklistGaps: deal.documentChecklistGaps,
    documentAssessment: deal.documentAssessment,
    amount: deal.amount,
    currency: deal.currency,
    amountDisplay: deal.amountDisplay,
    amountClassification: deal.amountClassification,
    amountSource: deal.amountSource,
    amountEvidence: deal.amountEvidence,
    minimumScreen: deal.minimumScreen,
    duplicateOf: deal.duplicateOf,
    duplicateReason: deal.duplicateReason,
    duplicateReviewReason: deal.duplicateReviewReason,
    evidenceReadErrorCount: deal.evidenceReadErrorCount,
  }));
  return {
    schemaVersion: 2,
    generatedAt,
    businessDateEastern: easternBusinessDate(new Date(generatedAt)),
    freshnessPolicy: { target: "05:00 America/New_York", absoluteMaxAgeHours: 20, currentBusinessDateRequiredAfterFive: true },
    manifest: {
      runId,
      snapshotId: drive.snapshotId,
      sourceCommit,
      startedAt,
      completedAt: generatedAt,
      sourceMode: "authenticated_service_account_drive_api",
      parserVersion: drive.parserVersion,
      totalFolders: drive.totalFolders,
      scannedFolders: drive.scannedFolders,
      failedFolderCount: drive.failedFolderCount,
      evidenceReadErrorCount: drive.evidenceReadErrorCount,
      fullDocumentInventory: fullRead.inventoryCount,
      fullDocumentReadable: fullRead.readableCount,
      fullDocumentPartial: fullRead.partialCount,
      fullDocumentEmpty: fullRead.emptyCount,
      fullDocumentUnsupported: fullRead.unsupportedCount,
      fullDocumentTooLarge: fullRead.tooLargeCount,
      fullDocumentFailed: fullRead.failedCount,
      fullAnalysisModelRuns: fullAnalysis.coverage.modelRuns,
      fullAnalysisCacheHits: fullAnalysis.coverage.cacheHits,
      sourceModifiedAt: drive.sourceModifiedAt,
      internalValidation: "passed",
      independentCompletenessAttestation: false,
    },
    source: {
      name: drive.sourceName,
      snapshotId: drive.snapshotId,
      parserVersion: `${drive.parserVersion}-authenticated-api`,
      connection: drive.connection,
      totalFolders: drive.totalFolders,
      scannedFolders: drive.scannedFolders,
      failedFolderCount: drive.failedFolderCount,
      evidenceReadErrorCount: drive.evidenceReadErrorCount,
      sourceModifiedAt: drive.sourceModifiedAt,
      accessMode: "Authenticated service-account Drive API",
      timestampPrecision: "Google Drive API modifiedTime",
      coverageClaim: "All client folders returned by the configured authenticated Drive scope; independent completeness attestation is not yet available.",
    },
    buckets: visibleBuckets,
    totalsByCurrency: requestEvidenceTotals,
    duplicateCandidateCount: visibleDriveDeals.filter(deal => Boolean(deal.duplicateOf || deal.duplicateReason || deal.duplicateReviewReason)).length,
    duplicateHeldValuedCount: visibleDriveDeals.filter(deal => Boolean(deal.duplicateOf || deal.duplicateReason || deal.duplicateReviewReason) && deal.amount != null).length,
    reviewQueueCount: visibleDriveDeals.filter(deal => deal.status === "needs_review").length,
    changedInLast24Hours: visibleDriveDeals.filter(deal => deal.daysSinceUpdate < 1).length,
    decisionQueue: decisions,
    moneyQueue: money,
    todayPlan,
    fileAdvice,
    companyStrategy,
    blueOcean,
    advisoryBoard,
    fullAnalysis,
    sourceHealth,
    deals,
    visibleFolderCount: visibleDriveDeals.length,
    securityWarnings: [
      "The Drive root still reports an anonymous permission. Authenticated ingestion is active, but source confidentiality remains unresolved until a Drive owner removes that permission.",
    ],
    disclosures: [
      "Folder activity is an observation, not an authoritative deal stage.",
      "Queue values are unconfirmed exact client-stated USD requests, not approved or fundable amounts.",
      "Currencies are never combined; non-USD requests are not included in the USD screen.",
      "Hypothetical fee arithmetic is not included in the operational dashboard payload.",
      "Client checklist items are labeled 'not located' and come from authenticated readable contents; unsupported or oversized files remain explicit verification gaps.",
      "All Decision Cards are internal. Recipient drafts and copy controls are disabled until contact, cadence, authorization, and action-history controls exist.",
    ],
  };
}

export function assertPublishableSnapshot(snapshot: { failedFolderCount: number; evidenceReadErrorCount: number; connection?: string; totalFolders?: number; scannedFolders?: number; snapshotId?: string }, sourceMode = "authenticated_service_account_drive_api") {
  const validCoverage = Number.isInteger(snapshot.totalFolders) && (snapshot.totalFolders || 0) > 0 && snapshot.scannedFolders === snapshot.totalFolders;
  if (sourceMode !== "authenticated_service_account_drive_api" || snapshot.connection !== "fresh_snapshot" || !validCoverage || !snapshot.snapshotId || snapshot.failedFolderCount > 0 || snapshot.evidenceReadErrorCount > 0) {
    throw new Error(`Refusing to publish a partial Drive snapshot: ${snapshot.failedFolderCount} folder error(s), ${snapshot.evidenceReadErrorCount} evidence error(s)`);
  }
}

function toBase64(value: Buffer) {
  return value.toString("base64");
}

export function encryptPayload(payload: unknown, recipientPublicJwk: crypto.JsonWebKey): EnvelopeV2 {
  const recipientPublicKey = crypto.createPublicKey({ key: recipientPublicJwk, format: "jwk" });
  const ephemeral = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sharedSecret = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPublicKey });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const aesKey = Buffer.from(crypto.hkdfSync("sha256", sharedSecret, salt, Buffer.from("AFG Dashboard Data v2"), 32));
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const plaintext = Buffer.from(JSON.stringify(payload));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    version: 2,
    algorithm: "ECDH-P256+HKDF-SHA256+AES-256-GCM",
    generatedAt: typeof payload === "object" && payload !== null && "generatedAt" in payload && typeof payload.generatedAt === "string" ? payload.generatedAt : new Date().toISOString(),
    ephemeralPublicKey: ephemeral.publicKey.export({ format: "jwk" }),
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const recipientPublicJwk = JSON.parse(await fs.readFile(PUBLIC_KEY_PATH, "utf8")) as crypto.JsonWebKey;
  const payload = await buildDashboardData();
  await fs.mkdir(SITE_DIR, { recursive: true });
  await fs.writeFile(path.join(SITE_DIR, "data.enc"), JSON.stringify(encryptPayload(payload, recipientPublicJwk)));
  console.log(JSON.stringify({
    generatedAt: payload.generatedAt,
    runId: payload.manifest.runId,
    folders: payload.source.scannedFolders,
    failedFolders: payload.source.failedFolderCount,
    evidenceErrors: payload.source.evidenceReadErrorCount,
    decisionCards: payload.decisionQueue.total,
    todayActions: payload.todayPlan.total,
    advisoryModels: payload.advisoryBoard.modelGeneratedCount,
    moneyScreens: payload.moneyQueue.total,
    currencies: payload.totalsByCurrency.map(item => item.currency),
    sourceMode: payload.manifest.sourceMode,
  }));
}
