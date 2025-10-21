import { updateProgress } from "./updateProgress.js";

const SAMPLE_RATE = 24000;

// --- Helper function to remap the slider value ---
function getRealSpeed(sliderValue) {
  // Linearly maps slider range [0.5, 2.0] to real speed range [0.75, 1.5]
  return 0.5 * sliderValue + 0.5;
}

export class AudioDiskSaver {
  constructor() {
    this.audioContext = new AudioContext();
    this.fileStream = null;
    this.totalAudioChunks = 0;
    this.processedAudioChunks = 0;
    this.headerWritten = false;
    this.bytesWritten = 0;
    // For WAV header updates
    this.fileSize = 0;
    this.dataSize = 0;
  }

  async initSave() {
    try {
      const fileHandle = await window.showSaveFilePicker({
        suggestedName: "audio_stream.wav",
        types: [
          {
            description: "Audio Files",
            accept: { "audio/wav": [".wav"] },
          },
        ],
      });

      this.fileStream = await fileHandle.createWritable();

      // --- THIS IS THE FIX ---
      const sliderValue = parseFloat(document.getElementById('speed-slider').value);
      const realSpeed = getRealSpeed(sliderValue);
      // --- END OF FIX ---

      await this.writeWavHeader(realSpeed); // Pass the real speed
      this.headerWritten = true;
    } catch (error) {
      console.error("Error initializing file save:", error);
      throw error;
    }
  }

  setTotalChunks(totalChunks) {
    this.totalAudioChunks = totalChunks;
    this.processedAudioChunks = 0;
  }

  async addAudioChunk(audioData) {
    try {
      if (!this.fileStream) {
        throw new Error("File stream not initialized");
      }
      await this.fileStream.write(audioData);
      this.dataSize += audioData.byteLength;
      this.processedAudioChunks++;
      return Math.min((this.processedAudioChunks / this.totalAudioChunks) * 100, 99);
    } catch (error) {
      console.error("Error processing audio chunk:", error);
      throw error;
    }
  }

  async finalizeSave() {
    if (!this.fileStream) {
      throw new Error("No file stream available");
    }
    try {
      await this.updateWavHeader();
      await this.fileStream.close();
      this.reset();
      return true;
    } catch (error) {
      console.error("Error finalizing audio save:", error);
      if (this.fileStream) {
        await this.fileStream.close();
      }
      this.reset();
      throw error;
    }
  }
  async stopSave() {
    if (!this.fileStream) {
      console.log("No active file stream to stop");
      return;
    }
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      await this.updateWavHeader();
      await this.fileStream.close();
      console.log("Disk save operation stopped");
      this.reset();
      return true;
    } catch (error) {
      console.error("Error stopping disk save:", error);
      if (this.fileStream) {
        try {
          await this.fileStream.close();
        } catch (closeError) {
          console.error("Error closing file stream:", closeError);
        }
      }
      this.reset();
      return false;
    }
  }

  reset() {
    this.fileStream = null;
    this.processedAudioChunks = 0;
    this.headerWritten = false;
    this.bytesWritten = 0;
    this.fileSize = 0;
    this.dataSize = 0;
  }

  getProgress() {
    return Math.min((this.processedAudioChunks / this.totalAudioChunks) * 100, 99);
  }

  // Write WAV header at the start
  async writeWavHeader(speed = 1.0) { // Accept the real speed
    const headerBuffer = new ArrayBuffer(44);
    const view = new DataView(headerBuffer);

    // --- THIS IS THE FIX ---
    const effective_sample_rate = Math.round(SAMPLE_RATE * speed); // Use real speed
    const bitsPerSample = 32;
    const numChannels = 1;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const effective_byte_rate = effective_sample_rate * blockAlign;
    // --- END OF FIX ---

    function writeString(view, offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }
    
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 0, true); // Placeholder for file size
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, numChannels, true);
V    view.setUint32(24, effective_sample_rate, true); // Use effective rate
    view.setUint32(28, effective_byte_rate, true); // Use effective rate
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(view, 36, 'data');
    view.setUint32(40, 0, true); // Placeholder for data size
    
    await this.fileStream.write(headerBuffer);
    this.bytesWritten = 44;
  }

  // Update the WAV header with final sizes
  async updateWavHeader() {
    this.fileSize = this.dataSize + 36;
    
    await this.fileStream.seek(4);
    const fileSizeBuffer = new ArrayBuffer(4);
    new DataView(fileSizeBuffer).setUint32(0, this.fileSize, true);
    await this.fileStream.write(fileSizeBuffer);
    
    await this.fileStream.seek(40);
    const dataSizeBuffer = new ArrayBuffer(4);
    new DataView(dataSizeBuffer).setUint32(0, this.dataSize, true);
    await this.fileStream.write(dataSizeBuffer);
  }
}
