/**
 * stores.js
 * -----------------------------------------------------------------------------
 * ALMACENAMIENTO PERSISTENTE con electron-store.
 *
 * electron-store guarda objetos JavaScript como archivos JSON dentro de la
 * carpeta de datos de la app (%APPDATA%/libredescarga en Windows) y escribe
 * de forma "atómica" (primero a un archivo temporal y luego lo renombra), así
 * que un apagón no deja el archivo corrupto.
 *
 * Usamos dos archivos:
 *   - settings.json   -> la configuración del usuario.
 *   - downloads.json  -> la lista de descargas (historial + progreso).
 * -----------------------------------------------------------------------------
 */

const Store = require('electron-store');
const { createDefaultSettings, sanitizeSettings } = require('../services/settingsService');

/**
 * Crea los almacenes y carga la configuración.
 * @param {string} downloadsPath - Carpeta "Descargas" del usuario (para los valores por defecto).
 * @returns {{
 *   getSettings: () => object,
 *   saveSettings: (changes: object) => object,
 *   downloadsStorage: {load: () => object[], save: (items: object[]) => void}
 * }}
 */
function createStores(downloadsPath) {
  const defaults = createDefaultSettings(downloadsPath);
  const settingsStore = new Store({ name: 'settings' });
  const downloadsStore = new Store({ name: 'downloads', defaults: { items: [] } });

  // Mezclamos lo guardado con los valores por defecto (por si en una versión
  // nueva aparecen opciones que el archivo antiguo no tenía) y validamos.
  let settings = sanitizeSettings(settingsStore.store, defaults);
  // Si no había token guardado, nos quedamos con el generado y lo persistimos.
  if (!settingsStore.get('serverToken')) settings.serverToken = defaults.serverToken;
  settingsStore.store = settings;

  return {
    /** @returns {object} Configuración actual (no modificar directamente). */
    getSettings: () => settings,

    /**
     * Valida, aplica y guarda cambios de configuración.
     * @param {object} changes - Cambios parciales.
     * @returns {object} Configuración resultante.
     */
    saveSettings(changes) {
      settings = sanitizeSettings(changes, settings);
      settingsStore.store = settings;
      return settings;
    },

    downloadsStorage: {
      load: () => downloadsStore.get('items', []),
      save: (items) => downloadsStore.set('items', items),
    },
  };
}

module.exports = { createStores };
