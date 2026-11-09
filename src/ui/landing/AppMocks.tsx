/** Static pictures of Setti's own screens for the landing page, filled with the Maple demo project's data. */
import Image from "next/image";
import { EMMA_MESSAGE, JORDAN_REQUEST, MAPLE_CHANGES, MAPLE_MONEY, MOVE_LABEL, V1_TOTAL_CENTS, V2_TOTAL_CENTS, usd, type MoveKind } from "./content";
import styles from "./Landing.module.css";

const MOVE_CLASS: Record<MoveKind, string> = {
  released: styles.moveReleased, held: styles.moveHeld, charged: styles.moveCharged, refunded: styles.moveRefunded, kept: styles.moveKept,
};

export function ThreadMock() {
  const [mention, ...rest] = JORDAN_REQUEST.split(" ");
  return (
    <div className={styles.thread}>
      <div className={styles.message}>
        <Image src="/avatars/budget-manager.webp" alt="" width={30} height={30} />
        <div><div className={styles.who}>Emma Park<span>Client</span></div><p>{EMMA_MESSAGE}</p></div>
      </div>
      <div className={styles.message}>
        <Image src="/avatars/designer.webp" alt="" width={30} height={30} />
        <div><div className={styles.who}>Jordan Lee<span>Designer</span></div><p><span className={styles.mention}>{mention}</span> {rest.join(" ")}</p></div>
      </div>
    </div>
  );
}

export function DraftMock() {
  return (
    <div className={styles.mockCard}>
      <div className={styles.mockHead}><span className={styles.spark} aria-hidden="true">✦</span><div><b>Setti · Draft V2</b><small>{MAPLE_CHANGES.length} changes from the thread, for Jordan to review</small></div></div>
      <ul className={styles.rows}>
        {MAPLE_CHANGES.map((change) => (
          <li key={change.itemId}>
            <span className={styles.item}>{change.name}<small>{change.change}</small></span>
            <span className={styles.amount}><s>{usd(change.beforeCents)}</s>{usd(change.afterCents)}</span>
          </li>
        ))}
      </ul>
      <div className={styles.total}><span>V1 {usd(V1_TOTAL_CENTS)}</span><b>V2 {usd(V2_TOTAL_CENTS)}</b></div>
    </div>
  );
}

export function MoneyMock() {
  return (
    <div className={styles.mockCard}>
      <div className={styles.mockHead}><span className={styles.paypalTag}>PayPal</span><div><b>After Emma signs V2</b><small>Each move is its own PayPal call</small></div></div>
      <ul className={styles.moves}>
        {MAPLE_MONEY.map((line) => (
          <li key={line.itemId}>
            <span className={styles.item}>{line.name}</span>
            <span className={styles.steps}>{line.moves.map((move) => <i key={move.kind} className={MOVE_CLASS[move.kind]}>{MOVE_LABEL[move.kind]} {usd(move.cents)}</i>)}</span>
            {line.note && <span className={styles.moveNote}>{line.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SignMock() {
  return (
    <div className={`${styles.mockCard} ${styles.sign}`}>
      <small>Change order V2 · Maple Ave Café</small>
      <div className={styles.signTotal}><s>{usd(V1_TOTAL_CENTS)}</s>{usd(V2_TOTAL_CENTS)}</div>
      <div className={styles.signature}>Emma Park</div>
      <small>Approved all {MAPLE_CHANGES.length} changes in one signature</small>
    </div>
  );
}

export function WindowMock() {
  return (
    <div className={styles.window}>
      <div className={styles.windowBar}><span className={styles.dots} aria-hidden="true"><i /><i /><i /></span><b>Maple Ave Café · Counter &amp; back bar</b><small>Emma Park, Jordan Lee, Setti</small></div>
      <div className={styles.windowBody}><ThreadMock /><DraftMock /></div>
    </div>
  );
}
