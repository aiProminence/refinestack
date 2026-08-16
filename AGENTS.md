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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
