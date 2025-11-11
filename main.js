// Add this to your main.js onMessageReceived function

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

    // FIX 1: Track sentence-level progress
    case "chunk_start":
      if (currentQueueJobId) {
        console.log(`Chunk starting with ${e.data.totalSentences} sentences`);
        // Store expected sentence count for this chunk
        if (!window._chunkSentenceCounts) {
          window._chunkSentenceCounts = {};
        }
        window._chunkSentenceCounts[currentQueueJobId] = e.data.totalSentences;
      }
      break;

    case "stream_audio_data":
      if (currentQueueJobId) {
        // Queue job - save chunks
        const audioData = new Float32Array(e.data.audio);
        audioChunksForQueue.push(audioData);
        
        const chunkNum = audioChunksForQueue.length;
        
        // FIX 2: Calculate progress based on ACTUAL chunks received
        if (currentJobEstimation === null) {
          try {
            const jobDetails = await queueManager.getJobDetails(currentQueueJobId);
            
            if (jobDetails && typeof jobDetails.text === 'string') {
              const textLength = jobDetails.text.length;
              
              // SIMPLIFIED: Estimate based on actual text length and average chunk size
              // Each audio chunk represents ~2-3 seconds of speech
              // Average speaking rate: ~150 words/minute = 2.5 words/second
              // So each chunk ≈ 5-7 words ≈ 30-50 characters
              const estimatedChunksFromLength = Math.ceil(textLength / 40);
              
              // Apply reasonable bounds
              currentJobEstimation = Math.max(5, Math.min(estimatedChunksFromLength, 100));
              
              console.log(`Job ${currentQueueJobId}: ${textLength} chars → est. ${currentJobEstimation} chunks`);
            } else {
              // Fallback: use dynamic estimation
              currentJobEstimation = Math.max(10, chunkNum * 2);
            }
          } catch (error) {
            console.warn('Could not get job details:', error);
            currentJobEstimation = Math.max(10, chunkNum * 2);
          }
          
          await queueManager.updateJobProgress(currentQueueJobId, 0, chunkNum, currentJobEstimation);
        }
        
        // FIX 3: Update estimation dynamically as we receive chunks
        // If we're past 90% and still receiving chunks, adjust estimation
        if (currentJobEstimation && chunkNum > currentJobEstimation * 0.9) {
          const newEstimation = Math.ceil(chunkNum * 1.15); // Increase by 15%
          console.log(`Adjusting estimation from ${currentJobEstimation} to ${newEstimation}`);
          currentJobEstimation = newEstimation;
        }
        
        // Calculate progress (cap at 98% until truly complete)
        if (currentJobEstimation) {
          const percent = Math.min((chunkNum / currentJobEstimation) * 100, 98);
          await queueManager.updateJobProgress(currentQueueJobId, percent, chunkNum, currentJobEstimation);
          updateProgress(percent, `Processing queue job ${currentQueueJobId}: ${chunkNum}/${currentJobEstimation} chunks (${Math.round(percent)}%)`);
        }
        
        tts_worker.postMessage({ type: "buffer_processed" });
        
      } else {
        // Manual job - existing logic
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

    case "complete":
      if (currentQueueJobId) {
        // FIX 4: Check for remaining chunks with timeout protection
        const hasRemainingChunks = window._queueRemainingChunks && 
            window._queueRemainingChunks.jobId === currentQueueJobId && 
            window._queueRemainingChunks.remaining.length > 0;
        
        if (hasRemainingChunks) {
          // Process next chunk
          const chunkInfo = window._queueRemainingChunks;
          const nextChunk = chunkInfo.remaining.shift();
          const currentIndex = chunkInfo.current;
          const totalChunks = chunkInfo.total;
          
          console.log(`Processing chunk ${currentIndex + 1}/${totalChunks}: "${nextChunk.substring(0, 50)}..."`);
          
          tts_worker.postMessage({ 
            type: "generate", 
            text: nextChunk, 
            voice: chunkInfo.voice, 
            speed: chunkInfo.speed 
          });
          
          chunkInfo.current++;
          updateProgress(Math.round((currentIndex / totalChunks) * 100), 
                         `Processing queue job ${currentQueueJobId} (${currentIndex + 1}/${totalChunks} chunks)...`);
          
        } else {
          // FIX 5: All chunks processed - FORCE completion
          console.log(`Queue job ${currentQueueJobId} COMPLETE with ${audioChunksForQueue.length} chunks`);
          
          // Force progress to 100%
          await queueManager.updateJobProgress(currentQueueJobId, 100, audioChunksForQueue.length, audioChunksForQueue.length);
          
          // Mark job as complete
          await queueManager.jobComplete(currentQueueJobId, audioChunksForQueue, true);
          
          // Reset all tracking variables
          const completedJobId = currentQueueJobId;
          currentQueueJobId = null;
          currentQueueMode = null;
          audioChunksForQueue = [];
          currentJobEstimation = null;
          window._queueRemainingChunks = null;
          
          updateQueueUI();
          updateProgress(100, `Job #${completedJobId} complete!`);
          
          // FIX 6: Process next job after short delay
          setTimeout(() => {
            queueManager.processNextJob();
          }, 1000);
        }
        
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
