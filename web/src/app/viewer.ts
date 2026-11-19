import { Injectable, computed, signal } from '@angular/core';
import { ExtensionService, WebSocketCall } from '@yamcs/webapp-sdk';
import {
  FilterResult,
  Highlight,
  PacketDetails,
  PacketViewerClient,
  RequestPromise,
  Row,
  Status,
} from '../../../wasm/dist/packet-viewer-client.js';
import { Api, PluginConfig, base64ToBytes, errorText } from './api';
import { MAX_RECENT, Prefs, loadPrefs, pushHistory, savePrefs } from './prefs';

export type SourceKind = 'none' | 'live' | 'archive' | 'file';

export interface Source {
  kind: SourceKind;
  /** for the toolbar, like the title of the Java viewer */
  label: string;
}

export interface Progress {
  label: string;
  /** 0..1, null: unknown */
  value: number | null;
  cancel?: () => void;
}

export interface FilterState {
  /** the text applied (null: no filter) */
  applied: string | null;
  /** an invalid text was applied: no filter, as in Java */
  error: string | null;
}

export interface ArchiveRequest {
  start: string;
  stop: string;
  names: string[];
}

const EMPTY_STATUS: Status = { packetCount: 0, rowCount: 0, filtering: false, range: null, maxHistory: 10, memoryBytes: 0 };
const LIVE_FLUSH_MS = 100;
const ARCHIVE_PAGE = 1000;

/**
 * The state of the Packet Viewer of one instance: the worker that decodes the packets, the source of the packets,
 * the selection. Kept while Yamcs-web shows other pages, so that coming back finds the packets (and the live
 * subscription goes on, bounded by liveMaxLines); replaced when the instance changes.
 */
@Injectable({ providedIn: 'root' })
export class Viewer {
  svc!: ExtensionService;
  api: Api | null = null;
  client: PacketViewerClient | null = null;

  readonly instance = signal<string | null>(null);
  readonly config = signal<PluginConfig | null>(null);
  readonly fileFormats = signal<string[]>([]);
  /** set once the MDB is loaded */
  readonly ready = signal(false);
  /** the MDB in use: the instance's or local files */
  readonly mdbLabel = signal('');
  /** the MDB comes from local files */
  readonly localMdb = signal(false);
  readonly fatal = signal<string | null>(null);

  readonly source = signal<Source>({ kind: 'none', label: '(no file loaded)' });
  readonly status = signal<Status>(EMPTY_STATUS);
  /** bumped when the rows change: the table fetches them again */
  readonly version = signal(0);
  readonly columns = signal<string[]>([]);
  readonly details = signal<PacketDetails | null>(null);
  readonly selectedNr = computed(() => this.details()?.nr ?? null);
  readonly selectedMarked = signal(false);
  readonly highlight = signal<Highlight | null>(null);
  readonly log = signal<string[]>([]);
  readonly progress = signal<Progress | null>(null);
  readonly filter = signal<FilterState>({ applied: null, error: null });
  readonly prefs = signal<Prefs>(loadPrefs(''));
  readonly connected = signal(false);
  /** the table scrolls to this row (bumped by auto-scroll and navigation) */
  readonly scrollTo = signal<{ row: number; seq: number } | null>(null);

  private live?: WebSocketCall<unknown, any>;
  private liveQueue: { data: Uint8Array; generationTime: string | null }[] = [];
  private liveTimer?: ReturnType<typeof setInterval>;
  private flushing = false;
  private archiveRun = 0;
  private filterRequest?: RequestPromise<FilterResult>;
  private scrollSeq = 0;

  /** Binds to the current instance of Yamcs-web; starts over if it changed. */
  attach(svc: ExtensionService) {
    this.svc = svc;
    const instance = svc.yamcs.instance!;
    if (instance === this.instance()) return;
    this.reset();
    this.instance.set(instance);
    this.prefs.set(loadPrefs(instance));
    this.api = new Api(svc.yamcs, instance);
    this.start();
  }

  private reset() {
    this.stopLive();
    this.archiveRun++;
    this.client?.terminate();
    this.client = null;
    this.ready.set(false);
    this.localMdb.set(false);
    this.fatal.set(null);
    this.config.set(null);
    this.source.set({ kind: 'none', label: '(no file loaded)' });
    this.status.set(EMPTY_STATUS);
    this.columns.set([]);
    this.details.set(null);
    this.highlight.set(null);
    this.log.set([]);
    this.progress.set(null);
    this.filter.set({ applied: null, error: null });
    this.version.update((v) => v + 1);
  }

  private async start() {
    const api = this.api!;
    try {
      const client = new PacketViewerClient({ onLog: (m) => this.addLog(m) });
      this.client = client;
      const config = await api.config();
      if (api !== this.api) return;
      this.config.set(config);
      const init = await client.init(config.viewer);
      this.fileFormats.set(init.fileFormats);
      this.addLog(`Loading remote mission database for Yamcs instance ${config.instance}`);
      const mdb = await api.mdb(config.mdbEtag);
      if (api !== this.api) return;
      await this.loadMdb(
        mdb.documents.map((d) => d.xtce),
        config.rootContainer,
        mdb.source === 'files' ? mdb.documents.map((d) => d.name).join(', ') : `${config.instance} (export)`,
      );
    } catch (e: any) {
      if (api !== this.api) return;
      const msg =
        e?.statusCode === 404 || e?.response?.status === 404
          ? `The packet viewer plugin is not available for instance ${api.instance}.`
          : `Cannot start the packet viewer: ${errorText(e)}`;
      this.fatal.set(msg);
      this.addLog(msg);
    }
  }

  private async loadMdb(xtce: string[], rootContainer: string | null, label: string) {
    const client = this.client!;
    await client.loadMdb(xtce, rootContainer); // the worker logs what it loaded
    this.mdbLabel.set(label);
    // the columns of the preferences that exist in this MDB
    let columns: string[] = [];
    for (const qn of this.prefs().columns) {
      columns = (await client.request<{ columns: string[] }>({ op: 'addColumn', qualifiedName: qn })).columns;
    }
    this.columns.set(columns);
    this.details.set(null);
    this.highlight.set(null);
    this.source.set({ kind: 'none', label: '(no file loaded)' });
    await this.refresh();
    this.ready.set(true);
  }

  /** "local MDB": XTCE files chosen by the user instead of the instance's MDB */
  async loadLocalMdb(files: File[]) {
    this.stopLive();
    this.archiveRun++;
    try {
      const xtce = await Promise.all(files.map((f) => f.text()));
      this.addLog(`Loading local XTCE db ${files.map((f) => f.name).join(', ')}`);
      await this.loadMdb(xtce, null, files.map((f) => f.name).join(', '));
      this.localMdb.set(true);
    } catch (e) {
      this.error(e);
    }
  }

  /** the instance's MDB again, after a local one */
  async reloadInstanceMdb() {
    this.reset();
    this.instance.set(this.api!.instance);
    this.start();
  }

  addLog(message: string) {
    this.log.update((l) => {
      const n = [...l, message];
      return n.length > 2000 ? n.slice(n.length - 2000) : n;
    });
  }

  error(e: any) {
    const msg = errorText(e);
    this.addLog(msg);
    this.svc.messageService.showError(msg);
  }

  updatePrefs(change: Partial<Prefs>) {
    this.prefs.update((p) => ({ ...p, ...change }));
    savePrefs(this.instance() ?? '', this.prefs());
  }

  // ------------------------------------------------------------------ rows

  async rows(from: number, to: number): Promise<{ rows: Row[]; rowCount: number }> {
    if (!this.client || !this.ready()) return { rows: [], rowCount: 0 };
    return this.client.rows(from, to);
  }

  /** after a change of the packets: the status, the table, the selection */
  async refresh() {
    const client = this.client;
    if (!client) return;
    const s = await client.request<Status>({ op: 'status' });
    this.status.set(s);
    this.version.update((v) => v + 1);
    const d = this.details();
    if (d) {
      try {
        const { row } = await client.request<{ row: number | null }>({ op: 'rowOf', nr: d.nr });
        if (row !== d.row) this.details.set({ ...d, row });
      } catch {
        // dropped (live maximum of lines)
        this.details.set(null);
        this.highlight.set(null);
      }
    }
  }

  private scroll(row: number) {
    this.scrollTo.set({ row, seq: ++this.scrollSeq });
  }

  // ------------------------------------------------------------------ sources

  private async newSource(kind: SourceKind, label: string, maxLines: number | null, format: number | null) {
    this.stopLive();
    this.archiveRun++;
    const client = this.client!;
    await client.request({ op: 'setMaxLines', maxLines });
    if (format === null) await client.request({ op: 'setSource', format: null });
    await client.request({ op: 'clear' });
    this.details.set(null);
    this.highlight.set(null);
    this.source.set({ kind, label });
    await this.refresh();
    await this.reapplyFilter();
  }

  async openFile(file: File, format: number) {
    if (!this.ready()) return;
    await this.newSource('file', file.name, null, format);
    const recent = [{ name: file.name, format }, ...this.prefs().recent.filter((r) => r.name !== file.name)];
    this.updatePrefs({ recent: recent.slice(0, MAX_RECENT), lastSource: 'file' });
    const client = this.client!;
    const req = client.openFile(file, format, (p) => {
      this.progress.set({
        label: `Loading ${file.name}: ${p.packets} packets`,
        value: p.total ? p.bytes / p.total : null,
        cancel: () => client.cancel(req),
      });
      this.refresh().then(() => this.afterAdd(this.status().rowCount));
    });
    this.progress.set({ label: `Loading ${file.name}`, value: 0, cancel: () => client.cancel(req) });
    try {
      const r = await req;
      // the messages of the Java viewer (which has the path of the file, the browser only its name)
      if (r.cancelled) {
        this.addLog(`Cancelled loading ${file.name}`);
      } else {
        if (r.truncated) this.addLog(`Encountered end of file while loading ${file.name}`);
        const n = r.filePackets;
        this.addLog(`Loaded ${n} packet${n === 1 ? '' : 's'} from "${file.name}"`);
      }
    } catch (e) {
      this.error(`Error while loading ${file.name}: ${errorText(e)}`);
      await this.clear();
    } finally {
      this.progress.set(null);
    }
    // the packets go through the table as they are read, as in Java: Auto-Scroll and Auto-Select apply
    await this.refresh();
    await this.afterAdd(this.status().rowCount);
  }

  /** Java: Connect to Yamcs; the packets of a stream, at most liveMaxLines */
  async startLive(stream: string) {
    if (!this.ready()) return;
    const config = this.config()!;
    const instance = this.instance()!;
    await this.newSource('live', `${instance} · ${stream} (live)`, config.liveMaxLines || null, null);
    this.updatePrefs({ lastSource: 'live' });
    const ws = (this.svc.yamcs.yamcsClient as any).webSocketClient;
    if (!ws) {
      this.error('No WebSocket connection to Yamcs');
      return;
    }
    this.live = ws.createSubscription('packets', { instance, stream }, (p: any) => {
      this.liveQueue.push({ data: base64ToBytes(p.packet), generationTime: p.generationTime ?? null });
    });
    this.connected.set(true);
    this.addLog(`subscribed to the packets of stream ${stream} of instance ${instance}`);
    this.liveTimer = setInterval(() => this.flushLive(), LIVE_FLUSH_MS);
  }

  stopLive() {
    if (this.live) {
      this.live.cancel();
      this.live = undefined;
      this.addLog('disconnected');
    }
    clearInterval(this.liveTimer);
    this.liveTimer = undefined;
    this.liveQueue = [];
    this.connected.set(false);
    if (this.source().kind === 'live') {
      this.source.update((s) => ({ ...s, label: s.label.replace(' (live)', ' (stopped)') }));
    }
  }

  private async flushLive() {
    if (this.flushing || !this.liveQueue.length || !this.client) return;
    this.flushing = true;
    const batch = this.liveQueue;
    this.liveQueue = [];
    try {
      await this.addPackets(batch);
    } catch (e) {
      this.addLog(errorText(e));
    } finally {
      this.flushing = false;
    }
  }

  private async addPackets(batch: { data: Uint8Array; generationTime: string | null }[]) {
    const r = await this.client!.addPackets(batch);
    this.status.set(r);
    this.version.update((v) => v + 1);
    await this.afterAdd(r.rowCount);
  }

  /** View → Auto-Scroll To Last Packet, Auto-Select Last Packet */
  private async afterAdd(rowCount: number) {
    if (!rowCount) return;
    const p = this.prefs();
    if (p.autoScroll) this.scroll(rowCount - 1);
    if (p.autoSelect) {
      const { rows } = await this.client!.rows(rowCount - 1, rowCount);
      if (rows.length) await this.select(rows[0].nr, false);
    } else if (this.details()) {
      await this.refresh();
    }
  }

  /** packets of the archive, with their generation times from Yamcs */
  async loadArchive(req: ArchiveRequest) {
    if (!this.ready()) return;
    const label = `${this.instance()} · archive ${req.start || '…'} – ${req.stop || '…'}`;
    await this.newSource('archive', label, null, null);
    this.updatePrefs({ lastSource: 'archive', archive: req });
    const run = this.archiveRun;
    const cancel = () => {
      if (this.archiveRun === run) this.archiveRun++;
    };
    let next: string | undefined;
    let n = 0;
    const startMs = req.start ? Date.parse(req.start) : NaN;
    const stopMs = req.stop ? Date.parse(req.stop) : NaN;
    this.progress.set({ label: 'Loading packets from the archive', value: null, cancel });
    try {
      do {
        const page = await this.api!.packets({ ...req, next, limit: ARCHIVE_PAGE });
        if (this.archiveRun !== run) {
          this.addLog(`Cancelled loading packets from the archive (${n} loaded)`);
          return;
        }
        next = page.next;
        if (page.packets.length) {
          await this.addPackets(
            page.packets.map((p) => ({ data: base64ToBytes(p.packet), generationTime: p.generationTime })),
          );
          n += page.packets.length;
          const last = Date.parse(page.packets[page.packets.length - 1].generationTime);
          this.progress.set({
            label: `Loading packets from the archive: ${n}`,
            value: isNaN(startMs) || isNaN(stopMs) ? null : Math.min(1, (last - startMs) / (stopMs - startMs)),
            cancel,
          });
        }
      } while (next);
      this.addLog(`Loaded ${n} packet${n === 1 ? '' : 's'} from the archive`);
    } catch (e) {
      this.error(e);
    } finally {
      if (this.archiveRun === run || this.progress()?.cancel === cancel) this.progress.set(null);
    }
  }

  /** View → Clear */
  async clear() {
    if (!this.client) return;
    this.liveQueue = [];
    await this.client.request({ op: 'clear' });
    this.details.set(null);
    this.highlight.set(null);
    await this.refresh();
  }

  // ------------------------------------------------------------------ filter

  validateFilter(expr: string) {
    return this.client!.validateFilter(expr);
  }

  /** applies the display filter (blank: none); a valid one goes to the history */
  async setFilter(expr: string | null) {
    const client = this.client;
    if (!client || !this.ready()) return;
    const text = expr?.trim() ? expr : null;
    if (this.filterRequest) client.cancel(this.filterRequest);
    const req = client.setFilter(text, (p) => {
      this.progress.set({
        label: `Filtering: ${p.scanned} of ${p.total} packets`,
        value: p.total ? p.scanned / p.total : null,
        cancel: () => client.cancel(req),
      });
      this.status.update((s) => ({ ...s, rowCount: p.rowCount }));
      this.version.update((v) => v + 1);
    });
    this.filterRequest = req;
    try {
      const r = await req;
      if (r.cancelled && this.filterRequest !== req) return; // superseded
      if (!r.ok) {
        this.filter.set({ applied: null, error: r.message ?? 'invalid filter' });
      } else if (r.cancelled) {
        this.filter.set({ applied: null, error: null });
      } else {
        this.filter.set({ applied: text, error: null });
        if (text) this.updatePrefs({ filterHistory: pushHistory(this.prefs().filterHistory, text) });
      }
    } catch (e) {
      this.error(e);
    } finally {
      if (this.filterRequest === req) {
        this.filterRequest = undefined;
        this.progress.set(null);
      }
    }
    await this.refresh();
    const d = this.details();
    if (d?.row != null) this.scroll(d.row);
  }

  /** the filter applies to the packets as they are added; a new source starts with it applied again */
  private async reapplyFilter() {
    const f = this.filter().applied;
    if (f) await this.setFilter(f);
  }

  // ------------------------------------------------------------------ selection, navigation

  async select(nr: number, scroll = true) {
    const client = this.client;
    if (!client) return;
    try {
      const d = await client.select(nr);
      this.details.set(d);
      this.highlight.set(null);
      const s = await client.rows(d.row ?? 0, (d.row ?? 0) + 1);
      this.selectedMarked.set(d.row !== null && !!s.rows[0]?.marked);
      if (scroll && d.row !== null) this.scroll(d.row);
    } catch (e) {
      this.error(e);
    }
  }

  async back() {
    const r = await this.client?.request<{ nr: number | null }>({ op: 'back' });
    if (r?.nr != null) await this.select(r.nr);
  }

  async forward() {
    const r = await this.client?.request<{ nr: number | null }>({ op: 'forward' });
    if (r?.nr != null) await this.select(r.nr);
  }

  /** Navigate → Previous/Next Packet */
  async neighbour(up: boolean) {
    const client = this.client;
    if (!client) return;
    const row = this.details()?.row ?? null;
    const r = await client.request<{ row: number | null }>({ op: 'neighbour', row, up });
    if (r.row == null) return;
    const { rows } = await client.rows(r.row, r.row + 1);
    if (rows.length) await this.select(rows[0].nr);
  }

  /** Navigate → Go to Packet: selects it, or says that it is filtered out */
  async goTo(nr: number) {
    await this.select(nr);
    if (this.details()?.nr === nr && this.details()?.row === null) {
      this.svc.messageService.showInfo(`Packet ${nr} is hidden by the display filter`);
    }
  }

  async toggleMark() {
    const d = this.details();
    if (!d || !this.client) return;
    const r = await this.client.request<{ marked: boolean }>({ op: 'toggleMark', nr: d.nr });
    this.selectedMarked.set(r.marked);
    this.version.update((v) => v + 1);
  }

  async setHighlight(ranges: [number, number][]) {
    if (!this.client) return;
    this.highlight.set(ranges.length ? await this.client.request<Highlight>({ op: 'highlight', ranges }) : null);
  }

  async copyHex() {
    const d = this.details();
    if (!d || !this.client) return;
    const { hex } = await this.client.request<{ hex: string }>({ op: 'copyHex', nr: d.nr });
    await navigator.clipboard.writeText(hex);
    this.svc.messageService.showInfo('Hex copied to the clipboard');
  }

  enumValues(qualifiedName: string) {
    return this.client!.request<{ typeName: string; values: [number, string][] } | null>({
      op: 'enumValues',
      qualifiedName,
    });
  }

  async parameters(): Promise<string[]> {
    if (!this.client || !this.ready()) return [];
    return (await this.client.request<{ parameters: string[] }>({ op: 'parameters' })).parameters;
  }

  // ------------------------------------------------------------------ columns

  /** Apply as Left Column */
  async addColumn(qualifiedName: string) {
    const r = await this.client!.request<{ added: boolean; columns: string[] }>({ op: 'addColumn', qualifiedName });
    this.setColumns(r.columns);
  }

  /** Hide Column */
  async removeColumn(index: number) {
    const r = await this.client!.request<{ columns: string[] }>({ op: 'removeColumn', index });
    this.setColumns(r.columns);
  }

  private setColumns(columns: string[]) {
    this.columns.set(columns);
    this.updatePrefs({ columns });
    this.version.update((v) => v + 1);
  }
}
