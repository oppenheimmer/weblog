// Tier 4 / Step 4 — what a file actually is.
//
// Fixtures are real encoder output (ffmpeg), not hand-built headers, because a
// parser tested only against buffers its own author wrote proves nothing beyond
// self-consistency.
//
// WebP was the exception for a while: with no encoder on the machine, its
// cases were hand-built headers, and VP8L — the lossless form, whose two
// dimensions are packed into one little-endian word — was only ever confirmed
// self-consistent. It is now real `cwebp` output, and the ground truth is
// independent of the encoder that produced it: each fixture was decoded back
// to PNG with `dwebp` and its dimensions read from the PNG header, which is a
// different program reading a different format.
//
// VP8X is still hand-built. Neither `webpmux` nor an ffmpeg WebP encoder was
// available to produce an extended file, so that one case remains what it was,
// and this comment is the record of which is which.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  sniffImage, sniffTex, identify, sanitizeAssetName, uniqueAssetName,
  MAX_IMAGE_BYTES, MAX_TEX_BYTES, MAX_IMAGE_DIMENSION,
} from "../lib/media.mjs";

const MEDIA = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "media");
const fixture = (name) => fs.readFileSync(path.join(MEDIA, name));

// ------------------------------------------------------- real encoder output

test("real PNG, JPEG and GIF files are identified with exact dimensions", () => {
  // Asymmetric on purpose: a width/height swap cannot hide behind a square.
  const cases = [
    ["sample-7x11.png", "png", "png", "image/png", 7, 11],
    ["sample-13x5.jpg", "jpeg", "jpg", "image/jpeg", 13, 5],
    ["sample-9x4.gif", "gif", "gif", "image/gif", 9, 4],
  ];
  for (const [file, format, extension, mediaType, width, height] of cases) {
    const found = sniffImage(fixture(file));
    assert.ok(found, `${file} was not recognised`);
    assert.equal(found.format, format);
    assert.equal(found.extension, extension, "the public extension comes from content, not the name");
    assert.equal(found.mediaType, mediaType);
    assert.equal(found.width, width, `${file} width`);
    assert.equal(found.height, height, `${file} height`);
  }
});

test("the extension written into a public URL comes from the bytes, not the filename", () => {
  // A JPEG uploaded as "photo.png" must publish as .jpg.
  const found = identify(fixture("sample-13x5.jpg"));
  assert.equal(found.ok, true);
  assert.equal(sanitizeAssetName("photo.png", found.extension), "photo.jpg");
});

// --------------------------------------------------------------------- WebP

/** Minimal RIFF/WEBP container around a given chunk. */
function webp(chunkId, payload) {
  const chunk = Buffer.concat([
    Buffer.from(chunkId, "latin1"),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(payload.length); return b; })(),
    payload,
  ]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(4 + chunk.length, 4);
  riff.write("WEBP", 8, "latin1");
  return Buffer.concat([riff, chunk, Buffer.alloc(16)]); // pad past the header reads
}

test("WebP lossy (VP8) dimensions are read from the frame header", () => {
  const payload = Buffer.alloc(24);
  // 3-byte frame tag + 3-byte start code, so the size fields sit at payload 6 and 8,
  // which is container offset 26 and 28.
  payload.writeUInt16LE(17, 6);
  payload.writeUInt16LE(6, 8);
  const found = sniffImage(webp("VP8 ", payload));
  assert.equal(found?.format, "webp");
  assert.equal(found.width, 17);
  assert.equal(found.height, 6);
});

test("WebP lossless (VP8L) dimensions come out of real encoder output", () => {
  // Two 14-bit fields packed into one little-endian word is the easiest place
  // in this parser to be self-consistently wrong: shift or mask the pair the
  // same way in both directions and a hand-built fixture agrees with you.
  // These are real files, and both are asymmetric, so a width/height swap has
  // nowhere to hide.
  for (const [name, width, height] of [
    ["sample-23x6-lossless.webp", 23, 6],
    ["sample-41x17-lossless.webp", 41, 17],
  ]) {
    const found = sniffImage(fs.readFileSync(path.join(MEDIA, name)));
    assert.equal(found?.format, "webp", name);
    assert.equal(found.mediaType, "image/webp", name);
    assert.equal(found.extension, "webp", name);
    assert.equal(`${found.width}x${found.height}`, `${width}x${height}`, name);
  }
});

test("WebP lossy (VP8) dimensions come out of real encoder output too", () => {
  const found = sniffImage(fs.readFileSync(path.join(MEDIA, "sample-41x17-lossy.webp")));
  assert.equal(found?.format, "webp");
  assert.equal(`${found.width}x${found.height}`, "41x17");
});

test("WebP lossless (VP8L) dimensions are read from packed 14-bit fields", () => {
  const payload = Buffer.alloc(24);
  payload[0] = 0x2f; // signature byte
  payload.writeUInt32LE(((8 - 1) & 0x3fff) | (((3 - 1) & 0x3fff) << 14), 1);
  const found = sniffImage(webp("VP8L", payload));
  assert.equal(found?.format, "webp");
  assert.equal(found.width, 8);
  assert.equal(found.height, 3);
});

test("WebP extended (VP8X) dimensions are read from the canvas fields", () => {
  const payload = Buffer.alloc(24);
  const write24 = (value, at) => {
    payload[at] = value & 0xff;
    payload[at + 1] = (value >> 8) & 0xff;
    payload[at + 2] = (value >> 16) & 0xff;
  };
  // 1 flag byte + 3 reserved bytes, so the canvas fields sit at payload 4 and 7,
  // which is container offset 24 and 27.
  write24(40 - 1, 4);
  write24(25 - 1, 7);
  const found = sniffImage(webp("VP8X", payload));
  assert.equal(found?.format, "webp");
  assert.equal(found.width, 40);
  assert.equal(found.height, 25);
});

test("a RIFF file that is not WebP, or carries an unknown chunk, is refused", () => {
  assert.equal(sniffImage(webp("XXXX", Buffer.alloc(24))), null);
  const notWebp = webp("VP8 ", Buffer.alloc(24));
  notWebp.write("AVI ", 8, "latin1");
  assert.equal(sniffImage(notWebp), null);
});

// ---------------------------------------------------------------- rejections

test("formats that can carry script or code are refused", () => {
  const hostile = {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    html: "<!DOCTYPE html><html><script>alert(1)</script></html>",
    pdf: "%PDF-1.7\n1 0 obj\n<</Type/Catalog>>\n",
    zip: "PK\u0003\u0004\u0000\u0000\u0000\u0000",
    elf: "\u007fELF\u0002\u0001\u0001\u0000\u0000\u0000\u0000\u0000",
    shell: "#!/bin/sh\nrm -rf /\n",
  };
  for (const [name, content] of Object.entries(hostile)) {
    const buffer = Buffer.from(content, "latin1");
    assert.equal(sniffImage(buffer), null, `${name} was accepted as an image`);
    const result = identify(buffer);
    assert.equal(result.ok, false, `${name} passed identify()`);
    assert.match(result.reason, /PNG, JPEG, GIF or WebP/);
  }
});

test("a file renamed to .png is still rejected for what it is", () => {
  // The whole point: identification never consults the name.
  const result = identify(Buffer.from("<svg onload=alert(1)></svg>"));
  assert.equal(result.ok, false);
});

test("a truncated or corrupt image is refused rather than half-read", () => {
  const png = fixture("sample-7x11.png");
  for (const length of [0, 4, 11, 16, 20]) {
    assert.equal(sniffImage(png.subarray(0, length)), null, `truncated to ${length} bytes was accepted`);
  }
  // Right magic, wrong structure.
  const brokenHeader = Buffer.from(png);
  brokenHeader.write("XXXX", 12, "latin1");
  assert.equal(sniffImage(brokenHeader), null, "a PNG without IHDR was accepted");
});

test("a JPEG whose segment chain does not terminate in a frame header is refused", () => {
  assert.equal(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64)])), null);
});

test("zero-sized images are refused", () => {
  const png = Buffer.from(fixture("sample-7x11.png"));
  png.writeUInt32BE(0, 16);
  assert.equal(sniffImage(png), null);
});

test("an image with absurd declared dimensions is refused before anything decodes it", () => {
  // A few hundred bytes can declare a bitmap far too large to render.
  const png = Buffer.from(fixture("sample-7x11.png"));
  png.writeUInt32BE(MAX_IMAGE_DIMENSION + 1, 16);
  png.writeUInt32BE(10, 20);
  const result = identify(png);
  assert.equal(result.ok, false);
  assert.match(result.reason, /each side must be under/);

  // Within per-side limits but an enormous product.
  const wide = Buffer.from(fixture("sample-7x11.png"));
  wide.writeUInt32BE(19_000, 16);
  wide.writeUInt32BE(19_000, 20);
  const pixels = identify(wide);
  assert.equal(pixels.ok, false);
  assert.match(pixels.reason, /too many pixels/);
});

test("images and snippets over their size limits are refused", () => {
  const png = fixture("sample-7x11.png");
  const big = Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]);
  const image = identify(big);
  assert.equal(image.ok, false);
  assert.match(image.reason, /at most 10 MiB/);

  const tex = identify(Buffer.alloc(MAX_TEX_BYTES + 1, 0x20), { kind: "tex" });
  assert.equal(tex.ok, false);
  assert.match(tex.reason, /at most 256 KiB/);
});

// ----------------------------------------------------------------- tex files

test("a real .tex snippet is accepted and its text recovered", () => {
  const result = identify(fixture("snippet.tex"), { kind: "tex" });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "tex");
  assert.equal(result.extension, "tex");
  assert.match(result.text, /\\section\{A snippet\}/);
});

test("binary wearing a .tex extension is refused", () => {
  // A NUL byte means binary, whatever the extension claims.
  assert.equal(sniffTex(Buffer.from([0x41, 0x00, 0x42])), null);
  assert.equal(sniffTex(fixture("sample-7x11.png")), null);
  // Invalid UTF-8 must not be silently replaced with U+FFFD and accepted.
  assert.equal(sniffTex(Buffer.from([0xc3, 0x28])), null);
  assert.equal(sniffTex(Buffer.from([0xff, 0xfe, 0x41])), null);
  assert.equal(sniffTex(Buffer.alloc(0)), null);
});

test("valid multi-byte UTF-8 is accepted", () => {
  const result = sniffTex(Buffer.from("\\text{café — naïve 日本語}", "utf8"));
  assert.ok(result);
  assert.match(result.text, /café/);
});

// -------------------------------------------------------------- public names

test("public names are human-readable, lowercase and path-free", () => {
  const cases = [
    ["Architecture Diagram.PNG", "png", "architecture-diagram.png"],
    ["../../etc/passwd", "png", "passwd.png"], // last segment only, never a joined path
    ["C:\\Users\\me\\My Photo.jpeg", "jpg", "my-photo.jpg"],
    ["  spaces  everywhere  .png", "png", "spaces-everywhere.png"],
    ["...", "png", "attachment.png"],
    ["", "png", "attachment.png"],
    ["ünïcödé näme.png", "png", "unicode-name.png"],
    ["a/b/c/d.png", "png", "d.png"],
    ["%2e%2e%2ftraversal.png", "png", "2e-2e-2ftraversal.png"],
  ];
  for (const [input, extension, expected] of cases) {
    assert.equal(sanitizeAssetName(input, extension), expected, `from ${JSON.stringify(input)}`);
  }
});

test("a sanitized name can never contain a path separator or traversal", () => {
  for (const hostile of ["../../../etc/passwd", "..\\..\\windows\\system32", "a/../../b", "./../x"]) {
    const name = sanitizeAssetName(hostile, "png");
    assert.ok(!name.includes("/"), name);
    assert.ok(!name.includes("\\"), name);
    assert.ok(!name.includes(".."), name);
  }
});

test("names are truncated, so a very long filename cannot bloat a key", () => {
  const name = sanitizeAssetName("a".repeat(500), "png");
  assert.ok(name.length <= 64, `${name.length} characters`);
  assert.match(name, /^a+\.png$/);
});

test("a colliding name is suffixed, never overwritten", () => {
  const taken = new Set(["diagram.png"]);
  assert.equal(uniqueAssetName("diagram.png", taken), "diagram-2.png");
  taken.add("diagram-2.png");
  assert.equal(uniqueAssetName("diagram.png", taken), "diagram-3.png");
  assert.equal(uniqueAssetName("other.png", taken), "other.png");
});

test("two posts may each hold the same filename without colliding", () => {
  // Names are scoped per post by the key layout, so an empty set is correct here.
  assert.equal(uniqueAssetName("diagram.png", new Set()), "diagram.png");
});
