const btn_subscribe = document.getElementById("btn_subscribe");
let has_registration = false;
navigator.serviceWorker.getRegistrations().then((regs) => {
  has_registration = regs.length > 0;
  if (has_registration) btn_subscribe.innerText = "unsub";
});

btn_subscribe.addEventListener("click", async () => {
  try {
    await (has_registration ? unsubscribe() : try_subscribe());
    setTimeout(() => location.reload(), 500);
  } catch (e) {
    console.error(e);
  }
});

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

const PUBLIC_KEY = "BKOzW72dCYU8ORIfO9kc-oCg6ZxWo_jHYqSynkBMUX8gHx6f20IWI3NO_dzrKIQEMVb3Gb-btw6OghzN8ryVVMg";

async function try_subscribe() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;

  const reg = await navigator.serviceWorker.register("/public/sw.js");
  if (!reg.active) {
    await new Promise((resolve) => {
      const worker = reg.installing || reg.waiting;
      if (!worker) return resolve();
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
      });
    });
  }

  await fetch("/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(PUBLIC_KEY),
      }),
    ),
  });

  location.reload();
}

async function unsubscribe() {
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map((reg) => reg.unregister()));
  location.reload();
}
