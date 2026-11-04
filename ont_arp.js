// Daftar client AKTIF di LAN ONT lewat shell telnet: "cat /proc/net/arp".
// ARP kernel = host yang benar-benar ada lalu-lintas paket terakhir, tercakup
// client DHCP maupun IP statik (yang tidak muncul di Hosts.Host TR-069).
// Entri dengan Flags 0x2 (complete) pada bridge br0; entri gateway WAN
// (dev nas*) dan yang belum resolve (0x0) dibuang.
// Kredensial: env CMDC_TELNET_USER/PASS/PORT, default admin/rootTM (CMDC GS3101).
const net = require("net");

const USER = process.env.CMDC_TELNET_USER || "admin";
const PASS = process.env.CMDC_TELNET_PASS || "rootTM";
const PORT = Number(process.env.CMDC_TELNET_PORT || 23);

function open(ip, deadline) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: ip, port: PORT });
    s.setNoDelay(true);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      s.destroy();
      reject(err);
    };
    s.on("error", (err) => fail(new Error("telnet " + ip + ": " + err.message)));
    s.on("close", () => fail(new Error("telnet " + ip + " ditutup")));
    const timer = setTimeout(() => fail(new Error("telnet " + ip + ":" + PORT + " timeout")), Math.max(0, deadline - Date.now()));
    s.once("connect", () => {
      clearTimeout(timer);
      settled = true;
      resolve(s);
    });
  });
}

// Baca sampai tidak ada data baru selama `idle` ms, atau `max` ms terlewati.
function drain(s, idle, max) {
  return new Promise((resolve) => {
    let buf = "";
    let last = Date.now();
    const end = last + max;
    function onData(d) {
      buf += d.toString("utf8");
      last = Date.now();
    }
    const tick = setInterval(() => {
      if (Date.now() - last >= idle || Date.now() >= end) {
        clearInterval(tick);
        s.removeListener("data", onData);
        resolve(buf);
      }
    }, 20);
    s.on("data", onData);
  });
}

function parseArp(text) {
  const clients = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [ip, , flags, mac, , dev] = f;
    if (!/^10\.0|^\d/.test(ip)) continue;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    if (flags !== "0x2") continue;
    if (dev !== "br0") continue;
    clients.push({ ip: ip, mac: mac.toUpperCase() });
  }
  return clients;
}

async function readArp(ip, totalMs) {
  const deadline = Date.now() + totalMs;
  const s = await open(ip, deadline);
  const rem = () => Math.max(0, deadline - Date.now());
  const send = (t) => {
    if (s.writable) s.write(t);
  };
  try {
    await drain(s, 200, Math.min(400, rem()));
    send(USER + "\r\n");
    await drain(s, 200, Math.min(1200, rem()));
    send(PASS + "\r\n");
    const hello = await drain(s, 250, Math.min(2000, rem()));
    if (!/[$#>]$/.test(hello.trim())) throw new Error("login telnet ditolak (" + USER + ")");
    send("cat /proc/net/arp\r\n");
    const out = await drain(s, 250, Math.min(2500, rem()));
    return parseArp(out);
  } finally {
    send("exit\r\n");
    s.destroy();
  }
}

function get(args, callback) {
  const ip = args && args[0];
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || ""))) {
    callback(new Error("IP ONT tidak valid"));
    return;
  }
  const timeout = Math.max(1000, Math.min(Number(args[1]) || 4500, 9000));
  readArp(ip, timeout)
    .then((clients) => callback(null, JSON.stringify({ clients: clients })))
    .catch((err) => callback(err));
}

module.exports = { get, readArp };
