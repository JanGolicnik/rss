document.addEventListener("click", function (e) {
  const link = e.target.closest("a[data-go]");
  if (link) {
    fetch(link.dataset.go, { method: "GET", keepalive: true }).catch(
      function () {},
    );
    return;
  }

  const filter_btn = e.target.closest("a[data-time]");
  if (filter_btn) filterTime(filter_btn.dataset.time);

  const sites_btn = e.target.closest("a[data-sites]");
  if (sites_btn) filterSites();
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
  document.querySelectorAll(".entry").forEach((entry) => {
    entry.style.display = entry.dataset.feed === feed ? "" : "none";
  });
}

parseURL();
