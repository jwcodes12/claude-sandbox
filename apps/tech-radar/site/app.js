const state = {
  topics: [],
  selectedSlug: null,
};

const topicList = document.querySelector('#topic-list');
const article = document.querySelector('#article');
const generatedAt = document.querySelector('#generated-at');

async function boot() {
  const data = await fetch('/data/topics.json', { cache: 'no-cache' }).then((response) => response.json());
  state.topics = data.topics ?? [];
  state.selectedSlug = new URL(location.href).searchParams.get('topic') || state.topics[0]?.slug || null;
  generatedAt.textContent = data.generatedAt ? `Updated ${formatTime(data.generatedAt)}` : 'No run yet';
  renderTopics();
  await renderArticle();
}

function renderTopics() {
  if (state.topics.length === 0) {
    topicList.innerHTML = '<p class="empty">No topics yet. Run the worker after adding feeds.</p>';
    return;
  }
  topicList.innerHTML = state.topics.map((topic) => `
    <button class="topic-button" data-slug="${escapeHtml(topic.slug)}" aria-current="${topic.slug === state.selectedSlug}">
      <p class="topic-title">${escapeHtml(topic.title)}</p>
      <div class="topic-meta">
        <span class="heat">${topic.hotness}</span>
        <span>${topic.sourceCount} sources</span>
        <span>${escapeHtml((topic.sources ?? []).slice(0, 2).join(', '))}</span>
      </div>
    </button>
  `).join('');

  for (const button of topicList.querySelectorAll('button')) {
    button.addEventListener('click', async () => {
      state.selectedSlug = button.dataset.slug;
      history.replaceState(null, '', `?topic=${encodeURIComponent(state.selectedSlug)}`);
      renderTopics();
      await renderArticle();
    });
  }
}

async function renderArticle() {
  if (!state.selectedSlug) {
    article.innerHTML = '<p class="empty">No topic selected.</p>';
    return;
  }
  const topic = await fetch(`/data/articles/${state.selectedSlug}.json`, { cache: 'no-cache' })
    .then((response) => response.json());

  article.innerHTML = `
    <h2>${escapeHtml(topic.title)}</h2>
    <div class="topic-meta">
      <span class="heat">Hotness ${topic.hotness}</span>
      <span>${escapeHtml(topic.mode || 'deterministic')}</span>
      <span>${formatTime(topic.updatedAt)}</span>
    </div>

    ${section('Why Hot', topic.whyHot)}
    ${section('Short Take', topic.shortTake)}
    ${section('Balanced Take', topic.balancedTake)}
    ${section('Strongest Case', topic.strongestCase)}
    ${section('Strongest Countercase', topic.strongestCountercase)}

    <section class="article-section">
      <h3>Research Questions</h3>
      <ul class="questions">
        ${(topic.researchQuestions ?? []).map((question) => `<li>${escapeHtml(question)}</li>`).join('')}
      </ul>
    </section>

    <section class="article-section">
      <h3>Sources</h3>
      <div class="sources">
        ${(topic.sources ?? []).map(renderSource).join('')}
      </div>
    </section>
  `;
}

function section(title, text) {
  return `
    <section class="article-section">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(text ?? '')}</p>
    </section>
  `;
}

function renderSource(source) {
  return `
    <div class="source">
      <a href="${escapeAttribute(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title)}</a>
      <div class="source-meta">${escapeHtml(source.source)}${source.author ? ` / ${escapeHtml(source.author)}` : ''}${source.publishedAt ? ` / ${formatTime(source.publishedAt)}` : ''}</div>
      <p>${escapeHtml(source.excerpt ?? '')}</p>
    </div>
  `;
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
  article.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
});
