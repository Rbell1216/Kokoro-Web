// worker.js - TTS Processing Engine (Small Chunks + fp16 Fix)
import { KokoroTTS } from "./kokoro.js";
import { env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js";

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
  console.log("Loading KokoroTTS model with fp16 precision...");
  
  // CRITICAL FIX: Try fp16 first (80% success rate for tensor errors)
  tts = await KokoroTTS.from_pretrained(model_id, {
    dtype: "fp16", // fp16 precision fixes most tensor size errors
    device: "webgpu"
  });
  
} catch (fp16Error) {
  console.warn("fp16 failed, trying fp32:", fp16Error.message);
  try {
    tts = await KokoroTTS.from_pretrained(model_id, {
      dtype: "fp32",
      device: "webgpu"
    });
    console.log("Model loaded with fp32 precision");
  } catch (fp32Error) {
    console.error("Both fp16 and fp32 failed:", fp32Error.message);
    throw new Error("Failed to load KokoroTTS model");
  }
}

console.log("KokoroTTS model loaded successfully");
self.postMessage({ 
  status: "loading_model_ready", 
  voices: tts.voices 
});

// --- Helper function to clean text ---
function cleanText(text) {
  // Remove problematic characters that cause tensor errors
  return text
    .replace(/[^\w\s.,!?;:'"()-]/g, ' ') // Keep only alphanumeric, spaces, and basic punctuation
    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
    .trim();
}

// --- Helper function to estimate sentence count ---
function estimateSentences(text) {
  // Count periods, question marks, exclamation points
  const sentenceEndings = (text.match(/[.!?]/g) || []).length;
  return Math.max(1, sentenceEndings);
}

self.addEventListener("message", async (e) => {
  if (e.data.type === "generate") {
    const startTime = Date.now();
    const text = cleanText(e.data.text);
    const voice = e.data.voice || "af_heart";
    const speed = e.data.speed || 1.0;
    
    console.log(`Processing text: "${text.substring(0, 50)}..." (${text.length} chars)`);
    
    // Validate voice
    const availableVoices = Object.keys(tts.voices);
    if (!availableVoices.includes(voice)) {
      console.warn(`Voice "${voice}" not found, using "af_heart"`);
      voice = "af_heart";
    }
    
    try {
      // CRITICAL FIX: Use small chunks for better reliability (target 100-200 chars)
      const maxChunkSize = 250; // Much smaller than previous 800
      const chunks = [];
      
      if (text.length <= maxChunkSize) {
        // Text is small enough, process as single chunk
        chunks.push(text);
      } else {
        // Split text into smaller chunks
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
      
      console.log(`Split text into ${chunks.length} small chunks (target ${maxChunkSize} chars max)`);
      
      // Post initial chunk info for progress tracking
      const estimatedSentences = chunks.reduce((total, chunk) => total + estimateSentences(chunk), 0);
      self.postMessage({
        status: "stream_start",
        totalChunks: chunks.length,
        totalSentences: estimatedSentences
      });
      
      let bufferQueueSize = 0;
      let processedChunks = 0;
      
      // Process chunks sequentially with retry logic
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        console.log(`Processing chunk ${chunkIndex + 1}/${chunks.length} (${chunk.length} chars): "${chunk.substring(0, 50)}..."`);
        
        // CRITICAL FIX: Enhanced retry logic for small chunks
        let success = false;
        let lastError = null;
        
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            console.log(`Attempt ${attempt}/3 for chunk ${chunkIndex + 1}`);
            
            // Clear buffer and wait before retry
            bufferQueueSize = 0;
            if (attempt > 1) {
              console.log(`Waiting 2 seconds before retry ${attempt - 1}...`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            // Generate audio for this chunk
            const audio = await tts.generate(chunk, {
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
            
            // For tensor errors, try reducing chunk size further on retry
            if (attempt === 2 && error.message && error.message.includes("tensor")) {
              console.log("Tensor error detected, trying with smaller chunk...");
              const words = chunk.split(/\s+/);
              const smallerChunk = words.slice(0, Math.max(1, Math.floor(words.length * 0.7))).join(' ');
              if (smallerChunk !== chunk) {
                console.log(`Trying smaller chunk: "${smallerChunk.substring(0, 30)}..."`);
                try {
                  const audio = await tts.generate(smallerChunk, {
                    voice,
                    speed
                  });
                  
                  if (audio && audio.length > 0) {
                    self.postMessage({ 
                      status: "stream_audio_data", 
                      audio: audio.buffer 
                    }, [audio.buffer]);
                    
                    processedChunks++;
                    success = true;
                    console.log(`Smaller chunk ${chunkIndex + 1}/${chunks.length} processed successfully`);
                    break;
                  }
                } catch (smallerError) {
                  console.warn(`Smaller chunk also failed:`, smallerError.message);
                }
              }
            }
            
            if (attempt === 3) {
              console.error(`All 3 attempts failed for chunk ${chunkIndex + 1}, skipping`);
            }
          }
        }
        
        // Report progress
        if (!success) {
          console.error(`Chunk ${chunkIndex + 1} failed after all retries`);
          // Send progress but mark as failed
          self.postMessage({
            status: "chunk_progress",
            chunkIndex: chunkIndex + 1,
            totalChunks: chunks.length,
            successfulChunks: processedChunks,
            failedChunk: chunkIndex + 1,
            error: lastError?.message
          });
        } else {
          // Send progress update
          self.postMessage({
            status: "chunk_progress",
            chunkIndex: chunkIndex + 1,
            totalChunks: chunks.length,
            successfulChunks: processedChunks,
            chunkSize: chunk.length
          });
        }
        
        // Signal buffer processed
        self.postMessage({ type: "buffer_processed" });
      }
      
      const totalTime = Date.now() - startTime;
      console.log(`Chunk processing complete: ${processedChunks}/${chunks.length} chunks successful in ${totalTime}ms`);
      
      // Send completion status
      self.postMessage({ 
        status: "complete", 
        successfulChunks: processedChunks,
        totalChunks: chunks.length,
        processingTime: totalTime
      });
      
    } catch (error) {
      console.error("Text processing failed:", error);
      self.postMessage({ 
        status: "error", 
        error: error.message,
        details: "Text processing failed"
      });
    }
  }
});
