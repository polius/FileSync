// Transfer engine over in-memory channels: integrity, flow control, resume, failures.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { channelPair, memorySink, tick } from './helpers/fakes.mjs';

const { OutgoingTransfer, IncomingTransfer, DownloadState, TransferError, WINDOW } = await import('../../web/js/app/transfer.js');

const sha = (b) => createHash('sha256').update(b).digest('hex');

function makeFile(size) {
  const bytes = new Uint8Array(randomBytes(size));
  return { bytes, blob: new Blob([bytes]) };
}

test('a file arrives byte for byte and both sides agree on SHA-256', async () => {
  const { bytes, blob } = makeFile(3 * 1024 * 1024 + 17);
  const [tx, rx] = channelPair();
  const sink = memorySink();
  const state = new DownloadState(sink, blob.size);
  const [sent, got] = await Promise.all([
    new OutgoingTransfer(tx, blob).run(0),
    new IncomingTransfer(rx, state).run(),
  ]);
  assert.equal(got, sha(bytes));
  assert.equal(sent, got);
  assert.deepEqual(sink.bytes(), bytes);
  assert.equal(state.written, blob.size);
});

test('empty files transfer and verify', async () => {
  const blob = new Blob([]);
  const [tx, rx] = channelPair();
  const sink = memorySink();
  const [, got] = await Promise.all([
    new OutgoingTransfer(tx, blob).run(0),
    new IncomingTransfer(rx, new DownloadState(sink, 0)).run(),
  ]);
  assert.equal(got, sha(new Uint8Array(0)));
});

test('flow control: the sender never runs more than WINDOW ahead of durable writes', async () => {
  const { blob } = makeFile(48 * 1024 * 1024);
  const [tx, rx] = channelPair();
  let written = 0;
  let maxAhead = 0;
  // A slow disk: every write takes a moment.
  const sink = {
    async write(b) { await tick(0); written += b.byteLength; },
    async close() {},
    async abort() {},
  };
  const origSend = tx.send.bind(tx);
  tx.send = (data) => {
    origSend(data);
    if (typeof data !== 'string') maxAhead = Math.max(maxAhead, tx.sentBytes - written);
  };
  await Promise.all([
    new OutgoingTransfer(tx, blob).run(0),
    new IncomingTransfer(rx, new DownloadState(sink, blob.size)).run(),
  ]);
  assert.ok(maxAhead <= WINDOW + 1024 * 1024 + 64 * 1024, `sender ran ${maxAhead} bytes ahead`);
});

test('resume continues from the bytes written and still verifies the whole file', async () => {
  const { bytes, blob } = makeFile(5 * 1024 * 1024 + 3);
  const sink = memorySink();
  const state = new DownloadState(sink, blob.size);

  // First attempt: the channel drops partway.
  const [tx1, rx1] = channelPair();
  const sender1 = new OutgoingTransfer(tx1, blob);
  const receiver1 = new IncomingTransfer(rx1, state, {
    onProgress: (w) => { if (w >= 2 * 1024 * 1024 && rx1.readyState === 'open') rx1.close(); },
  });
  const [r1, s1] = await Promise.allSettled([receiver1.run(), sender1.run(0)]);
  assert.equal(r1.status, 'rejected');
  assert.ok(r1.reason instanceof TransferError && r1.reason.resumable, 'interruption is resumable');
  assert.equal(s1.status, 'rejected');
  const offset = state.written;
  assert.ok(offset > 0 && offset < blob.size);

  // Second attempt on a new channel from that offset.
  const [tx2, rx2] = channelPair();
  const [sent, got] = await Promise.all([
    new OutgoingTransfer(tx2, blob).run(offset),
    new IncomingTransfer(rx2, state).run(),
  ]);
  assert.equal(got, sha(bytes));
  assert.equal(sent, got);
  assert.deepEqual(sink.bytes(), bytes);
  assert.ok(tx2.sentBytes <= blob.size - offset, 'resume did not re-send bytes the receiver had');
});

test('a corrupted byte is detected and the file is rejected', async () => {
  const { blob } = makeFile(256 * 1024);
  const [tx, rx] = channelPair();
  let flipped = false;
  tx.tamper = (d) => {
    if (typeof d !== 'string' && !flipped) { const v = new Uint8Array(d); v[100] ^= 0xff; flipped = true; }
    return d;
  };
  const [s, r] = await Promise.allSettled([
    new OutgoingTransfer(tx, blob).run(0),
    new IncomingTransfer(rx, new DownloadState(memorySink(), blob.size)).run(),
  ]);
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason.reason, 'checksum-mismatch');
  assert.equal(r.reason.resumable, false);
  assert.equal(s.status, 'rejected');
});

test('a header with the wrong size or offset is refused', async () => {
  const { blob } = makeFile(1000);
  const [tx, rx] = channelPair();
  const [, r] = await Promise.allSettled([
    new OutgoingTransfer(tx, blob).run(0),
    new IncomingTransfer(rx, new DownloadState(memorySink(), 999)).run(),
  ]);
  assert.equal(r.reason.reason, 'size-mismatch');
});

test('receiver stop reaches the sender; sender stop reaches the receiver', async () => {
  // Larger than the credit window, so the stop always lands mid-transfer.
  const { blob } = makeFile(WINDOW * 3);
  {
    const [tx, rx] = channelPair();
    const receiver = new IncomingTransfer(rx, new DownloadState(memorySink(), blob.size), {
      onProgress: (w) => { if (w > 1024 * 1024) receiver.stop('cancelled'); },
    });
    const [s, r] = await Promise.allSettled([new OutgoingTransfer(tx, blob).run(0), receiver.run()]);
    assert.equal(r.reason.reason, 'cancelled');
    assert.equal(s.status, 'rejected');
  }
  {
    const [tx, rx] = channelPair();
    const sender = new OutgoingTransfer(tx, blob, { onProgress: (a) => { if (a > 1024 * 1024) sender.stop('removed'); } });
    const [s, r] = await Promise.allSettled([sender.run(0), new IncomingTransfer(rx, new DownloadState(memorySink(), blob.size)).run()]);
    assert.equal(s.reason.reason, 'removed');
    assert.ok(['sender-removed', 'channel-closed'].includes(r.reason.reason));
    if (r.reason.reason === 'sender-removed') assert.equal(r.reason.resumable, false);
  }
});

test('a failing disk aborts the transfer and is not resumable', async () => {
  const { blob } = makeFile(2 * 1024 * 1024);
  const [tx, rx] = channelPair();
  const [, r] = await Promise.allSettled([
    new OutgoingTransfer(tx, blob).run(0),
    new IncomingTransfer(rx, new DownloadState(memorySink({ failAt: 500_000 }), blob.size)).run(),
  ]);
  assert.equal(r.reason.reason, 'write-failed');
  assert.equal(r.reason.resumable, false);
});

test('a silent sender is detected as a stall (resumable)', async () => {
  const [, rx] = channelPair();
  const r = await new IncomingTransfer(rx, new DownloadState(memorySink(), 10), { stallMs: 50 }).run().catch((e) => e);
  assert.equal(r.reason, 'stall');
  assert.equal(r.resumable, true);
});
