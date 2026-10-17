// Windows DPAPI, CurrentUser. Never fall back to plaintext token storage.
import { readFile, writeFile, rename, rm } from "node:fs/promises";
const script = (protect) =>
  `Add-Type -AssemblyName System.Security;$s=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($s);$r=[Security.Cryptography.ProtectedData]::${protect ? "Protect" : "Unprotect"}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([Convert]::ToBase64String($r))`;
// execFile does not accept stdin in async options; use an explicit pipe with no secret argv.
import { spawn } from "node:child_process";
const transform = (raw, protect) =>
  new Promise((resolve, reject) => {
    if (process.platform !== "win32") return reject(new Error("DPAPI доступен только в Windows"));
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script(protect), "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let chunks = [],
      size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("DPAPI timeout"));
    }, 10000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("DPAPI недоступен"));
    });
    child.stdout.on("data", (b) => {
      size += b.length;
      if (size > 100000) {
        child.kill();
        return reject(new Error("DPAPI limit"));
      }
      chunks.push(b);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("DPAPI отказ"));
      resolve(Buffer.from(Buffer.concat(chunks).toString().trim(), "base64"));
    });
    child.stdin.end(Buffer.from(raw).toString("base64"));
  });
export const tokenStore = (file) => ({
  async read() {
    try {
      return JSON.parse((await transform(await readFile(file), false)).toString());
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw new Error("Не удалось открыть защищённый Google credential");
    }
  },
  async save(value) {
    const data = await transform(Buffer.from(JSON.stringify(value)), true);
    const temp = file + ".tmp";
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, file);
  },
  async clear() {
    await rm(file, { force: true });
  },
});
