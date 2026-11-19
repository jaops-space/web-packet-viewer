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
import type { ParamRow, TreeNode } from '../../../wasm/dist/packet-viewer-client.js';
import { NgTemplateOutlet } from '@angular/common';
import { ContextMenu, MenuItem } from './context-menu';
import { Viewer } from './viewer';

/**
 * The right side of the Java viewer above the hex dump: the Parameters and Structure tabs of the selected packet and
 * the find bar (FindParameterBar).
 */
@Component({
  selector: 'pv-details',
  imports: [ContextMenu, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pv-details' },
  template: `
    <div class="pv-tabs">
      <button [class.active]="tab() === 'params'" (click)="tab.set('params')">Parameters</button>
      <button [class.active]="tab() === 'tree'" (click)="tab.set('tree')">Structure</button>
      <span class="pv-grow"></span>
      @if (viewer.details(); as d) {
        <span class="pv-mute pv-ellipsis" [title]="d.name">#{{ d.nr }} {{ d.name }}</span>
      }
    </div>
    @if (viewer.details()?.decodeError; as err) {
      <div class="pv-decode-error">{{ err }}</div>
    }
    <div class="pv-pane" #pane>
      @if (tab() === 'params') {
        <table class="pv-params">
          <thead>
            <tr>
              <th>Name</th>
              <th>Eng Value</th>
              <th>Raw Value</th>
              <th>Nominal Low</th>
              <th>Nominal High</th>
              <th>Danger Low</th>
              <th>Danger High</th>
              <th class="r">Bit Offset</th>
              <th class="r">Bit Size</th>
              <th>Calibration</th>
            </tr>
          </thead>
          <tbody>
            @for (p of params(); track $index; let i = $index) {
              <tr
                [class.sel]="selected().has(i)"
                [class.match]="matches().includes(i)"
                [attr.data-row]="i"
                (mousedown)="click($event, i)"
                (contextmenu)="paramMenu($event, i, p)">
                <td [class.b]="matches().includes(i)">{{ p.name }}</td>
                <td>{{ p.engValue }}</td>
                <td>{{ p.rawValue ?? '-' }}</td>
                <td>{{ p.nominalLow }}</td>
                <td>{{ p.nominalHigh }}</td>
                <td>{{ p.dangerLow }}</td>
                <td>{{ p.dangerHigh }}</td>
                <td class="r">{{ p.bitOffset ?? '-' }}</td>
                <td class="r">{{ p.bitSize ?? '-' }}</td>
                <td>
                  @switch (p.calibration.kind) {
                    @case ('enumeration') {
                      <a href="" (mousedown)="$event.stopPropagation()" (click)="$event.preventDefault(); lov.emit(p)">{{ $any(p.calibration).typeName }}</a>
                    }
                    @case ('text') {
                      {{ $any(p.calibration).text }}
                    }
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        @if (viewer.details(); as d) {
          <div class="pv-tree">
            <ng-container *ngTemplateOutlet="node; context: { $implicit: d.tree, path: 'r' }" />
          </div>
        }
      }
    </div>
    @if (findOpen()) {
      <div class="pv-find">
        <input
          #find
          placeholder="Find parameter"
          [value]="term()"
          (input)="term.set($any($event.target).value); next(1, true)"
          (keydown.enter)="next($any($event).shiftKey ? -1 : 1)"
          (keydown.escape)="closeFind()" />
        <button class="pv-icon" title="Previous (Shift+Enter)" (click)="next(-1)"><span class="material-symbols">keyboard_arrow_up</span></button>
        <button class="pv-icon" title="Next (Enter)" (click)="next(1)"><span class="material-symbols">keyboard_arrow_down</span></button>
        <span [class.pv-bad]="term() && !matches().length">{{ stats() }}</span>
        <span class="pv-grow"></span>
        <button class="pv-icon" title="Close (Esc)" (click)="closeFind()"><span class="material-symbols">close</span></button>
      </div>
    }
    <ng-template #node let-n let-path="path">
      <div
        class="pv-node"
        [class.sel]="treeSel().has(path)"
        [class.leaf]="!n.children.length"
        (mousedown)="treeClick($event, path, n)">
        @if (n.children.length) {
          <span class="material-symbols pv-twisty" (mousedown)="$event.stopPropagation(); toggle(path)">{{ collapsed().has(path) ? 'chevron_right' : 'expand_more' }}</span>
        } @else {
          <span class="pv-twisty"></span>
        }
        {{ n.label }}
      </div>
      @if (n.children.length && !collapsed().has(path)) {
        <div class="pv-indent">
          @for (c of n.children; track $index) {
            <ng-container *ngTemplateOutlet="node; context: { $implicit: c, path: path + '.' + $index }" />
          }
        </div>
      }
    </ng-template>
    @if (menu(); as m) {
      <pv-context-menu [x]="m.x" [y]="m.y" [items]="m.items" (closed)="menu.set(null)" />
    }
  `,
})
export class Details {
  readonly viewer = inject(Viewer);
  readonly lov = output<ParamRow>();
  readonly tab = signal<'params' | 'tree'>('params');
  readonly params = computed(() => this.viewer.details()?.params ?? []);
  readonly selected = signal<Set<number>>(new Set());
  private anchor = -1;
  readonly treeSel = signal<Map<string, TreeNode>>(new Map());
  readonly collapsed = signal<Set<string>>(new Set());
  readonly menu = signal<{ x: number; y: number; items: MenuItem[] } | null>(null);

  readonly findOpen = signal(false);
  readonly term = signal('');
  readonly current = signal(-1);
  private readonly findInput = viewChild<ElementRef<HTMLInputElement>>('find');
  private readonly pane = viewChild.required<ElementRef<HTMLDivElement>>('pane');

  /** ParametersTable.updateMatchingRows: substring of the name, ignoring case */
  readonly matches = computed(() => {
    const t = this.term().toLowerCase();
    if (!t || !this.findOpen()) return [];
    return this.params()
      .map((p, i) => (p.name.toLowerCase().includes(t) ? i : -1))
      .filter((i) => i >= 0);
  });

  readonly stats = computed(() => {
    if (!this.term()) return '';
    const m = this.matches();
    if (!m.length) return 'Parameter not found';
    const k = m.indexOf(this.current());
    return k >= 0 ? `${k + 1} of ${m.length}` : `${m.length} matches`;
  });

  constructor() {
    // a new packet: no selection (Java clears the tables)
    effect(() => {
      this.viewer.details();
      untracked(() => {
        this.selected.set(new Set());
        this.treeSel.set(new Map());
        this.collapsed.set(new Set());
        this.anchor = -1;
        this.current.set(-1);
      });
    });
  }

  // ---------------------------------------------------------------- parameters

  click(e: MouseEvent, i: number) {
    if (e.button === 2 && this.selected().has(i)) return;
    let s: Set<number>;
    if (e.shiftKey && this.anchor >= 0) {
      s = new Set(e.ctrlKey || e.metaKey ? this.selected() : []);
      for (let k = Math.min(this.anchor, i); k <= Math.max(this.anchor, i); k++) s.add(k);
    } else if (e.ctrlKey || e.metaKey) {
      s = new Set(this.selected());
      s.has(i) ? s.delete(i) : s.add(i);
      this.anchor = i;
    } else {
      s = new Set([i]);
      this.anchor = i;
    }
    this.setSelection(s);
  }

  private setSelection(s: Set<number>) {
    this.selected.set(s);
    const ranges: [number, number][] = [];
    for (const i of [...s].sort((a, b) => a - b)) {
      const p = this.params()[i];
      if (p && p.bitOffset !== null && p.bitSize !== null) ranges.push([p.bitOffset, p.bitSize]);
    }
    this.viewer.setHighlight(ranges);
  }

  paramMenu(e: MouseEvent, i: number, p: ParamRow) {
    e.preventDefault();
    const v = this.viewer;
    this.menu.set({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Apply as Left Column', action: () => v.addColumn(p.qualifiedName) },
        { label: 'Apply as Filter: Selected', separator: true, action: () => this.applyFilter(`${p.name} == ${p.engValue}`) },
        // !(x == x) rather than !=, which would only keep the packets that have the parameter
        { label: 'Apply as Filter: Not Selected', action: () => this.applyFilter(`!(${p.name} == ${p.engValue})`) },
      ],
    });
  }

  readonly filterRequest = output<string>();

  private applyFilter(expr: string) {
    this.filterRequest.emit(expr);
  }

  // ---------------------------------------------------------------- find bar

  openFind() {
    this.tab.set('params');
    this.findOpen.set(true);
    setTimeout(() => {
      this.findInput()?.nativeElement.focus();
      this.findInput()?.nativeElement.select();
    });
  }

  closeFind() {
    this.findOpen.set(false);
  }

  /** next/previous match relative to the selected row, wrapping around */
  next(dir: 1 | -1, fromCurrent = false) {
    const m = this.matches();
    if (!m.length) {
      this.current.set(-1);
      return;
    }
    const sel = [...this.selected()];
    const pos = sel.length ? (dir > 0 ? Math.min(...sel) : Math.max(...sel)) : -1;
    let target: number;
    if (fromCurrent && pos >= 0 && m.includes(pos)) target = pos;
    else if (dir > 0) target = m.find((i) => i > pos) ?? m[0];
    else target = [...m].reverse().find((i) => i < (pos < 0 ? Infinity : pos)) ?? m[m.length - 1];
    this.current.set(target);
    this.anchor = target;
    this.setSelection(new Set([target]));
    setTimeout(() => this.pane().nativeElement.querySelector(`[data-row="${target}"]`)?.scrollIntoView({ block: 'nearest' }));
  }

  // ---------------------------------------------------------------- structure

  toggle(path: string) {
    this.collapsed.update((c) => {
      const n = new Set(c);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });
  }

  treeClick(e: MouseEvent, path: string, n: TreeNode) {
    let s: Map<string, TreeNode>;
    if (e.ctrlKey || e.metaKey) {
      s = new Map(this.treeSel());
      s.has(path) ? s.delete(path) : s.set(path, n);
    } else {
      s = new Map([[path, n]]);
    }
    this.treeSel.set(s);
    const ranges: [number, number][] = [];
    for (const t of s.values()) {
      if (t.bitOffset !== null && t.bitSize !== null) ranges.push([t.bitOffset, t.bitSize]);
    }
    this.viewer.setHighlight(ranges);
  }
}
