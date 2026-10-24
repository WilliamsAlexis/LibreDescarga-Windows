/**
 * engine.test.js
 * -----------------------------------------------------------------------------
 * Pruebas del MOTOR DE DESCARGA (fases 2 y 3):
 *   - descarga simple y por segmentos (los bytes deben ser idénticos)
 *   - servidor sin Range y sin tamaño conocido
 *   - reintentos cuando el servidor corta la conexión
 *   - pausa, "reinicio de la app" y reanudación
 *   - cancelación, hash SHA-256, errores 404 y nombres repetidos
 *   - una descarga REAL desde internet
 *
 * Ejecutar con:  npm test
 * -----------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { randomData, sha256, startTestServer, createManager, waitFor, isFinal } = require('./helpers');
const { buildSegments } = require('../src/services/downloadTask');
const { resolveFileName, sanitizeFileName } = require('../src/utils/fileName');
const { categorize } = require('../src/utils/categories');
const { probe } = require('../src/utils/http');

test('utilidades: nombres de archivo y categorías', () => {
  assert.equal(resolveFileName({ url: 'https://x.com/a/mi%20video.mp4?x=1' }), 'mi video.mp4');
  assert.equal(resolveFileName({ url: 'https://x.com/d', contentDisposition: "attachment; filename*=UTF-8''informe%20a%C3%B1o.pdf" }), 'informe año.pdf');
  assert.equal(resolveFileName({ url: 'https://x.com/descargar', contentType: 'application/zip' }), 'descargar.zip');
  assert.equal(sanitizeFileName('a<b>:c?.txt'), 'a_b__c_.txt');
  assert.equal(sanitizeFileName('con.txt'), '_con.txt');
  assert.equal(categorize('peli.MKV'), 'video');
  assert.equal(categorize('setup.exe'), 'programs');
  assert.equal(categorize('raro.xyz'), 'other');
});

test('segmentos: reparto correcto del archivo', () => {
  const segs = buildSegments(10 * 1024 * 1024, true, 8);
  assert.equal(segs.length, 8);
  assert.equal(segs[0].start, 0);
  assert.equal(segs.at(-1).end, 10 * 1024 * 1024 - 1);
  // Cada segmento empieza justo donde acaba el anterior (sin huecos ni solapes).
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].start, segs[i - 1].end + 1);
  // Archivo pequeño: no se divide en trozos menores de 512 KB.
  assert.equal(buildSegments(600 * 1024, true, 16).length, 1);
  // Sin Range: un único segmento.
  assert.equal(buildSegments(10 * 1024 * 1024, false, 8).length, 1);
});

test('descarga por segmentos (8 conexiones) con bytes idénticos', async () => {
  const data = randomData(6 * 1024 * 1024 + 123);
  const server = await startTestServer(data);
  const { manager, dir } = createManager();
  try {
    const item = manager.add({ url: server.url, connections: 8 });
    const done = await waitFor(manager, item.id, isFinal);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(done.segments.length, 8);
    assert.equal(done.resumable, true);
    assert.equal(done.fileName, 'prueba.bin'); // Nombre tomado de Content-Disposition
    assert.equal(path.dirname(done.savePath), path.join(dir, 'Otros')); // Carpeta de su categoría
    assert.equal(sha256(fs.readFileSync(done.savePath)), sha256(data));
    assert.equal(fs.existsSync(`${done.savePath}.ldtmp`), false, 'La carpeta temporal debe borrarse');
  } finally {
    await manager.shutdown();
    await server.close();
  }
});

test('servidor SIN soporte de Range: descarga normal con 1 conexión', async () => {
  const data = randomData(2 * 1024 * 1024);
  const server = await startTestServer(data, { range: false });
  const { manager } = createManager();
  try {
    const item = manager.add({ url: server.url, connections: 8 });
    const done = await waitFor(manager, item.id, isFinal);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(done.resumable, false);
    assert.equal(done.segments.length, 1);
    assert.equal(sha256(fs.readFileSync(done.savePath)), sha256(data));
  } finally {
    await manager.shutdown();
    await server.close();
  }
});

test('tamaño desconocido (sin Content-Length)', async () => {
  const data = randomData(1024 * 1024 + 7);
  const server = await startTestServer(data, { range: false, chunked: true });
  const { manager } = createManager();
  try {
    const item = manager.add({ url: server.url });
    const done = await waitFor(manager, item.id, isFinal);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(done.totalBytes, data.length); // Se calcula al terminar
    assert.equal(sha256(fs.readFileSync(done.savePath)), sha256(data));
  } finally {
    await manager.shutdown();
    await server.close();
  }
});

test('reintentos automáticos cuando el servidor corta la conexión', async () => {
  const data = randomData(4 * 1024 * 1024);
  // La primera petición de cada segmento se corta tras 200 KB.
  const server = await startTestServer(data, { failAfterBytes: 200 * 1024 });
  const { manager } = createManager();
  try {
    const item = manager.add({ url: server.url, connections: 4 });
    let sawRetry = false;
    manager.on('item-updated', (i) => {
      if (i.id === item.id && i.retryInfo) sawRetry = true;
    });
    const done = await waitFor(manager, item.id, isFinal, 60000);
    assert.equal(done.status, 'completed', done.error);
    assert.ok(server.stats.cuts >= 4, `Debió haber cortes (hubo ${server.stats.cuts})`);
    assert.ok(sawRetry, 'Debió mostrarse un mensaje de reintento');
    assert.equal(sha256(fs.readFileSync(done.savePath)), sha256(data));
  } finally {
    await manager.shutdown();
    await server.close();
  }
});

test('pausa, cierre de la app y reanudación desde donde quedó', async () => {
  const data = randomData(8 * 1024 * 1024);
  // Servidor lento (≈ 64 KB cada 20 ms por conexión) para poder pausar a mitad.
  const server = await startTestServer(data, { delayMs: 20 });
  const memory = { saved: [] };
  const first = createManager({}, memory);
  let second;
  try {
    const item = first.manager.add({ url: server.url, connections: 4 });
    await waitFor(first.manager, item.id, (i) => i.downloadedBytes > data.length * 0.25);
    first.manager.pause(item.id);
    const paused = await waitFor(first.manager, item.id, isFinal);
    assert.equal(paused.status, 'paused');
    const downloadedAtPause = paused.downloadedBytes;
    assert.ok(downloadedAtPause > 0 && downloadedAtPause < data.length);

    // Las partes deben estar en disco.
    const parts = fs.readdirSync(`${paused.savePath}.ldtmp`);
    assert.equal(parts.length, 4);

    // "Cerramos la app": cierre ordenado y nuevo gestor que lee lo guardado.
    await first.manager.shutdown();
    const requestsBefore = server.stats.requests;
    second = createManager({ downloadDir: first.dir }, memory);
    const restored = second.manager.get(item.id);
    assert.equal(restored.status, 'paused');
    assert.ok(restored.downloadedBytes >= downloadedAtPause * 0.9);

    second.manager.resume(item.id);
    const done = await waitFor(second.manager, item.id, isFinal, 60000);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(sha256(fs.readFileSync(done.savePath)), sha256(data));
    // Al reanudar solo se piden los 4 segmentos pendientes (sin volver a sondear).
    assert.equal(server.stats.requests - requestsBefore, 4);
  } finally {
    await first.manager.shutdown();
    await second?.manager.shutdown();
    await server.close();
  }
});

test('cancelar borra las partes temporales', async () => {
  const data = randomData(8 * 1024 * 1024);
  // Lento a propósito (≈ 2 s por segmento) para cancelar con seguridad a mitad de descarga.
  const server = await startTestServer(data, { delayMs: 60 });
  const { manager } = createManager();
  try {
    const item = manager.add({ url: server.url, connections: 4 });
    const running = await waitFor(manager, item.id, (i) => i.status === 'downloading' && i.downloadedBytes > 0 && i.savePath);
    await manager.cancel(item.id);
    const canceled = manager.toPublic(manager.get(item.id));
    assert.equal(canceled.status, 'canceled');
    assert.equal(fs.existsSync(`${running.savePath}.ldtmp`), false);
    assert.equal(fs.existsSync(running.savePath), false);
  } finally {
    await manager.shutdown();
    await server.close();
  }
});

test('verificación SHA-256: correcta e incorrecta', async () => {
  const data = randomData(1024 * 1024);
  const server = await startTestServer(data);
  const { manager } = createManager();
  try {
    const ok = manager.add({ url: server.url, expectedHash: sha256(data).toUpperCase() });
    const bad = manager.add({ url: server.url, expectedHash: 'a'.repeat(64) });
    const doneOk = await waitFor(manager, ok.id, isFinal);
    const doneBad = await waitFor(manager, bad.id, isFinal);
    assert.equal(doneOk.hashOk, true);
    assert.equal(doneBad.hashOk, false);
    assert.equal(doneBad.status, 'completed');
    // Dos descargas con el mismo nombre no se pisan: "prueba (1).bin".
    assert.notEqual(doneOk.savePath, doneBad.savePath);
    assert.throws(() => manager.add({ url: server.url, expectedHash: 'xyz' }), /SHA-256/);
  } finally {
    await manager.shutdown();
    await server.close();
  }
});

test('error 404: falla sin reintentar y con mensaje claro', async () => {
  const server = await startTestServer(randomData(10));
  const { manager } = createManager();
  try {
    const started = Date.now();
    const item = manager.add({ url: `${server.base}/404/archivo.zip` });
    const done = await waitFor(manager, item.id, isFinal);
    assert.equal(done.status, 'error');
    assert.match(done.error, /404/);
    assert.ok(Date.now() - started < 3000, 'Un 404 no debe reintentarse');
    assert.throws(() => manager.add({ url: 'ftp://servidor/archivo' }), /http/);
    assert.throws(() => manager.add({ url: 'esto no es una url' }), /no es válida/);
  } finally {
    await manager.shutdown();
    await server.close();
  }
});

/** Servidores públicos de archivos de prueba de 10 MB (se usa el primero que responda). */
const REAL_TEST_URLS = [
  'http://ipv4.download.thinkbroadband.com/10MB.zip',
  'https://proof.ovh.net/files/10Mb.dat',
  'http://speedtest.tele2.net/10MB.zip',
];

test('descarga REAL desde internet (archivo público de 10 MB)', { timeout: 240000 }, async (t) => {
  // Elegimos un servidor que responda ahora mismo (a veces alguno limita las peticiones).
  let url = null;
  for (const candidate of REAL_TEST_URLS) {
    try {
      const info = await probe(candidate, { signal: AbortSignal.timeout(10000) });
      if (info.totalBytes === 10 * 1024 * 1024) {
        url = candidate;
        break;
      }
    } catch {
      // Probamos el siguiente.
    }
  }
  if (!url) {
    t.skip('Ningún servidor de prueba respondió (¿sin internet?)');
    return;
  }

  const { manager } = createManager();
  try {
    const item = manager.add({ url, connections: 8 });
    const done = await waitFor(manager, item.id, isFinal, 220000);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(done.totalBytes, 10 * 1024 * 1024);
    assert.equal(fs.statSync(done.savePath).size, 10 * 1024 * 1024);
    assert.equal(done.segments.length, 8);
    t.diagnostic(`${url} -> ${done.savePath} con ${done.segments.length} conexiones`);
  } finally {
    await manager.shutdown();
  }
});
