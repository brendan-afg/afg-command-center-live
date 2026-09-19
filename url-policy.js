export function safeDriveFolderUrl(value) {
  try {
    const url = new URL(String(value));
    const canonicalFolder = /^\/drive\/folders\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
    return url.protocol === "https:" && url.hostname === "drive.google.com" && !url.port && !url.username && !url.password && !url.search && !url.hash && canonicalFolder ? url.href : "#";
  } catch {
    return "#";
  }
}
