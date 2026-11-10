// Writes postman/recourse.postman_collection.json (Postman v2.1): one folder per phase.
// Phase 0 holds every PayPal sandbox call the probes make; Phases 1 and 2 call the Recourse API.
// Run: npm run postman
import { mkdirSync, writeFileSync } from 'node:fs';

type Req = {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  form?: Array<{ key: string; value: string; contentType?: string }>;
  headers?: Record<string, string>;
  auth?: 'basic' | 'inherit';
  test?: string[];
  prerequest?: string[];
  description?: string;
  /** Calls the Recourse API ({{app_base_url}}, no auth) instead of PayPal. */
  app?: boolean;
};

const json = (o: unknown) => JSON.stringify(o, null, 2);
const ccy = '{{currency}}';

const save = (varName: string, expr: string) =>
  `if (pm.response.code < 300) { const v = ${expr}; if (v) pm.collectionVariables.set('${varName}', v); }`;

const assertion = [
  "const b64 = (o) => CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(JSON.stringify(o))).replace(/=+$/, '').replace(/\\+/g, '-').replace(/\\//g, '_');",
  "pm.collectionVariables.set('auth_assertion', b64({alg:'none',typ:'JWT'}) + '.' + b64({iss: pm.collectionVariables.get('client_id'), email: pm.collectionVariables.get('buyer_email')}) + '.');",
];

const mandateHash = (prefix: string) => [
  "const mandate = JSON.stringify({kind:'recourse.test-mandate', created:new Date().toISOString(), amount:{currency_code:pm.collectionVariables.get('currency'), value:'25.00'}});",
  `pm.collectionVariables.set('${prefix}custom_id', CryptoJS.SHA256(mandate).toString());`,
  `pm.collectionVariables.set('${prefix}invoice_ref', 'RCS-TEST-' + Date.now());`,
  "pm.collectionVariables.set('request_id', pm.variables.replaceIn('{{$guid}}'));",
];

const orderBody = (vaultVar: string, prefix: string) => ({
  intent: 'CAPTURE',
  purchase_units: [
    {
      reference_id: 'default',
      description: 'Recourse: agent checkout, payer not present',
      custom_id: `{{${prefix}custom_id}}`,
      invoice_id: `{{${prefix}invoice_ref}}`,
      amount: { currency_code: ccy, value: '25.00' },
    },
  ],
  payment_source: { paypal: { vault_id: `{{${vaultVar}}}` } },
});

const saveOrder = (prefix: string) => [
  save(`${prefix}order_id`, 'pm.response.json().id'),
  save(`${prefix}capture_id`, "(((pm.response.json().purchase_units||[])[0]||{}).payments||{captures:[]}).captures?.[0]?.id"),
];

const folders: Array<{ name: string; description: string; items: Req[] }> = [
  {
    name: '1 Auth',
    description: 'Probe 1. Sets {{access_token}} for every other request.',
    items: [
      {
        name: 'Get access token',
        method: 'POST',
        path: '/v1/oauth2/token',
        auth: 'basic',
        form: [{ key: 'grant_type', value: 'client_credentials' }],
        test: [save('access_token', 'pm.response.json().access_token')],
      },
    ],
  },
  {
    name: '2 Vault v3',
    description: 'Probe 2 (buyer) and probe 8 step 1 (operator: approve as the operator sandbox account, then copy vault_id into operator_vault_id).',
    items: [
      {
        name: 'Create setup token (PayPal)',
        method: 'POST',
        path: '/v3/vault/setup-tokens',
        headers: { 'PayPal-Request-Id': '{{$guid}}' },
        body: {
          payment_source: {
            paypal: {
              description: 'Recourse: saved PayPal for agent checkout',
              usage_pattern: 'IMMEDIATE',
              usage_type: 'MERCHANT',
              customer_type: 'CONSUMER',
              permit_multiple_payment_tokens: false,
              experience_context: { brand_name: 'Recourse', return_url: '{{return_url}}', cancel_url: '{{cancel_url}}' },
            },
          },
        },
        test: [
          save('setup_token_id', 'pm.response.json().id'),
          "console.log('approve:', (pm.response.json().links||[]).find(l => l.rel === 'approve')?.href);",
        ],
      },
      { name: 'Get setup token', method: 'GET', path: '/v3/vault/setup-tokens/{{setup_token_id}}' },
      {
        name: 'Create payment token (from setup token)',
        method: 'POST',
        path: '/v3/vault/payment-tokens',
        headers: { 'PayPal-Request-Id': '{{$guid}}' },
        body: { payment_source: { token: { id: '{{setup_token_id}}', type: 'SETUP_TOKEN' } } },
        test: [save('vault_id', 'pm.response.json().id'), save('customer_id', 'pm.response.json().customer?.id')],
      },
      { name: 'Get payment token', method: 'GET', path: '/v3/vault/payment-tokens/{{vault_id}}' },
      { name: 'List customer payment tokens', method: 'GET', path: '/v3/vault/payment-tokens?customer_id={{customer_id}}' },
      {
        name: 'Fallback: create setup token (sandbox card)',
        method: 'POST',
        path: '/v3/vault/setup-tokens',
        headers: { 'PayPal-Request-Id': '{{$guid}}' },
        body: {
          payment_source: {
            card: {
              name: 'Sandbox Tester',
              number: '4111111111111111',
              expiry: '2030-12',
              security_code: '123',
              verification_method: 'SCA_WHEN_REQUIRED',
              billing_address: { address_line_1: '1 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' },
            },
          },
        },
        test: [save('setup_token_id', 'pm.response.json().id')],
      },
    ],
  },
  {
    name: '3 Orders v2 (vault, payer not present)',
    description: 'Probe 3. custom_id is the sha256 hex of a stand-in mandate, set by the pre-request script.',
    items: [
      {
        name: 'Create order with vault_id',
        method: 'POST',
        path: '/v2/checkout/orders',
        headers: { 'PayPal-Request-Id': '{{request_id}}', Prefer: 'return=representation' },
        prerequest: mandateHash(''),
        body: orderBody('vault_id', ''),
        test: saveOrder(''),
      },
      {
        name: 'Capture order (only if not already COMPLETED)',
        method: 'POST',
        path: '/v2/checkout/orders/{{order_id}}/capture',
        headers: { 'PayPal-Request-Id': '{{$guid}}', Prefer: 'return=representation' },
        body: {},
        test: saveOrder(''),
      },
      {
        name: 'Get order (check custom_id)',
        method: 'GET',
        path: '/v2/checkout/orders/{{order_id}}',
        test: [
          "const pu = (pm.response.json().purchase_units||[])[0]||{};",
          "console.log('custom_id sent:', pm.collectionVariables.get('custom_id'), 'returned:', pu.custom_id, pu.custom_id === pm.collectionVariables.get('custom_id') ? 'MATCH' : 'MISMATCH');",
        ],
      },
      { name: 'Get capture', method: 'GET', path: '/v2/payments/captures/{{capture_id}}' },
      {
        name: 'Fallback: save PayPal with purchase (store_in_vault)',
        method: 'POST',
        path: '/v2/checkout/orders',
        headers: { 'PayPal-Request-Id': '{{$guid}}', Prefer: 'return=representation' },
        body: {
          intent: 'CAPTURE',
          purchase_units: [{ reference_id: 'default', amount: { currency_code: ccy, value: '10.00' } }],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: 'Recourse',
                shipping_preference: 'NO_SHIPPING',
                user_action: 'PAY_NOW',
                return_url: '{{return_url}}',
                cancel_url: '{{cancel_url}}',
              },
              attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' } },
            },
          },
        },
        test: [save('order_id', 'pm.response.json().id')],
        description: 'Approve via the payer-action link, then run Capture order; the vault id is in payment_source.paypal.attributes.vault.id.',
      },
      {
        name: 'Fallback: buyer-present order (no vault)',
        method: 'POST',
        path: '/v2/checkout/orders',
        headers: { 'PayPal-Request-Id': '{{request_id}}', Prefer: 'return=representation' },
        prerequest: mandateHash(''),
        body: {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: 'default',
              custom_id: '{{custom_id}}',
              invoice_id: '{{invoice_ref}}',
              amount: { currency_code: ccy, value: '25.00' },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: 'Recourse',
                shipping_preference: 'NO_SHIPPING',
                user_action: 'PAY_NOW',
                return_url: '{{return_url}}',
                cancel_url: '{{cancel_url}}',
              },
            },
          },
        },
        test: [save('order_id', 'pm.response.json().id')],
        description: 'Approve via the payer-action link, then run Capture order.',
      },
    ],
  },
  {
    name: '4 Disputes',
    description: 'Probe 4. Create is sandbox only and acts as the buyer through an unsigned PayPal-Auth-Assertion JWT; without buyer consent it returns 400 "No permissions to set target_client_id" (see docs/phase0-findings.md). require-evidence and adjudicate are sandbox only and were not offered on a Resolution Center dispute.',
    items: [
      {
        name: 'Create dispute (sandbox, as buyer)',
        method: 'POST',
        path: '/v1/customer/disputes',
        prerequest: assertion,
        headers: { 'PayPal-Auth-Assertion': '{{auth_assertion}}' },
        form: [
          {
            key: 'input',
            contentType: 'application/json',
            value: json({
              disputed_transactions: [{ buyer_transaction_id: '{{capture_id}}' }],
              reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
              dispute_amount: { currency_code: ccy, value: '25.00' },
              extensions: { merchant_contacted: false, merchandize_dispute_properties: { issue_type: 'PRODUCT' } },
            }),
          },
        ],
        test: [save('dispute_id', "(pm.response.json().links||[]).find(l => l.rel === 'self')?.href.split('/').pop()")],
      },
      { name: 'List disputes', method: 'GET', path: '/v1/customer/disputes?page_size=50' },
      {
        name: 'Get dispute (status + links)',
        method: 'GET',
        path: '/v1/customer/disputes/{{dispute_id}}',
        test: ["const d = pm.response.json(); console.log(d.status, (d.links||[]).map(l => l.rel).join(', '));"],
      },
      {
        name: 'Accept claim',
        method: 'POST',
        path: '/v1/customer/disputes/{{dispute_id}}/accept-claim',
        body: { note: 'Recourse: accepting claim.' },
      },
      {
        name: 'Provide evidence (multipart)',
        method: 'POST',
        path: '/v1/customer/disputes/{{dispute_id}}/provide-evidence',
        form: [
          {
            key: 'input',
            contentType: 'application/json',
            value: json({ evidences: [{ evidence_type: 'ITEM_DESCRIPTION', notes: 'Signed mandate and receipt attached.' }] }),
          },
        ],
        description: 'Add a file part named evidence-file (PDF/PNG/JPG/GIF) in the Body tab.',
      },
      {
        name: 'Make offer',
        method: 'POST',
        path: '/v1/customer/disputes/{{dispute_id}}/make-offer',
        body: { note: 'Recourse: partial refund offer.', offer_amount: { currency_code: ccy, value: '5.00' }, offer_type: 'REFUND' },
      },
      {
        name: 'Send message',
        method: 'POST',
        path: '/v1/customer/disputes/{{dispute_id}}/send-message',
        body: { message: 'Recourse message.' },
      },
      {
        name: 'Escalate (as buyer)',
        method: 'POST',
        path: '/v1/customer/disputes/{{dispute_id}}/escalate',
        prerequest: assertion,
        headers: { 'PayPal-Auth-Assertion': '{{auth_assertion}}' },
        body: { note: 'Recourse: escalating to claim.' },
      },
      {
        name: 'Require evidence (sandbox only)',
        method: 'POST',
        path: '/v1/customer/disputes/{{dispute_id}}/require-evidence',
        body: { action: 'SELLER_EVIDENCE' },
      },
      {
        name: 'Adjudicate (sandbox only)',
        method: 'POST',
        path: '/v1/customer/disputes/{{dispute_id}}/adjudicate',
        body: { adjudication_outcome: 'BUYER_FAVOR' },
      },
    ],
  },
  {
    name: '5 Webhooks',
    description: 'Probe 5. Event types: CUSTOMER.DISPUTE.CREATED, CUSTOMER.DISPUTE.UPDATED, INVOICING.INVOICE.PAID, PAYMENT.CAPTURE.REFUNDED.',
    items: [
      { name: 'List event types', method: 'GET', path: '/v1/notifications/webhooks-event-types' },
      { name: 'List webhooks', method: 'GET', path: '/v1/notifications/webhooks' },
      {
        name: 'Create webhook',
        method: 'POST',
        path: '/v1/notifications/webhooks',
        body: {
          url: '{{webhook_url}}',
          event_types: [
            { name: 'CUSTOMER.DISPUTE.CREATED' },
            { name: 'CUSTOMER.DISPUTE.UPDATED' },
            { name: 'INVOICING.INVOICE.PAID' },
            { name: 'PAYMENT.CAPTURE.REFUNDED' },
          ],
        },
        test: [save('webhook_id', 'pm.response.json().id')],
      },
      {
        name: 'Verify webhook signature',
        method: 'POST',
        path: '/v1/notifications/verify-webhook-signature',
        body: {
          auth_algo: '<paypal-auth-algo header>',
          cert_url: '<paypal-cert-url header>',
          transmission_id: '<paypal-transmission-id header>',
          transmission_sig: '<paypal-transmission-sig header>',
          transmission_time: '<paypal-transmission-time header>',
          webhook_id: '{{webhook_id}}',
          webhook_event: { replace: 'with the event body exactly as received' },
        },
      },
      {
        name: 'Simulate event',
        method: 'POST',
        path: '/v1/notifications/simulate-event',
        body: { webhook_id: '{{webhook_id}}', event_type: 'CUSTOMER.DISPUTE.CREATED' },
      },
    ],
  },
  {
    name: '6 Invoicing v2',
    description: 'Probe 6. Invoice from the merchant to the agent operator.',
    items: [
      {
        name: 'Generate next invoice number',
        method: 'POST',
        path: '/v2/invoicing/generate-next-invoice-number',
        test: [save('invoice_number', 'pm.response.json().invoice_number')],
      },
      {
        name: 'Create invoice',
        method: 'POST',
        path: '/v2/invoicing/invoices',
        headers: { Prefer: 'return=representation' },
        body: {
          detail: {
            invoice_number: '{{invoice_number}}',
            reference: 'RCS-CASE-TEST',
            currency_code: ccy,
            note: 'Recourse ruling: agent fault. Reimbursement of the buyer refund.',
            payment_term: { term_type: 'DUE_ON_RECEIPT' },
          },
          invoicer: { business_name: 'Recourse sandbox merchant' },
          primary_recipients: [{ billing_info: { email_address: '{{operator_email}}' } }],
          items: [
            { name: 'Agent fault liability', quantity: '1', unit_amount: { currency_code: ccy, value: '25.00' }, unit_of_measure: 'AMOUNT' },
          ],
        },
        test: [save('invoice_id', "pm.response.json().id || (pm.response.json().href||'').split('/').pop()")],
      },
      {
        name: 'Send invoice',
        method: 'POST',
        path: '/v2/invoicing/invoices/{{invoice_id}}/send',
        body: { send_to_invoicer: false, send_to_recipient: true, subject: 'Recourse: agent fault liability invoice (sandbox)' },
      },
      { name: 'Get invoice', method: 'GET', path: '/v2/invoicing/invoices/{{invoice_id}}' },
    ],
  },
  {
    name: '7 Refunds',
    description: 'Probe 7. Partial refund of a capture.',
    items: [
      {
        name: 'Refund capture (partial)',
        method: 'POST',
        path: '/v2/payments/captures/{{capture_id}}/refund',
        headers: { 'PayPal-Request-Id': '{{$guid}}', Prefer: 'return=representation' },
        body: { amount: { currency_code: ccy, value: '5.00' }, note_to_payer: 'Recourse: partial refund.' },
        test: [save('refund_id', 'pm.response.json().id')],
      },
      { name: 'Get refund', method: 'GET', path: '/v2/payments/refunds/{{refund_id}}' },
    ],
  },
  {
    name: '8 Operator liability charge',
    description: 'Probe 8. Vault the operator with folder 2 (approve as the operator), set operator_vault_id, then charge it here.',
    items: [
      {
        name: 'Charge operator vault_id (payer not present)',
        method: 'POST',
        path: '/v2/checkout/orders',
        headers: { 'PayPal-Request-Id': '{{request_id}}', Prefer: 'return=representation' },
        prerequest: mandateHash('operator_'),
        body: orderBody('operator_vault_id', 'operator_'),
        test: saveOrder('operator_'),
      },
      {
        name: 'Capture operator order (only if not already COMPLETED)',
        method: 'POST',
        path: '/v2/checkout/orders/{{operator_order_id}}/capture',
        headers: { 'PayPal-Request-Id': '{{$guid}}', Prefer: 'return=representation' },
        body: {},
        test: saveOrder('operator_'),
      },
      { name: 'Get operator order', method: 'GET', path: '/v2/checkout/orders/{{operator_order_id}}' },
    ],
  },
];


// ---------- Phase 1 and 2: the Recourse API ----------

const expectStatus = (code: number) => `pm.test('HTTP ${code}', () => pm.response.to.have.status(${code}));`;

const phase1: Array<{ name: string; description: string; items: Req[] }> = [
  {
    name: '1.0 Service',
    description: 'Start the API with npm run dev. app_base_url defaults to http://localhost:3000.',
    items: [
      { app: true, name: 'Health', method: 'GET', path: '/health', test: [expectStatus(200)] },
      {
        app: true,
        name: 'Signing public key',
        method: 'GET',
        path: '/.well-known/recourse-signing-key',
        test: [expectStatus(200), "pm.test('Ed25519 key id', () => pm.expect(pm.response.json().key_id).to.match(/^ed25519:/));"],
      },
    ],
  },
  {
    name: '1.1 Mandates',
    description: 'Create from plain English (LLM), approve with PayPal Vault, then check the signature.',
    items: [
      {
        app: true,
        name: 'Create mandate',
        method: 'POST',
        path: '/mandates',
        body: { buyer_email: '{{buyer_email}}', text: "Running shoes, US men's 10, under $120, Nike or Asics, delivered by Friday" },
        test: [
          expectStatus(201),
          "const m = pm.response.json(); pm.collectionVariables.set('mandate_id', m.id);",
          "pm.test('DRAFT', () => pm.expect(m.status).to.eql('DRAFT'));",
          "pm.test('size keeps its system', () => pm.expect(m.spec.attributes.find(a => a.name === 'size').unit_system).to.eql('US'));",
          "pm.test('max_total 120.00 USD', () => pm.expect(m.spec.max_total).to.eql({ value: '120.00', currency: 'USD' }));",
        ],
      },
      {
        app: true,
        name: 'Create mandate: size without a system (expect 422)',
        method: 'POST',
        path: '/mandates',
        body: { buyer_email: '{{buyer_email}}', text: 'Running shoes, size 10, under $120, by Friday' },
        test: [expectStatus(422), "pm.test('MANDATE_UNCLEAR', () => pm.expect(pm.response.json().name).to.eql('MANDATE_UNCLEAR'));"],
      },
      {
        app: true,
        name: 'Get mandate (signature_valid)',
        method: 'GET',
        path: '/mandates/{{mandate_id}}',
        test: [expectStatus(200), "const m = pm.response.json(); console.log(m.status, 'signature_valid', m.signature_valid, m.signature_check.reason);"],
      },
      {
        app: true,
        name: 'Approve mandate (returns PayPal approve_url)',
        method: 'POST',
        path: '/mandates/{{mandate_id}}/approve',
        test: [
          expectStatus(200),
          "const r = pm.response.json(); pm.collectionVariables.set('mandate_approve_url', r.approve_url); console.log('Open as the BUYER:', r.approve_url);",
        ],
        description: 'Open approve_url in a browser as the buyer sandbox account. PayPal redirects to /mandates/{id}/vault-return, which signs the mandate and makes it ACTIVE.',
      },
      {
        app: true,
        name: 'Vault return (PayPal calls this in the browser; manual retry only)',
        method: 'GET',
        path: '/mandates/{{mandate_id}}/vault-return',
        test: [expectStatus(200)],
      },
    ],
  },
  {
    name: '1.2 Operators and agents',
    description: 'Operator pre-authorizes liability payments (default limit 200.00 USD); agents belong to an operator.',
    items: [
      {
        app: true,
        name: 'Create operator',
        method: 'POST',
        path: '/operators',
        body: { name: 'Acme Shopping Agents', email: '{{operator_email}}' },
        test: [
          expectStatus(201),
          "const o = pm.response.json(); pm.collectionVariables.set('operator_id', o.id);",
          "pm.test('default limit 200.00 USD', () => pm.expect(o.liability_limit).to.eql({ value: '200.00', currency: 'USD' }));",
        ],
      },
      {
        app: true,
        name: 'Approve operator (returns PayPal approve_url)',
        method: 'POST',
        path: '/operators/{{operator_id}}/approve',
        test: [expectStatus(200), "console.log('Open as the OPERATOR:', pm.response.json().approve_url);"],
      },
      {
        app: true,
        name: 'Get operator',
        method: 'GET',
        path: '/operators/{{operator_id}}',
        test: [expectStatus(200), "const o = pm.response.json(); console.log(o.status, o.operator_vault_id);"],
      },
      {
        app: true,
        name: 'Create agent',
        method: 'POST',
        path: '/agents',
        body: { operator_id: '{{operator_id}}', name: 'ShopBot', version: '1.0.0' },
        test: [expectStatus(201), "pm.collectionVariables.set('agent_id', pm.response.json().id);"],
      },
      { app: true, name: 'Get agent', method: 'GET', path: '/agents/{{agent_id}}', test: [expectStatus(200)] },
    ],
  },
];

const phase2: Array<{ name: string; description: string; items: Req[] }> = [
  {
    name: '2.1 Merchant cart (Stride & Co)',
    description: 'Shaped like PayPal Store Sync Cart API. Business problems come back as validation_issues on a 2xx cart. Run npm run seed first.',
    items: [
      {
        app: true,
        name: 'Create cart: Pegasus 41 US 10 (out of stock)',
        method: 'POST',
        path: '/merchant-cart',
        body: { items: [{ variant_id: 'nike-pegasus-41-us-10', quantity: 1 }] },
        test: [
          expectStatus(201),
          "const c = pm.response.json(); pm.collectionVariables.set('cart_id', c.id);",
          "const i = c.validation_issues[0];",
          "pm.test('INCOMPLETE', () => pm.expect(c.status).to.eql('INCOMPLETE'));",
          "pm.test('ITEM_OUT_OF_STOCK', () => pm.expect(i.context.specific_issue).to.eql('ITEM_OUT_OF_STOCK'));",
          "pm.test('substitute is the UK 10', () => pm.expect(i.suggested_substitute.variant_id).to.eql('nike-pegasus-41-uk-10'));",
          "pm.test('message only says size 10', () => pm.expect(i.message).to.not.match(/US|UK/));",
          'console.log(i.message);',
        ],
      },
      { app: true, name: 'Get cart', method: 'GET', path: '/merchant-cart/{{cart_id}}', test: [expectStatus(200)] },
      {
        app: true,
        name: 'Update cart: take the substitute (UK 10)',
        method: 'PUT',
        path: '/merchant-cart/{{cart_id}}',
        body: { items: [{ variant_id: 'nike-pegasus-41-uk-10', quantity: 1 }] },
        test: [expectStatus(200), "pm.test('READY', () => pm.expect(pm.response.json().status).to.eql('READY'));"],
      },
      {
        app: true,
        name: 'Checkout (501 until Phase 3)',
        method: 'POST',
        path: '/merchant-cart/{{cart_id}}/checkout',
        body: {},
        test: [expectStatus(501)],
      },
      {
        app: true,
        name: 'Create cart: unknown variant (DATA_ERROR, still 201)',
        method: 'POST',
        path: '/merchant-cart',
        body: { items: [{ variant_id: 'does-not-exist', quantity: 1 }] },
        test: [expectStatus(201), "pm.test('DATA_ERROR', () => pm.expect(pm.response.json().validation_issues[0].code).to.eql('DATA_ERROR'));"],
      },
    ],
  },
  {
    name: '2.2 Flight recorder',
    description: 'Hash chain per case_ref. The first request sets a fresh case_ref.',
    items: [
      {
        app: true,
        name: 'Append entry 1 (new case_ref)',
        method: 'POST',
        path: '/recorder/{{case_ref}}/entries',
        prerequest: ["pm.collectionVariables.set('case_ref', 'CASE-' + Date.now());"],
        body: { kind: 'mandate.read', payload: { mandate_id: '{{mandate_id}}', note: 'agent read the mandate' } },
        test: [expectStatus(201), "pm.test('seq 1', () => pm.expect(pm.response.json().seq).to.eql(1));"],
      },
      {
        app: true,
        name: 'Append entry 2',
        method: 'POST',
        path: '/recorder/{{case_ref}}/entries',
        body: { kind: 'merchant.cart.created', payload: { cart_id: '{{cart_id}}', variant_id: 'nike-pegasus-41-us-10', status: 'INCOMPLETE' } },
        test: [expectStatus(201)],
      },
      {
        app: true,
        name: 'Append entry 3',
        method: 'POST',
        path: '/recorder/{{case_ref}}/entries',
        body: { kind: 'agent.decision', payload: { accepted_substitute: 'nike-pegasus-41-uk-10', reason: 'merchant said size 10 is available' } },
        test: [expectStatus(201)],
      },
      { app: true, name: 'List entries', method: 'GET', path: '/recorder/{{case_ref}}', test: [expectStatus(200)] },
      {
        app: true,
        name: 'Verify chain',
        method: 'GET',
        path: '/recorder/{{case_ref}}/verify',
        test: [expectStatus(200), "const v = pm.response.json(); console.log('valid', v.valid, 'first_broken_seq', v.first_broken_seq);"],
      },
    ],
  },
];

function toItem(r: Req) {
  const [rawPath, query] = r.path.split('?');
  const base = r.app ? '{{app_base_url}}' : '{{base_url}}';
  const url = {
    raw: `${base}${r.path}`,
    host: [base],
    path: rawPath.split('/').filter(Boolean),
    ...(query
      ? { query: query.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] ?? '' })) }
      : {}),
  };
  const header = Object.entries(r.headers ?? {}).map(([key, value]) => ({ key, value }));
  let body: unknown;
  if (r.form && r.auth === 'basic') {
    body = { mode: 'urlencoded', urlencoded: r.form.map(({ key, value }) => ({ key, value })) };
  } else if (r.form) {
    body = { mode: 'formdata', formdata: r.form.map((f) => ({ key: f.key, value: f.value, type: 'text', contentType: f.contentType })) };
  } else if (r.body !== undefined) {
    header.push({ key: 'Content-Type', value: 'application/json' });
    body = { mode: 'raw', raw: json(r.body), options: { raw: { language: 'json' } } };
  }
  const event = [
    ...(r.prerequest ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: r.prerequest } }] : []),
    ...(r.test ? [{ listen: 'test', script: { type: 'text/javascript', exec: r.test } }] : []),
  ];
  return {
    name: r.name,
    ...(event.length ? { event } : {}),
    request: {
      method: r.method,
      header,
      ...(r.auth === 'basic'
        ? {
            auth: {
              type: 'basic',
              basic: [
                { key: 'username', value: '{{client_id}}', type: 'string' },
                { key: 'password', value: '{{client_secret}}', type: 'string' },
              ],
            },
          }
        : r.app
          ? { auth: { type: 'noauth' } }
          : {}),
      ...(body ? { body } : {}),
      url,
      ...(r.description ? { description: r.description } : {}),
    },
  };
}

const variables: Record<string, string> = {
  app_base_url: 'http://localhost:3000',
  mandate_id: '',
  mandate_approve_url: '',
  operator_id: '',
  agent_id: '',
  cart_id: '',
  case_ref: '',
  base_url: 'https://api-m.sandbox.paypal.com',
  client_id: '',
  client_secret: '',
  access_token: '',
  currency: 'USD',
  buyer_email: '',
  operator_email: '',
  return_url: 'http://localhost:8787/return',
  cancel_url: 'http://localhost:8787/cancel',
  webhook_url: '',
  auth_assertion: '',
  request_id: '',
  setup_token_id: '',
  vault_id: '',
  customer_id: '',
  operator_vault_id: '',
  custom_id: '',
  invoice_ref: '',
  order_id: '',
  capture_id: '',
  operator_custom_id: '',
  operator_invoice_ref: '',
  operator_order_id: '',
  operator_capture_id: '',
  dispute_id: '',
  webhook_id: '',
  invoice_number: '',
  invoice_id: '',
  refund_id: '',
};

const collection = {
  info: {
    name: 'Recourse',
    description:
      'One folder per phase. Phase 0: every PayPal sandbox call made by scripts/probes (fill client_id, client_secret, buyer_email, operator_email; run "1 Auth / Get access token" first). Phases 1 and 2: the Recourse API at app_base_url (npm run dev). Hand checks: docs/phase1-2-checks.md. Generated by scripts/postman/build.ts.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }] },
  item: [
    { name: 'Phase 0: PayPal sandbox probes', description: 'Direct PayPal sandbox calls (bearer {{access_token}}).', group: folders },
    { name: 'Phase 1: Mandates and operators', description: 'Recourse API. Needs DATABASE_URL, RECOURSE_SIGNING_KEY and the AI_* settings.', group: phase1 },
    { name: 'Phase 2: Demo merchant and flight recorder', description: 'Recourse API. Run npm run migrate and npm run seed first.', group: phase2 },
  ].map((phase) => ({
    name: phase.name,
    description: phase.description,
    item: phase.group.map((f) => ({ name: f.name, description: f.description, item: f.items.map(toItem) })),
  })),
  variable: Object.entries(variables).map(([key, value]) => ({ key, value, type: 'string' })),
};

mkdirSync('postman', { recursive: true });
writeFileSync('postman/recourse.postman_collection.json', json(collection) + '\n');
const all = [...folders, ...phase1, ...phase2];
const count = all.reduce((n, f) => n + f.items.length, 0);
console.log(`Wrote postman/recourse.postman_collection.json (3 phases, ${all.length} folders, ${count} requests)`);
