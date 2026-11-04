// The launch splash: a short Soundstage title card that fades into the project screen (web/project/home.mjs).
// It shows once per page load, only in the real App (never in the try-it demo). Click or any key skips it.
//
//   import { showSplash, splashMs } from "./project/splash.mjs";
//   await showSplash();           // resolves when it has faded out

const CSS = `
.ss-splash{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:#0e0d10;color:#f0efed;font-family:"Space Grotesk",system-ui,-apple-system,sans-serif;
  opacity:1;transition:opacity .45s ease}
.ss-splash.out{opacity:0;pointer-events:none}
.ss-splash .in{display:grid;gap:14px;justify-items:center;text-align:center;animation:ss-splash-rise .9s ease both}
.ss-splash .mark{font-weight:700;font-size:clamp(34px,7vw,72px);letter-spacing:.14em;text-transform:uppercase;color:#f2ff59}
.ss-splash .tag{font-size:clamp(13px,1.8vw,18px);color:#b9b3bf;letter-spacing:.04em}
.ss-splash .bar{width:min(220px,40vw);height:3px;border-radius:3px;background:#2a2330;overflow:hidden}
.ss-splash .bar i{display:block;height:100%;width:0;background:#f2ff59;animation:ss-splash-fill var(--ss-splash-ms,1600ms) linear forwards}
.ss-splash .hint{font-size:12px;color:#6f6978}
@keyframes ss-splash-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes ss-splash-fill{to{width:100%}}
@media (prefers-reduced-motion: reduce){.ss-splash .in{animation:none}.ss-splash .bar i{animation:none;width:100%}}
`;

/** How long the splash stays up: a beat, shorter with reduced motion. Pure. */
export function splashMs({ reduced = false } = {}) { return reduced ? 600 : 1600; }

/** Show the splash; resolves once it is gone (after the time, a click or a key). Never throws, never blocks forever. */
export function showSplash({ ms = null, parent = document.body } = {}) {
  return new Promise((resolve) => {
    try {
      const reduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      const total = ms ?? splashMs({ reduced });
      if (!document.getElementById("ss-splash-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ss-splash-css", textContent: CSS }));
      document.querySelector(".ss-splash")?.remove();
      const el = document.createElement("div");
      el.className = "ss-splash"; el.setAttribute("role", "presentation"); el.style.setProperty("--ss-splash-ms", `${total}ms`);
      el.innerHTML = '<div class="in"><div class="mark">Soundstage</div><div class="tag">A film set inside ComfyUI</div><div class="bar"><i></i></div><div class="hint">Click to skip</div></div>';
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        window.removeEventListener("keydown", finish, true); el.removeEventListener("pointerdown", finish);
        el.classList.add("out");
        setTimeout(() => { el.remove(); resolve(); }, 460);
      };
      window.addEventListener("keydown", finish, true); el.addEventListener("pointerdown", finish);
      parent.append(el);
      setTimeout(finish, total);
    } catch { resolve(); }
  });
}
