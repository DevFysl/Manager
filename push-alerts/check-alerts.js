/**
 * check-alerts.js
 * ----------------
 * Runs on a schedule (via GitHub Actions — see ../.github/workflows/check-alerts.yml).
 * Reads the live timesheet from Firestore, works out who has crossed a threshold
 * (the exact same rules as computeShift() in index.html), and sends a real Web
 * Push notification to every subscribed phone. This is what makes alerts arrive
 * even when the app is closed and the screen is locked — index.html's own
 * checkPhoneAlerts() only runs while a tab is open, so it can't do this alone.
 *
 * Required environment variables (set as GitHub Actions secrets — see README.md):
 *   FIREBASE_SERVICE_ACCOUNT  Full JSON of a Firebase service account key (one line)
 *   VAPID_PUBLIC_KEY          Same value as VAPID_PUBLIC_KEY in index.html
 *   VAPID_PRIVATE_KEY         Kept secret, never goes in index.html
 *   VAPID_CONTACT_EMAIL       A contact email, e.g. mailto:you@example.com
 */

const admin = require('firebase-admin');
const webpush = require('web-push');

/* ============================================================
   CONFIG — must match the constants in index.html
   ============================================================ */
const SEGMENT_MIN    = 4 * 60 + 50;  // 4h50 continuous segment max
const BREAK_MIN       = 30;          // 30 min mandatory break
const WARN_MIN         = 4 * 60 + 30; // yellow threshold
const CRIT_MIN         = 4 * 60 + 50; // red threshold (limit)
const FULL_NOBREAK_MIN = 10 * 60 + 10; // if no break taken at all

// Timezone the punch times in Firestore are recorded in. Change this if your
// shop is not in Morocco — it must match the phone/PC that enters the times.
const TIMEZONE = 'Africa/Casablanca';

/* ============================================================
   SETUP
   ============================================================ */
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT env var.');
  process.exit(1);
}
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars.');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

webpush.setVapidDetails(
  process.env.VAPID_CONTACT_EMAIL || 'mailto:admin@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

/* ============================================================
   TIME HELPERS
   ============================================================ */
function nowMinutes() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, hour12: false, hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return h * 60 + m;
}

/* ============================================================
   SAME SHIFT-STATUS LOGIC AS index.html's computeShift()
   ============================================================ */
function computeShift(emp, t) {
  const ci = emp.clockIn;
  const out = { status: 'ok', contMinutes: 0, elapsedBreakMinutes: 0 };

  if (ci === null || ci === undefined) {
    out.status = 'nodata';
    return out;
  }

  const hasReturn = emp.breakReturn !== null && emp.breakReturn !== undefined;
  const hasBreakStart = emp.breakStart !== null && emp.breakStart !== undefined;
  const hasClockOut = emp.clockOut !== null && emp.clockOut !== undefined;

  if (hasClockOut) {
    out.status = 'done';
    return out;
  }

  if (hasBreakStart && !hasReturn) {
    let elapsedBreak = t - emp.breakStart;
    if (elapsedBreak < 0) elapsedBreak += 1440;
    out.elapsedBreakMinutes = elapsedBreak;
    out.status = elapsedBreak >= BREAK_MIN ? 'breakover' : 'break';
    return out;
  }

  let cont;
  if (hasReturn) {
    cont = t - emp.breakReturn;
  } else {
    cont = t - ci;
  }
  if (cont < 0) cont += 1440;
  out.contMinutes = cont;

  if (cont >= CRIT_MIN) out.status = 'crit';
  else if (cont >= WARN_MIN) out.status = 'warn';
  else out.status = 'ok';

  return out;
}

function getQuickActionDefs(emp) {
  if (emp.clockOut !== null && emp.clockOut !== undefined) return [];
  if (emp.breakStart === null || emp.breakStart === undefined) {
    return [{ action: 'break', title: 'Départ Pause' }, { action: 'end', title: 'Sortie' }];
  }
  if (emp.breakReturn === null || emp.breakReturn === undefined) {
    return [{ action: 'return', title: 'Retour Pause' }, { action: 'end', title: 'Sortie' }];
  }
  return [{ action: 'end', title: 'Sortie' }];
}

/* ============================================================
   BUILD THE NOTIFICATION PAYLOAD (mirrors sendPhoneAlert() in index.html)
   ============================================================ */
function buildPayload(emp, level, kind) {
  const name = emp.name || 'Employé';
  const badgeLabel = emp.badge || '—';
  const actions = getQuickActionDefs(emp);
  const data = { badge: String(emp.badge || '') };
  const urgent = level === 'crit';

  let body;
  if (level === 'warn') body = 'Approche des 4h50 sans pause (4h30 atteintes).';
  else if (kind === 'brk') body = 'Pause dépassée (plus de 30 min).';
  else body = 'Limite de 4h50 atteinte — pause immédiate requise.';

  return {
    title: name + ' — Badge ' + badgeLabel,
    options: {
      body: body,
      icon: '200.webp',
      badge: '200.webp',
      vibrate: urgent ? [300, 150, 300, 150, 300, 150, 300] : [200, 100, 200],
      tag: 'csm-alert-' + badgeLabel,
      renotify: true,
      requireInteraction: !!urgent,
      actions: actions,
      data: data
    }
  };
}

/* ============================================================
   MAIN
   ============================================================ */
async function main() {
  const t = nowMinutes();

  const timesheetDoc = await db.collection('timesheets').doc('current').get();
  const employees = (timesheetDoc.exists && timesheetDoc.data().employees) || [];

  const stateDoc = await db.collection('pushAlertState').doc('current').get();
  const notifiedState = (stateDoc.exists && stateDoc.data().state) || {};
  const seenBadges = new Set();

  const toSend = []; // [{payload}]

  employees.forEach(emp => {
    const calc = computeShift(emp, t);
    let kind = null, level = null;

    if (calc.status === 'crit' || calc.status === 'breakover') {
      kind = calc.status === 'breakover' ? 'brk' : 'crit';
      level = 'crit';
    } else if (calc.status === 'warn') {
      kind = 'warn';
      level = 'warn';
    } else {
      return; // ok / done / nodata / break(<30min) — nothing to notify
    }

    const badgeKey = String(emp.badge || emp.id || emp.name || Math.random());
    seenBadges.add(badgeKey);

    if (notifiedState[badgeKey] !== level) {
      notifiedState[badgeKey] = level;
      toSend.push(buildPayload(emp, level, kind));
    }
  });

  // An employee who's no longer in alert can be notified again later
  Object.keys(notifiedState).forEach(b => {
    if (!seenBadges.has(b)) delete notifiedState[b];
  });

  console.log(toSend.length + ' new alert(s) to send this run.');

  if (toSend.length > 0) {
    const subsSnap = await db.collection('pushSubscriptions').get();
    const subs = subsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    for (const payload of toSend) {
      for (const subDoc of subs) {
        try {
          await webpush.sendNotification(subDoc.subscription, JSON.stringify(payload));
        } catch (err) {
          console.error('Push failed for device ' + subDoc.id + ':', err.statusCode || err.message);
          if (err.statusCode === 404 || err.statusCode === 410) {
            // Subscription is dead (uninstalled, permissions revoked, etc.) — clean it up.
            await db.collection('pushSubscriptions').doc(subDoc.id).delete().catch(() => {});
          }
        }
      }
    }
  }

  await db.collection('pushAlertState').doc('current').set({
    state: notifiedState,
    updatedAt: new Date().toISOString()
  });

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
