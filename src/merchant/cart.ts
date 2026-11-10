import type { VariantView } from './catalog';

/**
 * Cart validation in the shape of PayPal's Store Sync Cart API (PayPalCart / ValidationIssue from
 * @paypal/agentic-commerce-spec v1.1.0). Business problems never become HTTP errors: they are listed
 * in validation_issues and the cart is INCOMPLETE until they are resolved.
 */

export type RequestedItem = { variant_id: string; quantity: number };

type Money = { currency_code: string; value: string };

export type ValidationIssue = {
  code: 'INVENTORY_ISSUE' | 'DATA_ERROR';
  type: 'MISSING_FIELD' | 'INVALID_DATA' | 'BUSINESS_RULE';
  message: string;
  user_message?: string;
  item_id?: string;
  field?: string;
  context?: Record<string, unknown>;
  resolution_options?: Array<{ action: string; label: string; metadata?: Record<string, unknown> }>;
  /** Recourse extension: the variant the merchant proposes instead. */
  suggested_substitute?: {
    variant_id: string;
    item_id: string;
    name: string;
    description: string;
    price: Money;
    selected_attributes: Array<{ name: string; value: string }>;
  };
};

export type CartLine = {
  variant_id: string;
  item_id: string;
  name: string;
  quantity: number;
  price: Money;
  selected_attributes: Array<{ name: string; value: string }>;
  /** Recourse extension: false when the line can't be bought as is (out of stock or not enough). */
  available: boolean;
};

export type CartState = {
  status: 'INCOMPLETE' | 'READY';
  validation_status: 'VALID' | 'INVALID';
  items: CartLine[];
  totals: { subtotal: Money; shipping: Money; tax: Money; total: Money };
  validation_issues: ValidationIssue[];
};

const attrs = (v: VariantView) => [
  { name: 'size_system', value: v.size_system },
  { name: 'size', value: v.size },
];

/**
 * What the merchant offers when a variant is out of stock: the same model, the same size number,
 * the same price, in stock, in any size system. This is deliberately naive: US 10 and UK 10 share
 * the number but are different shoes, and the message text below calls both of them "size 10".
 */
export function findSubstitute(wanted: VariantView, quantity: number, all: Iterable<VariantView>): VariantView | undefined {
  for (const v of all) {
    if (
      v.variant_id !== wanted.variant_id &&
      v.product_id === wanted.product_id &&
      v.size === wanted.size &&
      v.price === wanted.price &&
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

  if (!requested.length) {
    issues.push({ code: 'DATA_ERROR', type: 'MISSING_FIELD', field: 'items', message: 'Cart has no items.' });
  }

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
      item_id: v.product_id,
      name: v.name,
      quantity: item.quantity,
      price: { currency_code: v.currency, value: v.price },
      selected_attributes: attrs(v),
      available,
    });
    if (available) {
      subtotalCents += Math.round(Number(v.price) * 100) * item.quantity;
      return;
    }

    const outOfStock = v.stock === 0;
    const sub = findSubstitute(v, item.quantity, variants.values());
    const issue: ValidationIssue = {
      code: 'INVENTORY_ISSUE',
      type: 'BUSINESS_RULE',
      item_id: v.product_id,
      field: `items[${i}]`,
      message: outOfStock
        ? `${v.name}, size ${v.size}, is out of stock.${sub ? ` Size ${sub.size} is available at the same price.` : ''}`
        : `${v.name}, size ${v.size}: only ${v.stock} left, ${item.quantity} requested.`,
      user_message: outOfStock
        ? `Sorry, ${v.name} in size ${v.size} is sold out.${sub ? ` We have it in size ${sub.size}.` : ''}`
        : `Only ${v.stock} left of ${v.name} in size ${v.size}.`,
      context: {
        specific_issue: outOfStock ? 'ITEM_OUT_OF_STOCK' : 'INSUFFICIENT_INVENTORY',
        item_id: v.product_id,
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
        item_id: sub.product_id,
        name: sub.name,
        description: `size ${sub.size}`,
        price: { currency_code: sub.currency, value: sub.price },
        selected_attributes: attrs(sub),
      };
    }
    issues.push(issue);
  });

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
