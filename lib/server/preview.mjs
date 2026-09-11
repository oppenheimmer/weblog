// Server-rendered preview (CLAUDE.md §3.1, Step 5).
//
// Rendered by exactly the pipeline a build uses — the same resolver, renderer
// and page template — so what the author sees is what readers get. The
// differences are deliberate and confined to the edges:
//
//   * Images come from the verified attachment through short-lived signed URLs,
//     because nothing is published yet. Those URLs exist only in this response.
//     A preview writes nothing, so none can end up stored in a draft.
//   * A half-written draft still previews. A missing title or date gets a
//     placeholder, and what publishing would refuse is reported, not thrown.
//   * What publishing refuses is decided by publishing's own functions
//     (validateMetadata, resolveForPublish), so the two cannot disagree about
//     whether a post can go out.
//
// The editor shows the result in an iframe with sandbox="" — no script, no
// access to the editor. Verified in Chromium rather than assumed
// (scripts/verify-preview-sandbox.mjs): without that attribute, a same-origin
// script placed in the preview runs.
import { createUploads } from "./uploads.mjs";
import { keys } from "./keys.mjs";
import { normalizeDraftInput } from "./drafts.mjs";
import { validateMetadata, resolveForPublish, PublishError } from "./publish.mjs";
import { normalizePost, ContentError, RESERVED_SLUGS } from "../content.mjs";
import { attachmentUrl } from "../attachments.mjs";
import { postPage, escapeHtml } from "../templates.mjs";
import { renderDiagnostics } from "../diagnostics.mjs";
import { BROWSER } from "../sanitize.mjs";

// JSON escaping inflates this, and Vercel caps a response at 4.5 MB.
export const MAX_PREVIEW_BYTES = 2_500_000;
// Signed image URLs are bearer tokens; the editor refreshes before they lapse.
export const PREVIEW_URL_TTL_SECONDS = 600;
const POST_ID = /^p_[0-9a-f]{16}$/;

export class PreviewError extends Error {
  constructor(message, { code = "preview_failed", status = 422, field } = {}) {
    super(message);
    this.name = "PreviewError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

/** A publish refusal, reported instead of thrown. */
const blocker = (err) => ({ level: "error", code: err.code, field: err.field ?? null, message: err.message });

export function createPreviewer(store, {
  uploads = createUploads(store),
  signGet = (key, options) => store.signGet(key, options),
  now = () => new Date(),
  maxBytes = MAX_PREVIEW_BYTES,
} = {}) {
  return {
    /**
     * Render the fields on screen, saved or not.
     *
     * Returns `{ html, diagnostics, bytes }`. Diagnostics at level "error" are
     * exactly the refusals publishing would give; "warning" means the post
     * would publish but not render as written.
     */
    async render(input = {}) {
      // The same bounds a draft save enforces, so preview cannot be used to
      // render something a draft could never hold.
      const fields = normalizeDraftInput(input);
      const postId = input.postId ?? null;
      if (postId !== null && (typeof postId !== "string" || !POST_ID.test(postId))) {
        throw new PreviewError("Unknown post.", { code: "invalid_post", status: 400, field: "postId" });
      }

      const diagnostics = [];
      const draft = { ...fields, postId };
      try {
        validateMetadata(draft);
      } catch (err) {
        if (!(err instanceof PublishError)) throw err;
        diagnostics.push(blocker(err));
      }

      // A slug that cannot be published still has to render; the refusal
      // above already says why it cannot go out.
      const slug = fields.slug && !RESERVED_SLUGS.has(fields.slug) ? fields.slug : "preview";

      let body = fields.body;
      let media = [];
      if (postId) {
        try {
          ({ body, media } = await resolveForPublish({ ...draft, slug }, uploads));
        } catch (err) {
          if (!(err instanceof PublishError)) throw err;
          diagnostics.push(blocker(err));
        }
      }

      let post;
      try {
        post = normalizePost({
          data: {
            title: fields.title || "Untitled",
            date: fields.date || now().toISOString().slice(0, 10),
            description: fields.description,
            tags: fields.tags,
            slug,
          },
          body,
          format: fields.format,
          sourceName: "preview",
          trust: BROWSER,
        });
      } catch (err) {
        if (err instanceof ContentError) {
          throw new PreviewError(err.message, { code: "invalid_content", field: err.field });
        }
        throw err;
      }
      diagnostics.push(...renderDiagnostics(post.html));

      // This post's images, signed from the verified attachment — the published
      // copy does not exist until publishing makes it.
      const signed = new Map();
      for (const item of media) {
        signed.set(
          attachmentUrl(slug, item.publicName),
          await signGet(keys.attachmentBlob(postId, item.publicName), { expiresIn: PREVIEW_URL_TTL_SECONDS })
        );
      }
      // Exact public paths only, in src attributes only. Authored text cannot
      // produce a src attribute, so nothing else can be rewritten.
      const html = postPage(post).replace(/(\ssrc=")([^"]*)(")/g, (whole, open, src, close) =>
        signed.has(src) ? `${open}${escapeHtml(signed.get(src))}${close}` : whole);

      const bytes = Buffer.byteLength(html, "utf8");
      if (bytes > maxBytes) {
        throw new PreviewError(
          `This preview is ${(bytes / 1_000_000).toFixed(1)} MB, more than the editor can show ` +
          `(${(maxBytes / 1_000_000).toFixed(1)} MB). Publishing is not affected.`,
          { code: "preview_too_large", status: 413 }
        );
      }
      return { html, diagnostics, bytes };
    },
  };
}
