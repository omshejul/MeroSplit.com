/* The links and manual steps work without JavaScript or dialog support. */
const androidGuide = document.getElementById("android-guide");
const androidBadge = document.getElementById("android-badge");
const guideSteps = Array.from(androidGuide.querySelectorAll("[data-guide-step]"));
const guideNext = document.getElementById("android-next");
const guideBack = document.getElementById("android-back");
let guideStep = 0, guideReturnFocus, guideOwnsHistory = false;

function showGuideStep(index, focus = true) {
  guideStep = Math.max(0, Math.min(index, guideSteps.length - 1));
  guideSteps.forEach((step, i) => { step.hidden = i !== guideStep; });
  const heading = guideSteps[guideStep].querySelector("h2");
  androidGuide.setAttribute("aria-labelledby", heading.id);
  document.getElementById("android-progress").textContent = `Step ${guideStep + 1} of ${guideSteps.length}`;
  document.getElementById("android-progress-bar").value = guideStep + 1;
  guideBack.disabled = guideStep === 0;
  guideNext.hidden = guideStep === guideSteps.length - 1;
  guideNext.textContent = guideSteps[guideStep].dataset.next || "";
  if (focus) heading.focus({ preventScroll: true });
}
function openAndroidSteps(event) {
  if (!androidGuide.showModal) return;
  if (event) event.preventDefault();
  if (androidGuide.open) return;
  guideReturnFocus = document.activeElement;
  if (window.location.hash !== "#android-install") {
    history.pushState(null, "", "#android-install");
    guideOwnsHistory = true;
  }
  showGuideStep(0, false);
  androidGuide.showModal();
  document.documentElement.classList.add("guide-open");
  guideSteps[0].querySelector("h2").focus({ preventScroll: true });
}
androidBadge.addEventListener("click", openAndroidSteps);
guideNext.addEventListener("click", () => showGuideStep(guideStep + 1));
guideBack.addEventListener("click", () => showGuideStep(guideStep - 1));
androidGuide.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const controls = Array.from(androidGuide.querySelectorAll("button, a[href]")).filter(control => !control.disabled && !control.closest("[hidden]"));
  const first = controls[0], last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
androidGuide.addEventListener("close", () => {
  document.documentElement.classList.remove("guide-open");
  if (window.location.hash === "#android-install") {
    if (guideOwnsHistory) history.back();
    else history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  guideOwnsHistory = false;
  (guideReturnFocus && guideReturnFocus !== document.body ? guideReturnFocus : androidBadge).focus({ preventScroll: true });
});
window.addEventListener("hashchange", () => {
  if (window.location.hash === "#android-install") openAndroidSteps();
  else if (androidGuide.open) { guideOwnsHistory = false; androidGuide.close(); }
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
  if (id === "android-badge" && androidGuide.showModal) { openAndroidSteps(); return; }
  target.classList.add("install-selected");
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "center", behavior: "instant" });
});
if (androidGuide.showModal) document.documentElement.classList.add("guide-supported");
