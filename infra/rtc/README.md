# inukshuk-rtc: rendezvous and TURN relay (2.7.0)

The Worker in `worker/` lets two phones of the same sync group find each other
over the internet and, when a direct connection fails, get short-lived
Cloudflare TURN credentials. Design: security review 2026-10 §2.4 and §2.9; the
phone side is `src/core/group/rdv.ts` and `roomBlob.ts`.

What it does, and does not do:

- **Rooms.** `wss://<host>/v1/r/<roomId>`: one Durable Object per room. A
  socket gets in only by signing a fresh challenge with the room's key; the
  room id is a hash of that key, which only group members can derive, and it
  changes every UTC day and with every group key rotation.
- **Opaque forwarding.** Admitted sockets exchange sealed, padded blobs by
  random handle. The Worker never opens one.
- **TURN.** Credentials only for an admitted socket with a peer in its room,
  15-minute lifetime, 6 per socket per hour, 60 per client IP per hour, a daily
  budget, and a usage check that stops minting at 80 % of the free monthly
  allowance.
- **Nothing is kept.** No storage, no KV/R2/D1, no Workers Logs, no log calls
  in the code. The client IP is a rate-limit key and is otherwise reduced to
  an opaque in-memory tag. CI enforces this (`worker/gates.mjs`).

It runs in its **own free Cloudflare account**, separate from the tiles Worker,
so relay load can never use up the basemap's daily request allowance.

## Owner checklist (one time)

Nothing here can be done by an agent: every step needs the owner's own
sign-in. Keep every value below out of the repository, issues and chats.

1. **Create the account.** A new, free Cloudflare account dedicated to the
   relay, with a company address you control. Turn on two-factor
   authentication, and add a notification for Worker deployments
   (Notifications → Workers).
2. **Choose the host.** Either the account's `*.workers.dev` subdomain, or a
   custom hostname (a domain in this account, then uncomment `routes` in
   `worker/wrangler.toml`). The phones sign the exact host they connect to, so
   the app's relay URL and this host must match.
3. **Create the TURN key.** Dashboard → Realtime → TURN Server → Create. Note
   the **key id** and the **API token** it shows once.
4. **Create two API tokens** (My Profile → API Tokens → Create Custom Token):
   - **Deploy token** for CI: Account → _Workers Scripts: Edit_; Account →
     _Account Settings: Read_. Restrict it to the relay account only. Add a
     zone permission (_Workers Routes: Edit_) only if you use a custom host.
   - **Analytics token** for the Worker's usage check: Account → _Account
     Analytics: Read_, relay account only.
   - Also note the **account id** (dashboard sidebar).
5. **Set the Worker secrets** from `infra/rtc/worker` (after `npm ci`), each
   one prompts for the value:

   ```sh
   npx wrangler login            # into the relay account, not the tiles one
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   npx wrangler secret put CF_ACCOUNT_ID
   npx wrangler secret put CF_ANALYTICS_TOKEN
   npx wrangler secret put IP_TAG_KEY     # any long random string, e.g. `openssl rand -base64 32`
   ```

   `wrangler secret put` on a Worker that does not exist yet creates it; the
   first CI deploy then uploads the code.

6. **Let CI deploy.** GitHub → Settings → Environments → create **`rtc`**:
   - Deployment branches: **Selected → `main`** only.
   - Environment secrets: `CLOUDFLARE_RTC_API_TOKEN` (the deploy token) and
     `CLOUDFLARE_RTC_ACCOUNT_ID` (the account id).

   Until both exist, the `deploy` job of `.github/workflows/rtc-worker.yml`
   is skipped and CI stays green. Once they exist, every merge to `main` that
   touches `infra/rtc/**` deploys; the Actions tab can also run it by hand on
   `main`.

7. **Check usage reading works** before relying on TURN (minting is off
   until the Worker gets a usage reading less than an hour old):

   ```sh
   curl -s https://api.cloudflare.com/client/v4/graphql \
     -H "Authorization: Bearer $ANALYTICS_TOKEN" -H 'Content-Type: application/json' \
     -d '{"query":"query($a: string!, $f: Date!, $t: Date!){viewer{accounts(filter:{accountTag:$a}){callsTurnUsageAdaptiveGroups(limit:10000, filter:{date_geq:$f, date_leq:$t}){sum{egressBytes}}}}}","variables":{"a":"'"$ACCOUNT_ID"'","f":"2026-10-01","t":"2026-10-31"}}'
   ```

   An answer with `"errors": null` (and possibly an empty list) is good. An
   error means the token scope or the dataset name changed; the Worker then
   refuses TURN (phones fall back to direct connections) until fixed.

## Kill switches and limits

All in `[vars]` of `worker/wrangler.toml`; change, merge, and CI redeploys. In
an emergency, edit the variable in the dashboard (Workers → inukshuk-rtc →
Settings → Variables): it applies at once, and the next deploy restores the
file's value.

| Variable                    | Default | Effect                                                        |
| --------------------------- | ------- | ------------------------------------------------------------- |
| `RTC_ENABLED`               | `1`     | `0`: no new room sockets (503); live ones close on next frame |
| `TURN_ENABLED`              | `1`     | `0`: no TURN credentials; phones use direct paths only        |
| `TURN_TTL_S`                | `900`   | credential lifetime (never above 900 whatever is set)         |
| `TURN_PER_SOCKET_PER_HOUR`  | `6`     | credentials per room socket per hour                          |
| `TURN_PER_IP_PER_HOUR`      | `60`    | credentials per client IP per hour, all rooms                 |
| `TURN_DAILY_BUDGET`         | `2000`  | credentials per UTC day, everyone                             |
| `TURN_MONTHLY_ALLOWANCE_GB` | `1000`  | Realtime's free egress per month                              |
| `TURN_USAGE_OFF_PERCENT`    | `80`    | minting stops at this share of the allowance                  |
| `ROOM_MAX_SOCKETS`          | `128`   | admitted sockets per room                                     |
| `ROOM_MAX_PER_IP`           | `16`    | admitted sockets per client IP in one room                    |

Rate-limiting bindings (per Cloudflare location): 120 room connections a
minute per client IP, 10 failed room entries a minute per client IP **and
room**, 5 TURN credentials a minute per client IP.

Per-IP limits are deliberately generous: mobile carriers put many phones
behind one public IP (CGNAT), so a whole team on one carrier can share an IP.
The limits that bound abuse are per socket (frame and byte rates, 3 failed
sign-ins, TURN per socket) and per room (128 sockets).

## Develop and test locally

```sh
cd infra/rtc/worker
npm ci --ignore-scripts
npm run typecheck
node gates.mjs                      # the CI gates
cd ../../.. && npx jest infra/rtc src/core/group/rdv src/core/group/roomBlob
```

`npx wrangler dev --local` runs it on the local workerd with no account; TURN
answers `off` there (no secrets). Never run `wrangler deploy` by hand from a
branch: deploys come from `main` through CI.

## To verify after the first deploy

- Whether a TURN allocation outlives its credential's expiry, and that the
  revoke call (made when a socket leaves) ends it.
- That the usage query above reports egress once TURN is used.
