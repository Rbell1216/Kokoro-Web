// worker.js - TTS Processing Engine
import { KokoroTTS } from "./kokoro.js";
import { env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js";
import { splitTextSmart } from "./semantic-split.js";

async function detectWebGPU() {
  try {
    // Check if WebGPU is supported
    if (!('gpu' in navigator)) {
      console.log("WebGPU not supported in this browser, using WASM");
      return false;
    }
    
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      console.log("No WebGPU adapter found, using WASM");
      return false;
    }
    
    console.log("WebGPU adapter found:", adapter.info.device || 'Unknown');
    return true;
  } catch (error) {
    console.warn("WebGPU detection failed:", error.message, "using WASM");
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
      
      try {
        const audio = await tts.generate(sentence, { voice, speed }); 
        if (shouldStop) break;

        let ab = audio.audio.buffer;
        bufferQueueSize++;
        self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
      } catch (audioError) {
        if (audioError.message && audioError.message.includes('GPUBuffer')) {
          console.error("WebGPU buffer error during audio generation:", audioError);
          self.postMessage({ status: "error", error: "WebGPU buffer lost. Please try again." });
          break;
        } else {
          console.error("Audio generation error:", audioError);
          // Continue with next sentence for other errors
          continue;
        }
      }
    }

    // When the loop finishes, this chunk is "complete"
    if (!shouldStop) {
      self.postMessage({ status: "complete" });
    }
  }
});
