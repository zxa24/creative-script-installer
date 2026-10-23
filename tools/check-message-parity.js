#!/usr/bin/env node
'use strict';
/*
 * tools/check-message-parity.js
 *
 * install-update.ps1 与 install-update.sh 是【同一个界面的两份实现】。
 * 这条检查从两边各自抽出「消息文本 → severity」的映射并断言两边一致。
 *
 * ── 它为什么存在 ───────────────────────────────────────────────────
 * 两份实现的消息文本是逐字相同的（只差插值语法：`{0}` ↔ `${VAR}`），
 * 而 severity 是**分别写的** —— 也就是说它有两个真相来源。
 * 一旦漂开，表现是【颜色在说谎】：一行绿色的 "成功" 其实是警告。
 * 🔴 说谎的颜色比没有颜色更糟 —— 没有颜色时人还会去读那行字。
 *
 * ── 它答什么 ───────────────────────────────────────────────────────
 * ✅ 答：**两边对同一句话给的 severity 是否相同**，不一致时**点名是哪一条**
 *    （行号 + 两边各自的档 + 原文）。
 *
 * ── ⛔ 它答不了 ────────────────────────────────────────────────────
 * · **那个 severity 本身对不对** —— 它只保证两边一致，⛔ 不保证一致地对。
 * · 运行时真的上了色没有（那要真渲染一次；见 README 的验收步骤）。
 * · 只在一边出现的消息（见下方豁免清单）—— 它**按定义**覆盖不到。
 *
 * ── 🔴 豁免清单是这条闸的必要部分，也是它的盲区 ──────────────────────
 * sh 有 22 条 ps1 没有的消息（mac 独有的路径 / 权限 / 隔离属性等）。
 * 它们没有参照系，所以不参与比对。**每一条都要写理由。**
 * ⚠ 豁免越长，这条闸能看见的就越少 —— **这份清单需要人定期看**，
 *   ⛔ 它不会自己提醒你它变长了。
 *
 * ── 用法 ───────────────────────────────────────────────────────────
 *   node tools/check-message-parity.js            # 断言模式（不一致 ⇒ exit 1）
 *   node tools/check-message-parity.js --report   # 报告模式：打印全表，不判定
 *   MSG_PARITY_SELFTEST='<归一化文本>' node tools/check-message-parity.js
 *                                                 # 反向控制：篡改该条的 sh 档
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PS1 = path.join(ROOT, 'install-update.ps1');
const SH = path.join(ROOT, 'install-update.sh');

/* ps1 的档 → 两边共用的规范名。SayUpdate 走自己的通道（只有"有更新"一种状态用它），
   与 Ok 同色但语义不同 —— 见两个脚本里那段注释。 */
const PS1_SEV = { Say: 'say', Ok: 'ok', Warn: 'warn', Err: 'err', SayUpdate: 'update' };
const SH_SEV = { say: 'say', ok: 'ok', warn: 'warn', fail: 'err', say_update: 'update' };

/* ── 归一化 ────────────────────────────────────────────────────────
   目标：把两边的同一句话变成同一个字符串。
   插值一律塌成 `{}` —— ⛔ 不保留变量名：两边的变量名本来就不同
   （`$removed` ↔ `${REMOVED}`），保留它等于制造假的不一致。 */
function normalize(s) {
  return String(s)
    .replace(/\{\d+\}/g, '{}')        // ps1 的 -f 占位符
    .replace(/\s+/g, ' ')
    .trim();
}

/* ps1 的一次调用：`Ok 'literal'` / `Ok ("fmt {0}" -f $a, $b)` / `Warn ("lit " + $expr)` */
function ps1Arg(raw) {
  let s = raw.trim();
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1).trim();

  /* 有 ` -f ` ⇒ 格式调用：占位符已在字面量里，⛔ 别把 -f 的实参也当表达式塞成 {} */
  const fIdx = findTopLevel(s, ' -f ');
  if (fIdx >= 0) s = s.slice(0, fIdx).trim();

  return joinQuoted(s);
}

/* 找一个在引号之外的子串位置 */
function findTopLevel(s, needle) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (s.startsWith(needle, i)) return i;
  }
  return -1;
}

/* 把一段 ps1 表达式里的引号内容拼起来，引号外的表达式塌成 {} */
function joinQuoted(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c; i++;
      let buf = '';
      while (i < s.length && s[i] !== q) { buf += s[i]; i++; }
      i++;
      /* 双引号里 ps1 会插值：$var / $($expr) */
      if (q === '"') buf = buf.replace(/\$\([^)]*\)/g, '{}').replace(/\$[A-Za-z_][\w.:]*/g, '{}');
      out += buf;
      continue;
    }
    /* 引号外：跳过连接符与空白，其余算一个表达式 */
    if (/[\s+,]/.test(c)) { i++; continue; }
    let j = i;
    while (j < s.length && s[j] !== '"' && s[j] !== "'") j++;
    const expr = s.slice(i, j).trim();
    if (expr && expr !== '+') out += '{}';
    i = j;
  }
  return out;
}

/* sh 的一次调用：`say "literal ${VAR} $(cmd)"` */
function shArg(raw) {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s
    .replace(/\$\([^)]*\)/g, '{}')
    .replace(/\$\{[^}]*\}/g, '{}')
    .replace(/\$[A-Za-z_]\w*/g, '{}');
}

function extract(file, fnNames, argFn, sevMap) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const alt = fnNames.join('|');
  const re = new RegExp('^\\s*(' + alt + ')\\s+([\'"(].*)$');
  const out = [];
  lines.forEach((ln, idx) => {
    const m = ln.match(re);
    if (!m) return;
    const text = normalize(argFn(m[2]));
    if (!text) return;
    out.push({ line: idx + 1, sev: sevMap[m[1]], text: text, raw: ln.trim() });
  });
  return out;
}

function load() {
  return {
    ps1: extract(PS1, ['Say', 'Ok', 'Warn', 'Err', 'SayUpdate'], ps1Arg, PS1_SEV),
    sh: extract(SH, ['say', 'ok', 'warn', 'fail', 'say_update'], shArg, SH_SEV),
  };
}

/* ── 🔴 清单（三节：manualPairs / severityOverride / shOnly）─────────
   详见 message-parity-exemptions.json 的 _README。
   ⚠ 三节合起来 = 这条闸的盲区，需要人定期看；⛔ 没有任何东西会在它变长时报警。 */
const EX = require('./message-parity-exemptions.json');
const MANUAL_PAIRS = (EX.manualPairs || []).map(p => ({
  sh: normalize(p.sh), ps1: normalize(p.ps1), why: p.why }));
const OVERRIDES = (EX.severityOverride || []).map(o => ({
  sh: normalize(o.sh), shSev: o.shSev, ps1Sev: o.ps1Sev, why: o.why }));
const EXEMPT_SH = EX.shOnly || {};

function main() {
  const argv = process.argv.slice(2);
  const report = argv.includes('--report');
  const { ps1, sh } = load();

  const ps1By = new Map();
  ps1.forEach(e => { if (!ps1By.has(e.text)) ps1By.set(e.text, e); });
  /* manualPairs：措辞按平台不同、但是同一句。声明成对之后 severity 【照常比对】——
     ⇒ 比豁免强：闸仍然钉得住它们。锚点两侧都必须存在，⛔ 找不到算失败不算跳过。 */
  const pairAlias = new Map();
  MANUAL_PAIRS.forEach(p => {
    if (!ps1By.has(p.ps1)) {
      console.error('🔴 manualPairs 的 ps1 侧锚点找不到: "' + p.ps1 + '"');
      console.error('   ⇒ 那一句在 ps1 里已被改写或删掉 ⇒ 这条配对声明已过期，必须人工更新。');
      process.exit(4);
    }
    pairAlias.set(p.sh, ps1By.get(p.ps1));
  });

  /* 反向控制：把指定那条的 sh 档改掉，检查必须红【且点名它】 */
  const mutate = process.env.MSG_PARITY_SELFTEST || '';
  if (mutate) {
    const victim = sh.find(e => e.text === normalize(mutate));
    if (!victim) {
      console.error('SELFTEST 锚点找不到: ' + mutate);
      console.error('🔴 锚点丢失算【失败】，⛔ 不算跳过 —— 否则这条反向控制会安静地什么都没测。');
      process.exit(4);
    }
    victim.sev = victim.sev === 'say' ? 'warn' : 'say';
  }

  const exemptSet = new Set(Object.keys(EXEMPT_SH).map(normalize));
  const mismatches = [];
  const shOnly = [];
  const matched = [];
  const pinned = [];

  sh.forEach(e => {
    const p = ps1By.get(e.text) || pairAlias.get(e.text);
    if (!p) { if (!exemptSet.has(e.text)) shOnly.push(e); return; }

    /* 🔴 severityOverride 不是"把这条从闸里拿掉"，是"把两边的档都钉住"：
       任一边将来变了都会红。豁免不该等于失明。 */
    const ov = OVERRIDES.find(o => o.sh === e.text);
    if (ov) {
      pinned.push({ sh: e, ps1: p, ov: ov });
      if (e.sev !== ov.shSev || p.sev !== ov.ps1Sev) {
        mismatches.push({ sh: e, ps1: p, ov: ov });
      }
      return;
    }

    matched.push({ sh: e, ps1: p });
    if (p.sev !== e.sev) mismatches.push({ sh: e, ps1: p });
  });

  const shTexts = new Set(sh.map(e => e.text));
  const ps1Only = ps1.filter(e => !shTexts.has(e.text));

  if (report) {
    console.log('=== 对上的 (' + matched.length + ') ===');
    matched.forEach(m => console.log(
      '  ' + (m.ps1.sev === m.sh.sev ? '  ' : '🔴') +
      ' ps1:' + String(m.ps1.line).padStart(4) + ' ' + m.ps1.sev.padEnd(6) +
      ' | sh:' + String(m.sh.line).padStart(4) + ' ' + m.sh.sev.padEnd(6) +
      ' | ' + m.sh.text.slice(0, 92)));
    console.log('\n=== sh-only (' + shOnly.length + ') —— 无参照系，交 arch 定档 ===');
    shOnly.forEach(e => console.log('  sh:' + String(e.line).padStart(4) + ' ' + e.sev.padEnd(6) + ' | ' + e.text.slice(0, 100)));
    console.log('\n=== ps1-only (' + ps1Only.length + ') ===');
    ps1Only.forEach(e => console.log('  ps1:' + String(e.line).padStart(4) + ' ' + e.sev.padEnd(6) + ' | ' + e.text.slice(0, 100)));
    console.log('\n=== 钉住的故意分岔 (' + pinned.length + ') —— 两边的档都被钉，任一边变了就红 ===');
    pinned.forEach(x => console.log('  ps1:' + x.ps1.line + ' ' + x.ov.ps1Sev
      + ' | sh:' + x.sh.line + ' ' + x.ov.shSev + ' | ' + x.sh.text.slice(0, 70)));
    console.log('\n=== 已豁免 sh-only (' + exemptSet.size + ') ===');
    Object.keys(EXEMPT_SH).forEach(k => console.log('  - ' + k.slice(0, 70) + '\n      理由: ' + EXEMPT_SH[k].slice(0, 110)));
    return;
  }

  /* 🔴 控制组：对上的条目数不能是 0。
     全都对不上时"零不一致"与"完全一致"是同一个输出 —— 那正是本仓 #28-分型② 那一族。 */
  if (matched.length === 0) {
    console.error('🔴 REFUSED: 一条都没对上 ⇒ 抽取器坏了，"零不一致"没有任何信息量。');
    process.exit(3);
  }

  let bad = false;
  if (mismatches.length) {
    bad = true;
    console.error('🔴 severity 不一致 —— ' + mismatches.length + ' 条（颜色会说谎）:');
    mismatches.forEach(m => {
      console.error('  · "' + m.sh.text.slice(0, 88) + '"');
      console.error('      ps1:' + m.ps1.line + ' = ' + m.ps1.sev + '   |   sh:' + m.sh.line + ' = ' + m.sh.sev);
      if (m.ov) {
        console.error('      ⚠ 这条在 severityOverride 里被钉成 ps1=' + m.ov.ps1Sev + ' / sh=' + m.ov.shSev
          + ' —— 实际值已经偏离，说明有人动了其中一边。');
        console.error('      钉它的理由: ' + m.ov.why.slice(0, 150));
      }
    });
  }
  if (shOnly.length) {
    bad = true;
    console.error('🔴 sh 有 ' + shOnly.length + ' 条既没有 ps1 对应、也不在豁免清单里:');
    shOnly.forEach(e => console.error('  · sh:' + e.line + ' [' + e.sev + '] ' + e.text.slice(0, 88)));
    console.error('  ⇒ 要么在 ps1 里补上对应的一句，要么写进 tools/message-parity-exemptions.json 并给理由。');
  }

  if (bad) process.exit(1);
  console.log('PASS message parity'
    + '\n  ' + matched.length + ' 条两边 severity 一致（其中 ' + MANUAL_PAIRS.length + ' 条是显式声明的跨平台措辞对）'
    + '\n  ' + pinned.length + ' 条故意分岔 —— 两边的档【都被钉住】，任一边变了也会红'
    + '\n  ' + exemptSet.size + ' 条 sh-only 已豁免 · ' + ps1Only.length + ' 条 ps1-only'
    + '\n  ⚠ 后两项是这条闸的【盲区】：它看不见那些行。⛔ 别把这个 PASS 读成'
    + '"两个脚本的消息完全对齐了"'
    + '\n  ⚠ 它也【不保证 severity 本身对】—— 只保证两边一致。参照系是 ps1，ps1 错了它照样绿。');
}

main();
