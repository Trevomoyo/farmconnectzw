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

// ── Render API Config ────────────────────────────────────────────────────────
const API_URL = 'https://farmconnectzw.onrender.com';

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
      localStorage.setItem('fcz_role', _userProfile.role || 'farmer');
      // Auto-trigger push prompt once per session, 3s after page settles
      _maybeTriggerPush();
      return _userProfile;
    }
  } catch (e) { console.warn('loadProfile:', e); }
  return null;
}

let _pushInitDone = false;
function _maybeTriggerPush() {
  if (_pushInitDone) return;
  _pushInitDone = true;
  setTimeout(() => initPushNotifications(), 3000);
}

// ── Role helpers ──────────────────────────────────────────────────────────────
function getRole() {
  return _userProfile?.role || localStorage.getItem('fcz_role') || 'farmer';
}

function dashboardFor(role) {
  const map = {
    farmer:           'dashboard-farmer.html',
    extension_officer:'dashboard-officer.html',
    administrator:    'dashboard-admin.html',
    supplier:         'supplier-portal.html'
  };
  return map[role] || 'dashboard-farmer.html';
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function logout() {
  try {
    _pushInitDone = false;
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

// ── Push Notifications ────────────────────────────────────────────────────────
// Two-step: show an in-app prompt first (so the browser dialog is triggered
// by a real user gesture), then register the subscription.

async function _registerPushSubscription() {
  try {
    const keyRes = await fetch(`${API_URL}/api/push/vapid-key`);
    if (!keyRes.ok) { console.warn('FCZ: Push not configured on server'); return false; }
    const { publicKey } = await keyRes.json();
    if (!publicKey) return false;

    // Register BOTH service workers (idempotent — safe to call multiple times)
    // sw.js for Web Push + offline caching
    await navigator.serviceWorker.register('/sw.js');
    // firebase-messaging-sw.js for Firebase Cloud Messaging (background notifications)
    await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    await navigator.serviceWorker.ready;

    // Check if already subscribed (use the main sw.js registration)
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const existing = await reg.pushManager.getSubscription();
    const subscription = existing || await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlBase64ToUint8Array(publicKey)
    });

    // Save subscription to server / Firestore
    const token = await _currentUser.getIdToken();
    const res = await fetch(`${API_URL}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ subscription })
    });
    if (!res.ok) throw new Error('Subscribe endpoint failed');
    console.log('FCZ: Push registered ✓');
    return true;
  } catch (e) {
    console.warn('FCZ: Push registration failed:', e.message);
    return false;
  }
}

// Call this once per session after the user is logged in.
// Shows a soft in-app card first, then requests browser permission on click.
async function initPushNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !_currentUser) return;

  // Already granted — silently re-register (handles returning users / new devices)
  if (Notification.permission === 'granted') {
    await _registerPushSubscription();
    return;
  }

  // User already denied — don't ask again
  if (Notification.permission === 'denied') return;

  // 'default' — show a soft prompt card so the browser dialog is user-gesture driven
  _showPushPromptCard();
}

function _showPushPromptCard() {
  // Don't show twice
  if (document.getElementById('fcz-push-prompt')) return;

  const card = document.createElement('div');
  card.id = 'fcz-push-prompt';
  card.style.cssText = `
    position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
    z-index:8500; width:min(360px,calc(100vw - 32px));
    background:#1a3617; border:1px solid rgba(157,204,130,.35);
    border-radius:16px; padding:18px 20px;
    box-shadow:0 8px 32px rgba(0,0,0,.45);
    display:flex; flex-direction:column; gap:12px;
    animation:fcz-slide-up .35s cubic-bezier(.34,1.56,.64,1) both;
  `;
  card.innerHTML = `
    <style>
      @keyframes fcz-slide-up {
        from { transform:translateX(-50%) translateY(20px); opacity:0; }
        to   { transform:translateX(-50%) translateY(0);    opacity:1; }
      }
    </style>
    <div style="display:flex;gap:12px;align-items:flex-start;">
      <div style="font-size:1.6rem;line-height:1;">🔔</div>
      <div>
        <div style="font-weight:700;font-size:.95rem;color:#f0f7ee;font-family:sans-serif;">
          Stay in the loop
        </div>
        <div style="font-size:.82rem;color:rgba(232,242,231,.6);margin-top:3px;line-height:1.5;font-family:sans-serif;">
          Get notified about new messages, market alerts and farm advisories even when the app is closed.
        </div>
      </div>
      <button id="fcz-push-dismiss" style="background:none;border:none;color:rgba(232,242,231,.4);font-size:1.1rem;cursor:pointer;padding:0;line-height:1;flex-shrink:0;">✕</button>
    </div>
    <div style="display:flex;gap:8px;">
      <button id="fcz-push-allow" style="
        flex:1;background:#3d7a35;border:none;color:#fff;
        padding:10px 16px;border-radius:10px;font-size:.875rem;font-weight:600;
        cursor:pointer;font-family:sans-serif;transition:background .15s;
      ">Allow Notifications</button>
      <button id="fcz-push-later" style="
        background:rgba(157,204,130,.1);border:1px solid rgba(157,204,130,.2);color:rgba(232,242,231,.6);
        padding:10px 16px;border-radius:10px;font-size:.875rem;
        cursor:pointer;font-family:sans-serif;transition:background .15s;
      ">Not now</button>
    </div>
  `;

  document.body.appendChild(card);

  const dismiss = () => { card.style.opacity = '0'; card.style.transform = 'translateX(-50%) translateY(10px)'; setTimeout(() => card.remove(), 200); };

  document.getElementById('fcz-push-dismiss').onclick = dismiss;
  document.getElementById('fcz-push-later').onclick   = () => {
    localStorage.setItem('fcz_push_snoozed', Date.now().toString());
    dismiss();
  };

  document.getElementById('fcz-push-allow').onclick = async () => {
    dismiss();
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        const ok = await _registerPushSubscription();
        if (ok) showToast('Notifications enabled ✓', 'success');
      }
    } catch (e) {
      console.warn('FCZ: Permission request failed:', e.message);
    }
  };
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
    fetch(`${API_URL}/api/notify/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ recipientId, senderName, preview })
    });
  } catch (e) { /* non-critical */ }
}

// ── Export to window so all inline page scripts can use them ─────────────────
window.FCZ = {
  Auth, DB,
  API_URL,
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