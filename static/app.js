/* ---------------------------------------------------------------------------
   blogson - index page scripts
   (feed filter, favicon color extraction, keyboard shortcuts)
   --------------------------------------------------------------------------- */

// -----------------------------------------------------------------------------
// Feed filter (invoked inline from the <select onchange>)
// -----------------------------------------------------------------------------

function filterFeed(feedName) {
  var params = new URLSearchParams(window.location.search);
  if (feedName) {
    params.set("range", "all");
    params.set("feed", feedName);
  } else {
    params.delete("feed");
    if (!params.get("range")) params.set("range", "month");
  }
  window.location.search = params.toString();
}

// -----------------------------------------------------------------------------
// Restore feed filter from URL on page load
// -----------------------------------------------------------------------------

(function () {
  var params = new URLSearchParams(window.location.search);
  var feed = params.get("feed");
  if (!feed) return;

  var select = document.querySelector(".feed-select");
  if (select) select.value = feed;
  document.querySelectorAll(".entry").forEach(function (entry) {
    entry.style.display = entry.dataset.feed === feed ? "" : "none";
  });
})();

// -----------------------------------------------------------------------------
// Extract dominant colors from favicons, apply as gradient left border
// -----------------------------------------------------------------------------

(function () {
  function getTopColors(img) {
    var canvas = document.createElement("canvas");
    var ctx = canvas.getContext("2d");
    canvas.width = img.naturalWidth || 16;
    canvas.height = img.naturalHeight || 16;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    var data;
    try {
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (e) {
      return null;
    }

    // Quantize pixels into buckets
    var buckets = {};
    for (var i = 0; i < data.length; i += 4) {
      var r = data[i],
        g = data[i + 1],
        b = data[i + 2],
        a = data[i + 3];
      if (a < 128) continue;
      var brightness = (r + g + b) / 3;
      if (brightness > 240 || brightness < 15) continue;

      var qr = (r >> 5) << 5;
      var qg = (g >> 5) << 5;
      var qb = (b >> 5) << 5;
      var key = qr + "," + qg + "," + qb;
      if (!buckets[key]) buckets[key] = { r: 0, g: 0, b: 0, count: 0 };
      buckets[key].r += r;
      buckets[key].g += g;
      buckets[key].b += b;
      buckets[key].count++;
    }

    var sorted = Object.values(buckets).sort(function (a, b) {
      return b.count - a.count;
    });
    if (sorted.length === 0) return null;

    var c1 = sorted[0];
    var color1 = {
      r: Math.round(c1.r / c1.count),
      g: Math.round(c1.g / c1.count),
      b: Math.round(c1.b / c1.count),
    };

    var color2;
    if (sorted.length > 1) {
      var c2 = sorted[1];
      color2 = {
        r: Math.round(c2.r / c2.count),
        g: Math.round(c2.g / c2.count),
        b: Math.round(c2.b / c2.count),
      };
    } else {
      color2 = {
        r: Math.min(255, color1.r + 40),
        g: Math.min(255, color1.g + 40),
        b: Math.min(255, color1.b + 40),
      };
    }

    return [ensureLightness(color1), ensureLightness(color2)];
  }

  // Convert RGB -> HSL, raise lightness to a minimum, convert back.
  // Keeps the hue so a dark red stays red, just brighter.
  function ensureLightness(c) {
    var r = c.r / 255,
      g = c.g / 255,
      b = c.b / 255;
    var max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    var h,
      s,
      l = (max + min) / 2;

    if (max === min) {
      h = s = 0;
    } else {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        case b:
          h = (r - g) / d + 4;
          break;
      }
      h /= 6;
    }

    // Floor lightness at 0.55 (on 0..1 scale)
    if (l < 0.55) l = 0.55;
    // Also clamp saturation for very washed-out colors to keep them visible
    if (s < 0.25) s = 0.25;

    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    return {
      r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      g: Math.round(hue2rgb(p, q, h) * 255),
      b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    };
  }

  function rgb(c) {
    return "rgb(" + c.r + "," + c.g + "," + c.b + ")";
  }

  function applyColors(domain, colors) {
    var c1 = rgb(colors[0]);
    var c2 = rgb(colors[1]);
    document
      .querySelectorAll('.entry[data-domain="' + domain + '"]')
      .forEach(function (entry) {
        entry.style.borderImage =
          "linear-gradient(to bottom, " + c1 + ", " + c2 + ") 1";
        var tag = entry.querySelector(".feed-tag");
        if (tag) tag.style.color = c1;
      });
  }

  var domains = new Set();
  document.querySelectorAll(".entry[data-domain]").forEach(function (el) {
    domains.add(el.dataset.domain);
  });

  domains.forEach(function (domain) {
    var img = new Image();
    img.onload = function () {
      var colors = getTopColors(img);
      if (colors) applyColors(domain, colors);
    };
    img.src = "/favicon/" + domain;
  });
})();

// -----------------------------------------------------------------------------
// Keyboard shortcuts: j/k to navigate, Enter to open, g to top
// -----------------------------------------------------------------------------

(function () {
  var focusedIdx = -1;

  function visibleEntries() {
    return Array.prototype.filter.call(
      document.querySelectorAll(".entry"),
      function (e) {
        return e.offsetParent !== null;
      },
    );
  }

  function setFocus(idx) {
    var entries = visibleEntries();
    if (entries.length === 0) return;

    document.querySelectorAll(".entry.focused").forEach(function (e) {
      e.classList.remove("focused");
    });

    idx = Math.max(0, Math.min(idx, entries.length - 1));
    focusedIdx = idx;
    var el = entries[idx];
    el.classList.add("focused");

    var rect = el.getBoundingClientRect();
    if (rect.top < 60 || rect.bottom > window.innerHeight - 40) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  document.addEventListener("keydown", function (e) {
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "j") {
      e.preventDefault();
      setFocus(focusedIdx < 0 ? 0 : focusedIdx + 1);
    } else if (e.key === "k") {
      e.preventDefault();
      setFocus(focusedIdx < 0 ? 0 : focusedIdx - 1);
    } else if (e.key === "Enter") {
      var entries = visibleEntries();
      if (focusedIdx >= 0 && entries[focusedIdx]) {
        var link = entries[focusedIdx].querySelector('a[href^="/go/"]');
        if (link) window.open(link.href, "_blank", "noopener");
      }
    } else if (e.key === "g") {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });
})();
