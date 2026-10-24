/**
 * services.test.js
 * -----------------------------------------------------------------------------
 * Pruebas de los SERVICIOS (fases 4, 5 y 6):
 *   - cola con límite de descargas simultáneas
 *   - limitador de velocidad global
 *   - validación de la configuración
 *   - historial persistente (sobrevive a un "reinicio")
 *   - programador de descargas
 *   - servidor local para la extensión (token, origen, errores)
 * -----------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { randomData, sha256, startTestServer, createManager, waitFor, isFinal } = require('./helpers');
const { Scheduler } = require('../src/services/scheduler');
const { BrowserServer } = require('../src/services/browserServer');
const { createDefaultSettings, sanitizeSettings } = require('../src/services/settingsService');

test('cola: nunca más descargas simultáneas que el límite', async () => {
  const data = randomData(1024 * 1024);
  const server = await startTestServer(data, { delayMs: 15 });
  const { manager } = createManager({ maxConcurrent: 2 });
  try {
    let maxActive = 0;
    manager.on('item-updated', () => {
      const active = manager.getAll().filter((i) => ['downloading', 'merging'].includes(i.status)).length;
      maxActive = Math.max(maxActive, active);
    });
    const ids = Array.from({ length: 5 }, () => manager.add({ url: server.url, connections: 2 }).id);
    // Nada más añadirlas: 2 corriendo y 3 esperando en cola.
    assert.equal(manager.getStats().queued, 3);
    for (const id of ids) {
      const done = await waitFor(manager, id, (i) => i.status === 'completed' || i.status === 'error', 60000);
      assert.equal(done.status, 'completed', done.error);
      assert.equal(sha256(fs.readFileSync(done.savePath)), sha256(data));
    }
    assert.equal(maxActive, 2);
  } finally {
    await manager.shutdown();
    await server.close();
  }
});

test('limitador de velocidad global (512 KB/s)', async () => {
  const data = randomData(1536 * 1024); // 1.5 MB
  const server = await startTestServer(data);
  const { manager } = createManager({ speedLimitKBps: 512 });
  try {
    const started = Date.now();
    const item = manager.add({ url: server.url, connections: 3 });
    const done = await waitFor(manager, item.id, isFinal, 30000);
    const seconds = (Date.now() - started) / 1000;
    assert.equal(done.status, 'completed', done.error);
    // 1.5 MB a 512 KB/s = 3 s (aceptamos un pequeño margen por la ráfaga inicial).
    assert.ok(seconds >= 2.4, `Fue demasiado rápido: ${seconds.toFixed(2)} s`);
    assert.ok(seconds < 6, `Fue demasiado lento: ${seconds.toFixed(2)} s`);
  } finally {
    await manager.shutdown();
    await server.close();
  }
});

test('configuración: valores fuera de rango se corrigen', () => {
  const defaults = createDefaultSettings('C:\\Users\\prueba\\Downloads');
  assert.equal(defaults.connections, 8);
  assert.match(defaults.serverToken, /^[a-f0-9]{32}$/);
  const next = sanitizeSettings(
    { connections: 99, maxConcurrent: 0, speedLimitKBps: -5, theme: 'rosa', serverPort: 80, notifications: 'sí', unknown: 1 },
    defaults,
  );
  assert.equal(next.connections, 16);
  assert.equal(next.maxConcurrent, 1);
  assert.equal(next.speedLimitKBps, 0);
  assert.equal(next.theme, 'system'); // Valor inválido: se queda el anterior
  assert.equal(next.serverPort, 1024);
  assert.equal(next.notifications, true); // Solo acepta booleanos
  assert.equal('unknown' in next, false);
});

test('historial persistente: sobrevive a un reinicio de la app', async () => {
  const data = randomData(700 * 1024);
  const server = await startTestServer(data);
  const memory = { saved: [] };
  const first = createManager({}, memory);
  let second;
  try {
    const item = first.manager.add({ url: server.url });
    await waitFor(first.manager, item.id, isFinal);
    await first.manager.shutdown(); // Guarda en "disco" (memoria compartida)

    second = createManager({ downloadDir: first.dir }, memory);
    const restored = second.manager.getAll();
    assert.equal(restored.length, 1);
    assert.equal(restored[0].status, 'completed');
    assert.equal(restored[0].fileName, 'prueba.bin');
    // Las cabeceras (cookies) nunca se envían a la interfaz.
    assert.equal('headers' in restored[0], false);
  } finally {
    await first.manager.shutdown();
    await second?.manager.shutdown();
    await server.close();
  }
});

test('programador: la descarga empieza a la hora indicada', async () => {
  const data = randomData(600 * 1024);
  const server = await startTestServer(data);
  const { manager } = createManager();
  const started = [];
  const scheduler = new Scheduler(manager, (items) => started.push(...items), 100);
  try {
    const when = Date.now() + 800;
    const item = manager.add({ url: server.url, scheduledAt: when });
    assert.equal(item.status, 'scheduled');
    assert.throws(() => manager.schedule(item.id, Date.now() - 1000), /futura/);

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(manager.get(item.id).status, 'scheduled', 'Aún no debía empezar');

    const done = await waitFor(manager, item.id, isFinal, 10000);
    assert.equal(done.status, 'completed');
    assert.equal(started.length, 1);
    assert.ok(Date.now() >= when);
  } finally {
    scheduler.stop();
    await manager.shutdown();
    await server.close();
  }
});

test('servidor local del navegador: token, origen y validaciones', async () => {
  const settings = { serverPort: 0, serverToken: 'token-de-prueba-1234567890' };
  const received = [];
  const server = new BrowserServer({
    getSettings: () => settings,
    version: '1.0.0',
    onDownload: async (payload) => {
      if (!/^https?:/.test(payload.url)) throw new Error('URL no válida');
      received.push(payload);
      return { id: 'abc' };
    },
  });
  // Puerto 0 = el sistema elige uno libre. Lo leemos del servidor real.
  await server.start();
  const port = server.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = (body, headers = {}) =>
    fetch(`${base}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LibreDescarga-Token': settings.serverToken, ...headers },
      body: JSON.stringify(body),
    });

  try {
    // /ping responde siempre, e indica si el token es válido.
    let res = await fetch(`${base}/ping`);
    assert.deepEqual(await res.json(), { ok: true, app: 'LibreDescarga', version: '1.0.0', authorized: false });
    res = await fetch(`${base}/ping`, { headers: { 'X-LibreDescarga-Token': settings.serverToken } });
    assert.equal((await res.json()).authorized, true);

    // Token incorrecto -> 401
    res = await post({ url: 'https://ejemplo.com/a.zip' }, { 'X-LibreDescarga-Token': 'malo' });
    assert.equal(res.status, 401);

    // Desde una página web (Origin http://...) -> 403 aunque el token sea bueno
    res = await post({ url: 'https://ejemplo.com/a.zip' }, { Origin: 'https://pagina-maliciosa.com' });
    assert.equal(res.status, 403);

    // Sin JSON -> 415 ; JSON roto -> 400 ; URL inválida -> 400
    res = await fetch(`${base}/download`, { method: 'POST', headers: { 'X-LibreDescarga-Token': settings.serverToken }, body: 'url=x' });
    assert.equal(res.status, 415);
    res = await fetch(`${base}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LibreDescarga-Token': settings.serverToken },
      body: '{roto',
    });
    assert.equal(res.status, 400);
    res = await post({ url: 'javascript:alert(1)' });
    assert.equal(res.status, 400);

    // Petición correcta desde una extensión -> 200
    res = await post(
      { url: 'https://ejemplo.com/a.zip', fileName: 'a.zip', referrer: 'https://ejemplo.com/', cookies: 'sesion=1' },
      { Origin: 'chrome-extension://abcdefghijklmnop' },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, id: 'abc' });
    assert.equal(received.length, 1);
    assert.equal(received[0].cookies, 'sesion=1');

    // Ruta desconocida -> 404
    res = await fetch(`${base}/otra`);
    assert.equal(res.status, 404);
  } finally {
    await server.stop();
  }
  assert.equal(server.running, false);
});

test('servidor local: puerto ocupado da un mensaje claro', async () => {
  const a = new BrowserServer({ getSettings: () => ({ serverPort: 0, serverToken: 'x'.repeat(20) }), version: '1', onDownload: () => ({}) });
  await a.start();
  const port = a.server.address().port;
  const b = new BrowserServer({ getSettings: () => ({ serverPort: port, serverToken: 'x'.repeat(20) }), version: '1', onDownload: () => ({}) });
  try {
    await assert.rejects(b.start(), /ya está en uso/);
  } finally {
    await a.stop();
    await b.stop();
  }
});
