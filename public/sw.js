self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }

  var title = payload.title || "Desi P9X9";
  var options = {
    body: payload.body || "New videos and updates are ready.",
    icon: payload.icon || "/favicon.png",
    badge: payload.icon || "/favicon.png",
    ...(payload.image ? { image: payload.image } : {}),
    data: { url: payload.url || "/" }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var requested = event.notification.data && event.notification.data.url || "/";
  var target = "/";
  try {
    var parsed = new URL(requested, self.location.origin);
    if (parsed.origin === self.location.origin) target = parsed.href;
  } catch {
    target = "/";
  }
  event.waitUntil(self.clients.openWindow(target));
});
