# RefineStack engineering guidance

## Product integrity

- Never fabricate AI observations, citations, competitors, ranks, confidence, or scores.
- Calculate metrics only from successful provider captures with stored provenance.
- Keep mentions, citations, explicit recommendations, and first-choice recommendations as distinct events.
- Failed or unavailable captures remain auditable and are excluded from metric denominators.
- Label provider access methods accurately; an API response must not be presented as a personalised consumer-session result.

## Engineering

- Keep provider credentials server-side and out of source control.
- Preserve tenant boundaries in every database query and job.
- Add tests around classification, metric denominators, retry behaviour, and provider failures.
- Prefer typed adapters and explicit unavailable states over fallbacks that invent data.
- Run `npm run check` before publishing changes.

## Interface

- Maintain the warm ivory, deep forest, restrained gold and editorial typography system.
- Use a 12px minimum for metadata and 14px minimum for working interface text.
- Every homepage promise must map to an implemented capability or be clearly labelled as planned/private beta.
