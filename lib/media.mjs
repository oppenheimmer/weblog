// What a file actually is, decided from its bytes.
//
// Step 4's rule: "Do not trust extensions, client MIME types, ETags as content
// hashes, or client-provided checksums alone." Everything here reads the file
// itself. A `.png` that is really an HTML document is rejected, and the
// extension written into the public URL is derived from the content rather than
// from whatever the browser claimed.
//
// Dimensions come out of the same pass, because Step 8 needs width and height on
// every image to reserve layout space, and decoding twice would be waste. Only
// the headers are parsed — never the pixel data — so this stays cheap and cannot
// be turned into a decompression bomb.
//
// No dependency. Four container formats, each a few lines of header arithmetic;
// an image library would be a large amount of attack surface for the job.

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;   // 10 MiB   (Step 4)
export const MAX_TEX_BYTES = 256 * 1024;           // 256 KiB  (Step 4)
export const MAX_IMAGE_PIXELS = 50_000_000;        // ~50 MP decoded
export const MAX_IMAGE_DIMENSION = 20_000;         // per side

/** Image types accepted on upload. SVG is absent on purpose: it can carry script. */
export const IMAGE_TYPES = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const u16be = (b, i) => b.readUInt16BE(i);
const u32be = (b, i) => b.readUInt32BE(i);
const u16le = (b, i) => b.readUInt16LE(i);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

const startsWith = (buffer, bytes) =>
  buffer.length >= bytes.length && bytes.every((byte, i) => buffer[i] === byte);

// ------------------------------------------------------------------ formats

function png(buffer) {
  // \x89 P N G \r \n \x1a \n, then a length+type header, then IHDR's dimensions.
  if (!startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  if (buffer.length < 24 || buffer.toString("latin1", 12, 16) !== "IHDR") return null;
  return { format: "png", width: u32be(buffer, 16), height: u32be(buffer, 20) };
}

function jpeg(buffer) {
  if (!startsWith(buffer, [0xff, 0xd8])) return null;
  // Walk the segment chain to a start-of-frame marker, which carries the size.
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null; // not a marker boundary: malformed
    const marker = buffer[offset + 1];
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan data
    const length = u16be(buffer, offset + 2);
    if (length < 2) return null;
    // SOF0-3, SOF5-7, SOF9-11, SOF13-15. The gaps are DHT, JPG and DAC.
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > buffer.length) return null;
      return { format: "jpeg", height: u16be(buffer, offset + 5), width: u16be(buffer, offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function gif(buffer) {
  const header = buffer.toString("latin1", 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return null;
  if (buffer.length < 10) return null;
  return { format: "gif", width: u16le(buffer, 6), height: u16le(buffer, 8) };
}

function webp(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString("latin1", 0, 4) !== "RIFF") return null;
  if (buffer.toString("latin1", 8, 12) !== "WEBP") return null;

  const chunk = buffer.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    // Lossy: a 3-byte start code, then 14-bit width and height.
    return {
      format: "webp",
      width: u16le(buffer, 26) & 0x3fff,
      height: u16le(buffer, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    // Lossless: a signature byte, then two 14-bit fields packed across 4 bytes.
    const bits = buffer.readUInt32LE(21);
    return {
      format: "webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X") {
    // Extended: canvas size as two 24-bit little-endian fields, minus one.
    return {
      format: "webp",
      width: u24le(buffer, 24) + 1,
      height: u24le(buffer, 27) + 1,
    };
  }
  return null;
}

const DETECTORS = [png, jpeg, gif, webp];

/**
 * Identify an image from its bytes.
 *
 * Returns null for anything unrecognised — which includes SVG, HTML and a
 * renamed executable. Callers treat null as a rejection, never as "assume it is
 * fine".
 */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  for (const detect of DETECTORS) {
    const found = detect(buffer);
    if (!found) continue;
    const { width, height } = found;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
    return {
      kind: "image",
      format: found.format,
      mediaType: IMAGE_TYPES[found.format],
      extension: found.format === "jpeg" ? "jpg" : found.format,
      width,
      height,
    };
  }
  return null;
}

/**
 * Is this a `.tex` snippet we can accept?
 *
 * UTF-8 that round-trips, with no NUL. A file containing NUL is binary being
 * passed off as text, whatever its extension says.
 */
export function sniffTex(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  if (buffer.includes(0)) return null;
  const text = buffer.toString("utf8");
  // Buffer.toString substitutes U+FFFD for invalid sequences; re-encoding and
  // comparing is the cheapest way to detect that it did.
  if (!Buffer.from(text, "utf8").equals(buffer)) return null;
  return { kind: "tex", format: "tex", mediaType: "text/x-tex", extension: "tex", text };
}

/** Identify any accepted attachment, or explain why it is refused. */
export function identify(buffer, { kind } = {}) {
  if (kind === "tex") {
    const tex = sniffTex(buffer);
    if (!tex) return { ok: false, reason: "That file is not valid UTF-8 text, so it cannot be a .tex snippet." };
    if (buffer.length > MAX_TEX_BYTES) {
      return { ok: false, reason: `A .tex snippet may be at most ${MAX_TEX_BYTES / 1024} KiB.` };
    }
    return { ok: true, ...tex, bytes: buffer.length };
  }

  const image = sniffImage(buffer);
  if (!image) {
    return {
      ok: false,
      reason: "That file is not a PNG, JPEG, GIF or WebP image. " +
        "SVG, PDF and archives are not accepted.",
    };
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `An image may be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MiB.` };
  }
  if (image.width > MAX_IMAGE_DIMENSION || image.height > MAX_IMAGE_DIMENSION) {
    return {
      ok: false,
      reason: `That image is ${image.width}x${image.height}; each side must be under ${MAX_IMAGE_DIMENSION}px.`,
    };
  }
  if (image.width * image.height > MAX_IMAGE_PIXELS) {
    // A small file can still decode to an enormous bitmap.
    return { ok: false, reason: "That image decodes to too many pixels to be displayed safely." };
  }
  return { ok: true, ...image, bytes: buffer.length };
}

// --------------------------------------------------------------- public names

/**
 * A human-readable public filename, per §3.3.
 *
 * `/images/uploads/setting-up/architecture-diagram.png`, never a 64-character
 * hash. The extension comes from the verified content, not from the name the
 * browser supplied.
 */
export function sanitizeAssetName(original, extension) {
  const base = String(original ?? "")
    .replace(/\\/g, "/")
    .split("/").pop()               // discard any path the browser included
    .replace(/\.[^.]*$/, "")        // and the claimed extension
    .toLowerCase()
    // Decompose accents, then drop the combining marks themselves. Without the
    // second step "ü" becomes "u" + a combining diaeresis, and the mark turns
    // into a separator: "ünïcödé" would sanitize to "u-ni-co-de".
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${base || "attachment"}.${extension}`;
}

/**
 * Make a name unique within one post by suffixing, never by overwriting.
 *
 * §3.3: "On collision within a post, append -2, -3, and so on. Never silently
 * overwrite." Two posts may each hold a `diagram.png`; they are in different
 * prefixes and do not collide.
 */
export function uniqueAssetName(name, taken = new Set()) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Cannot find a free name for ${name} after 999 attempts.`);
}
