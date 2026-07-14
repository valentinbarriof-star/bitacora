// Media: bitácora solo guarda AUDIO (la sección de textos es texto plano).
// Versión recortada del media.ts de notas8.

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function randomKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Clave R2: audios/aa/mm/<24 hex>.<ext>. El regex de validación en index.ts
// espera exactamente este formato.
export function buildAudioKey(ext: string): string {
  const d = new Date();
  const yy = pad2(d.getFullYear() % 100);
  const mm = pad2(d.getMonth() + 1);
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  return `audios/${yy}/${mm}/${randomKey()}.${safeExt}`;
}

// webm/opus de MediaRecorder + mp3/m4a/ogg/wav para archivos subidos a mano
// (un memo de iOS llega como audio/mp4).
const ALLOWED_AUDIO = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
]);

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB

export function classifyAudio(ct: string): { ext: string } | null {
  if (!ALLOWED_AUDIO.has(ct)) return null;
  const sub = ct.split("/")[1];
  const ext =
    sub === "mpeg" ? "mp3"
    : sub === "mp4" || sub === "x-m4a" ? "m4a"
    : sub === "x-wav" ? "wav"
    : sub;
  return { ext };
}

// Uint8Array → base64. Whisper de Workers AI espera el audio como STRING
// base64; chunkeado a 32 KB para no reventar el stack (ver notas8/media.ts).
export function uint8ToBase64(u8: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < u8.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, u8.length);
    binary += String.fromCharCode.apply(
      null,
      u8.subarray(i, end) as unknown as number[],
    );
  }
  return btoa(binary);
}
