import { createCustomElement } from '@angular/elements';
import { createApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideYamcsWebExtension } from '@yamcs/webapp-sdk';
import { InitElement } from './app/init.element';
import { ELEMENT, ViewerElement } from './app/viewer.element';

// Yamcs-web creates <web-packet-viewer> (named after the plugin) at startup, and <packet-viewer> for the route
// /ext/packet-viewer.
(async () => {
  const app = await createApplication({
    providers: [provideRouter([]), provideYamcsWebExtension()],
  });
  const define = (name: string, c: any) => {
    if (!customElements.get(name)) customElements.define(name, createCustomElement(c, { injector: app.injector }));
  };
  define('web-packet-viewer', InitElement);
  define(ELEMENT, ViewerElement);
})();
