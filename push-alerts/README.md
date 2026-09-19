# Real phone alerts — setup guide (ntfy version)

This sends alerts to your phone even when it's locked and the app is closed —
using **ntfy** (https://ntfy.sh), a free notification service with its own
app. This replaces the earlier Web Push approach, which depended on the
phone's browser fully supporting push — that's what was failing. This
version doesn't touch the browser at all: the GitHub Actions job talks
directly to the ntfy app on your phone.

## 1. Install the ntfy app

- Android: search **"ntfy"** on the Play Store (by nows.systems), install it.
- iPhone: search **"ntfy"** on the App Store, install it.

## 2. Pick your private topic name

A "topic" in ntfy is like a private channel name — anyone who knows the exact
name can subscribe to it, so use a long, random, unguessable one. Use this
one (already generated for you), or make your own:

```
YOUR-TOPIC```

Since your GitHub repo is **public**, this name must only ever live in a
GitHub secret (step 4) — never commit it into `index.html` or any file in
the repo.

## 3. Subscribe to it in the app

Open the ntfy app → **+** (Add subscription) → paste in the topic name above
(server: `ntfy.sh`, the default) → Subscribe. Do this on every phone that
should get alerts.

Optional but recommended: in the app's subscription settings, turn on
**"Override DND"** / set a custom sound for this subscription, so a `crit`
alert actually rings through silent mode.

## 4. Add GitHub secrets

Repo → **Settings** → **Secrets and variables** → **Actions** → **New
repository secret**. You need two:

| Secret name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | The full JSON of a Firebase service account key (see below if you don't have this yet) |
| `NTFY_TOPIC` | `3dd858f8e4b05eeb3d90c453` (or your own topic name) |

If you already added `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
`VAPID_CONTACT_EMAIL` secrets from the previous setup attempt, you can
delete those — they're no longer used.

### Getting the Firebase service account key (if you skipped this before)

1. Firebase console → your project → ⚙️ **Project settings** → **Service accounts** tab.
2. **Generate new private key** → confirm. A `.json` file downloads.
3. Open it in a text editor, copy the *entire* contents, paste as the
   `FIREBASE_SERVICE_ACCOUNT` secret value.

## 5. Push these updated files

Replace `push-alerts/check-alerts.js`, `push-alerts/package.json`, and
`.github/workflows/check-alerts.yml` in your repo with the versions in this
folder (same paths as before — `.github/workflows/check-alerts.yml` must
stay at exactly that path, not loose at the repo root).

## 6. Test it

Repo → **Actions** tab → **Check phone alerts** → **Run workflow**. Then
check the run's log — it'll say how many alerts it sent. If your ntfy app is
subscribed to the right topic, you should get a notification on your phone
within a few seconds, even with the phone locked.

## What you can ignore from the old setup

The `index.html` "Alertes Tél." button and its push-subscribe code, the
`pushSubscriptions` Firestore collection, and the VAPID keys are no longer
part of the critical path — background alerts now come entirely from GitHub
Actions → ntfy. You can leave that old code in place (it's harmless and
still gives an in-app sound/notification when the tab is open) or remove it
later if you want to tidy up — just ask and I'll strip it out.

## Good to know

- **Timezone**: `check-alerts.js` reads the current time in
  `Africa/Casablanca`. Change the `TIMEZONE` constant at the top of that file
  if your shop uses a different one.
- **Scheduling isn't second-precise** — GitHub's cron can slip a few minutes
  under load. Fine here given the thresholds have 20+ minutes of slack.
- If the whole repo goes 60 days with no commits, GitHub auto-disables
  scheduled workflows — any small commit re-enables it.
- ntfy is a public, free service — don't put anything sensitive (employee
  names are fine; nothing more secret than that) in the alert text, and keep
  the topic name unguessable.
