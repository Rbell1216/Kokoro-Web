// worker.js - WebGPU-Only Version (Minimal Changes)
// Keep proven 250-character chunk size, add WebGPU-only mode
import { KokoroTTS } from "./kokoro.js";
import { env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js";
import { splitTextSmart } from "./semantic-split.js";

async function detectWebGPU() {
  try {
    // Check if WebGPU is supported
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
    throw new Error("WebGPU detection failed: " + error.message);
  }
}

// WEBGPU-ONLY MODE: Force WebGPU, no WASM fallback
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
    dtype: "fp32", // Keep fp32 for stability with 250-char chunks
    device: "webgpu",
    progress_callback: (progress) => {
      self.postMessage({ status: "loading_model_progress", progress });
    }
  });
} catch (modelError) {
  console.error("FATAL: Model loading failed completely. WebGPU may not be available.");
  self.postMessage({ 
    status: "loading_model_error", 
    error: modelError.message,
    suggestion: "Please ensure WebGPU is supported in your browser and try refreshing the page."
  });
  throw modelError;
}

self.postMessage({ status: "loading_model_ready", voices: tts.voices, device: device });

// --- MEMORY-SAFE QUEUE LOGIC FOR SENTENCES WITHIN A CHUNK ---
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
    
    // Keep proven 250-character chunk size (no errors with this size)
    let sentences = splitTextSmart(text, 250); // Proven reliable size
    let currentTTS = tts;

    console.log(`Processing ${sentences.length} sentences per chunk (proven reliable size)`);
    
    // CRITICAL: Always report the total sentences being processed
    self.postMessage({ 
      status: "chunk_progress", 
      sentencesInChunk: sentences.length,
      totalEstimated: sentences.length
    });
    
    // Wait for buffer space with timeout to prevent infinite wait
    let waitStart = Date.now();
    while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop) {
      if (Date.now() - waitStart > 30000) { // 30 second timeout
        console.warn("Buffer wait timeout, proceeding anyway");
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (shouldStop) {
      console.log("Generation stopped before processing");
      return;
    }

    bufferQueueSize++;
    
    try {
      console.log(`Processing ${sentences.length} sentences per chunk (smaller chunks for reliability)`);
      
      // Process each sentence in the chunk with error handling
      const audioChunks = [];
      for (let i = 0; i < sentences.length; i++) {
        if (shouldStop) break;
        
        const sentence = sentences[i];
        try {
          console.log(`Sentence ${i + 1}/${sentences.length} processed successfully`);
          
          const audio = await currentTTS.generate({
            text: sentence,
            voice: voice || 'af_heart',
            speed: speed || 1.0
          });
          
          // Convert to WAV format if needed
          let audioData;
          if (audio instanceof Float32Array) {
            // Convert float32 to 16-bit PCM
            const pcmData = new Int16Array(audio.length);
            for (let j = 0; j < audio.length; j++) {
              pcmData[j] = Math.max(-32768, Math.min(32767, Math.floor(audio[j] * 32767)));
            }
            audioData = pcmData.buffer;
          } else {
            audioData = audio;
          }
          
          audioChunks.push({
            audio: audioData,
            sampleRate: 24000, // KokoroTTS default sample rate
            sentence: sentence
          });
          
          self.postMessage({ 
            status: "sentence_progress", 
            sentenceIndex: i + 1, 
            totalSentences: sentences.length,
            text: sentence 
          });
          
        } catch (sentenceError) {
          console.error(`Error processing sentence ${i + 1}:`, sentenceError);
          
          // Send error notification but continue with next sentence
          self.postMessage({
            status: "sentence_error",
            sentenceIndex: i + 1,
            error: sentenceError.message,
            text: sentence
          });
          
          // Add empty audio chunk to maintain sequence
          audioChunks.push({
            audio: new ArrayBuffer(0),
            sampleRate: 24000,
            sentence: sentence,
            error: sentenceError.message
          });
        }
      }

      if (shouldStop) {
        console.log("Generation stopped during processing");
        bufferQueueSize = Math.max(0, bufferQueueSize - 1);
        return;
      }

      console.log(`Chunk processing complete with ${sentences.length} sentences`);
      
      // Send all audio data at once
      self.postMessage({
        type: "audio_chunk",
        audioChunks: audioChunks,
        sentences: sentences
      });

    } catch (chunkError) {
      console.error("Critical error processing chunk:", chunkError);
      bufferQueueSize = Math.max(0, bufferQueueSize - 1);
      
      // Send error notification
      self.postMessage({
        status: "chunk_error",
        error: chunkError.message,
        sentences: sentences
      });
    }
  }
});
