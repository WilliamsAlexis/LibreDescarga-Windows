/**
 * http.js
 * -----------------------------------------------------------------------------
 * Funciones de red de bajo nivel construidas sobre los módulos nativos
 * `http` y `https` de Node.js:
 *
 *   - request(): hace una petición siguiendo redirecciones (301, 302...),
 *                con tiempo de espera y posibilidad de cancelarla.
 *   - probe():   "sondea" una URL para saber el tamaño del archivo, su nombre
 *                y si el servidor acepta descargas por partes (HTTP Range).
 *
 * ¿Qué es HTTP Range? Una cabecera que pide solo un trozo del archivo:
 *     Range: bytes=1000-1999   ->  "dame los bytes del 1000 al 1999"
 * Si el servidor la entiende responde con el código 206 (Partial Content).
 * Gracias a eso podemos abrir varias conexiones, cada una con un trozo, y
 * también reanudar una descarga pidiendo "desde donde me quedé".
 * -----------------------------------------------------------------------------
 */

const http = require('node:http');
const https = require('node:https');
const { resolveFileName } = require('./fileName');

/** Cabeceras que enviamos siempre (parecemos un navegador normal). */
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 LibreDescarga/1.0',
  Accept: '*/*',
  // "identity" = sin comprimir. Es importante: si el servidor comprimiera con
  // gzip, los rangos de bytes no corresponderían al archivo real.
  'Accept-Encoding': 'identity',
};

/**
 * Error HTTP con información extra para decidir si vale la pena reintentar.
 */
class HttpError extends Error {
  /**
   * @param {string} message - Mensaje legible.
   * @param {number} statusCode - Código HTTP (404, 500...).
   * @param {object} [headers] - Cabeceras de la respuesta (para leer Retry-After).
   */
  constructor(message, statusCode, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    // "Retry-After: 30" = el servidor pide esperar 30 s antes de volver a intentarlo.
    const retryAfter = Number(headers['retry-after']);
    this.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
    // Los errores 4xx (salvo 408 "timeout" y 429 "demasiadas peticiones")
    // significan que la petición está mal (p. ej. 404 = no existe), así que
    // reintentar no sirve de nada: los marcamos como "fatales".
    this.fatal = statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
  }
}

/**
 * Hace UNA petición HTTP/HTTPS (sin seguir redirecciones).
 * @param {string} url - Dirección completa.
 * @param {object} options
 * @param {string} options.method - Método HTTP (GET, HEAD...).
 * @param {object} options.headers - Cabeceras extra.
 * @param {AbortSignal} [options.signal] - Para cancelar la petición.
 * @param {number} options.timeout - Milisegundos sin actividad antes de abortar.
 * @returns {Promise<http.IncomingMessage>} La respuesta (el cuerpo se lee como stream).
 */
function singleRequest(url, { method, headers, signal, timeout }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new HttpError(`URL no válida: ${url}`, 400));
    }
    // Elegimos el módulo según el protocolo.
    const lib = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
    if (!lib) return reject(new HttpError(`Protocolo no soportado: ${parsed.protocol}`, 400));

    const req = lib.request(parsed, { method, headers: { ...DEFAULT_HEADERS, ...headers }, signal }, resolve);

    // Si el socket pasa `timeout` ms sin recibir datos, lo destruimos.
    // Esto también protege la lectura del cuerpo (conexiones "colgadas").
    req.setTimeout(timeout, () => {
      const err = new Error(`Sin respuesta del servidor durante ${Math.round(timeout / 1000)} s`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', reject);
    req.end(); // Enviamos la petición (no tiene cuerpo).
  });
}

/**
 * Hace una petición siguiendo hasta `maxRedirects` redirecciones.
 * @param {string} url - URL inicial.
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.headers={}]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeout=30000]
 * @param {number} [options.maxRedirects=10]
 * @returns {Promise<{res: http.IncomingMessage, url: string}>} Respuesta final y URL final.
 */
async function request(url, { method = 'GET', headers = {}, signal, timeout = 30000, maxRedirects = 10 } = {}) {
  let currentUrl = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await singleRequest(currentUrl, { method, headers, signal, timeout });
    const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location;
    if (!isRedirect) return { res, url: currentUrl };

    // Descartamos el cuerpo de la redirección y calculamos la nueva URL
    // (puede venir relativa, por eso usamos new URL(location, base)).
    res.resume();
    currentUrl = new URL(res.headers.location, currentUrl).toString();
  }
  throw new HttpError('Demasiadas redirecciones', 310);
}

/**
 * Lee el tamaño total de una cabecera Content-Range: "bytes 0-0/12345" -> 12345.
 * @param {string|undefined} header
 * @returns {number|null} Tamaño total o null si es desconocido ("*").
 */
function totalFromContentRange(header) {
  const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(header || '');
  return match ? Number(match[1]) : null;
}

/**
 * Sondea una URL para conocer el archivo antes de descargarlo.
 * Truco: pedimos solo el primer byte (Range: bytes=0-0). Si el servidor
 * responde 206 sabemos que acepta rangos y la cabecera Content-Range nos
 * dice el tamaño total. Si responde 200, no acepta rangos.
 * @param {string} url - URL a sondear.
 * @param {object} [options]
 * @param {object} [options.headers] - Cabeceras extra (Referer, Cookie...).
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{finalUrl: string, totalBytes: number|null, resumable: boolean,
 *           fileName: string, contentType: string}>}
 */
async function probe(url, { headers = {}, signal } = {}) {
  let { res, url: finalUrl } = await request(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal });

  // 416 = "rango no satisfacible": suele pasar con archivos vacíos. Volvemos
  // a preguntar sin Range para obtener la respuesta normal.
  if (res.statusCode === 416) {
    res.resume();
    ({ res, url: finalUrl } = await request(url, { headers, signal }));
  }

  // Ya tenemos las cabeceras: cerramos la conexión sin leer el cuerpo.
  res.destroy();

  if (res.statusCode >= 400) {
    throw new HttpError(`El servidor respondió ${res.statusCode} ${res.statusMessage || ''}`.trim(), res.statusCode, res.headers);
  }

  let totalBytes = null;
  let resumable = false;
  if (res.statusCode === 206) {
    totalBytes = totalFromContentRange(res.headers['content-range']);
    // Solo es reanudable de verdad si conocemos el tamaño total.
    resumable = totalBytes !== null;
  } else if (res.headers['content-length'] !== undefined) {
    const length = Number(res.headers['content-length']);
    totalBytes = Number.isFinite(length) ? length : null;
  }

  return {
    finalUrl,
    totalBytes,
    resumable,
    contentType: res.headers['content-type'] || '',
    fileName: resolveFileName({
      url: finalUrl,
      contentDisposition: res.headers['content-disposition'],
      contentType: res.headers['content-type'],
    }),
  };
}

module.exports = { request, probe, HttpError, totalFromContentRange, DEFAULT_HEADERS };
