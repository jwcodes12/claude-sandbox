import { attachBriefs } from './briefs.js';
import { buildSite } from './build-site.js';
import { buildTopics } from './cluster.js';
import { loadConfig } from './config.js';
import { ensureSources, getRecentItems, openDatabase, saveTopics } from './db.js';
import { ingestFeeds } from './feed.js';
import { markCompleted, shouldRun } from './schedule.js';

const command = process.argv[2] ?? 'run';
const force = process.argv.includes('--force');

async function main() {
  const config = loadConfig();
  const db = openDatabase(config);

  try {
    ensureSources(db, config.sources);

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
    const topics = buildTopics(items, config);
    const topicsWithBriefs = await attachBriefs(topics, config);
    saveTopics(db, topicsWithBriefs);
    buildSite(db, config);
    markCompleted(db);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
