document.addEventListener("click", function (e) {
  let link = e.target.closest("a[data-go]");
  if (!link) return;
  fetch(link.dataset.go, { method: "GET", keepalive: true }).catch(
    function () {},
  );
});

let iframe = document.getElementById("site-preview");

document.addEventListener("mousemove", function (e) {
  let link = e.target.closest("a[data-go]");
  if (!link) return;
  if (iframe.src !== link.href) {
    iframe.src = link.href;
  }
});

function filterFeed(feedName) {
  let params = new URLSearchParams(window.location.search);
  if (feedName) {
    params.set("range", "all");
    params.set("feed", feedName);
  } else {
    params.delete("feed");
    if (!params.get("range")) params.set("range", "week");
  }
  window.location.search = params.toString();
}

function filterSites() {
  let params = new URLSearchParams(window.location.search);
  if (params.get("sites_only")) {
    params.delete("sites_only");
  } else {
    params.set("sites_only", "1");
  }
  window.location.search = params.toString();
}

function filterTime(time) {
  let params = new URLSearchParams(window.location.search);
  params.set("range", time);
  window.location.search = params.toString();
}

function parseURL() {
  let params = new URLSearchParams(window.location.search);
  let feed = params.get("feed");
  if (!feed) return;

  let select = document.querySelector(".feed-select");
  if (select) select.value = feed;
  document.querySelectorAll(".entry").forEach(function (entry) {
    entry.style.display = entry.dataset.feed === feed ? "" : "none";
  });
}

// https://stackoverflow.com/questions/17242144/how-to-convert-hsb-hsv-color-to-rgb-accurately
function HSVtoRGB(h, s, v) {
  var r, g, b, i, f, p, q, t;
  i = Math.floor(h * 6);
  f = h * 6 - i;
  p = v * (1 - s);
  q = v * (1 - f * s);
  t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      ((r = v), (g = t), (b = p));
      break;
    case 1:
      ((r = q), (g = v), (b = p));
      break;
    case 2:
      ((r = p), (g = v), (b = t));
      break;
    case 3:
      ((r = p), (g = q), (b = v));
      break;
    case 4:
      ((r = t), (g = p), (b = v));
      break;
    case 5:
      ((r = v), (g = p), (b = q));
      break;
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}

function RGBtoHSV(r, g, b) {
  var max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min,
    h,
    s = max === 0 ? 0 : d / max,
    v = max;

  switch (max) {
    case min:
      h = 0;
      break;
    case r:
      h = g - b + d * (g < b ? 6 : 0);
      h /= 6 * d;
      break;
    case g:
      h = b - r + d * 2;
      h /= 6 * d;
      break;
    case b:
      h = r - g + d * 4;
      h /= 6 * d;
      break;
  }

  return {
    h: h,
    s: s,
    v: v,
  };
}

function fixColor(rgb) {
  let hsv = RGBtoHSV(rgb.r, rgb.g, rgb.b);
  hsv.l = Math.max(hsv.l, 0.55);
  hsv.s = Math.max(hsv.s, 0.25);
  return HSVtoRGB(hsv.h, hsv.s, hsv.v);
}

function getTopColors(img) {
  let canvas = document.createElement("canvas");
  let ctx = canvas.getContext("2d");
  canvas.width = img.naturalWidth || 16;
  canvas.height = img.naturalHeight || 16;
  if (canvas.width === 0 || canvas.height === 0) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  let data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  let buckets = {};
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i + 0];
    let g = data[i + 1];
    let b = data[i + 2];
    let a = data[i + 3];
    if (a < 128) continue;

    let brightness = r * 0.2126 + g * 0.7152 + b * 0.0722;
    if (brightness > 240 || brightness < 15) continue;

    r = (r / 32) * 32;
    g = (g / 32) * 32;
    b = (b / 32) * 32;
    let key = r + "," + g + "," + b;
    if (!buckets[key]) buckets[key] = { r, g, b, count: 0 };
    buckets[key].count++;
  }

  let sorted = Object.values(buckets).sort((a, b) => {
    return b.count - a.count;
  });
  if (sorted.length === 0) return null;

  let c1 = sorted[0];
  let color1 = {
    r: c1.r / 255,
    g: c1.g / 255,
    b: c1.b / 255,
  };

  let color2 = {
    r: Math.min(color1.r + 0.3, 1.0),
    g: Math.min(color1.g + 0.3, 1.0),
    b: Math.min(color1.b + 0.3, 1.0),
  };

  if (sorted.length > 1) {
    let c2 = sorted[1];
    color2 = {
      r: c2.r / 255,
      g: c2.g / 255,
      b: c2.b / 255,
    };
  }

  return [fixColor(color1), fixColor(color2)];
}

function applyColors(domain, colors) {
  let rgb = (c) => {
    return "rgb(" + c.r + "," + c.g + "," + c.b + ")";
  };
  let c1 = rgb(colors[0]);
  let c2 = rgb(colors[1]);
  document
    .querySelectorAll(`article[data-domain="${domain}"].needs-favicon`)
    .forEach(function (entry) {
      entry.classList.remove("needs-favicon");
      entry.style.borderImage =
        "linear-gradient(to bottom, " + c1 + ", " + c2 + ") 1";
      let tag = entry.querySelector(".feed-tag");
      if (tag) tag.style.color = c1;
    });
}

function updateFavicons() {
  let domains = new Set();
  let onImgReady = (img, domain) => {
    let colors = getTopColors(img);
    if (colors) applyColors(domain, colors);
  };
  document.querySelectorAll("article").forEach((entry) => {
    let domain = entry.dataset.domain;
    if (domains.has(domain)) return;
    domains.add(domain);

    let img = entry.querySelector("img");
    if (img.complete) onImgReady(img, domain);
    else img.addEventListener("load", () => onImgReady(img, domain));
    img
      .decode()
      .then(() => {})
      .catch((err) => console.log("decode failed:", err.name, err.message));
  });
}

function init() {
  parseURL();
  updateFavicons();
}

init();
