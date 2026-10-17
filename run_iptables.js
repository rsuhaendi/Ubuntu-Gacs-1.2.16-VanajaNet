const { exec } = require('child_process');

function run_iptables(args, callback) {
  const deviceIp = (args && args[0]) ? args[0] : '127.0.0.1';

  console.log(`[GenieACS Extension] Menjalankan telnet_cmd.expect ke IP: ${deviceIp}`);

  const command = `/opt/genieacs/ext/telnet_cmd.expect ${deviceIp}`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`[GenieACS Extension] Error:`, error.message);
      return callback(error);
    }
    console.log(`[GenieACS Extension] Sukses:\n${stdout}`);
    callback(null, stdout);
  });
}

module.exports = { run_iptables };
