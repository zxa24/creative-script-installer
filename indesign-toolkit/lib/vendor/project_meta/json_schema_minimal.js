// json_schema_minimal.js — minimal JSON Schema draft 2020-12 validator
//
// Scope: only the keywords needed by project_meta.schema.json:
//   $schema $id title description (metadata, ignored)
//   type (string|integer|object|array|null + ["string","null"])
//   required, properties, additionalProperties (false)
//   enum, const
//   pattern, minLength, maxLength
//   minimum, maximum
//   format (date-time — RFC 3339 subset)
//   oneOf (with branch selection)
//   items (single sub-schema; tuple not supported)
//
// Why not ajv: UXP webview can't `require` npm packages (only inlined
// libs); ajv is ~150KB minified and far more than we need. app-folio
// webui DOES vendor ajv UMD for richer error messages, but this minimal
// validator runs there too as fallback / unit-test cross-check (~250 LOC).
//
// API:
//   JSONSchemaMinimal.validate(data, schema) → { valid: bool, errors: [...] }
//
// Error format: { path: "/foo/bar", keyword: "required", message: "..." }
//
// UMD wrapper: window.JSONSchemaMinimal (browser) / module.exports (Node/UXP).

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.JSONSchemaMinimal = factory();
    }
}(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
    "use strict";

    var DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

    // RFC 3339 date-time validator: parses + checks Y/M/D/H/M/S ranges,
    // leap days, leap seconds. Requires UTC offset (Z or numeric).
    function isValidDateTime(s) {
        var m = DATE_TIME_RE.exec(s);
        if (!m) return false;
        var Y = +m[1], M = +m[2], D = +m[3], h = +m[4], mi = +m[5], se = +m[6];
        var offset = m[8];
        if (M < 1 || M > 12) return false;
        if (D < 1) return false;
        // Days in month
        var dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        var leap = (Y % 4 === 0 && Y % 100 !== 0) || (Y % 400 === 0);
        if (M === 2 && leap) { if (D > 29) return false; }
        else if (D > dim[M - 1]) return false;
        if (h > 23) return false;
        if (mi > 59) return false;
        // RFC 3339 §5.7: a leap second is inserted just before midnight UTC.
        // The leap-second instant in a given offset is the local time that
        // converts back to 23:59:60Z. Codex r3 P2: prior check used local
        // h/mi == 23/59 which rejected correctly-offset representations
        // (e.g. 1990-12-31T15:59:60-08:00 IS valid: it shifts to
        // 1990-12-31T23:59:60Z).
        if (se > 60) return false;
        if (se === 60) {
            // Compute UTC instant. Local h:mi shifted by offset. Codex r4 P2:
            // also verify UTC DATE is a valid leap-second date (per IERS
            // historical list, leap seconds inserted at end of 06-30 or
            // 12-31 UTC). We use a permissive check: month==06 || 12, day
            // is last-of-month after offset shift.
            var offsetH = 0, offsetM = 0, sign = 0;
            if (offset === "Z") {
                sign = 0;
            } else {
                sign = offset.charAt(0) === "+" ? 1 : -1;
                offsetH = +offset.substring(1, 3);
                offsetM = +offset.substring(4, 6);
            }
            var localMin = h * 60 + mi;
            var utcMin = localMin - sign * (offsetH * 60 + offsetM);
            // Day rollover if utcMin out of 0..1439
            var dayShift = 0;
            if (utcMin < 0) { dayShift = -1; utcMin += 1440; }
            else if (utcMin >= 1440) { dayShift = 1; utcMin -= 1440; }
            if (utcMin !== 23 * 60 + 59) return false;
            // Compute UTC date with day shift
            var utcDate = new Date(Date.UTC(Y, M - 1, D + dayShift));
            var utcM = utcDate.getUTCMonth() + 1;
            var utcD = utcDate.getUTCDate();
            // Must be last day of month 06 or 12 (when leap seconds can occur)
            var dimUtc = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
            if (!(utcM === 6 || utcM === 12)) return false;
            if (utcD !== dimUtc[utcM - 1]) return false;
        }
        // Numeric offset: validate hours 00-23 minutes 00-59
        if (offset !== "Z") {
            var oh = +offset.substring(1, 3);
            var om = +offset.substring(4, 6);
            if (oh > 23 || om > 59) return false;
        }
        return true;
    }

    // Count Unicode code points (vs UTF-16 code units). String.length counts
    // surrogate pairs as 2 — so "𝐀" (U+1D400) has length 2 but is 1 codepoint.
    // JSON Schema maxLength/minLength is defined in codepoints (per spec).
    function codePointLength(s) {
        // Modern engines (UXP webview included per probe 2026-06-07) support
        // Array.from on strings which iterates by codepoint.
        if (typeof Array.from === "function") {
            return Array.from(s).length;
        }
        var n = 0, i = 0;
        while (i < s.length) {
            var c = s.charCodeAt(i);
            if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
                var c2 = s.charCodeAt(i + 1);
                if (c2 >= 0xDC00 && c2 <= 0xDFFF) { n++; i += 2; continue; }
            }
            n++; i++;
        }
        return n;
    }

    function jsTypeOf(v) {
        if (v === null) return "null";
        if (Array.isArray(v)) return "array";
        var t = typeof v;
        if (t === "number") return Number.isInteger(v) ? "integer" : "number";
        return t; // "string" | "object" | "boolean" | "undefined"
    }

    function typeMatches(actual, expected) {
        if (typeof expected === "string") return actual === expected
            || (expected === "number" && actual === "integer"); // integer is a number
        if (Array.isArray(expected)) {
            for (var i = 0; i < expected.length; i++) {
                if (typeMatches(actual, expected[i])) return true;
            }
            return false;
        }
        return false;
    }

    function pushErr(errors, path, keyword, message) {
        errors.push({ path: path || "", keyword: keyword, message: message });
    }

    function deepEqual(a, b) {
        if (a === b) return true;
        if (typeof a !== typeof b) return false;
        if (a === null || b === null) return false;
        if (typeof a !== "object") return false;
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        if (Array.isArray(a)) {
            if (a.length !== b.length) return false;
            for (var i = 0; i < a.length; i++) {
                if (!deepEqual(a[i], b[i])) return false;
            }
            return true;
        }
        var ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (var i = 0; i < ka.length; i++) {
            if (!Object.prototype.hasOwnProperty.call(b, ka[i])) return false;
            if (!deepEqual(a[ka[i]], b[ka[i]])) return false;
        }
        return true;
    }

    function validateNode(data, schema, path, errors) {
        if (schema === true) return;
        if (schema === false) {
            pushErr(errors, path, "schema", "schema is false; nothing valid");
            return;
        }
        if (!schema || typeof schema !== "object") return;

        // type
        if (schema.type !== undefined) {
            var actual = jsTypeOf(data);
            if (!typeMatches(actual, schema.type)) {
                pushErr(errors, path, "type",
                    "expected type " + JSON.stringify(schema.type) + ", got " + actual);
                return; // type mismatch → don't run other keywords (they assume valid type)
            }
        }

        // const
        if (Object.prototype.hasOwnProperty.call(schema, "const")) {
            if (!deepEqual(data, schema.const)) {
                pushErr(errors, path, "const",
                    "expected const " + JSON.stringify(schema.const));
            }
        }

        // enum
        if (Array.isArray(schema.enum)) {
            var found = false;
            for (var i = 0; i < schema.enum.length; i++) {
                if (deepEqual(data, schema.enum[i])) { found = true; break; }
            }
            if (!found) {
                pushErr(errors, path, "enum",
                    "value not in enum " + JSON.stringify(schema.enum));
            }
        }

        var dtype = jsTypeOf(data);

        // string keywords
        if (dtype === "string") {
            var slen = codePointLength(data); // codepoint count per JSON Schema spec
            if (typeof schema.minLength === "number" && slen < schema.minLength) {
                pushErr(errors, path, "minLength", "string shorter than " + schema.minLength + " codepoints");
            }
            if (typeof schema.maxLength === "number" && slen > schema.maxLength) {
                pushErr(errors, path, "maxLength", "string longer than " + schema.maxLength + " codepoints");
            }
            if (typeof schema.pattern === "string") {
                try {
                    var re = new RegExp(schema.pattern);
                    if (!re.test(data)) {
                        pushErr(errors, path, "pattern",
                            "does not match pattern " + JSON.stringify(schema.pattern));
                    }
                } catch (eRe) {
                    pushErr(errors, path, "pattern", "invalid regex: " + eRe.message);
                }
            }
            if (schema.format === "date-time") {
                if (!isValidDateTime(data)) {
                    pushErr(errors, path, "format", "not a valid RFC 3339 date-time");
                }
            }
        }

        // number / integer
        if (dtype === "integer" || dtype === "number") {
            if (typeof schema.minimum === "number" && data < schema.minimum) {
                pushErr(errors, path, "minimum", "value < " + schema.minimum);
            }
            if (typeof schema.maximum === "number" && data > schema.maximum) {
                pushErr(errors, path, "maximum", "value > " + schema.maximum);
            }
        }

        // object
        if (dtype === "object") {
            if (Array.isArray(schema.required)) {
                for (var i = 0; i < schema.required.length; i++) {
                    var req = schema.required[i];
                    if (!Object.prototype.hasOwnProperty.call(data, req)) {
                        pushErr(errors, path, "required", "missing required property: " + req);
                    }
                }
            }
            var props = schema.properties || {};
            if (schema.additionalProperties === false) {
                // Codex r12 P2: iterate OWN keys only to avoid prototype-
                // injected properties bypassing the additionalProperties
                // check, and to detect __proto__ if explicitly present.
                var ownKeys = Object.keys(data);
                for (var ki = 0; ki < ownKeys.length; ki++) {
                    var k = ownKeys[ki];
                    if (!Object.prototype.hasOwnProperty.call(props, k)) {
                        pushErr(errors, path + "/" + k, "additionalProperties",
                            "unexpected property: " + k);
                    }
                }
            }
            for (var pk in props) {
                if (Object.prototype.hasOwnProperty.call(data, pk)) {
                    validateNode(data[pk], props[pk], path + "/" + pk, errors);
                }
            }
        }

        // array
        if (dtype === "array" && schema.items) {
            for (var i = 0; i < data.length; i++) {
                validateNode(data[i], schema.items, path + "/" + i, errors);
            }
        }

        // oneOf — exactly one branch must succeed
        if (Array.isArray(schema.oneOf)) {
            var matched = 0;
            var branchErrors = [];
            for (var i = 0; i < schema.oneOf.length; i++) {
                var subErrors = [];
                validateNode(data, schema.oneOf[i], path, subErrors);
                if (subErrors.length === 0) matched++;
                else branchErrors.push({ branch: i, errors: subErrors });
            }
            if (matched !== 1) {
                pushErr(errors, path, "oneOf",
                    "expected exactly one matching branch, got " + matched +
                    " (branch errors: " + JSON.stringify(branchErrors) + ")");
            }
        }
    }

    function validate(data, schema) {
        var errors = [];
        validateNode(data, schema, "", errors);
        return { valid: errors.length === 0, errors: errors };
    }

    return { validate: validate, _deepEqual: deepEqual };
}));
