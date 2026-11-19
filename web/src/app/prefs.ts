/**
 * What the Java viewer keeps in its Preferences, per Yamcs instance in browser storage: the parameter columns, the
 * filter history, the recent files, the View options, the pane sizes.
 */
export interface Prefs {
  /** qualified names of the parameter columns of the packets table */
  columns: string[];
  /** most recent first, at most 10 */
  filterHistory: string[];
  /** most recent first, at most 4: a file can only be opened again by choosing it */
  recent: { name: string; format: number }[];
  autoScroll: boolean;
  autoSelect: boolean;
  /** widths/heights in px */
  packetsWidth: number;
  hexHeight: number;
  logHeight: number;
  lastSource?: 'live' | 'archive' | 'file';
  archive?: { start: string; stop: string; names: string[] };
}

const DEFAULTS: Prefs = {
  columns: [],
  filterHistory: [],
  recent: [],
  autoScroll: true,
  autoSelect: false,
  packetsWidth: 640,
  hexHeight: 260,
  logHeight: 90,
};

export const MAX_FILTER_HISTORY = 10;
export const MAX_RECENT = 4;

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
