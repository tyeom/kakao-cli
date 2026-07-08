import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ClipboardImageFile {
  path: string;
  filename: string;
  cleanup: () => Promise<void>;
}

const COMMAND_TIMEOUT_MS = 10_000;

export async function readClipboardImageToTempFile(): Promise<ClipboardImageFile> {
  if (process.platform === 'darwin') return readMacClipboardImage();
  if (process.platform === 'win32') return readWindowsClipboardImage();
  if (process.platform === 'linux') return readLinuxClipboardImage();

  throw new Error(`클립보드 이미지 전송은 현재 지원되지 않는 OS입니다: ${process.platform}`);
}

function tempImagePath(ext: string): string {
  return join(tmpdir(), `kakao-cli-clipboard-${process.pid}-${Date.now()}-${randomUUID()}.${ext}`);
}

async function buildClipboardImageFile(path: string): Promise<ClipboardImageFile> {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) {
    await removeTemp(path);
    throw new Error('클립보드에 이미지가 없습니다.');
  }

  return {
    path,
    filename: `clipboard-${Date.now()}.${path.split('.').pop() || 'png'}`,
    cleanup: () => removeTemp(path),
  };
}

async function readMacClipboardImage(): Promise<ClipboardImageFile> {
  const outPath = tempImagePath('png');
  const script = `
ObjC.import('AppKit');
const outputPath = ${JSON.stringify(outPath)};
const pasteboard = $.NSPasteboard.generalPasteboard;
const image = $.NSImage.alloc.initWithPasteboard(pasteboard);
if (!image || !image.isValid) {
  throw new Error('NO_CLIPBOARD_IMAGE');
}
const tiff = image.TIFFRepresentation;
if (!tiff) {
  throw new Error('NO_CLIPBOARD_IMAGE');
}
const bitmap = $.NSBitmapImageRep.imageRepWithData(tiff);
if (!bitmap) {
  throw new Error('NO_CLIPBOARD_IMAGE');
}
const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
if (!png || !png.writeToFileAtomically(outputPath, true)) {
  throw new Error('CLIPBOARD_IMAGE_WRITE_FAILED');
}
`;

  try {
    await runCommand('osascript', ['-l', 'JavaScript', '-e', script]);
    return await buildClipboardImageFile(outPath);
  } catch (err) {
    await removeTemp(outPath);
    throw normalizeClipboardError(err);
  }
}

async function readWindowsClipboardImage(): Promise<ClipboardImageFile> {
  const outPath = tempImagePath('png');
  const psPath = outPath.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) {
  Write-Error 'NO_CLIPBOARD_IMAGE'
  exit 2
}
try {
  $image.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $image.Dispose()
}
`;

  try {
    await runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-Command',
      script,
    ]);
    return await buildClipboardImageFile(outPath);
  } catch (err) {
    await removeTemp(outPath);
    throw normalizeClipboardError(err);
  }
}

async function readLinuxClipboardImage(): Promise<ClipboardImageFile> {
  const candidates = [
    { ext: 'png', commands: [['wl-paste', ['--type', 'image/png']], ['xclip', ['-selection', 'clipboard', '-target', 'image/png', '-out']], ['xsel', ['--clipboard', '--output', '--mime-type', 'image/png']]] },
    { ext: 'jpg', commands: [['wl-paste', ['--type', 'image/jpeg']], ['xclip', ['-selection', 'clipboard', '-target', 'image/jpeg', '-out']], ['xsel', ['--clipboard', '--output', '--mime-type', 'image/jpeg']]] },
    { ext: 'gif', commands: [['wl-paste', ['--type', 'image/gif']], ['xclip', ['-selection', 'clipboard', '-target', 'image/gif', '-out']], ['xsel', ['--clipboard', '--output', '--mime-type', 'image/gif']]] },
  ] as const;

  const errors: string[] = [];
  for (const candidate of candidates) {
    for (const [command, args] of candidate.commands) {
      const outPath = tempImagePath(candidate.ext);
      try {
        await runCommandToFile(command, args, outPath);
        return await buildClipboardImageFile(outPath);
      } catch (err) {
        await removeTemp(outPath);
        errors.push(errorMessage(err));
      }
    }
  }

  const missingHint = [
    'Ubuntu/Linux에서 클립보드 이미지를 읽으려면 데스크톱 환경에 맞는 도구가 필요합니다.',
    'Wayland: sudo apt install wl-clipboard',
    'X11: sudo apt install xclip 또는 sudo apt install xsel',
  ].join(' ');
  throw new Error(`${missingHint} 클립보드에 이미지가 없거나 지원 도구가 없습니다. ${errors[0] ? `(${errors[0]})` : ''}`.trim());
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, COMMAND_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} failed with exit code ${code}`));
    });
  });
}

function runCommandToFile(command: string, args: readonly string[], outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath);
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    let childSucceeded = false;
    let outputFinished = false;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!output.closed) output.close();
      if (err) reject(err);
      else resolve();
    };
    const finishWhenReady = (): void => {
      if (childSucceeded && outputFinished) finish();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${command} timed out`));
    }, COMMAND_TIMEOUT_MS);

    child.stdout.pipe(output);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code === 0) {
        childSucceeded = true;
        finishWhenReady();
      } else {
        finish(new Error(stderr.trim() || `${command} failed with exit code ${code}`));
      }
    });
    output.on('finish', () => {
      outputFinished = true;
      finishWhenReady();
    });
    output.on('error', (err) => {
      child.kill('SIGKILL');
      finish(err);
    });
  });
}

async function removeTemp(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // 임시 파일 정리는 best-effort입니다.
  }
}

function normalizeClipboardError(err: unknown): Error {
  const message = errorMessage(err);
  if (message.includes('NO_CLIPBOARD_IMAGE')) return new Error('클립보드에 이미지가 없습니다.');
  return new Error(`클립보드 이미지 읽기 실패: ${message}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
