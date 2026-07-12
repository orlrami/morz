/*
 * node-pty is npm-aliased to @lydell/node-pty (prebuilt N-API binary), whose
 * typings are an ambient `declare module '@lydell/node-pty'`. Bridge the alias
 * so `import { spawn } from 'node-pty'` typechecks.
 */
/// <reference path="../../../node_modules/node-pty/node-pty.d.ts" />
declare module 'node-pty' {
  export * from '@lydell/node-pty'
}
