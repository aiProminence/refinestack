# RefineStack Release 1 acceptance-test plan

No feature is complete until its relevant automated and manual cases pass. A failure remains open until fixed and retested.

## Access, tenancy and authorization

- **AT-001** An uninvited email cannot create an account through UI or direct Auth API.
- **AT-002** Expired, forwarded, reused or mismatched invitations fail without revealing account state.
- **AT-002A** Knowing an invited email alone cannot choose, claim or reset that account's password; acceptance requires the mailbox-bound one-time token.
- **AT-003** Tenant A cannot read or infer Tenant B project, source, question, run, capture, export, webhook or audit data by changing identifiers.
- **AT-004** Viewer mutations fail at UI, API and database layers.
- **AT-005** Analyst cannot manage members, tokens, schedules or webhooks.
- **AT-006** Admin cannot create owner-only tokens, delete the workspace or transfer ownership.
- **AT-007** Removed members lose access with old sessions and direct URLs.
- **AT-008** Conversational commands enforce the same permissions as the workspace UI.
- **AT-009** API tokens are shown once, hashed at rest, scope-limited, revocable and never logged.
- **AT-010** Auth rate limits and error copy do not reveal whether an email exists.

## Setup and questions

- **AT-011** A user can create and resume a project with domain, category, market, language and competitors.
- **AT-012** Invalid domains, redirects, sparse sites, blocked crawling and internationalized domains receive distinct diagnostics.
- **AT-013** Changing competitor, market or question cohort creates a version boundary and preserves historical comparability.
- **AT-014** Every generated question has type, persona, stage, market and rationale.
- **AT-015** Duplicate and near-duplicate questions are detected before execution.
- **AT-016** Disqualified questions remain visible with reason and can be restored.
- **AT-017** Historical facts cannot satisfy a current requirement without a freshness warning.
- **AT-018** Question coverage identifies missing personas, stages, markets and playbook types.

## Evidence

- **AT-019** URL, plain text and supported file evidence ingests with source, version, retrieval time and policy.
- **AT-020** Source edits create a new version; earlier versions remain available to historical runs.
- **AT-021** Deleted or unavailable sources are marked rather than erased from historic lineage.
- **AT-022** Tracking parameters and redirects produce canonical URLs while retaining the original URL.
- **AT-023** Duplicate/syndicated sources do not count as independent evidence without warning.
- **AT-024** Restricted or non-quotable evidence never appears in an export or generated public-copy action.
- **AT-025** Prompt injection inside a source cannot change instructions, invoke tools or disclose secrets.
- **AT-026** Conflicting sources show their authority/freshness conflict and deterministic winner.

## Runs and provider failures

- **AT-027** Preflight shows selected questions/surfaces, call count, provider availability and estimated maximum cost.
- **AT-028** Double submit or refresh creates one run through idempotency.
- **AT-029** Each capture stores exact prompt, model/surface, locale, timestamp, raw response, citations, latency, usage and access method.
- **AT-030** Provider timeout/rate limit/auth failure/malformed response becomes an explicit typed state.
- **AT-031** Retry never duplicates a successful capture or billable usage record.
- **AT-032** One failed surface produces a partial run with transparent coverage loss.
- **AT-033** A run with no successful captures is failed and produces no recommendation metric.
- **AT-034** Cancellation prevents unleased work and preserves completed captures.
- **AT-035** Insufficient quota blocks before execution with exact shortfall.
- **AT-036** Scheduled overlap obeys skip/queue policy without duplicate work.
- **AT-037** Repeated scheduled failure opens a circuit breaker and exposes remediation.
- **AT-038** Market and locale remain distinct for otherwise identical questions.

## Classification and review

- **AT-039** Classifier distinguishes absent, mentioned, shortlisted, recommended, first choice and rejected.
- **AT-040** A mention or citation alone is not classified as recommendation.
- **AT-041** Brand aliases are resolved without double counting; common-word brand names require contextual evidence.
- **AT-042** Every derived result includes version, confidence and exact evidence spans.
- **AT-043** Low-confidence or contradictory results enter review according to policy.
- **AT-044** Override stores actor, reason, before/after and recalculates affected metrics.
- **AT-045** Raw provider response remains immutable after override or classifier upgrade.
- **AT-046** Reclassification creates a new version and historical metrics remain reproducible.
- **AT-047** Malformed, multilingual, empty and citation-free answers fail or classify explicitly without invented evidence.

## Metrics and analytics

- **AT-048** Every metric reproduces from documented numerator, denominator, cohort and version.
- **AT-049** Every aggregate drills to included and excluded captures.
- **AT-050** Provider, market, question type, persona, competitor and date filters update numerator and denominator consistently.
- **AT-051** Failed/unavailable captures change coverage but never enter answer-rate denominators.
- **AT-052** No-tracked-brand answers remain visible as coverage gaps.
- **AT-053** Retried captures do not double count decisions won/lost.
- **AT-054** Tiny samples display uncertainty instead of false precision.
- **AT-055** Trend comparison warns on changed questions, provider/model, classifier, market or competitor cohort.
- **AT-056** Usage and cost totals reconcile exactly to capture-level records.

## Actions, operator, API and webhooks

- **AT-057** Every proposed action links to losing questions, evidence gaps, expected impact, effort and uncertainty.
- **AT-058** Completing an action links to later runs without asserting causation.
- **AT-059** Operator can explain a score change using exact changed records.
- **AT-060** Operator refuses unsupported or unauthorized work and shows no fake success.
- **AT-061** Public API documents auth, scopes, pagination, idempotency, limits and errors.
- **AT-062** API object access is tenant-isolated and unknown/foreign IDs do not leak metadata.
- **AT-063** Webhook signature, timestamp tolerance and replay prevention reject tampering.
- **AT-064** Webhook retries are bounded, idempotent and visible in a delivery log.
- **AT-065** Revoking a token/webhook/provider stops future access or delivery immediately.
- **AT-066** Export contains all permitted customer data and no secret, restricted content or foreign row.

## Accessibility, resilience and operations

- **AT-067** Critical flows work with keyboard only and meaningful focus order.
- **AT-068** Screen readers receive labels, status announcements and textual chart/table equivalents.
- **AT-069** Interfaces remain usable at 320px, 200% zoom, long names, multilingual and RTL content.
- **AT-070** Colour is never the only indicator of result, status or severity.
- **AT-071** Slow/offline interruption cannot duplicate work or lose a saved draft silently.
- **AT-072** Empty, loading, partial, failed and permission-denied states are actionable.
- **AT-073** Production build, lint, typecheck, unit, integration and end-to-end suites pass.
- **AT-074** Security and performance advisors have no unresolved material finding.
- **AT-075** Production smoke tests cover public page, auth, setup, run, review, analytics, export and sign-out with no console/runtime errors.

## Verification loop

1. Run static checks and deterministic unit tests.
2. Apply migrations to an isolated branch or test database and run RLS/advisor checks.
3. Run authenticated browser journeys for Owner, Admin, Analyst and Viewer.
4. Run provider success and controlled failure fixtures.
5. Run cross-tenant, API-token, webhook-replay, prompt-injection and object-ID attacks.
6. Run keyboard, screen-reader semantic, responsive and visual regression checks.
7. Log defects with acceptance IDs, severity, reproduction and evidence.
8. Fix defects, rerun the failed case and its regression neighborhood.
9. Repeat until all Release 1 cases pass and no material defect is open.
