// Membaca SSID + passphrase WiFi ONT ZTE (CL601) lewat shell telnet.
// Firmware ZTE menyembunyikan KeyPassphrase lewat TR-069 (selalu kosong), tapi
// database internalnya bisa di-dump dari shell: "sidbg 1 DB p WLANPSK" dan
// "sidbg 1 DB p WLANCfg". Kredensial shell dibaca dari env, fallback ke pasangan
// CT-COM standar yang juga tersimpan di DeviceInfo.X_CT-COM_ServiceManage.
const net = require("net");
const cfg = require("./ont_config.js");

const USER = process.env.ZTE_TELNET_USER || "teluser";
const PASS = process.env.ZTE_TELNET_PASS || "teluser123";
const PORT = Number(process.env.ZTE_TELNET_PORT || 23);
const PSK_TABLE = "WLANPSK";
const CFG_TABLE = "WLANCfg";

function open(ip) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: ip, port: PORT });
    s.setNoDelay(true);
    s.once("connect", () => {
      s.setTimeout(0);
      resolve(s);
    });
    s.once("error", reject);
    s.setTimeout(4000, () => {
      s.destroy();
      reject(new Error("telnet " + ip + ":" + PORT + " timeout"));
    });
  });
}

// Baca sampai tidak ada data baru selama `idle` ms, atau `max` ms terlewati.
function drain(s, idle, max) {
  return new Promise((resolve) => {
    let buf = "";
    let last = Date.now();
    const end = last + max;
    const tick = setInterval(() => {
      if (Date.now() - last >= idle || Date.now() >= end) {
        clearInterval(tick);
        s.removeAllListeners("data");
        resolve(buf);
      }
    }, 20);
    s.on("data", (d) => {
      buf += d.toString("utf8");
      last = Date.now();
    });
  });
}

async function command(s, cmd, rem, idle) {
  s.write(cmd + "\r\n");
  const out = await drain(s, idle || 250, Math.min(2500, rem()));
  return out.replace(/\r/g, "");
}

function attr(row, name) {
  const m = row.match(new RegExp('<DM name="' + name + '" val="([^"]*)"'));
  return m ? m[1] : "";
}

function rows(text, table) {
  const start = text.indexOf('<Tbl name="' + table + '"');
  if (start < 0) return [];
  const end = text.indexOf("</Tbl>", start);
  const body = text.slice(start, end < 0 ? text.length : end);
  return body.split("<Row ").slice(1);
}

// Index WLAN diambil dari ViewName IGD.LD1.WLAN<n>, bukan dari urutan baris.
function wlanIndex(view) {
  const m = String(view).match(/WLAN(\d+)/);
  return m ? Number(m[1]) : 0;
}

function parse(texts) {
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
    e.psk = attr(row, "KeyPassphrase");
    if (!e.psk) e.psk = attr(row, "PreSharedKey");
    by.set(i, e);
  }
  return [...by.values()].sort((a, b) => a.index - b.index);
}

async function readWlan(ip, totalMs) {
  const rem = cfg.budget(totalMs);
  const s = await open(ip);
  try {
    await drain(s, 200, 400);
    s.write(USER + "\r\n");
    await drain(s, 200, Math.min(1200, rem()));
    s.write(PASS + "\r\n");
    const login = await drain(s, 250, Math.min(2000, rem()));
    if (!/[$#>]\s*$/.test(login.trim().slice(-4)))
      throw new Error("login telnet ditolak (" + USER + ")");
    const cfgText = await command(s, "sidbg 1 DB p " + CFG_TABLE, rem);
    const pskText = await command(s, "sidbg 1 DB p " + PSK_TABLE, rem);
    s.write("exit\r\n");
    const entries = parse({ cfg: cfgText, psk: pskText });
    if (!entries.length) throw new Error("tabel WLAN tidak terbaca (sidbg?)");
    return entries;
  } finally {
    s.destroy();
  }
}

function get(args, callback) {
  const ip = args && args[0];
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || "")))
    return callback(new Error("IP ONT tidak valid"));
  const t = Math.max(500, Math.min(Number(args[1]) || 6000, 6000));
  readWlan(ip, t)
    .then((entries) => callback(null, JSON.stringify({ entries: entries })))
    .catch((err) => callback(err));
}

module.exports = { get, readWlan };
