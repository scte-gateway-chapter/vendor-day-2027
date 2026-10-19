// Scaffolded by Task 2; views and router land in Task 6.
// For now this just registers the service worker so the production deploy
// demonstrates the PWA plumbing end-to-end.

async function main() {
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("/sw.js");
    } catch (err) {
      console.warn("Service worker registration failed:", err);
    }
  }
  console.log("App shell ready — views land in Task 6");
}

main();
