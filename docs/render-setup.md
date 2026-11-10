# Hosting Recourse on Render

One web service, defined in [render.yaml](../render.yaml): Node 22, Ohio (the same AWS region as the Neon database,
us-east-2), the Starter plan (it never sleeps), health check `/health`. The build installs the API and `web/`,
type-checks and builds the screens; before each deploy it runs the database migrations; it starts with `npm start`.
No secret is in the repo: Render asks for every variable when the Blueprint is created.

## 1. Sign up and connect GitHub

1. Go to https://render.com and choose **Get Started**, then **GitHub**. Sign in as `pgreyy` and authorise Render.
2. When GitHub asks which repositories the Render app may see, pick **Only select repositories** and choose
   **pgreyy/recourse**. The repo stays private; this only lets Render read it.
   (Already signed up? Account settings, **Git**, GitHub, **Configure**, and add pgreyy/recourse there.)

## 2. Apply the credit code

1. Open the workspace menu (top left), **Settings**, then **Billing**.
2. Find the place to add a promo or credit code and enter yours. Render may also ask for a payment method; the Starter
   instance is a paid plan, and the credit pays for it. Check the credit shows on the Billing page before going on.

(The billing screen's exact labels may differ from these; if you can't find the code field, ask Render support from the
same page.)

## 3. Create the service from the Blueprint

1. **New** (top right), then **Blueprint**.
2. Pick **pgreyy/recourse**, branch **main**. Render finds `render.yaml` and shows one service, **recourse** (web,
   Starter, Ohio).
3. Give the Blueprint a name (`recourse`), then fill in the variables it lists. Copy each value from your local
   `.env`, line by line, without spaces around it:

   | Variable | Where the value comes from |
   | --- | --- |
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | `.env`, same names (the US sandbox app) |
   | `WEBHOOK_ID` | `.env`, same name |
   | `PUBLIC_BASE_URL` | **Leave empty for now** (step 4 sets it) |
   | `DATABASE_URL` | `.env`, same name (the Neon string, with `?sslmode=require`) |
   | `RECOURSE_SIGNING_KEY` | `.env`, same name (the whole long line after `=`) |
   | `AI_PROVIDER`, `AI_MODEL`, `AI_FALLBACK_MODEL`, `AI_API_KEY` | `.env`, same names |
   | `OPENAI_API_KEY`, `AI_OPENAI_MODEL`, `AI_PRIMARY`, `AI_ASSESS_MODEL` | `.env`, same names |
   | `AI_OPENAI_AGENT_EFFORT`, `AI_CLERK_MODEL` | Leave empty (defaults: low, gpt-5-nano) |
   | `AI_CALLS_PER_HOUR`, `AGENT_RUNS_PER_IP_PER_HOUR` | Leave empty for the defaults (60 and 3), or type your own numbers |
   | `BUYER_EMAIL`, `OPERATOR_EMAIL` | `.env`, same names (the sandbox accounts) |
   | `JUDGE_BUYER_EMAIL`, `JUDGE_OPERATOR_EMAIL` | Leave empty to use the two above |
   | `JUDGE_BUYER_PASSWORD`, `JUDGE_OPERATOR_PASSWORD` | The sandbox accounts' passwords, from the PayPal developer dashboard (Sandbox, Accounts, the account, View/Edit). These show on `/app/judges`; leave them empty to say "in the Devpost testing instructions" instead |
   | `CURRENCY` | `USD` |
   | `AG_STUDIO_LICENSE_KEY` | Leave empty unless you have one (empty means AG Studio's trial watermark) |

4. **Apply**. The first build takes a few minutes. When the log ends with `Recourse API on http://localhost:10000`, the
   service is live. Render shows its address at the top of the service page, for example
   `https://recourse-xxxx.onrender.com`. Opening `/health` there answers `{"ok":true}`.

## 4. Once the address exists

1. **Set the public address.** Service, **Environment**, `PUBLIC_BASE_URL` = the address from step 3.4, no trailing
   slash. **Save, rebuild and deploy** (or Save, then **Manual Deploy**, **Deploy latest commit**). Until then the
   service already uses Render's own address for PayPal returns, so nothing breaks in between.
2. **Point PayPal's webhook at Render.** Service, **Shell** (top right), then run:

       npm run webhook:sync

   It updates the existing webhook (`WEBHOOK_ID`) to `PUBLIC_BASE_URL/webhooks/paypal`. You should see
   `PATCH webhook …: HTTP 200` and the six event types. From then on PayPal's webhooks go to Render, not to the laptop
   tunnel.
3. **Check it.** Open `https://<address>/app/judges`, then `/app/console`. If the case page or the Clerk shows
   "Demo limit reached", the hourly AI limit is working.

## 5. The clean demo

The demo reset is a separate step and needs your go-ahead. It runs against Neon only with `--neon`:

    npm run demo:reset -- --yes --neon

From the Render Shell or the laptop (both use the same Neon database). See [demo-reset.md](demo-reset.md).

## If something goes wrong

- **Build fails at `npm run typecheck`:** the log names the file; nothing was deployed, the old version keeps running.
- **Pre-deploy fails at `npm run migrate`:** `DATABASE_URL` is wrong or Neon is unreachable.
- **PayPal approval returns to localhost:** `PUBLIC_BASE_URL` is still set to a local address; fix it and redeploy.
- **No webhook events:** run `npm run webhook:sync` again in the Shell and check `WEBHOOK_ID` matches the local `.env`.
- **Roll back:** service, **Events**, pick the last good deploy, **Rollback**.
