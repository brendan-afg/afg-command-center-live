import type { DriveDealSnapshot } from "../server/driveSync";

export type ActionState = "DECIDE" | "VERIFY_FIRST" | "QUALIFY" | "SCREEN" | "REENGAGE" | "DO_NOT_CONTACT";

const PRODUCT_SIGNALS = [
  { name: "Purchase Order Financing", pattern: /purchase order|\bpo\b|supplier|buyer contract/i },
  { name: "SBLC / Bank Instrument", pattern: /sblc|standby letter|mt ?760|mt ?799|bank guarantee/i },
  { name: "Proof of Funds / Asset Monetization", pattern: /proof of funds|\bpof\b|asset monetization|readiness facilit|\beca\b|\bdfi\b/i },
  { name: "Distressed Assets", pattern: /distressed|non[- ]performing|\bnpl\b|foreclos/i },
  { name: "Working Capital", pattern: /working capital|growth capital|cash flow|revenue[- ]based/i },
  { name: "Senior Debt / Bridge", pattern: /real estate|property|land|hotel|development|infrastructure|bridge loan|senior debt/i },
  { name: "Private Placement", pattern: /private placement|bond|private note/i },
];

function combinedText(deal: DriveDealSnapshot) {
  return [
    deal.name,
    deal.folderName,
    deal.statusReason,
    ...(deal.documentNames || []),
    deal.amountEvidence?.excerpt,
    deal.statusEvidence?.excerpt,
  ].filter(Boolean).join(" ");
}

export function classifyInstrument(deal: DriveDealSnapshot) {
  const text = combinedText(deal);
  return PRODUCT_SIGNALS.find(signal => signal.pattern.test(text))?.name || "Product not confirmed";
}

function documentSignals(deal: DriveDealSnapshot) {
  const names = (deal.documentNames || []).join(" ");
  return {
    identity: /passport|kyc|identity|certificate of incorporation|registration/i.test(names),
    financials: /financial|bank statement|balance sheet|profit|loss|p&l|cash flow/i.test(names),
    businessPlan: /business plan|pitch deck|executive summary|information memorandum/i.test(names),
    valuation: /appraisal|valuation|survey/i.test(names),
    purchaseOrder: /purchase order|\bpo\b/i.test(names),
  };
}

function riskSignals(deal: DriveDealSnapshot, instrument: string) {
  const risks: string[] = [];
  const email = (deal.email || "").toLowerCase();
  if (/@(protonmail|hushmail|guerrillamail)\./.test(email)) risks.push("Private email provider on a capital request — verify identity and entity before outreach.");
  if ((deal.amount || 0) > 500_000_000 && deal.documentCount < 3) risks.push("Request exceeds $500M but the folder has fewer than three documents — verify substance before spending time.");
  if (instrument === "Private Placement" && /pure equity|venture capital|\bvc\b/i.test(combinedText(deal))) risks.push("The request may be outside AFG's arranged products — confirm product fit before proceeding.");
  if (instrument === "SBLC / Bank Instrument" && /leased|fresh cut/i.test(combinedText(deal))) risks.push("Bank-instrument wording matches a known high-risk pattern — verify the issuing bank and instrument independently.");
  return risks;
}

function actionFor(deal: DriveDealSnapshot, instrument: string, risks: string[]): ActionState {
  if (["closed", "funded"].includes(deal.status)) return "DO_NOT_CONTACT";
  if (deal.status === "needs_review" || deal.duplicateOf || deal.duplicateReason || deal.duplicateReviewReason) return "DECIDE";
  if (risks.length) return "VERIFY_FIRST";
  if (deal.status === "intake_only" && deal.daysSinceUpdate <= 2) return "QUALIFY";
  if (["active", "intake_only"].includes(deal.status) && deal.daysSinceUpdate >= 7) return "REENGAGE";
  return "SCREEN";
}

function ownerFor(action: ActionState) {
  if (["QUALIFY", "REENGAGE"].includes(action)) return "Tina";
  if (action === "DO_NOT_CONTACT") return "No action";
  return "Taimour";
}

function dueFor(action: ActionState) {
  if (["DECIDE", "VERIFY_FIRST", "QUALIFY"].includes(action)) return "Today";
  if (action === "REENGAGE") return "Within 48 hours";
  if (action === "SCREEN") return "This week";
  return "Do not contact";
}

function actionCopy(action: ActionState, instrument: string, deal: DriveDealSnapshot, risks: string[]) {
  const exactRequest = deal.amount != null && deal.currency === "USD" ? `an exact USD request is recorded` : "the request is not yet decision-ready";
  const duplicateSignal = deal.duplicateReason || deal.duplicateReviewReason;
  switch (action) {
    case "DECIDE":
      const decisionReasons = [deal.status === "needs_review" ? deal.statusReason : null, duplicateSignal].filter(Boolean);
      return {
        action: "Resolve the file conflict before anyone contacts the client or sends it to a capital source.",
        why: decisionReasons.join("; ") || "The file contains conflicting status or identity signals.",
        finishLine: "One current status, one correct folder, one recorded owner, and one next date.",
        steps: ["Open the Drive folder and the linked conflict evidence.", duplicateSignal ? "Decide whether the folders are one deal or separate engagements, then confirm the current status." : "Decide whether the file is open, closed, or parked and which amount is current.", "Record the decision, owner, and next date in the working system."],
      };
    case "VERIFY_FIRST":
      return {
        action: "Verify the identity, entity, and transaction claim before spending more time.",
        why: risks[0],
        finishLine: "The identity and core transaction claim are independently verified or the file is stopped.",
        steps: ["Confirm the legal entity and authorized person through an independent channel.", "Verify the core document or instrument with its issuer.", "Record pass, fail, or escalation with evidence."],
      };
    case "QUALIFY":
      return {
        action: `Confirm the request and whether it fits ${instrument === "Product not confirmed" ? "an AFG product" : instrument}.`,
        why: `This is a recent intake and ${exactRequest}.`,
        finishLine: "Product, exact amount, use of funds, source of repayment, and next required artifact are confirmed.",
        steps: ["Check Gmail and ActiveCampaign first so AFG does not duplicate outreach.", "Ask five qualification questions in one call or email.", "Record the agreed next artifact and date."],
      };
    case "REENGAGE":
      return {
        action: "Confirm whether the client is still moving forward before doing more work.",
        why: `The Drive file has not changed for ${deal.daysSinceUpdate} days; Drive activity is not proof of client activity.`,
        finishLine: "The client confirms active, paused, or stopped—and the file is updated to match.",
        steps: ["Check Gmail and ActiveCampaign for the last contact first.", "Send one short status-choice message.", "Update the file from the reply; archive after the approved follow-up cadence if there is no response."],
      };
    case "SCREEN":
      return {
        action: `Run a 15-minute internal screen for ${instrument === "Product not confirmed" ? "product fit" : instrument}.`,
        why: `${deal.documentCount} document names are visible and ${exactRequest}; document contents have not been independently verified.`,
        finishLine: "A product, hard-gate checklist, risk owner, and one next artifact are recorded.",
        steps: ["Confirm product and lifecycle stage.", "Check only the product's hard-gate documents and ratios.", "Advance, request one specific artifact, park, or decline."],
      };
    default:
      return {
        action: "Do not contact or count this file as an opportunity.",
        why: `The file is marked ${deal.status}; this status has not been independently confirmed by the dashboard.`,
        finishLine: "No action unless Taimour authorizes a status correction with evidence.",
        steps: ["Keep it out of outreach.", "Keep it out of opportunity totals.", "Reopen only with a recorded status decision."],
      };
  }
}

function messageFor(action: ActionState) {
  if (action === "QUALIFY") return {
    roleplay: "The recipient is likely to ignore a long request. They need one clear explanation of why AFG is asking and a short list they can answer at once.",
    guard: "Before sending: check Gmail and ActiveCampaign so this does not repeat an earlier request.",
    draft: "Hi [Name] — I’m reviewing your file so we can direct it correctly. Can you confirm five points in one reply: the exact amount, intended use, preferred structure, source of repayment, and the one document you can provide next? Once those are clear, we can tell you the correct next step. Best, Taimour",
    followUps: [
      { when: "48 hours", text: "Hi [Name] — following up on the five points below. Even a short answer is enough for us to decide the right next step." },
      { when: "72 hours later", text: "Hi [Name] — I don’t want to keep asking for the wrong information. Is the request still active, and can you confirm the amount and intended use first?" },
      { when: "One week later", text: "Hi [Name] — we have not received the information needed to review this properly, so we will park the file for now. Reply when you are ready and we can pick it back up." },
      { when: "30 days later", text: "Hi [Name] — closing the loop on your request. If it is still active, reply with the current amount, use of funds, and preferred structure and we will reassess the next step." },
    ],
  };
  if (action === "REENGAGE") return {
    roleplay: "The recipient may think this is another generic follow-up. A simple three-choice question makes replying easy and avoids pressure.",
    guard: "Before sending: check Gmail and ActiveCampaign for the last contact and do not send if a reply is already pending.",
    draft: "Hi [Name] — quick status check so we keep your file accurate. Is this still active, temporarily paused, or no longer moving forward? A one-line reply is enough and we’ll update the next step accordingly. Best, Taimour",
    followUps: [
      { when: "48 hours", text: "Hi [Name] — just checking the status note below. Active, paused, or stopped? A one-line reply is perfect." },
      { when: "72 hours later", text: "Hi [Name] — we want to keep your file accurate and avoid unnecessary follow-ups. Should we keep it active or move it to paused?" },
      { when: "One week later", text: "Hi [Name] — since we have not heard back, we will park the file for now. Reply anytime if the transaction becomes active again." },
      { when: "30 days later", text: "Hi [Name] — final check before we close the loop. If the request is active again, reply with the current status and we will reopen the next step." },
    ],
  };
  return null;
}

function advisoryLenses(action: ActionState, instrument: string, risks: string[]) {
  const bank = action === "DO_NOT_CONTACT" ? "Protect time and reputation: keep terminal files out of outreach and totals." : action === "VERIFY_FIRST" ? "Risk first: no capital-source exposure until identity and the core claim are independently verified." : "Do not confuse a request with a bankable transaction; complete the hard gates before capital-source outreach.";
  const product = action === "DECIDE" ? "Remove ambiguity first: one file, one status, one next action." : `Make the next step unmistakable: ${action === "REENGAGE" ? "get a three-choice status reply" : action === "QUALIFY" ? "answer five qualification questions" : "complete one product-fit screen"}.`;
  const scale = risks.length ? "Automate the risk trigger, but keep the final verification decision human." : instrument === "Product not confirmed" ? "The recurring bottleneck is unclassified demand; capture product, amount, use, repayment, and security as structured fields." : `Turn the ${instrument} screen into a repeatable checklist so every file is handled the same way.`;
  return { capitalDiscipline: bank, productSimplicity: product, firstPrinciplesScale: scale };
}

export function buildFileAdvice(deals: DriveDealSnapshot[]) {
  return deals.map(deal => {
    const instrument = classifyInstrument(deal);
    const risks = riskSignals(deal, instrument);
    const actionState = actionFor(deal, instrument, risks);
    const copy = actionCopy(actionState, instrument, deal, risks);
    const docs = documentSignals(deal);
    return {
      dealId: deal.id,
      name: deal.name,
      driveUrl: deal.driveUrl,
      contactEmail: deal.email || null,
      status: deal.status,
      actionState,
      owner: ownerFor(actionState),
      due: dueFor(actionState),
      instrument,
      action: copy.action,
      why: copy.why,
      finishLine: copy.finishLine,
      steps: copy.steps,
      riskSignals: risks,
      evidence: {
        statusFile: deal.statusEvidence?.fileName || null,
        amountFile: deal.amountEvidence?.fileName || null,
        exactAmount: deal.amount,
        currency: deal.currency,
        documentCount: deal.documentCount,
        namedDocumentSignals: docs,
        limitation: "Document names and approved text evidence only; PDFs, DOCX files, images, and third-party claims are not independently verified.",
      },
      message: messageFor(actionState),
      advisoryLenses: advisoryLenses(actionState, instrument, risks),
      lastModified: deal.latestDocumentModifiedTime,
      daysSinceUpdate: deal.daysSinceUpdate,
    };
  });
}

const ACTION_ORDER: Record<ActionState, number> = { DECIDE: 0, VERIFY_FIRST: 1, QUALIFY: 2, SCREEN: 3, REENGAGE: 4, DO_NOT_CONTACT: 9 };

export function buildTodayPlan(fileAdvice: ReturnType<typeof buildFileAdvice>, limit = 7) {
  const actionable = fileAdvice.filter(item => item.actionState !== "DO_NOT_CONTACT");
  const by = (states: ActionState[]) => actionable.filter(item => states.includes(item.actionState)).sort((a, b) => {
    const aAmount = a.evidence.currency === "USD" ? a.evidence.exactAmount || 0 : 0;
    const bAmount = b.evidence.currency === "USD" ? b.evidence.exactAmount || 0 : 0;
    return bAmount - aAmount || b.lastModified.localeCompare(a.lastModified) || a.dealId.localeCompare(b.dealId);
  });
  const selected = [
    ...by(["DECIDE"]).slice(0, 2),
    ...by(["VERIFY_FIRST"]).slice(0, 1),
    ...by(["QUALIFY", "SCREEN"]).slice(0, 2),
    ...by(["REENGAGE"]).slice(0, 2),
  ];
  for (const item of actionable.sort((a, b) => ACTION_ORDER[a.actionState] - ACTION_ORDER[b.actionState] || b.lastModified.localeCompare(a.lastModified))) {
    if (selected.length >= limit) break;
    if (!selected.some(chosen => chosen.dealId === item.dealId)) selected.push(item);
  }
  return {
    total: Math.min(limit, selected.length),
    selectionRule: "A balanced operating list: up to two file decisions, one verification gate, two screens/qualifications, and two re-engagements. No composite score and no fundability claim.",
    items: selected.slice(0, limit).map((item, index) => ({ ...item, order: index + 1 })),
  };
}

export function buildCompanyStrategy(deals: DriveDealSnapshot[], fileAdvice: ReturnType<typeof buildFileAdvice>, sourceHealth: any) {
  const count = (state: ActionState) => fileAdvice.filter(item => item.actionState === state).length;
  const unknownProducts = fileAdvice.filter(item => item.instrument === "Product not confirmed" && item.actionState !== "DO_NOT_CONTACT").length;
  const stale = fileAdvice.filter(item => item.actionState === "REENGAGE").length;
  const exactUsd = fileAdvice.filter(item => item.evidence.currency === "USD" && item.evidence.exactAmount != null && item.actionState !== "DO_NOT_CONTACT").length;
  const priorities = [
    {
      title: "Turn conflicts into decisions",
      metric: `${count("DECIDE")} files need a status, amount, or duplicate decision`,
      why: "Unresolved files create fake workload and can cause duplicate or inappropriate outreach.",
      action: "Taimour resolves the first five Decision files; each must end with one status, owner, next date, and merge/separate answer.",
      owner: "Taimour",
      due: "Today",
      finishLine: "Five decisions recorded; zero recipient messages sent from unresolved files.",
    },
    {
      title: "Convert request evidence into screened opportunities",
      metric: `${exactUsd} open files contain exact USD request evidence`,
      why: "An amount in a file is not a product match, credit decision, or revenue forecast.",
      action: "Run the product hard-gate screen on two files today; record product, use, repayment, security, and one next artifact.",
      owner: "Taimour",
      due: "Today",
      finishLine: "Two files receive a documented advance, request, park, or decline decision.",
    },
    {
      title: "Stop blind follow-ups",
      metric: sourceHealth?.activeCampaign?.joinedToDeals ? "Contact history is joined" : "Drive files are not joined to contact history",
      why: "Without the join, the dashboard cannot know who was contacted, who replied, or whether a message would be duplicated.",
      action: "Brendan defines one shared deal ID across Drive and ActiveCampaign; Tina checks contact history before every suggested message until the join exists.",
      owner: "Brendan + Tina",
      due: "This week",
      finishLine: "Every active file has a shared ID, last outbound date, last inbound date, and next-contact date.",
    },
    {
      title: "Classify demand before chasing volume",
      metric: `${unknownProducts} actionable files have no confirmed AFG product`,
      why: "A large folder count is not a pipeline if AFG cannot say what product each client needs.",
      action: "Tina captures five fields on every new inquiry: product, amount, use, repayment, and security/asset.",
      owner: "Tina",
      due: "Start today",
      finishLine: "New files cannot enter active review with an unconfirmed product.",
    },
    {
      title: "Force stale files to choose a lane",
      metric: `${stale} actionable files have been quiet for at least seven days`,
      why: "Old files consume attention until they are confirmed active, paused, or stopped.",
      action: "Tina runs the approved status-choice message only after checking Gmail and ActiveCampaign; Taimour closes the loop from replies.",
      owner: "Tina + Taimour",
      due: "Within 48 hours",
      finishLine: "Each contacted file is marked active, paused, or stopped with a dated source.",
    },
  ];
  return { priorities, facts: { totalFiles: deals.length, decisions: count("DECIDE"), exactUsd, unknownProducts, stale } };
}

export function buildBlueOceanOpportunities(fileAdvice: ReturnType<typeof buildFileAdvice>) {
  const actionable = fileAdvice.filter(item => item.actionState !== "DO_NOT_CONTACT");
  const unknown = actionable.filter(item => item.instrument === "Product not confirmed").length;
  const stale = actionable.filter(item => item.actionState === "REENGAGE").length;
  const productCounts = new Map<string, number>();
  for (const item of actionable) if (item.instrument !== "Product not confirmed") productCounts.set(item.instrument, (productCounts.get(item.instrument) || 0) + 1);
  const leading = [...productCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || ["Asset-backed finance", 0];
  return [
    {
      title: "Capital Readiness Sprint",
      evidence: `${unknown} active or intake files do not yet have a confirmed product`,
      hypothesis: "AFG can sell a short, paid readiness engagement before placement work: classify the product, verify the core claim, and produce one lender-ready gap list.",
      test: "Offer the sprint to five suitable existing files after Taimour approves the list; success means two paid mandates and complete intake fields.",
      owner: "Taimour + Tina",
      status: "Test—not validated demand",
    },
    {
      title: "Deal Rescue Desk",
      evidence: `${stale} actionable files have been quiet for at least seven days`,
      hypothesis: "A structured rescue review can separate fixable stalled transactions from files that should be closed, saving time while creating an advisory product.",
      test: "Select five stale but documented files; run a 30-minute rescue screen and measure how many produce a paid next step or a clean stop decision.",
      owner: "Taimour",
      status: "Test—not validated demand",
    },
    {
      title: `${leading[0]} Readiness Desk`,
      evidence: `${leading[1]} actionable files contain filename or text signals for this product`,
      hypothesis: "A repeatable product-specific checklist and partner route may let AFG process similar files faster than treating every transaction as custom.",
      test: "Build one checklist, apply it to three files, and measure time-to-decision, missing hard gates, and whether a capital-source introduction is actually justified.",
      owner: "Taimour + Brendan",
      status: "Test—not validated demand",
    },
  ];
}

type BoardCard = {
  key: string;
  name: string;
  lens: string;
  model: string | null;
  status: "model_generated" | "rule_based_fallback";
  headline: string;
  advice: string;
  why: string;
  todayAction: string;
  metric: string;
  challenge: string;
  disclaimer: string;
};

const BOARD = [
  {
    key: "capital_discipline",
    name: "Jamie Dimon lens",
    lens: "Large-bank CEO capital discipline: risk, client selection, throughput, and reputation.",
    preferred: ["gpt-5", "gpt-5.5"],
    fallback: { headline: "Stop confusing volume with bankable business", advice: "Resolve contradictory files and complete hard-gate screens before presenting anything to a capital source.", why: "Unresolved status, unverified evidence, and missing product fit create reputation risk.", todayAction: "Close five file decisions and complete two product screens.", metric: "Five decisions plus two documented screens", challenge: "If a lender asked why this file deserves attention, can AFG answer with verified facts in two minutes?" },
  },
  {
    key: "product_simplicity",
    name: "Steve Jobs lens",
    lens: "Product simplicity: remove clutter, make one next action obvious, and design the operating experience around completion.",
    preferred: ["gemini-3.1-pro-preview", "gpt-5"],
    fallback: { headline: "One file, one decision, one finish line", advice: "Every file should show only the next decision, why it matters, who owns it, and what done looks like.", why: "Extra metrics do not move a transaction; a completed next step does.", todayAction: "Finish the seven-item Today list before opening lower-priority files.", metric: "Seven actions closed or explicitly parked", challenge: "Can a new team member understand and complete the next step without asking Taimour what the card means?" },
  },
  {
    key: "first_principles_scale",
    name: "Elon Musk lens",
    lens: "First-principles scale: identify the constraint, eliminate unnecessary work, automate repeatable capture, and measure cycle time.",
    preferred: ["gpt-5.5", "gpt-5"],
    fallback: { headline: "The bottleneck is decision quality, not lead volume", advice: "Do not add more files until product, status, ownership, and contact history become structured fields.", why: "More volume multiplies ambiguity when the operating system cannot close the loop.", todayAction: "Brendan defines the shared deal ID and the minimum five-field intake record.", metric: "100% of new files carry product, amount, use, repayment, and security", challenge: "Which manual step can be deleted entirely once the authoritative field and owner are explicit?" },
  },
] as const;

async function liveModels() {
  const base = process.env.OPENAI_API_BASE?.replace(/\/$/, "");
  const key = process.env.OPENAI_API_KEY;
  if (!base || !key) return { base: null, key: null, models: [] as string[] };
  const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}`);
  const payload = await response.json();
  return { base, key, models: Array.isArray(payload?.data) ? payload.data.map((item: any) => item.id).filter((id: unknown): id is string => typeof id === "string") : [] };
}

async function callBoardModel(base: string, key: string, model: string, system: string, facts: unknown) {
  const schema = {
    type: "object",
    properties: {
      headline: { type: "string" },
      advice: { type: "string" },
      why: { type: "string" },
      todayAction: { type: "string" },
      metric: { type: "string" },
      challenge: { type: "string" },
    },
    required: ["headline", "advice", "why", "todayAction", "metric", "challenge"],
    additionalProperties: false,
  };
  const body: any = {
    model,
    messages: [
      { role: "system", content: `${system} You are not the named person and must not claim to speak for them. Use only the supplied aggregate facts. Do not invent market facts, client facts, approvals, revenue, or fundability. Give one concrete action for today in plain English. AFG's maximum daily operating capacity in this dashboard is seven file actions; never recommend completing or contacting more than seven files today. You may recommend a longer backlog for later, but today's action must fit within seven files.` },
      { role: "user", content: `Challenge this operating picture and produce one decisive recommendation. Aggregate facts only:\n${JSON.stringify(facts)}` },
    ],
    response_format: { type: "json_schema", json_schema: { name: "afg_advisor_card", strict: true, schema } },
  };
  if (model.startsWith("gpt-")) {
    body.max_completion_tokens = 1600;
    body.reasoning = { effort: "low" };
  } else {
    body.max_tokens = 4096;
  }
  const response = await fetch(`${base}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`${model} returned HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`${model} returned no structured content`);
  const parsed = JSON.parse(content);
  for (const field of ["headline", "advice", "why", "todayAction", "metric", "challenge"]) if (typeof parsed[field] !== "string" || !parsed[field].trim()) throw new Error(`${model} omitted ${field}`);
  return parsed;
}

export async function buildAdvisoryBoard(facts: unknown) {
  let catalog: Awaited<ReturnType<typeof liveModels>> = { base: null, key: null, models: [] };
  try { catalog = await liveModels(); } catch { /* Honest fallbacks below. */ }
  const cards: BoardCard[] = await Promise.all(BOARD.map(async board => {
    const model = board.preferred.find(candidate => catalog.models.includes(candidate)) || null;
    if (catalog.base && catalog.key && model) {
      try {
        const generated = await callBoardModel(catalog.base, catalog.key, model, board.lens, facts);
        return { key: board.key, name: board.name, lens: board.lens, model, status: "model_generated", ...generated, disclaimer: "AI simulation of a decision style—not advice from, affiliation with, or endorsement by the named person." };
      } catch { /* Honest fallback. */ }
    }
    return { key: board.key, name: board.name, lens: board.lens, model, status: "rule_based_fallback", ...board.fallback, disclaimer: "Rule-based simulation of a decision style—not advice from, affiliation with, or endorsement by the named person." };
  }));
  return {
    generatedAt: new Date().toISOString(),
    cards,
    modelGeneratedCount: cards.filter(card => card.status === "model_generated").length,
    assurance: `${cards.filter(card => card.status === "model_generated").length} of 3 advisory lenses were independently generated from aggregate dashboard facts. File-level actions remain evidence-gated and deterministic.`,
    synthesis: {
      agreement: "All three lenses prioritize decision quality, product classification, and a capped seven-file day over chasing dashboard volume.",
      disagreement: "The capital-discipline lens would pause stale-file outreach until contact history is joined; the daily operating plan allows two re-engagements only after Tina checks Gmail and ActiveCampaign.",
      afgDecision: "Complete the seven listed actions. The two re-engagement messages may be used only if Tina confirms there is no recent reply or pending conversation; otherwise replace them with two internal screens.",
    },
  };
}
