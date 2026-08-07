# RefineStack

AI recommendation intelligence for measuring when AI explicitly recommends a brand, why it earns that position, and what can improve it.

## Product truth

RefineStack does not treat mentions or citations as recommendations. AI Recommendation Share is calculated only from successful, provenance-backed observations:

`explicit recommendations for the brand / all captured brand recommendations`

Failed captures are retained for audit and excluded from metrics.

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
```

Add the Supabase project URL and publishable key to `.env.local`, then apply the migrations in `supabase/migrations`. The first confirmed user automatically receives a private workspace and owner membership. Never commit `.env.local`.

The public marketing page remains available without authentication. The dashboard is protected and all workspace-backed records are isolated with Postgres row-level security. Account creation is invitation-only: add an approved email to `private.beta_invites`, then send that person the private `/login?mode=signup` URL.

The initial monitoring surfaces are OpenAI, Claude, and Google AI Overviews. Provider access methods must remain explicit: API captures must not be presented as personalised consumer-session results.

## Quality checks

```bash
npm run check
```

## MVP milestones

1. Application foundation and product shell
2. Supabase authentication, tenancy and observation ledger
3. Provider adapters and provenance-backed capture
4. Recommendation classification and metrics
5. Scheduling, reports and operational controls
