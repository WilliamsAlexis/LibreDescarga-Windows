/**
 * generate-icons.js
 * -----------------------------------------------------------------------------
 * Script de utilidad que DIBUJA los iconos de la aplicación (y de la extensión
 * del navegador) píxel a píxel y los guarda como archivos PNG.
 *
 * ¿Por qué hacerlo así? Para no depender de programas de diseño ni de
 * librerías externas: solo usamos módulos que ya trae Node.js (zlib y fs).
 *
 * Uso:  npm run icons
 *
 * Genera:
 *   assets/icon.png            (256x256, icono principal / instalador)
 *   assets/tray.png            (32x32, icono de la bandeja del sistema)
 *   extension/icons/icon16.png, icon48.png, icon128.png
 * -----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* ---------------------------------------------------------------------------
 * 1) Utilidades para escribir un archivo PNG
 * ------------------------------------------------------------------------- */

/**
 * Tabla precalculada para el algoritmo CRC32 (lo exige el formato PNG
 * para comprobar que cada "chunk" no está corrupto).
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      // Si el bit más bajo es 1, aplicamos el polinomio estándar de CRC32.
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Calcula el CRC32 de un buffer.
 * @param {Buffer} buf - Datos de entrada.
 * @returns {number} El CRC32 como entero sin signo.
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Crea un "chunk" PNG: [longitud][tipo][datos][crc].
 * @param {string} type - Tipo de chunk de 4 letras (IHDR, IDAT, IEND).
 * @param {Buffer} data - Contenido del chunk.
 * @returns {Buffer} El chunk completo listo para concatenar.
 */
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/**
 * Convierte un lienzo RGBA en un archivo PNG.
 * @param {number} size - Ancho y alto (el icono es cuadrado).
 * @param {Uint8ClampedArray} rgba - Píxeles en formato R,G,B,A consecutivos.
 * @returns {Buffer} Bytes del archivo PNG.
 */
function encodePng(size, rgba) {
  // Cabecera IHDR: ancho, alto, 8 bits por canal, tipo de color 6 (RGBA).
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compresión
  ihdr[11] = 0; // filtro
  ihdr[12] = 0; // sin entrelazado

  // Cada fila del PNG empieza con un byte de "filtro" (0 = ninguno).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size * 4; x++) {
      raw[y * (size * 4 + 1) + 1 + x] = rgba[y * size * 4 + x];
    }
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------------------
 * 2) El dibujo: un cuadrado redondeado con degradado y una flecha hacia abajo
 *    Trabajamos en coordenadas normalizadas (0..1) para que sirva a cualquier
 *    tamaño.
 * ------------------------------------------------------------------------- */

/**
 * ¿Está el punto (x,y) dentro de un rectángulo con esquinas redondeadas?
 * @returns {boolean}
 */
function inRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  // Buscamos el punto más cercano dentro del rectángulo "interior" y medimos
  // la distancia: si es menor que el radio, estamos dentro de la esquina.
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/**
 * ¿Está el punto dentro de un triángulo? Usa el signo del producto cruzado.
 * @returns {boolean}
 */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Devuelve el color [r,g,b,a] del icono en un punto normalizado (u,v).
 * @param {number} u - Coordenada horizontal 0..1.
 * @param {number} v - Coordenada vertical 0..1.
 * @returns {number[]} Color RGBA (0..255).
 */
function samplePixel(u, v) {
  // Fondo: cuadrado redondeado con degradado azul -> violeta.
  if (!inRoundedRect(u, v, 0.04, 0.04, 0.96, 0.96, 0.22)) return [0, 0, 0, 0];

  // Flecha blanca: palo vertical + punta triangular + barra inferior.
  const isShaft = inRoundedRect(u, v, 0.43, 0.18, 0.57, 0.56, 0.04);
  const isHead = inTriangle(u, v, 0.24, 0.48, 0.76, 0.48, 0.5, 0.74);
  const isBase = inRoundedRect(u, v, 0.24, 0.79, 0.76, 0.86, 0.035);
  if (isShaft || isHead || isBase) return [255, 255, 255, 255];

  // Degradado diagonal: t = 0 arriba-izquierda, 1 abajo-derecha.
  const t = (u + v) / 2;
  const from = [37, 99, 235]; // azul (#2563eb)
  const to = [124, 58, 237]; // violeta (#7c3aed)
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
    255,
  ];
}

/**
 * Dibuja el icono a un tamaño concreto con "supersampling" (antialiasing):
 * por cada píxel tomamos 4x4 muestras y promediamos, así los bordes salen
 * suaves en lugar de dentados.
 * @param {number} size - Tamaño en píxeles.
 * @returns {Buffer} PNG resultante.
 */
function renderIcon(size) {
  const SAMPLES = 4;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const [pr, pg, pb, pa] = samplePixel(
            (x + (sx + 0.5) / SAMPLES) / size,
            (y + (sy + 0.5) / SAMPLES) / size,
          );
          // Premultiplicamos por alfa para que el promedio sea correcto.
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      }
      const i = (y * size + x) * 4;
      const n = SAMPLES * SAMPLES;
      rgba[i] = a ? r / a : 0;
      rgba[i + 1] = a ? g / a : 0;
      rgba[i + 2] = a ? b / a : 0;
      rgba[i + 3] = a / n;
    }
  }
  return encodePng(size, rgba);
}

/* ---------------------------------------------------------------------------
 * 3) Guardar todos los tamaños necesarios
 * ------------------------------------------------------------------------- */

/**
 * Función principal: genera y guarda cada icono.
 * @returns {void}
 */
function main() {
  const root = path.join(__dirname, '..');
  const outputs = [
    { file: 'assets/icon.png', size: 256 },
    { file: 'assets/tray.png', size: 32 },
    { file: 'extension/icons/icon16.png', size: 16 },
    { file: 'extension/icons/icon48.png', size: 48 },
    { file: 'extension/icons/icon128.png', size: 128 },
  ];
  for (const { file, size } of outputs) {
    try {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, renderIcon(size));
      console.log(`✔ ${file} (${size}x${size})`);
    } catch (err) {
      console.error(`✘ No se pudo generar ${file}:`, err.message);
      process.exitCode = 1;
    }
  }
}

main();
