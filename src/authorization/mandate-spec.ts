import { z } from 'zod';

/**
 * What the LLM must return when it compiles plain English. Provider-friendly on purpose (no regex,
 * every field present, null for "not stated") so one schema works with Gemini, OpenAI and Anthropic
 * structured output. The rules are enforced afterwards, in code, by MandateSpec.
 */
export const LlmMandate = z.object({
  category: z.string().describe("Short product category in lower case, e.g. 'running shoes'."),
  max_total: z
    .object({
      value: z.string().describe("Decimal string, e.g. '120.00'."),
      currency: z.string().describe('ISO 4217 code, e.g. USD.'),
    })
    .describe('The most the buyer will pay in TOTAL across all orders under this mandate, including tax and shipping.'),
  attributes: z
    .array(
      z.object({
        name: z.string().describe("Attribute name in lower case, e.g. 'size', 'color', 'width'."),
        value: z.string().describe("The value as written, e.g. '10', 'blue'."),
        unit_system: z
          .string()
          .nullable()
          .describe("Measurement system for sizes and measures exactly as written: 'US', 'UK' or 'EU'. Null if not a measure or not stated. Never convert."),
        gender: z.string().nullable().describe("'men', 'women' or 'kids' when the text ties the attribute to one (\"US men's 10\"), else null."),
      }),
    )
    .describe('Every product requirement other than category, price, brand, merchant, quantity and dates.'),
  brands_allowed: z.array(z.string()).describe('Brands the buyer accepts. Empty list if any brand is fine.'),
  merchants_allowed: z.array(z.string()).nullable().describe('Merchants the buyer accepts, or null if not stated.'),
  quantity: z.number().int().describe('Units to buy. 1 unless stated.'),
  max_orders: z.number().int().nullable().describe('How many separate orders the agent may place. Null if not stated.'),
  allow_substitutions: z.boolean().nullable().describe('True only if the text explicitly allows substitutes. Null if not stated.'),
  allow_split_orders: z.boolean().nullable().describe('True only if the text explicitly allows splitting the purchase. Null if not stated.'),
  deadline: z.string().describe('Latest delivery date, YYYY-MM-DD. For a hotel stay: the check-in date.'),
  stay: z
    .object({
      city: z.string().describe('City of the stay, as written, e.g. "Lisbon".'),
      check_in: z.string().describe('Check-in date, YYYY-MM-DD.'),
      check_out: z.string().describe('Check-out date, YYYY-MM-DD.'),
      nights: z.number().int().nullable().describe('Number of nights if stated, else null.'),
      min_stars: z.number().int().nullable().describe('Minimum hotel stars if stated ("4 stars or more" gives 4), else null.'),
      refund_policy: z
        .string()
        .nullable()
        .describe("'REFUNDABLE' only if the text requires a refundable or free-cancellation rate; else null."),
    })
    .nullable()
    .describe('Only for a hotel or other overnight stay; null for anything else.'),
  expires_at: z.string().nullable().describe('When the authority to buy ends, ISO 8601 date-time in UTC, only if the text says. Else null.'),
});
export type LlmMandate = z.infer<typeof LlmMandate>;

const MEASURE = /size|width|length|waist|inseam/i;
export const UNIT_SYSTEMS = ['US', 'UK', 'EU'] as const;
const GENDERS = ['men', 'women', 'kids', 'unisex'];

const Money = z.object({
  value: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal amount like 120.00')
    .transform((v) => Number(v).toFixed(2))
    .refine((v) => Number(v) > 0, 'must be more than 0'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 code'),
});

const isoDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

/**
 * The stored, signed mandate. Applies defaults (max_orders 1, no substitutions, no split orders,
 * expires_at = end of the deadline day UTC), normalizes case and money, then enforces the rules.
 * Anything that fails is rejected; nothing is guessed.
 */
export const MandateSpec = z
  .object({
    category: z.string().trim().toLowerCase().min(1),
    max_total: Money,
    attributes: z.array(
      z.object({
        name: z.string().trim().toLowerCase().min(1),
        value: z.string().trim().min(1),
        unit_system: z
          .string()
          .trim()
          .toUpperCase()
          .nullable()
          .transform((v) => (v ? v : null)),
        gender: z
          .string()
          .trim()
          .toLowerCase()
          .nullish()
          .transform((v) => (v ? v : undefined)),
      }),
    ),
    brands_allowed: z.array(z.string().trim().min(1)),
    merchants_allowed: z
      .array(z.string().trim().min(1))
      .nullish()
      .transform((v) => (v && v.length ? v : undefined)),
    quantity: z.number().int().min(1).max(100),
    max_orders: z
      .number()
      .int()
      .nullish()
      .transform((v) => v ?? 1)
      .pipe(z.number().int().min(1).max(20)),
    allow_substitutions: z.boolean().nullish().transform((v) => v ?? false),
    allow_split_orders: z.boolean().nullish().transform((v) => v ?? false),
    deadline: z.string().trim().refine(isoDate, 'must be a real date as YYYY-MM-DD'),
    expires_at: z.string().trim().nullish(),
    stay: z
      .object({
        city: z.string().trim().min(1),
        check_in: z.string().trim().refine(isoDate, 'check_in must be a real date as YYYY-MM-DD'),
        check_out: z.string().trim().refine(isoDate, 'check_out must be a real date as YYYY-MM-DD'),
        nights: z.number().int().min(1).nullish(),
        min_stars: z.number().int().min(1).max(5).nullish().transform((v) => v ?? null),
        refund_policy: z
          .string()
          .trim()
          .toUpperCase()
          .nullish()
          .transform((v) => (v ? v : null))
          .pipe(z.enum(['REFUNDABLE']).nullable()),
      })
      .superRefine((st, ctx) => {
        const nights = Math.round((Date.parse(st.check_out) - Date.parse(st.check_in)) / 864e5);
        if (!(nights >= 1)) ctx.addIssue({ code: 'custom', path: ['check_out'], message: 'check-out must be after check-in' });
        else if (st.nights && st.nights !== nights) ctx.addIssue({ code: 'custom', path: ['nights'], message: `${st.nights} nights does not match the dates (${nights} nights)` });
      })
      .nullish()
      .transform((v) => v ?? undefined),
  })
  .transform((spec) => {
    // A stay's nights follow from its dates; its deadline is the check-in date.
    const stay = spec.stay ? { ...spec.stay, nights: Math.round((Date.parse(spec.stay.check_out) - Date.parse(spec.stay.check_in)) / 864e5) } : undefined;
    const deadline = stay ? stay.check_in : spec.deadline;
    const { stay: _drop, ...rest } = spec;
    void _drop;
    return {
      ...rest,
      deadline,
      ...(stay ? { stay } : {}),
      expires_at: spec.expires_at ? new Date(spec.expires_at).toISOString() : `${deadline}T23:59:59.000Z`,
    };
  })
  .superRefine((spec, ctx) => {
    spec.attributes.forEach((a, i) => {
      if (MEASURE.test(a.name)) {
        if (!a.unit_system) {
          ctx.addIssue({
            code: 'custom',
            path: ['attributes', i, 'unit_system'],
            message: `${a.name} ${a.value} has no size system. Say which one, e.g. "US ${a.value}" or "UK ${a.value}".`,
          });
        } else if (!(UNIT_SYSTEMS as readonly string[]).includes(a.unit_system)) {
          ctx.addIssue({ code: 'custom', path: ['attributes', i, 'unit_system'], message: `unknown size system ${a.unit_system}; use US, UK or EU` });
        }
      }
      if (a.gender && !GENDERS.includes(a.gender)) {
        ctx.addIssue({ code: 'custom', path: ['attributes', i, 'gender'], message: `gender must be one of ${GENDERS.join(', ')}` });
      }
    });
    const today = new Date().toISOString().slice(0, 10);
    if (spec.deadline < today) {
      ctx.addIssue({ code: 'custom', path: ['deadline'], message: `deadline ${spec.deadline} is in the past (today is ${today} UTC)` });
    }
    if (Number.isNaN(Date.parse(spec.expires_at))) {
      ctx.addIssue({ code: 'custom', path: ['expires_at'], message: 'expires_at is not a valid ISO 8601 date-time' });
    } else if (Date.parse(spec.expires_at) <= Date.now()) {
      ctx.addIssue({ code: 'custom', path: ['expires_at'], message: 'expires_at is in the past' });
    }
  });
export type MandateSpec = z.output<typeof MandateSpec>;
