self.addEventListener("push", (e) => {
  const data = e.data?.json() ?? {};
  e.waitUntil(
    (async () => {
      try {
        await self.registration.showNotification(data.notification_title, {
          body: data.title ?? "uhh",
          icon: data.icon ?? "",
          data: {
            url: data.url ?? "/",
          },
        });
      } catch (e) {
        console.error(e);
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
