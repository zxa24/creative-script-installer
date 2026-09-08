import { defineConfig } from "vitepress";
import { SITE_TITLE, SITE_DESCRIPTION, SITE_BASE, SECTIONS, absoluteUrl, REPO_URL } from "./site.mjs";

// 中文侧栏文字, 按链接键入。SECTIONS 本身是英文站的单一来源; 这里只提供译文,
// 结构(分组、顺序、页面集合)永远跟着 SECTIONS 走。新增一页而忘了在这里加译文,
// 侧栏会显示英文标题 —— 可见, 而不是消失。
const ZH_SECTION = { "Start here": "从这里开始", "Scripts": "脚本", "Reference": "参考" };
const ZH_TEXT = {
  "/": "总览",
  "/guide/": "这套工具是什么",
  "/guide/install": "安装与更新",
  "/guide/workflow": "正常流程",
  "/guide/folders": "文件与目录",
  "/scripts/": "全部脚本",
  "/scripts/workflow": "1. 工作流",
  "/scripts/type-and-styles": "2. 字体与样式",
  "/scripts/check-and-repair": "3. 检查与修复",
  "/scripts/brand-presets": "4. 品牌预设",
  "/scripts/illustrator": "Illustrator",
  "/reference/advanced": "高级安装与分发",
  "/reference/changelog": "更新日志"
};

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
      label: "简体中文",
      lang: "zh-CN",
      link: "/zh/",
      title: "Creative Script Installer",
      description: "一条命令安装并更新 Adobe InDesign 与 Illustrator 的脚本。",
      themeConfig: {
        nav: [
          { text: "指南", link: "/zh/guide/", activeMatch: "/zh/guide/" },
          { text: "脚本", link: "/zh/scripts/", activeMatch: "/zh/scripts/" },
          { text: "参考", link: "/zh/reference/advanced", activeMatch: "/zh/reference/" },
          { text: "给 AI", link: "/llms.txt", target: "_blank" }
        ],
        // 与英文侧栏同一份 SECTIONS 派生, 只换文字和前缀 —— 两份手写的侧栏会各自漂。
        // 缺翻译的条目保留英文文字, 不会静默消失。
        sidebar: {
          "/zh/": SECTIONS.map((section) => ({
            text: ZH_SECTION[section.title] || section.title,
            collapsed: false,
            items: section.items.map((i) => ({ text: ZH_TEXT[i.link] || i.text, link: "/zh" + i.link }))
          }))
        },
        outline: { level: [2, 3], label: "本页" },
        docFooter: { prev: "上一页", next: "下一页" },
        darkModeSwitchLabel: "外观",
        returnToTopLabel: "回到顶部",
        editLink: { pattern: `${REPO_URL}/edit/main/website/:path`, text: "在 GitHub 上编辑本页" },
        footer: {
          message: `<a href="${REPO_URL}">GitHub 源码</a> &middot; 机器可读全文（仅英文）：<a href="${absoluteUrl("/llms.txt")}">llms.txt</a>`,
          copyright: "用于翻译与本地化工作的 InDesign 与 Illustrator 脚本。"
        }
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
