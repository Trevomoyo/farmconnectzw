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
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));

// ── Firebase Admin ──
let firebaseReady = false;
const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');
if (fs.existsSync(serviceAccountPath)) {
  admin.initializeApp({ credential: admin.credential.cert(require(serviceAccountPath)) });
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

// ── Supabase Storage ──
let supabaseReady = false;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  supabaseReady = true;
  console.log('Supabase client ready for storage');
}

// ── Multer (in-memory) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── Web Push ──
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

// ── Security & Middleware ──
app.use(helmet({
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://www.gstatic.com", "https://unpkg.com", "https://fonts.googleapis.com", "https://apis.google.com", "https://cdn.socket.io", "https://cdn.jsdelivr.net"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https:", "blob:", supabaseUrl ? `${supabaseUrl}/*` : ""],
      connectSrc: ["'self'", "https://firestore.googleapis.com", "https://identitytoolkit.googleapis.com",
                   "https://securetoken.googleapis.com", "https://api.openweathermap.org",
                   "https://*.tile.openstreetmap.org", "wss://firestore.googleapis.com",
                   "https://www.gstatic.com", "https://unpkg.com", "https://accounts.google.com",
                   "https://oauth2.googleapis.com", supabaseUrl || "", "ws:", "wss:"],
      frameSrc:   ["'self'", "https://farmconnectzw.firebaseapp.com", "https://farmconnectzw.co.zw",
                   "https://farmconnectzw.web.app", "https://accounts.google.com"],
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

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

// ── Auth Middleware ──
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

// ── Helper: Push notification ──
const APP_ORIGIN = process.env.RENDER_EXTERNAL_URL
  ? process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')
  : 'https://farmconnectzw.co.zw';

async function _sendPush(userId, subscription, payload) {
  if (!pushReady) return false;
  try {
    await webpush.sendNotification(subscription, JSON.stringify({
      ...payload,
      url: payload.url?.startsWith('http') ? payload.url : APP_ORIGIN + (payload.url || '/notifications.html')
    }));
    return true;
  } catch (e) {
    if ((e.statusCode === 410 || e.statusCode === 404) && db && userId) {
      db.collection('users').doc(userId).update({ pushSubscription: admin.firestore.FieldValue.delete() }).catch(() => {});
    }
    return false;
  }
}

// ── Helper: Create notification ──
async function createNotification(userId, type, title, message, linkType, linkId = null) {
  if (!db) return;
  try {
    await db.collection('notifications').add({
      userId, type, title, message, read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      linkType, linkId
    });
    const userDoc = await db.collection('users').doc(userId).get();
    if (userDoc.exists && userDoc.data().pushSubscription) {
      await _sendPush(userId, userDoc.data().pushSubscription, { title, body: message, url: '/notifications.html', tag: `notification-${type}` });
    }
  } catch (error) {
    console.error('Failed to create notification:', error);
  }
}

// ── Helper: Get wallet balance ──
async function getWalletBalance(userId) {
  const doc = await db.collection('users').doc(userId).get();
  const wallet = doc.data()?.wallet || { available_balance: 0, pending_balance: 0 };
  return { available: wallet.available_balance || 0, pending: wallet.pending_balance || 0 };
}

// ── Socket.io ──
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] } });
const onlineUsers = new Map();

io.on('connection', (socket) => {
  socket.on('join', ({ userId }) => {
    socket.userId = userId;
    onlineUsers.set(userId, socket.id);
    socket.emit('initial_online', Array.from(onlineUsers.keys()));
    socket.broadcast.emit('user_online', userId);
  });
  socket.on('join_chat',  ({ chatId }) => socket.join(chatId));
  socket.on('leave_chat', ({ chatId }) => socket.leave(chatId));
  socket.on('send_message', async (data) => {
    const recipientSocketId = onlineUsers.get(data.recipientId);
    if (recipientSocketId) io.to(recipientSocketId).emit('receive_message', data);
    if (pushReady && db && data.recipientId && !onlineUsers.has(data.recipientId)) {
      try {
        const userSnap = await db.collection('users').doc(data.recipientId).get();
        if (userSnap.exists && userSnap.data().pushSubscription) {
          const preview = data.text ? data.text.slice(0, 100) : data.mediaType ? '📎 ' + data.mediaType : 'New message';
          await _sendPush(data.recipientId, userSnap.data().pushSubscription, {
            title: `💬 ${data.senderName || 'New message'}`, body: preview, url: '/messages.html', tag: 'fcz-message'
          });
        }
      } catch (e) { console.error('Socket push error:', e.message); }
    }
  });
  socket.on('typing',      ({ chatId, userId, userName }) => socket.to(chatId).emit('typing', { userId, userName: userName || 'User' }));
  socket.on('stop_typing', ({ chatId, userId }) => socket.to(chatId).emit('stop_typing', { userId }));
  socket.on('disconnect', async () => {
    const userId = socket.userId;
    if (userId) {
      onlineUsers.delete(userId);
      socket.broadcast.emit('user_offline', { userId, lastSeen: Date.now() });
      if (db) db.collection('users').doc(userId).update({ lastSeen: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }
  });
});

// ============================================================================
// HEALTH
// ============================================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    firebase: firebaseReady ? 'connected' : 'not configured',
    push:     pushReady     ? 'enabled'   : 'disabled',
    storage:  supabaseReady ? 'enabled'   : 'disabled'
  });
});

// ============================================================================
// WALLET SYSTEM  (each route defined exactly once)
// ============================================================================

// GET balance
app.get('/api/wallet/balance', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.user.uid).get();
    const wallet = doc.data()?.wallet || { available_balance: 0, pending_balance: 0 };
    res.json({
      available_balance: wallet.available_balance || 0,
      pending_balance:   wallet.pending_balance   || 0,
      total_balance:    (wallet.available_balance || 0) + (wallet.pending_balance || 0),
      currency: 'USD'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// POST deposit
app.post('/api/wallet/deposit', verifyToken, async (req, res) => {
  const { amount, paymentMethod, transactionId } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (amount < 1) return res.status(400).json({ error: 'Minimum deposit is $1 USD' });
  try {
    const userRef = db.collection('users').doc(req.user.uid);
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(userRef);
      const current = doc.data()?.wallet?.available_balance || 0;
      tx.update(userRef, {
        'wallet.available_balance': current + amount,
        'wallet.last_deposit': admin.firestore.FieldValue.serverTimestamp(),
        'wallet.last_deposit_amount': amount
      });
      tx.set(db.collection('wallet_transactions').doc(), {
        userId: req.user.uid, type: 'deposit', amount, currency: 'USD',
        paymentMethod: paymentMethod || 'manual',
        transactionId: transactionId || `DEP-${Date.now()}`,
        status: 'completed', createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await createNotification(req.user.uid, 'wallet_credit', 'Wallet Funded',
      `$${Number(amount).toFixed(2)} USD has been added to your wallet.`, 'wallet');
    res.json({ success: true, message: `$${Number(amount).toFixed(2)} USD added to your wallet` });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'Deposit failed. Please try again.' });
  }
});

// POST withdraw
app.post('/api/wallet/withdraw', verifyToken, async (req, res) => {
  const { amount, method, accountDetails } = req.body;
  const validMethods = ['ecocash', 'onemoney', 'innbucks', 'zimswitch', 'bank_transfer'];
  if (!validMethods.includes(method)) return res.status(400).json({ error: 'Invalid withdrawal method' });
  if (!amount || amount <= 0)  return res.status(400).json({ error: 'Invalid amount' });
  if (amount < 5) return res.status(400).json({ error: 'Minimum withdrawal is $5 USD' });
  try {
    const userRef = db.collection('users').doc(req.user.uid);
    let withdrawalId = null;
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(userRef);
      const available = doc.data()?.wallet?.available_balance || 0;
      if (available < amount) throw new Error('Insufficient available balance');
      tx.update(userRef, { 'wallet.available_balance': admin.firestore.FieldValue.increment(-amount) });
      const withdrawalRef = db.collection('withdrawals').doc();
      withdrawalId = withdrawalRef.id;
      tx.set(withdrawalRef, {
        userId: req.user.uid, amount, method, accountDetails,
        status: 'pending', currency: 'USD', createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.set(db.collection('wallet_transactions').doc(), {
        userId: req.user.uid, type: 'withdrawal_request', amount, currency: 'USD',
        method, status: 'pending', withdrawalId, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await createNotification(req.user.uid, 'withdrawal_request', 'Withdrawal Request Submitted',
      `Your request to withdraw $${Number(amount).toFixed(2)} USD has been submitted for processing.`, 'wallet');
    res.json({ success: true, message: `Withdrawal request for $${Number(amount).toFixed(2)} USD submitted`, withdrawalId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET transactions
app.get('/api/wallet/transactions', verifyToken, async (req, res) => {
  const { limit = 50, type } = req.query;
  try {
    let query = db.collection('wallet_transactions')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit));
    if (type && type !== 'all') query = query.where('type', '==', type);
    const snapshot = await query.get();
    const transactions = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.() || new Date()
    }));
    res.json({ transactions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// ============================================================================
// ORDER / ESCROW SYSTEM  (each route defined exactly once)
// ============================================================================

// POST create order
app.post('/api/orders/create', verifyToken, async (req, res) => {
  const { items, totalAmount, sellerId, deliveryFee, paymentMethod } = req.body;
  if (!items || !totalAmount || !sellerId) return res.status(400).json({ error: 'Missing required fields' });
  if (totalAmount <= 0) return res.status(400).json({ error: 'Invalid order amount' });
  if (sellerId === req.user.uid) return res.status(400).json({ error: 'You cannot buy from yourself' });
  try {
    const buyerId = req.user.uid;
    let orderId = null;
    await db.runTransaction(async (tx) => {
      const buyerRef  = db.collection('users').doc(buyerId);
      const sellerRef = db.collection('users').doc(sellerId);
      const buyerDoc  = await tx.get(buyerRef);
      const available = buyerDoc.data()?.wallet?.available_balance || 0;
      if (available < totalAmount) throw new Error('Insufficient wallet balance');
      tx.update(buyerRef,  { 'wallet.available_balance': admin.firestore.FieldValue.increment(-totalAmount) });
      tx.update(sellerRef, { 'wallet.pending_balance':   admin.firestore.FieldValue.increment(totalAmount) });
      const orderRef = db.collection('orders').doc();
      orderId = orderRef.id;
      tx.set(orderRef, {
        orderId, buyerId, sellerId, items,
        totalAmount, deliveryFee: deliveryFee || 0,
        paymentMethod: paymentMethod || 'wallet',
        status: 'pending', escrowStatus: 'held', escrowReleased: false,
        disputed: false,
        createdAt:  admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:  admin.firestore.FieldValue.serverTimestamp()
      });
      tx.set(db.collection('wallet_transactions').doc(), {
        userId: buyerId, type: 'order_payment', amount: totalAmount,
        currency: 'USD', orderId, sellerId, status: 'completed',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    const sellerDoc = await db.collection('users').doc(sellerId).get();
    await createNotification(sellerId, 'order_placed', 'New Order Received!',
      `You have a new order worth $${Number(totalAmount).toFixed(2)} USD.`, 'order', orderId);
    res.json({ success: true, orderId, message: 'Order placed successfully. Funds held in escrow.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST seller confirms order (before dispatch)
app.post('/api/orders/confirm', verifyToken, async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  try {
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) return res.status(404).json({ error: 'Order not found' });
    const order = orderDoc.data();
    if (order.sellerId !== req.user.uid) return res.status(403).json({ error: 'Only the seller can confirm this order' });
    if (order.status !== 'pending') return res.status(400).json({ error: `Cannot confirm — order is already ${order.status}` });
    await orderRef.update({
      status: 'confirmed',
      confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:   admin.firestore.FieldValue.serverTimestamp()
    });
    await createNotification(order.buyerId, 'order_confirmed', 'Order Confirmed',
      `Your order #${orderId.slice(-8)} has been confirmed by the seller.`, 'order', orderId);
    res.json({ success: true, message: 'Order confirmed.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST seller dispatches order
app.post('/api/orders/dispatch', verifyToken, async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  try {
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) return res.status(404).json({ error: 'Order not found' });
    const order = orderDoc.data();
    if (order.sellerId !== req.user.uid) return res.status(403).json({ error: 'Only the seller can mark as dispatched' });
    if (order.status !== 'confirmed') return res.status(400).json({ error: 'Order must be confirmed before dispatch' });
    const releaseAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await orderRef.update({
      status: 'dispatched',
      dispatchedAt:    admin.firestore.FieldValue.serverTimestamp(),
      escrowReleaseAt: releaseAt,
      updatedAt:       admin.firestore.FieldValue.serverTimestamp()
    });
    await createNotification(order.buyerId, 'order_dispatched', 'Order Dispatched!',
      `Your order #${orderId.slice(-8)} has been dispatched. Confirm delivery when it arrives.`, 'order', orderId);
    res.json({ success: true, message: 'Order marked as dispatched. Escrow auto-releases in 48 hours.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST buyer confirms delivery — releases escrow immediately
app.post('/api/orders/confirm-delivery', verifyToken, async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  try {
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) return res.status(404).json({ error: 'Order not found' });
    const order = orderDoc.data();
    if (order.buyerId !== req.user.uid) return res.status(403).json({ error: 'Only the buyer can confirm delivery' });
    if (order.status !== 'dispatched') return res.status(400).json({ error: 'Order must be dispatched before confirming delivery' });
    if (order.escrowReleased) return res.status(400).json({ error: 'Escrow has already been released for this order' });

    await db.runTransaction(async (tx) => {
      const sellerRef = db.collection('users').doc(order.sellerId);
      // Move funds from pending → available
      tx.update(sellerRef, {
        'wallet.pending_balance':   admin.firestore.FieldValue.increment(-order.totalAmount),
        'wallet.available_balance': admin.firestore.FieldValue.increment(order.totalAmount)
      });
      tx.update(orderRef, {
        status:              'delivered',
        deliveredAt:         admin.firestore.FieldValue.serverTimestamp(),
        escrowReleased:      true,
        escrowReleaseMethod: 'buyer_confirmation',
        updatedAt:           admin.firestore.FieldValue.serverTimestamp()
      });
      tx.set(db.collection('wallet_transactions').doc(), {
        userId: order.sellerId, type: 'escrow_release', amount: order.totalAmount,
        currency: 'USD', orderId, buyerId: order.buyerId,
        method: 'buyer_confirmation', status: 'completed',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await createNotification(order.sellerId, 'transaction_success', 'Payment Released! 🎉',
      `$${Number(order.totalAmount).toFixed(2)} USD released to your available balance.`, 'wallet');
    res.json({ success: true, message: 'Delivery confirmed. Funds released to seller.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST raise dispute — freezes escrow
app.post('/api/orders/dispute', verifyToken, async (req, res) => {
  const { orderId, reason } = req.body;
  if (!reason || reason.trim().length < 10)
    return res.status(400).json({ error: 'Please provide a detailed reason (minimum 10 characters)' });
  try {
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) return res.status(404).json({ error: 'Order not found' });
    const order = orderDoc.data();
    if (order.buyerId !== req.user.uid) return res.status(403).json({ error: 'Only the buyer can raise a dispute' });
    if (order.disputed) return res.status(400).json({ error: 'A dispute has already been raised for this order' });
    if (order.escrowReleased) return res.status(400).json({ error: 'Cannot dispute — escrow already released' });
    await orderRef.update({
      disputed: true, disputeReason: reason.trim(),
      disputedAt:  admin.firestore.FieldValue.serverTimestamp(),
      status:      'disputed',
      escrowStatus:'frozen',
      updatedAt:   admin.firestore.FieldValue.serverTimestamp()
    });
    // Notify all admins
    const adminSnap = await db.collection('users').where('role', '==', 'administrator').get();
    await Promise.all(adminSnap.docs.map(d =>
      createNotification(d.id, 'dispute_raised', 'Order Dispute Raised',
        `Order #${orderId.slice(-8)}: ${reason.slice(0, 100)}`, 'dispute', orderId)
    ));
    res.json({ success: true, message: 'Dispute raised. Funds frozen pending admin review.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST admin resolves dispute
app.post('/api/orders/resolve-dispute', verifyToken, requireAdmin, async (req, res) => {
  const { orderId, resolution, releaseTo } = req.body;
  // releaseTo: 'seller' | 'buyer'
  if (!['seller', 'buyer'].includes(releaseTo))
    return res.status(400).json({ error: 'releaseTo must be "seller" or "buyer"' });
  if (!resolution || resolution.trim().length < 5)
    return res.status(400).json({ error: 'Resolution note required' });
  try {
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) return res.status(404).json({ error: 'Order not found' });
    const order = orderDoc.data();
    if (!order.disputed) return res.status(400).json({ error: 'No active dispute on this order' });
    if (order.escrowReleased) return res.status(400).json({ error: 'Escrow already released' });

    await db.runTransaction(async (tx) => {
      if (releaseTo === 'seller') {
        // Funds go to seller
        const sellerRef = db.collection('users').doc(order.sellerId);
        tx.update(sellerRef, {
          'wallet.pending_balance':   admin.firestore.FieldValue.increment(-order.totalAmount),
          'wallet.available_balance': admin.firestore.FieldValue.increment(order.totalAmount)
        });
      } else {
        // Refund buyer
        const buyerRef  = db.collection('users').doc(order.buyerId);
        const sellerRef = db.collection('users').doc(order.sellerId);
        tx.update(buyerRef,  { 'wallet.available_balance': admin.firestore.FieldValue.increment(order.totalAmount) });
        tx.update(sellerRef, { 'wallet.pending_balance':   admin.firestore.FieldValue.increment(-order.totalAmount) });
      }
      tx.update(orderRef, {
        status: 'dispute_resolved', disputed: false,
        escrowReleased: true, escrowReleaseMethod: `admin_${releaseTo}`,
        disputeResolution: resolution.trim(),
        resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
        resolvedBy: req.user.uid,
        updatedAt:  admin.firestore.FieldValue.serverTimestamp()
      });
      tx.set(db.collection('wallet_transactions').doc(), {
        userId: releaseTo === 'seller' ? order.sellerId : order.buyerId,
        type: 'dispute_resolution', amount: order.totalAmount,
        currency: 'USD', orderId, method: `admin_${releaseTo}`, status: 'completed',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    const sellerMsg = releaseTo === 'seller'
      ? `Dispute resolved in your favour. $${Number(order.totalAmount).toFixed(2)} USD released.`
      : `Dispute resolved. Funds refunded to buyer.`;
    const buyerMsg = releaseTo === 'buyer'
      ? `Dispute resolved in your favour. $${Number(order.totalAmount).toFixed(2)} USD refunded.`
      : `Dispute resolved. Funds released to seller.`;
    await createNotification(order.sellerId, 'dispute_resolved', 'Dispute Resolved', sellerMsg, 'order', orderId);
    await createNotification(order.buyerId,  'dispute_resolved', 'Dispute Resolved', buyerMsg,  'order', orderId);
    res.json({ success: true, message: `Dispute resolved — funds released to ${releaseTo}.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET order details (buyer or seller only)
app.get('/api/orders/:orderId', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('orders').doc(req.params.orderId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Order not found' });
    const order = doc.data();
    if (order.buyerId !== req.user.uid && order.sellerId !== req.user.uid)
      return res.status(403).json({ error: 'Access denied' });
    res.json({ order: { id: doc.id, ...order, createdAt: order.createdAt?.toDate?.() || null } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET orders list for current user
app.get('/api/orders', verifyToken, async (req, res) => {
  const { role = 'buyer', status, limit = 20 } = req.query;
  try {
    const field = role === 'seller' ? 'sellerId' : 'buyerId';
    let query = db.collection('orders')
      .where(field, '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit));
    if (status) query = query.where('status', '==', status);
    const snap = await query.get();
    const orders = snap.docs.map(d => ({
      id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.() || null
    }));
    res.json({ orders });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ESCROW AUTO-RELEASE CRON (hourly, releases after 48h)
// ============================================================================

async function runHourlyEscrowRelease() {
  if (!db) return;
  console.log('[Cron] Escrow auto-release check:', new Date().toISOString());
  const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
  try {
    const snap = await db.collection('orders')
      .where('status', '==', 'dispatched')
      .where('disputed', '==', false)
      .where('escrowReleased', '==', false)
      .get();
    let released = 0;
    for (const doc of snap.docs) {
      const order = doc.data();
      const dispatched = order.dispatchedAt?.toMillis?.();
      if (!dispatched || Date.now() - dispatched < FORTY_EIGHT_HOURS) continue;
      try {
        await db.runTransaction(async (tx) => {
          const sellerRef = db.collection('users').doc(order.sellerId);
          tx.update(sellerRef, {
            'wallet.pending_balance':   admin.firestore.FieldValue.increment(-order.totalAmount),
            'wallet.available_balance': admin.firestore.FieldValue.increment(order.totalAmount)
          });
          tx.update(doc.ref, {
            status: 'delivered', autoReleased: true, escrowReleased: true,
            escrowReleaseMethod: 'auto_48hr',
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt:   admin.firestore.FieldValue.serverTimestamp()
          });
          tx.set(db.collection('wallet_transactions').doc(), {
            userId: order.sellerId, type: 'escrow_release', amount: order.totalAmount,
            currency: 'USD', orderId: doc.id, buyerId: order.buyerId,
            method: 'auto_release', status: 'completed',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });
        released++;
        await createNotification(order.sellerId, 'transaction_success', 'Funds Auto-Released 🎉',
          `$${Number(order.totalAmount).toFixed(2)} USD for order #${doc.id.slice(-8)} released after 48 hours.`, 'wallet');
      } catch (err) {
        console.error(`Failed to auto-release order ${doc.id}:`, err.message);
      }
    }
    console.log(`[Cron] Auto-released ${released} orders`);
  } catch (err) {
    console.error('[Cron] Escrow routine error:', err.message);
  }
}
cron.schedule('0 * * * *', runHourlyEscrowRelease);

// ============================================================================
// NOTIFICATIONS
// ============================================================================

app.get('/api/notifications', verifyToken, async (req, res) => {
  const { limit = 50, unreadOnly = false } = req.query;
  try {
    let query = db.collection('notifications')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit));
    if (unreadOnly === 'true') query = query.where('read', '==', false);
    const snap = await query.get();
    res.json({ notifications: snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.() || new Date() })) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.post('/api/notifications/mark-read', verifyToken, async (req, res) => {
  const { notificationId } = req.body;
  try {
    const ref = db.collection('notifications').doc(notificationId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Notification not found' });
    if (doc.data().userId !== req.user.uid) return res.status(403).json({ error: 'Unauthorized' });
    await ref.update({ read: true, readAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/notifications/mark-all-read', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('notifications').where('userId', '==', req.user.uid).where('read', '==', false).get();
    const batch = db.batch();
    snap.forEach(d => batch.update(d.ref, { read: true, readAt: admin.firestore.FieldValue.serverTimestamp() }));
    await batch.commit();
    res.json({ success: true, count: snap.size });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/notifications/unread-count', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('notifications').where('userId', '==', req.user.uid).where('read', '==', false).get();
    res.json({ count: snap.size });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// COMMISSION TRACKING
// ============================================================================

const COMMISSION_RATE = 0.05;

app.get('/api/commissions/stats', verifyToken, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const snap = await db.collection('supplier_orders').where('supplierId', '==', req.user.uid).get();
    let totalRevenue = 0, totalCommission = 0;
    snap.forEach(d => { const r = d.data().total || 0; totalRevenue += r; totalCommission += r * COMMISSION_RATE; });
    res.json({ totalRevenue: totalRevenue.toFixed(2), totalCommission: totalCommission.toFixed(2), commissionRate: COMMISSION_RATE * 100, orderCount: snap.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/commissions/track', verifyToken, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  const { orderId, productId, amount } = req.body;
  if (!orderId || !amount) return res.status(400).json({ error: 'Order ID and amount required' });
  try {
    const commission = amount * COMMISSION_RATE;
    await db.collection('commission_tracking').add({
      orderId, productId, supplierId: req.user.uid, amount: commission,
      rate: COMMISSION_RATE, createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true, commission: commission.toFixed(2), rate: COMMISSION_RATE * 100 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// ANIMAL CENSUS (Extension Officers)
// ============================================================================

app.get('/api/census/animal', verifyToken, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();
    if (userData.role !== 'extension_officer') return res.status(403).json({ error: 'Officer access only' });
    const district = userData.district;
    if (!district) return res.status(400).json({ error: 'No district assigned' });
    const farmersSnap = await db.collection('users').where('role', '==', 'farmer').where('district', '==', district).get();
    const farmerIds = farmersSnap.docs.map(d => d.id);
    if (!farmerIds.length) return res.json({ total: 0, byType: {}, byFarmer: [], district });
    const chunks = [];
    for (let i = 0; i < farmerIds.length; i += 10) chunks.push(farmerIds.slice(i, i + 10));
    const chunkSnaps = await Promise.all(chunks.map(c => db.collection('farm_animals').where('ownerId', 'in', c).get()));
    const allDocs = chunkSnaps.flatMap(s => s.docs);
    const byType = { cattle: 0, goats: 0, sheep: 0, poultry: 0, pigs: 0, other: 0 };
    const byFarmer = {};
    allDocs.forEach(d => {
      const type = d.data().type || 'other';
      byType[type] !== undefined ? byType[type]++ : byType.other++;
      byFarmer[d.data().ownerId] = (byFarmer[d.data().ownerId] || 0) + 1;
    });
    const farmerNames = {};
    for (const fid of Object.keys(byFarmer)) {
      const fd = await db.collection('users').doc(fid).get();
      if (fd.exists) farmerNames[fid] = fd.data().name || 'Unknown';
    }
    res.json({
      total: allDocs.length, byType, district,
      farmersWithAnimals: Object.keys(byFarmer).length,
      byFarmer: Object.entries(byFarmer)
        .map(([id, count]) => ({ farmerId: id, farmerName: farmerNames[id] || 'Unknown', animalCount: count }))
        .sort((a, b) => b.animalCount - a.animalCount)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// WEATHER
// ============================================================================

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
      const err = await curRes.json().catch(() => ({}));
      return res.status(curRes.status).json({ error: err.message || 'Weather fetch failed' });
    }
    const cur = await curRes.json();
    const fcast = fcastRes.ok ? await fcastRes.json() : null;
    let todayMin = cur.main.temp, todayMax = cur.main.temp;
    if (fcast?.list) {
      const todayStr = new Date(Date.now() + 2*3600000).toISOString().split('T')[0];
      const todays = fcast.list.filter(s => s.dt_txt.startsWith(todayStr));
      if (todays.length) {
        todayMin = Math.min(...todays.map(s => s.main.temp_min), cur.main.temp);
        todayMax = Math.max(...todays.map(s => s.main.temp_max), cur.main.temp);
      }
    }
    res.json({
      city: cur.name, temp: Math.round(cur.main.temp), feelsLike: Math.round(cur.main.feels_like),
      description: cur.weather[0].description, icon: cur.weather[0].icon,
      humidity: cur.main.humidity, windSpeed: Math.round(cur.wind.speed), clouds: cur.clouds.all,
      todayMin: Math.round(todayMin), todayMax: Math.round(todayMax)
    });
  } catch (e) {
    res.status(500).json({ error: 'Weather unavailable: ' + e.message });
  }
});

// ============================================================================
// FILE UPLOAD (Supabase)
// ============================================================================

app.post('/api/upload', verifyToken, upload.single('file'), async (req, res) => {
  if (!supabaseReady) return res.status(503).json({ error: 'Storage not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file found in request' });
  try {
    const ext      = path.extname(req.file.originalname) || '';
    const filename = `${req.user.uid}-${Date.now()}${ext}`;
    let folder = 'docs';
    if (req.file.mimetype.startsWith('image/')) folder = 'images';
    if (req.file.mimetype.startsWith('video/')) folder = 'videos';
    if (req.file.mimetype.startsWith('audio/')) folder = 'audio';
    const filePath = `${folder}/${filename}`;
    const { error } = await supabase.storage.from('media-bucket').upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) throw error;
    const { data: { publicUrl } } = supabase.storage.from('media-bucket').getPublicUrl(filePath);
    res.json({ success: true, url: publicUrl, type: folder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// PUSH NOTIFICATIONS
// ============================================================================

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

app.post('/api/push/resubscribe', async (req, res) => {
  if (!db) return res.json({ success: false });
  const { oldEndpoint, subscription } = req.body;
  if (!subscription || !oldEndpoint) return res.json({ success: false });
  try {
    const snap = await db.collection('users').where('pushSubscription.endpoint', '==', oldEndpoint).limit(1).get();
    if (snap.empty) return res.json({ success: false, reason: 'not_found' });
    await snap.docs[0].ref.update({ pushSubscription: subscription, pushUpdatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, reason: e.message });
  }
});

app.post('/api/push/broadcast', verifyToken, requireAdmin, async (req, res) => {
  if (!pushReady || !db) return res.status(503).json({ error: 'Push not configured' });
  const { title, body, url, tag, district } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  try {
    let query = db.collection('users');
    if (district) query = query.where('district', '==', district);
    const usersSnap = await query.get();
    const payload = { title, body: body || '', url: url || '/notifications.html', tag: tag || 'fcz-alert' };
    let sent = 0;
    await Promise.allSettled(
      usersSnap.docs.filter(d => d.data().pushSubscription).map(async d => {
        const ok = await _sendPush(d.id, d.data().pushSubscription, payload);
        if (ok) sent++;
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
  if (!recipientId) return res.status(400).json({ error: 'recipientId required' });
  try {
    const snap = await db.collection('users').doc(recipientId).get();
    if (!snap.exists || !snap.data().pushSubscription) return res.json({ success: false, reason: 'no_subscription' });
    const ok = await _sendPush(recipientId, snap.data().pushSubscription, {
      title: `💬 ${senderName || 'New message'}`,
      body: preview ? preview.slice(0, 120) : 'You have a new message',
      url: '/messages.html', tag: 'fcz-message'
    });
    res.json({ success: ok });
  } catch (e) {
    res.json({ success: false, reason: e.message });
  }
});

// ============================================================================
// PAYMENTS (Paynow)
// ============================================================================

app.post('/api/payment/initiate', verifyToken, async (req, res) => {
  const { phone, method, amount, items } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (method === 'cash') return res.json({ success: true, reference: 'CASH-' + Date.now(), message: 'Cash order placed' });
  const PAYNOW_ID  = process.env.PAYNOW_ID;
  const PAYNOW_KEY = process.env.PAYNOW_KEY;
  if (!PAYNOW_ID || !PAYNOW_KEY) {
    return res.json({ success: true, reference: 'PENDING-' + Date.now(), paynow: false, message: 'Order recorded. Add PAYNOW_ID and PAYNOW_KEY to enable live payments.' });
  }
  try {
    const reference  = 'FCZ-' + Date.now();
    const itemDesc   = (items || []).map(i => i.name + ' x' + i.qty).join(', ').slice(0, 100);
    const baseUrl    = (process.env.RENDER_EXTERNAL_URL || 'https://farmconnectzw.onrender.com').replace(/\/+$/, '');
    const isMobile   = ['ecocash', 'onemoney', 'innbucks'].includes(method);
    const amount_str = Number(amount).toFixed(2);
    const returnurl  = baseUrl + '/marketplace.html';
    const resulturl  = baseUrl + '/api/payment/callback';
    const authemail  = req.user.email || '';
    function paynowHash(values, key) {
      return crypto.createHash('sha512').update(values.join('') + key, 'utf8').digest('hex').toUpperCase();
    }
    let paynowUrl, fields;
    if (!isMobile) {
      fields = { id: String(PAYNOW_ID), reference, amount: amount_str, additionalinfo: itemDesc, returnurl, resulturl, status: 'Message', authemail };
      fields.hash = paynowHash([fields.id, fields.reference, fields.amount, fields.additionalinfo, fields.returnurl, fields.resulturl, fields.status, fields.authemail], PAYNOW_KEY);
      paynowUrl = 'https://www.paynow.co.zw/interface/initiatetransaction';
    } else {
      const normPhone = ('263' + phone.replace(/^\+?2630?|^0/, '').replace(/\D/g, '')).slice(0, 12);
      fields = { id: String(PAYNOW_ID), reference, amount: amount_str, additionalinfo: itemDesc, returnurl, resulturl, status: 'Message', method, phone: normPhone, authemail };
      fields.hash = paynowHash([fields.id, fields.reference, fields.amount, fields.additionalinfo, fields.returnurl, fields.resulturl, fields.status, fields.method, fields.phone, fields.authemail], PAYNOW_KEY);
      paynowUrl = 'https://www.paynow.co.zw/interface/remotetransaction';
    }
    const pnRes  = await fetch(paynowUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
    const parsed = {};
    (await pnRes.text()).split('&').forEach(pair => {
      const eq = pair.indexOf('=');
      if (eq > -1) parsed[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    });
    const pnStatus = (parsed.status || '').toLowerCase();
    if (pnStatus === 'ok' || pnStatus === 'sent') {
      res.json({ success: true, reference, pollUrl: parsed.pollurl || null, redirectUrl: parsed.browserurl || null });
    } else {
      res.json({ success: false, error: parsed.error || 'Paynow error: ' + (parsed.status || 'unknown') });
    }
  } catch (e) {
    res.status(500).json({ error: 'Payment service error: ' + e.message });
  }
});

app.post('/api/payment/callback', async (req, res) => {
  const { reference, status, paynowreference } = req.body;
  if (db && reference) {
    try {
      const snap = await db.collection('orders').where('reference', '==', reference).limit(1).get();
      if (!snap.empty) {
        await snap.docs[0].ref.update({
          status: (status || '').toLowerCase() === 'paid' ? 'paid' : 'payment_failed',
          paynowReference: paynowreference || null
        });
      }
    } catch (e) { console.error('Callback error:', e.message); }
  }
  res.send('OK');
});

// ============================================================================
// MARKET PRICES CRON
// ============================================================================

let _lastPriceCronDate = '';
let _lastCronRunAt     = null;
let _lastCronStatus    = 'never_run';

async function runDailyPriceCron() {
  if (!db) return;
  const nowZW    = new Date(Date.now() + 2 * 3600000);
  const todayStr = nowZW.toISOString().split('T')[0];
  if (_lastPriceCronDate === todayStr) return;
  _lastPriceCronDate = todayStr;
  _lastCronStatus    = 'running';
  console.log(`[Cron] Market price refresh for ${todayStr}`);
  const commodities = [
    { commodity: 'Maize',       unit: 'per 50kg bag',    district: 'Harare',   base: 420,  volatility: 30 },
    { commodity: 'Maize',       unit: 'per 50kg bag',    district: 'Bulawayo', base: 430,  volatility: 30 },
    { commodity: 'Maize',       unit: 'per 50kg bag',    district: 'Mutare',   base: 415,  volatility: 25 },
    { commodity: 'Maize',       unit: 'per 50kg bag',    district: 'Kwekwe',   base: 418,  volatility: 25 },
    { commodity: 'Wheat',       unit: 'per ton',          district: 'Harare',   base: 6800, volatility: 200 },
    { commodity: 'Soya Beans',  unit: 'per ton',          district: 'Harare',   base: 9200, volatility: 300 },
    { commodity: 'Groundnuts',  unit: 'per kg',           district: 'Gweru',    base: 5.2,  volatility: 0.4 },
    { commodity: 'Sunflower',   unit: 'per ton',          district: 'Harare',   base: 5500, volatility: 150 },
    { commodity: 'Sugar Beans', unit: 'per kg',           district: 'Masvingo', base: 12,   volatility: 0.8 },
    { commodity: 'Cattle',      unit: 'per head',         district: 'Harare',   base: 1800, volatility: 100 },
    { commodity: 'Goats',       unit: 'per head',         district: 'Harare',   base: 280,  volatility: 20 },
    { commodity: 'Poultry',     unit: 'per bird',         district: 'Harare',   base: 22,   volatility: 2 },
    { commodity: 'Tomatoes',    unit: 'per 30kg crate',   district: 'Harare',   base: 85,   volatility: 15 },
    { commodity: 'Potatoes',    unit: 'per 50kg bag',     district: 'Mutare',   base: 160,  volatility: 20 },
    { commodity: 'Cabbages',    unit: 'per head',         district: 'Harare',   base: 3.5,  volatility: 0.5 },
    { commodity: 'Onions',      unit: 'per 20kg bag',     district: 'Kwekwe',   base: 95,   volatility: 10 },
  ];
  try {
    const batch    = db.batch();
    const prevSnap = await db.collection('marketPrices').where('autoGenerated', '==', true).orderBy('updatedAt', 'desc').limit(commodities.length * 2).get();
    const prevPrices = {};
    prevSnap.docs.forEach(d => {
      const p   = d.data();
      const key = `${p.commodity}|${p.district}`;
      if (!prevPrices[key]) prevPrices[key] = p.price;
    });
    for (const item of commodities) {
      const key       = `${item.commodity}|${item.district}`;
      const prev      = prevPrices[key] || item.base;
      const change    = (Math.random() - 0.5) * 2 * item.volatility;
      const raw       = Math.max(item.base * 0.6, Math.min(item.base * 1.4, prev + change));
      const price     = item.base < 10 ? Math.round(raw * 100) / 100 : Math.round(raw);
      const trend     = price > prev + item.volatility * 0.1 ? 'up' : price < prev - item.volatility * 0.1 ? 'down' : 'stable';
      const ref       = db.collection('marketPrices').doc(`${item.commodity.replace(/\s+/g,'_')}_${item.district}_auto`);
      batch.set(ref, { commodity: item.commodity, unit: item.unit, district: item.district, price, trend, prevPrice: prev, autoGenerated: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    await batch.commit();
    _lastCronRunAt  = new Date().toISOString();
    _lastCronStatus = 'success';
    console.log(`[Cron] ${commodities.length} price docs written`);
    if (pushReady) {
      const usersSnap = await db.collection('users').get();
      let sent = 0;
      await Promise.allSettled(
        usersSnap.docs.filter(d => d.data().pushSubscription).map(async d => {
          if (await _sendPush(d.id, d.data().pushSubscription, { title: '📊 Daily Market Prices Updated', body: `Fresh prices for ${todayStr} are now available.`, url: '/market-prices.html', tag: 'fcz-prices-daily' })) sent++;
        })
      );
      console.log(`[Cron] Price push sent to ${sent} devices`);
    }
  } catch (e) {
    _lastCronStatus = 'failed: ' + e.message;
    console.error('[Cron] Price cron failed:', e.message);
  }
}

setInterval(() => { if (new Date(Date.now() + 2*3600000).getUTCHours() === 6) runDailyPriceCron(); }, 30 * 60 * 1000);
runDailyPriceCron();

app.post('/api/cron/prices', async (req, res, next) => {
  const secret   = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'];
  if (secret && provided === secret) { _lastPriceCronDate = ''; await runDailyPriceCron(); return res.json({ success: true, status: _lastCronStatus, ranAt: _lastCronRunAt }); }
  if (secret && provided !== secret) return res.status(401).json({ error: 'Invalid cron secret' });
  next();
}, verifyToken, requireAdmin, async (req, res) => {
  _lastPriceCronDate = ''; await runDailyPriceCron();
  res.json({ success: true, status: _lastCronStatus, ranAt: _lastCronRunAt });
});

app.get('/api/cron/status', verifyToken, requireAdmin, (req, res) => {
  res.json({ lastRunAt: _lastCronRunAt || 'never', lastStatus: _lastCronStatus, lastDateKey: _lastPriceCronDate || 'none', serverTime: new Date().toISOString(), zimbabweTime: new Date(Date.now() + 2*3600000).toISOString() });
});

// ============================================================================
// AGROBOT — supports plain JSON and multipart/form-data (with files/audio)
// ============================================================================

async function buildUserContext(uid) {
  if (!db) return '';
  try {
    const [profileRes, pricesRes, livestockRes, listingsRes, yieldsRes] = await Promise.allSettled([
      db.collection('users').doc(uid).get(),
      db.collection('marketPrices').orderBy('updatedAt', 'desc').limit(20).get(),
      db.collection('livestock').where('ownerId', '==', uid).limit(50).get(),
      db.collection('listings').where('userId', '==', uid).where('status', '==', 'active').limit(10).get(),
      db.collection('crop_yields').where('userId', '==', uid).orderBy('createdAt', 'desc').limit(5).get()
    ]);
    let context = '\n\n--- LIVE USER CONTEXT ---\n';
    if (profileRes.status === 'fulfilled' && profileRes.value.exists) {
      const p = profileRes.value.data();
      context += `User: ${p.name || 'Unknown'}\nRole: ${p.role || 'farmer'}\nDistrict: ${p.district || 'Not specified'}\n`;
    }
    if (pricesRes.status === 'fulfilled' && !pricesRes.value.empty) {
      const userDistrict = profileRes.status === 'fulfilled' && profileRes.value.exists ? (profileRes.value.data().district || '') : '';
      const seen = new Set(); const prices = [];
      pricesRes.value.docs.forEach(d => { const p = d.data(); const k = `${p.commodity}|${p.district}`; if (!seen.has(k)) { seen.add(k); prices.push(p); } });
      prices.sort((a, b) => (a.district === userDistrict ? -1 : b.district === userDistrict ? 1 : 0));
      context += '\nMarket Prices (ZiG):\n';
      prices.slice(0, 12).forEach(p => {
        const arrow = p.trend === 'up' ? '↑' : p.trend === 'down' ? '↓' : '→';
        context += `  ${p.commodity} (${p.district}): ZiG ${p.price} ${p.unit} ${arrow}\n`;
      });
    }
    if (livestockRes.status === 'fulfilled' && !livestockRes.value.empty) {
      const counts = {};
      livestockRes.value.docs.forEach(d => { const t = d.data().type || 'other'; counts[t] = (counts[t] || 0) + 1; });
      context += '\nLivestock:\n';
      Object.entries(counts).forEach(([t, n]) => { context += `  ${t}: ${n}\n`; });
    }
    if (listingsRes.status === 'fulfilled' && !listingsRes.value.empty) {
      context += '\nActive Listings:\n';
      listingsRes.value.docs.forEach(d => { const l = d.data(); context += `  ${l.title || 'Listing'}: ZiG ${l.price || '?'} (${l.category || 'general'})\n`; });
    }
    if (yieldsRes.status === 'fulfilled' && !yieldsRes.value.empty) {
      context += '\nRecent Yields:\n';
      yieldsRes.value.docs.forEach(d => { const y = d.data(); context += `  ${y.crop || 'Crop'}: ${y.amount || '?'} ${y.unit || 'kg'} — ${y.season || ''}\n`; });
    }
    context += '--- END CONTEXT ---\n';
    return context;
  } catch (e) {
    console.error('[AgroBot] Context build failed:', e.message);
    return '';
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL     = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const chatLimiter    = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many chat requests. Please wait a moment.' } });

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
- When the user context block is present, USE it — reference the user's district, livestock, listings, and real market prices
- If market prices are in context, quote them with ZiG amount and trend arrow
- If a question is unrelated to agriculture or rural livelihoods, politely redirect
- Be warm and encouraging — most users are smallholder farmers
- Respond in the same language as the user (English or Shona/Ndebele if detected)
- Keep responses concise — under 200 words unless detail is genuinely needed`;

// Chat route — accepts both JSON (text only) and multipart (with files/audio)
app.post('/api/chat', verifyToken, chatLimiter, upload.any(), async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(503).json({ error: 'Chatbot not configured. Add GEMINI_API_KEY to environment variables.' });

  // Works for both JSON and FormData
  const message = req.body.message;
  const history = (() => { try { return JSON.parse(req.body.history || '[]'); } catch { return []; } })();
  const files   = req.files || [];
  const hasAudio = files.some(f => f.mimetype.startsWith('audio/'));

  if (!message && !files.length) return res.status(400).json({ error: 'Message is required' });
  if (message && message.length > 2000) return res.status(400).json({ error: 'Message too long (max 2000 characters)' });

  try {
    const liveContext = await buildUserContext(req.user.uid);

    // Build Gemini content parts
    const userParts = [];

    // Attach images inline (base64) so Gemini can see them
    for (const file of files) {
      if (file.mimetype.startsWith('image/')) {
        userParts.push({
          inlineData: {
            mimeType: file.mimetype,
            data: file.buffer.toString('base64')
          }
        });
      }
    }

    // Attach document filenames as text context (Gemini can't parse PDFs directly without Document AI)
    const docFiles = files.filter(f => !f.mimetype.startsWith('image/') && !f.mimetype.startsWith('audio/'));
    if (docFiles.length) {
      userParts.push({ text: `[User also attached: ${docFiles.map(f => f.originalname).join(', ')}]` });
    }

    if (hasAudio) {
      userParts.push({ text: '[User sent a voice message — transcription not available server-side. Respond based on text message if provided.]' });
    }

    // Main message text
    userParts.push({ text: `${AGRI_SYSTEM_PROMPT}${liveContext}\n\nUser message: ${(message || '').trim()}` });

    const contents = [];
    history.slice(-6).forEach(turn => {
      contents.push({ role: turn.role === 'model' ? 'model' : 'user', parts: [{ text: turn.text }] });
    });
    contents.push({ role: 'user', parts: userParts });

    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents })
    });
    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      console.error('Gemini error:', geminiRes.status, data);
      return res.status(502).json({ error: data.error?.message || 'AI service temporarily unavailable' });
    }
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) return res.status(502).json({ error: 'No response from AI' });
    res.json({ reply: reply.trim() });
  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: 'Chat service error' });
  }
});

// ============================================================================
// START
// ============================================================================

server.listen(PORT, '0.0.0.0', () => {
  console.log(`FarmConnectZW server running on port ${PORT}`);
});
