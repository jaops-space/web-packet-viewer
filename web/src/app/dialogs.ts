import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { WebappSdkModule } from '@yamcs/webapp-sdk';
import { Viewer } from './viewer';

// ---------------------------------------------------------------- mission database

/** files: local XTCE files; null: the MDB of the instance again */
export type MdbResult = { files: File[] | null };

/** The MDB used to decode the packets: the instance's, or local XTCE files for this page only. */
@Component({
  selector: 'pv-mdb-dialog',
  imports: [WebappSdkModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Mission database</h2>
    <mat-dialog-content class="pv-dialog">
      <p>In use: <b>{{ viewer.mdbLabel() }}</b></p>
      <label class="pv-field">
        Local XTCE files (in the order of the loaders)
        <input type="file" multiple accept=".xml,.xtce" (change)="files.set([...$any($event.target).files])" />
      </label>
      <p class="pv-mute">Instead of the MDB of the instance, for this page only. Loading an MDB clears the packets.</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <ya-button mat-dialog-close>Cancel</ya-button>
      @if (data.localMdb) {
        <ya-button (click)="ref.close({ files: null })">Use the instance MDB</ya-button>
      }
      <ya-button appearance="primary" [disabled]="!files().length" (click)="ref.close({ files: files() })">Load</ya-button>
    </mat-dialog-actions>
  `,
})
export class MdbDialog {
  readonly viewer = inject(Viewer);
  readonly ref = inject<MatDialogRef<MdbDialog, MdbResult>>(MatDialogRef);
  readonly data = inject<{ localMdb: boolean }>(MAT_DIALOG_DATA);
  readonly files = signal<File[]>([]);
}

// ---------------------------------------------------------------- go to packet

/** Go to packet… (Java GoToPacketDialog): a packet number in the range of the loaded packets. */
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
