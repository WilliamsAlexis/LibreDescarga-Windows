/**
 * helpers.js (pruebas)
 * -----------------------------------------------------------------------------
 * Utilidades para las pruebas automáticas:
 *   - Un SERVIDOR HTTP LOCAL configurable que imita servidores reales:
 *     con o sin soporte de Range, sin tamaño conocido, lento, o que corta
 *     la conexión a propósito (para probar los reintentos).
 *   - Un creador de gestores de descargas con almacenamiento en memoria.
 *   - Funciones para esperar estados y calcular hashes.
 * -----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { DownloadManager } = require('../src/services/downloadManager');
const { SpeedLimiter } = require('../src/services/speedLimiter');
const { createDefaultSettings } = require('../src/services/settingsService');

/**
 * Crea datos aleatorios (así comprobamos que cada byte llega en su sitio).
 * @param {number} size - Tamaño en bytes.
 * @returns {Buffer}
 */
function randomData(size) {
  return crypto.randomBytes(size);
}

/**
 * SHA-256 de un buffer.
 * @param {Buffer} buffer
 * @returns {string}
 */
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Arranca un servidor de pruebas.
 * @param {Buffer} data - Contenido del archivo que sirve.
 * @param {object} [opts]
 * @param {boolean} [opts.range=true] - ¿Acepta HTTP Range?
 * @param {boolean} [opts.chunked=false] - true = no envía Content-Length (tamaño desconocido).
 * @param {number} [opts.delayMs=0] - Pausa entre trozos (para simular un servidor lento).
 * @param {number} [opts.chunkSize=65536] - Tamaño de cada trozo enviado.
 * @param {number} [opts.failAfterBytes=0] - Si > 0, la PRIMERA petición de cada rango se corta tras esos bytes.
 * @param {string} [opts.fileName='prueba.bin'] - Nombre en Content-Disposition.
 * @returns {Promise<{url: string, close: () => Promise<void>, stats: {requests: number, cuts: number}}>}
 */
async function startTestServer(data, opts = {}) {
  const { range = true, chunked = false, delayMs = 0, chunkSize = 65536, failAfterBytes = 0, fileName = 'prueba.bin' } = opts;
  const stats = { requests: 0, cuts: 0 };
  const alreadyCut = new Set();
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    stats.requests++;
    if (req.url.startsWith('/404')) {
      res.writeHead(404);
      return res.end('No existe');
    }

    let start = 0;
    let end = data.length - 1;
    let status = 200;
    const match = range && /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (match) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
      status = 206;
      if (start >= data.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
        return res.end();
      }
    }

    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${fileName}"` };
    if (range) headers['Accept-Ranges'] = 'bytes';
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
    if (!chunked) headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);

    let pos = start;
    let sent = 0;
    const shouldCut = failAfterBytes > 0 && end - start + 1 > failAfterBytes && !alreadyCut.has(start);
    while (pos <= end) {
      if (res.destroyed) return;
      if (shouldCut && sent >= failAfterBytes) {
        alreadyCut.add(start);
        stats.cuts++;
        res.destroy(); // Cortamos la conexión a mitad: el cliente debe reintentar.
        return;
      }
      const next = Math.min(end + 1, pos + chunkSize);
      const ok = res.write(data.subarray(pos, next));
      sent += next - pos;
      pos = next;
      if (!ok) {
        // Esperamos a que se vacíe el búfer (o a que el cliente cierre), y quitamos
        // ambos listeners al terminar para no acumularlos.
        await new Promise((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.on('drain', done);
          res.on('close', done);
        });
      }
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    res.end();
  });

  // Guardamos los sockets para poder cerrarlos todos al terminar la prueba.
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/archivos/prueba.bin`,
    base: `http://127.0.0.1:${port}`,
    stats,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * Crea una carpeta temporal vacía para una prueba.
 * @returns {string}
 */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'libredescarga-test-'));
}

/**
 * Crea un gestor de descargas con almacenamiento en memoria.
 * @param {object} [overrides] - Cambios sobre la configuración por defecto.
 * @param {{saved: object[]}} [memory] - Almacenamiento compartido (para simular reinicios).
 * @param {{mediaTools?: object}} [extra] - Dependencias opcionales (herramientas de vídeo).
 * @returns {{manager: DownloadManager, settings: object, memory: {saved: object[]}, dir: string}}
 */
function createManager(overrides = {}, memory = { saved: [] }, extra = {}) {
  const dir = overrides.downloadDir || tempDir();
  const settings = { ...createDefaultSettings(dir), downloadDir: dir, ...overrides };
  const manager = new DownloadManager({
    storage: {
      load: () => structuredClone(memory.saved),
      save: (items) => {
        memory.saved = structuredClone(items);
      },
    },
    getSettings: () => settings,
    limiter: new SpeedLimiter(),
    mediaTools: extra.mediaTools || null,
  });
  manager.init();
  return { manager, settings, memory, dir };
}

/**
 * Espera a que una descarga cumpla una condición.
 * @param {DownloadManager} manager
 * @param {string} id
 * @param {(item: object) => boolean} predicate
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<object>} La descarga en el momento en que se cumplió.
 */
function waitFor(manager, id, predicate, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const current = manager.get(id);
    if (current && predicate(current)) return resolve(manager.toPublic(current));
    const timer = setTimeout(() => {
      manager.off('item-updated', onUpdate);
      reject(new Error(`Tiempo agotado esperando a la descarga (estado: ${manager.get(id)?.status})`));
    }, timeoutMs);
    function onUpdate(item) {
      if (item.id === id && predicate(item)) {
        clearTimeout(timer);
        manager.off('item-updated', onUpdate);
        resolve(item);
      }
    }
    manager.on('item-updated', onUpdate);
  });
}

/** Estados finales de una descarga. */
const isFinal = (item) => ['completed', 'error', 'canceled', 'paused'].includes(item.status);

module.exports = { randomData, sha256, startTestServer, tempDir, createManager, waitFor, isFinal };
