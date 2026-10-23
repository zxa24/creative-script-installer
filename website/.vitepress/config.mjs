import { defineConfig } from "vitepress";
import { SITE_TITLE, SITE_DESCRIPTION, SITE_BASE, SECTIONS, absoluteUrl, REPO_URL } from "./site.mjs";

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 中文侧栏文字, 按链接键入。SECTIONS 本身是英文站的单一来源; 这里只提供译文,
// 结构(分组、顺序、页面集合)永远跟着 SECTIONS 走。新增一页而忘了在这里加译文,
// 侧栏会显示英文标题 —— 可见, 而不是消失。
const ZH_SECTION = {
  "Get started": "开始",
  "Folio": "Folio",
  "More tools": "更多工具",
  "All scripts": "全部脚本",
  "Reference": "参考"
};
const ZH_TEXT = {
  "/": "Creative Script Kit",
  "/guide/install": "安装与更新",
  "/folio/": "Folio：翻译一份版面",
  "/folio/translator": "给译者",
  "/folio/designer": "给设计师",
  "/folio/before-export": "1 导出之前",
  "/folio/export-import": "2 导出与导入",
  "/folio/fonts": "3 让新语言看起来对",
  "/folio/rounds": "4 后续轮次",
  "/folio/sister-documents": "5 姊妹文档",
  "/tools/": "更多工具",
  "/scripts/": "全部脚本",
  "/guide/folders": "文件与目录",
  "/reference/advanced": "高级安装选项",
  "/reference/changelog": "更新日志"
};

// A zh page that is not translated yet links to the English page instead of a
// 404 (the English site is primary; zh follows, IT TODO #145).
function zhLink(link) {
  const file = link.endsWith("/") ? link + "index.md" : link + ".md";
  return existsSync(join(WEB_ROOT, "zh", file.replace(/^\//, ""))) ? "/zh" + link : link;
}

// One sidebar group per SECTIONS entry. A section whose only visible page has
// the section's own name ("More tools" > "More tools") renders as a single link
// instead of a heading that repeats itself. An item with `parent` is nested
// under that page (the five designer stages under "For designers"), so the
// prev/next footer walks parent, then its children, in SECTIONS order.
// SECTIONS is untouched, so llms.txt keeps its flat sections. `textOf` /
// `linkOf` give the zh variant.
function sidebarFrom(sectionText, textOf, linkOf) {
  return SECTIONS.map((section) => {
    const items = section.items.filter((i) => !i.hideInSidebar);
    if (items.length === 1 && items[0].text === section.title) {
      return { text: sectionText(section.title), link: linkOf(items[0].link) };
    }
    const byLink = new Map();
    const top = [];
    for (const i of items) {
      const entry = { text: textOf(i), link: linkOf(i.link) };
      byLink.set(i.link, entry);
      const parent = i.parent && byLink.get(i.parent);
      if (i.parent && !parent) throw new Error(`sidebar: ${i.link} names parent ${i.parent}, which is not listed before it in the same section`);
      if (parent) (parent.items = parent.items || []).push(entry);
      else top.push(entry);
    }
    return { text: sectionText(section.title), collapsed: false, items: top };
  });
}

const sidebar = sidebarFrom((t) => t, (i) => i.text, (l) => l);

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

  // English is the root locale and the primary text; `zh` follows it page for
  // page (technical details stay English only and are linked from each zh page).
  locales: {
    root: {
      label: "English",
      lang: "en-US",
      title: SITE_TITLE,
      description: SITE_DESCRIPTION
    },
    zh: {
      label: "简体中文",
      lang: "zh-CN",
      link: "/zh/",
      title: "Creative Script Kit",
      description: "一条命令安装并更新 Adobe InDesign 与 Illustrator 的脚本。",
      themeConfig: {
        nav: [
          { text: "安装", link: "/zh/guide/install" },
          { text: "Folio", link: zhLink("/folio/"), activeMatch: "/zh/folio/" },
          { text: "更多工具", link: zhLink("/tools/"), activeMatch: "/zh/tools/" },
          { text: "全部脚本", link: zhLink("/scripts/"), activeMatch: "/zh/scripts/" }
        ],
        // 与英文侧栏同一份 SECTIONS 派生, 只换文字和前缀 —— 两份手写的侧栏会各自漂。
        // 缺翻译的条目保留英文文字, 不会静默消失。
        sidebar: {
          "/zh/": sidebarFrom((t) => ZH_SECTION[t] || t, (i) => ZH_TEXT[i.link] || i.text, zhLink)
        },
        outline: { level: [2, 3], label: "本页" },
        docFooter: { prev: "上一页", next: "下一页" },
        darkModeSwitchLabel: "外观",
        returnToTopLabel: "回到顶部",
        editLink: { pattern: `${REPO_URL}/edit/main/website/:path`, text: "在 GitHub 上编辑本页" },
        footer: {
          message: `<a href="${REPO_URL}">GitHub 源码</a> &middot; 机器可读全文（仅英文）：<a href="${absoluteUrl("/llms.txt")}">llms.txt</a> &middot; <a href="${absoluteUrl("/llms-full.txt")}">llms-full.txt</a>`,
          copyright: "免费的 InDesign 与 Illustrator 脚本。"
        }
      }
    }
  },

  themeConfig: {
    outline: { level: [2, 3] },
    nav: [
      { text: "Install", link: "/guide/install" },
      { text: "Folio", link: "/folio/", activeMatch: "/folio/" },
      { text: "More tools", link: "/tools/", activeMatch: "/tools/" },
      { text: "All scripts", link: "/scripts/", activeMatch: "/scripts/" }
    ],
    sidebar: {
      "/guide/": sidebar,
      "/folio/": sidebar,
      "/tools/": sidebar,
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
      copyright: "Free scripts for InDesign and Illustrator."
    }
  }
});
