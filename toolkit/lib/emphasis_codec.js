"use strict";

// lib/emphasis_codec.js — Phase 8C-1
//
// Encode (sourceText, emphasis_runs[]) into LLM-friendly marked-up text;
// decode the LLM's translated marked-up text back into structured form.
//
// Default scheme: HTML-style inline tags (LLMs are fluent in HTML).
//   single dim:    <b>...</b>  <i>...</i>  <u>...</u>  <s>...</s>
//                  <sub>...</sub>  <sup>...</sup>
//   attributes:    <c=#FF0000>...</c>   <fs=14>...</fs>   <ff="Arial">...</ff>
//   composite:     <emp b u c=#0000FF>...</emp>   (multi-dim shortcut)
//
// API:
//   encode(sourceText, emphasisRuns, options) → markedText
//   decode(markedTargetText, options)         → { targetText, targetEmphasisRuns, stats }
//
// Decode returns 4-tier provenance per run via stats:
//   stats.matched   — strict tag match (open + close pair)
//   stats.tolerant  — close tag missing or malformed; ranged via stack fallback
//   stats.dropped   — couldn't recover; emphasis lost (target text intact)
//
// Pure module. Node + UXP loadable. No DOM dependencies.

// ─── Color helpers ────────────────────────────────────────────────

function colorToHex(c) {
    if (!c) return null;
    if (c.values && c.values.length >= 3) {
        var r = Math.max(0, Math.min(255, Math.round(c.values[0])));
        var g = Math.max(0, Math.min(255, Math.round(c.values[1])));
        var b = Math.max(0, Math.min(255, Math.round(c.values[2])));
        var hex = ((r << 16) | (g << 8) | b).toString(16);
        while (hex.length < 6) hex = "0" + hex;
        return hex.toUpperCase();
    }
    return null;
}

function hexToColor(hex) {
    var s = String(hex || "").replace(/^#/, "").toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(s)) return null;
    var v = parseInt(s, 16);
    return {
        space: "RGB",
        values: [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
    };
}

// ─── Encode: diff → tag pair ──────────────────────────────────────

// Returns { open, close } for wrapping the run's text. For multi-dim
// diffs, uses composite <emp ...> tag to keep the LLM payload compact.
function _diffToTagPair(diff) {
    if (!diff) return null;
    var keys = [];
    for (var k in diff) {
        if (Object.prototype.hasOwnProperty.call(diff, k)) keys.push(k);
    }
    if (keys.length === 0) return null;

    // Detect simple single-tag cases first (more LLM-friendly)
    if (keys.length === 1) {
        var only = keys[0];
        if (only === "fontStyle") {
            // Only the exact styles "Bold" / "Italic" / "Bold Italic" get the
            // <b>/<i> shorthand — decode maps them back to those exact names.
            // Substring matching here used to hijack Semibold/Xbold (contain
            // "bold") into <b>, collapsing the weight to "Bold" on decode.
            var fs = String(diff.fontStyle).toLowerCase();
            if (fs === "bold italic") return { open: "<b><i>", close: "</i></b>" };
            if (fs === "bold") return { open: "<b>", close: "</b>" };
            if (fs === "italic") return { open: "<i>", close: "</i>" };
            // Any other style string (Semibold/Xbold/Light/Medium/Black/
            // "Semibold Italic"/…) → composite fs_style, roundtrips verbatim
            return { open: "<emp fs_style=\"" + String(diff.fontStyle).replace(/"/g, "") + "\">", close: "</emp>" };
        }
        if (only === "underline" && diff.underline)         return { open: "<u>", close: "</u>" };
        if (only === "strikeThrough" && diff.strikeThrough) return { open: "<s>", close: "</s>" };
        if (only === "fontSize") return { open: "<fs=" + diff.fontSize + ">", close: "</fs>" };
        if (only === "fontFamily") return { open: "<ff=\"" + String(diff.fontFamily).replace(/"/g, "") + "\">", close: "</ff>" };
        if (only === "fillColor") {
            var hex = colorToHex(diff.fillColor);
            if (hex) return { open: "<c=#" + hex + ">", close: "</c>" };
            if (diff.fillColor && diff.fillColor.swatch) {
                return { open: "<c=" + diff.fillColor.swatch + ">", close: "</c>" };
            }
            return null;
        }
        if (only === "baseline_shift") {
            if (diff.baseline_shift > 0) return { open: "<sup>", close: "</sup>" };
            if (diff.baseline_shift < 0) return { open: "<sub>", close: "</sub>" };
            return null;
        }
    }

    // Multi-dim → composite <emp> tag
    var atts = [];
    if (diff.fontStyle) {
        // Same exact-match rule as the single-dim branch: b/i shorthand only
        // for exact Bold/Italic/Bold Italic; other weights keep fs_style
        var fsLow = String(diff.fontStyle).toLowerCase();
        if (fsLow === "bold")             atts.push("b");
        else if (fsLow === "italic")      atts.push("i");
        else if (fsLow === "bold italic") { atts.push("b"); atts.push("i"); }
        else atts.push('fs_style="' + String(diff.fontStyle).replace(/"/g, "") + '"');
    }
    if (diff.underline)     atts.push("u");
    if (diff.strikeThrough) atts.push("s");
    if (typeof diff.baseline_shift === "number") {
        if (diff.baseline_shift > 0) atts.push("sup");
        else if (diff.baseline_shift < 0) atts.push("sub");
    }
    if (diff.fontSize) atts.push("fs=" + diff.fontSize);
    if (diff.fontFamily) atts.push('ff="' + String(diff.fontFamily).replace(/"/g, "") + '"');
    if (diff.fillColor) {
        var hex2 = colorToHex(diff.fillColor);
        if (hex2) atts.push("c=#" + hex2);
        else if (diff.fillColor.swatch) atts.push("c=" + diff.fillColor.swatch);
    }
    if (atts.length === 0) return null;
    return { open: "<emp " + atts.join(" ") + ">", close: "</emp>" };
}

function encode(sourceText, emphasisRuns, options) {
    options = options || {};
    var src = String(sourceText || "");
    if (!emphasisRuns || !emphasisRuns.length) return src;

    var sorted = emphasisRuns.slice().sort(function (a, b) {
        return (a.start || 0) - (b.start || 0);
    });

    var out = "";
    var pos = 0;
    for (var i = 0; i < sorted.length; i++) {
        var r = sorted[i];
        if (!r || typeof r.start !== "number" || typeof r.end !== "number") continue;
        if (r.end <= r.start) continue;
        var s = Math.max(pos, Math.min(src.length, r.start));
        var e = Math.max(s, Math.min(src.length, r.end));
        if (e === s) continue;  // collapsed after clamp — nothing to wrap
        if (s > pos) out += src.substring(pos, s);
        var tag = _diffToTagPair(r.diff);
        if (tag) {
            out += tag.open + src.substring(s, e) + tag.close;
        } else {
            // Unencodable diff (e.g. only tracking changes) — emit raw text;
            // the run's offset is recoverable via source-side fallback at
            // decode time. Stats counts this elsewhere.
            out += src.substring(s, e);
        }
        pos = e;
    }
    if (pos < src.length) out += src.substring(pos);
    return out;
}

// ─── Decode: marked text → { text, runs, stats } ──────────────────

// Tag regex: <name attrs> or </name>. name is alpha; attrs may include
// =value (with optional quoted strings), space-separated names, mixed.
var TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9_]*)((?:\s+[^>]*)?|=[^>]*)?>/g;

function _parseAttrPart(attrPart) {
    // attrPart is the raw text between the tag name and the closing >.
    // Two shapes we care about:
    //   "" (no attrs)            e.g. <b>
    //   "=14"                    single =value (e.g. <fs=14>)
    //   ' b u c=#FF0000'         space-separated emp attrs
    //   '="Arial Bold"'          quoted string after =
    var raw = String(attrPart || "").trim();
    if (!raw) return { kind: "none", value: null, atts: [] };
    if (raw.charAt(0) === "=") {
        // single-value attr (e.g. <fs=14> or <c=#FF0000> or <ff="Arial">)
        var v = raw.substring(1).trim();
        // unquote
        if (v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') {
            v = v.substring(1, v.length - 1);
        }
        return { kind: "value", value: v, atts: [] };
    }
    // emp-style space-separated attrs
    // Split respecting quoted values: ff="Arial Bold" becomes one token
    var atts = [];
    var i = 0;
    while (i < raw.length) {
        if (/\s/.test(raw.charAt(i))) { i++; continue; }
        var j = i;
        var inQuote = false;
        while (j < raw.length) {
            var ch = raw.charAt(j);
            if (ch === '"') inQuote = !inQuote;
            else if (/\s/.test(ch) && !inQuote) break;
            j++;
        }
        atts.push(raw.substring(i, j));
        i = j;
    }
    return { kind: "atts", value: null, atts: atts };
}

function _parseEmpAtts(atts) {
    var diff = {};
    for (var i = 0; i < atts.length; i++) {
        var a = atts[i];
        if (!a) continue;
        if (a === "b") {
            diff.fontStyle = diff.fontStyle === "Italic" ? "Bold Italic" : "Bold";
        } else if (a === "i") {
            diff.fontStyle = diff.fontStyle === "Bold" ? "Bold Italic" : "Italic";
        } else if (a === "u")    diff.underline = true;
        else if (a === "s")      diff.strikeThrough = true;
        else if (a === "sup")    diff.baseline_shift = 2.5;
        else if (a === "sub")    diff.baseline_shift = -2.5;
        else if (a.indexOf("fs=") === 0) {
            var v = Number(a.substring(3));
            if (!isNaN(v) && v > 0) diff.fontSize = v;
        } else if (a.indexOf("c=") === 0) {
            var cv = a.substring(2);
            if (cv.charAt(0) === "#") cv = cv.substring(1);
            if (/^[0-9a-f]{6}$/i.test(cv)) {
                diff.fillColor = hexToColor(cv);
            } else {
                diff.fillColor = { swatch: cv };
            }
        } else if (a.indexOf("ff=") === 0) {
            var fv = a.substring(3);
            if (fv.charAt(0) === '"' && fv.charAt(fv.length - 1) === '"') {
                fv = fv.substring(1, fv.length - 1);
            }
            diff.fontFamily = fv;
        } else if (a.indexOf("fs_style=") === 0) {
            var fsv = a.substring(9);
            if (fsv.charAt(0) === '"' && fsv.charAt(fsv.length - 1) === '"') {
                fsv = fsv.substring(1, fsv.length - 1);
            }
            diff.fontStyle = fsv;
        }
    }
    return diff;
}

function _tagToDiff(tagName, parsedAttr) {
    var name = String(tagName).toLowerCase();
    if (name === "b")   return { fontStyle: "Bold" };
    if (name === "i")   return { fontStyle: "Italic" };
    if (name === "u")   return { underline: true };
    if (name === "s")   return { strikeThrough: true };
    if (name === "sub") return { baseline_shift: -2.5 };
    if (name === "sup") return { baseline_shift: 2.5 };
    if (name === "fs" && parsedAttr.kind === "value") {
        var n = Number(parsedAttr.value);
        if (!isNaN(n) && n > 0) return { fontSize: n };
        return null;
    }
    if (name === "ff" && parsedAttr.kind === "value") {
        return { fontFamily: parsedAttr.value };
    }
    if (name === "c" && parsedAttr.kind === "value") {
        var cv = parsedAttr.value;
        if (cv.charAt(0) === "#") cv = cv.substring(1);
        if (/^[0-9a-f]{6}$/i.test(cv)) return { fillColor: hexToColor(cv) };
        return { fillColor: { swatch: parsedAttr.value } };
    }
    if (name === "emp" && parsedAttr.kind === "atts") {
        var d = _parseEmpAtts(parsedAttr.atts);
        return Object.keys(d).length ? d : null;
    }
    return null;
}

function _isKnownTag(name) {
    return /^(b|i|u|s|sub|sup|fs|ff|c|emp)$/i.test(name);
}

function decode(markedText, options) {
    options = options || {};
    var stats = { matched: 0, tolerant: 0, dropped: 0 };
    var src = String(markedText || "");

    var out = "";
    var lastEnd = 0;
    var stack = [];   // [{ name, parsedAttr, startInOut, openTagText }]
    var runs = [];

    TAG_RE.lastIndex = 0;
    var m;
    while ((m = TAG_RE.exec(src)) !== null) {
        var fullTag = m[0];
        var isClose = m[1] === "/";
        var name = m[2];
        var attrPart = m[3] || "";
        var matchStart = m.index;

        // Unknown / unrelated tag → leave verbatim
        if (!_isKnownTag(name)) {
            out += src.substring(lastEnd, matchStart) + fullTag;
            lastEnd = matchStart + fullTag.length;
            continue;
        }

        // Append text before this tag
        out += src.substring(lastEnd, matchStart);
        lastEnd = matchStart + fullTag.length;

        if (!isClose) {
            stack.push({
                name: name.toLowerCase(),
                parsedAttr: _parseAttrPart(attrPart),
                startInOut: out.length,
                openTagText: fullTag
            });
        } else {
            // Find matching open in stack (nearest match by name)
            var found = -1;
            var lc = name.toLowerCase();
            for (var s = stack.length - 1; s >= 0; s--) {
                if (stack[s].name === lc) { found = s; break; }
            }
            if (found < 0) {
                // Orphan close — drop, no run
                stats.dropped++;
                continue;
            }
            // Pop everything above found (those are mis-nested opens — emit as tolerant)
            var tolerantPops = stack.length - 1 - found;
            for (var t = 0; t < tolerantPops; t++) {
                var orphan = stack.pop();
                var orphanDiff = _tagToDiff(orphan.name, orphan.parsedAttr);
                if (orphanDiff) {
                    runs.push({
                        start: orphan.startInOut,
                        end: out.length,
                        diff: orphanDiff,
                        provenance: "tolerant"
                    });
                    stats.tolerant++;
                } else {
                    stats.dropped++;
                }
            }
            var open = stack.pop();
            var diff = _tagToDiff(open.name, open.parsedAttr);
            if (diff) {
                runs.push({
                    start: open.startInOut,
                    end: out.length,
                    diff: diff,
                    provenance: "matched"
                });
                stats.matched++;
            } else {
                stats.dropped++;
            }
        }
    }

    // Append trailing text
    out += src.substring(lastEnd);

    // Any unclosed opens → tolerant runs to end of text
    while (stack.length > 0) {
        var unclosed = stack.pop();
        var dunc = _tagToDiff(unclosed.name, unclosed.parsedAttr);
        if (dunc) {
            runs.push({
                start: unclosed.startInOut,
                end: out.length,
                diff: dunc,
                provenance: "tolerant"
            });
            stats.tolerant++;
        } else {
            stats.dropped++;
        }
    }

    // Merge runs with identical [start, end] into one composite diff
    runs = _mergeColocatedRuns(runs);

    // Sort by start for determinism
    runs.sort(function (a, b) { return a.start - b.start; });

    // Strip provenance from final output (it's per-run dev info; stats has aggregate)
    var cleanRuns = [];
    for (var k = 0; k < runs.length; k++) {
        cleanRuns.push({ start: runs[k].start, end: runs[k].end, diff: runs[k].diff });
    }
    return { targetText: out, targetEmphasisRuns: cleanRuns, stats: stats };
}

function _mergeColocatedRuns(runs) {
    var byKey = {};
    var order = [];
    for (var i = 0; i < runs.length; i++) {
        var r = runs[i];
        var key = r.start + "_" + r.end;
        if (!byKey[key]) {
            byKey[key] = { start: r.start, end: r.end, diff: {}, provenance: r.provenance };
            order.push(key);
        }
        for (var k in r.diff) {
            if (!Object.prototype.hasOwnProperty.call(r.diff, k)) continue;
            // Merge fontStyle: combine Bold + Italic → Bold Italic
            if (k === "fontStyle") {
                var existing = byKey[key].diff.fontStyle;
                var incoming = r.diff[k];
                if (existing && existing !== incoming) {
                    var hasBold = (existing.toLowerCase().indexOf("bold") >= 0) ||
                                  (incoming.toLowerCase().indexOf("bold") >= 0);
                    var hasItal = (existing.toLowerCase().indexOf("italic") >= 0) ||
                                  (incoming.toLowerCase().indexOf("italic") >= 0);
                    byKey[key].diff.fontStyle = hasBold && hasItal ? "Bold Italic" :
                        hasBold ? "Bold" : hasItal ? "Italic" : incoming;
                } else {
                    byKey[key].diff.fontStyle = incoming;
                }
            } else {
                byKey[key].diff[k] = r.diff[k];
            }
        }
    }
    var out = [];
    for (var j = 0; j < order.length; j++) out.push(byKey[order[j]]);
    return out;
}

// ─── Module exports ───────────────────────────────────────────────

module.exports = {
    encode: encode,
    decode: decode,
    // exposed for tests
    _internal: {
        colorToHex: colorToHex,
        hexToColor: hexToColor,
        diffToTagPair: _diffToTagPair,
        parseAttrPart: _parseAttrPart,
        parseEmpAtts: _parseEmpAtts,
        tagToDiff: _tagToDiff,
        mergeColocatedRuns: _mergeColocatedRuns
    }
};
