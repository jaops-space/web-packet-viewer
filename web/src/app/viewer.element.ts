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
import { GoToDialog, LovDialog, OpenDialog, OpenResult } from './dialogs';
import { HexDump, LogPanel } from './hexdump';
import { PacketsTable } from './packets-table';
import { Viewer } from './viewer';

export const ELEMENT = 'packet-viewer';

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/** The routed element, /ext/packet-viewer?c=<instance>: the Java PacketViewer window. */
@Component({
  selector: 'pv-page',
  imports: [WebappSdkModule, PacketsTable, Details, HexDump, LogPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `
    <ya-instance-page noscroll>
      <ya-instance-toolbar [label]="'Packet Viewer'">
        <button mat-button class="pv-menubutton" [matMenuTriggerFor]="fileMenu">File</button>
        <button mat-button class="pv-menubutton" [matMenuTriggerFor]="editMenu">Edit</button>
        <button mat-button class="pv-menubutton" [matMenuTriggerFor]="navMenu">Navigate</button>
        <button mat-button class="pv-menubutton" [matMenuTriggerFor]="viewMenu">View</button>
        @if (v.connected()) {
          <ya-page-button icon="stop" (clicked)="v.stopLive()">Disconnect</ya-page-button>
        }
        <span class="pv-source" [title]="v.source().label">{{ v.source().label }}</span>
      </ya-instance-toolbar>

      <mat-menu #fileMenu="matMenu">
        <button mat-menu-item [disabled]="!v.ready()" (click)="open('file')">Open…<span class="pv-shortcut">{{ mod }}O</span></button>
        <button mat-menu-item [disabled]="!v.ready()" (click)="open('live')">Connect to Yamcs…<span class="pv-shortcut">{{ mod }}Y</span></button>
        <button mat-menu-item [disabled]="!v.ready()" (click)="open('archive')">Load from Archive…</button>
        @if (v.prefs().recent.length) {
          <mat-divider />
          @for (r of v.prefs().recent; track r.name; let i = $index) {
            <button mat-menu-item [disabled]="!v.ready()" [title]="'Choose ' + r.name + ' again (' + (v.fileFormats()[r.format] ?? '?') + ')'" (click)="reopen(r.format)">
              {{ i + 1 }} {{ r.name }}
            </button>
          }
        }
        <mat-divider />
        <button mat-menu-item (click)="open('mdb')">Mission Database…</button>
      </mat-menu>
      <mat-menu #editMenu="matMenu">
        <button mat-menu-item [disabled]="!v.details()" (click)="details()?.openFind()">Find Parameter…<span class="pv-shortcut">{{ mod }}F</span></button>
        <mat-divider />
        <button mat-menu-item [disabled]="!v.details() || v.details()?.row === null" (click)="v.toggleMark()">
          {{ v.selectedMarked() ? 'Unmark Packet' : 'Mark Packet' }}<span class="pv-shortcut">{{ mod }}M</span>
        </button>
      </mat-menu>
      <mat-menu #navMenu="matMenu">
        <button mat-menu-item [disabled]="!v.status().rowCount" (click)="goTo()">Go to Packet…<span class="pv-shortcut">{{ mod }}G</span></button>
        <mat-divider />
        <button mat-menu-item [disabled]="!v.details()?.canGoBack" (click)="v.back()">Back<span class="pv-shortcut">Alt+←</span></button>
        <button mat-menu-item [disabled]="!v.details()?.canGoForward" (click)="v.forward()">Forward<span class="pv-shortcut">Alt+→</span></button>
        <mat-divider />
        <button mat-menu-item [disabled]="!v.status().rowCount" (click)="v.neighbour(true)">Previous Packet<span class="pv-shortcut">Alt+↑</span></button>
        <button mat-menu-item [disabled]="!v.status().rowCount" (click)="v.neighbour(false)">Next Packet<span class="pv-shortcut">Alt+↓</span></button>
      </mat-menu>
      <mat-menu #viewMenu="matMenu">
        <button mat-menu-item (click)="v.updatePrefs({ autoScroll: !v.prefs().autoScroll })">
          <span class="material-symbols pv-check">{{ v.prefs().autoScroll ? 'check_box' : 'check_box_outline_blank' }}</span>Auto-Scroll To Last Packet
        </button>
        <button mat-menu-item (click)="v.updatePrefs({ autoSelect: !v.prefs().autoSelect })">
          <span class="material-symbols pv-check">{{ v.prefs().autoSelect ? 'check_box' : 'check_box_outline_blank' }}</span>Auto-Select Last Packet
        </button>
        <mat-divider />
        <button mat-menu-item (click)="v.clear()">Clear</button>
      </mat-menu>

      @if (v.fatal(); as msg) {
        <ya-empty-message headerTitle="Packet Viewer">{{ msg }}</ya-empty-message>
      } @else {
        <div class="pv" #root (keydown)="keys($event)">
          <div class="pv-filterbar">
            <div class="pv-filter" [class.pv-invalid]="invalid()">
              <input
                #filter
                [value]="filterText()"
                placeholder="Display Filter (e.g. my-parameter == 123)"
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
            <ya-button [disabled]="!filterText()" (click)="edit(''); apply()">Clear</ya-button>
            @if (v.filter().applied; as f) {
              <span class="pv-mute pv-ellipsis" [title]="f">{{ v.status().rowCount }} of {{ v.status().packetCount }} packets</span>
            } @else {
              <span class="pv-mute">{{ v.status().packetCount }} packets</span>
            }
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
            <pv-packets [style.width.px]="v.prefs().packetsWidth" (goTo)="goTo()" />
            <div class="pv-split-v" (mousedown)="drag($event, 'packetsWidth', 1)"></div>
            <div class="pv-right">
              <pv-details (lov)="lov($event)" (filterRequest)="edit($event); apply()" />
              <div class="pv-split-h" (mousedown)="drag($event, 'hexHeight', -1)"></div>
              <pv-hexdump [style.height.px]="v.prefs().hexHeight" />
            </div>
          </div>
          <div class="pv-split-h" (mousedown)="drag($event, 'logHeight', -1)"></div>
          <pv-log [style.height.px]="v.prefs().logHeight" />
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
  private pendingFormat = 0;
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

  async open(tab: 'file' | 'live' | 'archive' | 'mdb', format?: number) {
    const ref = this.dialog.open<OpenDialog, any, OpenResult>(OpenDialog, {
      width: '560px',
      data: { tab, format, localMdb: this.v.localMdb() },
    });
    const r = await firstValueFrom(ref.afterClosed());
    if (!r) return;
    switch (r.kind) {
      case 'file':
        await this.v.openFile(r.file, r.format);
        break;
      case 'live':
        await this.v.startLive(r.stream);
        break;
      case 'archive':
        await this.v.loadArchive(r.request);
        break;
      case 'mdb':
        if (r.files) await this.v.loadLocalMdb(r.files);
        else await this.v.reloadInstanceMdb();
        break;
    }
    this.table()?.focus();
  }

  /** a recent file: the browser cannot open it again by itself, the user chooses it */
  reopen(format: number) {
    this.pendingFormat = format;
    if (!this.filePicker) {
      this.filePicker = document.createElement('input');
      this.filePicker.type = 'file';
      this.filePicker.onchange = () => {
        const f = this.filePicker!.files?.[0];
        if (f) this.v.openFile(f, this.pendingFormat);
        this.filePicker!.value = '';
      };
    }
    this.filePicker.click();
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
   * The accelerators of the Java menus. On the window too (global) when nothing else has the focus, so that they work
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
          if (this.v.ready()) this.open('file');
          break;
        case 'y':
          if (this.v.ready()) this.open('live');
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

  drag(e: MouseEvent, key: 'packetsWidth' | 'hexHeight' | 'logHeight', sign: 1 | -1) {
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
