/**
 * preload.js
 * -----------------------------------------------------------------------------
 * EL PUENTE SEGURO entre la interfaz (renderer) y el proceso principal.
 *
 * Este archivo se ejecuta antes de cargar la página y tiene acceso a una
 * parte mínima de Electron (ipcRenderer). Con `contextBridge` publicamos en
 * la página un objeto `window.api` con funciones CONCRETAS. La página puede
 * usarlas, pero nunca ve ipcRenderer ni Node.js directamente.
 *
 * Así, aunque una página maliciosa llegara a ejecutarse en la ventana, solo
 * podría hacer lo que estas funciones permiten (y el proceso principal
 * además valida cada petición).
 * -----------------------------------------------------------------------------
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Llama a un canal del proceso principal y "desenvuelve" la respuesta.
 * El proceso principal responde { data } o { error } (ver ipc.js).
 * @param {string} channel - Canal IPC.
 * @param {...any} args - Argumentos.
 * @returns {Promise<any>} El dato devuelto; lanza un Error si hubo error.
 */
async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (response?.error) throw new Error(response.error);
  return response?.data;
}

/** Canales que el proceso principal puede enviar a la interfaz (lista blanca). */
const EVENT_CHANNELS = [
  'downloads:updated',
  'downloads:removed',
  'stats',
  'settings:changed',
  'server:status',
  'clipboard:url',
  'browser:request',
  'ui:open-add',
  'update:status',
];

contextBridge.exposeInMainWorld('api', {
  // --- Estado ---
  getState: () => invoke('app:get-state'),

  // --- Descargas ---
  addDownload: (data) => invoke('downloads:add', data),
  resolveUrl: (url, options) => invoke('media:resolve', url, options),
  addMedia: (data) => invoke('downloads:add-media', data),
  engineInfo: () => invoke('media:engine-info'),
  updateEngine: () => invoke('media:update-engine'),
  pause: (ids) => invoke('downloads:action', 'pause', ids),
  resume: (ids) => invoke('downloads:action', 'resume', ids),
  cancel: (ids) => invoke('downloads:action', 'cancel', ids),
  remove: (ids, deleteFiles = false) => invoke('downloads:action', deleteFiles ? 'remove-with-file' : 'remove', ids),
  schedule: (ids, timestamp) => invoke('downloads:schedule', ids, timestamp),
  pauseAll: () => invoke('downloads:pause-all'),
  resumeAll: () => invoke('downloads:resume-all'),
  clearCompleted: () => invoke('downloads:clear-completed'),
  openFile: (id) => invoke('downloads:open-file', id),
  openFolder: (id) => invoke('downloads:open-folder', id),
  copyUrl: (id) => invoke('downloads:copy-url', id),

  // --- Configuración y utilidades ---
  saveSettings: (changes) => invoke('settings:save', changes),
  regenerateToken: () => invoke('settings:regenerate-token'),
  chooseFolder: (defaultPath) => invoke('dialog:choose-folder', defaultPath),
  openExtensionFolder: () => invoke('extension:open-folder'),
  checkUpdate: () => invoke('update:check'),
  downloadUpdate: () => invoke('update:download'),
  installUpdate: () => invoke('update:install'),
  openExternal: (url) => invoke('shell:open-external', url),

  /**
   * Suscribe una función a un evento del proceso principal.
   * @param {string} channel - Uno de EVENT_CHANNELS.
   * @param {(payload: any) => void} callback
   * @returns {() => void} Función para cancelar la suscripción.
   */
  on(channel, callback) {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error(`Canal no permitido: ${channel}`);
    // No pasamos el objeto `event` de Electron a la página (expondría ipcRenderer).
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
