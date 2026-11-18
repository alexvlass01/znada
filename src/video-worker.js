'use strict';

// Utility-process entrypoint. All codec and D3D work stays off main/renderer.
// Only public playback/resource APIs: no desktop capture, input, or foreign windows.
const { performance } = require('perf_hooks');
const koffi = require('koffi');
const port = process.parentPort;
if (!port) throw new Error('Video worker requires an Electron parent port');
let engine, stopping = false;
const post = message => port.postMessage(message);

function createEngine(options) {
  const dll = koffi.load(options.dll);
  const dx = koffi.load('d3d11.dll'), kernel = koffi.load('kernel32.dll');
  const closeHandle = kernel.func('int __stdcall CloseHandle(void *)');
  const Param = koffi.struct('ZnadaMpvRenderParam', { type: 'int', data: 'void *' });
  const Desc = koffi.struct('ZnadaVideoTexture', { Width: 'uint32_t', Height: 'uint32_t', MipLevels: 'uint32_t', ArraySize: 'uint32_t',
    Format: 'uint32_t', SampleCount: 'uint32_t', SampleQuality: 'uint32_t', Usage: 'uint32_t', BindFlags: 'uint32_t', CPUAccessFlags: 'uint32_t', MiscFlags: 'uint32_t' });
  const Event = koffi.struct('ZnadaMpvEvent', { id: 'int', error: 'int', userdata: 'uint64_t', data: 'void *' });
  const Property = koffi.struct('ZnadaMpvProperty', { name: 'void *', format: 'int', data: 'void *' });
  if (koffi.sizeof(Desc) !== 44 || koffi.sizeof(Param) !== 16) throw new Error('Unsupported native ABI');
  const create = dll.func('void *mpv_create()'), init = dll.func('int mpv_initialize(void *)');
  const setOption = dll.func('int mpv_set_option_string(void *, const char *, const char *)');
  const observe = dll.func('int mpv_observe_property(void *, uint64_t, const char *, int)');
  const command = dll.func('int mpv_command_async(void *, uint64_t, const char **)');
  const waitEvent = dll.func('void *mpv_wait_event(void *, double)');
  const destroy = dll.func('void mpv_terminate_destroy(void *)');
  const renderCreate = dll.func('int mpv_render_context_create(_Out_ void **, void *, const ZnadaMpvRenderParam *)');
  const update = dll.func('uint64_t mpv_render_context_update(void *)');
  const render = dll.func('int mpv_render_context_render(void *, const ZnadaMpvRenderParam *)');
  const swap = dll.func('void mpv_render_context_report_swap(void *)'), renderFree = dll.func('void mpv_render_context_free(void *)');
  const createDevice = dx.func('int32_t __stdcall D3D11CreateDevice(void *,uint32_t,void *,uint32_t,void *,uint32_t,uint32_t,_Out_ void **,_Out_ uint32_t *,_Out_ void **)');
  const prototypes = new Map();
  function com(object, index, result, args, values) {
    const key = `${index}|${result}|${args.length}`;
    if (!prototypes.has(key)) prototypes.set(key, koffi.proto('__stdcall', result, ['void *', ...args]));
    const table = koffi.decode(object, 'void *');
    return koffi.call(koffi.decode(table, index * 8, 'void *'), prototypes.get(key), object, ...values);
  }
  const release = object => { if (object) com(object, 2, 'uint32_t', [], []); };
  const check = (code, label) => { if (code < 0) throw new Error(`${label}: ${code}`); };
  const ptr = object => { const bytes = Buffer.alloc(8); koffi.encode(bytes, 'void *', object); return bytes; };
  const iid = Buffer.from('791396300946414a998e54fe567ee0c1', 'hex');
  let mpv, renderContext, device, context, query, stopped = false, sequence = 0, lastState = 0;
  let timer = null;
  const frames = new Map();
  const properties = new Map();
  const completions = new Map();
  let commandId = 0;
  // Once render_context exists, every client call used here is explicitly render-thread-safe:
  // observe_property, command_async, wait_event(0). Never synchronously query the core.
  const get = name => properties.get(name) ?? null;
  function cmd(args, after) {
    const id = ++commandId;
    check(command(mpv, id, [...args.map(String), null]), args[0]);
    if (after) completions.set(id, after);
  }
  function disposeNative() {
    clearInterval(timer);
    if (renderContext) { renderFree(renderContext); renderContext = null; }
    if (mpv) { destroy(mpv); mpv = null; }
    release(query); query = null; release(context); context = null; release(device); device = null;
  }
  function releaseFrame(id) { const dispose = frames.get(id); if (dispose) { frames.delete(id); dispose(); } }
  try {
    const d = [null], c = [null], level = [0];
    let result = createDevice(null, 1, null, 0x20, null, 0, 7, d, level, c);
    if (result < 0) result = createDevice(null, 5, null, 0x20, null, 0, 7, d, level, c); // WARP if hardware device unavailable
    check(result, 'D3D11CreateDevice'); device = d[0]; context = c[0];
    const q = [null]; check(com(device, 24, 'int32_t', ['void *', '_Out_ void **'], [Buffer.alloc(8), q]), 'CreateQuery'); query = q[0];
    mpv = create(); if (!mpv) throw new Error('mpv_create failed');
    for (const [name, value] of Object.entries({ vo: 'libmpv', config: 'no', 'load-scripts': 'no', ytdl: 'no',
      'sub-auto': 'no', 'audio-file-auto': 'no', 'autoload-files': 'no', 'access-references': 'no',
      // The only stream is the loopback URL from main. Force the container to
      // exclude playlists and forbid the demuxer from opening nested inputs.
      ...(options.format ? {
        demuxer: 'lavf',
        'demuxer-lavf-format': options.format === 'mp4' ? 'mov' : 'matroska',
        'demuxer-lavf-o': 'protocol_whitelist=none',
        'stream-lavf-o': 'http_proxy=',
        'demuxer-max-bytes': '16MiB',
        'demuxer-max-back-bytes': '4MiB',
      } : { 'demuxer-lavf-o': 'protocol_whitelist=file' }),
      hwdec: 'd3d11va', volume: '100', osc: 'no', 'input-default-bindings': 'no', 'input-cursor': 'no',
      'media-controls': 'no', 'stop-screensaver': 'no', 'keep-open': 'yes', 'loop-file': 'no' })) check(setOption(mpv, name, value), name);
    check(init(mpv), 'mpv_initialize');
    for (const name of ['time-pos', 'duration', 'pause', 'eof-reached', 'volume', 'video-out-params/dw',
      'video-out-params/dh', 'hwdec-current', 'current-ao', 'audio-params/samplerate']) check(observe(mpv, 0, name, 1), 'Observe property');
    const rc = [null];
    check(renderCreate(rc, mpv, [{ type: 1, data: Buffer.from('d3d11\0') }, { type: 21, data: ptr(device) }, { type: 0, data: null }]), 'Render context');
    renderContext = rc[0];
    cmd(['loadfile', options.file]);
  } catch (error) { disposeNative(); throw error; }

  function tick() {
    if (stopped) return;
    let texture, resource, handle;
    try {
      for (let i = 0; i < 64; i++) {
        const event = koffi.decode(waitEvent(mpv, 0), Event);
        if (event.id === 0) break;
        if (event.error < 0) throw new Error('Decoder event failed');
        if (event.id === 5) {
          const after = completions.get(Number(event.userdata));
          completions.delete(Number(event.userdata));
          if (after) after();
        }
        if (event.id === 7 && event.data && koffi.decode(event.data, 'int') === 4) throw new Error('Media could not be decoded');
        if (event.id === 22 && event.data) {
          const property = koffi.decode(event.data, Property);
          const name = koffi.decode(property.name, 'char', -1);
          const value = property.format === 1 && property.data ? koffi.decode(property.data, 'void *') : null;
          properties.set(name, value ? koffi.decode(value, 'char', -1) : null);
        }
      }
      const now = performance.now();
      let width = Number(get('video-out-params/dw')), height = Number(get('video-out-params/dh'));
      if (now - lastState >= 200) {
        lastState = now;
        post({ type: 'state', time: Number(get('time-pos')) || 0, duration: Number(get('duration')) || 0,
          paused: get('pause') === 'yes', ended: get('eof-reached') === 'yes', volume: Number(get('volume')),
          width, height, hwdec: get('hwdec-current'), audioBackend: get('current-ao'), audioRate: Number(get('audio-params/samplerate')) || 0 });
      }
      if (frames.size >= 2 || !(Number(update(renderContext)) & 1) || !(width > 0 && height > 0)) return;
      // Keep rendering bounded, including inputs whose coded dimensions exceed the screen.
      const scale = Math.min(1, 4096 / Math.max(width, height));
      width = Math.max(1, Math.round(width * scale)); height = Math.max(1, Math.round(height * scale));
      const out = [null], desc = { Width: width, Height: height, MipLevels: 1, ArraySize: 1, Format: 87,
        SampleCount: 1, SampleQuality: 0, Usage: 0, BindFlags: 0x28, CPUAccessFlags: 0, MiscFlags: 0x802 };
      check(com(device, 5, 'int32_t', [koffi.pointer(Desc), 'void *', '_Out_ void **'], [desc, null, out]), 'CreateTexture2D'); texture = out[0];
      check(render(renderContext, [{ type: 22, data: ptr(texture) }, { type: 0, data: null }]), 'Render');
      com(context, 28, 'void', ['void *'], [query]); com(context, 111, 'void', [], []);
      const started = performance.now(), done = Buffer.alloc(4);
      for (;;) {
        const result = com(context, 29, 'int32_t', ['void *', 'void *', 'uint32_t', 'uint32_t'], [query, done, 4, 0]);
        check(result, 'GPU completion'); if (result === 0) break;
        if (performance.now() - started > 150) throw new Error('GPU completion timeout');
      }
      const r = [null]; check(com(texture, 0, 'int32_t', ['void *', '_Out_ void **'], [iid, r]), 'DXGI resource'); resource = r[0];
      const h = [null]; check(com(resource, 13, 'int32_t', ['void *', 'uint32_t', 'void *', '_Out_ void **'], [null, 0x80000001, null, h]), 'Shared handle'); handle = h[0];
      release(resource); resource = null;
      const ownedTexture = texture, ownedHandle = handle, id = ++sequence;
      frames.set(id, () => { closeHandle(ownedHandle); release(ownedTexture); });
      texture = null; handle = null;
      try { post({ type: 'frame', id, width, height, ntBytes: ptr(ownedHandle), time: Number(get('time-pos')) || 0 }); }
      catch (error) { releaseFrame(id); throw error; }
      swap(renderContext);
    } catch { stopped = true; clearInterval(timer); post({ type: 'error', code: 'playback_failed' }); }
    finally { if (resource) release(resource); if (handle) closeHandle(handle); if (texture) release(texture); }
  }
  timer = setInterval(tick, 8);
  return {
    releaseFrame,
    control(message) {
      if (stopped) return;
      if (message.action === 'pause') {
        if (get('eof-reached') === 'yes') cmd(['seek', '0', 'absolute+exact'], () => cmd(['set', 'pause', 'no']));
        else cmd(['cycle', 'pause']);
      } else if (message.action === 'seek') cmd(['seek', message.value, 'absolute+exact']);
      else if (message.action === 'volume') cmd(['set', 'volume', message.value]);
      lastState = 0;
    },
    async stop() {
      stopped = true; clearInterval(timer);
      // Stop sound before waiting on renderer references. Rendered textures are independent.
      if (mpv) cmd(['stop']);
      disposeNative();
      const end = performance.now() + 1500;
      while (frames.size && performance.now() < end) await new Promise(resolve => { setTimeout(resolve, 10); });
      for (const id of frames.keys()) releaseFrame(id);
      post({ type: 'stopped', pending: frames.size });
    },
  };
}

port.on('message', async event => {
  const message = event.data;
  try {
    if (message.type === 'start' && !engine && !stopping) engine = createEngine(message);
    else if (message.type === 'release') engine?.releaseFrame(message.id);
    else if (message.type === 'control' && !stopping) engine?.control(message);
    else if (message.type === 'stop' && !stopping) {
      stopping = true; await engine?.stop(); process.exit(0);
    }
  } catch { post({ type: 'error', code: 'playback_failed' }); }
});
// Parent loss must not leave a playing decoder behind.
port.on('close', () => process.exit(0));
