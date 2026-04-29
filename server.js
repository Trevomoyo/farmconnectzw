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
       frameSrc:   ["'self'", "https://farmconnectzw.firebaseapp.com", "https://farmconnectzw.web.app",
                    "https://accounts.google.com"],
       workerSrc:  ["'self'", "blob:"],
       mediaSrc:   ["'self'", supabaseUrl ? `${supabaseUrl}/*` : ""]
     }
   }
 }));

const ALLOWED_ORIGINS = [
  'https://farmconnectzw.web.app',
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
     // Persist to Firestore for history
     if (db) {
       try {
         const messageData = {
           senderId: data.senderId,
           senderName: data.senderName || '',
           recipientId: data.recipientId,
           recipientName: data.recipientName || '',
           participants: [data.senderId, data.recipientId],
           text: data.text || '',
           mediaType: data.mediaType || null,
           mediaUrl: data.mediaUrl || null,
           mediaName: data.mediaName || null,
           seen: false,
           createdAt: admin.firestore.FieldValue.serverTimestamp()
         };
         await db.collection('messages').add(messageData);
       } catch (e) {
         console.error('Failed to persist message:', e.message);
       }
     }

     // Broadcast to other participants only (exclude sender)
     socket.to(data.chatId).emit('receive_message', data);

     // Send push notification to recipient if they are offline
     if (pushReady && db && data.recipientId) {
       // Skip push if recipient is currently online
       if (!onlineUsers.has(data.recipientId)) {
         try {
           const userSnap = await db.collection('users').doc(data.recipientId).get();
           if (userSnap.exists && userSnap.data().pushSubscription) {
             const preview = data.text ? data.text.slice(0, 100) : (data.mediaType ? '📎 Media' : 'New message');
             const payload = JSON.stringify({
               title: `💬 Message from ${data.senderName || 'User'}`,
               body: preview,
               url: '/messages.html'
             });
             await webpush.sendNotification(userSnap.data().pushSubscription, payload);
           }
         } catch (e) {
           console.error('Push notification error:', e.message);
         }
       }
     }
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
