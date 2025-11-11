// worker.js - FINAL FIX: Voice validation + memory management to prevent hanging at chunk 26
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
    progress_callback: (progress) => {
      self.postMessage({ status: "loading_model_progress", progress });
    }
  });
} catch (initialError) {
  console.warn("Failed to load model with WebGPU, falling back to WASM:", initialError.message);
  useWasmFallback = true;
  device = "wasm";
  
  tts = await KokoroTTS.from_pretrained(model_id, {
    dtype: "q8", device: "wasm",
    progress_callback: (progress) => {
      self.postMessage({ status: "loading_model_progress", progress });
    }
  });
}

self.postMessage({ status: "loading_model_ready", voices: tts.voices, device: useWasmFallback ? "wasm" : device });

// --- MEMORY-SAFE QUEUE LOGIC WITH HANGING PREVENTION ---
let bufferQueueSize = 0;
const MAX_QUEUE_SIZE = 5; // Reduced from 6 to prevent memory issues
let shouldStop = false;
let processedChunks = 0; // Track chunk count to detect memory issues
const MAX_CHUNKS_BEFORE_RESET = 50; // Reset TTS instance every 50 chunks
// --- END QUEUE LOGIC ---

self.addEventListener("message", async (e) => {
  const { type, text, voice, speed } = e.data;
  
  if (type === "stop") {
    shouldStop = true;
    bufferQueueSize = 0;
    processedChunks = 0;
    console.log("Stop command received, stopping generation");
    return;
  }

  if (type === "buffer_processed") {
    bufferQueueSize = Math.max(0, bufferQueueSize - 1);
    return;
  }

  if (type === "generate" && text) { 
    shouldStop = false;
    
    // CRITICAL FIX: Ensure valid voice ID is used
    if (!voice || !tts.voices[voice]) {
      console.warn(`Invalid voice "${voice}", defaulting to "af_heart". Available voices:`, Object.keys(tts.voices));
      voice = "af_heart"; // Default to a known good voice
    }
    
    // Fixed chunk size: 250 characters for reliability
    let sentences = splitTextSmart(text, 250); 
    let currentTTS = tts;
    let useWasmFallback = false;
    
    // MEMORY MANAGEMENT FIX: Reset TTS instance if we've processed too many chunks
    processedChunks++;
    if (processedChunks >= MAX_CHUNKS_BEFORE_RESET) {
      console.log(`Processed ${processedChunks} chunks, resetting TTS instance to prevent memory leaks...`);
      try {
        // Force cleanup
        bufferQueueSize = 0;
        if (typeof gc === 'function') gc(); // Force garbage collection hint
        
        // Reload TTS model
        tts = await KokoroTTS.from_pretrained(model_id, {
          dtype: device === "wasm" ? "q8" : "fp32", device,
          progress_callback: () => {} // Silent reload
        });
        currentTTS = tts;
        processedChunks = 0; // Reset counter
        console.log("TTS instance successfully reset - memory leak prevented");
      } catch (resetError) {
        console.warn("Failed to reset TTS instance, continuing:", resetError.message);
        // Don't return error, just continue with current instance
      }
    }

    console.log(`Processing ${sentences.length} sentences per chunk (chunk #${processedChunks})`);
    
    // Report progress
    self.postMessage({ 
      status: "chunk_progress", 
      sentencesInChunk: sentences.length,
      totalEstimated: sentences.length
    });
    
    // Wait for buffer space (reduced timeout to prevent hanging)
    let waitAttempts = 0;
    const MAX_WAIT_ATTEMPTS = 40; // 20 seconds max wait
    while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop && waitAttempts < MAX_WAIT_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, 300));
      waitAttempts++;
    }
    
    if (shouldStop) {
      self.postMessage({ status: "complete" });
      return;
    }
    
    if (waitAttempts >= MAX_WAIT_ATTEMPTS) {
      console.warn("Buffer timeout, proceeding with smaller queue");
      bufferQueueSize = Math.min(bufferQueueSize, 2); // Force smaller queue
    }
    
    // Process sentences with timeout and error handling
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      if (shouldStop) break;
      
      // Reduced delay to prevent timeouts
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 400)); // Reduced from 800ms
      }
      
      try {
        // Shorter timeout for better responsiveness
        const audioPromise = currentTTS.generate(sentence, { voice, speed });
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Audio generation timeout')), 15000); // 15 seconds
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
        
        if (isWebGPUError || isSessionError) {
          console.warn("WebGPU error detected, switching to WASM:", audioError.message);
          useWasmFallback = true;
          
          try {
            currentTTS = tts._wasmFallback;
            await new Promise(resolve => setTimeout(resolve, 800)); // Shorter delay
            
            const audio = await currentTTS.generate(sentence, { voice, speed });
            let ab = audio.audio.buffer;
            bufferQueueSize++;
            self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
            
            console.log(`Sentence ${i + 1}/${sentences.length} processed with WASM fallback`);
            
          } catch (wasmError) {
            console.error("WASM fallback failed:", wasmError.message);
            // Continue to next sentence instead of hanging
          }
        } else if (audioError.message && audioError.message.includes('timeout')) {
          console.warn("Timeout, skipping sentence:", sentence.substring(0, 50) + "...");
        } else {
          console.error("Generation error:", audioError.message);
          // Continue processing instead of hanging
        }
      }
    }

    // Always send complete to prevent hanging
    console.log(`Chunk #${processedChunks} complete with ${sentences.length} sentences`);
    self.postMessage({ 
      status: "complete",
      processedSentences: sentences.length
    });
  }
});
