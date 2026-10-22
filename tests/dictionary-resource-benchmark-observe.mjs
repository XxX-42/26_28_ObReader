// Read-only diagnostic sidecar. Never changes benchmark parameters or scans IDB.
import { readFile, appendFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";

const [profile, output] = process.argv.slice(2);
if (!profile || !output) throw new Error("Pass benchmark Chrome profile and ignored output JSONL");
const port = (await readFile(`${profile}/DevToolsActivePort`, "utf8")).split("\n")[0];
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
let connected = true;
browser.on("disconnected", () => { connected = false; });
try {
  while (connected) {
    try {
      const targets = browser.targets().map(target => ({ type: target.type(), url: target.url() }));
      const pages = [];
      for (const page of await browser.pages()) {
        if (!page.url().includes("?variant=")) continue;
        const workers = [];
        for (const worker of page.workers()) {
          const metrics = await worker.evaluate(() => {
            const current = globalThis.__dictionaryBenchMetrics;
            if (!current) return null;
            const { membershipBucketUtf8Bytes, ...rest } = current;
            return rest;
          });
          workers.push({ url: worker.url(), metrics });
        }
        pages.push({ url: page.url(), workers });
      }
      await appendFile(output, JSON.stringify({ at: new Date().toISOString(), targets, pages }) + "\n");
    } catch (error) {
      await appendFile(output, JSON.stringify({ at: new Date().toISOString(), error: String(error) }) + "\n");
    }
    if (connected) await new Promise(resolve => setTimeout(resolve, 30000));
  }
} finally {
  browser.disconnect();
}
