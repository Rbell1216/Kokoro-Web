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
let useWasmFallback = false;

if (self.location.hostname === "localhost2") {
  env.allowLocalModels = true;
  model_id = "./my_model/";
}

let tts = null;
try {
  tts = await KokoroTTS.from_pretrained(model_id, {
    dtype: device === "wasm" ? "q8" : "fp32", device,
    //dtype: "fp16",
    progress_callback: (progress) => {
      self.postMessage({ status: "loading_model_progress", progress });
    }
  });
} catch (initialError) {
  console.warn("Failed to load model with WebGPU, falling back to WASM:", initialError.message);
  useWasmFallback = true;
  tts = await KokoroTTS.from_pretrained(model_id, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (progress) => {
      self.postMessage({ status: "loading_model_progress", progress });
    }
  });
}

self.postMessage({ status: "loading_model_ready", voices: tts.voices, device: useWasmFallback ? "wasm" : device });

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
    let currentTTS = tts;
    let webgpuRetryCount = 0;
    const MAX_WEBGPU_RETRIES = 2;

    for (const sentence of sentences) {
      if (shouldStop) break;

      while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (shouldStop) break;
      }
      if (shouldStop) break;
      
      let sentenceProcessed = false;
      
      for (let attempt = 0; attempt < (webgpuRetryCount < MAX_WEBGPU_RETRIES ? 2 : 1); attempt++) {
        if (shouldStop) break;
        
        try {
          // Add timeout to prevent hanging
          const audioPromise = currentTTS.generate(sentence, { voice, speed });
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Audio generation timeout')), 30000); // 30 second timeout
          });
          
          const audio = await Promise.race([audioPromise, timeoutPromise]);
          
          if (shouldStop) break;

          let ab = audio.audio.buffer;
          bufferQueueSize++;
          self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
          sentenceProcessed = true;
          break; // Success, exit retry loop
          
        } catch (audioError) {
          const isWebGPUError = audioError.message && 
            (audioError.message.includes('GPUBuffer') || 
             audioError.message.includes('webgpu') ||
             audioError.name === 'AbortError');
          
          if (isWebGPUError && webgpuRetryCount < MAX_WEBGPU_RETRIES && !useWasmFallback) {
            console.warn(`WebGPU error on attempt ${attempt + 1}, retrying with WASM:`, audioError.message);
            webgpuRetryCount++;
            // Switch to WASM for this sentence
            try {
              if (!currentTTS._wasmFallback) {
                currentTTS._wasmFallback = await KokoroTTS.from_pretrained(model_id, {
                  dtype: "q8",
                  device: "wasm"
                });
              }
              currentTTS = currentTTS._wasmFallback;
            } catch (fallbackError) {
              console.error("Failed to initialize WASM fallback:", fallbackError);
              break; // Exit retry loop on fallback failure
            }
          } else if (attempt === 0) {
            console.error("Audio generation error:", audioError);
            // Try to continue with next sentence for non-WebGPU errors
            break;
          } else {
            console.error("All retry attempts failed for sentence:", sentence.substring(0, 100) + "...");
            break;
          }
        }
      }
      
      // If sentence processing failed completely, continue with next sentence
      if (!sentenceProcessed) {
        console.warn("Skipping failed sentence, continuing with next one");
        continue;
      }
    }

    // When the loop finishes, this chunk is "complete"
    if (!shouldStop) {
      self.postMessage({ status: "complete" });
    }
  }
});
