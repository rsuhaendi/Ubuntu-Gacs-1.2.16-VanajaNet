// Helper bersama untuk membaca & menambal running-config ONT VSOL (boaform) dari
// GenieACS ext. Dipakai ont_captcha.js dan ont_user.js.
// Firmware V1.1.00-250829 tidak mengekspos banyak pengaturan lewat TR-069 dan tidak
// punya form web untuknya, jadi satu-satunya jalur tulis adalah upload kembali
// running-config yang nilainya sudah ditambal.
//
// Batas waktu: GENIEACS_EXT_TIMEOUT bawaan 3000 ms dan berlaku untuk seluruh
// panggilan ext, jadi semua transaksi di sini berbagi satu anggaran. Unduh config
// ~0,7 d dan upload ~1,5 d (perangkat menulis ke flash).
const http = require("http");
const net = require("net");
const fs = require("fs");

const USER = process.env.ONT_HTTP_USER || "admin";
const PASS = process.env.ONT_HTTP_PASS || "stdVSOL101";
const MAXCFG = 400000;

// Nama/sandi superadmin bisa diganti lewat UI. Tanpa penyimpanan kredensial,
// seluruh ext (RSSI, captcha, akun) langsung mati setelah itu karena masih
// memakai nilai bawaan. Berkas ini menimpa nilai env per perangkat.
const CRED_FILE = __dirname + "/files/ont_creds.json";

function credStore() {
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

function credsFor(ip) {
  const f = credStore();
  const c = f[ip] || f.default || {};
  return { user: c.user || USER, pass: c.pass || PASS };
}

// Ditulis hanya setelah perubahan kredensial benar-benar diterima perangkat.
function remember(ip, patch) {
  const f = credStore();
  const cur = f[ip] || f.default || { user: USER, pass: PASS };
  f[ip] = Object.assign({}, cur, patch);
  try {
    fs.mkdirSync(require("path").dirname(CRED_FILE), { recursive: true });
    const tmp = CRED_FILE + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(f));
    fs.renameSync(tmp, CRED_FILE);
  } catch (e) {
    /* perubahan tetap berlaku di perangkat, tinggal kredensial ext-nya perlu disetel manual */
  }
  return f[ip];
}

function budget(totalMs) {
  const t0 = Date.now();
  return (cap) => Math.max(150, Math.min(cap || 1e9, totalMs - (Date.now() - t0)));
}

function request(ip, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: ip,
        port: 80,
        method: method,
        path: path,
        timeout: timeoutMs,
        headers: body
          ? {
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": Buffer.byteLength(body),
            }
          : {},
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          data += c;
          if (data.length > MAXCFG) req.destroy();
        });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Respons boaform ada yang berkirim header normal (upload, custom_page), ada yang
// tanpa header sama sekali (unduh config, setara curl --http0.9). Perangkat juga
// tidak selalu menutup koneksi tepat waktu, jadi doneIf menyelesaikan pembacaan
// lebih dini begitu responsnya terbaca.
function rawRequest(ip, payload, timeoutMs, cap, doneIf) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: ip, port: 80 }, () => sock.write(payload));
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error("timeout")));
    sock.setEncoding("utf8");
    let raw = "";
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(raw);
      }
      sock.destroy();
    };
    sock.on("data", (c) => {
      raw += c;
      if (raw.length > cap || (doneIf && doneIf(raw))) finish();
    });
    sock.on("close", finish);
    sock.on("error", (err) => {
      if (settled) return;
      if (doneIf && doneIf(raw)) return finish();
      settled = true;
      reject(err);
    });
  });
}

function httpHead(ip, path, contentType, length) {
  return (
    `POST ${path} HTTP/1.1\r\nHost: ${ip}\r\nContent-Type: ${contentType}\r\n` +
    `Content-Length: ${length}\r\nConnection: close\r\n\r\n`
  );
}

function bodyOf(raw) {
  if (!raw || raw.slice(0, 5) !== "HTTP/") return raw || "";
  const i = raw.indexOf("\r\n\r\n");
  return i < 0 ? "" : raw.slice(i + 4);
}

function downloadConfig(ip, mask, timeoutMs) {
  const payload = "csrfMask=" + encodeURIComponent(mask);
  return rawRequest(
    ip,
    httpHead(ip, "/boaform/getASPdata/formMgmConfig", "application/x-www-form-urlencoded",
      Buffer.byteLength(payload)) + payload,
    timeoutMs,
    MAXCFG
  );
}

function uploadConfig(ip, xml, timeoutMs) {
  const b = "genieacs";
  const body =
    `--${b}\r\nContent-Disposition: form-data; name="binary"; filename="romfile.xml"\r\n` +
    `Content-Type: application/xml\r\n\r\n${xml}\r\n--${b}--\r\n`;
  return rawRequest(
    ip,
    httpHead(ip, "/boaform/getASPdata/formMgmConfigUpload", "multipart/form-data; boundary=" + b,
      Buffer.byteLength(body)) + body,
    timeoutMs,
    4000,
    (raw) => /success|failed|<HTML/i.test(bodyOf(raw))
  );
}

function flag(xml, name) {
  const m = xml.match(new RegExp('Name="' + name + '"\\s+Value="([^"]*)"'));
  return m ? m[1] : null;
}

function parseFlags(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

// custom_page berisi flag CF_* dan bisa dibaca tanpa login, jadi tidak memakan
// slot admin (CF_MAX_ADMIN_NUM=1) yang dipakai teknisi.
function readFlags(ip, timeoutMs) {
  return request(ip, "GET", "/boaform/getASPdata/custom_page", null, timeoutMs)
    .then((res) => parseFlags(res.body));
}

function loginAs(ip, user, pass, timeoutMs) {
  return request(ip, "POST", "/boaform/admin/formLogin",
    "username=" + encodeURIComponent(user) + "&password=" + encodeURIComponent(pass), timeoutMs)
    .then(assertLogin);
}

function login(ip, timeoutMs, cred) {
  const c = cred || credsFor(ip);
  return loginAs(ip, c.user, c.pass, timeoutMs);
}

// Login yang gagal membuat web login ONT dikunci sementara (LOGINED_ERROR_3=<sisa
// detik>), jadi bedakan "kredensial salah" dari "sedang dikunci" di pesan fault.
function assertLogin(res) {
  if (res.status === 302) return res;
  const body = bodyOf(res.body || "");
  const m = body.match(/LOGINED_ERROR(?:_\d+)?=?(\d*)/);
  if (m) {
    const left = Number(m[1]);
    throw new Error("login boaform ditolak" + (isFinite(left) && left > 0 ? ", login dikunci " + left + " detik lagi" : ""));
  }
  throw new Error("login boaform gagal (http " + res.status + (body ? "): " + body.slice(0, 40) : ", kredensial salah)"));
}

// Sesi harus dilepas sebelum ext memanggil balik: proses ext langsung berhenti
// setelah callback, jadi fire-and-forget sering tidak sempat terkirim.
async function logout(ip, timeoutMs) {
  try {
    await request(ip, "POST", "/boaform/admin/formLogout", "", timeoutMs);
  } catch (e) {
    /* sesi akan kedaluwarsa sendiri */
  }
}

// Nilai masuk ke atribut XML, jadi karakter yang bisa merusak markup atau menyisipkan
// elemen lain ditolak.
function assertSafeValue(v) {
  const s = String(v);
  if (/["&<>]|\p{C}/u.test(s)) throw new Error("nilai memuat karakter yang tidak didukung: " + s.slice(0, 20));
  if (s.length > 64) throw new Error("nilai terlalu panjang (maks 64)");
  return s;
}

function setValue(xml, name, value) {
  const re = new RegExp('(Name="' + name + '"\\s+Value=")[^"]*(")');
  if (!re.test(xml)) throw new Error(name + " tidak ada di running-config");
  return xml.replace(re, "$1" + assertSafeValue(value) + "$2");
}

// edits: [{name, value}]. Upload selalu mengirim seluruh config hasil tambal,
// jadi tidak ada risiko bagian lain kembali ke default.
async function patchKeys(ip, edits, totalMs, verify, cred) {
  const rem = budget(totalMs);
  await login(ip, rem(), cred);
  let res = "";
  let uploadErr = null;
  try {
    const mask = (await request(ip, "GET", "/boaform/getASPdata/FMask", null, rem())).body.trim();
    let xml = await downloadConfig(ip, mask, rem());
    for (const e of edits) {
      if (flag(xml, e.name) === null) throw new Error(e.name + " tidak ada di running-config");
    }
    for (const e of edits) xml = setValue(xml, e.name, e.value);
    try {
      res = await uploadConfig(ip, xml, rem(3000));
    } catch (err) {
      uploadErr = err;
    }
  } finally {
    await logout(ip, Math.min(300, rem()));
  }

  if (bodyOf(res).indexOf("success") >= 0) return "OK";

  // Config bisa sudah diterapkan walau responsnya tidak sempat terbaca.
  if (verify) {
    const applied = await verify(ip, Math.min(500, rem())).catch(() => null);
    if (applied && edits.every((e) => String(applied[e.name]) === String(e.value))) return "OK";
  }
  throw uploadErr || new Error("upload config ditolak: " + (bodyOf(res).slice(0, 80) || "respon kosong"));
}

module.exports = {
  USER,
  PASS,
  budget,
  request,
  bodyOf,
  downloadConfig,
  uploadConfig,
  flag,
  readFlags,
  credsFor,
  remember,
  login,
  loginAs,
  assertLogin,
  logout,
  patchKeys,
  assertSafeValue,
};
