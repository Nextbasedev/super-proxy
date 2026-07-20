import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

const PUBLIC_ROOT = path.join(process.cwd(), 'public');
const SKILLS_AVAILABLE = fs.existsSync(path.join(PUBLIC_ROOT, 'skills', 'SKILL.md'));

async function skillsApp() {
  const app = Fastify({ logger: false });
  app.addHook('onSend', async (req, reply, payload) => {
    const urlPath = String(req.raw.url || '').split('?')[0];
    if (urlPath.endsWith('.md')) {
      reply.type('text/markdown; charset=utf-8');
      reply.header('Cache-Control', 'public, max-age=300');
    }
    return payload;
  });

  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/',
    index: false,
    setHeaders: (res, filePath) => {
      if (path.extname(filePath) === '.md') {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=300');
      }
    },
  });
  return app;
}

const skillPaths = [
  '/skills/SKILL.md',
  '/skills/anthropic/SKILL.md',
  '/skills/openai-codex/SKILL.md',
  '/skills/openai-images/SKILL.md',
  '/skills/groq/SKILL.md',
  '/skills/cerebras/SKILL.md',
  '/skills/kimi/SKILL.md',
  '/skills/openrouter/SKILL.md',
  '/skills/deepgram/SKILL.md',
  '/skills/xai/SKILL.md',
  '/skills/hermes/SKILL.md',
];

test('master skill is served as markdown', { skip: !SKILLS_AVAILABLE }, async () => {
  const app = await skillsApp();
  const res = await app.inject('/skills/SKILL.md');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /^text\/markdown(?:; charset=utf-8)?/);
  assert.equal(res.headers['cache-control'], 'public, max-age=300');
  assert.match(res.body, /Super Proxy|Model Gateway|super-proxy/i);
});

test('kimi skill mentions current Kimi models', { skip: !SKILLS_AVAILABLE }, async () => {
  const app = await skillsApp();
  const res = await app.inject('/skills/kimi/SKILL.md');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /\bk3\b/);
  assert.match(res.body, /kimi-k2\.7-code/);
  assert.match(res.body, /kimi-k2\.6/);
});

test('cerebras skill mentions current gpt-oss-120b fallback', { skip: !SKILLS_AVAILABLE }, async () => {
  const app = await skillsApp();
  const res = await app.inject('/skills/cerebras/SKILL.md');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /gpt-oss-120b/);
  assert.match(res.body, /zai-glm-4\.7/);
});

test('groq skill mentions chat and transcription routes', { skip: !SKILLS_AVAILABLE }, async () => {
  const app = await skillsApp();
  const res = await app.inject('/skills/groq/SKILL.md');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /chat\/completions/);
  assert.match(res.body, /audio\/transcriptions/);
});

test('xai skill documents Agent Tools web search', { skip: !SKILLS_AVAILABLE }, async () => {
  const app = await skillsApp();
  const res = await app.inject('/skills/xai/SKILL.md');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Agent Tools/);
  assert.match(res.body, /web_search/);
  assert.match(res.body, /response\.web_search_call\.completed/);
});

test('hermes skill documents custom_providers + anthropic_messages + key_env', { skip: !SKILLS_AVAILABLE }, async () => {
  const app = await skillsApp();
  const res = await app.inject('/skills/hermes/SKILL.md');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /custom_providers/);
  assert.match(res.body, /api_mode: anthropic_messages/);
  assert.match(res.body, /(?:SUPER_PROXY_API_KEY|GATEWAY_API_KEY|API_KEY)/);
  assert.match(res.body, /(?:super-proxy-anthropic|anthropic)/);
});

test('master skill lists the Hermes client setup', { skip: !SKILLS_AVAILABLE }, async () => {
  const app = await skillsApp();
  const res = await app.inject('/skills/SKILL.md');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /\/skills\/hermes\/SKILL\.md/);
});

test('all provider skill files return 200', { skip: !SKILLS_AVAILABLE }, async () => {
  const app = await skillsApp();
  for (const skillPath of skillPaths) {
    const res = await app.inject(skillPath);
    assert.equal(res.statusCode, 200, skillPath);
  }
});
