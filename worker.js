// worker.js - TTS Processing Engine (Fixed WebGPU Only with Better Text Handling)
import { KokoroTTS } from "./kokoro.js";
import { env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js";
import { splitTextSmart } from "./semantic-split.js";

async function detectWebGPU() {
  try {
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
  throw error;
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
  throw initialError;
}

self.postMessage({ status: "loading_model_ready", voices: tts.voices, device: "webgpu" });

// --- MEMORY-SAFE QUEUE LOGIC ---
let bufferQueueSize = 0;
const MAX_QUEUE_SIZE = 6;
let shouldStop = false;

// IMPROVED: Better text chunking function
function chunkTextBetter(text, minChars = 400, maxChars = 800) {
  // First split by sentences
  const sentences = text.split(/[.!?]+(?:\s+|$)/).filter(s => s.trim().length > 0);
  const chunks = [];
  let currentChunk = '';
  
  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;
    
    // If adding this sentence would exceed max, start a new chunk
    if (currentChunk && (currentChunk + '. ' + trimmedSentence).length > maxChars) {
      if (currentChunk.length >= minChars) {
        chunks.push(currentChunk.trim() + '.');
        currentChunk = trimmedSentence;
      } else {
        // Current chunk is too small, add sentence anyway
        currentChunk += (currentChunk ? '. ' : '') + trimmedSentence;
      }
    } else {
      // Add sentence to current chunk
      currentChunk += (currentChunk ? '. ' : '') + trimmedSentence;
    }
  }
  
  // Add final chunk if it has content
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim() + '.');
  }
  
  console.log(`Text chunked into ${chunks.length} chunks, avg ${Math.round(text.length / chunks.length)} chars`);
  return chunks;
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
    
    // Use improved chunking instead of splitTextSmart
    let sentences = chunkTextBetter(text, 400, 800);

    console.log(`Processing ${sentences.length} chunks with improved text handling`);
    
    // Report chunk info
    self.postMessage({ 
      status: "chunk_progress", 
      sentencesInChunk: sentences.length,
      totalEstimated: sentences.length
    });
    
    // Wait for buffer space
    let waitAttempts = 0;
    const MAX_WAIT_ATTEMPTS = 60;
    while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop && waitAttempts < MAX_WAIT_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, 500));
      waitAttempts++;
    }
    
    if (shouldStop) {
      self.postMessage({ status: "complete" });
      return;
    }
    
    let successfulChunks = 0;
    
    for (let i = 0; i < sentences.length; i++) {
      const chunk = sentences[i];
      if (shouldStop) break;
      
      // Delay between chunks
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      
      try {
        // Add validation for chunk content
        if (!chunk || chunk.trim().length < 10) {
          console.warn(`Skipping empty or too short chunk ${i + 1}`);
          continue;
        }
        
        console.log(`Processing chunk ${i + 1}/${sentences.length} (${chunk.length} chars): "${chunk.substring(0, 50)}..."`);
        
        // Simple timeout for each chunk (30 seconds)
        const audioPromise = tts.generate(chunk, { voice, speed });
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Audio generation timeout')), 30000);
        });
        
        const audio = await Promise.race([audioPromise, timeoutPromise]);
        
        if (shouldStop) break;
        
        // Validate audio output
        if (!audio || !audio.audio || !audio.audio.buffer || audio.audio.buffer.byteLength === 0) {
          console.warn(`Invalid audio output for chunk ${i + 1}, skipping`);
          continue;
        }
        
        let ab = audio.audio.buffer;
        bufferQueueSize++;
        self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
        successfulChunks++;
        
        console.log(`Chunk ${i + 1}/${sentences.length} processed successfully (${successfulChunks}/${i + 1} total successful)`);
        
      } catch (audioError) {
        console.warn(`Chunk ${i + 1} failed:`, audioError.message);
        // Continue to next chunk
      }
    }

    console.log(`Chunk processing complete: ${successfulChunks}/${sentences.length} chunks successful`);
    self.postMessage({ 
      status: "complete",
      processedSentences: sentences.length,
      successfulChunks: successfulChunks
    });
  }
});
