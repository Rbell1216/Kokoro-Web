import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@3.2.0";

let currentTTS = null;
let shouldStop = false;
let useWasmFallback = false;
let model_id = "onnx-community/kokoro-v1_1-onnx";
const MAX_QUEUE_SIZE = 10;
let bufferQueueSize = 0;

const MAX_WAIT_ATTEMPTS = 60; // 30 seconds at 500ms intervals
const WAIT_INTERVAL = 500;

self.onmessage = async (e) => {
  if (e.data.command === "stop") {
    shouldStop = true;
    return;
  }

  if (e.data.command === "init") {
    try {
      console.log("Initializing TTS model...");
      
      // Try WebGPU first, then fall back to WASM if needed
      try {
        currentTTS = await KokoroTTS.from_pretrained(model_id, {
          dtype: "q8",
          device: "webgpu"
        });
        console.log("WebGPU model loaded successfully");
      } catch (webgpuError) {
        console.warn("WebGPU failed, falling back to WASM:", webgpuError.message);
        currentTTS = await KokoroTTS.from_pretrained(model_id, {
          dtype: "q8", 
          device: "wasm"
        });
        useWasmFallback = true;
        console.log("WASM model loaded successfully");
      }
      
      self.postMessage({ status: "initialized" });
    } catch (error) {
      console.error("Failed to initialize TTS model:", error);
      self.postMessage({ status: "error", message: error.message });
    }
    return;
  }

  if (e.data.command === "generate") {
    try {
      await generateAudio(e.data.text, e.data.voice, e.data.speed);
    } catch (error) {
      console.error("Generation failed:", error);
      self.postMessage({ status: "error", message: error.message });
    }
  }
};

async function generateAudio(text, voice = "af_bella", speed = 1.0) {
  console.log(`Starting audio generation for ${text.length} characters`);
  useWasmFallback = currentTTS?.device === 'wasm' || useWasmFallback;
  
  // Get sentences using simple splitting (reliable)
  const sentences = text
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  console.log(`Processing ${sentences.length} sentences`);
  
  // Group sentences into chunks of 2-3 sentences for moderate chunking
  const chunkSize = Math.min(3, Math.max(2, Math.ceil(sentences.length / 10))); // 2-3 sentences per chunk
  const chunks = [];
  for (let i = 0; i < sentences.length; i += chunkSize) {
    chunks.push(sentences.slice(i, i + chunkSize));
  }
  
  console.log(`Grouped into ${chunks.length} chunks with ${chunkSize} sentences per chunk`);

  // Process each chunk separately
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunkSentences = chunks[chunkIndex];
    
    // Send sentence count for progress tracking
    self.postMessage({ 
      status: "chunk_progress", 
      sentencesInChunk: chunkSentences.length,
      currentSentence: 0
    });

  // Wait for buffer queue to have space
  let waitAttempts = 0;
  while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop) {
    await new Promise(resolve => setTimeout(resolve, WAIT_INTERVAL));
    waitAttempts++;
    
    if (waitAttempts >= MAX_WAIT_ATTEMPTS) {
      console.warn("Buffer queue timeout, proceeding anyway");
      break;
    }
  }
  
  if (shouldStop) {
    self.postMessage({ status: "complete" });
    return;
  }
  
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunkSentences = chunks[chunkIndex];
    
    if (shouldStop) break;
    
    let attemptCount = 0;
    const maxAttempts = 3; // Try same method up to 3 times
    let wasmInitAttempts = 0;
    const maxWasmInitAttempts = 2; // Only switch to WASM after multiple failures
    
    // Report progress for this chunk
    self.postMessage({ 
      status: "chunk_progress", 
      sentencesInChunk: chunkSentences.length,
      currentSentence: 0
    });
    
    for (let i = 0; i < chunkSentences.length; i++) {
      const sentence = chunkSentences[i];
      if (shouldStop) break;
      
      // Moderate delay between sentences (reduced for better speed)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 500)); // Reduced from 800ms to 500ms
      }
    
    let sentenceProcessed = false;
    while (attemptCount < maxAttempts && !sentenceProcessed && !shouldStop) {
      try {
        // Simple timeout for each sentence (25 seconds)
        const audioPromise = currentTTS.generate(sentence, { voice, speed });
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Audio generation timeout')), 25000);
        });
        
        const audio = await Promise.race([audioPromise, timeoutPromise]);
        
        if (shouldStop) break;

        let ab = audio.audio.buffer;
        bufferQueueSize++;
        self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
        
        console.log(`Sentence ${i + 1}/${chunkSentences.length} processed successfully`);
        sentenceProcessed = true;
        
      } catch (audioError) {
        attemptCount++;
        
        const isWebGPUError = audioError.message && 
          (audioError.message.includes('GPUBuffer') || 
           audioError.message.includes('webgpu') ||
           audioError.name === 'AbortError');
        
        const isSessionError = audioError.message && 
          audioError.message.includes('Session already started');
        
        if (isSessionError || isWebGPUError) {
          if (attemptCount < maxAttempts) {
            console.warn(`Session/WebGPU error on attempt ${attemptCount}, retrying with same method:`, audioError.message);
            
            // For session errors, clear buffers and wait for session to properly clear
            if (isSessionError) {
              console.log("Clearing pending buffers and waiting for session reset...");
              
              // Clear any pending buffer queue
              bufferQueueSize = 0;
              
              // Wait longer for session to clear (2 seconds)
              await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
              // For WebGPU errors, shorter wait
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // Try again with the same method (WebGPU or WASM)
            continue;
          } else {
            // If all retries with same method failed, then consider switching to WASM
            console.warn(`All attempts with current method failed, considering WASM fallback...`);
            
            if (!useWasmFallback && wasmInitAttempts < maxWasmInitAttempts) {
              useWasmFallback = true;
              wasmInitAttempts++;
              console.log("Switching to WASM fallback mode");
              
              try {
                if (!self._wasmFallback || wasmInitAttempts === 1) {
                  console.log("Initializing WASM fallback model...");
                  
                  // Add timeout protection for WASM initialization (10 seconds max)
                  const wasmInitPromise = KokoroTTS.from_pretrained(model_id, {
                    dtype: "q8",
                    device: "wasm"
                  });
                  
                  const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('WASM initialization timeout')), 10000);
                  });
                  
                  self._wasmFallback = await Promise.race([wasmInitPromise, timeoutPromise]);
                  console.log("WASM fallback model initialized successfully");
                }
                currentTTS = self._wasmFallback;
                
                // Very short delay for WASM retry
                await new Promise(resolve => setTimeout(resolve, 500));
                
                const audio = await currentTTS.generate(sentence, { voice, speed });
                let ab = audio.audio.buffer;
                bufferQueueSize++;
                self.postMessage({ status: "stream_audio_data", audio: ab }, [ab]);
                
                console.log(`Sentence ${i + 1}/${chunkSentences.length} processed with WASM fallback`);
                sentenceProcessed = true;
                
              } catch (wasmError) {
                console.error("WASM fallback failed:", wasmError.message);
                console.error("Skipping sentence after all methods exhausted:", sentence.substring(0, 100) + "...");
                break;
              }
            } else {
              console.error("WASM fallback not available or maxed out, skipping sentence:", sentence.substring(0, 100) + "...");
              break;
            }
          }
        } else if (audioError.message && audioError.message.includes('timeout')) {
          console.warn("Audio generation timeout, skipping sentence:", sentence.substring(0, 100) + "...");
          break;
        } else {
          console.error("Audio generation error, skipping sentence:", audioError.message);
          if (attemptCount >= maxAttempts) {
            break;
          }
        }
      }
    }
    
    // After each chunk completes, send complete message
    console.log(`Chunk ${chunkIndex + 1}/${chunks.length} processing complete with ${chunkSentences.length} sentences`);
    self.postMessage({ 
      status: "complete",
      processedSentences: chunkSentences.length,
      chunkNumber: chunkIndex + 1,
      totalChunks: chunks.length
    });
  }
}
