// 零依赖局域网自动服务发现（标准 mDNS _agent-relay._tcp.local + 轻量 UDP 组播/广播信标）
const dgram = require('dgram');
const os = require('os');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE_TYPE = '_agent-relay._tcp.local';
const BEACON_ADDR = process.env.AGENT_RELAY_DISCOVERY_ADDR || '239.255.87.87';
const BEACON_PORT = Number(process.env.AGENT_RELAY_DISCOVERY_PORT || 8788);

// ---------- 轻量 DNS-SD / mDNS 报文编解码（RFC 6762 / 6763 子集） ----------
function encodeDnsName(name) {
  const parts = String(name).replace(/\.$/, '').split('.').filter(Boolean);
  const bufs = [];
  for (const part of parts) {
    const b = Buffer.from(part, 'utf8');
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

function decodeDnsName(buf, offset) {
  const labels = [];
  let jumped = false;
  let origEnd = offset;
  let pos = offset;
  let guard = 0;
  while (pos < buf.length && guard++ < 64) {
    const len = buf[pos];
    if (len === 0) {
      if (!jumped) origEnd = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) break;
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) origEnd = pos + 2;
      jumped = true;
      pos = ptr;
      continue;
    }
    pos++;
    if (pos + len > buf.length) break;
    labels.push(buf.toString('utf8', pos, pos + len));
    pos += len;
  }
  return { name: labels.join('.'), nextOffset: origEnd };
}

function dnsRecord(name, type, cls, ttl, rdata) {
  const nameBuf = encodeDnsName(name);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(cls, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuf, head, rdata]);
}

function buildMdnsResponse(info) {
  const hostSlug = String(info.hostname || os.hostname()).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 32) || 'agent-relay';
  const instanceName = `${hostSlug}-${info.port}.${SERVICE_TYPE}`;
  const hostFqdn = `${hostSlug}.local`;
  const primaryIp = (info.hosts && info.hosts[0]) || '127.0.0.1';
  const octets = primaryIp.split('.').map(n => Number(n) & 0xff);
  const ipBuf = octets.length === 4 ? Buffer.from(octets) : Buffer.from([127, 0, 0, 1]);

  const ptrRdata = encodeDnsName(instanceName);
  const srvHead = Buffer.alloc(6);
  srvHead.writeUInt16BE(0, 0);
  srvHead.writeUInt16BE(0, 2);
  srvHead.writeUInt16BE(Number(info.port) & 0xffff, 4);
  const srvRdata = Buffer.concat([srvHead, encodeDnsName(hostFqdn)]);

  const txtPairs = [
    `version=${info.version || '2.1.0'}`,
    `auth=${info.auth || 'open'}`,
    `rooms=${info.rooms ?? 1}`,
    `url=http://${primaryIp}:${info.port}`,
  ];
  const txtRdata = Buffer.concat(txtPairs.map(pair => {
    const b = Buffer.from(pair, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  }));

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x0000, 0); // ID
  header.writeUInt16BE(0x8400, 2); // Standard response, authoritative
  header.writeUInt16BE(0, 4);      // QDCOUNT
  header.writeUInt16BE(1, 6);      // ANCOUNT (PTR)
  header.writeUInt16BE(0, 8);      // NSCOUNT
  header.writeUInt16BE(3, 10);     // ARCOUNT (SRV, TXT, A)

  return Buffer.concat([
    header,
    dnsRecord(SERVICE_TYPE, 12, 0x0001, 120, ptrRdata),
    dnsRecord(instanceName, 33, 0x8001, 120, srvRdata),
    dnsRecord(instanceName, 16, 0x8001, 120, txtRdata),
    dnsRecord(hostFqdn, 1, 0x8001, 120, ipBuf),
  ]);
}

function isMdnsQueryForService(msg) {
  if (msg.length < 12) return false;
  const flags = msg.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) return false; // 仅处理查询
  const qdcount = msg.readUInt16BE(4);
  let offset = 12;
  for (let i = 0; i < qdcount && offset < msg.length; i++) {
    const { name, nextOffset } = decodeDnsName(msg, offset);
    offset = nextOffset + 4;
    const lower = name.toLowerCase();
    if (lower === SERVICE_TYPE || lower === '_services._dns-sd._udp.local') return true;
  }
  return false;
}

// ---------- 服务端广播与应答 ----------
function startDiscoveryResponder(getInfo, options = {}) {
  const beaconPort = options.beaconPort ?? BEACON_PORT;
  const beaconAddr = options.beaconAddr ?? BEACON_ADDR;
  const enableMdns = options.mdns !== false;
  const bindHost = options.bindHost || undefined;

  const status = {
    enabled: true,
    serviceType: SERVICE_TYPE,
    beaconAddr,
    beaconPort,
    mdnsActive: false,
    beaconActive: false,
  };
  const sockets = [];
  let announceTimer = null;

  function buildBeaconPayload() {
    const info = getInfo();
    const host = (info.hosts && info.hosts[0]) || '127.0.0.1';
    return Buffer.from(JSON.stringify({
      type: 'agent-relay-announce',
      service: SERVICE_TYPE,
      instanceId: info.instanceId,
      hostname: info.hostname || os.hostname(),
      version: info.version,
      auth: info.auth,
      rooms: info.rooms,
      port: info.port,
      hosts: info.hosts,
      url: `http://${host}:${info.port}`,
    }));
  }

  // 1. 轻量 LAN Beacon（UDP 组播 + 单播响应）
  try {
    const beacon = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    beacon.on('error', () => { status.beaconActive = false; });
    beacon.on('message', (msg, rinfo) => {
      try {
        const parsed = JSON.parse(msg.toString('utf8'));
        if (parsed?.type === 'agent-relay-discover') {
          const reply = buildBeaconPayload();
          beacon.send(reply, rinfo.port, rinfo.address, () => {});
        }
      } catch {}
    });
    beacon.bind(beaconPort, bindHost, () => {
      status.beaconActive = true;
      try {
        beacon.setBroadcast(true);
        beacon.setMulticastTTL(2);
        beacon.setMulticastLoopback(true);
        beacon.addMembership(beaconAddr);
      } catch {}
    });
    beacon.unref();
    sockets.push(beacon);
  } catch {}

  // 2. 标准 mDNS (_agent-relay._tcp.local on 224.0.0.251:5353)
  if (enableMdns) {
    try {
      const mdns = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      mdns.on('error', () => { status.mdnsActive = false; });
      mdns.on('message', (msg) => {
        if (isMdnsQueryForService(msg)) {
          const packet = buildMdnsResponse(getInfo());
          mdns.send(packet, MDNS_PORT, MDNS_ADDR, () => {});
        }
      });
      mdns.bind(MDNS_PORT, () => {
        status.mdnsActive = true;
        try {
          mdns.setMulticastTTL(255);
          mdns.setMulticastLoopback(true);
          mdns.addMembership(MDNS_ADDR);
          const packet = buildMdnsResponse(getInfo());
          mdns.send(packet, MDNS_PORT, MDNS_ADDR, () => {});
        } catch {}
      });
      mdns.unref();
      sockets.push(mdns);

      announceTimer = setInterval(() => {
        if (!status.mdnsActive) return;
        try {
          const packet = buildMdnsResponse(getInfo());
          mdns.send(packet, MDNS_PORT, MDNS_ADDR, () => {});
        } catch {}
      }, 60_000);
      announceTimer.unref();
    } catch {}
  }

  return {
    status,
    close() {
      if (announceTimer) clearInterval(announceTimer);
      for (const s of sockets) {
        try { s.close(); } catch {}
      }
    },
  };
}

// ---------- 客户端自动扫描 ----------
function discoverRelays({ timeoutMs = 1500, beaconPort = BEACON_PORT, beaconAddr = BEACON_ADDR, hosts = [] } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      resolve([...found.values()].sort((a, b) => a.url.localeCompare(b.url)));
    };
    const timer = setTimeout(finish, Math.max(200, timeoutMs));

    sock.on('error', finish);
    sock.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString('utf8'));
        if (data?.type !== 'agent-relay-announce' || !data.port) return;
        const primaryHost = (Array.isArray(data.hosts) && data.hosts[0]) || rinfo.address;
        const url = data.url || `http://${primaryHost}:${data.port}`;
        const key = data.instanceId || url;
        found.set(key, {
          url,
          hostname: data.hostname || primaryHost,
          hosts: Array.isArray(data.hosts) ? data.hosts : [rinfo.address],
          port: data.port,
          version: data.version || '',
          auth: data.auth || 'open',
          rooms: data.rooms ?? 0,
          from: rinfo.address,
        });
      } catch {}
    });

    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch {}
      try { sock.setMulticastTTL(2); } catch {}
      try { sock.setMulticastLoopback(true); } catch {}
      const probe = Buffer.from(JSON.stringify({ type: 'agent-relay-discover', service: SERVICE_TYPE }));
      const targets = [beaconAddr, '255.255.255.255', '127.0.0.1', ...hosts];
      const sendProbe = () => {
        for (const addr of targets) sock.send(probe, beaconPort, addr, () => {});
      };
      sendProbe();
      setTimeout(() => { if (!finished) sendProbe(); }, Math.min(350, Math.floor(timeoutMs / 3))).unref();
    });
  });
}

module.exports = {
  SERVICE_TYPE,
  MDNS_ADDR,
  MDNS_PORT,
  BEACON_ADDR,
  BEACON_PORT,
  buildMdnsResponse,
  isMdnsQueryForService,
  startDiscoveryResponder,
  discoverRelays,
};
