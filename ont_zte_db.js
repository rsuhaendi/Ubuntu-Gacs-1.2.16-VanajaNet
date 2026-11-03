// Akun web ONT ZTE (CL601): baca/tulis lewat shell telnet + "sidbg 1 DB p/set".
// ZTE tidak mengekspos akun web level-normal lewat TR-069; DevAuthInfo menyimpan
// User/Pass/Level (1 = normal, 2 = superadmin) dan hanya bisa dibaca dari shell.
//
// Nama file ini baru (bukan editan ont_zte.js) dengan sengaja: genieacs menyimpan
// modul ext per proses worker, jadi fungsi tambahan di ont_zte.js tidak terlihat oleh
// worker yang sudah terlanjur me-load versi lama ("No such function 'setAccount'").
// Kredit shell dari env ZTE_TELNET_USER/PASS/PORT, fallback pasangan CT-COM standar
// yang juga tersimpan di DeviceInfo.X_CT-COM_ServiceManage.
const net = require("net");

const USER = process.env.ZTE_TELNET_USER || "teluser";
const PASS = process.env.ZTE_TELNET_PASS || "teluser123";
const PORT = Number(process.env.ZTE_TELNET_PORT || 23);

const AUTH_TABLE = "DevAuthInfo";
const WEB_APPID = "1"; // baris DevAuthInfo milik web
const LEVEL = { normal: "1", super: "2" };

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

// Batas waktu total dilanggar = ext dianggap gagal oleh genieacs, jadi setiap
// perintah cuma boleh menghabiskan sisa anggaran.
function budget(totalMs) {
  const t0 = Date.now();
  return (cap) => Math.max(150, Math.min(cap || 1e9, totalMs - (Date.now() - t0)));
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

function rowNum(row) {
  const m = row.match(/^No="(\d+)"/);
  return m ? Number(m[1]) : -1;
}

function parseAccounts(text) {
  const start = text.indexOf('<Tbl name="' + AUTH_TABLE + '"');
  if (start < 0) return {};
  const end = text.indexOf("</Tbl>", start);
  const rows = text.slice(start, end < 0 ? text.length : end).split("<Row ").slice(1);
  const out = {};
  for (const row of rows) {
    if (attr(row, "AppID") !== WEB_APPID) continue;
    const level = attr(row, "Level");
    const who = level === LEVEL.normal ? "normal" : level === LEVEL.super ? "super" : "";
    if (!who) continue;
    out[who] = {
      row: rowNum(row),
      user: attr(row, "User"),
      pass: attr(row, "Pass"),
      enable: attr(row, "Enable") === "1",
    };
  }
  return out;
}

// Nilai diketik operator dan dikirim ke shell, jadi karakter shell tidak boleh lolos:
// tanpa spasi, tanpa ; | & < > ` $ " ' \ dan tanpa glob.
function assertSafeAccount(v, kind) {
  const s = String(v);
  const re = kind === "user"
    ? /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,31}$/
    : /^[A-Za-z0-9!@#$%^_+=.:,?~-]{1,64}$/;
  if (!re.test(s))
    throw new Error(kind === "user"
      ? "nama akun: 1-32 karakter huruf/angka (. _ @ -)"
      : "password: 1-64 karakter, tanpa spasi dan karakter shell");
  return s;
}

async function readAccounts(ip, totalMs) {
  const rem = budget(totalMs);
  const sh = await shell(ip, rem);
  try {
    const a = parseAccounts(await sh.run("sidbg 1 DB p " + AUTH_TABLE));
    if (!a.normal && !a.super) throw new Error("tabel akun web tidak terbaca (DevAuthInfo?)");
    return a;
  } finally {
    sh.close();
  }
}

// "sidbg 1 DB set" membalas dengan tabel hasilnya, jadi balasan itu sekaligus
// verifikasinya. Perubahan hanya hidup di RAM db sampai "sidbg 1 DB save".
async function writeAccount(ip, who, field, value, totalMs) {
  const rem = budget(totalMs);
  const sh = await shell(ip, rem);
  const dm = field === "user" ? "User" : "Pass";
  try {
    const a = parseAccounts(await sh.run("sidbg 1 DB p " + AUTH_TABLE));
    const acct = a[who];
    if (!acct || acct.row < 0) throw new Error("akun " + who + " tidak ada di DevAuthInfo");
    const after = parseAccounts(await sh.run("sidbg 1 DB set " + AUTH_TABLE + " " + acct.row + " " + dm + " " + value));
    if (!after[who] || after[who][field] !== value)
      throw new Error("perubahan tidak diterima DB (" + (after[who] ? after[who][field] : "baris hilang") + ")");
    const saved = (await sh.run("sidbg 1 DB save")).trim();
    if (/fail|error|invalid/i.test(saved))
      throw new Error("gagal menyimpan DB: " + saved.slice(0, 60));
    return true;
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

function account(args, callback) {
  try {
    readAccounts(ipOf(args), timeoutOf(args[1]))
      .then((a) => callback(null, JSON.stringify(a)))
      .catch((err) => callback(err));
  } catch (err) {
    callback(err);
  }
}

function setAccount(args, callback) {
  let ip, who, field, value, t;
  try {
    ip = ipOf(args);
    who = String(args[1]);
    field = String(args[2]);
    value = assertSafeAccount(args[3] === undefined ? "" : args[3], field);
    t = timeoutOf(args[4]);
    if (!LEVEL[who]) throw new Error("akun harus normal atau super");
    if (field !== "user" && field !== "pass") throw new Error("field harus user atau pass");
  } catch (err) {
    return callback(err);
  }
  writeAccount(ip, who, field, value, t)
    .then(() => callback(null, "OK"))
    .catch((err) => callback(err));
}

module.exports = { account, setAccount, readAccounts, writeAccount };
