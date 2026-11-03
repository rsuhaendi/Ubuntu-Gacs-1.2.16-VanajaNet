// EXT: akun login web ONT VSOL V2801RGW — username & password superadmin dan normal user.
// Firmware V1.1.00-250829 tidak mengekspos akun web lewat TR-069, jadi nilainya dibaca
// dari running-config. Password diganti lewat form perangkat (new_formPasswordSetup,
// yang berubah adalah akun yang sedang login); username tidak punya form sama sekali
// sehingga penulisannya lewat upload running-config (lihat ont_config.js).
//   ext("ont_account", "get", <ipOnt>, [timeoutMs])
//     -> {"userName":"user","userPass":"...","adminName":"admin","adminPass":"..."}
//   ext("ont_account", "setPass", <ipOnt>, <user|admin>, <passBaru>, [passLama], [timeoutMs])
//     -> "OK" | pesan error perangkat
//   ext("ont_account", "setName", <ipOnt>, <user|admin>, <namaBaru>, [timeoutMs])
//     -> "OK" | pesan error
// Modul ini terpisah dari ont_user.js karena GenieACS meng-cache modul ext per proses:
// file baru langsung terbaca, file lama butuh restart layanan.
// Mengganti nama/sandi superadmin membuat kredensial bawaan ext lain tidak berlaku
// lagi, jadi nilai baru dicatat ke files/ont_creds.json setelah perubahan sukses.
const cfg = require("./ont_config.js");

const WHO = {
  user: { nameKey: "USER_NAME", label: "normal user" },
  admin: { nameKey: "SUSER_NAME", label: "superadmin" },
};

// Caller boleh memperkecil anggaran, tidak boleh memperbesar.
const limit = (v, dflt) => {
  const max = dflt || 2800;
  return Math.max(150, Math.min(Number(v) || max, max));
};

function value(xml, name) {
  const m = xml.match(new RegExp('Name="' + name + '"\\s+Value="([^"]*)"'));
  return m ? m[1] : "";
}

function assertWho(who) {
  if (!WHO[who]) throw new Error("akun harus 'user' atau 'admin'");
  return who;
}

async function readAccounts(ip, t) {
  const rem = cfg.budget(t);
  await cfg.login(ip, rem());
  try {
    const mask = (await cfg.request(ip, "GET", "/boaform/getASPdata/FMask", null, rem())).body.trim();
    const xml = await cfg.downloadConfig(ip, mask, rem());
    if (xml.indexOf("USER_NAME") < 0)
      throw new Error("running-config tidak terbaca" + (/^HTTP/.test(xml) ? " (sesi boaform tidak diterima perangkat)" : ""));
    return {
      userName: value(xml, "USER_NAME"),
      userPass: value(xml, "USER_PASSWORD"),
      adminName: value(xml, "SUSER_NAME"),
      adminPass: value(xml, "SUSER_PASSWORD"),
    };
  } finally {
    // Slot admin cuma satu (CF_MAX_ADMIN_NUM=1) dan sesi terikat IP sumber.
    await cfg.logout(ip, Math.min(300, rem()));
  }
}

async function changePass(ip, loginName, oldPass, newPass, t) {
  const rem = cfg.budget(t);
  try {
    await cfg.loginAs(ip, loginName, oldPass, rem());
  } catch (err) {
    throw new Error("login dengan password lama gagal (" + err.message + ")");
  }
  let res;
  try {
    const mask = (await cfg.request(ip, "GET", "/boaform/getASPdata/FMask", null, rem())).body.trim();
    res = await cfg.request(ip, "POST", "/boaform/getASPdata/new_formPasswordSetup",
      "oldPasswd=" + encodeURIComponent(oldPass) +
      "&newPasswd=" + encodeURIComponent(newPass) +
      "&affirmPasswd=" + encodeURIComponent(newPass) +
      "&csrfMask=" + encodeURIComponent(mask), rem());
  } finally {
    await cfg.logout(ip, Math.min(300, rem()));
  }
  const b = res.body || "";
  if (b.indexOf("Successs") >= 0) return "OK";
  if (b.indexOf("LANG_ERROR_INPUT_OLD_USER_PASSWORD_ERROR") >= 0) return "Password lama salah";
  if (b.indexOf("LANG_PSWD_IS_INVALID") >= 0) return "Password tidak valid (6-32 karakter, kombinasi huruf+angka/simbol)";
  if (b.indexOf("LANG_PSWD_SHOULD_NOT_BE_SAME") >= 0) return "Password baru tidak boleh sama dengan yang lama";
  return "Gagal: " + (b.slice(0, 120) || "respon kosong (http " + res.status + ")");
}

function checkName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,31}$/.test(name))
    throw new Error("nama akun harus 1-32 karakter, dimulai huruf/angka (. _ @ - boleh setelahnya)");
  return name;
}

function get(args, callback) {
  const ip = args && args[0];
  if (!ip) return callback(new Error("IP ONT tidak diberikan"));
  readAccounts(ip, limit(args[1], 2000))
    .then((a) => callback(null, JSON.stringify(a)))
    .catch((err) => callback(err));
}

function setPass(args, callback) {
  const ip = args && args[0];
  let who, newPass, oldPass, t;
  try {
    if (!ip) throw new Error("IP ONT tidak diberikan");
    who = assertWho(args[1]);
    newPass = String(args[2] === undefined ? "" : args[2]);
    oldPass = args[3] === undefined || args[3] === null ? "" : String(args[3]);
    t = limit(args[4], 2800);
    if (!newPass.length) throw new Error("Password baru kosong");
    cfg.assertSafeValue(newPass);
  } catch (err) {
    return callback(err);
  }

  // Nama akun untuk login dan password lama diambil dari config perangkat, jadi
  // operator tidak perlu mengetik ulang kredensial di UI.
  const run = async () => {
    const a = await readAccounts(ip, t);
    const name = who === "admin" ? a.adminName : a.userName;
    const stored = who === "admin" ? a.adminPass : a.userPass;
    const old = oldPass.length ? oldPass : stored;
    if (!String(old).length) throw new Error("password lama " + WHO[who].label + " kosong di running-config");
    if (!String(name).length) throw new Error("username " + WHO[who].label + " kosong di running-config");
    const msg = await changePass(ip, name, old, newPass, t);
    if (msg === "OK" && who === "admin") cfg.remember(ip, { user: name, pass: newPass });
    return msg;
  };

  run().then((msg) => callback(null, msg)).catch((err) => callback(err));
}

function setName(args, callback) {
  const ip = args && args[0];
  let who, name, t;
  try {
    if (!ip) throw new Error("IP ONT tidak diberikan");
    who = assertWho(args[1]);
    name = checkName(String(args[2] === undefined ? "" : args[2]));
    t = limit(args[3], 2800);
  } catch (err) {
    return callback(err);
  }

  // Verifikasi hanya dipakai kalau respons upload tidak terbaca; biayanya satu
  // unduh config, jadi jarang sempat jalan dalam anggaran yang sama.
  const verify = async (ip2, t2) => {
    const a = await readAccounts(ip2, t2);
    return { USER_NAME: a.userName, SUSER_NAME: a.adminName };
  };

  cfg.patchKeys(ip, [{ name: WHO[who].nameKey, value: name }], t, verify)
    .then((msg) => {
      if (msg === "OK" && who === "admin") cfg.remember(ip, { user: name });
      return msg;
    })
    .then((msg) => callback(null, msg))
    .catch((err) => callback(err));
}

module.exports = { get, setPass, setName };
