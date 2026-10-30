import * as v from 'valibot';

// The typed env schema (probed by the plugin from the project root): plain
// objects of Standard Schema validators — valibot here, but zod, arktype, or
// any compliant library works, even mixed per key.
//
// `client` vars must carry the public VITE_ prefix and come through
// `virtual:env/client` as validated values baked into the bundle. Server
// vars would go under `server` and come through `virtual:env/server` (server
// modules only — importing it from client code fails the build); this
// playground has none. Generated types land in solid-env.d.ts.
export default {
  client: {
    VITE_APP_NAME: v.optional(
      v.pipe(v.string(), v.minLength(1)),
      'Solid Motion Lab',
    ),
  },
};
