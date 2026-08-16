import Link from "next/link";
import { EmptyState, Notice, PageHeader, SectionHeading, StatCard, StatusChip } from "@/components/product-ui";
import { SubmitButton } from "@/components/submit-button";
import { listEvidence, listProjects } from "@/lib/db";
import { listSourceVersions } from "@/lib/evidence/lifecycle";
import {
  assessFreshness,
  evaluateEvidenceQuality,
  injectionFlagLabels,
  type FreshnessState,
  type QualityClaim,
  type QualitySource,
  type SourceQualityAssessment,
} from "@/lib/evidence/quality";
import { listEvidenceClaims } from "@/lib/evidence/quality-store";
import type { SourceRow } from "@/types/database";
import { canWrite, getDashboardContext } from "../_context";
import { appendEvidenceVersionAction, archiveEvidenceAction, recordEvidenceClaimAction } from "./actions";
import { CreateEvidenceForm } from "./create-evidence-form";

export const metadata = { title: "Evidence library" };

type SourceVersion = Awaited<ReturnType<typeof listSourceVersions>>[number];

function freshnessTone(state: FreshnessState): "positive" | "warning" | "neutral" {
  return state === "current" ? "positive" : state === "stale" ? "warning" : "neutral";
}

function VersionHistory({ versions }: { versions: SourceVersion[] }) {
  return <details>
    <summary>{versions.length} immutable version{versions.length === 1 ? "" : "s"}</summary>
    <div className="table-wrap"><table>
      <caption>Immutable version history</caption>
      <thead><tr><th scope="col">Version</th><th scope="col">Quality contract</th><th scope="col">SHA-256</th><th scope="col">Valid from</th><th scope="col">Storage</th></tr></thead>
      <tbody>{versions.map((version) => {
        const freshness = assessFreshness(version.retrieved_at, version.freshness_days_snapshot);
        return <tr key={version.id}>
          <td>v{version.version}<br /><small>{version.mime_type ?? "text/plain"}</small></td>
          <td><StatusChip tone={freshnessTone(freshness.state)}>{freshness.state}</StatusChip><p>{Math.round(Number(version.authority_weight_snapshot) * 100)}% authority · {version.freshness_days_snapshot} day window</p>{version.prompt_injection_flags.length ? <small>{version.prompt_injection_flags.length} inert injection pattern{version.prompt_injection_flags.length === 1 ? "" : "s"}</small> : null}</td>
          <td><code title={version.content_hash}>{version.content_hash.slice(0, 12)}…</code></td>
          <td>{new Date(version.valid_from).toLocaleString()}</td>
          <td>{version.storage_path ? "Private object retained" : "Database text"}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </details>;
}

function NewVersionForm({ projectId, source }: { projectId: string; source: SourceRow }) {
  if (source.state !== "active") return null;
  return <details>
    <summary>Add a new version</summary>
    <form action={appendEvidenceVersionAction} className="product-form">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="sourceId" value={source.id} />
      {source.kind === "url" ? <p>The URL is retrieved again. A version is added only when its SHA-256 content hash is new.</p> : null}
      {source.kind === "text" ? <div className="field"><label htmlFor={`source-content-${source.id}`}>Replacement source text</label><textarea id={`source-content-${source.id}`} name="content" rows={5} required maxLength={1_000_000} /></div> : null}
      {source.kind === "file" ? <div className="field"><label htmlFor={`source-file-${source.id}`}>New private file</label><input id={`source-file-${source.id}`} name="file" type="file" required accept=".txt,.md,.csv,.json,.html,text/plain,text/markdown,text/csv,application/json,text/html" /><p>UTF-8 .txt, .md, .csv, .json, or .html only; maximum 1,000,000 bytes.</p></div> : null}
      <div className="form-grid">
        <div className="field"><label htmlFor={`source-authority-${source.id}`}>Authority weight</label><input id={`source-authority-${source.id}`} name="authorityWeight" type="number" min="0" max="1" step="0.05" defaultValue={source.authority_weight} required /></div>
        <div className="field"><label htmlFor={`source-freshness-${source.id}`}>Fresh for (days)</label><input id={`source-freshness-${source.id}`} name="freshnessDays" type="number" min="1" max="3650" step="1" defaultValue={source.freshness_days ?? 90} required /></div>
        {source.kind !== "url" ? <div className="field field-wide"><label htmlFor={`source-date-${source.id}`}>Retrieved or verified on <span>(optional)</span></label><input id={`source-date-${source.id}`} name="evidenceDate" type="date" /><p>Leave blank to preserve unknown freshness for this version.</p></div> : null}
      </div>
      <p>Authority and freshness are snapshotted with this version. Earlier versions retain their original configuration.</p>
      <SubmitButton pendingLabel="Saving version…">Save immutable version</SubmitButton>
    </form>
  </details>;
}

function ClaimForm({ projectId, source, version }: { projectId: string; source: SourceRow; version: SourceVersion | undefined }) {
  if (source.state !== "active" || !version) return null;
  return <details>
    <summary>Record a claim</summary>
    <form action={recordEvidenceClaimAction} className="product-form">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="sourceId" value={source.id} />
      <input type="hidden" name="sourceVersionId" value={version.id} />
      <div className="field"><label htmlFor={`claim-${source.id}`}>Exact claim</label><textarea id={`claim-${source.id}`} name="claimText" rows={3} maxLength={2000} required /></div>
      <div className="field"><label htmlFor={`excerpt-${source.id}`}>Supporting excerpt <span>(optional)</span></label><textarea id={`excerpt-${source.id}`} name="evidenceExcerpt" rows={3} maxLength={4000} /></div>
      <div className="field"><label htmlFor={`conflict-${source.id}`}>Conflict topic <span>(optional)</span></label><input id={`conflict-${source.id}`} name="conflictGroup" maxLength={160} placeholder="for example: enterprise refund window" /><p>Use the same topic on disagreeing claims. Ranking is deterministic and LLM-free.</p></div>
      <SubmitButton pendingLabel="Recording…">Record immutable claim</SubmitButton>
    </form>
  </details>;
}

function SourceQuality({ quality, sourceById }: { quality: SourceQualityAssessment | undefined; sourceById: Map<string, SourceRow> }) {
  if (!quality) return <p>Archived lineage retained; excluded from current quality counts.</p>;
  return <div>
    <p><StatusChip tone={freshnessTone(quality.freshness)}>{quality.freshness}</StatusChip> <StatusChip tone={quality.independent ? "positive" : "warning"}>{quality.independent ? "independent" : "duplicate"}</StatusChip></p>
    <p>{Math.round(quality.authorityWeight * 100)}% authority · {quality.freshnessDays} day window</p>
    {quality.freshness === "stale" ? <p><strong>Freshness warning:</strong> {quality.ageDays} days old; it cannot silently satisfy a current requirement.</p> : null}
    {quality.freshness === "unknown" ? <p><strong>Freshness warning:</strong> no valid immutable retrieval date was recorded.</p> : null}
    {!quality.independent ? <p><strong>Duplicate warning:</strong> {quality.duplicateKind?.replaceAll("_", " ")} of {sourceById.get(quality.duplicateOfSourceId ?? "")?.name ?? "the representative source"}; it does not add an independent vote.</p> : null}
    {quality.promptInjectionFlags.length ? <Notice title="Prompt-injection pattern held inert" tone="critical"><p>This source is stored and analyzed only as untrusted evidence text. It cannot issue instructions or invoke tools.</p><ul>{quality.promptInjectionFlags.map((flag) => <li key={flag}>{injectionFlagLabels[flag]}</li>)}</ul></Notice> : null}
  </div>;
}

export default async function EvidencePage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const [ctx, query] = await Promise.all([getDashboardContext(), searchParams]);
  const projects = await listProjects(ctx);
  const project = projects[0];
  const sources = project ? await listEvidence(ctx, project.id) : [];
  const [versionEntries, claims] = project ? await Promise.all([
    Promise.all(sources.map(async (source) => [source.id, await listSourceVersions(ctx, project.id, source.id)] as const)),
    listEvidenceClaims(ctx, project.id),
  ]) : [[], []] as const;
  const sourceVersions = new Map<string, SourceVersion[]>(versionEntries);
  const activeSources = sources.filter((source) => source.state === "active");
  const qualitySources: QualitySource[] = activeSources.map((source) => {
    const current = (sourceVersions.get(source.id) ?? []).find((version) => version.valid_until === null) ?? null;
    return { id: source.id, name: source.name, canonicalUrl: source.canonical_url, authorityWeight: Number(source.authority_weight), currentVersion: current ? {
      id: current.id, contentHash: current.content_hash, contentText: current.content_text,
      retrievedAt: current.retrieved_at, authorityWeight: Number(current.authority_weight_snapshot),
      freshnessDays: current.freshness_days_snapshot, promptInjectionFlags: current.prompt_injection_flags,
    } : null };
  });
  const qualityClaims: QualityClaim[] = claims.map((claim) => ({
    id: claim.id, sourceVersionId: claim.source_version_id, claimText: claim.claim_text,
    conflictGroup: claim.conflict_group, freshnessState: claim.freshness_state,
    authorityWeight: Number(claim.authority_weight_snapshot), createdAt: claim.created_at,
  }));
  const report = evaluateEvidenceQuality(qualitySources, qualityClaims);
  const qualityBySource = new Map(report.sources.map((quality) => [quality.sourceId, quality]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const versionById = new Map([...sourceVersions.values()].flat().map((version) => [version.id, version]));
  const sourceByVersionId = new Map([...sourceVersions.entries()].flatMap(([sourceId, versions]) => versions.map((version) => [version.id, sourceId] as const)));
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const writable = canWrite(ctx.actor.role);

  return <>
    <PageHeader eyebrow="Evidence library" title="Make every conclusion traceable." description="Manage public URLs, supplied text, and private files with immutable quality, policy, duplicate and conflict lineage." />
    {query.saved ? <Notice title="Saved" tone="info"><p>{query.saved}</p></Notice> : null}
    {query.error ? <Notice title="Evidence change failed" tone="critical"><p>{query.error}</p></Notice> : null}
    {!project ? <Notice title="Create a project first" tone="warning"><p><Link className="text-link" href="/dashboard/setup">Project setup</Link> is required before evidence can be added.</p></Notice> : null}
    {project ? <section className="stat-grid">
      <StatCard label="Current sources" value={report.counts.current.toLocaleString()} detail={`${report.counts.stale} stale · ${report.counts.unknown} unknown freshness`} tone="accent" />
      <StatCard label="Independent sources" value={report.counts.independent.toLocaleString()} detail="Syndicated and exact duplicates count once." />
      <StatCard label="Duplicate sources" value={report.counts.duplicate.toLocaleString()} detail="Same hash, canonical URL, or high-overlap copy." />
      <StatCard label="Quality warnings" value={(report.counts.injectionFlagged + report.counts.conflictGroups).toLocaleString()} detail={`${report.counts.injectionFlagged} injection-flagged · ${report.counts.conflictGroups} conflict groups`} />
    </section> : null}
    {project && writable ? <section className="workspace-card"><SectionHeading title="Add evidence" description="Set authority, freshness and use policy before the first immutable version is created." /><CreateEvidenceForm projectId={project.id} /></section> : null}
    <section className="workspace-card workspace-section-spaced">
      <SectionHeading title="Sources" description={`${sources.length} evidence source${sources.length === 1 ? "" : "s"}`} />
      {!sources.length ? <EmptyState title="No evidence sources yet" description="Evidence becomes useful only when its policy, content hash, quality and lineage are explicit." /> : <div className="table-wrap"><table>
        <caption>Evidence sources for {project?.name}</caption>
        <thead><tr><th scope="col">Source</th><th scope="col">Quality and policy</th><th scope="col">Lineage</th>{writable ? <th scope="col">Actions</th> : null}</tr></thead>
        <tbody>{sources.map((source) => {
          const versions = sourceVersions.get(source.id) ?? [];
          const currentVersion = versions.find((version) => version.valid_until === null);
          return <tr key={source.id}>
            <td><strong>{source.original_url ? <a className="text-link" href={source.original_url} rel="noreferrer" target="_blank">{source.name}<span className="sr-only"> (opens in new tab)</span></a> : source.name}</strong><p>{source.kind} · updated {new Date(source.updated_at).toLocaleDateString()}</p><StatusChip tone={source.state === "active" ? "positive" : "neutral"}>{source.state}</StatusChip></td>
            <td><SourceQuality quality={qualityBySource.get(source.id)} sourceById={sourceById} /><p>{[source.retrieval_allowed && "retrieve", source.quoting_allowed && "quote", source.export_allowed && "export"].filter(Boolean).join(", ") || "restricted"}</p></td>
            <td><VersionHistory versions={versions} /></td>
            {writable ? <td><NewVersionForm projectId={project!.id} source={source} /><ClaimForm projectId={project!.id} source={source} version={currentVersion} />{source.state === "active" ? <form action={archiveEvidenceAction} className="product-form"><input type="hidden" name="projectId" value={project!.id} /><input type="hidden" name="sourceId" value={source.id} /><SubmitButton pendingLabel="Archiving…">Archive source</SubmitButton></form> : <p>History retained; no new versions or claims accepted.</p>}</td> : null}
          </tr>;
        })}</tbody>
      </table></div>}
    </section>
    {project ? <section className="workspace-card workspace-section-spaced">
      <SectionHeading title="Conflict intelligence" description="Claims sharing a conflict topic are ranked by independence, authority, freshness, retrieval time and stable ID." />
      {!report.conflicts.length ? <p>No current source claims disagree within a shared conflict topic.</p> : <div className="record-stack">{report.conflicts.map((conflict) => {
        const winner = claimById.get(conflict.winnerClaimId)!;
        return <article className="record-card open" key={conflict.conflictGroup}><div className="record-summary"><span><strong>{conflict.conflictGroup}</strong><small>{conflict.distinctClaimCount} distinct claims</small></span><StatusChip tone="warning">conflict</StatusChip></div><div className="record-body">
          <p><strong>Deterministic winner:</strong> {winner.claim_text}</p><p>{conflict.rationale}</p>
          <details><summary>Compare every claim</summary><ul>{conflict.claimIds.map((claimId) => {
            const claim = claimById.get(claimId)!;
            const source = sourceById.get(sourceByVersionId.get(claim.source_version_id) ?? "");
            const version = versionById.get(claim.source_version_id);
            const freshness = assessFreshness(version?.retrieved_at, version?.freshness_days_snapshot);
            return <li key={claim.id}><strong>{source?.name ?? "Retained source"}:</strong> {claim.claim_text} <StatusChip tone={freshnessTone(freshness.state)}>{freshness.state}</StatusChip> <small>{Math.round(Number(claim.authority_weight_snapshot) * 100)}% authority{claim.id === conflict.winnerClaimId ? " · winner" : ""}</small></li>;
          })}</ul></details>
        </div></article>;
      })}</div>}
    </section> : null}
    {project ? <section className="workspace-card workspace-section-spaced">
      <SectionHeading title="Immutable claim ledger" description={`${claims.length} structured claim${claims.length === 1 ? "" : "s"}; conflict topics are optional and normalized.`} />
      {!claims.length ? <p>No claims have been recorded from current or historical versions.</p> : <div className="table-wrap"><table><caption>Evidence claim ledger</caption><thead><tr><th scope="col">Source</th><th scope="col">Claim</th><th scope="col">Conflict topic</th><th scope="col">Current freshness</th></tr></thead><tbody>{claims.map((claim) => {
        const version = versionById.get(claim.source_version_id);
        const source = sourceById.get(sourceByVersionId.get(claim.source_version_id) ?? "");
        const freshness = assessFreshness(version?.retrieved_at, version?.freshness_days_snapshot);
        return <tr key={claim.id}><td>{source?.name ?? "Retained source"}<br /><small>v{version?.version ?? "?"}</small></td><td>{claim.claim_text}{claim.evidence_excerpt ? <details><summary>Supporting excerpt</summary><blockquote>{claim.evidence_excerpt}</blockquote></details> : null}</td><td>{claim.conflict_group ?? "—"}</td><td><StatusChip tone={freshnessTone(freshness.state)}>{freshness.state}</StatusChip></td></tr>;
      })}</tbody></table></div>}
    </section> : null}
  </>;
}
