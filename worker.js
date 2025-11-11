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
    
    // CRITICAL FIX: Process ONLY ONE sentence per chunk to avoid session conflicts
    // The main app will send each sentence as a separate chunk
    let sentences = splitTextSmart(text, 1000); // High limit, we'll take only first sentence
    let currentTTS = tts;
    let useWasmFallback = false;

    // Take only the first sentence to ensure single-session processing
    let sentence = sentences[0] || text.trim();
    
    console.log(`Processing single sentence: "${sentence.substring(0, 50)}..." with session-safe approach`);

    // Wait for buffer space
    while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (shouldStop) break;
    }
    if (shouldStop) {
      self.postMessage({ status: "complete" }); // Complete anyway to prevent hanging
      return;
    }
    
    try {
      // Add delay before processing to ensure session is free
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Simple timeout for each sentence (30 seconds)
      const audioPromise = currentTTS.generate(sentence, { voice, speed });
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Audio generation timeout')), 30000);
      });
      
      const audio = await Promise.race([audioPromise, timeoutPromise]);
      
      if (shouldStop) {
        self.postMessage({ status: "complete" }); // Complete anyway to prevent hanging
        return;
      }

      let ab = audio.audio.buffer;
      bufferQueueSize++;
      self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
      
      console.log(`Single sentence processed successfully: ${sentence.length} chars`);
      
    } catch (audioError) {
      const isWebGPUError = audioError.message && 
        (audioError.message.includes('GPUBuffer') || 
         audioError.message.includes('webgpu') ||
         audioError.name === 'AbortError');
      
      const isSessionError = audioError.message && 
        audioError.message.includes('Session already started');
      
      if (isSessionError || isWebGPUError) {
        console.warn("Session/WebGPU error, falling back to WASM:", audioError.message);
        useWasmFallback = true;
        try {
          if (!tts._wasmFallback) {
            console.log("Initializing WASM fallback model...");
            tts._wasmFallback = await KokoroTTS.from_pretrained(model_id, {
              dtype: "q8",
              device: "wasm"
            });
          }
          currentTTS = tts._wasmFallback;
          
          // Add longer delay before retrying with WASM
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          const audio = await currentTTS.generate(sentence, { voice, speed });
          let ab = audio.audio.buffer;
          bufferQueueSize++;
          self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
          
          console.log(`Single sentence processed with WASM fallback`);
          
        } catch (wasmError) {
          console.error("WASM fallback failed:", wasmError.message);
          // Continue to complete anyway to prevent hanging
        }
      } else if (audioError.message && audioError.message.includes('timeout')) {
        console.warn("Audio generation timeout:", sentence.substring(0, 100) + "...");
      } else {
        console.error("Audio generation error:", audioError.message);
        // Continue to complete anyway to prevent hanging
      }
    }

    // CRITICAL: Always send complete message to prevent hanging
    // The main app will handle processing the next sentence as a new chunk
    console.log(`Single-sentence chunk complete, sending final message`);
    self.postMessage({ status: "complete" });
  }
});
