import { existsSync } from "node:fs";

const WINDOWS_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const MACOS_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];

export function resolveBrowserPath({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const explicit = env.PDF_READER_CHROME || env.PDFJS_CHROME;
  if (explicit) return exists(explicit) ? explicit : undefined;

  const candidates = platform === "darwin"
    ? MACOS_CANDIDATES
    : platform === "win32"
      ? WINDOWS_CANDIDATES
      : [];
  return candidates.find((candidate) => exists(candidate));
}
