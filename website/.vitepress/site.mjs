// Single source of truth for site identity + page order.
//
// Both `.vitepress/config.mjs` (sidebar/nav) and `.vitepress/gen-llms.mjs`
// (llms.txt / llms-full.txt) import this file, so the machine-readable
// surface cannot drift away from the human-readable navigation.
//
// Override the published origin/base at build time, e.g.:
//   SITE_ORIGIN=https://example.github.io SITE_BASE=/creative-script-installer/ npm run build

// Display name only. 2026-09-08 the owner gave the site the repository's name
// (Creative Script Installer); 2026-10-11 the owner renamed the SITE, because it
// is a website and a toolbox hub, not an installer. The repository, the URL and
// the install command keep "creative-script-installer" on purpose (IT TODO #145).
export const SITE_TITLE = "Creative Script Kit";

export const SITE_DESCRIPTION =
  "Free scripts for Adobe InDesign and Illustrator, installed and updated with one line. " +
  "Folio takes a finished InDesign layout to a translator and brings the translation " +
  "back into the same layout; a set of InDesign tools fixes what a new language changes; " +
  "five Illustrator tools handle everyday chores.";

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
 *
 * SECTIONS stays flat on purpose (llms.txt lists every page once). An item
 * with `parent: <link>` is shown nested under that page in the sidebar; the
 * nesting is built in config.mjs, for both locales. The order here is the
 * reading order, and the prev/next footer follows it.
 */
export const SECTIONS = [
  {
    title: "Get started",
    items: [
      {
        text: "Creative Script Kit",
        link: "/",
        file: "index.md",
        // Not in the sidebar: the site title at the top left already links home.
        hideInSidebar: true,
        summary: "The toolbox: Folio, InDesign tools and Illustrator tools, and the one line that installs them."
      },
      {
        text: "Install and update",
        link: "/guide/install",
        file: "guide/install.md",
        summary: "Paste one line into a terminal on a Mac or Windows PC, restart InDesign and Illustrator, find the scripts. Common problems and the installer's technical behaviour are folded below the steps."
      }
    ]
  },
  {
    title: "Folio",
    items: [
      {
        text: "Folio: translate a layout",
        link: "/folio/",
        file: "folio/index.md",
        summary: "What Folio is: the designer exports a zip, a translator translates it in a web page, the designer imports it into a copy of the same layout. Pick your part: designer or translator."
      },
      {
        text: "For translators",
        link: "/folio/translator",
        file: "folio/translator.md",
        summary: "Open the zip in the Folio web app, translate and mark formatting, save the zip and send it back. Nothing to install."
      },
      {
        text: "For designers",
        link: "/folio/designer",
        file: "folio/designer.md",
        summary: "The designer's five stages in work order, one line each with a link to its page, and the warning not to import a later round into the original."
      },
      {
        text: "1 Before you export",
        link: "/folio/before-export",
        file: "folio/before-export.md",
        parent: "/folio/designer",
        summary: "Stage 1. Get a document ready before 1.1: 3.3 Relink Missing Links and 2.4 Reorganize Styles."
      },
      {
        text: "2 Export and import",
        link: "/folio/export-import",
        file: "folio/export-import.md",
        parent: "/folio/designer",
        summary: "Stage 2. Export the text as a zip with 1.1 Export Translation Package, send it to the translator, get it back, import it into a copy of the original with 1.2 Import Translation Package, and check the result. Common problems of export and import, and the technical details of 1.1 and 1.2."
      },
      {
        text: "3 Make the new language look right",
        link: "/folio/fonts",
        file: "folio/fonts.md",
        parent: "/folio/designer",
        summary: "Stage 3. Fix what the new language changed after 1.2: 2.1 Apply Font Pairing, 2.2 Apply CJK Styles, 2.3 Set Selection Weight, 2.5 Repair Cluster GREP, 2.6 Convert Underline to Rule, and 3.1 Snapshot Before Apply with 3.2 Repair After Apply to protect the layout during big changes."
      },
      {
        text: "4 Later rounds",
        link: "/folio/rounds",
        file: "folio/rounds.md",
        parent: "/folio/designer",
        summary: "Stage 4. When the translation changes after you adjusted the layout: update the .translated.indd you adjusted (never the original), and mark every changed character with 3.4 Highlight Translation Changes."
      },
      {
        text: "5 Sister documents",
        link: "/folio/sister-documents",
        file: "folio/sister-documents.md",
        parent: "/folio/designer",
        summary: "Stage 5. 4.1 Export Brand Preset and 4.2 Apply Brand Preset: copy tuned paragraph-style settings to a sister document. Fonts are never changed."
      }
    ]
  },
  {
    title: "More tools",
    items: [
      {
        text: "More tools",
        link: "/tools/",
        file: "tools/index.md",
        summary: "Tools that are not part of the translation workflow: InDesign 3.5 Save and Reveal, and the five Illustrator tools (Unembed All Images, Export Artboard PDFs, Export Small PDF, Replace Fonts, CJK Composer and Mojikumi)."
      }
    ]
  },
  {
    title: "All scripts",
    items: [
      {
        text: "All scripts",
        link: "/scripts/",
        file: "scripts/index.md",
        summary: "Every script of both apps: the numbered InDesign scripts (1.1 to 4.2) in Scripts panel order and the five Illustrator scripts, each with one line on what it is for and where it is explained."
      }
    ]
  },
  {
    title: "Reference",
    items: [
      {
        text: "Advanced install options",
        link: "/reference/advanced",
        file: "reference/advanced.md",
        summary: "Installer flags, the TOOLKIT_SOURCE / TOOLKIT_ZIP_URL / TOOLKIT_AUTH_TOKEN overrides, exit codes, and how the distribution bundle is produced."
      },
      {
        text: "Files and folders",
        link: "/guide/folders",
        file: "guide/folders.md",
        summary: "The working folder stays simple; everything the scripts produce goes into script_outputs/."
      },
      {
        text: "Changelog",
        link: "/reference/changelog",
        file: "reference/changelog.md",
        summary: "What each released version contains, newest first."
      }
    ]
  }
];

// Where each id of the old Folio designer page lives now (owner decision
// 2026-10-12: one place per thing, reading order follows the work). Shared by
// the stubs that used to forward to /folio/designer, so an old bookmark goes
// straight to the right page instead of hopping through /folio/designer.
// /folio/designer mirrors this as `anchorMoves:` in its frontmatter (see
// ANCHOR_MOVES below).
export const DESIGNER_MOVES = {
  "what-to-do": "/folio/export-import",
  "common-problems": "/folio/export-import",
  "import-stopped": "/folio/export-import",
  "missing-fonts": "/folio/export-import",
  "missing-links": "/folio/export-import",
  "font-has-no-pair": "/folio/export-import",
  "backup-failed": "/folio/export-import",
  "bold-italic-missing": "/folio/export-import",
  "text-too-long": "/folio/export-import",
  "report-and-log": "/folio/export-import",
  "export-translation-package": "/folio/export-import",
  "import-translation-package": "/folio/export-import",
  "next-round": "/folio/rounds"
};

/**
 * Pages that moved. Each old path keeps a stub page (its `file`) that forwards to
 * `to`, keeping any #anchor. Stubs are not in the sidebar, not in search and not
 * in llms-full.txt. ⚠ Never remove an entry: both installers print
 * /guide/workflow after an install (install-update.ps1 / .sh), and offline
 * copies keep printing it (IT TODO #145).
 *
 * `anchors` sends an old #anchor to the page that now holds it; any other hash
 * goes to `to`. The stub's frontmatter mirrors this as `redirectAnchors:` (that
 * is what the browser reads); the zh stub carries the same map with /zh in front.
 */
export const REDIRECTS = [
  { from: "/guide/", file: "guide/index.md", to: "/" },
  { from: "/guide/workflow", file: "guide/workflow.md", to: "/folio/designer", anchors: DESIGNER_MOVES },
  // The old 1.1 and 1.2 script reference. Its content is now the export and
  // import stage; its subsection headings (notes, guardrails) land there too.
  { from: "/scripts/workflow", file: "scripts/workflow.md", to: "/folio/export-import", anchors: DESIGNER_MOVES },
  // The numbered InDesign scripts moved into the Folio stage pages (owner
  // decision "A", 2026-10-11).
  {
    from: "/scripts/type-and-styles", file: "scripts/type-and-styles.md", to: "/folio/fonts",
    anchors: { "reorganize-styles": "/folio/before-export" }
  },
  {
    from: "/scripts/check-and-repair", file: "scripts/check-and-repair.md", to: "/scripts/",
    anchors: {
      "snapshot-before-apply": "/folio/fonts",
      "repair-after-apply": "/folio/fonts",
      "relink-missing-links": "/folio/before-export",
      "highlight-translation-changes": "/folio/rounds",
      "modes": "/folio/rounds",
      "options": "/folio/rounds",
      "surviving-structural-edits": "/folio/rounds",
      "save-and-reveal": "/tools/"
    }
  },
  { from: "/scripts/brand-presets", file: "scripts/brand-presets.md", to: "/folio/sister-documents" },
  // 2026-10-12: review rounds merged with "the next round of changes" into one
  // stage page; 3.5 and the Illustrator tools became "More tools". Every old id
  // keeps its name on the new page, so the hash is simply carried over.
  { from: "/folio/review-rounds", file: "folio/review-rounds.md", to: "/folio/rounds" },
  { from: "/scripts/illustrator", file: "scripts/illustrator.md", to: "/tools/" }
];

/**
 * Ids that left a page that still exists. Each page's frontmatter mirrors its
 * map as `anchorMoves:` (that is what the browser reads): a hash that is not on
 * the page and is listed there is forwarded to the page that now holds it. The
 * zh page carries the same map with /zh in front; an id that came from a
 * heading without an explicit {#id} is the zh heading's own slug there
 * (common-problems is 常见问题, tools-for-each-stage is 各阶段的工具).
 * Never list an id that points back to the same page: that would reload forever.
 * /folio/designer#next (the old "Next" heading) is left out on purpose: it
 * lands on the top of /folio/designer, which is now the stage list.
 */
export const ANCHOR_MOVES = [
  { page: "/folio/designer", file: "folio/designer.md", moves: DESIGNER_MOVES },
  { page: "/folio/", file: "folio/index.md", moves: { "tools-for-each-stage": "/folio/designer" } },
  {
    page: "/scripts/", file: "scripts/index.md",
    moves: { "save-and-reveal": "/tools/", "save-and-reveal-details": "/tools/" }
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
