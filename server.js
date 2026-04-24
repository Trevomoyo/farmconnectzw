

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
const crypto     = require('crypto'); // Added crypto to top level

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

// ── Paynow Helper (Fixed Hashing Logic) ───────────────────────────────────────
function generatePaynowHash(fields, statusKey) {
  // 1. Sort keys alphabetically (CRITICAL for Paynow)
  const sortedKeys = Object.keys(fields).sort();
  let hashString = "";

  // 2. Concatenate values of all fields except the hash itself
  sortedKeys.forEach((key) => {
    if (key !== 'hash') {
      hashString += fields[key];
    }
  });

  // 3. Append Integration Key and generate MD5
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
  origin: ['https://farmconnectzw.web.app', 'https://farmconnectzw.firebaseapp.com'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Added for Paynow callback support

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

// ── Weather Route (Unchanged Logic) ───────────────────────────────────────────
app.get('/api/weather', async (req, res) => {
  const OWM_KEY = (process.env.OWM_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!OWM_KEY) return res.status(500).json({ error: 'OWM_KEY not set' });
  const district = (req.query.district || 'Harare').trim();
  try {
    const [curRes, fcastRes] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(district)},ZW&units=metric&appid=${OWM_KEY}`),
      fetch(`https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(district)},ZW&units=metric&cnt=8&appid=${OWM_KEY}`)
    ]);
    const cur   = await curRes.json();
    const fcast = fcastRes.ok ? await fcastRes.json() : null;

    let todayMin = cur.main.temp;
    let todayMax = cur.main.temp;
    if (fcast && fcast.list) {
      const todayStr = new Date().toISOString().split('T')[0];
      fcast.list.filter(s => s.dt_txt.startsWith(todayStr)).forEach(s => {
        if (s.main.temp_min < todayMin) todayMin = s.main.temp_min;
        if (s.main.temp_max > todayMax) todayMax = s.main.temp_max;
      });
    }

    res.json({
      city: cur.name,
      temp: Math.round(cur.main.temp),
      feelsLike: Math.round(cur.main.feels_like),
      description: cur.weather[0].description,
      icon: cur.weather[0].icon,
      humidity: cur.main.humidity,
      windSpeed: Math.round(cur.wind.speed),
      clouds: cur.clouds.all,
      todayMin: Math.round(todayMin),
      todayMax: Math.round(todayMax)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Payment Routes (Fixed Hashing) ─────────────────────────────────────────────
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
    const crypto    = require('crypto');
    const reference = 'FCZ-' + Date.now();
    const itemDesc  = (items || []).map(i => i.name + ' x' + i.qty).join(', ').slice(0, 100);
    const baseUrl   = process.env.RENDER_EXTERNAL_URL || 'https://farmconnectzw.onrender.com';

    const fields = {
      additionalinfo: itemDesc || "FarmConnect Order",
      amount: parseFloat(amount).toFixed(2),
      authemail: req.user.email || '',
      id: PAYNOW_ID,
      reference: reference,
      resulturl: baseUrl + '/api/payment/callback',
      returnurl: baseUrl + '/marketplace.html',
      status: 'Message'
    };

    if (['ecocash','onemoney','innbucks'].includes(method)) {
      fields.method = method;
      fields.phone  = phone;
    }

    // 1. Sort keys alphabetically (Mandatory for Paynow)
    const sortedKeys = Object.keys(fields).sort();

    // 2. Concatenate values
    let hashString = '';
    for (const key of sortedKeys) {
      hashString += fields[key];
    }

    // 3. Append Integration Key
    hashString += PAYNOW_KEY;

    // 4. Hash using SHA-512 (Mandatory for Paynow)
    fields.hash = crypto.createHash('sha512').update(hashString).digest('hex').toUpperCase();

    const pnRes = await fetch('https://www.paynow.co.zw/interface/initiatetransaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString()
    });

    const parsedText = await pnRes.text();
    // Paynow sends back a URL-encoded string, Parse it:
    const parsed = Object.fromEntries(new URLSearchParams(parsedText));

    if ((parsed.status || '').toLowerCase() === 'ok') {
      res.json({ success: true, reference, pollUrl: parsed.pollurl });
    } else {
      res.json({ success: false, error: parsed.error || 'Payment initiation failed' });
    }
  } catch (e) {
    console.error('Payment error:', e.message);
    res.status(500).json({ error: 'Payment service error' });
    
  }
 
app.listen(PORT, '0.0.0.0', () => console.log(`✓ Server running on port ${PORT}`));

