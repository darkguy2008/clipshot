import { spawn, execSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadConfig } from "./config";

const POLL_INTERVAL_MS = 200;
const LOG_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

let lastImageHash: string | null = null;
let logFile: string | null = null;
let logStartTime: number = 0;

const isWindows = process.platform === "win32";
const isMacOS = process.platform === "darwin";

function isWSL(): boolean {
  if (isWindows) {
    return false;
  }
  try {
    const release = fs.readFileSync("/proc/version", "utf8");
    return release.toLowerCase().includes("microsoft") || release.toLowerCase().includes("wsl");
  } catch {
    return false;
  }
}

const LOG_DIR = path.join(os.homedir(), ".config", "clipshot", "logs");

function createNewLogFile(): string {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(LOG_DIR, `clipshot-${timestamp}.log`);
}

function log(message: string): void {
  const now = Date.now();
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;

  // Check if we need a new log file
  if (!logFile || (now - logStartTime) > LOG_MAX_AGE_MS) {
    logFile = createNewLogFile();
    logStartTime = now;
  }

  // Write to file
  fs.appendFileSync(logFile, line);

  // Also print to console if not in background
  if (!process.env.SHOTMON_BACKGROUND) {
    process.stdout.write(message + "\n");
  }
}

async function getClipboardImageWindows(): Promise<Buffer | null> {
  const tempFileName = `clipshot-clipboard-${Date.now()}.png`;
  let tempFilePath: string | null = null;

  try {
    // PowerShell script to get clipboard image and save directly to temp file
    // This avoids base64 encoding and stdout buffer limits for large images
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -ne $null) {
  $tempPath = Join-Path $env:TEMP '${tempFileName}'
  $img.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output $tempPath
}
`;
    // Encode as UTF-16LE base64 for -EncodedCommand
    const encoded = Buffer.from(psScript, "utf16le").toString("base64");

    // Use powershell.exe for WSL, powershell for native Windows
    const psCmd = isWindows ? "powershell" : "powershell.exe";
    const windowsPath = execSync(`${psCmd} -NoProfile -WindowStyle Hidden -EncodedCommand ${encoded}`, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }).trim();

    if (!windowsPath) {
      return null;
    }

    // Convert path for WSL if needed
    if (isWindows) {
      tempFilePath = windowsPath;
    } else {
      tempFilePath = execSync(`wslpath '${windowsPath}'`, { encoding: "utf8", timeout: 2000 }).trim();
    }

    if (fs.existsSync(tempFilePath)) {
      const imageBuffer = fs.readFileSync(tempFilePath);
      fs.unlinkSync(tempFilePath);
      return imageBuffer;
    }

    return null;
  } catch {
    // Try to clean up temp file if it was created
    if (tempFilePath) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {
        // Ignore cleanup errors
      }
    }
    return null;
  }
}

async function getClipboardImageNative(): Promise<Buffer | null> {
  try {
    // Check if clipboard has image using xclip
    const targets = execSync("xclip -selection clipboard -t TARGETS -o 2>/dev/null", {
      encoding: "utf8",
      timeout: 2000,
    });

    if (!targets.includes("image/png")) {
      return null;
    }

    // Get image data
    const imageData = execSync("xclip -selection clipboard -t image/png -o 2>/dev/null", {
      encoding: "buffer",
      timeout: 5000,
      maxBuffer: 50 * 1024 * 1024, // 50MB max
    });

    return imageData.length > 0 ? imageData : null;
  } catch {
    return null;
  }
}

let macClipboardScriptPath: string | null = null;
const macTempImagePath = path.join(os.tmpdir(), "clipshot-cb.png");

function ensureMacClipboardScript(): string {
  if (!macClipboardScriptPath) {
    const scriptPath = path.join(os.tmpdir(), "clipshot-get-clipboard.applescript");
    const script = `use framework "AppKit"
use scripting additions
set pb to current application's NSPasteboard's generalPasteboard()
set imgData to pb's dataForType:"public.png"
if imgData is not missing value then
    imgData's writeToFile:"${macTempImagePath}" atomically:true
    return "OK"
end if
set imgData to pb's dataForType:"public.tiff"
if imgData is not missing value then
    set bitmapRep to current application's NSBitmapImageRep's imageRepWithData:imgData
    set pngData to (bitmapRep's representationUsingType:4 |properties|:(missing value))
    pngData's writeToFile:"${macTempImagePath}" atomically:true
    return "OK"
end if
return "NO_IMAGE"`;
    fs.writeFileSync(scriptPath, script);
    macClipboardScriptPath = scriptPath;
  }
  return macClipboardScriptPath;
}

async function getClipboardImageMacOS(): Promise<Buffer | null> {
  try {
    const scriptPath = ensureMacClipboardScript();
    const result = execSync(`osascript "${scriptPath}"`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();

    if (result === "NO_IMAGE") {
      return null;
    }

    if (fs.existsSync(macTempImagePath)) {
      const imageBuffer = fs.readFileSync(macTempImagePath);
      fs.unlinkSync(macTempImagePath);
      return imageBuffer.length > 0 ? imageBuffer : null;
    }

    return null;
  } catch {
    return null;
  }
}

async function getClipboardImage(): Promise<Buffer | null> {
  if (isWindows || isWSL()) {
    return getClipboardImageWindows();
  }
  if (isMacOS) {
    return getClipboardImageMacOS();
  }
  return getClipboardImageNative();
}

function getImageHash(buffer: Buffer): string {
  return crypto.createHash("md5").update(buffer).digest("hex");
}

function generateFilename(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `screenshot-${timestamp}.png`;
}

const LOCAL_SCREENSHOT_DIR = "/tmp/clipshot-screenshots";

function saveLocal(imageBuffer: Buffer, filename: string): { success: boolean; path: string } {
  const filePath = path.join(LOCAL_SCREENSHOT_DIR, filename);
  try {
    fs.mkdirSync(LOCAL_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(filePath, imageBuffer);
    return { success: true, path: filePath };
  } catch {
    return { success: false, path: filePath };
  }
}

async function pipeToRemote(imageBuffer: Buffer, remote: string, filename: string): Promise<{ success: boolean; path: string; error?: string }> {
  const remoteDir = "/tmp/clipshot-screenshots";
  const remotePath = `${remoteDir}/${filename}`;

  return new Promise((resolve) => {
    const proc = spawn("ssh", [
      remote,
      `mkdir -p ${remoteDir} && cat > ${remotePath}`
    ], {
      windowsHide: true,
    });

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.stdin.write(imageBuffer);
    proc.stdin.end();

    proc.on("close", (code) => {
      resolve({ success: code === 0, path: remotePath, error: stderr.trim() || undefined });
    });

    proc.on("error", (err) => {
      resolve({ success: false, path: remotePath, error: err.message });
    });
  });
}

function setRemoteClipboard(remote: string, filePath: string, display: string): void {
  try {
    // Kill previous xclip owner so the new one can take over
    execSync(
      `ssh ${remote} 'pkill -x xclip 2>/dev/null; true'`,
      { timeout: 3000, stdio: "ignore" }
    );
    // Run xclip in detached nohup so it persists after SSH exits.
    // xclip must stay alive to own the X clipboard selection.
    execSync(
      `ssh ${remote} 'DISPLAY=${display} nohup xclip -selection clipboard -t image/png -i ${filePath} </dev/null >/dev/null 2>&1 &'`,
      { timeout: 5000, stdio: "ignore" }
    );
  } catch {
    // Ignore - clipboard setting is best-effort
  }
}

function copyToClipboard(text: string): void {
  const escaped = text.replace(/'/g, "'\\''");
  try {
    if (isWindows) {
      const psEscaped = text.replace(/'/g, "''");
      execSync(`powershell -NoProfile -WindowStyle Hidden -Command "Set-Clipboard -Value '${psEscaped}'"`, { timeout: 2000, windowsHide: true });
    } else if (isWSL()) {
      execSync(`echo -n '${escaped}' | clip.exe`, { timeout: 2000 });
    } else if (isMacOS) {
      execSync(`printf '%s' '${escaped}' | pbcopy`, { timeout: 2000 });
    } else {
      execSync(`printf '%s' '${escaped}' | xclip -selection clipboard`, { timeout: 2000 });
    }
  } catch {
    // Ignore clipboard errors
  }
}

export async function startMonitor(remote: string): Promise<void> {
  // Initialize logging
  logFile = createNewLogFile();
  logStartTime = Date.now();

  const config = loadConfig();
  const display = config?.display || ":0";

  const wsl = isWSL();
  const env = isWindows ? "Windows" : (wsl ? "WSL" : "Native");
  log(`Starting monitor for: ${remote}`);
  log(`Environment: ${env}`);
  log(`Display: ${display}`);
  log(`Log file: ${logFile}`);
  if (remote === "local") {
    log(`Saving to: ${LOCAL_SCREENSHOT_DIR}`);
  }
  log("");
  log("Monitoring clipboard... (Ctrl+C to stop)");
  log("");
  // Initialize with current clipboard state
  const initialImage = await getClipboardImage();
  if (initialImage) {
    lastImageHash = getImageHash(initialImage);
  }

  const poll = async () => {
    try {
      const imageBuffer = await getClipboardImage();

      if (!imageBuffer) {
        return;
      }

      const currentHash = getImageHash(imageBuffer);

      if (currentHash !== lastImageHash) {
        lastImageHash = currentHash;

        const filename = generateFilename();
        const size = Math.round(imageBuffer.length / 1024);

        log(`New screenshot: ${filename} (${size}KB)`);

        if (remote === "local") {
          const result = saveLocal(imageBuffer, filename);
          if (result.success) {
            log(`  -> Saved: ${result.path}`);
            copyToClipboard(result.path);
            log(`  -> Copied to clipboard`);
          } else {
            log(`  -> Failed to save locally`);
          }
        } else {
          const result = await pipeToRemote(imageBuffer, remote, filename);
          if (result.success) {
            log(`  -> Sent to ${remote}:${result.path}`);
            // Set the remote X clipboard so Ctrl+V works in Claude Code over SSH
            setRemoteClipboard(remote, result.path, display);
            log(`  -> Set remote clipboard`);
            // Also save locally so the image is accessible on this machine
            const localResult = saveLocal(imageBuffer, filename);
            if (localResult.success) {
              copyToClipboard(localResult.path);
              log(`  -> Local copy: ${localResult.path}`);
              log(`  -> Copied local path to clipboard`);
            } else {
              copyToClipboard(result.path);
              log(`  -> Copied remote path to clipboard`);
            }
          } else {
            log(`  -> Failed to send to ${remote}`);
            if (result.error) {
              log(`  -> Error: ${result.error}`);
            }
          }
        }
      }
    } catch (err) {
      log(`Error: ${err}`);
    }
  };

  // Start polling
  setInterval(poll, POLL_INTERVAL_MS);

  // Keep process running
  await new Promise(() => {});
}
