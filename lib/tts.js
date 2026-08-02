const crypto = require("node:crypto");

const TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const GEC_VERSION = "1-143.0.3650.75";
const WIN_EPOCH_OFFSET = 11644473600n;

function makeToken() {
  let seconds = BigInt(Math.floor(Date.now() / 1000)) + WIN_EPOCH_OFFSET;
  seconds -= seconds % 300n;
  const ticks = (seconds * 10000000n).toString();
  const gec = crypto.createHash("sha256").update(ticks + TRUSTED_TOKEN).digest("hex").toUpperCase();
  return { token: TRUSTED_TOKEN, gec, version: GEC_VERSION };
}

function setupHeaders(session) {
  session.webRequest.onBeforeSendHeaders({ urls: ["wss://speech.platform.bing.com/*"] }, (details, callback) => {
    details.requestHeaders["Origin"] = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
    details.requestHeaders["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
    callback({ requestHeaders: details.requestHeaders });
  });
}

function register(ipcMain) {
  ipcMain.handle("tts:token", () => makeToken());
}

module.exports = { register, setupHeaders };
