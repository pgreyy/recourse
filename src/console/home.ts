import { env } from '../config';
import { settlementView } from '../settlement/executor';
import { db } from '../shared/db/pool';
import { overview } from './queries';

/** The home page's live figures and its story card, from confirmed records only. Public, read-only. */
export async function homeData() {
  const o = await overview();
  const decided = (await db().query<{ n: string }>(`SELECT count(DISTINCT case_id)::text AS n FROM rulings WHERE status IN ('RULING_APPROVED', 'APPEALED', 'SETTLED', 'REVERSED')`)).rows[0].n;
  const covered = (await db().query<{ n: string }>(`SELECT count(DISTINCT operator_id)::text AS n FROM liability_agreements WHERE status = 'ACCEPTED'`)).rows[0].n;
  // Wrongly blamed agents in the latest scorecard run: AGENT_FAULT where the labelled answer was something else.
  const run = (await db().query(`SELECT id, cases_total, results, finished_at FROM scorecard_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`)).rows[0];
  const results = (run?.results ?? []) as Array<{ got: string; expected: string }>;
  const wrongly = run ? { count: results.filter((r) => r.got === 'AGENT_FAULT' && r.expected !== 'AGENT_FAULT').length, cases: run.cases_total as number, run_id: String(run.id).slice(0, 8) } : null;

  return {
    numbers: {
      recovered_confirmed: o.recovered_confirmed,
      cases_decided: Number(decided),
      operators_covered: Number(covered),
      wrongly_blamed_in_testing: wrongly,
    },
    story: await latestStory(),
    links: {
      video_url: env('VIDEO_URL') ?? null,
      // Shown only when the repository is public: REPO_PUBLIC holds its https URL.
      repo_url: /^https:\/\//.test(env('REPO_PUBLIC') ?? '') ? env('REPO_PUBLIC')! : null,
    },
  };
}

/** The latest agent-fault case whose recovery PayPal confirmed, told in the card's five lines; null if none yet. */
async function latestStory() {
  const ob = (
    await db().query(
      `SELECT so.id, so.case_id FROM settlement_obligations so WHERE so.kind = 'RECOVERY' AND so.status = 'RECOVERED' ORDER BY so.updated_at DESC LIMIT 1`,
    )
  ).rows[0];
  if (!ob) return null;
  const view = await settlementView(ob.id);
  const w = view.who_paid;
  if (!w) return null;
  const c = (
    await db().query(
      `SELECT cs.case_ref, o.lines, o.total_value::text AS total, m.source_text
       FROM cases cs JOIN orders o ON o.id = cs.order_id JOIN mandates m ON m.id = o.mandate_id WHERE cs.id = $1`,
      [ob.case_id],
    )
  ).rows[0];
  const a = (await db().query(`SELECT counterfactual FROM assessments WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`, [ob.case_id])).rows[0];
  const line = (c?.lines ?? [])[0];
  const stay = line?.attributes?.stay;
  const alt = a?.counterfactual?.compliant_alternatives?.[0];
  const policy = (p: string | null | undefined) => (p === 'REFUNDABLE' ? 'refundable' : p === 'NON_REFUNDABLE' ? 'non-refundable' : 'no refund policy');
  // A rate with no refund policy whose own description says it is non-refundable is called that, with the source.
  let bookedPolicy = stay ? policy(stay.refund_policy) : '';
  if (stay && !stay.refund_policy && line?.variant_id) {
    const d = (await db().query<{ description: string }>('SELECT description FROM merchant_variants WHERE id = $1', [line.variant_id])).rows[0]?.description ?? '';
    if (/non-?refundable/i.test(d)) bookedPolicy = 'non-refundable';
  }
  return {
    case_ref: c?.case_ref ?? null,
    asked: c?.source_text ?? null,
    booked: line ? `${line.name}${bookedPolicy ? `, ${bookedPolicy}` : ''}` : null,
    alternative: alt ? { what: alt.attributes?.stay ? `A ${policy(alt.attributes.stay.refund_policy)} room` : alt.name, total: alt.price } : null,
    currency: w.currency,
    buyer_refunded: w.buyer.refunded,
    merchant_loss: w.merchant.loss_after_recovery,
    operator_charged: w.operator.charged,
  };
}
