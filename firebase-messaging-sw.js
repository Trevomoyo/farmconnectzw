// firebase-messaging-sw.js
// Must be at root of domain for push notifications to work

importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyARSui7hmCsODCtbWdZTnTXNHLKsX3j1UM",
  authDomain:        "farmconnectzw.firebaseapp.com",
  projectId:         "farmconnectzw",
  storageBucket:     "farmconnectzw.firebasestorage.app",
  messagingSenderId: "273410033306",
  appId:             "1:273410033306:web:97d124d2b709c7f8808123"
});

const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || 'FarmConnectZW', {
    body:  body || 'You have a new notification',
    icon:  '/images/icon-192.png',
    badge: '/images/icon-192.png',
    data:  payload.data || {}
  });
});

// Notification click — open app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  let url = '/';
  if (data.type === 'message') url = '/messages.html';
  if (data.type === 'alert')   url = '/notifications.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
