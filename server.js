/**
 * FarmConnectZW — Express Backend Server
 * Integrated Security Version
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
const crypto     = require('crypto'); // Needed for hashing

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

// ── Paynow Helper Functions ───────────────────────────────────────────────────
function generatePaynowHash(fields, statusKey) {
  // Paynow requires keys to be sorted alphabetically before concatenation
  const sortedKeys = Object.keys(fields).sort();
  let hashString = "";

  sortedKeys.forEach((key) => {
    if (key !== 'hash') { // Never include the hash itself in the string
      hashString += fields[key];
    }
  });

  hashString += statusKey;

  return crypto
    .createHash("md5")
    .update(hashString)
    .digest("hex")
    .toUpperCase();
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
  origin: [
    'https://farmconnectzw.web.app',
    'https://farmconnectzw.firebaseapp.com',
    'http://localhost:3000'
  ],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Added to parse Paynow's URL-encoded callbacks

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

// ── Weather & Push Routes ─────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', firebase: firebaseReady ? 'connected' : 'not configured', push: pushReady ? 'enabled' : 'disabled' });
});

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
    res.json({ city: cur.name, temp: Math.round(cur.main.temp), description: cur.weather[0].description });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Payment Initiation (Fixed Hashing) ────────────────────────────────────────
app.post('/api/payment/initiate', verifyToken, async (req, res) => {
  const { phone, method, amount, items } = req.body;
  const PAYNOW_ID  = process.env.PAYNOW_ID;
  const PAYNOW_KEY = process.env.PAYNOW_KEY;

  if (!PAYNOW_ID || !PAYNOW_KEY) {
    return res.json({ success: true, reference: 'PENDING-' + Date.now(), message: 'Demo Mode: Keys Missing' });
  }

  try {
    const reference = 'FCZ-' + Date.now();
    const itemDesc  = (items || []).map(i => i.name + ' x' + i.qty).join(', ').slice(0, 100);
    const baseUrl   = process.env.RENDER_EXTERNAL_URL || 'https://farmconnectzw.onrender.com';

    const fields = {
      id: PAYNOW_ID,
      reference,
      amount: parseFloat(amount).toFixed(2),
      additionalinfo: itemDesc || "FarmConnect Order",
      returnurl: baseUrl + '/marketplace.html',
      resulturl: baseUrl + '/api/payment/callback',
      status: 'Message',
      authemail: req.user.email || ''
    };

    if (['ecocash','onemoney','innbucks'].includes(method)) {
      fields.phone  = phone;
      fields.method = method;
    }

    // Use the robust sorting hash function
    fields.hash = generatePaynowHash(fields, PAYNOW_KEY);

    const pnRes = await fetch('https://www.paynow.co.zw/interface/initiatetransaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString()
    });

    const text = await pnRes.text();
    const parsed = Object.fromEntries(new URLSearchParams(text));

    if (parsed.status.toLowerCase() === 'ok') {
      res.json({ success: true, reference, pollUrl: parsed.pollurl });
    } else {
      res.json({ success: false, error: parsed.error });
    }
  } catch (e) {
    res.status(500).json({ error: 'Payment initiation failed' });
  }
});

// ── Payment Callback (Added Hash Validation) ──────────────────────────────────
app.post('/api/payment/callback', async (req, res) => {
  const PAYNOW_KEY = process.env.PAYNOW_KEY;
  const data = req.body;
  const receivedHash = data.hash;

  // Validate the hash to ensure this message actually came from Paynow
  const calculatedHash = generatePaynowHash(data, PAYNOW_KEY);

  if (receivedHash !== calculatedHash) {
    console.warn('⚠️ Malicious/Invalid callback received!');
    return res.status(403).send('Invalid Hash');
  }

  if (db && data.reference) {
    try {
      const isPaid = data.status.toLowerCase() === 'paid' || data.status.toLowerCase() === 'awaiting delivery';
      const snap = await db.collection('orders').where('reference', '==', data.reference).limit(1).get();
      
      if (!snap.empty) {
        await snap.docs[0].ref.update({ 
          status: isPaid ? 'paid' : 'payment_failed', 
          paynowReference: data.paynowreference || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    } catch(e) { console.error('Callback DB Error:', e.message); }
  }
  res.send('OK');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Server running on port ${PORT}`);
});
