import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { cases } from './accountability/cases.routes';
import { receipts } from './accountability/receipts.routes';
import { scorecard } from './accountability/scorecard';
import { appeals, reputation, rulings } from './accountability/rulings.routes';
import { caseSettlement, settlements } from './settlement/routes';
import { agents } from './authorization/agents.routes';
import { mandates } from './authorization/mandates.routes';
import { operators } from './authorization/operators.routes';
import { recorder, snapshots } from './evidence/recorder.routes';
import { loadSigner } from './shared/crypto/signing';
import { errorHandler, route } from './shared/http/errors';
import { paypalWebhooks } from './paypal/webhooks.routes';
import { agentRoutes } from './transaction/agent/routes';
import { merchantCart } from './transaction/cart.routes';
import { checkoutRoutes } from './transaction/checkout.routes';
import { consoleRoutes } from './console/routes';

/**
 * One app, organised as modules:
 *   authorization   buyers, mandates, operators, agents, liability agreements, payment tokens
 *   transaction     the demo merchant: catalog, Store Sync style carts, size table (checkout in Phase 3)
 *   evidence        flight recorder, signed checkpoints, catalog snapshots
 *   accountability  fault definitions now; cases, assessments, rulings, appeals in Phase 4
 *   settlement      exposure now; obligations and PayPal actions in Phase 5
 * plus paypal (the one PayPal adapter, shared with the probes) and shared (db, crypto, http, ai).
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind Render's proxy: req.ip is the client address (used by the per-IP demo limit).
  app.set('trust proxy', 1);
  // Webhooks take the raw body (signature verification), so they mount before the JSON parser.
  app.use('/webhooks/paypal', paypalWebhooks);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' })); // receipt page forms

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  /** Public half of Recourse's signing key, so anyone can check mandates, acceptances and checkpoints. */
  app.get(
    '/.well-known/recourse-signing-key',
    route(async (_req, res) => {
      const s = loadSigner();
      res.json({ key_id: s.keyId, alg: 'Ed25519', jwk: s.publicJwk });
    }),
  );

  // authorization
  app.use('/mandates', mandates);
  app.use('/operators', operators);
  app.use('/agents', agents);
  // transaction
  app.use(checkoutRoutes); // /merchant-cart/:id/checkout, /step-ups/:id/*, /orders/:ref
  app.use('/merchant-cart', merchantCart);
  app.use('/agent', agentRoutes);
  // accountability
  app.use('/r', receipts);
  app.use('/cases', cases);
  app.use('/scorecard', scorecard);
  app.use('/cases', caseSettlement); // GET /cases/:id/settlement
  app.use('/rulings', rulings);
  app.use('/appeals', appeals);
  app.use(reputation); // GET /agents/:id/reputation, GET /operators/:id/reputation
  // settlement
  app.use('/settlements', settlements);
  // evidence
  app.use('/recorder', recorder);
  app.use('/catalog-snapshots', snapshots);
  // screens: read-only views and the Clerk's model turn, then the built web app (npm run web:build)
  app.use('/console', consoleRoutes);
  const web = join(process.cwd(), 'web', 'dist');
  if (existsSync(web)) {
    app.use('/app', express.static(web, { index: false, maxAge: '1h' }));
    app.get(/^\/app(\/.*)?$/, (_req, res) => res.sendFile(join(web, 'index.html')));
    app.get('/', (_req, res) => res.redirect('/app/'));
  }

  app.use((req, res) => {
    res.status(404).json({ name: 'RESOURCE_NOT_FOUND', message: `No route for ${req.method} ${req.path}` });
  });
  app.use(errorHandler);
  return app;
}
