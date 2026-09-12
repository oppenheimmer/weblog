// A figure's entry module, imported by the post's own page.
//
// §3.6 grants a verified figure the same page access as the blog's own
// JavaScript — that is the whole point of the pathway, and the reason a figure
// is not an iframe. So this module proves it has that access rather than
// merely that it loaded.
import { label } from "./helper.mjs";

export function mount(root, context) {
  // What the engine hands a figure, reported so the contract is measured
  // rather than assumed: the root it must draw into, and engine-owned
  // presentation values it could not work out for itself.
  root.dataset.mounted = label;
  root.textContent = "mounted";
  new Image().src = "/hit/figure-mount/" + encodeURIComponent(
    [label, context.theme, context.reducedMotion, typeof context.width].join(",")
  );
  // A vendored library the figure declared, loaded by the engine before this
  // module was imported: the version the page actually defines, or none.
  new Image().src = "/hit/figure-d3/" + encodeURIComponent(globalThis.d3 ? globalThis.d3.version : "none");
  return context;
}

new Image().src = "/hit/figure-module-ran/" + encodeURIComponent(label);
// Reaching the host document is the grant working. If a response header ever
// sandboxed the *importing* page by accident, this is what would stop.
document.title = "mounted";
