import type { LineAttrs, VariantView } from './catalog';

/**
 * Cart validation in the shape of PayPal's Store Sync Cart API (PayPalCart / ValidationIssue in
 * @paypal/agentic-commerce-spec v1.1.0). Business problems never become HTTP errors: they are listed
 * in validation_issues and the cart stays INCOMPLETE until they are resolved.
 */

export type RequestedItem = { variant_id: string; quantity: number };
type Money = { currency_code: string; value: string };
type Attrs = LineAttrs;

export type ValidationIssue = {
  code: 'INVENTORY_ISSUE' | 'DATA_ERROR';
  type: 'MISSING_FIELD' | 'INVALID_DATA' | 'BUSINESS_RULE';
  message: string;
  user_message?: string;
  item_id?: string;
  field?: string;
  context?: Record<string, unknown>;
  resolution_options?: Array<{ action: string; label: string; metadata?: Record<string, unknown> }>;
  /** Recourse extension: the variant the merchant proposes instead, with its structured data as the merchant has it. */
  suggested_substitute?: {
    variant_id: string;
    item_id: string;
    name: string;
    description: string;
    price: Money;
    attributes: Attrs;
    selected_attributes: Array<{ name: string; value: string }>;
  };
};

export type CartLine = {
  variant_id: string;
  item_id: string;
  name: string;
  quantity: number;
  price: Money;
  /** Store Sync name/value pairs; an attribute the merchant left out is simply absent. */
  selected_attributes: Array<{ name: string; value: string }>;
  /** Recourse extension: the structured attributes, with null where the merchant gave none. */
  attributes: Attrs;
  available: boolean;
};

export type CartState = {
  status: 'INCOMPLETE' | 'READY';
  validation_status: 'VALID' | 'INVALID';
  items: CartLine[];
  totals: { subtotal: Money; shipping: Money; tax: Money; total: Money };
  validation_issues: ValidationIssue[];
};

const attrsOf = (v: VariantView): Attrs => (v.stay ? { size: v.size, unit_system: v.unit_system, gender: v.gender, stay: v.stay } : { size: v.size, unit_system: v.unit_system, gender: v.gender });
const selected = (v: VariantView) =>
  (v.stay
    ? [
        { name: 'hotel', value: v.stay.hotel },
        v.stay.stars !== null ? { name: 'stars', value: String(v.stay.stars) } : null,
        { name: 'city', value: v.stay.city },
        { name: 'check_in', value: v.stay.check_in },
        { name: 'check_out', value: v.stay.check_out },
        { name: 'nights', value: String(v.stay.nights) },
        v.stay.refund_policy ? { name: 'refund_policy', value: v.stay.refund_policy } : null,
      ]
    : [
        v.size ? { name: 'size', value: v.size } : null,
        v.unit_system ? { name: 'unit_system', value: v.unit_system } : null,
        v.gender ? { name: 'gender', value: v.gender } : null,
      ]
  ).filter((a): a is { name: string; value: string } => a !== null);

/**
 * What this merchant offers when a variant can't be supplied: same listing, same size NUMBER, same
 * price, in stock, but a different (or missing) unit system. Deliberately naive, like a real
 * merchant's fallback: "10" with no unit system is not the same shoe as US 10, and the message text
 * below calls both of them "size 10".
 */
export function findSubstitute(wanted: VariantView, quantity: number, all: Iterable<VariantView>): VariantView | undefined {
  if (wanted.stay) {
    // A hotel's fallback: another rate of the same hotel for the same dates, no dearer, with rooms left.
    for (const v of all) {
      if (v.variant_id !== wanted.variant_id && v.stay && v.stay.hotel === wanted.stay.hotel && v.stay.check_in === wanted.stay.check_in && v.stay.check_out === wanted.stay.check_out && Number(v.price) <= Number(wanted.price) && v.stock >= quantity) return v;
    }
    return undefined;
  }
  for (const v of all) {
    if (
      v.variant_id !== wanted.variant_id &&
      v.listing_id === wanted.listing_id &&
      v.size === wanted.size &&
      v.unit_system !== wanted.unit_system &&
      v.price === wanted.price &&
      (v.gender === wanted.gender || v.gender === null) &&
      v.stock >= quantity
    ) {
      return v;
    }
  }
  return undefined;
}

export function computeCart(requested: RequestedItem[], variants: Map<string, VariantView>, currency: string): CartState {
  const issues: ValidationIssue[] = [];
  const lines: CartLine[] = [];
  let subtotalCents = 0;

  if (!requested.length) issues.push({ code: 'DATA_ERROR', type: 'MISSING_FIELD', field: 'items', message: 'Cart has no items.' });

  requested.forEach((item, i) => {
    const v = variants.get(item.variant_id);
    if (!v) {
      issues.push({
        code: 'DATA_ERROR',
        type: 'INVALID_DATA',
        field: `items[${i}].variant_id`,
        message: `Unknown variant_id ${item.variant_id}.`,
        context: { specific_issue: 'INVALID_ITEM', variant_id: item.variant_id },
      });
      return;
    }
    const available = v.stock >= item.quantity;
    lines.push({
      variant_id: v.variant_id,
      item_id: v.listing_id,
      name: v.name,
      quantity: item.quantity,
      price: { currency_code: v.currency, value: v.price },
      selected_attributes: selected(v),
      attributes: attrsOf(v),
      available,
    });
    if (available) {
      subtotalCents += Math.round(Number(v.price) * 100) * item.quantity;
      return;
    }
    const outOfStock = v.stock === 0;
    const sub = findSubstitute(v, item.quantity, variants.values());
    if (v.stay) {
      const dates = `${v.stay.check_in} to ${v.stay.check_out}`;
      const issue: ValidationIssue = {
        code: 'INVENTORY_ISSUE',
        type: 'BUSINESS_RULE',
        item_id: v.listing_id,
        field: `items[${i}]`,
        message: `${v.name} is sold out for ${dates}.${sub ? ` ${sub.name} is available for the same dates at ${sub.price}.` : ''}`,
        user_message: `Sorry, ${v.name} is sold out for these dates.${sub ? ` ${sub.name} is available instead.` : ''}`,
        context: {
          specific_issue: 'ITEM_OUT_OF_STOCK',
          item_id: v.listing_id,
          variant_id: v.variant_id,
          available_quantity: v.stock,
          requested_quantity: item.quantity,
          ...(sub ? { suggested_alternatives: [sub.variant_id] } : {}),
        },
        resolution_options: [
          ...(sub ? [{ action: 'SUGGEST_ALTERNATIVE', label: `Switch to ${sub.name}`, metadata: { cost_impact: (Number(sub.price) - Number(v.price)).toFixed(2), priority: 'HIGH', auto_applicable: true } }] : []),
          { action: 'REMOVE_ITEM', label: 'Remove this rate' },
        ],
      };
      if (sub) {
        issue.suggested_substitute = {
          variant_id: sub.variant_id,
          item_id: sub.listing_id,
          name: sub.name,
          description: sub.name,
          price: { currency_code: sub.currency, value: sub.price },
          attributes: attrsOf(sub),
          selected_attributes: selected(sub),
        };
      }
      issues.push(issue);
      return;
    }
    const issue: ValidationIssue = {
      code: 'INVENTORY_ISSUE',
      type: 'BUSINESS_RULE',
      item_id: v.listing_id,
      field: `items[${i}]`,
      message: outOfStock
        ? `${v.name}, size ${v.size}, is out of stock.${sub ? ` Size ${sub.size} is available at the same price.` : ''}`
        : `${v.name}, size ${v.size}: only ${v.stock} left, ${item.quantity} requested.`,
      user_message: outOfStock
        ? `Sorry, ${v.name} in size ${v.size} is sold out.${sub ? ` We have it in size ${sub.size}.` : ''}`
        : `Only ${v.stock} left of ${v.name} in size ${v.size}.`,
      context: {
        specific_issue: outOfStock ? 'ITEM_OUT_OF_STOCK' : 'INSUFFICIENT_INVENTORY',
        item_id: v.listing_id,
        variant_id: v.variant_id,
        available_quantity: v.stock,
        requested_quantity: item.quantity,
        ...(sub ? { suggested_alternatives: [sub.variant_id] } : {}),
      },
      resolution_options: [
        ...(sub
          ? [{ action: 'SUGGEST_ALTERNATIVE', label: `Switch to size ${sub.size}`, metadata: { cost_impact: '0.00', priority: 'HIGH', auto_applicable: true } }]
          : []),
        { action: 'REMOVE_ITEM', label: 'Remove this item' },
      ],
    };
    if (sub) {
      issue.suggested_substitute = {
        variant_id: sub.variant_id,
        item_id: sub.listing_id,
        name: sub.name,
        description: `size ${sub.size}`,
        price: { currency_code: sub.currency, value: sub.price },
        attributes: attrsOf(sub),
        selected_attributes: selected(sub),
      };
    }
    issues.push(issue);
  });

  // The demo merchant charges no shipping or tax, so total = subtotal (mandate budgets include both).
  const money = (cents: number): Money => ({ currency_code: currency, value: (cents / 100).toFixed(2) });
  const ready = issues.length === 0;
  return {
    status: ready ? 'READY' : 'INCOMPLETE',
    validation_status: ready ? 'VALID' : 'INVALID',
    items: lines,
    totals: { subtotal: money(subtotalCents), shipping: money(0), tax: money(0), total: money(subtotalCents) },
    validation_issues: issues,
  };
}
