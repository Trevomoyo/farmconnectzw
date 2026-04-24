/**
 * FarmConnectZW — Express Backend Server
 * Full Version — No lines omitted.
 */

require('dotenv').config();

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const fetch      = require('node-fetch');
const webpush    = require('web-push');
const admin      = require('firebase-admin');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 10000;

// ── Firebase Admin Init ───────────────────────────────────────────────────────
let firebaseReady = false;
const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');

if (fs.existsSync(serviceAccountPath)) {
  admin.initializeApp({
    credential: admin.credential.cert(require(serviceAccountPath))
  });
  firebaseReady = true;
  console.log('✓ Firebase Admin: initialized from service account file');
} else if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
  firebaseReady = true;
  console.log('✓ Firebase Admin: initialized from env variables');
}

const db = firebaseReady ? admin.firestore() : null;

// ── Web Push (VAPID) Init ─────────────────────────────────────────────────────
let pushReady = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@farmconnectzw.zw',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  pushReady = true;
  console.log('✓ Web Push: VAPID keys configured');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }, 
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://www.gstatic.com", "https://unpkg.com", "https://fonts.googleapis.com", "https://apis.google.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://firestore.googleapis.com", "https://identitytoolkit.googleapis.com",
                   "https://securetoken.googleapis.com", "https://api.openweathermap.org",
                   "https://*.tile.openstreetmap.org", "wss://firestore.googleapis.com",
                   "https://www.gstatic.com", "https://unpkg.com",
                   "https://accounts.google.com", "https://oauth2.googleapis.com"],
      frameSrc:   ["'self'", "https://farmconnectzw.firebaseapp.com", "https://farmconnectzw.web.app",
                   "https://accounts.google.com"],
      workerSrc:  ["'self'", "blob:"],
      mediaSrc:   ["'self'"]
    }
  }
}));

// CORS Fix: Allow your Firebase domain
app.use(cors({
  origin: [
    'https://farmconnectzw.web.app',
    'https://farmconnectzw.firebaseapp.com'
  ],
  credentials: true
}));

app.use(express.json());

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

// ── Auth Middleware ───────────────────────────────────────────────────────────
async function verifyToken(req, res, next) {
  if (!firebaseReady) return res.status(503).json({ error: 'Auth service not configured' });
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = await admin.auth().verifyIdToken(header.split('Bearer ')[1]);
    next();
  } catch (e) { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

async function requireAdmin(req, res, next) {
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  try {
    const snap = await db.collection('users').doc(req.user.uid).get();
    if (!snap.exists || snap.data().role !== 'administrator') return res.status(403).json({ error: 'Admin access required' });
    req.userDoc = snap.data();
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', firebase: firebaseReady ? 'connected' : 'not configured', push: pushReady ? 'enabled' : 'disabled' });
});

app.get('/api/weather', async (req, res) => {
  const OWM_KEY = (process.env.OWM_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!OWM_KEY) return res.status(500).json({ error: 'OWM_KEY not set in environment variables' });
  const district = (req.query.district || 'Harare').trim() || 'Harare';
  try {
    // Fetch current weather AND 3-hourly forecast in parallel
    const [curRes, fcastRes] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(district)},ZW&units=metric&appid=${OWM_KEY}`),
      fetch(`https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(district)},ZW&units=metric&cnt=8&appid=${OWM_KEY}`)
    ]);
    if (!curRes.ok) {
      const errBody = await curRes.json().catch(() => ({}));
      return res.status(curRes.status).json({ error: errBody.message || 'Weather fetch failed' });
    }
    const cur   = await curRes.json();
    const fcast = fcastRes.ok ? await fcastRes.json() : null;

    // Derive true today min/max from 3-hourly slots
    let todayMin = cur.main.temp;
    let todayMax = cur.main.temp;
    if (fcast && fcast.list) {
      const todayStr = new Date().toISOString().split('T')[0];
      fcast.list
        .filter(s => s.dt_txt.startsWith(todayStr))
        .forEach(s => {
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
    console.error('Weather error:', e.message);
    res.status(500).json({ error: 'Weather service unavailable: ' + e.message });
  }
});

app.get('/api/push/vapid-key', (req, res) => {
  if (!pushReady) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', verifyToken, async (req, res) => {
  if (!pushReady || !db) return res.status(503).json({ error: 'Service unavailable' });
  const { subscription } = req.body;
  try {
    await db.collection('users').doc(req.user.uid).update({
      pushSubscription: subscription,
      pushUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/push/broadcast', verifyToken, requireAdmin, async (req, res) => {
  if (!pushReady || !db) return res.status(503).json({ error: 'Push not configured' });
  const { title, body, url } = req.body;
  try {
    const usersSnap = await db.collection('users').get();
    const payload = JSON.stringify({ title, body: body || '', url: url || '/notifications.html' });
    let sent = 0;
    await Promise.allSettled(
      usersSnap.docs
        .filter(d => d.data().pushSubscription)
        .map(async d => {
          await webpush.sendNotification(d.data().pushSubscription, payload);
          sent++;
        })
    );
    res.json({ success: true, sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notify/message', verifyToken, async (req, res) => {
  if (!pushReady || !db) return res.json({ success: false });
  const { recipientId, senderName, preview } = req.body;
  try {
    const snap = await db.collection('users').doc(recipientId).get();
    if (!snap.exists || !snap.data().pushSubscription) return res.json({ success: false });
    const payload = JSON.stringify({
      title: `💬 Message from ${senderName}`,
      body: preview ? preview.slice(0, 100) : 'New message',
      url: '/messages.html'
    });
    await webpush.sendNotification(snap.data().pushSubscription, payload);
    res.json({ success: true });
  } catch (e) { res.json({ success: false }); }
});

// ── Payment Initiation ───────────────────────────────────────────────────────
app.post('/api/payment/initiate', verifyToken, async (req, res) => {
  const { phone, method, amount, items } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  if (method === 'cash') {
    return res.json({ success: true, reference: 'CASH-' + Date.now(), message: 'Cash order placed' });
  }

  const PAYNOW_ID  = process.env.PAYNOW_ID;
  const PAYNOW_KEY = process.env.PAYNOW_KEY;

  if (!PAYNOW_ID || !PAYNOW_KEY) {
    console.warn('Paynow keys not set — order recorded as pending');
    return res.json({ success: true, reference: 'PENDING-' + Date.now(), paynow: false, message: 'Order recorded. Add PAYNOW_ID and PAYNOW_KEY to Render env vars to enable live payments.' });
  }

  try {
    const crypto     = require('crypto');
    const reference  = 'FCZ-' + Date.now();
    const itemDesc   = (items || []).map(i => i.name + ' x' + i.qty).join(', ').slice(0, 100);
    const baseUrl    = (process.env.RENDER_EXTERNAL_URL || 'https://farmconnectzw.onrender.com').replace(/\/+$/, '');
    const isMobile   = ['ecocash','onemoney','innbucks'].includes(method);
    const amount_str = Number(amount).toFixed(2);
    const returnurl  = baseUrl + '/marketplace.html';
    const resulturl  = baseUrl + '/api/payment/callback';
    const authemail  = req.user.email || '';

    // ── Paynow Hash (FIXED) ────────────────────────────────────────────────
    // Per Paynow docs: hash = MD5( value1 + value2 + ... + integrationKey )
    // Values must be in the EXACT same order as the POST fields.
    // For web initiation field order:
    //   id, reference, amount, additionalinfo, returnurl, resulturl, status, authemail
    // Then append the raw integration key (NOT URL-encoded) at the end.
    // Result must be uppercase hex.
    // Source: https://developers.paynow.co.zw/docs/initiating_transactions.html
    // ─────────────────────────────────────────────────────────────────────

    let hashInput, postData, paynowUrl;

    if (!isMobile) {
      // Web / redirect transaction
      hashInput = String(PAYNOW_ID) + reference + amount_str + itemDesc +
                  returnurl + resulturl + 'Message' + authemail + PAYNOW_KEY;
      const hash = crypto.createHash('md5').update(hashInput).digest('hex').toUpperCase();

      postData = new URLSearchParams({
        id:             String(PAYNOW_ID),
        reference,
        amount:         amount_str,
        additionalinfo: itemDesc,
        returnurl,
        resulturl,
        status:         'Message',
        authemail,
        hash
      });
      paynowUrl = 'https://www.paynow.co.zw/interface/initiatetransaction';

    } else {
      // Mobile money transaction (EcoCash / OneMoney / InnBucks)
      // Normalise phone to international format 263XXXXXXXXX
      const normPhone = ('263' + phone.replace(/^\+?26[34]|^0/, '').replace(/\D/g,'')).slice(0, 12);

      // Mobile field order: id, reference, amount, additionalinfo, returnurl, resulturl, status, authemail, phone, method
      hashInput = String(PAYNOW_ID) + reference + amount_str + itemDesc +
                  returnurl + resulturl + 'Message' + authemail +
                  normPhone + method + PAYNOW_KEY;
      const hash = crypto.createHash('md5').update(hashInput).digest('hex').toUpperCase();

      postData = new URLSearchParams({
        id:             String(PAYNOW_ID),
        reference,
        amount:         amount_str,
        additionalinfo: itemDesc,
        returnurl,
        resulturl,
        status:         'Message',
        authemail,
        phone:          normPhone,
        method,
        hash
      });
      paynowUrl = 'https://www.paynow.co.zw/interface/remotetransaction';
    }

    const pnRes = await fetch(paynowUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: postData.toString()
    });
    const rawText = await pnRes.text();
    console.log('Paynow raw response:', rawText);

    // Parse Paynow's URL-encoded response
    const parsed = {};
    rawText.split('&').forEach(pair => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > -1) {
        parsed[decodeURIComponent(pair.slice(0, eqIdx))] = decodeURIComponent(pair.slice(eqIdx + 1));
      }
    });

    const pnStatus = (parsed.status || '').toLowerCase();
    if (pnStatus === 'ok' || pnStatus === 'sent') {
      res.json({ success: true, reference, pollUrl: parsed.pollurl || null, redirectUrl: parsed.browserurl || null });
    } else {
      console.error('Paynow rejected:', parsed);
      res.json({ success: false, error: parsed.error || ('Paynow status: ' + (parsed.status || 'unknown')) });
    }
  } catch (e) {
    console.error('Payment error:', e.message);
    res.status(500).json({ error: 'Payment service error: ' + e.message });
  }
});

app.post('/api/payment/callback', async (req, res) => {
  const { reference, status, paynowreference } = req.body;
  if (db && reference) {
    try {
      const snap = await db.collection('orders').where('reference','==',reference).limit(1).get();
      if (!snap.empty) await snap.docs[0].ref.update({ status: (status||'').toLowerCase() === 'paid' ? 'paid' : 'payment_failed', paynowReference: paynowreference || null });
    } catch(e) { console.error('Callback error:', e.message); }
  }
  res.send('OK');
});


// Final listener for Render
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
