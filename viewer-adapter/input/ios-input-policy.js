(() => {
  "use strict";

  class IOSInputPolicy {
    route(intent, forwardExistingBehavior) {
      // The existing iPad event behavior remains the compatibility target in
      // this extraction-only stage; subsequent phases move its ownership here.
      return forwardExistingBehavior(intent);
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { IOSInputPolicy },
  );
})();
