import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  finalizeTestBrowserLaunch,
  getTestBrowserLaunchMetadata,
  launchTestBrowser,
  mergeBrowserTestEnvironment,
} from "./browser-test-launch.mjs";

async function makeArtifactsDirectory(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { root, artifactsDir: path.join(root, "artifacts") };
}

function fakeBrowser(pid) {
  return {
    process: () => ({ pid, spawnfile: "/opt/fake/Chrome" }),
  };
}

async function readLaunchRecords(recordPath) {
  const contents = await readFile(recordPath, "utf8");
  return contents.trim().split("\n").map((line) => JSON.parse(line));
}

test("Windows browser environments merge variable names case-insensitively", () => {
  assert.deepEqual(mergeBrowserTestEnvironment({ Path: "system-path", KEEP: "base" }, {
    path: "launch-path",
    keep: "override",
  }, "win32"), {
    PATH: "launch-path",
    keep: "override",
  });
});

test("test browser launches get unique Crashpad directories and preserve launch environment/options", async () => {
  const { root, artifactsDir } = await makeArtifactsDirectory("test-browser-launch-unique-");
  const parentKey = "PDF_READER_LAUNCH_TEST_PARENT";
  const globalCrashpad = path.join(root, "global-crashpad");
  const previousParent = process.env[parentKey];
  const previousCrashpad = process.env.BREAKPAD_DUMP_LOCATION;
  await mkdir(globalCrashpad);
  await writeFile(path.join(globalCrashpad, "keep.txt"), "existing global dump data");
  process.env[parentKey] = "inherited-value";
  process.env.BREAKPAD_DUMP_LOCATION = globalCrashpad;

  try {
    const launchOptions = {
      executablePath: "/opt/fake/Chrome",
      headless: true,
      timeout: 12_345,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-crash-reporter-for-testing"],
      env: {
        [parentKey]: "options-value",
        PDF_READER_LAUNCH_TEST_OPTION: "explicit-option",
        BREAKPAD_DUMP_LOCATION: globalCrashpad,
      },
    };
    const originalOptionsEnv = { ...launchOptions.env };
    const received = [];
    let nextPid = 41001;
    const launcher = {
      async launch(options) {
        received.push(options);
        return fakeBrowser(nextPid++);
      },
    };

    const first = await launchTestBrowser(launcher, launchOptions, {
      testName: "offline smoke / preserve flags",
      artifactsDir,
      crashpadRoot: path.join(root, "crashpad-fixture"),
    });
    const second = await launchTestBrowser(launcher, launchOptions, {
      testName: "offline smoke / preserve flags",
      artifactsDir,
      crashpadRoot: path.join(root, "crashpad-fixture"),
    });
    const firstMetadata = getTestBrowserLaunchMetadata(first);
    const secondMetadata = getTestBrowserLaunchMetadata(second);

    assert.notEqual(firstMetadata.launchId, secondMetadata.launchId);
    assert.notEqual(firstMetadata.crashpadDirectory, secondMetadata.crashpadDirectory);
    assert.equal(firstMetadata.testName, "offline smoke / preserve flags");
    assert.equal(received.length, 2);
    for (const [index, options] of received.entries()) {
      const metadata = index === 0 ? firstMetadata : secondMetadata;
      assert.equal(options.env["PDF_READER_LAUNCH_TEST_PARENT"], "options-value");
      assert.equal(options.env.PDF_READER_LAUNCH_TEST_OPTION, "explicit-option");
      assert.equal(options.env.PATH, process.env.PATH);
      assert.equal(options.env.BREAKPAD_DUMP_LOCATION, metadata.crashpadDirectory);
      assert.notEqual(options.env.BREAKPAD_DUMP_LOCATION, globalCrashpad);
      assert.equal(options.executablePath, launchOptions.executablePath);
      assert.equal(options.headless, true);
      assert.equal(options.timeout, 12_345);
      assert.deepEqual(options.args, launchOptions.args);
      assert.notEqual(options.env, launchOptions.env);
      assert.equal(metadata.state, "launched");
      assert.equal(metadata.browserPid, 41001 + index);
      assert.equal(metadata.browserExecutable, "Chrome");
      assert.ok(metadata.recordPath.startsWith(`${artifactsDir}${path.sep}`));
      assert.ok(metadata.crashpadDirectory.startsWith(`${path.join(root, "crashpad-fixture")}${path.sep}`));
      assert.match(await readFile(metadata.ownerMarkerPath, "utf8"), /"launchId"/);
      assert.equal((await stat(metadata.crashpadDirectory)).isDirectory(), true);
      if (process.platform !== "win32") {
        assert.equal((await stat(metadata.crashpadDirectory)).mode & 0o777, 0o700);
      }
      assert.equal(await readFile(path.join(globalCrashpad, "keep.txt"), "utf8"), "existing global dump data");
    }
    assert.deepEqual(launchOptions.env, originalOptionsEnv);
    assert.equal(process.env.BREAKPAD_DUMP_LOCATION, globalCrashpad);

    const finalized = await finalizeTestBrowserLaunch(first, {
      status: "normal",
      browser: {
        status: "normal",
        closeState: "fulfilled",
        connectedAfterClose: false,
        process: { pid: firstMetadata.browserPid, exitCode: 0, signalCode: null },
      },
    });
    assert.equal(finalized.state, "closed-naturally");
    assert.equal(finalized.cleanupState, "closed-naturally");
    assert.equal((await stat(firstMetadata.crashpadDirectory)).isDirectory(), true);
    const records = await readLaunchRecords(firstMetadata.recordPath);
    assert.deepEqual(records.map((record) => record.state), [
      "launching",
      "launched",
      "closed-naturally",
    ]);
    assert.equal(JSON.stringify(records).includes("inherited-value"), false);
    assert.equal(JSON.stringify(records).includes("explicit-option"), false);
    const owner = JSON.parse(await readFile(firstMetadata.ownerMarkerPath, "utf8"));
    assert.equal(owner.crashpadDirectory, firstMetadata.crashpadDirectory);
    assert.equal(records[0].crashpadDirectory, firstMetadata.crashpadDirectory);
  } finally {
    if (previousParent === undefined) delete process.env[parentKey];
    else process.env[parentKey] = previousParent;
    if (previousCrashpad === undefined) delete process.env.BREAKPAD_DUMP_LOCATION;
    else process.env.BREAKPAD_DUMP_LOCATION = previousCrashpad;
    await rm(root, { recursive: true, force: true });
  }
});

test("failed launches retain a failure record and never touch an existing global Crashpad directory", async () => {
  const { root, artifactsDir } = await makeArtifactsDirectory("test-browser-launch-failure-");
  const globalCrashpad = path.join(root, "global-crashpad");
  await mkdir(globalCrashpad);
  await writeFile(path.join(globalCrashpad, "existing.dmp"), "preserve");
  const failure = new Error("controlled fake launcher failure");
  let receivedOptions;

  try {
    await assert.rejects(
      launchTestBrowser({
        async launch(options) {
          receivedOptions = options;
          throw failure;
        },
      }, {
        executablePath: "/opt/fake/Chrome",
        args: ["--enable-crash-reporter-for-testing"],
        env: { BREAKPAD_DUMP_LOCATION: globalCrashpad },
      }, {
        testName: "failed launch",
        artifactsDir,
        crashpadRoot: path.join(root, "crashpad-fixture"),
      }),
      (error) => error === failure,
    );

    const crashpadDirectory = receivedOptions.env.BREAKPAD_DUMP_LOCATION;
    const metadata = failure.testBrowserLaunchMetadata;
    assert.ok(metadata);
    assert.equal(metadata.state, "launch-failed");
    assert.equal(metadata.crashpadDirectory, crashpadDirectory);
    assert.notEqual(crashpadDirectory, globalCrashpad);
    assert.ok(crashpadDirectory.startsWith(`${path.join(root, "crashpad-fixture")}${path.sep}`));
    assert.equal(await readFile(path.join(globalCrashpad, "existing.dmp"), "utf8"), "preserve");
    assert.match(await readFile(metadata.ownerMarkerPath, "utf8"), /"launchId"/);
    assert.equal((await stat(crashpadDirectory)).isDirectory(), true);
    const records = await readLaunchRecords(metadata.recordPath);
    assert.deepEqual(records.map((record) => record.state), ["launching", "launch-failed"]);
    assert.equal(records.at(-1).failureStage, "puppeteer-launch");
    assert.equal(JSON.stringify(records).includes("BREAKPAD_DUMP_LOCATION"), false);
    assert.equal(JSON.stringify(records).includes("controlled fake launcher failure"), true);
    const launchDirectory = path.dirname(metadata.ownerMarkerPath);
    assert.equal(path.dirname(metadata.recordPath), launchDirectory);
    assert.ok(launchDirectory.startsWith(`${artifactsDir}${path.sep}`));
    assert.ok(crashpadDirectory.startsWith(`${path.join(root, "crashpad-fixture")}${path.sep}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a success-record write failure returns the Browser with failed metadata for cleanup", async () => {
  const { root, artifactsDir } = await makeArtifactsDirectory("test-browser-launch-record-failure-");
  const browser = fakeBrowser(42001);

  try {
    const launched = await launchTestBrowser({
      async launch(options) {
        assert.ok(options.env.BREAKPAD_DUMP_LOCATION.startsWith(`${path.join(root, "crashpad-fixture")}${path.sep}`));
        const [launchDirectory] = await readdir(artifactsDir);
        assert.ok(launchDirectory.startsWith("browser-launch-"));
        const recordPath = path.join(artifactsDir, launchDirectory, "launch-record.jsonl");
        await rm(recordPath);
        await mkdir(recordPath);
        return browser;
      },
    }, {
      executablePath: "/opt/fake/Chrome",
      args: ["--no-sandbox"],
    }, {
      testName: "record failure",
      artifactsDir,
      crashpadRoot: path.join(root, "crashpad-fixture"),
    });

    assert.equal(launched, browser, "A record-write failure must not hide the launched Browser from cleanup");
    const metadata = getTestBrowserLaunchMetadata(browser);
    assert.equal(metadata.state, "record-write-failed");
    assert.ok(metadata.recordErrors.some((entry) => entry.stage === "record-launched"));
    assert.match(await readFile(metadata.ownerMarkerPath, "utf8"), /"launchId"/);
    assert.equal((await stat(metadata.crashpadDirectory)).isDirectory(), true);

    const finalized = await finalizeTestBrowserLaunch(browser, {
      status: "normal",
      browser: {
        status: "normal",
        connectedAfterClose: false,
        process: { pid: 42001, exitCode: 0, signalCode: null },
      },
    });
    assert.equal(finalized.state, "record-write-failed");
    assert.equal(finalized.cleanupState, "closed-naturally");
    assert.ok(finalized.recordErrors.length > 0);
    assert.notEqual(finalized.state, "closed-naturally");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default Crashpad databases are allocated under the system temp directory", async () => {
  const { root, artifactsDir } = await makeArtifactsDirectory("test-browser-launch-default-temp-");
  let metadata;

  try {
    const browser = await launchTestBrowser({
      async launch() {
        return fakeBrowser(42501);
      },
    }, {
      executablePath: "/opt/fake/Chrome",
    }, {
      testName: "default Crashpad root",
      artifactsDir,
    });
    metadata = getTestBrowserLaunchMetadata(browser);

    assert.ok(metadata.crashpadDirectory.startsWith(`${path.join(os.tmpdir(), "pdf-reader-crashpad-")}`));
    assert.ok(metadata.recordPath.startsWith(`${artifactsDir}${path.sep}`));
    assert.equal((await stat(metadata.crashpadDirectory)).isDirectory(), true);
    if (process.platform !== "win32") {
      assert.equal((await stat(metadata.crashpadDirectory)).mode & 0o777, 0o700);
    }
    const records = await readLaunchRecords(metadata.recordPath);
    assert.equal(records[0].crashpadDirectory, metadata.crashpadDirectory);
  } finally {
    if (metadata?.crashpadDirectory) {
      await rm(metadata.crashpadDirectory, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Crashpad setup failures leave a durable artifact record without launching", async () => {
  const { root, artifactsDir } = await makeArtifactsDirectory("test-browser-launch-crashpad-setup-failure-");
  const blockedCrashpadRoot = path.join(root, "not-a-directory");
  await writeFile(blockedCrashpadRoot, "file blocks temp directory creation");
  let launchCalls = 0;
  let metadata;

  try {
    await assert.rejects(
      launchTestBrowser({
        async launch() {
          launchCalls += 1;
          return fakeBrowser(42701);
        },
      }, {}, {
        testName: "Crashpad setup failure",
        artifactsDir,
        crashpadRoot: blockedCrashpadRoot,
      }),
      (error) => {
        metadata = error.testBrowserLaunchMetadata;
        return Boolean(metadata);
      },
    );

    assert.equal(launchCalls, 0);
    assert.equal(metadata.state, "launch-failed");
    assert.equal(metadata.crashpadDirectory, null);
    assert.ok(metadata.ownerMarkerPath.startsWith(`${artifactsDir}${path.sep}`));
    assert.match(await readFile(metadata.ownerMarkerPath, "utf8"), /"launchId"/);
    const records = await readLaunchRecords(metadata.recordPath);
    assert.equal(records.length, 1);
    assert.equal(records[0].state, "launch-failed");
    assert.equal(records[0].failureStage, "prepare-crashpad-directory");
    assert.match(records[0].error.message, /not-a-directory|ENOTDIR|EEXIST/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launch artifact setup failures do not call the launcher", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-browser-launch-no-artifacts-"));
  const blockedArtifactsPath = path.join(root, "not-a-directory");
  await writeFile(blockedArtifactsPath, "file blocks mkdir");
  let launchCalls = 0;

  try {
    await assert.rejects(
      launchTestBrowser({
        async launch() {
          launchCalls += 1;
          return fakeBrowser(43001);
        },
      }, {}, { artifactsDir: blockedArtifactsPath }),
    );
    assert.equal(launchCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
