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
let buttonHandler = new ButtonHandler(tts_worker, audioPlayer, audioDiskSaver, getRealSpeed);

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

const onMessageReceived = async (e) => {switch (e.data.status) {
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
      break;

    case "loading_model_progress":
      let progress = Number(e.data.progress) * 100;
      if (isNaN(progress)) progress = 0;
      updateProgress(progress, `Loading model: ${Math.round(progress)}%`);
      break;

    case "stream_audio_data":
      if (buttonHandler.getMode() === "disk") {
        await audioDiskSaver.addAudioChunk(e.data.audio);
      } else if (buttonHandler.getMode() === "stream") {
        await audioPlayer.queueAudio(e.data.audio);
      }
      // Regardless of mode, tell worker it's clear to process the next sentence
      tts_worker.postMessage({ type: "buffer_processed" });
      break;

    // --- THIS LOGIC IS MODIFIED ---
    case "complete":
      // This now means the WORKER has finished its CURRENT CHUNK.
      // We need to tell the ButtonHandler to send the NEXT chunk.
      if (buttonHandler.getMode() === "disk") {
        buttonHandler.processNextChunk(); // The key change!
      } else if (buttonHandler.getMode() === "stream") {
        // For streaming, "complete" still means the whole job is done.
        buttonHandler.resetStreamingState();
        updateProgress(100, "Streaming complete");
      }
      break;
    // --- END MODIFIED LOGIC ---
  }
};

const onErrorReceived = (e) => {
  console.error("Worker error:", e);
  buttonHandler.resetStreamingState();
  updateProgress(100, "An error occurred! Please try again.");
};

tts_worker.addEventListener("message", onMessageReceived);
tts_worker.addEventListener("error", onErrorReceived);

document.addEventListener('DOMContentLoaded', async () => {
  updateProgress(0, "Initializing Kokoro model...");
  document.getElementById("progressContainer").style.display = "block";
  document.getElementById("ta").value = await (await fetch('./end.txt')).text();
  buttonHandler.init();

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
