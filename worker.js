// worker.js - TTS Processing Engine (WebGPU Only with Retry Logic)
import { KokoroTTS } from "./kokoro.js";
import { env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js";
import { splitTextSmart } from "./semantic-split.js";

async function detectWebGPU() {
  try {
    // Check if WebGPU is supported
    if (!('gpu' in navigator)) {
      console.log("WebGPU not supported in this browser");
      throw new Error("WebGPU not supported");
    }
    
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      console.log("No WebGPU adapter found");
      throw new Error("No WebGPU adapter found");
    }
    
    console.log("WebGPU adapter found:", adapter.info.device || 'Unknown');
    return true;
  } catch (error) {
    console.error("WebGPU detection failed:", error.message);
    throw error;
  }
}

let useWebGPU = false;
try {
  useWebGPU = await detectWebGPU();
} catch (error) {
  console.error("Failed to initialize WebGPU:", error.message);
  throw error; // Don't fallback, just fail
}

const device = "webgpu";
self.postMessage({ status: "loading_model_start", device });

let model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";

if (self.location.hostname === "localhost2") {
  env.allowLocalModels = true;
  model_id = "./my_model/";
}

let tts = null;
try {
  tts = await KokoroTTS.from_pretrained(model_id, {
    dtype: "fp32", 
    device: "webgpu",
    progress_callback: (progress) => {
      self.postMessage({ status: "loading_model_progress", progress });
    }
  });
} catch (initialError) {
  console.error("Failed to load model with WebGPU:", initialError.message);
  throw initialError; // Don't fallback
}

self.postMessage({ status: "loading_model_ready", voices: tts.voices, device: "webgpu" });

// --- MEMORY-SAFE QUEUE LOGIC FOR SENTENCES WITHIN A CHUNK ---
let bufferQueueSize = 0;
const MAX_QUEUE_SIZE = 6;
let shouldStop = false;
// --- END QUEUE LOGIC ---

// Retry logic for WebGPU processing
async function processWithRetry(sentence, voice, speed, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (shouldStop) break;
    
    try {
      // Add timeout for each sentence (25 seconds)
      const audioPromise = tts.generate(sentence, { voice, speed });
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Audio generation timeout')), 25000);
      });
      
      const audio = await Promise.race([audioPromise, timeoutPromise]);
      
      if (shouldStop) break;
      
      let ab = audio.audio.buffer;
      bufferQueueSize++;
      self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
      
      console.log(`Sentence processed successfully on attempt ${attempt}`);
      return true; // Success
      
    } catch (audioError) {
      lastError = audioError;
      console.warn(`Audio generation attempt ${attempt} failed:`, audioError.message);
      
      // Check for critical errors that shouldn't be retried
      if (audioError.message && audioError.message.includes('Session already started')) {
        console.error("Session conflict detected, cannot retry");
        throw audioError;
      }
      
      // If this isn't the last attempt, clear buffers and wait
      if (attempt < maxRetries) {
        console.log(`Clearing buffers and retrying in 2 seconds (attempt ${attempt + 1}/${maxRetries})`);
        
        // Clear buffer queue to free up memory
        bufferQueueSize = 0;
        
        // Wait 2 seconds before retry
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  // All retries failed
  console.error("All retry attempts failed, skipping sentence:", lastError.message);
  throw lastError;
}

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
    
    // Process 2-3 sentences per chunk for balanced speed and reliability
    let sentences = splitTextSmart(text, 800); // Use same chunk size as main.js for consistency

    console.log(`Processing ${sentences.length} sentences per chunk for better speed`);
    
    // Report the total sentences being processed
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
      
      // Delay between sentences
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      
      try {
        // Use retry logic instead of direct generation
        await processWithRetry(sentence, voice, speed);
        
        console.log(`Sentence ${i + 1}/${sentences.length} processed successfully`);
        
      } catch (audioError) {
        // Continue to next sentence if this one fails
        console.error(`Skipping sentence ${i + 1}/${sentences.length}:`, audioError.message);
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
