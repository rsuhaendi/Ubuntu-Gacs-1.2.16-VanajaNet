// Daftar client AKTIF di LAN ONT lewat shell telnet.
//   GS3101 (busybox YHTC)  : "cat /proc/net/arp" (flags 0x2 di br0) + "brctl showmacs br0".
//   VSOL V2801RGW/V2802DAC : "show arp" + "show route" + "show bridge macs"; entri ARP
//     yang rute terbaiknya bukan interface LAN (br/lan/eth) dibuang (gateway WAN, nas*, ppp0).
// ARP dipakai bersama tabel forwarding bridge: ARP = IP terakhir, bridge = MAC yang
// masih benar-benar mengirim frame. Keduanya lihat sisi berbeda, lihat parseFdb().
// Kredensial env: CMDC_TELNET_USER/PASS (admin/rootTM), VSOL_TELNET_USER/PASS
// (admin/stdVSOL101), port telnet via *_TELNET_PORT atau argumen ke-4.
const net = require("net");

function profileOf(model) {
  if (/^V28\d\d/.test(String(model || "")))
    return {
      name: "VSOL",
      user: process.env.VSOL_TELNET_USER || "admin",
      pass: process.env.VSOL_TELNET_PASS || "stdVSOL101",
      port: Number(process.env.VSOL_TELNET_PORT || 23),
      cmds: ["show arp", "show route", "show bridge macs"],
      parse: parseVsol,
    };
  return {
    name: "GS3101",
    user: process.env.CMDC_TELNET_USER || "admin",
    pass: process.env.CMDC_TELNET_PASS || "rootTM",
    port: Number(process.env.CMDC_TELNET_PORT || 23),
    cmds: ["cat /proc/net/arp", "brctl showmacs br0"],
    parse: (texts) => {
      const f = parseFdb(texts[1]);
      return { clients: parseBusybox(texts[0]), bridge: f.bridge, radioPorts: f.radioPorts };
    },
  };
}

// Terjemahkan stream telnet: balas negosiasi (WONT/DONT), buang IAC/NULL.
function decode(s, chunk) {
  let txt = "";
  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i];
    if (b === 0xff && i + 1 < chunk.length) {
      const cmd = chunk[i + 1];
      if ((cmd === 0xfd || cmd === 0xfb) && i + 2 < chunk.length) {
        if (s.writable) s.write(Buffer.from([0xff, cmd === 0xfd ? 0xfc : 0xfe, chunk[i + 2]]));
        i += 2;
        continue;
      }
      if (cmd === 0xfc || cmd === 0xfe) { i += 2; continue; }
      if (cmd === 0xfa) {
        let j = i + 2;
        while (j + 1 < chunk.length && !(chunk[j] === 0xff && chunk[j + 1] === 0xf0)) j++;
        i = j + 1;
        continue;
      }
      if (cmd === 0xff) { txt += "ÿ"; i++; continue; }
      i++;
      continue;
    }
    if (b === 0x00) continue;
    txt += String.fromCharCode(b);
  }
  return txt;
}

function open(ip, port, deadline) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: ip, port: port });
    s.setNoDelay(true);
    const acc = { buf: "", last: Date.now() };
    s.on("data", (d) => {
      acc.buf += decode(s, d);
      acc.last = Date.now();
    });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      s.destroy();
      reject(err);
    };
    s.on("error", (err) => fail(new Error("telnet " + ip + ": " + err.message)));
    s.on("close", () => fail(new Error("telnet " + ip + " ditutup")));
    const timer = setTimeout(() => fail(new Error("telnet " + ip + ":" + port + " timeout")), Math.max(0, deadline - Date.now()));
    s.once("connect", () => {
      clearTimeout(timer);
      settled = true;
      acc.s = s;
      resolve(acc);
    });
  });
}

// Baca sampai tidak ada data baru selama `idle` ms, atau `max` ms terlewati.
function drain(acc, idle, max) {
  return new Promise((resolve) => {
    acc.buf = "";
    acc.last = Date.now();
    const end = acc.last + max;
    const tick = setInterval(() => {
      if (Date.now() - acc.last >= idle || Date.now() >= end) {
        clearInterval(tick);
        resolve(acc.buf);
      }
    }, 20);
  });
}

// VSOL CLI merender tabel per-pancaran dengan jeda >300ms; idle-drain biasa
// membuat tabel terpotong (jumlah klien berubah 0,1,2,3 antar summon).
// Baca terus sampai prompt ("/[>$#]\\s*$/") muncul di ujung dan stream diam.
function untilPrompt(acc, max) {
  return new Promise((resolve) => {
    acc.buf = "";
    acc.last = Date.now();
    const end = acc.last + max;
    const tick = setInterval(() => {
      const quiet = Date.now() - acc.last >= 120;
      const prompted = /[>$#]\s*$/.test(acc.buf.replace(/\s+$/, ""));
      if ((quiet && prompted) || Date.now() >= end) {
        clearInterval(tick);
        resolve(acc.buf);
      }
    }, 25);
  });
}

function parseBusybox(text) {
  const clients = [];
  for (const line of String(text).replace(/\r/g, "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [ip, , flags, mac, , dev] = f;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    if (flags !== "0x2") continue;
    if (dev !== "br0") continue;
    clients.push({ ip: ip, mac: mac.toUpperCase() });
  }
  return clients;
}

const clean = (t) => String(t).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

// Interface LAN VSOL: br0/br0.*, lan*, eth*. Selain itu (ppp0, nas0_*=TR-069/voip) dibuang.
const LAN_IFACE = /^(br|lan|eth)/i;

// Bridge forwarding DB -- VSOL "show bridge macs", GS3101 "brctl showmacs br0";
// keduanya memakai kolom yang sama. MAC di sini belajar dari trafik *bridged*
// (client <-> internet tanpa menyentuh stack IP ONT), sedangkan ARP kernel hanya
// menyimpan host yang bicara DENGAN ONT dan bisa berumur sangat panjang. Karena itu
// entri ARP tanpa padanan di tabel bridge = klien yang sudah pergi, dan tidak dihitung.
// Kolom "ageing timer" menghitung NAIK sejak frame terakhir (entri dibuang pada
// Bridge Ageing Time, bawaan 300s), jadi ambang 120s menandai yang masih hidup.
// Port yang menaungi MAC lokal ONT (is local = yes), atau bernama wlan/ath, adalah
// radio WiFi; port lain port kabel. V2802DAC tidak pernah mengisi AssociatedDevice,
// jadi hanya kolom ini yang bisa membedakan WiFi vs kabel di model itu.
const FRESH_MAX = 120;
function parseFdb(text) {
  const fdb = [];
  for (const line of clean(text || "").split("\n")) {
    const m = line.trim().match(/^(\S+)\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\s+(yes|no)\s+([\d.]+)/i);
    if (m) fdb.push({ port: m[1], mac: m[2].toUpperCase(), local: /^yes$/i.test(m[3]), age: Number(m[4]) });
  }
  const radioPorts = {};
  const perPort = {};
  for (const e of fdb) {
    if (e.local || /wlan|wifi|ath/i.test(e.port)) radioPorts[e.port] = true;
    else perPort[e.port] = (perPort[e.port] || 0) + 1;
  }
  // Port switch hanya menaungi satu perangkat di bawahnya; port radio menaungi
  // banyak stasiun. Kalau ONT tidak menaruh MAC lokal di bridge (V2801RGW), jumlah
  // MAC per port adalah satu-satunya penanda radio.
  for (const port of Object.keys(perPort)) if (perPort[port] >= 2) radioPorts[port] = true;
  const bridge = [];
  for (const e of fdb) {
    if (e.local || !(e.age >= 0) || e.age > FRESH_MAX) continue;
    bridge.push({ port: e.port, mac: e.mac, age: Math.round(e.age), radio: !!radioPorts[e.port] });
  }
  return { bridge: bridge, radioPorts: Object.keys(radioPorts) };
}

function parseVsol(texts) {
  const routes = [];
  for (const line of clean(texts[1] || "").split("\n")) {
    const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+\S+\s+(\S+)$/);
    if (m) routes.push({ dest: m[1], mask: m[2], iface: m[3] });
  }
  const inNet = (ip, dest, mask) => {
    const a = ip.split(".").map(Number), d = dest.split(".").map(Number), k = mask.split(".").map(Number);
    return a.every((o, i) => (o & k[i]) === (d[i] & k[i]));
  };
  const ifaceOf = (ip) => {
    let best = null, bestMask = -1;
    for (const r of routes) {
      let score = 0;
      for (const oct of r.mask.split(".").map(Number)) for (let b = 7; b >= 0; b--) if (oct & (1 << b)) score++;
      if (score > bestMask && inNet(ip, r.dest, r.mask)) { bestMask = score; best = r.iface; }
    }
    return best;
  };
  const clients = [];
  for (const line of clean(texts[0] || "").split("\n")) {
    const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/);
    if (!m) continue;
    const iface = ifaceOf(m[1]);
    // hanya buang yang PASTI lewat interface WAN (ppp/nas/dsl); tak dikenal -> pertahankan,
    // supaya tabel route yang terpotong tidak menghapus semua klien.
    if (iface && !LAN_IFACE.test(iface)) continue;
    clients.push({ ip: m[1], mac: m[2].toUpperCase() });
  }

  const f = parseFdb(texts[2]);
  return { clients: clients, bridge: f.bridge, radioPorts: f.radioPorts };
}

// Satu sesi telnet -> jalankan satu perintah -> kumpulkan output sampai prompt.
// Login VSOL kadang merender menu bertahap, jadi kalau window baca habis sebelum
// prompt muncul kita kirim baris kosong dan tunggu lagi (bukan langsung gagal).
async function telnetCmd(ip, port, p, cmd, deadline) {
  const acc = await open(ip, port, deadline);
  const s = acc.s;
  const rem = () => Math.max(0, deadline - Date.now());
  const send = (t) => {
    if (s.writable) s.write(t + "\r\n");
  };
  try {
    await drain(acc, 150, Math.min(400, rem()));
    send(p.user);
    await drain(acc, 150, Math.min(800, rem()));
    send(p.pass);
    let hello = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) send("");
      hello = await untilPrompt(acc, Math.min(2500, rem()));
      if (/[$#>]$/.test(hello.trim())) break;
      if (/login\s*(error|failed|incorrect)|bad\s*(password|login)/i.test(hello))
        throw new Error("login telnet ditolak (" + p.user + ")");
    }
    if (!/[$#>]$/.test(hello.trim())) throw new Error("login telnet ditolak (" + p.user + ")");
    send(cmd);
    return await untilPrompt(acc, Math.min(4000, rem()));
  } finally {
    s.destroy();
  }
}

async function readArp(ip, totalMs, model, port) {
  const p = profileOf(model);
  const deadline = Date.now() + totalMs;
  // Perintah dijalankan berurutan dalam sesi sendiri-sendiri: beberapa ONT
  // menolak koneksi telnet kedua yang datang bersamaan.
  const texts = [];
  for (const cmd of p.cmds) texts.push(await telnetCmd(ip, port || p.port, p, cmd, deadline));
  const res = p.parse(texts);
  if (!res || !Array.isArray(res.clients)) throw new Error("output " + p.name + " tidak dikenali");
  if (!Array.isArray(res.bridge)) res.bridge = [];
  if (!Array.isArray(res.radioPorts)) res.radioPorts = [];
  return res;
}

function get(args, callback) {
  const ip = args && args[0];
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || ""))) {
    callback(new Error("IP ONT tidak valid"));
    return;
  }
  const timeout = Math.max(1000, Math.min(Number(args[1]) || 4500, 9000));
  readArp(ip, timeout, args[2], Number(args[3]) || 0)
    .then((res) => callback(null, JSON.stringify(res)))
    .catch((err) => callback(err));
}

module.exports = { get, readArp };
