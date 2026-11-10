import { approveLink, createPaymentToken, createPaypalSetupToken, getSetupToken } from '../../src/paypal/vault';
import { args, env, flag, requireValue, saveValues } from './env';
import { showLinks } from './print';
import { printed } from './sdk';

export type Role = 'BUYER' | 'OPERATOR';

/** Probes 2 and 8 share these. `--operator` stores under OPERATOR_*, otherwise BUYER_*. */
export function role(): Role {
  return flag('operator') ? 'OPERATOR' : 'BUYER';
}

const opFlag = (who: Role) => (who === 'OPERATOR' ? ' --operator' : '');

export async function createPaypalSetupTokenProbe(who: Role): Promise<void> {
  const port = env('PORT', '8787');
  const res = await printed(
    `POST /v3/vault/setup-tokens (paypal, ${who.toLowerCase()})`,
    createPaypalSetupToken({
      description:
        who === 'OPERATOR'
          ? 'Recourse: agent operator pre-authorized liability payments'
          : 'Recourse: buyer saved PayPal for agent checkout',
      usagePattern: env('VAULT_USAGE_PATTERN', 'IMMEDIATE'),
      returnUrl: env('RETURN_URL', `http://localhost:${port}/return`)!,
      cancelUrl: env('CANCEL_URL', `http://localhost:${port}/cancel`)!,
    }),
  );
  if (res.status >= 300) {
    if (JSON.stringify(res.body).includes('NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE')) {
      console.log('\nNOT_ENABLED_TO_VAULT_PAYMENT_SOURCE: vaulting PayPal wallets is not enabled for this app.');
      console.log('Fallback: npx tsx scripts/probes/02c-vault-card-fallback.ts');
    }
    process.exit(1);
  }
  console.log('\nLinks:');
  showLinks(res.body.links);
  saveValues({ [`${who}_SETUP_TOKEN_ID`]: res.body.id });
  console.log(`\nOpen this link and log in as the ${who.toLowerCase()} sandbox personal account:\n  ${approveLink(res.body)}`);
  console.log(`Then run: npx tsx scripts/probes/02b-vault-payment-token.ts${opFlag(who)}`);
}

export async function exchangeSetupToken(who: Role): Promise<void> {
  const setupTokenId =
    args()[0] ?? requireValue(`${who}_SETUP_TOKEN_ID`, `Run 02a-vault-setup-token.ts${opFlag(who)} first.`);

  await printed(`GET /v3/vault/setup-tokens/${setupTokenId}`, getSetupToken(setupTokenId));
  const res = await printed('POST /v3/vault/payment-tokens', createPaymentToken(setupTokenId));
  if (res.status >= 300) process.exit(1);

  const vaultId: string = res.body.id;
  saveValues({ [`${who}_VAULT_ID`]: vaultId, [`${who}_CUSTOMER_ID`]: res.body.customer?.id });
  console.log(`\nvault_id: ${vaultId}`);
  console.log(
    who === 'OPERATOR'
      ? `To pin it, add to .env: OPERATOR_VAULT_ID=${vaultId}\nNext: npx tsx scripts/probes/08-operator-charge.ts`
      : 'Next: npx tsx scripts/probes/03-order-vault-capture.ts',
  );
}
