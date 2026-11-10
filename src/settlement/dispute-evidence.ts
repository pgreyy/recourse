import { checkMandateSignature } from '../authorization/mandate-document';
import { listEntries, verifyChain, listCheckpoints } from '../evidence/recorder';
import { getOrder } from '../paypal/orders';
import { db } from '../shared/db/pool';
import { textPdf } from './evidence-pdf';

/**
 * Evidence PDF for a dispute (BUYER_REMORSE): the signed buyer instructions and their signature check, the buyer's
 * signed confirmation, a recorder excerpt with step numbers, the PayPal anchor check and tracking.
 * Everything in it is read from records and checked by code at the time it is built.
 */
export async function buildEvidencePdf(cs: any, order: any, ruling: any): Promise<Buffer> {
  const m = (
    await db().query(
      `SELECT m.*, b.email AS buyer_email, pt.vault_id FROM mandates m JOIN buyers b ON b.id = m.buyer_id
       LEFT JOIN payment_tokens pt ON pt.id = m.payment_token_id WHERE m.id = $1`,
      [order.mandate_id],
    )
  ).rows[0];
  const sig = checkMandateSignature(m);
  const entries = await listEntries(cs.case_ref);
  const chain = verifyChain(cs.case_ref, entries, await listCheckpoints(cs.case_ref));
  const pp = order.paypal_order_id ? await getOrder(order.paypal_order_id) : null;
  const unit = pp?.body?.purchase_units?.[0] ?? {};
  const anchorEntry = entries.find((e) => e.seq === order.anchor_seq);
  const ack = entries.find((e) => e.kind === 'buyer.receipt.confirmed');
  const spec = m.spec;
  const lines = (order.lines as Array<{ name: string; quantity: number; price: string; attributes: { size: string; unit_system: string | null; gender: string | null } }>)
    .map((l) => `${l.quantity} x ${l.name}, size ${l.attributes.unit_system ?? '(no system)'} ${l.attributes.size}${l.attributes.gender ? `, ${l.attributes.gender}` : ''}, ${l.price} ${order.currency.trim()}`)
    .join('\n');
  const excerpt = entries
    .filter((e) => /^(agent\.tool_call|checkout\.|paypal\.|buyer\.)/.test(e.kind))
    .slice(0, 30)
    .map((e) => {
      const p = e.payload as any;
      const what = e.kind === 'agent.tool_call' ? `${p.tool}${p.input?.items ? ' ' + p.input.items.map((i: { variant_id: string }) => i.variant_id).join(',') : ''}` : e.kind === 'checkout.firewall' ? `firewall ${p.decision}` : '';
      return `step ${e.seq}  ${e.created_at.toISOString()}  ${e.kind} ${what}  hash ${e.hash.slice(0, 16)}...`;
    })
    .join('\n');
  return textPdf(`Recourse evidence for ${cs.case_ref} (order ${order.order_ref})`, [
    {
      heading: '1. Signed buyer instructions',
      body: `In the buyer's words: "${m.source_text}"\nInstructions ${m.id}, v${m.version}. Category ${spec.category}; size ${spec.attributes.map((a: { name: string; unit_system: string; value: string }) => `${a.name} ${a.unit_system ?? ''} ${a.value}`).join('; ')}; brands ${spec.brands_allowed.join(', ')}; budget ${spec.max_total.value} ${spec.max_total.currency} in total; deadline ${spec.deadline}.\nHash ${m.mandate_hash?.trim()}\nSigned ${m.signed_at?.toISOString()} with key ${m.signing_key_id}.`,
    },
    { heading: '2. Signature check (at the time this file was built)', body: `Ed25519 signature over the canonical instructions: ${sig.signature_valid ? 'VALID' : 'INVALID'} (${sig.signature_check.reason}).` },
    { heading: '3. What was bought', body: `${lines}\nTotal ${order.total_value} ${order.currency.trim()}. Checkout compliance: ${order.compliance} (firewall ${order.firewall?.decision}).` },
    {
      heading: '4. Buyer confirmation',
      body: ack
        ? `The buyer confirmed the purchase on the receipt at ${(ack.payload as { acknowledged_at: string }).acknowledged_at} (recorder step ${ack.seq}). Signed acknowledgement hash ${(ack.payload as { acknowledgement_hash: string }).acknowledgement_hash}.`
        : 'The buyer did not confirm on the receipt.',
    },
    { heading: '5. Decision record (flight recorder excerpt)', body: `${excerpt}\nChain check: ${chain.valid ? 'intact' : `problem at step ${chain.first_problem?.seq}`} (${chain.entries} entries, ${chain.checkpoints.count} signed checkpoints).` },
    {
      heading: '6. PayPal anchor check',
      body: `PayPal order ${order.paypal_order_id}, capture ${order.paypal_capture_id}.\nOrder description at PayPal: ${unit.description ?? '(unread)'}\nRecorded chain head at purchase (step ${order.anchor_seq}): ${anchorEntry?.hash ?? '(missing)'}\nMatch: ${unit.description === `RCS-ANCHOR ${anchorEntry?.hash}` ? 'YES' : 'NO'}. custom_id = instructions hash: ${unit.custom_id === m.mandate_hash?.trim() ? 'YES' : 'NO'}. invoice_id = order ref: ${unit.invoice_id === order.order_ref ? 'YES' : 'NO'}.`,
    },
    { heading: '7. Shipping', body: `Tracker on the capture: ${order.tracker_id ?? 'none'}.` },
    { heading: '8. Decision', body: `Recourse decision ${ruling.id}: ${ruling.verdict}, approved by ${ruling.approved_by_name} at ${new Date(ruling.approved_at).toISOString()}. Decision document hash ${ruling.document_hash?.trim()}.` },
  ]);
}
