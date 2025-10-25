import { KokoroTTS } from "./kokoro.js";
import { env } from "./transformers.min.js";
import { splitTextSmart } from "./semantic-split.js";

async function detectWebGPU() {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch (e) {
    return false;
  }
}

const device = await detectWebGPU() ? "webgpu" : "wasm";
self.postMessage({ status: "loading_model_start", device });

let model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";

if (self.location.hostname === "localhost2") {
  env.allowLocalModels = true;
  model_id = "./my_model/";
}

const tts = await KokoroTTS.from_pretrained(model_id, {
  dtype: device === "wasm" ? "q8" : "fp32", device,
  //dtype: "fp16",
  progress_callback: (progress) => {
    self.postMessage({ status: "loading_model_progress", progress });
  }
}).catch((e) => {
  self.postMessage({ status: "error", error: e.message });
  throw e;
});

self.postMessage({ status: "loading_model_ready", voices: tts.voices, device });

// --- THIS IS THE MEMORY-SAFE QUEUE LOGIC FOR SENTENCES WITHIN A CHUNK ---
let bufferQueueSize = 0;
const MAX_QUEUE_SIZE = 6;
let shouldStop = false;
// --- END QUEUE LOGIC ---

self.addEventListener("message", async (e) => {
  const { type, text, voice, speed } = e.data;
  
  if (type === "stop") {
    shouldStop = true;
    bufferQueueSize = 0;
    console.log("Stop command received, stopping generation");
    return;
  }

  if (type === "buffer_processed") {
    bufferQueueSize = Math.max(0, bufferQueueSize - 1);
    return;
  }

  if (type === "generate" && text) { 
    shouldStop = false;
    
    // This now splits only the SMALL chunk it was given
    let sentences = splitTextSmart(text, 300); 

    for (const sentence of sentences) {
      if (shouldStop) break;

      while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (shouldStop) break;
      }
      if (shouldStop) break;
      
      const audio = await tts.generate(sentence, { voice, speed }); 
      if (shouldStop) break;

      let ab = audio.audio.buffer;
      bufferQueueSize++;
      self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
    }

    // When the loop finishes, this chunk is "complete"
    if (!shouldStop) {
      self.postMessage({ status: "complete" });
    }
  }
});
