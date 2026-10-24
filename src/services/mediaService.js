/**
 * mediaService.js
 * -----------------------------------------------------------------------------
 * ANÁLISIS de enlaces: averigua qué hay detrás de una URL.
 *
 * Una URL puede ser:
 *   - un ARCHIVO directo (.zip, .exe, .mp4...)  -> descarga por segmentos.
 *   - un VÍDEO de una página (YouTube, Vimeo...) -> hay que elegir calidad o
 *     solo audio; lo descarga yt-dlp.
 *   - una LISTA de reproducción                  -> hay que elegir qué vídeos.
 *
 * `resolve()` decide cuál de los tres es y devuelve los datos que la interfaz
 * necesita para mostrar las opciones.
 * -----------------------------------------------------------------------------
 */

const { probe } = require('../utils/http');
const { getExtension, CATEGORIES } = require('../utils/categories');

/** Sitios que sabemos que son de vídeo/audio: no hace falta sondearlos como archivo. */
const MEDIA_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|facebook\.com|fb\.watch|instagram\.com|twitter\.com|x\.com|soundcloud\.com|bandcamp\.com|reddit\.com|redd\.it|bilibili\.com|rumble\.com|streamable\.com|odysee\.com|mixcloud\.com|ok\.ru|vk\.com)$/i;

/** Extensiones que se consideran un archivo directo (todas menos "Otros"). */
const FILE_EXTENSIONS = new Set(CATEGORIES.flatMap((c) => c.extensions));

/**
 * ¿El servidor del enlace es de un sitio de vídeo conocido?
 * @param {string} hostname
 * @returns {boolean}
 */
function isMediaHost(hostname) {
  return MEDIA_HOSTS.test(hostname);
}

/**
 * ¿La ruta de la URL termina en una extensión de archivo conocida?
 * @param {URL} url
 * @returns {boolean}
 */
function looksLikeFile(url) {
  const ext = getExtension(url.pathname);
  return Boolean(ext) && FILE_EXTENSIONS.has(ext);
}

/**
 * Obtiene la dirección de un elemento de lista (yt-dlp la llama "url" o "webpage_url").
 * @param {object} entry
 * @returns {string|null}
 */
function entryUrl(entry) {
  const candidate = entry.webpage_url || entry.url;
  if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return candidate;
  // En YouTube a veces solo viene el id del vídeo.
  if (entry.ie_key === 'Youtube' && entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  return null;
}

/**
 * Tamaño aproximado de un formato (yt-dlp lo da exacto o estimado).
 * @param {object} f
 * @returns {number}
 */
const sizeOf = (f) => Number(f.filesize || f.filesize_approx || 0) || 0;

/**
 * Convierte el JSON de yt-dlp en un objeto sencillo para la interfaz.
 * Es una función pura (sin red ni disco), por eso se puede probar fácilmente.
 * @param {object} info - JSON devuelto por `yt-dlp -J`.
 * @param {object} context
 * @param {string} context.requestedUrl - URL que escribió el usuario.
 * @param {boolean} context.hasPlaylist - ¿La URL también apunta a una lista?
 * @returns {object} { kind: 'video' | 'playlist', ... }
 * @throws {Error} Si es una emisión en directo o no hay nada descargable.
 */
function normalizeInfo(info, { requestedUrl, hasPlaylist = false }) {
  // ---- Lista de reproducción ----
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    const entries = (info.entries || [])
      .filter(Boolean)
      .map((e) => ({
        id: String(e.id || ''),
        title: e.title || e.id || 'Sin título',
        url: entryUrl(e),
        duration: Number(e.duration) || null,
        uploader: e.uploader || e.channel || null,
      }))
      .filter((e) => e.url);
    if (!entries.length) throw new Error('La lista está vacía o es privada.');
    return {
      kind: 'playlist',
      url: requestedUrl,
      title: info.title || 'Lista de reproducción',
      uploader: info.uploader || info.channel || null,
      count: entries.length,
      entries,
    };
  }

  // ---- Un solo vídeo o audio ----
  if (info.is_live) throw new Error('Las emisiones en directo no se pueden descargar.');
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const hasVideoCodec = (f) => f.vcodec && f.vcodec !== 'none';
  const hasAudioCodec = (f) => f.acodec && f.acodec !== 'none';

  const audioOnly = formats.filter((f) => hasAudioCodec(f) && !hasVideoCodec(f));
  const bestAudioSize = audioOnly.reduce((best, f) => Math.max(best, sizeOf(f)), 0);

  // Una opción por cada altura (1080, 720...), con el tamaño aproximado total.
  const byHeight = new Map();
  for (const f of formats.filter((x) => hasVideoCodec(x) && x.height)) {
    const total = sizeOf(f) + (hasAudioCodec(f) ? 0 : bestAudioSize); // Si no trae audio, se le suma el audio aparte.
    byHeight.set(f.height, Math.max(byHeight.get(f.height) || 0, total));
  }
  const heights = [...byHeight]
    .sort((a, b) => b[0] - a[0])
    .map(([height, approxBytes]) => ({ height, label: `${height}p`, approxBytes: approxBytes || null }));

  const duration = Number(info.duration) || null;
  // Enlaces directos "raros" que yt-dlp trata como un vídeo sin lista de formatos.
  const singleVideo = !formats.length && info.url && info.vcodec !== 'none' && info.ext && ['mp4', 'webm', 'mkv', 'mov', 'm4v'].includes(info.ext);
  const hasVideo = heights.length > 0 || Boolean(singleVideo);

  if (!hasVideo && !audioOnly.length && !formats.some(hasAudioCodec) && !info.url) {
    throw new Error('No se encontró ningún vídeo ni audio descargable en esta página.');
  }

  return {
    kind: 'video',
    url: info.webpage_url || requestedUrl,
    title: info.title || 'Sin título',
    uploader: info.uploader || info.channel || null,
    duration,
    thumbnail: typeof info.thumbnail === 'string' ? info.thumbnail : null,
    heights,
    hasVideo,
    audioApproxBytes: bestAudioSize || null,
    hasPlaylist,
  };
}

class MediaService {
  /**
   * @param {object} deps
   * @param {import('./mediaTools').MediaTools} deps.tools
   * @param {() => object} deps.getSettings
   */
  constructor({ tools, getSettings }) {
    this.tools = tools;
    this.getSettings = getSettings;
  }

  /**
   * Pregunta a yt-dlp qué hay en la URL.
   * @param {string} url
   * @param {object} [options]
   * @param {boolean} [options.playlist=false] - true = tratar la URL como lista completa.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<object>} Resultado normalizado (ver normalizeInfo).
   * @throws {Error} Con un mensaje claro para el usuario.
   */
  async analyzeMedia(url, { playlist = false, signal } = {}) {
    const parsed = new URL(url);
    const hasPlaylist = parsed.searchParams.has('list') && (parsed.searchParams.has('v') || /youtu\.be$/i.test(parsed.hostname));
    const args = [
      ...this.tools.baseArgs({ cookiesBrowser: this.getSettings().cookiesBrowser }),
      '-J',
      '--flat-playlist',
      '--skip-download',
      playlist ? '--yes-playlist' : '--no-playlist',
      url,
    ];
    const { code, stdout, stderr } = await this.tools.run(args, { signal, timeoutMs: 90000 });
    if (code !== 0 || !stdout.trim()) throw new Error(friendlyMediaError(stderr));
    let info;
    try {
      info = JSON.parse(stdout);
    } catch {
      throw new Error('No se pudo interpretar la respuesta del analizador.');
    }
    return normalizeInfo(info, { requestedUrl: url, hasPlaylist: hasPlaylist && !playlist });
  }

  /**
   * Decide qué es la URL (archivo directo, vídeo o lista) y devuelve sus datos.
   * @param {string} url
   * @param {object} [options]
   * @param {boolean} [options.playlist=false]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<object>} `{kind:'direct', fileName, totalBytes, resumable}` o un resultado de vídeo/lista.
   * @throws {Error}
   */
  async resolve(url, { playlist = false, signal } = {}) {
    let parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch {
      throw new Error('La URL no es válida.');
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Solo se admiten direcciones http:// o https://');

    const probeDirect = async () => {
      const info = await probe(parsed.href, { signal: signal || AbortSignal.timeout(15000) });
      return { kind: 'direct', fileName: info.fileName, totalBytes: info.totalBytes, resumable: info.resumable, contentType: info.contentType };
    };

    // 1) Sitio de vídeo conocido -> yt-dlp directamente.
    if (isMediaHost(parsed.hostname) && !looksLikeFile(parsed)) return this.analyzeMedia(parsed.href, { playlist, signal });

    // 2) Parece un archivo (por su extensión) -> sondeo normal.
    if (looksLikeFile(parsed)) return probeDirect();

    // 3) Desconocido: miramos qué responde el servidor.
    let direct = null;
    let directError = null;
    try {
      direct = await probeDirect();
    } catch (err) {
      directError = err;
    }
    // Si NO es una página web (HTML), es un archivo.
    if (direct && !/text\/html|application\/xhtml/i.test(direct.contentType)) return direct;

    // Es una página web (o falló): puede tener un vídeo dentro.
    try {
      return await this.analyzeMedia(parsed.href, { playlist, signal });
    } catch (err) {
      if (direct) throw new Error('Esta página no contiene ningún vídeo ni archivo que se pueda descargar.');
      throw directError || err;
    }
  }
}

/**
 * Traduce los errores de yt-dlp (en inglés y técnicos) a mensajes claros.
 * @param {string} stderr - Salida de errores de yt-dlp.
 * @returns {string}
 */
function friendlyMediaError(stderr) {
  const text = String(stderr || '');
  const rules = [
    [/not a bot|Sign in to confirm you.re not/i, 'YouTube pide comprobar que no eres un robot. En Configuración → Vídeo y audio elige tu navegador para usar sus cookies, e inténtalo de nuevo.'],
    [/confirm your age|age.restricted|inappropriate for some users/i, 'El vídeo tiene restricción de edad. En Configuración → Vídeo y audio elige tu navegador (con tu sesión iniciada) para usar sus cookies.'],
    [/Private video/i, 'El vídeo es privado.'],
    [/members.only|Join this channel/i, 'El vídeo es solo para miembros del canal.'],
    [/unavailable|not available|has been removed|no longer available|terminated|does not exist/i, 'El vídeo no está disponible (eliminado, privado o bloqueado en tu país).'],
    [/Unsupported URL/i, 'Esta página no es compatible: no se encontró ningún vídeo.'],
    [/is live|live event|This live event/i, 'Las emisiones en directo no se pueden descargar.'],
    [/HTTP Error 403|Forbidden/i, 'El servidor rechazó la descarga (error 403). Prueba a actualizar el motor en Configuración → Vídeo y audio.'],
    [/HTTP Error 429|Too Many Requests/i, 'Demasiadas peticiones seguidas. Espera unos minutos e inténtalo de nuevo.'],
    [/ffmpeg|ffprobe/i, 'Falta ffmpeg o no funciona. Reinstala la aplicación.'],
    [/getaddrinfo|Unable to download webpage|timed out|Network is unreachable|Connection (reset|refused)|SSL/i, 'No se pudo conectar. Revisa tu conexión a internet.'],
    [/Requested format is not available/i, 'La calidad elegida no está disponible para este vídeo. Prueba con otra.'],
    [/No space left|ENOSPC/i, 'No hay espacio suficiente en el disco.'],
    [/Permission denied|EACCES/i, 'No hay permiso para escribir en la carpeta de destino.'],
  ];
  for (const [regex, message] of rules) if (regex.test(text)) return message;
  const line = text.split(/\r?\n/).reverse().find((l) => /^ERROR:/.test(l.trim()));
  return line ? line.replace(/^ERROR:\s*(\[[^\]]+\]\s*[\w-]+:\s*)?/i, '').trim().slice(0, 220) : 'No se pudo analizar el enlace.';
}

module.exports = { MediaService, normalizeInfo, friendlyMediaError, isMediaHost, looksLikeFile };
