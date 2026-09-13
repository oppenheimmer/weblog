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
//
// **Run preview** (`run: true`, §3.6) is the one exception, and the author asks
// for it. The page is the same; each interactive it uses points at a grant to
// its unpublished bundle instead of the public path it will have, and the
// engine's figure loader for those grants is added. The editor shows it in a
// frame sandboxed with scripts but no origin of its own, so a figure gets page
// access to the previewed article and a lab its production sandbox inside it,
// and neither reaches the editor.
import { createUploads } from "./uploads.mjs";
import { keys } from "./keys.mjs";
import { normalizeDraftInput } from "./drafts.mjs";
import { validateMetadata, resolveForPublish, PublishError } from "./publish.mjs";
import { normalizePost, ContentError, RESERVED_SLUGS } from "../content.mjs";
import { createInteractives } from "./interactives.mjs";
import { attachmentUrl } from "../attachments.mjs";
import { publicFileUrl } from "../interactives.mjs";
import { mintRunGrant, runDirectory, RUN_GRANT_TTL_SECONDS } from "./run-grants.mjs";
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
  // Preview resolves interactives through the same store publication uses, so
  // an unattached or wrong-kind reference is reported here as the refusal it
  // will be there.
  interactives = createInteractives(store),
  signGet = (key, options) => store.signGet(key, options),
  // Signs Run preview grants; without it, a preview still renders but cannot run.
  runSecret = null,
  now = () => new Date(),
  maxBytes = MAX_PREVIEW_BYTES,
} = {}) {
  return {
    /**
     * Render the fields on screen, saved or not.
     *
     * Returns `{ html, diagnostics, bytes, running }`. Diagnostics at level
     * "error" are exactly the refusals publishing would give; "warning" means
     * the post would publish but not render as written. `running` counts the
     * interactives a Run preview pointed at their unpublished bundles.
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
      let bundles = [];
      if (postId) {
        try {
          ({ body, media, interactives: bundles } = await resolveForPublish({ ...draft, slug }, uploads, interactives));
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
      // An image in an interactive's fallback, likewise: its public copy does
      // not exist until publishing makes it.
      for (const bundle of bundles) {
        for (const file of bundle.files.filter((entry) => entry.type.startsWith("image/"))) {
          signed.set(
            publicFileUrl(bundle.kind, slug, bundle.name, bundle.revisionId, file.name),
            await signGet(keys.interactiveFile(postId, bundle.id, bundle.revisionId, file.name),
              { expiresIn: PREVIEW_URL_TTL_SECONDS })
          );
        }
      }
      // Exact public paths only, in src attributes only. Authored text cannot
      // produce a src attribute, so nothing else can be rewritten. The media
      // list goes in as the build's does, so images carry the same dimensions.
      let html = postPage({ ...post, media }).replace(/(\ssrc=")([^"]*)(")/g, (whole, open, src, close) =>
        signed.has(src) ? `${open}${escapeHtml(signed.get(src))}${close}` : whole);

      let running = 0;
      if (input.run === true && bundles.length) {
        if (!runSecret) {
          throw new PreviewError("Running interactives needs RATE_LIMIT_HASH_SECRET to be set.",
            { code: "run_unavailable", status: 503 });
        }
        // The same exact-attribute rule: only an address the resolver wrote
        // for a bundle this post uses is replaced, and only with its grant.
        const granted = new Map(bundles.map((bundle) => {
          const grant = mintRunGrant(
            { postId, interactiveId: bundle.id, revisionId: bundle.revisionId },
            { secret: runSecret, now: now().getTime(), ttlSeconds: RUN_GRANT_TTL_SECONDS }
          );
          return [
            publicFileUrl(bundle.kind, slug, bundle.name, bundle.revisionId, bundle.entry),
            bundle.kind === "demo" ? runDirectory(grant) : `${runDirectory(grant)}${bundle.entry}`,
          ];
        }));
        html = html.replace(/(\sdata-interactive-src=")([^"]*)(")/g, (whole, open, src, close) => {
          if (!granted.has(src)) return whole;
          running += 1;
          return `${open}${escapeHtml(granted.get(src))}${close}`;
        });
        // assets/blog.js frames a lab from any same-origin address, and
        // imports a figure only from /assets/figures/. That second rule stays
        // exactly as published pages have it; figures running from a grant
        // have a loader of their own.
        if (running) {
          html = html.replace('<script src="/assets/blog.js"></script>',
            '<script src="/assets/blog.js"></script>\n  <script src="/assets/preview-run.js"></script>');
        }
      }

      const bytes = Buffer.byteLength(html, "utf8");
      if (bytes > maxBytes) {
        throw new PreviewError(
          `This preview is ${(bytes / 1_000_000).toFixed(1)} MB, more than the editor can show ` +
          `(${(maxBytes / 1_000_000).toFixed(1)} MB). Publishing is not affected.`,
          { code: "preview_too_large", status: 413 }
        );
      }
      return { html, diagnostics, bytes, running };
    },
  };
}
