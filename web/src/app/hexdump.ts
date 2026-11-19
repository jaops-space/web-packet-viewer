import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { ContextMenu, MenuItem } from './context-menu';
import { Viewer } from './viewer';

interface Segment {
  text: string;
  cls: '' | 'o' | 'h';
}

/**
 * The hex dump of the selected packet (Java hexText): offsets in grey, the bit ranges selected in the Parameters or
 * Structure tab highlighted in the hex and ASCII columns (character ranges computed by pv-core), scrolled to the first
 * one. Right-click: Copy hex.
 */
@Component({
  selector: 'pv-hexdump',
  imports: [ContextMenu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pv-hex' },
  template: `
    <pre #pre (contextmenu)="openMenu($event)">@for (s of segments(); track $index) {<span [class]="s.cls">{{ s.text }}</span>}</pre>
    @if (menu(); as m) {
      <pv-context-menu [x]="m.x" [y]="m.y" [items]="m.items" (closed)="menu.set(null)" />
    }
  `,
})
export class HexDump {
  readonly viewer = inject(Viewer);
  private readonly pre = viewChild.required<ElementRef<HTMLPreElement>>('pre');
  readonly menu = signal<{ x: number; y: number; items: MenuItem[] } | null>(null);

  readonly segments = computed<Segment[]>(() => {
    const hex = this.viewer.details()?.hex ?? '';
    const spans = this.viewer.highlight()?.spans ?? [];
    // character classes: offsets ('o', the first 4 characters of each line), highlighted ('h')
    const cls = new Uint8Array(hex.length);
    let lineStart = 0;
    for (let i = 0; i <= hex.length; i++) {
      if (i === hex.length || hex[i] === '\n') {
        for (let k = lineStart; k < Math.min(lineStart + 4, i); k++) cls[k] = 1;
        lineStart = i + 1;
      }
    }
    for (const [a, b] of spans) for (let k = a; k < Math.min(b, hex.length); k++) cls[k] = 2;
    const out: Segment[] = [];
    let start = 0;
    for (let i = 1; i <= hex.length; i++) {
      if (i === hex.length || cls[i] !== cls[start]) {
        out.push({ text: hex.substring(start, i), cls: (['', 'o', 'h'] as const)[cls[start]] });
        start = i;
      }
    }
    return out;
  });

  constructor() {
    effect(() => {
      const h = this.viewer.highlight();
      this.segments();
      if (!h || !h.spans.length) return;
      setTimeout(() => this.pre().nativeElement.querySelector('.h')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    });
  }

  openMenu(e: MouseEvent) {
    e.preventDefault();
    this.menu.set({
      x: e.clientX,
      y: e.clientY,
      items: [{ label: 'Copy hex', disabled: !this.viewer.details(), action: () => this.viewer.copyHex() }],
    });
  }
}

/** The log panel (Java logText): scrolled to the last message. */
@Component({
  selector: 'pv-log',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pv-log' },
  template: `<pre #pre>{{ viewer.log().join('\n') }}</pre>`,
})
export class LogPanel {
  readonly viewer = inject(Viewer);
  private readonly el = inject(ElementRef);

  constructor() {
    effect(() => {
      this.viewer.log();
      setTimeout(() => {
        const e = this.el.nativeElement as HTMLElement;
        e.scrollTop = e.scrollHeight;
      });
    });
  }
}
