import { z } from 'zod';

/**
 * What the LLM must return. Kept provider-friendly (no regex, every field present, nulls instead
 * of optional) so the same schema works with Gemini, OpenAI and Anthropic structured output.
 * The strict rules are applied afterwards in code by MandateSpec.
 */
export const LlmMandate = z.object({
  category: z.string().describe("Short product category in lower case, e.g. 'running shoes'."),
  max_total: z
    .object({
      value: z.string().describe("Maximum total price as a decimal string, e.g. '120.00'."),
      currency: z.string().describe('ISO 4217 code, e.g. USD.'),
    })
    .describe('The most the buyer will pay in total.'),
  attributes: z
    .array(
      z.object({
        name: z.string().describe("Attribute name in lower case, e.g. 'size', 'gender', 'color', 'width'."),
        value: z.string().describe("The value exactly as meant, e.g. '10', 'men', 'blue'."),
        unit_system: z
          .string()
          .nullable()
          .describe("Measurement system for sizes and measures, e.g. 'US', 'UK', 'EU'. Null if the attribute is not a measure or the text does not say."),
      }),
    )
    .describe('Every product requirement other than category, price, brand, merchant, deadline and quantity.'),
  brands_allowed: z.array(z.string()).describe('Brands the buyer accepts. Empty list if the text does not restrict brands.'),
  merchants_allowed: z.array(z.string()).nullable().describe('Merchants the buyer accepts, or null if the text does not say.'),
  deadline: z.string().describe('Latest delivery date as YYYY-MM-DD.'),
  quantity: z.number().int().describe('How many units. 1 unless the text says otherwise.'),
});
export type LlmMandate = z.infer<typeof LlmMandate>;

const MEASURE_NAMES = /size|width|length|waist|inseam/i;
export const UNIT_SYSTEMS = ['US', 'UK', 'EU', 'JP', 'CM', 'MM', 'IN'];

/** The stored, signed mandate spec. Normalizes case and money format, then enforces the rules. */
export const MandateSpec = z
  .object({
    category: z.string().trim().toLowerCase().min(1),
    max_total: z.object({
      value: z
        .string()
        .trim()
        .regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal amount like 120.00')
        .transform((v) => Number(v).toFixed(2))
        .refine((v) => Number(v) > 0, 'must be more than 0'),
      currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 code'),
    }),
    attributes: z.array(
      z.object({
        name: z.string().trim().toLowerCase().min(1),
        value: z.string().trim().min(1),
        unit_system: z
          .string()
          .trim()
          .toUpperCase()
          .nullable()
          .transform((v) => (v === '' ? null : v)),
      }),
    ),
    brands_allowed: z.array(z.string().trim().min(1)),
    merchants_allowed: z
      .array(z.string().trim().min(1))
      .nullable()
      .optional()
      .transform((v) => (v && v.length ? v : undefined)),
    deadline: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date YYYY-MM-DD')
      .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'is not a real date'),
    quantity: z.number().int().min(1),
  })
  .superRefine((spec, ctx) => {
    spec.attributes.forEach((a, i) => {
      if (MEASURE_NAMES.test(a.name)) {
        if (!a.unit_system) {
          ctx.addIssue({
            code: 'custom',
            path: ['attributes', i, 'unit_system'],
            message: `${a.name} ${a.value} has no size system. Say which one, e.g. "US ${a.value}" or "UK ${a.value}".`,
          });
        } else if (!UNIT_SYSTEMS.includes(a.unit_system)) {
          ctx.addIssue({
            code: 'custom',
            path: ['attributes', i, 'unit_system'],
            message: `unknown size system ${a.unit_system}; expected one of ${UNIT_SYSTEMS.join(', ')}`,
          });
        }
      }
    });
    const today = new Date().toISOString().slice(0, 10);
    if (spec.deadline < today) {
      ctx.addIssue({ code: 'custom', path: ['deadline'], message: `deadline ${spec.deadline} is in the past (today is ${today})` });
    }
  });
export type MandateSpec = z.infer<typeof MandateSpec>;
