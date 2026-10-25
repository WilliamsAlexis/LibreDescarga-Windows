/**
 * downloadManager.js
 * -----------------------------------------------------------------------------
 * GESTOR DE DESCARGAS: el "director de orquesta".
 *
 *   - Guarda la lista de todas las descargas (activas y del historial).
 *   - Mantiene una COLA: solo deja correr a la vez tantas descargas como diga
 *     la configuración (maxConcurrent); el resto espera en estado "queued".
 *   - Crea un DownloadTask por cada descarga que arranca y escucha sus avisos.
 *   - Guarda el estado en disco (como máximo una vez por segundo) para que
 *     todo sobreviva a un cierre de la aplicación.
 *   - Emite eventos para que la interfaz se actualice:
 *        'item-updated'  (item)  -> cambió el progreso o el estado
 *        'item-removed'  (id)    -> se quitó de la lista
 *        'completed'     (item)  -> terminó con éxito
 *        'failed'        (item)  -> terminó con error
 *
 * Tampoco depende de Electron: el almacenamiento se le pasa desde fuera.
 *
 * Estados posibles de una descarga:
 *   queued     -> en cola, esperando un hueco
 *   scheduled  -> programada para una hora
 *   downloading-> descargando
 *   merging    -> uniendo partes
 *   paused     -> en pausa
 *   completed  -> terminada
 *   error      -> falló (se puede reintentar)
 *   canceled   -> cancelada
 * -----------------------------------------------------------------------------
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { DownloadTask } = require('./downloadTask');
const { MediaTask, finalExtension } = require('./mediaTask');
const { categorize, getCategoryDirectory } = require('../utils/categories');
const { fileNameFromUrl, sanitizeFileName } = require('../utils/fileName');

/** Estados en los que la descarga está "trabajando" (ocupa un hueco de la cola). */
const ACTIVE_STATUSES = new Set(['downloading', 'merging']);

/** Campos que solo tienen sentido en memoria y no se guardan en disco. */
const VOLATILE_FIELDS = ['speed', 'eta', 'retryInfo'];

class DownloadManager extends EventEmitter {
  /**
   * @param {object} deps
   * @param {{load: () => object[], save: (items: object[]) => void}} deps.storage - Dónde se guardan las descargas.
   * @param {() => object} deps.getSettings - Devuelve la configuración actual.
   * @param {import('./speedLimiter').SpeedLimiter} deps.limiter - Limitador global.
   */
  constructor({ storage, getSettings, limiter, mediaTools = null }) {
    super();
    this.mediaTools = mediaTools; // Herramientas de vídeo (yt-dlp/ffmpeg); null = sin soporte de vídeo.
    this.storage = storage;
    this.getSettings = getSettings;
    this.limiter = limiter;
    this.items = new Map(); // id -> datos de la descarga
    this.tasks = new Map(); // id -> { task, promise } (solo las que están corriendo)
    this.saveTimer = null;
    this.shuttingDown = false;
  }

  /**
   * Carga las descargas guardadas. Las que estaban a medias cuando se cerró la
   * app (descargando, uniendo...) pasan a "pausa" para que el usuario decida.
   * @returns {void}
   */
  init() {
    let saved = [];
    try {
      saved = this.storage.load() || [];
    } catch (err) {
      console.error('No se pudo leer el historial de descargas:', err);
    }
    for (const item of saved) {
      if (!item?.id || !item.url) continue; // Ignoramos datos corruptos.
      if (ACTIVE_STATUSES.has(item.status)) item.status = 'paused';
      item.speed = 0;
      item.eta = null;
      item.retryInfo = null;
      this.items.set(item.id, item);
    }
    this.applySettings();
  }

  /* ------------------------------------------------------------------------
   * Consultas
   * ---------------------------------------------------------------------- */

  /**
   * Copia "pública" de una descarga para enviar a la interfaz.
   * Quitamos las cabeceras (pueden llevar cookies de sesión del navegador).
   * @param {object} item
   * @returns {object}
   */
  toPublic(item) {
    const { headers, ...rest } = item;
    return { ...rest, segments: (item.segments || []).map(({ start, end, downloaded }) => ({ start, end, downloaded })) };
  }

  /**
   * Lista de todas las descargas (copia pública), de la más nueva a la más antigua.
   * @returns {object[]}
   */
  getAll() {
    return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt).map((i) => this.toPublic(i));
  }

  /**
   * Busca una descarga por id.
   * @param {string} id
   * @returns {object|undefined} Datos internos (no la copia pública).
   */
  get(id) {
    return this.items.get(id);
  }

  /**
   * Estadísticas globales para la barra de estado, la bandeja y la barra de tareas.
   * @returns {{totalSpeed:number, active:number, queued:number, progress:number|null}}
   */
  getStats() {
    let totalSpeed = 0, active = 0, queued = 0, done = 0, total = 0;
    for (const item of this.items.values()) {
      if (ACTIVE_STATUSES.has(item.status)) {
        active++;
        totalSpeed += item.speed || 0;
        if (item.totalBytes) {
          done += item.downloadedBytes;
          total += item.totalBytes;
        }
      } else if (item.status === 'queued') {
        queued++;
      }
    }
    return { totalSpeed, active, queued, progress: total ? done / total : null };
  }

  /* ------------------------------------------------------------------------
   * Añadir descargas
   * ---------------------------------------------------------------------- */

  /**
   * Añade una descarga nueva.
   * @param {object} options
   * @param {string} options.url - URL http(s) del archivo (obligatoria).
   * @param {string} [options.fileName] - Nombre deseado (si no, se deduce).
   * @param {string} [options.directory] - Carpeta deseada (si no, la de su categoría).
   * @param {number} [options.connections] - Conexiones (1-16).
   * @param {number} [options.scheduledAt] - Marca de tiempo (ms) para empezar más tarde.
   * @param {boolean} [options.startNow=true] - false = añadir en pausa.
   * @param {object} [options.headers] - Cabeceras extra (Referer, Cookie) desde el navegador.
   * @param {string} [options.source='manual'] - De dónde viene: manual, clipboard, browser.
   * @returns {object} La descarga creada (copia pública).
   * @throws {Error} Si la URL o el hash no son válidos.
   */
  add(options) {
    const settings = this.getSettings();

    // --- Validación de la URL ---
    let url;
    try {
      url = new URL(String(options.url || '').trim());
    } catch {
      throw new Error('La URL no es válida.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Solo se admiten direcciones http:// o https://');
    }

    // --- Nombre y carpeta provisionales (se confirman al sondear) ---
    const customFileName = Boolean(options.fileName && String(options.fileName).trim());
    const fileName = sanitizeFileName(customFileName ? options.fileName : fileNameFromUrl(url.href) || 'descarga');
    const category = categorize(fileName);
    const customDirectory = Boolean(options.directory && String(options.directory).trim());
    const directory = customDirectory ? path.resolve(String(options.directory)) : getCategoryDirectory(category, settings);

    // --- Estado inicial ---
    const scheduledAt = Number(options.scheduledAt) || null;
    let status = 'queued';
    if (scheduledAt && scheduledAt > Date.now()) status = 'scheduled';
    else if (options.startNow === false) status = 'paused';

    const connections = Math.min(16, Math.max(1, Math.round(Number(options.connections) || settings.connections)));

    const item = {
      id: crypto.randomUUID(),
      url: url.href,
      fileName,
      customFileName,
      directory,
      customDirectory,
      savePath: null,
      category,
      totalBytes: null,
      downloadedBytes: 0,
      resumable: false,
      probed: false,
      connections,
      segments: [],
      status,
      error: null,
      retryInfo: null,
      speed: 0,
      eta: null,
      createdAt: Date.now(),
      queuedAt: Date.now(),
      completedAt: null,
      scheduledAt: status === 'scheduled' ? scheduledAt : null,
      headers: this.sanitizeHeaders(options.headers),
      source: ['manual', 'clipboard', 'browser'].includes(options.source) ? options.source : 'manual',
    };

    this.items.set(item.id, item);
    this.notify(item);
    this.scheduleSave();
    this.processQueue();
    return this.toPublic(item);
  }

  /**
   * Añade una descarga de VÍDEO o AUDIO de una página (YouTube, etc.).
   * Se descarga con yt-dlp (ver mediaTask.js) pero usa la misma cola, el mismo
   * historial y los mismos botones que cualquier otra descarga.
   * @param {object} options
   * @param {string} options.url - Página del vídeo.
   * @param {string} options.title - Título (será el nombre del archivo).
   * @param {'video'|'audio'} options.mode - Qué descargar.
   * @param {number|null} [options.height] - Altura máxima del vídeo (null = la mejor).
   * @param {'mp3'|'m4a'|'opus'} [options.audioFormat='mp3'] - Formato del audio.
   * @param {number} [options.audioQuality=0] - kbps (0 = la mejor).
   * @param {number|null} [options.estimatedBytes] - Tamaño aproximado (para el % total).
   * @param {string} [options.directory] - Carpeta deseada (si no, la de su categoría).
   * @param {number} [options.scheduledAt] - Marca de tiempo (ms) para empezar más tarde.
   * @param {boolean} [options.startNow=true]
   * @param {string} [options.source='manual']
   * @returns {object} La descarga creada (copia pública).
   * @throws {Error} Si la URL no es válida o faltan las herramientas de vídeo.
   */
  addMedia(options) {
    const settings = this.getSettings();
    if (!this.mediaTools?.available) {
      throw new Error('Faltan las herramientas de vídeo (yt-dlp o ffmpeg). Reinstala la aplicación o ejecuta "npm run tools".');
    }
    let url;
    try {
      url = new URL(String(options.url || '').trim());
    } catch {
      throw new Error('La URL no es válida.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Solo se admiten direcciones http:// o https://');

    const mode = options.mode === 'audio' ? 'audio' : 'video';
    const media = {
      mode,
      height: mode === 'video' && Number(options.height) > 0 ? Math.round(Number(options.height)) : null,
      audioFormat: ['mp3', 'm4a', 'opus'].includes(options.audioFormat) ? options.audioFormat : 'mp3',
      audioQuality: [0, 128, 192, 256, 320].includes(Number(options.audioQuality)) ? Number(options.audioQuality) : 0,
      estimatedBytes: Number(options.estimatedBytes) > 0 ? Math.round(Number(options.estimatedBytes)) : null,
    };

    const title = String(options.title || '').trim() || 'video';
    const fileName = sanitizeFileName(`${title}.${finalExtension(media)}`);
    const category = categorize(fileName);
    const customDirectory = Boolean(options.directory && String(options.directory).trim());
    const directory = customDirectory ? path.resolve(String(options.directory)) : getCategoryDirectory(category, settings);

    const scheduledAt = Number(options.scheduledAt) || null;
    let status = 'queued';
    if (scheduledAt && scheduledAt > Date.now()) status = 'scheduled';
    else if (options.startNow === false) status = 'paused';

    const item = {
      id: crypto.randomUUID(),
      kind: 'media',
      media,
      url: url.href,
      fileName,
      customFileName: false,
      directory,
      customDirectory,
      savePath: null,
      category,
      totalBytes: media.estimatedBytes,
      downloadedBytes: 0,
      resumable: true,
      probed: true,
      connections: settings.connections,
      segments: [],
      status,
      error: null,
      retryInfo: null,
      speed: 0,
      eta: null,
      createdAt: Date.now(),
      queuedAt: Date.now(),
      completedAt: null,
      scheduledAt: status === 'scheduled' ? scheduledAt : null,
      headers: {},
      source: ['manual', 'clipboard', 'browser'].includes(options.source) ? options.source : 'manual',
    };

    this.items.set(item.id, item);
    this.notify(item);
    this.scheduleSave();
    this.processQueue();
    return this.toPublic(item);
  }

  /**
   * Borra los archivos temporales de una descarga sin terminar, según su tipo.
   * @param {object} item
   * @returns {Promise<void>}
   */
  cleanupTemp(item) {
    return item.kind === 'media' ? MediaTask.removeTempFiles(item) : DownloadTask.removeTempFiles(item);
  }

  /**
   * Solo dejamos pasar cabeceras seguras y útiles para descargar.
   * @param {object} headers
   * @returns {object}
   */
  sanitizeHeaders(headers) {
    const clean = {};
    if (!headers || typeof headers !== 'object') return clean;
    for (const key of ['Referer', 'Cookie', 'User-Agent']) {
      const value = headers[key];
      // Sin saltos de línea: evitamos "inyección de cabeceras".
      if (typeof value === 'string' && value && !/[\r\n]/.test(value)) clean[key] = value.slice(0, 8192);
    }
    return clean;
  }

  /* ------------------------------------------------------------------------
   * Acciones sobre descargas
   * ---------------------------------------------------------------------- */

  /**
   * Pone en cola (para que arranque cuando haya hueco) una descarga pausada,
   * con error, programada o cancelada. Las canceladas empiezan de cero.
   * @param {string} id
   * @returns {void}
   */
  resume(id) {
    const item = this.items.get(id);
    if (!item || ACTIVE_STATUSES.has(item.status) || item.status === 'completed' || item.status === 'queued') return;
    if (item.status === 'canceled') this.resetProgress(item);
    item.status = 'queued';
    item.queuedAt = Date.now();
    item.scheduledAt = null;
    item.error = null;
    this.notify(item);
    this.scheduleSave();
    this.processQueue();
  }

  /**
   * Pausa una descarga (activa, en cola o programada).
   * @param {string} id
   * @returns {void}
   */
  pause(id) {
    const item = this.items.get(id);
    if (!item) return;
    const running = this.tasks.get(id);
    if (running) {
      running.task.pause(); // El propio task cambiará el estado a 'paused'.
    } else if (item.status === 'queued' || item.status === 'scheduled') {
      item.status = 'paused';
      item.scheduledAt = null;
      this.notify(item);
      this.scheduleSave();
    }
  }

  /**
   * Cancela una descarga: se detiene y se borran sus partes temporales.
   * Queda en el historial como "Cancelada" (se puede volver a iniciar).
   * @param {string} id
   * @returns {Promise<void>}
   */
  async cancel(id) {
    const item = this.items.get(id);
    if (!item || item.status === 'completed' || item.status === 'canceled') return;
    const running = this.tasks.get(id);
    if (running) {
      running.task.cancel();
      await running.promise;
      return;
    }
    await this.cleanupTemp(item);
    this.resetProgress(item);
    item.status = 'canceled';
    this.notify(item);
    this.scheduleSave();
  }

  /**
   * Quita descargas de la lista. Opcionalmente borra también el archivo del disco.
   * @param {string} id
   * @param {boolean} [deleteFile=false] - true = borrar el archivo descargado.
   * @returns {Promise<void>}
   */
  async remove(id, deleteFile = false) {
    const item = this.items.get(id);
    if (!item) return;

    // Si está corriendo, primero la cancelamos y esperamos a que pare.
    const running = this.tasks.get(id);
    if (running) {
      running.task.cancel();
      await running.promise;
    }
    // Las partes temporales de una descarga sin terminar ya no sirven para nada.
    await this.cleanupTemp(item);

    if (deleteFile && item.status === 'completed' && item.savePath) {
      try {
        await fsp.unlink(item.savePath);
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('No se pudo borrar el archivo:', err.message);
      }
    }
    this.items.delete(id);
    this.emit('item-removed', id);
    this.scheduleSave();
  }

  /**
   * Programa una descarga para que empiece a una hora concreta.
   * @param {string} id
   * @param {number} timestamp - Fecha/hora en milisegundos.
   * @returns {void}
   * @throws {Error} Si la fecha no es futura.
   */
  schedule(id, timestamp) {
    const item = this.items.get(id);
    if (!item || item.status === 'completed' || ACTIVE_STATUSES.has(item.status)) return;
    const when = Number(timestamp);
    if (!Number.isFinite(when) || when <= Date.now()) throw new Error('La hora programada debe ser futura.');
    if (item.status === 'canceled') this.resetProgress(item);
    item.status = 'scheduled';
    item.scheduledAt = when;
    item.error = null;
    this.notify(item);
    this.scheduleSave();
  }

  /**
   * Revisa las descargas programadas y pone en cola las que ya toca empezar.
   * La llama el programador (scheduler.js) cada pocos segundos.
   * @param {number} [now=Date.now()]
   * @returns {object[]} Descargas que se acaban de poner en cola.
   */
  checkSchedule(now = Date.now()) {
    const started = [];
    for (const item of this.items.values()) {
      if (item.status === 'scheduled' && item.scheduledAt && item.scheduledAt <= now) {
        this.resume(item.id);
        started.push(item);
      }
    }
    return started;
  }

  /** Pausa todas las descargas activas, en cola o programadas. */
  pauseAll() {
    for (const item of this.items.values()) {
      if (ACTIVE_STATUSES.has(item.status) || item.status === 'queued' || item.status === 'scheduled') this.pause(item.id);
    }
  }

  /** Reanuda todas las descargas en pausa o con error. */
  resumeAll() {
    for (const item of this.items.values()) {
      if (item.status === 'paused' || item.status === 'error') this.resume(item.id);
    }
  }

  /**
   * Quita del historial todas las descargas completadas (no borra los archivos).
   * @returns {Promise<void>}
   */
  async clearCompleted() {
    for (const item of [...this.items.values()]) {
      if (item.status === 'completed') await this.remove(item.id, false);
    }
  }

  /**
   * Deja una descarga como si nunca hubiera empezado.
   * @param {object} item
   * @returns {void}
   */
  resetProgress(item) {
    item.probed = false;
    item.segments = [];
    item.downloadedBytes = 0;
    item.totalBytes = item.kind === 'media' ? item.media?.estimatedBytes ?? null : null;
    item.savePath = null;
    item.error = null;
  }

  /* ------------------------------------------------------------------------
   * Cola
   * ---------------------------------------------------------------------- */

  /**
   * Arranca descargas de la cola mientras haya huecos libres.
   * Orden: la que lleva más tiempo esperando primero (FIFO).
   * @returns {void}
   */
  processQueue() {
    if (this.shuttingDown) return;
    const max = this.getSettings().maxConcurrent;
    const queued = [...this.items.values()].filter((i) => i.status === 'queued').sort((a, b) => a.queuedAt - b.queuedAt);
    while (this.tasks.size < max && queued.length) this.startTask(queued.shift());
  }

  /**
   * Crea y lanza el DownloadTask de una descarga.
   * @param {object} item
   * @returns {void}
   */
  startTask(item) {
    const isPathReserved = (fullPath, selfId) => this.isPathReserved(fullPath, selfId);
    const task =
      item.kind === 'media'
        ? new MediaTask(item, { tools: this.mediaTools, getSettings: this.getSettings, isPathReserved })
        : new DownloadTask(item, { limiter: this.limiter, getSettings: this.getSettings, isPathReserved });

    task.on('progress', () => {
      this.notify(item);
      this.scheduleSave();
    });
    task.on('status', () => {
      this.notify(item);
      this.scheduleSave();
    });

    // start() nunca lanza errores; cuando termina (como sea) liberamos el hueco.
    const promise = task.start().then(() => {
      this.tasks.delete(item.id);
      if (item.status === 'completed') this.emit('completed', this.toPublic(item));
      if (item.status === 'error') this.emit('failed', this.toPublic(item));
      this.notify(item);
      this.scheduleSave();
      this.processQueue(); // ¡Hueco libre! Que entre la siguiente.
    });
    this.tasks.set(item.id, { task, promise });
  }

  /**
   * ¿Está la ruta ya asignada a otra descarga? Evita que dos descargas con el
   * mismo nombre escriban en el mismo archivo.
   * @param {string} fullPath
   * @param {string} selfId - id de quien pregunta (no cuenta como conflicto).
   * @returns {boolean}
   */
  isPathReserved(fullPath, selfId) {
    const target = fullPath.toLowerCase(); // Windows no distingue mayúsculas.
    for (const item of this.items.values()) {
      if (item.id === selfId || item.status === 'canceled' || !item.savePath) continue;
      if (item.savePath.toLowerCase() === target) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------------
   * Configuración, eventos y guardado
   * ---------------------------------------------------------------------- */

  /**
   * Aplica la configuración actual (límite de velocidad y tamaño de la cola).
   * Se llama al iniciar y cada vez que el usuario guarda la configuración.
   * @returns {void}
   */
  applySettings() {
    const settings = this.getSettings();
    this.limiter.setRate(settings.speedLimitKBps * 1024);
    this.processQueue();
  }

  /**
   * Avisa a la interfaz de que una descarga cambió.
   * @param {object} item
   * @returns {void}
   */
  notify(item) {
    this.emit('item-updated', this.toPublic(item));
  }

  /**
   * Programa un guardado en disco dentro de 1 segundo (si no hay ya uno
   * programado). Así, aunque haya cientos de cambios por segundo, solo
   * escribimos el archivo una vez por segundo.
   * @returns {void}
   */
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1000);
  }

  /**
   * Guarda inmediatamente todas las descargas (sin los campos volátiles).
   * @returns {void}
   */
  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      const data = [...this.items.values()].map((item) => {
        const copy = { ...item };
        for (const field of VOLATILE_FIELDS) delete copy[field];
        return copy;
      });
      this.storage.save(data);
    } catch (err) {
      console.error('No se pudo guardar el historial de descargas:', err);
    }
  }

  /**
   * Cierre ordenado: pausa lo que esté corriendo, espera a que se cierren los
   * archivos y guarda. Lo llama main.js antes de salir de la aplicación.
   * @returns {Promise<void>}
   */
  async shutdown() {
    this.shuttingDown = true;
    const running = [...this.tasks.values()];
    for (const { task } of running) task.pause();
    // Si estaba uniendo partes, esperamos a que termine (pause no la interrumpe).
    await Promise.allSettled(running.map((r) => r.promise));
    this.saveNow();
  }
}

module.exports = { DownloadManager };
