import { ChangeDetectionStrategy, Component, ElementRef, HostListener, inject, input, output } from '@angular/core';

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action?: () => void;
  /** a separator before the item */
  separator?: boolean;
}

/** A popup menu at the mouse position (Java JPopupMenu); closes on a click elsewhere, Escape or scroll. */
@Component({
  selector: 'pv-context-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pv-menu" [style.left.px]="x()" [style.top.px]="y()" (mousedown)="$event.stopPropagation()">
      @for (it of items(); track $index) {
        @if (it.separator) {
          <hr />
        }
        <button [disabled]="it.disabled" (click)="run(it)">
          <span>{{ it.label }}</span>
          @if (it.shortcut) {
            <span class="pv-shortcut">{{ it.shortcut }}</span>
          }
        </button>
      }
    </div>
  `,
})
export class ContextMenu {
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  readonly items = input.required<MenuItem[]>();
  readonly closed = output<void>();
  private readonly el = inject(ElementRef);

  run(it: MenuItem) {
    this.closed.emit();
    it.action?.();
  }

  @HostListener('document:mousedown', ['$event'])
  @HostListener('document:keydown.escape', ['$event'])
  @HostListener('window:blur', ['$event'])
  @HostListener('document:wheel', ['$event'])
  close(e: Event) {
    if (e.target instanceof Node && this.el.nativeElement.contains(e.target)) return;
    this.closed.emit();
  }
}
