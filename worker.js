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
  dtype: device === "wasm" ? "q8" : "fp32", // This is the auto-select logic
  device,
  progress_callback: (progress) => {
    self.postMessage({ status: "loading_model_progress", progress });
  }
}).catch((e) => {
  self.postMessage({ status: "error", error: e.message });
  throw e;
});

self.postMessage({ status: "loading_model_ready", voices: tts.voices, device });

// --- THIS IS THE MEMORY-SAFE QUEUE LOGIC ---
let bufferQueueSize = 0;
const MAX_QUEUE_SIZE = 6; // Work ahead by 6 chunks
let shouldStop = false;
// --- END QUEUE LOGIC ---

self.addEventListener("message", async (e) => {
  const { type, text, voice, speed } = e.data; // <-- Get speed from the message
  
  if (type === "stop") {
    bufferQueueSize = 0;
    shouldStop = true;
    console.log("Stop command received, stopping generation");
    return;
  }

  // --- THIS IS THE MEMORY-SAFE QUEUE LOGIC ---
  if (type === "buffer_processed") {
    bufferQueueSize = Math.max(0, bufferQueueSize - 1); // Free up a slot
    return;
  }
  // --- END QUEUE LOGIC ---

  if (type === "generate" && text) { 
    shouldStop = false;
    let chunks = splitTextSmart(text, 300); 
    
    self.postMessage({ status: "chunk_count", count: chunks.length });

    for (const chunk of chunks) {
      if (shouldStop) {
        console.log("Stopping audio generation");
        self.postMessage({ status: "complete" });
        break;
      }
      console.log(chunk);

      // --- THIS IS THE MEMORY-SAFE QUEUE LOGIC ---
      // Wait if the queue is full
      while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop) {
        console.log("Waiting for buffer space...");
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 sec
        if (shouldStop) break;
      }

      if (shouldStop) {
        console.log("Stopping after queue wait");
        self.postMessage({ status: "complete" });
        break;
      }
      // --- END QUEUE LOGIC ---
      
      const audio = await tts.generate(chunk, { voice, speed }); 
      let ab = audio.audio.buffer;

      bufferQueueSize++; // Increment the queue size
      self.postMessage({ status: "stream_audio_data", audio: ab, text: chunk }, [ab]);
    }

    if (!shouldStop) {
      self.postMessage({ status: "complete" });
    }
  }
});
