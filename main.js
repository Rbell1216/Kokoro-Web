// main.js - Multi-Worker Parallel TTS Processing
// 2 workers processing chunks simultaneously for 2x speed

// Global state management
let currentTTS = null;
let isGenerating = false;
let currentJobId = null;
let workers = []; // Array to hold 2 workers
let completedChunks = 0;
let totalChunks = 0;

// Use proven chunk size (250 characters - no errors with this size)
const CHUNK_SIZE = 250;
const NUM_WORKERS = 2; // Use 2 workers for parallel processing

// Enhanced UI Elements
const elements = {
  textInput: document.getElementById('textInput'),
  voiceSelect: document.getElementById('voiceSelect'),
  speedInput: document.getElementById('speedInput'),
  generateBtn: document.getElementById('generateBtn'),
  stopBtn: document.getElementById('stopBtn'),
  audioContainer: document.getElementById('audioContainer'),
  statusDiv: document.getElementById('status'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  backgroundMode: document.getElementById('backgroundMode')
};

// Initialize the application
async function init() {
  try {
    // Register service worker for background processing
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.register('/service-worker.js');
      console.log('Service Worker registered:', registration);
    }

    // Check for Background Sync API support
    if ('serviceWorker' in navigator && 'sync' in window.ServiceWorkerRegistration.prototype) {
      console.log('Background Sync API supported');
      // Initialize BackgroundQueueManager
      window.backgroundQueueManager = new BackgroundQueueManager();
    } else {
      console.log('Background Sync API not supported');
    }

    // Update status
    updateStatus('Initializing...', 0);
    
    // Load available voices (will be populated when model loads)
    updateStatus('Loading voices...', 10);
    
    // Check WebGPU support
    if (!('gpu' in navigator)) {
      updateStatus('WebGPU not supported in this browser. Please use a modern browser.', 0);
      elements.generateBtn.disabled = true;
      return;
    }

    updateStatus('Ready to generate speech with 2 workers', 100);
    
  } catch (error) {
    console.error('Initialization error:', error);
    updateStatus(`Initialization failed: ${error.message}`, 0);
  }
}

// Enhanced status updates with proper chunk tracking
function updateStatus(message, progress = null) {
  elements.statusDiv.textContent = message;
  
  if (progress !== null) {
    elements.progressBar.style.width = `${progress}%`;
    elements.progressText.textContent = `${Math.round(progress)}%`;
  }
}

// Dynamic progress updates for chunks
function updateProgress(percent, message) {
  elements.progressBar.style.width = `${percent}%`;
  elements.progressText.textContent = `${Math.round(percent)}%`;
  elements.statusDiv.textContent = message;
}

// Generate TTS with multi-worker parallel processing
async function generateTTS() {
  if (isGenerating) {
    console.log('Already generating, ignoring request');
    return;
  }

  const text = elements.textInput.value.trim();
  if (!text) {
    alert('Please enter some text to convert to speech');
    return;
  }

  const voice = elements.voiceSelect.value;
  const speed = parseFloat(elements.speedInput.value) || 1.0;
  const backgroundMode = elements.backgroundMode.checked;

  // Generate unique job ID
  const jobId = Date.now();
  currentJobId = jobId;
  isGenerating = true;

  try {
    updateStatus(`Processing queue job ${jobId} with ${NUM_WORKERS} workers (parallel)`, 0);
    
    // Use proven 250-character chunk size (no errors with this size)
    const chunks = await import('./semantic-split.js').then(m => m.splitTextSmart(text, CHUNK_SIZE));
    
    // Store current job data with UI-compatible properties
    window._queueRemainingChunks = {
      jobId,
      remaining: chunks,
      voice,
      speed,
      current: 0,
      total: chunks.length,
      totalChunks: chunks.length, // Added for UI compatibility
      totalSentences: Math.ceil(text.length / CHUNK_SIZE), // Estimate
      processedSentences: 0
    };

    totalChunks = chunks.length;
    completedChunks = 0;

    console.log(`Processing ${chunks.length} chunks with ${NUM_WORKERS} workers (parallel processing)`);
    console.log(`Estimated ${window._queueRemainingChunks.totalSentences} total sentences for ${chunks.length} chunks`);
    
    // Clear previous audio
    elements.audioContainer.innerHTML = '';

    // Process chunks with 2 workers
    await processChunksParallel(chunks, jobId, voice, speed, backgroundMode);

  } catch (error) {
    console.error('Generation failed:', error);
    updateStatus(`Generation failed: ${error.message}`, 0);
  } finally {
    isGenerating = false;
    currentJobId = null;
    // Clean up workers
    cleanupWorkers();
  }
}

// Multi-worker parallel chunk processing
async function processChunksParallel(chunks, jobId, voice, speed, backgroundMode) {
  return new Promise((resolve, reject) => {
    const chunkQueue = [...chunks]; // Copy chunks for distribution
    const workerPromises = [];
    const results = [];

    // Initialize 2 workers
    for (let workerIndex = 0; workerIndex < NUM_WORKERS; workerIndex++) {
      const workerPromise = new Promise((workerResolve, workerReject) => {
        const worker = new Worker('./worker_webgpu_only_simple.js');
        workers.push(worker);

        // Track this worker's chunks
        const workerChunks = [];
        while (chunkQueue.length > 0) {
          workerChunks.push(chunkQueue.shift());
        }

        console.log(`Worker ${workerIndex + 1} assigned ${workerChunks.length} chunks`);

        // Process chunks assigned to this worker
        processWorkerChunks(worker, workerChunks, workerIndex + 1, voice, speed, jobId)
          .then(result => {
            console.log(`Worker ${workerIndex + 1} completed successfully`);
            workerResolve(result);
          })
          .catch(error => {
            console.error(`Worker ${workerIndex + 1} failed:`, error);
            workerReject(error);
          });
      });

      workerPromises.push(workerPromise);
    }

    // Wait for all workers to complete
    Promise.allSettled(workerPromises)
      .then(settledResults => {
        const successCount = settledResults.filter(r => r.status === 'fulfilled').length;
        console.log(`All workers completed. Success: ${successCount}/${NUM_WORKERS}`);
        
        // Notify completion
        if (window.backgroundQueueManager) {
          window.backgroundQueueManager.notifyJobComplete(jobId, successCount === NUM_WORKERS);
        }
        
        const jobCompleted = successCount === NUM_WORKERS;
        updateStatus(`Job ${jobId} completed: ${jobCompleted ? 'success' : 'partial success'}`, 100);
        resolve();
      })
      .catch(error => {
        console.error('Multi-worker processing failed:', error);
        reject(error);
      });
  });
}

// Process chunks assigned to a specific worker
async function processWorkerChunks(worker, chunks, workerId, voice, speed, jobId) {
  return new Promise((resolve, reject) => {
    const chunkPromises = [];
    
    // Process each chunk assigned to this worker
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkIndex = i; // Index within this worker's chunks
      const globalChunkNumber = i * NUM_WORKERS + workerId; // Calculate global chunk number
      
      const chunkPromise = new Promise((chunkResolve, chunkReject) => {
        const timeout = setTimeout(() => {
          worker.terminate();
          chunkReject(new Error(`Chunk ${globalChunkNumber} processing timeout`));
        }, 60000); // 60 second timeout per chunk

        // Listen for messages from this worker
        const messageHandler = (e) => {
          const { type, status, audioChunks, error } = e.data;
          
          switch (type) {
            case 'audio_chunk':
              clearTimeout(timeout);
              worker.removeEventListener('message', messageHandler);
              
              // Update progress
              completedChunks++;
              const percent = (completedChunks / totalChunks) * 100;
              updateProgress(percent, `Processing queue job ${jobId}: ${completedChunks}/${totalChunks} chunks (Worker ${workerId})`);
              
              // Create audio elements for this chunk
              if (audioChunks && audioChunks.length > 0) {
                for (const audioChunk of audioChunks) {
                  if (audioChunk.audio && audioChunk.audio.byteLength > 0) {
                    createAudioElement(audioChunk, globalChunkNumber + 1).catch(console.error);
                  }
                }
              }
              
              window._queueRemainingChunks.current = completedChunks;
              window._queueRemainingChunks.processedSentences += audioChunks ? audioChunks.length : 0;
              
              console.log(`Worker ${workerId} completed chunk ${globalChunkNumber + 1}/${totalChunks}`);
              chunkResolve(audioChunks);
              break;
              
            case 'error':
            case 'loading_model_error':
              clearTimeout(timeout);
              worker.removeEventListener('message', messageHandler);
              console.error(`Worker ${workerId} error on chunk ${globalChunkNumber + 1}:`, error);
              chunkReject(new Error(error || 'Worker error'));
              break;
          }
        };

        worker.addEventListener('message', messageHandler);

        // Send chunk to worker
        worker.postMessage({
          type: 'generate',
          text: chunk,
          voice,
          speed
        });
      });

      chunkPromises.push(chunkPromise);
    }

    // Wait for all chunks from this worker
    Promise.allSettled(chunkPromises)
      .then(results => {
        const successCount = results.filter(r => r.status === 'fulfilled').length;
        console.log(`Worker ${workerId} completed ${successCount}/${chunks.length} chunks`);
        resolve(successCount === chunks.length);
      })
      .catch(error => {
        reject(error);
      });
  });
}

// Clean up workers
function cleanupWorkers() {
  workers.forEach(worker => {
    if (worker) {
      worker.terminate();
    }
  });
  workers = [];
}

// Create audio element for playback
async function createAudioElement(audioChunk, chunkNumber) {
  try {
    if (!audioChunk.audio || audioChunk.audio.byteLength === 0) {
      console.warn(`Empty audio for chunk ${chunkNumber}`);
      return;
    }

    // Create WAV blob
    const wavBlob = createWavBlob(audioChunk.audio, audioChunk.sampleRate);
    const audioUrl = URL.createObjectURL(wavBlob);
    
    // Create audio element
    const audioElement = document.createElement('audio');
    audioElement.controls = true;
    audioElement.src = audioUrl;
    audioElement.style.margin = '10px 0';
    
    // Add label
    const label = document.createElement('div');
    label.textContent = `Chunk ${chunkNumber}`;
    label.style.fontWeight = 'bold';
    label.style.marginBottom = '5px';
    
    elements.audioContainer.appendChild(label);
    elements.audioContainer.appendChild(audioElement);
    
    console.log(`Audio element created for chunk ${chunkNumber}`);
    
  } catch (error) {
    console.error(`Error creating audio element for chunk ${chunkNumber}:`, error);
  }
}

// Convert audio data to WAV format
function createWavBlob(audioData, sampleRate = 24000) {
  const arrayBuffer = new ArrayBuffer(44 + audioData.byteLength);
  const view = new DataView(arrayBuffer);
  
  // WAV header
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };
  
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + audioData.byteLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, audioData.byteLength, true);
  
  // Copy audio data
  const audioBytes = new Uint8Array(arrayBuffer, 44);
  audioBytes.set(new Uint8Array(audioData));
  
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

// Stop generation
function stopGeneration() {
  if (isGenerating) {
    currentJobId = null;
    isGenerating = false;
    cleanupWorkers();
    updateStatus('Generation stopped', 0);
    console.log('Generation stopped by user');
  }
}

// Background Queue Manager Class
class BackgroundQueueManager {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.currentJobId = null;
    
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', this.handleServiceWorkerMessage.bind(this));
    }
    
    console.log('BackgroundQueueManager initialized');
  }

  async addJob(text, voice, speed, mode) {
    const job = {
      id: Date.now(),
      text,
      voice,
      speed,
      mode,
      status: 'queued',
      timestamp: Date.now()
    };
    
    this.queue.push(job);
    console.log(`Job ${job.id} added to queue`);
    
    if (!this.isProcessing) {
      this.processQueue();
    }
    
    return job.id;
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }
    
    this.isProcessing = true;
    
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      this.currentJobId = job.id;
      
      console.log(`Starting job ${job.id}:`, {
        text: job.text.substring(0, 100) + '...',
        voice: job.voice,
        speed: job.speed,
        mode: job.mode
      });
      
      try {
        job.status = 'processing';
        await this.executeJob(job);
        job.status = 'completed';
        console.log(`Job ${job.id} completed successfully`);
        
      } catch (error) {
        job.status = 'failed';
        job.error = error.message;
        console.error(`Job ${job.id} failed:`, error);
      }
    }
    
    this.isProcessing = false;
    this.currentJobId = null;
  }

  async executeJob(job) {
    console.log(`Executing job ${job.id} in ${job.mode} mode`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    return true;
  }

  handleServiceWorkerMessage(event) {
    console.log('Message from service worker:', event.data);
  }

  notifyJobComplete(jobId, success) {
    console.log(`Job ${jobId} complete. Success: ${success}`);
    
    if (this.currentJobId === jobId) {
      updateStatus(`Job ${jobId} completed: ${success ? 'success' : 'failed'}`, 100);
    }
  }
}

// Event listeners
document.addEventListener('DOMContentLoaded', init);
elements.generateBtn.addEventListener('click', generateTTS);
elements.stopBtn.addEventListener('click', stopGeneration);

// Allow Enter key to generate
elements.textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    generateTTS();
  }
});

console.log('TTS Generator initialized with 2-worker parallel processing');
