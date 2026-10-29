// Browser-built ZIPs keep large private exports within the function response limit.
export const EXPORT_CHUNK_BYTES = 1024 * 1024;
export const MAX_EXPORT_BYTES = 160 * 1024 * 1024;

export function sourceDocument(fields) {
  const names = ["title", "date", "format", "slug", "description", "tags"];
  return ["---", ...names.map((name) => `${name}: ${JSON.stringify(fields[name] ?? (name === "tags" ? [] : ""))}`), "---", "", fields.body ?? "", ""].join("\n");
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const header = (length) => {
  const bytes = new Uint8Array(length);
  return { bytes, view: new DataView(bytes.buffer) };
};

/** Standard stored ZIP, UTF-8 paths, deterministic timestamps, no executable wrapper. */
export async function createZip(files) {
  const encoder = new TextEncoder(), parts = [], central = [], paths = new Set();
  let offset = 0, centralSize = 0;
  if (files.length > 2000) throw new Error("Too many files to export.");
  for (const file of files) {
    if (!file.path || file.path.startsWith("/") || file.path.includes("\\") || file.path.split("/").some((p) => !p || p === "." || p === "..") || /[\x00-\x1f]/.test(file.path) || paths.has(file.path)) {
      throw new Error("Unsafe or duplicate export path.");
    }
    paths.add(file.path);
    const name = encoder.encode(file.path);
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(await file.bytes.arrayBuffer());
    if (name.length > 65535 || offset + bytes.length > MAX_EXPORT_BYTES) throw new Error("Export exceeds the package size limit.");
    const crc = crc32(bytes);
    const local = header(30), record = header(46);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true); local.view.setUint16(6, 0x800, true);
    local.view.setUint16(12, 33, true); // 1980-01-01
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, bytes.length, true); local.view.setUint32(22, bytes.length, true);
    local.view.setUint16(26, name.length, true);
    record.view.setUint32(0, 0x02014b50, true);
    record.view.setUint16(4, 20, true); record.view.setUint16(6, 20, true);
    record.view.setUint16(8, 0x800, true); record.view.setUint16(14, 33, true);
    record.view.setUint32(16, crc, true);
    record.view.setUint32(20, bytes.length, true); record.view.setUint32(24, bytes.length, true);
    record.view.setUint16(28, name.length, true); record.view.setUint32(42, offset, true);
    parts.push(local.bytes, name, bytes);
    central.push(record.bytes, name);
    centralSize += record.bytes.length + name.length;
    offset += local.bytes.length + name.length + bytes.length;
  }
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, files.length, true); end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, centralSize, true); end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.bytes], { type: "application/zip" });
}

export async function verifyExportFile(blob, expected) {
  if (blob.size !== expected.bytes) throw new Error(`Export size mismatch: ${expected.path}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== expected.sha256) throw new Error(`Export hash mismatch: ${expected.path}`);
}
