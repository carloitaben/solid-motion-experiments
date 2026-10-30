// The router lives in its own module so src/App.tsx (render) and any other
// module that needs the instance share one source of truth. Routes are scanned
// from src/routes by `virtual:file-routes`.
import { pageRoutes } from 'virtual:file-routes';
import { createRouter, intentPreload } from '@solidjs/router';
import { fileRoutes } from '@solidjs/router/fs';

// Link preloading is opt-in. intentPreload() is the hover/focus/touch
// strategy: resting on a link warms its code and runs its preload before the
// click. The only link here is the 404's way back to the lab.
export const Router = createRouter({
  routes: fileRoutes(pageRoutes),
  preloadLinks: intentPreload(),
});

export const { paths } = Router;
