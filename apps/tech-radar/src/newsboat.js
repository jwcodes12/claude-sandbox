import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { excerpt, stripHtml } from './text.js';
import { makeItem } from './item.js';
import { getSourceState, updateSourceState, upsertItem } from './db.js';

// Resolve the newsboat cache.db path.
// Priority: NEWSBOAT_CACHE_DB env -> settings.newsboat.cacheDb -> ~/.newsboat/cache.db.
export function newsboatCachePath(config) {
  const fromSetting = config?.settings?.newsboat?.cacheDb;
  const explicit = String(process.env.NEWSBOAT_CACHE_DB || fromSetting || '').trim();
  if (explicit) return path.resolve(expandHome(explicit));
  return path.join(os.homedir(), '.newsboat', 'cache.db');
}

function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

// Ingest items straight from the local newsboat sqlite cache instead of fetching
// an RSS bridge over HTTP. The cache is opened read-only so the running newsboat
// instance is never locked or mutated.
export function ingestNewsboatSource(db, source, config) {
  const cachePath = newsboatCachePath(config);

  if (!fs.existsSync(cachePath)) {
    updateSourceState(db, source.id, { status: 0, error: `newsboat cache not found: ${cachePath}` });
    return { source: source.id, status: 'error: cache not found', items: 0 };
  }

  const matcher = buildFeedMatcher(source.newsboat ?? {});
  const lookbackHours = Number(config.settings.lookbackHours ?? 96);
  const sinceEpoch = Math.floor((Date.now() - lookbackHours * 3_600_000) / 1000);
  const maxItems = Number(source.newsboat?.maxItems ?? 250);

  let cache;
  try {
    cache = new DatabaseSync(cachePath, { readOnly: true });
    const feeds = cache
      .prepare('SELECT rssurl FROM rss_feed')
      .all()
      .map((row) => row.rssurl)
      .filter((rssurl) => matcher(rssurl));

    if (feeds.length === 0) {
      cache.close();
      updateSourceState(db, source.id, { status: 200, error: 'no matching newsboat feeds' });
      return { source: source.id, status: 'ok', items: 0 };
    }

    const placeholders = feeds.map(() => '?').join(',');
    const rows = cache
      .prepare(
        `SELECT title, author, url, content, pubDate, feedurl
         FROM rss_item
         WHERE deleted = 0 AND pubDate >= ? AND feedurl IN (${placeholders})
         ORDER BY pubDate DESC
         LIMIT ?`,
      )
      .all(sinceEpoch, ...feeds, maxItems);
    cache.close();
    cache = undefined;

    let count = 0;
    for (const row of rows) {
      const item = normalizeRow(row, source);
      if (!item) continue;
      upsertItem(db, item);
      count += 1;
    }

    updateSourceState(db, source.id, { status: 200 });
    return { source: source.id, status: 'ok', items: count };
  } catch (error) {
    try {
      cache?.close();
    } catch {
      // ignore close failures during error handling
    }
    updateSourceState(db, source.id, { status: 0, error: error.message });
    return { source: source.id, status: `error: ${error.message}`, items: 0 };
  }
}

function buildFeedMatcher(spec) {
  if (spec.match) {
    const regex = new RegExp(spec.match);
    return (rssurl) => regex.test(rssurl);
  }
  if (Array.isArray(spec.feeds) && spec.feeds.length > 0) {
    const allowed = new Set(spec.feeds);
    return (rssurl) => allowed.has(rssurl);
  }
  return () => true;
}

function normalizeRow(row, source) {
  const url = String(row.url ?? '').trim();
  const rawTitle = stripHtml(String(row.title ?? '')).trim();
  const content = String(row.content ?? '');
  const contentText = stripHtml(content || rawTitle);
  if (!url && !rawTitle && !contentText) return null;

  // Text-less quote/retweets arrive from xcancel with the bare status id as the
  // title (e.g. "2065...#m") and the real text in the body. Prefer the body text
  // when the title carries no actual words.
  const titleHasWords = /[a-z]{2,}/i.test(rawTitle);
  const title = (titleHasWords ? rawTitle : '') || excerpt(contentText, 140) || rawTitle || 'Untitled';

  const pubDate = Number(row.pubDate);
  const publishedAt = Number.isFinite(pubDate) && pubDate > 0
    ? new Date(pubDate * 1000).toISOString()
    : null;

  return makeItem({
    source,
    title,
    url: url || source.url,
    author: String(row.author ?? '').trim(),
    summary: excerpt(content || rawTitle),
    contentText,
    publishedAt,
    raw: { feedurl: row.feedurl, author: row.author },
  });
}
