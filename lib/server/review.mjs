import { keys } from "./keys.mjs";
import { DraftError } from "./drafts.mjs";

const compact = (record) => ({
  ...Object.fromEntries(["title", "date", "format", "slug", "description", "tags", "body"].map((name) => [name, record[name]])),
  media: (record.media ?? []).map(({ publicName, sha256 }) => ({ publicName, sha256 })),
  interactives: (record.interactives ?? []).map(({ kind, name, revisionId }) => ({ kind, name, revisionId })),
});

export async function publicationReview({ store, publisher, draft, baseline = "latest", readManifest }) {
  if (!["latest", "live"].includes(baseline)) throw new DraftError("Choose latest publication or currently live.");
  const after = await publisher.review(draft);
  let entry;
  let label;
  if (baseline === "live") {
    const manifest = await readManifest();
    if (!manifest.ok) return { available: false, reason: `The live revision could not be checked: ${manifest.reason}.` };
    entry = manifest.posts.find((post) => post.postId === draft.postId);
    label = entry ? "Revision currently live" : "Currently live: this post is absent";
  } else {
    const { data: index } = await publisher.readIndex();
    entry = Object.values(index.posts ?? {}).find((post) => post.postId === draft.postId)
      ?? index.unpublished?.[draft.postId];
    label = entry ? "Latest publication in R2 (may differ from the live site)" : "First publication: no previous publication";
  }
  let before = null;
  if (entry) {
    // Identities come from the authoritative index or public manifest, never a caller-selected key.
    if (typeof entry.revisionId !== "string" || !/^r_[0-9a-z_]{1,100}$/.test(entry.revisionId)) {
      return { available: false, reason: "The baseline revision could not be identified." };
    }
    const record = await store.getJson(keys.publishedRevision(draft.postId, entry.revisionId));
    if (!record || record.data.postId !== draft.postId) {
      return { available: false, reason: "The baseline publication is no longer retained. Choose another baseline." };
    }
    before = compact(record.data);
    label += ` · ${entry.revisionId}`;
  }
  const result = { available: true, label: `${label} → current fields. Attachment references are expanded on both sides.`, before, after: compact(after) };
  if (Buffer.byteLength(JSON.stringify(result)) > 4_300_000) {
    throw new DraftError("This comparison is too large to return. Export source to compare it locally.", { status: 413 });
  }
  return result;
}
