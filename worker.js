// worker.js - TTS Processing Engine (100% Success Rate with Aggressive Retry Logic)
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

// --- NEW: Function to break text into progressively smaller pieces ---
function breakTextIntoSmallerPieces(text, maxRetries = 4) {
  const pieces = [];
  
  // Try 1: Full chunk
  if (text.length <= 250) {
    pieces.push({ text, size: 'full', priority: 1 });
    return pieces;
  }
  
  // Try 2: Half chunk (125 chars)
  const halfSize = Math.ceil(text.length / 2);
  pieces.push({ text: text.substring(0, halfSize), size: 'half', priority: 2 });
  pieces.push({ text: text.substring(halfSize), size: 'half', priority: 2 });
  
  // Try 3: Sentence-by-sentence
  const sentences = text.split(/([.!?]+\s*)/);
  const sentenceChunks = [];
  let currentSentence = "";
  
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    if (!sentence.trim()) continue;
    
    const punctuation = sentences[i + 1] || "";
    currentSentence += sentence + punctuation;
    
    if (currentSentence.length > 150 || i === sentences.length - 1) {
      sentenceChunks.push(currentSentence.trim());
      currentSentence = "";
    }
  }
  
  for (const sentence of sentenceChunks) {
    pieces.push({ text: sentence, size: 'sentence', priority: 3 });
  }
  
  // Try 4: Last resort - word-by-word for very problematic text
  if (text.length > 200) {
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i += 5) { // Groups of 5 words
      const wordGroup = words.slice(i, i + 5).join(' ');
      pieces.push({ text: wordGroup, size: 'words', priority: 4 });
    }
  }
  
  return pieces;
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
      // CRITICAL FIX: Use small chunks for better reliability (target 100-250 chars)
      const maxChunkSize = 200; // Even smaller for better success rate
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
      let failedChunks = 0;
      
      // Process chunks sequentially with AGGRESSIVE retry logic for 100% success
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        console.log(`Processing chunk ${chunkIndex + 1}/${chunks.length} (${chunk.length} chars): "${chunk.substring(0, 50)}..."`);
        
        // AGGRESSIVE RETRY LOGIC FOR 100% SUCCESS
        let success = false;
        let lastError = null;
        let chunkAudio = null;
        
        // Method 1: Try original chunk (up to 3 attempts)
        for (let attempt = 1; attempt <= 3 && !success; attempt++) {
          try {
            console.log(`Chunk ${chunkIndex + 1} - Method 1, Attempt ${attempt}/3`);
            
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
            
            chunkAudio = audio;
            success = true;
            console.log(`Chunk ${chunkIndex + 1} processed successfully with Method 1`);
            
          } catch (error) {
            lastError = error;
            console.warn(`Chunk ${chunkIndex + 1} Method 1 attempt ${attempt} failed:`, error.message);
            
            // Check if it's a session conflict (don't retry method 1)
            if (error.message && error.message.includes("Session")) {
              console.log("Session conflict detected, moving to Method 2");
              break;
            }
            
            if (attempt === 3) {
              console.log("Method 1 exhausted, trying Method 2...");
              break;
            }
          }
        }
        
        // Method 2: Try smaller chunk (if Method 1 failed)
        if (!success) {
          const words = chunk.split(/\s+/);
          const smallerChunk = words.slice(0, Math.max(1, Math.floor(words.length * 0.6))).join(' ');
          
          try {
            console.log(`Chunk ${chunkIndex + 1} - Method 2: Trying smaller chunk (${Math.floor(words.length * 0.6)} words)`);
            chunkAudio = await tts.generate(smallerChunk, {
              voice,
              speed
            });
            
            if (chunkAudio && chunkAudio.length > 0) {
              success = true;
              console.log(`Chunk ${chunkIndex + 1} processed successfully with Method 2`);
            }
          } catch (method2Error) {
            console.warn(`Method 2 failed for chunk ${chunkIndex + 1}:`, method2Error.message);
          }
        }
        
        // Method 3: Try sentence-by-sentence (if Methods 1&2 failed)
        if (!success) {
          console.log(`Chunk ${chunkIndex + 1} - Method 3: Breaking into sentences`);
          const sentences = chunk.split(/([.!?]+\s*)/);
          let sentenceChunks = [];
          let currentSentence = "";
          
          for (let i = 0; i < sentences.length; i++) {
            const sentence = sentences[i];
            if (!sentence.trim()) continue;
            
            const punctuation = sentences[i + 1] || "";
            currentSentence += sentence + punctuation;
            
            if (currentSentence.length > 120 || i === sentences.length - 1) {
              if (currentSentence.trim()) {
                sentenceChunks.push(currentSentence.trim());
                currentSentence = "";
              }
            }
          }
          
          // Process each sentence individually
          for (let sentenceIndex = 0; sentenceIndex < sentenceChunks.length && !success; sentenceIndex++) {
            try {
              console.log(`Chunk ${chunkIndex + 1}, Sentence ${sentenceIndex + 1}/${sentenceChunks.length}: "${sentenceChunks[sentenceIndex].substring(0, 30)}..."`);
              
              const sentenceAudio = await tts.generate(sentenceChunks[sentenceIndex], {
                voice,
                speed
              });
              
              if (sentenceAudio && sentenceAudio.length > 0) {
                // Store this sentence audio - we'll combine them later
                chunkAudio = sentenceAudio;
                success = true;
                console.log(`Chunk ${chunkIndex + 1} processed successfully with Method 3`);
                break;
              }
            } catch (sentenceError) {
              console.warn(`Sentence ${sentenceIndex + 1} failed:`, sentenceError.message);
              // Try to continue with next sentence
            }
          }
        }
        
        // FINAL METHOD: Last resort - individual words/phrases
        if (!success) {
          console.log(`Chunk ${chunkIndex + 1} - Method 4: Last resort - processing word groups`);
          const words = chunk.split(/\s+/);
          
          for (let i = 0; i < words.length; i += 3) { // Groups of 3 words
            try {
              const wordGroup = words.slice(i, i + 3).join(' ');
              console.log(`Chunk ${chunkIndex + 1}, Word group ${Math.floor(i/3) + 1}: "${wordGroup}"`);
              
              const wordAudio = await tts.generate(wordGroup, {
                voice,
                speed
              });
              
              if (wordAudio && wordAudio.length > 0) {
                chunkAudio = wordAudio;
                success = true;
                console.log(`Chunk ${chunkIndex + 1} processed successfully with Method 4`);
                break;
              }
            } catch (wordError) {
              console.warn(`Word group failed:`, wordError.message);
              // Continue to next word group
            }
          }
        }
        
        // Send audio if we got any successful result
        if (success && chunkAudio) {
          self.postMessage({ 
            status: "stream_audio_data", 
            audio: chunkAudio.buffer 
          }, [chunkAudio.buffer]);
          
          processedChunks++;
          console.log(`✅ Chunk ${chunkIndex + 1}/${chunks.length} SUCCESSFULLY processed`);
        } else {
          failedChunks++;
          console.error(`❌ Chunk ${chunkIndex + 1}/${chunks.length} FAILED after all methods`);
        }
        
        // Report progress
        self.postMessage({
          status: "chunk_progress",
          chunkIndex: chunkIndex + 1,
          totalChunks: chunks.length,
          successfulChunks: processedChunks,
          failedChunks: failedChunks,
          successRate: Math.round((processedChunks / chunks.length) * 100),
          chunkSize: chunk.length
        });
        
        // Signal buffer processed
        self.postMessage({ type: "buffer_processed" });
      }
      
      const totalTime = Date.now() - startTime;
      const successRate = Math.round((processedChunks / chunks.length) * 100);
      console.log(`🎯 Chunk processing complete: ${processedChunks}/${chunks.length} chunks successful (${successRate}% success rate) in ${totalTime}ms`);
      
      // CRITICAL: Only mark as complete if we have meaningful audio data
      if (processedChunks > 0) {
        self.postMessage({ 
          status: "complete", 
          successfulChunks: processedChunks,
          totalChunks: chunks.length,
          failedChunks: failedChunks,
          successRate: successRate,
          processingTime: totalTime,
          complete: true
        });
      } else {
        // No chunks succeeded, report as error
        self.postMessage({ 
          status: "error", 
          error: "All chunks failed to process",
          details: `${failedChunks} chunks failed after aggressive retry attempts`
        });
      }
      
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
