const REFRESH_MS = 5 * 60_000;
const RECENT_MS = 12 * 3_600_000;

const state = {
  stories: [],
  earlier: [],
  generatedAt: null,
  openSources: new Set(),
  openEarlier: new Set(),
  articles: new Map(),
};

const contents = document.querySelector('#contents');
const digest = document.querySelector('#digest');
const earlier = document.querySelector('#earlier');
const generatedAt = document.querySelector('#generated-at');

const LANE_LABELS = { takes: 'Takes', news: 'News', research: 'Research' };

async function boot() {
  await refresh(true);
  const requested = new URL(location.href).searchParams.get('story');
  if (requested) document.getElementById(`story-${requested}`)?.scrollIntoView({ block: 'start' });
  setInterval(() => refresh().catch(() => {}), REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh().catch(() => {});
  });
}

async function refresh(initial = false) {
  const data = await fetch('/data/digest.json', { cache: 'no-cache' }).then((response) => response.json());
  if (!initial && data.generatedAt === state.generatedAt) return;
  state.generatedAt = data.generatedAt;
  state.stories = data.stories ?? [];
  state.earlier = data.earlier ?? [];
  state.articles.clear();
  generatedAt.textContent = data.generatedAt ? `Updated ${formatTime(data.generatedAt)}` : 'No run yet';
  render();
}

function render() {
  renderContents();
  renderDigest();
  renderEarlier();
}

function renderContents() {
  if (state.stories.length < 2) {
    contents.innerHTML = '';
    return;
  }
  contents.innerHTML = `
    <h2>In this digest</h2>
    <ol>
      ${state.stories.map((story) => `
        <li>
          <a href="#story-${escapeAttribute(story.slug)}">${escapeHtml(story.title)}</a>
          ${storyBadge(story)}
        </li>
      `).join('')}
    </ol>
  `;
}

function renderDigest() {
  if (state.stories.length === 0) {
    digest.innerHTML = '<p class="empty">No stories yet. The next worker run will fill this in.</p>';
    return;
  }
  digest.innerHTML = state.stories.map(renderStory).join('');

  for (const details of digest.querySelectorAll('details[data-sources]')) {
    details.addEventListener('toggle', () => {
      const slug = details.dataset.sources;
      if (details.open) {
        state.openSources.add(slug);
        loadSources(slug, details.querySelector('.sources'));
      } else {
        state.openSources.delete(slug);
      }
    });
  }
}

function renderStory(story, position) {
  const isLead = position === 0;
  const updates = renderUpdates(story.updates);
  return `
    <article class="story${isLead ? ' lead' : ''}" id="story-${escapeAttribute(story.slug)}">
      <div class="story-meta">
        <time datetime="${escapeHtml(story.updatedAt)}">${formatTime(story.updatedAt)}</time>
        ${storyBadge(story)}
        <span class="chip">${escapeHtml(LANE_LABELS[story.lane] ?? 'News')}</span>
        <span class="names">${escapeHtml((story.sources ?? []).slice(0, 3).join(' · '))}</span>
      </div>
      <h2 class="headline">${escapeHtml(story.title)}</h2>
      ${story.summary ? `<p class="standfirst">${escapeHtml(story.summary)}</p>` : ''}
      ${story.body ? `<div class="body">${renderMarkdown(story.body)}</div>` : ''}
      ${updates}
      <details class="sources-details" data-sources="${escapeAttribute(story.slug)}"${state.openSources.has(story.slug) ? ' open' : ''}>
        <summary>Sources (${story.sourceCount})</summary>
        <div class="sources"><p class="empty">Loading...</p></div>
      </details>
    </article>
  `;
}

function storyBadge(story) {
  const now = Date.now();
  if (story.createdAt && now - Date.parse(story.createdAt) < RECENT_MS) {
    return '<span class="badge new">New</span>';
  }
  const update = (story.updates ?? []).at(-1);
  if (update && now - Date.parse(update.at) < RECENT_MS) {
    return `<span class="badge updated">Updated +${update.added}</span>`;
  }
  return '';
}

function renderUpdates(updates = []) {
  const recent = [...updates].reverse().slice(0, 4);
  if (recent.length === 0) return '';
  return `
    <p class="update-line">
      ${recent.map((update) => `<span><time>${formatTimeShort(update.at)}</time> +${update.added} from ${escapeHtml((update.sources ?? []).join(', '))}</span>`).join('')}
    </p>
  `;
}

function renderEarlier() {
  if (state.earlier.length === 0) {
    earlier.innerHTML = '';
    return;
  }
  earlier.innerHTML = `
    <h2>Earlier this week</h2>
    ${state.earlier.map((story) => `
      <details class="earlier-story" data-earlier="${escapeAttribute(story.slug)}"${state.openEarlier.has(story.slug) ? ' open' : ''}>
        <summary>
          <span class="earlier-title">${escapeHtml(story.title)}</span>
          <span class="earlier-meta">${formatTimeShort(story.updatedAt)}</span>
        </summary>
        <div class="earlier-body"><p class="empty">Loading...</p></div>
      </details>
    `).join('')}
  `;

  for (const details of earlier.querySelectorAll('details[data-earlier]')) {
    details.addEventListener('toggle', () => {
      const slug = details.dataset.earlier;
      if (details.open) {
        state.openEarlier.add(slug);
        loadEarlierBody(slug, details.querySelector('.earlier-body'));
      } else {
        state.openEarlier.delete(slug);
      }
    });
  }
}

async function fetchArticle(slug) {
  if (!state.articles.has(slug)) {
    const article = await fetch(`/data/articles/${slug}.json`, { cache: 'no-cache' })
      .then((response) => response.json());
    state.articles.set(slug, article);
  }
  return state.articles.get(slug);
}

async function loadSources(slug, container) {
  try {
    const article = await fetchArticle(slug);
    container.innerHTML = (article.sources ?? []).map(renderSource).join('') || '<p class="empty">No sources recorded.</p>';
  } catch {
    container.innerHTML = '<p class="empty">Could not load sources.</p>';
  }
}

async function loadEarlierBody(slug, container) {
  try {
    const article = await fetchArticle(slug);
    container.innerHTML = `
      ${article.summary ? `<p class="standfirst">${escapeHtml(article.summary)}</p>` : ''}
      ${article.body ? `<div class="body">${renderMarkdown(article.body)}</div>` : ''}
      <div class="sources">${(article.sources ?? []).map(renderSource).join('')}</div>
    `;
  } catch {
    container.innerHTML = '<p class="empty">Could not load this story.</p>';
  }
}

function renderSource(source) {
  const text = source.text ?? source.excerpt ?? '';
  return `
    <div class="source">
      <a href="${escapeAttribute(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title)}</a>
      <div class="source-meta">${escapeHtml(source.source)}${source.author ? ` / ${escapeHtml(source.author)}` : ''}${source.publishedAt ? ` / ${formatTime(source.publishedAt)}` : ''}</div>
      <p class="source-text">${escapeHtml(text).replaceAll('\n', '<br>')}</p>
    </div>
  `;
}

// --- Minimal, safe markdown renderer (escape first, then a small subset). ---

function renderMarkdown(md) {
  return String(md)
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(renderBlock)
    .filter(Boolean)
    .join('\n');
}

function renderBlock(block) {
  const trimmed = block.trim();
  if (!trimmed) return '';
  const lines = block.split('\n');
  if (lines.every((line) => /^\s*>/.test(line))) {
    const inner = lines.map((line) => line.replace(/^\s*>\s?/, '')).join('\n');
    return `<blockquote>${renderInlineMultiline(inner)}</blockquote>`;
  }
  if (lines.length === 1 && /^#{1,4}\s+/.test(trimmed)) {
    return `<h3>${renderInline(trimmed.replace(/^#{1,4}\s+/, ''))}</h3>`;
  }
  if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
    return `<ul>${lines.map((line) => `<li>${renderInline(line.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
  }
  return `<p>${renderInlineMultiline(block)}</p>`;
}

function renderInlineMultiline(text) {
  return text.split('\n').map(renderInline).join('<br>');
}

function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, label, url) =>
    `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return out;
}

function formatTime(input) {
  if (!input) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(input));
}

function formatTimeShort(input) {
  if (!input) return '';
  const date = new Date(input);
  const today = new Date();
  const options = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function escapeHtml(input = '') {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(input = '') {
  return escapeHtml(input).replaceAll('`', '&#96;');
}

boot().catch((error) => {
  digest.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
});
