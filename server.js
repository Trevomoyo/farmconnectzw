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
  const OWM_KEY = process.env.OWM_KEY;
  if (!OWM_KEY) return res.status(500).json({ error: 'OWM_KEY not set' });
  const district = (req.query.district || 'Kwekwe').trim();
  try {
    const curRes = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(district)},ZW&units=metric&appid=${OWM_KEY}`);
    if (!curRes.ok) return res.status(curRes.status).json({ error: 'Weather fetch failed' });
    const cur = await curRes.json();
    res.json({
      city: cur.name,
      temp: Math.round(cur.main.temp),
      description: cur.weather[0].description,
      humidity: cur.main.humidity
    });
  } catch (e) { res.status(500).json({ error: 'Weather service unavailable' }); }
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

// Final listener for Render
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
