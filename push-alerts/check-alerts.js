/**
 * check-alerts.js
 * ----------------
 * Runs on a schedule (via GitHub Actions — see ../.github/workflows/check-alerts.yml).
 * Reads the live timesheet from Firestore, works out who has crossed a threshold
 * (the exact same rules as computeShift() in index.html), and sends an alert to
 * your phone via ntfy (https://ntfy.sh) — a free push service with its own app.
 * This is what makes alerts arrive even when the app is closed and the screen
 * is locked, and it doesn't depend on the browser's own Web Push support at
 * all, which is what was failing before.
 *
 * Required environment variables (set as GitHub Actions secrets — see README.md):
 *   FIREBASE_SERVICE_ACCOUNT  Full JSON of a Firebase service account key (one line)
 *   NTFY_TOPIC                Your private, unguessable ntfy topic name
 */

const admin = require('firebase-admin');

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
if (!process.env.NTFY_TOPIC) {
  console.error('Missing NTFY_TOPIC env var.');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();


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

/* ============================================================
   BUILD THE ntfy MESSAGE
   ============================================================ */
function buildMessage(emp, level, kind) {
  const name = emp.name || 'Employé';
  const badgeLabel = emp.badge || '—';
  const urgent = level === 'crit';

  let body;
  if (level === 'warn') body = 'Approche des 4h50 sans pause (4h30 atteintes).';
  else if (kind === 'brk') body = 'Pause dépassée (plus de 30 min).';
  else body = 'Limite de 4h50 atteinte — pause immédiate requise.';

  return {
    title: name + ' — Badge ' + badgeLabel,
    body: body,
    priority: urgent ? 5 : 4, // 5 = urgent, 4 = high
    tags: urgent ? ['rotating_light'] : ['warning']
  };
}

// NOTE: we publish as JSON (not HTTP headers) because headers can't carry
// characters like "—" or Arabic/accented names — Node throws and nothing is sent.
async function sendNtfy(msg) {
  const res = await fetch('https://ntfy.sh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      topic: process.env.NTFY_TOPIC,
      title: msg.title,
      message: msg.body,
      priority: msg.priority,
      tags: msg.tags
    })
  });
  if (!res.ok) {
    throw new Error('ntfy responded ' + res.status + ': ' + (await res.text()));
  }
}

/* ============================================================
   MAIN
   ============================================================ */
async function main() {
  // Manual test: Actions -> Run workflow -> tick "test". Sends one message and stops.
  if (process.env.NTFY_TEST === 'true') {
    await sendNtfy({
      title: 'Test — CSM alerts',
      body: 'Si vous voyez ceci, ntfy fonctionne.',
      priority: 5,
      tags: ['rotating_light']
    });
    console.log('Test notification sent.');
    return;
  }

  const t = nowMinutes();

  const timesheetDoc = await db.collection('timesheets').doc('current').get();
  const employees = (timesheetDoc.exists && timesheetDoc.data().employees) || [];

  const stateDoc = await db.collection('pushAlertState').doc('current').get();
  const notifiedState = (stateDoc.exists && stateDoc.data().state) || {};
  const seenBadges = new Set();

  const toSend = [];

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
      toSend.push({ badgeKey, prev: notifiedState[badgeKey], msg: buildMessage(emp, level, kind) });
      notifiedState[badgeKey] = level;
    }
  });

  // An employee who's no longer in alert can be notified again later
  Object.keys(notifiedState).forEach(b => {
    if (!seenBadges.has(b)) delete notifiedState[b];
  });

  console.log(toSend.length + ' new alert(s) to send this run.');

  let failures = 0;
  for (const item of toSend) {
    try {
      await sendNtfy(item.msg);
      console.log('Sent: ' + item.msg.title);
    } catch (err) {
      failures++;
      console.error('ntfy send failed:', err.message);
      // Un-mark it so the next run (3 min later) tries again
      if (item.prev === undefined) delete notifiedState[item.badgeKey];
      else notifiedState[item.badgeKey] = item.prev;
    }
  }

  await db.collection('pushAlertState').doc('current').set({
    state: notifiedState,
    updatedAt: new Date().toISOString()
  });

  console.log('Done.');
  if (failures > 0) process.exit(1); // makes the Actions run show red
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

