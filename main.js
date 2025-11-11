import { updateProgress } from "./updateProgress.js";
import { AudioPlayer } from "./AudioPlayer.js";
import { AudioDiskSaver } from "./AudioDiskSaver.js";
import { ButtonHandler } from "./ButtonHandler.js";
import { BackgroundQueueManager } from "./BackgroundQueueManager.js";

// --- Helper function to remap the slider value ---
function getRealSpeed(sliderValue) {
  return 0.5 * sliderValue + 0.5;
}

// Register service worker
if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
  navigator.serviceWorker.register("./service-worker.js").then((registration) => {
    console.log("Service Worker registered:", registration);
    if ('sync' in registration) {
      console.log('Background Sync API supported');
    } else {
      console.log('Background Sync not supported, using foreground processing');
    }
  }).catch(err => {
    console.warn("Service Worker registration failed:", err);
  });
} else if (window.location.hostname === "localhost") {
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
let currentJobEstimation = null;
let totalChunksForJob = 0; // Track total expected chunks

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
        setTimeout(() => queueManager.processNextJob(), 1000);
      }
      break;

    case "loading_model_progress":
      let progress = Number(e.data.progress) * 100;
      if (isNaN(progress)) progress = 0;
      updateProgress(progress, `Loading model: ${Math.round(progress)}%`);
      break;

    case "stream_audio_data":
      if (currentQueueJobId) {
        // Queue job - save chunks
        const audioData = new Float32Array(e.data.audio);
        audioChunksForQueue.push(audioData);
        
        const chunkNum = audioChunksForQueue.length;
        const totalChunks = totalChunksForJob || currentJobEstimation || window._queueRemainingChunks?.totalChunks || 10;
        
        const percent = Math.min((chunkNum / totalChunks) * 100, 99); // Cap at 99% until truly complete
        
        await queueManager.updateJobProgress(currentQueueJobId, percent, chunkNum, totalChunks);
        updateProgress(percent, `Processing queue job ${currentQueueJobId}: ${chunkNum}/${totalChunks} chunks (${Math.round(percent)}%)`);
        
        console.log(`Audio chunk ${chunkNum}/${totalChunks} received for job ${currentQueueJobId}`);
        
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

    case "chunk_progress":
      // Update total chunks tracking
      if (currentQueueJobId && e.data.sentencesInChunk) {
        // This is for chunk-level progress, update our tracking
        console.log(`Processing chunk with ${e.data.sentencesInChunk} sentences`);
      }
      break;

    case "complete":
      if (currentQueueJobId) {
        const successfulChunks = audioChunksForQueue.length;
        const totalExpected = totalChunksForJob || window._queueRemainingChunks?.totalChunks || currentJobEstimation || 0;
        
        console.log(`Job ${currentQueueJobId} complete: ${successfulChunks}/${totalExpected} chunks successful`);
        
        // Only mark as complete if we have meaningful audio data
        if (successfulChunks > 0) {
          await queueManager.updateJobProgress(currentQueueJobId, 100, successfulChunks, totalExpected);
          await queueManager.jobComplete(currentQueueJobId, audioChunksForQueue, true);
          updateProgress(100, `Queue job complete! (${successfulChunks}/${totalExpected} chunks)`);
        } else {
          // No audio chunks were successful
          console.warn(`Job ${currentQueueJobId} failed - no successful chunks`);
          await queueManager.jobComplete(currentQueueJobId, null, false);
          updateProgress(100, `Queue job failed - no successful chunks`);
        }
        
        // Reset tracking
        currentQueueJobId = null;
        currentQueueMode = null;
        audioChunksForQueue = [];
        currentJobEstimation = null;
        totalChunksForJob = 0;
        window._queueRemainingChunks = null;
        
        updateQueueUI();
        
      } else {
        // Manual job complete
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
  
  if (currentQueueJobId) {
    queueManager.jobComplete(currentQueueJobId, null, false);
    currentQueueJobId = null;
    currentQueueMode = null;
    audioChunksForQueue = [];
    currentJobEstimation = null;
    totalChunksForJob = 0;
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
  
  currentQueueJobId = jobId;
  currentQueueMode = mode;
  audioChunksForQueue = [];
  currentJobEstimation = null;
  totalChunksForJob = 0;
  
  try {
    // Use the improved chunking approach that matches the worker
    const chunks = chunkTextBetter(text, 400, 800);
    
    console.log(`Processing ${chunks.length} chunks for job ${jobId}`);
    
    if (chunks.length === 0) {
      await queueManager.jobComplete(jobId, null, false);
      updateProgress(100, "No text to process");
      return;
    }
    
    totalChunksForJob = chunks.length;
    
    // Calculate estimated sentences
    let totalEstimatedSentences = 0;
    for (const chunk of chunks) {
      const sentenceCount = Math.max(1, Math.ceil(chunk.length / 150));
      totalEstimatedSentences += sentenceCount;
    }
    
    console.log(`Estimated ${totalEstimatedSentences} total sentences for ${chunks.length} chunks`);
    currentJobEstimation = totalEstimatedSentences;
    
    // Store chunk info
    window._queueRemainingChunks = {
      jobId,
      remaining: chunks,
      voice,
      speed,
      current: 0,
      total: chunks.length,
      totalChunks: chunks.length,
      totalSentences: totalEstimatedSentences
    };
    
    // Process the entire text as one batch (the worker will handle chunking)
    const fullText = chunks.join(' ');
    console.log(`Processing full text (${fullText.length} characters) for job ${jobId}`);
    
    tts_worker.postMessage({ 
      type: "generate", 
      text: fullText, 
      voice: voice, 
      speed: speed 
    });
    
    updateProgress(0, `Processing queue job ${jobId} (0/${chunks.length} chunks)...`);
    
  } catch (error) {
    console.error("Error processing queue job:", error);
    tts_worker.postMessage({ 
      type: "generate", 
      text: text, 
      voice: voice, 
      speed: speed 
    });
    updateProgress(0, `Processing queue job ${jobId}...`);
  }
});

// Show completed job
window.addEventListener('queue-show-job', async (event) => {
  const { jobId } = event.detail;
  const audioData = await queueManager.getAudioData(jobId);
  
  if (audioData && audioData.chunks) {
    console.log(`Playing completed job ${jobId}`);
    for (const chunk of audioData.chunks) {
      await audioPlayer.queueAudio(chunk);
    }
    updateProgress(100, `Playing job ${jobId}`);
  }
});

// Better text chunking function to match worker
function chunkTextBetter(text, minChars = 400, maxChars = 800) {
  const sentences = text.split(/[.!?]+(?:\s+|$)/).filter(s => s.trim().length > 0);
  const chunks = [];
  let currentChunk = '';
  
  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;
    
    if (currentChunk && (currentChunk + '. ' + trimmedSentence).length > maxChars) {
      if (currentChunk.length >= minChars) {
        chunks.push(currentChunk.trim() + '.');
        currentChunk = trimmedSentence;
      } else {
        currentChunk += (currentChunk ? '. ' : '') + trimmedSentence;
      }
    } else {
      currentChunk += (currentChunk ? '. ' : '') + trimmedSentence;
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim() + '.');
  }
  
  return chunks;
}

// ===== QUEUE UI MANAGEMENT =====

async function updateQueueUI() {
  const queueContainer = document.getElementById('queueContainer');
  const queueList = document.getElementById('queueList');
  const queueStats = document.getElementById('queueStats');
  
  const stats = await queueManager.getQueueStats();
  const jobs = await queueManager.getAllJobs();
  
  queueStats.textContent = `${stats.queued} queued, ${stats.processing} processing, ${stats.complete} complete`;
  
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
      'queued': '⏳',
      'processing': '⚙️',
      'complete': '✅',
      'failed': '❌'
    }[job.status] || '❓';
    
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
        ${job.progress > 0 ? `
          <div class="queue-progress-info">
            <span>Progress: ${Math.round(job.progress)}%</span>
            <div class="queue-progress-bar">
              <div class="queue-progress-fill" style="width: ${job.progress}%"></div>
            </div>
            ${job.chunks && job.totalChunks ? `<span class="chunks-info">${job.chunks}/${job.totalChunks} chunks</span>` : ''}
          </div>
        ` : ''}
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
    try {
      await audioDiskSaver.initSave();
      for (const chunk of audioData.chunks) {
        await audioDiskSaver.addAudioChunk(chunk);
      }
      await audioDiskSaver.finalizeSave();
      updateProgress(100, "Download complete!");
    } catch (error) {
      console.error('Download error:', error);
      if (error.message && (error.message.includes('user aborted') || error.message.includes('abort'))) {
        await downloadAsBlob(jobId, audioData.chunks);
      } else {
        await downloadAsBlob(jobId, audioData.chunks);
      }
    }
  } else {
    alert('No audio data found for this job');
  }
};

async function downloadAsBlob(jobId, chunks) {
  try {
    updateProgress(0, "Creating audio file...");
    const samples = [];
    for (const chunk of chunks) {
      const chunkArray = new Float32Array(chunk);
      for (let i = 0; i < chunkArray.length; i++) {
        samples.push(chunkArray[i]);
      }
    }
    const allSamples = new Float32Array(samples);
    
    const numChannels = 1;
    const sampleRate = 24000;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = allSamples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    
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
    
    for (let i = 0; i < allSamples.length; i++) {
      const sample = Math.max(-1, Math.min(1, allSamples[i]));
      view.setInt16(44 + i * 2, sample * 0x7FFF, true);
    }
    
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
  const refreshBtn = document.querySelector('.queue-btn-refresh');
  if (refreshBtn) {
    refreshBtn.style.opacity = '0.7';
    setTimeout(() => {
      refreshBtn.style.opacity = '1';
    }, 200);
  }
  updateQueueUI();
  const stats = await queueManager.getQueueStats();
  console.log('Queue refreshed:', stats);
};

// ===== INITIALIZATION =====

document.addEventListener('DOMContentLoaded', async () => {
  updateProgress(0, "Initializing Kokoro model...");
  document.getElementById("progressContainer").style.display = "block";
  document.getElementById("ta").value = await (await fetch('./end.txt')).text();
  buttonHandler.init();

  await queueManager.init();
  buttonHandler.setQueueManager(queueManager);
  queueManager.onQueueUpdate = updateQueueUI;
  queueManager.onJobComplete = (jobId, success) => {
    console.log(`Job ${jobId} completed: ${success}`);
  };
  
  updateQueueUI();

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

window.queueManager = queueManager;
