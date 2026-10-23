function pageBaseHref() {
  const doc = globalThis.document;
  if (typeof doc === "undefined" || doc === null) return void 0;
  const raw = doc.baseURI;
  if (typeof raw !== "string" || raw === "") return void 0;
  try {
    const url = new URL(raw);
    const lastSlash = url.pathname.lastIndexOf("/");
    const lastSegment = url.pathname.slice(lastSlash + 1);
    if (/\.(html?|php|aspx?|jsp)$/i.test(lastSegment)) {
      url.pathname = url.pathname.slice(0, lastSlash + 1);
    } else if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
    }
    return url.href;
  } catch {
    return void 0;
  }
}
function resolveApiUrl(path) {
  if (typeof path !== "string" || path.charAt(0) !== "/" || path.charAt(1) === "/") return path;
  const base = pageBaseHref();
  if (base === void 0) return path;
  try {
    return new URL(path.slice(1), base).href;
  } catch {
    return path;
  }
}
export {
  resolveApiUrl
};
