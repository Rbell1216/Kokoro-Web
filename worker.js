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
    
    // MODERATE APPROACH: Process 2-3 sentences per chunk to balance speed and reliability
    let sentences = splitTextSmart(text, 800); // Process 2-3 sentences per chunk
    let currentTTS = tts;
    let useWasmFallback = false;

    console.log(`Processing ${sentences.length} sentences per chunk for better speed`);
    
    // CRITICAL FIX: Always report the total sentences being processed
    self.postMessage({ 
      status: "chunk_progress", 
      sentencesInChunk: sentences.length,
      totalEstimated: sentences.length
    });
    
    // Wait for buffer space with timeout to prevent infinite wait
    let waitAttempts = 0;
    const MAX_WAIT_ATTEMPTS = 60; // 30 seconds max wait
    while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop && waitAttempts < MAX_WAIT_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, 500));
      waitAttempts++;
    }
    
    if (shouldStop) {
      self.postMessage({ status: "complete" });
      return;
    }
    
    if (waitAttempts >= MAX_WAIT_ATTEMPTS) {
      console.warn("Buffer queue timeout, proceeding anyway");
    }
    
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      if (shouldStop) break;
      
      // Moderate delay between sentences (not too long)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 800)); // Reduced from 1500 to 800ms
      }
      
      try {
        // Simple timeout for each sentence (25 seconds)
        const audioPromise = currentTTS.generate(sentence, { voice, speed });
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Audio generation timeout')), 25000);
        });
        
        const audio = await Promise.race([audioPromise, timeoutPromise]);
        
        if (shouldStop) break;

        let ab = audio.audio.buffer;
        bufferQueueSize++;
        self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
        
        console.log(`Sentence ${i + 1}/${sentences.length} processed successfully`);
        
      } catch (audioError) {
        const isWebGPUError = audioError.message && 
          (audioError.message.includes('GPUBuffer') || 
           audioError.message.includes('webgpu') ||
           audioError.name === 'AbortError');
        
        const isSessionError = audioError.message && 
          audioError.message.includes('Session already started');
        
        if (isSessionError || (isWebGPUError && !useWasmFallback)) {
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
            
            // Shorter delay for WASM retry
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const audio = await currentTTS.generate(sentence, { voice, speed });
            let ab = audio.audio.buffer;
            bufferQueueSize++;
            self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
            
            console.log(`Sentence ${i + 1}/${sentences.length} processed with WASM fallback`);
            
          } catch (wasmError) {
            console.error("WASM fallback failed, skipping sentence:", wasmError.message);
            // Continue to next sentence
          }
        } else if (audioError.message && audioError.message.includes('timeout')) {
          console.warn("Audio generation timeout, skipping sentence:", sentence.substring(0, 100) + "...");
        } else {
          console.error("Audio generation error, skipping sentence:", audioError.message);
          // Continue to next sentence for any other errors
        }
      }
    }

    // Always send complete message to prevent hanging
    console.log(`Chunk processing complete with ${sentences.length} sentences`);
    self.postMessage({ 
      status: "complete",
      processedSentences: sentences.length
    });
  }
});
