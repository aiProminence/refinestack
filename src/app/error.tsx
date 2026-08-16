"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="system-page">
    <span className="eyebrow">Request interrupted</span>
    <h1>That work did not finish.</h1>
    <p>No result has been invented or marked complete. Retry the request or inspect run health.</p>
    <button className="button" type="button" onClick={reset}>Retry</button>
  </main>;
}
