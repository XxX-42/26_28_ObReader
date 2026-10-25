import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "native-os-pointer.swift");

export function dispatchNativeOsPointerDrag({ x1, y1, x2, y2, steps = 12, delayMs = 20 }) {
  for (const [name, value] of Object.entries({ x1, y1, x2, y2 })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid native pointer ${name}: ${value}`);
  }
  if (!Number.isInteger(steps) || steps < 2 || steps > 48) throw new Error(`Invalid native pointer steps: ${steps}`);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 100) throw new Error(`Invalid native pointer delay: ${delayMs}`);
  const output = execFileSync("swift", [DRIVER, "drag", String(x1), String(y1), String(x2), String(y2),
    String(steps), String(delayMs)], { encoding: "utf8", timeout: 20_000 });
  return JSON.parse(output.trim());
}
