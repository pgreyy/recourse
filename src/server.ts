// npm run dev (watch) or npm start: the Recourse API.
import { createApp } from './app';
import { config } from './config';

const port = config.appPort();
createApp().listen(port, () => {
  const missing = ['DATABASE_URL', 'RECOURSE_SIGNING_KEY', 'AI_PROVIDER', 'AI_MODEL', 'AI_API_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'].filter(
    (k) => !process.env[k]?.trim(),
  );
  console.log(`Recourse API on http://localhost:${port}  (PayPal redirects to ${config.publicBaseUrl()})`);
  if (missing.length) console.log(`Not set in .env yet: ${missing.join(', ')}. Routes that need them answer 503.`);
});
