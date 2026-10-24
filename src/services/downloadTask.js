/**
 * downloadTask.js
 * -----------------------------------------------------------------------------
 * Representa UNA descarga en ejecución. Es el "motor" de la aplicación.
 *
 * Ciclo de vida de una descarga:
 *
 *   1. SONDEO      -> preguntamos al servidor el tamaño, el nombre y si acepta
 *                     rangos (HTTP Range).
 *   2. SEGMENTOS   -> si acepta rangos, dividimos el archivo en N trozos y
 *                     abrimos N conexiones a la vez. Cada trozo se guarda en
 *                     su propio archivo "partN" dentro de una carpeta temporal
 *                     "<archivo>.ldtmp".
 *   3. PAUSA       -> cortamos las conexiones. Lo descargado queda en disco.
 *      REANUDAR    -> miramos cuánto mide cada "partN" y pedimos al servidor
 *                     solo lo que falta (Range: bytes=desde-hasta).
 *                     Como el progreso real se lee del DISCO, la reanudación
 *                     funciona incluso tras cerrar la app o un apagón.
 *   4. UNIÓN       -> al terminar todos los trozos los juntamos en orden en el
 *                     archivo final y borramos la carpeta temporal.
 *
 * Si el servidor NO acepta rangos, se usa una sola conexión normal (y si se
 * pausa, al reanudar empieza de cero porque no hay otra forma).
 *
 * Esta clase NO depende de Electron: se puede probar con Node.js puro.
 * -----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { finished } = require('node:stream/promises');

const { request, probe, HttpError, totalFromContentRange } = require('../utils/http');
const { categorize, getCategoryDirectory } = require('../utils/categories');
const { uniquePath } = require('../utils/fileName');
const { sleep } = require('../utils/sleep');

/** Tamaño mínimo de cada segmento: no merece la pena dividir en trozos diminutos. */
const MIN_SEGMENT_SIZE = 512 * 1024; // 512 KB

/** Cada cuánto (ms) recalculamos la velocidad y avisamos del progreso. */
const PROGRESS_INTERVAL = 500;

/** Ventana de tiempo (ms) usada para promediar la velocidad. */
const SPEED_WINDOW = 3000;

/**
 * Convierte errores técnicos en mensajes comprensibles en español.
 * @param {Error} err - Error original.
 * @returns {string} Mensaje para mostrar al usuario.
 */
function friendlyError(err) {
  const messages = {
    ENOTFOUND: 'No se encontró el servidor (¿hay conexión a internet?)',
    EAI_AGAIN: 'No se pudo resolver el nombre del servidor (¿hay conexión a internet?)',
    ECONNREFUSED: 'El servidor rechazó la conexión',
    ECONNRESET: 'Se perdió la conexión con el servidor',
    EPIPE: 'Se perdió la conexión con el servidor',
    ENOSPC: 'No hay espacio suficiente en el disco',
    EACCES: 'No hay permiso para escribir en la carpeta de destino',
    EPERM: 'No hay permiso para escribir en la carpeta de destino',
    EROFS: 'La carpeta de destino es de solo lectura',
    CERT_HAS_EXPIRED: 'El certificado de seguridad del servidor ha caducado',
  };
  return messages[err?.code] || err?.message || String(err);
}

/**
 * Indica si un error NO merece reintento (por ejemplo, disco lleno o 404).
 * @param {Error} err
 * @returns {boolean}
 */
function isFatal(err) {
  return Boolean(err?.fatal) || ['ENOSPC', 'EACCES', 'EPERM', 'EROFS'].includes(err?.code);
}

/**
 * Crea un error marcado como fatal (no se reintentará).
 * @param {string} message
 * @returns {Error}
 */
function fatalError(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

/**
 * Calcula la lista de segmentos en que se divide un archivo.
 * @param {number|null} totalBytes - Tamaño total (null si es desconocido).
 * @param {boolean} resumable - ¿Acepta el servidor rangos?
 * @param {number} connections - Conexiones deseadas (1..16).
 * @returns {Array<{index:number,start:number,end:number|null,downloaded:number,done:boolean}>}
 *          `end` es inclusivo (el último byte del trozo). null = hasta el final.
 */
function buildSegments(totalBytes, resumable, connections) {
  // Sin rangos o sin tamaño conocido: un único segmento con todo el archivo.
  if (!resumable || !totalBytes) {
    return [{ index: 0, start: 0, end: totalBytes ? totalBytes - 1 : totalBytes === 0 ? -1 : null, downloaded: 0, done: false }];
  }
  // Nunca más segmentos que conexiones, ni trozos menores que MIN_SEGMENT_SIZE.
  const count = Math.max(1, Math.min(connections, 16, Math.floor(totalBytes / MIN_SEGMENT_SIZE)));
  const size = Math.ceil(totalBytes / count);
  const segments = [];
  for (let i = 0; i < count; i++) {
    const start = i * size;
    if (start >= totalBytes) break;
    const end = Math.min(totalBytes - 1, start + size - 1);
    segments.push({ index: i, start, end, downloaded: 0, done: false });
  }
  return segments;
}

/**
 * Bytes que mide un segmento (null si es desconocido).
 * @param {{start:number,end:number|null}} seg
 * @returns {number|null}
 */
function segmentLength(seg) {
  return seg.end === null ? null : seg.end - seg.start + 1;
}

class DownloadTask extends EventEmitter {
  /**
   * @param {object} item - Datos de la descarga (los comparte con el gestor y se guardan en disco).
   * @param {object} deps - Dependencias inyectadas:
   * @param {import('./speedLimiter').SpeedLimiter} deps.limiter - Limitador global.
   * @param {() => object} deps.getSettings - Devuelve la configuración actual.
   * @param {(fullPath:string, selfId:string) => boolean} deps.isPathReserved - ¿Ruta usada por otra descarga?
   */
  constructor(item, { limiter, getSettings, isPathReserved }) {
    super();
    this.item = item;
    this.limiter = limiter;
    this.getSettings = getSettings;
    this.isPathReserved = (p) => isPathReserved(p, item.id);
    this.controller = new AbortController(); // Permite cortar todas las conexiones a la vez.
    this.stopReason = null; // 'pause' | 'cancel' | null
    this.speedTimer = null;
    this.samples = [];
  }

  /* ------------------------------------------------------------------------
   * API pública
   * ---------------------------------------------------------------------- */

  /**
   * Ejecuta la descarga de principio a fin. Nunca lanza errores: el resultado
   * queda reflejado en `item.status` ('completed', 'paused', 'canceled', 'error').
   * @returns {Promise<void>}
   */
  async start() {
    const { item } = this;
    const { signal } = this.controller;
    item.error = null;
    item.retryInfo = null;
    this.setStatus('downloading');
    this.startSpeedMeter();

    try {
      // 1) Sondeo (solo la primera vez; al reanudar ya conocemos el archivo).
      if (!item.probed) await this.withRetries(() => this.prepare(signal), () => 0, signal);

      // 2) Descargamos en paralelo todos los segmentos que falten.
      await fsp.mkdir(this.tempDir, { recursive: true });
      await this.downloadAllSegments(signal);
      this.stopSpeedMeter();

      // 3) y 4) Unión de partes y verificación.
      await this.finalize();
      item.completedAt = Date.now();
      this.setStatus('completed');
    } catch (err) {
      this.stopSpeedMeter();
      if (this.stopReason === 'pause') {
        this.setStatus('paused');
      } else if (this.stopReason === 'cancel') {
        await DownloadTask.removeTempFiles(item);
        this.setStatus('canceled');
      } else {
        item.error = friendlyError(err);
        this.setStatus('error');
      }
    } finally {
      item.retryInfo = null;
    }
  }

  /**
   * Pausa la descarga cortando todas sus conexiones (lo descargado se conserva).
   * Durante la unión o la verificación no se puede pausar (son operaciones locales y rápidas).
   * @returns {void}
   */
  pause() {
    if (this.item.status !== 'downloading') return;
    this.stopReason = 'pause';
    this.controller.abort(new Error('Pausado por el usuario'));
  }

  /**
   * Cancela la descarga y borra los archivos temporales.
   * @returns {void}
   */
  cancel() {
    if (this.item.status !== 'downloading') return;
    this.stopReason = 'cancel';
    this.controller.abort(new Error('Cancelado por el usuario'));
  }

  /** Carpeta temporal donde se guardan las partes: "<archivo final>.ldtmp". */
  get tempDir() {
    return DownloadTask.tempDirOf(this.item);
  }

  /**
   * Ruta del archivo de un segmento.
   * @param {number} index - Número de segmento.
   * @returns {string}
   */
  partPath(index) {
    return path.join(this.tempDir, `part${index}`);
  }

  /* ------------------------------------------------------------------------
   * Paso 1: sondeo y preparación
   * ---------------------------------------------------------------------- */

  /**
   * Sondea la URL y rellena nombre, tamaño, categoría, carpeta y segmentos.
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  async prepare(signal) {
    const { item } = this;
    const settings = this.getSettings();
    const info = await probe(item.url, { headers: item.headers, signal });

    item.totalBytes = info.totalBytes;
    item.resumable = info.resumable;
    if (!item.customFileName) item.fileName = info.fileName;
    item.category = categorize(item.fileName);
    if (!item.customDirectory) item.directory = getCategoryDirectory(item.category, settings);

    // Creamos la carpeta de destino si no existe (recursive = crea también las intermedias).
    await fsp.mkdir(item.directory, { recursive: true });

    // Elegimos una ruta libre para no sobrescribir nada.
    item.savePath = uniquePath(item.directory, item.fileName, this.isPathReserved);
    item.fileName = path.basename(item.savePath);
    item.segments = buildSegments(item.totalBytes, item.resumable, item.connections);
    item.downloadedBytes = 0;
    item.probed = true;
    this.emit('progress', item);
  }

  /* ------------------------------------------------------------------------
   * Paso 2: descarga de segmentos
   * ---------------------------------------------------------------------- */

  /**
   * Lanza una "tarea" por cada segmento pendiente y espera a que acaben todas.
   * Si un segmento falla definitivamente, abortamos los demás.
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  async downloadAllSegments(signal) {
    // Revisamos TODOS los segmentos: downloadSegment() mira el tamaño real en
    // disco y sale enseguida si el segmento ya está completo. No nos fiamos del
    // progreso guardado en el JSON, porque tras un cierre brusco podría ir
    // por delante de lo que de verdad llegó a escribirse.
    let firstError = null;

    const workers = this.item.segments.map((seg) =>
      this.withRetries(() => this.downloadSegment(seg, signal), () => seg.downloaded, signal).catch((err) => {
        // El primer fallo real detiene a los demás segmentos.
        if (!firstError && !this.stopReason) {
          firstError = err;
          this.controller.abort(err);
        }
        throw err;
      }),
    );

    // allSettled espera a TODOS (aunque alguno falle) para cerrar bien los archivos.
    const results = await Promise.allSettled(workers);
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected) throw firstError || rejected.reason;

    // Comprobamos los segmentos en disco por si alguno quedó a medias.
    this.recalculateDownloaded();
  }

  /**
   * Descarga (o continúa) un segmento concreto.
   * @param {object} seg - Segmento a descargar.
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  async downloadSegment(seg, signal) {
    const { item } = this;
    const partFile = this.partPath(seg.index);
    const length = segmentLength(seg);

    // ¿Cuánto tenemos ya en disco? Esa es la verdad, aunque la app se cerrara de golpe.
    let existing = 0;
    try {
      existing = (await fsp.stat(partFile)).size;
    } catch {
      existing = 0; // El archivo aún no existe.
    }

    // Si el servidor no acepta rangos no podemos continuar: empezamos de cero.
    if (!item.resumable) existing = 0;

    // Por seguridad, si la parte es más grande de lo debido la recortamos.
    if (length !== null && existing > length) {
      await fsp.truncate(partFile, length);
      existing = length;
    }
    seg.downloaded = existing;
    seg.done = false;
    this.recalculateDownloaded();

    // Segmento ya completo (o archivo vacío): nos aseguramos de que exista y salimos.
    if (length !== null && existing >= length) {
      if (length === 0) await fsp.writeFile(partFile, '');
      return;
    }

    // Preparamos la petición. Con rangos pedimos solo lo que falta.
    const headers = { ...item.headers };
    if (item.resumable) headers.Range = `bytes=${seg.start + existing}-${seg.end}`;

    const { res } = await request(item.url, { headers, signal });

    if (res.statusCode >= 400) {
      res.resume();
      throw new HttpError(`El servidor respondió ${res.statusCode} ${res.statusMessage || ''}`.trim(), res.statusCode, res.headers);
    }
    if (item.resumable) {
      // Pedimos un rango: la respuesta DEBE ser 206 (Partial Content).
      if (res.statusCode !== 206) {
        res.destroy();
        throw fatalError('El servidor ya no acepta descargas por partes. Vuelve a añadir la descarga.');
      }
      // Si el tamaño total cambió, el archivo del servidor es otro: no podemos mezclar.
      const total = totalFromContentRange(res.headers['content-range']);
      if (total !== null && total !== item.totalBytes) {
        res.destroy();
        throw fatalError('El archivo cambió en el servidor. Vuelve a añadir la descarga.');
      }
    }

    // Abrimos la parte en modo "a" (append = añadir al final) o "w" (desde cero).
    const out = fs.createWriteStream(partFile, { flags: existing > 0 ? 'a' : 'w' });
    // Si falla la escritura (p. ej. disco lleno) cortamos la respuesta con ese error,
    // lo que hace que el bucle `for await` de abajo lance la excepción.
    out.on('error', (err) => res.destroy(err));

    try {
      // `for await` lee la respuesta trozo a trozo (chunks de ~16-64 KB) y
      // respeta la "contrapresión": no pide más datos hasta procesar el actual.
      for await (const chunk of res) {
        let data = chunk;
        if (length !== null) {
          const remaining = length - seg.downloaded;
          if (remaining <= 0) break;
          // Si el servidor envía de más, nos quedamos solo con lo que toca.
          if (data.length > remaining) data = data.subarray(0, remaining);
        }

        // Pagamos al limitador de velocidad (puede hacernos esperar).
        await this.limiter.consume(data.length, signal);

        // write() devuelve false si el búfer interno está lleno: esperamos "drain".
        if (!out.write(data)) await once(out, 'drain', { signal });

        seg.downloaded += data.length;
        item.downloadedBytes += data.length;
      }
    } finally {
      res.destroy();
      out.end();
      try {
        await finished(out); // Esperamos a que todo quede escrito en disco.
      } catch {
        // El error ya se propagó por el bucle; aquí solo cerramos.
      }
    }

    if (signal.aborted) throw signal.reason;
    if (length !== null && seg.downloaded < length) {
      // El servidor cortó antes de tiempo: se reintentará desde donde quedó.
      const err = new Error('La conexión se cerró antes de terminar el segmento');
      err.code = 'ECONNRESET';
      throw err;
    }
    seg.done = true;
  }

  /**
   * Ejecuta `fn` reintentando con espera progresiva (1 s, 2 s, 4 s, 8 s... máx. 30 s).
   *
   * El contador de reintentos se reinicia si hubo avance desde el intento
   * anterior: tanto del propio segmento como de la descarga en conjunto.
   * Así, si el servidor limita el número de conexiones (responde 429 o 503 a
   * algunas), esos segmentos esperan su turno mientras los demás avanzan, en
   * vez de hacer fallar toda la descarga.
   * @param {() => Promise<any>} fn - Operación a ejecutar.
   * @param {() => number} progressOf - Devuelve el progreso del segmento (para detectar avances).
   * @param {AbortSignal} signal
   * @returns {Promise<any>} Lo que devuelva `fn`.
   */
  async withRetries(fn, progressOf, signal) {
    let attempt = 0;
    let before = progressOf();
    let beforeTotal = this.item.downloadedBytes;
    for (;;) {
      try {
        const result = await fn();
        if (this.item.retryInfo) {
          this.item.retryInfo = null;
          this.emit('progress', this.item);
        }
        return result;
      } catch (err) {
        // Si fue el usuario quien paró, o el error no tiene arreglo, no reintentamos.
        if (signal.aborted || isFatal(err)) throw err;

        // ¿Hubo avance desde la última vez? Entonces no contamos este fallo.
        if (progressOf() > before || this.item.downloadedBytes > beforeTotal) attempt = 0;
        before = progressOf();
        beforeTotal = this.item.downloadedBytes;
        attempt++;
        const maxRetries = this.getSettings().maxRetries;
        if (attempt > maxRetries) throw err;

        // Espera progresiva; si el servidor indica cuánto esperar (Retry-After), le hacemos caso.
        let delay = Math.min(30000, 1000 * 2 ** (attempt - 1));
        if (err.retryAfterMs) delay = Math.min(60000, Math.max(delay, err.retryAfterMs));
        this.item.retryInfo = `Reintento ${attempt}/${maxRetries} en ${Math.round(delay / 1000)} s: ${friendlyError(err)}`;
        this.emit('progress', this.item);
        await sleep(delay, signal);
      }
    }
  }

  /** Suma lo descargado de todos los segmentos en `item.downloadedBytes`. */
  recalculateDownloaded() {
    this.item.downloadedBytes = this.item.segments.reduce((sum, s) => sum + s.downloaded, 0);
  }

  /* ------------------------------------------------------------------------
   * Pasos 4 y 5: unir las partes y verificar el hash
   * ---------------------------------------------------------------------- */

  /**
   * Une las partes en el archivo final, borra los temporales y verifica el hash.
   * @returns {Promise<void>}
   */
  async finalize() {
    const { item } = this;
    this.setStatus('merging');

    // Si no conocíamos el tamaño, ahora sí: es lo que hemos descargado.
    if (item.totalBytes === null) item.totalBytes = item.downloadedBytes;

    // Si mientras tanto alguien creó un archivo con el mismo nombre, buscamos otro.
    if (fs.existsSync(item.savePath)) {
      item.savePath = uniquePath(item.directory, item.fileName, this.isPathReserved);
      item.fileName = path.basename(item.savePath);
    }

    const parts = [...item.segments].sort((a, b) => a.start - b.start).map((s) => this.partPath(s.index));
    if (parts.length === 1) {
      // Una sola parte: basta con moverla (instantáneo, no copia datos).
      await fsp.rename(parts[0], item.savePath);
    } else {
      // Varias partes: las copiamos en orden, una tras otra, al archivo final.
      // Leemos cada parte por trozos y respetamos la contrapresión: si el
      // búfer de escritura se llena, esperamos el evento "drain".
      const out = fs.createWriteStream(item.savePath);
      let writeError = null;
      out.on('error', (err) => (writeError = err));
      try {
        for (const part of parts) {
          for await (const chunk of fs.createReadStream(part)) {
            if (writeError) throw writeError;
            if (!out.write(chunk)) await once(out, 'drain');
          }
        }
      } finally {
        out.end();
        await finished(out).catch(() => {});
      }
      if (writeError) throw writeError;
    }
    await DownloadTask.removeTempFiles(item);

  }

  /* ------------------------------------------------------------------------
   * Medidor de velocidad y tiempo restante
   * ---------------------------------------------------------------------- */

  /**
   * Arranca un temporizador que cada 500 ms calcula la velocidad media de los
   * últimos 3 segundos y el tiempo restante estimado.
   * @returns {void}
   */
  startSpeedMeter() {
    this.samples = [{ time: Date.now(), bytes: this.item.downloadedBytes }];
    this.speedTimer = setInterval(() => {
      const now = Date.now();
      const { item } = this;
      this.samples.push({ time: now, bytes: item.downloadedBytes });
      // Descartamos muestras más antiguas que la ventana (pero dejamos al menos 2).
      while (this.samples.length > 2 && now - this.samples[0].time > SPEED_WINDOW) this.samples.shift();

      const first = this.samples[0];
      const seconds = (now - first.time) / 1000;
      item.speed = seconds > 0 ? Math.max(0, (item.downloadedBytes - first.bytes) / seconds) : 0;
      item.eta = item.totalBytes && item.speed > 0 ? (item.totalBytes - item.downloadedBytes) / item.speed : null;
      this.emit('progress', item);
    }, PROGRESS_INTERVAL);
  }

  /** Detiene el medidor de velocidad. */
  stopSpeedMeter() {
    clearInterval(this.speedTimer);
    this.speedTimer = null;
    this.item.speed = 0;
    this.item.eta = null;
  }

  /**
   * Cambia el estado y avisa a quien escuche (el gestor de descargas).
   * @param {string} status - Nuevo estado.
   * @returns {void}
   */
  setStatus(status) {
    this.item.status = status;
    this.emit('status', this.item);
  }

  /* ------------------------------------------------------------------------
   * Utilidades estáticas (se usan también sin una tarea activa)
   * ---------------------------------------------------------------------- */

  /**
   * Carpeta temporal de una descarga.
   * @param {object} item
   * @returns {string|null}
   */
  static tempDirOf(item) {
    return item.savePath ? `${item.savePath}.ldtmp` : null;
  }

  /**
   * Borra la carpeta temporal de partes de una descarga (si existe).
   * @param {object} item
   * @returns {Promise<void>}
   */
  static async removeTempFiles(item) {
    const dir = DownloadTask.tempDirOf(item);
    if (!dir) return;
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      // Si no se puede borrar (archivo bloqueado), no es grave.
    }
  }
}

module.exports = { DownloadTask, buildSegments, friendlyError };
