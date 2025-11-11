// worker.js - TTS Processing Engine (Minimal Fix: Small Chunks + Simple Retry)
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
  // MINIMAL FIX: Keep original fp32 model loading (no fp16)
  console.log("Loading KokoroTTS model with fp32 precision (original method)...");
  
  tts = await KokoroTTS.from_pretrained(model_id, {
    dtype: "fp32", // Keep original fp32 - more compatible
    device: "webgpu"
  });
  
} catch (error) {
  console.error("Failed to load KokoroTTS model:", error.message);
  throw new Error("Failed to load KokoroTTS model");
}

console.log("KokoroTTS model loaded successfully");
self.postMessage({ 
  status: "loading_model_ready", 
  voices: tts.voices 
});

self.addEventListener("message", async (e) => {
  if (e.data.type === "generate") {
    const startTime = Date.now();
    let text = e.data.text;
    const voice = e.data.voice || "af_heart";
    const speed = e.data.speed || 1.0;
    
    console.log(`Processing text: "${text.substring(0, 50)}..." (${text.length} chars)`);
    
    // MINIMAL FIX: Use smaller chunks (250 chars instead of 800)
    const maxChunkSize = 250;
    let chunks = [];
    
    if (text.length <= maxChunkSize) {
      // Text is small enough, process as single chunk
      chunks.push(text);
    } else {
      // Split text into smaller chunks (same logic as original, just smaller size)
      const sentences = text.split(/([.!?]+\s*)/); // Split on sentence endings
      let currentChunk = "";
      
      for (let i = 0; i < sentences.length; i += 2) {
        const sentence = sentences[i];
        const punctuation = sentences[i + 1] || "";
        
        if (!sentence.trim()) continue;
        
        const testChunk = currentChunk + sentence + punctuation;
        
        // If adding this sentence would exceed limit, start new chunk
        if (testChunk.length > maxChunkSize && currentChunk.length > 0) {
          chunks.push(currentChunk.trim());
          currentChunk = sentence + punctuation;
        } else {
          currentChunk = testChunk;
        }
      }
      
      // Add final chunk if it has content
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
    }
    
    console.log(`Split text into ${chunks.length} small chunks (max ${maxChunkSize} chars each)`);
    
    // Post initial chunk info for progress tracking
    self.postMessage({
      status: "stream_start",
      total: chunks.length,
      totalChunks: chunks.length, // Add for UI compatibility
      sentencesPerChunk: chunks.map(chunk => (chunk.match(/[.!?]/g) || []).length)
    });
    
    let bufferQueueSize = 0;
    let processedChunks = 0;
    
    // Process chunks sequentially with simple retry logic
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      console.log(`Processing chunk ${chunkIndex + 1}/${chunks.length} (${chunk.length} chars): "${chunk.substring(0, 50)}..."`);
      
      // SIMPLE RETRY: Try up to 3 times with smaller chunks
      let success = false;
      let lastError = null;
      
      for (let attempt = 1; attempt <= 3 && !success; attempt++) {
        try {
          console.log(`Attempt ${attempt}/3 for chunk ${chunkIndex + 1}`);
          
          // Clear buffer and wait before retry (original retry logic)
          bufferQueueSize = 0;
          if (attempt > 1) {
            console.log(`Waiting 2 seconds before retry ${attempt - 1}...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          
          // If this is retry attempt 2+, try with smaller chunk
          let chunkToProcess = chunk;
          if (attempt > 1 && chunk.length > 150) {
            // Try with 70% of the original text
            const words = chunk.split(/\s+/);
            const smallerWordCount = Math.floor(words.length * 0.7);
            chunkToProcess = words.slice(0, smallerWordCount).join(' ');
            console.log(`Retrying with smaller chunk: "${chunkToProcess.substring(0, 30)}..."`);
          }
          
          // Generate audio for this chunk
          const audio = await tts.generate(chunkToProcess, {
            voice,
            speed
          });
          
          // Validate audio data
          if (!audio || audio.length === 0) {
            throw new Error("Generated audio is empty");
          }
          
          // Send audio data
          self.postMessage({ 
            status: "stream_audio_data", 
            audio: audio.buffer 
          }, [audio.buffer]);
          
          processedChunks++;
          success = true;
          console.log(`Chunk ${chunkIndex + 1}/${chunks.length} processed successfully`);
          
          break; // Exit retry loop on success
          
        } catch (error) {
          lastError = error;
          console.warn(`Chunk ${chunkIndex + 1} attempt ${attempt} failed:`, error.message);
          
          // Check if it's a session conflict (don't retry)
          if (error.message && error.message.includes("Session")) {
            console.log("Session conflict detected, moving to next chunk");
            break;
          }
          
          if (attempt === 3) {
            console.error(`All 3 attempts failed for chunk ${chunkIndex + 1}, skipping`);
          }
        }
      }
      
      // Report progress
      self.postMessage({
        status: "chunk_progress",
        chunkIndex: chunkIndex + 1,
        totalChunks: chunks.length,
        successfulChunks: processedChunks,
        sentencesInChunk: 1, // For compatibility
        chunkSize: chunk.length
      });
      
      // Signal buffer processed
      self.postMessage({ type: "buffer_processed" });
    }
    
    const totalTime = Date.now() - startTime;
    console.log(`Chunk processing complete: ${processedChunks}/${chunks.length} chunks successful in ${totalTime}ms`);
    
    // CRITICAL: Only mark as complete if we have meaningful audio data
    if (processedChunks > 0) {
      self.postMessage({ 
        status: "complete", 
        successfulChunks: processedChunks,
        totalChunks: chunks.length,
        processingTime: totalTime
      });
    } else {
      // No chunks succeeded, report as error
      self.postMessage({ 
        status: "error", 
        error: "All chunks failed to process",
        details: lastError?.message
      });
    }
    
  }
});
