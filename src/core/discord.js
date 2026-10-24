'use strict';
// Minimal Discord RPC client over the local IPC pipe. The READY handshake
// returns the signed-in user's id, username and avatar, and the same
// connection can set Rich Presence. Needs a Discord application id.

const net = require('net');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2 };

function pipePath(i) {
  if (process.platform === 'win32') return '\\\\?\\pipe\\discord-ipc-' + i;
  const tmp = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
  return tmp.replace(/\/$/, '') + '/discord-ipc-' + i;
}

function encode(op, payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

class DiscordRpc {
  constructor() {
    this.sock = null;
    this.user = null;
  }

  tryPipe(i, clientId) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(pipePath(i));
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('Discord did not answer.')); }, 4000);
      sock.once('error', (e) => { clearTimeout(timer); reject(e); });
      sock.on('connect', () => sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: String(clientId) })));
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 8) {
          const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
          if (buf.length < 8 + len) break;
          let msg = {};
          try { msg = JSON.parse(buf.toString('utf8', 8, 8 + len)); } catch (e) { /* ignore */ }
          buf = buf.subarray(8 + len);
          if (op === OP.CLOSE || msg.evt === 'ERROR') {
            clearTimeout(timer);
            sock.destroy();
            reject(new Error((msg.data && msg.data.message) || msg.message || 'Discord refused the connection.'));
            return;
          }
          if (msg.evt === 'READY' && msg.data && msg.data.user) {
            clearTimeout(timer);
            resolve({ sock, user: msg.data.user });
          }
        }
      });
    });
  }

  async connect(clientId) {
    if (!/^\d{15,22}$/.test(String(clientId || ''))) throw new Error('Enter a valid Discord Application ID (numbers only).');
    this.disconnect();
    let lastErr = null;
    for (let i = 0; i < 10; i++) {
      try {
        const { sock, user } = await this.tryPipe(i, clientId);
        this.sock = sock;
        this.user = user;
        sock.on('close', () => { if (this.sock === sock) this.sock = null; });
        sock.on('error', () => {});
        return DiscordRpc.publicUser(user);
      } catch (e) {
        lastErr = e;
        if (e.code !== 'ENOENT') break;
      }
    }
    if (lastErr && lastErr.code === 'ENOENT') throw new Error('Discord desktop app is not running.');
    throw lastErr || new Error('Could not reach Discord.');
  }

  static publicUser(u) {
    const avatar = u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
    return { id: u.id, username: u.username, globalName: u.global_name || u.username, avatar };
  }

  setActivity(details, state, start) {
    if (!this.sock) return false;
    this.sock.write(encode(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      nonce: String(Date.now()) + Math.random(),
      args: { pid: process.pid, activity: { details, state, timestamps: start ? { start } : undefined, instance: false } },
    }));
    return true;
  }

  disconnect() {
    if (this.sock) { try { this.sock.destroy(); } catch (e) { /* ignore */ } }
    this.sock = null;
  }
}

module.exports = { DiscordRpc };
