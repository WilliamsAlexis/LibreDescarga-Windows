/**
 * mediaTask.js
 * -----------------------------------------------------------------------------
 * TAREA DE DESCARGA DE VÍDEO/AUDIO (YouTube y similares) con yt-dlp.
 *
 * Tiene la MISMA forma que DownloadTask (start / pause / cancel y los eventos
 * 'progress' y 'status'), así que el gestor de descargas puede usar una u otra
 * sin saber cuál es. Por eso la cola, el límite de simultáneas, el historial y
 * los botones de pausa funcionan igual para vídeos que para archivos.
 *
 * Cómo trabaja:
 *   1. Calcula el nombre final del archivo (sin pisar otro existente).
 *   2. Lanza yt-dlp con las opciones elegidas (calidad, mp3...).
 *   3. Lee su salida línea a línea: de ahí saca el progreso, la velocidad y
 *      cuándo está uniendo/convirtiendo con ffmpeg.
 *   4. Pausar = matar el proceso (lo descargado queda en archivos ".part");
 *      Reanudar = volver a lanzarlo, y yt-dlp continúa donde quedó.
 *
 * Datos de la descarga (item.media):
 *   mode          'video' | 'audio'
 *   height        altura máxima en vídeo (null = la mejor)
 *   audioFormat   'mp3' | 'm4a' | 'opus'
 *   audioQuality  kbps para mp3/m4a (0 = la mejor)
 *   estimatedBytes tamaño aproximado conocido por el análisis (para el % total)
 * -----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');

const { MediaTools } = require('./mediaTools');
const { friendlyMediaError } = require('./mediaService');

/** Plantilla de progreso: una línea fácil de leer por nuestro código. */
const PROGRESS_TEMPLATE =
  'download:LDP|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.filename)s';

/** Líneas con las que yt-dlp avisa de que ya está procesando con ffmpeg. */
const POST_PROCESS = /^\[(Merger|ExtractAudio|VideoConvertor|VideoRemuxer|Fixup\w*|Metadata|EmbedThumbnail)\]/;

/** Extensión del archivo final según lo elegido. */
const AUDIO_EXTENSIONS = { mp3: 'mp3', m4a: 'm4a', opus: 'opus' };

/**
 * Extensión que tendrá el archivo final.
 * @param {object} media - item.media
 * @returns {string}
 */
function finalExtension(media) {
  return media.mode === 'audio' ? AUDIO_EXTENSIONS[media.audioFormat] || 'mp3' : 'mp4';
}

/**
 * Convierte "NA"/"None"/vacío en null y el resto en número.
 * @param {string} text
 * @returns {number|null}
 */
function num(text) {
  const n = Number(text);
  return text && text !== 'NA' && text !== 'None' && Number.isFinite(n) ? n : null;
}

/**
 * Construye la lista de argumentos de yt-dlp para una descarga.
 * Es una función pura: se puede probar sin ejecutar nada.
 * @param {object} item - La descarga (url, media...).
 * @param {object} options
 * @param {string} options.outputBase - Ruta completa SIN extensión (yt-dlp añade la suya).
 * @param {object} options.settings - Configuración de la app.
 * @param {string[]} options.baseArgs - Argumentos comunes (ffmpeg, cookies...).
 * @returns {string[]}
 */
function buildDownloadArgs(item, { outputBase, settings, baseArgs }) {
  const { media } = item;
  const args = [
    ...baseArgs,
    '--no-playlist',
    '--newline',
    '--no-simulate', // --print implicaría "no descargar"; esto lo evita.
    '--no-quiet',
    '--progress',
    '--progress-template', PROGRESS_TEMPLATE,
    '--print', 'after_move:LDFILE|%(filepath)s',
    '--windows-filenames',
    '--embed-metadata',
    '--retries', '10',
    '--fragment-retries', '10',
    '--socket-timeout', '30',
    '-N', String(Math.min(16, Math.max(1, Number(item.connections) || settings.connections || 4))),
    // "%" tiene significado especial en las plantillas de yt-dlp: se escribe "%%".
    '-o', `${outputBase.replace(/%/g, '%%')}.%(ext)s`,
  ];

  if (settings.speedLimitKBps > 0) args.push('--limit-rate', `${settings.speedLimitKBps}K`);

  if (media.mode === 'audio') {
    const format = AUDIO_EXTENSIONS[media.audioFormat] ? media.audioFormat : 'mp3';
    args.push('-x', '--audio-format', format);
    // Calidad: 0 = la mejor; si no, bitrate en kbps (no se aplica a opus).
    if (format !== 'opus') args.push('--audio-quality', media.audioQuality > 0 ? `${media.audioQuality}K` : '0');
  } else {
    const limit = media.height ? `[height<=${Number(media.height)}]` : '';
    args.push(
      '-f', `bv*${limit}+ba/b${limit}`,
      // Entre calidades iguales, preferimos H.264+AAC: se reproduce en cualquier equipo.
      '-S', 'res,vcodec:h264,acodec:m4a',
      '--merge-output-format', 'mp4',
    );
  }
  args.push(item.url);
  return args;
}

class MediaTask extends EventEmitter {
  /**
   * @param {object} item - Datos de la descarga (compartidos con el gestor).
   * @param {object} deps
   * @param {import('./mediaTools').MediaTools} deps.tools
   * @param {() => object} deps.getSettings
   * @param {(fullPath:string, selfId:string) => boolean} deps.isPathReserved
   */
  constructor(item, { tools, getSettings, isPathReserved }) {
    super();
    this.item = item;
    this.tools = tools;
    this.getSettings = getSettings;
    this.isPathReserved = (p) => isPathReserved(p, item.id);
    this.child = null;
    this.stopReason = null; // 'pause' | 'cancel' | null
    this.streams = new Map(); // archivo -> {downloaded, total}: vídeo y audio llegan por separado.
    this.errorLines = [];
    this.lastEmit = 0;
  }

  /**
   * Ejecuta la descarga de principio a fin. Nunca lanza errores: el resultado
   * queda en `item.status` ('completed', 'paused', 'canceled' o 'error').
   * @returns {Promise<void>}
   */
  async start() {
    const { item } = this;
    item.error = null;
    item.retryInfo = null;
    item.probed = true;
    item.resumable = true;
    this.setStatus('downloading');

    try {
      await this.resolveOutputPath();
      const settings = this.getSettings();
      const outputBase = item.savePath.slice(0, -path.extname(item.savePath).length);
      const args = buildDownloadArgs(item, {
        outputBase,
        settings,
        baseArgs: this.tools.baseArgs({ cookiesBrowser: settings.cookiesBrowser }),
      });
      await fsp.mkdir(path.dirname(item.savePath), { recursive: true });
      const code = await this.runProcess(args);

      if (this.stopReason === 'pause') {
        this.finishSpeed();
        this.setStatus('paused');
      } else if (this.stopReason === 'cancel') {
        await MediaTask.removeTempFiles(item);
        this.finishSpeed();
        this.setStatus('canceled');
      } else if (code === 0 && fs.existsSync(item.savePath)) {
        const stat = await fsp.stat(item.savePath);
        item.totalBytes = stat.size;
        item.downloadedBytes = stat.size;
        item.completedAt = Date.now();
        this.finishSpeed();
        this.setStatus('completed');
      } else {
        throw new Error(friendlyMediaError(this.errorLines.join('\n')));
      }
    } catch (err) {
      this.finishSpeed();
      if (this.stopReason === 'pause') this.setStatus('paused');
      else if (this.stopReason === 'cancel') {
        await MediaTask.removeTempFiles(item);
        this.setStatus('canceled');
      } else {
        item.error = err.message || String(err);
        this.setStatus('error');
      }
    }
  }

  /**
   * Pausa: detiene yt-dlp. Lo descargado queda en archivos ".part" y al
   * reanudar yt-dlp continúa desde ahí.
   * @returns {void}
   */
  pause() {
    if (this.item.status !== 'downloading' && this.item.status !== 'merging') return;
    this.stopReason = 'pause';
    MediaTools.killTree(this.child);
  }

  /**
   * Cancela y borra lo descargado a medias.
   * @returns {void}
   */
  cancel() {
    if (this.item.status !== 'downloading' && this.item.status !== 'merging') return;
    this.stopReason = 'cancel';
    MediaTools.killTree(this.child);
  }

  /**
   * Decide la ruta final del archivo. La primera vez busca un nombre libre
   * ("Canción.mp3", "Canción (1).mp3"...); al reanudar conserva la anterior.
   * @returns {Promise<void>}
   */
  async resolveOutputPath() {
    const { item } = this;
    if (item.savePath) return;
    const ext = `.${finalExtension(item.media)}`;
    const base = path.parse(item.fileName).name || 'descarga';
    let candidate = path.join(item.directory, `${base}${ext}`);
    for (let n = 1; fs.existsSync(candidate) || this.isPathReserved(candidate); n++) {
      candidate = path.join(item.directory, `${base} (${n})${ext}`);
    }
    item.savePath = candidate;
    item.fileName = path.basename(candidate);
  }

  /**
   * Lanza yt-dlp y espera a que termine, procesando su salida.
   * @param {string[]} args
   * @returns {Promise<number>} Código de salida (0 = bien).
   */
  runProcess(args) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.tools.spawnYtdlp(args);
      } catch (err) {
        reject(err);
        return;
      }
      this.child = child;

      readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
      readline.createInterface({ input: child.stderr }).on('line', (line) => this.onErrorLine(line));
      child.on('error', reject);
      child.on('close', (code) => {
        this.child = null;
        resolve(code);
      });
    });
  }

  /**
   * Interpreta una línea de la salida de yt-dlp.
   * @param {string} line
   * @returns {void}
   */
  onLine(line) {
    const { item } = this;
    if (line.startsWith('LDP|')) {
      this.onProgress(line.split('|'));
    } else if (line.startsWith('LDFILE|')) {
      // Ruta definitiva del archivo (después de unir/convertir).
      const finalPath = line.slice('LDFILE|'.length).trim();
      if (finalPath) {
        item.savePath = finalPath;
        item.fileName = path.basename(finalPath);
      }
    } else if (POST_PROCESS.test(line)) {
      if (item.status !== 'merging') {
        item.speed = 0;
        item.eta = null;
        this.setStatus('merging');
      }
    } else if (/^ERROR:/.test(line)) {
      this.errorLines.push(line);
    }
  }

  /**
   * Guarda los mensajes de error (yt-dlp los escribe por la salida de errores).
   * @param {string} line
   * @returns {void}
   */
  onErrorLine(line) {
    if (/ERROR:/.test(line)) this.errorLines.push(line);
  }

  /**
   * Actualiza bytes, velocidad y tiempo restante a partir de una línea LDP.
   * Formato: LDP|estado|descargados|total|total_estimado|velocidad|eta|archivo
   * @param {string[]} parts
   * @returns {void}
   */
  onProgress(parts) {
    const { item } = this;
    const [, status, downloadedText, totalText, estimateText, speedText, , file = ''] = parts;
    const downloaded = num(downloadedText) ?? 0;
    const total = num(totalText) ?? num(estimateText);

    // Vídeo y audio son archivos distintos: sumamos los de todos para el total.
    this.streams.set(file, { downloaded, total });
    let sumDownloaded = 0;
    let sumTotal = 0;
    for (const s of this.streams.values()) {
      sumDownloaded += s.downloaded;
      sumTotal += s.total || 0;
    }
    // Si el análisis nos dio un tamaño aproximado, lo usamos para que el % no "salte"
    // cuando empieza el segundo archivo (el audio).
    const known = Math.max(sumTotal, item.media.estimatedBytes || 0) || null;

    if (item.status === 'merging') return; // Ya está procesando: ignoramos líneas tardías.
    item.downloadedBytes = known ? Math.min(sumDownloaded, known) : sumDownloaded;
    item.totalBytes = known;
    const speed = num(speedText);
    if (status === 'downloading' && speed !== null) {
      item.speed = speed;
      item.eta = known && speed > 0 ? Math.max(0, (known - item.downloadedBytes) / speed) : null;
    }
    this.emitProgress();
  }

  /**
   * Avisa del progreso como mucho 4 veces por segundo.
   * @returns {void}
   */
  emitProgress() {
    const now = Date.now();
    if (now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.emit('progress', this.item);
  }

  /**
   * Pone velocidad y tiempo restante a cero.
   * @returns {void}
   */
  finishSpeed() {
    this.item.speed = 0;
    this.item.eta = null;
    this.item.retryInfo = null;
  }

  /**
   * Cambia el estado y avisa.
   * @param {string} status
   * @returns {void}
   */
  setStatus(status) {
    this.item.status = status;
    this.emit('status', this.item);
  }

  /**
   * Borra los archivos temporales de una descarga NO terminada: partes
   * (".part"), restos de ".ytdl" y los archivos sueltos de vídeo/audio
   * (".f137.mp4"). Nunca toca otros archivos ni el archivo final terminado.
   * @param {object} item
   * @returns {Promise<void>}
   */
  static async removeTempFiles(item) {
    if (!item.savePath || item.status === 'completed') return;
    const dir = path.dirname(item.savePath);
    const base = path.basename(item.savePath, path.extname(item.savePath));
    const temp = /\.(part|ytdl|temp)(-Frag\d+)?$|\.f[\w-]+\.\w+(\.part)?$/i;
    try {
      for (const name of await fsp.readdir(dir)) {
        const isOurs = name.toLowerCase().startsWith(`${base.toLowerCase()}.`);
        if (isOurs && (temp.test(name) || name.toLowerCase() === path.basename(item.savePath).toLowerCase())) {
          await fsp.rm(path.join(dir, name), { force: true });
        }
      }
    } catch {
      // Carpeta inexistente o archivo bloqueado: no es grave.
    }
  }
}

module.exports = { MediaTask, buildDownloadArgs, finalExtension };
