import { createInterface } from "node:readline";
import { connectToIsolatedObsidian } from "./native-cdp-transport.mjs";

const [cdpUrl, expectedVault, expectedConfigDir, vaultSelector, rawTimeout] =
  process.argv.slice(2);
const timeoutMs = Number(rawTimeout);
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let client;

try {
  client = await connectToIsolatedObsidian({
    cdpUrl,
    expectedVault,
    expectedConfigDir,
    vaultSelector,
    timeoutMs,
  });
  await client.verifyIdentity();
  output({ ready: true });

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      await client.verifyIdentity();
      const response = await client.send(request.method, request.params || {});
      output({ id: request.id, response: response.result ?? response });
    } catch (error) {
      output({
        id: request?.id ?? null,
        error: error?.stack || String(error),
      });
    }
  }
} catch (error) {
  output({ ready: false, error: error?.stack || String(error) });
  process.exitCode = 1;
} finally {
  client?.close();
}
