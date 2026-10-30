import { Title } from '@solidjs/meta';
import type { RouteDefinition } from '@solidjs/router';
import { httpStatus } from '@solidjs/web';

import { paths } from '../router';

// The catch-all route. httpStatus() sets the response status during SSR
// (a no-op in the browser); it runs in preload so the status code is set
// before the response head flushes.
export const route = {
  preload: () => httpStatus(404),
} satisfies RouteDefinition;

export default function NotFound() {
  return (
    <main>
      <Title>Not Found</Title>
      <h1>Page Not Found</h1>
      <p>
        The motion lab is the only page here — <a href={paths()}>go to the lab</a>.
      </p>
    </main>
  );
}
