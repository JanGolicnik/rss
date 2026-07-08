document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const iframe = document.getElementById("frame");
  // iframe.src = `http://127.0.0.1:5001/extension/?url=${encodeURIComponent(tab.url)}`;
  iframe.src = `https://blogsoni.duckdns.org/extension/?url=${encodeURIComponent(tab.url)}`;
});
