import crypto from 'node:crypto';

const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'amid', 'among', 'and', 'are', 'because',
  'been', 'before', 'being', 'between', 'but', 'can', 'could', 'did', 'does', 'doing',
  'during', 'for', 'from', 'has', 'have', 'having', 'how', 'into', 'its', 'more', 'new',
  'not', 'now', 'off', 'one', 'only', 'over', 'per', 'should', 'than', 'that', 'the',
  'their', 'then', 'there', 'these', 'they', 'this', 'through', 'under', 'use', 'using',
  'was', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'with', 'would',
]);

export function hashText(text, length = 16) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, length);
}

export function slugify(text) {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug || 'topic';
}

export function stripHtml(html = '') {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => decodeCodePoint(parseInt(hex, 16), match))
    .replace(/&#(\d+);/g, (match, dec) => decodeCodePoint(Number(dec), match))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeCodePoint(codePoint, fallback) {
  if (!Number.isInteger(codePoint) || codePoint < 32 || codePoint > 0x10ffff) return fallback;
  return String.fromCodePoint(codePoint);
}

export function excerpt(text = '', max = 360) {
  const clean = stripHtml(text);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}...`;
}

export function tokenize(text = '') {
  return String(text)
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{2,}/g)
    ?.filter((token) => !STOPWORDS.has(token) && token.length < 32) ?? [];
}

export function keywordSet(text = '', limit = 36) {
  return new Set(tokenize(text).slice(0, limit));
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  return overlap / (a.size + b.size - overlap);
}

export function topKeywords(items, limit = 6) {
  const counts = new Map();
  for (const item of items) {
    for (const token of tokenize(`${item.title} ${item.summary} ${(item.tags ?? []).join(' ')}`)) {
      counts.set(token, (counts.get(token) ?? 0) + Number(item.sourceWeight ?? 1));
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token]) => token);
}

export function canonicalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid)/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return String(url ?? '').trim();
  }
}
