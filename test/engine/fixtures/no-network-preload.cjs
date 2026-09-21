// Test material · a process-wide tripwire for network use, loaded with `NODE_OPTIONS=--require`.
//
// Every TCP connection, UDP socket, DNS lookup, HTTP(S) request and `fetch` made by the process is
// appended to the file named by CERNUM_NETWORK_LOG and then REFUSED by throwing. A test asserts that
// the file is empty. Local IPC over a filesystem socket path is not network and is let through —
// the TypeScript loader uses it to talk to its own compiler — but it is still logged, as `ipc`, so
// nothing reaches the outside unrecorded.
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const dgram = require('node:dgram');
const http = require('node:http');
const https = require('node:https');

const LOG = process.env.CERNUM_NETWORK_LOG;

function record(kind, target) {
  if (LOG) fs.appendFileSync(LOG, `${process.pid} ${kind} ${target}\n`);
}

function refuse(kind, target) {
  record(kind, target);
  throw new Error(`network use refused by the test tripwire: ${kind} ${target}`);
}

function describe(args) {
  const first = args[0];
  if (first && typeof first === 'object') {
    if (first.path) return { ipc: true, target: String(first.path) };
    return { ipc: false, target: `${first.host ?? 'localhost'}:${first.port}` };
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { ipc: true, target: first };
  return { ipc: false, target: `${args[1] ?? 'localhost'}:${first}` };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const { ipc, target } = describe(Array.isArray(args[0]) ? args[0] : args);
  if (!ipc) refuse('tcp', target);
  record('ipc', target);
  return originalConnect.apply(this, args);
};

tls.connect = (...args) => refuse('tls', describe(args).target);
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
  dns[name] = (host) => refuse('dns', String(host));
  if (dns.promises && dns.promises[name]) dns.promises[name] = async (host) => refuse('dns', String(host));
}
dgram.createSocket = () => refuse('udp', 'createSocket');
for (const module of [http, https]) {
  const label = module === http ? 'http' : 'https';
  module.request = (target) => refuse(label, typeof target === 'string' ? target : JSON.stringify(target && (target.host || target.hostname)));
  module.get = module.request;
}
if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = async (target) => refuse('fetch', String(target));
}
