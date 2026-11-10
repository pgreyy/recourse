import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { signMandate } from '../authorization/mandate-document';
import { MandateSpec } from '../authorization/mandate-spec';
import { checkpointDocument, entryHash, GENESIS_HASH, hashedBody, type Checkpoint, type RecorderEntry } from '../evidence/recorder';
import type { Snapshot } from '../evidence/snapshots';
import { canonicalHash } from '../shared/crypto/canonical';
import { loadSigner, signDocument } from '../shared/crypto/signing';
import { readCatalogFile } from '../transaction/catalog';
import { runFirewall, type FirewallLine } from '../transaction/firewall';
import type { CaseMaterial, StoredLine } from './material';

/**
 * Scorecard fixtures: labelled cases built in memory as complete, signed case material (signed mandate,
 * hash-chained recorder with signed checkpoints, hashed catalog snapshot, PayPal order mirror carrying the
 * anchor). Then optional tampering. They go through the same pipeline as live cases.
 */
export const Fixture = z.object({
  id: z.string(),
  category: z.enum(['agent_fault', 'merchant_fault', 'buyer_remorse', 'tampered', 'injection', 'third_party', 'borderline']),
  expected: z.enum(['AGENT_FAULT', 'MERCHANT_FAULT', 'BUYER_REMORSE', 'THIRD_PARTY_FAULT', 'INCONCLUSIVE']),
  title: z.string(),
  purchase: z.object({ path: z.enum(['substitute', 'direct']), requested: z.string().optional(), bought: z.string() }),
  buyer_report: z.string().optional(),
  dispute: z.object({ reason: z.string(), buyer_notes: z.array(z.string()) }).optional(),
  receipt: z.enum(['PENDING', 'CONFIRMED']).default('PENDING'),
  operator_statement: z.string().optional(),
  carrier_note: z.string().optional(),
  agent_reasoning: z.record(z.string(), z.string()).optional(),
  catalog: z.object({ stock: z.record(z.string(), z.number()).optional(), descriptions: z.record(z.string(), z.string()).optional() }).optional(),
  mandate: z.record(z.string(), z.unknown()).optional(),
  tamper: z.enum(['recorder_payload', 'anchor', 'truncated', 'snapshot', 'mandate']).optional(),
});
export type Fixture = z.infer<typeof Fixture>;

export const FixtureFile = z.object({ version: z.string(), cases: z.array(Fixture) });

export function readFixtures(path = resolve(process.cwd(), 'data/scorecard-cases.json')) {
  return FixtureFile.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const TEXT = "Running shoes, US men's 10, under $120, Kestrel or Sorin, by Friday";

function baseSpec(now: Date, overrides: Record<string, unknown> = {}): MandateSpec {
  const deadline = new Date(now.getTime() + 3 * 864e5).toISOString().slice(0, 10);
  return MandateSpec.parse({
    category: 'running shoes',
    max_total: { value: '120.00', currency: 'USD' },
    attributes: [{ name: 'size', value: '10', unit_system: 'US', gender: 'men' }],
    brands_allowed: ['Kestrel', 'Sorin'],
    merchants_allowed: null,
    quantity: 1,
    max_orders: 1,
    allow_substitutions: false,
    allow_split_orders: false,
    deadline,
    expires_at: null,
    ...overrides,
  });
}

function snapshotFrom(f: Fixture): Snapshot {
  const cat = readCatalogFile();
  return {
    merchant: { id: cat.merchant.id, name: cat.merchant.name, delivery_days: cat.merchant.delivery_days },
    catalog_version: cat.catalog_version,
    currency: cat.merchant.currency,
    listings: cat.listings
      .map((l) => ({
        listing_id: l.id,
        name: l.name,
        brand: l.brand,
        category: l.category,
        description: f.catalog?.descriptions?.[l.id] ?? l.description,
        variants: l.variants
          .map((v) => ({
            variant_id: v.id,
            attributes: v.attributes,
            price: { currency_code: cat.merchant.currency, value: v.price },
            stock: f.catalog?.stock?.[v.id] ?? v.stock,
            description: f.catalog?.descriptions?.[v.id] ?? v.description,
          }))
          .sort((a, b) => a.variant_id.localeCompare(b.variant_id)),
      }))
      .sort((a, b) => a.listing_id.localeCompare(b.listing_id)),
  };
}

export function buildFixtureMaterial(f: Fixture, now = new Date()): CaseMaterial {
  const signer = loadSigner();
  const caseRef = `SC-${f.id}`;
  const spec = baseSpec(now, f.mandate);
  const snap = snapshotFrom(f);
  const snapSha = canonicalHash(snap);
  const find = (id: string) => {
    for (const l of snap.listings) for (const v of l.variants) if (v.variant_id === id) return { l, v };
    throw new Error(`fixture ${f.id}: unknown variant ${id}`);
  };

  // Signed mandate
  const mandate: CaseMaterial['mandate'] = {
    id: randomUUID(),
    lineage_id: randomUUID(),
    version: 1,
    buyer_email: 'buyer@example.com',
    source_text: TEXT,
    spec,
    vault_id: 'FIXTURE-VAULT',
    signed_at: new Date(now.getTime() - 3600e3),
    signing_key_id: signer.keyId,
    previous_mandate_hash: null,
    mandate_hash: null,
    signature: null,
    status: 'CONSUMED',
    expires_at: new Date(spec.expires_at),
  };
  const sm = signMandate(mandate);
  mandate.mandate_hash = sm.mandateHash;
  mandate.signature = sm.signature;

  // Recorder chain, built entry by entry with real hashes and signed checkpoints
  const entries: RecorderEntry[] = [];
  const checkpoints: Checkpoint[] = [];
  let t = now.getTime() - 1800e3;
  const add = (kind: string, payload: unknown) => {
    const seq = entries.length + 1;
    const prev = entries.length ? entries[entries.length - 1].hash : GENESIS_HASH;
    const created_at = new Date((t += 1000));
    const p = JSON.parse(JSON.stringify(payload));
    const hash = entryHash(prev, hashedBody({ case_ref: caseRef, seq, kind, recorded_at: created_at.toISOString(), payload: p }));
    entries.push({ case_ref: caseRef, seq, kind, payload: p, prev_hash: prev, hash, created_at });
    const cp = { case_ref: caseRef, seq, head_hash: hash, signed_at: created_at, signing_key_id: signer.keyId };
    checkpoints.push({ ...cp, signature: signDocument(checkpointDocument(cp)).signature });
    return entries[entries.length - 1];
  };
  const reason = (tool: string, fallback: string) => f.agent_reasoning?.[tool] ?? fallback;
  const bought = find(f.purchase.bought);
  const cartId = `CART-${f.id}`;
  const lineOf = (x: ReturnType<typeof find>) => ({ variant_id: x.v.variant_id, quantity: 1, price: x.v.price.value, attributes: x.v.attributes, available: x.v.stock > 0 });

  add('agent.run.started', { agent: { name: 'Acme Shopper', version: f.purchase.path === 'substitute' ? '1.3' : '2.0' }, mandate: { id: mandate.id, version: 1, mandate_hash: mandate.mandate_hash } });
  add('agent.tool_call', { tool: 'search_catalog', reasoning: reason('search_catalog', 'Find running shoes in US men 10 from the allowed brands.'), input: {}, catalog_snapshot_sha256: snapSha });
  if (f.purchase.path === 'substitute') {
    const req = find(f.purchase.requested!);
    add('merchant.cart.created', {
      cart_id: cartId,
      status: 'INCOMPLETE',
      lines: [lineOf(req)],
      validation_issues: [{ code: 'INVENTORY_ISSUE', specific_issue: 'ITEM_OUT_OF_STOCK', message: `${req.l.name}, size ${req.v.attributes.size}, is out of stock. Size ${bought.v.attributes.size} is available at the same price.`, variant_id: req.v.variant_id, suggested_substitute: { variant_id: bought.v.variant_id, description: `size ${bought.v.attributes.size}`, attributes: bought.v.attributes } }],
      catalog_snapshot: { sha256: snapSha },
    });
    add('agent.tool_call', { tool: 'create_cart', reasoning: reason('create_cart', `Cheapest matching listing: ${req.l.name}.`), input: { items: [{ variant_id: req.v.variant_id, quantity: 1 }] }, result: { status: 'INCOMPLETE' }, catalog_snapshot_sha256: snapSha });
    add('merchant.cart.updated', { cart_id: cartId, status: 'READY', lines: [lineOf(bought)], validation_issues: [], catalog_snapshot: { sha256: snapSha } });
    add('agent.tool_call', { tool: 'update_cart', reasoning: reason('update_cart', `Accept the merchant's suggested substitute ${bought.v.variant_id}.`), input: { cart_id: cartId, items: [{ variant_id: bought.v.variant_id, quantity: 1 }] }, result: { status: 'READY' }, catalog_snapshot_sha256: snapSha });
  } else {
    add('merchant.cart.created', { cart_id: cartId, status: 'READY', lines: [lineOf(bought)], validation_issues: [], catalog_snapshot: { sha256: snapSha } });
    add('agent.tool_call', { tool: 'create_cart', reasoning: reason('create_cart', `${bought.l.name} matches every mandate attribute.`), input: { items: [{ variant_id: bought.v.variant_id, quantity: 1 }] }, result: { status: 'READY' }, catalog_snapshot_sha256: snapSha });
  }

  const fwLine: FirewallLine = { variant_id: bought.v.variant_id, listing_id: bought.l.listing_id, name: bought.l.name, brand: bought.l.brand, category: bought.l.category, quantity: 1, unit_price_cents: Math.round(Number(bought.v.price.value) * 100), attributes: bought.v.attributes };
  const firewall = runFirewall({ spec, mandate_status: 'ACTIVE', expires_at: mandate.expires_at, history: { spent_cents: 0, orders_placed: 0, units_bought: 0 }, cart: { currency: 'USD', total_cents: fwLine.unit_price_cents, lines: [fwLine] }, merchant: snap.merchant, agent: null, now: new Date(t) });
  const fwEntry = add('checkout.firewall', { cart_id: cartId, decision: firewall.decision, warnings: firewall.warnings, violations: firewall.violations, checks: firewall.checks, catalog_snapshot_sha256: snapSha });
  const orderRef = `RCS-SC-${f.id}`;
  const line: StoredLine = { variant_id: bought.v.variant_id, listing_id: bought.l.listing_id, name: bought.l.name, brand: bought.l.brand, quantity: 1, price: bought.v.price.value, attributes: bought.v.attributes, variant_description: bought.v.description, listing_description: bought.l.description };
  const compliance = firewall.decision === 'WARN' ? 'WARNING' : firewall.decision === 'PASS' ? 'COMPLIANT' : 'VIOLATION_APPROVED';
  const started = add('checkout.started', {
    order_ref: orderRef,
    cart_id: cartId,
    lines: [line],
    firewall_decision: firewall.decision,
    firewall_entry_seq: fwEntry.seq,
    ...(firewall.decision === 'WARN' ? { proceeded_despite_warnings: { warning_entry_seq: fwEntry.seq, rules: firewall.warnings.map((w) => w.rule), details: firewall.warnings.map((w) => w.detail) } } : {}),
    compliance,
  });
  const captureId = `CAP-SC-${f.id}`;
  add('paypal.order.created', { order_ref: orderRef, http: 201, status: 'COMPLETED' });
  add('paypal.anchor.verified', { all_match: true });
  add('paypal.tracker.added', { http: 201, tracking_number: `TRK-${f.id}` });
  add('checkout.completed', { order_ref: orderRef, paypal_capture_id: captureId, amount: { currency_code: 'USD', value: line.price } });
  let ackHash: string | null = null;
  if (f.receipt === 'CONFIRMED') {
    const doc = { type: 'recourse.receipt_acknowledgement', receipt_id: `RCPT-${f.id}`, order_ref: orderRef, case_ref: caseRef, mandate_hash: mandate.mandate_hash, paypal_capture_id: captureId, statement: 'The buyer confirmed this purchase. Confirming is not a waiver of PayPal dispute rights.', acknowledged_at: new Date(t + 60e3).toISOString(), signing_key_id: signer.keyId };
    const s = signDocument(doc);
    ackHash = s.hash;
    add('buyer.receipt.confirmed', { ...doc, acknowledgement_hash: s.hash, signature: s.signature });
  }
  if (f.carrier_note) add('carrier.note', { text: f.carrier_note });
  if (f.buyer_report) add('buyer.issue.reported', { order_ref: orderRef, description: f.buyer_report });
  if (f.operator_statement) add('operator.statement', { author: 'Acme Ops', text: f.operator_statement });

  const material: CaseMaterial = {
    kind: 'fixture',
    case: {
      id: null,
      case_ref: caseRef,
      source: f.dispute ? 'PAYPAL_DISPUTE' : 'BUYER_REPORT',
      opened_by: f.dispute ? 'PAYPAL' : 'BUYER',
      buyer_report: f.buyer_report ?? null,
      dispute: f.dispute ? { id: `PP-D-SC-${f.id}`, reason: f.dispute.reason, status: 'OPEN', buyer_notes: f.dispute.buyer_notes } : null,
    },
    mandate,
    agent: { name: 'Acme Shopper', version: f.purchase.path === 'substitute' ? '1.3' : '2.0', operator_name: 'Acme Shopping Agents' },
    order: {
      order_ref: orderRef,
      lines: [line],
      total_value: line.price,
      currency: 'USD',
      custom_id: mandate.mandate_hash!,
      invoice_id: orderRef,
      anchor_seq: started.seq,
      anchor_head_hash: started.hash,
      anchor_description: `RCS-ANCHOR ${started.hash}`,
      tracker_id: `TRK-${f.id}`,
      compliance,
      firewall,
      paypal_order_id: `PPO-SC-${f.id}`,
      paypal_capture_id: captureId,
      captured_at: new Date(t),
      spent_before_cents: 0,
    },
    paypal: { order: { description: `RCS-ANCHOR ${started.hash}`, custom_id: mandate.mandate_hash, invoice_id: orderRef, capture: { id: captureId, status: 'COMPLETED', status_reason: null, amount: { value: line.price, currency_code: 'USD' } } }, read_error: null },
    recorder: { entries, checkpoints },
    snapshot: { id: `SNAP-${f.id}`, sha256_stored: snapSha, snapshot: snap },
    receipt: { status: f.receipt === 'CONFIRMED' ? 'CONFIRMED' : f.buyer_report ? 'ISSUE_REPORTED' : 'PENDING', acknowledgement_hash: ackHash },
    statements: f.operator_statement ? [{ party: 'OPERATOR', author: 'Acme Ops', text: f.operator_statement, created_at: new Date(t) }] : [],
    delivery: { tracking_number: `TRK-${f.id}`, carrier_note: f.carrier_note ?? null },
  };

  // Tampering, applied after everything was signed and hashed
  switch (f.tamper) {
    case 'recorder_payload':
      (entries.find((e) => e.kind === 'checkout.firewall')!.payload as { decision: string }).decision = 'PASS';
      break;
    case 'anchor':
      material.paypal.order!.description = `RCS-ANCHOR ${'0'.repeat(64)}`;
      break;
    case 'truncated':
      entries.splice(entries.length - 2, 2);
      break;
    case 'snapshot':
      material.snapshot!.snapshot.listings[0].variants[0].price.value = '1.00';
      break;
    case 'mandate':
      material.mandate.spec = { ...material.mandate.spec, max_total: { value: '500.00', currency: 'USD' } };
      break;
  }
  return material;
}
