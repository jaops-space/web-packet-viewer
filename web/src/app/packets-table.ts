import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { Row } from '../../../wasm/dist/packet-viewer-client.js';
import { ContextMenu, MenuItem } from './context-menu';
import { Viewer } from './viewer';

const ROW = 22;
const MARGIN = 30;
/**
 * The tallest the rows element gets: browsers cap the height of an element (Firefox at about 17.9M px, 800k rows),
 * so beyond it the scroll position is mapped proportionally to the rows.
 */
const MAX_HEIGHT = 8_000_000;

/**
 * The packets table (Java PacketsTable): #, Generation Time, Packet Name, Length and the parameter columns; no
 * sorting. Virtual: only the rows in view are fetched from the worker.
 */
@Component({
  selector: 'pv-packets',
  imports: [ContextMenu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pv-packets' },
  template: `
    <div #body class="pv-scroll" tabindex="0" (scroll)="onScroll()" (keydown)="key($event)">
      <div class="pv-grid pv-head" [style.grid-template-columns]="template()">
        <div class="r" (contextmenu)="headerMenu($event, -1)">#</div>
        <div (contextmenu)="headerMenu($event, -1)">Generation Time</div>
        <div (contextmenu)="headerMenu($event, -1)">Packet Name</div>
        <div class="r" (contextmenu)="headerMenu($event, -1)">Length</div>
        @for (c of viewer.columns(); track c; let i = $index) {
          <div class="pv-colhead" [title]="c + ' (right-click: Hide Column)'" (contextmenu)="headerMenu($event, i)">
            {{ shortName(c) }}
          </div>
        }
      </div>
      <div class="pv-rows" [style.height.px]="height()">
        <div [style.transform]="'translateY(' + offset() + 'px)'">
          @for (r of rows(); track r.nr) {
            <div
              class="pv-grid pv-row"
              [style.grid-template-columns]="template()"
              [class.sel]="r.nr === viewer.selectedNr()"
              [class.marked]="r.marked"
              (mousedown)="viewer.select(r.nr, false)"
              (contextmenu)="rowMenu($event, r)">
              <div class="r">{{ r.nr }}</div>
              <div>{{ r.generationTime }}</div>
              <div [title]="r.name">{{ r.name }}</div>
              <div class="r">{{ r.length }}</div>
              @for (v of r.columns; track $index) {
                <div [title]="v ?? ''">{{ v ?? '' }}</div>
              }
            </div>
          }
        </div>
      </div>
      @if (!rowCount()) {
        <div class="pv-empty">{{ empty() }}</div>
      }
    </div>
    @if (menu(); as m) {
      <pv-context-menu [x]="m.x" [y]="m.y" [items]="m.items" (closed)="menu.set(null)" />
    }
  `,
})
export class PacketsTable {
  readonly viewer = inject(Viewer);
  readonly ROW = ROW;
  readonly goTo = output<void>();
  private readonly body = viewChild.required<ElementRef<HTMLDivElement>>('body');
  readonly rowCount = computed(() => this.viewer.status().rowCount);
  readonly rows = signal<Row[]>([]);
  /** where the rows fetched are drawn in the rows element */
  readonly offset = signal(0);
  readonly height = computed(() => Math.min(this.rowCount() * ROW, MAX_HEIGHT));
  readonly menu = signal<{ x: number; y: number; items: MenuItem[] } | null>(null);
  private readonly viewport = signal({ top: 0, height: 600 });
  private fetchSeq = 0;
  private resize = new ResizeObserver(() => this.onScroll());

  readonly template = computed(() => `64px 215px minmax(160px, 1fr) 60px ${'minmax(110px, 160px) '.repeat(this.viewer.columns().length)}`);

  readonly empty = computed(() => {
    const v = this.viewer;
    if (v.status().packetCount && v.filter().applied) return 'No packet matches the display filter';
    if (v.source().kind === 'live') return 'Waiting for packets…';
    return v.ready() ? 'No packets. File → Open… a packet file, or Connect to Yamcs' : '';
  });

  constructor() {
    effect(() => {
      this.viewer.version();
      const { top, height } = this.viewport();
      const count = this.rowCount();
      untracked(() => this.fetch(top, height, count));
    });
    effect(() => {
      const s = this.viewer.scrollTo();
      if (s) untracked(() => requestAnimationFrame(() => this.reveal(s.row)));
    });
    effect((onCleanup) => {
      const el = this.body().nativeElement;
      this.resize.observe(el);
      onCleanup(() => this.resize.disconnect());
    });
  }

  /** virtual position (all the rows at their height) per pixel of scroll; 1 below MAX_HEIGHT */
  private scale(count: number, visible: number) {
    const total = count * ROW;
    return total > MAX_HEIGHT ? (total - visible) / (MAX_HEIGHT - visible) : 1;
  }

  private async fetch(top: number, height: number, count: number) {
    const visible = height - ROW; // below the header
    const virtualTop = top * this.scale(count, visible);
    const from = Math.max(0, Math.floor(virtualTop / ROW) - MARGIN);
    const to = Math.min(count, Math.ceil((virtualTop + visible) / ROW) + MARGIN);
    const seq = ++this.fetchSeq;
    if (to <= from) {
      this.rows.set([]);
      this.offset.set(0);
      return;
    }
    const r = await this.viewer.rows(from, to);
    if (seq !== this.fetchSeq) return;
    this.offset.set(top + from * ROW - virtualTop);
    this.rows.set(r.rows);
  }

  onScroll() {
    const el = this.body().nativeElement;
    this.viewport.set({ top: el.scrollTop, height: el.clientHeight });
  }

  /** scrolls the row into view (below the sticky header) */
  private reveal(row: number) {
    const el = this.body().nativeElement;
    const visible = el.clientHeight - ROW; // the header
    const scale = this.scale(this.rowCount(), visible);
    const y = row * ROW;
    const virtualTop = el.scrollTop * scale;
    if (y < virtualTop) el.scrollTop = y / scale;
    else if (y + ROW > virtualTop + visible) el.scrollTop = Math.ceil((y + ROW - visible) / scale);
  }

  focus() {
    this.body().nativeElement.focus();
  }

  key(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const page = Math.max(1, Math.floor(this.body().nativeElement.clientHeight / ROW) - 2);
    switch (e.key) {
      case 'ArrowUp':
        this.viewer.neighbour(true);
        break;
      case 'ArrowDown':
        this.viewer.neighbour(false);
        break;
      case 'PageUp':
        this.selectRow(Math.max(0, (this.viewer.details()?.row ?? 0) - page));
        break;
      case 'PageDown':
        this.selectRow(Math.min(this.rowCount() - 1, (this.viewer.details()?.row ?? -1) + page));
        break;
      case 'Home':
        this.selectRow(0);
        break;
      case 'End':
        this.selectRow(this.rowCount() - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  private async selectRow(row: number) {
    if (row < 0) return;
    const { rows } = await this.viewer.rows(row, row + 1);
    if (rows.length) await this.viewer.select(rows[0].nr);
  }

  rowMenu(e: MouseEvent, r: Row) {
    e.preventDefault();
    this.viewer.select(r.nr, false).then(() => {
      this.menu.set({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: r.marked ? 'Unmark Packet' : 'Mark Packet', shortcut: 'Ctrl+M', action: () => this.viewer.toggleMark() },
          { label: 'Go to Packet…', shortcut: 'Ctrl+G', action: () => this.goTo.emit() },
        ],
      });
    });
  }

  /** index of the parameter column; -1: a fixed column, which cannot be hidden (Java: Hide Column disabled) */
  headerMenu(e: MouseEvent, index: number) {
    e.preventDefault();
    this.menu.set({
      x: e.clientX,
      y: e.clientY,
      items: [{ label: 'Hide Column', disabled: index < 0, action: () => this.viewer.removeColumn(index) }],
    });
  }

  shortName(qn: string) {
    return qn.substring(qn.lastIndexOf('/') + 1);
  }
}
