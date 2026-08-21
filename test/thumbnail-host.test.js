'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const path = require('path');
const {
  ThumbnailHost,
  resolveThumbnailHelperPath,
} = require('../src/thumbnail-host');

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
    this.writes = [];
    this.killed = false;
    this.stdin = {
      write: (data, encoding, callback) => {
        this.writes.push(String(data));
        if (callback) callback(null);
        return true;
      },
      end: () => {},
    };
  }

  send(message, fragments = 1) {
    const line = JSON.stringify(message) + '\n';
    if (fragments <= 1) {
      this.stdout.write(line);
      return;
    }
    const size = Math.max(1, Math.ceil(line.length / fragments));
    for (let i = 0; i < line.length; i += size) this.stdout.write(line.slice(i, i + size));
  }

  requests() {
    return this.writes.map((line) => JSON.parse(line));
  }

  kill() {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit('exit', 1, null));
    return true;
  }
}

function readyMessage(pid) {
  return {
    protocolVersion: 1,
    type: 'ready',
    pid,
    helperVersion: 'test',
    capabilities: { delivery: ['inline'] },
  };
}

function success(id, extra = {}) {
  return {
    protocolVersion: 1,
    type: 'response',
    id,
    ok: true,
    result: {
      delivery: 'inline',
      mime: 'image/jpeg',
      width: 320,
      height: 180,
      dataBase64: 'AQID',
      encodedBytes: 3,
      durationMs: 2,
      ...extra,
    },
  };
}

function waitTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function disposeHost(host, child) {
  const disposing = host.dispose();
  await waitTurn();
  if (child && !child.killed) {
    const shutdown = child.requests().find((request) => request.op === 'shutdown');
    if (shutdown) child.send(success(shutdown.id, { shuttingDown: true }));
  }
  await disposing;
}

(async () => {
  assert.strictEqual(
    resolveThumbnailHelperPath({
      isPackaged: false,
      appPath: 'C:\\repo',
      resourcesPath: 'C:\\resources',
    }),
    path.join('C:\\repo', '.build', 'thumbnail-helper', 'Znada.ThumbnailHelper.exe')
  );
  assert.strictEqual(
    resolveThumbnailHelperPath({
      isPackaged: true,
      appPath: 'C:\\repo',
      resourcesPath: 'C:\\resources',
    }),
    path.join('C:\\resources', 'thumbnail-helper', 'Znada.ThumbnailHelper.exe')
  );

  // Fragmented ready and response frames are reconstructed, and a result keeps its shape.
  {
    const children = [];
    const events = [];
    const host = new ThumbnailHost({
      executablePath: 'helper.exe',
      spawnImpl: () => {
        const child = new FakeChild(100 + children.length);
        children.push(child);
        return child;
      },
      onEvent: (name, attrs) => events.push({ name, attrs }),
    });
    const start = host.start();
    children[0].send(readyMessage(children[0].pid), 5);
    await start;
    const request = host.thumbnail('C:\\image.jpg', 320);
    await waitTurn();
    const sent = children[0].requests()[0];
    assert.strictEqual(sent.op, 'thumbnail');
    assert.strictEqual(sent.path, 'C:\\image.jpg');
    children[0].send(success(sent.id), 7);
    const result = await request;
    assert.strictEqual(result.mime, 'image/jpeg');
    assert.strictEqual(result.width, 320);
    assert.ok(events.some((event) => event.name === 'ready'));
    assert.ok(events.some((event) => event.name === 'response' && event.attrs.status === 'ok'));
    await disposeHost(host, children[0]);
    await host.dispose();
    assert.strictEqual(children[0].killed, true);
  }

  // Waiting on an intentionally slow helper response must not block the Node event loop.
  {
    const child = new FakeChild(175);
    const host = new ThumbnailHost({ executablePath: 'helper.exe', spawnImpl: () => child });
    const start = host.start();
    child.send(readyMessage(child.pid));
    await start;
    const request = host.thumbnail('C:\\slow.jpg', 320);
    await waitTurn();
    const sent = child.requests()[0];
    let heartbeat = 0;
    let heartbeatRunning = true;
    const beat = () => {
      heartbeat++;
      if (heartbeatRunning) setImmediate(beat);
    };
    setImmediate(beat);
    setTimeout(() => child.send(success(sent.id)), 30);
    await request;
    heartbeatRunning = false;
    assert.ok(heartbeat >= 5);
    await disposeHost(host, child);
  }

  // Multiple frames in one chunk are matched by id, not FIFO order. Stderr is ignored.
  {
    const child = new FakeChild(200);
    const host = new ThumbnailHost({ executablePath: 'helper.exe', spawnImpl: () => child });
    const start = host.start();
    child.send(readyMessage(child.pid));
    await start;
    const first = host.ping();
    const second = host.ping();
    await waitTurn();
    const requests = child.requests();
    child.stderr.write('{not-protocol}\n');
    child.stdout.write(
      JSON.stringify(success(requests[1].id, { marker: 'second' })) + '\n'
      + JSON.stringify(success(requests[0].id, { marker: 'first' })) + '\n'
    );
    assert.strictEqual((await first).marker, 'first');
    assert.strictEqual((await second).marker, 'second');
    await disposeHost(host, child);
  }

  // A helper protocol error rejects pending work and kills the bad process.
  {
    const child = new FakeChild(300);
    const host = new ThumbnailHost({ executablePath: 'helper.exe', spawnImpl: () => child });
    const start = host.start();
    child.send(readyMessage(child.pid));
    await start;
    const request = host.ping();
    await waitTurn();
    child.stdout.write('{not-json}\n');
    await assert.rejects(request, (error) => error && error.code === 'protocol_error');
    assert.strictEqual(child.killed, true);
    await host.dispose();
  }

  // A syntactically valid response with an unsafe thumbnail shape is still corruption.
  {
    const child = new FakeChild(325);
    const host = new ThumbnailHost({ executablePath: 'helper.exe', spawnImpl: () => child });
    const start = host.start();
    child.send(readyMessage(child.pid));
    await start;
    const request = host.thumbnail('C:\\bad.jpg', 320);
    await waitTurn();
    const sent = child.requests()[0];
    child.send(success(sent.id, { mime: 'text/html' }));
    await assert.rejects(request, (error) => error && error.code === 'protocol_error');
    assert.strictEqual(child.killed, true);
    await host.dispose();
  }

  // An oversized frame without a newline is treated as protocol corruption.
  {
    const child = new FakeChild(350);
    const host = new ThumbnailHost({
      executablePath: 'helper.exe',
      spawnImpl: () => child,
      frameLimit: 64,
    });
    const start = host.start();
    child.stdout.write('x'.repeat(65));
    await assert.rejects(start, (error) => error && error.code === 'protocol_error');
    assert.strictEqual(child.killed, true);
    await host.dispose();
  }

  // A helper that never sends ready is killed after the startup deadline.
  {
    const child = new FakeChild(375);
    const host = new ThumbnailHost({
      executablePath: 'helper.exe',
      spawnImpl: () => child,
      startupTimeoutMs: 15,
    });
    await assert.rejects(host.start(), (error) => error && error.code === 'start_timeout');
    assert.strictEqual(child.killed, true);
    await host.dispose();
  }

  // One unexpected exit rejects every pending request on that process.
  {
    const child = new FakeChild(390);
    const host = new ThumbnailHost({ executablePath: 'helper.exe', spawnImpl: () => child });
    const start = host.start();
    child.send(readyMessage(child.pid));
    await start;
    const first = host.ping();
    const second = host.ping();
    await waitTurn();
    child.emit('exit', 9, null);
    const settled = await Promise.allSettled([first, second]);
    assert.deepStrictEqual(settled.map((item) => item.status), ['rejected', 'rejected']);
    assert.ok(settled.every((item) => item.reason && item.reason.code === 'process_lost'));
    await host.dispose();
  }

  // Work lost with a crashed process is retried once in a fresh helper.
  {
    const children = [];
    const host = new ThumbnailHost({
      executablePath: 'helper.exe',
      spawnImpl: () => {
        const child = new FakeChild(400 + children.length);
        children.push(child);
        return child;
      },
    });
    const start = host.start();
    children[0].send(readyMessage(children[0].pid));
    await start;
    const request = host.thumbnail('C:\\retry.jpg', 200);
    await waitTurn();
    children[0].emit('exit', 9, null);
    await waitTurn();
    assert.strictEqual(children.length, 2);
    children[1].send(readyMessage(children[1].pid));
    await waitTurn();
    const retried = children[1].requests()[0];
    assert.strictEqual(retried.op, 'thumbnail');
    children[1].send(success(retried.id));
    assert.strictEqual((await request).width, 320);
    await disposeHost(host, children[1]);
  }

  // A wedged request times out, kills the helper and opens the crash circuit at its budget.
  {
    const children = [];
    let now = 1000;
    const host = new ThumbnailHost({
      executablePath: 'helper.exe',
      requestTimeoutMs: 15,
      crashLimit: 1,
      cooldownMs: 1000,
      now: () => now,
      spawnImpl: () => {
        const child = new FakeChild(500 + children.length);
        children.push(child);
        return child;
      },
    });
    const start = host.start();
    children[0].send(readyMessage(children[0].pid));
    await start;
    await assert.rejects(host.ping(), (error) => error && error.code === 'extract_timeout');
    await waitTurn();
    assert.strictEqual(children[0].killed, true);
    await assert.rejects(host.start(), (error) => error && error.code === 'circuit_open');
    now += 1001;
    const restarted = host.start();
    children[1].send(readyMessage(children[1].pid));
    await restarted;
    await disposeHost(host, children[1]);
  }

  console.log('thumbnail-host.test.js ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
