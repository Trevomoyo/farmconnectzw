/**
 * FarmConnectZW — Express Backend Server
 * Final Optimized Version - Fixes Weather UI & Paynow Hashing
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
const crypto     = require('crypto');

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
} else if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
  firebaseReady = true;
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
}

// ── Paynow Hashing Helper ───────────────────────────────────────────────────
function generatePaynowHash(fields, statusKey) {
  const sortedKeys = Object.keys(fields).sort();
  let hashString = "";
  sortedKeys.forEach((key) => {
    if (key !== 'hash') hashString += fields[key];
  });
  hashString += statusKey;
  return crypto.createHash("md5").update(hashString).digest("hex").toUpperCase();
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

app.use(cors({
  origin: ['https://farmconnectzw.web.app', 'https://farmconnectzw.firebaseapp.com'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// ── Weather Route (FIXED KEYS) ────────────────────────────────────────────────
app.get('/api/weather', async (req, res) => {
  const OWM_KEY = (process.env.OWM_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!OWM_KEY) return res.status(500).json({ error: 'OWM_KEY not set' });
  const district = (req.query.district || 'Harare').trim();
  try {
    const [curRes, fcastRes] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(district)},ZW&units=metric&appid=${OWM_KEY}`),
      fetch(`https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(district)},ZW&units=metric&cnt=8&appid=${OWM_KEY}`)
    ]);
    const cur = await curRes.json();
    const fcast = fcastRes.ok ? await fcastRes.json() : null;

    res.json({
      city: cur.name,
      temp: Math.round(cur.main.temp),
      feelsLike: Math.round(cur.main.feels_like),
      description: cur.weather[0].description,
      humidity: cur.main.humidity,      // Restored original key
      windSpeed: Math.round(cur.wind.speed), // Restored original key
      clouds: cur.clouds.all,           // Restored original key
      todayMin: Math.round(cur.main.temp_min),
      todayMax: Math.round(cur.main.temp_max)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Payment Initiation (FIXED HASH) ──────────────────────────────────────────
app.post('/api/payment/initiate', verifyToken, async (req, res) => {
  const { phone, method, amount, items } = req.body;
  const PAYNOW_ID  = process.env.PAYNOW_ID;
  const PAYNOW_KEY = process.env.PAYNOW_KEY;

  if (!PAYNOW_ID || !PAYNOW_KEY) return res.json({ success: true, reference: 'DEMO-' + Date.now() });

  try {
    const reference = 'FCZ-' + Date.now();
    const fields = {
      id: PAYNOW_ID,
      reference,
      amount: parseFloat(amount).toFixed(2),
      additionalinfo: (items || []).map(i => i.name).join(', ').slice(0, 100),
      returnurl: 'https://farmconnectzw.web.app/marketplace.html',
      resulturl: 'https://farmconnectzw.onrender.com/api/payment/callback',
      status: 'Message',
      authemail: req.user.email || ''
    };

    if (['ecocash','onemoney','innbucks'].includes(method)) {
      fields.phone = phone;
      fields.method = method;
    }

    fields.hash = generatePaynowHash(fields, PAYNOW_KEY);

    const pnRes = await fetch('https://www.paynow.co.zw/interface/initiatetransaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString()
    });

    const parsed = Object.fromEntries(new URLSearchParams(await pnRes.text()));
    if (parsed.status.toLowerCase() === 'ok') {
      res.json({ success: true, reference, pollUrl: parsed.pollurl });
    } else {
      res.json({ success: false, error: parsed.error });
    }
  } catch (e) { res.status(500).json({ error: 'Payment failed' }); }
});

app.post('/api/payment/callback', async (req, res) => {
  const PAYNOW_KEY = process.env.PAYNOW_KEY;
  const data = req.body;
  const receivedHash = data.hash;
  const calculatedHash = generatePaynowHash(data, PAYNOW_KEY);

  if (receivedHash === calculatedHash && db) {
    const isPaid = data.status.toLowerCase() === 'paid';
    const snap = await db.collection('orders').where('reference', '==', data.reference).limit(1).get();
    if (!snap.empty) {
      await snap.docs[0].ref.update({ 
        status: isPaid ? 'paid' : 'payment_failed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  }
  res.send('OK');
});

app.listen(PORT, '0.0.0.0', () => console.log(`✓ Server running on port ${PORT}`));
