// Loaded by NODE_OPTIONS=--import into `build --publish` and its wrangler children, for test 5c.
// Blocks and records any connection that leaves loopback, before a packet is sent.
import { appendFileSync } from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';

const log = process.env.NET_LOG;
const local = (h) => !h || h === 'localhost' || h === '::1' || h.startsWith('127.');
const hit = (h) => { appendFileSync(log, `${process.argv[1]} ${h}\n`); return new Error(`blocked ${h}`); };

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  const o = Array.isArray(a[0]) ? a[0][0] : a[0];
  const host = typeof o === 'object' && o && !o.path ? o.host : typeof a[1] === 'string' ? a[1] : undefined;
  if (typeof o === 'object' && o?.path) return connect.apply(this, a);   // unix socket
  if (!local(host)) { this.destroy(hit(host)); return this; }
  return connect.apply(this, a);
};
const lookup = dns.lookup;
dns.lookup = function (h, ...a) {
  if (!local(h)) { const cb = a.at(-1); hit(h); return void process.nextTick(cb, new Error(`blocked ${h}`)); }
  return lookup.call(this, h, ...a);
};
