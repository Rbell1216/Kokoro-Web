// worker.js - TTS Processing Engine
import { KokoroTTS } from "./kokoro.js";
import { env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js";
import { splitTextSmart } from "./semantic-split.js";

async function detectWebGPU() {
  try {
    if (!('gpu' in navigator)) {
      console.log("WebGPU not supported, using WASM");
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

let currentTTS = null;
let shouldStop = false;
let useWasmFallback = false;
const MAX_QUEUE_SIZE = 6;
let bufferQueueSize = 0;

self.onmessage = async (e) => {
  if (e.data.command === "stop") {
    shouldStop = true;
    bufferQueueSize = 0;
    return;
  }

  if (e.data.command === "buffer_processed") {
    bufferQueueSize = Math.max(0, bufferQueueSize - 1);
    return;
  }

  if (e.data.command === "init") {
    try {
      console.log("Initializing TTS model...");
      
      const device = await detectWebGPU() ? "webgpu" : "wasm";
      self.postMessage({ status: "loading_model_start", device });
      
      let model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";
      
      try {
        currentTTS = await KokoroTTS.from_pretrained(model_id, {
          dtype: device === "wasm" ? "q8" : "fp32", 
          device
        });
        console.log(`${device.toUpperCase()} model loaded successfully`);
      } catch (initialError) {
        console.warn("Failed to load model with WebGPU, falling back to WASM:", initialError.message);
        useWasmFallback = true;
        currentTTS = await KokoroTTS.from_pretrained(model_id, {
          dtype: "q8",
          device: "wasm"
        });
        console.log("WASM model loaded successfully");
      }
      
      self.postMessage({ status: "initialized", voices: currentTTS.voices, device: useWasmFallback ? "wasm" : device });
    } catch (error) {
      console.error("Failed to initialize TTS model:", error);
      self.postMessage({ status: "error", message: error.message });
    }
    return;
  }

  if (e.data.command === "generate") {
    shouldStop = false;
    await generateAudio(e.data.text, e.data.voice, e.data.speed);
  }
};

async function generateAudio(text, voice = "af_bella", speed = 1.0) {
  shouldStop = false;
  
  // Use semantic splitting from the imported module
  const sentences = splitTextSmart(text);

  console.log(`Processing ${sentences.length} sentences`);
  
  // Process sentences with proven working logic
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    if (shouldStop) break;
    
    // Delay between sentences
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    
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
        console.warn("Session/WebGPU error detected:", audioError.message);
        
        // SMART RETRY STRATEGY: Wait 2 seconds and clear buffer before retry
        console.log("Clearing buffer and waiting 2 seconds before retry...");
        bufferQueueSize = 0;
        
        // Wait 2 seconds to let GPU session stabilize
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Try again with current model
        try {
          const audio = await currentTTS.generate(sentence, { voice, speed });
          let ab = audio.audio.buffer;
          bufferQueueSize++;
          self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
          
          console.log(`Sentence ${i + 1}/${sentences.length} processed successfully after retry`);
          
        } catch (retryError) {
          console.warn("Retry failed, falling back to WASM:", retryError.message);
          useWasmFallback = true;
          
          try {
            if (!currentTTS._wasmFallback) {
              console.log("Initializing WASM fallback model...");
              currentTTS._wasmFallback = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
                dtype: "q8",
                device: "wasm"
              });
            }
            
            const audio = await currentTTS._wasmFallback.generate(sentence, { voice, speed });
            let ab = audio.audio.buffer;
            bufferQueueSize++;
            self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
            
            console.log(`Sentence ${i + 1}/${sentences.length} processed with WASM fallback`);
            
          } catch (wasmError) {
            console.error("WASM fallback failed, skipping sentence:", wasmError.message);
          }
        }
        
      } else if (audioError.message && audioError.message.includes('timeout')) {
        console.warn("Audio generation timeout, skipping sentence:", sentence.substring(0, 100) + "...");
      } else {
        console.error("Audio generation error, skipping sentence:", audioError.message);
      }
    }
  }

  console.log(`Audio generation complete`);
  self.postMessage({ status: "complete", processedSentences: sentences.length });
}
