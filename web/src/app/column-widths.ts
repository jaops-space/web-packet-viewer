import { computed, signal } from '@angular/core';
import { Prefs } from './prefs';
import { Viewer } from './viewer';

const MIN_WIDTH = 30;

type WidthsKey = 'columnWidths' | 'paramColumnWidths';

/**
 * Resizable table columns: the widths in px by column key, saved in the preferences when the mouse is released.
 * The handle is a `.pv-colresize` element inside the header cell, on its right edge; double-click resets the column.
 */
export class ColumnWidths {
  /** the widths while a column is being resized */
  private readonly dragging = signal<Record<string, number> | null>(null);
  private readonly saved = computed(() => this.viewer.prefs()[this.key] ?? {});
  /** the current widths, without the defaults */
  readonly widths = computed(() => this.dragging() ?? this.saved());

  constructor(
    private readonly viewer: Viewer,
    private readonly key: WidthsKey,
    private readonly defaults: (column: string) => number,
  ) {}

  width(column: string) {
    return this.widths()[column] ?? this.defaults(column);
  }

  /** mousedown on the handle */
  start(e: MouseEvent, column: string) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cell = (e.target as HTMLElement).parentElement!;
    const initial = cell.getBoundingClientRect().width;
    const x = e.clientX;
    const base = { ...this.saved() };
    const move = (m: MouseEvent) => {
      this.dragging.set({ ...base, [column]: Math.max(MIN_WIDTH, Math.round(initial + m.clientX - x)) });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('pv-col-resizing');
      const w = this.dragging();
      this.dragging.set(null);
      if (w) this.viewer.updatePrefs({ [this.key]: w } as Partial<Prefs>);
    };
    document.body.classList.add('pv-col-resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  /** back to the default width */
  reset(column: string) {
    const { [column]: _, ...rest } = this.saved();
    this.viewer.updatePrefs({ [this.key]: rest } as Partial<Prefs>);
  }
}
