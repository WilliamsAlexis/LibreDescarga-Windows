/**
 * state.js
 * -----------------------------------------------------------------------------
 * ESTADO DE LA INTERFAZ en un único objeto compartido por todos los módulos
 * (app.js y dialogs.js), más las reglas de filtrado y ordenación.
 *
 * La fuente de la verdad son los datos que envía el proceso principal; aquí
 * solo guardamos una copia para pintar la pantalla, y lo que el usuario
 * eligió ver (filtros, búsqueda, selección, orden).
 * -----------------------------------------------------------------------------
 */

import { percentOf } from './format.js';

export const state = {
  items: new Map(), // id -> descarga
  settings: null, // configuración actual
  categories: [], // [{id, label, icon}]
  server: null, // estado del servidor del navegador
  stats: null, // velocidad total, activas, en cola
  version: '',
  update: null, // estado de las actualizaciones (ver services/updater.js)
  statusFilter: 'all', // vista de la barra lateral (ver STATUS_VIEWS)
  categoryFilter: null, // id de categoría o null = todas
  search: '', // texto de búsqueda
  selected: new Set(), // ids seleccionados
  lastClickedId: null, // para seleccionar rangos con Mayús
  sort: { key: 'createdAt', dir: 'desc' },
};

/** Estados agrupados para los filtros de la barra lateral. */
const ACTIVE = ['downloading', 'merging', 'queued'];
const UNFINISHED = ['paused', 'error', 'canceled'];

/** Vistas por estado que aparecen en la barra lateral. */
export const STATUS_VIEWS = [
  { id: 'all', label: 'Todas', icon: 'layers', match: () => true },
  { id: 'active', label: 'En curso', icon: 'arrow-down-to-line', match: (i) => ACTIVE.includes(i.status) },
  { id: 'completed', label: 'Completadas', icon: 'circle-check', match: (i) => i.status === 'completed' },
  { id: 'unfinished', label: 'Sin terminar', icon: 'circle-pause', match: (i) => UNFINISHED.includes(i.status) },
  { id: 'scheduled', label: 'Programadas', icon: 'calendar-clock', match: (i) => i.status === 'scheduled' },
];

/**
 * ¿Debe mostrarse esta descarga con los filtros actuales?
 * @param {object} item
 * @returns {boolean}
 */
export function matchesFilters(item) {
  const view = STATUS_VIEWS.find((v) => v.id === state.statusFilter) || STATUS_VIEWS[0];
  if (!view.match(item)) return false;
  if (state.categoryFilter && item.category !== state.categoryFilter) return false;
  if (state.search) {
    const text = `${item.fileName} ${item.url}`.toLowerCase();
    if (!text.includes(state.search.toLowerCase())) return false;
  }
  return true;
}

/** Orden lógico de los estados (para ordenar por la columna Estado). */
const STATUS_ORDER = ['downloading', 'merging', 'queued', 'scheduled', 'paused', 'error', 'canceled', 'completed'];

/**
 * Valor por el que se ordena una descarga según la columna elegida.
 * @param {object} item
 * @param {string} key
 * @returns {number|string}
 */
function sortValue(item, key) {
  switch (key) {
    case 'fileName': return item.fileName.toLowerCase();
    case 'progress': return percentOf(item) ?? -1;
    case 'status': return STATUS_ORDER.indexOf(item.status);
    default: return item[key] ?? -1;
  }
}

/**
 * Lista de descargas visibles, filtrada y ordenada.
 * @returns {object[]}
 */
export function visibleItems() {
  const { key, dir } = state.sort;
  const factor = dir === 'asc' ? 1 : -1;
  return [...state.items.values()]
    .filter(matchesFilters)
    .sort((a, b) => {
      const va = sortValue(a, key);
      const vb = sortValue(b, key);
      if (va < vb) return -1 * factor;
      if (va > vb) return 1 * factor;
      return b.createdAt - a.createdAt; // Desempate: la más nueva primero.
    });
}

/**
 * Descargas seleccionadas (objetos completos).
 * @returns {object[]}
 */
export function selectedItems() {
  return [...state.selected].map((id) => state.items.get(id)).filter(Boolean);
}
