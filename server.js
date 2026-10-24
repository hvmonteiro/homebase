import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';

const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const databasePath = path.join(dataDir, 'apps.json');
const settingsPath = path.join(dataDir, 'settings.json');
const iconDir = path.join(dataDir, 'icons');
const adminPassword = process.env.ADMIN_PASSWORD;
const sessions = new Map();
let apps = [];
let settings = { layout: 'ungrouped' };
let healthCache = [];
let healthCacheAt = 0;
let healthRefresh;

if (!adminPassword || adminPassword.length < 12) {
  throw new Error('Set ADMIN_PASSWORD to a unique password of at least 12 characters.');
}

async function loadApps() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(iconDir, { recursive: true });
  try {
    const content = await readFile(databasePath, 'utf8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error('The app list must be an array.');
    apps = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    apps = [];
    await persistApps();
  }
}

async function persistApps() {
  // The file is tiny and writes are rare; a synchronous replace keeps updates
  // serialized in this single-process home-server service.
  writeFileSync(databasePath, `${JSON.stringify(apps, null, 2)}\n`, 'utf8');
}

async function loadSettings() {
  try {
    const content = await readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(content);
    const layout = ['ungrouped', 'grouped', 'tabs'].includes(parsed?.layout)
      ? parsed.layout
      : parsed?.groupByCategory ? 'grouped' : 'ungrouped';
    settings = { layout };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await persistSettings();
  }
}

async function persistSettings() {
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function normalizeApp(input) {
  const name = String(input?.name || '').trim().slice(0, 48);
  const category = String(input?.category || '').trim().slice(0, 28);
  const description = String(input?.description || '').trim().slice(0, 120);
  const icon = String(input?.icon || '').trim().slice(0, 2);
  const color = String(input?.color || '#5a8cf0');
  let url;
  try { url = new URL(String(input?.url || '').trim()).toString(); } catch { url = ''; }
  if (!name || !category || !url || !/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  return { name, category, url, description, icon, color };
}

const faviconExtensions = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/x-icon', 'ico'],
  ['image/vnd.microsoft.icon', 'ico'],
]);

async function retrieveFavicon(applicationUrl, id) {
  try {
    const faviconUrl = new URL('/favicon.ico', applicationUrl);
    const response = await fetch(faviconUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon' },
    });
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const extension = faviconExtensions.get(contentType);
    if (!response.ok || !extension) return '';
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 1024 * 1024) return '';
    const filename = `${id}.${extension}`;
    writeFileSync(path.join(iconDir, filename), bytes);
    return `/app-icons/${filename}`;
  } catch {
    return '';
  }
}

function probeUrl(applicationUrl, redirectsRemaining = 5) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(applicationUrl);
    } catch {
      resolve('offline');
      return;
    }

    const transport = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!transport) {
      resolve('offline');
      return;
    }

    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      resolve(state);
    };
    const request = transport.request(url, {
      method: 'GET',
      timeout: 7000,
      headers: { 'user-agent': 'Homebase health check' },
      // Home servers commonly use a locally issued HTTPS certificate. The
      // indicator reports reachability, not certificate trust, so accept it.
      rejectUnauthorized: false,
    }, (response) => {
      const location = response.headers.location;
      const isRedirect = response.statusCode >= 300 && response.statusCode < 400 && location;
      response.resume();
      if (isRedirect && redirectsRemaining > 0) {
        try {
          finish(probeUrl(new URL(location, url).toString(), redirectsRemaining - 1));
        } catch {
          finish('offline');
        }
        return;
      }
      finish(response.statusCode < 500 ? 'online' : 'offline');
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => finish('offline'));
    request.end();
  });
}

async function refreshApplicationHealth() {
  // A browser cannot reliably probe private-server URLs because of CORS and
  // mixed-content restrictions. Do the probes here instead, where Homebase is
  // running on the same network as the services it lists.
  if (healthRefresh) return healthRefresh;
  if (Date.now() - healthCacheAt < 55_000) return healthCache;

  healthRefresh = (async () => {
    let iconsChanged = false;
    const results = await Promise.all(apps.map(async (entry) => {
      const state = await probeUrl(entry.url);

      const favicon = await retrieveFavicon(entry.url, entry.id);
      if (favicon && favicon !== entry.favicon) {
        entry.favicon = favicon;
        iconsChanged = true;
      }
      return { id: entry.id, state, favicon: entry.favicon || '' };
    }));

    if (iconsChanged) await persistApps();
    healthCache = results;
    healthCacheAt = Date.now();
    return results;
  })();

  try {
    return await healthRefresh;
  } finally {
    healthRefresh = null;
  }
}

function sessionFor(request) {
  const token = request.cookies.homebase_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) { sessions.delete(token); return null; }
  return session;
}

async function requireAdmin(request, reply) {
  if (!sessionFor(request)) return reply.code(401).send({ error: 'Admin sign-in required.' });
}

const app = Fastify({ logger: true, trustProxy: process.env.TRUST_PROXY === 'true' });
await mkdir(iconDir, { recursive: true });
await app.register(cookie);
await app.register(fastifyStatic, { root: path.join(process.cwd(), 'public'), prefix: '/', wildcard: false });
await app.register(fastifyStatic, { root: iconDir, prefix: '/app-icons/', wildcard: false, decorateReply: false });

app.get('/api/apps', async () => apps);
app.get('/api/apps/health', async () => refreshApplicationHealth());
app.get('/api/settings', async () => settings);
app.get('/api/session', async (request) => ({ authenticated: Boolean(sessionFor(request)), username: 'admin' }));

app.post('/api/login', async (request, reply) => {
  const password = String(request.body?.password || '');
  const expected = Buffer.from(adminPassword);
  const supplied = Buffer.from(password);
  const valid = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  if (!valid) return reply.code(401).send({ error: 'Incorrect password.' });
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { expiresAt: Date.now() + 1000 * 60 * 60 * 12 });
  reply.setCookie('homebase_session', token, { httpOnly: true, sameSite: 'strict', secure: request.protocol === 'https', path: '/', maxAge: 60 * 60 * 12 });
  return { authenticated: true, username: 'admin' };
});

app.post('/api/logout', { preHandler: requireAdmin }, async (_request, reply) => {
  sessions.delete(_request.cookies.homebase_session);
  reply.clearCookie('homebase_session', { path: '/' });
  return reply.code(204).send();
});

app.put('/api/settings', { preHandler: requireAdmin }, async (request, reply) => {
  if (!['ungrouped', 'grouped', 'tabs'].includes(request.body?.layout)) return reply.code(400).send({ error: 'A valid layout preference is required.' });
  settings = { layout: request.body.layout };
  await persistSettings();
  return settings;
});

app.post('/api/apps', { preHandler: requireAdmin }, async (request, reply) => {
  const values = normalizeApp(request.body);
  if (!values) return reply.code(400).send({ error: 'Name, category, a valid URL and a six-digit colour are required.' });
  const entry = { id: crypto.randomUUID(), ...values };
  entry.favicon = await retrieveFavicon(entry.url, entry.id);
  apps = [entry, ...apps];
  await persistApps();
  healthCacheAt = 0;
  return reply.code(201).send(entry);
});

app.put('/api/apps/:id', { preHandler: requireAdmin }, async (request, reply) => {
  const index = apps.findIndex((entry) => entry.id === request.params.id);
  const values = normalizeApp(request.body);
  if (index < 0) return reply.code(404).send({ error: 'Application not found.' });
  if (!values) return reply.code(400).send({ error: 'Name, category, a valid URL and a six-digit colour are required.' });
  const entry = { id: apps[index].id, ...values };
  entry.favicon = await retrieveFavicon(entry.url, entry.id) || apps[index].favicon || '';
  apps[index] = entry;
  await persistApps();
  healthCacheAt = 0;
  return apps[index];
});

app.delete('/api/apps/:id', { preHandler: requireAdmin }, async (request, reply) => {
  const before = apps.length;
  apps = apps.filter((entry) => entry.id !== request.params.id);
  if (apps.length === before) return reply.code(404).send({ error: 'Application not found.' });
  await persistApps();
  healthCacheAt = 0;
  return reply.code(204).send();
});

await loadApps();
await loadSettings();
await app.listen({ port, host: '0.0.0.0' });
