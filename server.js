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

// Static files
app.use(express.static(__dirname));

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
    process.env.VAPID_EMAIL || 'mailto:support@farmconnectzw.co.zw',
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
       scriptSrc: ["'self'", "'unsafe-inline'", "https://www.gstatic.com", "https://unpkg.com", "https://fonts.googleapis.com", "https://apis.google.com", "https://cdn.socket.io", "https://cdn.jsdelivr.net"],
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
       frameSrc:   ["'self'", "https://farmconnectzw.firebaseapp.com","https://farmconnectzw.co.zw","https://farmconnectzw.web.app",
                    "https://accounts.google.com"],
       workerSrc:  ["'self'", "blob:"],
       mediaSrc:   ["'self'", supabaseUrl ? `${supabaseUrl}/*` : ""]
     }
   }
 }));

const ALLOWED_ORIGINS = [
  'https://farmconnectzw.web.app',
  'https://farmconnectzw.co.zw',
  'https://farmconnectzw.firebaseapp.com',
  process.env.RENDER_EXTERNAL_URL || 'https://farmconnectzw.onrender.com'
].filter(Boolean);

app.use(cors({
  origin: ALLOWED_ORIGINS,
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
const server = http.createServer(app); // Pass app so HTTP routes work immediately
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"]
  }
});

const onlineUsers = new Map();

io.on('connection', (socket) => {

   socket.on('join', ({ userId }) => {
     socket.userId = userId;
     onlineUsers.set(userId, socket.id);

     // Send current online list to the newly joined user
     socket.emit('initial_online', Array.from(onlineUsers.keys()));

     // Notify others that this user is online
     socket.broadcast.emit('user_online', userId);
   });

   socket.on('join_chat', ({ chatId }) => {
     socket.join(chatId);
   });

   socket.on('leave_chat', ({ chatId }) => {
     socket.leave(chatId);
   });

  socket.on('send_message', async (data) => {
    // Relay message to recipient in real-time (avoids Firestore onSnapshot delay)
    const recipientSocketId = onlineUsers.get(data.recipientId);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('receive_message', data);
    }

    // Push notification if recipient is offline
    if (pushReady && db && data.recipientId && !onlineUsers.has(data.recipientId)) {
      try {
        const userSnap = await db.collection('users').doc(data.recipientId).get();
        if (userSnap.exists) {
          const userData = userSnap.data();
          if (userData.pushSubscription) {
            const preview = data.text 
              ? data.text.slice(0, 100) 
              : data.mediaType ? '📎 ' + data.mediaType : 'New message';
            await _sendPush(data.recipientId, userData.pushSubscription, {
              title: `💬 ${data.senderName || 'New message'}`,
              body: preview,
              url: '/messages.html',
              tag: 'fcz-message'
            });
          }
        }
      } catch (e) { 
        console.error('Socket push error:', e.message);
      }
    } 
  }); 

  socket.on('typing', ({ chatId, userId, userName }) => {
    socket.to(chatId).emit('typing', { userId, userName: userName || 'User' });
  });

  socket.on('stop_typing', ({ chatId, userId }) => {
    socket.to(chatId).emit('stop_typing', { userId });
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

// Supplier Commission API
const COMMISSION_RATE = 0.05; // 5% commission

app.get('/api/commissions/stats', verifyToken, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    const ordersSnap = await db.collection('supplier_orders')
      .where('supplierId', '==', req.user.uid)
      .get();
    
    let totalRevenue = 0;
    let totalCommission = 0;
    let orderCount = 0;
    
    ordersSnap.forEach(doc => {
      const order = doc.data();
      const revenue = order.total || 0;
      totalRevenue += revenue;
      totalCommission += revenue * COMMISSION_RATE;
      orderCount++;
    });
    
    res.json({
      totalRevenue: totalRevenue.toFixed(2),
      totalCommission: totalCommission.toFixed(2),
      commissionRate: COMMISSION_RATE * 100,
      orderCount
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/commissions/track', verifyToken, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  
  const { orderId, productId, amount } = req.body;
  
  if (!orderId || !amount) {
    return res.status(400).json({ error: 'Order ID and amount required' });
  }
  
  try {
    const commission = amount * COMMISSION_RATE;
    
    await db.collection('commission_tracking').add({
      orderId,
      productId,
      supplierId: req.user.uid,
      amount: commission,
      rate: COMMISSION_RATE,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ 
      success: true, 
      commission: commission.toFixed(2),
      rate: COMMISSION_RATE * 100
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Animal Census API for Officers
app.get('/api/census/animal', verifyToken, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    // Get officer's district
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    
    const userData = userDoc.data();
    if (userData.role !== 'extension_officer') {
      return res.status(403).json({ error: 'Officer access only' });
    }
    
    const district = userData.district;
    if (!district) return res.status(400).json({ error: 'No district assigned' });
    
    // Get farmers in district
    const farmersSnap = await db.collection('users')
      .where('role', '==', 'farmer')
      .where('district', '==', district)
      .get();
    
    const farmerIds = farmersSnap.docs.map(d => d.id);
    
    if (farmerIds.length === 0) {
      return res.json({ total: 0, byType: {}, byFarmer: [], district });
    }
    
    // Get animals for these farmers — chunk into 10 to respect Firestore 'in' limit
    const chunks = [];
    for (let i = 0; i < farmerIds.length; i += 10) chunks.push(farmerIds.slice(i, i + 10));
    const chunkSnaps = await Promise.all(
      chunks.map(chunk => db.collection('farm_animals').where('ownerId', 'in', chunk).get())
    );
    const allAnimalDocs = chunkSnaps.flatMap(s => s.docs);

    const byType = { cattle: 0, goats: 0, sheep: 0, poultry: 0, pigs: 0, other: 0 };
    const byFarmer = {};
    
    allAnimalDocs.forEach(doc => {
      const animal = doc.data();
      const type = animal.type || 'other';
      if (byType[type] !== undefined) {
        byType[type]++;
      } else {
        byType.other++;
      }
      
      if (!byFarmer[animal.ownerId]) {
        byFarmer[animal.ownerId] = 0;
      }
      byFarmer[animal.ownerId]++;
    });
    
    // Get farmer names
    const farmerNames = {};
    for (const fid of Object.keys(byFarmer)) {
      const fDoc = await db.collection('users').doc(fid).get();
      if (fDoc.exists) {
        farmerNames[fid] = fDoc.data().name || 'Unknown';
      }
    }
    
    res.json({
      total: allAnimalDocs.length,
      byType,
      byFarmer: Object.entries(byFarmer).map(([id, count]) => ({
        farmerId: id,
        farmerName: farmerNames[id] || 'Unknown',
        animalCount: count
      })).sort((a, b) => b.animalCount - a.animalCount),
      district,
      farmersWithAnimals: Object.keys(byFarmer).length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
app.post('/api/upload', verifyToken, upload.single('file'), async (req, res) => {
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

// ── Push helper — send to one user, auto-remove stale subscription ────────────
const APP_ORIGIN = process.env.RENDER_EXTERNAL_URL
  ? process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')
  : 'https://farmconnectzw.co.zw';

async function _sendPush(userId, subscription, payload) {
  if (!pushReady) return false;
  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({
        ...payload,
        // Resolve relative URL to absolute so SW openWindow works
        url: payload.url?.startsWith('http')
          ? payload.url
          : APP_ORIGIN + (payload.url || '/notifications.html')
      })
    );
    return true;
  } catch (e) {
    // 410 Gone or 404 = subscription expired — delete it so we stop trying
    if ((e.statusCode === 410 || e.statusCode === 404) && db && userId) {
      db.collection('users').doc(userId)
        .update({ pushSubscription: admin.firestore.FieldValue.delete() })
        .catch(() => {});
    }
    return false;
  }
}

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
      pushUpdatedAt:    admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SW calls this when browser auto-renews a push subscription
app.post('/api/push/resubscribe', async (req, res) => {
  if (!db) return res.json({ success: false });
  const { oldEndpoint, subscription } = req.body;
  if (!subscription || !oldEndpoint) return res.json({ success: false });
  try {
    // Find user by their old endpoint and swap in the new subscription
    const snap = await db.collection('users')
      .where('pushSubscription.endpoint', '==', oldEndpoint)
      .limit(1).get();
    if (snap.empty) return res.json({ success: false, reason: 'not_found' });
    await snap.docs[0].ref.update({
      pushSubscription: subscription,
      pushUpdatedAt:    admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, reason: e.message });
  }
});

// Broadcast alert to all users (or specific district) — admin only
app.post('/api/push/broadcast', verifyToken, requireAdmin, async (req, res) => {
  if (!pushReady || !db) return res.status(503).json({ error: 'Push not configured' });
  const { title, body, url, tag, district } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  try {
    let query = db.collection('users');
    if (district) query = query.where('district', '==', district);
    const usersSnap = await query.get();

    const payload = {
      title,
      body: body || '',
      url:  url  || '/notifications.html',
      tag:  tag  || 'fcz-alert'
    };

    let sent = 0;
    await Promise.allSettled(
      usersSnap.docs
        .filter(d => d.data().pushSubscription)
        .map(async d => {
          const ok = await _sendPush(d.id, d.data().pushSubscription, payload);
          if (ok) sent++;
        })
    );

    res.json({ success: true, sent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send push to one specific user — used by /api/notify/message
app.post('/api/notify/message', verifyToken, async (req, res) => {
  if (!pushReady || !db) return res.json({ success: false });
  const { recipientId, senderName, preview } = req.body;
  if (!recipientId) return res.status(400).json({ error: 'recipientId required' });

  try {
    const snap = await db.collection('users').doc(recipientId).get();
    if (!snap.exists || !snap.data().pushSubscription) {
      return res.json({ success: false, reason: 'no_subscription' });
    }
    const ok = await _sendPush(recipientId, snap.data().pushSubscription, {
      title: `💬 ${senderName || 'New message'}`,
      body:  preview ? preview.slice(0, 120) : 'You have a new message',
      url:   '/messages.html',
      tag:   'fcz-message'
    });
    res.json({ success: ok });
  } catch (e) {
    res.json({ success: false, reason: e.message });
  }
});

// Payments
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

    function paynowHash(values, integrationKey) {
      const str = values.join('') + integrationKey;
      return crypto.createHash('sha512').update(str, 'utf8').digest('hex').toUpperCase();
    }

    let paynowUrl, fields, hashValues;

    if (!isMobile) {
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
      const normPhone = ('263' + phone.replace(/^\+?2630?|^0/, '').replace(/\D/g, '')).slice(0, 12);
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

// ── Daily Market Prices Cron Job ──────────────────────────────────────────────
// IMPORTANT: On Render free tier, setInterval dies when the instance spins down.
// Fix: Use Render's native Cron Job service to POST to /api/cron/prices instead.
// Render dashboard → your service → Cron Jobs tab → add:
//   Schedule : 0 4 * * *   (4:00 AM UTC = 6:00 AM Zimbabwe time)
//   Command  : curl -X POST https://YOUR-SERVICE.onrender.com/api/cron/prices \
//                   -H "X-Cron-Secret: YOUR_SECRET"
// Add CRON_SECRET to your Render environment variables.

let _lastPriceCronDate = '';
let _lastCronRunAt     = null;
let _lastCronStatus    = 'never_run';

// Core cron logic — no hour-check here so manual/external triggers always work
async function runDailyPriceCron() {
  if (!db) return;

  const nowZW    = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const todayStr = nowZW.toISOString().split('T')[0];

  // Prevent double-runs on the same calendar day
  if (_lastPriceCronDate === todayStr) return;
  _lastPriceCronDate = todayStr;
  _lastCronStatus    = 'running';

  console.log(`[Cron] Running daily market price refresh for ${todayStr}`);

  const commodities = [
    { commodity: 'Maize',       unit: 'per 50kg bag',   district: 'Harare',   base: 420,  volatility: 30  },
    { commodity: 'Maize',       unit: 'per 50kg bag',   district: 'Bulawayo', base: 430,  volatility: 30  },
    { commodity: 'Maize',       unit: 'per 50kg bag',   district: 'Mutare',   base: 415,  volatility: 25  },
    { commodity: 'Maize',       unit: 'per 50kg bag',   district: 'Kwekwe',   base: 418,  volatility: 25  },
    { commodity: 'Wheat',       unit: 'per ton',        district: 'Harare',   base: 6800, volatility: 200 },
    { commodity: 'Soya Beans',  unit: 'per ton',        district: 'Harare',   base: 9200, volatility: 300 },
    { commodity: 'Groundnuts',  unit: 'per kg',         district: 'Gweru',    base: 5.2,  volatility: 0.4 },
    { commodity: 'Sunflower',   unit: 'per ton',        district: 'Harare',   base: 5500, volatility: 150 },
    { commodity: 'Sugar Beans', unit: 'per kg',         district: 'Masvingo', base: 12,   volatility: 0.8 },
    { commodity: 'Cattle',      unit: 'per head',       district: 'Harare',   base: 1800, volatility: 100 },
    { commodity: 'Goats',       unit: 'per head',       district: 'Harare',   base: 280,  volatility: 20  },
    { commodity: 'Poultry',     unit: 'per bird',       district: 'Harare',   base: 22,   volatility: 2   },
    { commodity: 'Tomatoes',    unit: 'per 30kg crate', district: 'Harare',   base: 85,   volatility: 15  },
    { commodity: 'Potatoes',    unit: 'per 50kg bag',   district: 'Mutare',   base: 160,  volatility: 20  },
    { commodity: 'Cabbages',    unit: 'per head',       district: 'Harare',   base: 3.5,  volatility: 0.5 },
    { commodity: 'Onions',      unit: 'per 20kg bag',   district: 'Kwekwe',   base: 95,   volatility: 10  },
  ];

  try {
    const batch = db.batch();

    // Fetch previous prices for trend calculation
    const prevSnap = await db.collection('marketPrices')
      .where('autoGenerated', '==', true)
      .orderBy('updatedAt', 'desc')
      .limit(commodities.length * 2)
      .get();

    const prevPrices = {};
    prevSnap.docs.forEach(d => {
      const p = d.data();
      const key = `${p.commodity}|${p.district}`;
      if (!prevPrices[key]) prevPrices[key] = p.price;
    });

    for (const item of commodities) {
      const key      = `${item.commodity}|${item.district}`;
      const prevPrice = prevPrices[key] || item.base;
      const change    = (Math.random() - 0.5) * 2 * item.volatility;
      const newPrice  = Math.max(item.base * 0.6, Math.min(item.base * 1.4, prevPrice + change));
      const roundedPrice = item.base < 10
        ? Math.round(newPrice * 100) / 100
        : Math.round(newPrice);

      const trend = newPrice > prevPrice + (item.volatility * 0.1) ? 'up'
                  : newPrice < prevPrice - (item.volatility * 0.1) ? 'down'
                  : 'stable';

      // Deterministic doc ID — overwrites same doc each run instead of accumulating duplicates
      const docId = `${item.commodity.replace(/\s+/g, '_')}_${item.district}_auto`;
      const ref   = db.collection('marketPrices').doc(docId);

      batch.set(ref, {
        commodity:     item.commodity,
        unit:          item.unit,
        district:      item.district,
        price:         roundedPrice,
        trend,
        prevPrice,
        autoGenerated: true,
        updatedAt:     admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await batch.commit();

    _lastCronRunAt  = new Date().toISOString();
    _lastCronStatus = 'success';
    console.log(`[Cron] Market prices updated — ${commodities.length} docs written`);

    // Broadcast push alert about new prices
    if (pushReady) {
      const usersSnap = await db.collection('users').get();
      let sent = 0;
      await Promise.allSettled(
        usersSnap.docs
          .filter(d => d.data().pushSubscription)
          .map(async d => {
            const ok = await _sendPush(d.id, d.data().pushSubscription, {
              title: '📊 Daily Market Prices Updated',
              body:  `Fresh commodity prices for ${todayStr} are now available.`,
              url:   '/market-prices.html',
              tag:   'fcz-prices-daily'
            });
            if (ok) sent++;
          })
      );
      console.log(`[Cron] Price push sent to ${sent} devices`);
    }
  } catch (e) {
    _lastCronStatus = 'failed: ' + e.message;
    console.error('[Cron] Market price cron failed:', e.message);
  }
}

// setInterval as fallback — only fires during the 6 AM Zimbabwe hour
// Not reliable on Render free tier; use Render Cron Jobs as primary trigger
setInterval(() => {
  const hourZW = new Date(Date.now() + 2 * 60 * 60 * 1000).getUTCHours();
  if (hourZW === 6) runDailyPriceCron();
}, 30 * 60 * 1000);

// Run once on startup — no-ops unless it happens to be 6 AM
runDailyPriceCron();

// External cron trigger — Render Cron Job hits this with X-Cron-Secret header
// Also works as admin manual trigger (falls back to verifyToken + requireAdmin if no secret configured)
app.post('/api/cron/prices', async (req, res, next) => {
  const secret   = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'];

  if (secret && provided === secret) {
    // Valid external cron call — run immediately
    _lastPriceCronDate = '';
    await runDailyPriceCron();
    return res.json({ success: true, status: _lastCronStatus, ranAt: _lastCronRunAt });
  }

  if (secret && provided !== secret) {
    return res.status(401).json({ error: 'Invalid cron secret' });
  }

  // No CRON_SECRET configured — require admin auth for manual trigger
  next();
}, verifyToken, requireAdmin, async (req, res) => {
  _lastPriceCronDate = '';
  await runDailyPriceCron();
  res.json({ success: true, status: _lastCronStatus, ranAt: _lastCronRunAt });
});

// Cron status — lets you verify the cron is actually running
app.get('/api/cron/status', verifyToken, requireAdmin, (req, res) => {
  res.json({
    lastRunAt:    _lastCronRunAt   || 'never',
    lastStatus:   _lastCronStatus  || 'never_run',
    lastDateKey:  _lastPriceCronDate || 'none',
    serverTime:   new Date().toISOString(),
    zimbabweTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  });
});

// ── AgroBot: build live Firestore context for the current user ────────────────
async function buildUserContext(uid) {
  if (!db) return '';

  try {
    const [profileRes, pricesRes, livestockRes, listingsRes, yieldsRes] = await Promise.allSettled([
      // 1. User profile
      db.collection('users').doc(uid).get(),

      // 2. Latest market prices
      db.collection('marketPrices')
        .orderBy('updatedAt', 'desc')
        .limit(20)
        .get(),

      // 3. User's livestock
      db.collection('livestock')
        .where('ownerId', '==', uid)
        .limit(50)
        .get(),

      // 4. User's active listings
      db.collection('listings')
        .where('userId', '==', uid)
        .where('status', '==', 'active')
        .limit(10)
        .get(),

      // 5. User's recent yields
      db.collection('yields')
        .where('userId', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(5)
        .get()
    ]);

    let context = '\n\n--- LIVE USER CONTEXT (use this to personalise your answer) ---\n';

    // Profile
    if (profileRes.status === 'fulfilled' && profileRes.value.exists) {
      const p = profileRes.value.data();
      context += `User: ${p.name || 'Unknown'}\n`;
      context += `Role: ${p.role || 'farmer'}\n`;
      context += `District: ${p.district || 'Not specified'}\n`;
      context += `Phone: ${p.phone || 'Not provided'}\n`;
    }

    // Market prices — deduplicate, show user's district first
    if (pricesRes.status === 'fulfilled' && !pricesRes.value.empty) {
      const userDistrict = profileRes.status === 'fulfilled' && profileRes.value.exists
        ? (profileRes.value.data().district || '') : '';

      const seen = new Set();
      const prices = [];
      pricesRes.value.docs.forEach(d => {
        const p = d.data();
        const key = `${p.commodity}|${p.district}`;
        if (!seen.has(key)) { seen.add(key); prices.push(p); }
      });

      prices.sort((a, b) => {
        if (a.district === userDistrict) return -1;
        if (b.district === userDistrict) return 1;
        return 0;
      });

      context += '\nCurrent Market Prices (ZiG):\n';
      prices.slice(0, 12).forEach(p => {
        const trend = p.trend === 'up' ? '↑' : p.trend === 'down' ? '↓' : '→';
        context += `  ${p.commodity} (${p.district}): ZiG ${p.price} ${p.unit} ${trend}\n`;
      });
    }

    // Livestock summary
    if (livestockRes.status === 'fulfilled' && !livestockRes.value.empty) {
      const counts = {};
      livestockRes.value.docs.forEach(d => {
        const type = d.data().type || 'other';
        counts[type] = (counts[type] || 0) + 1;
      });
      context += '\nUser\'s Livestock:\n';
      Object.entries(counts).forEach(([type, count]) => {
        context += `  ${type}: ${count}\n`;
      });
    }

    // Active listings
    if (listingsRes.status === 'fulfilled' && !listingsRes.value.empty) {
      context += '\nUser\'s Active Listings:\n';
      listingsRes.value.docs.forEach(d => {
        const l = d.data();
        context += `  ${l.title || 'Listing'}: ZiG ${l.price || '?'} (${l.category || 'general'})\n`;
      });
    }

    // Recent yields
    if (yieldsRes.status === 'fulfilled' && !yieldsRes.value.empty) {
      context += '\nRecent Yield Records:\n';
      yieldsRes.value.docs.forEach(d => {
        const y = d.data();
        context += `  ${y.crop || 'Crop'}: ${y.amount || '?'} ${y.unit || 'kg'} — ${y.season || ''}\n`;
      });
    }

    context += '--- END CONTEXT ---\n';
    return context;

  } catch (e) {
    console.error('[AgroBot] Context build failed:', e.message);
    return ''; // fail silently — still answer without context
  }
}

// ── Gemini Chatbot Endpoint ────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// Rate limiter specifically for chatbot — 30 requests per minute per IP
const chatbotLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many chat requests. Please wait a moment.' }
});

const AGRI_SYSTEM_PROMPT = `You are AgroBot, an expert agricultural assistant for FarmConnectZW — Zimbabwe's national agricultural coordination platform. You help farmers, extension officers, and suppliers across Zimbabwe.

Your expertise covers:
- Zimbabwean crop farming: maize, tobacco, wheat, soya, cotton, groundnuts, vegetables, fruit
- Livestock management: cattle, goats, sheep, poultry, pigs — including Zimbabwean breeds
- Pest and disease identification and control (e.g. fall armyworm, foot-and-mouth, Newcastle disease)
- Soil management, fertilizers (Compound D, AN, urea), and irrigation
- Zimbabwe's seasons: rainy season (Nov–Mar), dry season (Apr–Oct)
- Market prices, ZiG currency, and selling strategies
- Agritex extension services and government agricultural programs
- Weather patterns across Zimbabwe's provinces and districts

Rules:
- Keep answers practical, actionable, and relevant to Zimbabwean conditions
- When the user context block is present, USE it — reference the user's district, their livestock, their listings, and real market prices in your answer
- If market prices are available in the context, always quote them with the ZiG amount and trend arrow
- Mention specific products, brands, or government bodies when helpful
- If a question is completely unrelated to agriculture, farming, or rural livelihoods, politely redirect
- Be warm and encouraging — most users are smallholder farmers
- Respond in the same language as the user (English or Shona/Ndebele if detected)
- Keep responses concise — aim for under 200 words unless a detailed explanation is genuinely needed
- Use simple language; avoid jargon when possible`;

app.post('/api/chat', verifyToken, chatbotLimiter, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ error: 'Chatbot not configured. Add GEMINI_API_KEY to environment variables.' });
  }

  const { message, history = [] } = req.body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message is required' });
  }
  if (message.length > 1000) {
    return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
  }

  try {
    // Pull live Firestore context for this user
    const liveContext = await buildUserContext(req.user.uid);

    // Build contents array for multi-turn support
    // history = [{ role: 'user'|'model', text: '...' }, ...]
    const contents = [];

    // Inject prior conversation turns (capped at last 6 to limit token usage)
    history.slice(-6).forEach(turn => {
      contents.push({
        role:  turn.role === 'model' ? 'model' : 'user',
        parts: [{ text: turn.text }]
      });
    });

    // Final turn: system prompt + live context + user's current message
    contents.push({
      role:  'user',
      parts: [{ text: `${AGRI_SYSTEM_PROMPT}${liveContext}\n\nUser message: ${message.trim()}` }]
    });

    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contents })
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('Gemini API error:', geminiRes.status, data);
      return res.status(502).json({ error: data.error?.message || 'AI service temporarily unavailable' });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) {
      return res.status(502).json({ error: 'No response from AI' });
    }

    res.json({ reply: reply.trim() });

  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: 'Chat service error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running with realtime on port ${PORT}`);
});
