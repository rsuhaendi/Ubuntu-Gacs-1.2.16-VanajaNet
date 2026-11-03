// EXT: daftar klien WiFi + RSSI dari web API internal ONT (Realtek/VSOL, boaform).
// Dipakai untuk firmware V1.1.00-250829 yang tidak mengekspos RSSI lewat TR-069.
// Pemanggilan: ext("ont_wifi", "get", <ipOnt>, [timeoutMs])
// Sesi boaform terikat ke IP sumber dan tidak pakai cookie, jadi cukup login sekali
// bila endpoint menjawab 302 ke /login.html.
const http = require("http");

const USER = process.env.ONT_HTTP_USER || "admin";
const PASS = process.env.ONT_HTTP_PASS || "stdVSOL101";

function request(ip, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: ip,
        port: 80,
        path: path,
        method: method,
        timeout: timeoutMs,
        headers: body
          ? {
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": Buffer.byteLength(body),
            }
          : undefined,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          data += c;
          if (data.length > 200000) {
            req.destroy();
            resolve({ status: res.statusCode, body: data });
          }
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

// Bentuk blob boaform: "wlan_cli[<mac>]=k=v&k=v&" yang berulang
function parseClients(raw) {
  const clients = [];
  for (const block of raw.split("wlan_cli[").slice(1)) {
    const body = block.slice(block.indexOf("]") + 1).replace(/^=/, "");
    const f = {};
    for (const pair of body.split("&")) {
      const eq = pair.indexOf("=");
      if (eq > 0) f[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    if (f.rssi !== undefined) clients.push(f);
  }
  return clients;
}

const LIST = "/boaform/getASPdata/wirelessClientList";

async function fetchClients(ip, timeoutMs) {
  let res = await request(ip, "GET", LIST, null, timeoutMs);
  let clients = parseClients(res.body);
  // Belum ada sesi dari IP ini: ONT menjawab 302 ke /login.html
  if (!clients.length && res.body.indexOf("wlan_cli[") < 0 && res.body.indexOf("<HTML") >= 0) {
    await request(ip, "POST", "/boaform/admin/formLogin",
      "username=" + encodeURIComponent(USER) + "&password=" + encodeURIComponent(PASS), timeoutMs);
    res = await request(ip, "GET", LIST, null, timeoutMs);
    clients = parseClients(res.body);
  }
  // CF_MAX_ADMIN_NUM=1: satu sesi admin untuk seluruh perangkat, dan sesi boaform terikat
  // IP. Kalau slot ini tidak dilepas, login web/telnet teknisi dari IP mana pun bisa
  // "Error!" atau koneksi terputus tanpa pesan.
  request(ip, "POST", "/boaform/admin/formLogout", "", timeoutMs).catch(() => {});
  return clients;
}

function get(args, callback) {
  const ip = args && args[0];
  if (!ip) return callback(new Error("IP ONT tidak diberikan"));
  // EXT_TIMEOUT GenieACS default 3000 ms; login + 2x GET harus selesai di bawah itu
  const timeoutMs = Math.min(Number(args[1]) || 900, 2500);

  fetchClients(ip, timeoutMs)
    .then((clients) => {
      const out = clients.map((c) => ({
        mac: c.mac_addr || "",
        rssi: Number(c.rssi),
        txrate: c.txrate || "",
        ssid: c.ssidname || "",
      }));
      callback(null, JSON.stringify(out));
    })
    .catch((err) => callback(err));
}

module.exports = { get };
