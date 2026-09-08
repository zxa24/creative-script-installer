#!/usr/bin/env node
/**
 * gen-llms.mjs — regenerate public/llms.txt and public/llms-full.txt from the
 * Markdown that builds this site.
 *
 * Wired into `npm run build` and `npm run dev`, so the machine-readable surface
 * cannot drift away from the pages. Never hand-edit the two generated files.
 *
 * Devices, not discipline:
 *   - The page list comes from `.vitepress/site.mjs`, the SAME list that builds
 *     the sidebar. One source, so nav and llms.txt cannot disagree.
 *   - A Markdown file on disk that is NOT in that list is a hard failure
 *     (exit 1), so a new page cannot be silently omitted from llms-full.txt.
 *   - A listed page that does not exist on disk is a hard failure.
 *   - Output is a pure function of the inputs — no timestamps, no counters —
 *     so running it twice produces a byte-identical result.
 *
 * Usage:  node .vitepress/gen-llms.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SITE_TITLE,
  SITE_DESCRIPTION,
  REPO_URL,
  SECTIONS,
  ALL_PAGES,
  absoluteUrl
} from "./site.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PUBLIC_DIR = join(ROOT, "public");

/** Directories never scanned for content pages. */
const DIR_EXCLUDE = new Set([".vitepress", "node_modules", "public", "dist", "cache"]);

/**
 * Locales deliberately outside the llms surface. `zh` is an i18n stub with no
 * translated content; including it would put placeholder text in front of a
 * model as if it were documentation.
 */
const LOCALE_EXCLUDE = new Set(["zh"]);

// ───────────────────────────── discovery ─────────────────────────────

function walk(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (DIR_EXCLUDE.has(entry)) continue;
      if (dir === ROOT && LOCALE_EXCLUDE.has(entry)) continue;
      walk(abs, found);
    } else if (entry.endsWith(".md")) {
      found.push(relative(ROOT, abs).split(sep).join("/"));
    }
  }
  return found;
}

// ────────────────────────── frontmatter + body ────────────────────────

/**
 * Split a Markdown file into { frontmatter (raw string), body }.
 * Deliberately not a YAML parser — only the raw block and the body are needed.
 */
function splitFrontmatter(raw) {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { fm: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm: "", body: text };
  const fm = text.slice(4, end + 1);
  const body = text.slice(end + 4).replace(/^\n+/, "");
  return { fm, body };
}

/** Read one scalar key out of a raw frontmatter block (top level only). */
function fmValue(fm, key) {
  const m = fm.match(new RegExp("^" + key + ":\\s*(.+)$", "m"));
  if (!m) return "";
  return m[1].trim().replace(/^["']|["']$/g, "");
}

/**
 * VitePress `layout: home` pages carry their prose in frontmatter (hero,
 * features) plus whatever body follows. Flatten the hero/feature strings so
 * llms-full.txt still contains the words a reader sees on the page.
 */
function homeFrontmatterProse(fm) {
  const lines = [];
  const name = fmValue(fm, "  name");
  const text = fmValue(fm, "  text");
  const tagline = fmValue(fm, "  tagline");
  if (name) lines.push(name);
  if (text) lines.push(text);
  if (tagline) lines.push(tagline);

  // features: - title / details pairs, indented two spaces under `features:`
  const featBlock = fm.split(/^features:\s*$/m)[1];
  if (featBlock) {
    for (const m of featBlock.matchAll(/^\s*-?\s*(title|details):\s*(.+)$/gm)) {
      lines.push(m[2].trim().replace(/^["']|["']$/g, ""));
    }
  }
  return lines.length ? lines.join("\n\n") + "\n" : "";
}

/** Strip VitePress-only syntax that adds nothing for a text reader. */
function toPlainMarkdown(body) {
  return body
    .replace(/^:::\s*(tip|warning|danger|info|details)\s*(.*)$/gm, (_, kind, title) =>
      title ? `> **${title}**` : `> **${kind[0].toUpperCase()}${kind.slice(1)}**`
    )
    .replace(/^:::\s*$/gm, "")
    .replace(/\{#[a-z0-9-]+\}\s*$/gm, "") // explicit heading anchors
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageTitle(fm, body, fallback) {
  const t = fmValue(fm, "title");
  if (t) return t;
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return fallback;
}

// ───────────────────────────── generation ─────────────────────────────

function main() {
  const onDisk = walk(ROOT).sort();
  const listed = new Set(ALL_PAGES.map((p) => p.file));

  const unlisted = onDisk.filter((f) => !listed.has(f));
  if (unlisted.length) {
    console.error(
      "gen-llms: these Markdown pages exist on disk but are not in SECTIONS " +
        "in .vitepress/site.mjs, so they would be missing from llms-full.txt:\n  " +
        unlisted.join("\n  ") +
        "\nAdd them to SECTIONS (or to DIR_EXCLUDE / LOCALE_EXCLUDE in this file)."
    );
    process.exit(1);
  }

  const pages = [];
  for (const item of ALL_PAGES) {
    const abs = join(ROOT, item.file);
    let raw;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      console.error(`gen-llms: listed page does not exist on disk: ${item.file}`);
      process.exit(1);
    }
    const { fm, body } = splitFrontmatter(raw);
    const isHome = /^layout:\s*home\s*$/m.test(fm);
    const prose = (isHome ? homeFrontmatterProse(fm) + "\n" : "") + body;
    pages.push({
      ...item,
      title: pageTitle(fm, body, item.text),
      description: fmValue(fm, "description"),
      url: absoluteUrl(item.link),
      text: toPlainMarkdown(prose)
    });
  }

  if (pages.length !== onDisk.length) {
    console.error(
      `gen-llms: page-count mismatch — ${onDisk.length} Markdown files on disk, ` +
        `${pages.length} rendered. Refusing to write a partial surface.`
    );
    process.exit(1);
  }

  const byFile = new Map(pages.map((p) => [p.file, p]));

  // ── llms.txt : the index ──
  const index = [];
  index.push(`# ${SITE_TITLE}`);
  index.push("");
  index.push(`> ${SITE_DESCRIPTION}`);
  index.push("");
  index.push(`Source repository: ${REPO_URL}`);
  index.push("");
  index.push(
    "Adobe InDesign scripts installed into the InDesign Scripts panel. Group 1 " +
      "(1.1, 1.2) is the normal translation path a designer runs; groups 2, 3 and 4 " +
      "are tools reached for when a specific problem appears."
  );
  index.push("");
  index.push(
    `The complete text of every page below is available as a single file: ` +
      `[llms-full.txt](${absoluteUrl("/llms-full.txt")})`
  );
  index.push("");
  for (const section of SECTIONS) {
    index.push(`## ${section.title}`);
    index.push("");
    for (const item of section.items) {
      const p = byFile.get(item.file);
      index.push(`- [${p.title}](${p.url}): ${item.summary}`);
    }
    index.push("");
  }
  const llmsTxt = index.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  // ── llms-full.txt : every page, in full ──
  const full = [];
  full.push(`# ${SITE_TITLE} — full documentation`);
  full.push("");
  full.push(`> ${SITE_DESCRIPTION}`);
  full.push("");
  full.push(
    `This file is the concatenated full text of all ${pages.length} pages of ` +
      `${absoluteUrl("/")}. It is generated from the site's Markdown sources; ` +
      `do not edit it by hand.`
  );
  full.push("");
  full.push("Contents:");
  for (const p of pages) full.push(`- ${p.title} — ${p.url}`);
  full.push("");

  for (const p of pages) {
    full.push("");
    full.push("---");
    full.push("");
    full.push(`<!-- page: ${p.file} -->`);
    full.push(`# ${p.title}`);
    full.push("");
    full.push(`Source: ${p.url}`);
    if (p.description) {
      full.push("");
      full.push(`Summary: ${p.description}`);
    }
    full.push("");
    full.push(p.text);
    full.push("");
  }
  const llmsFull = full.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  mkdirSync(PUBLIC_DIR, { recursive: true });
  writeFileSync(join(PUBLIC_DIR, "llms.txt"), llmsTxt, "utf8");
  writeFileSync(join(PUBLIC_DIR, "llms-full.txt"), llmsFull, "utf8");

  console.log(
    `gen-llms: wrote public/llms.txt and public/llms-full.txt ` +
      `covering ${pages.length}/${onDisk.length} content pages ` +
      `(${LOCALE_EXCLUDE.size} locale(s) excluded: ${[...LOCALE_EXCLUDE].join(", ")}).`
  );
}

main();
