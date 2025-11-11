// worker.js - TTS Processing Engine
import { KokoroTTS } from "./kokoro.js";
import { env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js";
import { splitTextSmart } from "./semantic-split.js";

async function detectWebGPU() {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch (e) {
    return false;
  }
}

const device = await detectWebGPU() ? "webgpu" : "wasm";
self.postMessage({ status: "loading_model_start", device });

let model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";

// Initialize model immediately when worker loads
const tts = await KokoroTTS.from_pretrained(model_id, {
  dtype: device === "wasm" ? "q8" : "fp32", 
  device,
  progress_callback: (progress) => {
    self.postMessage({ status: "loading_model_progress", progress });
  }
}).catch((e) => {
  self.postMessage({ status: "error", message: e.message });
  throw e;
});

self.postMessage({ status: "initialized", voices: tts.voices, device });

// --- MEMORY-SAFE QUEUE LOGIC ---
let bufferQueueSize = 0;
const MAX_QUEUE_SIZE = 6;
let shouldStop = false;
let useWasmFallback = false;

self.addEventListener("message", async (e) => {
  const { command, type, text, voice, speed } = e.data;
  
  if (command === "stop" || type === "stop") {
    shouldStop = true;
    bufferQueueSize = 0;
    console.log("Stop command received, stopping generation");
    return;
  }

  if (command === "buffer_processed" || type === "buffer_processed") {
    bufferQueueSize = Math.max(0, bufferQueueSize - 1);
    return;
  }

  if ((command === "generate" || type === "generate") && text) { 
    shouldStop = false;
    
    // Use semantic splitting like the original
    let sentences = splitTextSmart(text, 300); 

    for (const sentence of sentences) {
      if (shouldStop) break;

      while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (shouldStop) break;
      }
      if (shouldStop) break;
      
      // SMART RETRY STRATEGY with 2-second buffer reset on WebGPU errors
      try {
        const audio = await tts.generate(sentence, { voice, speed }); 
        if (shouldStop) break;

        let ab = audio.audio.buffer;
        bufferQueueSize++;
        self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
        
        console.log(`Sentence processed successfully`);
        
      } catch (audioError) {
        const isWebGPUError = audioError.message && 
          (audioError.message.includes('GPUBuffer') || 
           audioError.message.includes('webgpu') ||
           audioError.name === 'AbortError');
        
        const isSessionError = audioError.message && 
          audioError.message.includes('Session already started');
        
        if (isSessionError || (isWebGPUError && !useWasmFallback)) {
          console.warn("Session/WebGPU error detected:", audioError.message);
          
          // SMART RETRY STRATEGY: Wait 2 seconds and clear buffer before retry
          console.log("Clearing buffer and waiting 2 seconds before retry...");
          bufferQueueSize = 0;
          
          // Wait 2 seconds to let GPU session stabilize
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Try again with current model
          try {
            const audio = await tts.generate(sentence, { voice, speed });
            let ab = audio.audio.buffer;
            bufferQueueSize++;
            self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
            
            console.log(`Sentence processed successfully after retry`);
            
          } catch (retryError) {
            console.warn("Retry failed, using alternative approach:", retryError.message);
            // For now, just skip the sentence on retry failure
            console.error("Skipping sentence after retry failure:", sentence.substring(0, 50) + "...");
          }
          
        } else if (audioError.message && audioError.message.includes('timeout')) {
          console.warn("Audio generation timeout, skipping sentence:", sentence.substring(0, 100) + "...");
        } else {
          console.error("Audio generation error, skipping sentence:", audioError.message);
        }
      }
    }

    // When the loop finishes, this chunk is "complete"
    if (!shouldStop) {
      self.postMessage({ status: "complete", processedSentences: sentences.length });
    }
  }
});
