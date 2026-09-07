// bcp47_validate.js — minimal BCP 47 (RFC 5646) validator + canonicalizer
//
// Two-layer model (per 8D-ext-A0 plan):
//
//   Layer 1 — Structural validation (REJECT if fail)
//     Strict subtag-length check per RFC 5646 grammar subset:
//       primary  : 2-3 letter (ISO 639-1/2/3) | 4 letter (reserved) | 5-8 letter (registered)
//       script   : exactly 4 letter
//       region   : 2 letter | 3 digit
//       variant  : 5-8 alphanumeric | 1 digit + 3 alphanumeric
//     No extlang (3-letter after primary) — kept out of MVP grammar.
//     No private-use / grandfathered tags (`x-...`, `i-...`) — kept out.
//     ASCII only, no whitespace/underscore, primary subtag required.
//
//   Layer 2 — Catalog warning (WARN, don't reject)
//     Looks up primary subtag in embedded ISO 639-1/2 snapshot. If absent,
//     returns warn=true (caller may surface "<tag> not a recognized language
//     code, typo?"). Does NOT reject — UXP font_apply BCP 47 picker already
//     supports free input for niche locales (commit 00ffb53).
//
//   Canonicalization: lowercase primary, TitleCase script, UPPERCASE region,
//   lowercase variants. Returns the normalized form.
//
// API:
//   BCP47.validate(tag) → { valid: bool, canonical?: string,
//                            warn?: bool, errors?: [string] }
//
//   BCP47.isStructurallyValid(tag) → bool  (layer 1 only, convenience)
//   BCP47.canonicalize(tag) → string | null  (returns null if invalid)
//
// UMD wrapper: window.BCP47 (browser), module.exports (Node/UXP).

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.BCP47 = factory();
    }
}(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
    "use strict";

    // ISO 639-1 (alpha-2, 184 entries) + a curated ISO 639-2 alpha-3 subset
    // commonly used in publishing. NOT exhaustive — coverage is "common
    // publishing locales"; unknown but structurally valid tags WARN, not
    // REJECT (Layer 2 contract). Loaded as a plain Set for O(1) lookup.
    var REGISTERED_PRIMARY = new Set([
        // ISO 639-1 alpha-2 (most common subset; full list in Wikipedia)
        "aa","ab","ae","af","ak","am","an","ar","as","av","ay","az",
        "ba","be","bg","bh","bi","bm","bn","bo","br","bs",
        "ca","ce","ch","co","cr","cs","cu","cv","cy",
        "da","de","dv","dz",
        "ee","el","en","eo","es","et","eu",
        "fa","ff","fi","fj","fo","fr","fy",
        "ga","gd","gl","gn","gu","gv",
        "ha","he","hi","ho","hr","ht","hu","hy","hz",
        "ia","id","ie","ig","ii","ik","io","is","it","iu",
        "ja","jv",
        "ka","kg","ki","kj","kk","kl","km","kn","ko","kr","ks","ku","kv","kw","ky",
        "la","lb","lg","li","ln","lo","lt","lu","lv",
        "mg","mh","mi","mk","ml","mn","mr","ms","mt","my",
        "na","nb","nd","ne","ng","nl","nn","no","nr","nv","ny",
        "oc","oj","om","or","os",
        "pa","pi","pl","ps","pt",
        "qu",
        "rm","rn","ro","ru","rw",
        "sa","sc","sd","se","sg","si","sk","sl","sm","sn","so","sq","sr","ss","st","su","sv","sw",
        "ta","te","tg","th","ti","tk","tl","tn","to","tr","ts","tt","tw","ty",
        "ug","uk","ur","uz",
        "ve","vi","vo",
        "wa","wo",
        "xh",
        "yi","yo",
        "za","zh","zu",
        // Common ISO 639-2/3 alpha-3 in publishing (includes bibliographic
        // alpha-3 for ISO 639-1 codes that also need warn-free, e.g. eng/fra/
        // deu/spa, plus the Philippine `fil` and several niche tags codex
        // found absent.)
        "ace","afh","ain","aka","akk","ale","amh","ang","arb","arc","ara","arg","asm","ast","awa","aze",
        "ban","bak","bam","bar","bel","ben","bgs","bih","bod","bos","bre","bua","bug","bul",
        "cat","ceb","ces","cha","che","chi","chk","chr","chu","chv","cmn","cnr","cop","cor","cos","cre","cym","cze",
        "dan","deu","div","dzo",
        "egy","ell","eng","enm","epo","est","eus","ewe",
        "fao","fas","fij","fil","fin","fra","fre","fro","frs","fry","ful",
        "geo","gla","gle","glg","glv","got","grc","gre","grn","guj",
        "hat","hau","haw","heb","her","hin","hit","hmo","hrv","hun","hye",
        "ibo","ice","ido","iii","iku","ile","ina","ind","ine","ipk","isl","ita",
        "jav","jbo","jpn","jpr","jrb",
        "kal","kan","kas","kat","kaz","khm","kik","kin","kir","kor","kua","kur",
        "lao","lat","lav","lim","lin","lit","ltz","lub","lug",
        "mah","mal","mao","mar","may","mga","mis","mkd","mlg","mlt","mol","mon","mri","msa","mul","mya",
        "nau","nav","nbl","nde","ndo","nep","nld","nno","nob","nor","non","nso","nya",
        "oci","oji","ori","orm","oss","oto",
        "pan","peo","phn","pli","pol","por","pus","pol",
        "que","raj","roh","rom","ron","rum","run","rus",
        "sag","san","sin","slk","slo","slv","sme","smo","sna","snd","som","sot","spa","sqi","srp","ssw","sun","sga","swa","swe","syr",
        "tah","tam","tai","tat","tel","tgk","tgl","tha","tib","tir","tmh","ton","tsn","tso","tuk","tur","twi",
        "uig","ukr","und","urd","uzb",
        "ven","vie","vol",
        "wln","wol",
        "xho",
        "yid","yor","yue",
        "zha","zho","zul",
        // Chinese variety tags (per IANA registry)
        "wuu","hak","nan","gan","hsn","cdo","cjy","cmn","cpx","czh","czo","lzh","mnp"
    ]);

    // Position-aware BCP 47 (RFC 5646) parser.
    // Grammar (MVP subset — no extensions / private use / grandfathered):
    //   langtag = language ["-" script] ["-" region] *("-" variant)
    //   language = primary [extlang]
    //   primary = 2-3 alpha | 4 alpha (reserved) | 5-8 alpha (registered)
    //   extlang = 3 alpha (max 3 chained, only after 2-3 alpha primary)
    //   script = 4 alpha
    //   region = 2 alpha | 3 digit
    //   variant = 5-8 alphanumeric | digit + 3 alphanumeric
    //
    // Rejects tags valid only via grammar-position confusion (codex r3+impl
    // finding): `en-US-Latn` (script after region), `en-Latn-Cyrl` (two
    // scripts), `en-US-GB` (two regions). Accepts `zh-yue-Hant-HK` (extlang).
    function parseStructure(tag) {
        if (typeof tag !== "string" || tag.length === 0) return null;
        if (/\s/.test(tag)) return null;
        if (/[^\x00-\x7F]/.test(tag)) return null;
        if (/_/.test(tag)) return null;
        if (tag.indexOf("--") >= 0) return null;
        if (tag.charAt(0) === "-" || tag.charAt(tag.length - 1) === "-") return null;

        var parts = tag.split("-");
        if (parts.length === 0) return null;
        var idx = 0;
        var out = { primary: null, extlang: [], script: null, region: null, variants: [] };

        // 1. Primary subtag: 2-3 letters | 4 letters (reserved) | 5-8 letters
        var p = parts[idx];
        if (/^[A-Za-z]{2,3}$/.test(p) || /^[A-Za-z]{4}$/.test(p) || /^[A-Za-z]{5,8}$/.test(p)) {
            out.primary = p;
            idx++;
        } else {
            return null;
        }

        // 2. Optional extlang(s) — only if primary is 2-3 letters; max 3
        if (out.primary.length <= 3) {
            while (idx < parts.length && /^[A-Za-z]{3}$/.test(parts[idx]) && out.extlang.length < 3) {
                out.extlang.push(parts[idx]);
                idx++;
            }
        }

        // 3. Optional script: exactly 4 letters
        if (idx < parts.length && /^[A-Za-z]{4}$/.test(parts[idx])) {
            out.script = parts[idx];
            idx++;
        }

        // 4. Optional region: 2 letters or 3 digits
        if (idx < parts.length && (/^[A-Za-z]{2}$/.test(parts[idx]) || /^\d{3}$/.test(parts[idx]))) {
            out.region = parts[idx];
            idx++;
        }

        // 5. Variants: 5-8 alphanumeric OR digit + 3 alphanumeric (chained).
        //    Per RFC 5646 §2.2.5, the same variant subtag MUST NOT be used
        //    more than once. Codex r2 P2: previously sl-rozaj-rozaj passed.
        var seenVariants = {};
        while (idx < parts.length && (/^[A-Za-z0-9]{5,8}$/.test(parts[idx]) || /^\d[A-Za-z0-9]{3}$/.test(parts[idx]))) {
            var vk = parts[idx].toLowerCase();
            if (seenVariants[vk]) return null;
            seenVariants[vk] = true;
            out.variants.push(parts[idx]);
            idx++;
        }

        // All consumed?
        if (idx !== parts.length) return null;
        return out;
    }

    function isStructurallyValid(tag) {
        return parseStructure(tag) !== null;
    }

    function canonicalize(tag) {
        if (!isStructurallyValid(tag)) return null;
        var parts = tag.split("-");
        var out = [];
        // Primary: lowercase
        out.push(parts[0].toLowerCase());
        // Position-based normalization for subsequent subtags
        for (var i = 1; i < parts.length; i++) {
            var p = parts[i];
            if (/^[A-Za-z]{4}$/.test(p)) {
                // Script: TitleCase
                out.push(p.charAt(0).toUpperCase() + p.substring(1).toLowerCase());
            } else if (/^[A-Za-z]{2}$/.test(p)) {
                // Region: UPPERCASE
                out.push(p.toUpperCase());
            } else if (/^\d{3}$/.test(p)) {
                // Region (UN M.49): digits unchanged
                out.push(p);
            } else {
                // Variant or other: lowercase
                out.push(p.toLowerCase());
            }
        }
        return out.join("-");
    }

    function validate(tag) {
        if (!isStructurallyValid(tag)) {
            return { valid: false, errors: ["structural BCP 47 grammar violation: " + JSON.stringify(tag)] };
        }
        var canonical = canonicalize(tag);
        var primary = canonical.split("-")[0];
        var warn = !REGISTERED_PRIMARY.has(primary);
        var result = { valid: true, canonical: canonical };
        if (warn) {
            result.warn = true;
            result.warnReason = "primary subtag '" + primary + "' not in known registry; may be typo";
        }
        return result;
    }

    return {
        validate: validate,
        isStructurallyValid: isStructurallyValid,
        canonicalize: canonicalize,
        _REGISTERED_PRIMARY: REGISTERED_PRIMARY
    };
}));
