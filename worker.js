// worker.js - TTS Processing Engine (FIXED)
import { KokoroTTS } from "./kokoro.js";
import { env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js";
import { splitTextSmart } from "./semantic-split.js";

async function detectWebGPU() {
  try {
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
  tts = await KokoroTTS.from_pretrained(model_id, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (progress) => {
      self.postMessage({ status: "loading_model_progress", progress });
    }
  });
}

self.postMessage({ status: "loading_model_ready", voices: tts.voices, device: useWasmFallback ? "wasm" : device });

// --- MEMORY-SAFE QUEUE LOGIC ---
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
    
    // Split text into sentences
    let sentences = splitTextSmart(text, 800);
    let currentTTS = tts;
    let useWasmFallback = false;

    console.log(`Processing ${sentences.length} sentences for chunk`);
    
    // FIX 1: Send total sentence count at start
    self.postMessage({ 
      status: "chunk_start", 
      totalSentences: sentences.length 
    });
    
    // Wait for buffer space
    while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (shouldStop) break;
    }
    if (shouldStop) {
      console.log("Stopped before processing sentences");
      self.postMessage({ status: "complete" });
      return;
    }
    
    let successfulSentences = 0;
    
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      if (shouldStop) break;
      
      // Delay between sentences
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      
      // FIX 2: Wait for buffer space before each sentence
      let waitAttempts = 0;
      while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop) {
        await new Promise(resolve => setTimeout(resolve, 500));
        waitAttempts++;
        
        // FIX 3: Add timeout to prevent infinite waiting
        if (waitAttempts > 60) { // 30 seconds max wait
          console.error("Buffer queue timeout - forcing continue");
          bufferQueueSize = Math.max(0, bufferQueueSize - 1);
          break;
        }
      }
      
      if (shouldStop) break;
      
      try {
        // Timeout for each sentence
        const audioPromise = currentTTS.generate(sentence, { voice, speed });
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Audio generation timeout')), 25000);
        });
        
        const audio = await Promise.race([audioPromise, timeoutPromise]);
        
        if (shouldStop) break;

        let ab = audio.audio.buffer;
        bufferQueueSize++;
        successfulSentences++;
        
        // FIX 4: Send progress with sentence count
        self.postMessage({ 
          status: "stream_audio_data", 
          audio: ab,
          sentenceIndex: i,
          totalSentences: sentences.length
        }, [ab]);
        
        console.log(`Sentence ${i + 1}/${sentences.length} processed (${successfulSentences} successful)`);
        
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
            
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const audio = await currentTTS.generate(sentence, { voice, speed });
            let ab = audio.audio.buffer;
            bufferQueueSize++;
            successfulSentences++;
            
            self.postMessage({ 
              status: "stream_audio_data", 
              audio: ab,
              sentenceIndex: i,
              totalSentences: sentences.length
            }, [ab]);
            
            console.log(`Sentence ${i + 1}/${sentences.length} processed with WASM (${successfulSentences} successful)`);
            
          } catch (wasmError) {
            console.error("WASM fallback failed, skipping sentence:", wasmError.message);
          }
        } else if (audioError.message && audioError.message.includes('timeout')) {
          console.warn("Audio generation timeout, skipping sentence:", sentence.substring(0, 100) + "...");
        } else {
          console.error("Audio generation error, skipping sentence:", audioError.message);
        }
      }
    }

    // FIX 5: Always send complete with success count
    console.log(`Chunk complete: ${successfulSentences}/${sentences.length} sentences processed`);
    self.postMessage({ 
      status: "complete",
      processedSentences: successfulSentences,
      totalSentences: sentences.length
    });
  }
});
