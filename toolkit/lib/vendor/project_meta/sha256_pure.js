// sha256_pure.js — minimal SHA-256 in pure JS (FIPS 180-4)
//
// Why: UXP webview lacks `crypto.subtle` (probe 2026-06-07); Browser
// has it but we keep one shared implementation for byte-identity across
// runtimes (canonical-JSON content-hash for CAS).
//
// UMD-ish wrapper: works in <script> tag (window.SHA256Pure), CommonJS
// (toolkit lib via require), and ES module imports (Node test).
//
// API:
//   SHA256Pure.hex(str)  → 64-char lowercase hex digest of UTF-8 bytes
//   SHA256Pure.bytes(str) → Uint8Array(32) of the digest
//
// License: public domain (FIPS 180-4 is non-proprietary; implementation
// derived from the specification, no copied code).

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.SHA256Pure = factory();
    }
}(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
    "use strict";

    // SHA-256 round constants (first 32 bits of the fractional parts of the
    // cube roots of the first 64 primes, per FIPS 180-4 §4.2.2).
    var K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }

    function utf8Encode(str) {
        // Manual well-formed UTF-8 encoding. Lone / unpaired surrogates are
        // replaced with U+FFFD REPLACEMENT CHARACTER (matches Node
        // `Buffer.from(s, 'utf8')` and browser TextEncoder behavior — so
        // SHA-256 hashes agree across Node/UXP/Browser even for ill-formed
        // input). Without this fixup we'd emit WTF-8 and disagree.
        var out = [];
        var FFFD = [0xEF, 0xBF, 0xBD]; // UTF-8 of U+FFFD
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 0x80) {
                out.push(c);
            } else if (c < 0x800) {
                out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
            } else if (c >= 0xD800 && c <= 0xDBFF) {
                // High surrogate — must be followed by low surrogate
                if (i + 1 < str.length) {
                    var c2 = str.charCodeAt(i + 1);
                    if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
                        var cp = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
                        out.push(
                            0xF0 | (cp >> 18),
                            0x80 | ((cp >> 12) & 0x3F),
                            0x80 | ((cp >> 6) & 0x3F),
                            0x80 | (cp & 0x3F)
                        );
                        i++;
                        continue;
                    }
                }
                // Lone high surrogate → U+FFFD
                out.push(FFFD[0], FFFD[1], FFFD[2]);
            } else if (c >= 0xDC00 && c <= 0xDFFF) {
                // Lone low surrogate → U+FFFD
                out.push(FFFD[0], FFFD[1], FFFD[2]);
            } else {
                out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
            }
        }
        return out;
    }

    function hashBytes(bytes) {
        // Initial hash values (first 32 bits of the fractional parts of the
        // square roots of the first 8 primes; FIPS 180-4 §5.3.3).
        var H = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        ];

        var L = bytes.length;
        var bitLen = L * 8;

        // Pad: append 0x80 + zeros + 64-bit big-endian length
        var padded = bytes.slice();
        padded.push(0x80);
        while ((padded.length % 64) !== 56) padded.push(0);
        // 64-bit big-endian length — JS bitwise ops are 32-bit, so high
        // 32 bits = (bitLen / 0x100000000) | 0; low 32 = bitLen | 0.
        var hi = Math.floor(bitLen / 0x100000000);
        var lo = bitLen >>> 0;
        padded.push((hi >>> 24) & 0xFF, (hi >>> 16) & 0xFF, (hi >>> 8) & 0xFF, hi & 0xFF);
        padded.push((lo >>> 24) & 0xFF, (lo >>> 16) & 0xFF, (lo >>> 8) & 0xFF, lo & 0xFF);

        var W = new Array(64);
        for (var off = 0; off < padded.length; off += 64) {
            for (var t = 0; t < 16; t++) {
                W[t] = ((padded[off + t * 4]) << 24)
                     | ((padded[off + t * 4 + 1]) << 16)
                     | ((padded[off + t * 4 + 2]) << 8)
                     | (padded[off + t * 4 + 3]);
            }
            for (t = 16; t < 64; t++) {
                var s0 = rotr(7, W[t - 15]) ^ rotr(18, W[t - 15]) ^ (W[t - 15] >>> 3);
                var s1 = rotr(17, W[t - 2]) ^ rotr(19, W[t - 2]) ^ (W[t - 2] >>> 10);
                W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
            }

            var a = H[0], b = H[1], c = H[2], d = H[3];
            var e = H[4], f = H[5], g = H[6], h = H[7];

            for (t = 0; t < 64; t++) {
                var S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
                var ch = (e & f) ^ ((~e) & g);
                var T1 = (h + S1 + ch + K[t] + W[t]) | 0;
                var S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
                var mj = (a & b) ^ (a & c) ^ (b & c);
                var T2 = (S0 + mj) | 0;
                h = g; g = f; f = e;
                e = (d + T1) | 0;
                d = c; c = b; b = a;
                a = (T1 + T2) | 0;
            }
            H[0] = (H[0] + a) | 0;
            H[1] = (H[1] + b) | 0;
            H[2] = (H[2] + c) | 0;
            H[3] = (H[3] + d) | 0;
            H[4] = (H[4] + e) | 0;
            H[5] = (H[5] + f) | 0;
            H[6] = (H[6] + g) | 0;
            H[7] = (H[7] + h) | 0;
        }

        // Output 32-byte digest big-endian
        var out = new Array(32);
        for (var i = 0; i < 8; i++) {
            out[i * 4]     = (H[i] >>> 24) & 0xFF;
            out[i * 4 + 1] = (H[i] >>> 16) & 0xFF;
            out[i * 4 + 2] = (H[i] >>> 8) & 0xFF;
            out[i * 4 + 3] = H[i] & 0xFF;
        }
        return out;
    }

    function toHex(bytes) {
        var s = "";
        for (var i = 0; i < bytes.length; i++) {
            var b = bytes[i];
            s += (b < 16 ? "0" : "") + b.toString(16);
        }
        return s;
    }

    function hex(str) {
        return toHex(hashBytes(utf8Encode(str)));
    }

    function bytes(str) {
        var arr = hashBytes(utf8Encode(str));
        return typeof Uint8Array !== "undefined" ? new Uint8Array(arr) : arr;
    }

    return { hex: hex, bytes: bytes, _utf8Encode: utf8Encode };
}));
