import type { MandateRow } from '../authorization/mandate-document';
import type { MandateSpec } from '../authorization/mandate-spec';
import { listCheckpoints, listEntries, type Checkpoint, type RecorderEntry } from '../evidence/recorder';
import type { Snapshot } from '../evidence/snapshots';
import { getOrder } from '../paypal/orders';
import { db } from '../shared/db/pool';
import type { FirewallResult } from '../transaction/firewall';

/**
 * Everything a case is decided on, in one shape. Live cases are loaded from the database and PayPal;
 * scorecard fixtures build the same shape in memory. Code checks, the counterfactual, the injection
 * scan and the evidence pack all work on this, so fixtures and real cases go through identical code.
 */
export type StoredLine = {
  variant_id: string;
  listing_id: string;
  name: string;
  brand: string;
  quantity: number;
  price: string;
  attributes: { size: string; unit_system: string | null; gender: string | null };
  variant_description: string;
  listing_description: string;
};

export type CaseMaterial = {
  kind: 'live' | 'fixture';
  case: {
    id: string | null;
    case_ref: string;
    source: string;
    opened_by: string;
    buyer_report: string | null;
    dispute: null | { id: string; reason: string | null; status: string | null; buyer_notes: string[] };
  };
  mandate: MandateRow & { status: string; spec: MandateSpec; expires_at: Date };
  agent: null | { name: string; version: string; operator_name: string };
  order: {
    order_ref: string;
    lines: StoredLine[];
    total_value: string;
    currency: string;
    custom_id: string;
    invoice_id: string;
    anchor_seq: number;
    anchor_head_hash: string;
    anchor_description: string;
    tracker_id: string | null;
    compliance: string;
    firewall: FirewallResult;
    paypal_order_id: string | null;
    paypal_capture_id: string | null;
    captured_at: Date | null;
    spent_before_cents: number;
  };
  paypal: { order: null | { description: string | null; custom_id: string | null; invoice_id: string | null; capture: null | { id: string; status: string; status_reason: string | null; amount: { value: string; currency_code: string } } }; read_error: string | null };
  recorder: { entries: RecorderEntry[]; checkpoints: Checkpoint[] };
  snapshot: null | { id: string; sha256_stored: string; snapshot: Snapshot };
  receipt: null | { status: string; acknowledgement_hash: string | null };
  statements: Array<{ party: string; author: string | null; text: string; created_at: Date }>;
  delivery: null | { tracking_number: string | null; carrier_note: string | null };
};

export type CaseRow = {
  id: string;
  case_ref: string;
  order_id: string | null;
  receipt_id: string | null;
  status: string;
  opened_by: string;
  source: string;
  description: string;
  dispute_id: string | null;
  dispute_snapshot: any;
  created_at: Date;
  updated_at: Date;
};

/** Load a live case: order, signed mandate, PayPal's copy of the order (re-read now), recorder, snapshot, receipt, statements. */
export async function loadCaseMaterial(c: CaseRow): Promise<CaseMaterial> {
  const o = (await db().query('SELECT * FROM orders WHERE id = $1', [c.order_id])).rows[0];
  if (!o) throw new Error(`case ${c.id} has no order`);
  const m = (
    await db().query(
      `SELECT m.*, b.email AS buyer_email, pt.vault_id FROM mandates m JOIN buyers b ON b.id = m.buyer_id
       LEFT JOIN payment_tokens pt ON pt.id = m.payment_token_id WHERE m.id = $1`,
      [o.mandate_id],
    )
  ).rows[0];
  const agent = o.agent_version_id
    ? (
        await db().query(
          `SELECT a.name, v.version, op.name AS operator_name FROM agent_versions v JOIN agents a ON a.id = v.agent_id
           JOIN operators op ON op.id = a.operator_id WHERE v.id = $1`,
          [o.agent_version_id],
        )
      ).rows[0] ?? null
    : null;
  const spentBefore = (
    await db().query<{ s: string | null }>(
      `SELECT SUM(total_value) AS s FROM orders WHERE mandate_lineage_id = $1 AND status IN ('CAPTURED', 'PARTIALLY_REFUNDED') AND captured_at < $2`,
      [o.mandate_lineage_id, o.captured_at ?? new Date()],
    )
  ).rows[0].s;

  let paypal: CaseMaterial['paypal'] = { order: null, read_error: null };
  if (o.paypal_order_id) {
    const r = await getOrder(o.paypal_order_id);
    if (r.status === 200) {
      const unit = r.body.purchase_units?.[0] ?? {};
      const cap = unit.payments?.captures?.[0];
      paypal = {
        order: {
          description: unit.description ?? null,
          custom_id: unit.custom_id ?? null,
          invoice_id: unit.invoice_id ?? null,
          capture: cap ? { id: cap.id, status: cap.status, status_reason: cap.status_details?.reason ?? null, amount: cap.amount } : null,
        },
        read_error: null,
      };
    } else paypal = { order: null, read_error: `HTTP ${r.status} ${r.body?.name ?? ''} debug ${r.debugId ?? '-'}` };
  }

  const entries = await listEntries(c.case_ref);
  const checkpoints = await listCheckpoints(c.case_ref);
  const fw = [...entries].reverse().find((e) => e.kind === 'checkout.firewall' && e.seq < o.anchor_seq);
  const sha = (fw?.payload as { catalog_snapshot_sha256?: string } | undefined)?.catalog_snapshot_sha256;
  const snapRow = sha ? (await db().query('SELECT id, sha256, snapshot FROM catalog_snapshots WHERE sha256 = $1', [sha])).rows[0] : undefined;
  const receipt = (await db().query('SELECT status, acknowledgement_hash FROM receipts WHERE order_id = $1', [o.id])).rows[0] ?? null;
  const statements = (await db().query('SELECT party, author, text, created_at FROM case_statements WHERE case_id = $1 ORDER BY created_at', [c.id])).rows;
  const d = c.dispute_snapshot;

  return {
    kind: 'live',
    case: {
      id: c.id,
      case_ref: c.case_ref,
      source: c.source,
      opened_by: c.opened_by,
      buyer_report: c.description || null,
      dispute: d ? { id: d.dispute_id, reason: d.reason ?? null, status: d.status ?? null, buyer_notes: d.buyer_notes ?? [] } : null,
    },
    mandate: { ...m, spec: m.spec, expires_at: m.expires_at },
    agent,
    order: {
      order_ref: o.order_ref,
      lines: o.lines,
      total_value: o.total_value,
      currency: o.currency.trim(),
      custom_id: o.custom_id,
      invoice_id: o.invoice_id,
      anchor_seq: o.anchor_seq,
      anchor_head_hash: o.anchor_head_hash.trim(),
      anchor_description: o.anchor_description,
      tracker_id: o.tracker_id,
      compliance: o.compliance,
      firewall: o.firewall,
      paypal_order_id: o.paypal_order_id,
      paypal_capture_id: o.paypal_capture_id,
      captured_at: o.captured_at,
      spent_before_cents: Math.round(Number(spentBefore ?? 0) * 100),
    },
    paypal,
    recorder: { entries, checkpoints },
    snapshot: snapRow ? { id: snapRow.id, sha256_stored: snapRow.sha256.trim(), snapshot: snapRow.snapshot } : null,
    receipt: receipt ? { status: receipt.status, acknowledgement_hash: receipt.acknowledgement_hash?.trim() ?? null } : null,
    statements,
    delivery: { tracking_number: o.tracker_id, carrier_note: null },
  };
}
