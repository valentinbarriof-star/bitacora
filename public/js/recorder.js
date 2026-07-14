// Grabadora de dictado — versión recortada de twoitter/public/js/recorder.js.
// mp4/AAC primero (único formato que graban iOS Y Chromium moderno → notas
// universales); webm/opus de fallback. Safari/iOS ignora el bitrate pedido y
// graba ~189 kbps: no pasa nada, Whisper lo digiere igual (25 MB de tope dan
// para muchísimo dictado).

const PREFERRED_TYPES = [
  'audio/mp4',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
];

const VOICE_NOTE_BITRATE = 24000;

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of PREFERRED_TYPES) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';
}

export function canRecord() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

// Sesión única de grabación. start() → stop() devuelve un Blob de audio.
export function createRecorder() {
  let rec = null;
  let stream = null;
  let chunks = [];
  let mimeType = '';

  return {
    get active() {
      return !!rec;
    },

    async start() {
      // Mono + DSP de voz: todos los bits a un canal, captura limpia.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mimeType = pickMimeType();
      const opts = { audioBitsPerSecond: VOICE_NOTE_BITRATE };
      if (mimeType) opts.mimeType = mimeType;
      rec = new MediaRecorder(stream, opts);
      chunks = [];
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      rec.start();
    },

    stop() {
      return new Promise((resolve) => {
        if (!rec) return resolve(null);
        const r = rec;
        r.onstop = () => {
          stream?.getTracks().forEach((t) => t.stop());
          const mime = (mimeType || r.mimeType || 'audio/webm').split(';')[0];
          const blob = new Blob(chunks, { type: mime });
          rec = null;
          stream = null;
          chunks = [];
          resolve(blob.size > 0 ? blob : null);
        };
        try {
          r.stop();
        } catch {
          resolve(null);
        }
      });
    },
  };
}
