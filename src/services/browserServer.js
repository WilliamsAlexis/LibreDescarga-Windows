/**
 * browserServer.js
 * -----------------------------------------------------------------------------
 * SERVIDOR LOCAL para la integración con el navegador.
 *
 * La extensión de Chrome/Edge no puede hablar directamente con nuestra app,
 * así que abrimos un pequeño servidor HTTP que SOLO escucha en 127.0.0.1
 * (es decir, solo es accesible desde este mismo ordenador, nunca desde la red).
 *
 * Endpoints:
 *   GET  /ping      -> responde si la app está viva (y si el token es válido).
 *   POST /download  -> recibe { url, fileName, referrer, cookies } y añade la descarga.
 *
 * Seguridad (varias capas):
 *   1. Solo escucha en 127.0.0.1.
 *   2. Exige la cabecera "X-LibreDescarga-Token" con el token de la configuración.
 *      Se compara con timingSafeEqual para no filtrar información por tiempos.
 *   3. Rechaza peticiones que vengan de páginas web normales (cabecera Origin
 *      que no sea de una extensión) y exige Content-Type JSON, lo que obliga
 *      al navegador a hacer una comprobación CORS previa que nunca aprobamos.
 *   4. Limita el tamaño del cuerpo a 64 KB.
 * -----------------------------------------------------------------------------
 */

const http = require('node:http');
const crypto = require('node:crypto');

/** Tamaño máximo del cuerpo de una petición. */
const MAX_BODY = 64 * 1024;

/**
 * Compara dos textos en tiempo constante (evita ataques de temporización).
 * @param {string} a
 * @param {string} b
 * @returns {boolean} true si son iguales.
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  // timingSafeEqual exige la misma longitud; si difieren, ya sabemos que no son iguales.
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Envía una respuesta JSON.
 * @param {http.ServerResponse} res
 * @param {number} status - Código HTTP.
 * @param {object} body - Objeto a enviar.
 * @returns {void}
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Lee el cuerpo completo de una petición (con límite de tamaño).
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const err = new Error('Cuerpo demasiado grande');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class BrowserServer {
  /**
   * @param {object} options
   * @param {() => object} options.getSettings - Configuración (serverPort, serverToken).
   * @param {(payload: object) => Promise<object>|object} options.onDownload - Qué hacer con cada URL recibida.
   * @param {string} options.version - Versión de la app (se devuelve en /ping).
   */
  constructor({ getSettings, onDownload, version }) {
    this.getSettings = getSettings;
    this.onDownload = onDownload;
    this.version = version;
    this.server = null;
    this.port = null;
  }

  /**
   * Arranca el servidor en 127.0.0.1 y el puerto configurado.
   * @returns {Promise<void>}
   * @throws {Error} Si el puerto está ocupado.
   */
  async start() {
    await this.stop();
    const { serverPort } = this.getSettings();
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        sendJson(res, err.status || 500, { ok: false, error: err.message });
      });
    });

    await new Promise((resolve, reject) => {
      server.once('error', (err) => {
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(`El puerto ${serverPort} ya está en uso. Elige otro en Configuración.`)
            : err,
        );
      });
      // '127.0.0.1' = solo conexiones desde este equipo.
      server.listen(serverPort, '127.0.0.1', resolve);
    });
    this.server = server;
    this.port = serverPort;
  }

  /**
   * Detiene el servidor si está en marcha.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.port = null;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  /** @returns {boolean} ¿Está escuchando? */
  get running() {
    return Boolean(this.server);
  }

  /**
   * Atiende una petición.
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @returns {Promise<void>}
   */
  async handle(req, res) {
    const { serverToken } = this.getSettings();
    const tokenOk = safeEqual(req.headers['x-libredescarga-token'], serverToken);

    // Bloqueamos peticiones hechas desde páginas web (solo extensiones o sin Origin).
    const origin = req.headers.origin;
    if (origin && !/^(chrome|moz|edge)-extension:\/\//.test(origin)) {
      return sendJson(res, 403, { ok: false, error: 'Origen no permitido' });
    }

    const { pathname } = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && pathname === '/ping') {
      return sendJson(res, 200, { ok: true, app: 'LibreDescarga', version: this.version, authorized: tokenOk });
    }

    if (req.method === 'POST' && pathname === '/download') {
      if (!tokenOk) return sendJson(res, 401, { ok: false, error: 'Token incorrecto' });
      if (!String(req.headers['content-type'] || '').includes('application/json')) {
        return sendJson(res, 415, { ok: false, error: 'Se esperaba JSON' });
      }

      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (err) {
        if (err.status) throw err;
        return sendJson(res, 400, { ok: false, error: 'JSON no válido' });
      }
      if (!payload || typeof payload.url !== 'string') {
        return sendJson(res, 400, { ok: false, error: 'Falta la URL' });
      }

      try {
        const result = await this.onDownload({
          url: payload.url,
          fileName: typeof payload.fileName === 'string' ? payload.fileName : '',
          referrer: typeof payload.referrer === 'string' ? payload.referrer : '',
          cookies: typeof payload.cookies === 'string' ? payload.cookies : '',
          userAgent: typeof payload.userAgent === 'string' ? payload.userAgent : '',
          page: payload.page === true,
        });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    return sendJson(res, 404, { ok: false, error: 'Ruta no encontrada' });
  }
}

module.exports = { BrowserServer, safeEqual };
