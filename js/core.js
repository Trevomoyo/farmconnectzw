/**
 * FarmConnectZW — Core Module
 * Single source of truth for Firebase, Auth state, and shared utilities.
 * All pages load this one file. No circular deps, no race conditions.
 */

// ── Firebase config ──────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyARSui7hmCsODCtbWdZTnTXNHLKsX3j1UM",
  authDomain:        "farmconnectzw.firebaseapp.com",
  projectId:         "farmconnectzw",
  storageBucket:     "farmconnectzw.firebasestorage.app",
  messagingSenderId: "273410033306",
  appId:             "1:273410033306:web:97d124d2b709c7f8808123"
};

// ── Init Firebase once ────────────────────────────────────────────────────────
if (!firebase.apps.length) {
  firebase.initializeApp(FIREBASE_CONFIG);
}

const Auth = firebase.auth();
const DB   = firebase.firestore();

// Enable Firestore offline persistence (best-effort)
DB.enablePersistence({ synchronizeTabs: true }).catch(() => {});

// ── Auth state ────────────────────────────────────────────────────────────────
let _currentUser = null;
let _userProfile  = null;  // Firestore doc data

// Promise that resolves once Firebase has emitted the first auth state event.
const authReady = new Promise(resolve => {
  Auth.onAuthStateChanged(user => {
    _currentUser = user;
    resolve(user);
  });
});

function getCurrentUser()    { return _currentUser; }
function getUserProfile()    { return _userProfile; }
function setUserProfile(p)   { _userProfile = p; }
function isLoggedIn()        { return _currentUser !== null; }

// ── Guard — redirect to login if not authenticated ───────────────────────────
async function requireAuth() {
  await authReady;
  if (!_currentUser) {
    window.location.href = 'login.html';
    return false;
  }
  return true;
}

// ── Load user profile from Firestore ─────────────────────────────────────────
async function loadProfile() {
  if (!_currentUser) return null;
  try {
    const snap = await DB.collection('users').doc(_currentUser.uid).get();
    if (snap.exists) {
      _userProfile = snap.data();
      return _userProfile;
    }
  } catch (e) { console.warn('loadProfile:', e); }
  return null;
}

// ── Role helpers ──────────────────────────────────────────────────────────────
function getRole() {
  return _userProfile?.role || localStorage.getItem('fcz_role') || 'farmer';
}

function dashboardFor(role) {
  const map = {
    farmer:           'dashboard-farmer.html',
    extension_officer:'dashboard-officer.html',
    administrator:    'dashboard-admin.html'
  };
  return map[role] || 'dashboard-farmer.html';
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function logout() {
  try {
    await Auth.signOut();
    localStorage.removeItem('fcz_role');
    window.location.href = 'login.html';
  } catch (e) { showToast('Logout failed', 'error'); }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info', duration = 4000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── Loading overlay ───────────────────────────────────────────────────────────
function showLoading(msg = 'Loading…') {
  let ov = document.getElementById('loading-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'loading-overlay';
    ov.className = 'loading-overlay';
    ov.innerHTML = '<div class="spinner"></div><p id="loading-msg">Loading…</p>';
    document.body.appendChild(ov);
  }
  document.getElementById('loading-msg').textContent = msg;
  ov.classList.add('show');
}

function hideLoading() {
  const ov = document.getElementById('loading-overlay');
  if (ov) {
    ov.classList.remove('show');
    ov.style.display = 'none';   // belt-and-suspenders
  }
}

// ── Navbar ────────────────────────────────────────────────────────────────────
function initNavbar() {
  // Mobile toggle
  const toggle = document.querySelector('.navbar-toggle');
  const nav    = document.querySelector('.navbar-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => nav.classList.toggle('open'));
  }
  // Logout buttons
  document.querySelectorAll('[data-action="logout"]').forEach(btn => {
    btn.addEventListener('click', logout);
  });
  // Active link
  const path = window.location.pathname.split('/').pop();
  document.querySelectorAll('.navbar-nav a').forEach(a => {
    if (a.getAttribute('href') === path) a.classList.add('active');
  });
  // Show user name & role badge if available
  const nameEl = document.getElementById('nav-username');
  const roleEl = document.getElementById('nav-role');
  if (nameEl && _currentUser) nameEl.textContent = _currentUser.displayName || _currentUser.email?.split('@')[0];
  if (roleEl && _userProfile)  roleEl.textContent = roleLabel(getRole());
}

function roleLabel(role) {
  return { farmer: 'Farmer', extension_officer: 'Officer', administrator: 'Admin' }[role] || role;
}

// ── Online / offline banner ───────────────────────────────────────────────────
function initOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  const update = () => banner.classList.toggle('show', !navigator.onLine);
  update();
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
}

// ── Format helpers ────────────────────────────────────────────────────────────
function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-ZW', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtRelative(ts) {
  if (!ts) return '—';
  const d   = ts.toDate ? ts.toDate() : new Date(ts);
  const min = Math.floor((Date.now() - d) / 60000);
  if (min < 1)   return 'Just now';
  if (min < 60)  return `${min}m ago`;
  if (min < 1440)return `${Math.floor(min/60)}h ago`;
  return fmtDate(ts);
}

function initials(name = '') {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function openModal(id)  {
  const m = document.getElementById(id);
  if (m) m.classList.add('show');
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('show');
}
// Close modals on background click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-bg')) e.target.classList.remove('show');
});

// ── Push Notifications (Web Push via Express server) ─────────────────────────
// Uses standard Web Push API — no Firebase Cloud Messaging required.
// Call once after login to register this device for push notifications.
async function initPushNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !_currentUser) return;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    // Get VAPID public key from our Express server
    const keyRes = await fetch('/api/push/vapid-key');
    if (!keyRes.ok) {
      console.warn('FCZ: Push not configured on server — skipping');
      return;
    }
    const { publicKey } = await keyRes.json();
    if (!publicKey) return;

    // Register service worker
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    // Subscribe to Web Push
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlBase64ToUint8Array(publicKey)
    });

    // Send subscription to server
    const token = await _currentUser.getIdToken();
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ subscription })
    });

    console.log('FCZ: Push notifications registered');
  } catch (e) {
    // Non-critical — app works fine without push
    console.warn('FCZ: Push setup failed:', e.message);
  }
}

function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = window.atob(base64);
  return new Uint8Array([...raw].map(c => c.charCodeAt(0)));
}

// ── Notify message recipient via server ───────────────────────────────────────
async function notifyNewMessage(recipientId, senderName, preview) {
  if (!_currentUser) return;
  try {
    const token = await _currentUser.getIdToken();
    fetch('/api/notify/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ recipientId, senderName, preview })
    });
  } catch (e) { /* non-critical */ }
}

// ── Export to window so all inline page scripts can use them ─────────────────
window.FCZ = {
  Auth, DB,
  authReady, requireAuth, loadProfile,
  getCurrentUser, getUserProfile, setUserProfile,
  isLoggedIn, getRole, dashboardFor, logout,
  showToast, showLoading, hideLoading,
  initNavbar, initOfflineBanner,
  fmtDate, fmtRelative, initials,
  openModal, closeModal,
  initPushNotifications,
  notifyNewMessage
};