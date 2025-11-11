import { updateProgress } from "./updateProgress.js";
import { AudioPlayer } from "./AudioPlayer.js";
import { AudioDiskSaver } from "./AudioDiskSaver.js";
import { ButtonHandler } from "./ButtonHandler.js";
import { BackgroundQueueManager } from "./BackgroundQueueManager.js";

// --- Helper function to remap the slider value ---
function getRealSpeed(sliderValue) {
  // Linearly maps slider range [0.5, 2.0] to real speed range [0.75, 1.5]
  return 0.5 * sliderValue + 0.5;
}

// Register service worker for HTTPS (GitHub Pages)
if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
  navigator.serviceWorker.register("./service-worker.js").then((registration) => {
    console.log("Service Worker registered:", registration);
    
    // Register background sync if supported
    if ('sync' in registration) {
      console.log('Background Sync API supported');
    } else {
      console.log('Background Sync not supported, using foreground processing');
    }
  }).catch(err => {
    console.warn("Service Worker registration failed:", err);
  });
} else if (window.location.hostname === "localhost") {
  // For localhost testing
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").then(() => {
      console.log("Service Worker registered.");
    });
  }
}

// Use the final fix worker with voice validation + memory management
let tts_worker = new Worker(new URL("./worker_final_memory_fix.js", import.meta.url), { type: "module" });
let audioPlayer = new AudioPlayer(tts_worker);
let audioDiskSaver = new AudioDiskSaver();
let buttonHandler = new ButtonHandler(tts_worker, audioPlayer, audioDiskSaver, getRealSpeed);
let queueManager = new BackgroundQueueManager();

// Track current queue job
let currentQueueJobId = null;
let currentQueueMode = null;
let audioChunksForQueue = [];
let currentJobEstimation = null; // Store the chunk estimation for current job

function populateVoiceSelector(voices) {
  const voiceSelector = document.getElementById("voiceSelector");
  while (voiceSelector.options.length > 0) {
    voiceSelector.remove(0);
  }

  const voiceGroups = {};
  let heartVoice = null;

  for (const [id, voice] of Object.entries(voices)) {
    if (id === "af_heart") {
      heartVoice = { id, name: voice.name, language: voice.language };
      continue;
    }
    const category = id.split('_')[0];
    const groupKey = `${category} - ${voice.gender}`;
    if (!voiceGroups[groupKey]) {
      voiceGroups[groupKey] = [];
    }
    voiceGroups[groupKey].push({ id, name: voice.name, language: voice.language });
  }
  
  const sortedGroups = Object.keys(voiceGroups).sort();
  for (const groupKey of sortedGroups) {
    const [category, gender] = groupKey.split(' - ');
    const optgroup = document.createElement('optgroup');
    optgroup.label = `${gender} Voices (${category.toUpperCase()})`;
    voiceGroups[groupKey].sort((a, b) => a.name.localeCompare(b.name));
    if (category === "af" && gender === "Female" && heartVoice) {
      const option = document.createElement('option');
      option.value = heartVoice.id;
      option.textContent = `${heartVoice.name} (${heartVoice.language})`;
      option.selected = true;
      optgroup.appendChild(option);
    }
    for (const voice of voiceGroups[groupKey]) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = `${voice.name} (${voice.language})`;
      if (!heartVoice && voiceSelector.options.length === 0) {
        option.selected = true;
      }
      optgroup.appendChild(option);
    }
    voiceSelector.appendChild(optgroup);
  }
  voiceSelector.disabled = false;
}

// --- EVENT LISTENERS ---
tts_worker.addEventListener("message", (e) => {
  const data = e.data;
  
  if (data.status === "loading_model_ready") {
    console.log("Model loaded successfully with device:", data.device);
    populateVoiceSelector(data.voices);
  } else if (data.status === "loading_model_progress") {
    console.log("Model loading progress:", data.progress);
  } else if (data.status === "stream_audio_data") {
    if (currentQueueJobId) {
      // Queue job - collect all audio
      audioChunksForQueue.push(data.audio);
      
      // Calculate progress for queue jobs
      if (currentJobEstimation) {
        const chunkNum = Math.min(audioChunksForQueue.length, currentJobEstimation);
        const fallbackEstimation = Math.max(5, Math.ceil(chunkNum * 1.2));
        const percent = Math.min((chunkNum / fallbackEstimation) * 100, 98);
        updateProgress(percent, `Processing queue job ${currentQueueJobId}: ${chunkNum}/${fallbackEstimation} chunks (${Math.round(percent)}%)`);
      }
      
      tts_worker.postMessage({ type: "buffer_processed" });
    } else {
      // Manual job - use existing logic
      if (buttonHandler.getMode() === "disk") {
        const percent = audioDiskSaver.addAudioChunk(data.audio);
        updateProgress(percent, "Processing audio for saving...");
        buttonHandler.updateDiskButtonToStop();
        tts_worker.postMessage({ type: "buffer_processed" });
      } else if (buttonHandler.getMode() === "stream") {
        buttonHandler.updateStreamButtonToStop();
        audioPlayer.queueAudio(data.audio);
      }
    }
  } else if (data.status === "complete") {
    if (currentQueueJobId) {
      // Queue job complete
      console.log(`Queue job ${currentQueueJobId} complete with ${audioChunksForQueue.length} audio chunks`);
      
      if (currentQueueMode === "stream") {
        // Stream all collected audio
        console.log(`Starting playback of ${audioChunksForQueue.length} audio chunks...`);
        audioChunksForQueue.forEach((audio, index) => {
          setTimeout(() => {
            audioPlayer.queueAudio(audio);
          }, index * 100);
        });
      } else if (currentQueueMode === "disk") {
        // Save all collected audio
        console.log(`Saving ${audioChunksForQueue.length} audio chunks...`);
        audioChunksForQueue.forEach(audio => {
          audioDiskSaver.addAudioChunk(audio);
        });
        audioDiskSaver.finalizeCurrentFile();
      }
      
      // Clear current job tracking
      currentQueueJobId = null;
      currentQueueMode = null;
      audioChunksForQueue = [];
      currentJobEstimation = null;
      queueManager.markCurrentJobComplete();
      
      updateProgress(100, "Job completed successfully!");
      buttonHandler.resetButtons();
      
    } else {
      // Manual job complete
      console.log("Manual job completed");
      updateProgress(100, "Job completed successfully!");
      buttonHandler.resetButtons();
    }
  } else if (data.status === "error") {
    console.error("Worker error:", data.message);
    if (currentQueueJobId) {
      queueManager.markCurrentJobError(data.message);
      currentQueueJobId = null;
      currentQueueMode = null;
      audioChunksForQueue = [];
      currentJobEstimation = null;
    }
    updateProgress(0, `Error: ${data.message}`);
    buttonHandler.resetButtons();
  } else if (data.status === "chunk_progress") {
    // Update chunk progress for queue jobs
    if (currentQueueJobId) {
      console.log(`Chunk progress: ${data.sentencesInChunk} sentences in this chunk`);
    }
  }
});

// --- QUEUE PROCESSING ---
queueManager.addEventListener("jobstarted", async (event) => {
  if (!queueManager.hasActiveJob()) return;
  
  const { jobId, text, voice, speed, mode } = event.detail;
  currentQueueJobId = jobId;
  currentQueueMode = mode;
  audioChunksForQueue = [];
  currentJobEstimation = null;
  
  try {
    // Split text into chunks and process sequentially
    const { chunks, estimatedChunks } = await splitTextForQueue(text);
    currentJobEstimation = estimatedChunks;
    
    let currentIndex = 0;
    
    const processNextChunk = async () => {
      if (currentIndex >= chunks.length) return;
      
      const totalChunks = chunks.length;
      const nextChunk = chunks[currentIndex];
      
      console.log(`Processing chunk ${currentIndex + 1}/${totalChunks}: "${nextChunk.substring(0, 50)}..."`);
      
      // Send next chunk to worker
      tts_worker.postMessage({ 
        type: "generate", 
        text: nextChunk, 
        voice: voice, 
        speed: speed 
      });
      
      currentIndex++;
    };
    
    // Process first chunk immediately
    await processNextChunk();
    
    // Listen for completion to process next chunk
    const handleChunkComplete = async (e) => {
      if (e.data.status === "complete") {
        // Remove this listener
        tts_worker.removeEventListener("message", handleChunkComplete);
        
        // Process next chunk if available
        if (currentIndex < chunks.length) {
          await processNextChunk();
          
          // Add listener back for next chunk
          tts_worker.addEventListener("message", handleChunkComplete);
        }
      }
    };
    
    tts_worker.addEventListener("message", handleChunkComplete);
    
    updateProgress(0, `Processing queue job ${jobId}: 0/${estimatedChunks} chunks...`);
    
  } catch (error) {
    console.error("Error processing queue job:", error);
    queueManager.markCurrentJobError(error.message);
    currentQueueJobId = null;
  }
});

// --- QUEUE JOB TEXT SPLITTING ---
async function splitTextForQueue(text) {
  const { splitTextSmart } = await import("./semantic-split.js");
  
  try {
    // Use 250 characters per chunk for reliability
    const chunks = splitTextSmart(text, 250);
    const estimatedChunks = chunks.length;
    
    console.log(`Split text into ${estimatedChunks} chunks for queue processing`);
    
    return { chunks, estimatedChunks };
  } catch (error) {
    console.error("Error splitting text into chunks:", error);
    // Fallback: send entire text as single chunk
    return { chunks: [text], estimatedChunks: 1 };
  }
}

// --- EXPORT BUTTON FUNCTIONALITY ---
window.addEventListener("jobstarted", (event) => {
  const { jobId, text, voice, speed, mode } = event.detail;
  currentQueueJobId = jobId;
  currentQueueMode = mode;
  audioChunksForQueue = [];
  currentJobEstimation = null;
  
  console.log("Starting job:", { jobId, text: text.substring(0, 100), voice, speed, mode });
});

// Initialize queue manager
queueManager.initialize();

console.log("TTS Generator loaded with final memory fixes");
