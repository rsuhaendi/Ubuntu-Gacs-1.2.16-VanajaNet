// EXT: ubah akun web ONT ZL-2113X / ZL-4224X lewat form Boa+ASP.
// STATUS: tidak dipakai lagi — VP akun ZL kembali menulis ConfigFile (ONT reboot).
// Fakta yang terbukti di 172.16.68.190: POST tanpa hidden name0/name1/name2
// dibalas signal="1" sementara nama akun tidak berubah sama sekali, jadi hasil
// "OK" dari jalur ini tidak bisa dipercaya tanpa verifikasi ke halaman akun.
// Jalur lengkap+verifikasi belum sempat diuji dengan perubahan sungguhan.
// File ini ditinggalkan sebagai catatan hasil pembalikan-rekayasa
// /cgi-bin/mag-account.asp (login Boa + form ASP), bukan sebagai kode aktif.
// Kenapa bukan lewat TR-069: semua config ONT ini ada di dalam blob
// InternetGatewayDevice.DeviceConfig.ConfigFile dan menulis balik blob itu
// membuat ONT langsung reboot. Halaman "Manage->User Management"
// (/cgi-bin/mag-account.asp) melakukan hal yang sama tanpa reboot.
//   ext("ont_zl", "set", <ipOnt>, <json>, [timeoutMs])
//     json = {"login":{"u":"superadmin","p":"..."}, "who":"super|normal",
//             "field":"user|pass", "value":"nilai baru", "cur":"password lama target"}
//     -> "OK" | melempar Error dengan pesan perangkat
// Modul baru (bukan editan ont_config/ont_account) karena GenieACS meng-cache
// modul ext per proses worker: file baru langsung terbaca, file lama butuh restart.
const http = require("http");

const LOGIN_PATH = "/cgi-bin/index2.asp";
const ACCT_PATH = "/cgi-bin/mag-account.asp";
const MENU = "Manage->User Management";

// Indeks akun yang dipakai field hidden "user" di halaman akun.
const ACCOUNT = {
  super: { idx: "0" },
  normal: { idx: "1" },
};

const limit = (v, dflt) => {
  const max = dflt || 2800;
  return Math.max(150, Math.min(Number(v) || max, max));
};

function request(ip, method, path, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ Host: ip, Connection: "close" }, headers || {});
    if (body) {
      h["Content-Type"] = "application/x-www-form-urlencoded";
      h["Content-Length"] = Buffer.byteLength(body);
    }
    const req = http.request({ host: ip, port: 80, method, path, timeout: timeoutMs, headers: h }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        data += c;
        if (data.length > 262144) req.destroy();
      });
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout menunggu " + path)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const q = (o) =>
  Object.keys(o)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(o[k] == null ? "" : o[k]))
    .join("&");

// Sesi web ONT ini dipegang oleh cookie SESSIONID yang diterbitkan Boa lewat
// respon 401, lalu UID/PSW yang ikut dikirim browser setelah login.
async function openSession(ip, login, rem) {
  const boot = await request(ip, "GET", "/", null, null, rem());
  const sc = boot.headers["set-cookie"] || [];
  const m = String(sc.join(";")).match(/SESSIONID=(boasid[0-9a-fA-F]+)/);
  if (!m) throw new Error("SESSIONID tidak diterbitkan perangkat (HTTP " + boot.status + ")");
  const sid = m[1];
  const ck = "SESSIONID=" + sid + "; UID=" + encodeURIComponent(login.u) + "; PSW=" + encodeURIComponent(login.p);
  const r = await request(ip, "POST", LOGIN_PATH, q({
    Username: login.u, Password: login.p, Password1: login.p, Password2: login.p,
    Logoff: 0, hLoginTimes: 1, value_one: 1, logintype: "usr", Language_Flag: 0,
  }), { Cookie: ck }, rem());
  // Halaman login menyisipkan userPSWST(1) kalau password diterima; (2) berarti
  // perangkat memaksa ganti password, dan tanpa sisipan sesi ditolak.
  if (/userPSWST\(1\)/.test(r.body)) return ck;
  if (/userPSWST\(2\)/.test(r.body)) throw new Error("perangkat meminta " + login.u + " mengganti passwordnya dulu");
  throw new Error("login web " + login.u + " ditolak perangkat (HTTP " + r.status + ")");
}

// GenieACS memanggil fungsi ext sebagai fn(argsArray, callback), jadi argumen
// dibaca dari array dan hasil/error diserahkan lewat callback.
function parseSpec(spec) {
  let s = spec;
  if (typeof s === "string") {
    try {
      s = JSON.parse(s);
    } catch (e) {
      throw new Error("spec dari VP bukan JSON yang sah: " + String(spec).slice(0, 60));
    }
  }
  if (!s || typeof s !== "object") throw new Error("spec dari VP tidak berupa objek");
  if (!ACCOUNT[s.who]) throw new Error("akun harus 'super' atau 'normal'");
  if (s.field !== "user" && s.field !== "pass") throw new Error("field harus 'user' atau 'pass'");
  if (!s.login || !s.login.u) throw new Error("kredensial login web tidak diberikan");
  return s;
}

// Halaman akun menyimpan nama akun yang SAH pada hidden field name0/name1/name2.
// POST tanpa ketiganya dibalas signal="1" (terlihat sukses) tapi namanya tidak
// pernah diganti — jadi form-nya dibaca dulu, baru dikirim apa adanya.
async function readForm(ip, ck, timeoutMs) {
  const r = await request(ip, "GET", ACCT_PATH, null, { Cookie: ck, Referer: "http://" + ip + ACCT_PATH }, timeoutMs);
  if (r.status !== 200) throw new Error("halaman akun menolak (HTTP " + r.status + ")");
  const names = {};
  const re = /NAME=["']?name(\d)["']?\s+VALUE=["']?([^"'>\s]*)/gi;
  let m;
  while ((m = re.exec(r.body))) names[m[1]] = m[2];
  if (!Object.keys(names).length) throw new Error("field name0/name1/name2 tidak ada di halaman akun");
  const tag = /<INPUT[^>]*Selected_Menu[^>]*>/i.exec(r.body);
  const sm = tag && /value=["']([^"']*)["']/i.exec(tag[0]);
  return { names, menu: (sm && sm[1]) || MENU, body: r.body };
}

async function changeAccount(ip, s, t) {
  const who = ACCOUNT[s.who];

  const start = Date.now();
  const rem = limit(t, 2800);
  // Anggaran dibagi berdasarkan sisa waktu, bukan persepertiga tetap: POST
  // form memakan 1,3-1,6 detik, sisanya untuk baca form + verifikasi.
  const left = () => Math.max(200, rem - (Date.now() - start));
  const ck = await openSession(ip, s.login, left);
  const form = await readForm(ip, ck, left());

  const idx = who.idx;
  const oldName = form.names[idx] || s.curName || "";
  if (s.field === "user" && s.value === oldName) return "OK";

  // oldPassword dipakai perangkat untuk memverifikasi operator; nilainya kita
  // ambil dari ConfigFile lewat TR-069 (halaman akun tidak pernah menampilkan password).
  const target = s.cur || "";
  const body = q({
    Selected_Menu: form.menu,
    name0: form.names["0"] || "",
    name1: form.names["1"] || "",
    name2: form.names["2"] || "",
    accountflg: 1,
    user: idx,
    oldUsername: oldName,
    newUsername: s.field === "user" ? s.value : oldName,
    oldPassword: target,
    newPassword: s.field === "pass" ? s.value : target,
    cfmPassword: s.field === "pass" ? s.value : target,
  });
  const r = await request(ip, "POST", ACCT_PATH, body, { Cookie: ck, Referer: "http://" + ip + ACCT_PATH }, left());
  if (r.status !== 200) throw new Error("halaman akun menolak (HTTP " + r.status + ")");
  const m2 = r.body.match(/var signal = "([^"]*)"/);
  const sig = m2 ? m2[1] : "N/A";
  if (sig === "0") throw new Error("perubahan ditolak perangkat: password lama tidak cocok atau akun " + s.who + " tidak dapat diubah lewat web");
  if (sig !== "1") throw new Error("perangkat mengembalikan error (signal=" + sig + ")");

  // Penggantian nama pernah dibalas signal="1" tanpa efek apa pun, jadi hasilnya
  // dicek ulang ke halaman akun. Password tidak bisa dibaca, hanya nama.
  if (s.field === "user") {
    const chk = await readForm(ip, ck, left());
    if (chk.names[idx] !== s.value)
      throw new Error("perangkat menerima perubahan tapi nama akun masih \"" + chk.names[idx] + "\"");
  }
  return "OK";
}

function set(args, callback) {
  const ip = args && args[0];
  let s;
  try {
    if (!ip) throw new Error("IP ONT tidak diberikan");
    s = parseSpec(args[1]);
  } catch (err) {
    return callback(err);
  }
  changeAccount(String(ip), s, args[2])
    .then((msg) => callback(null, msg))
    .catch((err) => callback(err));
}

module.exports = { set };
