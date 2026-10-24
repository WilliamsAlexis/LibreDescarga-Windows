/**
 * popup.js (extensión)
 * -----------------------------------------------------------------------------
 * Lógica de la ventana emergente:
 *   1. Comprueba si la app está abierta y si el token es correcto.
 *   2. Inyecta una pequeña función en la pestaña actual que recoge los enlaces
 *      a archivos descargables (por su extensión) y los muestra en una lista.
 *   3. Permite enviar uno o todos a la app.
 * -----------------------------------------------------------------------------
 */

const statusEl = document.getElementById('status');
const listEl = document.getElementById('links');
const sendAllBtn = document.getElementById('send-all');
const interceptEl = document.getElementById('intercept');

let pageUrl = '';
let foundLinks = [];

/**
 * Esta función se ejecuta DENTRO de la página web (no en el popup), por eso
 * no puede usar variables de fuera: todo lo que necesita llega por parámetro.
 * @param {string[]} extensions - Extensiones a buscar.
 * @returns {{url:string, text:string}[]} Enlaces encontrados (sin repetir).
 */
function collectLinks(extensions) {
  const found = new Map();
  const add = (href, text) => {
    try {
      const url = new URL(href, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      const ext = url.pathname.split('.').pop().toLowerCase();
      if (extensions.includes(ext) && !found.has(url.href)) found.set(url.href, (text || '').trim().slice(0, 120));
    } catch {
      // Enlace mal formado: lo ignoramos.
    }
  };
  document.querySelectorAll('a[href]').forEach((a) => add(a.href, a.getAttribute('download') || a.textContent));
  document.querySelectorAll('video[src], audio[src], source[src]').forEach((m) => add(m.src, ''));
  return [...found].map(([url, text]) => ({ url, text }));
}

/**
 * Nombre de archivo a partir de una URL.
 * @param {string} url
 * @returns {string}
 */
function fileNameOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop()) || url;
  } catch {
    return url;
  }
}

/**
 * Envía un enlace a la app a través del service worker.
 * @param {string} url
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function send(url) {
  return chrome.runtime.sendMessage({ type: 'send', data: { url, referrer: pageUrl } });
}

/**
 * Pinta el estado de conexión con la app.
 * @returns {Promise<void>}
 */
async function renderStatus() {
  const s = await ldPing();
  if (s.online && s.authorized) statusEl.innerHTML = `<span class="dot on"></span> Conectado (v${s.version})`;
  else if (s.online) statusEl.innerHTML = '<span class="dot warn"></span> Token incorrecto — revisa las opciones';
  else statusEl.innerHTML = '<span class="dot off"></span> La app no está abierta';
}

/**
 * Busca y pinta los enlaces descargables de la pestaña activa.
 * @returns {Promise<void>}
 */
async function renderLinks() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    pageUrl = tab?.url || '';
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectLinks,
      args: [LD_EXTENSIONS],
    });
    foundLinks = result?.result || [];
  } catch {
    // Páginas especiales (chrome://, tienda de extensiones...) no permiten inyectar código.
    foundLinks = [];
  }

  listEl.innerHTML = '';
  if (!foundLinks.length) {
    listEl.innerHTML = '<li class="muted">No se encontraron enlaces a archivos en esta página.</li>';
    return;
  }
  sendAllBtn.disabled = false;
  for (const link of foundLinks) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'link-info';
    const name = document.createElement('div');
    name.className = 'link-name';
    name.textContent = fileNameOf(link.url); // textContent: nunca interpretamos HTML de la página
    name.title = link.url;
    const sub = document.createElement('div');
    sub.className = 'muted small';
    sub.textContent = link.text || new URL(link.url).host;
    info.append(name, sub);

    const button = document.createElement('button');
    button.className = 'btn small';
    button.textContent = 'Enviar';
    button.addEventListener('click', async () => {
      button.disabled = true;
      const res = await send(link.url);
      button.textContent = res?.ok ? '✓ Enviado' : 'Error';
      button.title = res?.error || '';
      if (!res?.ok) button.disabled = false;
    });
    li.append(info, button);
    listEl.appendChild(li);
  }
}

sendAllBtn.addEventListener('click', async () => {
  sendAllBtn.disabled = true;
  let ok = 0;
  for (const link of foundLinks) {
    const res = await send(link.url);
    if (res?.ok) ok++;
  }
  sendAllBtn.textContent = `✓ ${ok}/${foundLinks.length} enviados`;
});

interceptEl.addEventListener('change', () => chrome.storage.local.set({ intercept: interceptEl.checked }));
document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

// Arranque
ldGetConfig().then((config) => (interceptEl.checked = config.intercept));
renderStatus();
renderLinks();
