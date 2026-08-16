"use client";

import styles from "./global-error.module.css";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="en"><body className={styles.body}>
    <title>Application error · RefineStack</title>
    <main className={styles.main}>
      <span className={styles.eyebrow}>Application error</span>
      <h1>RefineStack could not complete that request.</h1>
      <p>The error was contained and no result was marked complete. Retry once or contact support with the time it occurred.</p>
      <div className={styles.actions}>
        <button className={styles.button} type="button" onClick={reset}>Try again</button>
        <a className={styles.link} href="mailto:hello@refinestack.com?subject=RefineStack%20application%20error">Contact support</a>
      </div>
    </main>
  </body></html>;
}
