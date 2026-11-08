"use client";

import { useState, type ReactNode } from "react";
import styles from "./AiQuality.module.css";

/** One recorded run at a time; the panels are rendered on the server and only switched here. */
export function RunTabs({ labels, panels }: { labels: string[]; panels: ReactNode[] }) {
  const [active, setActive] = useState(0);
  return (
    <div className={styles.runs}>
      <div className={styles.runTabs} role="group" aria-label="Recorded runs">
        {labels.map((label, index) => (
          <button key={label} type="button" className={styles.runTab} aria-pressed={index === active} onClick={() => setActive(index)}>{label}</button>
        ))}
      </div>
      {panels.map((panel, index) => <div key={labels[index]} hidden={index !== active}>{panel}</div>)}
    </div>
  );
}
