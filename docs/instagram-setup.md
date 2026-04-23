# Instagram Direct Comment → DM Setup

One-time configuration for the Meta Graph API integration that replaces
ManyChat as the comment-to-DM dispatcher. This walks Pat through the steps
in the Meta App Dashboard and Graph API Explorer.

## What this enables

Two trigger paths, both backed by the same DB lookup:

1. **Comment trigger:** viewer comments a configured keyword on any `@starter_story` post → Meta hits our webhook → we DM the link via the Send API's *private reply* form (bypasses the 24h messaging window).
2. **DM trigger:** viewer DMs a configured keyword to `@starter_story` → Meta hits our webhook → we DM the link back via the Send API's *standard message* form (24h window is open since they just messaged us).

Both are handled by `/api/instagram/webhook` against the same keyword DB (`productionItems.manychat_keyword`).

## Prerequisites

- `@starter_story` is a Business or Creator IG account ✅
- It's connected to a Facebook Page ✅
- You have admin access to that FB Page ✅

## Env vars to populate

By the end of setup, your `.env.local` (and Heroku config) needs:

| Var | Where it comes from |
|---|---|
| `META_VERIFY_TOKEN` | Random string we pick. Already generated and stored. |
| `META_APP_SECRET` | Meta App Dashboard → Settings → Basic → "App Secret" |
| `INSTAGRAM_PAGE_ACCESS_TOKEN` | Graph API Explorer (steps below) |
| `INSTAGRAM_BUSINESS_ID` | Graph API call (step below) |

---

## Step 1 — Meta App

1. Go to https://developers.facebook.com/apps/
2. Either pick the existing Starter Story app (if there is one) or click **Create App** → Type: **Business** → name it `Hub & Spoke - IG Automations`.
3. App Dashboard → **Add Product** → enable both:
   - **Webhooks**
   - **Instagram** (the "Instagram with Facebook Login" path — *not* "Instagram Basic Display", which is deprecated)

## Step 2 — Get the App Secret

1. App Dashboard → Settings → **Basic**
2. Copy the **App Secret** (click "Show", may need to re-enter your FB password)
3. Paste into `META_APP_SECRET` in `.env.local` AND in Heroku:
   ```
   heroku config:set META_APP_SECRET=<value> --app hubandspoke
   ```

## Step 3 — Connect the Instagram account

1. App Dashboard → Instagram → **Set Up** (or "API Setup with Instagram Login" / "API Setup with Facebook Login")
2. Use the **Facebook Login** path (the FB Page route). Select the FB Page that owns `@starter_story`.
3. Confirm `@starter_story` shows up as the linked Instagram Business account.

## Step 4 — Generate a long-lived Page Access Token

The token is what authorizes us to send DMs on behalf of `@starter_story`.

1. Open https://developers.facebook.com/tools/explorer/
2. Top right:
   - **Meta App:** select `Hub & Spoke - IG Automations`
   - Click **Get User Access Token**
   - Check the boxes for: `instagram_basic`, `instagram_manage_messages`, `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`
   - Click **Generate Access Token**, complete the OAuth prompt
3. You now have a **short-lived user token** (in the input box at the top). Copy it.
4. In a terminal, exchange it for a long-lived user token. Replace `<APP_ID>`, `<APP_SECRET>`, and `<SHORT_LIVED_TOKEN>`:
   ```
   curl -G "https://graph.facebook.com/v25.0/oauth/access_token" \
     --data-urlencode "grant_type=fb_exchange_token" \
     --data-urlencode "client_id=<APP_ID>" \
     --data-urlencode "client_secret=<APP_SECRET>" \
     --data-urlencode "fb_exchange_token=<SHORT_LIVED_TOKEN>"
   ```
   The response `access_token` field is your long-lived user token. ~60 day lifetime.
5. List the Pages you admin to find the Page Access Token (these are non-expiring once derived from a long-lived user token):
   ```
   curl -G "https://graph.facebook.com/v25.0/me/accounts" \
     --data-urlencode "access_token=<LONG_LIVED_USER_TOKEN>"
   ```
   Find the entry for the FB Page linked to `@starter_story`. Copy that entry's `access_token`. **That's `INSTAGRAM_PAGE_ACCESS_TOKEN`.** Also note the `id` value — that's the Page ID (used in the next step).

   Set it locally and on Heroku:
   ```
   heroku config:set INSTAGRAM_PAGE_ACCESS_TOKEN=<value> --app hubandspoke
   ```

## Step 5 — Get the Instagram Business ID

Used to skip self-comments in our webhook handler.

```
curl -G "https://graph.facebook.com/v25.0/<PAGE_ID>" \
  --data-urlencode "fields=instagram_business_account" \
  --data-urlencode "access_token=<INSTAGRAM_PAGE_ACCESS_TOKEN>"
```

Returns:
```json
{ "instagram_business_account": { "id": "17841..." }, "id": "<PAGE_ID>" }
```

The `instagram_business_account.id` is `INSTAGRAM_BUSINESS_ID`. Set it:
```
heroku config:set INSTAGRAM_BUSINESS_ID=<value> --app hubandspoke
```

## Step 6 — Configure the webhook subscription

1. App Dashboard → Webhooks
2. Find **Instagram** in the dropdown → click **Edit Subscription**
3. **Callback URL:** `https://hubandspoke.starterstory.com/api/instagram/webhook`
4. **Verify Token:** the value of `META_VERIFY_TOKEN` from `.env.local` (locally generated as `423f478af0e73088cce5f641b39cda801296aa84bac91adb` — also set this on Heroku before this step or the handshake will fail)
5. Click **Verify and Save** — Meta hits our GET endpoint. Should succeed on first try.
6. Subscribe to BOTH fields:
   - **`comments`** — for comment-triggered DMs
   - **`messages`** — for DM-triggered DM replies
7. Then in the same Instagram subscription panel, add the `@starter_story` account by selecting it and clicking **Subscribe** on both fields above.

## Step 7 — App Review for `instagram_manage_messages`

Required for DM-sending to work for *anyone other than the page admin*. Until approved, you (Pat) can still test the full flow.

1. App Dashboard → **App Review** → Permissions and Features
2. Find `instagram_manage_messages` → **Request Advanced Access**
3. Submission requires:
   - **Screencast** (1-3 min): record commenting a configured keyword on a test post → DM with the link arriving in your IG DMs. Show the Hub & Spoke item detail page where the keyword is configured, then the IG post + comment + DM.
   - **Use case description:**
     > Hub & Spoke is an internal tool used by the @starter_story team to configure per-post comment triggers. When a viewer comments a configured keyword on one of our IG posts, our backend (`hubandspoke.starterstory.com`) receives the comment via the Instagram webhook, looks up the matching link in our database, and DMs that link to the commenter via the Instagram Private Reply API. This automates the previously manual workflow of replying to every keyword commenter individually.
   - **Test instructions:** "Visit our test post at `<URL>`. Comment the word `testtube`. Within 5 seconds you should receive a DM containing `https://www.starterstory.com/wrapitup`."
4. Submit. Realistic review timeline: 2-7 business days. Sometimes longer.
5. **During the wait:** the webhook + DM still works for you (the page admin). You can verify the entire pipeline immediately.

---

## Verification (after Step 6)

In a terminal on a machine that can hit our prod URL:

```
# Should return 200 with the challenge value as plain text
curl -i "https://hubandspoke.starterstory.com/api/instagram/webhook?hub.mode=subscribe&hub.verify_token=423f478af0e73088cce5f641b39cda801296aa84bac91adb&hub.challenge=test123"

# Wrong token should return 403
curl -i "https://hubandspoke.starterstory.com/api/instagram/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=test123"
```

Then exercise both trigger paths (as your admin account — works pre-review):

```
heroku logs --app hubandspoke --tail | grep "instagram/webhook"
```

- **Comment test:** comment a configured keyword on a real IG post. Look for `comment_id=... match=yes` followed by `DM sent`.
- **DM test:** open a DM with `@starter_story` from a different account (or any account that's not the page admin echo) and message the configured keyword. Look for `dm mid=... match=yes` followed by `DM reply sent`.

---

## Tear-down (after Meta direct is verified)

Once we've confirmed prod stability over a few real comments, follow-up PR:

1. Disable the ManyChat automation in the ManyChat UI (just hit the LIVE toggle off — keeps it for reference)
2. Delete `MANYCHAT_WEBHOOK_SECRET` from Heroku config
3. Delete `src/app/api/manychat/lookup/route.ts`
4. Rename `manychat_keyword` / `manychat_link` columns to `ig_trigger_keyword` / `ig_dm_link` (drizzle migration), update the UI labels
5. Rename `src/lib/services/manychat.ts` → `src/lib/services/ig-trigger.ts`

Saving this for after the direct path proves out, to avoid churn while still depending on ManyChat.
