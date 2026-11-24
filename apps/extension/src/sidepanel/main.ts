const dot = document.getElementById("dot")!;
const statusText = document.getElementById("status")!;

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "getStatus" }).catch(() => undefined);
  const connected = Boolean(res?.connected);
  dot.classList.toggle("on", connected);
  statusText.textContent = `Server: ${connected ? "connected" : "disconnected"}`;
}

refresh();
setInterval(refresh, 2000);
export {};
