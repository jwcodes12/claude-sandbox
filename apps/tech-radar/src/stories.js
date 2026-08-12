import { fallbackArticle, scoreItem } from './cluster.js';
import { hashText, jaccard, slugify } from './text.js';

const MAX_STORED_ITEMS = 80;

// Match this run's clusters against the persistent story list, updating stories
// in place when new discourse arrives and creating stories for genuinely new
// clusters. Stories keep stable ids/slugs across runs, so the digest reads like
// a news site where articles get updated rather than replaced.
export function reconcileStories(previousStories, clusters, config, now = new Date()) {
  const nowIso = now.toISOString();
  const settings = config.settings;
  const retentionMs = (settings.storyRetentionDays ?? 14) * 86_400_000;
  const keywordWindowMs = settings.lookbackHours * 1.5 * 3_600_000;

  const stories = previousStories
    .filter((story) => now.getTime() - Date.parse(story.updatedAt) < retentionMs)
    .map((story) => ({ ...story, changed: false, isNew: false, freshItemIds: [] }));

  const itemToStory = new Map();
  for (const story of stories) {
    for (const item of story.items) itemToStory.set(item.id, story);
  }
  const usedSlugs = new Set(stories.map((story) => story.slug));
  const claimed = new Set();
  let newCount = 0;
  let updatedCount = 0;

  // Clusters arrive sorted by hotness, so the strongest cluster claims a story
  // first when a story's discourse splits across clusters in one run.
  for (const cluster of clusters) {
    const story = matchCluster(cluster, stories, itemToStory, claimed, settings, now, keywordWindowMs);
    if (story) {
      claimed.add(story.id);
      if (applyCluster(story, cluster, nowIso)) updatedCount += 1;
      for (const item of story.items) itemToStory.set(item.id, story);
    } else {
      const fresh = createStory(cluster, usedSlugs, nowIso);
      stories.push(fresh);
      claimed.add(fresh.id);
      newCount += 1;
      for (const item of fresh.items) itemToStory.set(item.id, fresh);
    }
  }

  stories.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { stories, newCount, updatedCount };
}

// Render a story in the shape cluster.js/briefs.js expect for a topic: the
// current top items by recency/weight, capped like a per-run cluster.
export function storyTopicView(story, config) {
  const items = [...story.items]
    .sort((a, b) => scoreItem(b) - scoreItem(a))
    .slice(0, config.settings.maxTopicItems);
  return {
    id: story.id,
    slug: story.slug,
    title: story.title,
    lane: story.lane,
    hotness: story.hotness,
    keywords: story.keywords,
    items,
  };
}

// Deterministic digest article for a story, stamped with the story's own
// update time so unchanged runs don't pretend the story moved.
export function storyDigestArticle(story, config) {
  const article = fallbackArticle(storyTopicView(story, config));
  article.updatedAt = story.updatedAt;
  return article;
}

function matchCluster(cluster, stories, itemToStory, claimed, settings, now, keywordWindowMs) {
  // Primary signal: the cluster literally contains items already attributed to
  // a story. Items partition across clusters each run, so heavy overlap means
  // this cluster is that story, re-clustered with fresh discourse mixed in.
  const votes = new Map();
  for (const item of cluster.items) {
    const story = itemToStory.get(item.id);
    if (story && !claimed.has(story.id)) votes.set(story, (votes.get(story) ?? 0) + 1);
  }
  let best = null;
  let bestOverlap = 0;
  for (const [story, overlap] of votes) {
    if (overlap > bestOverlap) {
      best = story;
      bestOverlap = overlap;
    }
  }
  if (best) {
    const ratio = bestOverlap / Math.max(1, Math.min(cluster.items.length, best.items.length));
    if (bestOverlap >= 3 || ratio >= 0.5) return best;
  }

  // Fallback: keyword similarity against recently-active stories, for the case
  // where the discourse moved on to entirely new posts about the same thing.
  const threshold = settings.ranking.storyMatchSimilarity ?? 0.3;
  const clusterKeywords = new Set(cluster.keywords);
  let bestByKeywords = null;
  let bestScore = 0;
  for (const story of stories) {
    if (claimed.has(story.id)) continue;
    if (now.getTime() - Date.parse(story.updatedAt) > keywordWindowMs) continue;
    const storyKeywords = new Set(story.keywords);
    // Story keyword sets grow well past a cluster's six, so plain jaccard
    // punishes the size mismatch; containment of the smaller set catches a
    // cluster that clearly speaks a story's vocabulary.
    let overlap = 0;
    for (const keyword of clusterKeywords) {
      if (storyKeywords.has(keyword)) overlap += 1;
    }
    const containment = overlap / Math.max(1, Math.min(clusterKeywords.size, storyKeywords.size));
    const score = Math.max(jaccard(clusterKeywords, storyKeywords), overlap >= 3 ? containment : 0);
    if (score > bestScore) {
      bestByKeywords = story;
      bestScore = score;
    }
  }
  if (bestByKeywords && bestScore >= threshold) return bestByKeywords;
  return best && bestOverlap >= 2 ? best : null;
}

// Merge a cluster into its story. Returns true when new discourse arrived.
function applyCluster(story, cluster, nowIso) {
  const known = new Set(story.items.map((item) => item.id));
  const freshItems = cluster.items.filter((item) => !known.has(item.id));

  const clusterById = new Map(cluster.items.map((item) => [item.id, item]));
  const kept = story.items.map((item) => {
    const updated = clusterById.get(item.id);
    return updated ? { ...updated, addedAt: item.addedAt } : item;
  });
  story.items = [...kept, ...freshItems.map((item) => ({ ...item, addedAt: nowIso }))]
    .sort((a, b) => Date.parse(b.publishedAt ?? b.fetchedAt) - Date.parse(a.publishedAt ?? a.fetchedAt))
    .slice(0, MAX_STORED_ITEMS);
  story.keywords = [...new Set([...story.keywords, ...cluster.keywords])].slice(0, 24);
  story.lane = cluster.lane;
  story.hotness = cluster.hotness;

  if (freshItems.length === 0) return false;
  story.changed = true;
  story.updatedAt = nowIso;
  story.freshItemIds = freshItems.map((item) => item.id);
  story.updates = [
    ...(story.updates ?? []),
    {
      at: nowIso,
      added: freshItems.length,
      sources: [...new Set(freshItems.map((item) => item.sourceTitle))].slice(0, 5),
    },
  ].slice(-12);
  return true;
}

function createStory(cluster, usedSlugs, nowIso) {
  let slug = `${slugify(cluster.title)}-${hashText(`${cluster.slug}:${nowIso}`, 6)}`;
  while (usedSlugs.has(slug)) slug = `${slug}-${hashText(slug, 4)}`;
  usedSlugs.add(slug);
  return {
    id: hashText(`story:${slug}`),
    slug,
    title: cluster.title,
    lane: cluster.lane,
    hotness: cluster.hotness,
    keywords: [...cluster.keywords],
    createdAt: nowIso,
    updatedAt: nowIso,
    updates: [],
    article: null,
    items: cluster.items.map((item) => ({ ...item, addedAt: nowIso })),
    changed: true,
    isNew: true,
    freshItemIds: cluster.items.map((item) => item.id),
  };
}
