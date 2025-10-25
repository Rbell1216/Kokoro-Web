import { updateProgress } from "./updateProgress.js";

export class ButtonHandler {
  constructor(worker, audioPlayer, audioDiskSaver, getRealSpeedFunc) {
    this.worker = worker;
    this.audioPlayer = audioPlayer;
    this.audioDiskSaver = audioDiskSaver;
    this.getRealSpeed = getRealSpeedFunc; 
    this.mode = "none";
    this.isStreaming = false;

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

  showButtonContent(button, contentType) {
    const allContents = button.querySelectorAll('.btn-content');
    allContents.forEach(content => {
        content.style.display = 'none';
    });

    let contentClass;
    switch (contentType) {
        case 'play': contentClass = '.play-content'; break;
        case 'stop': contentClass = '.stop-content'; break;
        case 'loading': contentClass = '.loading-content'; break;
        case 'download': contentClass = '.download-content'; break;
        case 'download-loading': contentClass = '.download-loading-content'; break;
        case 'stop-download': contentClass = '.stop-content'; break;
        default: console.error('Unknown content type:', contentType); return;
    }

    const contentToShow = button.querySelector(contentClass);
    if (contentToShow) {
        contentToShow.style.display = 'inline-flex';
    }
  }

  enableButtons() {
    const streamBtn = document.getElementById("streamAudioContext");
    const diskBtn = document.getElementById("streamDisk");

    if (this.isStreaming) return;
    
    streamBtn.disabled = false;
    diskBtn.disabled = false;
    streamBtn.classList.remove("loading", "stop-streaming", "has-content");
    diskBtn.classList.remove("loading", "stop-saving", "has-content");
    this.showButtonContent(streamBtn, "play");
    this.showButtonContent(diskBtn, "download");
  }

  updateStreamButtonToStop() {
    const streamBtn = document.getElementById("streamAudioContext");
    if (streamBtn.classList.contains("loading")) {
        streamBtn.disabled = false;
        streamBtn.classList.remove("loading");
        streamBtn.classList.add("stop-streaming", "has-content");
        this.showButtonContent(streamBtn, "stop");
    }
  }

  resetStreamButton() {
    this.resetStreamingState(); // Centralize reset logic
  }
  
  resetDiskButton() {
    this.resetStreamingState(); // Centralize reset logic
  }

  // --- NEW CENTRAL RESET FUNCTION ---
  resetStreamingState() {
    this.isStreaming = false;
    this.mode = "none";
    this.enableButtons();
  }
  // --- END NEW FUNCTION ---

  handleStreamButtonClick() {
    if (this.isStreaming) {
      this.audioPlayer.stop(); // This will also send a "stop" message to the worker
      this.resetStreamingState();
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
    this.audioPlayer.setTotalChunks(text.length / 300); // rough estimate
    this.worker.postMessage({ type: "generate", text: text, voice: voice, speed: speed }); // Pass speed
  }
  
  async handleDiskButtonClick() {
    if (this.isStreaming) {
      this.worker.postMessage({ type: "stop" });
      await this.audioDiskSaver.stopSave();
      this.resetStreamingState();
      updateProgress(100, "Disk save stopped");
      return;
    }

    this.setStreamingState("disk");

    try {
      updateProgress(0, "Preparing to save audio...");
      await this.audioDiskSaver.initSave(); 

      const { text, voice, speed } = this.getTtsOptions();
      if (text.trim().length === 0) {
        this.resetStreamingState();
        return;
      }

      this.audioDiskSaver.setTotalChunks(text.length / 100); 
      updateProgress(0, "Processing audio for saving...");
      this.worker.postMessage({ type: "generate", text: text, voice: voice, speed: speed }); // Pass speed
    } catch (error) {
      console.error("Error initializing disk save:", error);
      updateProgress(100, "File save error!");
      this.resetStreamingState();
    }
  }

  // --- STATE MANAGEMENT ---
  setStreamingState(mode) {
    this.isStreaming = true;
    this.mode = mode;
    
    const streamBtn = document.getElementById("streamAudioContext");
    const diskBtn = document.getElementById("streamDisk");

    if (mode === "stream") {
      this.showButtonContent(streamBtn, "loading");
      streamBtn.disabled = false; // It's now a stop button
      diskBtn.disabled = true;
    } else if (mode === "disk") {
      this.showButtonContent(diskBtn, "download-loading");
      diskBtn.disabled = false; // It's now a stop button
      streamBtn.disabled = true;
    }
  }
  
  updateDiskButtonToStop() {
    const diskBtn = document.getElementById("streamDisk");
    if (diskBtn.classList.contains("loading")) {
        diskBtn.disabled = false;
        diskBtn.classList.remove("loading");
        diskBtn.classList.add("stop-saving", "has-content");
        this.showButtonContent(diskBtn, "stop-download");
    }
  }

  getMode() {
    return this.mode;
  }

  setMode(newMode) {
    this.mode = newMode;
  }

  isCurrentlyStreaming() {
    return this.isStreaming;
  }

  setStreaming(state) {
    this.isStreaming = state;
  }
}
