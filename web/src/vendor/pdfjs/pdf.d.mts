// Minimal types for the vendored pdf.js legacy build (only what src/plans/files.ts uses).
export const GlobalWorkerOptions: { workerSrc: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getDocument(src: { data: Uint8Array }): { promise: Promise<any> }
