/**
 * notifications.js
 * -----------------------------------------------------------------------------
 * Muestra NOTIFICACIONES nativas de Windows (las que aparecen abajo a la
 * derecha), por ejemplo "Descarga completada".
 * -----------------------------------------------------------------------------
 */

const path = require('node:path');
const { Notification } = require('electron');

const ICON = path.join(__dirname, '../../assets/icon.png');

/**
 * Muestra una notificación.
 * @param {object} options
 * @param {string} options.title - Título en negrita.
 * @param {string} options.body - Texto.
 * @param {() => void} [options.onClick] - Qué hacer si el usuario hace clic.
 * @returns {void}
 */
function showNotification({ title, body, onClick }) {
  try {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body, icon: ICON, silent: false });
    if (onClick) notification.on('click', onClick);
    notification.show();
  } catch (err) {
    // Una notificación fallida nunca debe romper la app.
    console.error('No se pudo mostrar la notificación:', err);
  }
}

module.exports = { showNotification };
