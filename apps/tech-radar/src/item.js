import { canonicalizeUrl, hashText } from './text.js';

// Shared item shape used by every ingestion source (HTTP feeds + newsboat).
export function makeItem({ source, title, url, author, summary, contentText, publishedAt, raw }) {
  const canonicalUrl = canonicalizeUrl(url);
  const id = hashText(`${source.id}:${canonicalUrl || title}`);
  return {
    id,
    sourceId: source.id,
    sourceTitle: source.title,
    sourceKind: source.kind,
    sourceWeight: Number(source.weight ?? 1),
    title,
    url,
    canonicalUrl,
    author,
    summary,
    contentText,
    publishedAt,
    fetchedAt: new Date().toISOString(),
    tags: source.tags ?? [],
    raw,
  };
}
