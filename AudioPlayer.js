import { updateProgress } from "./updateProgress.js";

const SAMPLE_RATE = 24000;

export class AudioPlayer {

  constructor(worker) {
    this.audioContext = new AudioContext();
    this.audioQueue = []; // Queue just stores buffers
    this.isPlaying = false;
    this.worker = worker;
    this.totalAudioChunks = 0;
    this.processedAudioChunks = 0;
    this.currentSource = null; // Track current audio source for stopping
  }

  setTotalChunks(totalChunks) {
    this.totalAudioChunks = totalChunks;
    this.processedAudioChunks = 0;
  }

  async queueAudio(audioData) {
    const audioData2 = new Float32Array(audioData);
    const audioBuffer = this.audioContext.createBuffer(1, audioData2.length, SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(audioData2);
    
    this.audioQueue.push(audioBuffer); // Just store the buffer
    this.playAudioQueue();
  }

  async playAudioQueue() {
    if (this.isPlaying || this.audioQueue.length === 0) return;

    this.isPlaying = true;
    try {
      while (this.audioQueue.length > 0) {
        const buffer = this.audioQueue.shift(); // Get the next buffer

        const source = this.audioContext.createBufferSource();
        this.currentSource = source; 
        source.buffer = buffer; 
        source.connect(this.audioContext.destination);
        
        // --- THIS IS REMOVED ---
        // No longer setting playbackRate here
        // --- END OF REMOVAL ---

        if (this.audioContext.state === "suspended") {
          await this.audioContext.resume();
          console.log("AudioContext resumed.");
        }

        console.log("Playing audio buffer");
        await new Promise((resolve) => {
          source.onended = () => {
            this.currentSource = null; 
            resolve();
          };
          source.start();
        });

        console.log("Audio playback finished.");

        this.processedAudioChunks++;
        const percent = Math.min((this.processedAudioChunks / this.totalAudioChunks) * 100, 99);
        updateProgress(percent, "Processing text...");

        this.worker.postMessage({type: "buffer_processed"});
      }
    } catch (error) {
      console.error("Error during audio playback:", error);
    } finally {
      this.isPlaying = false;
    }
  }

  stop() {
    console.log("Stopping audio playback");
    
    if (this.currentSource) {
      try {
        this.currentSource.stop();
        this.currentSource = null;
      } catch (error) {
        console.error("Error stopping current source:", error);
      }
    }
    
    this.audioQueue = [];
    this.isPlaying = false;
    
    if (this.worker) {
      this.worker.postMessage({
        type: "stop"
      });
    }
  }

  close() {
    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close();
    }
  }

  getAudioContext() {
    return this.audioContext;
  }
}
