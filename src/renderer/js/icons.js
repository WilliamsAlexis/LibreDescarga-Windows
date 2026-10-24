/**
 * icons.js
 * -----------------------------------------------------------------------------
 * Ayudante para usar los iconos de Lucide.
 *
 * La librería (cargada en index.html) expone `window.lucide.icons`, un objeto
 * con cada icono descrito como datos, por ejemplo:
 *   Download: [["path", {d: "M12 15V3"}], ["path", {...}], ...]
 * Aquí convertimos esos datos en el texto de un <svg> listo para insertar.
 * -----------------------------------------------------------------------------
 */

/**
 * "arrow-down-to-line" -> "ArrowDownToLine" (así se llaman las claves en Lucide).
 * @param {string} name
 * @returns {string}
 */
function toPascalCase(name) {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Devuelve el HTML de un icono SVG.
 * @param {string} name - Nombre del icono en Lucide (p. ej. "download").
 * @param {number} [size=18] - Tamaño en píxeles.
 * @param {string} [extraClass=''] - Clases CSS adicionales (p. ej. "spin").
 * @returns {string} Código SVG (o '' si el icono no existe).
 */
export function icon(name, size = 18, extraClass = '') {
  const node = window.lucide?.icons?.[toPascalCase(name)];
  if (!node) return '';
  const children = node
    .map(([tag, attrs]) => {
      const attributes = Object.entries(attrs)
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ');
      return `<${tag} ${attributes}/>`;
    })
    .join('');
  return (
    `<svg class="icon ${extraClass}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${children}</svg>`
  );
}

/**
 * Rellena todos los elementos con atributo data-icon="nombre" dentro de `root`.
 * Ejemplo en HTML: <span data-icon="play" data-size="16"></span>
 * @param {ParentNode} [root=document]
 * @returns {void}
 */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 18);
  });
}
