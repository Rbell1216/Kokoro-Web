// worker.js - WebGPU Only with Retry Mechanism
import { KokoroTTS } from "./kokoro.js";
import { env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js";
import { splitTextSmart } from "./semantic-split.js";

// WebGPU ONLY - No WASM fallback to prevent memory/context conflicts
async function detectWebGPU() {
  try {
    if (!('gpu' in navigator)) {
      throw new Error("WebGPU not supported in this browser");
    }
    
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("No WebGPU adapter found");
    }
    
    console.log("WebGPU adapter found:", adapter.info.device || 'Unknown');
    return true;
  } catch (error) {
    throw new Error(`WebGPU detection failed: ${error.message}`);
  }
}

const useWebGPU = await detectWebGPU();
self.postMessage({ status: "loading_model_start", device: "webgpu" });

let model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";

if (self.location.hostname === "localhost2") {
  env.allowLocalModels = true;
  model_id = "./my_model/";
}

let tts = null;
try {
  tts = await KokoroTTS.from_pretrained(model_id, {
    dtype: "fp32", device: "webgpu",
    progress_callback: (progress) => {
      self.postMessage({ status: "loading_model_progress", progress });
    }
  });
} catch (error) {
  console.error("Failed to load KokoroTTS model:", error);
  self.postMessage({ status: "error", message: `Model loading failed: ${error.message}` });
  return;
}

self.postMessage({ status: "loading_model_ready", voices: tts.voices, device: "webgpu" });

// --- MEMORY-SAFE QUEUE LOGIC ---
let bufferQueueSize = 0;
const MAX_QUEUE_SIZE = 4; // Reduced to prevent memory issues
let shouldStop = false;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 3; // Reset after this many errors
// --- END QUEUE LOGIC ---

self.addEventListener("message", async (e) => {
  const { type, text, voice, speed } = e.data;
  
  if (type === "stop") {
    shouldStop = true;
    bufferQueueSize = 0;
    consecutiveErrors = 0;
    console.log("Stop command received, stopping generation");
    return;
  }

  if (type === "buffer_processed") {
    bufferQueueSize = Math.max(0, bufferQueueSize - 1);
    return;
  }

  if (type === "generate" && text) { 
    shouldStop = false;
    
    // Ensure valid voice ID is used
    if (!voice || !tts.voices[voice]) {
      console.warn(`Invalid voice "${voice}", defaulting to "af_heart". Available voices:`, Object.keys(tts.voices));
      voice = "af_heart";
    }
    
    // Process text into 250-char chunks for reliability
    let sentences = splitTextSmart(text, 250);
    
    console.log(`Processing chunk with ${sentences.length} sentences using WebGPU`);
    
    // Report progress
    self.postMessage({ 
      status: "chunk_progress", 
      sentencesInChunk: sentences.length,
      totalEstimated: sentences.length
    });
    
    // Wait for buffer space (shorter timeout to prevent hanging)
    let waitAttempts = 0;
    const MAX_WAIT_ATTEMPTS = 30; // 15 seconds max wait
    while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop && waitAttempts < MAX_WAIT_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, 300));
      waitAttempts++;
    }
    
    if (shouldStop) {
      self.postMessage({ status: "complete" });
      return;
    }
    
    if (waitAttempts >= MAX_WAIT_ATTEMPTS) {
      console.warn("Buffer queue timeout, proceeding with smaller queue");
      bufferQueueSize = Math.min(bufferQueueSize, 2); // Force smaller queue
    }
    
    // Process sentences with retry mechanism
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      if (shouldStop) break;
      
      // Shorter delay between sentences to prevent timeouts
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      
      let sentenceSuccess = false;
      let retryCount = 0;
      const MAX_RETRIES = 3;
      
      // Retry mechanism for each sentence
      while (!sentenceSuccess && retryCount <= MAX_RETRIES && !shouldStop) {
        try {
          // Shorter timeout for each sentence (10 seconds)
          const audioPromise = tts.generate(sentence, { voice, speed });
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Sentence generation timeout')), 10000);
          });
          
          const audio = await Promise.race([audioPromise, timeoutPromise]);
          
          if (shouldStop) break;

          let ab = audio.audio.buffer;
          bufferQueueSize++;
          self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
          
          console.log(`Sentence ${i + 1}/${sentences.length} processed successfully (attempt ${retryCount + 1})`);
          sentenceSuccess = true;
          consecutiveErrors = 0; // Reset error counter on success
          
        } catch (sentenceError) {
          retryCount++;
          consecutiveErrors++;
          
          console.warn(`Sentence ${i + 1} attempt ${retryCount} failed:`, sentenceError.message);
          
          if (retryCount <= MAX_RETRIES) {
            // Exponential backoff: 1s, 2s, 4s
            const delay = Math.pow(2, retryCount - 1) * 1000;
            console.log(`Retrying sentence ${i + 1} in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            console.error(`Sentence ${i + 1} failed after ${MAX_RETRIES} retries, skipping:`, sentence.substring(0, 50) + "...");
            break;
          }
          
          // Reset TTS instance if too many consecutive errors
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.warn("Too many consecutive errors, resetting TTS instance...");
            try {
              // Force garbage collection hint
              if (typeof gc === 'function') gc();
              
              // Create new TTS instance
              tts = await KokoroTTS.from_pretrained(model_id, {
                dtype: "fp32", device: "webgpu",
                progress_callback: () => {} // Silent reload
              });
              
              console.log("TTS instance reset successfully");
              consecutiveErrors = 0;
            } catch (resetError) {
              console.error("Failed to reset TTS instance:", resetError.message);
              break;
            }
          }
        }
      }
      
      // If we've had too many total failures, stop processing
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS * 2) {
        console.error("Too many consecutive failures, stopping chunk processing");
        break;
      }
    }

    // Always send complete message
    console.log(`Chunk processing complete with retry mechanism`);
    self.postMessage({ 
      status: "complete",
      processedSentences: sentences.length
    });
  }
});
