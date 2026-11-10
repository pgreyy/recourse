# Hosting Recourse on Render

One web service, defined in [render.yaml](../render.yaml): Node 22, Ohio (the same AWS region as the Neon database,
us-east-2), the **Free** plan (no card needed), health check `/health`. The build installs the API and `web/`,
type-checks and builds the screens. At start it runs the database migrations (skipped when the database is up to
date), then the API. No secret is in the repo: Render asks for every variable when the Blueprint is created.

A free service sleeps after 15 minutes without traffic, and the first visit after that waits while it wakes up. We
keep it awake with an external ping to `/health` every 10 minutes (cron-job.org, free): see step 5. A free service
also has no Render Shell, so the one command needed after deploy runs on the laptop (step 4.2).

## 1. Sign up and connect GitHub

1. Go to https://render.com and choose **Get Started**, then **GitHub**. Sign in as `pgreyy` and authorise Render.
2. When GitHub asks which repositories the Render app may see, pick **Only select repositories** and choose
   **pgreyy/recourse**. The repo stays private; this only lets Render read it.
   (Already signed up? Account settings, **Git**, GitHub, **Configure**, and add pgreyy/recourse there.)

## 2. No card needed

The service uses the Free plan, so Render does not ask for a payment method. If you later want it never to sleep
without the ping, switch the service to a paid instance type (that needs a card or credit on the Billing page).

## 3. Create the service from the Blueprint

1. **New** (top right), then **Blueprint**.
2. Pick **pgreyy/recourse**, branch **main**. Render finds `render.yaml` and shows one service, **getrecourse** (web,
   Free, Ohio).
3. Give the Blueprint a name (`getrecourse`), then fill in the variables it lists. Copy each value from your local
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
   `https://getrecourse.onrender.com` (the service name sets it). Opening `/health` there answers `{"ok":true}`.

## 4. Once the address exists

1. **Set the public address.** Service, **Environment**, `PUBLIC_BASE_URL` = the address from step 3.4, no trailing
   slash. **Save, rebuild and deploy** (or Save, then **Manual Deploy**, **Deploy latest commit**). Until then the
   service already uses Render's own address for PayPal returns, so nothing breaks in between.
2. **Point PayPal's webhook at Render, from the laptop.** The free plan has no Render Shell. On the laptop, in the
   project folder, run this with your Render address (it overrides `PUBLIC_BASE_URL` for this one command only; the
   local `.env` is not changed):

       PUBLIC_BASE_URL=https://getrecourse.onrender.com npm run webhook:sync

   It updates the existing webhook (`WEBHOOK_ID` from the local `.env`, the same value Render has) to
   `https://getrecourse.onrender.com/webhooks/paypal`. You should see `PATCH webhook …: HTTP 200` and the six event
   types. From then on PayPal's webhooks go to Render, not to the laptop tunnel.
3. **Check it.** Open `https://getrecourse.onrender.com/app/judges`, then `/app/console`. If the case page or the Clerk shows
   "Demo limit reached", the hourly AI limit is working.

## 5. Keep it awake (cron-job.org)

1. Go to https://cron-job.org and create a free account.
2. **Create cronjob**. Title `recourse health`, URL `https://getrecourse.onrender.com/health`.
3. Schedule: **Every 10 minutes**. Save, and leave the job enabled.
4. After a few runs, the job's history shows status 200 each time.

A ping every 10 minutes is inside the 15 minute idle limit, so the service stays awake. If the ping stops, the first
visit after 15 quiet minutes takes a short while as the service wakes up; nothing is lost. The ping hits only
`/health`, which makes no AI or PayPal call.

## 6. The clean demo

The demo reset is a separate step and needs your go-ahead. It runs against Neon only with `--neon`:

    npm run demo:reset -- --yes --neon

Run it on the laptop (it uses the same Neon database as Render). See [demo-reset.md](demo-reset.md).

## If something goes wrong

- **Build fails at `npm run typecheck`:** the log names the file; nothing was deployed, the old version keeps running.
- **The start fails at `npm run migrate`:** `DATABASE_URL` is wrong or Neon is unreachable.
- **PayPal approval returns to localhost:** `PUBLIC_BASE_URL` is still set to a local address; fix it and redeploy.
- **No webhook events:** run the step 4.2 command again on the laptop and check `WEBHOOK_ID` matches the local `.env`.
- **Roll back:** service, **Events**, pick the last good deploy, **Rollback**.
