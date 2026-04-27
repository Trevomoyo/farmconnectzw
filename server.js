require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fetch = require('node-fetch');
const webpush = require('web-push');
const admin = require('firebase-admin');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http'); 
const { Server } = require('socket.io');

// New dependencies for rich media handling
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 10000;

// Firebase Admin Setup
let firebaseReady = false;
const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');

if (fs.existsSync(serviceAccountPath)) {
  admin.initializeApp({
    credential: admin.credential.cert(require(serviceAccountPath))
  });
  firebaseReady = true;
  console.log('Firebase Admin ready (service account)');
} else if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
  firebaseReady = true;
  console.log('Firebase Admin ready (env vars)');
}

const db = firebaseReady ? admin.firestore() : null;

// Supabase Storage Setup
let supabaseReady = false;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 
let supabase = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  supabaseReady = true;
  console.log('Supabase client ready for storage');
}

// Multer config for in-memory uploads before piping to Supabase
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB cap for media
});

// Web Push Setup
let pushReady = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@farmconnectzw.co.zw',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  pushReady = true;
  console.log('Web Push keys configured');
}

// Security & Middleware
app.use(helmet({
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }, 
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://www.gstatic.com", "https://unpkg.com", "https://fonts.googleapis.com", "https://apis.google.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https:", "blob:", supabaseUrl ? `${supabaseUrl}/*` : ""],
      connectSrc: ["'self'", "https://firestore.googleapis.com", "https://identitytoolkit.googleapis.com",
                   "https://securetoken.googleapis.com", "https://api.openweathermap.org",
                   "https://*.tile.openstreetmap.org", "wss://firestore.googleapis.com",
                   "https://www.gstatic.com", "https://unpkg.com",
                   "https://accounts.google.com", "https://oauth2.googleapis.com",
                   supabaseUrl || "",
                   "ws:", 
                   "wss:" 
                  ],
      frameSrc:   ["'self'", "https://farmconnectzw.firebaseapp.com", "https://farmconnectzw.web.app",
                   "https://accounts.google.com"],
      workerSrc:  ["'self'", "blob:"],
      mediaSrc:   ["'self'", supabaseUrl ? `${supabaseUrl}/*` : ""]
    }
  }
}));

app.use(cors({
  origin: [
    'https://farmconnectzw.web.app',
    'https://farmconnectzw.firebaseapp.com'
  ],
  credentials: true
}));

app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

// Auth Checks
async function verifyToken(req, res, next) {
  if (!firebaseReady) return res.status(503).json({ error: 'Auth service down' });
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = await admin.auth().verifyIdToken(header.split('Bearer ')[1]);
    next();
  } catch (e) { 
    return res.status(401).json({ error: 'Invalid or expired token' }); 
  }
}

async function requireAdmin(req, res, next) {
  if (!db) return res.status(503).json({ error: 'Database down' });
  try {
    const snap = await db.collection('users').doc(req.user.uid).get();
    if (!snap.exists || snap.data().role !== 'administrator') return res.status(403).json({ error: 'Admin only' });
    req.userDoc = snap.data();
    next();
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
}
// Socket.io
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      'https://farmconnectzw.web.app',
      'https://farmconnectzw.firebaseapp.com'
    ],
    methods: ["GET", "POST"]
  }
});

const onlineUsers = new Map();

io.on('connection', (socket) => {

  socket.on('join', ({ userId }) => {
    socket.userId = userId;
    onlineUsers.set(userId, socket.id);
    socket.broadcast.emit('user_online', userId);
  });

  socket.on('join_chat', ({ chatId }) => {
    socket.join(chatId);
  });

  socket.on('send_message', (data) => {
    io.to(data.chatId).emit('receive_message', data);
  });

  socket.on('typing', ({ chatId, userId }) => {
    socket.to(chatId).emit('typing', userId);
  });

  socket.on('stop_typing', ({ chatId, userId }) => {
    socket.to(chatId).emit('stop_typing', userId);
  });

  socket.on('disconnect', async () => {
    const userId = socket.userId;

    if (userId) {
      onlineUsers.delete(userId);

      const lastSeen = Date.now();

      socket.broadcast.emit('user_offline', {
        userId,
        lastSeen
      });

      if (db) {
        try {
          await db.collection('users').doc(userId).update({
            lastSeen: admin.firestore.FieldValue.serverTimestamp()
          });
        } catch (e) {}
      }
    }
  });

});

// Core API
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    firebase: firebaseReady ? 'connected' : 'not configured', 
    push: pushReady ? 'enabled' : 'disabled',
    storage: supabaseReady ? 'enabled' : 'disabled'
  });
});

app.get('/api/weather', async (req, res) => {
  const OWM_KEY = (process.env.OWM_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!OWM_KEY) return res.status(500).json({ error: 'OWM_KEY missing' });
  
  const district = (req.query.district || 'Harare').trim() || 'Harare';
  
  try {
    const [curRes, fcastRes] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(district)},ZW&units=metric&appid=${OWM_KEY}`),
      fetch(`https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(district)},ZW&units=metric&cnt=8&appid=${OWM_KEY}`)
    ]);

    if (!curRes.ok) {
      const errBody = await curRes.json().catch(() => ({}));
      return res.status(curRes.status).json({ error: errBody.message || 'Weather fetch failed' });
    }

    const cur = await curRes.json();
    const fcast = fcastRes.ok ? await fcastRes.json() : null;

    let todayMin = cur.main.temp;
    let todayMax = cur.main.temp;

    // Fix: Account for local time (UTC+2) to isolate today's true min/max from the forecast segments
    if (fcast && fcast.list) {
      const localNow = new Date(new Date().getTime() + 2 * 60 * 60 * 1000);
      const todayStr = localNow.toISOString().split('T')[0];
      
      const todaysForecasts = fcast.list.filter(s => s.dt_txt.startsWith(todayStr));
      if (todaysForecasts.length > 0) {
        todayMin = Math.min(...todaysForecasts.map(s => s.main.temp_min), cur.main.temp);
        todayMax = Math.max(...todaysForecasts.map(s => s.main.temp_max), cur.main.temp);
      }
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
  } catch (e) {
    res.status(500).json({ error: 'Weather unavailable: ' + e.message });
  }
});

// Rich Media Uploads via Supabase
app.post('/api/upload', verifyToken, upload.single('media'), async (req, res) => {
  if (!supabaseReady) return res.status(503).json({ error: 'Storage not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file found in request' });

  try {
    const ext = path.extname(req.file.originalname) || '';
    const filename = `${req.user.uid}-${Date.now()}${ext}`;
    
    // Sort into folders based on mimetype
    let folder = 'docs';
    if (req.file.mimetype.startsWith('image/')) folder = 'images';
    if (req.file.mimetype.startsWith('video/')) folder = 'videos';
    if (req.file.mimetype.startsWith('audio/')) folder = 'audio';

    const filePath = `${folder}/${filename}`;

    const { data, error } = await supabase.storage
      .from('media-bucket')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage
      .from('media-bucket')
      .getPublicUrl(filePath);

    res.json({ success: true, url: publicUrl, type: folder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Notifications
app.get('/api/push/vapid-key', (req, res) => {
  if (!pushReady) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', verifyToken, async (req, res) => {
  if (!pushReady || !db) return res.status(503).json({ error: 'Service unavailable' });
  try {
    await db.collection('users').doc(req.user.uid).update({
      pushSubscription: req.body.subscription,
      pushUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
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
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
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
  } catch (e) { 
    res.json({ success: false }); 
  }
});
//Payments
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

    // ── Paynow Hash ────────────────────────────────────────────────────────
    // Source: https://forums.paynow.co.zw/t/invalid-hash-when-initiating-a-remotetransaction/1295
    // Harvey's confirmed working example (post #14) and Lucia's field order (post #11).
    //
    // Algorithm: SHA512( concatenated_values + integrationKey ), uppercase hex.
    // NOT MD5. NOT URL-encoded values. Raw strings only.
    //
    // Web field order:
    //   id, reference, amount, additionalinfo, returnurl, resulturl, status, authemail
    //
    // Mobile field order (Harvey post #14 confirmed working):
    //   id, reference, amount, additionalinfo, returnurl, resulturl, status, method, phone, authemail
    //
    // Hash appended LAST to the POST body, not included in hash input.

    function paynowHash(values, integrationKey) {
      // values = array of raw string values in exact field order
      const str = values.join('') + integrationKey;
      return crypto.createHash('sha512').update(str, 'utf8').digest('hex').toUpperCase();
    }

    let paynowUrl, fields, hashValues;

    if (!isMobile) {
      // Web / redirect transaction
      fields = {
        id:             String(PAYNOW_ID),
        reference,
        amount:         amount_str,
        additionalinfo: itemDesc,
        returnurl,
        resulturl,
        status:         'Message',
        authemail
      };
      hashValues     = [fields.id, fields.reference, fields.amount, fields.additionalinfo, fields.returnurl, fields.resulturl, fields.status, fields.authemail];
      fields.hash    = paynowHash(hashValues, PAYNOW_KEY);
      paynowUrl      = 'https://www.paynow.co.zw/interface/initiatetransaction';

    } else {
      // Mobile money — normalise phone to 263XXXXXXXXX
      const normPhone = ('263' + phone.replace(/^\+?2630?|^0/, '').replace(/\D/g, '')).slice(0, 12);
      // Confirmed field order from forums post #14:
      // id, reference, amount, additionalinfo, returnurl, resulturl, status, method, phone, authemail
      fields = {
        id:             String(PAYNOW_ID),
        reference,
        amount:         amount_str,
        additionalinfo: itemDesc,
        returnurl,
        resulturl,
        status:         'Message',
        method,
        phone:          normPhone,
        authemail
      };
      hashValues     = [fields.id, fields.reference, fields.amount, fields.additionalinfo, fields.returnurl, fields.resulturl, fields.status, fields.method, fields.phone, fields.authemail];
      fields.hash    = paynowHash(hashValues, PAYNOW_KEY);
      paynowUrl      = 'https://www.paynow.co.zw/interface/remotetransaction';
    }

    console.log('Paynow posting to:', paynowUrl);
    console.log('Paynow fields (no key):', { ...fields, hash: fields.hash });

    const pnRes = await fetch(paynowUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams(fields).toString()
    });
    const rawText = await pnRes.text();
    console.log('Paynow response:', rawText);

    // Parse URL-encoded response
    const parsed = {};
    rawText.split('&').forEach(pair => {
      const eq = pair.indexOf('=');
      if (eq > -1) parsed[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    });

    const pnStatus = (parsed.status || '').toLowerCase();
    if (pnStatus === 'ok' || pnStatus === 'sent') {
      res.json({ success: true, reference, pollUrl: parsed.pollurl || null, redirectUrl: parsed.browserurl || null });
    } else {
      console.error('Paynow rejected:', parsed);
      res.json({ success: false, error: parsed.error || ('Paynow error: ' + (parsed.status || 'check Render logs')) });
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


server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running with realtime on port ${PORT}`);
});
