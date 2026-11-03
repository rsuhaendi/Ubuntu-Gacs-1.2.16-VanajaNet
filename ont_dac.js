// EXT: akun login web ONT VSOL V2802DAC (boaform + ASP, firmware SCALPHY).
//   ext("ont_dac", "get", <ipOnt>, [timeoutMs])
//     -> {"userName":"user","userPass":"...","adminName":"admin","adminPass":"...",
//         "captcha":"1"}
//   ext("ont_dac", "setPass", <ipOnt>, <user|admin>, <passBaru>, [passLama], [timeoutMs])
//     -> "OK" | pesan error
//
// Beda dengan V2801RGW (ont_account.js) pada tiga titik:
//   1. Form login memakai field "psd" plus kode verifikasi dan csrftoken yang
//      di-render server di /admin/login.asp, bukan "password" polos.
//   2. Running-config dibaca lewat POST /boaform/admin/formMgmConfig
//      action=saveconfigfile (RGW: /boaform/getASPdata/formMgmConfig + FMask).
//   3. Username dan flag WEB_VERIFICATION_CODE_ENABLE tidak punya form sendiri;
//      satu-satunya jalur tulis adalah upload running-config, dan halaman
//      mgm_config_file.asp menyatakan perangkat reboot setelah upload. Keduanya
//      karena itu read-only di sini.
//
// File baru, bukan perubahan ont_config.js: GenieACS meng-cache modul ext per
// proses, jadi file baru langsung terpakai tanpa restart ACS.
const cfg = require("./ont_config.js");
const net = require("net");

// Unduh running-config dikirim perangkat tanpa header HTTP yang bisa dipahami
// parser Node (sama seperti di ont_config.js), jadi lewat socket mentah.
// rawRequest tidak diekspor dari sana dan ont_config.js tidak boleh diubah di
// sini karena proses ext yang sudah jalan memegang versi lamanya.
function rawPost(ip, path, payload, timeoutMs, doneIf) {
  return new Promise((resolve, reject) => {
    const head =
      `POST ${path} HTTP/1.1\r\nHost: ${ip}\r\n` +
      `Content-Type: application/x-www-form-urlencoded\r\n` +
      `Content-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n`;
    const sock = net.connect({ host: ip, port: 80 }, () => sock.write(head + payload));
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error("timeout")));
    sock.setEncoding("binary");
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
      if (raw.length > 400000 || (doneIf && doneIf(raw))) finish();
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

const WHO = {
  user: { nameKey: "USER_NAME", passKey: "USER_PASSWORD", label: "normal user" },
  admin: { nameKey: "SUSER_NAME", passKey: "SUSER_PASSWORD", label: "superadmin" },
};

// Caller boleh memperkecil anggaran, tidak boleh memperbesar.
const limit = (v, dflt) => {
  const max = dflt || 2800;
  return Math.max(400, Math.min(Number(v) || max, max));
};

const enc = encodeURIComponent;

// Satu halaman superadmin membaca VP yang sama berkali-kali; unduh config
// ~300 ms jadi tidak perlu diulang dalam rentang pendek. Setiap jalur tulis
// membuang isian ini sebelum verifikasi.
const MEMO_MS = 5000;
const memo = {};

function tokenOf(text) {
  const m = String(text || "").match(/name=['"]csrftoken['"] value=['"]([^'"]*)['"]/);
  if (!m) throw new Error("csrftoken tidak terbaca dari halaman ONT");
  return m[1];
}

function codeOf(text) {
  const m = String(text || "").match(/check_code'\)\.value='([^']*)'/);
  return m ? m[1] : "";
}

// Sesi boaform perangkat ini terikat IP sumber dan tidak memakai cookie, dan
// hanya ada satu sesi admin (MAX_ADMIN_NUM=1). Kalau teknisi sedang membuka web
// ONT, formLogin menolak dengan 200; untuk jalur baca boleh menumpang sesi yang
// sudah ada, asalkan sesi itu tidak kita logout.
async function openSession(ip, rem) {
  const c = cfg.credsFor(ip);
  try {
    await loginAs(ip, c.user, c.pass, rem());
    return { owned: true };
  } catch (err) {
    const probe = await cfg
      .request(ip, "GET", "/mgm_config_file.asp", null, rem())
      .catch(() => null);
    if (probe && probe.status === 200 && /name=['"]csrftoken['"]/.test(probe.body))
      return { owned: false };
    throw err;
  }
}

function closeSession(ip, rem, s) {
  return s.owned ? cfg.logout(ip, Math.min(300, rem())) : Promise.resolve();
}

function loginAs(ip, user, pass, timeoutMs) {
  return cfg
    .request(ip, "GET", "/admin/login.asp", null, timeoutMs)
    .then((res) =>
      cfg.request(
        ip,
        "POST",
        "/boaform/admin/formLogin",
        "username=" + enc(user) + "&psd=" + enc(pass) + "&sec_lang=0" +
          "&loginSelinit=0&ismobile=0&check_code=" + enc(codeOf(res.body)) +
          "&verification_code=" + enc(codeOf(res.body)) +
          "&csrftoken=" + enc(tokenOf(res.body)),
        timeoutMs
      )
    )
    .then(cfg.assertLogin);
}

function downloadConfig(ip, timeoutMs) {
  return cfg
    .request(ip, "GET", "/mgm_config_file.asp", null, timeoutMs)
    .then((res) => {
      const token = tokenOf(res.body);
      const payload = "action=saveconfigfile&submit-url=&csrftoken=" + enc(token);
      return rawPost(ip, "/boaform/admin/formMgmConfig", payload, timeoutMs, (raw) =>
        /<\/Config>/.test(raw)
      );
    })
    .then((raw) => {
      const xml = Buffer.from(bodyOfRaw(raw), "binary").toString("utf8");
      if (xml.indexOf("<Config") < 0)
        throw new Error(
          "running-config tidak terbaca" +
            (/404/.test(xml) ? " (sesi boaform tidak diterima perangkat)" : "")
        );
      return xml;
    });
}

// Header respons perangkat ini ada yang berkiri \\n saja, tidak selalu \\r\\n,
// jadi pemisah header/body dicari dalam kedua bentuk.
function bodyOfRaw(raw) {
  if (!raw || raw.slice(0, 5) !== "HTTP/") return raw || "";
  let i = raw.indexOf("\r\n\r\n");
  if (i >= 0) return raw.slice(i + 4);
  i = raw.indexOf("\n\n");
  return i < 0 ? "" : raw.slice(i + 2);
}

function readConfig(ip, rem) {
  const m = memo[ip];
  if (m && Date.now() - m.at < MEMO_MS) return Promise.resolve(m.xml);
  return openSession(ip, rem)
    .then((s) =>
      downloadConfig(ip, rem())
        .then((xml) =>
          closeSession(ip, rem, s).then(() => {
            memo[ip] = { at: Date.now(), xml: xml };
            return xml;
          })
        )
        .catch((err) => closeSession(ip, rem, s).then(() => { throw err; }))
    );
}

function accounts(xml) {
  return {
    userName: cfg.flag(xml, "USER_NAME") || "",
    userPass: cfg.flag(xml, "USER_PASSWORD") || "",
    adminName: cfg.flag(xml, "SUSER_NAME") || "",
    adminPass: cfg.flag(xml, "SUSER_PASSWORD") || "",
    captcha: cfg.flag(xml, "WEB_VERIFICATION_CODE_ENABLE") || "",
  };
}

// Yang diubah formPasswordSetup adalah akun yang sedang login (baris "Select
// User" hanya muncul saat MULTI_USER_EN=1), jadi password normal user diganti
// dengan membuka sesi sebagai normal user itu. Password dikirim dalam base64
// persis seperti encode64() di halaman ONT.
// Di jalur tulis tidak ada penumpangan sesi: login harus atas nama akun target.
function changePass(ip, loginName, oldPass, newPass, rem) {
  return loginAs(ip, loginName, oldPass, rem())
    .catch((err) => {
      throw new Error("login dengan password lama gagal (" + err.message + ")");
    })
    .then(() =>
      cfg
        .request(ip, "GET", "/mgm_usr_user.asp", null, rem())
        .then((res) => {
          const b64 = (v) => Buffer.from(String(v), "binary").toString("base64");
          return cfg.request(
            ip,
            "POST",
            "/boaform/admin/formPasswordSetup",
            "oldUserName=" + enc(loginName) + "&UserIdx=0" +
              "&oldPasswd=" + enc(b64(oldPass)) + "&newPasswd=" + enc(b64(newPass)) +
              "&affirmPasswd=" + enc(b64(newPass)) +
              "&submit-url=&csrftoken=" + enc(tokenOf(res.body)),
            rem()
          );
        })
        .then((res) =>
          cfg.logout(ip, Math.min(300, rem())).then(() => res.body || "")
        )
    );
}

function get(args, callback) {
  const ip = args && args[0];
  if (!ip) return callback(new Error("IP ONT tidak diberikan"));
  readConfig(ip, cfg.budget(limit(args[1], 2000)))
    .then((xml) => callback(null, JSON.stringify(accounts(xml))))
    .catch((err) => callback(err));
}

function setPass(args, callback) {
  const ip = args && args[0];
  let who, newPass, oldPass, rem;
  try {
    if (!ip) throw new Error("IP ONT tidak diberikan");
    who = args[1];
    if (!WHO[who]) throw new Error("akun harus 'user' atau 'admin'");
    newPass = String(args[2] === undefined ? "" : args[2]);
    oldPass = args[3] === undefined || args[3] === null ? "" : String(args[3]);
    rem = cfg.budget(limit(args[4], 2800));
    if (!newPass.length) throw new Error("Password baru kosong");
    if (newPass.length < 6 || newPass.length > 32)
      throw new Error("Password baru harus 6-32 karakter");
    cfg.assertSafeValue(newPass);
  } catch (err) {
    return callback(err);
  }

  // Nama akun dan password lama dibaca dari config perangkat, dan hasilnya
  // selalu diverifikasi dengan baca ulang: teks respons form bukan bukti, dan
  // perangkat menolak password yang tidak memenuhi ruleset-nya sendiri.
  const run = () =>
    readConfig(ip, rem)
      .then((before) => {
        const a = accounts(before);
        const name = who === "admin" ? a.adminName : a.userName;
        const stored = who === "admin" ? a.adminPass : a.userPass;
        const old = oldPass.length ? oldPass : stored;
        if (!name.length) throw new Error("username " + WHO[who].label + " kosong di running-config");
        if (!old.length) throw new Error("password lama " + WHO[who].label + " kosong di running-config");
        if (old === newPass) return "SAME";
        return changePass(ip, name, old, newPass, rem);
      })
      .then((res) => {
        if (res === "SAME") return "OK";
        delete memo[ip];
        const deviceMsg = String(res).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
        return readConfig(ip, rem).then((after) => {
          const a = accounts(after);
          const now = who === "admin" ? a.adminPass : a.userPass;
          if (now !== newPass)
            throw new Error(
              "password tidak berubah" + (deviceMsg ? ": " + deviceMsg : " (masih " + (now || "kosong") + ")")
            );
          if (who === "admin") cfg.remember(ip, { user: a.adminName, pass: newPass });
          return "OK";
        });
      });

  run().then((msg) => callback(null, msg)).catch((err) => callback(err));
}

module.exports = { get, setPass };
