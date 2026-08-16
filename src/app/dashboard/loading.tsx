export default function DashboardLoading() {
  return <section className="workspace-loading" role="status" aria-busy="true" aria-live="polite" aria-atomic="true">
    <span className="eyebrow">Loading workspace</span>
    <h1>Retrieving tenant-scoped evidence…</h1>
    <div aria-hidden="true"><span /><span /><span /></div>
  </section>;
}
