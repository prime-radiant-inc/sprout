import styles from "./App.module.css";

export function App() {
  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <span className={styles.logo}>[sprout]</span>
        <span className={styles.headerRight}>
          <span className={styles.model}>model</span>
          <span className={styles.sessionId}>session-id</span>
        </span>
      </header>

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <div className={styles.panelTitle}>Agent Tree</div>
          <div className={styles.placeholder}>No agents yet</div>
        </aside>

        <main className={styles.conversation}>
          <div className={styles.panelTitle}>Conversation</div>
          <div className={styles.placeholder}>Waiting for events...</div>
        </main>
      </div>

      <footer className={styles.footer}>
        <div className={styles.statusBar}>
          <span>ctx: 0 tokens</span>
          <span>0 turns</span>
          <span>idle</span>
        </div>
        <div className={styles.inputArea}>
          <span className={styles.prompt}>&gt; </span>
          <span className={styles.cursor}>_</span>
        </div>
      </footer>
    </div>
  );
}
