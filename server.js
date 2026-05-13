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
app.set('trust proxy', 1);
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
       scriptSrc:  ["'self'", "'unsafe-inline'", "https://www.gstatic.com", "https://unpkg.com", "https://fonts.googleapis.com", "https://apis.google.com", "https://cdn.socket.io"],
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

// Map of userId -> Set of socket.id (supports multiple devices per user)
const onlineUsers = new Map();

io.on('connection', (socket) => {
  socket.on('join', ({ userId }) => {
    if (!userId) return;

    // Store association between this socket and the userId
    socket.userId = userId;

    // Add this socket to the Set for this userId
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    const sockets = onlineUsers.get(userId);
    const wasOffline = sockets.size === 0;
    sockets.add(socket.id);

    // Send the current online user list (unique userIds) to this socket
    const onlineUserIds = Array.from(onlineUsers.keys());
    socket.emit('initial_online', onlineUserIds);

    // If this is the first device for this user, notify others that the user is online
    if (wasOffline) {
      socket.broadcast.emit('user_online', userId);
    }
  });

  socket.on('join_chat', ({ chatId }) => {
    socket.join(chatId);
  });

  socket.on('leave_chat', ({ chatId }) => {
    socket.leave(chatId);
  });

  socket.on('send_message', async (data) => {
    // Send to all sockets of the recipient (multi-device support)
    const recipientSockets = onlineUsers.get(data.recipientId);
    if (recipientSockets && recipientSockets.size > 0) {
      for (const socketId of recipientSockets) {
        io.to(socketId).emit('receive_message', data);
      }
    }

    // Push notification if recipient is offline (no active sockets)
    if (pushReady && db && data.recipientId && (!recipientSockets || recipientSockets.size === 0)) {
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
    if (!userId) return;

    const sockets = onlineUsers.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      // If no more sockets for this user, remove them from the map and broadcast offline
      if (sockets.size === 0) {
        onlineUsers.delete(userId);
        const lastSeen = Date.now();
        socket.broadcast.emit('user_offline', { userId, lastSeen });

        if (db) {
          try {
            await db.collection('users').doc(userId).update({
              lastSeen: admin.firestore.FieldValue.serverTimestamp()
            });
          } catch (e) {}
        }
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

// ── Daily Market Prices Cron Job (runs at 6:00 AM Zimbabwe time = 4:00 AM UTC) ──
// Zimbabwe is UTC+2. We simulate by checking every hour and running once per day.
// Uses a simple lock stored in memory to prevent double-runs.
let _lastPriceCronDate = '';

async function runDailyPriceCron() {
  if (!db) return;
  const nowZW = new Date(Date.now() + 2 * 60 * 60 * 1000); // UTC+2
  const todayStr = nowZW.toISOString().split('T')[0];
  const hourZW   = nowZW.getUTCHours(); // hour in ZW local time

  // Only run between 06:00–07:00 ZW, once per day
  if (hourZW !== 6 || _lastPriceCronDate === todayStr) return;
  _lastPriceCronDate = todayStr;

  console.log(`[Cron] Running daily market price refresh for ${todayStr}`);

  // Commodity list with realistic Zimbabwe price ranges (ZiG)
  const commodities = [
    { commodity: 'Maize',       unit: 'per 50kg bag', district: 'Harare',   base: 420,  volatility: 30  },
    { commodity: 'Maize',       unit: 'per 50kg bag', district: 'Bulawayo', base: 430,  volatility: 30  },
    { commodity: 'Maize',       unit: 'per 50kg bag', district: 'Mutare',   base: 415,  volatility: 25  },
    { commodity: 'Wheat',       unit: 'per ton',      district: 'Harare',   base: 6800, volatility: 200 },
    { commodity: 'Soya Beans',  unit: 'per ton',      district: 'Harare',   base: 9200, volatility: 300 },
    { commodity: 'Groundnuts',  unit: 'per kg',       district: 'Gweru',    base: 5.2,  volatility: 0.4 },
    { commodity: 'Sunflower',   unit: 'per ton',      district: 'Harare',   base: 5500, volatility: 150 },
    { commodity: 'Sugar Beans', unit: 'per kg',       district: 'Masvingo', base: 12,   volatility: 0.8 },
    { commodity: 'Cattle',      unit: 'per head',     district: 'Harare',   base: 1800, volatility: 100 },
    { commodity: 'Goats',       unit: 'per head',     district: 'Harare',   base: 280,  volatility: 20  },
    { commodity: 'Poultry',     unit: 'per bird',     district: 'Harare',   base: 22,   volatility: 2   },
    { commodity: 'Tomatoes',    unit: 'per 30kg crate', district: 'Harare', base: 85,   volatility: 15  },
    { commodity: 'Potatoes',    unit: 'per 50kg bag', district: 'Mutare',   base: 160,  volatility: 20  },
    { commodity: 'Cabbages',    unit: 'per head',     district: 'Harare',   base: 3.5,  volatility: 0.5 },
    { commodity: 'Onions',      unit: 'per 20kg bag', district: 'Kwekwe',   base: 95,   volatility: 10  },
  ];

  try {
    const batch = db.batch();

    // Fetch yesterday's prices to compute trend
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
      const key = `${item.commodity}|${item.district}`;
      const prevPrice = prevPrices[key] || item.base;

      // Random walk within volatility range
      const change = (Math.random() - 0.5) * 2 * item.volatility;
      const newPrice = Math.max(item.base * 0.6, Math.min(item.base * 1.4, prevPrice + change));
      const roundedPrice = item.base < 10
        ? Math.round(newPrice * 100) / 100   // 2 dp for small prices
        : Math.round(newPrice);

      const trend = newPrice > prevPrice + (item.volatility * 0.1) ? 'up'
                  : newPrice < prevPrice - (item.volatility * 0.1) ? 'down'
                  : 'stable';

      const ref = db.collection('marketPrices').doc();
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
    console.log(`[Cron] Market prices updated — ${commodities.length} commodities written`);

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
    console.error('[Cron] Market price cron failed:', e.message);
  }
}

// Run cron check every 30 minutes
setInterval(runDailyPriceCron, 30 * 60 * 1000);
// Also run once on startup (will no-op unless it's 6 AM)
runDailyPriceCron();

// Manual trigger endpoint (admin only)
app.post('/api/cron/prices', verifyToken, requireAdmin, async (req, res) => {
  _lastPriceCronDate = ''; // reset lock so it runs immediately
  await runDailyPriceCron();
  res.json({ success: true, message: 'Market price cron executed' });
});

// ── Gemini Chatbot Endpoint ────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent';

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
    // Build conversation history for context (max last 10 turns)
    const recentHistory = history.slice(-10);
    const contents = [
      ...recentHistory.map(turn => ({
        role: turn.role,
        parts: [{ text: turn.text }]
      })),
      {
        role: 'user',
        parts: [{ text: message.trim() }]
      }
    ];

    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: AGRI_SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature:     0.7,
          topP:            0.9,
          maxOutputTokens: 512,
          stopSequences:   []
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',      threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
        ]
      })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => '');
      console.error('Gemini API error:', geminiRes.status, errText);
      return res.status(502).json({ error: 'AI service temporarily unavailable' });
    }

    const geminiData = await geminiRes.json();
    const candidate  = geminiData.candidates?.[0];
    const reply      = candidate?.content?.parts?.[0]?.text;

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
