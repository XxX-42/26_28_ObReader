const errorRecord = (error) => ({
  name: error?.name || "Error",
  message: error?.message || String(error),
  stack: error?.stack || null,
});

const withinDeadline = async (promise, timeoutMs, label) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ state: "fulfilled", value }),
        (error) => ({ state: "rejected", error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ state: "timeout", error: new Error(`${label} exceeded ${timeoutMs} ms`) }),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const processHasExited = (child) =>
  Boolean(child && (child.exitCode !== null || child.signalCode !== null));

const waitForProcessExit = async (child, timeoutMs) => {
  if (processHasExited(child)) return true;
  const result = await withinDeadline(
    new Promise((resolve) => child.once("exit", resolve)),
    timeoutMs,
    "owned browser process exit",
  );
  return result.state === "fulfilled" || processHasExited(child);
};

/**
 * Close a browser launched by this test, then release only its stdio readers
 * after Puppeteer confirms the browser is disconnected and its own process has
 * exited. A crashpad descendant can inherit stderr, so ChildProcess `close`
 * (and Puppeteer's readline cleanup) may otherwise never occur.
 */
export async function cleanupBrowserTestResources({
  browser,
  server,
  browserTimeoutMs = 8_000,
  processExitTimeoutMs = 2_000,
  serverTimeoutMs = 5_000,
} = {}) {
  const report = {
    browser: null,
    server: null,
    errors: [],
  };

  if (browser) {
    const child = browser.process?.() || null;
    const closeResult = await withinDeadline(
      Promise.resolve().then(() => browser.close()),
      browserTimeoutMs,
      "Puppeteer browser.close",
    );
    report.browser = {
      closeState: closeResult.state,
      closeError: closeResult.error ? errorRecord(closeResult.error) : null,
      process: child
        ? {
            pid: child.pid ?? null,
            exitCode: child.exitCode,
            signalCode: child.signalCode,
          }
        : null,
      connectedAfterClose: browser.connected ?? null,
      releasedExitedProcessPipes: false,
    };

    if (closeResult.state !== "fulfilled") {
      report.errors.push({
        phase: "browser.close",
        ...errorRecord(closeResult.error),
      });
    }

    const exited = child
      ? await waitForProcessExit(child, processExitTimeoutMs)
      : false;
    if (child && !exited) {
      report.errors.push({
        phase: "browser.process.exit",
        message: `Owned browser process ${child.pid ?? "unknown"} did not exit within ${processExitTimeoutMs} ms`,
      });
    }

    if (child && exited && browser.connected) {
      const disconnectResult = await withinDeadline(
        Promise.resolve().then(() => browser.disconnect()),
        1_000,
        "Puppeteer browser.disconnect",
      );
      report.browser.disconnectState = disconnectResult.state;
      if (disconnectResult.state !== "fulfilled") {
        report.errors.push({
          phase: "browser.disconnect",
          ...errorRecord(disconnectResult.error),
        });
      }
    }

    const disconnected = browser.connected === false;
    report.browser.connectedAfterClose = browser.connected ?? null;
    report.browser.process = child
      ? {
          pid: child.pid ?? null,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
        }
      : null;

    if (child && exited && disconnected) {
      for (const streamName of ["stdout", "stderr"]) {
        try {
          child[streamName]?.destroy();
        } catch (error) {
          report.errors.push({
            phase: `browser.${streamName}.destroy`,
            ...errorRecord(error),
          });
        }
      }
      report.browser.releasedExitedProcessPipes = true;
    } else if (child) {
      report.errors.push({
        phase: "browser.pipe.release",
        message:
          "Did not destroy browser stdio: both the owned process exit and Puppeteer disconnect were not confirmed",
      });
    }
  }

  if (server) {
    const closeResult = await withinDeadline(
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
      serverTimeoutMs,
      "HTTP test server close",
    );
    report.server = { closeState: closeResult.state };
    if (closeResult.state !== "fulfilled") {
      report.server.closeError = closeResult.error
        ? errorRecord(closeResult.error)
        : null;
      report.errors.push({
        phase: "server.close",
        ...(closeResult.error
          ? errorRecord(closeResult.error)
          : { message: "HTTP test server did not close before its deadline" }),
      });
    }
  }

  return report;
}

export function attachCleanupErrors(primaryError, report) {
  if (!report?.errors?.length) return primaryError;
  if (primaryError) {
    primaryError.cleanupErrors = report.errors;
    return primaryError;
  }
  return new AggregateError(
    report.errors.map((entry) => Object.assign(new Error(entry.message), entry)),
    "Browser test cleanup failed",
  );
}
