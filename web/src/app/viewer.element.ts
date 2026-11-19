import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewEncapsulation,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Title } from '@angular/platform-browser';
import { WebappSdkModule, YamcsWebExtension } from '@yamcs/webapp-sdk';
import { firstValueFrom } from 'rxjs';
import type { ParamRow } from '../../../wasm/dist/packet-viewer-client.js';
import { Details } from './details';
import { GoToDialog, LovDialog, MdbDialog, MdbResult } from './dialogs';
import { HexDump } from './hexdump';
import { PacketsTable } from './packets-table';
import { SourceBar } from './source-bar';
import { MOD, Viewer } from './viewer';

export const ELEMENT = 'packet-viewer';

/** The routed element, /ext/packet-viewer?c=<instance>. */
@Component({
  selector: 'pv-page',
  imports: [WebappSdkModule, PacketsTable, Details, HexDump, SourceBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `
    <ya-instance-page noscroll>
      <ya-instance-toolbar [label]="'Packet Viewer'">
        @if (v.source().kind === 'live') {
          @if (v.connected()) {
            <ya-page-button icon="pause" (clicked)="v.pauseLive()">Pause</ya-page-button>
          } @else {
            <ya-page-button icon="play_arrow" (clicked)="v.resumeLive()">Resume</ya-page-button>
          }
        }
        <ya-page-button icon="delete_sweep" [disabled]="!v.status().packetCount" (clicked)="v.clear()">Clear</ya-page-button>
        <ya-more icon="more_vert">
          <button mat-menu-item [disabled]="!v.status().rowCount" (click)="goTo()">Go to packet…<span class="pv-shortcut">{{ mod }}G</span></button>
          <button mat-menu-item [disabled]="!v.details()" (click)="details()?.openFind()">Find parameter…<span class="pv-shortcut">{{ mod }}F</span></button>
          <mat-divider />
          <button mat-menu-item (click)="v.updatePrefs({ autoScroll: !v.prefs().autoScroll })">
            <span class="material-symbols pv-check">{{ v.prefs().autoScroll ? 'check_box' : 'check_box_outline_blank' }}</span>Scroll to new packets
          </button>
          <button mat-menu-item (click)="v.updatePrefs({ autoSelect: !v.prefs().autoSelect })">
            <span class="material-symbols pv-check">{{ v.prefs().autoSelect ? 'check_box' : 'check_box_outline_blank' }}</span>Select new packets
          </button>
          <mat-divider />
          <button mat-menu-item (click)="openMdb()">Mission database…</button>
        </ya-more>
        <span class="pv-source" [title]="v.source().label">{{ v.source().label }}</span>
      </ya-instance-toolbar>

      @if (v.fatal(); as msg) {
        <ya-empty-message headerTitle="Packet Viewer">{{ msg }}</ya-empty-message>
      } @else {
        <div
          class="pv"
          #root
          [class.pv-dropping]="dropping()"
          (keydown)="keys($event)"
          (dragover)="dragOver($event)"
          (dragleave)="dropping.set(false)"
          (drop)="drop($event)">
          <pv-source-bar (openFile)="pickFile()" />
          <div class="pv-filterbar">
            <div class="pv-filter" [class.pv-invalid]="invalid()">
              <input
                #filter
                [value]="filterText()"
                placeholder="Display filter (e.g. my-parameter == 123)"
                [title]="invalid() ?? ''"
                (input)="edit($any($event.target).value)"
                (keydown.enter)="apply()"
                (keydown.escape)="filterInput()?.nativeElement?.blur()" />
              <button class="pv-icon" [matMenuTriggerFor]="historyMenu" [disabled]="!v.prefs().filterHistory.length" title="Filter history">
                <span class="material-symbols">arrow_drop_down</span>
              </button>
            </div>
            <mat-menu #historyMenu="matMenu">
              @for (h of v.prefs().filterHistory; track h) {
                <button mat-menu-item (click)="edit(h); apply()">{{ h }}</button>
              }
            </mat-menu>
            <ya-button [disabled]="!filterText()" (click)="edit(''); apply()">Clear filter</ya-button>
          </div>
          @if (v.progress(); as p) {
            <div class="pv-progress">
              <div class="pv-bar"><div [style.width.%]="p.value === null ? 100 : p.value * 100" [class.pv-indeterminate]="p.value === null"></div></div>
              <span>{{ p.label }}</span>
              @if (p.cancel) {
                <ya-button (click)="p.cancel()">Cancel</ya-button>
              }
            </div>
          }
          <div class="pv-main">
            <div class="pv-left" [style.width.px]="v.prefs().packetsWidth">
              <div class="pv-navbar">
                <button class="pv-icon" [disabled]="!v.details()?.canGoBack" title="Back (Alt+←)" (click)="v.back()">
                  <span class="material-symbols">arrow_back</span>
                </button>
                <button class="pv-icon" [disabled]="!v.details()?.canGoForward" title="Forward (Alt+→)" (click)="v.forward()">
                  <span class="material-symbols">arrow_forward</span>
                </button>
                <span class="pv-sep"></span>
                <button class="pv-icon" [disabled]="!v.status().rowCount" title="Previous packet (Alt+↑)" (click)="v.neighbour(true)">
                  <span class="material-symbols">keyboard_arrow_up</span>
                </button>
                <button class="pv-icon" [disabled]="!v.status().rowCount" title="Next packet (Alt+↓)" (click)="v.neighbour(false)">
                  <span class="material-symbols">keyboard_arrow_down</span>
                </button>
                <button class="pv-icon" [disabled]="!v.status().rowCount" title="Go to packet… ({{ mod }}G)" (click)="goTo()">
                  <span class="material-symbols">move_down</span>
                </button>
                <span class="pv-sep"></span>
                <button
                  class="pv-icon"
                  [disabled]="v.details()?.row == null"
                  [title]="(v.selectedMarked() ? 'Unmark packet' : 'Mark packet') + ' (' + mod + 'M)'"
                  (click)="v.toggleMark()">
                  <span class="material-symbols" [class.pv-filled]="v.selectedMarked()">bookmark</span>
                </button>
                <span class="pv-grow"></span>
                <span class="pv-mute pv-ellipsis pv-count" [title]="v.filter().applied ?? ''">
                  @if (v.filter().applied) {
                    {{ v.status().rowCount }} of {{ v.status().packetCount }} packets
                  } @else {
                    {{ v.status().packetCount }} packets
                  }
                </span>
              </div>
              <pv-packets (goTo)="goTo()" />
            </div>
            <div class="pv-split-v" (mousedown)="drag($event, 'packetsWidth', 1)"></div>
            <div class="pv-right">
              <pv-details (lov)="lov($event)" (filterRequest)="edit($event); apply()" />
              <div class="pv-split-h" (mousedown)="drag($event, 'hexHeight', -1)"></div>
              <pv-hexdump [style.height.px]="v.prefs().hexHeight" />
            </div>
          </div>
          <div class="pv-status">
            <span class="pv-mdb" [title]="'Mission database: ' + v.mdbLabel()">MDB: {{ v.mdbLabel() || '…' }}</span>
            <span class="pv-message pv-ellipsis" [title]="recentLog()">{{ v.message() }}</span>
          </div>
          @if (dropping()) {
            <div class="pv-dropzone">Drop the file to open it ({{ v.fileFormats()[sourceBar()?.fileFormat() ?? 0] }})</div>
          }
        </div>
      }
    </ya-instance-page>
  `,
})
export class ViewerElement extends YamcsWebExtension implements OnDestroy {
  readonly v = inject(Viewer);
  readonly mod = MOD;
  private readonly title = inject(Title);
  private readonly dialog = inject(MatDialog);
  readonly details = viewChild(Details);
  readonly table = viewChild(PacketsTable);
  readonly sourceBar = viewChild(SourceBar);
  /** a file is dragged over the page */
  readonly dropping = signal(false);
  /** the last messages, as the tooltip of the status line */
  readonly recentLog = computed(() => this.v.log().slice(-15).join('\n'));
  readonly filterInput = viewChild<ElementRef<HTMLInputElement>>('filter');
  readonly root = viewChild<ElementRef<HTMLElement>>('root');

  readonly filterText = signal('');
  private readonly validation = signal<{ text: string; error: string | null }>({ text: '', error: null });
  /** red while the text does not parse (Java: the editor background) */
  readonly invalid = computed(() => {
    const t = this.filterText();
    const val = this.validation();
    if (val.text === t && val.error) return val.error;
    // an invalid filter applied: the text stays red until edited
    if (this.v.filter().error && t.trim()) return this.v.filter().error;
    return null;
  });
  private filePicker?: HTMLInputElement;
  private readonly globalKeys = (e: KeyboardEvent) => this.keys(e, true);

  override onExtensionInit(): void {
    this.title.setTitle('Packet Viewer');
    this.v.attach(this.extensionService);
    this.filterText.set(this.v.filter().applied ?? '');
    window.addEventListener('keydown', this.globalKeys);
  }

  override onExtensionChanges(): void {
    this.v.attach(this.extensionService);
  }

  ngOnDestroy() {
    window.removeEventListener('keydown', this.globalKeys);
  }

  // ---------------------------------------------------------------- filter

  async edit(text: string) {
    this.filterText.set(text);
    if (!text.trim() || !this.v.ready()) {
      this.validation.set({ text, error: null });
      return;
    }
    const r = await this.v.validateFilter(text);
    if (this.filterText() === text) {
      this.validation.set({ text, error: r.ok ? null : `${r.message}${r.position != null ? ` (at ${r.position})` : ''}` });
    }
  }

  apply() {
    this.v.setFilter(this.filterText());
  }

  // ---------------------------------------------------------------- dialogs

  async openMdb() {
    const ref = this.dialog.open<MdbDialog, any, MdbResult>(MdbDialog, {
      width: '520px',
      data: { localMdb: this.v.localMdb() },
    });
    const r = await firstValueFrom(ref.afterClosed());
    if (!r) return;
    if (r.files) await this.v.loadLocalMdb(r.files);
    else await this.v.reloadInstanceMdb();
  }

  /** the file picker; the file is opened in the format chosen in the source bar */
  pickFile() {
    if (!this.filePicker) {
      this.filePicker = document.createElement('input');
      this.filePicker.type = 'file';
      this.filePicker.onchange = () => {
        const f = this.filePicker!.files?.[0];
        if (f) this.openFile(f);
        this.filePicker!.value = '';
      };
    }
    this.filePicker.click();
  }

  private async openFile(file: File) {
    await this.v.openFile(file, this.sourceBar()?.fileFormat() ?? 0);
    this.table()?.focus();
  }

  dragOver(e: DragEvent) {
    if (!this.v.ready() || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    this.dropping.set(true);
  }

  drop(e: DragEvent) {
    this.dropping.set(false);
    const f = e.dataTransfer?.files[0];
    if (!f || !this.v.ready()) return;
    e.preventDefault();
    this.openFile(f);
  }

  async goTo() {
    const range = this.v.status().range;
    if (!range || !this.v.status().rowCount) return;
    const ref = this.dialog.open<GoToDialog, any, number>(GoToDialog, {
      width: '360px',
      data: { range, current: this.v.selectedNr() },
    });
    const nr = await firstValueFrom(ref.afterClosed());
    if (nr != null) await this.v.goTo(nr);
    this.table()?.focus();
  }

  async lov(p: ParamRow) {
    const e = await this.v.enumValues(p.qualifiedName);
    if (!e) return;
    const raw = p.rawValue !== null && /^-?\d+$/.test(p.rawValue) ? Number(p.rawValue) : null;
    this.dialog.open(LovDialog, { width: '480px', data: { ...e, raw } });
  }

  // ---------------------------------------------------------------- keyboard

  /**
   * The keyboard shortcuts. On the window too (global) when nothing else has the focus, so that they work
   * right after opening the page; Alt+arrows are the browser's history keys and are taken only inside the viewer.
   */
  keys(e: KeyboardEvent, global = false) {
    const root = this.root()?.nativeElement;
    const inside = !!root && e.target instanceof Node && root.contains(e.target);
    if (global && (inside || !(e.target === document.body || e.target === document.documentElement))) return;
    if (this.dialog.openDialogs.length) return;
    const ctrl = e.ctrlKey || e.metaKey;
    let done = true;
    if (ctrl && !e.altKey && !e.shiftKey) {
      switch (e.key.toLowerCase()) {
        case 'o':
          if (this.v.ready()) this.pickFile();
          break;
        case 'f':
          if (this.v.details()) this.details()?.openFind();
          break;
        case 'm':
          this.v.toggleMark();
          break;
        case 'g':
          this.goTo();
          break;
        default:
          done = false;
      }
    } else if (e.altKey && !ctrl && !e.shiftKey) {
      switch (e.key) {
        case 'ArrowLeft':
          this.v.back();
          break;
        case 'ArrowRight':
          this.v.forward();
          break;
        case 'ArrowUp':
          this.v.neighbour(true);
          break;
        case 'ArrowDown':
          this.v.neighbour(false);
          break;
        default:
          done = false;
      }
    } else {
      done = false;
    }
    if (done) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ---------------------------------------------------------------- split panes

  drag(e: MouseEvent, key: 'packetsWidth' | 'hexHeight', sign: 1 | -1) {
    e.preventDefault();
    const horizontal = key === 'packetsWidth';
    const start = horizontal ? e.clientX : e.clientY;
    const initial = this.v.prefs()[key];
    const move = (m: MouseEvent) => {
      const d = (horizontal ? m.clientX : m.clientY) - start;
      const size = Math.max(horizontal ? 200 : 40, initial + sign * d);
      this.v.prefs.update((p) => ({ ...p, [key]: size }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.v.updatePrefs({});
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
}
