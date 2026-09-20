import { evaluateSnapshot } from "./snapshot-policy.js";
import { safeDriveFolderUrl } from "./url-policy.js";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let state = null;
let operatingState = { locked: true, reasons: ["Data has not loaded"], ageHours: null };

const titles = {
  command: ["Today", "Seven actions for today—each with an owner and finish line."],
  pipeline: ["All Files", "Every file currently shown on the dashboard."],
  actions: ["Products & Providers", "What each client needs, what AFG can offer, what is not located, and who may fit."],
  strategy: ["Company Strategy", "What AFG should change, test, and finish next."],
  board: ["Advisory Board", "Three independent AI decision lenses on today's company facts."],
  intelligence: ["All Decisions", "Open the evidence, decide what is true, and record the result."],
  sources: ["Data Sources", "See which systems are working and what each one provides."],
};

function bytes(base64) {
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
}

async function decrypt(envelope, privateFragmentKey) {
  if (envelope.version !== 2 || envelope.algorithm !== "ECDH-P256+HKDF-SHA256+AES-256-GCM") throw new Error("Unsupported encrypted snapshot");
  const privateJwk = JSON.parse(fromBase64Url(privateFragmentKey));
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const ephemeralPublicKey = await crypto.subtle.importKey("jwk", envelope.ephemeralPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeralPublicKey }, privateKey, 256);
  const keyMaterial = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bytes(envelope.salt), info: new TextEncoder().encode("AFG Dashboard Data v2") },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(envelope.iv) }, key, bytes(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const safeDriveUrl = safeDriveFolderUrl;
const driveButton = (url, label) => `<button class="secondary" data-open-drive="${escapeHtml(safeDriveUrl(url))}">${escapeHtml(label)}</button>`;
const formatDate = value => value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }).format(new Date(value)) + " ET" : "Not available";
const formatAmount = (amount, currency) => amount == null || !currency ? "No exact amount found" : new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount);
const statusLabel = value => ({
  active: "Has documents — current status not confirmed",
  intake_only: "New file — current status not confirmed",
  needs_review: "Needs a decision",
  funded: "A file says funded — not independently confirmed",
  closed: "A file says closed",
}[value] || "Status not confirmed");
const decisionLabel = item => item.blockers.includes("status_or_amount") ? "The files disagree" : "Possible duplicate";
const urgencyLabel = severity => severity === "critical" ? "Fix first" : severity === "high" ? "Check next" : "Review";
const decisionQuestion = item => {
  const status = item.blockers.includes("status_or_amount");
  const duplicate = item.blockers.includes("duplicate_resolution");
  if (status && duplicate) return "Is this the same deal as another file, and is it still open?";
  if (status) return "What is the correct status or amount?";
  return "Is this the same deal as another file?";
};
const decisionReason = item => {
  const status = item.blockers.includes("status_or_amount");
  const duplicate = item.blockers.includes("duplicate_resolution");
  if (status && duplicate) return "The information does not agree, and another folder may be the same deal.";
  if (status) return "Two pieces of information in Drive do not agree.";
  return "Two folders may belong to the same deal.";
};
const actionStateLabel = value => ({ DECIDE: "Decide", VERIFY_FIRST: "Verify first", QUALIFY: "Qualify", SCREEN: "Screen", REENGAGE: "Re-engage", DO_NOT_CONTACT: "Do not contact" }[value] || value);
const actionTone = value => ({ DECIDE: "critical", VERIFY_FIRST: "critical", QUALIFY: "high", SCREEN: "medium", REENGAGE: "medium", DO_NOT_CONTACT: "muted" }[value] || "medium");
const readinessLabel = value => ({ provider_ready: "Ready for provider fit check", advisory_first: "Sell advisory first", needs_verification: "Verify before outreach", do_not_contact: "Do not contact" }[value] || "Needs review");
const readinessTone = value => ({ provider_ready: "high", advisory_first: "medium", needs_verification: "critical", do_not_contact: "muted" }[value] || "medium");

function bulletList(items, empty) {
  return items?.length ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p class="muted">${escapeHtml(empty)}</p>`;
}

function communicationBlock(title, message) {
  if (!message) return "";
  return `<details class="message-block"><summary>${escapeHtml(title)}</summary><div class="roleplay"><span>How the reader is likely to react</span><p>${escapeHtml(message.roleplay)}</p></div>${message.guard ? `<p class="record-warning">${escapeHtml(message.guard)}</p>` : ""}<pre>${escapeHtml(message.draft)}</pre></details>`;
}

function providerBlock(matches) {
  if (!matches?.length) return `<div class="provider-empty"><strong>No verified provider match yet.</strong><p>Finish the checklist or add a vetted provider for this product. The dashboard will not invent a name.</p></div>`;
  return `<div class="provider-grid">${matches.map(provider => `<article class="provider-card"><div class="provider-head"><div><span class="plain-label">${escapeHtml(provider.confidenceLabel)}</span><h4>${escapeHtml(provider.company)}</h4></div><span class="status ${provider.matchState === "ready_to_confirm" ? "high" : "medium"}">${provider.matchState === "ready_to_confirm" ? "Confirm current fit" : "Confirm program first"}</span></div><p><strong>Contact:</strong> ${escapeHtml(provider.contactName)}${provider.title ? ` · ${escapeHtml(provider.title)}` : ""}<br>${[provider.email, provider.phone].filter(Boolean).map(escapeHtml).join(" · ") || "Use the official provider profile"}</p><p><strong>Published range:</strong> ${provider.minimumUsd == null ? "No verified minimum" : formatAmount(provider.minimumUsd, "USD")} to ${provider.maximumUsd == null ? "no verified maximum" : formatAmount(provider.maximumUsd, "USD")}</p><p><strong>Geography:</strong> ${escapeHtml(provider.geographies.join(", "))}</p><p><strong>Why it may fit:</strong> ${escapeHtml(provider.fit)}</p><details><summary>Role-play and fit-check draft</summary><div class="roleplay"><span>Provider's likely reaction</span><p>${escapeHtml(provider.roleplay)}</p></div><pre>${escapeHtml(provider.draft)}</pre><small>Capability evidence: ${escapeHtml(provider.evidenceSource)} · ${escapeHtml(provider.evidenceLocator)} · ${escapeHtml(provider.evidenceDate)}<br>Contact evidence: ${escapeHtml(provider.contactEvidenceSource)} · verified ${escapeHtml(provider.contactVerifiedAt)}</small></details></article>`).join("")}</div>`;
}

function fullAnalysisCard(item, compact = false) {
  const order = item.order ? `<span class="action-number">${escapeHtml(item.order)}</span>` : "";
  const amount = formatAmount(item.exactAmount, item.currency);
  const action = item.todayAction || item.bestNextAction;
  const incomplete = item.readCoverage.partialCount + item.readCoverage.emptyCount + item.readCoverage.unsupportedCount + item.readCoverage.tooLargeCount + item.readCoverage.failedCount;
  const provided = item.providedEvidence?.length ? `<ul>${item.providedEvidence.map(entry => `<li><strong>${escapeHtml(entry.claim)}</strong><br><small>${escapeHtml(entry.fileName)}: “${escapeHtml(entry.quote)}”</small></li>`).join("")}</ul>` : `<p class="muted">No provided-item claim has a complete, exact source quote yet.</p>`;
  const ledger = (item.documentLedger || []).map(document => `<tr><td>${escapeHtml(document.fileName)}</td><td>${escapeHtml(document.status)}</td><td>${escapeHtml(document.method)}</td><td>${escapeHtml(document.retainedCharacters)} / ${escapeHtml(document.originalCharacters)}</td><td>${escapeHtml(document.note || "Complete")}</td></tr>`).join("");
  const details = compact ? "" : `<details class="analysis-details"><summary>See documents, checklist, advisory, and providers</summary><div class="analysis-grid"><section><h4>What the file is about</h4><p>${escapeHtml(item.businessDescription)}</p><p><strong>Sector:</strong> ${escapeHtml(item.sector)} · <strong>Place:</strong> ${escapeHtml(item.jurisdiction)}</p><p><strong>Request found:</strong> ${escapeHtml(item.requestedAmountText || amount)}</p></section><section><h4>What is confirmed in the file</h4>${provided}</section><section><h4>What was not located</h4>${incomplete ? `<p class="warning">Not shown because at least one document was not completely readable. Check the ledger and Drive.</p>` : bulletList(item.notLocatedItems, "No checklist gap was identified from complete readable contents.")}</section><section><h4>Read coverage</h4><p>${escapeHtml(item.readCoverage.readableCount)} complete · ${escapeHtml(item.readCoverage.partialCount)} partial · ${escapeHtml(item.readCoverage.emptyCount)} empty · ${escapeHtml(item.readCoverage.unsupportedCount)} unsupported · ${escapeHtml(item.readCoverage.tooLargeCount)} oversized · ${escapeHtml(item.readCoverage.failedCount)} failed.</p>${incomplete ? `<p class="warning">External outreach is blocked until every affected document is reviewed.</p>` : `<p>Every inventoried document reached a complete readable state.</p>`}</section></div>${item.advisoryOffer ? `<article class="advisory-offer"><span class="plain-label">AFG SERVICE TO OFFER</span><h4>${escapeHtml(item.advisoryOffer.service)}</h4><p>${escapeHtml(item.advisoryOffer.why)}</p>${bulletList(item.advisoryOffer.deliverables, "")}${communicationBlock("Role-play and advisory message", item.advisoryOffer)}</article>` : ""}${communicationBlock("Client checklist and ready-to-send message", item.clientChecklistMessage)}<section class="provider-section"><h4>Eligible provider candidates</h4>${providerBlock(item.providerMatches)}</section><details><summary>Evidence used</summary>${(item.evidence || []).length ? item.evidence.map(entry => `<blockquote><strong>${escapeHtml(entry.claim)}</strong><br>${escapeHtml(entry.fileName)}: “${escapeHtml(entry.quote)}”</blockquote>`).join("") : `<p>No short source quote passed exact validation; open Drive before acting.</p>`}</details><details><summary>Document read ledger (${escapeHtml(item.readCoverage.inventoryCount)})</summary><div class="ledger-wrap"><table class="read-ledger"><thead><tr><th>File</th><th>Result</th><th>Method</th><th>Kept / found</th><th>Note</th></tr></thead><tbody>${ledger}</tbody></table></div></details></details>`;
  return `<article class="action-card ${escapeHtml(readinessTone(item.readiness))}"><div class="action-heading">${order}<div><span class="plain-label">${escapeHtml(readinessLabel(item.readiness))}</span><h3>${escapeHtml(item.name)}</h3></div><span class="status ${escapeHtml(readinessTone(item.readiness))}">${escapeHtml(item.recommendedProduct)}</span></div><p class="action-main">${escapeHtml(action)}</p><p><strong>Client wants:</strong> ${escapeHtml(item.clientNeed)}</p>${item.topReason ? `<p><strong>Why this file:</strong> ${escapeHtml(item.topReason)}</p>` : ""}<div class="owner-row"><span><strong>Product:</strong> ${escapeHtml(item.recommendedProduct)}</span><span><strong>Confidence:</strong> ${escapeHtml(item.productConfidence)}</span></div><p class="finish-line"><strong>Why this product:</strong> ${escapeHtml(item.whyThisProduct)}</p><div class="card-actions">${driveButton(item.driveUrl, "Open folder in Drive")}${compact ? `<button class="secondary" data-analysis="${escapeHtml(item.dealId)}">Read full file advice</button>` : ""}</div>${details}</article>`;
}

function showView(view) {
  $$(".view").forEach(node => node.classList.toggle("active-view", node.id === view));
  $$(`[data-view]`).forEach(node => {
    const active = node.dataset.view === view;
    node.classList.toggle("active", active);
    if (active) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  });
  $("#page-title").textContent = titles[view][0];
  $("#page-subtitle").textContent = titles[view][1];
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function metric(label, value, note, tone = "blue") {
  return `<article class="metric-card ${tone}"><p>${escapeHtml(label)}</p><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;
}

function evidenceBlock(evidence) {
  if (!evidence) return `<div class="evidence"><strong>What we found:</strong> No short evidence note is available. Open Drive to check the file.</div>`;
  return `<div class="evidence"><strong>What we found:</strong> ${escapeHtml(evidence.fileName)} · ${escapeHtml(formatDate(evidence.fileModifiedTime))}<br><span>${escapeHtml(evidence.excerpt || "No note available")}</span></div>`;
}

function decisionCard(item) {
  return `<article class="decision-card"><div class="priority-body"><div class="priority-top"><div><span class="plain-label">${escapeHtml(decisionLabel(item))}</span><h3>${escapeHtml(item.name)}</h3></div><span class="status ${escapeHtml(item.severity)}">${escapeHtml(urgencyLabel(item.severity))}</span></div><p class="decision-question"><strong>Check this:</strong> ${escapeHtml(decisionQuestion(item))}</p><div class="card-actions primary-action">${driveButton(item.driveUrl, "Open folder in Drive")}</div><p class="simple-reason"><strong>Why:</strong> ${escapeHtml(decisionReason(item))}</p><details class="evidence-details"><summary>Show the evidence</summary>${evidenceBlock(item.evidence)}</details></div></article>`;
}

function advisoryLenses(item) {
  const lenses = item.advisoryLenses || {};
  return `<div class="mini-board"><article><strong>Capital discipline</strong><p>${escapeHtml(lenses.capitalDiscipline || "Not available")}</p></article><article><strong>Product simplicity</strong><p>${escapeHtml(lenses.productSimplicity || "Not available")}</p></article><article><strong>First-principles scale</strong><p>${escapeHtml(lenses.firstPrinciplesScale || "Not available")}</p></article></div>`;
}

function messageBlock(item) {
  if (!item.message) return "";
  const followUps = (item.message.followUps || []).map(step => `<li><strong>${escapeHtml(step.when)}:</strong> ${escapeHtml(step.text)}</li>`).join("");
  return `<details class="message-block"><summary>Message and follow-up campaign</summary><p><strong>Contact found in Drive:</strong> ${escapeHtml(item.contactEmail || "No email found")}</p><div class="roleplay"><span>Recipient's likely reaction</span><p>${escapeHtml(item.message.roleplay)}</p></div><p class="record-warning">${escapeHtml(item.message.guard)}</p><p><strong>Initial message</strong></p><pre>${escapeHtml(item.message.draft)}</pre>${followUps ? `<p><strong>If there is no reply</strong></p><ol class="cadence-list">${followUps}</ol>` : ""}</details>`;
}

function actionCard(item, compact = false) {
  const order = item.order ? `<span class="action-number">${escapeHtml(item.order)}</span>` : "";
  const steps = compact ? "" : `<details><summary>Show the three steps</summary><ol>${(item.steps || []).map(step => `<li>${escapeHtml(step)}</li>`).join("")}</ol></details>`;
  const board = compact ? "" : `<details><summary>Advisory board on this file</summary>${advisoryLenses(item)}</details>`;
  const message = compact ? "" : messageBlock(item);
  return `<article class="action-card ${escapeHtml(actionTone(item.actionState))}"><div class="action-heading">${order}<div><span class="plain-label">${escapeHtml(actionStateLabel(item.actionState))}</span><h3>${escapeHtml(item.name)}</h3></div><span class="status ${escapeHtml(actionTone(item.actionState))}">${escapeHtml(item.due)}</span></div><p class="action-main">${escapeHtml(item.action)}</p><div class="owner-row"><span><strong>Owner:</strong> ${escapeHtml(item.owner)}</span><span><strong>Product:</strong> ${escapeHtml(item.instrument)}</span></div><p><strong>Why:</strong> ${escapeHtml(item.why)}</p><p class="finish-line"><strong>Done when:</strong> ${escapeHtml(item.finishLine)}</p><div class="card-actions">${driveButton(item.driveUrl, "Open folder in Drive")}${compact ? `<button class="secondary" data-advice="${escapeHtml(item.dealId)}">View full advice</button>` : ""}</div>${steps}${message}${board}</article>`;
}

function renderCommand() {
  const source = state.source;
  $("#freshness").className = `health-pill ${operatingState.locked ? "bad" : "ok"}`;
  $("#freshness").textContent = operatingState.locked ? "Not current" : "Data updated today";
  $("#side-time").textContent = formatDate(state.generatedAt);
  $("#source-banner").className = `source-banner ${operatingState.locked ? "locked-banner" : ""}`;
  $("#source-banner").innerHTML = operatingState.locked
    ? `<div><strong>Stop — this information is not current.</strong><p>${operatingState.reasons.map(escapeHtml).join(" · ")}</p>${state.securityWarnings?.length ? `<details class="security-warning"><summary>Drive sharing warning</summary><p>Anyone with the link can open the main Drive folder. Remove public sharing.</p></details>` : ""}</div><div class="source-meta">Last update ${escapeHtml(formatDate(state.generatedAt))}</div>`
    : `<div><strong>Data is current</strong><p>Updated ${escapeHtml(formatDate(state.generatedAt))}. ${escapeHtml(state.visibleFolderCount)} files are shown.</p>${state.securityWarnings?.length ? `<details class="security-warning"><summary>Drive sharing warning</summary><p>Anyone with the link can open the main Drive folder. Remove public sharing.</p></details>` : ""}</div>`;
  const totals = operatingState.locked ? "—" : state.totalsByCurrency.length ? state.totalsByCurrency.map(total => `${formatAmount(total.amount, total.currency)} USD`).join(" · ") : "$0 USD";
  $("#metric-grid").innerHTML = [
    metric("Provider fit check", operatingState.locked ? "—" : String(state.fullAnalysis.coverage.providerReady), "Files with a clear product path and readable evidence", "green"),
    metric("Advisory first", operatingState.locked ? "—" : String(state.fullAnalysis.coverage.advisoryFirst), "Files to package before provider outreach", "blue"),
    metric("USD requests found", totals, operatingState.locked ? "Unavailable" : `${state.moneyQueue.total} files. These are requests, not approved deals.`, "blue"),
    metric("Files analyzed", operatingState.locked ? "—" : String(state.fullAnalysis.coverage.filesAnalyzed), `${state.manifest.fullDocumentReadable} documents read completely in this refresh`, "navy"),
  ].join("");
  $("#today-plan").innerHTML = operatingState.locked
    ? `<div class="empty danger">Today's actions are hidden until current information is available.</div>`
    : state.fullAnalysis.topFiles.items.map(item => fullAnalysisCard(item, true)).join("") || `<div class="empty success">No evidence-backed action is available today.</div>`;
  $("#priority-list").innerHTML = operatingState.locked
    ? `<div class="empty danger">Today's list is hidden until current information is available.</div>`
    : state.decisionQueue.items.slice(0, 2).map(decisionCard).join("") || `<div class="empty success">Nothing needs a decision right now.</div>`;
  $("#decision-count-note").textContent = operatingState.locked ? "Unavailable" : `View all ${state.decisionQueue.total} decisions`;
}

function dealCard(deal) {
  const warnings = [deal.duplicateOf ? "Possible duplicate" : null, deal.duplicateReason || deal.duplicateReviewReason ? "Duplicate check needed" : null, deal.evidenceReadErrorCount ? "A file could not be read" : null].filter(Boolean);
  const analysis = state.fullAnalysis.items.find(item => item.dealId === deal.id);
  return `<article class="deal-card"><div><h3>${escapeHtml(deal.name)}</h3><p>${escapeHtml(statusLabel(deal.status))}</p>${analysis ? `<p><strong>${escapeHtml(analysis.recommendedProduct)}</strong> · ${escapeHtml(readinessLabel(analysis.readiness))}</p>` : ""}</div><div class="deal-metrics"><span>${escapeHtml(formatAmount(deal.amount, deal.currency))}</span><span>${deal.documentCount} files</span><span>Changed ${deal.daysSinceUpdate} days ago</span></div>${warnings.length ? `<p class="warning">${escapeHtml([...new Set(warnings)].join(" · "))}</p>` : ""}<div class="card-actions"><button class="secondary" data-analysis="${escapeHtml(deal.id)}">Read full file advice</button><button class="secondary" data-deal="${escapeHtml(deal.id)}">View details</button>${driveButton(deal.driveUrl, "Open Drive")}</div></article>`;
}

function renderDeals() {
  if (operatingState.locked) {
    $("#deal-search").disabled = true;
    $("#status-filter").disabled = true;
    $("#deal-list").innerHTML = `<div class="empty danger">Files are hidden because the information is not current.</div>`;
    return;
  }
  const term = $("#deal-search").value.trim().toLowerCase();
  const filter = $("#status-filter").value;
  const deals = state.deals.filter(deal => (!term || deal.name.toLowerCase().includes(term)) && (filter === "all" || deal.status === filter));
  $("#deal-list").innerHTML = deals.map(dealCard).join("") || `<div class="empty">No matching files.</div>`;
}

function renderFileAdvice() {
  if (operatingState.locked) {
    $("#advice-search").disabled = true;
    $("#action-filter").disabled = true;
    $("#file-advice-list").innerHTML = `<div class="empty danger">File advice is hidden because the information is not current.</div>`;
    return;
  }
  const term = $("#advice-search").value.trim().toLowerCase();
  const filter = $("#action-filter").value;
  const items = state.fullAnalysis.items.filter(item => (!term || `${item.name} ${item.recommendedProduct} ${item.clientNeed}`.toLowerCase().includes(term)) && (filter === "all" || item.readiness === filter));
  $("#file-advice-list").innerHTML = items.map(item => fullAnalysisCard(item)).join("") || `<div class="empty">No matching file analysis.</div>`;
}

function renderStrategy() {
  if (operatingState.locked) {
    $("#company-strategy").innerHTML = `<div class="empty danger">Strategy is hidden because the information is not current.</div>`;
    $("#blue-ocean").innerHTML = "";
    return;
  }
  $("#company-strategy").innerHTML = `<section class="panel"><div class="panel-head"><div><p class="eyebrow">COMPANY DIRECTION</p><h2>Five operating priorities</h2></div></div>${state.companyStrategy.priorities.map((item, index) => `<article class="strategy-card"><span class="action-number">${index + 1}</span><div><h3>${escapeHtml(item.title)}</h3><p class="strategy-metric">${escapeHtml(item.metric)}</p><p><strong>Do:</strong> ${escapeHtml(item.action)}</p><p><strong>Why:</strong> ${escapeHtml(item.why)}</p><div class="owner-row"><span><strong>Owner:</strong> ${escapeHtml(item.owner)}</span><span><strong>Due:</strong> ${escapeHtml(item.due)}</span></div><p class="finish-line"><strong>Done when:</strong> ${escapeHtml(item.finishLine)}</p></div></article>`).join("")}</section>`;
  $("#blue-ocean").innerHTML = state.blueOcean.map(item => `<article class="opportunity-card"><span class="test-badge">${escapeHtml(item.status)}</span><h3>${escapeHtml(item.title)}</h3><p><strong>Signal:</strong> ${escapeHtml(item.evidence)}</p><p><strong>Idea:</strong> ${escapeHtml(item.hypothesis)}</p><p><strong>Test:</strong> ${escapeHtml(item.test)}</p><p><strong>Owner:</strong> ${escapeHtml(item.owner)}</p></article>`).join("");
}

function renderBoard() {
  if (operatingState.locked) {
    $("#advisory-board").innerHTML = `<div class="empty danger">Advisory-board output is hidden because the information is not current.</div>`;
    return;
  }
  $("#advisory-board").innerHTML = `<p class="board-assurance">${escapeHtml(state.advisoryBoard.assurance)}</p><article class="board-synthesis"><h2>What AFG should do</h2><p><strong>They agree:</strong> ${escapeHtml(state.advisoryBoard.synthesis.agreement)}</p><p><strong>They disagree:</strong> ${escapeHtml(state.advisoryBoard.synthesis.disagreement)}</p><p class="finish-line"><strong>AFG decision:</strong> ${escapeHtml(state.advisoryBoard.synthesis.afgDecision)}</p></article>${state.advisoryBoard.cards.map(item => `<article class="advisor-card"><div class="advisor-head"><div><p class="eyebrow">${escapeHtml(item.name)}</p><h2>${escapeHtml(item.headline)}</h2></div><span class="status ${item.status === "model_generated" ? "medium" : "high"}">${item.status === "model_generated" ? "Independent AI review" : "Rule-based fallback"}</span></div><p><strong>Advice:</strong> ${escapeHtml(item.advice)}</p><div class="advisor-action"><strong>Do today</strong><p>${escapeHtml(item.todayAction)}</p></div><p><strong>Measure:</strong> ${escapeHtml(item.metric)}</p><details><summary>Why and what this challenges</summary><p class="advisor-lens">${escapeHtml(item.lens)}</p><p><strong>Why now:</strong> ${escapeHtml(item.why)}</p><p><strong>Challenge:</strong> ${escapeHtml(item.challenge)}</p><small>${escapeHtml(item.disclaimer)}${item.model ? ` Model: ${escapeHtml(item.model)}.` : ""}</small></details></article>`).join("")}`;
}

function renderIntelligence() {
  const all = operatingState.locked ? [] : state.decisionQueue.items;
  const statusItems = all.filter(item => item.blockers.includes("status_or_amount"));
  const duplicateItems = all.filter(item => !item.blockers.includes("status_or_amount") && item.blockers.includes("duplicate_resolution"));
  const renderGroup = items => items.map(decisionCard).join("") || `<div class="empty success">None right now.</div>`;
  const decisions = operatingState.locked ? `<div class="empty danger">Decisions are hidden because the information is not current.</div>` : `<details class="decision-group" open><summary>Information that does not match (${statusItems.length})</summary>${renderGroup(statusItems)}</details><details class="decision-group"><summary>Possible duplicates (${duplicateItems.length})</summary>${renderGroup(duplicateItems)}</details>`;
  const money = operatingState.locked ? `<div class="empty danger">USD requests are hidden because the information is not current.</div>` : state.moneyQueue.items.map(item => `<article class="money-card"><div><div class="priority-top"><h3>${escapeHtml(item.name)}</h3><strong>${escapeHtml(formatAmount(item.amount, item.currency))}</strong></div><p>This is an amount written in the file. It is not approved or confirmed fundable.</p><div class="card-actions">${driveButton(item.driveUrl, "Open folder in Drive")}</div><details><summary>Show the evidence</summary>${evidenceBlock(item.evidence)}</details></div></article>`).join("") || `<div class="empty">No exact USD requests of at least $1 million are shown.</div>`;
  $("#intelligence-list").innerHTML = `<section class="panel"><div class="panel-head"><div><p class="eyebrow">DECIDE</p><h2>All ${escapeHtml(state.decisionQueue.total)} decisions</h2></div></div>${decisions}</section><section class="panel"><div class="panel-head"><div><p class="eyebrow">CHECK</p><h2>USD requests found in files</h2></div><span class="badge">${state.moneyQueue.total} files</span></div>${money}</section>`;
}

function renderSources() {
  const rows = [
    ["Google Drive", state.sourceHealth.googleDrive, `${state.source.scannedFolders} folders checked · ${state.manifest.fullDocumentReadable} complete · ${state.manifest.fullDocumentPartial} partial · ${state.manifest.fullDocumentEmpty} empty · ${state.manifest.fullDocumentUnsupported} unsupported · ${state.manifest.fullDocumentTooLarge} oversized · ${state.manifest.fullDocumentFailed} failed`],
    ["ActiveCampaign", state.sourceHealth.activeCampaign, state.sourceHealth.activeCampaign.connected ? `${state.sourceHealth.activeCampaign.contactsTotal.toLocaleString()} contacts found` : state.sourceHealth.activeCampaign.reason],
    ["Calendly", state.sourceHealth.calendly, state.sourceHealth.calendly.connected ? `${state.sourceHealth.calendly.upcomingEvents} upcoming events found` : state.sourceHealth.calendly.reason],
    ["MeetAlfred", state.sourceHealth.meetAlfred, state.sourceHealth.meetAlfred.connected ? `${state.sourceHealth.meetAlfred.campaignsTotal} campaigns found` : state.sourceHealth.meetAlfred.reason],
  ];
  $("#source-health").innerHTML = `<article class="source-card security-source"><div class="source-icon bad"></div><div><h2>Dashboard access</h2><p><strong>Shared-link access</strong></p><small>Anyone with this full dashboard link can open it. There are no individual logins, revocation controls, or access logs. The main Drive folder also still allows anyone with its link to open it.</small></div></article>` + rows.map(([name, source, detail]) => `<article class="source-card"><div class="source-icon ${source.connected ? "ok" : "bad"}"></div><div><h2>${escapeHtml(name)}</h2><p>${escapeHtml(detail || "Not available")}</p><p class="connection-answer"><strong>${source.connected ? "Working" : "Not working"}</strong>${source.joinedToDeals ? " · Used with files" : " · Not matched to files"}</p><small>${escapeHtml(source.limitation || source.decisionUse || source.reason || "No note")}</small></div></article>`).join("") + `<article class="source-card"><div class="source-icon bad"></div><div><h2>Website traffic</h2><p>Not connected</p><small>No website traffic number is shown.</small></div></article>`;
}

function renderAll() {
  renderCommand();
  renderDeals();
  renderFileAdvice();
  renderStrategy();
  renderBoard();
  renderIntelligence();
  renderSources();
}

function refreshOperatingState() {
  if (!state) return false;
  const previous = JSON.stringify(operatingState);
  operatingState = evaluateSnapshot(state);
  if (previous !== JSON.stringify(operatingState)) {
    if (operatingState.locked && $("#detail-dialog")?.open) $("#detail-dialog").close();
    renderAll();
  }
  return !operatingState.locked;
}

function showDetail(id) {
  if (operatingState.locked) return;
  const deal = state.deals.find(item => item.id === id);
  if (!deal) return;
  const evidence = deal.statusEvidence || deal.amountEvidence;
  $("#dialog-content").innerHTML = `<p class="eyebrow">FILE DETAILS</p><h2>${escapeHtml(deal.name)}</h2><dl><dt>What we know</dt><dd>${escapeHtml(statusLabel(deal.status))}</dd><dt>Why</dt><dd>${escapeHtml(deal.statusReason)}</dd><dt>Exact request found</dt><dd>${escapeHtml(formatAmount(deal.amount, deal.currency))}</dd><dt>Evidence file</dt><dd>${escapeHtml(evidence?.fileName || "No short evidence note found")}</dd><dt>Last changed</dt><dd>${escapeHtml(formatDate(deal.lastModified))}</dd><dt>Files in folder</dt><dd>${deal.documentCount}</dd><dt>Duplicate check</dt><dd>${escapeHtml(deal.duplicateOf || deal.duplicateReviewReason ? "Needs a duplicate decision" : "No duplicate signal found")}</dd></dl>${driveButton(deal.driveUrl, "Open in Google Drive")}`;
  $("#detail-dialog").showModal();
}

function wire() {
  $$(`[data-view]`).forEach(node => node.addEventListener("click", () => { refreshOperatingState(); showView(node.dataset.view); }));
  $("#deal-search").addEventListener("input", renderDeals);
  $("#status-filter").addEventListener("change", renderDeals);
  $("#advice-search").addEventListener("input", renderFileAdvice);
  $("#action-filter").addEventListener("change", renderFileAdvice);
  $("#dialog-close").addEventListener("click", () => $("#detail-dialog").close());
  document.addEventListener("click", event => {
    const dataAction = event.target.closest("[data-open-drive],[data-deal],[data-analysis],[data-advice]");
    if (dataAction && !refreshOperatingState()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const openDrive = event.target.closest("[data-open-drive]");
    if (openDrive) {
      const url = safeDriveUrl(openDrive.dataset.openDrive);
      if (url !== "#") window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    const detail = event.target.closest("[data-deal]");
    if (detail) showDetail(detail.dataset.deal);
    const analysis = event.target.closest("[data-analysis]");
    if (analysis) {
      const item = state.fullAnalysis.items.find(record => record.dealId === analysis.dataset.analysis);
      $("#advice-search").value = item?.name || "";
      $("#action-filter").value = "all";
      renderFileAdvice();
      showView("actions");
    }
    const advice = event.target.closest("[data-advice]");
    if (advice) {
      const item = state.fileAdvice.find(record => record.dealId === advice.dataset.advice);
      $("#advice-search").value = item?.name || "";
      $("#action-filter").value = "all";
      renderFileAdvice();
      showView("actions");
    }
  }, true);
  window.setInterval(refreshOperatingState, 60_000);
  window.addEventListener("focus", refreshOperatingState);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshOperatingState(); });
}

async function unlock(password) {
  $("#unlock-error").textContent = "Opening…";
  try {
    const envelope = await fetch(`./data.enc?ts=${Date.now()}`, { cache: "no-store" }).then(response => { if (!response.ok) throw new Error("Snapshot unavailable"); return response.json(); });
    state = await decrypt(envelope, password);
    operatingState = evaluateSnapshot(state);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    $("#access-key").value = "";
    $("#unlock").classList.add("hidden");
    $("#app").classList.remove("hidden");
    renderAll(); wire();
  } catch {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    $("#access-key").value = "";
    $("#unlock-error").textContent = "This link or access key is not valid. Use the latest AFG dashboard link.";
  }
}

$("#unlock-form").addEventListener("submit", event => { event.preventDefault(); unlock($("#access-key").value); });
const hashKey = new URLSearchParams(location.hash.slice(1)).get("key");
if (hashKey) { history.replaceState(null, "", `${location.pathname}${location.search}`); unlock(hashKey); }
