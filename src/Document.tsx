import type { ParentProps } from 'solid-js';
import { HydrationScript } from '@solidjs/web';
// Typed client env, validated and baked in at build time (see env.ts).
import { env } from 'virtual:env/client';

// The document shell (the index.html replacement), picked up by the
// src/Document.* convention; it must render the full <html> and ships no
// client JS. <HydrationScript /> is stripped from the prerendered shell in
// client mode and activates under `ssr: true`. Delete this file to fall
// back to the plugin's built-in shell.
export default function Document(props: ParentProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content="Motion layout animations driven by Solid 2 signals: animateLayout, three commit strategies, and what each one sees."
        />
        <link rel="icon" href="/favicon.ico" />
        {/* Default title; a route's <Title> replaces it once the page renders. */}
        <title>{env.VITE_APP_NAME}</title>
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
