// A source-level image block shared by Markdown and LaTeX; all presentation is plain text.
import { isLocalImageUrl } from "./sanitize.mjs";
export const IMAGE_DIRECTIVE = /^[ \t]*::image\[([^\]\n]+)\](?:[ \t]+(\{[^\n]*\}))?[ \t]*$/gm;

export class ImageDetailsError extends Error {
  constructor(message) { super(message); this.name = "ImageDetailsError"; }
}

export function imageDetails(raw = "{}") {
  let input;
  try { input = JSON.parse(raw); } catch { throw new ImageDetailsError("Image details must be a JSON object on one line."); }
  if (!input || Array.isArray(input) || typeof input !== "object") throw new ImageDetailsError("Image details must be an object.");
  const limits = { alt: 1000, caption: 2000, credit: 1000, description: 10000 };
  if (Object.keys(input).some((name) => !Object.hasOwn(limits, name))) throw new ImageDetailsError("Image details accept alt, caption, credit and description only.");
  const result = {};
  for (const [name, limit] of Object.entries(limits)) {
    const value = input[name] ?? "";
    if (typeof value !== "string" || value.length > limit) throw new ImageDetailsError(`Image ${name} must be text of at most ${limit} characters.`);
    result[name] = value;
  }
  return result;
}

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function figure(src, notes) {
  if (!isLocalImageUrl(src)) throw new ImageDetailsError("An image block must reference a verified attachment or a local published image.");
  const text = [
    notes.caption ? `<p class="image-caption">${escape(notes.caption)}</p>` : "",
    notes.credit ? `<p class="image-credit">Credit: ${escape(notes.credit)}</p>` : "",
    notes.description ? `<p class="image-description">${escape(notes.description)}</p>` : "",
  ].join("");
  return `<figure class="article-image"><img src="${escape(src)}" alt="${escape(notes.alt)}" />${text ? `<figcaption>${text}</figcaption>` : ""}</figure>`;
}

export function renderImageBlocks(source, { format, replace, render }) {
  if (!source.includes("::image[")) return render(source);
  let prefix = "WEBLOGIMAGEBLOCK";
  while (source.includes(prefix)) prefix += "X";
  const images = [];
  const body = replace(source, format, IMAGE_DIRECTIVE, (match) => {
    const token = `${prefix}${images.length}END`;
    images.push({ token, html: figure(match[1], imageDetails(match[2])) });
    return `\n\n${token}\n\n`;
  });
  let html = render(body);
  for (const image of images) {
    const paragraph = `<p>${image.token}</p>`;
    if (html.trim() === image.token) { html = image.html; continue; }
    if (!html.includes(paragraph)) throw new ImageDetailsError("Put each image block on a separate paragraph outside inline formatting.");
    html = html.replace(paragraph, image.html);
  }
  return html;
}
