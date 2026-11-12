import Link from "next/link";
import { DraftMock, MoneyMock, SignMock, ThreadMock, WindowMock } from "./AppMocks";
import { CardIcon, ChatIcon, DesignerDoodle, LampDoodle, PlantDoodle, ReceiptDoodle, SignIcon, SofaDoodle, SparkIcon } from "./Doodles";
import { DEMO_VIDEO_ID, DISCUSSION_LENGTH, EVAL_RESULTS, GITHUB_URL, SECURITY_URL } from "./content";
import styles from "./Landing.module.css";
import { BrandMark } from "../BrandMark";

const PITCH = "Design evolves through conversation. Setti's AI spots changes, drafts revised quotes, and links each approval to PayPal holds, charges and refunds, so designers can spend their time on design.";
const score = ([passed, runs]: readonly [number, number]) => `${passed}/${runs}`;

export function Landing() {
  const [draftsPassed, draftRuns] = EVAL_RESULTS.drafts;
  return (
    <div className={styles.page}>
      <header className={styles.nav}>
        <Link href="/" className={styles.wordmark} aria-label="Setti home"><BrandMark className={styles.mark} />setti<span aria-hidden="true">.</span></Link>
        <nav className={styles.links} aria-label="Sections">
          <a href="#how">How it works</a><a href="#paypal">PayPal</a><a href="#ai">AI</a><a href={GITHUB_URL}>GitHub</a>
        </nav>
        <div className={styles.account}>
          <Link href="/sign-in" className={styles.signIn}>Sign in</Link>
          <Link href="/sign-up" className={`${styles.btn} ${styles.btnPrimary}`}>Sign up</Link>
        </div>
      </header>

      <main>
        <section className={styles.hero}>
          <h1>Settle the design in a chat, settle up in <span className={styles.pill}>PayPal</span>.</h1>
          <p className={styles.sub}>{PITCH}</p>
          <div className={styles.ctas}>
            <Link href="/try" className={`${styles.btn} ${styles.btnPrimary}`}>Try the live demo</Link>
            {DEMO_VIDEO_ID
              ? <a href="#video" className={`${styles.btn} ${styles.btnSoft}`}>Watch the 2-minute video</a>
              : <Link href="/ai-quality" className={`${styles.btn} ${styles.btnSoft}`}>See every AI eval</Link>}
          </div>
          <p className={styles.small}>Built for Build What&apos;s Next with PayPal and AI · PayPal Sandbox, no account needed · <Link href="/try/cases">Browse read-only examples</Link></p>
          <div className={styles.stage}>
            <span className={`${styles.doodle} ${styles.dSofa}`}><SofaDoodle /></span>
            <WindowMock />
            <span className={`${styles.doodle} ${styles.dPerson}`}><DesignerDoodle /></span>
            <span className={`${styles.doodle} ${styles.dLamp}`}><LampDoodle /></span>
            <span className={`${styles.doodle} ${styles.dPlant}`}><PlantDoodle /></span>
          </div>
        </section>

        <div className={styles.builtRow}><small>Built with</small><span>PayPal</span><span>Render</span><span>Claude</span></div>

        <section id="how" className={styles.section}>
          <h2>One change, settled in four steps.</h2>
          <p className={styles.lede}>Emma&apos;s landlord lets her café use the front window. Here is how that conversation becomes a signed revision and five kinds of PayPal move.</p>
          <div className={styles.bento}>
            <div className={styles.tile}>
              <h3><ChatIcon />Emma says it in the chat</h3>
              <p>A window counter with six more stools, acoustic panels, a shorter front counter, four pendants and sage green tile.</p>
              <div className={styles.tileMock}><ThreadMock /></div>
            </div>
            <div className={styles.tile}>
              <h3><SparkIcon />Setti drafts V2</h3>
              <p>It reads all {DISCUSSION_LENGTH} messages and the supplier notes, then proposes seven changes, each linked to the message it came from.</p>
              <div className={styles.tileMock}><DraftMock /></div>
            </div>
            <div className={styles.tile}>
              <h3><SignIcon />Jordan checks, Emma signs once</h3>
              <p>Jordan confirms prices, re-cut and return terms. Emma approves the whole revision with one signature.</p>
              <div className={styles.tileMock}><SignMock /></div>
            </div>
            <div className={styles.tile}>
              <h3><CardIcon />PayPal settles each item</h3>
              <p>New holds for the added pieces, four pendants charged and two released, and refunds for the re-cut top and the returned tile, minus the suppliers&apos; fees.</p>
              <div className={styles.tileMock}><MoneyMock /></div>
            </div>
          </div>
        </section>

        <section id="paypal" className={styles.section}>
          <div className={styles.wide}>
            <div>
              <span className={styles.receipt}><ReceiptDoodle /></span>
              <h2>One signature, five different PayPal moves.</h2>
              <p>PayPal holds the money, and each item moves on its own terms: a released hold, a new hold, a smaller charge or a refund that keeps the supplier&apos;s fee. Webhooks confirm every step.</p>
              <div className={styles.chips}><span>Authorizations</span><span>Partial captures</span><span>Voids</span><span>Refunds</span><span>Vault</span><span>Pay Later</span><span>Webhooks</span></div>
            </div>
            <MoneyMock />
          </div>
        </section>

        <section id="ai" className={styles.section}>
          <h2>AI you can check.</h2>
          <p className={styles.lede}>The AI drafts and explains. The money rules and the PayPal calls stay with the server and the people who approve them.</p>
          <div className={styles.three}>
            <div className={styles.stat}><b>Every amount</b><h3>cites a record</h3><p>The server checks each number against the project&apos;s PayPal records before anyone sees the answer.</p></div>
            <div className={styles.stat}><b>No PayPal access</b><h3>for the model</h3><p>It can draft and explain, but it cannot hold, charge or refund. A test fails if AI code ever reaches the PayPal client.</p><a href={SECURITY_URL}>Read SECURITY.md</a></div>
            <div className={styles.stat}><b>{draftsPassed} / {draftRuns}</b><h3>change drafts passed</h3><p>Graded against answer keys written before the model ran. Money answers {score(EVAL_RESULTS.money)}, inbox summaries {score(EVAL_RESULTS.inbox)}.</p><Link href="/ai-quality">See every case</Link></div>
          </div>
        </section>

        {DEMO_VIDEO_ID && (
          <section id="video" className={styles.section}>
            <h2>Watch one change settle.</h2>
            <div className={styles.video}>
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${DEMO_VIDEO_ID}?rel=0`}
                title="Setti walkthrough video"
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
              />
            </div>
          </section>
        )}

        <section className={styles.section}>
          <h2>Built with</h2>
          <div className={styles.built}>
            <div><b>PayPal</b><p>Holds, captures, voids, refunds, Vault and Pay Later, confirmed by webhooks.</p></div>
            <div><b>Render</b><p>The app, its Postgres database and a daily hold check.</p></div>
            <div><b>Claude</b><p>Setti&apos;s AI agent, on Claude Sonnet 5.5.</p></div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.end}`}>
          <div className={styles.endArt}><LampDoodle width={54} /><SofaDoodle width={150} /><PlantDoodle width={62} /></div>
          <h2>Settle the next change in Setti.</h2>
          <div className={styles.ctas}>
            <Link href="/try" className={`${styles.btn} ${styles.btnPrimary}`}>Try the live demo</Link>
            <a href={GITHUB_URL} className={`${styles.btn} ${styles.btnSoft}`}>See the code on GitHub</a>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span>Setti · hackathon build · PayPal Sandbox only</span>
        <a href={GITHUB_URL}>GitHub</a><a href={SECURITY_URL}>Security</a><Link href="/ai-quality">AI evals</Link>
      </footer>
    </div>
  );
}
