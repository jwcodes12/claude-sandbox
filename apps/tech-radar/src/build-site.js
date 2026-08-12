import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, resolveFromRoot } from './paths.js';
import { readSources, readStories } from './db.js';

export function buildSite(db, config) {
  const publicDir = ensureDir(resolveFromRoot('public'));
  const dataDir = ensureDir(path.join(publicDir, 'data'));
  const articlesDir = path.join(dataDir, 'articles');
  fs.rmSync(articlesDir, { recursive: true, force: true });
  ensureDir(articlesDir);

  for (const file of ['index.html', 'app.js', 'styles.css']) {
    fs.copyFileSync(resolveFromRoot('site', file), path.join(publicDir, file));
  }

  const settings = config.settings;
  const stories = readStories(db);
  const now = Date.now();
  const frontPageMs = (settings.frontPageHours ?? 48) * 3_600_000;
  const earlierMs = (settings.earlierHours ?? 168) * 3_600_000;

  // The digest page: the hottest stories that moved recently, importance
  // first, like an edition. Everything else recent lands in a compact
  // "Earlier" list so quiet-but-alive stories stay reachable.
  const moving = stories.filter((story) => now - Date.parse(story.updatedAt) <= frontPageMs);
  const front = [...moving]
    .sort((a, b) => b.hotness - a.hotness)
    .slice(0, settings.frontPageStories ?? 12);
  const frontSlugs = new Set(front.map((story) => story.slug));
  const earlier = stories.filter((story) =>
    !frontSlugs.has(story.slug) && now - Date.parse(story.updatedAt) <= earlierMs);

  const index = front.map((story) => ({
    slug: story.slug,
    title: story.title,
    lane: story.lane,
    hotness: story.hotness,
    mode: story.article?.mode ?? 'digest',
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    summary: story.article?.summary ?? story.article?.shortTake ?? '',
    body: story.article?.body ?? '',
    updates: (story.updates ?? []).slice(-6),
    sourceCount: story.article?.sources?.length ?? story.items.length,
    sources: [...new Set(story.items.map((item) => item.sourceTitle))].slice(0, 4),
  }));

  const earlierIndex = earlier.map((story) => ({
    slug: story.slug,
    title: story.title,
    lane: story.lane,
    updatedAt: story.updatedAt,
    summary: story.article?.summary ?? story.article?.shortTake ?? '',
  }));

  fs.writeFileSync(path.join(dataDir, 'digest.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    title: settings.title,
    description: settings.description,
    stories: index,
    earlier: earlierIndex,
  }, null, 2));

  fs.writeFileSync(path.join(dataDir, 'sources.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    sources: readSources(db),
  }, null, 2));

  // Every retained story keeps an article file: the page lazy-loads sources
  // and "Earlier" bodies from here, and deep links outlive the front page.
  for (const story of stories) {
    fs.writeFileSync(path.join(articlesDir, `${story.slug}.json`), JSON.stringify({
      ...story.article,
      createdAt: story.createdAt,
      updatedAt: story.updatedAt,
      updates: story.updates ?? [],
    }, null, 2));
  }

  fs.writeFileSync(path.join(publicDir, '_headers'), [
    '/data/*',
    '  Cache-Control: public, max-age=60, stale-while-revalidate=600',
    '/*',
    '  Cache-Control: public, max-age=300',
    '',
  ].join('\n'));

  console.log(`[build] wrote ${index.length} digest stories + ${earlierIndex.length} earlier (${stories.length} tracked) to ${publicDir}`);
}
