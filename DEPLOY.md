# Deploying StorePilot AI

No terminal, no Node install. Supabase for the database, GitHub for the code, Vercel to run it. About 25 minutes, most of it waiting on Vercel's first build.

---

## 1 · Database (Supabase, 5 minutes)

1. Open your Supabase project → **SQL Editor** → **New query**.
2. Open `supabase-setup.sql` from this folder, copy the whole file, paste it in, press **Run**.
3. You should see **Success. No rows returned**. Some `NOTICE` lines are normal.

That created 34 tables, made the audit log insert-only at the database level, and wrote your store row and default settings. The file is safe to run again if you ever need to.

**Get the connection string:** Project Settings → **Database** → Connection string → **URI**, and choose the **Session pooler** (port 5432, host contains `pooler.supabase.com`). Replace `[YOUR-PASSWORD]` with your database password.

> Two things people get wrong here. Use the **Session pooler**, not the transaction pooler on port 6543. And if your database password contains `@`, `#`, `/` or `?`, reset it to something alphanumeric, because those characters break the URL unless they are percent-encoded.

---

## 2 · Code (GitHub, 5 minutes)

Easiest path on Windows without a terminal:

1. Go to github.com → **New repository** → name it `storepilot` → **Private** → Create.
2. On the empty repo page click **uploading an existing file**.
3. Unzip `storepilot-ai.zip` on your machine, open the `storepilot` folder, select **everything inside it** (not the folder itself) and drag it into the browser.
4. Commit.

Make sure `package.json` ends up at the top level of the repo, not inside a `storepilot/` subfolder. If it does end up nested, Vercel will fail to find the project and you'll need to re-upload.

There is no `.env` file in the zip and there should never be one in the repo. Secrets live in Vercel only.

---

## 3 · Deploy (Vercel, 10 minutes)

1. vercel.com → sign in with GitHub → **Add New → Project** → import `storepilot`.
2. Framework preset should auto-detect as **Next.js**. Leave the build settings alone.
3. Before clicking Deploy, open **Environment Variables** and add these five:

| Name | Value |
|---|---|
| `DATABASE_URL` | your Supabase session-pooler URI |
| `ADMIN_EMAIL` | the email you'll log in with |
| `SESSION_SECRET` | 40+ random characters. Mash the keyboard, or use a password manager's generator |
| `ANTHROPIC_API_KEY` | from console.anthropic.com |
| `APP_URL` | leave blank for now, you'll set it after the first deploy |

4. Deploy. First build takes 2 to 4 minutes.
5. When it finishes, copy the URL (`https://storepilot-something.vercel.app`), go back to Environment Variables, set `APP_URL` to it, and redeploy.

**Do not add `ADMIN_PASSWORD_HASH`.** Leaving it out is what enables the first-run screen in the next step.

---

## 4 · Set your password (2 minutes, do this immediately)

Open your Vercel URL. You'll get a **first run** screen asking you to choose a password.

Set it now, before you do anything else. Until you do, the deployment is unclaimed — anyone who guesses both the URL and your `ADMIN_EMAIL` could claim it. Once you set a password the screen closes permanently and cannot be used again, even by you.

Use 12+ characters. Only a bcrypt hash is stored; the password itself is never written anywhere, including logs.

You should land on the dashboard.

---

## 5 · Hourly sync (1 minute, optional until you have orders)

`vercel.json` already schedules `/api/cron/sync` hourly. Vercel Cron sends its own authorization, so on the Hobby plan you may see the cron log 401s. Two options:

- **Ignore it until you launch.** Nothing needs syncing before you have orders.
- **Wire it properly:** in Vercel, add environment variable `CRON_SECRET` equal to your `SESSION_SECRET`. Vercel sends `Authorization: Bearer $CRON_SECRET` on cron invocations, which is exactly what the endpoint checks for.

You can always press **Sync and detect** on the Command Center by hand.

---

## 6 · Connect Shopify (when you reach Store Builder)

Not now. When the Store Builder tab is where you are:

1. Shopify Admin → **Settings → Apps and sales channels → Develop apps → Create an app**.
2. **Configure Admin API scopes.** Start read-only: `read_orders`, `read_fulfillments`, `read_products`, `read_inventory`. Add `write_products` and `write_content` only when you actually want the tool to create the product and pages.
3. **Install app**, then copy two values: the **Admin API access token** (`shpat_…`) and the **API secret key**.
4. In Vercel, add three more environment variables and redeploy:

| Name | Value |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `yourstore.myshopify.com` (not your custom domain) |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | the `shpat_…` token |
| `SHOPIFY_API_SECRET` | the API secret key |

5. In StorePilot → **Settings**, turn on **Shopify write actions**. It is off by default and should stay off until you've watched one push land where you expected.

Then use **Propose webhook registration** on the Store Builder tab so order events flow back in.

---

## Costs

| | |
|---|---|
| Supabase | free tier is fine |
| Vercel | free Hobby tier is fine |
| Anthropic | $8 to $25/month at this volume. Set a $75 limit on the key in the console; the app's own $50 budget breaker trips first |
| Shopify | dev store is free, but **a development store cannot take real payments**. You need a paid plan and a domain to actually sell |

---

## If something breaks

**Build fails, "Cannot find module":** `package.json` is nested. Re-upload with the folder contents at the repo root.

**Runtime error mentioning `DATABASE_URL` or a connection timeout:** wrong Supabase string. Use the Session pooler URI, and check for unencoded special characters in the password.

**"Invalid environment configuration":** the error names the missing variable. Add it in Vercel and redeploy. Environment variable changes need a redeploy to take effect.

**Login says no password is set:** the setup screen is at the same URL. If it doesn't appear, `ADMIN_PASSWORD_HASH` is set in Vercel by mistake. Delete it and redeploy.

**AI features error immediately:** missing or out-of-credit `ANTHROPIC_API_KEY`, or the monthly budget breaker has tripped. Both are visible on the dashboard.

---

## Sanity check, in order

1. `/api/health` returns `{"ok":true,"db":"up"}`.
2. You can log in.
3. Settings → change the target price → save. The Audit log shows the change with before and after state.
4. Approvals → **Create test approval** → open it → **Approve**. The execution row says `succeeded`.
5. Settings → engage the kill switch. Create and approve another test approval. That execution says `blocked_by_kill_switch`, and a red banner sits on every page. Release the switch.

If all five work, the machinery is sound and you can start on the Research tab.
