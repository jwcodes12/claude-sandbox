import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, resolveFromRoot } from './paths.js';
import { readSources, readTopics } from './db.js';

export function buildSite(db, config) {
  const publicDir = ensureDir(resolveFromRoot('public'));
  const dataDir = ensureDir(path.join(publicDir, 'data'));
  const articlesDir = path.join(dataDir, 'articles');
  fs.rmSync(articlesDir, { recursive: true, force: true });
  ensureDir(articlesDir);

  for (const file of ['index.html', 'app.js', 'styles.css']) {
    fs.copyFileSync(resolveFromRoot('site', file), path.join(publicDir, file));
  }

  const topics = readTopics(db);
  const sources = readSources(db);
  const topicIndex = topics.map((topic) => ({
    id: topic.id,
    slug: topic.slug,
    title: topic.title,
    hotness: topic.hotness,
    updatedAt: topic.updatedAt,
    whyHot: topic.article.whyHot,
    shortTake: topic.article.shortTake,
    sourceCount: topic.article.sources?.length ?? 0,
    sources: [...new Set((topic.article.sources ?? []).map((source) => source.source))].slice(0, 5),
  }));

  fs.writeFileSync(path.join(dataDir, 'topics.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    title: config.settings.title,
    description: config.settings.description,
    topics: topicIndex,
  }, null, 2));

  fs.writeFileSync(path.join(dataDir, 'sources.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    sources,
  }, null, 2));

  for (const topic of topics) {
    fs.writeFileSync(path.join(articlesDir, `${topic.slug}.json`), JSON.stringify(topic.article, null, 2));
  }

  fs.writeFileSync(path.join(publicDir, '_headers'), [
    '/data/*',
    '  Cache-Control: public, max-age=60, stale-while-revalidate=600',
    '/*',
    '  Cache-Control: public, max-age=300',
    '',
  ].join('\n'));

  console.log(`[build] wrote ${topicIndex.length} topics to ${publicDir}`);
}
