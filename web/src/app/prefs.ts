/**
 * What the viewer remembers per Yamcs instance in browser storage: the parameter columns, the filter history, the
 * source last used, the View options, the pane and column sizes.
 */
export interface Prefs {
  /** qualified names of the parameter columns of the packets table */
  columns: string[];
  /** most recent first, at most 10 */
  filterHistory: string[];
  autoScroll: boolean;
  autoSelect: boolean;
  /** widths/heights in px */
  packetsWidth: number;
  hexHeight: number;
  /** packets table column widths in px, by column key ('#', 'time', 'name', 'length' or a parameter qualified name) */
  columnWidths: Record<string, number>;
  /** Parameters table column widths in px, by column key */
  paramColumnWidths: Record<string, number>;
  lastSource?: 'live' | 'archive' | 'file';
  stream?: string;
  /** the file format last used */
  format?: number;
  /** interval: an ISO duration back from now, or CUSTOM (start, stop) */
  archive?: { interval: string; start: string; stop: string; names: string[] };
}

const DEFAULTS: Prefs = {
  columns: [],
  filterHistory: [],
  autoScroll: true,
  autoSelect: false,
  packetsWidth: 640,
  hexHeight: 260,
  columnWidths: {},
  paramColumnWidths: {},
};

export const MAX_FILTER_HISTORY = 10;

export function loadPrefs(instance: string): Prefs {
  try {
    const s = localStorage.getItem(key(instance));
    if (s) return { ...DEFAULTS, ...JSON.parse(s) };
  } catch {
    // unavailable or invalid: defaults
  }
  return { ...DEFAULTS };
}

export function savePrefs(instance: string, p: Prefs) {
  try {
    localStorage.setItem(key(instance), JSON.stringify(p));
  } catch {
    // storage unavailable: preferences last for this page only
  }
}

function key(instance: string) {
  return `packet-viewer.${instance}`;
}

/** PacketViewer.updateFilterHistory */
export function pushHistory(history: string[], filter: string): string[] {
  if (!filter.trim()) return history;
  return [filter, ...history.filter((h) => h !== filter)].slice(0, MAX_FILTER_HISTORY);
}
