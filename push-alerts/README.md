# Real phone alerts — setup guide

This adds *true* Web Push to Contract Social Manager, so alerts ring even when
the app is closed and the phone is locked. Everything here is free — no
Firebase Blaze plan, no credit card, no paid service anywhere.

## What changed

- `index.html` — subscribes the device to push (alongside the existing
  in-app notification permission), saves the subscription to a new Firestore
  collection `pushSubscriptions`.
- `service-worker.js` — added a `push` listener that displays the
  notification when one arrives from the backend, even with no tab open.
- `push-alerts/check-alerts.js` — a small script that re-runs your 4h30 /
  4h50 / 30-min-break rules against the live Firestore data and sends a push
  to every subscribed phone when something crosses a threshold.
- `.github/workflows/check-alerts.yml` — runs that script every 3 minutes,
  for free, using GitHub Actions (since you're already on GitHub).

## 1. Your VAPID keys (already generated for you)

VAPID keys prove to the push service that pushes are coming from you. These
are real, ready to use — you don't need to run anything to get them:

```
VAPID_PUBLIC_KEY  = BIM16c4X9es9VcfFBg7Zr0jYe_zoxmmJD4JfXSeMrShjzq-oSkVwxJRoYXruq2w7Tde9d9zNPxJQGDzZ2hO05n8
VAPID_PRIVATE_KEY = jWgxWMIXpA0N_aB0yuZJVl_unQYDo2f9jd3Xuckbxig
```

The public key is already placed in `index.html` — no action needed there.
Keep the **private** key only for step 3 below; never put it in `index.html`
or commit it to the repo.

> If you'd rather generate your own pair instead of trusting mine, run
> `npx web-push generate-vapid-keys` anywhere with Node installed, and swap
> the public key into `index.html`'s `VAPID_PUBLIC_KEY` constant too.

## 2. Get a Firebase service account key

The scheduled script needs admin access to Firestore (so it can read the
timesheet and subscriptions without touching your existing security rules).

1. Firebase console → your project (**contractsocialmanager**) → ⚙️ **Project settings** → **Service accounts** tab.
2. Click **Generate new private key** → confirm. A `.json` file downloads.
3. Open that file in a text editor and copy its *entire* contents (it's one JSON object).

This is sensitive — treat it like a password. It only goes into a GitHub
secret (step 3), never into the website's code.

## 3. Add GitHub secrets

In your GitHub repo → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**. Add these four:

| Secret name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Paste the *entire* JSON file from step 2 |
| `VAPID_PUBLIC_KEY` | `BIM16c4X9es9VcfFBg7Zr0jYe_zoxmmJD4JfXSeMrShjzq-oSkVwxJRoYXruq2w7Tde9d9zNPxJQGDzZ2hO05n8` |
| `VAPID_PRIVATE_KEY` | `jWgxWMIXpA0N_aB0yuZJVl_unQYDo2f9jd3Xuckbxig` |
| `VAPID_CONTACT_EMAIL` | `mailto:your-email@example.com` (any address you can be reached at) |

## 4. Update your Firestore security rules

Firebase console → **Firestore Database** → **Rules**. Your existing rules
already protect `timesheets` with the shared secret pattern — add a rule for
the new `pushSubscriptions` collection alongside it (don't remove anything
that's already there):

```
match /pushSubscriptions/{deviceId} {
  // Only the backend script (using the admin service account) can read this
  // collection — the admin SDK bypasses rules entirely, so "read: if false"
  // here is fine and keeps subscription endpoints private from the public.
  allow read: if false;
  allow write: if request.resource.data.secret == "EasyNet-99-Secret";
}

match /pushAlertState/{docId} {
  // Only touched by the backend script (admin SDK bypasses rules).
  allow read, write: if false;
}
```

If your `APP_SECRET` in `index.html` isn't `"EasyNet-99-Secret"`, use your
actual value in the rule above instead.

## 5. Push the files and enable Actions

Commit and push all the changed/added files (`index.html`,
`service-worker.js`, the `push-alerts/` folder, and `.github/workflows/`) to
your GitHub repo. GitHub Actions runs automatically once the workflow file is
in the repo — no extra toggle needed.

To test it immediately instead of waiting: repo → **Actions** tab → **Check
phone alerts** → **Run workflow**.

## 6. Re-enable the phone alerts toggle

Open the app, tap **Alertes Tél.** again to grant notification permission —
this now also subscribes the device for real push in the background. Do this
on each phone that should receive alerts.

## Good to know

- **iOS**: push only works if the app is added to the **Home Screen**
  (Share → Add to Home Screen), not just opened in Safari. Open it from the
  home screen icon once and grant permission from there.
- **Timezone**: `check-alerts.js` reads the current time in `Africa/Casablanca`.
  If your shop clocks in using a different timezone, change the `TIMEZONE`
  constant at the top of that file.
- **GitHub Actions scheduling isn't second-precise** — it can slip by a few
  minutes under load. Fine here since your thresholds have a wide margin.
- If the whole repo goes 60 days with no commits, GitHub auto-disables
  scheduled workflows. A commit (even a small one) re-enables it — worth
  remembering if things go quiet for a couple of months.
- The custom "ringtone" sound (siren, chime, etc.) only plays while the app
  is open — a locked-screen push notification uses the phone's normal
  notification sound/vibration instead. That's a platform limit, not
  something this setup can change.
