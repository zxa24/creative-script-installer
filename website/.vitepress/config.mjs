import { defineConfig } from "vitepress";
import { SITE_TITLE, SITE_DESCRIPTION, SITE_BASE, SECTIONS, absoluteUrl, REPO_URL } from "./site.mjs";

const sidebar = SECTIONS.map((section) => ({
  text: section.title,
  collapsed: false,
  items: section.items.map((i) => ({ text: i.text, link: i.link }))
}));

export default defineConfig({
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  base: SITE_BASE,
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: false,

  head: [
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        rel: "stylesheet",
        href:
          "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400" +
          "&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap"
      }
    ]
  ],

  // i18n scaffolding. English is the root locale and the only one with
  // content today; `zh` is wired up but intentionally left as a stub.
  locales: {
    root: {
      label: "English",
      lang: "en-US",
      title: SITE_TITLE,
      description: SITE_DESCRIPTION
    },
    zh: {
      label: "Chinese",
      lang: "zh-CN",
      link: "/zh/",
      themeConfig: {
        nav: [{ text: "Guide", link: "/guide/" }],
        sidebar: [{ text: "Overview", items: [{ text: "Status", link: "/zh/" }] }]
      }
    }
  },

  themeConfig: {
    outline: { level: [2, 3] },
    nav: [
      { text: "Guide", link: "/guide/", activeMatch: "/guide/" },
      { text: "Scripts", link: "/scripts/", activeMatch: "/scripts/" },
      { text: "Reference", link: "/reference/advanced", activeMatch: "/reference/" },
      { text: "For AI", link: "/llms.txt", target: "_blank" }
    ],
    sidebar: {
      "/guide/": sidebar,
      "/scripts/": sidebar,
      "/reference/": sidebar
    },
    // Three ways in to the repository, for three different readers: the nav
    // icon for someone looking for the source, the per-page edit link for
    // someone who found a wrong sentence, the footer for someone at the end of a
    // page. The public repository carries website/ as-is, so :path resolves.
    socialLinks: [{ icon: "github", link: REPO_URL }],
    editLink: { pattern: `${REPO_URL}/edit/main/website/:path`, text: "Edit this page on GitHub" },
    search: { provider: "local" },
    docFooter: { prev: "Previous", next: "Next" },
    darkModeSwitchLabel: "Appearance",
    returnToTopLabel: "Back to top",
    footer: {
      message:
        `<a href="${REPO_URL}">Source on GitHub</a> &middot; Machine-readable full text: <a href="${absoluteUrl("/llms.txt")}">llms.txt</a> &middot; <a href="${absoluteUrl("/llms-full.txt")}">llms-full.txt</a>`,
      copyright: "InDesign scripts for translation and localization work."
    }
  }
});
