import crypto from "crypto";
import * as db from "./db";

export const DRIVE_FOLDER_ID = (process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim();
export const DRIVE_FOLDER_URL = `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`;

const GOOGLE_FOLDER = "application/vnd.google-apps.folder";
const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
export const SNAPSHOT_CACHE_KEY = "drive_snapshot_v10";
export const SNAPSHOT_TTL_MINUTES = 26 * 60;
const FULL_SYNC_MAX_AGE_MS = 26 * 60 * 60 * 1000;
const MAX_STALE_AGE_MS = FULL_SYNC_MAX_AGE_MS;
const OPEN_CHECK_MAX_AGE_MS = 5 * 60 * 1000;
const DRIVE_TIMEOUT_MS = 15_000;
const DRIVE_RETRIES = 2;

export type DriveDealStatus = "active" | "intake_only" | "funded" | "closed" | "needs_review";
export type SnapshotFreshness = "fresh_snapshot" | "stored_snapshot" | "stale_snapshot" | "partial_snapshot";
export type EvidenceConfidence = "high" | "medium" | "ambiguous";

export type DriveFileRecord = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  parentFolderId?: string;
};

export type DriveEvidence = {
  fileId: string;
  fileName: string;
  fileModifiedTime: string;
  fieldPath: string | null;
  excerpt: string | null;
  confidence: EvidenceConfidence;
  classification: "client_stated_exact" | "client_stated_bracket" | "status_marker";
};

export type DriveDealSnapshot = {
  id: string;
  name: string;
  folderName: string;
  email: string | null;
  driveUrl: string;
  modifiedTime: string;
  latestDocumentModifiedTime: string;
  daysSinceUpdate: number;
  status: DriveDealStatus;
  statusReason: string;
  statusConfidence: "explicit" | "inferred" | "conflict";
  statusEvidence: DriveEvidence | null;
  documentCount: number;
  uploadCount: number;
  documentNames: string[];
  documentChecklistGaps: string[];
  documentAssessment: "filename_only";
  /** Compatibility alias. These are filename-only checklist gaps, not confirmed missing documents. */
  missingDocuments: string[];
  amount: number | null;
  currency: string | null;
  amountDisplay: string | null;
  amountSource: string | null;
  amountEvidence: DriveEvidence | null;
  amountClassification: "client_stated_exact" | "client_stated_bracket" | "unavailable";
  amountConfirmedByAfg: false;
  verifiedEligibleAmount: null;
  approvedFundableAmount: null;
  feeEligibleAmount: null;
  contractedFeeRate: null;
  earnedRevenue: null;
  minimumScreen: "passes_usd_1m" | "below_usd_1m" | "not_assessed_non_usd" | "amount_unavailable";
  duplicateOf: string | null;
  duplicateReason: string | null;
  duplicateReviewReason: string | null;
  evidenceReadErrorCount: number;
  priorityScore: number;
};

export type DriveCurrencyTotal = {
  currency: string;
  amount: number;
  mathematicalThreePercent: number;
  dealCount: number;
  basis: "client_stated_exact_unconfirmed";
};

export type DriveSnapshot = {
  version: 10;
  snapshotId: string;
  parserVersion: "10.0";
  source: "google_drive";
  sourceName: "AFG Client Data";
  folderId: string;
  folderUrl: string;
  connection: SnapshotFreshness;
  lastCheckedAt: string;
  lastFullSyncAt: string;
  sourceModifiedAt: string | null;
  totalFolders: number;
  scannedFolders: number;
  buckets: {
    active: number;
    intakeOnly: number;
    funded: number;
    closed: number;
    needsReview: number;
  };
  totalsByCurrency: DriveCurrencyTotal[];
  grossTotalsByCurrency: DriveCurrencyTotal[];
  valuedDealCount: number;
  confirmedValuedDealCount: 0;
  duplicateCandidateCount: number;
  duplicateHeldValuedCount: number;
  reviewQueueCount: number;
  changedInLast24Hours: number;
  failedFolderCount: number;
  evidenceReadErrorCount: number;
  deals: DriveDealSnapshot[];
  error?: string;
};

type GoogleDriveFile = DriveFileRecord & { parents?: string[] };

type AmountCandidate = {
  amount: number;
  currency: string;
  display: string;
  source: string;
  score: number;
  evidence: DriveEvidence;
};

type BracketCandidate = {
  amount: null;
  currency: null;
  display: string;
  source: string;
  score: number;
  evidence: DriveEvidence;
};

type RequestedAmount = AmountCandidate | BracketCandidate;

let tokenCache: { token: string; expiresAt: number } | null = null;
let liveCheckCache: { snapshot: DriveSnapshot; checkedAt: number } | null = null;
type SyncOperation = { mode: "force" | "check"; promise: Promise<DriveSnapshot> };
let currentOperation: SyncOperation | null = null;

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/webhook_key=[^&\s]+/gi, "webhook_key=[redacted]").slice(0, 240);
}

function getCredentialJson() {
  const raw = process.env.GOOGLE_CLOUD_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
  if (!raw) throw new Error("Google Drive service-account credentials are not configured");
  const credentials = JSON.parse(raw);
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Google Drive service-account credentials are incomplete");
  }
  return credentials;
}

async function fetchWithRetry(url: string, init: RequestInit = {}, retries = DRIVE_RETRIES): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(DRIVE_TIMEOUT_MS) });
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === retries) return response;
      await response.body?.cancel().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt));
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Google Drive request failed");
}

export async function getDriveAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const credentials = getCredentialJson();
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(credentials.private_key).toString("base64url")}`;

  const response = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  }, 1);
  if (!response.ok) throw new Error(`Google Drive authentication failed (${response.status})`);
  const payload = await response.json() as { access_token?: string; expires_in?: number };
  if (!payload.access_token) throw new Error("Google Drive did not return an access token");
  tokenCache = { token: payload.access_token, expiresAt: Date.now() + (payload.expires_in || 3600) * 1000 };
  return payload.access_token;
}

async function listDriveFiles(query: string, orderBy = "modifiedTime desc"): Promise<GoogleDriveFile[]> {
  const token = await getDriveAccessToken();
  const files: GoogleDriveFile[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: query,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size,parents)",
      pageSize: "1000",
      orderBy,
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetchWithRetry(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Google Drive list failed (${response.status})`);
    const payload = await response.json() as { files?: GoogleDriveFile[]; nextPageToken?: string };
    files.push(...(payload.files || []));
    pageToken = payload.nextPageToken || "";
  } while (pageToken);
  return files;
}

export async function listClientFolders(): Promise<GoogleDriveFile[]> {
  return listDriveFiles(`'${DRIVE_FOLDER_ID}' in parents and mimeType='${GOOGLE_FOLDER}' and trashed=false`);
}

async function listFolderTree(folderId: string): Promise<GoogleDriveFile[]> {
  const all: GoogleDriveFile[] = [];
  const visited = new Set<string>([folderId]);
  let frontier = [folderId];
  while (frontier.length) {
    const current = frontier;
    frontier = [];
    const batches = await mapWithConcurrency(current, 3, async id => ({ children: await listDriveFiles(`'${id}' in parents and trashed=false`) }));
    for (const batch of batches) {
      all.push(...batch.children);
      for (const child of batch.children) {
        if (child.mimeType === GOOGLE_FOLDER && !visited.has(child.id)) {
          visited.add(child.id);
          frontier.push(child.id);
        }
      }
    }
  }
  return all;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function isReadableText(file: GoogleDriveFile) {
  return file.mimeType === GOOGLE_DOC || file.mimeType === GOOGLE_SHEET || file.mimeType.startsWith("text/") ||
    file.mimeType === "application/json" || /\.(txt|json|csv|md)$/i.test(file.name);
}

async function downloadText(file: GoogleDriveFile): Promise<string> {
  if (!isReadableText(file)) return "";
  const token = await getDriveAccessToken();
  const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`;
  let url = `${base}?alt=media&supportsAllDrives=true`;
  if (file.mimeType === GOOGLE_DOC) url = `${base}/export?mimeType=${encodeURIComponent("text/plain")}`;
  else if (file.mimeType === GOOGLE_SHEET) url = `${base}/export?mimeType=${encodeURIComponent("text/csv")}`;
  const response = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-99999" } });
  if (!response.ok) throw new Error(`Google Drive evidence download failed (${response.status})`);
  return (await response.text()).slice(0, 100_000);
}

function extractEmail(folderName: string) {
  return folderName.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || null;
}

function cleanDealName(folderName: string, email: string | null) {
  const withoutEmail = email ? folderName.replace(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "") : folderName;
  return withoutEmail.replace(/\s*[-–—]\s*$/, "").trim() || folderName;
}

function isSystemFile(name: string) {
  return /conversation[- _]?summary|qualification[- _]?snapshot|^status(?:[- _:.:]|$)|client uploads|readme/i.test(name);
}

function statusFromMarker(name: string): { status: DriveDealStatus | null; label: string } {
  const lines = name.split(/\r?\n/).map(line => line.trim().replace(/\.[a-z0-9]{1,8}$/i, "")).filter(Boolean);
  for (const line of lines) {
    const statusValue = line.match(/^status\s*[-:=]\s*(.+)$/i)?.[1]?.trim() || line;
    if (/^dead deal - do not queue(?:\s*-\s*.+)?$/i.test(statusValue) || /^closed[ _-]?lost$/i.test(statusValue)) {
      return { status: "closed", label: "explicit dead/closed status declaration" };
    }
    if (/^(?:funded|paid out|closed[ _-]?won)$/i.test(statusValue) || /^awaiting second lender payout - no action needed(?:\s*-\s*.+)?$/i.test(statusValue)) {
      return { status: "funded", label: "explicit funded/payout status declaration" };
    }
    if (/^active$/i.test(statusValue)) return { status: "active", label: "explicit active status declaration" };
    if (/^(?:paused|on hold|stalled)$/i.test(statusValue)) return { status: "needs_review", label: "explicit paused/on-hold status declaration" };
  }
  return { status: null, label: "" };
}

export function classifyStatus(files: GoogleDriveFile[], statusContents: Array<{ file: GoogleDriveFile; text: string }> = []): {
  status: DriveDealStatus;
  reason: string;
  confidence: "explicit" | "inferred" | "conflict";
  evidence: GoogleDriveFile | null;
} {
  const controlledFiles = files.filter(file => /^status(?:[- _:].*)?(?:\.[a-z0-9]+)?$|^dead deal - do not queue(?:\s*-.*)?(?:\.[a-z0-9]+)?$/i.test(file.name));
  const ambiguousContent = statusContents.find(({ text }) => {
    const hasTerminalLanguage = /\b(funded|paid out|closed won|closed lost|dead deal|do not queue)\b/i.test(text);
    const hasContradiction = /\b(not funded|no longer funded|not paid|entered in error|incorrect|correction|previously|historical|was funded|used to be|expected to be funded|will be funded|once approved|cancelled|canceled|rescinded|reopened)\b/i.test(text);
    const terminalStatuses = new Set(text.split(/\r?\n/).map(line => statusFromMarker(line).status).filter(Boolean));
    return hasTerminalLanguage && (hasContradiction || terminalStatuses.size > 1 || !statusFromMarker(text).status);
  });
  const unknownControlledContent = statusContents.find(({ text }) => /^status\s*[-:=]/im.test(text) && !statusFromMarker(text).status);
  const ambiguousFile = controlledFiles.find(file => /^status\s*[-:=]/i.test(file.name.replace(/\.[a-z0-9]{1,8}$/i, "")) && !statusFromMarker(file.name).status);
  if (ambiguousContent || unknownControlledContent || ambiguousFile) {
    const evidenceFile = ambiguousContent?.file || unknownControlledContent?.file || ambiguousFile!;
    return { status: "needs_review", reason: "Status marker contains narrative, negated, or historical terminal-status language", confidence: "conflict", evidence: evidenceFile };
  }
  const markerFiles = [
    ...controlledFiles
      .map(file => ({ file, marker: statusFromMarker(file.name) })),
    ...statusContents.map(({ file, text }) => ({ file, marker: statusFromMarker(text) })),
  ]
    .filter(item => item.marker.status)
    .sort((a, b) => b.file.modifiedTime.localeCompare(a.file.modifiedTime));
  if (markerFiles.length > 0) {
    const latest = markerFiles[0];
    const latestTime = latest.file.modifiedTime;
    const conflictingLatest = markerFiles.some(item => item.file.modifiedTime === latestTime && item.marker.status !== latest.marker.status);
    if (conflictingLatest) {
      return { status: "needs_review", reason: "Conflicting current Drive status markers", confidence: "conflict", evidence: latest.file };
    }
    const newerUpload = files.some(file => file.mimeType !== GOOGLE_FOLDER && !isSystemFile(file.name) && file.modifiedTime > latest.file.modifiedTime);
    if (newerUpload && ["closed", "funded"].includes(latest.marker.status!)) {
      return { status: "needs_review", reason: "Client activity postdates the latest closed/funded marker", confidence: "conflict", evidence: latest.file };
    }
    return { status: latest.marker.status!, reason: `Drive contains an ${latest.marker.label}`, confidence: "explicit", evidence: latest.file };
  }
  const documents = files.filter(file => file.mimeType !== GOOGLE_FOLDER);
  const uploads = documents.filter(file => !isSystemFile(file.name));
  return uploads.length > 0
    ? { status: "active", reason: "Client-uploaded documents are present; status is inferred", confidence: "inferred", evidence: null }
    : { status: "intake_only", reason: "Only intake/system files are present; status is inferred", confidence: "inferred", evidence: null };
}

function detectDocumentChecklistGaps(files: GoogleDriveFile[]) {
  const names = files.map(file => file.name).join(" | ").toLowerCase();
  const gaps: string[] = [];
  if (!/passport|kyc|identity|id card/.test(names)) gaps.push("Possible KYC / identity gap");
  if (!/financial|bank statement|account|revenue|balance sheet|income statement|p&l|profit and loss/.test(names)) gaps.push("Possible financial-statement gap");
  if (!/business plan|project description|use of funds|executive summary/.test(names)) gaps.push("Possible business-plan / use-of-funds gap");
  if (!/intake|loan request|application/.test(names)) gaps.push("Possible intake-form gap");
  return gaps;
}

function multiplier(unit: string) {
  const normalized = unit.toLowerCase();
  if (["billion", "bn", "b"].includes(normalized)) return 1_000_000_000;
  if (["million", "mn", "m"].includes(normalized)) return 1_000_000;
  if (["thousand", "k"].includes(normalized)) return 1_000;
  return 1;
}

function parseConservativeNumber(token: string, hasUnit: boolean): number | null {
  const value = token.trim();
  if (!/^\d[\d,.]*$/.test(value)) return null;
  const hasComma = value.includes(",");
  const hasDot = value.includes(".");
  if (hasComma && hasDot) {
    if (!/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(value)) return null;
    return Number(value.replace(/,/g, ""));
  }
  if (hasComma) {
    if (hasUnit) {
      if (!/^\d+,\d{1,2}$/.test(value)) return null;
      return Number(value.replace(",", "."));
    }
    if (!/^\d{1,3}(,\d{3})+$/.test(value)) return null;
    return Number(value.replace(/,/g, ""));
  }
  if (hasDot) {
    if (!/^\d+\.\d{1,2}$/.test(value)) return null;
    return Number(value);
  }
  return Number(value);
}

export function currencyCode(token: string): string | null {
  const normalized = token.toUpperCase().replace(/\s/g, "");
  if (normalized.startsWith("AUD") || normalized === "A$") return "AUD";
  if (normalized.startsWith("CAD") || normalized === "C$") return "CAD";
  if (normalized === "EUR" || normalized === "€") return "EUR";
  if (normalized === "GBP" || normalized === "£") return "GBP";
  if (normalized === "USD" || normalized === "US$") return "USD";
  if (["AED", "SGD", "CHF", "JPY", "INR", "ZAR", "HKD", "NZD", "SEK", "NOK", "DKK", "PLN", "BRL", "MXN", "CNY", "SAR", "QAR"].includes(normalized)) return normalized;
  return null;
}

function formatAmount(amount: number, currency: string) {
  const prefix: Record<string, string> = { USD: "US$", AUD: "AUD$", CAD: "CAD$", EUR: "€", GBP: "£" };
  const value = amount >= 1_000_000_000 ? `${Number((amount / 1_000_000_000).toFixed(2))}B`
    : amount >= 1_000_000 ? `${Number((amount / 1_000_000).toFixed(2))}M`
      : amount >= 1_000 ? `${Number((amount / 1_000).toFixed(1))}K` : amount.toLocaleString("en-US");
  return `${prefix[currency] || `${currency} `}${value}`;
}

function evidence(file: GoogleDriveFile, fieldPath: string | null, excerpt: string | null, confidence: EvidenceConfidence, classification: DriveEvidence["classification"]): DriveEvidence {
  return { fileId: file.id, fileName: file.name, fileModifiedTime: file.modifiedTime, fieldPath, excerpt: excerpt?.slice(0, 240) || null, confidence, classification };
}

export function parseExactAmountValue(value: unknown, currencyHint: unknown, source: string, file?: GoogleDriveFile, fieldPath: string | null = null): AmountCandidate | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw || /\b(to|between|range|approximately from|minimum|at least|up to|approximately|approx\.?|around|about|estimated|estimate|indicative|target|expected|proposed|budget(?:ed)?)\b/i.test(raw) || /\d\s*[-–—]\s*\d/.test(raw) || /\+|~|plus/i.test(raw)) return null;
  const numberTokens = raw.match(/\d(?:[\d,.]*\d)?/g) || [];
  if (numberTokens.length !== 1) return null;
  const unitMatch = raw.match(/\d[\d,.]*\s*(billion|bn|million|mn|thousand|b|m|k)\b/i);
  const rawNumber = parseConservativeNumber(numberTokens[0], Boolean(unitMatch));
  if (rawNumber === null || !Number.isFinite(rawNumber) || rawNumber <= 0) return null;
  if (unitMatch && rawNumber >= 1_000_000) return null;
  const amount = unitMatch ? rawNumber * multiplier(unitMatch[1]) : rawNumber;
  if (amount < 100_000 || amount > 100_000_000_000) return null;
  const explicitCurrencyTokens = raw.match(/US\$|USD|AUD\$?|A\$|CAD\$?|C\$|EUR|€|GBP|£|AED|SGD|CHF|JPY|INR|ZAR|HKD|NZD|SEK|NOK|DKK|PLN|BRL|MXN|CNY|SAR|QAR/gi) || [];
  const explicitCurrencies = new Set(explicitCurrencyTokens.map(token => currencyCode(token)).filter(Boolean));
  if (explicitCurrencies.size > 1) return null;
  const explicitCurrency = explicitCurrencyTokens[0] || "";
  const hint = typeof currencyHint === "string" ? currencyHint : "";
  const currency = currencyCode(explicitCurrency) || currencyCode(hint);
  if (!currency) return null;
  const fallbackFile = file || { id: "unknown", name: source, mimeType: "text/plain", modifiedTime: new Date(0).toISOString() };
  return {
    amount,
    currency,
    display: formatAmount(amount, currency),
    source: fieldPath ? `${source} · ${fieldPath}` : source,
    score: 100,
    evidence: evidence(fallbackFile, fieldPath, raw, "high", "client_stated_exact"),
  };
}

function formatBracket(value: string) {
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  const plus = normalized.match(/^(\d+(?:\.\d+)?)m[- ]?plus$/i);
  if (plus) return `${plus[1]}M+ bracket`;
  const range = normalized.match(/^(\d+(?:\.\d+)?)m?-(\d+(?:\.\d+)?)m$/i);
  if (range) return `${range[1]}M–${range[2]}M bracket`;
  return `${value.replace(/_/g, " ")} bracket`;
}

function structuredRequestedAmount(text: string, file: GoogleDriveFile): { exact: AmountCandidate | null; bracket: BracketCandidate | null } {
  try {
    const parsed = JSON.parse(text) as any;
    const details = parsed?.qualificationDetails || parsed || {};
    const handoff = details?.candice_handoff_summary || {};
    const catalogue = details?.catalogue_metadata || {};
    const currencyHint = handoff.currency || details.catalogue_currency || catalogue.currency || "";
    const exactFields: Array<[unknown, string]> = [
      [details.tr_capital_ask, "qualificationDetails.tr_capital_ask"],
      [handoff.amountNeeded, "qualificationDetails.candice_handoff_summary.amountNeeded"],
      [catalogue.amount, "qualificationDetails.catalogue_metadata.amount"],
    ];
    const exactCandidates = exactFields
      .map(([value, field]) => parseExactAmountValue(value, currencyHint, file.name, file, field))
      .filter((candidate): candidate is AmountCandidate => Boolean(candidate));
    const distinctExact = new Set(exactCandidates.map(candidate => `${candidate.currency}:${candidate.amount}`));
    if (distinctExact.size > 1) {
      return {
        exact: null,
        bracket: {
          amount: null,
          currency: null,
          display: "Conflicting request values — review required",
          source: `${file.name} · conflicting authoritative request fields`,
          score: 20,
          evidence: evidence(file, "conflicting authoritative request fields", exactCandidates.map(candidate => candidate.evidence.excerpt).filter(Boolean).join(" | "), "ambiguous", "client_stated_bracket"),
        },
      };
    }
    if (exactCandidates[0]) return { exact: exactCandidates[0], bracket: null };
    const bracketFields: Array<[unknown, string]> = [
      [details.asset_loan_size, "qualificationDetails.asset_loan_size"],
      [details.gc_amount, "qualificationDetails.gc_amount"],
      [details.da_deal_size, "qualificationDetails.da_deal_size"],
      [details.wc_amount, "qualificationDetails.wc_amount"],
      [details.ref_deal_size, "qualificationDetails.ref_deal_size"],
      [details.pof_amount, "qualificationDetails.pof_amount"],
      [details.swiss_capital, "qualificationDetails.swiss_capital"],
    ];
    for (const [value, field] of bracketFields) {
      if (typeof value !== "string" || !value.trim()) continue;
      return {
        exact: null,
        bracket: {
          amount: null,
          currency: null,
          display: formatBracket(value),
          source: `${file.name} · ${field}`,
          score: 20,
          evidence: evidence(file, field, value, "ambiguous", "client_stated_bracket"),
        },
      };
    }
  } catch {
    // Invalid structured input is ignored and never converted into a money value.
  }
  return { exact: null, bracket: null };
}

export function extractAmountCandidates(text: string, source: string, file?: GoogleDriveFile): AmountCandidate[] {
  const candidates: AmountCandidate[] = [];
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  const pattern = /(US\$|USD|AUD\$?|A\$|CAD\$?|C\$|EUR|€|GBP|£|AED|SGD|CHF|JPY|INR|ZAR|HKD|NZD|SEK|NOK|DKK|PLN|BRL|MXN|CNY|SAR|QAR)\s*(\d(?:[\d,.]*\d)?)\s*(billion|bn|million|mn|thousand|b|m|k)?\+?/gi;
  const trailingPattern = /(\d(?:[\d,.]*\d)?)\s*(billion|bn|million|mn|thousand|b|m|k)?\s*(USD|AUD|CAD|EUR|GBP|AED|SGD|CHF|JPY|INR|ZAR|HKD|NZD|SEK|NOK|DKK|PLN|BRL|MXN|CNY|SAR|QAR)\b\+?/gi;
  for (const sourceSentence of sentences) {
    const clauses = sourceSentence.split(/;|,(?!\d)|\b(?:supported|secured)\s+by\b/i).map(value => value.trim()).filter(Boolean);
    for (const sentence of clauses) {
      const context = sentence.toLowerCase();
      const positive = /capital requested|capital ask|amount needed|amount requested|funding requested|funding required|loan amount requested|facility requested|requesting|seeking|needs?|requires?/.test(context);
      const disqualifying = /asset value|valuation|collateral value|revenue|turnover|sales|net worth|property value|portfolio value|fee|commission|deposit|retainer|monthly|annual/.test(context);
      if (!positive || disqualifying) continue;
      if (/\+|\b(minimum|at least|up to|approximately|approx\.?|around|about)\b/i.test(sentence)) continue;
      for (const match of Array.from(sentence.matchAll(pattern))) {
      const unit = match[3] || "";
      const rawNumber = parseConservativeNumber(match[2], Boolean(unit));
      if (rawNumber === null || !Number.isFinite(rawNumber) || rawNumber <= 0) continue;
      if (unit && rawNumber >= 1_000_000) continue;
      const amount = unit ? rawNumber * multiplier(unit) : rawNumber;
      const currency = currencyCode(match[1]);
      if (!currency || amount < 100_000 || amount > 100_000_000_000) continue;
      const fallbackFile = file || { id: "unknown", name: source, mimeType: "text/plain", modifiedTime: new Date(0).toISOString() };
      candidates.push({
        amount,
        currency,
        display: formatAmount(amount, currency),
        source,
        score: /capital requested|amount requested|loan amount requested|facility requested/.test(context) ? 12 : 9,
          evidence: evidence(fallbackFile, null, sentence, "medium", "client_stated_exact"),
        });
      }
      for (const match of Array.from(sentence.matchAll(trailingPattern))) {
        const unit = match[2] || "";
        const rawNumber = parseConservativeNumber(match[1], Boolean(unit));
        if (rawNumber === null || !Number.isFinite(rawNumber) || rawNumber <= 0) continue;
        if (unit && rawNumber >= 1_000_000) continue;
        const amount = unit ? rawNumber * multiplier(unit) : rawNumber;
        const currency = currencyCode(match[3]);
        if (!currency || amount < 100_000 || amount > 100_000_000_000) continue;
        const fallbackFile = file || { id: "unknown", name: source, mimeType: "text/plain", modifiedTime: new Date(0).toISOString() };
        candidates.push({
          amount,
          currency,
          display: formatAmount(amount, currency),
          source,
          score: /capital requested|amount requested|loan amount requested|facility requested/.test(context) ? 12 : 9,
          evidence: evidence(fallbackFile, null, sentence, "medium", "client_stated_exact"),
        });
      }
    }
  }
  return candidates;
}

function chooseRequestedAmount(candidates: AmountCandidate[]) {
  const credible = candidates.filter(candidate => candidate.score >= 8);
  if (!credible.length) return null;
  const topScore = Math.max(...credible.map(candidate => candidate.score));
  const strongest = credible.filter(candidate => candidate.score === topScore);
  const distinct = new Set(strongest.map(candidate => `${candidate.currency}:${candidate.amount}`));
  if (distinct.size > 1) return null;
  return strongest.sort((a, b) => b.evidence.fileModifiedTime.localeCompare(a.evidence.fileModifiedTime))[0] || null;
}

function chooseCurrentRequestedAmount(texts: Array<{ file: GoogleDriveFile; text: string; failed?: boolean }>): RequestedAmount | null {
  const exact: AmountCandidate[] = [];
  const brackets: BracketCandidate[] = [];
  for (const item of texts) {
    if (item.failed) continue;
    if (/qualification[- _]?snapshot/i.test(item.file.name)) {
      const structured = structuredRequestedAmount(item.text, item.file);
      if (structured.exact) exact.push(structured.exact);
      if (structured.bracket) brackets.push(structured.bracket);
    } else if (/conversation[- _]?summary/i.test(item.file.name)) {
      const summary = chooseRequestedAmount(extractAmountCandidates(item.text, item.file.name, item.file));
      if (summary?.amount != null) exact.push(summary as AmountCandidate);
    }
  }
  exact.sort((a, b) => b.evidence.fileModifiedTime.localeCompare(a.evidence.fileModifiedTime));
  brackets.sort((a, b) => b.evidence.fileModifiedTime.localeCompare(a.evidence.fileModifiedTime));
  const highConfidence = exact.filter(candidate => candidate.evidence.confidence === "high");
  const authoritative = highConfidence.length ? highConfidence : exact;
  const authoritativeValues = new Set(authoritative.map(candidate => `${candidate.currency}:${candidate.amount}`));
  const corroboratingValues = new Set(exact.map(candidate => `${candidate.currency}:${candidate.amount}`));
  const conflict = authoritativeValues.size > 1 || (highConfidence.length > 0 && corroboratingValues.size > 1);
  if (conflict) {
    const newest = authoritative[0];
    return {
      amount: null,
      currency: null,
      display: "Conflicting exact request values — human decision required",
      source: `${newest.evidence.fileName} · conflicting current evidence`,
      score: 0,
      evidence: {
        ...newest.evidence,
        fieldPath: "conflicting current evidence",
        excerpt: exact.map(candidate => `${candidate.currency} ${candidate.amount}`).join(" | ").slice(0, 240),
        confidence: "ambiguous",
        classification: "client_stated_bracket",
      },
    };
  }
  return authoritative[0] || brackets[0] || null;
}

function calculatePriority(deal: Omit<DriveDealSnapshot, "priorityScore">) {
  void deal;
  return 0;
}

async function buildDealSnapshot(folder: GoogleDriveFile): Promise<DriveDealSnapshot> {
  const files = await listFolderTree(folder.id);
  const documents = files.filter(file => file.mimeType !== GOOGLE_FOLDER);
  const uploads = documents.filter(file => !isSystemFile(file.name));
  const keyFiles = documents
    .filter(file => /qualification[- _]?snapshot|conversation[- _]?summary|^status(?:[- _:.]|$)/i.test(file.name) && isReadableText(file))
    .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  const reads = await mapWithConcurrency(keyFiles, 3, async file => {
    try { return { file, text: await downloadText(file), failed: false }; }
    catch { return { file, text: "", failed: true }; }
  });
  const texts = reads.filter(read => !read.failed);
  const unreadableStatus = reads.find(read => read.failed && /^status(?:[- _:.]|$)/i.test(read.file.name));
  const classifiedStatus = classifyStatus(files, texts.filter(({ file }) => /^status(?:[- _:.]|$)/i.test(file.name)));
  let status = unreadableStatus ? {
    status: "needs_review" as const,
    reason: "A controlled status file could not be read; terminal status is not assumed",
    confidence: "conflict" as const,
    evidence: unreadableStatus.file,
  } : classifiedStatus;
  const requested = chooseCurrentRequestedAmount(reads);
  if (requested?.amount === null && requested.display.startsWith("Conflicting exact request values")) {
    status = {
      status: "needs_review",
      reason: "Conflicting exact request amounts require a human decision",
      confidence: "conflict",
      evidence: null,
    };
  }
  const latestDocumentModifiedTime = documents.reduce(
    (latest, file) => file.modifiedTime > latest ? file.modifiedTime : latest,
    folder.modifiedTime,
  );
  const email = extractEmail(folder.name);
  const checklistGaps = detectDocumentChecklistGaps(documents);
  const statusEvidence = status.evidence ? evidence(status.evidence, null, status.evidence.name, status.confidence === "explicit" ? "high" : "ambiguous", "status_marker") : null;
  const base: Omit<DriveDealSnapshot, "priorityScore"> = {
    id: folder.id,
    name: cleanDealName(folder.name, email),
    folderName: folder.name,
    email,
    driveUrl: `https://drive.google.com/drive/folders/${folder.id}`,
    modifiedTime: folder.modifiedTime,
    latestDocumentModifiedTime,
    daysSinceUpdate: Math.max(0, Math.floor((Date.now() - new Date(latestDocumentModifiedTime).getTime()) / 86_400_000)),
    status: status.status,
    statusReason: status.reason,
    statusConfidence: status.confidence,
    statusEvidence,
    documentCount: documents.length,
    uploadCount: uploads.length,
    documentNames: documents.map(file => file.name).sort().slice(0, 100),
    documentChecklistGaps: checklistGaps,
    documentAssessment: "filename_only",
    missingDocuments: checklistGaps,
    amount: requested?.amount ?? null,
    currency: requested?.currency ?? null,
    amountDisplay: requested?.display || null,
    amountSource: requested?.source || null,
    amountEvidence: requested?.evidence || null,
    amountClassification: requested ? (requested.amount === null ? "client_stated_bracket" : "client_stated_exact") : "unavailable",
    amountConfirmedByAfg: false,
    verifiedEligibleAmount: null,
    approvedFundableAmount: null,
    feeEligibleAmount: null,
    contractedFeeRate: null,
    earnedRevenue: null,
    minimumScreen: requested?.amount == null || !requested.currency ? "amount_unavailable" : requested.currency === "USD" ? (requested.amount >= 1_000_000 ? "passes_usd_1m" : "below_usd_1m") : "not_assessed_non_usd",
    duplicateOf: null,
    duplicateReason: null,
    duplicateReviewReason: null,
    evidenceReadErrorCount: reads.filter(read => read.failed).length,
  };
  return { ...base, priorityScore: calculatePriority(base) };
}

export type PublicDriveFolderInput = {
  folder: DriveFileRecord;
  files: DriveFileRecord[];
  evidenceTextByFileId: Record<string, string>;
  evidenceReadFailures?: string[];
};

function buildDealSnapshotFromPublicInput(input: PublicDriveFolderInput): DriveDealSnapshot {
  const folder = input.folder;
  const files = input.files;
  const documents = files.filter(file => file.mimeType !== GOOGLE_FOLDER);
  const uploads = documents.filter(file => !isSystemFile(file.name));
  const keyFiles = documents
    .filter(file => /qualification[- _]?snapshot|conversation[- _]?summary|^status(?:[- _:.]|$)/i.test(file.name) && isReadableText(file))
    .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  const failedIds = new Set(input.evidenceReadFailures || []);
  const reads = keyFiles.map(file => ({
    file,
    text: input.evidenceTextByFileId[file.id] || "",
    failed: failedIds.has(file.id),
  }));
  const texts = reads.filter(read => !read.failed);
  const unreadableStatus = reads.find(read => read.failed && /^status(?:[- _:.]|$)/i.test(read.file.name));
  const classifiedStatus = classifyStatus(files, texts.filter(({ file }) => /^status(?:[- _:.]|$)/i.test(file.name)));
  let status = unreadableStatus ? {
    status: "needs_review" as const,
    reason: "A controlled status file could not be read; terminal status is not assumed",
    confidence: "conflict" as const,
    evidence: unreadableStatus.file,
  } : classifiedStatus;
  const requested = chooseCurrentRequestedAmount(reads);
  if (requested?.amount === null && requested.display.startsWith("Conflicting exact request values")) {
    status = {
      status: "needs_review",
      reason: "Conflicting exact request amounts require a human decision",
      confidence: "conflict",
      evidence: null,
    };
  }
  const latestDocumentModifiedTime = documents.reduce(
    (latest, file) => file.modifiedTime > latest ? file.modifiedTime : latest,
    folder.modifiedTime,
  );
  const email = extractEmail(folder.name);
  const checklistGaps = detectDocumentChecklistGaps(documents);
  const statusEvidence = status.evidence ? evidence(status.evidence, null, status.evidence.name, status.confidence === "explicit" ? "high" : "ambiguous", "status_marker") : null;
  const base: Omit<DriveDealSnapshot, "priorityScore"> = {
    id: folder.id,
    name: cleanDealName(folder.name, email),
    folderName: folder.name,
    email,
    driveUrl: `https://drive.google.com/drive/folders/${folder.id}`,
    modifiedTime: folder.modifiedTime,
    latestDocumentModifiedTime,
    daysSinceUpdate: Math.max(0, Math.floor((Date.now() - new Date(latestDocumentModifiedTime).getTime()) / 86_400_000)),
    status: status.status,
    statusReason: status.reason,
    statusConfidence: status.confidence,
    statusEvidence,
    documentCount: documents.length,
    uploadCount: uploads.length,
    documentNames: documents.map(file => file.name).sort().slice(0, 100),
    documentChecklistGaps: checklistGaps,
    documentAssessment: "filename_only",
    missingDocuments: checklistGaps,
    amount: requested?.amount ?? null,
    currency: requested?.currency ?? null,
    amountDisplay: requested?.display || null,
    amountSource: requested?.source || null,
    amountEvidence: requested?.evidence || null,
    amountClassification: requested ? (requested.amount === null ? "client_stated_bracket" : "client_stated_exact") : "unavailable",
    amountConfirmedByAfg: false,
    verifiedEligibleAmount: null,
    approvedFundableAmount: null,
    feeEligibleAmount: null,
    contractedFeeRate: null,
    earnedRevenue: null,
    minimumScreen: requested?.amount == null || !requested.currency ? "amount_unavailable" : requested.currency === "USD" ? (requested.amount >= 1_000_000 ? "passes_usd_1m" : "below_usd_1m") : "not_assessed_non_usd",
    duplicateOf: null,
    duplicateReason: null,
    duplicateReviewReason: null,
    evidenceReadErrorCount: failedIds.size,
  };
  return { ...base, priorityScore: calculatePriority(base) };
}

export function markDuplicateCandidates(deals: DriveDealSnapshot[]) {
  const parent = new Map(deals.map(deal => [deal.id, deal.id]));
  const find = (id: string): string => {
    const current = parent.get(id) || id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent.set(right, left);
  };
  const normalizedName = (item: DriveDealSnapshot) => item.name
    .toLowerCase()
    .replace(/\(broker:.*$/i, "")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "")
    .replace(/\b(copy|duplicate|dup)\b|\(\d+\)|[^a-z0-9]+/g, " ")
    .trim();
  const byEmail = new Map<string, DriveDealSnapshot[]>();
  const byName = new Map<string, DriveDealSnapshot[]>();
  for (const deal of deals) {
    deal.duplicateOf = null;
    deal.duplicateReason = null;
    deal.duplicateReviewReason = null;
    if (deal.email) byEmail.set(deal.email, [...(byEmail.get(deal.email) || []), deal]);
    const name = normalizedName(deal);
    if (name.length >= 5) byName.set(name, [...(byName.get(name) || []), deal]);
  }
  for (const group of [...byEmail.values(), ...byName.values()]) {
    if (group.length < 2) continue;
    for (let index = 1; index < group.length; index++) union(group[0].id, group[index].id);
  }
  const groups = new Map<string, DriveDealSnapshot[]>();
  for (const deal of deals) groups.set(find(deal.id), [...(groups.get(find(deal.id)) || []), deal]);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => b.uploadCount - a.uploadCount || b.latestDocumentModifiedTime.localeCompare(a.latestDocumentModifiedTime) || a.id.localeCompare(b.id));
    const primary = ordered[0];
    primary.duplicateReviewReason = "Potential duplicate group; provisional primary retained pending a human merge-or-separate decision";
    for (const twin of ordered.slice(1)) {
      twin.duplicateOf = primary.id;
      twin.duplicateReason = "Potential duplicate twin held pending a human merge-or-separate decision";
    }
  }
  return deals;
}

function snapshotHash(deals: DriveDealSnapshot[]) {
  const payload = deals
    .map(deal => ({
      id: deal.id,
      status: deal.status,
      statusReason: deal.statusReason,
      statusConfidence: deal.statusConfidence,
      statusEvidence: deal.statusEvidence ? [deal.statusEvidence.fileId, deal.statusEvidence.fileModifiedTime, deal.statusEvidence.excerpt] : null,
      latestDocumentModifiedTime: deal.latestDocumentModifiedTime,
      documentCount: deal.documentCount,
      uploadCount: deal.uploadCount,
      documentChecklistGaps: deal.documentChecklistGaps,
      amount: deal.amount,
      currency: deal.currency,
      amountClassification: deal.amountClassification,
      amountEvidence: deal.amountEvidence ? [deal.amountEvidence.fileId, deal.amountEvidence.fileModifiedTime, deal.amountEvidence.fieldPath, deal.amountEvidence.excerpt] : null,
      minimumScreen: deal.minimumScreen,
      duplicateReason: deal.duplicateReason,
      duplicateReviewReason: deal.duplicateReviewReason,
      duplicateOf: deal.duplicateOf,
      evidenceReadErrorCount: deal.evidenceReadErrorCount,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
}

function snapshotFromDeals(folders: GoogleDriveFile[], rawDeals: DriveDealSnapshot[], nowIso: string, failedFolderCount = 0): DriveSnapshot {
  const deals = markDuplicateCandidates(rawDeals);
  const openDeals = deals.filter(deal => ["active", "intake_only"].includes(deal.status));
  const duplicateHeld = (deal: DriveDealSnapshot) => Boolean(deal.duplicateOf || deal.duplicateReason || deal.duplicateReviewReason);
  const aggregateDeals = openDeals.filter(deal => !duplicateHeld(deal) && deal.evidenceReadErrorCount === 0);
  const evidenceReadErrorCount = deals.reduce((sum, deal) => sum + deal.evidenceReadErrorCount, 0);
  const partial = failedFolderCount > 0 || evidenceReadErrorCount > 0;
  const totalize = (sourceDeals: DriveDealSnapshot[]) => {
    const totals = new Map<string, { amount: number; dealCount: number }>();
    for (const deal of sourceDeals) {
      if (!deal.amount || !deal.currency || deal.amountClassification !== "client_stated_exact" || deal.minimumScreen !== "passes_usd_1m") continue;
      const current = totals.get(deal.currency) || { amount: 0, dealCount: 0 };
      current.amount += deal.amount;
      current.dealCount += 1;
      totals.set(deal.currency, current);
    }
    return Array.from(totals.entries()).map(([currency, value]) => ({
      currency,
      amount: value.amount,
      mathematicalThreePercent: Number((value.amount * 0.03).toFixed(2)),
      dealCount: value.dealCount,
      basis: "client_stated_exact_unconfirmed" as const,
    })).sort((a, b) => b.amount - a.amount);
  };
  const totalsByCurrency = totalize(aggregateDeals);
  const grossTotalsByCurrency = totalize(openDeals.filter(deal => deal.evidenceReadErrorCount === 0));
  const sourceModifiedAt = deals.reduce<string | null>((latest, deal) => !latest || deal.latestDocumentModifiedTime > latest ? deal.latestDocumentModifiedTime : latest, null);
  const dayAgo = Date.now() - 86_400_000;
  const sortedDeals = [...deals].sort((a, b) => b.priorityScore - a.priorityScore || b.latestDocumentModifiedTime.localeCompare(a.latestDocumentModifiedTime));
  return {
    version: 10,
    parserVersion: "10.0",
    snapshotId: snapshotHash(deals),
    source: "google_drive",
    sourceName: "AFG Client Data",
    folderId: DRIVE_FOLDER_ID,
    folderUrl: DRIVE_FOLDER_URL,
    connection: partial ? "partial_snapshot" : "fresh_snapshot",
    lastCheckedAt: nowIso,
    lastFullSyncAt: nowIso,
    sourceModifiedAt,
    totalFolders: folders.length,
    scannedFolders: deals.length,
    buckets: {
      active: deals.filter(deal => deal.status === "active").length,
      intakeOnly: deals.filter(deal => deal.status === "intake_only").length,
      funded: deals.filter(deal => deal.status === "funded").length,
      closed: deals.filter(deal => deal.status === "closed").length,
      needsReview: deals.filter(deal => deal.status === "needs_review").length,
    },
    totalsByCurrency,
    grossTotalsByCurrency,
    valuedDealCount: aggregateDeals.filter(deal => deal.amount && deal.currency && deal.amountClassification === "client_stated_exact" && deal.minimumScreen === "passes_usd_1m").length,
    confirmedValuedDealCount: 0,
    duplicateCandidateCount: deals.filter(deal => deal.duplicateReason || deal.duplicateReviewReason).length,
    duplicateHeldValuedCount: openDeals.filter(deal => duplicateHeld(deal) && deal.amount && deal.currency && deal.amountClassification === "client_stated_exact" && deal.minimumScreen === "passes_usd_1m").length,
    reviewQueueCount: openDeals.filter(deal => deal.status === "active" && deal.uploadCount > 0 && !duplicateHeld(deal) && deal.evidenceReadErrorCount === 0).length,
    changedInLast24Hours: deals.filter(deal => new Date(deal.latestDocumentModifiedTime).getTime() >= dayAgo).length,
    failedFolderCount,
    evidenceReadErrorCount,
    deals: sortedDeals,
    error: partial ? `${failedFolderCount} folder(s) and ${evidenceReadErrorCount} evidence file(s) could not be fully scanned` : undefined,
  };
}

export function buildDriveSnapshotFromPublicInputs(
  inputs: PublicDriveFolderInput[],
  failedFolderCount = 0,
  totalFolderCount = inputs.length + failedFolderCount,
  nowIso = new Date().toISOString(),
  excludeFolderIds: Iterable<string> = [],
): DriveSnapshot {
  const excluded = new Set(excludeFolderIds);
  const includedInputs = inputs.filter(input => !excluded.has(input.folder.id));
  const effectiveTotalFolderCount = Math.max(0, totalFolderCount - (inputs.length - includedInputs.length));
  const deals = includedInputs.map(buildDealSnapshotFromPublicInput);
  if (!isDriveScanCompleteEnough(effectiveTotalFolderCount, deals.length, failedFolderCount)) {
    throw new Error("Public Google Drive scan failed the completeness threshold");
  }
  const folders = includedInputs.map(input => input.folder);
  const snapshot = snapshotFromDeals(folders, deals, nowIso, failedFolderCount);
  snapshot.totalFolders = effectiveTotalFolderCount;
  snapshot.scannedFolders = deals.length;
  return snapshot;
}

export async function syncDriveSnapshot(options: { persist?: boolean; excludeFolderIds?: Iterable<string> } = {}): Promise<DriveSnapshot> {
  const allFolders = await listClientFolders();
  const excluded = new Set(options.excludeFolderIds || []);
  const folders = allFolders.filter(folder => !excluded.has(folder.id));
  if (!folders.length) throw new Error("The AFG Client Data folder is reachable but contains no included client folders");
  const outcomes = await mapWithConcurrency(folders, 6, async folder => {
    try { return { deal: await buildDealSnapshot(folder), failed: false }; }
    catch { return { deal: null, failed: true }; }
  });
  const failedFolderCount = outcomes.filter(outcome => outcome.failed).length;
  const deals = outcomes.flatMap(outcome => outcome.deal ? [outcome.deal] : []);
  if (!isDriveScanCompleteEnough(folders.length, deals.length, failedFolderCount)) throw new Error("Google Drive scan failed the completeness threshold");
  const snapshot = snapshotFromDeals(folders, deals, new Date().toISOString(), failedFolderCount);
  if (options.persist !== false) {
    await db.cacheInsight(SNAPSHOT_CACHE_KEY, snapshot, SNAPSHOT_TTL_MINUTES);
    liveCheckCache = { snapshot, checkedAt: Date.now() };
  }
  return snapshot;
}

export function isDriveScanCompleteEnough(totalFolders: number, successfulFolders: number, failedFolders: number) {
  if (totalFolders <= 0 || successfulFolders <= 0) return false;
  const maximumSafeFailures = Math.max(1, Math.ceil(totalFolders * 0.1));
  return failedFolders <= maximumSafeFailures && successfulFolders / totalFolders >= 0.9;
}

export function activateDriveSnapshot(snapshot: DriveSnapshot) {
  liveCheckCache = { snapshot, checkedAt: Date.now() };
}

function isCompatibleSnapshot(value: unknown): value is DriveSnapshot {
  const snapshot = value as DriveSnapshot | undefined;
  return snapshot?.version === 10 && snapshot.folderId === DRIVE_FOLDER_ID && Array.isArray(snapshot.deals) && typeof snapshot.snapshotId === "string";
}

export async function getStoredDriveSnapshot(): Promise<DriveSnapshot | null> {
  const cached = await db.getLatestInsight(SNAPSHOT_CACHE_KEY).catch(() => null);
  return cached && isCompatibleSnapshot(cached.content) ? cached.content : null;
}

export function isSnapshotCurrentForBusinessDay(lastFullSyncAt: string, now = new Date()) {
  const age = now.getTime() - new Date(lastFullSyncAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age > FULL_SYNC_MAX_AGE_MS) return false;
  return getEasternBusinessDate(new Date(lastFullSyncAt)) === getEasternBusinessDate(now);
}

export function getEasternBusinessDate(now = new Date()) {
  const eastern = getEasternDateParts(now);
  if (eastern.hour >= 5) return eastern.date;
  const [year, month, day] = eastern.date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

async function refreshOrCheckSnapshot(force: boolean): Promise<DriveSnapshot> {
  const stored = await getStoredDriveSnapshot();
  if (force || !stored) return syncDriveSnapshot();
  const age = Date.now() - new Date(stored.lastFullSyncAt).getTime();
  const stillCurrentForBusinessDay = isSnapshotCurrentForBusinessDay(stored.lastFullSyncAt);
  if (stillCurrentForBusinessDay) {
    const remainsPartial = stored.failedFolderCount > 0 || stored.evidenceReadErrorCount > 0;
    const snapshot = { ...stored, connection: remainsPartial ? "partial_snapshot" as const : "stored_snapshot" as const, lastCheckedAt: new Date().toISOString(), error: remainsPartial ? stored.error : undefined };
    liveCheckCache = { snapshot, checkedAt: Date.now() };
    return snapshot;
  }
  try {
    return await syncDriveSnapshot();
  } catch (error) {
    if (Number.isFinite(age) && age <= MAX_STALE_AGE_MS) {
      const stale = { ...stored, connection: "stale_snapshot" as const, error: sanitizeError(error) };
      liveCheckCache = { snapshot: stale, checkedAt: Date.now() };
      return stale;
    }
    throw new Error("Google Drive data is unavailable and the last snapshot is too old to use safely");
  }
}

export async function getLiveDriveSnapshot(options: { force?: boolean } = {}): Promise<DriveSnapshot> {
  const force = options.force === true;
  if (!force && liveCheckCache && Date.now() - liveCheckCache.checkedAt < OPEN_CHECK_MAX_AGE_MS) return liveCheckCache.snapshot;
  if (currentOperation && (!force || currentOperation.mode === "force")) return currentOperation.promise;
  const prior = currentOperation?.promise;
  const operation = { mode: force ? "force" as const : "check" as const, promise: Promise.resolve(null as unknown as DriveSnapshot) };
  operation.promise = (prior ? prior.catch(() => undefined).then(() => refreshOrCheckSnapshot(force)) : refreshOrCheckSnapshot(force))
    .finally(() => {
      if (currentOperation === operation) currentOperation = null;
    });
  currentOperation = operation;
  return operation.promise;
}

export function getEasternDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || "";
  return { date: `${pick("year")}-${pick("month")}-${pick("day")}`, hour: Number(pick("hour")), minute: Number(pick("minute")) };
}

function easternLocalMidnightToUtc(year: number, monthIndex: number, day: number) {
  const target = Date.UTC(year, monthIndex, day, 0, 0, 0);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    guess += target - represented;
  }
  return new Date(guess);
}

export function getEasternWeekStart(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("weekStart must be YYYY-MM-DD");
  const [year, month, day] = value.split("-").map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) throw new Error("Invalid weekStart date");
  const daysSinceMonday = (calendarDate.getUTCDay() + 6) % 7;
  calendarDate.setUTCDate(calendarDate.getUTCDate() - daysSinceMonday);
  return easternLocalMidnightToUtc(calendarDate.getUTCFullYear(), calendarDate.getUTCMonth(), calendarDate.getUTCDate());
}

export function getEasternMonthWindow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(now).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const year = Number(parts.year);
  const monthIndex = Number(parts.month) - 1;
  return {
    start: easternLocalMidnightToUtc(year, monthIndex, 1).toISOString(),
    endExclusive: easternLocalMidnightToUtc(year, monthIndex + 1, 1).toISOString(),
  };
}

export const __testing = {
  formatBracket,
  statusFromMarker,
  snapshotHash,
  snapshotFromDeals,
  chooseCurrentRequestedAmount,
};
