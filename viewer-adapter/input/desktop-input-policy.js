(() => {
  "use strict";

  class DesktopInputPolicy {
    route(intent, forwardExistingBehavior) {
      // Preserve the established PDF.js and browser path. The compatibility
      // callback currently contains only the Reader's pre-existing boundary
      // tracking; later extraction phases replace it with intent consumers.
      return forwardExistingBehavior(intent);
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { DesktopInputPolicy },
  );
})();
