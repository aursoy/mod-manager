'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A stand-in for the Discord desktop app's local pipe: answers the handshake with READY.
test('discord: connects over the local pipe and reads the signed-in user (no login needed)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-ipc-'));
  process.env.XDG_RUNTIME_DIR = dir;
  const { DiscordRpc } = require('../src/core/discord');
  const frames = [];
  const server = net.createServer((sock) => {
    sock.on('data', (d) => {
      const op = d.readInt32LE(0), msg = JSON.parse(d.toString('utf8', 8));
      frames.push({ op, msg });
      if (op === 0) {
        const body = Buffer.from(JSON.stringify({ cmd: 'DISPATCH', evt: 'READY', data: { user: { id: '80351110224678912', username: 'kt', global_name: 'KT', avatar: 'abc' } } }));
        const head = Buffer.alloc(8); head.writeInt32LE(1, 0); head.writeInt32LE(body.length, 4);
        sock.write(Buffer.concat([head, body]));
      }
    });
  });
  await new Promise((r) => server.listen(path.join(dir, 'discord-ipc-0'), r));
  const rpc = new DiscordRpc();
  const user = await rpc.connect('1234567890123456789');
  assert.deepStrictEqual(user, { id: '80351110224678912', username: 'kt', globalName: 'KT', avatar: 'https://cdn.discordapp.com/avatars/80351110224678912/abc.png?size=128' });
  assert.strictEqual(frames[0].msg.client_id, '1234567890123456789');
  assert.ok(rpc.setActivity('In Graphics', 'Kt Mod Manager', 1));
  rpc.disconnect();
  server.close();
});
