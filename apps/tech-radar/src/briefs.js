import fs from 'node:fs';
import { fallbackArticle } from './cluster.js';
import { resolveFromRoot } from './paths.js';

export async function attachBriefs(topics, config) {
  const shouldUseModel = Boolean(config.settings.models.enabled) && process.env.TECH_RADAR_ENABLE_LLM === '1';
  const eligibleTopics = topics.map((topic) => ({
    ...topic,
    needsModel: topic.hotness >= config.settings.ranking.minHotnessForBrief &&
      topic.items.length >= config.settings.ranking.minItemsForBrief,
  }));

  if (!shouldUseModel) {
    return eligibleTopics.map((topic) => ({
      ...topic,
      article: fallbackArticle(topic),
    }));
  }

  const promptTemplate = fs.readFileSync(resolveFromRoot('prompts/topic-brief.md'), 'utf8');
  const output = [];
  for (const topic of eligibleTopics) {
    if (!topic.needsModel) {
      output.push({ ...topic, article: fallbackArticle(topic) });
      continue;
    }

    try {
      const article = await generateBrief(topic, config, promptTemplate);
      output.push({ ...topic, article: { ...fallbackArticle(topic), ...article, mode: 'model' } });
    } catch (error) {
      console.warn(`[brief] ${topic.slug}: ${error.message}`);
      output.push({ ...topic, article: { ...fallbackArticle(topic), modelError: error.message } });
    }
  }
  return output;
}

async function generateBrief(topic, config, promptTemplate) {
  const input = promptTemplate
    .replace('{{TOPIC_JSON}}', JSON.stringify({
      title: topic.title,
      hotness: topic.hotness,
      keywords: topic.keywords,
      sources: topic.items.map((item) => ({
        title: item.title,
        source: item.sourceTitle,
        sourceKind: item.sourceKind,
        author: item.author,
        url: item.url,
        publishedAt: item.publishedAt,
        text: item.contentText || item.summary,
      })),
    }, null, 2));

  const provider = config.settings.models.provider;
  if (provider === 'openai') return generateOpenAI(input, config);
  return generateAnthropic(input, config);
}

async function generateAnthropic(input, config) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.settings.models.largeModel,
      max_tokens: 1800,
      temperature: 0.2,
      messages: [{ role: 'user', content: input }],
    }),
  });
  if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}: ${await response.text()}`);
  const json = await response.json();
  return parseJson(json.content?.map((part) => part.text ?? '').join('\n') ?? '');
}

async function generateOpenAI(input, config) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.settings.models.largeModel,
      input,
      temperature: 0.2,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${await response.text()}`);
  const json = await response.json();
  return parseJson(json.output_text ?? JSON.stringify(json));
}

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('model did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}
