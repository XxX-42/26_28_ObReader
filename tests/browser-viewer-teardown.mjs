import assert from "node:assert/strict";

// A page target disappearing alone is not evidence that the PDF loading task
// completed destruction. Exercise bridge disposal and await PDF.js shutdown
// before releasing this test-owned page/iframe.
export async function teardownViewerPage(page) {
  if (!page || page.isClosed()) return [];
  const results = [];
  for (const frame of page.frames()) {
    const result = await frame.evaluate(async () => {
      const app = window.PDFViewerApplication;
      if (!app) return null;
      const task = app.pdfLoadingTask;
      const worker = task?._worker;
      window.dispatchEvent(new Event("pagehide"));
      await app.close();
      if (task) await task.destroy();
      window.getSelection()?.removeAllRanges();
      return { taskDestroyed: !task || task.destroyed === true,
        workerDestroyed: !worker || worker.destroyed === true,
        documentReleased: app.pdfDocument === null,
        pageViews: app.pdfViewer?._pages?.length ?? 0,
        selectionCollapsed: window.getSelection()?.isCollapsed !== false };
    });
    if (!result) continue;
    assert.deepEqual(result, { taskDestroyed: true, workerDestroyed: true,
      documentReleased: true, pageViews: 0, selectionCollapsed: true });
    results.push(result);
  }
  return results;
}
