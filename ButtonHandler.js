import { updateProgress } from "./updateProgress.js";

export class ButtonHandler {
  constructor(worker, audioPlayer, audioDiskSaver, getRealSpeedFunc) { // Added getRealSpeedFunc
    this.worker = worker;
    this.audioPlayer = audioPlayer;
    this.audioDiskSaver = audioDiskSaver;
    this.getRealSpeed = getRealSpeedFunc; // <-- Store the speed function
    this.mode = "none";
    this.isStreaming = false;

    // Bind methods to maintain 'this' context
    this.handleStreamButtonClick = this.handleStreamButtonClick.bind(this);
    this.handleDiskButtonClick = this.handleDiskButtonClick.bind(this);
  }

  init() {
    document.getElementById("streamAudioContext").addEventListener("click", this.handleStreamButtonClick);
    document.getElementById("streamDisk").addEventListener("click", this.handleDiskButtonClick);
  }

  // --- NEW FUNCTION ---
  getTtsOptions() {
    const text = document.getElementById("ta").value;
    const voice = document.getElementById("voiceSelector").value;
    const sliderValue = parseFloat(document.getElementById('speed-slider').value);
    const speed = this.getRealSpeed(sliderValue); // Use the remapped speed
    return { text, voice, speed };
  }
  // --- END NEW FUNCTION ---

  showButtonContent(button, contentType) {
    // Hide all content spans first
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
    const streamBtn = document.getElementById("streamAudioContext");
    streamBtn.disabled = false;
    streamBtn.classList.remove("loading", "stop-streaming", "has-content");
    this.showButtonContent(streamBtn, "play");
    console.log("Button reset to play state");
  }

  handleStreamButtonClick() {
    if (this.isStreaming) {
      this.mode = "none";
      this.isStreaming = false;
      this.audioPlayer.stop(); // This will also send a "stop" message to the worker
      updateProgress(100, "Streaming stopped");
      setTimeout(() => {
          this.resetStreamButton();
          document.getElementById("streamDisk").disabled = false;
      }, 50); 
      return;
    }

    const streamBtn = document.getElementById("streamAudioContext");
    streamBtn.classList.add("loading", "has-content");
    this.showButtonContent(streamBtn, "loading");
    document.getElementById("streamDisk").disabled = true;

    this.mode = "stream";
    this.isStreaming = true;
    
    const { text, voice, speed } = this.getTtsOptions();
    if (text.trim().length === 0) {
        this.resetStreamButton();
        this.isStreaming = false;
        return;
    }

    updateProgress(0, "Initializing audio streaming...");
    this.audioPlayer.setTotalChunks(text.length / 300); // rough estimate
    this.worker.postMessage({ type: "generate", text: text, voice: voice, speed: speed }); // Pass speed
  }
  
  async handleDiskButtonClick() {
    if (this.mode === "disk") {
      this.mode = "none";
      this.isStreaming = false;
      this.worker.postMessage({ type: "stop" });
      await this.audioDiskSaver.stopSave();
      updateProgress(100, "Disk save stopped");
      setTimeout(() => {
          this.resetDiskButton();
          document.getElementById("streamAudioContext").disabled = false;
      }, 50);
      return;
    }

    const diskBtn = document.getElementById("streamDisk");
    diskBtn.classList.add("loading", "has-content");
    this.showButtonContent(diskBtn, "download-loading");
    document.getElementById("streamAudioContext").disabled = true;
    diskBtn.disabled = true;

    this.mode = "disk";
    this.isStreaming = true; 

    try {
      updateProgress(0, "Preparing to save audio...");
      await this.audioDiskSaver.initSave(); 

      const { text, voice, speed } = this.getTtsOptions();
      if (text.trim().length === 0) {
        this.resetDiskButton();
        this.isStreaming = false;
        return;
      }

      this.audioDiskSaver.setTotalChunks(text.length / 100); 
      updateProgress(0, "Processing audio for saving...");
      this.worker.postMessage({ type: "generate", text: text, voice: voice, speed: speed }); // Pass speed
    } catch (error) {
      console.error("Error initializing disk save:", error);
      updateProgress(100, "Error initializing file save!");
      this.resetDiskButton(); 
      document.getElementById("streamAudioContext").disabled = false;
      this.isStreaming = false;
      this.mode = "none";
    }
  }
  
  resetDiskButton() {
    const diskBtn = document.getElementById("streamDisk");
    diskBtn.disabled = false;
    diskBtn.classList.remove("loading", "stop-saving", "has-content");
    this.showButtonContent(diskBtn, "download");
    console.log("Disk button reset to download state");
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
