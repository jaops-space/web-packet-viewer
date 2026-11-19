// Types of the packet viewer client; see docs/protocol.md.

export interface ViewerConfig {
  defaultNamespace?: string;
  packetPreprocessorClassName?: string;
  packetPreprocessorArgs?: Record<string, unknown>;
  fileFormats?: {
    name: string;
    packetInputStreamClassName: string;
    packetInputStreamArgs?: Record<string, unknown>;
    packetPreprocessorClassName?: string;
    packetPreprocessorArgs?: Record<string, unknown>;
    rootContainer?: string;
  }[];
  packetInputStreamClassName?: string;
  packetInputStreamArgs?: Record<string, unknown>;
}

export interface Status {
  packetCount: number;
  rowCount: number;
  filtering: boolean;
  /** first and last packet number for "Go to packet" */
  range: [number, number] | null;
  maxHistory: number;
  /** the size of the wasm memory, which only grows */
  memoryBytes: number;
}

export interface FileStatus extends Status {
  filePackets: number;
  /** the file ends with an incomplete packet */
  truncated: boolean;
  cancelled?: boolean;
}

export interface FileProgress {
  bytes: number;
  total: number;
  packets: number;
}

export interface FilterProgress {
  scanned: number;
  total: number;
  rowCount: number;
}

export interface FilterResult {
  ok: boolean;
  rowCount: number;
  /** when not ok */
  message?: string;
  position?: number;
  cancelled?: boolean;
}

export interface Row {
  nr: number;
  /** yyyy-MM-dd/DDDTHH:mm:ss.SSS */
  generationTime: string;
  name: string;
  length: number;
  /** engineering values of the parameter columns, null if not in the packet */
  columns: (string | null)[];
  marked: boolean;
}

export type Calibration =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'enumeration'; typeName: string };

export interface ParamRow {
  qualifiedName: string;
  name: string;
  engValue: string;
  rawValue: string | null;
  nominalLow: string;
  nominalHigh: string;
  dangerLow: string;
  dangerHigh: string;
  bitOffset: number | null;
  bitSize: number | null;
  calibration: Calibration;
}

export interface TreeNode {
  label: string;
  bitOffset: number | null;
  bitSize: number | null;
  children: TreeNode[];
}

export interface PacketDetails {
  nr: number;
  name: string;
  /** the hex dump text */
  hex: string;
  params: ParamRow[];
  tree: TreeNode;
  /** decoding error; params has what was extracted before it */
  decodeError: string | null;
  /** the row of the packet, null if filtered out */
  row: number | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface Highlight {
  /** [start, end) character ranges of the hex dump */
  spans: [number, number][];
  /** character position to scroll to */
  scroll: number;
}

export interface EnumValues {
  typeName: string;
  values: [number, string][];
}

export type Request =
  | { op: 'init'; config?: ViewerConfig }
  | { op: 'loadMdb'; xtce: string[]; rootContainer?: string | null }
  | { op: 'setSource'; format: number | null }
  | { op: 'setMaxLines'; maxLines: number | null }
  | { op: 'clear' }
  | { op: 'openFile'; file: Blob; format: number }
  | { op: 'addPackets'; lengths: number[]; generationTimes: (string | null)[]; now: number; data: Uint8Array }
  | { op: 'status' }
  | { op: 'rows'; from: number; to: number }
  | { op: 'rowOf'; nr: number }
  | { op: 'addColumn'; qualifiedName: string }
  | { op: 'removeColumn'; index: number }
  | { op: 'validateFilter'; expr: string }
  | { op: 'setFilter'; expr: string | null }
  | { op: 'select'; nr: number }
  | { op: 'back' }
  | { op: 'forward' }
  | { op: 'neighbour'; row: number | null; up: boolean }
  | { op: 'toggleMark'; nr: number }
  | { op: 'highlight'; ranges: [number, number][] }
  | { op: 'copyHex'; nr: number }
  | { op: 'enumValues'; qualifiedName: string }
  | { op: 'parameters' };

export interface RequestPromise<T> extends Promise<T> {
  id: number;
}

export class PacketViewerClient {
  constructor(options?: { onLog?: (message: string) => void; createWorker?: (source: string) => Worker });
  request<T = any>(
    req: Request,
    options?: { onProgress?: (progress: any) => void; transfer?: Transferable[] },
  ): RequestPromise<T>;
  cancel(promise: RequestPromise<unknown>): void;
  terminate(): void;

  init(config?: ViewerConfig): RequestPromise<{ fileFormats: string[] }>;
  loadMdb(xtce: string[], rootContainer?: string | null): RequestPromise<{ message: string; rootContainer: string | null }>;
  openFile(file: Blob, format: number, onProgress?: (p: FileProgress) => void): RequestPromise<FileStatus>;
  addPackets(packets: { data: Uint8Array; generationTime?: string | null }[]): RequestPromise<Status & { added: number }>;
  rows(from: number, to: number): RequestPromise<{ rows: Row[]; rowCount: number }>;
  setFilter(expr: string | null, onProgress?: (p: FilterProgress) => void): RequestPromise<FilterResult>;
  validateFilter(expr: string): RequestPromise<{ ok: boolean; message?: string; position?: number }>;
  select(nr: number): RequestPromise<PacketDetails>;
}
