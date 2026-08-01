# Prominence

AI recommendation intelligence for measuring when AI explicitly recommends a brand, why it earns that position, and what can improve it.

## Product truth

Prominence does not treat mentions or citations as recommendations. AI Recommendation Share is calculated only from successful, provenance-backed observations:

`explicit recommendations for the brand / all captured brand recommendations`

Failed captures are retained for audit and excluded from metrics.

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
```

No credentials are required for the public site or honest dashboard empty state. Never commit `.env.local`.

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
