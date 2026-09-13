// The Distill template's own style blocks, allowed by SHA-256 (CLAUDE.md §3.6).
//
// assets/vendor/distill.template.v2.js injects <style> elements into the page
// and into its components' shadow roots. Public pages refuse inline style
// elements, so without these its slider was invisible, footnote hover boxes
// showed inline, block maths ran into the text and titles lost their layout.
// Allowing exactly these blocks, rather than 'unsafe-inline', keeps every other
// inline style element refused (owner's choice, 2026-09-14).
//
// Measured in Chromium by instantiating every component the template defines
// and hashing each style element's text: twelve blocks, identical across loads.
// Under the public policy with these, nothing is refused and every component
// renders; without them the slider measures 0×0. A new template version needs
// measuring again, and scripts/verify-public-csp.mjs fails on any style block
// it has not been told about.
export const DISTILL_STYLE_HASHES = [
  "sha256-mDUUkO8Ero6MaODIX0zAjpGMp+VUGlgeTQQZ8sOT0Sw=",
  "sha256-K46ywKa38mxnvkLDaec//FO6ocv9FMAYoCRq2lKp45k=",
  "sha256-QTUhQ3/hnEvGqTwFbzSREPoJ7rz41FTXO80X1gPsyMY=",
  "sha256-BwLkN5nYf+A9iqnjz9jFwwX8pMbp63nhyCE8y+T3esI=",
  "sha256-UbaLlBdpEHooXaaR1LL8LMWzmU3H2qmDJiQiZ22lEgg=",
  "sha256-QeGqBMdwTe2penv00WLpKhukH+ugrhG3nkM2CVcXjxU=",
  "sha256-H/6PGmk985AnNj9GGUlHqhyQY7tg4E4+iu82sSUU0aE=",
  "sha256-Z9lHTsR0ayCjzKXSHykm9hDZ7L73TxrQjQ2vLySVxm8=",
  "sha256-6uvI5FiQViwObJgu/OiUEnz1UUzwKYne+nzw81YsIsI=",
  "sha256-thn2Qghx0NEN6Rcosyly4UJzYNMvEH4w+ZuoFZyVlPQ=",
  "sha256-lFap1La84c9963KKksH+HPPhhZ9ovYJIVUmaKHfSX2E=",
  "sha256-wzeZCKm16t+lZk8jGANgGzkDeDsbqr2pXXPaMvlVP18=",
];

/** The hashes as CSP source expressions, for a style-src directive. */
export const distillStyleSources = () => DISTILL_STYLE_HASHES.map((hash) => `'${hash}'`).join(" ");
