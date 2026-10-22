import assert from 'node:assert/strict';

// Called only inside the real Viewer browser harness. This flow has no seeded
// Vocabulary, Context or Review rows and uses the production Host methods.
export async function runLearningContextBrowserFlow({ page, frame, methodSource, sourceHash }) {
  await page.evaluate(methodSource => window.__learningBrowser.enableRealVocabulary({ methodSource,
    fingerprint: bytes => window.__learningFingerprint(Array.from(bytes)) }), methodSource);
  await frame.waitForFunction(() => window.__pdfReaderBridgeState.vocabularyEnabled &&
    PDFViewerApplication.pdfViewer.annotationEditorMode === 0, { timeout: 10_000 });
  const geometry = await frame.evaluate(() => {
    const span = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')]
      .find(node => /Dynamic languages/.test(node.textContent));
    const node = span?.firstChild;
    if (node?.nodeType !== Node.TEXT_NODE) throw Error('Actual PDF Dynamic languages text is required');
    const start = node.textContent.indexOf('Dynamic');
    const word = document.createRange(); word.setStart(node, start); word.setEnd(node, start + 7);
    const line = document.createRange(); line.setStart(node, start); line.setEnd(node, node.textContent.length);
    const a = word.getBoundingClientRect(), b = line.getBoundingClientRect();
    return { word: { x: a.x + a.width / 2, y: a.y + a.height / 2 },
      line: { x: b.x + 1, endX: b.right - 1, y: b.y + b.height / 2 } };
  });
  const offset = await page.$eval('iframe', node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  await page.mouse.click(offset.x + geometry.word.x, offset.y + geometry.word.y);
  await frame.waitForSelector('.pdfReaderVocabularyPill[data-key="dynamic"]', { timeout: 10_000 });
  await frame.click('.pdfReaderVocabularyPill button[data-status="2"]');
  await page.waitForFunction(async () => (await window.__learningBrowser.personalService.getTerm('dynamic'))?.status === 2 ||
    window.__learningBrowser.errors.length, { timeout: 10_000 });
  assert.deepEqual(await page.evaluate(() => window.__learningBrowser.errors), []);
  await page.mouse.move(offset.x + geometry.line.x, offset.y + geometry.line.y);
  await page.mouse.down();
  await page.mouse.move(offset.x + geometry.line.endX, offset.y + geometry.line.y, { steps: 12 });
  await page.mouse.up();
  const selected = await frame.evaluate(() => getSelection().toString());
  assert.match(selected, /Dynamic languages/);
  await frame.click('.pdfReaderVocabularyContextCapture');
  await frame.waitForSelector('.pdfReaderVocabularyContextConfirm:not([hidden])', { timeout: 10_000 });
  assert.equal(await frame.$eval('.pdfReaderVocabularyContextPreview', node => node.value), selected);
  await frame.click('.pdfReaderVocabularyContextConfirm');
  await page.waitForFunction(async () => {
    const state = window.__learningBrowser, family = await state.personalService.getFamily('dynamic');
    return (await state.vocabularyRuntime.contexts.listFamily(family.familyKey, { limit: 2 })).contexts.length === 1 || state.errors.length;
  }, { timeout: 10_000 });
  assert.deepEqual(await page.evaluate(() => window.__learningBrowser.errors), []);
  const context = await page.evaluate(async () => {
    const state = window.__learningBrowser, family = await state.personalService.getFamily('dynamic');
    return (await state.vocabularyRuntime.contexts.listFamily(family.familyKey, { limit: 2 })).contexts[0];
  });
  assert.equal(context.sentence, selected);
  assert.equal(context.sourceFingerprint, sourceHash);
  assert.ok(context.anchor.textPosition.end > context.anchor.textPosition.start);
  await page.evaluate(() => window.__learningBrowser.openVocabularyReview('vocabulary'));
  await page.waitForSelector('[data-action="select-family"]', { timeout: 10_000 });
  await page.click('[data-action="select-family"]');
  await page.click('[data-action="bulk-enroll"]');
  await page.waitForFunction(() => /已处理 1/.test(document.querySelector('.vocabulary-workbench__status')?.textContent), { timeout: 10_000 });
  await page.click('[data-action="tab-review"]');
  await page.waitForSelector('[data-role="review-row"][data-provider-id="vocabulary"]', { timeout: 10_000 });
  assert.equal(await page.$$eval('[data-role="review-row"][data-provider-id="learning"]', nodes => nodes.length), 1,
    'Today shows both the earlier Highlight learning item and real Vocabulary due state');
  await page.click('[data-role="review-row"][data-provider-id="vocabulary"] [data-action^="review-source-"]');
  await page.waitForFunction(id => window.__learningBrowser.opened.some(row => row.target.id === id), { timeout: 8_000 }, context.anchorId);
  await frame.waitForFunction(() => window.CSS?.highlights?.get('pdfReaderAnchorFocusText')?.size > 0, { timeout: 8_000 });
  assert.equal(await frame.evaluate(() => [...CSS.highlights.get('pdfReaderAnchorFocusText')].map(range => range.toString()).join('')), context.anchor.exactQuote);
  await page.evaluate(familyKey => window.__learningBrowser.openVocabularyReview('contexts', familyKey), context.familyKey);
  await page.waitForSelector('[data-action^="context-add-review-"]', { timeout: 10_000 });
  await page.click('[data-action^="context-add-review-"]');
  await page.waitForSelector('textarea[aria-label="答案"]', { timeout: 10_000 });
  await page.type('textarea[aria-label="问题"]', 'What does Dynamic mean in this exact Context?');
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === '确认加入复习').click());
  await page.waitForFunction(() => window.__learningBrowser.contextDraft.confirmed || window.__learningBrowser.contextDraft.lastError, { timeout: 10_000 });
  assert.equal(await page.evaluate(() => window.__learningBrowser.contextDraft.lastError?.message || null), null);
  await page.click('[data-action^="context-open-"]');
  await frame.waitForFunction(() => window.CSS?.highlights?.get('pdfReaderAnchorFocusText')?.size > 0, { timeout: 8_000 });
  assert.equal(await frame.evaluate(() => [...CSS.highlights.get('pdfReaderAnchorFocusText')].map(range => range.toString()).join('')), context.anchor.exactQuote);
  return { context, selected, boundary: 'Obsidian Workspace/Modal/DataAdapter and unavailable external dictionary; real LingQ, main Host methods and Vocabulary/Context/Review services' };
}
