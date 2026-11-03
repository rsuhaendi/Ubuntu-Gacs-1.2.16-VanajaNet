// EXT: baca & tulis flag captcha login web (CF_WEB_CAPTCHA) pada ONT VSOL V2801RGW.
// Firmware V1.1.00-250829 tidak mengekspos flag ini lewat TR-069 dan tidak punya
// form web untuk mengubahnya, jadi penulisannya lewat upload running-config yang
// nilainya sudah ditambal. Efeknya langsung, tanpa reboot.
//   ext("ont_captcha", "get", <ipOnt>, [timeoutMs])
//     -> {"captcha":"0","simple":"1"}   (GET custom_page, tanpa login)
//   ext("ont_captcha", "set", <ipOnt>, <0|1>, [timeoutMs])
//     -> "OK" | pesan error
// Slot admin ONT cuma satu (CF_MAX_ADMIN_NUM=1) dan sesi terikat IP sumber, jadi
// read dilakukan tanpa login dan sesi tulis selalu dilepas lagi.
const http = require("http");
const net = require("net");

const USER = process.env.ONT_HTTP_USER || "admin";
const PASS = process.env.ONT_HTTP_PASS || "stdVSOL101";
const MAXCFG = 400000;

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

// Respons formMgmConfig tidak punya header HTTP sama sekali (setara curl --http0.9),
// dan body upload multipart bisa berisi XML mentah, jadi keduanya pakai socket mentah.
// Perangkat tidak selalu menutup koneksi tepat waktu, jadi doneIf boleh menyelesaikan
// pembacaan lebih dini begitu responsnya terbaca.
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
      // Data sudah cukup tapi koneksi dipaksa tutup: anggap selesai.
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

// Respons boaform ada yang berkirim header normal, ada yang tanpa header sama sekali.
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
    // Body upload cuma "success" atau halaman error, jadi tidak perlu menunggu
    // perangkat menutup koneksi (kadang ia menahannya jauh melewati timeout).
    (raw) => /success|failed|<HTML/i.test(bodyOf(raw))
  );
}

function flag(xml, name) {
  const m = xml.match(new RegExp('Name="' + name + '"\\s+Value="([^"]*)"'));
  return m ? m[1] : null;
}

function parseFlags(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

async function readFlags(ip, t) {
  const res = await request(ip, "GET", "/boaform/getASPdata/custom_page", null, t);
  return parseFlags(res.body || "");
}

// GENIEACS_EXT_TIMEOUT bawaan 3000 ms dan tidak diubah di env, jadi seluruh
// panggilan tulis harus selesai dalam satu anggaran waktu.
function remaining(t0, totalMs) {
  return Math.max(150, totalMs - (Date.now() - t0));
}

async function logout(ip, t) {
  try {
    await request(ip, "POST", "/boaform/admin/formLogout", "", t);
  } catch (e) {
    /* sesi akan kedaluwarsa sendiri */
  }
}

async function writeFlag(ip, want, totalMs) {
  const t0 = Date.now();
  await request(ip, "POST", "/boaform/admin/formLogin",
    "username=" + encodeURIComponent(USER) + "&password=" + encodeURIComponent(PASS), remaining(t0, totalMs));
  const mask = (await request(ip, "GET", "/boaform/getASPdata/FMask", null, remaining(t0, totalMs))).body.trim();
  const xml = await downloadConfig(ip, mask, remaining(t0, totalMs));
  if (flag(xml, "CF_WEB_CAPTCHA") === null) {
    await logout(ip, Math.min(300, remaining(t0, totalMs)));
    throw new Error("running-config tidak terbaca");
  }
  const patched = xml.replace(/(Name="CF_WEB_CAPTCHA"\s+Value=")[^"]*(")/, "$1" + want + "$2");
  let res = "";
  let uploadErr = null;
  try {
    res = await uploadConfig(ip, patched, remaining(t0, totalMs));
  } catch (err) {
    uploadErr = err;
  }
  // Slot admin cuma satu dan sesi terikat IP, jadi lepas sebelum memanggil balik:
  // fire-and-forget bisa hilang karena proses ext langsung berhenti.
  await logout(ip, Math.min(300, remaining(t0, totalMs)));
  const body = bodyOf(res);
  if (body.indexOf("success") < 0) {
    // Config kadang sudah terlanjur diterapkan walau responsnya tidak sempat
    // terbaca, jadi nilai aktual yang deciding, bukan respons upload.
    const f = await readFlags(ip, Math.min(400, remaining(t0, totalMs))).catch(() => null);
    if (f && f.CF_WEB_CAPTCHA === want) return "OK";
    throw uploadErr || new Error("upload config ditolak: " + (body.slice(0, 80) || "respon kosong"));
  }
  return "OK";
}

function timeoutOf(v, dflt) {
  // Caller boleh memperkecil, tidak boleh memperbesar anggaran.
  return Math.min(Number(v) || dflt, dflt);
}

function get(args, callback) {
  const ip = args && args[0];
  if (!ip) return callback(new Error("IP ONT tidak diberikan"));
  readFlags(ip, timeoutOf(args[1], 2000))
    .then((f) => callback(null, JSON.stringify({ captcha: f.CF_WEB_CAPTCHA || "", simple: f.CF_WEB_CAPTCHA_SIMPLE || "" })))
    .catch((err) => callback(err));
}

function set(args, callback) {
  const ip = args && args[0];
  const want = args && args[1];
  if (!ip) return callback(new Error("IP ONT tidak diberikan"));
  if (want !== "0" && want !== "1") return callback(new Error("Nilai captcha harus 0 atau 1"));
  writeFlag(ip, want, timeoutOf(args[2], 2500))
    .then((msg) => callback(null, msg))
    .catch((err) => callback(err));
}

module.exports = { get, set };
