import { updateProgress } from "./updateProgress.js";

const CHUNK_SIZE = 5000; // Process 5000 characters at a time

export class ButtonHandler {
  constructor(worker, audioPlayer, audioDiskSaver, getRealSpeedFunc) {
    this.worker = worker;
    this.audioPlayer = audioPlayer;
    this.audioDiskSaver = audioDiskSaver;
    this.getRealSpeed = getRealSpeedFunc; 
    this.mode = "none";
    this.isStreaming = false;

    // --- NEW LOGIC FOR DISPATCHING ---
    this.textQueue = [];
    this.currentChunkIndex = 0;
    // --- END NEW LOGIC ---

    this.handleStreamButtonClick = this.handleStreamButtonClick.bind(this);
    this.handleDiskButtonClick = this.handleDiskButtonClick.bind(this);
  }

  init() {
    document.getElementById("streamAudioContext").addEventListener("click", this.handleStreamButtonClick);
    document.getElementById("streamDisk").addEventListener("click", this.handleDiskButtonClick);
  }

  getTtsOptions() {
    const text = document.getElementById("ta").value;
    const voice = document.getElementById("voiceSelector").value;
    const sliderValue = parseFloat(document.getElementById('speed-slider').value);
    const speed = this.getRealSpeed(sliderValue); 
    return { text, voice, speed };
  }
  
  // --- STREAMING (Full script) ---
  handleStreamButtonClick() {
    if (this.isStreaming) {
      this.resetStreamingState();
      this.audioPlayer.stop(); 
      updateProgress(100, "Streaming stopped");
      return;
    }

    this.setStreamingState("stream");
    const { text, voice, speed } = this.getTtsOptions();
    if (text.trim().length === 0) {
        this.resetStreamingState();
        return;
    }
    
    updateProgress(0, "Initializing audio streaming...");
    this.audioPlayer.setTotalChunks(text.length / 300);
    this.worker.postMessage({ type: "generate", text: text, voice: voice, speed: speed });
  }
  
  // --- DOWNLOAD (Dispatcher Logic) ---
  async handleDiskButtonClick() {
    if (this.isStreaming) { // Use this button as a STOP button
      this.resetStreamingState();
      this.worker.postMessage({ type: "stop" });
      await this.audioDiskSaver.stopSave();
      updateProgress(100, "Disk save stopped");
      return;
    }

    this.setStreamingState("disk");

    try {
      await this.audioDiskSaver.initSave(); 

      const { text: fullText } = this.getTtsOptions();
      if (fullText.trim().length === 0) {
        this.resetStreamingState();
        return;
      }
      
      // --- SPLIT TEXT INTO CHUNKS AND START THE PROCESS ---
      this.textQueue = this.splitText(fullText, CHUNK_SIZE);
      this.currentChunkIndex = 0;
      this.processNextChunk();
      // --- END ---

    } catch (error) {
      console.error("Error initializing disk save:", error);
      updateProgress(100, "Error initializing file save!");
      this.resetStreamingState();
    }
  }

  // --- NEW FUNCTION TO FEED THE WORKER ---
  processNextChunk() {
    if (this.currentChunkIndex >= this.textQueue.length) {
        // --- ALL CHUNKS ARE DONE ---
        this.audioDiskSaver.finalizeSave().then(() => {
            updateProgress(100, "File saved successfully!");
            this.resetStreamingState();
        });
        return;
    }
    
    const { voice, speed } = this.getTtsOptions();
    const nextChunk = this.textQueue[this.currentChunkIndex];
    
    // Update progress bar based on text chunks
    const progressPercent = (this.currentChunkIndex / this.textQueue.length) * 100;
    updateProgress(progressPercent, `Processing chunk ${this.currentChunkIndex + 1} of ${this.textQueue.length}...`);

    this.worker.postMessage({
        type: "generate",
        text: nextChunk,
        voice: voice,
        speed: speed
    });

    this.currentChunkIndex++;
  }

  // --- NEW HELPER TO SPLIT TEXT ---
  splitText(text, length) {
    const chunks = [];
    for (let i = 0; i < text.length; i += length) {
        chunks.push(text.substring(i, i + length));
    }
    return chunks;
  }
  
  // --- STATE MANAGEMENT ---
  
  setStreamingState(mode) {
    this.isStreaming = true;
    this.mode = mode;
    
    document.getElementById("streamAudioContext").disabled = true;
    document.getElementById("streamDisk").disabled = true;

    if (mode === "stream") {
      this.updateStreamButtonToStop();
    } else if (mode === "disk") {
      this.updateDiskButtonToStop();
    }
  }

  resetStreamingState() {
    this.isStreaming = false;
    this.mode = "none";
    this.textQueue = [];
    this.currentChunkIndex = 0;
    this.enableButtons();
  }
  
  enableButtons() {
    document.getElementById("streamAudioContext").disabled = false;
    document.getElementById("streamDisk").disabled = false;
    this.showButtonContent(document.getElementById("streamAudioContext"), "play");
    this.showButtonContent(document.getElementById("streamDisk"), "download");
  }

  updateStreamButtonToStop() {
    this.showButtonContent(document.getElementById("streamAudioContext"), "stop");
    document.getElementById("streamAudioContext").disabled = false; // Make it a stop button
  }
  
  updateDiskButtonToStop() {
    this.showButtonContent(document.getElementById("streamDisk"), "stop-download");
    document.getElementById("streamDisk").disabled = false; // Make it a stop button
  }

  getMode() { return this.mode; }
}
