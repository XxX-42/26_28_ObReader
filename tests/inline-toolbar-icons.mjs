import { readFileSync } from "node:fs";

// These exact embedded SVG masks have no network origin. HTTP(S) requests
// from an SVG remain subject to each test's external-resource assertion.
const css = readFileSync(new URL("../viewer-adapter/bridge.css", import.meta.url), "utf8");
const inlineIcons = new Set([...css.matchAll(/mask-image:\s*url\("(data:image\/svg\+xml,[^"]+)"\)/g)].map(match => match[1]));
export const isInlineToolbarIcon = url => inlineIcons.has(url);
