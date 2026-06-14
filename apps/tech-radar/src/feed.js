import { XMLParser } from 'fast-xml-parser';
import { canonicalizeUrl, excerpt, hashText, stripHtml } from './text.js';
import { getSourceState, updateSourceState, upsertItem } from './db.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  parseTagValue: false,
  trimValues: true,
});

export async function ingestFeeds(db, config) {
  const results = [];
  for (const source of config.sources) {
    const result = await ingestFeed(db, source, config);
    results.push(result);
    console.log(`[feed] ${source.id}: ${result.status} ${result.items} items`);
  }
  return results;
}

export async function ingestFeed(db, source, config) {
  const previous = getSourceState(db, source.id);
  const headers = {
    'user-agent': 'claude-sandbox-tech-radar/0.1 (+https://github.com/jwcodes12/claude-sandbox)',
    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
  };
  if (previous.etag) headers['if-none-match'] = previous.etag;
  if (previous.last_modified) headers['if-modified-since'] = previous.last_modified;

  try {
    const response = await fetch(source.url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 304) {
      updateSourceState(db, source.id, {
        etag: previous.etag,
        lastModified: previous.last_modified,
        status: 304,
      });
      return { source: source.id, status: 'not-modified', items: 0 };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const xml = await response.text();
    const parsed = parser.parse(xml);
    const items = normalizeFeed(parsed, source, config).slice(0, config.settings.maxItemsPerFeed);
    for (const item of items) {
      upsertItem(db, item);
    }

    updateSourceState(db, source.id, {
      etag: response.headers.get('etag') ?? previous.etag,
      lastModified: response.headers.get('last-modified') ?? previous.last_modified,
      status: response.status,
    });

    return { source: source.id, status: 'ok', items: items.length };
  } catch (error) {
    updateSourceState(db, source.id, {
      etag: previous.etag,
      lastModified: previous.last_modified,
      status: 0,
      error: error.message,
    });
    return { source: source.id, status: `error: ${error.message}`, items: 0 };
  }
}

function normalizeFeed(parsed, source) {
  if (parsed.rss?.channel) return normalizeRss(parsed.rss.channel, source);
  if (parsed.feed?.entry) return normalizeAtom(parsed.feed, source);
  if (parsed.rdf?.item) return normalizeRss({ item: parsed.rdf.item }, source);
  return [];
}

function normalizeRss(channel, source) {
  return asArray(channel.item).map((entry) => {
    const url = value(entry.link) || value(entry.guid) || source.url;
    const title = stripHtml(value(entry.title) || 'Untitled');
    const content = value(entry['content:encoded']) || value(entry.description) || value(entry.summary);
    const publishedAt = parseDate(value(entry.pubDate) || value(entry['dc:date']) || value(entry.date));
    return makeItem({
      source,
      title,
      url,
      author: value(entry.author) || value(entry['dc:creator']),
      summary: excerpt(content || title),
      contentText: stripHtml(content || title),
      publishedAt,
      raw: entry,
    });
  });
}

function normalizeAtom(feed, source) {
  return asArray(feed.entry).map((entry) => {
    const url = atomLink(entry.link) || value(entry.id) || source.url;
    const title = stripHtml(value(entry.title) || 'Untitled');
    const content = value(entry.content) || value(entry.summary);
    const publishedAt = parseDate(value(entry.published) || value(entry.updated));
    return makeItem({
      source,
      title,
      url,
      author: atomAuthor(entry.author),
      summary: excerpt(content || title),
      contentText: stripHtml(content || title),
      publishedAt,
      raw: entry,
    });
  });
}

function makeItem({ source, title, url, author, summary, contentText, publishedAt, raw }) {
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

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function value(input) {
  if (input == null) return '';
  if (typeof input === 'string' || typeof input === 'number') return String(input);
  if (typeof input === 'object') return String(input['#cdata'] ?? input['#text'] ?? input.href ?? input['@_href'] ?? '').trim();
  return '';
}

function atomLink(link) {
  const links = asArray(link);
  const alternate = links.find((item) => !item['@_rel'] || item['@_rel'] === 'alternate');
  return value(alternate ?? links[0]);
}

function atomAuthor(author) {
  if (!author) return '';
  const first = Array.isArray(author) ? author[0] : author;
  return value(first.name) || value(first);
}

function parseDate(input) {
  if (!input) return null;
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
