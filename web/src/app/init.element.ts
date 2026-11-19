import { ChangeDetectionStrategy, Component } from '@angular/core';
import { User, YamcsWebExtension } from '@yamcs/webapp-sdk';
import { ELEMENT } from './viewer.element';

const MAY_SEE = (user: User) => user.hasAnyObjectPrivilegeOfType('ReadPacket') || user.isSuperuser();

/** Startup hook: adds Packet Viewer to the Telemetry group of the sidebar. Renders nothing. */
@Component({
  selector: 'pv-init',
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InitElement extends YamcsWebExtension {
  override onExtensionInit(): void {
    const svc = this.extensionService;
    svc.disableReloadOnNavigation(ELEMENT);
    svc.addNavItem('telemetry', {
      path: `ext/${ELEMENT}`,
      activeWhen: `ext/${ELEMENT}`,
      label: 'Packet Viewer',
      icon: 'view_list',
      order: 100,
      condition: MAY_SEE,
    });
  }
}
