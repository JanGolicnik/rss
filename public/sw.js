self.addEventListener("push", (e) => {
  const data = e.data?.json() ?? {};
  e.waitUntil(
    (async () => {
      try {
        await self.registration.showNotification(data.title, {
          body: data.body ?? "uhh",
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
  alert(event.nofitication.data.url);
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
