/**
 * background.js (service worker de la extensión)
 * -----------------------------------------------------------------------------
 * Se ejecuta en segundo plano y se encarga de:
 *   1. Crear el menú de clic derecho "Descargar con LibreDescarga" para
 *      enlaces, imágenes, vídeos y audios.
 *   2. (Opcional) INTERCEPTAR las descargas del navegador: cuando empieza una
 *      descarga, la pausa, intenta enviarla a la app y, si lo consigue, la
 *      cancela en el navegador. Si la app no está abierta, la deja seguir.
 *   3. Mostrar avisos de éxito o error.
 * -----------------------------------------------------------------------------
 */

importScripts('common.js');

/**
 * Muestra una notificación del navegador.
 * @param {string} title
 * @param {string} message
 * @returns {void}
 */
function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message });
}

/**
 * Pone una marca temporal en el icono de la extensión (✓ verde o ! rojo).
 * @param {boolean} ok
 * @returns {void}
 */
function flashBadge(ok) {
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#16a34a' : '#dc2626' });
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
}

/**
 * Envía una URL y avisa del resultado.
 * @param {object} data - { url, fileName, referrer }
 * @returns {Promise<boolean>} true si la app la aceptó.
 */
async function sendAndReport(data) {
  try {
    await ldSendToApp(data);
    flashBadge(true);
    return true;
  } catch (err) {
    flashBadge(false);
    notify('No se pudo enviar a LibreDescarga', err.message);
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * 1) Menú contextual
 * ------------------------------------------------------------------------- */

// Los menús se crean al instalar/actualizar la extensión (Chrome los recuerda).
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ld-link', title: 'Descargar enlace con LibreDescarga', contexts: ['link'] });
    chrome.contextMenus.create({
      id: 'ld-media',
      title: 'Descargar con LibreDescarga',
      contexts: ['image', 'video', 'audio'],
    });
  });
  // La primera vez abrimos las opciones para que el usuario pegue el token.
  ldGetConfig().then((config) => {
    if (!config.token) chrome.runtime.openOptionsPage();
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === 'ld-link' ? info.linkUrl : info.srcUrl;
  if (!url || !/^https?:/i.test(url)) {
    notify('Enlace no compatible', 'Solo se pueden enviar enlaces http:// o https://');
    return;
  }
  sendAndReport({ url, referrer: info.pageUrl || tab?.url || '' });
});

/* ---------------------------------------------------------------------------
 * 2) Interceptar descargas del navegador (si está activado en opciones)
 * ------------------------------------------------------------------------- */

chrome.downloads.onCreated.addListener(async (item) => {
  const config = await ldGetConfig();
  const url = item.finalUrl || item.url;
  // Solo URLs http(s): las "blob:" o "data:" las genera la propia página y no se pueden reenviar.
  if (!config.intercept || !/^https?:/i.test(url)) return;

  try {
    // Pausamos enseguida para que el navegador no siga descargando mientras preguntamos.
    await chrome.downloads.pause(item.id).catch(() => {});
    const status = await ldPing();
    if (!status.online || !status.authorized) {
      // La app no está disponible: dejamos que el navegador continúe normalmente.
      await chrome.downloads.resume(item.id).catch(() => {});
      return;
    }
    const fileName = (item.filename || '').split(/[\\/]/).pop();
    const sent = await sendAndReport({ url, fileName, referrer: item.referrer || '' });
    if (sent) {
      await chrome.downloads.cancel(item.id).catch(() => {});
      await chrome.downloads.erase({ id: item.id }).catch(() => {});
    } else {
      await chrome.downloads.resume(item.id).catch(() => {});
    }
  } catch (err) {
    console.error('LibreDescarga: error al interceptar', err);
    chrome.downloads.resume(item.id).catch(() => {});
  }
});

/* ---------------------------------------------------------------------------
 * 3) Mensajes desde la ventana emergente
 * ------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'send') {
    // Respondemos de forma asíncrona: hay que devolver true para mantener el canal abierto.
    ldSendToApp(message.data)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});
