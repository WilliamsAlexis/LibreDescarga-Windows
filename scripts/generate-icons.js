/**
 * generate-icons.js
 * -----------------------------------------------------------------------------
 * Genera TODOS los iconos de la aplicación y de la extensión del navegador a
 * partir de un único dibujo: assets/logo.svg (el mismo logo que la app de
 * Android de LibreDescarga).
 *
 * Para convertir el SVG en PNG usamos @resvg/resvg-js (un renderizador de SVG
 * que no necesita Electron ni un navegador).
 *
 * Uso:  npm run icons
 *
 * Genera:
 *   assets/icon.png            512x512  Icono principal (ventana, instalador, notificaciones)
 *   assets/tray.png             64x64   Icono de la bandeja del sistema (se muestra a 16x16 o 32x32)
 *   extension/icons/icon16.png   16x16  Extensión del navegador
 *   extension/icons/icon48.png   48x48
 *   extension/icons/icon128.png 128x128
 * -----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'logo.svg');

/** Cada icono que hay que generar: archivo de salida y tamaño en píxeles. */
const TARGETS = [
  { file: 'assets/icon.png', size: 512 },
  { file: 'assets/tray.png', size: 64 },
  { file: 'extension/icons/icon16.png', size: 16 },
  { file: 'extension/icons/icon48.png', size: 48 },
  { file: 'extension/icons/icon128.png', size: 128 },
];

/**
 * Convierte el SVG en un PNG cuadrado con fondo transparente.
 * @param {string} svg - Contenido del archivo SVG.
 * @param {number} size - Lado del PNG en píxeles.
 * @returns {Buffer} Datos del PNG.
 */
function renderPng(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size }, shapeRendering: 2, imageRendering: 0 });
  return resvg.render().asPng();
}

/**
 * Punto de entrada: lee el SVG y escribe cada PNG.
 * @returns {void}
 */
function main() {
  const svg = fs.readFileSync(SOURCE, 'utf8');
  for (const { file, size } of TARGETS) {
    const destination = path.join(ROOT, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, renderPng(svg, size));
    console.log(`  ${file}  (${size}x${size})`);
  }
  console.log('Iconos generados desde assets/logo.svg');
}

main();
