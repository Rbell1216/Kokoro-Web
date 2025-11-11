// BackgroundQueueManager.js
// Manages background TTS job queue with IndexedDB persistence

export class BackgroundQueueManager {
  constructor() {
    this.db = null;
    this.swRegistration = null;
    this.isProcessing = false;
    this.currentJobId = null;
    this.onJobComplete = null;
    this.onQueueUpdate = null;
  }

  async init() {
    // Open IndexedDB
    this.db = await this.openDB();
    
    // Register service worker for GitHub Pages (HTTPS)
    if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
      try {
        this.swRegistration = await navigator.serviceWorker.register('./service-worker.js');
        console.log('Service Worker registered for background processing');
      } catch (error) {
        console.warn('Service Worker registration failed:', error);
      }
    }
    
    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      console.log('Notification permission:', permission);
    }
    
    // Check for pending jobs on startup
    const pendingCount = await this.checkPendingJobs();
    
    return pendingCount;
  }

  async openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('KokoroTTSDatabase', 2);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Queue store
        if (!db.objectStoreNames.contains('queue')) {
          const queueStore = db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
          queueStore.createIndex('status', 'status', { unique: false });
          queueStore.createIndex('createdAt', 'createdAt', { unique: false });
        }
        
        // Audio store (for completed jobs)
        if (!db.objectStoreNames.contains('audio')) {
          db.createObjectStore('audio', { keyPath: 'jobId' });
        }
      };
    });
  }

  async addJob(text, voice, speed, mode = 'stream') {
    const job = {
      text,
      voice,
      speed,
      mode,
      status: 'queued',
      createdAt: new Date().toISOString(),
      progress: 0,
      chunks: 0,
      totalChunks: 0
    };

    const tx = this.db.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');
    
    return new Promise((resolve, reject) => {
      const request = store.add(job);
      request.onsuccess = () => {
        const jobId = request.result;
        console.log(`Job ${jobId} added to queue`);
        
        // Trigger UI update
        if (this.onQueueUpdate) this.onQueueUpdate();
        
        // Start processing if not already running
        this.processNextJob();
        
        resolve(jobId);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async processNextJob() {
    if (this.isProcessing) {
      console.log('Already processing a job, skipping...');
      return;
    }

    const jobs = await this.getJobsByStatus('queued');
    if (jobs.length === 0) {
      console.log('No queued jobs to process');
      return;
    }

    this.isProcessing = true;
    const job = jobs[0];
    this.currentJobId = job.id;

    console.log(`Starting job ${job.id}:`, job);

    // Update status to processing
    await this.updateJobStatus(job.id, 'processing');

    // Dispatch event for main app to process
    window.dispatchEvent(new CustomEvent('queue-process-job', { 
      detail: { 
        jobId: job.id,
        text: job.text,
        voice: job.voice,
        speed: job.speed,
        mode: job.mode
      } 
    }));

    // Note: Job completion is handled by jobComplete() method
  }

  async jobComplete(jobId, audioChunks = null, success = true) {
    console.log(`Job ${jobId} complete. Success: ${success}`);
    
    if (success && audioChunks && audioChunks.length > 0) {
      // Store audio data
      await this.saveAudioData(jobId, audioChunks);
      await this.updateJobStatus(jobId, 'complete');
      
      // Show notification
      this.showNotification('TTS Complete', `Audio conversion finished! Click to play.`, jobId);
    } else if (success) {
      // For stream mode (no chunks to save)
      await this.updateJobStatus(jobId, 'complete');
      this.showNotification('TTS Complete', `Audio streaming finished!`, jobId);
    } else {
      await this.updateJobStatus(jobId, 'failed');
    }

    // Callback
    if (this.onJobComplete) {
      this.onJobComplete(jobId, success);
    }

    // Reset state
    this.isProcessing = false;
    this.currentJobId = null;

    // Update UI
    if (this.onQueueUpdate) this.onQueueUpdate();

    // Process next job
    setTimeout(() => this.processNextJob(), 500);
  }

  async updateJobStatus(id, status, progress = null) {
    const tx = this.db.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');
    
    return new Promise((resolve, reject) => {
      const getRequest = store.get(id);
      getRequest.onsuccess = () => {
        const job = getRequest.result;
        if (job) {
          job.status = status;
          if (progress !== null) job.progress = progress;
          if (status === 'complete') job.completedAt = new Date().toISOString();
          if (status === 'failed') job.failedAt = new Date().toISOString();
          
          const putRequest = store.put(job);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          resolve();
        }
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  async updateJobProgress(id, progress, chunks, totalChunks) {
    const tx = this.db.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');
    
    return new Promise((resolve, reject) => {
      const getRequest = store.get(id);
      getRequest.onsuccess = () => {
        const job = getRequest.result;
        if (job) {
          job.progress = progress;
          job.chunks = chunks;
          job.totalChunks = totalChunks;
          
          const putRequest = store.put(job);
          putRequest.onsuccess = () => {
            if (this.onQueueUpdate) this.onQueueUpdate();
            resolve();
          };
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          resolve();
        }
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  async saveAudioData(jobId, audioChunks) {
    const tx = this.db.transaction('audio', 'readwrite');
    const store = tx.objectStore('audio');
    
    return new Promise((resolve, reject) => {
      const request = store.put({ 
        jobId, 
        chunks: audioChunks,
        savedAt: new Date().toISOString()
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getAudioData(jobId) {
    const tx = this.db.transaction('audio', 'readonly');
    const store = tx.objectStore('audio');
    
    return new Promise((resolve, reject) => {
      const request = store.get(jobId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getJobsByStatus(status) {
    const tx = this.db.transaction('queue', 'readonly');
    const store = tx.objectStore('queue');
    const index = store.index('status');
    
    return new Promise((resolve, reject) => {
      const request = index.getAll(status);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllJobs() {
    const tx = this.db.transaction('queue', 'readonly');
    const store = tx.objectStore('queue');
    
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteJob(id) {
    const tx = this.db.transaction(['queue', 'audio'], 'readwrite');
    
    return new Promise((resolve, reject) => {
      const queueRequest = tx.objectStore('queue').delete(id);
      queueRequest.onsuccess = () => {
        const audioRequest = tx.objectStore('audio').delete(id);
        audioRequest.onsuccess = () => {
          if (this.onQueueUpdate) this.onQueueUpdate();
          resolve();
        };
        audioRequest.onerror = () => reject(audioRequest.error);
      };
      queueRequest.onerror = () => reject(queueRequest.error);
    });
  }

  async clearCompletedJobs() {
    const completed = await this.getJobsByStatus('complete');
    const tx = this.db.transaction(['queue', 'audio'], 'readwrite');
    
    for (const job of completed) {
      await tx.objectStore('queue').delete(job.id);
      await tx.objectStore('audio').delete(job.id);
    }
    
    if (this.onQueueUpdate) this.onQueueUpdate();
    
    return completed.length;
  }

  async checkPendingJobs() {
    const processing = await this.getJobsByStatus('processing');
    const queued = await this.getJobsByStatus('queued');
    
    // Reset processing jobs to queued (in case of crash/refresh)
    for (const job of processing) {
      await this.updateJobStatus(job.id, 'queued');
    }
    
    const totalPending = processing.length + queued.length;
    
    if (totalPending > 0) {
      console.log(`Found ${totalPending} pending jobs`);
      
      // Show notification if we have permission
      if ('Notification' in window && Notification.permission === 'granted') {
        this.showNotification(
          'TTS Jobs Pending', 
          `You have ${totalPending} pending audio conversion(s). Processing will resume.`,
          null
        );
      }
    }
    
    return totalPending;
  }

  showNotification(title, body, jobId = null) {
    if ('Notification' in window && Notification.permission === 'granted') {
      const notification = new Notification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: jobId ? `tts-job-${jobId}` : 'tts-notification',
        requireInteraction: false,
        silent: false
      });

      notification.onclick = () => {
        window.focus();
        notification.close();
        if (jobId) {
          // Dispatch event to show completed job
          window.dispatchEvent(new CustomEvent('queue-show-job', { detail: { jobId } }));
        }
      };
    }
  }

  getCurrentJobId() {
    return this.currentJobId;
  }

  isCurrentlyProcessing() {
    return this.isProcessing;
  }

  async getQueueStats() {
    const all = await this.getAllJobs();
    return {
      total: all.length,
      queued: all.filter(j => j.status === 'queued').length,
      processing: all.filter(j => j.status === 'processing').length,
      complete: all.filter(j => j.status === 'complete').length,
      failed: all.filter(j => j.status === 'failed').length
    };
  }
}
