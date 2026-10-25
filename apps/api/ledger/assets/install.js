/* Native links remain available without JavaScript. */
const androidGuide = document.getElementById("android-guide");
const androidBadge = document.getElementById("android-badge");
let guideReturnFocus;
function openAndroidSteps(event) {
  if (!androidGuide.showModal) return;
  if (event) event.preventDefault();
  if (androidGuide.open) return;
  guideReturnFocus = document.activeElement;
  androidGuide.showModal();
  document.documentElement.classList.add("guide-open");
}
androidBadge.addEventListener("click", openAndroidSteps);
androidGuide.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const controls = androidGuide.querySelectorAll("button, a[href]");
  const first = controls[0], last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
androidGuide.addEventListener("close", () => {
  document.documentElement.classList.remove("guide-open");
  (guideReturnFocus && guideReturnFocus !== document.body ? guideReturnFocus : androidBadge).focus({ preventScroll: true });
});
window.addEventListener("hashchange", () => {
  if (window.location.hash === "#android-install") openAndroidSteps();
});
window.addEventListener("pageshow", () => {
  if (window.location.hash === "#android-install") openAndroidSteps();
  if (new URLSearchParams(window.location.search).get("install") !== "1") return;
  const ua = navigator.userAgent;
  const ipad = /Macintosh|MacIntel/.test(ua + " " + navigator.platform) && navigator.maxTouchPoints > 1;
  const id = /Android/i.test(ua) ? "android-badge" : /iPhone|iPad|iPod/i.test(ua) || ipad ? "iphone-install" : "install";
  const target = document.getElementById(id);
  if (!target) return;
  if (id === "iphone-install") {
    const url = new URL(window.location.href);
    url.searchParams.delete("install");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    window.location.assign(target.href);
    return;
  }
  if (id === "android-badge") { openAndroidSteps(); return; }
  target.classList.add("install-selected");
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "center", behavior: "instant" });
});
