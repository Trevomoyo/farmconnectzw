/**
 * FarmConnectZW — Express Backend Server
 * Full Version — No lines omitted.
 */

require('dotenv').config();

// Debug logs to verify .env loading
console.log('DEBUG: VAPID_PUBLIC_KEY is:', process.env.VAPID_PUBLIC_KEY ? 'Present' : 'MISSING');
console.log('DEBUG: VAPID_PRIVATE_KEY is:', process.env.VAPID_PRIVATE_KEY ? 'Present' : 'MISSING');

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
const PORT = process.env.PORT || 3000;

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
} else {
  console.warn('⚠ Firebase Admin: not configured — protected routes will be unavailable');
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
} else {
  console.warn('⚠ Web Push: VAPID keys not set');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({
  // Fixes the "Silent Failure" by allowing Google Auth popup communication
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

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 30 });
app.use(limiter);
app.use('/api/', apiLimiter);

// Serve static files
app.use(express.static(path.join(__dirname), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    firebase: firebaseReady ? 'connected' : 'not configured',
    push: pushReady ? 'enabled' : 'disabled',
    timestamp: new Date().toISOString()
  });
});

// Weather Proxy (Protects OWM_KEY)
app.get('/api/weather', async (req, res) => {
  const OWM_KEY = process.env.OWM_KEY;
  if (!OWM_KEY) return res.status(500).json({ error: 'OWM_KEY not set' });
  const district = (req.query.district || 'Harare').trim();
  try {
    const [curRes, fcastRes] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(district)},ZW&units=metric&appid=${OWM_KEY}`),
      fetch(`https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(district)},ZW&units=metric&cnt=8&appid=${OWM_KEY}`)
    ]);
    if (!curRes.ok) return res.status(curRes.status).json({ error: 'Weather fetch failed' });
    const cur = await curRes.json();
    const fcast = fcastRes.ok ? await fcastRes.json() : null;
    res.json({
      city: cur.name,
      temp: Math.round(cur.main.temp),
      description: cur.weather[0].description,
      icon: cur.weather[0].icon,
      humidity: cur.main.humidity,
      windSpeed: Math.round(cur.wind.speed),
      todayMin: Math.round(cur.main.temp_min),
      todayMax: Math.round(cur.main.temp_max)
    });
  } catch (e) { res.status(500).json({ error: 'Weather service unavailable' }); }
});

// VAPID public key — needed by browser to subscribe to Web Push
app.get('/api/push/vapid-key', (req, res) => {
  if (!pushReady) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Push Subscription Storage
app.post('/api/push/subscribe', verifyToken, async (req, res) => {
  if (!pushReady || !db) return res.status(503).json({ error: 'Service unavailable' });
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  try {
    await db.collection('users').doc(req.user.uid).update({
      pushSubscription: subscription,
      pushUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Broadcast Alert (Admin Only)
app.post('/api/push/broadcast', verifyToken, requireAdmin, async (req, res) => {
  if (!pushReady || !db) return res.status(503).json({ error: 'Push not configured' });
  const { title, body, url } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
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

// Notification for Messages
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

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'login.html')));

app.listen(PORT, () => {
  console.log(`\nFarmConnectZW server running on http://localhost:${PORT}`);
  console.log(`Firebase: ${firebaseReady ? '✓' : '✗'}`);
  console.log(`Push:     ${pushReady     ? '✓' : '✗'}`);
  console.log(`Weather:  ${process.env.OWM_KEY ? '✓' : '✗'}\n`);
});
