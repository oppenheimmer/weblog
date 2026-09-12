// The entry module, loaded by relative path from index.html.
//
// Module scripts are always fetched in CORS mode. From the sandbox's opaque
// origin that makes this load cross-origin, so it needs an explicit read
// header on the bundle path — the most fragile assumption in §3.6, and the
// reason this fixture exists.
import { label } from "./nested.mjs";

window.beacon("module-ran/" + encodeURIComponent(label));
