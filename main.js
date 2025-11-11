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

let tts_worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let audioPlayer = new AudioPlayer(tts_worker);
let audioDiskSaver = new AudioDiskSaver();
let buttonHandler = new ButtonHandler(tts_worker, audioPlayer, audioDiskSaver, getRealSpeed);
let queueManager = new BackgroundQueueManager();

// Track current queue job
let currentQueueJobId = null;
let currentQueueMode = null;
let audioChunksForQueue = [];

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

const onMessageReceived = async (e) => {
  switch (e.data.status) {
    case "loading_model_start":
      console.log(e.data);
      updateProgress(0, "Loading model...");
      break;

    case "loading_model_ready":
      buttonHandler.enableButtons();
      updateProgress(100, "Model loaded successfully");
      
      if (e.data.voices) {
        populateVoiceSelector(e.data.voices);
      }
      
      // Check for pending queue jobs
      const stats = await queueManager.getQueueStats();
      if (stats.queued > 0 || stats.processing > 0) {
        console.log(`Found ${stats.queued + stats.processing} pending jobs in queue`);
        updateQueueUI();
        
        // Start processing queue
        setTimeout(() => queueManager.processNextJob(), 1000);
      }
      break;

    case "loading_model_progress":
      let progress = Number(e.data.progress) * 100;
      if (isNaN(progress)) progress = 0;
      updateProgress(progress, `Loading model: ${Math.round(progress)}%`);
      break;

    case "stream_audio_data":
      // Check if this is a queue job or manual job
      if (currentQueueJobId) {
        // Queue job - save chunks
        const audioData = new Float32Array(e.data.audio);
        audioChunksForQueue.push(audioData);
        
        const chunkNum = audioChunksForQueue.length;
        const percent = Math.min((chunkNum / 50) * 100, 99); // Estimate
        
        await queueManager.updateJobProgress(currentQueueJobId, percent, chunkNum, 50);
        updateProgress(percent, `Processing queue job ${currentQueueJobId}...`);
        
        tts_worker.postMessage({ type: "buffer_processed" });
      } else {
        // Manual job - use existing logic
        if (buttonHandler.getMode() === "disk") {
          const percent = await audioDiskSaver.addAudioChunk(e.data.audio);
          updateProgress(percent, "Processing audio for saving...");
          buttonHandler.updateDiskButtonToStop();
          tts_worker.postMessage({ type: "buffer_processed" });
        } else if (buttonHandler.getMode() === "stream") {
          buttonHandler.updateStreamButtonToStop();
          await audioPlayer.queueAudio(e.data.audio);
        }
      }
      break;

    case "complete":
      if (currentQueueJobId) {
        // Queue job complete
        console.log(`Queue job ${currentQueueJobId} complete with ${audioChunksForQueue.length} chunks`);
        
        // Mark job as complete with audio data
        await queueManager.jobComplete(currentQueueJobId, audioChunksForQueue, true);
        
        // Reset queue job tracking
        currentQueueJobId = null;
        currentQueueMode = null;
        audioChunksForQueue = [];
        
        updateQueueUI();
        updateProgress(100, "Queue job complete!");
        
      } else {
        // Manual job complete - use existing logic
        if (buttonHandler.getMode() === "disk") {
          try {
            updateProgress(99, "Combining audio chunks...");
            updateProgress(99.5, "Writing file to disk...");
            await audioDiskSaver.finalizeSave();
            updateProgress(100, "File saved successfully!");
          } catch (error) {
            console.error("Error combining audio chunks:", error);
            updateProgress(100, "Error saving file!");
          }
          buttonHandler.resetStreamingState();
        } else if (buttonHandler.getMode() === "stream") {
          buttonHandler.resetStreamingState();
          updateProgress(100, "Streaming complete");
        }
      }
      break;
  }
};

const onErrorReceived = (e) => {
  console.error("Worker error:", e);
  
  // Handle queue job error
  if (currentQueueJobId) {
    queueManager.jobComplete(currentQueueJobId, null, false);
    currentQueueJobId = null;
    currentQueueMode = null;
    audioChunksForQueue = [];
  }
  
  buttonHandler.resetStreamingState();
  updateProgress(100, "An error occurred! Please try again.");
};

tts_worker.addEventListener("message", onMessageReceived);
tts_worker.addEventListener("error", onErrorReceived);

// ===== QUEUE EVENT HANDLERS =====

// Process queue job
window.addEventListener('queue-process-job', async (event) => {
  const { jobId, text, voice, speed, mode } = event.detail;
  
  console.log(`Processing queue job ${jobId} in ${mode} mode`);
  
  // Set current queue job tracking
  currentQueueJobId = jobId;
  currentQueueMode = mode;
  audioChunksForQueue = [];
  
  // Send to worker
  tts_worker.postMessage({ 
    type: "generate", 
    text: text, 
    voice: voice, 
    speed: speed 
  });
  
  updateProgress(0, `Processing queue job ${jobId}...`);
});

// Show completed job
window.addEventListener('queue-show-job', async (event) => {
  const { jobId } = event.detail;
  
  // Get audio data
  const audioData = await queueManager.getAudioData(jobId);
  
  if (audioData && audioData.chunks) {
    console.log(`Playing completed job ${jobId}`);
    
    // Play the audio chunks
    for (const chunk of audioData.chunks) {
      await audioPlayer.queueAudio(chunk);
    }
    
    updateProgress(100, `Playing job ${jobId}`);
  }
});

// ===== QUEUE UI MANAGEMENT =====

async function updateQueueUI() {
  const queueContainer = document.getElementById('queueContainer');
  const queueList = document.getElementById('queueList');
  const queueStats = document.getElementById('queueStats');
  
  const stats = await queueManager.getQueueStats();
  const jobs = await queueManager.getAllJobs();
  
  // Update stats
  queueStats.textContent = `${stats.queued} queued, ${stats.processing} processing, ${stats.complete} complete`;
  
  // Queue container is always visible (removed hide/show logic for always-visible queue)
  
  // Build job list
  queueList.innerHTML = '';
  
  if (jobs.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'queue-empty-state';
    emptyEl.innerHTML = `
      <div class="empty-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.5;">
          <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z"></path>
          <path d="M8 21v-4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4"></path>
          <line x1="9" y1="7" x2="9" y2="7"></line>
          <line x1="15" y1="7" x2="15" y2="7"></line>
        </svg>
      </div>
      <h4>No jobs in queue</h4>
      <p>Enable "Background Queue Mode" and submit a job to get started</p>
    `;
    queueList.appendChild(emptyEl);
    return;
  }
  
  for (const job of jobs.sort((a, b) => b.id - a.id)) {
    const jobEl = document.createElement('div');
    jobEl.className = `queue-job queue-job-${job.status}`;
    
    const textPreview = job.text.substring(0, 60) + (job.text.length > 60 ? '...' : '');
    const statusEmoji = {
      'queued': 'â³',
      'processing': 'âš™ï¸',
      'complete': 'âœ…',
      'failed': 'âŒ'
    }[job.status] || 'â“';
    
    jobEl.innerHTML = `
      <div class="queue-job-header">
        <span class="queue-job-status">${statusEmoji} ${job.status.toUpperCase()}</span>
        <span class="queue-job-mode">${job.mode}</span>
        <span class="queue-job-id">#${job.id}</span>
      </div>
      <div class="queue-job-text">${textPreview}</div>
      <div class="queue-job-meta">
        <span>Voice: ${job.voice}</span>
        <span>Speed: ${job.speed.toFixed(2)}x</span>
        ${job.progress > 0 ? `<span>Progress: ${Math.round(job.progress)}%</span>` : ''}
      </div>
      <div class="queue-job-actions">
        ${job.status === 'complete' ? `
          <button class="queue-btn queue-btn-play" onclick="playQueueJob(${job.id})">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            Play
          </button>
          <button class="queue-btn queue-btn-download" onclick="downloadQueueJob(${job.id})">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Download
          </button>
        ` : ''}
        <button class="queue-btn queue-btn-delete" onclick="deleteQueueJob(${job.id})">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
          Delete
        </button>
      </div>
    `;
    
    queueList.appendChild(jobEl);
  }
}

// Global functions for queue actions
window.playQueueJob = async function(jobId) {
  const audioData = await queueManager.getAudioData(jobId);
  
  if (audioData && audioData.chunks) {
    console.log(`Playing job ${jobId} with ${audioData.chunks.length} chunks`);
    updateProgress(0, `Playing job ${jobId}...`);
    
    for (const chunk of audioData.chunks) {
      await audioPlayer.queueAudio(chunk);
    }
  } else {
    alert('No audio data found for this job');
  }
};

window.downloadQueueJob = async function(jobId) {
  const audioData = await queueManager.getAudioData(jobId);
  
  if (audioData && audioData.chunks) {
    // Try File System Access API first
    try {
      await audioDiskSaver.initSave();
      
      for (const chunk of audioData.chunks) {
        await audioDiskSaver.addAudioChunk(chunk);
      }
      
      await audioDiskSaver.finalizeSave();
      updateProgress(100, "Download complete!");
    } catch (error) {
      console.error('Download error:', error);
      
      // Handle user cancellation more gracefully
      if (error.message && (error.message.includes('user aborted') || error.message.includes('abort'))) {
        console.log('User cancelled the file save dialog, trying alternative download...');
        
        // Fallback: create a blob and download it
        await downloadAsBlob(jobId, audioData.chunks);
      } else {
        // For other errors, try the blob method as fallback
        console.log('File save failed, trying alternative download...');
        await downloadAsBlob(jobId, audioData.chunks);
      }
    }
  } else {
    alert('No audio data found for this job');
  }
};

// Alternative download method using blob URLs
async function downloadAsBlob(jobId, chunks) {
  try {
    updateProgress(0, "Creating audio file...");
    
    // Combine chunks into a single array
    const samples = [];
    for (const chunk of chunks) {
      const chunkArray = new Float32Array(chunk);
      for (let i = 0; i < chunkArray.length; i++) {
        samples.push(chunkArray[i]);
      }
    }
    const allSamples = new Float32Array(samples);
    
    // Create WAV header
    const numChannels = 1;
    const sampleRate = 24000;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = allSamples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    
    // WAV header
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);
    
    // Write audio data
    for (let i = 0; i < allSamples.length; i++) {
      const sample = Math.max(-1, Math.min(1, allSamples[i]));
      view.setInt16(44 + i * 2, sample * 0x7FFF, true);
    }
    
    // Create blob and download
    const blob = new Blob([buffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tts_audio_${jobId}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    updateProgress(100, "Download complete!");
  } catch (error) {
    console.error('Blob download error:', error);
    alert('Download failed: ' + error.message);
  }
}

window.deleteQueueJob = async function(jobId) {
  if (confirm(`Delete job #${jobId}?`)) {
    await queueManager.deleteJob(jobId);
    updateQueueUI();
  }
};

window.clearCompletedJobs = async function() {
  const count = await queueManager.clearCompletedJobs();
  alert(`Cleared ${count} completed job(s)`);
  updateQueueUI();
};

window.refreshQueueDisplay = async function() {
  // Add a small visual feedback for the refresh
  const refreshBtn = document.querySelector('.queue-btn-refresh');
  if (refreshBtn) {
    refreshBtn.style.opacity = '0.7';
    setTimeout(() => {
      refreshBtn.style.opacity = '1';
    }, 200);
  }
  
  // Force refresh the queue display
  updateQueueUI();
  
  // Also refresh the queue stats
  const stats = await queueManager.getQueueStats();
  console.log('Queue refreshed:', stats);
};

// ===== INITIALIZATION =====

document.addEventListener('DOMContentLoaded', async () => {
  updateProgress(0, "Initializing Kokoro model...");
  document.getElementById("progressContainer").style.display = "block";
  document.getElementById("ta").value = await (await fetch('./end.txt')).text();
  buttonHandler.init();

  // Initialize queue manager
  await queueManager.init();
  
  // Connect queue manager to button handler
  buttonHandler.setQueueManager(queueManager);
  queueManager.onQueueUpdate = updateQueueUI;
  queueManager.onJobComplete = (jobId, success) => {
    console.log(`Job ${jobId} completed: ${success}`);
  };
  
  // Update queue UI
  updateQueueUI();

  // Speed slider setup
  const speedSlider = document.getElementById('speed-slider');
  const speedLabel = document.getElementById('speed-label');
  if (speedSlider && speedLabel) {
    speedLabel.textContent = getRealSpeed(parseFloat(speedSlider.value)).toFixed(2);
    speedSlider.addEventListener('input', () => {
      const sliderValue = parseFloat(speedSlider.value);
      const realSpeed = getRealSpeed(sliderValue);
      speedLabel.textContent = realSpeed.toFixed(2);
    });
  }
  
  // Add queue mode checkbox handler
  const queueModeCheckbox = document.getElementById('queueMode');
  if (queueModeCheckbox) {
    queueModeCheckbox.addEventListener('change', (e) => {
      const queueInfo = document.getElementById('queueInfo');
      if (queueInfo) {
        queueInfo.style.display = e.target.checked ? 'block' : 'none';
      }
    });
  }
});

window.addEventListener("beforeunload", () => {
  audioPlayer.close();
});

// Export queue manager for debugging
window.queueManager = queueManager;
