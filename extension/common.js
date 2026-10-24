/**
 * common.js (extensión)
 * -----------------------------------------------------------------------------
 * Código COMPARTIDO por el service worker (background.js), la ventana
 * emergente (popup.js) y la página de opciones (options.js):
 *   - Lista de extensiones de archivo que consideramos "descargables".
 *   - Lectura de la configuración guardada (puerto y token).
 *   - Envío de una URL a la app de escritorio por el servidor local.
 *
 * Se carga con <script src="common.js"> en las páginas y con importScripts()
 * en el service worker, por eso declara funciones globales (sin módulos).
 * -----------------------------------------------------------------------------
 */

/** Extensiones que se detectan como descargables en las páginas. */
const LD_EXTENSIONS = [
  // Vídeo
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp',
  // Música
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus',
  // Documentos
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'epub', 'csv', 'txt',
  // Programas
  'exe', 'msi', 'msix', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'jar',
  // Comprimidos e imágenes de disco
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso', 'img',
];

/**
 * Sitios de vídeo/audio en los que la página (no un archivo) es lo que se
 * descarga: la app la analiza y deja elegir calidad, formato o lista.
 * Debe parecerse a VIDEO_PAGE_RULES de src/utils/categories.js.
 */
const LD_VIDEO_PAGES = [
  { host: /(^|\.)youtube\.com$/, test: (u) => (u.pathname === '/watch' && u.searchParams.has('v')) || /^\/(shorts|live|embed)\//.test(u.pathname) || (u.pathname === '/playlist' && u.searchParams.has('list')) },
  { host: /(^|\.)youtu\.be$/, test: (u) => u.pathname.length > 1 },
  { host: /(^|\.)vimeo\.com$/, test: (u) => /^\/(\w+\/)?\d+/.test(u.pathname) },
  { host: /(^|\.)tiktok\.com$/, test: (u) => /\/video\/\d+/.test(u.pathname) },
  { host: /(^|\.)(twitter|x)\.com$/, test: (u) => /\/status\/\d+/.test(u.pathname) },
  { host: /(^|\.)instagram\.com$/, test: (u) => /^\/(reel|reels|p|tv)\//.test(u.pathname) },
  { host: /(^|\.)facebook\.com$/, test: (u) => /\/(videos|reel|watch)/.test(u.pathname) },
  { host: /(^|\.)dailymotion\.com$/, test: (u) => /^\/video\//.test(u.pathname) },
  { host: /(^|\.)twitch\.tv$/, test: (u) => /\/(videos|clip)\//.test(u.pathname) },
  { host: /(^|\.)soundcloud\.com$/, test: (u) => u.pathname.split('/').filter(Boolean).length >= 2 },
  { host: /(^|\.)bandcamp\.com$/, test: (u) => /^\/(track|album)\//.test(u.pathname) },
];

/**
 * ¿Es esta URL la página de un vídeo, canción o lista de un sitio conocido?
 * @param {string} href
 * @returns {boolean}
 */
function ldIsVideoPage(href) {
  try {
    const url = new URL(href);
    return LD_VIDEO_PAGES.some((rule) => rule.host.test(url.hostname) && rule.test(url));
  } catch {
    return false;
  }
}

/** Configuración por defecto (debe coincidir con la de la app). */
const LD_DEFAULTS = { port: 6801, token: '', intercept: false, overlay: true, floating: true };

/**
 * Lee la configuración guardada en chrome.storage.
 * @returns {Promise<{port:number, token:string, intercept:boolean, overlay:boolean, floating:boolean}>}
 */
async function ldGetConfig() {
  const stored = await chrome.storage.local.get(LD_DEFAULTS);
  return { ...LD_DEFAULTS, ...stored };
}

/**
 * Pregunta a la app si está en marcha y si el token es correcto.
 * @returns {Promise<{online:boolean, authorized:boolean, version?:string, error?:string}>}
 */
async function ldPing() {
  const { port, token } = await ldGetConfig();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      headers: { 'X-LibreDescarga-Token': token },
      signal: AbortSignal.timeout(2500), // Si no responde en 2,5 s, damos por hecho que está cerrada.
    });
    const data = await res.json();
    return { online: data.app === 'LibreDescarga', authorized: Boolean(data.authorized), version: data.version };
  } catch (err) {
    return { online: false, authorized: false, error: err.message };
  }
}

/**
 * Obtiene las cookies del navegador para una URL (por si la descarga
 * requiere haber iniciado sesión en la web).
 * @param {string} url
 * @returns {Promise<string>} Cabecera Cookie ("a=1; b=2") o "".
 */
async function ldCookiesFor(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

/**
 * Envía una URL a la app de escritorio.
 * @param {object} data
 * @param {string} data.url - URL del archivo.
 * @param {string} [data.fileName] - Nombre sugerido.
 * @param {string} [data.referrer] - Página desde la que se descarga.
 * @param {boolean} [data.page] - true = es la página de un vídeo (la app dejará elegir calidad/formato).
 *                              Si no se indica, se deduce de la URL.
 * @returns {Promise<object>} Respuesta de la app.
 * @throws {Error} Si la app no responde o rechaza la petición.
 */
async function ldSendToApp({ url, fileName = '', referrer = '', page }) {
  const { port, token } = await ldGetConfig();
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LibreDescarga-Token': token },
      body: JSON.stringify({
        url,
        fileName,
        referrer,
        page: page ?? ldIsVideoPage(url),
        cookies: page === false ? '' : await ldCookiesFor(url),
        userAgent: navigator.userAgent,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error('LibreDescarga no está abierta (o el puerto no coincide).');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Token incorrecto. Revisa las opciones de la extensión.');
  if (!res.ok || !data.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
