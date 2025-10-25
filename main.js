import { updateProgress } from "./updateProgress.js";
import { AudioPlayer } from "./AudioPlayer.js";
import { AudioDiskSaver } from "./AudioDiskSaver.js";
import { ButtonHandler } from "./ButtonHandler.js";

// --- Helper function to remap the slider value ---
function getRealSpeed(sliderValue) {
  // Linearly maps slider range [0.5, 2.0] to real speed range [0.75, 1.5]
  return 0.5 * sliderValue + 0.5;
}

if (window.location.hostname === "localhost") {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").then(() => {
      console.log("Service Worker registered.");
    });
  }
}

let tts_worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let audioPlayer = new AudioPlayer(tts_worker);
let audioDiskSaver = new AudioDiskSaver();
// --- MODIFIED: Pass the getRealSpeed function to the ButtonHandler ---
let buttonHandler = new ButtonHandler(tts_worker, audioPlayer, audioDiskSaver, getRealSpeed);

function populateVoiceSelector(voices) {
  const voiceSelector = document.getElementById("voiceSelector");
  // Clear any existing options
  while (voiceSelector.options.length > 0) {
    voiceSelector.remove(0);
  }

  // Group voices by category (based on prefix) and gender
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

  // Sort groups alphabetically
  const sortedGroups = Object.keys(voiceGroups).sort();

  // Add optgroups and options
  for (const groupKey of sortedGroups) {
    const [category, gender] = groupKey.split(' - ');
    const optgroup = document.createElement('optgroup');
    optgroup.label = `${gender} Voices (${category.toUpperCase()})`;
    // Sort voices within the group by name
    voiceGroups[groupKey].sort((a, b) => a.name.localeCompare(b.name));
    // If this is the AF Female group, insert Heart at the top
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
      // If Heart wasn't found, select the first option
      if (!heartVoice && voiceSelector.options.length === 0) {
        option.selected = true;
      }
      optgroup.appendChild(option);
    }
    voiceSelector.appendChild(optgroup);
  }
  voiceSelector.disabled = false;
}

const onMessageReceived = async (e) => {switch (e.data.status) {
    case "loading_model_start":
      console.log(e.data);
      updateProgress(0, "Loading model...");
      break;

    case "loading_model_ready":
      buttonHandler.enableButtons();
      updateProgress(100, "Model loaded successfully");
      
      // Populate voice selector if voices are available
      if (e.data.voices) {
        populateVoiceSelector(e.data.voices);
      }
      break;

    case "loading_model_progress":
      let progress = Number(e.data.progress) * 100;
      if (isNaN(progress)) progress = 0;
      updateProgress(progress, `Loading model: ${Math.round(progress)}%`);
      break;

    case "stream_audio_data":
      if (buttonHandler.getMode() === "disk") {
        const percent = await audioDiskSaver.addAudioChunk(e.data.audio);
        updateProgress(percent, "Processing audio for saving...");
        buttonHandler.updateDiskButtonToStop();
        // --- THIS IS THE FIX ---
        // Tell the worker it can send the next chunk
        tts_worker.postMessage({ type: "buffer_processed" });
        // --- END FIX ---
      } else if (buttonHandler.getMode() === "stream") {
        buttonHandler.updateStreamButtonToStop();
        // AudioPlayer will send its own "buffer_processed" message
        await audioPlayer.queueAudio(e.data.audio);
      }
      break;

    case "complete":
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
        buttonHandler.setMode("none");
        buttonHandler.resetDiskButton();
        document.getElementById("streamAudioContext").disabled = false;
      } else if (buttonHandler.getMode() === "stream") {
        buttonHandler.setStreaming(false);
        buttonHandler.setMode("none");
        updateProgress(100, "Streaming complete");
        buttonHandler.resetStreamButton();
        document.getElementById("streamDisk").disabled = false;
      } else {
        buttonHandler.enableButtons();
      }
      break;
  }
};

const onErrorReceived = (e) => {
  console.error("Worker error:", e);
  const currentMode = buttonHandler.getMode();
  buttonHandler.setStreaming(false);
  buttonHandler.setMode("none");
  updateProgress(100, "An error occurred! Please try again.");
  
  if (currentMode === "disk") {
    buttonHandler.resetDiskButton();
    document.getElementById("streamAudioContext").disabled = false;
  } else {
    buttonHandler.resetStreamButton();
    document.getElementById("streamDisk").disabled = false;
  }
};

tts_worker.addEventListener("message", onMessageReceived);
tts_worker.addEventListener("error", onErrorReceived);

document.addEventListener('DOMContentLoaded', async () => {
  updateProgress(0, "Initializing Kokoro model...");
  document.getElementById("progressContainer").style.display = "block";
  document.getElementById("ta").value = await (await fetch('./end.txt')).text();
  buttonHandler.init();

  // This block connects the speed slider label
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
});

window.addEventListener("beforeunload", () => {
  audioPlayer.close();
});
