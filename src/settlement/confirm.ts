import { recordReputationEvent } from '../accountability/reputation';
import { appendEntry } from '../evidence/recorder';
import { getCapture, getInvoice, getRefund } from '../paypal/settlement-api';
import { db, tx } from '../shared/db/pool';
import { HttpError } from '../shared/http/errors';

/**
 * Confirmations: PayPal's word (webhook, or a GET when the webhook is late) that an action really
 * completed. An AGENT_FAULT obligation becomes RECOVERED only on a confirmed operator capture or a paid
 * invoice; that is also when the ruling is final for reputation.
 */
async function confirmAction(actionId: string, by: 'webhook' | 'GET') {
  const { rows } = await db().query(
    `UPDATE settlement_actions SET confirmation = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1 AND confirmation = 'pending' RETURNING *`,
    [actionId, by],
  );
  return rows[0] ?? null;
}

/** Operator capture or invoice confirmed: obligation RECOVERED, ruling SETTLED, reputation events written. */
async function finalizeRecovery(obligationId: string, by: string, ids: Record<string, unknown>) {
  await tx(async (c) => {
    const ob = (await c.query('SELECT * FROM settlement_obligations WHERE id = $1 FOR UPDATE', [obligationId])).rows[0];
    if (ob.status === 'RECOVERED') return;
    await c.query(`UPDATE settlement_obligations SET status = 'RECOVERED', updated_at = now() WHERE id = $1`, [obligationId]);
    const ruling = (await c.query(`UPDATE rulings SET status = 'SETTLED' WHERE id = $1 AND status = 'RULING_APPROVED' RETURNING *`, [ob.ruling_id])).rows[0];
    const cs = (await c.query('SELECT case_ref FROM cases WHERE id = $1', [ob.case_id])).rows[0];
    await c.query(`UPDATE cases SET status = 'CLOSED', updated_at = now() WHERE id = $1`, [ob.case_id]);
    await recordReputationEvent(c, { kind: 'CONFIRMED_AGENT_FAULT', agentVersionId: ob.agent_version_id, operatorId: ob.operator_id, rulingId: ob.ruling_id, obligationId, amount: ob.amount_value, currency: ob.currency.trim(), weight: Number(ob.amount_value) });
    await recordReputationEvent(c, { kind: 'OBLIGATION_PAID', operatorId: ob.operator_id, agentVersionId: ob.agent_version_id, rulingId: ob.ruling_id, obligationId, amount: ob.recovered_value, currency: ob.currency.trim(), weight: Number(ob.recovered_value) });
    await appendEntry(cs.case_ref, 'settlement.recovered', { obligation_id: obligationId, confirmed_by: by, ...ids, recovered: ob.recovered_value, ruling_status: ruling?.status ?? 'unchanged' }, c);
  });
}

export async function onCaptureCompleted(captureId: string, by: 'webhook' | 'GET') {
  const a = (await db().query(`SELECT * FROM settlement_actions WHERE action = 'CHARGE_OPERATOR' AND status = 'SUCCEEDED' AND paypal_ids->>'capture_id' = $1`, [captureId])).rows[0];
  if (!a) return null;
  await confirmAction(a.id, by);
  await finalizeRecovery(a.obligation_id, by, { operator_capture_id: captureId });
  return a.obligation_id as string;
}

export async function onRefundCompleted(refundId: string, by: 'webhook' | 'GET') {
  const a = (await db().query(`SELECT * FROM settlement_actions WHERE action IN ('REFUND_BUYER', 'REFUND_OPERATOR') AND status = 'SUCCEEDED' AND paypal_ids->>'refund_id' = $1`, [refundId])).rows[0];
  if (!a) return null;
  await confirmAction(a.id, by);
  return a.obligation_id as string;
}

export async function onInvoicePaid(invoiceId: string, by: 'webhook' | 'GET') {
  const a = (await db().query(`SELECT * FROM settlement_actions WHERE action = 'INVOICE_OPERATOR' AND status = 'SUCCEEDED' AND paypal_ids->>'invoice_id' = $1`, [invoiceId])).rows[0];
  if (!a) return null;
  await confirmAction(a.id, by);
  await finalizeRecovery(a.obligation_id, by, { invoice_id: invoiceId });
  return a.obligation_id as string;
}

/** Reconcile with GETs for anything still pending (when a webhook is late or missing). */
export async function reconcileObligation(obligationId: string) {
  const ob = (await db().query('SELECT id FROM settlement_obligations WHERE id = $1', [obligationId])).rows[0];
  if (!ob) throw new HttpError(404, 'RESOURCE_NOT_FOUND', `Obligation ${obligationId} not found`);
  const pending = (await db().query(`SELECT * FROM settlement_actions WHERE obligation_id = $1 AND status = 'SUCCEEDED' AND confirmation = 'pending'`, [obligationId])).rows;
  const results: Array<{ action: string; paypal_status: string | null; confirmed: boolean }> = [];
  for (const a of pending) {
    if (a.action === 'CHARGE_OPERATOR' && a.paypal_ids.capture_id) {
      const r = await getCapture(a.paypal_ids.capture_id);
      const ok = r.body?.status === 'COMPLETED';
      if (ok) await onCaptureCompleted(a.paypal_ids.capture_id, 'GET');
      results.push({ action: a.action, paypal_status: r.body?.status ?? `HTTP ${r.status}`, confirmed: ok });
    } else if ((a.action === 'REFUND_BUYER' || a.action === 'REFUND_OPERATOR') && a.paypal_ids.refund_id) {
      const r = await getRefund(a.paypal_ids.refund_id);
      const ok = r.body?.status === 'COMPLETED';
      if (ok) await onRefundCompleted(a.paypal_ids.refund_id, 'GET');
      results.push({ action: a.action, paypal_status: r.body?.status ?? `HTTP ${r.status}`, confirmed: ok });
    } else if (a.action === 'INVOICE_OPERATOR' && a.paypal_ids.invoice_id) {
      const r = await getInvoice(a.paypal_ids.invoice_id);
      const ok = r.body?.status === 'PAID';
      if (ok) await onInvoicePaid(a.paypal_ids.invoice_id, 'GET');
      results.push({ action: a.action, paypal_status: r.body?.status ?? `HTTP ${r.status}`, confirmed: ok });
    }
  }
  return { obligation_id: obligationId, checked: results };
}
