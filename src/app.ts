import express from 'express';
import { agents } from './authorization/agents.routes';
import { mandates } from './authorization/mandates.routes';
import { operators } from './authorization/operators.routes';
import { recorder, snapshots } from './evidence/recorder.routes';
import { loadSigner } from './shared/crypto/signing';
import { errorHandler, route } from './shared/http/errors';
import { merchantCart } from './transaction/cart.routes';

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
  app.use(express.json({ limit: '1mb' }));

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
  app.use('/merchant-cart', merchantCart);
  // evidence
  app.use('/recorder', recorder);
  app.use('/catalog-snapshots', snapshots);

  app.use((req, res) => {
    res.status(404).json({ name: 'RESOURCE_NOT_FOUND', message: `No route for ${req.method} ${req.path}` });
  });
  app.use(errorHandler);
  return app;
}
