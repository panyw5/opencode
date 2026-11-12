# e2e-ext fixture

Self-contained, dependency-free server extension consumed by
`test/extension/e2e-lifecycle.test.ts` (remediation plan T6.1 regression net).

- `server.js` is the `./server` entry, packed into a local `.tgz` by the test
  and installed through the real installer (`local` source).
- Do not add package dependencies: the installed package is extracted into a
  managed generation directory and imported in place, so nothing can resolve
  `node_modules` at runtime.
- The test overrides `package.json#version` when packing, so keep the checked-in
  version at `1.0.0`.
