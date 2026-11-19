import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { WebappSdkModule } from '@yamcs/webapp-sdk';
import { ArchiveRequest, Viewer } from './viewer';

// ---------------------------------------------------------------- open

export type OpenTab = 'file' | 'live' | 'archive';

export type OpenResult =
  | { kind: 'file'; file: File; format: number }
  | { kind: 'live'; stream: string }
  | { kind: 'archive'; request: ArchiveRequest }
  | { kind: 'mdb'; files: File[] | null };

/**
 * File → Open… (Java OpenFileDialog: a file and its format) and Connect to Yamcs… (Java ConnectDialog: here only the
 * stream, Yamcs-web is connected already), plus the packets of the archive and the choice of the MDB.
 */
@Component({
  selector: 'pv-open-dialog',
  imports: [WebappSdkModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Open</h2>
    <mat-dialog-content class="pv-dialog">
      <div class="pv-tabs">
        <button [class.active]="tab() === 'file'" (click)="tab.set('file')">Local file</button>
        <button [class.active]="tab() === 'live'" (click)="tab.set('live')">Live</button>
        <button [class.active]="tab() === 'archive'" (click)="tab.set('archive')">Archive</button>
        <button [class.active]="tab() === 'mdb'" (click)="tab.set('mdb')">MDB</button>
      </div>
      @switch (tab()) {
        @case ('file') {
          <label class="pv-field">
            File
            <input type="file" (change)="file.set($any($event.target).files[0] ?? null)" />
          </label>
          <label class="pv-field">
            File format
            <select [value]="format()" (change)="format.set(+$any($event.target).value)">
              @for (f of viewer.fileFormats(); track $index) {
                <option [value]="$index" [selected]="$index === format()">{{ f }}</option>
              }
            </select>
          </label>
          <p class="pv-mute">The file is read and decoded in this browser; nothing is uploaded.</p>
        }
        @case ('live') {
          <label class="pv-field">
            Stream
            <select [value]="stream()" (change)="stream.set($any($event.target).value)">
              @for (s of streams(); track s) {
                <option [value]="s" [selected]="s === stream()">{{ s }}</option>
              }
            </select>
          </label>
          <p class="pv-mute">
            The packets of the stream as Yamcs receives them, the last {{ viewer.config()?.liveMaxLines || 'all' }} kept.
          </p>
        }
        @case ('archive') {
          <div class="pv-row2">
            <label class="pv-field">
              Start (UTC)
              <input [value]="start()" (input)="start.set($any($event.target).value)" placeholder="2026-01-01T00:00:00Z" [class.pv-invalid]="!validTime(start())" />
            </label>
            <label class="pv-field">
              Stop (UTC)
              <input [value]="stop()" (input)="stop.set($any($event.target).value)" placeholder="2026-01-01T01:00:00Z" [class.pv-invalid]="!validTime(stop())" />
            </label>
          </div>
          <div class="pv-row2">
            @for (p of presets; track p.label) {
              <button class="pv-link" (click)="preset(p.minutes)">{{ p.label }}</button>
            }
          </div>
          <label class="pv-field">
            Packets ({{ names().length ? names().length + ' selected' : 'all' }})
            <select multiple size="8" (change)="pickNames($event)">
              @for (n of packetNames(); track n) {
                <option [value]="n" [selected]="names().includes(n)">{{ n }}</option>
              }
            </select>
          </label>
        }
        @case ('mdb') {
          <p>Mission database in use: <b>{{ viewer.mdbLabel() }}</b></p>
          <label class="pv-field">
            Local XTCE files (in the order of the loaders)
            <input type="file" multiple accept=".xml,.xtce" (change)="mdbFiles.set([...$any($event.target).files])" />
          </label>
          <p class="pv-mute">Instead of the MDB of the instance, for this page only. Loading an MDB clears the packets.</p>
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <ya-button mat-dialog-close>Cancel</ya-button>
      @if (tab() === 'mdb') {
        <ya-button [disabled]="!localMdb()" (click)="ref.close({ kind: 'mdb', files: null })">Use the instance MDB</ya-button>
      }
      <ya-button appearance="primary" [disabled]="!ok()" (click)="submit()">{{ tab() === 'live' ? 'Connect' : 'Open' }}</ya-button>
    </mat-dialog-actions>
  `,
})
export class OpenDialog {
  readonly viewer = inject(Viewer);
  readonly ref = inject<MatDialogRef<OpenDialog, OpenResult>>(MatDialogRef);
  readonly data = inject<{ tab: OpenTab | 'mdb'; format?: number; localMdb: boolean }>(MAT_DIALOG_DATA);
  readonly tab = signal<OpenTab | 'mdb'>(this.data.tab);
  readonly localMdb = signal(this.data.localMdb);

  readonly file = signal<File | null>(null);
  readonly format = signal(this.data.format ?? 0);

  readonly streams = signal<string[]>([]);
  readonly stream = signal(this.viewer.config()?.stream ?? 'tm_realtime');

  readonly start = signal('');
  readonly stop = signal('');
  readonly names = signal<string[]>([]);
  readonly packetNames = signal<string[]>([]);
  readonly presets = [
    { label: 'Last 5 minutes', minutes: 5 },
    { label: 'Last hour', minutes: 60 },
    { label: 'Last day', minutes: 1440 },
  ];

  readonly mdbFiles = signal<File[]>([]);

  readonly ok = computed(() => {
    switch (this.tab()) {
      case 'file':
        return !!this.file();
      case 'live':
        return !!this.stream();
      case 'archive':
        return this.validTime(this.start()) && this.validTime(this.stop());
      default:
        return this.mdbFiles().length > 0;
    }
  });

  constructor() {
    const api = this.viewer.api!;
    const configured = this.stream();
    api
      .streams()
      .then((s) => this.streams.set(s.includes(configured) ? s : [configured, ...s]))
      .catch(() => this.streams.set([configured]));
    api
      .packetNames()
      .then((n) => this.packetNames.set(n.sort()))
      .catch(() => {});
    const last = this.viewer.prefs().archive;
    if (last) {
      this.start.set(last.start);
      this.stop.set(last.stop);
      this.names.set(last.names);
    } else {
      this.preset(60);
    }
  }

  validTime(s: string) {
    return !s.trim() || !isNaN(Date.parse(s));
  }

  preset(minutes: number) {
    const now = Date.now();
    this.start.set(new Date(now - minutes * 60000).toISOString());
    this.stop.set(new Date(now).toISOString());
  }

  pickNames(e: Event) {
    const sel = (e.target as HTMLSelectElement).selectedOptions;
    this.names.set([...sel].map((o) => o.value));
  }

  submit() {
    switch (this.tab()) {
      case 'file':
        this.ref.close({ kind: 'file', file: this.file()!, format: this.format() });
        break;
      case 'live':
        this.ref.close({ kind: 'live', stream: this.stream() });
        break;
      case 'archive': {
        const iso = (s: string) => (s.trim() ? new Date(Date.parse(s)).toISOString() : '');
        this.ref.close({ kind: 'archive', request: { start: iso(this.start()), stop: iso(this.stop()), names: this.names() } });
        break;
      }
      default:
        this.ref.close({ kind: 'mdb', files: this.mdbFiles() });
    }
  }
}

// ---------------------------------------------------------------- go to packet

/** Navigate → Go to Packet… (Java GoToPacketDialog): a packet number in the range of the loaded packets. */
@Component({
  selector: 'pv-goto-dialog',
  imports: [WebappSdkModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Go to Packet</h2>
    <mat-dialog-content class="pv-dialog">
      <label class="pv-field">
        Packet number ({{ data.range[0] }} – {{ data.range[1] }})
        <input #nr [value]="value()" (input)="value.set($any($event.target).value); error.set(null)" (keydown.enter)="go()" autofocus />
      </label>
      @if (error(); as e) {
        <div class="pv-bad">{{ e }}</div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <ya-button mat-dialog-close>Cancel</ya-button>
      <ya-button appearance="primary" (click)="go()">Go to</ya-button>
    </mat-dialog-actions>
  `,
})
export class GoToDialog {
  readonly data = inject<{ range: [number, number]; current: number | null }>(MAT_DIALOG_DATA);
  readonly ref = inject<MatDialogRef<GoToDialog, number>>(MatDialogRef);
  readonly value = signal(this.data.current !== null ? String(this.data.current) : '');
  readonly error = signal<string | null>(null);

  /** GoToPacketDialog.actionPerformed: its messages, the dialog stays open */
  go() {
    const v = this.value().trim();
    if (!/^[+-]?\d+$/.test(v)) {
      this.error.set('Cannot parse packet number');
      return;
    }
    const n = Number(v);
    if (n < this.data.range[0] || n > this.data.range[1]) {
      this.error.set(`There is no packet number ${n}`);
      return;
    }
    this.ref.close(n);
  }
}

// ---------------------------------------------------------------- list of values

/** The values of an enumerated type, the raw value of the parameter selected (Java: List of Values · type). */
@Component({
  selector: 'pv-lov-dialog',
  imports: [WebappSdkModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>List of Values · {{ data.typeName }}</h2>
    <mat-dialog-content class="pv-dialog">
      <table class="pv-params pv-lov">
        <thead>
          <tr><th class="r">#</th><th>Label</th></tr>
        </thead>
        <tbody>
          @for (v of data.values; track $index) {
            <tr [class.sel]="v[0] === data.raw" [attr.id]="v[0] === data.raw ? 'pv-lov-sel' : null">
              <td class="r">{{ v[0] }}</td>
              <td>{{ v[1] }}</td>
            </tr>
          }
        </tbody>
      </table>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <ya-button appearance="primary" mat-dialog-close>OK</ya-button>
    </mat-dialog-actions>
  `,
})
export class LovDialog {
  readonly data = inject<{ typeName: string; values: [number, string][]; raw: number | null }>(MAT_DIALOG_DATA);

  constructor() {
    setTimeout(() => document.getElementById('pv-lov-sel')?.scrollIntoView({ block: 'center' }), 50);
  }
}
