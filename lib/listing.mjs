// The listing model shared by the home page and every tag page (CLAUDE.md Step 8).
//
// A listing is a scope — every post, or every post carrying one tag — shown two
// ways. The feed shows complete articles, so it is split into pages by how much
// HTML those articles weigh. The table is a line per post, so it lists the
// whole scope on every page: that is what the table has always been for, and
// splitting it by the feed's weight would cut an index into arbitrary pieces.
// Both show the same posts in the same order; the feed just takes more pages to
// do it.
import { containsElement } from "./markup.mjs";

/**
 * How much rendered article HTML one feed page may carry, in bytes.
 *
 * Decided against measured output rather than a post count, because KaTeX
 * dominates weight and posts differ by an order of magnitude: a long
 * mathematical post renders to about 110 KB and 2,900 elements, a LaTeX note to
 * about 58 KB, a prose essay of similar length to about 7.5 KB. This budget is
 * roughly three long mathematical posts, or forty-odd essays, per page. A post
 * heavier than the whole budget still gets a page of its own.
 */
export const FEED_PAGE_BYTES = 350_000;

/**
 * Split `items` into consecutive pages whose total weight stays within
 * `budget`. Order is preserved, no page is empty, and an item heavier than the
 * budget is placed alone rather than dropped. An empty scope is one empty page,
 * so a listing always has a first page to render.
 */
export function paginate(items, { budget = FEED_PAGE_BYTES, weigh }) {
  if (!(budget > 0)) throw new Error(`A page budget must be positive, not ${budget}.`);
  const pages = [];
  let current = [];
  let used = 0;
  for (const item of items) {
    const weight = weigh(item);
    if (current.length && used + weight > budget) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += weight;
  }
  if (current.length || !pages.length) pages.push(current);
  return pages;
}

// Elements that act on the whole document rather than where they sit.
const PAGE_LEVEL_ELEMENTS = ["script", "style", "link", "base", "meta"];

/**
 * Whether a post's body can be placed in the feed beside other posts.
 *
 * Per-post embeds assume they own the page. A script written for one post finds
 * its nodes with document-wide selectors, and a head hook or stylesheet applies
 * to everything on the page. Two such posts on one page could load a bundle
 * twice or bind each other's elements. So a post carrying any of them appears
 * in the feed by title and description with a link, and its code runs on its
 * own page, once. Only repository-authored posts can carry embeds at all
 * (lib/content.mjs), so nothing published from the editor is affected.
 */
export function inlinesInFeed(post) {
  if (post.scripts?.length || post.styles?.length || post.head || post.distill) return false;
  return !containsElement(post.html, PAGE_LEVEL_ELEMENTS);
}

/** URL of page `number` of the listing rooted at `base` ("/" or "/tags/x/"). */
export function pagePath(base, number) {
  return number === 1 ? base : `${base}page/${number}/`;
}

/**
 * Describe every page of one listing.
 *
 * Each page knows its neighbours, so templates render navigation without
 * recomputing anything, and the build writes each to `<path>index.html`.
 */
export function listingPages(posts, { base = "/", budget = FEED_PAGE_BYTES, weigh }) {
  const pages = paginate(posts, { budget, weigh });
  return pages.map((pagePosts, index) => {
    const number = index + 1;
    return {
      number,
      count: pages.length,
      path: pagePath(base, number),
      base,
      posts: pagePosts,
      newer: number > 1 ? pagePath(base, number - 1) : null,
      older: number < pages.length ? pagePath(base, number + 1) : null,
    };
  });
}
