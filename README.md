# AltFunds Global Command Center

This repository publishes a mobile-ready, read-only evidence viewer for AltFunds Global. The owner approved link-only access with no password or login: anyone who has the dashboard URL can open the published client-level information. The page requests no search indexing, but the URL is not an authorization control. A protected operator must run deployment manually. The generator uses a least-privilege Google service account, the Drive API, exact API timestamps, conservative amount rules, and fail-closed publication.

## What the dashboard measures

| Area | Literal meaning |
|---|---|
| Today | A seven-file operating plan balancing decisions, verification, screening/qualification, and guarded re-engagement. Every action has an owner, due time, reason, three steps, and a finish line. It is not a fundability ranking. |
| Products & Providers | One full-document-gated record for every included Drive folder: client need, AFG product, exact source quotes, provided items, checklist limits, extraction ledger, advisory route, and eligible provider candidates. External drafts remain blocked unless lifecycle, extraction, product, evidence, exact USD amount, currency, geography, and provider-range gates all pass. |
| Company Strategy | Five operating priorities derived from aggregate dashboard facts, each with an owner, due time, action, reason, and measurable finish line. |
| Blue Ocean | Three explicitly labeled, unvalidated service hypotheses with a small test, owner, and success condition. These are tests—not forecasts or established demand. |
| Advisory Board | Three independent AI-generated decision lenses covering capital discipline, product simplicity, and first-principles scale, plus an explicit consensus/disagreement synthesis. The named-person labels describe styles only and are not statements, affiliations, endorsements, or advice from those people. |
| Human decisions | Status, amount, and duplicate conditions requiring internal resolution. These appear before ordinary file activity. |
| Unconfirmed exact USD asks ≥ US$1M | Exact client-stated USD requests meeting the parser screen. This is not a pipeline, approved amount, fundable amount, fee base, forecast, or revenue. |
| Folders with uploads | Authenticated folders containing non-system uploads. This is document activity, not a confirmed deal stage. |
| Observed changes in 24 hours | Files whose authenticated Drive API timestamps changed. This is not client-response or AFG-touch attribution. |
| Evidence Inventory | Every folder returned by the configured authenticated Drive scope, with literal observation labels and available evidence provenance. |
| Decision Work | The complete parser-generated exception-card set, grouped by status/amount and duplicate conditions, plus a separate seven-item unconfirmed USD evidence screen. Recipient drafting is blocked until conflicts and verification gates are resolved. |
| Source Health | Provider access, fetched aggregate/availability metadata, stored-ingestion state, deal-level join state, timestamps, counts, and limitations. A connected provider is not represented as joined or decision-used unless it actually is. |

## Data and financial rules

- File presence never establishes an authoritative active deal stage.
- Exact client-stated requests remain separate from verified eligible, approved, fee-eligible, contracted, or earned amounts.
- Currencies are never combined; non-USD values are not included in the USD screen.
- Historical 3% arithmetic remains in the upstream extraction layer for audit compatibility, but it is not emitted in the published dashboard schema, rendered, or used for decisions.
- Every inventoried document is reconciled to complete, partial, empty, unsupported, oversized, or failed. Only exact quotes from completely read documents may support a displayed “provided” claim. If any document is not completely readable, absence claims and external outreach are blocked.
- Provider candidates must pass exact product, source-quote evidence, exact USD amount, currency, geography, and stated range gates. A public candidate is never labeled as an existing AFG relationship and cannot outrank an eligible confirmed relationship.
- High-confidence structured request evidence takes precedence over summary text. A conflicting summary cannot silently override it; the amount is cleared and sent to human review.
- Every unresolved duplicate candidate—including the provisional primary—is excluded from operational totals and request-evidence screens pending a merge-or-separate decision.

## Freshness and safety

The browser rechecks freshness every minute, on focus, on visibility return, on navigation, and before every Drive/data action. It locks all data views when any of the following is true: the timestamp is invalid or materially future-dated; the artifact is older than 20 hours; no post-5:00 a.m. Eastern snapshot exists after the morning deadline; the source is not the authenticated Drive API; returned-scope folder counts do not reconcile; evidence reads failed; manifest and snapshot identifiers do not reconcile; or the artifact is not bound to an exact source commit. This is a display guardrail, not proof that an unattended morning refresh occurred.

The current GitHub Pages access model is direct link-only access with no key or login. Anyone who obtains the URL can open the published client-level information. `noindex,nofollow,noarchive` is included as a search-engine request, not a security boundary. GitHub Pages provides no individual authorization, revocation, or access logging.

The Drive root still reports an anonymous sharing permission. The read-only service account can ingest the source but received HTTP 403 when asked to remove that permission. Owner-level Drive permission is required to close this confidentiality gap; the dashboard surfaces the warning rather than hiding it.

## Automation state

An unattended GitHub Actions workflow is deliberately not published because the currently connected GitHub OAuth integration is denied both workflow-file and Actions-secret authorization. No unattended credentialed refresh, retry service, or alerting system is installed. Authenticated refreshes are generated and deployed only when the protected operator script is run; the browser stale lock is a fallback display guardrail.

## Verification

Run `pnpm install --frozen-lockfile` and `pnpm main`. The release command executes strict TypeScript checking, the regression suite, a source secret scan, authenticated source collection, complete extraction reconciliation, fail-closed analysis, static build, and source-to-artifact parity. `scripts/deploy-pages.sh` refuses dirty or uncommitted source, requires local HEAD to equal protected remote `main`, injects that source commit into the manifest, updates only the `gh-pages` artifact, verifies every public artifact hash and exact file set, and writes a protected release receipt.
