// EXT: akun login web ONT HK719 (firmware ZTE boaform, session berbasis IP).
// Tidak menggunakan cookie — server HK719 mengenali sesi dari IP sumber.
//
//   ext("ont_hk719", "get",     <ipOnt>, [timeoutMs])
//     -> {"adminName":"admin","adminPass":"admin","userName":"useradmin","userPass":"admin"}
//        adminPass/userPass diambil dari ont_creds.json (password terakhir yang diketahui).
//        Nilai "***" hanya muncul jika password belum pernah disimpan sebelumnya.
//
//   ext("ont_hk719", "setPass", <ipOnt>, <"admin"|"user">, <passBaru>, [timeoutMs])
//     -> "OK" | pesan error
//
//   ext("ont_hk719", "setName", <ipOnt>, <"admin"|"user">, <namaBaru>, [timeoutMs])
//     -> "OK" | pesan error
//
// Kredensial login disimpan di files/ont_creds.json (kunci "hk719_<ip>").
// Default: admin / admin

const http = require("http");
const fs   = require("fs");
const path = require("path");

const DEFAULT_USER = process.env.HK719_USER || "admin";
const DEFAULT_PASS = process.env.HK719_PASS || "admin";
const MAXBODY = 200000;
const CRED_FILE = path.join(__dirname, "files", "ont_creds.json");

// ---------- kredensial per-IP ----------
function credStore() {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, "utf8")) || {}; } catch (e) { return {}; }
}
function credsFor(ip) {
  const f = credStore();
  const c = f["hk719_" + ip] || f["hk719_default"] || {};
  return {
    user:     c.user     || DEFAULT_USER,
    pass:     c.pass     || DEFAULT_PASS,
    userUser: c.userUser || null,   // username akun normal (right=2)
    userPass: c.userPass || null,   // password akun normal terakhir yang diketahui
  };
}
function remember(ip, patch) {
  const f = credStore();
  const cur = f["hk719_" + ip] || { user: DEFAULT_USER, pass: DEFAULT_PASS };
  f["hk719_" + ip] = Object.assign({}, cur, patch);
  try {
    fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
    const tmp = CRED_FILE + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(f));
    fs.renameSync(tmp, CRED_FILE);
  } catch (e) { /* non-fatal */ }
}

// ---------- budget ----------
function budget(totalMs) {
  const t0 = Date.now();
  return (cap) => Math.max(150, Math.min(cap || 1e9, totalMs - (Date.now() - t0)));
}

// ---------- HTTP helper (tanpa cookie — HK719 pakai session berbasis IP) ----------
function request(ip, method, reqPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = http.request(
      { host: ip, port: 80, method, path: reqPath, timeout: timeoutMs, headers },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; if (data.length > MAXBODY) req.destroy(); });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("HTTP timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

// Ambil nilai dari Transfer_meaning('key','value') di halaman
function extract(html, key) {
  const re = new RegExp("Transfer_meaning\\('" + key + "','((?:[^'\\\\]|\\\\.)*)'\\)");
  const m = html.match(re);
  if (!m) return null;
  return m[1].replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

const ACCOUNT_PAGE = "/getpage.gch?pid=1002&nextpage=manager_aduser_conf_t.gch";

// ---------- logout — selalu dipanggil setelah operasi selesai ----------
// Tanpa logout, sesi terkunci di IP server dan client tidak bisa masuk ke ONT.
async function logout(ip) {
  try {
    await request(ip, "POST", "/", "logout=1&logout_from=login_timeout", 3000);
  } catch (e) { /* non-fatal */ }
}

// ---------- login ----------
async function login(ip, user, pass, rem) {
  // Frm_Logintoken=1 memberitahu ONT untuk paksa ambil alih sesi
  // yang sedang aktif dari IP lain (perilaku dosubmit() di halaman login).
  const res = await request(ip, "POST", "/",
    "username=" + encodeURIComponent(user) +
    "&Password=" + encodeURIComponent(pass) +
    "&Frm_Logintoken=1&frashnum=&_lang=&action=login",
    rem());
  // Firmware lama redirect (302), firmware baru balas 200 langsung.
  // Login dianggap GAGAL jika halaman login muncul lagi (ada form action=login).
  const loginFailed =
    res.status !== 302 &&
    !(res.status === 200 && res.body.indexOf("action=login") === -1);
  if (loginFailed)
    throw new Error("Login gagal, cek username/password (HTTP " + res.status + ")");
}

// ---------- ambil halaman akun ----------
async function fetchAccountPage(ip, rem) {
  const res = await request(ip, "GET", ACCOUNT_PAGE, null, rem());
  if (res.status !== 200) throw new Error("Halaman akun tidak bisa diakses (HTTP " + res.status + ")");
  if (res.body.indexOf("IF_ERRORSTR") < 0)
    throw new Error("Sesi tidak valid atau halaman tidak dikenal");
  return res.body;
}

function getSessionToken(html) {
  const m = html.match(/var\s+session_token\s*=\s*"([^"]+)"/);
  return m ? m[1] : "";
}

function parseAccounts(html) {
  const accounts = [];
  for (let i = 0; i <= 9; i++) {
    const uname = extract(html, "Username" + i);
    if (uname === null) break;
    const right  = extract(html, "Right"  + i) || "";
    const enable = extract(html, "Enable" + i) || "0";
    const type   = extract(html, "Type"   + i) || "1";
    accounts.push({ index: i, username: uname, right, enable, type });
  }
  return accounts;
}

// ---------- fungsi utama ----------
async function doGet(ip, t) {
  const rem = budget(t);
  const creds = credsFor(ip);
  await login(ip, creds.user, creds.pass, rem);
  try {
    const html = await fetchAccountPage(ip, rem);
    const accounts = parseAccounts(html);

    let adminName = "", userName = "";
    for (const a of accounts) {
      if (a.right === "1" && !adminName) adminName = a.username;
      if (a.right === "2" && !userName)  userName  = a.username;
    }

    // Password diambil dari ont_creds.json — ONT tidak pernah mengekspos password asli.
    // creds.pass  = password admin (dipakai untuk login, jadi selalu terketahui).
    // creds.userPass = password user terakhir yang pernah di-set lewat GenieACS.
    const adminPass = creds.pass;
    const userPass  = creds.userPass || "***";

    // Simpan username terbaru dari ONT ke creds agar konsisten
    remember(ip, { user: adminName || creds.user, userUser: userName || creds.userUser });

    return JSON.stringify({ adminName, adminPass, userName, userPass });
  } finally {
    await logout(ip);
  }
}

async function doSetPass(ip, who, newPass, t) {
  const rem = budget(t);
  const creds = credsFor(ip);
  await login(ip, creds.user, creds.pass, rem);
  try {
    const html = await fetchAccountPage(ip, rem);
    const token = getSessionToken(html);
    const accounts = parseAccounts(html);

    const targetRight = who === "admin" ? "1" : "2";
    const acct = accounts.find(a => a.right === targetRight && a.username);
    if (!acct) throw new Error("Akun " + who + " tidak ditemukan di halaman ONT");

    const body =
      "IF_ACTION=apply&IF_INDEX=" + acct.index +
      "&Type=" + encodeURIComponent(acct.type) +
      "&Enable=" + encodeURIComponent(acct.enable) +
      "&Right=" + encodeURIComponent(acct.right) +
      "&Username=" + encodeURIComponent(acct.username) +
      "&Password=" + encodeURIComponent(newPass) +
      "&OldPassword=" + encodeURIComponent(creds.pass) +
      "&Frm_Username=" + encodeURIComponent(acct.username) +
      "&Frm_OldPassword=" + encodeURIComponent(creds.pass) +
      "&Frm_Password=" + encodeURIComponent(newPass) +
      "&Frm_CfmPassword=" + encodeURIComponent(newPass) +
      "&_SESSION_TOKEN=" + encodeURIComponent(token);

    const res = await request(ip, "POST", ACCOUNT_PAGE, body, rem());
    if (res.status !== 200) throw new Error("Submit gagal (HTTP " + res.status + ")");

    const errStr = extract(res.body, "IF_ERRORSTR") || "";
    if (errStr !== "SUCC") throw new Error("ONT menolak: " + errStr);

    if (who === "admin") remember(ip, { user: acct.username, pass: newPass });
    if (who === "user")  remember(ip, { userUser: acct.username, userPass: newPass });
    return "OK";
  } finally {
    await logout(ip);
  }
}

async function doSetName(ip, who, newName, t) {
  const rem = budget(t);
  const creds = credsFor(ip);
  await login(ip, creds.user, creds.pass, rem);
  try {
    const html = await fetchAccountPage(ip, rem);
    const token = getSessionToken(html);
    const accounts = parseAccounts(html);

    const targetRight = who === "admin" ? "1" : "2";
    const acct = accounts.find(a => a.right === targetRight && a.username);
    if (!acct) throw new Error("Akun " + who + " tidak ditemukan di halaman ONT");

    // Ganti username saja — Password dikosongkan agar ONT tidak mengubah password
    const body =
      "IF_ACTION=apply&IF_INDEX=" + acct.index +
      "&Type=" + encodeURIComponent(acct.type) +
      "&Enable=" + encodeURIComponent(acct.enable) +
      "&Right=" + encodeURIComponent(acct.right) +
      "&Username=" + encodeURIComponent(newName) +
      "&Password=&OldPassword=" +
      "&Frm_Username=" + encodeURIComponent(newName) +
      "&Frm_OldPassword=&Frm_Password=&Frm_CfmPassword=" +
      "&_SESSION_TOKEN=" + encodeURIComponent(token);

    const res = await request(ip, "POST", ACCOUNT_PAGE, body, rem());
    if (res.status !== 200) throw new Error("Submit gagal (HTTP " + res.status + ")");

    const errStr = extract(res.body, "IF_ERRORSTR") || "";
    if (errStr !== "SUCC") throw new Error("ONT menolak: " + errStr);

    if (who === "admin") remember(ip, { user: newName });
    return "OK";
  } finally {
    await logout(ip);
  }
}

// ---------- entry points GenieACS ext ----------
function get(args, callback) {
  const ip = args && args[0];
  if (!ip) return callback(new Error("IP ONT tidak diberikan"));
  doGet(ip, Math.min(Number(args[1]) || 5000, 5000))
    .then(r => callback(null, r)).catch(err => callback(err));
}

function setPass(args, callback) {
  const ip = args && args[0];
  const who = args && args[1];
  const newPass = args && String(args[2] || "").trim();
  if (!ip) return callback(new Error("IP ONT tidak diberikan"));
  if (who !== "admin" && who !== "user") return callback(new Error("who harus 'admin' atau 'user'"));
  if (!newPass) return callback(new Error("Password baru kosong"));
  doSetPass(ip, who, newPass, Math.min(Number(args[3]) || 6000, 6000))
    .then(r => callback(null, r)).catch(err => callback(err));
}

function setName(args, callback) {
  const ip = args && args[0];
  const who = args && args[1];
  const newName = args && String(args[2] || "").trim();
  if (!ip) return callback(new Error("IP ONT tidak diberikan"));
  if (who !== "admin" && who !== "user") return callback(new Error("who harus 'admin' atau 'user'"));
  if (!newName) return callback(new Error("Nama baru kosong"));
  doSetName(ip, who, newName, Math.min(Number(args[3]) || 3000, 3000))
    .then(r => callback(null, r)).catch(err => callback(err));
}

module.exports = { get, setPass, setName };
