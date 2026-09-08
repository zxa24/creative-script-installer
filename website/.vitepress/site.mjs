// Single source of truth for site identity + page order.
//
// Both `.vitepress/config.mjs` (sidebar/nav) and `.vitepress/gen-llms.mjs`
// (llms.txt / llms-full.txt) import this file, so the machine-readable
// surface cannot drift away from the human-readable navigation.
//
// Override the published origin/base at build time, e.g.:
//   SITE_ORIGIN=https://example.github.io SITE_BASE=/creative-script-installer/ npm run build

export const SITE_TITLE = "indesign-toolkit";

export const SITE_DESCRIPTION =
  "Adobe InDesign scripts for a translation and localization workflow: " +
  "export a translation package, import the translated text back into the " +
  "layout, and repair typography afterwards.";

export const SITE_ORIGIN = (process.env.SITE_ORIGIN || "https://zxa24.github.io").replace(/\/+$/, "");

export const SITE_BASE = (() => {
  // The distribution repo is creative-script-installer (owner, 2026-09-06), so
  // that is the GitHub Pages path. This was a guess until then, inferred from a
  // sibling project's Pages URL — and every absolute link in llms.txt and
  // llms-full.txt is built from it, so a wrong value is wrong everywhere at
  // once rather than in one visible place.
  let b = process.env.SITE_BASE || "/creative-script-installer/";
  if (!b.startsWith("/")) b = "/" + b;
  if (!b.endsWith("/")) b = b + "/";
  return b;
})();

/**
 * Every English content page, in reading order, grouped into the sections
 * that llms.txt exposes. `file` is relative to the website root and is the
 * authority for what gets concatenated into llms-full.txt.
 */
export const SECTIONS = [
  {
    title: "Start here",
    items: [
      {
        text: "Overview",
        link: "/",
        file: "index.md",
        summary: "What the toolkit is, who runs which script, and how the pieces fit together."
      },
      {
        text: "What this toolkit is",
        link: "/guide/",
        file: "guide/index.md",
        summary: "The two tracks: the normal translation path (1.x) versus the tools you reach for when needed (2.x/3.x/4.x)."
      },
      {
        text: "Install and update",
        link: "/guide/install",
        file: "guide/install.md",
        summary: "One-click install on Windows and macOS, the SmartScreen/Gatekeeper prompts, install paths, and the atomic-replace update behaviour."
      },
      {
        text: "The normal path",
        link: "/guide/workflow",
        file: "guide/workflow.md",
        summary: "Export a translation package, translate it, import it back — step by step."
      },
      {
        text: "Files and folders",
        link: "/guide/folders",
        file: "guide/folders.md",
        summary: "The directory convention: a simple working folder plus a script_outputs/ folder that scripts own."
      }
    ]
  },
  {
    title: "Scripts",
    items: [
      {
        text: "All scripts",
        link: "/scripts/",
        file: "scripts/index.md",
        summary: "The complete numbered index of every script the installer distributes."
      },
      {
        text: "1. Workflow",
        link: "/scripts/workflow",
        file: "scripts/workflow.md",
        summary: "1.1 Export Translation Package and 1.2 Import Translation Package — the normal path."
      },
      {
        text: "2. Type and Styles",
        link: "/scripts/type-and-styles",
        file: "scripts/type-and-styles.md",
        summary: "2.1 Apply Font Pairing, 2.2 Apply CJK Styles, 2.3 Set Selection Weight, 2.4 Reorganize Styles, 2.5 Repair Cluster GREP, 2.6 Convert Underline to Rule."
      },
      {
        text: "3. Check and Repair",
        link: "/scripts/check-and-repair",
        file: "scripts/check-and-repair.md",
        summary: "3.1 Snapshot Before Apply, 3.2 Repair After Apply, 3.3 Relink Missing Links, 3.4 Highlight Translation Changes, 3.5 Save and Reveal."
      },
      {
        text: "4. Brand Presets",
        link: "/scripts/brand-presets",
        file: "scripts/brand-presets.md",
        summary: "4.1 Export Brand Preset and 4.2 Apply Brand Preset — move tuned paragraph-style geometry between sibling documents."
      }
    ]
  },
  {
    title: "Reference",
    items: [
      {
        text: "Advanced install and distribution",
        link: "/reference/advanced",
        file: "reference/advanced.md",
        summary: "Installer flags, the TOOLKIT_SOURCE / TOOLKIT_ZIP_URL / TOOLKIT_AUTH_TOKEN overrides, and how the distribution bundle is produced."
      }
    ]
  }
];

/** Flat list of every content file, in order. */
export const ALL_PAGES = SECTIONS.flatMap((s) => s.items);

/** Turn a VitePress route into an absolute, publishable URL. */
// The source repository. Derived from the Pages origin and base rather than
// written out, so it cannot drift from them: <owner>.github.io/<repo>/ is what
// github.com/<owner>/<repo> publishes. That derivation assumes the github.io
// pattern; a custom domain needs REPO_URL set explicitly at build time.
export const REPO_URL = (() => {
  if (process.env.REPO_URL) return process.env.REPO_URL.replace(/\/+$/, "");
  const owner = new URL(SITE_ORIGIN).hostname.split(".")[0];
  const repo = SITE_BASE.replace(/^\/+|\/+$/g, "");
  return `https://github.com/${owner}/${repo}`;
})();

export function absoluteUrl(link) {
  const path = link === "/" ? "" : link.replace(/^\//, "");
  return SITE_ORIGIN + SITE_BASE + path;
}
