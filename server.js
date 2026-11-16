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
const authPath = path.join(dataDir, 'auth.json');
const iconDir = path.join(dataDir, 'icons');
const textSetting = (name, fallback, maxLength = 240) => {
  const value = String(process.env[name] || '').trim();
  return value ? value.slice(0, maxLength) : fallback;
};
const dashboardRefreshTime = Number(process.env.DASHBOARD_REFRESH_TIME || 60);
const defaultSettings = {
  layout: 'ungrouped',
  appTitle: textSetting('APP_TITLE', 'Homebase · Server dashboard', 80),
  appDescription: textSetting('APP_DESCRIPTION', 'A shared home-server application dashboard.', 180),
  appFavicon: '',
  brandTitle: textSetting('BRAND_TITLE', 'Homebase', 48),
  brandTagline: textSetting('BRAND_TAGLINE', 'Your private launchpad', 80),
  dashboardIntro: textSetting('DASHBOARD_INTRO', 'Everything running at home, in one calm place.', 140),
  dashboardIntroTagline: textSetting('DASHBOARD_INTRO_TAGLINE', 'A shared launchpad for the services you host. Everyone sees the same application directory.', 240),
  dashboardRefreshTime: Number.isFinite(dashboardRefreshTime) && dashboardRefreshTime >= 10 && dashboardRefreshTime <= 3600
    ? dashboardRefreshTime
    : 60,
};
const sessions = new Map();
let apps = [];
let settings = { ...defaultSettings };
let authentication = { adminHash: '', guestHash: '' };
let healthCache = [];
let healthCacheAt = 0;
let healthRefresh;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function matchesPassword(suppliedPassword, storedHash) {
  const [salt, expectedHex] = String(storedHash || '').split(':');
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const supplied = crypto.scryptSync(String(suppliedPassword || ''), salt, 64);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
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
    settings = {
      layout,
      appTitle: String(parsed?.appTitle || defaultSettings.appTitle).slice(0, 80),
      appDescription: String(parsed?.appDescription || defaultSettings.appDescription).slice(0, 180),
      appFavicon: String(parsed?.appFavicon || defaultSettings.appFavicon).slice(0, 500),
      brandTitle: String(parsed?.brandTitle || defaultSettings.brandTitle).slice(0, 48),
      brandTagline: String(parsed?.brandTagline || defaultSettings.brandTagline).slice(0, 80),
      dashboardIntro: String(parsed?.dashboardIntro || defaultSettings.dashboardIntro).slice(0, 140),
      dashboardIntroTagline: String(parsed?.dashboardIntroTagline || defaultSettings.dashboardIntroTagline).slice(0, 240),
      dashboardRefreshTime: Number.isFinite(Number(parsed?.dashboardRefreshTime)) && Number(parsed.dashboardRefreshTime) >= 10 && Number(parsed.dashboardRefreshTime) <= 3600
        ? Number(parsed.dashboardRefreshTime)
        : defaultSettings.dashboardRefreshTime,
    };
    if (JSON.stringify(settings) !== JSON.stringify(parsed)) await persistSettings();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await persistSettings();
  }
}

async function persistSettings() {
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function storeUploadedFavicon(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|svg\+xml)|image\/x-icon);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 1024 * 1024) return null;
  const extension = { 'image/png':'png', 'image/jpeg':'jpg', 'image/svg+xml':'svg', 'image/x-icon':'ico' }[match[1]];
  if (!extension) return null;
  const filename = `homebase-favicon.${extension}`;
  writeFileSync(path.join(dataDir, filename), bytes);
  return `/homebase-assets/${filename}`;
}

async function loadAuthentication() {
  try {
    const content = await readFile(authPath, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed?.adminHash) throw new Error('The authentication data has no admin password.');
    authentication = { adminHash: String(parsed.adminHash), guestHash: String(parsed.guestHash || '') };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    authentication = { adminHash: '', guestHash: '' };
  }
}

async function persistAuthentication() {
  writeFileSync(authPath, `${JSON.stringify(authentication, null, 2)}\n`, 'utf8');
}

function normalizeApp(input) {
  const name = String(input?.name || '').trim().slice(0, 48);
  const category = String(input?.category || '').trim().slice(0, 28);
  const description = String(input?.description || '').trim().slice(0, 120);
  const icon = Array.from(String(input?.icon || '').trim()).slice(0, 2).join('');
  const iconMode = input?.iconMode === 'emoji' ? 'emoji' : 'favicon';
  const color = String(input?.color || '#5a8cf0');
  let url;
  try { const parsed = new URL(String(input?.url || '').trim()); url = ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : ''; } catch { url = ''; }
  if (!name || !category || !url || !/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  return { name, category, url, description, icon, iconMode, color };
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
  if (Date.now() - healthCacheAt < settings.dashboardRefreshTime * 1000) return healthCache;

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

async function requireAuthenticated(request, reply) {
  if (!sessionFor(request)) return reply.code(401).send({ error: 'Sign-in required.' });
}

async function requireViewer(request, reply) {
  if (authentication.guestHash && !sessionFor(request)) return reply.code(401).send({ error: 'Sign-in required.' });
}

async function requireAdmin(request, reply) {
  if (!authentication.adminHash) return;
  if (sessionFor(request)?.role !== 'admin') return reply.code(401).send({ error: 'Admin sign-in required.' });
}

const app = Fastify({ logger: true, trustProxy: process.env.TRUST_PROXY === 'true' });
await mkdir(iconDir, { recursive: true });
await app.register(cookie);
await app.register(fastifyStatic, { root: path.join(process.cwd(), 'public'), prefix: '/', wildcard: false });
await app.register(fastifyStatic, { root: iconDir, prefix: '/app-icons/', wildcard: false, decorateReply: false });
await app.register(fastifyStatic, { root: dataDir, prefix: '/homebase-assets/', wildcard: false, decorateReply: false });

app.get('/api/apps', { preHandler: requireViewer }, async () => apps);
app.get('/api/apps/health', { preHandler: requireViewer }, async () => refreshApplicationHealth());
app.get('/api/config', { preHandler: requireViewer }, async () => settings);
app.get('/api/settings', { preHandler: requireViewer }, async () => ({ ...settings, guestEnabled: Boolean(authentication.guestHash), adminConfigured: Boolean(authentication.adminHash) }));
app.get('/api/auth', { preHandler: requireAdmin }, async () => ({ guestEnabled: Boolean(authentication.guestHash), adminConfigured: Boolean(authentication.adminHash) }));
app.get('/api/session', async (request) => {
  const session = sessionFor(request);
  return { authenticated: Boolean(session) || !authentication.adminHash, role: session?.role || (!authentication.adminHash ? 'admin' : null), authenticationRequired: Boolean(authentication.guestHash), adminConfigured: Boolean(authentication.adminHash) };
});

app.post('/api/login', async (request, reply) => {
  if (!authentication.adminHash) return { authenticated: true, role: 'admin' };
  const password = String(request.body?.password || '');
  const adminMatch = matchesPassword(password, authentication.adminHash);
  const guestMatch = Boolean(authentication.guestHash) && matchesPassword(password, authentication.guestHash);
  const adminOnly = Boolean(request.body?.adminOnly);
  if (!adminMatch && (!guestMatch || adminOnly)) {
    request.log.warn({ event: 'authentication_failed', requestedRole: adminOnly ? 'admin' : 'viewer' }, 'Failed authentication attempt');
    return reply.code(401).send({ error: 'Incorrect password.' });
  }
  const role = adminMatch ? 'admin' : 'guest';
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { role, expiresAt: Date.now() + 1000 * 60 * 60 * 12 });
  reply.setCookie('homebase_session', token, { httpOnly: true, sameSite: 'strict', secure: request.protocol === 'https', path: '/', maxAge: 60 * 60 * 12 });
  return { authenticated: true, role };
});

app.post('/api/logout', { preHandler: requireAuthenticated }, async (_request, reply) => {
  sessions.delete(_request.cookies.homebase_session);
  reply.clearCookie('homebase_session', { path: '/' });
  return reply.code(204).send();
});

app.put('/api/settings', { preHandler: requireAdmin }, async (request, reply) => {
  const input = request.body || {};
  const layout = ['ungrouped', 'grouped', 'tabs'].includes(input.layout) ? input.layout : null;
  const refreshTime = Number(input.dashboardRefreshTime);
  const text = (name, maximum) => String(input[name] || '').trim().slice(0, maximum);
  const faviconMode = input.appFaviconMode === 'upload' ? 'upload' : 'default';
  const uploadedFavicon = input.appFaviconUpload ? storeUploadedFavicon(input.appFaviconUpload) : null;
  if (input.appFaviconUpload && !uploadedFavicon) return reply.code(400).send({ error: 'Upload a PNG, JPEG, SVG, or ICO favicon smaller than 1 MB.' });
  if (!layout || !text('appTitle', 80) || !text('brandTitle', 48) || !text('dashboardIntro', 140) || !Number.isFinite(refreshTime) || refreshTime < 10 || refreshTime > 3600) {
    return reply.code(400).send({ error: 'Complete the required settings and use a refresh interval between 10 and 3600 seconds.' });
  }
  settings = {
    layout,
    appTitle: text('appTitle', 80),
    appDescription: text('appDescription', 180),
    appFavicon: faviconMode === 'default' ? '' : (uploadedFavicon || settings.appFavicon || ''),
    brandTitle: text('brandTitle', 48),
    brandTagline: text('brandTagline', 80),
    dashboardIntro: text('dashboardIntro', 140),
    dashboardIntroTagline: text('dashboardIntroTagline', 240),
    dashboardRefreshTime: refreshTime,
  };
  await persistSettings();
  return { ...settings, guestEnabled: Boolean(authentication.guestHash), adminConfigured: Boolean(authentication.adminHash) };
});

app.put('/api/auth', { preHandler: requireAdmin }, async (request, reply) => {
  const input = request.body || {};
  const adminPassword = String(input.adminPassword || '');
  const guestPassword = String(input.guestPassword || '');
  const guestEnabled = Boolean(input.guestEnabled);
  if (adminPassword) {
    if (adminPassword.length < 12) return reply.code(400).send({ error: 'The new admin password must have at least 12 characters.' });
    authentication.adminHash = hashPassword(adminPassword);
  }
  if (guestEnabled && !authentication.adminHash) return reply.code(400).send({ error: 'Set an administrator password before enabling guest access.' });
  if (guestEnabled) {
    if (guestPassword) {
      if (guestPassword.length < 12) return reply.code(400).send({ error: 'The guest password must have at least 12 characters.' });
      authentication.guestHash = hashPassword(guestPassword);
    } else if (!authentication.guestHash) {
      return reply.code(400).send({ error: 'Enter a guest password to enable dashboard sign-in.' });
    }
  } else {
    authentication.guestHash = '';
  }
  await persistAuthentication();
  return { guestEnabled: Boolean(authentication.guestHash), adminConfigured: Boolean(authentication.adminHash) };
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
await loadAuthentication();
await app.listen({ port, host: '0.0.0.0' });
