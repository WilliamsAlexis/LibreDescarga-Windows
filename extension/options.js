/**
 * options.js (extensión)
 * -----------------------------------------------------------------------------
 * Guarda el puerto, el token y la opción de capturar descargas en
 * chrome.storage.local, y permite probar la conexión con la app.
 * -----------------------------------------------------------------------------
 */

const portEl = document.getElementById('port');
const tokenEl = document.getElementById('token');
const interceptEl = document.getElementById('intercept');
const messageEl = document.getElementById('message');

/**
 * Muestra un mensaje bajo el formulario.
 * @param {string} text
 * @param {'ok'|'error'|''} kind
 * @returns {void}
 */
function showMessage(text, kind = '') {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`;
}

/**
 * Guarda los valores del formulario.
 * @returns {Promise<void>}
 */
async function save() {
  const port = Number(portEl.value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('El puerto debe estar entre 1024 y 65535.');
  await chrome.storage.local.set({ port, token: tokenEl.value.trim(), intercept: interceptEl.checked });
}

document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await save();
    showMessage('✓ Opciones guardadas.', 'ok');
  } catch (err) {
    showMessage(err.message, 'error');
  }
});

document.getElementById('test').addEventListener('click', async () => {
  try {
    await save(); // Probamos con lo que está escrito ahora mismo.
    showMessage('Probando…');
    const s = await ldPing();
    if (s.online && s.authorized) showMessage(`✓ Conectado con LibreDescarga v${s.version}.`, 'ok');
    else if (s.online) showMessage('La app responde, pero el token no coincide.', 'error');
    else showMessage('No hay respuesta. ¿Está LibreDescarga abierta y el servidor activado?', 'error');
  } catch (err) {
    showMessage(err.message, 'error');
  }
});

// Rellenamos el formulario con lo guardado.
ldGetConfig().then((config) => {
  portEl.value = config.port;
  tokenEl.value = config.token;
  interceptEl.checked = config.intercept;
});
