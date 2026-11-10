import express from 'express';
import { agents } from './agents/routes';
import { loadSigner } from './crypto/signing';
import { errorHandler, route } from './http/errors';
import { mandates } from './mandates/routes';
import { merchantCart } from './merchant/routes';
import { operators } from './operators/routes';
import { recorder } from './recorder/routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  /** Public half of the mandate signing key, so anyone can check a mandate signature. */
  app.get(
    '/.well-known/recourse-signing-key',
    route(async (_req, res) => {
      const s = loadSigner();
      res.json({ key_id: s.keyId, alg: 'Ed25519', jwk: s.publicJwk });
    }),
  );

  app.use('/mandates', mandates);
  app.use('/operators', operators);
  app.use('/agents', agents);
  app.use('/merchant-cart', merchantCart);
  app.use('/recorder', recorder);

  app.use((req, res) => {
    res.status(404).json({ name: 'RESOURCE_NOT_FOUND', message: `No route for ${req.method} ${req.path}` });
  });
  app.use(errorHandler);
  return app;
}
