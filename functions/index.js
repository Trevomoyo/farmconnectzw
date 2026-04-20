/**
 * FarmConnectZW — Cloud Functions
 *
 * Functions:
 * 1. onNewUser       — Firestore trigger: sets up new user doc on registration
 * 2. sendAlert       — HTTP: admin posts alert → sends push to all FCM tokens
 * 3. weatherProxy    — HTTP: proxies OpenWeatherMap so API key stays server-side
 * 4. onNewMessage    — Firestore trigger: sends push notification to message recipient
 */

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const fetch     = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

// ── 1. New User Setup ─────────────────────────────────────────────────────────
// Triggered when a user registers via Google Sign-In (Auth trigger)
// Creates a users doc if it doesn't exist yet
exports.onNewAuthUser = functions.auth.user().onCreate(async (user) => {
  const ref = db.collection('users').doc(user.uid);
  const snap = await ref.get();
  if (snap.exists) return; // already created by registration form

  await ref.set({
    uid:      user.uid,
    name:     user.displayName || '',
    email:    user.email || '',
    phone:    '',
    district: '',
    role:     'farmer', // default — admin promotes via console
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  functions.logger.info('New user doc created:', user.uid);
});

// ── 2. Weather Proxy ──────────────────────────────────────────────────────────
// GET /api/weather?district=Kwekwe
// Keeps the OpenWeatherMap key server-side
const OWM_KEY = functions.config().owm?.key || '';

exports.weatherProxy = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const district = req.query.district || 'Harare';

  if (!OWM_KEY) {
    res.status(500).json({ error: 'Weather API key not configured' });
    return;
  }

  try {
    const [curRes, fcastRes] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(district)},ZW&units=metric&appid=${OWM_KEY}`),
      fetch(`https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(district)},ZW&units=metric&cnt=8&appid=${OWM_KEY}`)
    ]);

    const cur   = await curRes.json();
    const fcast = await fcastRes.json();

    let todayMin = cur.main.temp;
    let todayMax = cur.main.temp;
    const todayStr = new Date().toISOString().split('T')[0];
    if (fcast.list) {
      fcast.list.filter(s => s.dt_txt.includes(todayStr)).forEach(s => {
        if (s.main.temp_min < todayMin) todayMin = s.main.temp_min;
        if (s.main.temp_max > todayMax) todayMax = s.main.temp_max;
      });
    }

    res.json({
      city:        cur.name,
      temp:        Math.round(cur.main.temp),
      feelsLike:   Math.round(cur.main.feels_like),
      description: cur.weather[0].description,
      icon:        cur.weather[0].icon,
      humidity:    cur.main.humidity,
      windSpeed:   Math.round(cur.wind.speed),
      clouds:      cur.clouds.all,
      todayMin:    Math.round(todayMin),
      todayMax:    Math.round(todayMax)
    });
  } catch (e) {
    functions.logger.error('Weather proxy error:', e);
    res.status(500).json({ error: 'Weather fetch failed' });
  }
});

// ── 3. Push Notification on New Alert ────────────────────────────────────────
// Triggered when an alert doc is created in Firestore
exports.onNewAlert = functions.firestore
  .document('alerts/{alertId}')
  .onCreate(async (snap) => {
    const alert = snap.data();
    if (!alert.active) return;

    // Get all FCM tokens from users
    const usersSnap = await db.collection('users').get();
    const tokens = [];
    usersSnap.docs.forEach(d => {
      const fcmToken = d.data().fcmToken;
      if (fcmToken) tokens.push(fcmToken);
    });

    if (!tokens.length) {
      functions.logger.info('No FCM tokens found — skipping push');
      return;
    }

    const message = {
      notification: {
        title: `🚨 ${alert.title}`,
        body:  alert.message
      },
      data: {
        type:     'alert',
        alertId:  snap.id,
        severity: alert.severity || 'low'
      },
      tokens
    };

    try {
      const response = await admin.messaging().sendEachForMulticast(message);
      functions.logger.info(`Alert push sent: ${response.successCount} success, ${response.failureCount} failed`);

      // Clean up invalid tokens
      const invalidTokenDocs = [];
      response.responses.forEach((r, i) => {
        if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
          invalidTokenDocs.push(tokens[i]);
        }
      });
      if (invalidTokenDocs.length) {
        const batch = db.batch();
        const staleSnap = await db.collection('users').where('fcmToken', 'in', invalidTokenDocs).get();
        staleSnap.docs.forEach(d => batch.update(d.ref, { fcmToken: admin.firestore.FieldValue.delete() }));
        await batch.commit();
      }
    } catch (e) {
      functions.logger.error('Push send error:', e);
    }
  });

// ── 4. Push Notification on New Message ──────────────────────────────────────
exports.onNewMessage = functions.firestore
  .document('messages/{msgId}')
  .onCreate(async (snap) => {
    const msg = snap.data();
    if (!msg.recipientId || !msg.senderId) return;

    // Get recipient's FCM token
    const recipientDoc = await db.collection('users').doc(msg.recipientId).get();
    if (!recipientDoc.exists) return;

    const fcmToken = recipientDoc.data().fcmToken;
    if (!fcmToken) return;

    const senderName = msg.senderName || 'Someone';

    try {
      await admin.messaging().send({
        token: fcmToken,
        notification: {
          title: `💬 New message from ${senderName}`,
          body:  msg.text ? msg.text.slice(0, 100) : 'You have a new message'
        },
        data: {
          type:      'message',
          senderId:  msg.senderId,
          senderName
        }
      });
      functions.logger.info('Message push sent to:', msg.recipientId);
    } catch (e) {
      functions.logger.warn('Message push failed:', e.message);
    }
  });
