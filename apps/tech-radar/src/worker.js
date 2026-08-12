import fs from 'node:fs';
import { attachStoryBriefs } from './briefs.js';
import { buildSite } from './build-site.js';
import { buildTopics } from './cluster.js';
import { loadConfig } from './config.js';
import { ensureSources, getRecentItems, migrateTopicsToStories, openDatabase, readStories, saveStories } from './db.js';
import { ingestFeeds } from './feed.js';
import { resolveFromRoot } from './paths.js';
import { markCompleted, shouldRun } from './schedule.js';
import { reconcileStories } from './stories.js';

const command = process.argv[2] ?? 'run';
const force = process.argv.includes('--force');

async function main() {
  const config = loadConfig();
  const db = openDatabase(config);

  try {
    ensureSources(db, config.sources);
    const migrated = migrateTopicsToStories(db);
    if (migrated > 0) console.log(`[migrate] seeded ${migrated} stories from the old topics table`);

    if (command === 'build') {
      buildSite(db, config);
      return;
    }

    const gate = shouldRun(db, config, { force });
    if (!gate.run && command === 'run') {
      console.log(`[schedule] skipped: ${gate.reason}`);
      return;
    }
    console.log(`[schedule] running: ${gate.reason}`);

    await ingestFeeds(db, config);

    if (command === 'fetch') {
      markCompleted(db);
      return;
    }

    const items = getRecentItems(db, config.settings.lookbackHours);
    const clusters = buildTopics(items, config);
    const { stories, newCount, updatedCount } = reconcileStories(readStories(db), clusters, config);
    await attachStoryBriefs(stories, config);
    saveStories(db, stories);
    console.log(`[stories] ${newCount} new, ${updatedCount} updated, ${stories.length} tracked`);

    // Rebuild (and thus redeploy) only when the digest actually moved.
    if (newCount + updatedCount > 0 || force || !fs.existsSync(resolveFromRoot('public', 'data', 'digest.json'))) {
      buildSite(db, config);
    } else {
      console.log('[build] no story changes; leaving the published digest as-is');
    }
    markCompleted(db);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
