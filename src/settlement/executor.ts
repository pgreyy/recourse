import { createHash } from 'node:crypto';
import { instructionWords } from '../shared/words';
import { agentCoverage } from '../authorization/coverage';
import { appendEntry } from '../evidence/recorder';

import { feeCents, feeModelFrom, grossUp, rateWords } from './fees';
import { captureOrder, createVaultOrder, firstCapture } from '../paypal/orders';
import { createAndSendInvoice, disputeAction, findLink, getCapture, getDispute, refundCapture } from '../paypal/settlement-api';
import type { PPResponse } from '../paypal/types';
import { db } from '../shared/db/pool';
import { HttpError } from '../shared/http/errors';
import { buildEvidencePdf } from './dispute-evidence';
import { cents, money, usedUnderAgreement } from './exposure';
import type { ObligationRow } from './obligations';

/**
 * The settlement executor. It only runs obligations from approved rulings, checks everything before each
 * PayPal action, writes the intended action BEFORE calling PayPal and the response after, and reconciles
 * an uncertain outcome (same PayPal-Request-Id, or a re-read) before any retry.
 */
type Check = { id: string; ok: boolean; detail: string };
type ActionName = 'REFUND_BUYER' | 'CHARGE_OPERATOR' | 'INVOICE_OPERATOR' | 'DISPUTE_ACCEPT_CLAIM' | 'DISPUTE_MAKE_OFFER' | 'DISPUTE_PROVIDE_EVIDENCE' | 'DISPUTE_ESCALATE' | 'REFUND_OPERATOR';
export type ActionRow = {
  id: string;
  obligation_id: string;
  action: ActionName;
  idempotency_key: string;
  status: 'INTENDED' | 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN' | 'SKIPPED';
  confirmation: 'pending' | 'confirmed';
  paypal_ids: Record<string, string | null>;
  response: any;
  http_status: number | null;
  amount_value: string | null;
  error: string | null;
};

export const idempotencyKey = (obligationId: string, action: ActionName) => createHash('sha256').update(`${obligationId}:${action}`).digest('hex');

async function getAction(obligationId: string, action: ActionName): Promise<ActionRow | undefined> {
  return (await db().query<ActionRow>('SELECT * FROM settlement_actions WHERE idempotency_key = $1', [idempotencyKey(obligationId, action)])).rows[0];
}

/**
 * Run one PayPal action exactly once. Intent is persisted first. An INTENDED/UNCERTAIN row from an earlier
 * attempt is reconciled before calling again: `reconcile` reads PayPal's state; if it shows the action
 * done, the row is completed from that; otherwise the call is repeated with the same idempotency key.
 */
async function runAction(
  ob: ObligationRow,
  caseRef: string,
  action: ActionName,
  amount: { value: string; currency: string } | null,
  request: unknown,
  call: (key: string) => Promise<PPResponse>,
  ids: (r: PPResponse) => Record<string, string | null>,
  okWhen: (r: PPResponse) => boolean = (r) => r.status < 300,
  reconcile?: () => Promise<PPResponse | null>,
): Promise<ActionRow> {
  const key = idempotencyKey(ob.id, action);
  let row = await getAction(ob.id, action);
  if (row?.status === 'SUCCEEDED') return row;
  if (row && (row.status === 'INTENDED' || row.status === 'UNCERTAIN') && reconcile) {
    const seen = await reconcile();
    if (seen && okWhen(seen)) {
      return finish(row.id, 'SUCCEEDED', seen, ids(seen), caseRef, action, 'reconciled from PayPal state before retry');
    }
  }
  if (!row) {
    row = (
      await db().query<ActionRow>(
        `INSERT INTO settlement_actions (obligation_id, action, idempotency_key, status, amount_value, currency, request) VALUES ($1, $2, $3, 'INTENDED', $4, $5, $6) RETURNING *`,
        [ob.id, action, key, amount?.value ?? null, amount?.currency ?? null, JSON.stringify(request)],
      )
    ).rows[0];
  } else {
    await db().query(`UPDATE settlement_actions SET status = 'INTENDED', error = NULL WHERE id = $1`, [row.id]);
  }
  await appendEntry(caseRef, 'settlement.action_intended', { obligation_id: ob.id, action, idempotency_key: key, amount, request });
  let res: PPResponse;
  try {
    res = await call(key);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await db().query(`UPDATE settlement_actions SET status = 'UNCERTAIN', error = $2 WHERE id = $1`, [row.id, msg]);
    await appendEntry(caseRef, 'settlement.action_uncertain', { obligation_id: ob.id, action, error: msg });
    throw new HttpError(504, 'SETTLEMENT_UNCERTAIN', `${action}: outcome unknown (${msg}). Run execute again: it reconciles before retrying.`);
  }
  return finish(row.id, okWhen(res) ? 'SUCCEEDED' : 'FAILED', res, ids(res), caseRef, action);
}

async function finish(id: string, status: 'SUCCEEDED' | 'FAILED', res: PPResponse, paypalIds: Record<string, string | null>, caseRef: string, action: ActionName, note?: string): Promise<ActionRow> {
  const err = status === 'FAILED' ? `HTTP ${res.status} ${res.body?.name ?? ''} ${res.body?.message ?? ''}`.trim() : null;
  const row = (
    await db().query<ActionRow>(
      `UPDATE settlement_actions SET status = $2, response = $3, http_status = $4, debug_id = $5, paypal_ids = $6, error = $7, completed_at = now() WHERE id = $1 RETURNING *`,
      [id, status, JSON.stringify(res.body), res.status, res.debugId ?? null, JSON.stringify(paypalIds), err],
    )
  ).rows[0];
  await appendEntry(caseRef, 'settlement.action_result', { action, status, http: res.status, debug_id: res.debugId ?? null, paypal_ids: paypalIds, error: err, note: note ?? null });
  return row;
}

async function setStatus(ob: ObligationRow, status: string, extra: Record<string, unknown> = {}) {
  const sets = ['status = $2', 'updated_at = now()'];
  const vals: unknown[] = [ob.id, status];
  for (const [k, v] of Object.entries(extra)) {
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  await db().query(`UPDATE settlement_obligations SET ${sets.join(', ')} WHERE id = $1`, vals);
}

async function context(obligationId: string) {
  const ob = (await db().query<ObligationRow>('SELECT * FROM settlement_obligations WHERE id = $1', [obligationId])).rows[0];
  if (!ob) throw new HttpError(404, 'RESOURCE_NOT_FOUND', `Obligation ${obligationId} not found`);
  const ruling = (await db().query('SELECT * FROM rulings WHERE id = $1', [ob.ruling_id])).rows[0];
  const cs = (await db().query('SELECT * FROM cases WHERE id = $1', [ob.case_id])).rows[0];
  const order = (await db().query('SELECT * FROM orders WHERE id = $1', [cs.order_id])).rows[0];
  const operator = ob.operator_id ? (await db().query('SELECT * FROM operators WHERE id = $1', [ob.operator_id])).rows[0] : null;
  const agreement = ob.liability_agreement_id ? (await db().query('SELECT * FROM liability_agreements WHERE id = $1', [ob.liability_agreement_id])).rows[0] : null;
  const token = ob.operator_id
    ? (await db().query(`SELECT * FROM payment_tokens WHERE operator_id = $1 AND owner_type = 'OPERATOR' AND status = 'ACTIVE'`, [ob.operator_id])).rows[0]
    : null;
  return { ob, ruling, cs, order, operator, agreement, token };
}

/** Fee PayPal kept when refunding: the capture's fee minus the fee returned on the refund (from the real breakdowns). */
function unreturnedFeeCents(capture: any, refund: any): number {
  const captureFee = cents(capture?.seller_receivable_breakdown?.paypal_fee?.value ?? 0);
  const refundedFee = cents(refund?.seller_payable_breakdown?.paypal_fee?.value ?? 0);
  return Math.max(0, captureFee - refundedFee);
}

export async function executeObligation(obligationId: string) {
  const { ob, ruling, cs, order, operator, agreement, token } = await context(obligationId);
  const caseRef: string = cs.case_ref;
  const checks: Check[] = [];
  const check = (id: string, ok: boolean, detail: string) => (checks.push({ id, ok, detail }), ok);
  const done = async (status: string, note: string) => {
    await setStatus(ob, status, { checks: JSON.stringify(checks), last_error: status === 'FAILED' ? note : null });
    return { obligation_id: ob.id, status, note, checks };
  };

  // Always: only approved rulings, never a reversed or appealed one.
  if (!check('ruling.approved', ruling.status === 'RULING_APPROVED' || ruling.status === 'SETTLED', `ruling ${ruling.status}`)) return done(ob.status, 'ruling is not in force (appealed or reversed)');
  if (ob.status === 'RECOVERED' || ob.status === 'COMPLETED' || ob.status === 'NO_ACTION') return { obligation_id: ob.id, status: ob.status, note: 'nothing left to do', checks };
  if (ob.kind === 'NO_CHARGE') return done('NO_ACTION', `${ob.verdict}: nobody is charged`);

  const currency = ob.currency.trim();
  const captureId: string = order.paypal_capture_id;

  // ---- REVERSAL: an appeal reversed an AGENT_FAULT after the operator was charged: refund the operator.
  if (ob.kind === 'REVERSAL') {
    const original = (await db().query<ObligationRow>(`SELECT * FROM settlement_obligations WHERE ruling_id = $1 AND kind = 'RECOVERY'`, [ob.ruling_id])).rows[0];
    const charge = original ? await getAction(original.id, 'CHARGE_OPERATOR') : undefined;
    const opCapture = charge?.paypal_ids?.capture_id;
    if (!check('operator.charge_exists', Boolean(opCapture), opCapture ? `operator capture ${opCapture}` : 'no operator charge to reverse')) return done('NO_ACTION', 'nothing was charged');
    const a = await runAction(
      ob, caseRef, 'REFUND_OPERATOR', { value: ob.amount_value, currency }, { capture_id: opCapture },
      (key) => refundCapture(opCapture!, { value: ob.amount_value, currency }, key, 'Recourse: ruling reversed on appeal'),
      (r) => ({ refund_id: r.body?.id ?? null, capture_id: opCapture! }),
    );
    return done(a.status === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED', a.status === 'SUCCEEDED' ? `operator refunded (${a.paypal_ids.refund_id})` : a.error ?? 'refund failed');
  }

  // ---- Workflow B: act through the dispute's own links; show PayPal's real status afterwards.
  if (ob.workflow === 'B') return executeDispute(ob, cs, order, ruling, checks, check, done, { operator, agreement, token });

  // ---- Workflow A
  const capRead = await getCapture(captureId);
  const ourRefund = await getAction(ob.id, 'REFUND_BUYER');
  if (ob.verdict === 'MERCHANT_FAULT' || ob.kind === 'RECOVERY') {
    if (ourRefund?.status !== 'SUCCEEDED') {
      if (!check('capture.not_refunded', capRead.body?.status === 'COMPLETED', `capture ${captureId} is ${capRead.body?.status}`)) return done('FAILED', `capture is ${capRead.body?.status}; refusing to refund twice`);
    } else check('capture.not_refunded', true, `already refunded by this obligation (${ourRefund.paypal_ids.refund_id})`);
    // The buyer refund never waits for the operator.
    const refund = await runAction(
      ob, caseRef, 'REFUND_BUYER', { value: order.total_value, currency }, { capture_id: captureId, full: true },
      (key) => refundCapture(captureId, { value: order.total_value, currency }, key, `Recourse ruling on ${caseRef}: full refund`),
      (r) => ({ refund_id: r.body?.id ?? null, capture_id: captureId }),
      (r) => r.status < 300 && ['COMPLETED', 'PENDING'].includes(r.body?.status),
    );
    if (refund.status !== 'SUCCEEDED') return done('FAILED', `buyer refund failed: ${refund.error}`);
    if (ob.verdict === 'MERCHANT_FAULT') return done('COMPLETED', `merchant refunded the buyer (${refund.paypal_ids.refund_id})`);
    await setStatus(ob, 'BUYER_REFUNDED');
    return recoverFromOperator(ob, caseRef, ruling, order, operator, agreement, token, capRead.body, refund.response, checks, check, done);
  }
  return done('NO_ACTION', `${ob.verdict} in workflow A: nothing to pay`);
}

async function recoverFromOperator(
  ob: ObligationRow,
  caseRef: string,
  ruling: any,
  order: any,
  operator: any,
  agreement: any,
  token: any,
  capture: any,
  refund: any,
  checks: Check[],
  check: (id: string, ok: boolean, detail: string) => boolean,
  done: (status: string, note: string) => Promise<unknown>,
) {
  const currency = ob.currency.trim();
  // Operator recovery waits for the operator's acceptance or the end of the appeal window.
  const accepted = Boolean(ruling.operator_accepted_at);
  const windowOver = ruling.appeal_deadline && new Date(ruling.appeal_deadline) <= new Date();
  if (!check('approvals.operator_recovery', accepted || windowOver, accepted ? `operator accepted the ruling at ${new Date(ruling.operator_accepted_at).toISOString()}` : `waiting: appeal window ends ${new Date(ruling.appeal_deadline).toISOString()}`)) {
    return done('BUYER_REFUNDED', 'buyer refunded; operator recovery waits for acceptance or the end of the appeal window');
  }
  const coverage = ob.agent_version_id ? await agentCoverage(ob.agent_version_id) : null;
  if (!check('agreement.accepted_and_covers', Boolean(coverage?.covered && agreement?.status === 'ACCEPTED' && coverage.agreement_id === agreement.id), coverage?.covered ? `agreement v${coverage.agreement_version} ACCEPTED and covers the agent version` : 'agent version not covered by an accepted agreement')) {
    return done('FAILED', 'no accepted liability agreement covers this agent version');
  }
  if (!check('vault.linked_to_agreement', Boolean(token && token.liability_agreement_id === agreement.id && token.vault_id), token ? `operator vault ${token.vault_id} linked to agreement ${token.liability_agreement_id === agreement.id ? 'v' + agreement.version : 'another version'}` : 'operator has no active saved PayPal')) {
    return invoiceOperator(ob, caseRef, operator, order, ob.amount_value, checks, done, 'operator vault not linked to the current agreement');
  }
  const refunded = cents(refund?.amount?.value ?? order.total_value);
  const fee = unreturnedFeeCents(capture, refund);
  // Gross-up: the charge also covers PayPal's fee on the charge itself, so the merchant nets exactly 0.00.
  const fees = feeModelFrom(capture);
  const full = grossUp(refunded + fee, fees);
  const used = await usedUnderAgreement(agreement.id);
  const remaining = Math.max(0, cents(agreement.aggregate_cap) - used.usedCents);
  const perIncident = cents(agreement.per_incident_cap);
  const amountCents = Math.min(full, perIncident, remaining);
  const chargeFee = feeCents(amountCents, fees);
  const m$ = (c: number) => money(c, currency).value;
  check('cap.per_incident', full <= perIncident, `refund ${m$(refunded)} + fee PayPal kept on the refund ${m$(fee)} + fee on this charge ${m$(feeCents(full, fees))} = ${m$(full)}; per-incident cap ${m$(perIncident)}`);
  if (!check('cap.aggregate', amountCents > 0, `aggregate cap ${agreement.aggregate_cap}, used ${money(used.usedCents, currency).value}, remaining ${money(remaining, currency).value}`)) {
    return done('FAILED', 'aggregate cap exhausted');
  }
  const amount = money(amountCents, currency).value;
  const charge = await runAction(
    ob, caseRef, 'CHARGE_OPERATOR', { value: amount, currency }, { vault_id: token.vault_id, custom_id: ruling.id, invoice_id: caseRef, breakdown: { booking_capture: m$(cents(capture?.seller_receivable_breakdown?.gross_amount?.value ?? order.total_value)), booking_capture_fee: m$(cents(capture?.seller_receivable_breakdown?.paypal_fee?.value ?? 0)), refund_fee_returned: m$(cents(refund?.seller_payable_breakdown?.paypal_fee?.value ?? 0)), refunded: m$(refunded), unreturned_fee: m$(fee), fee_on_charge: m$(chargeFee), full_recovery: m$(full), capped: amountCents < full, fee_rate: rateWords(fees), fee_source: fees.source } },
    async (key) => {
      const created = await createVaultOrder({ vaultId: token.vault_id, source: 'paypal', amount, currency, customId: ruling.id, invoiceId: caseRef, description: `Recourse ruling ${ruling.id} (${caseRef}): agent fault liability` }, key);
      if (created.status < 300 && created.body?.status !== 'COMPLETED') {
        const cap = await captureOrder(created.body.id, `${key}:capture`);
        return { ...cap, body: { ...cap.body, id: created.body.id } };
      }
      return created;
    },
    (r) => ({ order_id: r.body?.id ?? null, capture_id: firstCapture(r.body)?.id ?? null }),
    (r) => r.status < 300 && firstCapture(r.body)?.status === 'COMPLETED',
  );
  if (charge.status !== 'SUCCEEDED') return invoiceOperator(ob, caseRef, operator, order, amount, checks, done, `vault charge failed: ${charge.error ?? firstCapture(charge.response)?.status}`);
  await db().query(`UPDATE settlement_obligations SET recovered_value = $2 WHERE id = $1`, [ob.id, amount]);
  return done('AWAITING_CONFIRMATION', `operator charged ${amount} ${currency} (capture ${charge.paypal_ids.capture_id}); RECOVERED once PayPal confirms`);
}

async function invoiceOperator(ob: ObligationRow, caseRef: string, operator: any, order: any, amount: string, checks: Check[], done: (s: string, n: string) => Promise<unknown>, why: string) {
  checks.push({ id: 'fallback.invoice', ok: true, detail: why });
  const currency = ob.currency.trim();
  const inv = await runAction(
    ob, caseRef, 'INVOICE_OPERATOR', { value: amount, currency }, { recipient: operator?.email, reason: why },
    async () => {
      const r = await createAndSendInvoice({ recipientEmail: operator.email, amount, currency, reference: caseRef, note: `Recourse ruling on ${caseRef}: agent fault liability. ${why}.`, item: `Agent fault liability, order ${order.order_ref}` });
      return { status: r.sent?.status ?? r.created.status, debugId: r.created.debugId, headers: {}, body: { invoice_id: r.invoiceId, created: r.created.body, sent: r.sent?.body ?? null } };
    },
    (r) => ({ invoice_id: r.body?.invoice_id ?? null }),
  );
  if (inv.status !== 'SUCCEEDED') return done('FAILED', `invoice failed: ${inv.error}`);
  await db().query(`UPDATE settlement_obligations SET recovered_value = $2 WHERE id = $1`, [ob.id, amount]);
  return done('INVOICED', `invoice ${inv.paypal_ids.invoice_id} sent to the operator; RECOVERED when PayPal reports it paid`);
}

async function executeDispute(
  ob: ObligationRow,
  cs: any,
  order: any,
  ruling: any,
  checks: Check[],
  check: (id: string, ok: boolean, detail: string) => boolean,
  done: (status: string, note: string) => Promise<unknown>,
  op: { operator: any; agreement: any; token: any },
) {
  const caseRef: string = cs.case_ref;
  const disputeId: string = cs.dispute_id;
  const read = await getDispute(disputeId);
  const d = read.body;
  check('dispute.read', read.status === 200, `dispute ${disputeId}: ${d?.status} (${d?.dispute_life_cycle_stage}); links ${(d?.links ?? []).map((l: { rel: string }) => l.rel).join(', ')}`);
  const status = () => `PayPal says the dispute is ${d?.status} (${d?.dispute_life_cycle_stage})`;
  const amount = { value: d?.dispute_amount?.value ?? order.total_value, currency: d?.dispute_amount?.currency_code ?? ob.currency.trim() };

  if (ob.verdict === 'AGENT_FAULT') {
    const link = findLink(d, 'accept_claim');
    if (!check('paypal.offers.accept_claim', Boolean(link), link ? 'accept_claim offered' : 'accept_claim not offered now')) return done('AWAITING_PAYPAL', `${status()}; accept_claim is not offered at this status`);
    const a = await runAction(ob, caseRef, 'DISPUTE_ACCEPT_CLAIM', amount, { dispute_id: disputeId }, () => disputeAction(link!, { note: `Recourse ruling ${ruling.id}: agent fault. The buyer is refunded.`, accept_claim_type: 'REFUND' }), () => ({ dispute_id: disputeId }), undefined, async () => {
      const again = await getDispute(disputeId);
      return again.body?.status === 'RESOLVED' ? again : null;
    });
    if (a.status !== 'SUCCEEDED') return done('FAILED', `accept_claim failed: ${a.error}`);
    await setStatus(ob, 'BUYER_REFUNDED');
    return recoverFromOperator(ob, caseRef, ruling, order, op.operator, op.agreement, op.token, null, { amount }, checks, check, done);
  }

  if (ob.verdict === 'MERCHANT_FAULT') {
    const offer = findLink(d, 'make_offer');
    const accept = findLink(d, 'accept_claim');
    if (offer) {
      const a = await runAction(ob, caseRef, 'DISPUTE_MAKE_OFFER', amount, { dispute_id: disputeId }, () => disputeAction(offer, { note: 'Recourse: merchant fault. Full refund offered.', offer_amount: { currency_code: amount.currency, value: amount.value }, offer_type: 'REFUND' }), () => ({ dispute_id: disputeId }));
      return done(a.status === 'SUCCEEDED' ? 'AWAITING_PAYPAL' : 'FAILED', a.status === 'SUCCEEDED' ? `full refund offered; ${status()}` : `make_offer failed: ${a.error}`);
    }
    if (accept) {
      const a = await runAction(ob, caseRef, 'DISPUTE_ACCEPT_CLAIM', amount, { dispute_id: disputeId }, () => disputeAction(accept, { note: 'Recourse: merchant fault. Claim accepted.', accept_claim_type: 'REFUND' }), () => ({ dispute_id: disputeId }));
      return done(a.status === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED', a.status === 'SUCCEEDED' ? 'claim accepted; PayPal refunds the buyer' : `accept_claim failed: ${a.error}`);
    }
    check('paypal.offers.refund_action', false, 'neither make_offer nor accept_claim offered');
    return done('AWAITING_PAYPAL', `${status()}; no refund action offered now`);
  }

  if (ob.verdict === 'BUYER_REMORSE') {
    const provide = findLink(d, 'provide_evidence');
    const escalate = findLink(d, 'escalate');
    const pdf = await buildEvidencePdf(cs, order, ruling);
    // Use an evidence type PayPal asked the seller for (it rejects others with EVIDENCE_TYPE_IS_NOT_ALLOWED).
    // Never claim PROOF_OF_REFUND for a purchase that was not refunded.
    const requested: string[] = (d?.evidences ?? []).filter((e: { source?: string }) => e.source === 'REQUESTED_FROM_SELLER').map((e: { evidence_type: string }) => e.evidence_type);
    const evidenceType = requested.includes('OTHER') ? 'OTHER' : (requested.find((t) => t !== 'PROOF_OF_REFUND') ?? 'OTHER');
    check('evidence.type', true, `PayPal requested ${requested.join(', ') || 'nothing specific'}; filing as ${evidenceType}`);
    if (provide) {
      const a = await runAction(
        ob, caseRef, 'DISPUTE_PROVIDE_EVIDENCE', amount, { dispute_id: disputeId, file: 'recourse-evidence.pdf', bytes: pdf.length },
        () => disputeAction(provide, { evidences: [{ evidence_type: evidenceType, notes: 'Signed buyer instructions, signed buyer confirmation, recorder excerpt, PayPal anchor check and tracking or booking confirmation. The purchase matched the instructions and was delivered as described; the buyer changed their mind.' }] }, [{ name: 'evidence-file', filename: 'recourse-evidence.pdf', contentType: 'application/pdf', data: pdf }]),
        () => ({ dispute_id: disputeId }),
      );
      const after = await getDispute(disputeId);
      return done(a.status === 'SUCCEEDED' ? 'AWAITING_PAYPAL' : 'FAILED', a.status === 'SUCCEEDED' ? `evidence filed; PayPal says ${after.body?.status} (${after.body?.dispute_life_cycle_stage})` : `provide_evidence failed: ${a.error}`);
    }
    if (escalate) {
      // Evidence can only be filed once the case is a claim; escalating hands the decision to PayPal.
      const a = await runAction(ob, caseRef, 'DISPUTE_ESCALATE', null, { dispute_id: disputeId }, () => disputeAction(escalate, { note: 'Recourse: the purchase matched the buyer\'s signed instructions and the buyer confirmed it. Escalating so evidence can be filed.' }), () => ({ dispute_id: disputeId }));
      return done(a.status === 'SUCCEEDED' ? 'AWAITING_PAYPAL' : 'FAILED', a.status === 'SUCCEEDED' ? `provide_evidence not offered yet; escalated to a claim. Run execute again when PayPal offers provide_evidence. ${status()}` : `escalate failed: ${a.error}`);
    }
    check('paypal.offers.provide_evidence', false, 'provide_evidence not offered now');
    return done('AWAITING_PAYPAL', `${status()}; provide_evidence not offered now`);
  }
  return done('NO_ACTION', `${ob.verdict}: nobody is charged`);
}

/**
 * Who paid what, from confirmed settlement records only (PayPal-confirmed actions and PayPal's own capture and refund
 * records). Null until the obligation is settled and every money action is confirmed.
 */
export async function whoPaid(ob: ObligationRow, actions: Array<Record<string, any>>) {
  if (!['RECOVERED', 'COMPLETED'].includes(ob.status)) return null;
  const done = (name: string) => actions.find((a) => a.action === name && a.status === 'SUCCEEDED');
  const refund = done('REFUND_BUYER');
  const charge = done('CHARGE_OPERATOR') ?? done('INVOICE_OPERATOR');
  if ((refund && refund.confirmation !== 'confirmed') || (charge && charge.confirmation !== 'confirmed')) return null;
  const ccy = ob.currency.trim();
  const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
  const fmt = (c: number) => (c / 100).toFixed(2);
  const refunded = refund ? cents(refund.amount_value) : 0;
  const charged = charge ? cents(charge.amount_value) : 0;
  const unreturnedFee = charge ? cents(charge.request?.breakdown?.unreturned_fee) : 0;
  // PayPal's fee on the recovery charge itself, from PayPal's capture record (kept by PayPal, not recovered).
  const capture = charge?.response?.purchase_units?.[0]?.payments?.captures?.[0];
  const recoveryFee = capture?.seller_receivable_breakdown?.paypal_fee?.value ? cents(capture.seller_receivable_breakdown.paypal_fee.value) : null;
  // The merchant's cash flows on this order, each from a PayPal record: the booking capture and the fee PayPal took on
  // it, the refund and any fee PayPal returned on it, the operator charge and the fee PayPal took on that.
  const bd = charge?.request?.breakdown ?? {};
  const returnedFee = refund ? cents(refund.response?.seller_payable_breakdown?.paypal_fee?.value ?? bd.refund_fee_returned ?? 0) : 0;
  const bookingGross = bd.booking_capture !== undefined ? cents(bd.booking_capture) : cents(ob.amount_value);
  const bookingFee = bd.booking_capture_fee !== undefined ? cents(bd.booking_capture_fee) : unreturnedFee + returnedFee;
  const flows = [
    { label: 'booking captured', cents: bookingGross },
    { label: 'PayPal fee on the booking', cents: -bookingFee },
    ...(refund ? [{ label: 'refund to the buyer', cents: -refunded }, { label: 'fee PayPal returned on the refund', cents: returnedFee }] : []),
    ...(charge ? [{ label: 'charge to the operator', cents: charged }, { label: 'PayPal fee on the operator charge', cents: -(recoveryFee ?? 0) }] : []),
  ];
  // Net cash on this order, and the loss against the booking price the merchant was paid before the refund.
  const orderNet = flows.reduce((t, f) => t + f.cents, 0);
  const merchantNet = orderNet - bookingGross;
  let agreement = null;
  if (ob.liability_agreement_id) {
    const la = (await db().query('SELECT version, per_incident_cap::text, aggregate_cap::text FROM liability_agreements WHERE id = $1', [ob.liability_agreement_id])).rows[0];
    const used = (await db().query(`SELECT COALESCE(SUM(recovered_value), 0)::text AS v FROM settlement_obligations WHERE liability_agreement_id = $1 AND status = 'RECOVERED'`, [ob.liability_agreement_id])).rows[0].v;
    if (la) agreement = { version: la.version, per_incident_cap: la.per_incident_cap, aggregate_cap: la.aggregate_cap, used: Number(used).toFixed(2), cap_remaining: (Number(la.aggregate_cap) - Number(used)).toFixed(2) };
  }
  return {
    currency: ccy,
    buyer: { refunded: fmt(refunded), refund_id: refund?.paypal_ids?.refund_id ?? null },
    merchant: {
      refunded_to_buyer: fmt(refunded),
      paypal_fee_not_returned: fmt(unreturnedFee),
      received_from_operator: fmt(charged),
      net: fmt(merchantNet),
      made_whole: merchantNet >= 0,
      loss_after_recovery: fmt(Math.max(0, -merchantNet)),
      cash_flows: flows.map((f) => ({ label: f.label, amount: fmt(f.cents) })),
      order_net: fmt(orderNet),
      booking_price: fmt(bookingGross),
      calculation: charge?.request?.breakdown?.fee_on_charge ? charge.request.breakdown : null,
      paypal_fee_on_recovery: recoveryFee === null ? null : fmt(recoveryFee),
    },
    operator: { charged: fmt(charged), capture_id: charge?.paypal_ids?.capture_id ?? null, agreement },
  };
}

/** The settlement as shown to people: every action with real PayPal ids, status and confirmation. */
export async function settlementView(obligationId: string, live = false) {
  const ob = (await db().query<ObligationRow>('SELECT * FROM settlement_obligations WHERE id = $1', [obligationId])).rows[0];
  if (!ob) throw new HttpError(404, 'RESOURCE_NOT_FOUND', `Obligation ${obligationId} not found`);
  const actions = (await db().query('SELECT * FROM settlement_actions WHERE obligation_id = $1 ORDER BY created_at', [obligationId])).rows;
  const cs = (await db().query('SELECT case_ref, dispute_id FROM cases WHERE id = $1', [ob.case_id])).rows[0];
  const operator = ob.operator_id ? ((await db().query<{ name: string }>('SELECT name FROM operators WHERE id = $1', [ob.operator_id])).rows[0]?.name ?? null) : null;
  let paypalDispute = null;
  if (live && ob.workflow === 'B' && cs.dispute_id) {
    const d = await getDispute(cs.dispute_id);
    paypalDispute = { id: cs.dispute_id, http: d.status, status: d.body?.status ?? null, stage: d.body?.dispute_life_cycle_stage ?? null, outcome: d.body?.dispute_outcome ?? null, links: (d.body?.links ?? []).map((l: { rel: string }) => l.rel), read_at: new Date().toISOString() };
  }
  return {
    id: ob.id,
    ruling_id: ob.ruling_id,
    case_id: ob.case_id,
    case_ref: cs.case_ref,
    operator,
    kind: ob.kind,
    workflow: ob.workflow,
    verdict: ob.verdict,
    status: ob.status,
    amount: { value: ob.amount_value, currency: ob.currency.trim() },
    recovered: { value: ob.recovered_value, currency: ob.currency.trim() },
    last_error: ob.last_error,
    // Pre-check details are shown to people: "decision", "instructions" (stored text unchanged).
    checks: Array.isArray(ob.checks) ? (ob.checks as Array<Record<string, unknown>>).map((c) => (typeof c.detail === 'string' ? { ...c, detail: instructionWords(c.detail) } : c)) : ob.checks,
    paypal_dispute: paypalDispute,
    who_paid: await whoPaid(ob, actions),
    actions: actions.map((a) => ({
      action: a.action,
      status: a.status,
      confirmation: a.confirmation,
      confirmed_by: a.confirmed_by,
      amount: a.amount_value ? { value: a.amount_value, currency: a.currency?.trim() } : null,
      paypal_ids: a.paypal_ids,
      http_status: a.http_status,
      debug_id: a.debug_id,
      error: a.error,
      idempotency_key: a.idempotency_key.trim(),
      // How an operator charge was worked out (refund, fee kept on the refund, fee on the charge, rate, cap).
      calculation: a.action === 'CHARGE_OPERATOR' && a.request?.breakdown?.fee_on_charge ? a.request.breakdown : null,
      created_at: a.created_at,
      completed_at: a.completed_at,
      confirmed_at: a.confirmed_at,
    })),
    created_at: ob.created_at,
    updated_at: ob.updated_at,
  };
}

