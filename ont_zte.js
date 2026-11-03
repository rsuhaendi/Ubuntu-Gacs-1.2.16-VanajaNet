// Membaca passphrase WiFi + SSID ONT ZTE (CL601) lewat shell telnet.
// ZTE menyembunyikan KeyPassphrase lewat TR-069 (selalu kosong), tapi database
// internalnya bisa di-dump dari shell: "sidbg 1 DB p WLANCfg / WLANPSK".
// Akun web CL601 ada di modul ont_zte_db (file terpisah karena genieacs menyimpan
// modul ext per proses worker). Kredensial shell dari env ZTE_TELNET_USER/PASS/PORT,
// fallback pasangan CT-COM standar yang juga ada di X_CT-COM_ServiceManage.
const net = require("net");
const cfg = require("./ont_config.js");

const USER = process.env.ZTE_TELNET_USER || "teluser";
const PASS = process.env.ZTE_TELNET_PASS || "teluser123";
const PORT = Number(process.env.ZTE_TELNET_PORT || 23);

const CFG_TABLE = "WLANCfg";
const PSK_TABLE = "WLANPSK";

function open(ip) {
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
    // Handler error harus tetap terpasang setelah connect: socket yang RST di tengah
    // perintah akan memicu 'error' dan menjatuhkan proses ext kalau tidak ada listener.
    s.on("error", (err) => fail(new Error("telnet " + ip + ": " + err.message)));
    s.on("close", () => fail(new Error("telnet " + ip + " ditutup")));
    s.setTimeout(4000, () => fail(new Error("telnet " + ip + ":" + PORT + " timeout")));
    s.once("connect", () => {
      settled = true;
      s.setTimeout(0);
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

async function shell(ip, rem) {
  const s = await open(ip);
  const send = (t) => {
    if (s.writable) s.write(t);
  };
  await drain(s, 200, 400);
  send(USER + "\r\n");
  await drain(s, 200, Math.min(1200, rem()));
  send(PASS + "\r\n");
  const hello = await drain(s, 250, Math.min(2000, rem()));
  if (!/[$#>]$/.test(hello.trim())) {
    s.destroy();
    throw new Error("login telnet ditolak (" + USER + ")");
  }
  return {
    run: async (cmd) => {
      send(cmd + "\r\n");
      return (await drain(s, 250, Math.min(2500, rem()))).replace(/\r/g, "");
    },
    close: () => {
      send("exit\r\n");
      s.destroy();
    },
  };
}

function attr(row, name) {
  const m = row.match(new RegExp('<DM name="' + name + '" val="([^"]*)"'));
  return m ? m[1] : "";
}

function rows(text, table) {
  const start = text.indexOf('<Tbl name="' + table + '"');
  if (start < 0) return [];
  const end = text.indexOf("</Tbl>", start);
  return text.slice(start, end < 0 ? text.length : end).split("<Row ").slice(1);
}

// Index WLAN diambil dari ViewName IGD.LD1.WLAN<n>, bukan dari urutan baris.
function wlanIndex(view) {
  const m = String(view).match(/WLAN(\d+)/);
  return m ? Number(m[1]) : 0;
}

function parseWlan(texts) {
  const by = new Map();
  for (const row of rows(texts.cfg, CFG_TABLE)) {
    const i = wlanIndex(attr(row, "ViewName"));
    if (!i) continue;
    by.set(i, {
      index: i,
      ssid: attr(row, "ESSID"),
      enable: attr(row, "Enable") === "1",
      hidden: attr(row, "ESSIDHideEnable") === "1",
      beacon: attr(row, "BeaconType"),
    });
  }
  for (const row of rows(texts.psk, PSK_TABLE)) {
    const i = wlanIndex(attr(row, "ViewName"));
    if (!i) continue;
    const e = by.get(i) || { index: i, ssid: "", enable: false, hidden: false, beacon: "" };
    e.psk = attr(row, "KeyPassphrase") || attr(row, "PreSharedKey");
    by.set(i, e);
  }
  return [...by.values()].sort((a, b) => a.index - b.index);
}

async function readWlan(ip, totalMs) {
  const rem = cfg.budget(totalMs);
  const sh = await shell(ip, rem);
  try {
    const entries = parseWlan({
      cfg: await sh.run("sidbg 1 DB p " + CFG_TABLE),
      psk: await sh.run("sidbg 1 DB p " + PSK_TABLE),
    });
    if (!entries.length) throw new Error("tabel WLAN tidak terbaca (sidbg?)");
    return entries;
  } finally {
    sh.close();
  }
}

function ipOf(args) {
  const ip = args && args[0];
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || ""))) throw new Error("IP ONT tidak valid");
  return ip;
}

function timeoutOf(v) {
  return Math.max(500, Math.min(Number(v) || 2800, 8000));
}

function get(args, callback) {
  try {
    readWlan(ipOf(args), timeoutOf(args[1]))
      .then((entries) => callback(null, JSON.stringify({ entries: entries })))
      .catch((err) => callback(err));
  } catch (err) {
    callback(err);
  }
}

module.exports = { get, readWlan };
