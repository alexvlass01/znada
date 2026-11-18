'use strict';

// Main uses only these resource operations, never libmpv or a graphics context.
// The source PID is the UtilityProcess instance created by video-session, never renderer input.
let api;
function bindings() {
  if (api) return api;
  const koffi = require('koffi');
  const kernel = koffi.load('kernel32.dll');
  api = {
    open: kernel.func('void * __stdcall OpenProcess(uint32_t, int, uint32_t)'),
    current: kernel.func('void * __stdcall GetCurrentProcess()'),
    duplicate: kernel.func('int __stdcall DuplicateHandle(void *, void *, void *, _Out_ void **, uint32_t, int, uint32_t)'),
    close: kernel.func('int __stdcall CloseHandle(void *)'),
    koffi,
  };
  return api;
}
function duplicateTextureHandle(pid, bytes) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !bytes || bytes.length !== 8) throw new Error('Invalid video handle');
  const b = bindings();
  const source = b.open(0x40, 0, pid); // PROCESS_DUP_HANDLE only
  if (!source) throw new Error('Video worker is unavailable');
  const out = [null];
  try {
    if (!b.duplicate(source, b.koffi.decode(Buffer.from(bytes), 'void *'), b.current(), out, 0, 0, 2)) throw new Error('Cannot duplicate texture handle');
  } finally { b.close(source); }
  const handle = out[0], buffer = Buffer.alloc(8);
  b.koffi.encode(buffer, 'void *', handle);
  let closed = false;
  return { buffer, close() { if (!closed) { closed = true; b.close(handle); } } };
}
module.exports = { duplicateTextureHandle };
