import { evaluateSnapshot } from "./snapshot-policy.js";
import { safeDriveFolderUrl } from "./url-policy.js";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let state = null;
let operatingState = { locked: true, reasons: ["Data has not loaded"], ageHours: null };

const titles = {
  command: ["Today", "Start here. These files need a decision."],
  pipeline: ["All Files", "Every file currently shown on the dashboard."],
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
  return `<article class="decision-card"><div class="priority-body"><div class="priority-top"><div><span class="plain-label">${escapeHtml(decisionLabel(item))}</span><h3>${escapeHtml(item.name)}</h3></div><span class="status ${escapeHtml(item.severity)}">${escapeHtml(urgencyLabel(item.severity))}</span></div><p class="decision-question"><strong>Check this:</strong> ${escapeHtml(decisionQuestion(item))}</p><div class="card-actions primary-action"><a href="${escapeHtml(safeDriveUrl(item.driveUrl))}" target="_blank" rel="noopener noreferrer">Open folder in Drive</a></div><p class="simple-reason"><strong>Why:</strong> ${escapeHtml(decisionReason(item))}</p><details class="evidence-details"><summary>Show the evidence</summary>${evidenceBlock(item.evidence)}</details></div></article>`;
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
    metric("Decisions needed", operatingState.locked ? "—" : String(state.decisionQueue.total), "Files where the information does not agree", "red"),
    metric("USD requests found", totals, operatingState.locked ? "Unavailable" : `${state.moneyQueue.total} files. These are requests, not approved deals.`, "blue"),
    metric("Files shown", operatingState.locked ? "—" : String(state.visibleFolderCount), "Files included on this dashboard", "navy"),
    metric("Changed in 24 hours", operatingState.locked ? "—" : String(state.changedInLast24Hours), "A Drive file changed; this may not be a client reply", "green"),
  ].join("");
  $("#priority-list").innerHTML = operatingState.locked
    ? `<div class="empty danger">Today's list is hidden until current information is available.</div>`
    : state.decisionQueue.items.slice(0, 5).map(decisionCard).join("") || `<div class="empty success">Nothing needs a decision right now.</div>`;
  $("#decision-count-note").textContent = operatingState.locked ? "Unavailable" : `View all ${state.decisionQueue.total} decisions`;
}

function dealCard(deal) {
  const warnings = [deal.duplicateOf ? "Possible duplicate" : null, deal.duplicateReason || deal.duplicateReviewReason ? "Duplicate check needed" : null, deal.evidenceReadErrorCount ? "A file could not be read" : null].filter(Boolean);
  return `<article class="deal-card"><div><h3>${escapeHtml(deal.name)}</h3><p>${escapeHtml(statusLabel(deal.status))}</p></div><div class="deal-metrics"><span>${escapeHtml(formatAmount(deal.amount, deal.currency))}</span><span>${deal.documentCount} files</span><span>Changed ${deal.daysSinceUpdate} days ago</span></div>${warnings.length ? `<p class="warning">${escapeHtml([...new Set(warnings)].join(" · "))}</p>` : ""}<div class="card-actions"><button class="secondary" data-deal="${escapeHtml(deal.id)}">View dashboard details</button><a href="${escapeHtml(safeDriveUrl(deal.driveUrl))}" target="_blank" rel="noopener noreferrer">Open folder in Drive</a></div></article>`;
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

function renderIntelligence() {
  const all = operatingState.locked ? [] : state.decisionQueue.items;
  const statusItems = all.filter(item => item.blockers.includes("status_or_amount"));
  const duplicateItems = all.filter(item => !item.blockers.includes("status_or_amount") && item.blockers.includes("duplicate_resolution"));
  const renderGroup = items => items.map(decisionCard).join("") || `<div class="empty success">None right now.</div>`;
  const decisions = operatingState.locked ? `<div class="empty danger">Decisions are hidden because the information is not current.</div>` : `<details class="decision-group" open><summary>Information that does not match (${statusItems.length})</summary>${renderGroup(statusItems)}</details><details class="decision-group"><summary>Possible duplicates (${duplicateItems.length})</summary>${renderGroup(duplicateItems)}</details>`;
  const money = operatingState.locked ? `<div class="empty danger">USD requests are hidden because the information is not current.</div>` : state.moneyQueue.items.map(item => `<article class="money-card"><div><div class="priority-top"><h3>${escapeHtml(item.name)}</h3><strong>${escapeHtml(formatAmount(item.amount, item.currency))}</strong></div><p>This is an amount written in the file. It is not approved or confirmed fundable.</p><div class="card-actions"><a href="${escapeHtml(safeDriveUrl(item.driveUrl))}" target="_blank" rel="noopener noreferrer">Open folder in Drive</a></div><details><summary>Show the evidence</summary>${evidenceBlock(item.evidence)}</details></div></article>`).join("") || `<div class="empty">No exact USD requests of at least $1 million are shown.</div>`;
  $("#intelligence-list").innerHTML = `<section class="panel"><div class="panel-head"><div><p class="eyebrow">DECIDE</p><h2>All ${escapeHtml(state.decisionQueue.total)} decisions</h2></div></div>${decisions}</section><section class="panel"><div class="panel-head"><div><p class="eyebrow">CHECK</p><h2>USD requests found in files</h2></div><span class="badge">${state.moneyQueue.total} files</span></div>${money}</section>`;
}

function renderSources() {
  const rows = [
    ["Google Drive", state.sourceHealth.googleDrive, `${state.source.scannedFolders} folders checked · ${state.visibleFolderCount} shown`],
    ["ActiveCampaign", state.sourceHealth.activeCampaign, state.sourceHealth.activeCampaign.connected ? `${state.sourceHealth.activeCampaign.contactsTotal.toLocaleString()} contacts found` : state.sourceHealth.activeCampaign.reason],
    ["Calendly", state.sourceHealth.calendly, state.sourceHealth.calendly.connected ? `${state.sourceHealth.calendly.upcomingEvents} upcoming events found` : state.sourceHealth.calendly.reason],
    ["MeetAlfred", state.sourceHealth.meetAlfred, state.sourceHealth.meetAlfred.connected ? `${state.sourceHealth.meetAlfred.campaignsTotal} campaigns found` : state.sourceHealth.meetAlfred.reason],
  ];
  $("#source-health").innerHTML = `<article class="source-card security-source"><div class="source-icon bad"></div><div><h2>Dashboard access</h2><p><strong>Shared-link access</strong></p><small>Anyone with this full dashboard link can open it. There are no individual logins, revocation controls, or access logs. The main Drive folder also still allows anyone with its link to open it.</small></div></article>` + rows.map(([name, source, detail]) => `<article class="source-card"><div class="source-icon ${source.connected ? "ok" : "bad"}"></div><div><h2>${escapeHtml(name)}</h2><p>${escapeHtml(detail || "Not available")}</p><p class="connection-answer"><strong>${source.connected ? "Working" : "Not working"}</strong>${source.joinedToDeals ? " · Used with files" : " · Not matched to files"}</p><small>${escapeHtml(source.limitation || source.decisionUse || source.reason || "No note")}</small></div></article>`).join("") + `<article class="source-card"><div class="source-icon bad"></div><div><h2>Website traffic</h2><p>Not connected</p><small>No website traffic number is shown.</small></div></article>`;
}

function showDetail(id) {
  if (operatingState.locked) return;
  const deal = state.deals.find(item => item.id === id);
  if (!deal) return;
  const evidence = deal.statusEvidence || deal.amountEvidence;
  $("#dialog-content").innerHTML = `<p class="eyebrow">FILE DETAILS</p><h2>${escapeHtml(deal.name)}</h2><dl><dt>What we know</dt><dd>${escapeHtml(statusLabel(deal.status))}</dd><dt>Why</dt><dd>${escapeHtml(deal.statusReason)}</dd><dt>Exact request found</dt><dd>${escapeHtml(formatAmount(deal.amount, deal.currency))}</dd><dt>Evidence file</dt><dd>${escapeHtml(evidence?.fileName || "No short evidence note found")}</dd><dt>Last changed</dt><dd>${escapeHtml(formatDate(deal.lastModified))}</dd><dt>Files in folder</dt><dd>${deal.documentCount}</dd><dt>Duplicate check</dt><dd>${escapeHtml(deal.duplicateOf || deal.duplicateReviewReason ? "Needs a duplicate decision" : "No duplicate signal found")}</dd></dl><a class="primary-link" href="${escapeHtml(safeDriveUrl(deal.driveUrl))}" target="_blank" rel="noopener noreferrer">Open in Google Drive</a>`;
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
  $("#unlock-error").textContent = "Opening…";
  try {
    const envelope = await fetch(`./data.enc?ts=${Date.now()}`, { cache: "no-store" }).then(response => { if (!response.ok) throw new Error("Snapshot unavailable"); return response.json(); });
    state = await decrypt(envelope, password);
    operatingState = evaluateSnapshot(state);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    $("#access-key").value = "";
    $("#unlock").classList.add("hidden");
    $("#app").classList.remove("hidden");
    renderCommand(); renderDeals(); renderIntelligence(); renderSources(); wire();
  } catch {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    $("#access-key").value = "";
    $("#unlock-error").textContent = "This link or access key is not valid. Use the latest AFG dashboard link.";
  }
}

$("#unlock-form").addEventListener("submit", event => { event.preventDefault(); unlock($("#access-key").value); });
const hashKey = new URLSearchParams(location.hash.slice(1)).get("key");
if (hashKey) { history.replaceState(null, "", `${location.pathname}${location.search}`); unlock(hashKey); }
