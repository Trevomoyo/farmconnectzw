# FarmConnectZW — Clean Rebuild

National Agricultural Coordination Platform for Zimbabwe.
Stack: **Firebase Auth + Firestore + Firebase Hosting**. No backend server, no PostgreSQL.

## Project Structure

```
FarmConnectZW/
├── css/styles.css            # Single shared stylesheet
├── js/
│   ├── core.js               # Firebase init, auth, shared utilities
│   └── navbar.js             # Navbar renderer
├── images/                   # Add icon-192.png and icon-512.png here
├── login.html                # Entry point
├── dashboard-farmer.html     # Farmer dashboard
├── dashboard-officer.html    # Extension officer dashboard
├── dashboard-admin.html      # Admin dashboard
├── map.html                  # Interactive Leaflet map
├── livestock-tracking.html   # Add/track animals
├── market-prices.html        # Commodity prices
├── messages.html             # Messaging between users
├── notifications.html        # Alerts and advisories
├── knowledge-hub.html        # Agricultural articles
├── profile.html              # User profile editor
├── firebase.json             # Firebase Hosting config
├── firestore.rules           # Firestore security rules
└── manifest.json             # PWA manifest
```

## Deploy to Firebase Hosting

### 1. Install Firebase CLI (once)
```bash
npm install -g firebase-tools
```

### 2. Login and select project
```bash
firebase login
firebase use farmconnectzw
```

### 3. Deploy Firestore rules
```bash
firebase deploy --only firestore:rules
```

### 4. Deploy the site
```bash
firebase deploy --only hosting
```

Your site will be live at **https://farmconnectzw.web.app**

---

## First-Time Setup in Firestore Console

After deploying, go to [Firebase Console → Firestore](https://console.firebase.google.com/project/farmconnectzw/firestore).

### Create your admin account
1. Register normally on the site (as any role)
2. In Firestore → `users` collection, find your document
3. Change the `role` field to `administrator`

> **Why?** The registration form only allows `farmer` and `extension_officer` to prevent
> anyone self-assigning admin. Admins must be promoted manually in the console.

### Firestore indexes needed
If you see "index required" errors in the console, Firebase will give you a direct link to
create the required indexes. The most common ones needed are:
- `livestock`: `ownerId` ASC + `createdAt` DESC
- `messages`: `recipientId` ASC + `createdAt` DESC
- `alerts`: `active` ASC + `createdAt` DESC

---

## Key Design Decisions

### No race conditions
`js/core.js` initialises Firebase **once** at load time. Every page waits on the
`FCZ.authReady` promise (which resolves on the first `onAuthStateChanged` event) before
making auth-gated decisions. Maps (Leaflet) are always initialised immediately on
`DOMContentLoaded` — they never wait for auth, so they always render.

### No loading overlay deadlocks
`hideLoading()` removes the CSS class **and** sets `display:none`. A crash mid-init
can never leave a fullscreen overlay blocking the page.

### Firestore-only
All data lives in Firestore. No PostgreSQL, no server.js, no Express — nothing to run
locally or deploy separately.

### Static fallbacks
`market-prices.html` and `knowledge-hub.html` include hardcoded fallback data. If
Firestore returns empty or throws a permissions error, the pages still show useful content
rather than a blank screen.

---

## Adding Icons
Add `icon-192.png` and `icon-512.png` to the `images/` folder for PWA support.
A simple green square with the 🌾 emoji works fine as a placeholder.
