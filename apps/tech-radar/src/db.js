import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir } from './paths.js';

export function openDatabase(config) {
  const dir = ensureDir(config.settings.dataDir);
  const dbPath = path.join(dir, 'news.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      url TEXT NOT NULL,
      weight REAL NOT NULL,
      tags_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_state (
      source_id TEXT PRIMARY KEY,
      etag TEXT,
      last_modified TEXT,
      last_status INTEGER,
      last_fetched_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS source_items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_title TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_weight REAL NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      author TEXT,
      summary TEXT,
      content_text TEXT,
      published_at TEXT,
      fetched_at TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_items_published ON source_items(published_at);
    CREATE INDEX IF NOT EXISTS idx_items_canonical ON source_items(canonical_url);

    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      hotness REAL NOT NULL,
      summary TEXT NOT NULL,
      article_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS topic_items (
      topic_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      relevance REAL NOT NULL,
      PRIMARY KEY (topic_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS run_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function databasePath(config) {
  return path.join(config.settings.dataDir, 'news.sqlite');
}

export function ensureSources(db, sources) {
  const stmt = db.prepare(`
    INSERT INTO sources (id, title, kind, url, weight, tags_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      kind = excluded.kind,
      url = excluded.url,
      weight = excluded.weight,
      tags_json = excluded.tags_json,
      updated_at = excluded.updated_at
  `);
  const now = new Date().toISOString();
  for (const source of sources) {
    stmt.run(source.id, source.title, source.kind, source.url, source.weight, JSON.stringify(source.tags ?? []), now);
  }
}

export function getSourceState(db, sourceId) {
  return db.prepare('SELECT * FROM source_state WHERE source_id = ?').get(sourceId) ?? {};
}

export function updateSourceState(db, sourceId, state) {
  db.prepare(`
    INSERT INTO source_state (source_id, etag, last_modified, last_status, last_fetched_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      etag = excluded.etag,
      last_modified = excluded.last_modified,
      last_status = excluded.last_status,
      last_fetched_at = excluded.last_fetched_at,
      last_error = excluded.last_error
  `).run(
    sourceId,
    state.etag ?? null,
    state.lastModified ?? null,
    state.status ?? null,
    state.fetchedAt ?? new Date().toISOString(),
    state.error ?? null,
  );
}

export function upsertItem(db, item) {
  db.prepare(`
    INSERT INTO source_items (
      id, source_id, source_title, source_kind, source_weight, title, url, canonical_url,
      author, summary, content_text, published_at, fetched_at, tags_json, raw_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      content_text = excluded.content_text,
      published_at = excluded.published_at,
      fetched_at = excluded.fetched_at,
      raw_json = excluded.raw_json
  `).run(
    item.id,
    item.sourceId,
    item.sourceTitle,
    item.sourceKind,
    item.sourceWeight,
    item.title,
    item.url,
    item.canonicalUrl,
    item.author ?? null,
    item.summary ?? '',
    item.contentText ?? '',
    item.publishedAt ?? null,
    item.fetchedAt,
    JSON.stringify(item.tags ?? []),
    JSON.stringify(item.raw ?? {}),
  );
}

export function getRecentItems(db, lookbackHours) {
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT * FROM source_items
    WHERE published_at IS NULL OR published_at >= ?
    ORDER BY COALESCE(published_at, fetched_at) DESC
  `).all(since).map(rowToItem);
}

export function saveTopics(db, topics) {
  db.exec('DELETE FROM topic_items;');
  db.exec('DELETE FROM topics;');
  const topicStmt = db.prepare(`
    INSERT INTO topics (id, slug, title, hotness, summary, article_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const itemStmt = db.prepare(`
    INSERT INTO topic_items (topic_id, item_id, relevance)
    VALUES (?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const topic of topics) {
    topicStmt.run(
      topic.id,
      topic.slug,
      topic.title,
      topic.hotness,
      topic.article.shortTake,
      JSON.stringify(topic.article),
      now,
    );
    for (const item of topic.items) {
      itemStmt.run(topic.id, item.id, item.relevance ?? 1);
    }
  }
}

export function readTopics(db) {
  return db.prepare('SELECT * FROM topics ORDER BY hotness DESC, updated_at DESC').all().map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    hotness: row.hotness,
    article: JSON.parse(row.article_json),
    updatedAt: row.updated_at,
  }));
}

export function readSources(db) {
  return db.prepare('SELECT * FROM sources ORDER BY title').all().map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    url: row.url,
    weight: row.weight,
    tags: JSON.parse(row.tags_json),
  }));
}

export function getState(db, key) {
  return db.prepare('SELECT value FROM run_state WHERE key = ?').get(key)?.value ?? null;
}

export function setState(db, key, value) {
  db.prepare(`
    INSERT INTO run_state (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function removeDatabase(config) {
  fs.rmSync(databasePath(config), { force: true });
}

function rowToItem(row) {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    sourceKind: row.source_kind,
    sourceWeight: row.source_weight,
    title: row.title,
    url: row.url,
    canonicalUrl: row.canonical_url,
    author: row.author,
    summary: row.summary,
    contentText: row.content_text,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    tags: JSON.parse(row.tags_json),
    raw: JSON.parse(row.raw_json),
  };
}
