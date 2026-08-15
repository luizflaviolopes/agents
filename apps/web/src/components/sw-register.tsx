"use client";

import * as React from "react";

/** Registers the service worker (production only — it would cache dev chunks). */
export function ServiceWorkerRegister() {
  React.useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      !("serviceWorker" in navigator)
    )
      return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration failure just means no offline support — never fatal.
    });
  }, []);

  return null;
}
