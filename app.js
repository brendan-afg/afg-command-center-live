import { evaluateSnapshot } from "./snapshot-policy.js";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let state = null;
let operatingState = { locked: true, reasons: ["Snapshot not loaded"], ageHours: null };

const titles = {
  command: ["Command Center", "What requires a human decision today, with evidence and explicit limitations."],
  pipeline: ["Evidence Inventory", "Every authenticated Drive folder, described as observed—not as an authoritative deal stage."],
  intelligence: ["Decision Work", "Internal decision cards first; narrow exact-USD screening second. No recipient drafts."],
  sources: ["Source Health", "Access, ingestion, join coverage, freshness, and known limitations by source."],
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
const safeDriveUrl = value => {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && ["drive.google.com", "docs.google.com"].includes(url.hostname) ? url.href : "#";
  } catch {
    return "#";
  }
};
const formatDate = value => value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }).format(new Date(value)) + " ET" : "Unavailable";
const formatAmount = (amount, currency) => amount == null || !currency ? "Not extracted" : new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount);
const statusLabel = value => ({
  active: "Uploads present — lifecycle unconfirmed",
  intake_only: "Intake artifacts only — lifecycle unconfirmed",
  needs_review: "Human decision required",
  funded: "Funded marker detected",
  closed: "Terminal marker detected",
}[value] || value);

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
  if (!evidence) return `<div class="evidence"><strong>Evidence:</strong> No decision-level evidence excerpt is available in this snapshot. Verify in Drive.</div>`;
  return `<div class="evidence"><strong>Evidence:</strong> ${escapeHtml(evidence.fileName)} · ${escapeHtml(formatDate(evidence.fileModifiedTime))}<br><span>${escapeHtml(evidence.excerpt || "No excerpt available")}</span><br><small>${escapeHtml(evidence.sourceKind || "Drive document; client attribution unverified")} · ${escapeHtml(evidence.confidence || "unknown confidence")}</small></div>`;
}

function decisionCard(item, index) {
  return `<article class="decision-card"><div class="rank">${index + 1}</div><div class="priority-body"><div class="priority-top"><h3>${escapeHtml(item.name)}</h3><span class="status ${escapeHtml(item.severity)}">${escapeHtml(item.type.replaceAll("_", " "))}</span></div><p><strong>Decision required:</strong> ${escapeHtml(item.decision)}</p><p><strong>Why:</strong> ${escapeHtml(item.why)}</p><div class="card-actions primary-action"><a href="${escapeHtml(safeDriveUrl(item.driveUrl))}" target="_blank" rel="noopener noreferrer">Open evidence in Drive</a></div><p class="record-warning"><strong>No decision-recording system is connected.</strong> After verification, record the outcome, owner, and due date in AFG's authoritative workflow.</p><details class="evidence-details"><summary>Evidence, limits, and decision options</summary>${evidenceBlock(item.evidence)}<div class="decision-grid"><p><strong>Owner</strong><br>${escapeHtml(item.owner || "Unassigned")}</p><p><strong>Due</strong><br>${escapeHtml(item.due || "Not recorded")}</p><p><strong>Blocker</strong><br>${escapeHtml(item.blocker)}</p><p><strong>Permitted action</strong><br>${escapeHtml(item.authorizedAction)}</p></div><ul>${item.options.map(option => `<li>${escapeHtml(option)}</li>`).join("")}</ul></details></div></article>`;
}

function renderCommand() {
  const source = state.source;
  $("#freshness").className = `health-pill ${operatingState.locked ? "bad" : "ok"}`;
  $("#freshness").textContent = operatingState.locked ? "STALE / LOCKED" : "Authenticated snapshot";
  $("#side-time").textContent = formatDate(state.generatedAt);
  $("#source-banner").className = `source-banner ${operatingState.locked ? "locked-banner" : ""}`;
  $("#source-banner").innerHTML = operatingState.locked
    ? `<div><strong>STALE — DO NOT USE TOTALS OR PRIORITIES</strong><p>${operatingState.reasons.map(escapeHtml).join(" · ")}</p></div><div class="source-meta">Last artifact ${escapeHtml(formatDate(state.generatedAt))}</div>`
    : `<div><strong>${escapeHtml(source.name)} · authenticated Drive API</strong><p>${source.scannedFolders} folders returned by the configured authenticated scope · ${source.failedFolderCount} folder failures · ${source.evidenceReadErrorCount} evidence failures</p>${state.securityWarnings?.length ? `<p class="security-warning"><strong>Security:</strong> ${escapeHtml(state.securityWarnings.join(" "))}</p>` : ""}</div><div class="source-meta">Updated ${escapeHtml(formatDate(state.generatedAt))}<br>Run ${escapeHtml(state.manifest.runId)}</div>`;
  const totals = operatingState.locked ? "—" : state.totalsByCurrency.length ? state.totalsByCurrency.map(total => `${formatAmount(total.amount, total.currency)} ${total.currency}`).join(" · ") : "No unconflicted exact USD evidence";
  $("#metric-grid").innerHTML = [
    metric("Human decisions", operatingState.locked ? "—" : String(state.decisionQueue.total), "Status, amount, or duplicate decisions requiring human judgment", "red"),
    metric("Unconfirmed exact USD request evidence ≥ US$1M", totals, operatingState.locked ? "Unavailable while the snapshot is locked" : `${state.moneyQueue.total} unconflicted records; not pipeline, approval, fundability, fee, or revenue`, "blue"),
    metric("Folders with uploads", operatingState.locked ? "—" : String(state.buckets.active), "Document activity only; lifecycle is unconfirmed", "navy"),
    metric("Observed changes in 24h", operatingState.locked ? "—" : String(state.changedInLast24Hours), "Artifact timestamp changes; not client-response attribution", "green"),
  ].join("");
  $("#priority-list").innerHTML = operatingState.locked
    ? `<div class="empty danger">Decision ordering is disabled until a current validated authenticated snapshot is deployed.</div>`
    : state.decisionQueue.items.slice(0, 7).map(decisionCard).join("") || `<div class="empty">No status, amount, or duplicate decisions are currently surfaced.</div>`;
  $("#decision-count-note").textContent = operatingState.locked ? "Ordering locked" : `View all ${state.decisionQueue.total}`;
  $("#disclosures").innerHTML = state.disclosures.map(item => `<p>• ${escapeHtml(item)}</p>`).join("");
}

function dealCard(deal) {
  const warnings = [deal.duplicateOf ? `Held twin of ${deal.duplicateOf}` : null, deal.duplicateReason, deal.duplicateReviewReason, deal.evidenceReadErrorCount ? `${deal.evidenceReadErrorCount} evidence read error(s)` : null].filter(Boolean);
  return `<article class="deal-card"><div><h3>${escapeHtml(deal.name)}</h3><p>${escapeHtml(statusLabel(deal.status))} · API modified ${escapeHtml(formatDate(deal.lastModified))}</p></div><div class="deal-metrics"><span>${escapeHtml(formatAmount(deal.amount, deal.currency))}</span><span>${deal.documentCount} files</span><span>${deal.daysSinceUpdate}d artifact age</span></div>${warnings.length ? `<p class="warning">${escapeHtml(warnings.join(" · "))}</p>` : ""}<div class="card-actions"><button class="secondary" data-deal="${escapeHtml(deal.id)}">Evidence details</button><a href="${escapeHtml(safeDriveUrl(deal.driveUrl))}" target="_blank" rel="noopener noreferrer">Open Drive</a></div></article>`;
}

function renderDeals() {
  const term = $("#deal-search").value.trim().toLowerCase();
  const filter = $("#status-filter").value;
  const deals = state.deals.filter(deal => (!term || deal.name.toLowerCase().includes(term) || (deal.email || "").toLowerCase().includes(term)) && (filter === "all" || deal.status === filter));
  $("#deal-list").innerHTML = deals.map(dealCard).join("") || `<div class="empty">No matching Drive folders.</div>`;
}

function renderIntelligence() {
  const all = operatingState.locked ? [] : state.decisionQueue.items;
  const statusItems = all.filter(item => item.blockers.includes("status_or_amount"));
  const duplicateItems = all.filter(item => !item.blockers.includes("status_or_amount") && item.blockers.includes("duplicate_resolution"));
  const renderGroup = (items, offset = 0) => items.map((item, index) => decisionCard(item, offset + index)).join("") || `<div class="empty">No decisions in this category.</div>`;
  const decisions = operatingState.locked ? `<div class="empty danger">Decision ordering is locked because the snapshot is not decision-eligible.</div>` : `<p class="queue-rule">${escapeHtml(state.decisionQueue.sortRule)}</p><details class="decision-group" open><summary>Status or amount conflicts (${statusItems.length})</summary>${renderGroup(statusItems)}</details><details class="decision-group"><summary>Duplicate-only decisions (${duplicateItems.length})</summary>${renderGroup(duplicateItems, statusItems.length)}</details>`;
  const money = operatingState.locked ? `<div class="empty danger">Request evidence is unavailable while the snapshot is locked.</div>` : state.moneyQueue.items.map(item => `<article class="money-card"><div><div class="priority-top"><h3>${escapeHtml(item.name)}</h3><strong>${escapeHtml(formatAmount(item.amount, item.currency))}</strong></div><p>${escapeHtml(item.screeningState)}</p>${evidenceBlock(item.evidence)}<p><strong>Why this is not a funding priority:</strong> ${escapeHtml(item.missingGates.join(" · "))}</p><div class="card-actions"><a href="${escapeHtml(safeDriveUrl(item.driveUrl))}" target="_blank" rel="noopener noreferrer">Verify in Drive</a></div></div></article>`).join("") || `<div class="empty">No unconflicted exact USD request evidence qualifies for this narrow inventory.</div>`;
  $("#intelligence-list").innerHTML = `<section class="panel"><div class="panel-head"><div><p class="eyebrow">COMPLETE INTERNAL WORKLIST</p><h2>All ${escapeHtml(state.decisionQueue.total)} decisions</h2></div><span class="badge">Internal only</span></div>${decisions}</section><section class="panel"><div class="panel-head"><div><p class="eyebrow">UNRANKED EVIDENCE INVENTORY</p><h2>Unconfirmed exact USD request evidence</h2></div><span class="badge">Showing ${state.moneyQueue.items.length} of ${state.moneyQueue.total}</span></div>${money}</section><section class="panel disclosure-panel"><h2>Recipient communication</h2><p><strong>Blocked by design.</strong> No copyable draft is produced until the dashboard has verified contact identity, relationship, channel, consent/suppression, broker routing, owner, cadence, authorization, and immutable action history.</p></section>`;
}

function renderSources() {
  const rows = [
    ["Google Drive", state.sourceHealth.googleDrive, `${state.source.scannedFolders} folders fetched · ${state.source.failedFolderCount} failed · ${state.source.evidenceReadErrorCount} evidence failures`],
    ["ActiveCampaign", state.sourceHealth.activeCampaign, state.sourceHealth.activeCampaign.connected ? `${state.sourceHealth.activeCampaign.contactsTotal.toLocaleString()} contacts · ${state.sourceHealth.activeCampaign.campaignsTotal.toLocaleString()} campaigns` : state.sourceHealth.activeCampaign.reason],
    ["Calendly", state.sourceHealth.calendly, state.sourceHealth.calendly.connected ? `${state.sourceHealth.calendly.upcomingEvents} upcoming active events returned` : state.sourceHealth.calendly.reason],
    ["MeetAlfred", state.sourceHealth.meetAlfred, state.sourceHealth.meetAlfred.connected ? `${state.sourceHealth.meetAlfred.campaignsTotal} campaigns returned` : state.sourceHealth.meetAlfred.reason],
  ];
  $("#source-health").innerHTML = rows.map(([name, source, detail]) => `<article class="source-card"><div class="source-icon ${source.connected ? "ok" : "bad"}"></div><div><h2>${escapeHtml(name)}</h2><p>${escapeHtml(detail || "Unavailable")}</p><dl class="source-dl"><dt>Access</dt><dd>${source.connected ? "Available" : "Unavailable"}</dd><dt>Ingested</dt><dd>${source.ingested ? "Yes" : "No"}</dd><dt>Joined to files</dt><dd>${source.joinedToDeals ? "Yes" : "No"}</dd><dt>Checked</dt><dd>${escapeHtml(formatDate(source.checkedAt || state.generatedAt))}</dd></dl><small>${escapeHtml([source.accessRisk, source.limitation || source.decisionUse || source.reason].filter(Boolean).join(" ") || "No limitation recorded")}</small></div></article>`).join("") + `<article class="source-card"><div class="source-icon bad"></div><div><h2>GA4 / first-party website analytics</h2><p>Not configured in this deployment.</p><small>No website traffic value, trend, or interpretation is displayed.</small></div></article><article class="source-card"><div class="source-icon bad"></div><div><h2>Snapshot delta history</h2><p>Not yet persisted in an immutable history store.</p><small>The current 24-hour count is based on artifact timestamps, not yesterday-versus-today snapshot comparison.</small></div></article>`;
}

function showDetail(id) {
  const deal = state.deals.find(item => item.id === id);
  if (!deal) return;
  const evidence = deal.statusEvidence || deal.amountEvidence;
  $("#dialog-content").innerHTML = `<p class="eyebrow">AUTHENTICATED DRIVE EVIDENCE</p><h2>${escapeHtml(deal.name)}</h2><dl><dt>Observation</dt><dd>${escapeHtml(statusLabel(deal.status))}</dd><dt>Status basis</dt><dd>${escapeHtml(deal.statusReason)}</dd><dt>Status confidence</dt><dd>${escapeHtml(deal.statusConfidence)}</dd><dt>Client-stated request</dt><dd>${escapeHtml(formatAmount(deal.amount, deal.currency))}</dd><dt>Amount source</dt><dd>${escapeHtml(deal.amountSource || "Not available")}</dd><dt>Evidence file</dt><dd>${escapeHtml(evidence?.fileName || "No decision-level evidence extracted")}</dd><dt>Evidence timestamp</dt><dd>${escapeHtml(formatDate(evidence?.fileModifiedTime))}</dd><dt>Evidence excerpt</dt><dd>${escapeHtml(evidence?.excerpt || "Unavailable")}</dd><dt>File inventory</dt><dd>${deal.documentCount} files · ${deal.uploadCount} non-system uploads</dd><dt>Filename-only indicators</dt><dd>${escapeHtml(deal.documentChecklistGaps.join(", ") || "None detected")}<br><small>These are not confirmed missing documents and cannot create an external request.</small></dd><dt>Duplicate state</dt><dd>${escapeHtml(deal.duplicateOf ? `Held twin of ${deal.duplicateOf}` : deal.duplicateReviewReason || "No duplicate signal")}</dd></dl><a class="primary-link" href="${escapeHtml(safeDriveUrl(deal.driveUrl))}" target="_blank" rel="noopener noreferrer">Open source in Google Drive</a>`;
  $("#detail-dialog").showModal();
}

function wire() {
  $$(`[data-view]`).forEach(node => node.addEventListener("click", () => showView(node.dataset.view)));
  $("#deal-search").addEventListener("input", renderDeals);
  $("#status-filter").addEventListener("change", renderDeals);
  $("#dialog-close").addEventListener("click", () => $("#detail-dialog").close());
  document.addEventListener("click", event => {
    const detail = event.target.closest("[data-deal]");
    if (detail) showDetail(detail.dataset.deal);
  });
}

async function unlock(password) {
  $("#unlock-error").textContent = "Opening encrypted snapshot…";
  try {
    const envelope = await fetch(`./data.enc?ts=${Date.now()}`, { cache: "no-store" }).then(response => { if (!response.ok) throw new Error("Snapshot unavailable"); return response.json(); });
    state = await decrypt(envelope, password);
    operatingState = evaluateSnapshot(state);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    $("#unlock").classList.add("hidden");
    $("#app").classList.remove("hidden");
    renderCommand(); renderDeals(); renderIntelligence(); renderSources(); wire();
  } catch {
    $("#unlock-error").textContent = "That private link or access key is invalid. Please use the latest AFG dashboard link.";
  }
}

$("#unlock-form").addEventListener("submit", event => { event.preventDefault(); unlock($("#access-key").value); });
const hashKey = new URLSearchParams(location.hash.slice(1)).get("key");
if (hashKey) { $("#access-key").value = hashKey; unlock(hashKey); }
