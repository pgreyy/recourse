// npm run keygen: make a new Ed25519 signing key for mandates.
//   npm run keygen              prints the RECOURSE_SIGNING_KEY=... line to paste into .env
//   npm run keygen -- --append  writes it into .env instead (only if no key is set) and prints only the key id
// The private key is a secret: don't paste it into chat, tickets or commits.
// Changing the key later makes every mandate signed with the old key show signature_valid=false.
import 'dotenv/config';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateSigningKey } from '../src/shared/crypto/signing';

const key = generateSigningKey();
const line = `RECOURSE_SIGNING_KEY=${key.privateKeyB64}`;

if (process.argv.includes('--append')) {
  const envPath = resolve(process.cwd(), '.env');
  const current = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  if (/^RECOURSE_SIGNING_KEY=\S/m.test(current)) {
    console.error('.env already has RECOURSE_SIGNING_KEY. Not replacing it (old signatures would stop verifying).');
    process.exit(1);
  }
  appendFileSync(envPath, `${current.endsWith('\n') || current === '' ? '' : '\n'}${line}\n`);
  console.log(`Wrote RECOURSE_SIGNING_KEY to .env. Key id: ${key.keyId}`);
} else {
  console.log('Paste this line into .env (it is a secret):\n');
  console.log(line);
  console.log(`\nKey id: ${key.keyId}`);
}
