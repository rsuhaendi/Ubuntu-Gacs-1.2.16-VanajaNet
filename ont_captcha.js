// EXT: baca & tulis flag captcha login web (CF_WEB_CAPTCHA) pada ONT VSOL V2801RGW.
//   ext("ont_captcha", "get", <ipOnt>, [timeoutMs])
//     -> {"captcha":"0","simple":"1"}   (baca custom_page, tanpa login)
//   ext("ont_captcha", "set", <ipOnt>, <0|1>, [timeoutMs])
//     -> "OK" | pesan error
// Mekanisme baca/tulisnya ada di ont_config.js. Efek penulisan langsung, tanpa reboot.
const cfg = require("./ont_config.js");

// Dipakai juga sebagai verify() setelah upload, jadi kembalikan nilai per kunci.
async function readPair(ip, t) {
  const f = await cfg.readFlags(ip, t);
  return { CF_WEB_CAPTCHA: f.CF_WEB_CAPTCHA, CF_WEB_CAPTCHA_SIMPLE: f.CF_WEB_CAPTCHA_SIMPLE };
}

// Caller boleh memperkecil anggaran, tidak boleh memperbesar.
const limit = (v, dflt) => Math.min(Number(v) || dflt, dflt);

function get(args, callback) {
  const ip = args && args[0];
  if (!ip) return callback(new Error("IP ONT tidak diberikan"));
  readPair(ip, limit(args[1], 2000))
    .then((f) => callback(null, JSON.stringify({ captcha: f.CF_WEB_CAPTCHA || "", simple: f.CF_WEB_CAPTCHA_SIMPLE || "" })))
    .catch((err) => callback(err));
}

function set(args, callback) {
  const ip = args && args[0];
  const want = args && args[1];
  if (!ip) return callback(new Error("IP ONT tidak diberikan"));
  if (want !== "0" && want !== "1") return callback(new Error("Nilai captcha harus 0 atau 1"));
  cfg.patchKeys(ip, [{ name: "CF_WEB_CAPTCHA", value: want }], limit(args[2], 2800), readPair)
    .then((msg) => callback(null, msg))
    .catch((err) => callback(err));
}

module.exports = { get, set };
