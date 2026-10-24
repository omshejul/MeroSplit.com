/* Only an explicit QR/install intent selects a platform. All links remain SSR. */
window.addEventListener("pageshow", () => {
  if (new URLSearchParams(window.location.search).get("install") !== "1") return;
  const ua = navigator.userAgent;
  const ipad = /Macintosh|MacIntel/.test(ua + " " + navigator.platform) && navigator.maxTouchPoints > 1;
  const id = /Android/i.test(ua) ? "android-install" : /iPhone|iPad|iPod/i.test(ua) || ipad ? "iphone-install" : "install";
  const target = document.getElementById(id);
  if (!target) return;
  if (id === "iphone-install") {
    const url = new URL(window.location.href);
    url.searchParams.delete("install");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    window.location.assign(target.href);
    return;
  }
  target.classList.add("install-selected");
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "center", behavior: "instant" });
});
