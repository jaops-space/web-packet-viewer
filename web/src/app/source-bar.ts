import { ChangeDetectionStrategy, Component, computed, effect, inject, output, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl } from '@angular/forms';
import { WebappSdkModule, YaSelectOption, utils } from '@yamcs/webapp-sdk';
import { Viewer } from './viewer';

type Kind = 'live' | 'archive' | 'file';

const KINDS: YaSelectOption[] = [
  { id: 'live', label: 'Live', icon: 'sensors' },
  { id: 'archive', label: 'Archive', icon: 'history' },
  { id: 'file', label: 'Local file', icon: 'upload_file' },
];

const INTERVALS: YaSelectOption[] = [
  { id: 'PT5M', label: 'Last 5 minutes' },
  { id: 'PT1H', label: 'Last hour' },
  { id: 'PT6H', label: 'Last 6 hours' },
  { id: 'P1D', label: 'Last 24 hours' },
  { id: 'CUSTOM', label: 'Custom', group: true },
];

/**
 * Where the packets come from, above the table: the stream of the live packets, the time range and packet names of
 * the archive, or a local file (also dropped on the page).
 */
@Component({
  selector: 'pv-source-bar',
  imports: [WebappSdkModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pv-sourcebar' },
  template: `
    <ya-select icon="input" [formControl]="kind" [options]="kinds" />
    @switch (kindValue()) {
      @case ('live') {
        <ya-select icon="stream" [formControl]="stream" [options]="streamOptions()" />
        @if (isCurrentLive()) {
          <ya-button icon="restart_alt" [disabled]="!v.ready()" (click)="startLive()" title="Clear the packets and start again">Restart</ya-button>
        } @else {
          <ya-button appearance="primary" icon="play_arrow" [disabled]="!v.ready() || !streamValue()" (click)="startLive()">Start</ya-button>
        }
        <span class="pv-mute pv-ellipsis">The last {{ v.config()?.liveMaxLines || 'all' }} packets are kept</span>
      }
      @case ('archive') {
        <ya-select icon="access_time" [formControl]="interval" [options]="intervals" />
        @if (intervalValue() === 'CUSTOM') {
          <ya-date-time-input [formControl]="start" />
          <ya-date-time-input [formControl]="stop" />
        }
        <ya-multi-select icon="filter_list" emptyOption="All packets" [formControl]="names" [options]="nameOptions()" />
        <ya-button appearance="primary" icon="download" [disabled]="!v.ready() || !archiveValid()" (click)="loadArchive()">Load</ya-button>
      }
      @case ('file') {
        @if (formatOptions().length > 1) {
          <ya-select icon="description" [formControl]="format" [options]="formatOptions()" />
        }
        <ya-button appearance="primary" icon="file_open" [disabled]="!v.ready()" (click)="pickFile()">Open file…</ya-button>
        <span class="pv-mute pv-ellipsis">or drop it on the page. It is decoded in this browser, nothing is uploaded.</span>
      }
    }
  `,
})
export class SourceBar {
  readonly v = inject(Viewer);
  /** asks the page to open the file picker */
  readonly openFile = output<void>();

  readonly kinds = KINDS;
  readonly intervals = INTERVALS;

  readonly kind = new FormControl<Kind>(this.initialKind(), { nonNullable: true });
  readonly kindValue = toSignal(this.kind.valueChanges, { initialValue: this.kind.value });

  readonly stream = new FormControl<string>(this.v.prefs().stream ?? this.v.config()?.stream ?? 'tm_realtime', { nonNullable: true });
  readonly streamValue = toSignal(this.stream.valueChanges, { initialValue: this.stream.value });
  /** the tm streams of the instance, and the stream of the plugin configuration */
  private readonly streams = computed(() => {
    const c = this.v.config();
    if (!c) return [];
    const s = c.tmStreams ?? [];
    return s.includes(c.stream) ? s : [c.stream, ...s];
  });
  readonly streamOptions = computed(() => {
    const s = this.streams();
    const cur = this.streamValue();
    return (!cur || s.includes(cur) || !s.length ? s : [cur, ...s]).map((id) => ({ id, label: id }));
  });

  readonly interval = new FormControl<string>(this.v.prefs().archive?.interval ?? 'PT1H', { nonNullable: true });
  readonly intervalValue = toSignal(this.interval.valueChanges, { initialValue: this.interval.value });
  readonly start = new FormControl<string | null>(this.v.prefs().archive?.start || null);
  readonly stop = new FormControl<string | null>(this.v.prefs().archive?.stop || null);
  private readonly startValue = toSignal(this.start.valueChanges, { initialValue: this.start.value });
  private readonly stopValue = toSignal(this.stop.valueChanges, { initialValue: this.stop.value });
  readonly names = new FormControl<string[]>(this.v.prefs().archive?.names ?? [], { nonNullable: true });
  private readonly packetNames = signal<string[]>([]);
  readonly nameOptions = computed(() => this.packetNames().map((id) => ({ id, label: id })));
  readonly archiveValid = computed(() => {
    if (this.intervalValue() !== 'CUSTOM') return true;
    const a = this.startValue();
    const b = this.stopValue();
    return !!a && !!b && Date.parse(a) <= Date.parse(b);
  });

  readonly format = new FormControl<string>(String(this.v.prefs().format ?? 0), { nonNullable: true });
  readonly formatOptions = computed(() => this.v.fileFormats().map((label, i) => ({ id: String(i), label })));

  /** the live source shown is the one the packets come from */
  readonly isCurrentLive = computed(() => this.v.source().kind === 'live' && this.v.liveStream() === this.streamValue());

  constructor() {
    // a remembered stream that is no longer a tm stream: the configured one
    effect(() => {
      const s = this.streams();
      const cur = untracked(() => this.stream.value);
      if (s.length && !s.includes(cur)) this.stream.setValue(this.v.config()!.stream);
    });
    const api = this.v.api;
    api?.packetNames().then((n) => this.packetNames.set(n.sort())).catch(() => {});
    this.interval.valueChanges.subscribe((i) => {
      if (i === 'CUSTOM' && !this.start.value) {
        const now = this.v.svc.yamcs.getMissionTime();
        this.stop.setValue(utils.toISOString(now));
        this.start.setValue(utils.toISOString(utils.subtractDuration(now, 'PT1H')));
      }
    });
  }

  private initialKind(): Kind {
    const k = this.v.source().kind;
    if (k !== 'none') return k;
    return this.v.prefs().lastSource ?? 'live';
  }

  /** the format chosen for the next file */
  fileFormat() {
    return Number(this.format.value) || 0;
  }

  pickFile() {
    this.openFile.emit();
  }

  startLive() {
    this.v.startLive(this.stream.value);
  }

  loadArchive() {
    const interval = this.interval.value;
    let start: string;
    let stop: string;
    if (interval === 'CUSTOM') {
      start = utils.toISOString(this.start.value!);
      stop = utils.toISOString(this.stop.value!);
    } else {
      const now = this.v.svc.yamcs.getMissionTime();
      stop = utils.toISOString(now);
      start = utils.toISOString(utils.subtractDuration(now, interval));
    }
    const names = this.names.value;
    this.v.updatePrefs({ archive: { interval, start: this.start.value ?? '', stop: this.stop.value ?? '', names } });
    this.v.loadArchive({ start, stop, names });
  }
}
