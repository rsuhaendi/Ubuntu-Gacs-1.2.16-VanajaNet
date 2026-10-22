const http = require('http');

function getComment(args, callback) {
  let ipAddress = "";
  if (Array.isArray(args) && args.length > 0) {
    ipAddress = Array.isArray(args[0]) ? args[0][0] : args[0];
  } else if (typeof args === 'string') {
    ipAddress = args;
  }

  if (!ipAddress || ipAddress === "undefined" || ipAddress === "null" || ipAddress === "") {
    return callback(null, "IP Not Found");
  }

  // Bersihkan IP dari spasi/port/CIDR
  ipAddress = String(ipAddress).trim().split(':')[0].split('/')[0];

  const authHeader = 'Basic ' + Buffer.from('cwmp:cwmp').toString('base64');

  const options = {
    hostname: '10.26.51.254',
    port: 8801,
    path: '/rest/queue/simple',
    method: 'GET',
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json'
    },
    timeout: 5000
  };

  // Helper untuk membersihkan format IP target dari MikroTik (menghapus /32)
  const cleanTargetIp = (targetStr) => {
    if (!targetStr) return "";
    return targetStr.trim().split('/')[0];
  };

  const req = http.request(options, (res) => {
    let rawData = '';

    res.on('data', (chunk) => { rawData += chunk; });

    res.on('end', () => {
      if (res.statusCode !== 200) {
        return callback(null, "HTTP " + res.statusCode);
      }

      try {
        const data = JSON.parse(rawData);

        if (Array.isArray(data)) {
          // Pencarian EXACT MATCH (Mencocokkan IP secara presisi)
          const matchedItem = data.find(item => {
            if (!item.target) return false;

            if (typeof item.target === 'string') {
              return cleanTargetIp(item.target) === ipAddress;
            }
            if (Array.isArray(item.target)) {
              return item.target.some(t => cleanTargetIp(t) === ipAddress);
            }
            return false;
          });

          if (matchedItem) {
            if (matchedItem.comment && matchedItem.comment.trim() !== "") {
              return callback(null, matchedItem.comment.trim());
            } else {
              return callback(null, "Comment Kosong");
            }
          } else {
            return callback(null, "IP Tidak Ada di Queue");
          }
        } else {
          return callback(null, "Format Queue Invalid");
        }
      } catch (e) {
        return callback(null, "JSON Parse Error");
      }
    });
  });

  req.on('error', (e) => {
    return callback(null, "Error Connect MikroTik");
  });

  req.on('timeout', () => {
    req.destroy();
    return callback(null, "MikroTik Timeout");
  });

  req.end();
}

exports.getComment = getComment;
