import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const KATEX_VERSION = require("katex/package.json").version;
export const KATEX_ASSET_ROOT = `/styles/katex/${KATEX_VERSION}`;
