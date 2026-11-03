// EXT: baca & ganti akun login web "normal user" pada ONT VSOL (boaform).
// Firmware V1.1.00-250829 tidak mengekspos akun web lewat TR-069, jadi nilai
// USER_NAME/USER_PASSWORD dibaca dari running-config dan perubahannya dilakukan
// dengan login sebagai akun itu lalu POST new_formPasswordSetup.
//   ext("ont_user", "get", <ipOnt>, [timeoutMs])
//     -> {"userName":"user","userPass":"user","adminName":"admin","adminPass":"..."}
//   ext("ont_user", "setPass", <ipOnt>, <passBaru>, <passLama>, [timeoutMs])
//     -> "OK" | pesan error perangkat
const http = require("http");
const net = require("net");

const ADMIN_USER = process.env.ONT_HTTP_USER || "admin";
const ADMIN_PASS = process.env.ONT_HTTP_PASS || "stdVSOL101";

function request(ip, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: ip,
        port: 80,
        method: method,
        path: path,
        headers: body
          ? {
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": Buffer.byteLength(body),
            }
          : {},
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          data += c;
          if (data.length > 400000) req.destroy();
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

// Respons formMgmConfig tidak punya header HTTP sama sekali, jadi harus dibaca
// mentah (setara "curl --http0.9").
function downloadConfig(ip, mask, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: ip, port: 80 }, () => {
      const payload = "csrfMask=" + encodeURIComponent(mask);
      sock.write(
        "POST /boaform/getASPdata/formMgmConfig HTTP/1.1\r\n" +
          "Host: " + ip + "\r\n" +
          "Content-Type: application/x-www-form-urlencoded\r\n" +
          "Content-Length: " + Buffer.byteLength(payload) + "\r\n" +
          "Connection: close\r\n\r\n" + payload
      );
    });
    let raw = "";
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error("timeout")));
    sock.setEncoding("utf8");
    sock.on("data", (c) => {
      raw += c;
      if (raw.length > 2000000) sock.destroy();
    });
    sock.on("close", () => resolve(raw));
    sock.on("error", reject);
  });
}

function value(xml, name) {
  const m = xml.match(new RegExp('Name="' + name + '"\\s+Value="([^"]*)"'));
  return m ? m[1] : "";
}

async function readAccounts(ip, t) {
  await request(ip, "POST", "/boaform/admin/formLogin",
    "username=" + encodeURIComponent(ADMIN_USER) + "&password=" + encodeURIComponent(ADMIN_PASS), t);
  const mask = (await request(ip, "GET", "/boaform/getASPdata/FMask", null, t)).body.trim();
  const xml = await downloadConfig(ip, mask, t);
  if (xml.indexOf("USER_NAME") < 0) throw new Error("running-config tidak terbaca");
  // Slot admin cuma satu (CF_MAX_ADMIN_NUM=1); jangan ditinggal.
  request(ip, "POST", "/boaform/admin/formLogout", "", t).catch(() => {});
  return {
    userName: value(xml, "USER_NAME"),
    userPass: value(xml, "USER_PASSWORD"),
    adminName: value(xml, "SUSER_NAME"),
    adminPass: value(xml, "SUSER_PASSWORD"),
  };
}

async function changeUserPass(ip, userName, oldPass, newPass, t) {
  await request(ip, "POST", "/boaform/admin/formLogin",
    "username=" + encodeURIComponent(userName) + "&password=" + encodeURIComponent(oldPass), t);
  const mask = (await request(ip, "GET", "/boaform/getASPdata/FMask", null, t)).body.trim();
  const res = await request(ip, "POST", "/boaform/getASPdata/new_formPasswordSetup",
    "oldPasswd=" + encodeURIComponent(oldPass) +
    "&newPasswd=" + encodeURIComponent(newPass) +
    "&affirmPasswd=" + encodeURIComponent(newPass) +
    "&csrfMask=" + encodeURIComponent(mask), t);
  request(ip, "POST", "/boaform/admin/formLogout", "", t).catch(() => {});
  const b = res.body || "";
  if (b.indexOf("Successs") >= 0) return "OK";
  if (b.indexOf("LANG_ERROR_INPUT_OLD_USER_PASSWORD_ERROR") >= 0) return "Password lama salah";
  if (b.indexOf("LANG_PSWD_IS_INVALID") >= 0) return "Password baru tidak valid (min 6 karakter, kombinasi huruf+angka/simbol)";
  if (b.indexOf("LANG_PSWD_SHOULD_NOT_BE_SAME") >= 0) return "Password baru tidak boleh sama dengan yang lama";
  return "Gagal: " + (b.slice(0, 120) || "respon kosong (http " + res.status + ")");
}

function get(args, callback) {
  const ip = args[0];
  if (!ip) return callback(new Error("IP ONT tidak diberikan"));
  const t = Math.min(Number(args[1]) || 900, 2500);
  readAccounts(ip, t)
    .then((a) => callback(null, JSON.stringify(a)))
    .catch((err) => callback(err));
}

function setPass(args, callback) {
  const ip = args[0];
  const newPass = args[1];
  let oldPass = args[2];
  if (!ip) return callback(new Error("IP ONT tidak diberikan"));
  if (!newPass) return callback(new Error("Password baru kosong"));
  const t = Math.min(Number(args[3]) || 900, 2500);

  const run = async () => {
    let userName = "user";
    if (!oldPass) {
      const a = await readAccounts(ip, t);
      userName = a.userName;
      oldPass = a.userPass;
    }
    return changeUserPass(ip, userName, oldPass, newPass, t);
  };

  run().then((msg) => callback(null, msg)).catch((err) => callback(err));
}

module.exports = { get, setPass };
