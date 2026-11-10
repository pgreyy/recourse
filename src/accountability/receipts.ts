import type pg from 'pg';
import type { MandateSpec } from '../authorization/mandate-spec';
import { appendEntry } from '../evidence/recorder';
import { config } from '../config';
import { signBytes, signDocument, verifyBytes, loadSigner } from '../shared/crypto/signing';
import { db, tx } from '../shared/db/pool';
import type { FirewallResult } from '../transaction/firewall';

/**
 * Ratification receipt: after a purchase the buyer sees what was asked, what was bought and how they
 * differ, and can confirm (a signed acknowledgement, recorded) or report an issue (opens a case;
 * no PayPal dispute is created). Confirming does not waive PayPal dispute rights.
 */

const TOKEN_PREFIX = 'recourse.receipt.v1:';

/** URL token = receipt id + Ed25519 signature over it, so receipt links can't be guessed or altered. */
export function receiptToken(receiptId: string): string {
  return `${receiptId}.${signBytes(TOKEN_PREFIX + receiptId).signature}`;
}

export function parseReceiptToken(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return verifyBytes(TOKEN_PREFIX + id, token.slice(dot + 1)) ? id : null;
}

export function receiptUrl(receiptId: string): string {
  return `${config.publicBaseUrl()}/r/${receiptToken(receiptId)}`;
}

export async function createReceipt(orderId: string, c: pg.PoolClient): Promise<{ id: string; url: string }> {
  const { rows } = await c.query<{ id: string }>('INSERT INTO receipts (order_id) VALUES ($1) RETURNING id', [orderId]);
  return { id: rows[0].id, url: receiptUrl(rows[0].id) };
}

type Line = {
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

/**
 * Differences between the mandate and what was bought, computed in code (no LLM). Merchant text is
 * only scanned for sizing words; it is quoted, never followed.
 */
export function receiptDifferences(spec: MandateSpec, lines: Line[]): { differences: string[]; matches: string[] } {
  const differences: string[] = [];
  const matches: string[] = [];
  for (const l of lines) {
    for (const a of spec.attributes) {
      if (a.name === 'size') {
        const want = `${a.unit_system} ${a.value}`;
        if (!l.attributes.unit_system) differences.push(`size system: requested ${a.unit_system}, listing gave none (size "${l.attributes.size}")`);
        else if (l.attributes.unit_system !== a.unit_system || l.attributes.size !== a.value) differences.push(`size: requested ${want}, listing is ${l.attributes.unit_system} ${l.attributes.size}`);
        else matches.push(`size ${want}`);
        const text = `${l.variant_description} ${l.listing_description}`;
        for (const m of text.matchAll(/\b(US|UK|EU)\s+sizing\b/gi)) {
          if (m[1].toUpperCase() !== a.unit_system) differences.push(`description says ${m[1].toUpperCase()} sizing`);
        }
        if (/runs\s+(large|small|big)/i.test(text)) differences.push(`description says it ${text.match(/runs\s+(large|small|big)/i)![0].toLowerCase()}`);
        if (a.gender) {
          if (!l.attributes.gender) differences.push(`gender: requested ${a.gender}, listing gave none`);
          else if (l.attributes.gender !== a.gender) differences.push(`gender: requested ${a.gender}, listing is ${l.attributes.gender}`);
          else matches.push(`${a.gender}'s`);
        }
      }
    }
    if (spec.brands_allowed.length) {
      if (spec.brands_allowed.some((b) => b.toLowerCase() === l.brand.toLowerCase())) matches.push(`brand ${l.brand} (allowed: ${spec.brands_allowed.join(', ')})`);
      else differences.push(`brand ${l.brand} is not in ${spec.brands_allowed.join(', ')}`);
    }
  }
  return { differences: [...new Set(differences)], matches: [...new Set(matches)] };
}

export type ReceiptView = Awaited<ReturnType<typeof loadReceipt>>;

export async function loadReceipt(receiptId: string) {
  const { rows } = await db().query(
    `SELECT r.id AS receipt_id, r.status AS receipt_status, r.confirmed_at, r.acknowledgement_hash,
            o.id AS order_id, o.order_ref, o.case_ref, o.lines, o.total_value::text AS total, o.currency, o.firewall, o.compliance,
            o.paypal_order_id, o.paypal_capture_id, o.captured_at, o.custom_id, o.anchor_head_hash, o.anchor_verified,
            m.id AS mandate_id, m.version AS mandate_version, m.source_text, m.spec, m.mandate_hash,
            mer.name AS merchant_name
     FROM receipts r JOIN orders o ON o.id = r.order_id JOIN mandates m ON m.id = o.mandate_id
     JOIN merchants mer ON mer.id = o.merchant_id WHERE r.id = $1`,
    [receiptId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  const cases = await db().query('SELECT id, status, description, created_at FROM cases WHERE receipt_id = $1 ORDER BY created_at', [receiptId]);
  const diff = receiptDifferences(r.spec as MandateSpec, r.lines as Line[]);
  return { ...r, ...diff, cases: cases.rows, firewall: r.firewall as FirewallResult };
}

/** "Confirm purchase": signed acknowledgement, stored and appended to the recorder. */
export async function confirmReceipt(receiptId: string) {
  const r = await loadReceipt(receiptId);
  if (!r) throw new Error('receipt not found');
  if (r.receipt_status !== 'PENDING') return r;
  const at = new Date();
  const doc = {
    type: 'recourse.receipt_acknowledgement',
    receipt_id: r.receipt_id,
    order_ref: r.order_ref,
    case_ref: r.case_ref,
    mandate_hash: r.mandate_hash?.trim(),
    paypal_capture_id: r.paypal_capture_id,
    statement: 'The buyer confirmed this purchase. Confirming is not a waiver of PayPal dispute rights.',
    acknowledged_at: at.toISOString(),
    signing_key_id: loadSigner().keyId,
  };
  const s = signDocument(doc);
  await tx(async (c) => {
    await c.query(
      `UPDATE receipts SET status = 'CONFIRMED', confirmed_at = $2, acknowledgement_hash = $3, acknowledgement_sig = $4, signing_key_id = $5 WHERE id = $1`,
      [receiptId, at, s.hash, s.signature, s.keyId],
    );
    await appendEntry(r.case_ref, 'buyer.receipt.confirmed', { ...doc, acknowledgement_hash: s.hash, signature: s.signature }, c);
  });
  return loadReceipt(receiptId);
}

/** "Report an issue": opens a case (OPEN) and records it. Pre-dispute: nothing is filed at PayPal. */
export async function reportIssue(receiptId: string, description: string) {
  const r = await loadReceipt(receiptId);
  if (!r) throw new Error('receipt not found');
  await tx(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO cases (case_ref, order_id, receipt_id, status, opened_by, description) VALUES ($1, $2, $3, 'OPEN', 'BUYER', $4) RETURNING id`,
      [r.case_ref, r.order_id, receiptId, description.slice(0, 2000)],
    );
    await c.query(`UPDATE receipts SET status = 'ISSUE_REPORTED' WHERE id = $1`, [receiptId]);
    await appendEntry(r.case_ref, 'buyer.issue.reported', { case_id: rows[0].id, receipt_id: receiptId, order_ref: r.order_ref, description: description.slice(0, 2000) }, c);
  });
  return loadReceipt(receiptId);
}
