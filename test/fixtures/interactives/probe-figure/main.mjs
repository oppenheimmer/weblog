// A figure's entry module, imported by the post's own page.
//
// §3.6 grants a verified figure the same page access as the blog's own
// JavaScript — that is the whole point of the pathway, and the reason a figure
// is not an iframe. So this module proves it has that access rather than
// merely that it loaded.
import { label } from "./helper.mjs";

export function mount(root, context) {
  root.dataset.mounted = label;
  return context;
}

new Image().src = "/hit/figure-module-ran/" + encodeURIComponent(label);
// Reaching the host document is the grant working. If a response header ever
// sandboxed the *importing* page by accident, this is what would stop.
document.title = "mounted";
