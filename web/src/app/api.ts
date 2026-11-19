import { YamcsService } from '@yamcs/webapp-sdk';
import type { ViewerConfig } from '../../../wasm/dist/packet-viewer-client.js';

/** GET /packet-viewer/api/{instance}/config (docs/plugin.md) */
export interface PluginConfig {
  instance: string;
  stream: string;
  rootContainer: string | null;
  liveMaxLines: number;
  mdbEtag: string;
  viewer: ViewerConfig;
}

export interface MdbDocuments {
  source: 'files' | 'export';
  documents: { name: string; xtce: string }[];
}

/** An archived packet, as /api/archive/{instance}/packets gives it. */
export interface ArchivedPacket {
  id?: { name: string };
  generationTime: string;
  packet: string;
}

const CACHE = 'yamcs-packet-viewer';

/** The plugin API and the Yamcs APIs the viewer uses, through Yamcs-web's client (its authentication applies). */
export class Api {
  constructor(
    private yamcs: YamcsService,
    readonly instance: string,
  ) {}

  private url(path: string) {
    return new URL(path.replace(/^\//, ''), document.baseURI).toString();
  }

  private async get(path: string, init?: RequestInit): Promise<Response> {
    return this.yamcs.yamcsClient.doFetch(this.url(path), init);
  }

  private plugin(path: string) {
    return `packet-viewer/api/${encodeURIComponent(this.instance)}/${path}`;
  }

  async config(): Promise<PluginConfig> {
    return (await this.get(this.plugin('config'))).json();
  }

  /**
   * The XTCE documents of the MDB, kept in the Cache Storage of the browser with their ETag: downloaded again only
   * when the MDB changed (the plugin answers 304 otherwise).
   */
  async mdb(etag: string): Promise<MdbDocuments> {
    const path = this.plugin('mdb');
    let cache: Cache | null = null;
    try {
      cache = await caches.open(CACHE);
      const hit = await cache.match(this.url(path));
      if (hit && hit.headers.get('x-etag') === etag) {
        return await hit.json();
      }
    } catch {
      // no Cache Storage (not a secure context): no cache
    }
    const r = await this.get(path);
    const text = await r.text();
    try {
      await cache?.put(
        this.url(path),
        new Response(text, { headers: { 'content-type': 'application/json', 'x-etag': r.headers.get('etag') ?? '' } }),
      );
    } catch {
      // quota: no cache
    }
    return JSON.parse(text);
  }

  async packetNames(): Promise<string[]> {
    const r = await (await this.get(`api/archive/${encodeURIComponent(this.instance)}/packet-names`)).json();
    return r.packets ?? [];
  }

  async streams(): Promise<string[]> {
    const r = await (await this.get(`api/archive/${encodeURIComponent(this.instance)}/streams`)).json();
    return (r.streams ?? []).map((s: any) => s.name);
  }

  /** a page of archived packets, in generation time order */
  async packets(o: { start?: string; stop?: string; names: string[]; next?: string; limit: number }) {
    const q = new URLSearchParams({ limit: String(o.limit), order: 'asc' });
    if (o.start) q.set('start', o.start);
    if (o.stop) q.set('stop', o.stop);
    if (o.next) q.set('next', o.next);
    for (const n of o.names) q.append('name', n);
    const r = await (await this.get(`api/archive/${encodeURIComponent(this.instance)}/packets?${q}`)).json();
    return { packets: (r.packet ?? []) as ArchivedPacket[], next: r.continuationToken as string | undefined };
  }
}

export function errorText(e: any): string {
  if (!e) return 'error';
  if (typeof e === 'string') return e;
  if (e.statusText || e.message) {
    return [e.statusCode ?? e.response?.status, e.message || e.statusText].filter(Boolean).join(' ');
  }
  return String(e);
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
