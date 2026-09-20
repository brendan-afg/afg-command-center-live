import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { DriveDealSnapshot } from "../server/driveSync";
import type { DealReadBundle, FullReadResult } from "./full-file-reader";
import { PROVIDERS, publicProvider, type ProviderProfile } from "./provider-directory";

const CACHE_PATH = "/home/ubuntu/afg-command-center-analysis-cache.json";
const MODEL = "gpt-5-mini";
const MAX_CONCURRENCY = 6;
const PRODUCT_NAMES = [
  "Asset-Secured Capital",
  "Purchase Order Financing",
  "Working Capital Against Revenue",
  "SBLC-Backed Capital",
  "Asset Transformation",
  "Proof of Funds Letter",
  "Contract-Backed / Exit-Based Capital",
  "Capital Advisory",
  "No confirmed product fit",
] as const;

type ProductName = typeof PRODUCT_NAMES[number];
type EvidenceCitation = { claim: string; fileName: string; quote: string };
type ValidatedEvidenceCitation = EvidenceCitation & { fileId: string; extractionStatus: "read" };
type ModelAnalysis = {
  clientNeed: string;
  businessDescription: string;
  sector: string;
  jurisdiction: string;
  requestedAmountText: string;
  recommendedProduct: ProductName;
  productConfidence: "high" | "medium" | "low";
  readiness: "provider_ready" | "advisory_first" | "needs_verification" | "do_not_contact";
  whyThisProduct: string;
  providedItems: string[];
  notLocatedItems: string[];
  redFlags: string[];
  bestNextAction: string;
  evidence: EvidenceCitation[];
};

export type ProviderMatch = ReturnType<typeof publicProvider> & {
  fit: string;
  matchState: "ready_to_confirm" | "hold_until_checklist_complete" | "confirm_capability_first";
  roleplay: string;
  draft: string;
};

export type FullDealAnalysis = ModelAnalysis & {
  dealId: string;
  name: string;
  driveUrl: string;
  contactEmail: string | null;
  status: DriveDealSnapshot["status"];
  exactAmount: number | null;
  currency: string | null;
  readCoverage: {
    inventoryCount: number;
    readableCount: number;
    partialCount: number;
    emptyCount: number;
    unsupportedCount: number;
    tooLargeCount: number;
    failedCount: number;
    extractedCharacters: number;
  };
  documentLedger: Array<{
    fileId: string;
    fileName: string;
    modifiedTime: string;
    method: string;
    status: string;
    originalCharacters: number;
    retainedCharacters: number;
    truncated: boolean;
    note: string | null;
  }>;
  providedEvidence: ValidatedEvidenceCitation[];
  outreachAuthorized: boolean;
  analysisModel: string;
  analysisGeneratedAt: string;
  analysisHash: string;
  providerMatches: ProviderMatch[];
  advisoryOffer: null | {
    service: "Capital Advisory";
    why: string;
    deliverables: string[];
    roleplay: string;
    draft: string;
  };
  clientChecklistMessage: null | {
    roleplay: string;
    guard: string;
    draft: string;
  };
};

type Cache = Record<string, { hash: string; analysis: ModelAnalysis; generatedAt: string }>;

const analysisSchema = {
  type: "object",
  properties: {
    clientNeed: { type: "string" },
    businessDescription: { type: "string" },
    sector: { type: "string" },
    jurisdiction: { type: "string" },
    requestedAmountText: { type: "string" },
    recommendedProduct: { type: "string", enum: PRODUCT_NAMES },
    productConfidence: { type: "string", enum: ["high", "medium", "low"] },
    readiness: { type: "string", enum: ["provider_ready", "advisory_first", "needs_verification", "do_not_contact"] },
    whyThisProduct: { type: "string" },
    providedItems: { type: "array", items: { type: "string" }, maxItems: 10 },
    notLocatedItems: { type: "array", items: { type: "string" }, maxItems: 10 },
    redFlags: { type: "array", items: { type: "string" }, maxItems: 8 },
    bestNextAction: { type: "string" },
    evidence: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: { claim: { type: "string" }, fileName: { type: "string" }, quote: { type: "string" } },
        required: ["claim", "fileName", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["clientNeed", "businessDescription", "sector", "jurisdiction", "requestedAmountText", "recommendedProduct", "productConfidence", "readiness", "whyThisProduct", "providedItems", "notLocatedItems", "redFlags", "bestNextAction", "evidence"],
  additionalProperties: false,
};

function clip(value: string, max = 260) {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function fallbackAnalysis(deal: DriveDealSnapshot, bundle: DealReadBundle): ModelAnalysis {
  const terminal = ["closed", "funded"].includes(deal.status);
  return {
    clientNeed: "The client need could not be confirmed from readable document contents.",
    businessDescription: "Not confirmed from readable evidence.",
    sector: "Not confirmed",
    jurisdiction: "Not confirmed",
    requestedAmountText: deal.amountDisplay || "No exact amount confirmed",
    recommendedProduct: "No confirmed product fit",
    productConfidence: "low",
    readiness: terminal ? "do_not_contact" : "needs_verification",
    whyThisProduct: terminal ? "The file is marked terminal and must not enter outreach." : "The file needs a human evidence review before a financing product or provider can be selected.",
    providedItems: [],
    notLocatedItems: [],
    redFlags: bundle.inventoryCount ? ["No complete, validated evidence set supports an external recommendation"] : ["No document evidence is available"],
    bestNextAction: terminal ? "Keep the file out of outreach." : "Open the folder and complete the product-fit checklist with the client.",
    evidence: [],
  };
}

function documentPrompt(deal: DriveDealSnapshot, bundle: DealReadBundle) {
  const documents = bundle.documents.map(item => `\n--- FILE: ${item.fileName} | modified ${item.modifiedTime} | read=${item.status} ---\n${item.text || `[${item.note || item.status}]`}`).join("\n");
  return `Analyze one AltFunds Global client folder. Use only the supplied Drive evidence. Do not claim approval, fundability, client authorship, missing documents, or provider fit beyond the evidence. Say \"not located\" rather than \"missing\". A filename alone may support that a file exists but not its contents. Exact status conflicts, suspected duplicates, closed, or funded states require human review and no outreach.\n\nAFG products allowed:\n- Asset-Secured Capital: senior/bridge debt secured by verifiable assets or real estate.\n- Purchase Order Financing: signed credible buyer order plus supplier and fulfilment evidence.\n- Working Capital Against Revenue: operating business with recurring revenue, receivables, or cash flow.\n- SBLC-Backed Capital: genuine bank instrument, issuer, ownership, SWIFT/compliance evidence.\n- Asset Transformation: convert owned revenue-producing or essential-use assets into liquidity.\n- Proof of Funds Letter: defined transaction requiring evidence of funds.\n- Contract-Backed / Exit-Based Capital: contract, committed exit, or acquisition structure.\n- Capital Advisory: paid file-readiness, structuring, evidence packaging, and lender-readiness when the file is not provider-ready.\n\nFile metadata:\nName: ${deal.name}\nDrive status parser: ${deal.status} (${deal.statusReason})\nExact amount evidence: ${deal.amountDisplay || "none"}\nDuplicate warning: ${deal.duplicateReason || deal.duplicateReviewReason || deal.duplicateOf || "none"}\nContact email found: ${deal.email || "none"}\n\nFor readiness, provider_ready requires readable evidence of the request, use of funds, repayment path, entity/identity, and product-specific security/contract/revenue evidence. If not, use advisory_first or needs_verification. Evidence quotes must be short exact excerpts copied from the named file.\n\n${documents}`;
}

async function callModel(prompt: string): Promise<ModelAnalysis> {
  const base = process.env.OPENAI_API_BASE?.replace(/\/$/, "");
  const key = process.env.OPENAI_API_KEY;
  if (!base || !key) throw new Error("LLM runtime unavailable");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: "You are a conservative structured-finance file analyst. Return valid JSON matching the schema. Never invent evidence." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_schema", json_schema: { name: "afg_file_analysis", strict: true, schema: analysisSchema } },
      max_completion_tokens: 3000,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 220)}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("LLM returned no content");
  return JSON.parse(content) as ModelAnalysis;
}

function validateEvidence(analysis: ModelAnalysis, bundle: DealReadBundle) {
  const byName = new Map(bundle.documents.map(item => [item.fileName, item]));
  analysis.evidence = analysis.evidence.filter(item => {
    const document = byName.get(item.fileName);
    if (!document || document.status !== "read") return false;
    const source = document.text;
    const quote = item.quote.replace(/\s+/g, " ").trim().toLowerCase();
    return quote.length >= 8 && source.replace(/\s+/g, " ").toLowerCase().includes(quote);
  }).map(item => ({ ...item, claim: clip(item.claim), quote: clip(item.quote, 300) }));
  analysis.providedItems = [...new Set(analysis.evidence.map(item => clip(item.claim)).filter(Boolean))];
  const completeCoverage = bundle.partialCount === 0 && bundle.emptyCount === 0 && bundle.unsupportedCount === 0 && bundle.tooLargeCount === 0 && bundle.failedCount === 0;
  analysis.notLocatedItems = completeCoverage ? [...new Set(analysis.notLocatedItems.map(item => clip(item)).filter(Boolean))] : [];
  analysis.redFlags = [...new Set(analysis.redFlags.map(item => clip(item)).filter(Boolean))];
  if (!completeCoverage) analysis.redFlags.unshift("At least one file is partial, empty, unsupported, oversized, or failed; absence claims and external outreach are blocked");
  for (const key of ["clientNeed", "businessDescription", "sector", "jurisdiction", "requestedAmountText", "whyThisProduct", "bestNextAction"] as const) analysis[key] = clip(analysis[key], key === "businessDescription" ? 420 : 300);
  return analysis;
}

function validatedProvidedEvidence(analysis: ModelAnalysis, bundle: DealReadBundle): ValidatedEvidenceCitation[] {
  const documents = new Map(bundle.documents.map(item => [item.fileName, item]));
  return analysis.evidence.flatMap(item => {
    const document = documents.get(item.fileName);
    return document?.status === "read" ? [{ ...item, fileId: document.fileId, extractionStatus: "read" as const }] : [];
  });
}

function scoreProvider(provider: ProviderProfile, analysis: ModelAnalysis, deal: DriveDealSnapshot) {
  const text = `${analysis.recommendedProduct} ${analysis.clientNeed} ${analysis.businessDescription} ${analysis.sector} ${analysis.jurisdiction}`.toLowerCase();
  let score = 0;
  for (const product of provider.products) if (text.includes(product.toLowerCase())) score += 5;
  if (provider.id === "pensam-capital" && /multifamily/.test(text)) score += 10;
  if (provider.id === "kennedy-funding" && /commercial real estate|real estate|land|development/.test(text)) score += 8;
  if (provider.id === "eldridge-capital-management" && /essential.use|equipment|sale.leaseback|revenue.producing asset/.test(text)) score += 10;
  if (provider.id === "slr-business-credit" && /receivable|inventory|working capital|factoring|manufacturer|wholesale|digital media|ad tech/.test(text)) score += 8;
  if (provider.id === "sallyport-commercial-finance" && /purchase order|signed order|receivable|inventory/.test(text)) score += 7;
  if (provider.id === "white-oak-commercial-finance" && /asset.secured|receivable|inventory|fixed asset|machinery|equipment|real estate/.test(text)) score += 9;
  if (provider.id === "ecapital-supply-chain-finance" && /purchase order|supply chain|receivable|working capital|manufactur|wholesale|distribution|consumer goods|healthcare|transport/.test(text)) score += 9;
  const confidence = provider.confidence === "provider_confirmed" ? 100 : provider.confidence === "afg_claim_provider_replied" ? 25 : 0;
  return score + confidence;
}

function geographyEligible(provider: ProviderProfile, jurisdiction: string) {
  const place = jurisdiction.toLowerCase();
  if (!place || /not confirmed|unknown|unclear/.test(place)) return false;
  const regions = provider.geographies.join(" ").toLowerCase();
  if (regions.includes("confirm jurisdiction")) return false;
  const us = /united states|\busa\b|\bu\.s\.?\b|california|florida|texas|new york/.test(place);
  const canada = /canada|ontario|quebec|alberta|british columbia/.test(place);
  const mexico = /mexico/.test(place);
  const europe = /europe|united kingdom|\buk\b|germany|france|italy|spain|switzerland|netherlands/.test(place);
  const australia = /australia/.test(place);
  if (regions === "united states") return us;
  if (regions.includes("united states") && regions.includes("canada")) return us || canada;
  if (regions.includes("north america")) return us || canada || mexico;
  if (regions.includes("europe") || regions.includes("australia")) return (regions.includes("north america") && (us || canada || mexico)) || (regions.includes("europe") && europe) || (regions.includes("australia") && australia);
  return false;
}

function productEvidenceEligible(provider: ProviderProfile, analysis: ModelAnalysis) {
  const allowedProducts: Record<string, ProductName[]> = {
    "pensam-capital": ["Asset-Secured Capital"],
    "kennedy-funding": ["Asset-Secured Capital"],
    "eldridge-capital-management": ["Asset-Secured Capital", "Asset Transformation"],
    "slr-business-credit": ["Asset-Secured Capital", "Working Capital Against Revenue"],
    "sallyport-commercial-finance": ["Purchase Order Financing", "Working Capital Against Revenue"],
    "white-oak-commercial-finance": ["Asset-Secured Capital", "Working Capital Against Revenue"],
    "ecapital-supply-chain-finance": ["Purchase Order Financing", "Working Capital Against Revenue"],
  };
  if (!(allowedProducts[provider.id] || []).includes(analysis.recommendedProduct)) return false;
  const text = analysis.evidence.map(item => `${item.claim} ${item.quote}`).join(" ").toLowerCase();
  const productEvidence = analysis.recommendedProduct === "Purchase Order Financing"
    ? /purchase order|signed order|buyer order|supplier/.test(text)
    : analysis.recommendedProduct === "Working Capital Against Revenue"
      ? /accounts receivable|receivable|recurring revenue|cash flow|factoring|inventory/.test(text)
      : analysis.recommendedProduct === "Asset Transformation"
        ? /essential.use|equipment|sale.leaseback|revenue.producing asset|owned asset/.test(text)
        : analysis.recommendedProduct === "Asset-Secured Capital"
          ? /asset|collateral|property|real estate|equipment|land/.test(text)
          : false;
  if (!productEvidence) return false;
  if (provider.id === "pensam-capital") return /multifamily/.test(text);
  if (provider.id === "kennedy-funding") return /commercial real estate|real estate|land|development/.test(text);
  if (provider.id === "eldridge-capital-management") return /essential.use|equipment|sale.leaseback|revenue.producing asset/.test(text);
  if (provider.id === "slr-business-credit") return /commercial accounts receivable|receivable|inventory|factoring/.test(text);
  if (provider.id === "sallyport-commercial-finance") return /purchase order|signed order|receivable|inventory/.test(text);
  if (provider.id === "white-oak-commercial-finance") return /performing receivable|receivable|inventory|fixed asset|machinery|equipment|real estate/.test(text);
  if (provider.id === "ecapital-supply-chain-finance") return /purchase order|supplier|supply chain|accounts receivable|receivable/.test(text);
  return false;
}

export function providerEligibility(provider: ProviderProfile, analysis: ModelAnalysis, deal: DriveDealSnapshot) {
  if (analysis.readiness !== "provider_ready") return { eligible: false, reason: "The file is not provider-ready" };
  if (analysis.evidence.length < 2) return { eligible: false, reason: "Fewer than two source-backed facts support the fit" };
  const evidenceText = analysis.evidence.map(item => `${item.claim} ${item.quote}`).join(" ");
  if (!geographyEligible(provider, evidenceText)) return { eligible: false, reason: "The jurisdiction is outside or not confirmed within source-backed evidence for the provider's stated coverage" };
  if (deal.currency !== "USD" || deal.amount == null) return { eligible: false, reason: "An exact USD request is not confirmed" };
  if (provider.minimumUsd != null && deal.amount < provider.minimumUsd) return { eligible: false, reason: "The exact request is below the provider's stated minimum" };
  if (provider.maximumUsd != null && deal.amount > provider.maximumUsd) return { eligible: false, reason: "The exact request is above the provider's stated maximum" };
  if (!productEvidenceEligible(provider, analysis)) return { eligible: false, reason: "The source-backed facts do not satisfy the provider's basic product evidence gate" };
  return { eligible: true, reason: "Basic product, evidence, amount, currency, and geography gates pass; mandate and underwriting remain unconfirmed" };
}

function providerDraft(provider: ProviderProfile, analysis: ModelAnalysis, ready: boolean) {
  const firstName = provider.contactName.split(/\s+/)[0];
  const ask = clip(analysis.clientNeed, 160);
  const known = analysis.providedItems.slice(0, 2).join("; ") || "the initial file package";
  const gaps = analysis.notLocatedItems.slice(0, 2).join("; ") || "the final provider checklist";
  const qualifier = provider.confidence === "provider_confirmed" ? "fits your current box" : provider.confidence === "public_candidate" ? "fits the capabilities listed on your official site" : "may fit the capabilities referenced in our earlier exchange; the mandate and terms remain unconfirmed";
  return `Hi ${firstName},\n\nWe have a ${clip(analysis.sector, 70)} file involving ${ask}. Before I send a package, I want to confirm it still ${qualifier}.\n\nWhat we have: ${known}.\nWhat we are ${ready ? "confirming" : "still completing"}: ${gaps}.\n\nIf this is within your current mandate, I can send a one-page summary once the file is ready. Would you be open to a short fit check?\n\nBest,\nTaimour`;
}

export function matchProviders(analysis: ModelAnalysis, deal: DriveDealSnapshot): ProviderMatch[] {
  if (analysis.readiness !== "provider_ready" || ["closed", "funded", "needs_review"].includes(deal.status) || deal.duplicateOf || deal.duplicateReason || deal.duplicateReviewReason) return [];
  const ready = true;
  return PROVIDERS.map(provider => ({ provider, score: scoreProvider(provider, analysis, deal), eligibility: providerEligibility(provider, analysis, deal) }))
    .filter(item => item.eligibility.eligible && item.score >= 5)
    .sort((a, b) => b.score - a.score || a.provider.company.localeCompare(b.provider.company))
    .slice(0, 3)
    .map(({ provider }) => ({
      ...publicProvider(provider),
      fit: `Potential capability fit—not an approval: ${provider.evidenceSummary}`,
      matchState: provider.confidence === "provider_confirmed" ? "ready_to_confirm" : "confirm_capability_first",
      roleplay: ready ? "The provider will want a short, clean package showing the ask, use of funds, repayment path, and the evidence that fits its box—not a full unfiltered data room." : "The provider is likely to disengage if AFG sends an incomplete file. Finish the checklist first, then ask for a fit check before sending documents.",
      draft: providerDraft(provider, analysis, ready),
    }));
}

function clientChecklist(analysis: ModelAnalysis, deal: DriveDealSnapshot) {
  if (!["provider_ready", "advisory_first"].includes(analysis.readiness) || deal.status === "needs_review" || deal.duplicateOf || deal.duplicateReason || deal.duplicateReviewReason) return null;
  const found = analysis.providedItems.slice(0, 5);
  const gaps = analysis.notLocatedItems.slice(0, 7);
  if (!gaps.length) return null;
  return {
    roleplay: "The client wants one clear list and a reason for each request. They do not want to be told they failed or be asked again for something already sent.",
    guard: "Before sending, check Gmail, ActiveCampaign, and the Drive folder for newer material. 'Not located' is not proof the client never supplied it.",
    draft: `Hi [Name],\n\nI reviewed the documents currently visible in your file. I could locate:\n${found.length ? found.map(item => `• ${item}`).join("\n") : "• The initial folder and intake material"}\n\nTo confirm whether ${analysis.recommendedProduct} is the right path, I could not yet locate:\n${gaps.map(item => `• ${item}`).join("\n")}\n\nPlease upload these items to the same folder or tell me where they already appear. Once they are in one place, we can confirm the correct next step.\n\nBest,\nTaimour`,
  };
}

function advisoryOffer(analysis: ModelAnalysis, deal: DriveDealSnapshot) {
  if (analysis.readiness !== "advisory_first" || ["closed", "funded", "needs_review"].includes(deal.status)) return null;
  return {
    service: "Capital Advisory" as const,
    why: "The file has a financing objective, but it is not ready for a responsible provider submission. AFG can structure the request, organize evidence, and produce a lender-ready package before outreach.",
    deliverables: ["One confirmed capital request and use-of-funds statement", "Product-fit and structure recommendation", "Evidence index and missing-item checklist", "Provider-ready one-page transaction summary", "Submission sequence only after the hard gates are complete"],
    roleplay: "The client may hear 'advisory' as another fee. Lead with the practical outcome: fewer repeated requests, one organized file, and no premature lender submission.",
    draft: `Hi [Name],\n\nYour file shows a real capital objective, but it is not ready to send responsibly to a provider yet. The fastest next step is to organize the request, confirm the structure, and close the evidence gaps before anyone sees it.\n\nAFG can handle that as a Capital Advisory engagement: one clear request, one checklist, one evidence index, and a provider-ready summary. That prevents the file from being circulated too early or to the wrong source.\n\nIf you want, I can send the exact scope and the documents we would organize first.\n\nBest,\nTaimour`,
  };
}

export function enforceStatusSafety(analysis: ModelAnalysis, deal: DriveDealSnapshot, bundle: DealReadBundle) {
  if (["closed", "funded"].includes(deal.status)) {
    analysis.readiness = "do_not_contact";
    analysis.bestNextAction = "Keep the file out of client and provider outreach unless a human records a new authoritative lifecycle decision.";
    return analysis;
  }
  const incompleteExtraction = bundle.partialCount + bundle.emptyCount + bundle.unsupportedCount + bundle.tooLargeCount + bundle.failedCount > 0;
  const evidenceText = analysis.evidence.map(item => `${item.claim} ${item.quote}`).join(" ").toLowerCase();
  const hardGates = {
    request: /request|amount|facility|financ|capital/.test(evidenceText),
    useOfFunds: /use of funds|proceeds|purpose|acquisition|purchase|working capital|construction|refinanc/.test(evidenceText),
    repayment: /repay|cash flow|revenue|receivable|contract|exit|sale|lease|payment/.test(evidenceText),
    entityOrSecurity: /borrower|company|entity|owner|asset|collateral|property|purchase order|sblc|guarant/.test(evidenceText),
  };
  const missingHardGate = Object.values(hardGates).some(value => !value);
  if (deal.status === "needs_review" || deal.duplicateOf || deal.duplicateReason || deal.duplicateReviewReason || incompleteExtraction || bundle.readableCount === 0 || analysis.evidence.length < 2 || missingHardGate) {
    analysis.readiness = "needs_verification";
    analysis.bestNextAction = "Resolve the status, duplicate, extraction, or evidence gate internally; do not contact the client or a provider from this dashboard yet.";
    return analysis;
  }
  if (analysis.recommendedProduct === "No confirmed product fit") analysis.readiness = "advisory_first";
  return analysis;
}

async function loadCache(): Promise<Cache> {
  try { return JSON.parse(await fs.readFile(CACHE_PATH, "utf8")); } catch { return {}; }
}

async function saveCache(cache: Cache) {
  await fs.writeFile(CACHE_PATH, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
  await fs.chmod(CACHE_PATH, 0o600);
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await worker(items[index], index); }
  }));
  return results;
}

export async function analyzeEveryDeal(deals: DriveDealSnapshot[], fullRead: FullReadResult) {
  const cache = await loadCache();
  const bundles = new Map(fullRead.deals.map(item => [item.dealId, item]));
  let cacheHits = 0;
  let modelRuns = 0;
  let fallbacks = 0;
  const analyses = await mapLimit(deals, MAX_CONCURRENCY, async deal => {
    const bundle = bundles.get(deal.id) || { dealId: deal.id, folderName: deal.folderName, inventoryCount: 0, readableCount: 0, partialCount: 0, emptyCount: 0, unsupportedCount: 0, tooLargeCount: 0, failedCount: 1, extractedCharacters: 0, contentHash: "missing", documents: [] };
    const hash = crypto.createHash("sha256").update(`${bundle.contentHash}|${deal.status}|${deal.amountDisplay}|${deal.duplicateReason}|${deal.duplicateReviewReason}|v4`).digest("hex");
    let modelAnalysis: ModelAnalysis;
    let generatedAt: string;
    if (cache[deal.id]?.hash === hash) {
      modelAnalysis = cache[deal.id].analysis;
      generatedAt = cache[deal.id].generatedAt;
      cacheHits++;
    } else {
      try {
        const usableText = bundle.readableCount + bundle.partialCount;
        modelAnalysis = usableText ? validateEvidence(await callModel(documentPrompt(deal, bundle)), bundle) : fallbackAnalysis(deal, bundle);
        modelRuns += usableText ? 1 : 0;
      } catch {
        modelAnalysis = fallbackAnalysis(deal, bundle);
        fallbacks++;
      }
      generatedAt = new Date().toISOString();
      cache[deal.id] = { hash, analysis: modelAnalysis, generatedAt };
    }
    modelAnalysis = enforceStatusSafety(validateEvidence(modelAnalysis, bundle), deal, bundle);
    const providerMatches = matchProviders(modelAnalysis, deal);
    const providedEvidence = validatedProvidedEvidence(modelAnalysis, bundle);
    return {
      ...modelAnalysis,
      dealId: deal.id,
      name: deal.name,
      driveUrl: deal.driveUrl,
      contactEmail: deal.email || null,
      status: deal.status,
      exactAmount: deal.amount,
      currency: deal.currency,
      readCoverage: {
        inventoryCount: bundle.inventoryCount,
        readableCount: bundle.readableCount,
        partialCount: bundle.partialCount,
        emptyCount: bundle.emptyCount,
        unsupportedCount: bundle.unsupportedCount,
        tooLargeCount: bundle.tooLargeCount,
        failedCount: bundle.failedCount,
        extractedCharacters: bundle.extractedCharacters,
      },
      documentLedger: bundle.documents.map(document => ({
        fileId: document.fileId,
        fileName: document.fileName,
        modifiedTime: document.modifiedTime,
        method: document.method,
        status: document.status,
        originalCharacters: document.originalCharacters,
        retainedCharacters: document.retainedCharacters,
        truncated: document.truncated,
        note: document.note,
      })),
      providedEvidence,
      outreachAuthorized: modelAnalysis.readiness === "provider_ready" && providerMatches.length > 0,
      analysisModel: bundle.readableCount + bundle.partialCount ? MODEL : "deterministic_fallback",
      analysisGeneratedAt: generatedAt,
      analysisHash: hash,
      providerMatches,
      advisoryOffer: advisoryOffer(modelAnalysis, deal),
      clientChecklistMessage: clientChecklist(modelAnalysis, deal),
    } satisfies FullDealAnalysis;
  });
  await saveCache(cache);
  const priorityOrder = { provider_ready: 0, advisory_first: 1, needs_verification: 2, do_not_contact: 9 } as const;
  const topFiles = analyses
    .filter(item => item.readiness !== "do_not_contact")
    .filter(item => !["closed", "funded"].includes(item.status))
    .sort((a, b) => {
      const readiness = priorityOrder[a.readiness] - priorityOrder[b.readiness];
      if (readiness) return readiness;
      const aCoverage = a.readCoverage.inventoryCount ? a.readCoverage.readableCount / a.readCoverage.inventoryCount : 0;
      const bCoverage = b.readCoverage.inventoryCount ? b.readCoverage.readableCount / b.readCoverage.inventoryCount : 0;
      if (aCoverage !== bCoverage) return bCoverage - aCoverage;
      const aAmount = a.currency === "USD" ? a.exactAmount || 0 : 0;
      const bAmount = b.currency === "USD" ? b.exactAmount || 0 : 0;
      return bAmount - aAmount || a.name.localeCompare(b.name) || a.dealId.localeCompare(b.dealId);
    })
    .slice(0, 7)
    .map((item, index) => ({
      ...item,
      order: index + 1,
      topReason: item.readiness === "provider_ready"
        ? "The file has a clear product path and readable evidence for a provider-fit check."
        : item.readiness === "advisory_first"
          ? "The need is identifiable, but the file should be packaged through Capital Advisory before provider outreach."
          : "A material evidence or status issue must be resolved before the file can move.",
      todayAction: item.readiness === "provider_ready"
        ? "Confirm the best provider's current box, then prepare a one-page submission."
        : item.readiness === "advisory_first"
          ? "Send the evidence checklist and offer Capital Advisory to make the file provider-ready."
          : "Open Drive and resolve the evidence or status issue; do not send anything externally yet.",
    }));
  return {
    generatedAt: new Date().toISOString(),
    coverage: {
      filesAnalyzed: analyses.length,
      filesWithReadableContent: analyses.filter(item => item.readCoverage.readableCount > 0).length,
      providerReady: analyses.filter(item => item.readiness === "provider_ready").length,
      advisoryFirst: analyses.filter(item => item.readiness === "advisory_first").length,
      needsVerification: analyses.filter(item => item.readiness === "needs_verification").length,
      doNotContact: analyses.filter(item => item.readiness === "do_not_contact").length,
      cacheHits,
      modelRuns,
      fallbacks,
    },
    providerDirectory: PROVIDERS.map(publicProvider),
    topFiles: {
      selectionRule: "Provider-ready files first; then advisory-ready files; then verification blockers. Within each group: higher readable-document coverage, exact USD request as a tie-breaker, then file name. No composite score and no fundability claim.",
      items: topFiles,
    },
    items: analyses,
  };
}
