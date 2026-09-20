// engine/url-normalize.ts
// URL normalization shared by the extractor, the trace and perUrl aggregation.

function stripUtm(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
  }
}

function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/** Normalized URL used for stateHash, perUrl keys and the loop detector's page identity. */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  stripUtm(url);
  const pathname = stripTrailingSlash(url.pathname);
  const search = url.searchParams.toString();
  return `${url.origin}${pathname === '/' ? '' : pathname}${search ? `?${search}` : ''}${url.hash}`;
}

/** Href as stored on an element: relative for same-origin, absolute otherwise, always utm-free. */
export function toRelativeHref(raw: string, base: string): string {
  let url: URL;
  let baseUrl: URL;
  try {
    url = new URL(raw, base);
    baseUrl = new URL(base);
  } catch {
    return raw;
  }
  stripUtm(url);
  const search = url.searchParams.toString();
  if (url.origin !== baseUrl.origin) return url.toString();
  return `${stripTrailingSlash(url.pathname)}${search ? `?${search}` : ''}${url.hash}`;
}
