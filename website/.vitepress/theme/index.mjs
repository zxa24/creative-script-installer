import DefaultTheme from "vitepress/theme";
import "./custom.css";

// Thin override of the stock VitePress theme: palette + typography, plus two
// behaviours for in-page jumps (IT TODO #145):
// 1. Optional and technical text lives in collapsed blocks. A link, an old
//    bookmark or a search hit that points INSIDE a collapsed block would land
//    on hidden text, so open the enclosing <details> first, then scroll to it.
// 2. Highlight what the link points at, then fade it out (owner 2026-10-12), so
//    the reader sees where they landed: a problem block, a heading's section,
//    or the paragraph that holds an inline anchor.
const HL = "jump-highlight";

function isHeading(el) { return /^H[1-6]$/.test(el.tagName); }

function highlightTargets(el) {
  if (isHeading(el)) {
    // The heading plus everything up to the next heading of the same or higher level.
    const level = Number(el.tagName[1]);
    const out = [el];
    for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
      if (isHeading(n) && Number(n.tagName[1]) <= level) break;
      out.push(n);
    }
    return out;
  }
  // An empty anchor (<a id>) marks the block it sits in. If that block has no
  // text of its own (an anchor on its own line), use the collapsed block it
  // opens, or else the next block.
  let block = el.closest("p, li, tr, details, .custom-block") || el;
  if (!block.textContent.trim()) {
    const d = el.closest("details");
    block = d || block.nextElementSibling || block;
  }
  return [block];
}

// One rectangle around everything that is highlighted (a heading's section is
// several blocks; the owner wants a single box, 2026-10-12). Drawn as an
// overlay in page coordinates so the page's own DOM is never rearranged.
function flash(el) {
  const targets = highlightTargets(el);
  let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity;
  for (const t of targets) {
    const r = t.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    top = Math.min(top, r.top); left = Math.min(left, r.left);
    right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
  }
  if (!isFinite(top)) return;
  document.querySelectorAll("." + HL).forEach((o) => o.remove());
  const pad = 6;
  const box = document.createElement("div");
  box.className = HL;
  box.setAttribute("aria-hidden", "true");
  box.style.top = (top + window.scrollY - pad) + "px";
  box.style.left = (left + window.scrollX - pad) + "px";
  box.style.width = (right - left + pad * 2) + "px";
  box.style.height = (bottom - top + pad * 2) + "px";
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3200);
}

// Set in enhanceApp; read by followAnchorMove.
let theRouter = null;
let theBase = "/";

// A page that still exists but whose sections moved elsewhere lists them in
// its frontmatter as `anchorMoves: { <id>: /new/page }` (list in site.mjs
// ANCHOR_MOVES). When the #id is not on this page and is listed there, go to
// that page with the same #id. A direct load, an in-site link and a hash change
// all end in openFragment, so all three are covered.
function followAnchorMove(id) {
  const fm = theRouter && theRouter.route && theRouter.route.data && theRouter.route.data.frontmatter;
  const moves = fm && fm.anchorMoves;
  if (!moves || typeof moves !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(moves, id)) return false;
  window.location.replace(theBase.replace(/\/$/, "") + moves[id] + window.location.hash);
  return true;
}

function openFragment() {
  if (typeof window === "undefined" || !window.location.hash) return;
  let id;
  try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (e) { return; }
  const el = document.getElementById(id);
  if (!el) { followAnchorMove(id); return; }
  let opened = false;
  for (let d = el.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) {
    if (!d.open) { d.open = true; opened = true; }
  }
  if (opened) el.scrollIntoView();
  flash(el);
}

// A page that moved keeps a stub at its old path whose frontmatter says
// `redirect: /new/path` (list in site.mjs REDIRECTS). Forward to it, keeping the
// #anchor, so old bookmarks and the link the installer prints keep working.
// When an old page was split across several new pages, its stub also carries
// `redirectAnchors: { <anchor>: /page }`: a hash listed there goes to that page
// (hash kept), any other hash or none goes to `redirect`.
function followRedirect(router, siteBase) {
  const fm = router.route && router.route.data && router.route.data.frontmatter;
  if (!fm || !fm.redirect) return false;
  const hash = window.location.hash;
  let dest = fm.redirect;
  if (hash && fm.redirectAnchors && typeof fm.redirectAnchors === "object") {
    let id = "";
    try { id = decodeURIComponent(hash.slice(1)); } catch (e) { id = ""; }
    if (id && Object.prototype.hasOwnProperty.call(fm.redirectAnchors, id)) dest = fm.redirectAnchors[id];
  }
  const target = siteBase.replace(/\/$/, "") + dest + hash;
  window.location.replace(target);
  return true;
}

export default {
  extends: DefaultTheme,
  enhanceApp({ router, siteData }) {
    if (typeof window === "undefined") return;
    const base = (siteData && siteData.value && siteData.value.base) || "/";
    theRouter = router;
    theBase = base;
    window.addEventListener("hashchange", openFragment);
    // Same-page anchor clicks are handled by the router without a hashchange
    // event, so also react to the click itself.
    document.addEventListener("click", (e) => {
      const a = e.target && e.target.closest && e.target.closest("a[href*='#']");
      if (!a || a.target === "_blank") return;
      setTimeout(openFragment, 60);
    });
    const prev = router.onAfterRouteChanged;
    router.onAfterRouteChanged = (to) => {
      if (prev) prev(to);
      if (followRedirect(router, base)) return;
      setTimeout(openFragment, 0);
    };
    window.addEventListener("load", () => {
      if (followRedirect(router, base)) return;
      setTimeout(openFragment, 0);
    });
  }
};
