// Háttérszolgáltatás: telepíthető webalkalmazás + értesítések megjelenítése / megnyitása.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

// Mindig a hálózatról töltünk (így mindig a legfrissebb változat fut)
self.addEventListener("fetch", () => {});

// Szerverről érkező push (későbbi bővítéshez): { title, body, url }
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  const n = d.notification || d.data || d;
  e.waitUntil(self.registration.showNotification(n.title || "Embercsere", {
    body: n.body || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: n.tag, data: { url: n.url || (d.data && d.data.url) || "./" }
  }));
});

// Értesítésre kattintva megnyitja (vagy előre hozza) a megfelelő oldalt
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) if (c.url.split("?")[0] === url.split("?")[0] && "focus" in c) return c.focus();
    if (all[0] && "navigate" in all[0]) { await all[0].navigate(url); return all[0].focus(); }
    return self.clients.openWindow(url);
  })());
});
