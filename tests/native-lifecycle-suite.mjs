import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobile = process.env.PDF_READER_NATIVE_MOBILE === '1';
const runStamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
const artifacts = path.join(root, 'tests', 'artifacts');
const lifecycle = path.join(root, 'tests', 'native-macos-lifecycle.mjs');
const logPrefix = `native-${mobile ? 'mobile' : 'desktop'}-suite-${runStamp}`;
const aggregatePath = path.join(artifacts, `${logPrefix}-aggregate.json`);
const cdpUrl = 'http://127.0.0.1:9226';
const vault = '/Users/jiajia/Documents/ObReader-Apple-Test';
const configDir = '.obsidian';
const pluginId = 'pdf-web-reader';
const viewType = 'pdf-web-reader-view';
const appUrl = 'app://obsidian.md/index.html';
const expected = JSON.parse(await readFile(process.env.PDF_READER_NATIVE_IDENTITY_FILE, 'utf8'));
const allCases = [
  'manual-save', 'autosave', 'inflight', 'rename', 'stale', 'external-conflict',
  'failed-save', 'close-flush', 'close-recovery', 'close-recovery-write-failure',
  'switch', 'matrix', 'eraser', 'tool-wheel', 'freetext-focus', 'freetext-undo',
  'popout', 'popout-close', 'popout-move',
];
const cases = mobile ? allCases.filter(name => !name.startsWith('popout')) : allCases;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const timestamp = () => new Date().toISOString();
const aggregate = {
  schemaVersion: 1,
  task: `Identity-guarded ${mobile ? 'desktop mobile-emulation' : 'desktop'} suite; one group per process, sequential`,
  mobileEmulation: mobile,
  physicalIpadValidated: false,
  status: 'not-started',
  createdAt: timestamp(),
  candidate: { expectedSha256: expected, observedSha256: {}, installedSha256: null },
  harness: { expectedSha256: expected.harness, observedSha256: null, staticAuditStatus: 'must be confirmed by parent before running' },
  execution: {
    cdpUrl, vault, configDir, pluginId,
    groupOrder: cases,
    plannedGroups: cases.length,
    executedGroups: 0,
    passedGroups: 0,
    failedGroups: 0,
    preflightBlockedGroups: 0,
    naturalProcessExits: 0,
    groups: [],
  },
  finalHandoff: null,
  fixtureCleanup: { status: 'not-run', reportOwnedPaths: [] },
};

async function persist() {
  await mkdir(artifacts, { recursive: true });
  await writeFile(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`);
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function hashCandidate() {
  const rootFiles = path.join(root, 'dist', 'pdf-web-reader');
  const installed = path.join(vault, configDir, 'plugins', pluginId);
  const built = {};
  const inVault = {};
  for (const name of ['main.js', 'manifest.json', 'styles.css']) {
    const a = await readFile(path.join(rootFiles, name));
    const b = await readFile(path.join(installed, name));
    built[name] = { bytes: a.byteLength, sha256: sha256(a) };
    inVault[name] = { bytes: b.byteLength, sha256: sha256(b), matchesDist: sha256(a) === sha256(b) };
  }
  const bridgeSource = await readFile(path.join(root, 'viewer-adapter', 'obsidian-bridge.js'));
  aggregate.candidate.observedSha256 = built;
  aggregate.candidate.observedSha256.bridgeSource = { bytes: bridgeSource.byteLength, sha256: sha256(bridgeSource) };
  aggregate.candidate.installedSha256 = inVault;
  aggregate.harness.observedSha256 = sha256(await readFile(lifecycle));
  assert.equal(built['main.js'].sha256, expected.productMain);
  assert.equal(built['manifest.json'].sha256, expected.manifest);
  assert.equal(built['styles.css'].sha256, expected.styles);
  assert.equal(sha256(bridgeSource), expected.bridge);
  assert.equal(inVault['main.js'].sha256, expected.productMain);
  assert.equal(inVault['manifest.json'].sha256, expected.manifest);
  assert.equal(inVault['styles.css'].sha256, expected.styles);
  assert.equal(aggregate.harness.observedSha256, expected.harness, 'Frozen native harness SHA changed; wait for updated parent instruction.');
}
async function initialPreflight() {
  const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null, protocolTimeout: 15_000 });
  try {
    const appPages = (await browser.pages()).filter((page) => page.url() === appUrl);
    const pageTargets = browser.targets().filter((target) => target.type() === 'page').map((target) => ({ url: target.url() }));
    assert.equal(appPages.length, 1, 'Require exactly one app page before the first lifecycle case.');
    assert.equal(pageTargets.length, 1, 'Refuse to run while any additional page/popout target exists.');
    const state = await appPages[0].evaluate((id, type) => {
      const plugin = app.plugins?.plugins?.[id];
      const leaves = [];
      app.workspace?.iterateAllLeaves?.((leaf) => leaves.push(leaf));
      return {
        identity: { vault: app.vault?.adapter?.basePath || null, configDir: app.vault?.configDir || null, vaultName: app.vault?.getName?.() || null },
        pluginEnabled: app.plugins?.enabledPlugins?.has(id) === true,
        autoSave: plugin?.settings?.autoSave ?? null,
        readers: app.workspace?.getLeavesOfType?.(type)?.map((leaf) => ({ path: leaf.view?.requestedPath || leaf.view?.file?.path || null })) || [],
        allReaderCount: leaves.filter((leaf) => leaf?.view?.getViewType?.() === type).length,
        pluginViewCount: plugin?.views?.size ?? null,
        gates: [...(plugin?.popoutCloseGates?.values?.() || [])].map((gate) => ({ active: gate.active === true, views: gate.views?.size ?? null, liveViews: plugin.popoutViewsForGate?.(gate)?.length ?? null })),
      };
    }, pluginId, viewType);
    assert.deepEqual(state.identity, { vault, configDir, vaultName: 'ObReader-Apple-Test' });
    assert.equal(state.pluginEnabled, true);
    assert.equal(state.autoSave, true);
    assert.deepEqual(state.readers, []);
    assert.equal(state.allReaderCount, 0);
    assert.equal(state.pluginViewCount, 0);
    assert.deepEqual(state.gates, []);
    const result = { checkedAt: timestamp(), identity: state.identity, pluginEnabled: state.pluginEnabled, autoSave: state.autoSave, readers: state.readers, allReaderCount: state.allReaderCount, pluginViewCount: state.pluginViewCount, gates: state.gates, pageTargets };
    await browser.disconnect();
    return result;
  } catch (error) {
    await browser.disconnect().catch(() => {});
    throw error;
  }
}
async function findReport(output, before) {
  const fromOutput = output.match(/^Result:\s*(.+)$/m)?.[1]?.trim();
  if (fromOutput) return path.resolve(fromOutput);
  const after = await readdir(artifacts);
  const candidates = after.filter((name) => /^native-macos-lifecycle-\d+\.json$/.test(name) && !before.has(name));
  if (!candidates.length) return null;
  candidates.sort();
  return path.join(artifacts, candidates.at(-1));
}
async function runCase(name, index) {
  const startedAt = timestamp();
  const before = new Set((await readdir(artifacts)).filter((file) => /^native-macos-lifecycle-\d+\.json$/.test(file)));
  const logPath = path.join(artifacts, `${logPrefix}-${String(index + 1).padStart(2, '0')}-${name}.log`);
  const env = {
    ...process.env,
    PDF_READER_CDP_URL: cdpUrl,
    OBSIDIAN_VAULT_PATH: vault,
    OBSIDIAN_VAULT_NAME: 'ObReader-Apple-Test',
    OBSIDIAN_CONFIG_DIR: configDir,
    PDF_READER_NATIVE_CASES: name,
    PDF_READER_NATIVE_BUILD_SHA: expected.productMain,
  };
  await mkdir(artifacts, { recursive: true });
  const log = await import('node:fs').then(({ createWriteStream }) => createWriteStream(logPath, { flags: 'w' }));
  const child = spawn(process.execPath, [lifecycle], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  child.stdout.on('data', (chunk) => { log.write(chunk); tail = (tail + chunk.toString()).slice(-50_000); });
  child.stderr.on('data', (chunk) => { log.write(chunk); tail = (tail + chunk.toString()).slice(-50_000); });
  console.log(`[start ${index + 1}/${cases.length}] ${name}`);
  const outcome = await new Promise((resolve) => {
    let timedOut = false;
    let escalation;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 10_000);
      escalation.unref?.();
    }, 15 * 60_000);
    timer.unref?.();
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      resolve({ exitCode, signal, timedOut });
    });
  });
  log.end();
  await new Promise((resolve) => log.once('close', resolve));
  const reportPath = await findReport(tail, before);
  let report = null;
  let reportReadError = null;
  if (reportPath) {
    try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
    catch (error) { reportReadError = String(error); }
  }
  const executed = report?.executedCases?.includes(name) === true;
  const completed = report?.completedCases?.includes(name) === true;
  const expectedReportHash = report?.preflight?.installedPluginMainSha256 || null;
  const modeCheck = await readModeCheck();
  const naturalExit = outcome.signal == null && Number.isInteger(outcome.exitCode);
  const row = {
    modeCheck,
    caseName: name,
    index: index + 1,
    startedAt,
    finishedAt: timestamp(),
    child: { ...outcome, naturalExit },
    log: path.relative(root, logPath),
    report: reportPath ? path.relative(root, reportPath) : null,
    reportReadError,
    reportStatus: report?.status || null,
    selectedCases: report?.caseSelection?.selected || [],
    executedCases: report?.executedCases || [],
    completedCases: report?.completedCases || [],
    executed,
    completed,
    candidateMainSha256: expectedReportHash,
    cleanupErrors: report?.cleanupErrors || [],
    autoSaveRestored: report?.autoSaveRestored ?? null,
    popoutEvidence: {
      automaticViewCleanup: report?.checks?.popoutAutomaticViewCleanup || [],
      windowCleanup: report?.checks?.popoutWindowCleanup || [],
      nativeCloseAttempts: report?.checks?.nativePopoutCloseAttempts || [],
      closeLifecycle: report?.checks?.popoutWindowCloseLifecycle || null,
    },
      freeTextUndoEvidence: report?.checks?.nativeFreeTextUndoVisualRecovery || null,
    matrixEvidence: report?.checks?.nativeEditorViewerMatrix || null,
    testPrefix: report?.testPrefix || null,
    testFiles: report?.testFiles || [],
    focusEmulationRestored: report?.visibilityEmulation?.ownerWindows?.every((owner) => owner.enabled === false) ?? null,
  };
  aggregate.execution.groups.push(row);
  aggregate.execution.executedGroups = aggregate.execution.groups.filter((item) => item.executed).length;
  aggregate.execution.passedGroups = aggregate.execution.groups.filter((item) => item.completed && item.reportStatus === 'passed' && item.child.naturalExit && item.child.exitCode === 0 && item.candidateMainSha256 === expected.productMain && item.modeCheck.valid).length;
  aggregate.execution.failedGroups = aggregate.execution.groups.filter((item) => item.executed && !(item.completed && item.reportStatus === 'passed' && item.child.naturalExit && item.child.exitCode === 0 && item.candidateMainSha256 === expected.productMain && item.modeCheck.valid)).length;
  aggregate.execution.preflightBlockedGroups = aggregate.execution.groups.filter((item) => !item.executed).length;
  aggregate.execution.naturalProcessExits = aggregate.execution.groups.filter((item) => item.child.naturalExit).length;
  aggregate.status = 'running';
  await persist();
  console.log(`[exit ${index + 1}/${cases.length}] ${name}: child=${outcome.exitCode ?? outcome.signal}, report=${row.reportStatus || 'missing'}, executed=${executed}, completed=${completed}`);
  if (outcome.timedOut) {
    aggregate.status = 'interrupted-after-timeout';
    aggregate.execution.notRunAfterTimeout = cases.slice(index + 1);
    await persist();
    return false;
  }
  return true;
}
async function finalReadOnlyHandoff() {
  const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null, protocolTimeout: 15_000 });
  try {
    const pages = (await browser.pages()).filter((page) => page.url() === appUrl);
    const rows = [];
    for (const page of pages) {
      const row = await page.evaluate((id, type) => {
        const plugin = app.plugins?.plugins?.[id];
        const allLeaves = [];
        app.workspace?.iterateAllLeaves?.((leaf) => allLeaves.push(leaf));
        return {
          identity: { vault: app.vault?.adapter?.basePath || null, configDir: app.vault?.configDir || null, vaultName: app.vault?.getName?.() || null },
          pluginEnabled: app.plugins?.enabledPlugins?.has(id) === true,
          autoSave: plugin?.settings?.autoSave ?? null,
          readers: app.workspace?.getLeavesOfType?.(type)?.map((leaf) => ({ leafId: leaf.id, path: leaf.view?.requestedPath || leaf.view?.file?.path || null })) || [],
          allReaderCount: allLeaves.filter((leaf) => leaf?.view?.getViewType?.() === type).length,
          pluginViews: [...(plugin?.views || [])].map((view) => ({ path: view.requestedPath || view.documentFile?.path || null, teardownStarted: view.teardownStarted === true })),
          gates: [...(plugin?.popoutCloseGates?.values?.() || [])].map((gate) => ({ active: gate.active === true, views: gate.views?.size ?? null, liveViews: plugin.popoutViewsForGate?.(gate)?.length ?? null, closePromise: !!gate.closePromise })),
          title: document.title,
          visibility: document.visibilityState,
          hasFocus: document.hasFocus(),
        };
      }, pluginId, viewType);
      rows.push(row);
    }
    const targets = browser.targets().filter((target) => target.type() === 'page').map((target) => ({ targetId: target._targetInfo?.targetId || target._targetId || null, url: target.url() }));
    return {
      checkedAt: timestamp(),
      appPageCount: pages.length,
      appRows: rows,
      pageTargets: targets,
      exactTestVaultPageCount: rows.filter((row) => row.identity?.vault === vault && row.identity?.configDir === configDir).length,
      noOtherPageTargets: targets.length === 1,
      allReaderViewsEmpty: rows.every((row) => row.identity?.vault !== vault || (row.readers.length === 0 && row.allReaderCount === 0)),
      allPluginViewsEmpty: rows.every((row) => row.identity?.vault !== vault || row.pluginViews.length === 0),
      allGatesEmpty: rows.every((row) => row.identity?.vault !== vault || row.gates.length === 0),
      autoSaveTrue: rows.every((row) => row.identity?.vault !== vault || row.autoSave === true),
      pluginEnabled: rows.every((row) => row.identity?.vault !== vault || row.pluginEnabled === true),
      focusEmulation: 'Each lifecycle process disables its per-window CDP focus emulation in finally; this field records renderer visibility/focus only and makes no OS foreground claim.',
      networkBlocking: 'No network blocking is performed by the lifecycle runner.',
      cdpDisconnectedAfterRead: true,
    };
  } finally {
    await browser.disconnect().catch(() => {});
  }
}
async function safeExactFixtureCleanup() {
  const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null, protocolTimeout: 15_000 });
  try {
    const pages = (await browser.pages()).filter((page) => [appUrl, 'about:blank'].includes(page.url()));
    assert.equal(pages.length, 1, 'Refuse fixture cleanup unless exactly one Obsidian app target exists and no popout remains.');
    const page = pages[0];
    assert.equal(page.url(), appUrl, 'Refuse cleanup unless the sole app target is the main Obsidian page.');
    const preflight = await page.evaluate((id, type) => {
      const plugin = app.plugins?.plugins?.[id];
      const readers = app.workspace?.getLeavesOfType?.(type) || [];
      const allLeaves = [];
      app.workspace?.iterateAllLeaves?.((leaf) => allLeaves.push(leaf));
      return {
        identity: { vault: app.vault?.adapter?.basePath || null, configDir: app.vault?.configDir || null, vaultName: app.vault?.getName?.() || null },
        pluginEnabled: app.plugins?.enabledPlugins?.has(id) === true,
        autoSave: plugin?.settings?.autoSave ?? null,
        readers: readers.map((leaf) => ({ leafId: leaf.id, path: leaf.view?.requestedPath || leaf.view?.file?.path || null })),
        allReaderCount: allLeaves.filter((leaf) => leaf?.view?.getViewType?.() === type).length,
        pluginViews: [...(plugin?.views || [])].map((view) => ({ path: view.requestedPath || view.documentFile?.path || null, teardownStarted: view.teardownStarted === true })),
        gates: [...(plugin?.popoutCloseGates?.values?.() || [])].map((gate) => ({ active: gate.active === true, views: gate.views?.size ?? null, liveViews: plugin.popoutViewsForGate?.(gate)?.length ?? null })),
      };
    }, pluginId, viewType);
    assert.deepEqual(preflight.identity, { vault, configDir, vaultName: 'ObReader-Apple-Test' });
    assert.equal(preflight.pluginEnabled, true);
    assert.equal(preflight.autoSave, true);
    assert.deepEqual(preflight.readers, [], 'Do not delete fixtures while any Reader is open.');
    assert.equal(preflight.allReaderCount, 0);
    assert.deepEqual(preflight.pluginViews, [], 'Do not hide an automatic unregister failure by cleaning fixtures.');
    assert.deepEqual(preflight.gates, []);

    const rowsForCleanup = [];
    const prefixes = [];
    for (const row of aggregate.execution.groups) {
      if (!row.report) continue;
      const parsed = JSON.parse(await readFile(path.join(root, row.report), 'utf8'));
      const testPrefix = parsed.testPrefix;
      if (typeof testPrefix !== 'string' || !/^PDF迁移测试\/native-macos-lifecycle-\d+$/.test(testPrefix)) continue;
      prefixes.push(testPrefix);
      for (const value of parsed.testFiles || []) {
        if (typeof value !== 'string' || !value.startsWith(`${testPrefix}/`) || !value.endsWith('.pdf') || value.includes('..') || value.includes('\\')) continue;
        rowsForCleanup.push({ prefix: testPrefix, path: value, caseName: row.caseName });
      }
    }
    const uniqueFiles = [...new Map(rowsForCleanup.map((item) => [item.path, item])).values()];
    const uniquePrefixes = [...new Set(prefixes)];
    const cleanup = await page.evaluate(async ({ id, expectedVault, expectedConfig, files, prefixes }) => {
      if (app.vault?.adapter?.basePath !== expectedVault || app.vault?.configDir !== expectedConfig) throw new Error('Vault identity changed before fixture cleanup.');
      const plugin = app.plugins?.plugins?.[id];
      const readers = app.workspace?.getLeavesOfType?.('pdf-web-reader-view') || [];
      if (readers.length || plugin?.views?.size || plugin?.popoutCloseGates?.size) throw new Error('Reader/view/gate became live before exact fixture cleanup.');
      const deleted = [];
      const missing = [];
      for (const row of files) {
        const file = app.vault.getAbstractFileByPath(row.path);
        if (!file) { missing.push(row.path); continue; }
        await app.vault.delete(file, true);
        deleted.push(row.path);
      }
      const directories = [];
      for (const prefix of prefixes) {
        try {
          const listing = await app.vault.adapter.list(prefix);
          if ((listing.files || []).length === 0 && (listing.folders || []).length === 0) {
            await app.vault.adapter.rmdir(prefix, true);
            directories.push({ path: prefix, status: 'removed-empty-directory' });
          } else {
            directories.push({ path: prefix, status: 'preserved-nonempty', listing });
          }
        } catch (error) {
          directories.push({ path: prefix, status: 'preserved-or-missing', error: error?.message || String(error) });
        }
      }
      return { deleted, missing, directories, recoveryFoldersTouched: false };
    }, { id: pluginId, expectedVault: vault, expectedConfig: configDir, files: uniqueFiles, prefixes: uniquePrefixes });
    const after = await page.evaluate((id, type) => {
      const plugin = app.plugins?.plugins?.[id];
      return {
        identity: { vault: app.vault?.adapter?.basePath || null, configDir: app.vault?.configDir || null, vaultName: app.vault?.getName?.() || null },
        pluginEnabled: app.plugins?.enabledPlugins?.has(id) === true,
        autoSave: plugin?.settings?.autoSave ?? null,
        readers: app.workspace?.getLeavesOfType?.(type)?.length ?? null,
        pluginViews: plugin?.views?.size ?? null,
        gates: plugin?.popoutCloseGates?.size ?? null,
      };
    }, pluginId, viewType);
    const reportPaths = aggregate.execution.groups.map((row) => row.report).filter(Boolean);
    return {
      status: 'passed',
      preflight,
      uniqueOwnedPdfCount: uniqueFiles.length,
      uniqueRunPrefixCount: uniquePrefixes.length,
      cleanup,
      after,
      preservedRecoveryArtifacts: true,
      preservedNonEmptyRunDirectories: cleanup.directories.filter((row) => row.status === 'preserved-nonempty'),
      referencedPerCaseReports: reportPaths,
    };
  } finally {
    await browser.disconnect().catch(() => {});
  }
}

assert.equal(process.platform, 'darwin');
assert.equal(cdpUrl, 'http://127.0.0.1:9226');
assert.equal(cases.length, mobile ? 16 : 19);
assert.equal(process.env.PDF_READER_NATIVE_RUN_CONFIRMED, 'yes', 'Only run after the parent authorizes execution.');
assert.equal(process.env.PDF_READER_NATIVE_STATIC_AUDIT_CONFIRMED, 'yes', 'Only run after the parent confirms the frozen harness audit has no blockers.');
aggregate.harness.staticAuditStatus = 'passed: parent confirmed no static-audit blocker before execution';
await hashCandidate();
aggregate.initialPreflight = await initialPreflight();
await persist();
let previousMode = null;
try {
  previousMode = await withPage(p => p.evaluate(() => ({isMobile:!!app.isMobile})));
  aggregate.modePreparation = await prepareMode(mobile);
for (let index = 0; index < cases.length; index += 1) {
  const keepGoing = await runCase(cases[index], index);
  if (!keepGoing) break;
}
if (aggregate.execution.groups.length === cases.length) {
  aggregate.fixtureCleanup = await safeExactFixtureCleanup().catch((error) => ({ status: 'refused-or-failed', error: error?.stack || String(error) }));
  aggregate.finalHandoff = await finalReadOnlyHandoff().catch((error) => ({ status: 'read-failed', error: error?.stack || String(error) }));
  const allPassed = aggregate.execution.groups.length === cases.length &&
    aggregate.execution.passedGroups === cases.length && aggregate.execution.preflightBlockedGroups === 0 &&
    aggregate.finalHandoff?.allReaderViewsEmpty && aggregate.finalHandoff?.allPluginViewsEmpty &&
      aggregate.finalHandoff?.allGatesEmpty && aggregate.finalHandoff?.autoSaveTrue &&
    aggregate.finalHandoff?.pluginEnabled && aggregate.finalHandoff?.noOtherPageTargets &&
      aggregate.finalHandoff?.exactTestVaultPageCount === 1 &&
    aggregate.fixtureCleanup?.status === 'passed';
  aggregate.status = allPassed ? 'passed' : 'incomplete';
} else if (!aggregate.status.startsWith('interrupted')) {
  aggregate.status = 'incomplete';
}
} catch (error) {
  aggregate.status = 'failed';
  aggregate.error = error?.stack || String(error);
} finally {
  if (previousMode) aggregate.modeRestoration = await restoreMode(previousMode).catch(error => ({restored:false,error:error?.stack || String(error)}));
}
if (aggregate.modeRestoration?.restored !== true) aggregate.status = 'incomplete';
aggregate.finishedAt = timestamp();
await persist();
console.log(`Aggregate: ${aggregatePath}`);
console.log(`Status: ${aggregate.status} (${aggregate.execution.passedGroups}/${cases.length} passed, ${aggregate.execution.executedGroups}/${cases.length} entered)`);
if(aggregate.status !== 'passed') process.exitCode = 1;

async function withPage(action) {
  const browser = await puppeteer.connect({browserURL: cdpUrl, defaultViewport: null, protocolTimeout: 30_000});
  try {
    const pages = (await browser.pages()).filter(p => p.url() === appUrl);
    assert.equal(pages.length,1);
    const page = pages[0];
    const readyDeadline=Date.now()+60_000;
    let ready=false;
    while(Date.now()<readyDeadline) {
      try {ready=await page.evaluate(()=>!!(globalThis.app?.vault?.adapter && globalThis.app?.plugins && globalThis.app?.workspace?.layoutReady));}
      catch(error) {if(!/Execution context was destroyed|Cannot find context with specified id/.test(error?.message||'')) throw error;}
      if(ready) break;
      await delay(250);
    }
    assert.equal(ready,true,'Obsidian app did not finish initializing in its main realm');
    const id = await page.evaluate(() => ({vault:app.vault.adapter.basePath,configDir:app.vault.configDir}));
    assert.deepEqual(id,{vault,configDir});
    return await action(page);
  } finally { await browser.disconnect(); }
}
async function readModeCheck() {
  const state = await withPage(p => p.evaluate(() => ({appMobile:!!app.isMobile, pluginMobile:!!app.plugins.plugins['pdf-web-reader']?.isMobileRuntime})));
  return {...state, expectedMobile:mobile, valid:state.appMobile===mobile && state.pluginMobile===mobile};
}
async function prepareMode(wanted) {
  return transitionMode(wanted);
}
async function restoreMode(old) {
  return transitionMode(old.isMobile);
}
async function transitionMode(wanted) {
  const before = await withPage(p => p.evaluate(async () => {
    const id='pdf-web-reader', plugin=app.plugins.plugins[id];
    if(app.workspace.getLeavesOfType('pdf-web-reader-view').length || plugin?.views?.size || plugin?.popoutCloseGates?.size) throw Error('Live Reader/view/gate; refuse mode change');
    const old={isMobile:!!app.isMobile};
    if(app.plugins.enabledPlugins.has(id)) await app.plugins.disablePluginAndSave(id);
    return old;
  }));
  let navigationObserved = false;
  if(before.isMobile !== wanted) {
    const nonce = `pdf-reader-mode-${Date.now()}-${Math.random()}`;
    await withPage(async p => {
      await p.evaluate(nonce => {globalThis.__pdfReaderTestModeNonce=nonce;},nonce);
      // emulateMobile reloads Obsidian. Do not keep using app from the old realm.
      try { await p.evaluate(wanted => app.emulateMobile(wanted), wanted); }
      catch(error) {
        if(!/Execution context was destroyed|Cannot find context with specified id/.test(error?.message || '')) {
          throw error;
        }
      }
    });
    // Electron's app:// reload may not deliver Puppeteer's navigation lifecycle.
    // A fresh session must observe a new realm and a fully initialized exact vault.
    const deadline=Date.now()+60_000;
    while(Date.now()<deadline) {
      try {
        navigationObserved=await withPage(p=>p.evaluate(({nonce,wanted})=>
          globalThis.__pdfReaderTestModeNonce!==nonce && !!app.isMobile===wanted,{nonce,wanted}));
        if(navigationObserved) break;
      } catch(error) {
        if(!/Execution context was destroyed|Cannot find context with specified id|Waiting failed|timeout|Timed out/i.test(error?.message || '')) throw error;
      }
      await delay(250);
    }
    assert.equal(navigationObserved,true,'Mode transition did not initialize a new exact-vault realm');
  }
  const after = await withPage(p => p.evaluate(async wanted => {
    const id='pdf-web-reader', current=app.plugins.plugins[id];
    if(app.workspace.getLeavesOfType('pdf-web-reader-view').length || current?.views?.size || current?.popoutCloseGates?.size) throw Error('Live Reader/view/gate after mode navigation');
    if(!!app.isMobile !== wanted) throw Error('Application mobile mode did not match requested mode');
    if(!app.plugins.enabledPlugins.has(id)) await app.plugins.enablePluginAndSave(id);
    const plugin=app.plugins.plugins[id];
    if(!!plugin?.isMobileRuntime!==wanted || plugin?.settings?.autoSave !== true) throw Error('Reloaded plugin mode or auto-save mismatch');
    return {restored:true,appMobile:!!app.isMobile,pluginMobile:!!plugin.isMobileRuntime};
  },wanted));
  return {...after,previousMode:before.isMobile,navigationObserved};
}
