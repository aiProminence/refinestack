# RefineStack canonical product specification

Status: frozen for Release 1  
Research cut-off: 16 August 2026

## Product definition

RefineStack is an AI recommendation-intelligence system. It turns real buyer-decision questions into provenance-backed captures across AI surfaces, separates recommendation from visibility, explains why brands win or lose, and creates an auditable action plan.

The interaction model has two equally important surfaces:

1. **Operator**: one conversational command surface for setup, status, explanation, review and approved work.
2. **Workspace**: an inspectable system of record for questions, captures, evidence, metrics, actions, usage, health and governance.

RefineStack does not automate sales outreach, send email sequences, or imitate the proprietary visual design, copy, code or personalities of Single Brain or 11x. It adapts their useful operating patterns to recommendation intelligence.

## Research conclusions

### What to retain

- One coherent command surface backed by narrow specialist responsibilities.
- Guided, editable onboarding instead of an unstructured prompt box.
- Typed playbooks and question categories.
- Task-specific evidence retrieval with source priority and freshness.
- Durable work state, retries, idempotency and health visibility.
- Human approval for consequential or low-confidence decisions.
- Record-level drilldown from every aggregate.
- Continuous measurement tied to outcomes, not activity volume.

### What to improve

- No opaque autonomy or silent failure.
- No fabricated evidence, inferred customer proof or vanity metrics.
- No hidden pricing/usage math or inconsistent limits.
- No stale source treated as current truth without warning.
- No score without its denominator, coverage and metric version.
- No low-confidence classification silently entering a headline metric.
- No decorative integration, action or run controls.
- No cross-tenant or cross-workflow context bleed.

### Evidence base

Primary product sources:

- [Single Brain product](https://singlebrain.com/)
- [Single Brain deployment intake](https://singlebrain.com/get-started)
- [11x Alice](https://www.11x.ai/worker/alice)
- [11x Julian](https://www.11x.ai/worker/julian)
- [11x platform](https://www.11x.ai/)
- [11x analytics](https://www.11x.ai/platform/analytics-deliverability/deep-analytics)
- [11x API positioning](https://www.11x.ai/platform/integrations/api)
- [11x security](https://www.11x.ai/security)
- [11x Alice pricing](https://www.11x.ai/products/alice/pricing)
- [11x Julian pricing](https://www.11x.ai/products/julian/pricing)

Independent and user evidence:

- [11x G2 reviews](https://www.g2.com/products/11x/reviews)
- [11x Trustpilot reviews](https://www.trustpilot.com/review/11x.ai)
- [TechCrunch investigation](https://techcrunch.com/2025/03/24/a16z-and-benchmark-backed-11x-has-been-claiming-customers-it-doesnt-have/)
- [Sifted investigation](https://sifted.eu/articles/11x-toxic-culture-ceo-working-nights-a16z)

Single Brain has no credible independent product-review corpus, public API reference, help centre, status page or published price sheet as of the research cut-off. Its claims are product positioning, not independently validated acceptance evidence.

## Canonical feature matrix

| Module | Release 1 capability | Definition of done |
|---|---|---|
| Access | Admin-issued, token-bound invite auth, password reset, workspace roles and expiring invitations | Knowing an invited email cannot claim the account; all authorization is server-side; removed users lose access; no email enumeration |
| Setup | Brand, domain, category, markets, languages, competitors and aliases | Draft is resumable; dependencies are versioned when configuration changes |
| Question Library | Manual and generated questions across 14 typed playbooks | Every question has type, persona, market, stage, rationale, version and active state |
| Quality Gate | Duplicate, realism, answerability, freshness and coverage checks | Weak questions remain visible with reasons; overrides are audited |
| Evidence Library | URL, text and file sources with authority, freshness, policy and lineage | Source versions are immutable; retrieval and quoted-use permissions are separate |
| Provider Health | OpenAI, Anthropic and Google AI Overview adapters | Credentials remain server-side; unavailable providers show actionable state |
| Monitoring Runs | Preflight cost/coverage, idempotent execution, progress, retry and cancellation | Every requested capture ends succeeded, failed or unavailable; no silent work |
| Raw Answers | Exact prompt, provider, model/surface, access method, locale, response, citations, latency and usage | Raw records are immutable and never rewritten by later classification |
| Classification | Independent mention, citation, shortlist, recommendation, first-choice and rejection facts | Logical implications enforced; versioned classifier, confidence, evidence spans and review threshold |
| Review Queue | Human approval/override for low-confidence and disputed results | Actor, reason, before/after values and metric effects are retained |
| Metrics | Coverage, mention rate/share, recommendation rate/share, first-choice rate, owned citation rate and evidence support | Formula, denominator, cohort and version are visible; aggregates drill to records |
| Decision Map | Won, lost, absent and unstable buyer decisions | One path shows question → captures → classifications → evidence → action |
| Actions | Evidence-backed intervention backlog with impact, effort and uncertainty | Each action links to affected decisions/evidence; completion never claims causation |
| Compare | Side-by-side run and period comparison | Warn when question set, model, market or competitor cohort differs |
| Operator | Ask status, explain metrics, locate evidence and create draft actions/runs | Same permissions as workspace; unsupported actions are stated honestly |
| Schedules | Daily/weekly/monthly monitoring with timezone, overlap and missed-run policy | Next/last run and health visible; repeated failure opens a circuit breaker |
| Usage | Provider calls, tokens, latency, estimated cost, quota and hard caps | Preflight blocks unaffordable fan-out; retry charging is explicit |
| API | Versioned read API and run creation with hashed workspace tokens | Pagination, idempotency, rate limits and error schema documented |
| Webhooks | Signed events for run, review and action state changes | Timestamp tolerance, replay rejection, retries and delivery log implemented |
| Export | CSV and JSON exports of customer-owned data | Role-gated, tenant-safe and excludes secrets/restricted source content |
| Audit | Immutable security and product event stream | Covers membership, config, sources, questions, runs, reviews, exports and connectors |
| Accessibility | Keyboard, screen-reader, zoom, contrast and textual chart equivalents | Critical flows usable at 320px and 200% zoom without colour-only meaning |

## Question playbooks

1. Category discovery
2. Best or recommended vendors
3. Vendor shortlist
4. Brand-versus-competitor comparison
5. Alternatives or replacement
6. Problem-to-solution
7. Capability or feature fit
8. Industry or use-case fit
9. Role or persona fit
10. Pricing or value
11. Trust, risk or compliance
12. Implementation or integration
13. Regional or local market
14. Purchase readiness or decision criteria

## Specialist contracts

The Operator may delegate only to these bounded workers:

- **Market Mapper** validates brand, domain, market, category, competitors and aliases.
- **Question Strategist** drafts and scores buyer-decision questions.
- **Capture Orchestrator** executes approved questions across configured surfaces.
- **Answer Classifier** creates versioned brand and recommendation events.
- **Evidence Mapper** connects claims and citations to sources and flags conflicts.
- **Decision Analyst** calculates metrics and decision outcomes.
- **Action Planner** drafts evidence-backed interventions.
- **QA/Risk Worker** enforces confidence, provenance, policy and tenant boundaries.

Every worker receives explicit tenant, project, allowed-source and allowed-action scope. Workers cannot approve their own consequential output.

## Metric contracts

Only `succeeded` captures are eligible for answer-based rates. Failed and unavailable captures remain visible and contribute to coverage.

- **Capture coverage** = succeeded scheduled captures / all scheduled captures.
- **Mention rate** = succeeded captures mentioning the focal brand / succeeded captures.
- **Mention share of voice** = focal-brand occurrences / all tracked-brand occurrences.
- **Recommendation rate** = eligible captures explicitly recommending the focal brand / eligible captures.
- **Recommendation share** = focal-brand recommendation slots / recommendation slots occupied by any tracked brand.
- **First-choice rate** = eligible captures ranking the focal brand first / eligible captures.
- **Owned citation rate** = succeeded captures citing an owned domain / succeeded captures.
- **Evidence support rate** = classified claims with at least one retrievable source / classified claims.

An answer recommending no tracked brand is retained as a coverage gap. Comparisons must surface changes in coverage, questions, providers/models, markets, classifier version and tracked-brand cohort.

## Product truth rules

1. Never fabricate a provider result, source, event, competitor, rank, cost or customer outcome.
2. Raw captures are immutable; derived results are versioned.
3. A mention or citation is never silently promoted to a recommendation.
4. Every aggregate opens its included and excluded records.
5. Observed fact, model classification, human correction and system inference remain distinct.
6. Restricted evidence cannot appear in exports or public-copy recommendations.
7. A partial run never appears complete.
8. Unsupported features have no visible control.
9. Provider API captures are labelled as API captures, not personalized consumer sessions.
10. No external publish, delete, bulk write or connector mutation occurs without explicit human approval.

## Release exclusions

Release 1 intentionally excludes automated outbound email/phone/WhatsApp, a proprietary contact database, CRM write-back, media buying, payment collection and autonomous content publishing. These are not shown as available controls. Generic signed webhooks and the documented API provide an honest integration boundary.
