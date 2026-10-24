/**
 * tray.js
 * -----------------------------------------------------------------------------
 * ICONO EN LA BANDEJA DEL SISTEMA (junto al reloj de Windows).
 *
 * Permite que la app siga descargando con la ventana cerrada. Con clic se
 * muestra la ventana; con clic derecho aparece un menú con acciones rápidas.
 * -----------------------------------------------------------------------------
 */

const path = require('node:path');
const { Tray, Menu, nativeImage } = require('electron');

/**
 * Crea el icono de la bandeja.
 * @param {object} actions - Funciones a ejecutar desde el menú.
 * @param {() => void} actions.onShow - Mostrar la ventana.
 * @param {() => void} actions.onAddUrl - Abrir el diálogo "Agregar URL".
 * @param {() => void} actions.onPauseAll - Pausar todas.
 * @param {() => void} actions.onResumeAll - Reanudar todas.
 * @param {() => void} actions.onQuit - Salir de verdad.
 * @returns {{tray: Tray, update: (stats: object, formatSpeed: (n:number)=>string) => void}}
 */
function createTray({ onShow, onAddUrl, onPauseAll, onResumeAll, onQuit }) {
  const image = nativeImage.createFromPath(path.join(__dirname, '../../assets/tray.png')).resize({ width: 16, height: 16 });
  const tray = new Tray(image);
  tray.setToolTip('LibreDescarga');

  const menu = Menu.buildFromTemplate([
    { label: 'Mostrar LibreDescarga', click: onShow },
    { label: 'Agregar URL…', click: onAddUrl },
    { type: 'separator' },
    { label: 'Reanudar todas', click: onResumeAll },
    { label: 'Pausar todas', click: onPauseAll },
    { type: 'separator' },
    { label: 'Salir', click: onQuit },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', onShow); // Clic izquierdo = mostrar ventana.

  /**
   * Actualiza el texto que aparece al pasar el ratón por encima.
   * @param {{active:number, queued:number, totalSpeed:number}} stats
   * @param {(n:number) => string} formatSpeed - Formatea bytes/s a texto.
   * @returns {void}
   */
  function update(stats, formatSpeed) {
    const text = stats.active
      ? `LibreDescarga — ${stats.active} activa(s) · ${formatSpeed(stats.totalSpeed)}`
      : 'LibreDescarga — sin descargas activas';
    tray.setToolTip(text);
  }

  return { tray, update };
}

module.exports = { createTray };
